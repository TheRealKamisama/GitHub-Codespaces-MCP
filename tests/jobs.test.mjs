import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Github } from '../dist/github.js';
import { Store } from '../dist/storage.js';
import { Application } from '../dist/application.js';
import { AppError } from '../dist/errors.js';
import { Runner } from '../dist/transport/runner.js';
import { LocalGit, githubRepository } from '../dist/git.js';
import { jobSubmitInput } from '../dist/contracts.js';

const binding = { projectId: 'dev/sample', expectedAccount: 'fixture', repository: 'fixture/repo', codespaceName: 'fixture-space', remoteProjectRoot: '/workspaces/sample', githubHost: 'github.com', ownership: 'shared', preparePolicy: 'reuse_only' };
const sha = 'c'.repeat(40);
const plan = (overrides = {}) => ({ projectId: binding.projectId, requestId: 'req-1', source: { ref: 'refs/heads/main', commit: sha },
  steps: [{ id: 'unit', role: 'test', kind: 'command', argv: ['npm', 'test'] }], ...overrides });
const statusFor = (job, overrides = {}) => ({
  jobId: job.jobId, projectId: job.projectId, digest: job.digest, state: 'accepted', settled: false, observation: 'reachable', errorCode: null,
  cancelRequested: false, generation: 'g', acceptedAt: 1, startedAt: null, endedAt: null, updatedAt: 1,
  source: { mode: 'revision', repository: job.source.repository, ref: job.source.ref, requestedCommit: job.source.commit, resolvedCommit: null, sourceModified: null, workdir: null },
  steps: job.steps.map(s => ({ id: s.id, role: s.role, optional: s.optional, state: 'pending', exitCode: null, signal: null, errorCode: null, startedAt: null, endedAt: null })),
  summary: { execution: 'NOT_RUN', verification: 'NOT_RUN', cleanup: 'NOT_CONFIGURED' }, ...overrides,
});
const reply = value => ({ stdout: JSON.stringify(value), stderr: '', exitCode: 0 });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'm1-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const world = { state: 'Available' };
  const gh = new Github(async (file, args) => {
    if (args[0] === '--version') return { stdout: 'gh version fixture\n', stderr: '', exitCode: 0 };
    if (args[0] === 'auth') return reply({ hosts: { 'github.com': [{ active: true, state: 'success', login: 'fixture' }] } });
    if (args.at(-1) === 'user') return reply({ login: 'fixture' });
    return reply({ name: 'fixture-space', state: world.state, repository: { full_name: 'fixture/repo' }, owner: { login: 'fixture' } });
  }, {});
  // A fake remote that behaves like runner/main.py Jobs: idempotent by jobId, conflict on a different digest.
  const remote = new Map(), calls = [];
  const runner = { fail: null, call: async (b, action, fields) => {
    calls.push({ action, fields });
    if (runner.fail) throw new AppError(runner.fail);
    if (action === 'job_submit') {
      const existing = remote.get(fields.job.jobId);
      if (existing && existing.digest !== fields.job.digest) throw new AppError('IDEMPOTENCY_CONFLICT');
      if (!existing) remote.set(fields.job.jobId, statusFor(fields.job));
      return remote.get(fields.job.jobId);
    }
    const status = remote.get(fields.jobId);
    if (!status) throw new AppError('JOB_NOT_FOUND');
    if (action === 'job_cancel') return { ...status, state: 'cancel_requested', cancelRequested: true };
    if (action === 'job_logs') return { jobId: fields.jobId, cursor: fields.cursor, nextCursor: 'v1:5', text: 'hello', size: 5, complete: false };
    return status;
  } };
  const store = new Store(root);
  const app = new Application(store, gh, runner);
  await app.bind(binding);
  return { root, store, app, runner, remote, calls, world };
}

test('job record is persisted before the remote call; same requestId reconciles the same job, a new plan conflicts', async t => {
  const f = await fixture(t);
  let persistedFirst = false;
  const call = f.runner.call;
  f.runner.call = async (b, action, fields) => {
    persistedFirst = (await f.store.read('job', fields.job.jobId))?.submission === 'pending';
    return call(b, action, fields);
  };
  const first = await f.app.submitJob(plan({ locale: 'en' }));
  assert.equal(persistedFirst, true);
  assert.equal(first.submission, 'accepted'); assert.equal(first.status.state, 'accepted');
  assert.equal(f.calls[0].fields.job.source.repository, 'fixture/repo');
  assert.deepEqual(f.calls[0].fields.job.steps[0], { id: 'unit', role: 'test', kind: 'command', argv: ['npm', 'test'], cwd: '.', env: {}, optional: false });
  const again = await new Application(new Store(f.root), f.app.gh, f.runner).submitJob(plan({ locale: 'zh-CN' }));
  assert.equal(again.jobId, first.jobId); assert.equal(f.remote.size, 1);
  const before = f.calls.length;
  await assert.rejects(f.app.submitJob(plan({ steps: [{ id: 'other', role: 'build', kind: 'command', argv: ['make'] }] })), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(f.calls.length, before, 'a conflicting plan never reaches the remote');
  assert.notEqual((await f.app.submitJob(plan({ requestId: 'req-2' }))).jobId, first.jobId);
});

test('lost submit response stays unknown until observed; it is never downgraded to not_sent', async t => {
  const f = await fixture(t);
  f.runner.fail = 'TRANSPORT_UNAVAILABLE';
  const lost = await f.app.submitJob(plan());
  assert.equal(lost.submission, 'unknown'); assert.equal(lost.errorCode, 'TRANSPORT_UNAVAILABLE');
  f.runner.fail = null; f.world.state = 'Shutdown';
  const stopped = await f.app.submitJob(plan());
  assert.equal(stopped.submission, 'unknown'); assert.equal(stopped.errorCode, 'CODESPACE_NOT_READY');
  const fresh = await f.app.submitJob(plan({ requestId: 'never-sent' }));
  assert.equal(fresh.submission, 'not_sent');
  f.world.state = 'Available';
  f.remote.set(lost.jobId, statusFor({ ...plan(), jobId: lost.jobId, digest: lost.digest, projectId: binding.projectId, source: { ...plan().source, repository: 'fixture/repo' }, steps: [{ id: 'unit', role: 'test', optional: false }] }, { state: 'running' }));
  assert.equal((await f.app.getJob({ projectId: binding.projectId, jobId: lost.jobId })).state, 'running');
  const reconciled = await f.store.read('job', lost.jobId);
  assert.equal(reconciled.submission, 'accepted'); assert.equal(reconciled.status.state, 'running');
  f.runner.fail = 'CONFIG_INVALID';
  assert.equal((await f.app.submitJob(plan({ requestId: 'rejected' }))).submission, 'rejected');
});

test('job queries follow the binding, refuse moved bindings and do not need a local record', async t => {
  const f = await fixture(t);
  const record = await f.app.submitJob(plan());
  const waited = await f.app.getJob({ projectId: binding.projectId, jobId: record.jobId, waitSeconds: 20 });
  assert.equal(waited.jobId, record.jobId); assert.equal(f.calls.at(-1).fields.waitSeconds, 20);
  assert.equal((await f.app.cancelJob({ projectId: binding.projectId, jobId: record.jobId })).state, 'cancel_requested');
  assert.equal((await f.app.jobLogs({ projectId: binding.projectId, jobId: record.jobId })).nextCursor, 'v1:5');
  assert.deepEqual(f.calls.at(-1).fields, { jobId: record.jobId, cursor: 'v1:0', maxBytes: 32768 });
  await rm(f.store.path('job', record.jobId));
  assert.equal((await f.app.getJob({ projectId: binding.projectId, jobId: record.jobId })).jobId, record.jobId);
  const kept = (await f.app.submitJob(plan({ requestId: 'kept' }))).jobId;
  await f.app.bind({ ...binding, remoteProjectRoot: '/workspaces/moved', expectedVersion: 1 });
  await assert.rejects(f.app.getJob({ projectId: binding.projectId, jobId: kept }), { code: 'JOB_LOCATION_CHANGED' });
  f.world.state = 'Shutdown';
  await assert.rejects(f.app.getJob({ projectId: binding.projectId, jobId: 'e'.repeat(64) }), { code: 'CODESPACE_NOT_READY' });
});

test('job plan schema rejects escapes, short SHAs, partial refs, duplicate ids and oversized plans', () => {
  assert.equal(jobSubmitInput.safeParse(plan()).success, true);
  const step = plan().steps[0];
  const bad = [
    { source: { ref: 'main', commit: sha } }, { source: { ref: 'refs/heads/main', commit: 'abc123' } }, { source: { ref: 'refs/heads/../x', commit: sha } },
    { steps: [] }, { steps: [step, step] }, { steps: [{ ...step, cwd: '../up' }] }, { steps: [{ ...step, cwd: '/abs' }] },
    { steps: [{ ...step, argv: ['a\0b'] }] }, { steps: [{ ...step, env: { 'BAD-NAME': 'x' } }] }, { steps: [{ ...step, role: 'service' }] },
    { steps: [{ ...step, kind: 'shell', shell: 'zsh', script: 'x' }] }, { steps: [{ ...step, unknown: true }] }, { timeoutSeconds: 0 },
    { steps: Array.from({ length: 30 }, (_, i) => ({ ...step, id: `s${i}`, argv: ['x'.repeat(8000)] })) },
  ];
  for (const overrides of bad) assert.equal(jobSubmitInput.safeParse(plan(overrides)).success, false, JSON.stringify(overrides).slice(0, 80));
});

test('runner transport sends job fields only on stdin and scales the deadline with waitSeconds', async () => {
  const build = JSON.parse(await readFile('dist/build.json', 'utf8'));
  let captured;
  const job = { jobId: 'a'.repeat(64), digest: 'b'.repeat(64), projectId: 'p', source: { repository: 'r/r', ref: 'refs/heads/x', commit: sha }, steps: [] };
  const gh = { command: async (args, stdin, limits) => { captured = { args, stdin: JSON.parse(stdin), limits }; return reply({ ok: true, data: statusFor(job), error: null }); } };
  const b = { ...binding, schemaVersion: 1, version: 1, locale: 'en' };
  await new Runner(gh, build).call(b, 'job_get', { jobId: job.jobId, waitSeconds: 20 });
  assert.equal(captured.stdin.jobId, job.jobId); assert.equal(captured.stdin.action, 'job_get');
  assert.equal(captured.args.join(' ').includes(job.jobId), false);
  assert.ok(captured.limits.timeoutMs >= 35000); assert.ok(captured.limits.maxBytes >= 2 * 1024 * 1024);
  const bad = { command: async () => reply({ ok: true, data: { ...statusFor(job), state: 'exploded' }, error: null }) };
  await assert.rejects(new Runner(bad, build).call(b, 'job_get', { jobId: job.jobId }), { code: 'RUNNER_INVALID_RESPONSE' });
  const refused = { command: async () => reply({ ok: false, data: null, error: 'IDEMPOTENCY_CONFLICT' }) };
  await assert.rejects(new Runner(refused, build).call(b, 'job_submit', { job }), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('GitHub remote parsing never returns embedded credentials', () => {
  assert.equal(githubRepository('https://github.com/Owner/repo.git'), 'Owner/repo');
  assert.equal(githubRepository('https://x-access-token:secret@github.com/owner/repo'), 'owner/repo');
  assert.equal(githubRepository('git@github.com:owner/re.po.git'), 'owner/re.po');
  assert.equal(githubRepository('ssh://git@github.com/owner/repo.git'), 'owner/repo');
  for (const url of ['https://gitlab.com/o/r.git', 'https://github.com.evil/o/r', 'https://github.com/o/r/extra', '/local/path']) assert.equal(githubRepository(url), null);
});

test('project_inspect reads upstream, push state, renames and dirt from a real local repository', async t => {
  const root = await mkdtemp(join(tmpdir(), 'm1 inspect 中文 '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=f', '-c', 'user.email=f@example.invalid', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();
  const remote = join(root, 'remote.git'), work = join(root, 'work');
  git(root, 'init', '-q', '--bare', remote); git(root, 'init', '-q', work);
  const inspector = new LocalGit();
  assert.equal((await inspector.inspect(work)).head, null);
  await writeFile(join(work, 'a.txt'), 'a'); git(work, 'add', '-A'); git(work, 'commit', '-q', '-m', 'one');
  git(work, 'remote', 'add', 'origin', remote);
  git(work, 'push', '-q', '-u', 'origin', 'HEAD:refs/heads/main');
  // Point the push URL at GitHub to exercise repository parsing; nothing is fetched or pushed by inspection.
  git(work, 'remote', 'set-url', '--push', 'origin', 'https://token@github.com/fixture/repo.git');
  const f = await fixture(t);
  const clean = await f.app.inspect({ localProjectRoot: join(work, '.'), projectId: binding.projectId });
  const head = git(work, 'rev-parse', 'HEAD');
  assert.deepEqual({ ...clean, localProjectRoot: undefined }, { localProjectRoot: undefined, head, branch: 'refs/heads/main',
    upstream: { remote: 'origin', ref: 'refs/heads/main', trackingRef: 'refs/remotes/origin/main', repository: 'fixture/repo' },
    dirty: { tracked: 0, untracked: 0 }, pushed: 'yes', binding: { projectId: binding.projectId, repository: 'fixture/repo', matches: true },
    suggestedSource: { mode: 'revision', ref: 'refs/heads/main', commit: head }, warnings: [] });
  await writeFile(join(work, 'b.txt'), 'b'); git(work, 'add', 'b.txt'); git(work, 'commit', '-q', '-m', 'two');
  git(work, 'mv', 'a.txt', 'renamed.txt'); await writeFile(join(work, 'new file.txt'), 'n');
  const ahead = await f.app.inspect({ localProjectRoot: work });
  assert.equal(ahead.pushed, 'no'); assert.equal(ahead.suggestedSource, null); assert.equal(ahead.binding, null);
  assert.deepEqual(ahead.dirty, { tracked: 1, untracked: 1 });
  assert.deepEqual(ahead.warnings, ['NOT_PUSHED', 'WORKTREE_DIRTY']);
  git(work, 'checkout', '-q', '--detach');
  assert.ok((await f.app.inspect({ localProjectRoot: work })).warnings.includes('DETACHED_HEAD'));
  await assert.rejects(inspector.inspect(tmpdir()), { code: 'NOT_A_GIT_REPOSITORY' });
  await assert.rejects(inspector.inspect('relative/path'), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(new LocalGit(async () => { throw new AppError('EXECUTABLE_UNAVAILABLE'); }).inspect(work), { code: 'GIT_NOT_FOUND' });
});
