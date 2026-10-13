import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AppError } from './errors.js';
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class Store {
  constructor(readonly root: string) {}
  path(kind: string, id: string) { return join(this.root, `${kind}-${digest(id)}.json`); }
  async read(kind: string, id: string): Promise<unknown | undefined> {
    try {
      const path = this.path(kind, id);
      if ((await stat(path)).size > 65536) throw new AppError('STATE_INVALID');
      return JSON.parse(await readFile(path, 'utf8'));
    }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new AppError('STATE_INVALID'); }
  }
  async write(kind: string, id: string, value: unknown) {
    await mkdir(this.root, { recursive: true });
    const target = this.path(kind, id), temp = `${target}.${randomUUID()}.tmp`;
    try { await writeFile(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); await rename(temp, target); }
    finally { await rm(temp, { force: true }); }
  }
  async locked<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true });
    const lock = join(this.root, 'mutation.lock');
    try { await mkdir(lock); } catch { throw new AppError('STATE_BUSY', true); }
    try { return await fn(); } finally { await rm(lock, { recursive: true }); }
  }
}
