import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Github } from '../dist/github.js';
import { Store } from '../dist/storage.js';
import { Application } from '../dist/application.js';
import { AppError } from '../dist/errors.js';
import { Controller, runController } from '../dist/lifecycle.js';

const base = { expectedAccount: 'fixture', repository: 'fixture/repo', codespaceName: 'space', githubHost: 'github.com' };
const dedicated = { ...base, projectId: 'p/one', remoteProjectRoot: '/workspaces/one', ownership: 'dedicated', preparePolicy: 'start_existing', resourcePolicy: { releaseMode: 'stop_after_export', graceSeconds: 60, exportTimeoutSeconds: 300 } };
const shared = { ...base, projectId: 'p/shared', remoteProjectRoot: '/workspaces/shared', ownership: 'shared', preparePolicy: 'reuse_only' };
const sha = 'c'.repeat(40);
const plan = (requestId = 'r1') => ({ projectId: 'p/one', requestId, source: { ref: 'refs/heads/main', commit: sha }, steps: [{ id: 'unit', role: 'test', kind: 'command', argv: ['true'] }] });
const reply = value => ({ stdout: JSON.stringify(value), stderr: '', exitCode: 0 });

function status(job, overrides = {}) {
  return { jobId: job.jobId, projectId: job.projectId, digest: job.digest, state: 'running', settled: false, observation: 'reachable', errorCode: null, cancelRequested: false,
    generation: 'g', acceptedAt: 1, startedAt: 1, endedAt: null, updatedAt: 1,
    source: { mode: 'revision', repository: 'fixture/repo', ref: 'refs/heads/main', requestedCommit: sha, resolvedCommit: sha, sourceModified: false, workdir: '/w' },
    steps: [{ id: 'unit', role: 'test', optional: false, state: 'running', exitCode: null, signal: null, errorCode: null, startedAt: 1, endedAt: null }],
    summary: { execution: 'INCOMPLETE', verification: 'NOT_RUN', cleanup: 'NOT_CONFIGURED' }, ...overrides };
}
const settle = s => ({ ...s, state: 'succeeded', settled: true, endedAt: 2, steps: s.steps.map(x => ({ ...x, state: 'passed', exitCode: 0, endedAt: 2 })), summary: { execution: 'PASS', verification: 'PASS', cleanup: 'NOT_CONFIGURED' } });

async function world(t) {
  const root = await mkdtemp(join(tmpdir(), 'm1-life-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // GitHub: a small state machine. A stop request goes through ShuttingDown before Shutdown.
  const w = { state: 'Available', posts: [], stopFails: 0, jobs: new Map(), logs: new Map(), holds: [], closing: null, runnerCalls: [], closeRefused: false, now: Date.now() };
  const gh = new Github(async (file, args) => {
    if (args[0] === '--version') return { stdout: 'gh version fixture\n', stderr: '', exitCode: 0 };
    if (args[0] === 'auth') return reply({ hosts: { 'github.com': [{ active: true, state: 'success', login: 'fixture' }] } });
    if (args.at(-1) === 'user') return reply({ login: 'fixture' });
    if (args.includes('POST')) {
      const endpoint = args.at(-1); w.posts.push(endpoint);
      if (endpoint.endsWith('/stop')) { if (w.stopFails > 0) { w.stopFails--; return { stdout: '', stderr: 'boom', exitCode: 1 }; } w.state = 'ShuttingDown'; }
      if (endpoint.endsWith('/start')) w.state = 'Starting';
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    const current = w.state;
    if (w.state === 'ShuttingDown') w.state = 'Shutdown';
    if (w.state === 'Starting') w.state = 'Available';
    return reply({ name: 'space', state: current, repository: { full_name: 'fixture/repo' }, owner: { login: 'fixture' } });
  }, {});
  const instance = () => ({ generation: 'g', closed: false, holds: w.holds, closing: w.closing,
    activeJobs: [...w.jobs.values()].filter(s => !s.settled).map(s => ({ projectRoot: '/workspaces/one', jobId: s.jobId, state: s.state })) });
  const runner = { call: async (b, action, fields = {}) => {
    w.runnerCalls.push(action);
    if (w.state !== 'Available') throw new AppError('TRANSPORT_UNAVAILABLE');
    if (action === 'handshake') return { protocolVersion: 1, runnerSha256: 'a'.repeat(64), version: 'v', gitSha: 'b'.repeat(40), dirty: false, codespaceName: 'space', generation: 'g', pythonVersion: '3', platform: 'linux', capabilities: ['handshake'] };
    if (action === 'job_submit') {
      if (w.closing) throw new AppError('CODESPACE_RELEASING');
      if (!w.jobs.has(fields.job.jobId)) { w.jobs.set(fields.job.jobId, status(fields.job)); w.logs.set(fields.job.jobId, 'line 中文\n'.repeat(3)); }
      return w.jobs.get(fields.job.jobId);
    }
    if (action === 'job_get') { if (!w.jobs.has(fields.jobId)) throw new AppError('JOB_NOT_FOUND'); return w.jobs.get(fields.jobId); }
    if (action === 'job_logs') {
      const log = Buffer.from(w.logs.get(fields.jobId)); const offset = Number(fields.cursor.slice(3));
      if (w.failLogs) throw new AppError('TRANSPORT_UNAVAILABLE');
      // Like the real runner: small pages, never split inside a UTF-8 sequence.
      let end = Math.min(log.length, offset + Math.min(fields.maxBytes, 7));
      while (end < log.length && (log[end] & 0xc0) === 0x80) end--;
      const chunk = log.subarray(offset, end);
      return { jobId: fields.jobId, cursor: fields.cursor, nextCursor: `v1:${offset + chunk.length}`, text: chunk.toString(), size: log.length, complete: false };
    }
    if (action === 'instance_status') return instance();
    if (action === 'instance_close') {
      const s = instance();
      if (s.activeJobs.length || s.holds.length || w.closeRefused) return { ...s, closed: false };
      w.closing = { closeId: fields.closeId, generation: 'g', createdAt: 1, expiresAt: 2 }; return { ...instance(), closed: true };
    }
    if (action === 'instance_reopen') { if (w.closing?.closeId === fields.closeId) w.closing = null; return instance(); }
    if (action === 'hold_set') { w.holds.push({ holdId: fields.holdId, expiresAt: 9e9 }); return instance(); }
    if (action === 'hold_clear') { w.holds = w.holds.filter(h => h.holdId !== fields.holdId); return instance(); }
    throw new Error(`unexpected ${action}`);
  } };
  const store = new Store(root);
  let wakes = 0;
  const app = new Application(store, gh, runner, undefined, { wake: () => { wakes++; }, sleep: async () => {}, startWaitMs: 10 });
  const controller = new Controller(app, () => w.now);
  const tick = async (projectId = 'p/one') => { const busy = await controller.tick(); return { busy, release: (await app.release({ projectId, action: 'status' })).release }; };
  return { root, w, app, store, controller, tick, wakes: () => wakes };
}

test('dedicated instance: settled job is archived, grace runs, intake closes, stop is confirmed by GitHub', async t => {
  const f = await world(t);
  await f.app.bind(dedicated);
  const record = await f.app.submitJob(plan());
  assert.ok(f.wakes() >= 2, 'bind and submit wake the controller');
  let r = await f.tick();
  assert.equal(r.busy, true); assert.equal(r.release.state, 'waiting_for_leases');
  assert.deepEqual(r.release.blockers.map(b => b.kind), ['JOB_ACTIVE']);
  f.w.jobs.set(record.jobId, settle(f.w.jobs.get(record.jobId)));
  r = await f.tick();
  assert.equal(r.release.state, 'grace'); assert.equal(r.release.exportStatus, 'COMPLETE');
  f.w.now += 30_000;
  assert.equal((await f.tick()).release.state, 'grace');
  assert.deepEqual(f.w.posts, []);
  f.w.now += 31_000;
  r = await f.tick();
  assert.equal(r.release.state, 'stopping'); assert.equal(r.release.computeRelease, 'NOT_RELEASED');
  assert.deepEqual(f.w.posts, ['user/codespaces/space/stop']);
  assert.ok(f.w.closing, 'intake closed before the stop request');
  f.w.now += 5_000;
  r = await f.tick();          // GitHub still reports ShuttingDown: not yet released
  assert.equal(r.release.state, 'stopping');
  r = await f.tick();
  assert.equal(r.busy, false);
  assert.deepEqual([r.release.state, r.release.computeRelease, r.release.storageRelease], ['stopped', 'RELEASED', 'RETAINED']);
  // Results stay readable without contacting or restarting the instance.
  const calls = f.w.runnerCalls.length;
  const archived = await f.app.getJob({ projectId: 'p/one', jobId: record.jobId });
  assert.equal(archived.state, 'succeeded');
  let cursor = 'v1:0', text = '';
  for (;;) { const page = await f.app.jobLogs({ projectId: 'p/one', jobId: record.jobId, cursor, maxBytes: 5 }); text += page.text; if (page.complete) break; cursor = page.nextCursor; }
  assert.equal(text, 'line 中文\n'.repeat(3));
  assert.equal(f.w.runnerCalls.length, calls); assert.equal(f.w.posts.filter(p => p.endsWith('/start')).length, 0);
});

test('holds, unconfirmed submissions and a fresh prepare all keep the instance; request skips only the grace period', async t => {
  const f = await world(t);
  await f.app.bind(dedicated);
  await f.app.prepare({ projectId: 'p/one', requestId: 'prep' });
  assert.deepEqual((await f.tick()).release.blockers.map(b => b.kind), ['PREPARE_LEASE']);
  await f.app.release({ projectId: 'p/one', action: 'request' });
  assert.equal((await f.tick()).release.state, 'stopping', 'an explicit request skips the prepare lease and grace');
  await f.tick(); await f.tick();
  f.w.state = 'Available'; f.w.closing = null; f.w.posts.length = 0;
  const { hold } = await f.app.release({ projectId: 'p/one', action: 'hold', holdSeconds: 600 });
  await f.app.release({ projectId: 'p/one', action: 'request' });
  let r = await f.tick();
  assert.equal(r.release.state, 'waiting_for_leases'); assert.deepEqual(r.release.blockers.map(b => b.kind), ['HOLD']);
  assert.equal(r.release.requested, true, 'the request survives until it is consumed');
  await f.app.release({ projectId: 'p/one', action: 'unhold', holdId: hold.holdId });
  f.w.state = 'Shutdown';
  await f.app.submitJob(plan('lost')).catch(() => {});   // never sent: instance not Available
  f.w.state = 'Available';
  // An ambiguous submission blocks release until it is reconciled.
  const runner = f.app.runner.call;
  f.app.runner.call = async (...a) => { if (a[1] === 'job_submit') throw new AppError('TRANSPORT_UNAVAILABLE'); return runner(...a); };
  const unknown = await f.app.submitJob(plan('ambiguous'));
  f.app.runner.call = runner;
  assert.equal(unknown.submission, 'unknown');
  assert.ok((await f.tick()).release.blockers.some(b => b.kind === 'SUBMISSION_UNCONFIRMED'));
  f.w.now += 61_000;
  await f.tick();   // reconciles: the remote never saw it
  assert.equal((await f.store.read('job', unknown.jobId)).submission, 'not_sent');
  assert.equal((await f.tick()).release.state, 'stopping');
});

test('a job accepted just before closing wins; stop failures reopen intake, back off and end in action_required', async t => {
  const f = await world(t);
  await f.app.bind({ ...dedicated, resourcePolicy: { ...dedicated.resourcePolicy, graceSeconds: 0 } });
  f.w.closeRefused = true;
  let r = await f.tick(); r = await f.tick();
  assert.equal(r.release.state, 'waiting_for_leases'); assert.deepEqual(f.w.posts, []);
  f.w.closeRefused = false; f.w.stopFails = 99;
  for (let attempt = 1; attempt <= 5; attempt++) {
    r = await f.tick();
    assert.equal(f.w.closing, null, 'intake reopened after a failed stop');
    assert.equal(r.release.attempts, attempt);
    if (attempt < 5) { assert.equal(r.release.state, 'retry_pending'); assert.ok(r.release.nextAttemptAt > f.w.now); f.w.now = r.release.nextAttemptAt; }
  }
  assert.equal(r.release.state, 'action_required'); assert.equal(r.release.errorCode, 'GITHUB_REQUEST_FAILED'); assert.equal(r.busy, false);
  assert.equal((await f.tick()).busy, false, 'gives up until an explicit request');
});

test('a stop GitHub accepts but never completes is retried, then reported as action_required', async t => {
  const f = await world(t);
  await f.app.bind({ ...dedicated, resourcePolicy: { ...dedicated.resourcePolicy, graceSeconds: 0 } });
  const realStop = f.app.gh.stop.bind(f.app.gh);
  f.app.gh.stop = async name => { f.w.posts.push(`ignored ${name}`); };   // accepted, no effect
  let r;
  for (let i = 0; i < 20 && r?.release.state !== 'action_required'; i++) { r = await f.tick(); f.w.now += 130_000; f.w.closing = null; }
  assert.equal(r.release.state, 'action_required'); assert.equal(r.release.errorCode, 'STOP_UNCONFIRMED');
  assert.equal(f.w.posts.length, 5);
  f.app.gh.stop = realStop;
});

test('export failures block within the export window; afterwards the stop proceeds and the export is PENDING', async t => {
  const f = await world(t);
  await f.app.bind({ ...dedicated, resourcePolicy: { ...dedicated.resourcePolicy, graceSeconds: 0, exportTimeoutSeconds: 30 } });
  const record = await f.app.submitJob(plan());
  f.w.jobs.set(record.jobId, settle(f.w.jobs.get(record.jobId)));
  f.w.failLogs = true;
  const ended = f.w.now; f.w.jobs.set(record.jobId, { ...f.w.jobs.get(record.jobId), endedAt: ended / 1000 });
  f.w.now = ended + 10_000;   // inside the 30 s window
  let r = await f.tick();
  assert.deepEqual(r.release.blockers.map(b => b.kind), ['EXPORT_RUNNING']);
  f.w.now = ended + 31_000;
  r = await f.tick(); r = await f.tick();
  assert.equal(r.release.state, 'stopping'); assert.equal(r.release.exportStatus, 'PENDING');
  await f.tick(); r = await f.tick();
  assert.equal(r.release.state, 'stopped'); assert.equal(r.release.exportStatus, 'PENDING');
  await assert.rejects(f.app.getJob({ projectId: 'p/one', jobId: record.jobId }), { code: 'CODESPACE_NOT_READY' });
});

test('shared instances are never started or stopped; ownership must agree per instance; policies cannot exceed the binding', async t => {
  const f = await world(t);
  await f.app.bind(shared);
  assert.equal((await f.tick('p/shared')).busy, false);
  await assert.rejects(f.app.bind({ ...dedicated, codespaceName: 'space' }), { code: 'CONFIG_INVALID' });
  await assert.rejects(f.app.bind({ ...shared, projectId: 'p/x', preparePolicy: 'start_existing' }), { code: 'CONFIG_INVALID' });
  await assert.rejects(f.app.bind({ ...shared, projectId: 'p/x', resourcePolicy: { releaseMode: 'stop_after_export' } }), { code: 'CONFIG_INVALID' });
  f.w.state = 'Shutdown';
  const op = await f.app.prepare({ projectId: 'p/shared', requestId: 'x' });
  assert.equal(op.errorCode, 'CODESPACE_NOT_READY');
  await assert.rejects(f.app.prepare({ projectId: 'p/shared', requestId: 'y', policy: 'start_existing' }), { code: 'POLICY_NOT_ALLOWED' });
  await assert.rejects(f.app.release({ projectId: 'p/shared', action: 'request' }), { code: 'BLOCKED_SHARED_USAGE' });
  assert.deepEqual(f.w.posts, []);
});

test('start_existing starts a stopped dedicated instance and an externally stopped instance is recorded as released', async t => {
  const f = await world(t);
  await f.app.bind(dedicated);
  f.w.state = 'Shutdown';
  assert.equal((await f.app.prepare({ projectId: 'p/one', requestId: 'reuse', policy: 'reuse_only' })).errorCode, 'CODESPACE_NOT_READY');
  const ready = await f.app.prepare({ projectId: 'p/one', requestId: 'start' });
  assert.deepEqual(f.w.posts, ['user/codespaces/space/start']);
  assert.equal(ready.state, 'ready');
  f.w.state = 'Shutdown';   // e.g. the official idle timeout
  const r = await f.tick();
  assert.deepEqual([r.release.state, r.release.computeRelease, r.busy], ['stopped', 'RELEASED', false]);
});

test('only one controller runs per state directory', async t => {
  const f = await world(t);
  await f.app.bind(dedicated);
  f.w.state = 'Shutdown';
  let release;
  const blocker = new Promise(r => { release = r; });
  const tick = Controller.prototype.tick;
  Controller.prototype.tick = async function () { await blocker; return false; };
  try {
    const first = runController(f.app, { intervalMs: 1, idleTicks: 1 });
    await new Promise(r => setTimeout(r, 50));
    assert.equal(await runController(f.app, { intervalMs: 1, idleTicks: 1 }), false);
    release();
    assert.equal(await first, true);
    assert.equal(await runController(f.app, { intervalMs: 1, idleTicks: 1 }), true, 'lock released on exit');
  } finally { Controller.prototype.tick = tick; }
});

test('regression (live): a job that settles during a controller round is exported before the instance stops', async t => {
  const f = await world(t);
  await f.app.bind({ ...dedicated, resourcePolicy: { ...dedicated.resourcePolicy, graceSeconds: 0 } });
  const record = await f.app.submitJob(plan());
  await f.app.release({ projectId: 'p/one', action: 'request' });   // no grace period to hide the race
  // The live race: the job is seen running by one check and finishes right after it, within the same round.
  const call = f.app.runner.call;
  f.app.runner.call = async (b, action, fields) => {
    const result = await call(b, action, fields);
    if (action === 'job_get' && !result.settled) f.w.jobs.set(record.jobId, settle(result));
    return result;
  };
  let r = await f.tick();
  assert.notEqual(r.release.state, 'stopping', 'must not stop in the round the job was last seen running');
  for (let i = 0; i < 3 && r.release.state !== 'stopping'; i++) r = await f.tick();
  assert.equal(r.release.state, 'stopping'); assert.equal(r.release.exportStatus, 'COMPLETE');
  assert.ok(await f.app.archive.read(record.jobId), 'exported before the stop');
});

test('regression (live): prepare and job_submit do not hold the local state lock during network calls', async t => {
  const f = await world(t);
  await f.app.bind(dedicated);
  const free = [];
  const call = f.app.runner.call;
  f.app.runner.call = async (b, action, fields) => {
    free.push(await f.store.locked(async () => action));   // would throw STATE_BUSY if the tool still held the lock
    return call(b, action, fields);
  };
  assert.equal((await f.app.prepare({ projectId: 'p/one', requestId: 'p1' })).state, 'ready');
  assert.equal((await f.app.submitJob(plan())).submission, 'accepted');
  assert.deepEqual(free, ['handshake', 'job_submit']);
});
