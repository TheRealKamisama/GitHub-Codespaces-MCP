import { createReadStream } from 'node:fs';
import { link, lstat, readdir, rename, rm, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, posix } from 'node:path';
import { AppError, requireThat } from './errors.js';
import type { JobStatus } from './contracts.js';

export type ArtifactEntry = JobStatus['artifacts'][number];

// Path handed to `gh codespace cp -e`. In literal mode gh single-quotes remote paths for scp's legacy protocol, which
// breaks with OpenSSH 9+ clients whose scp uses SFTP (the quotes become part of the name). With -e nothing is quoted,
// so the path must be inert under both protocols: only [A-Za-z0-9._/-], no `..`. The runner provides such an alias.
export function transferPath(status: JobStatus, name: string) {
  const root = status.transferRoot;
  requireThat(root && /^\/workspaces\/[A-Za-z0-9._/-]+$/.test(root) && !root.split('/').includes('..'), 'TRANSFER_UNSUPPORTED');
  requireThat(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name), 'TRANSFER_UNSUPPORTED');
  return posix.join(root, name);
}

async function sha256(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function regularFiles(root: string, prefix = ''): Promise<{ path: string; full: string }[]> {
  const result = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await regularFiles(root, relative));
    else if (entry.isFile()) result.push({ path: relative, full: join(root, relative) });
    else throw new AppError('HASH_MISMATCH');   // links or special files never come from a verified copy
  }
  return result;
}

// A transferred copy is accepted only if it is exactly the frozen manifest: same files, sizes and SHA-256.
export async function verifyArtifact(path: string, entry: ArtifactEntry) {
  const info = await lstat(path).catch(() => { throw new AppError('TRANSFER_FAILED'); });
  if (entry.kind === 'file') {
    requireThat(info.isFile() && info.size === entry.size && await sha256(path) === entry.sha256, 'HASH_MISMATCH');
    return;
  }
  requireThat(info.isDirectory(), 'HASH_MISMATCH');
  const files = await regularFiles(path);
  const expected = new Map(entry.files.map(f => [f.path, f]));
  requireThat(files.length === expected.size, 'HASH_MISMATCH');
  for (const file of files) {
    const want = expected.get(file.path);
    requireThat(want && (await lstat(file.full)).size === want.size && await sha256(file.full) === want.sha256, 'HASH_MISMATCH');
  }
}

// Moves a verified copy into place without ever replacing an existing file or directory.
export async function placeArtifact(temp: string, destination: string, kind: ArtifactEntry['kind']) {
  if (kind === 'file') {
    try { await link(temp, destination); await unlink(temp); return; }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') throw new AppError('DESTINATION_EXISTS');
      if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EXDEV') throw e;   // no hard links here: check, then rename
    }
  }
  const exists = await lstat(destination).then(() => true, () => false);
  requireThat(!exists, 'DESTINATION_EXISTS');
  await rename(temp, destination);
}

export async function discard(path: string) { await rm(path, { recursive: true, force: true }); }
