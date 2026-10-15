import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, cp } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Github } from '../dist/github.js';
import { Store } from '../dist/storage.js';
import { Application } from '../dist/application.js';
import { AppError } from '../dist/errors.js';
import { Controller } from '../dist/lifecycle.js';
import { jobSubmitInput } from '../dist/contracts.js';
import { digest } from '../dist/storage.js';

const sha = data => createHash('sha256').update(data).digest('hex');
const binding = { projectId: 'p/art', expectedAccount: 'fixture', repository: 'fixture/repo', codespaceName: 'space', remoteProjectRoot: '/workspaces/art', githubHost: 'github.com',
  ownership: 'dedicated', preparePolicy: 'start_existing', resourcePolicy: { releaseMode: 'stop_after_export', graceSeconds: 0, exportTimeoutSeconds: 300 } };
const reply = value => ({ stdout: JSON.stringify(value), stderr: '', exitCode: 0 });

// The "remote" is a real directory tree: gh codespace cp copies from <remote><remotePath>, like scp would.
async function world(t) {
  const root = await mkdtemp(join(tmpdir(), 'm1-art-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = join(root, 'remote'), out = join(root, 'out');
  await mkdir(out);
  const w = { state: 'Available', copies: [], corrupt: null, failCopy: false, jobs: new Map(), now: Date.now() };
  const gh = new Github(async (file, args) => {
    if (args[0] === '--version') return { stdout: 'gh version fixture\n', stderr: '', exitCode: 0 };
    if (args[0] === 'auth') return reply({ hosts: { 'github.com': [{ active: true, state: 'success', login: 'fixture' }] } });
    if (args.at(-1) === 'user') return reply({ login: 'fixture' });
    if (args[0] === 'codespace' && args[1] === 'cp') {
      const [source, destination] = args.slice(-2);
      w.copies.push(source);
      assert.ok(args.includes('-e'), 'literal-mode quoting breaks SFTP-mode scp; transfers use -e on inert paths');
      if (w.failCopy) return { stdout: '', stderr: 'lost connection', exitCode: 1 };
      await cp(join(remote, source.replace(/^remote:/, '')), destination, { recursive: args.includes('-r') });
      if (w.corrupt) await w.corrupt(destination);
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (args.includes('POST')) { if (args.at(-1).endsWith('/stop')) w.state = 'Shutdown'; return { stdout: '', stderr: '', exitCode: 0 }; }
    return reply({ name: 'space', state: w.state, repository: { full_name: 'fixture/repo' }, owner: { login: 'fixture' } });
  }, {});
  const runner = { call: async (b, action, fields = {}) => {
    if (w.state !== 'Available') throw new AppError('TRANSPORT_UNAVAILABLE');
    if (action === 'job_submit') { w.jobs.set(fields.job.jobId, fields.job); return w.status(fields.job); }
    if (action === 'job_get') { const job = w.jobs.get(fields.jobId); if (!job) throw new AppError('JOB_NOT_FOUND'); return w.status(job); }
    if (action === 'job_logs') return { jobId: fields.jobId, cursor: fields.cursor, nextCursor: 'v1:3', text: fields.cursor === 'v1:0' ? 'ok\n' : '', size: 3, complete: true };
    if (action === 'instance_status' || action === 'instance_close') return { generation: 'g', closed: action === 'instance_close', activeJobs: [], holds: [], closing: null };
    throw new Error(`unexpected ${action}`);
  } };
  const app = new Application(new Store(join(root, 'state')), gh, runner, undefined, { sleep: async () => {} });
  await app.bind(binding);
  return { root, remote, out, w, app };
}

// Writes real frozen artifacts into the fake remote store and returns the matching manifest.
async function freeze(f, jobId, files) {
  const store = join(f.remote, binding.remoteProjectRoot, '.codespace-mcp', 'jobs', jobId, 'artifacts');
  const manifest = [];
  for (const [name, content] of Object.entries(files)) {
    if (typeof content === 'object' && !Buffer.isBuffer(content)) {
      const members = [];
      for (const [path, data] of Object.entries(content)) {
        await mkdir(dirname(join(store, name, path)), { recursive: true });
        await writeFile(join(store, name, path), data);
        members.push({ path, size: Buffer.byteLength(data), sha256: sha(data) });
      }
      manifest.push({ name, path: `dist/${name}`, required: true, kind: 'directory', state: 'collected', size: members.reduce((n, m) => n + m.size, 0), sha256: null, files: members, errorCode: null });
    } else {
      await mkdir(store, { recursive: true });
      await writeFile(join(store, name), content);
      manifest.push({ name, path: `dist/${name}`, required: true, kind: 'file', state: 'collected', size: Buffer.byteLength(content), sha256: sha(content), files: [], errorCode: null });
    }
  }
  return manifest;
}

async function settledJob(f, artifacts, extra = []) {
  f.w.status = job => ({ jobId: job.jobId, projectId: job.projectId, digest: job.digest, state: 'succeeded', settled: true, observation: 'reachable', errorCode: null,
    cancelRequested: false, generation: 'g', acceptedAt: 1, startedAt: 1, endedAt: f.w.now / 1000, updatedAt: 2,
    source: { mode: 'revision', repository: 'fixture/repo', ref: 'refs/heads/main', requestedCommit: 'c'.repeat(40), resolvedCommit: 'c'.repeat(40), sourceModified: false, workdir: '/w' },
    steps: [{ id: 'build', role: 'build', optional: false, state: 'passed', exitCode: 0, signal: null, errorCode: null, startedAt: 1, endedAt: 2 }],
    summary: { execution: 'PASS', verification: 'NOT_CONFIGURED', cleanup: 'NOT_CONFIGURED' }, artifacts: [...artifacts, ...extra],
    transferRoot: `/workspaces/art/.codespace-mcp/jobs/${job.jobId}/artifacts` });
  const record = await f.app.submitJob({ projectId: 'p/art', requestId: `r-${Math.random()}`, source: { ref: 'refs/heads/main', commit: 'c'.repeat(40) },
    steps: [{ id: 'build', role: 'build', kind: 'command', argv: ['true'] }], artifacts: [...artifacts.map(a => ({ name: a.name, path: a.path })), ...extra.map(a => ({ name: a.name, path: a.path, required: a.required }))] });
  assert.equal(record.submission, 'accepted', record.errorCode ?? '');
  return record.jobId;
}

test('job plans accept artifact declarations and reject unsafe ones; digests of plans without artifacts are unchanged', async t => {
  const base = { projectId: 'p', requestId: 'r', source: { ref: 'refs/heads/main', commit: 'c'.repeat(40) }, steps: [{ id: 's', role: 'build', kind: 'command', argv: ['true'] }] };
  assert.deepEqual(jobSubmitInput.parse(base).artifacts, []);
  assert.equal(jobSubmitInput.parse({ ...base, artifacts: [{ name: 'pkg', path: 'dist/app.tar' }] }).artifacts[0].required, true);
  for (const artifacts of [[{ name: 'x', path: '../x' }], [{ name: 'x', path: '/etc/passwd' }], [{ name: 'x', path: '.' }], [{ name: '../x', path: 'a' }],
    [{ name: 'x', path: 'a' }, { name: 'x', path: 'b' }], [{ name: 'x', path: 'a', follow: true }]]) {
    assert.equal(jobSubmitInput.safeParse({ ...base, artifacts }).success, false, JSON.stringify(artifacts));
  }
  // The digest formula of the previous release, so existing requestIds keep reconciling instead of conflicting.
  const f = await world(t);
  f.w.status = job => ({ ...job, state: 'accepted' });
  f.app.runner.call = async () => { throw new AppError('TRANSPORT_UNAVAILABLE'); };
  const record = await f.app.submitJob({ ...base, projectId: 'p/art' });
  const parsed = jobSubmitInput.parse(base);
  assert.equal(record.digest, digest({ projectId: 'p/art', repository: 'fixture/repo', codespaceName: 'space', remoteProjectRoot: '/workspaces/art',
    source: parsed.source, steps: parsed.steps, timeoutSeconds: parsed.timeoutSeconds }));
});

test('downloads verify the frozen manifest, place files and directories without overwriting, and leave nothing behind on failure', async t => {
  const f = await world(t);
  const jobId = await settledJob(f, []);
  const manifest = await freeze(f, jobId, { 'app.tar': Buffer.alloc(300_000, 7), report: { 'summary.json': '{"ok":true}', 'deep/报告 notes.txt': '中文' } });
  const job = f.w.jobs.get(jobId);
  f.w.status = (s => j => ({ ...s(j), artifacts: [...manifest, { name: 'coverage', path: 'coverage/lcov.info', required: false, kind: null, state: 'missing', size: null, sha256: null, files: [], errorCode: 'ARTIFACT_MISSING' }] }))(f.w.status);
  const file = await f.app.downloadArtifact({ projectId: 'p/art', jobId, artifact: 'app.tar', localDestination: join(f.out, 'app.tar') });
  assert.deepEqual([file.kind, file.size, file.source, file.verified], ['file', 300_000, 'codespace', true]);
  assert.equal(sha(await readFile(join(f.out, 'app.tar'))), manifest[0].sha256);
  assert.equal(f.w.copies.at(-1), `remote:/workspaces/art/.codespace-mcp/jobs/${jobId}/artifacts/app.tar`);
  const dir = await f.app.downloadArtifact({ projectId: 'p/art', jobId, artifact: 'report', localDestination: join(f.out, '报告 dir') });
  assert.equal(dir.files, 2);
  assert.equal(await readFile(join(f.out, '报告 dir', 'deep', '报告 notes.txt'), 'utf8'), '中文');
  // Never overwrite; the existing file is untouched.
  await writeFile(join(f.out, 'taken'), 'mine');
  await assert.rejects(f.app.downloadArtifact({ projectId: 'p/art', jobId, artifact: 'app.tar', localDestination: join(f.out, 'taken') }), { code: 'DESTINATION_EXISTS' });
  assert.equal(await readFile(join(f.out, 'taken'), 'utf8'), 'mine');
  // Corrupted, short or failed transfers leave neither a destination nor a partial file.
  for (const [setup, code] of [
    [() => { f.w.corrupt = async p => writeFile(p, 'tampered'); }, 'HASH_MISMATCH'],
    [() => { f.w.corrupt = async p => writeFile(p, Buffer.alloc(299_999, 7)); }, 'HASH_MISMATCH'],
    [() => { f.w.corrupt = null; f.w.failCopy = true; }, 'TRANSFER_FAILED'],
  ]) {
    setup();
    await assert.rejects(f.app.downloadArtifact({ projectId: 'p/art', jobId, artifact: 'app.tar', localDestination: join(f.out, 'bad.tar') }), { code });
  }
  f.w.failCopy = false;
  f.w.corrupt = async p => writeFile(join(p, 'extra.txt'), 'injected');
  await assert.rejects(f.app.downloadArtifact({ projectId: 'p/art', jobId, artifact: 'report', localDestination: join(f.out, 'bad-dir') }), { code: 'HASH_MISMATCH' });
  f.w.corrupt = null;
  assert.deepEqual((await readdir(f.out)).sort(), ['app.tar', 'taken', '报告 dir']);
  await assert.rejects(f.app.downloadArtifact({ projectId: 'p/art', jobId, artifact: 'coverage', localDestination: join(f.out, 'c') }), { code: 'ARTIFACT_NOT_COLLECTED' });
  await assert.rejects(f.app.downloadArtifact({ projectId: 'p/art', jobId, artifact: 'nope', localDestination: join(f.out, 'n') }), { code: 'ARTIFACT_NOT_FOUND' });
  await assert.rejects(f.app.downloadArtifact({ projectId: 'p/art', jobId, artifact: 'app.tar', localDestination: 'relative.tar' }), { code: 'DESTINATION_INVALID' });
  // A transfer path that a remote shell could expand is refused before gh is ever invoked.
  const copies = f.w.copies.length;
  for (const transferRoot of ['/workspaces/my project/x', '/workspaces/$(id)', '/tmp/x', '/workspaces/../etc', null]) {
    f.w.status = (s => j => ({ ...s(j), transferRoot }))(f.w.status);
    await assert.rejects(f.app.downloadArtifact({ projectId: 'p/art', jobId, artifact: 'app.tar', localDestination: join(f.out, 'unsafe') }), { code: 'TRANSFER_UNSUPPORTED' }, String(transferRoot));
  }
  assert.equal(f.w.copies.length, copies);
  await assert.rejects(f.app.downloadArtifact({ projectId: 'p/art', jobId, artifact: 'app.tar', localDestination: join(f.out, 'missing-dir', 'x') }), { code: 'DESTINATION_INVALID' });
  assert.ok(job);
});

test('the controller exports verified artifacts before stopping, within the quota; downloads then work offline', async t => {
  const f = await world(t);
  const jobId = await settledJob(f, []);
  const manifest = await freeze(f, jobId, { 'app.tar': 'package', report: { 'a.txt': 'a', 'b/c.txt': 'c' } });
  // A huge optional artifact over the export quota stays remote; it is recorded as skipped, not as a failure.
  const huge = { name: 'huge', path: 'dist/huge', required: false, kind: 'file', state: 'collected', size: 100 * 1024 * 1024, sha256: 'f'.repeat(64), files: [], errorCode: null };
  f.w.status = (s => j => ({ ...s(j), artifacts: [...manifest, huge] }))(f.w.status);
  const controller = new Controller(f.app, () => f.w.now);
  let release;
  for (let i = 0; i < 4 && release?.state !== 'stopped'; i++) { await controller.tick(); release = (await f.app.release({ projectId: 'p/art', action: 'status' })).release; }
  assert.deepEqual([release.state, release.exportStatus], ['stopped', 'COMPLETE']);
  assert.ok(!f.w.copies.some(c => c.endsWith('/huge')), 'the over-quota artifact is never transferred');
  const archived = await f.app.archive.read(jobId);
  assert.deepEqual([archived.receipt.artifactsExported, archived.receipt.artifactsSkipped], [['app.tar', 'report'], ['huge']]);
  // Instance is Shutdown: downloads come from the archive and never touch the Codespace.
  const copies = f.w.copies.length;
  const file = await f.app.downloadArtifact({ projectId: 'p/art', jobId, artifact: 'app.tar', localDestination: join(f.out, 'offline.tar') });
  const dir = await f.app.downloadArtifact({ projectId: 'p/art', jobId, artifact: 'report', localDestination: join(f.out, 'offline-report') });
  assert.deepEqual([file.source, dir.source, dir.files, f.w.copies.length, f.w.state], ['archive', 'archive', 2, copies, 'Shutdown']);
  assert.equal(await readFile(join(f.out, 'offline-report', 'b', 'c.txt'), 'utf8'), 'c');
  await assert.rejects(f.app.downloadArtifact({ projectId: 'p/art', jobId, artifact: 'huge', localDestination: join(f.out, 'h') }), { code: 'CODESPACE_NOT_READY' });
});

test('a failed artifact export blocks the stop within the export window and never leaves a half-written archive', async t => {
  const f = await world(t);
  const jobId = await settledJob(f, []);
  const manifest = await freeze(f, jobId, { 'app.tar': 'package' });
  f.w.status = (s => j => ({ ...s(j), artifacts: manifest }))(f.w.status);
  f.w.corrupt = async p => writeFile(p, 'tampered');
  const controller = new Controller(f.app, () => f.w.now);
  await controller.tick();
  const release = (await f.app.release({ projectId: 'p/art', action: 'status' })).release;
  assert.deepEqual([release.state, release.blockers.map(b => b.kind)], ['waiting_for_leases', ['EXPORT_RUNNING']]);
  assert.equal(await f.app.archive.read(jobId), undefined);
  assert.deepEqual((await readdir(f.app.archive.root)).filter(n => n.startsWith('.')), [], 'staging directories are cleaned up');
  f.w.corrupt = null;
  await controller.tick();
  assert.deepEqual((await f.app.archive.read(jobId)).receipt.artifactsExported, ['app.tar']);
});

test('jobs whose artifacts cannot be transferred are still archived, with their artifacts recorded as skipped', async t => {
  const f = await world(t);
  const jobId = await settledJob(f, []);
  const manifest = await freeze(f, jobId, { 'app.tar': 'package' });
  f.w.status = (s => j => ({ ...s(j), artifacts: manifest, transferRoot: null }))(f.w.status);
  await new Controller(f.app, () => f.w.now).tick();
  const archived = await f.app.archive.read(jobId);
  assert.deepEqual([archived.status.state, archived.receipt.artifactsExported, archived.receipt.artifactsSkipped], ['succeeded', [], ['app.tar']]);
  assert.deepEqual(f.w.copies, []);
});
