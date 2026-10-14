import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execute } from '../dist/transport/process.js';
import { Github } from '../dist/github.js';
import { Store } from '../dist/storage.js';
import { Application } from '../dist/application.js';
import { AppError } from '../dist/errors.js';
import { Runner } from '../dist/transport/runner.js';
import { bindingInput, prepareInput } from '../dist/contracts.js';

const input = { projectId: 'dev/sample', expectedAccount: 'fixture', repository: 'fixture/repo', codespaceName: 'fixture-space', remoteProjectRoot: '/workspaces/fixture root/中文', githubHost: 'github.com', ownership: 'shared', preparePolicy: 'reuse_only' };
const handshake = { protocolVersion: 1, runnerSha256: 'a'.repeat(64), version: '0.1.0-alpha.0', gitSha: 'b'.repeat(40), dirty: true, codespaceName: 'fixture-space', generation: 'fixture-generation', pythonVersion: '3.12', platform: 'linux', capabilities: ['handshake', 'bounded_diagnostic'] };
const cs = { name: 'fixture-space', state: 'Available', repository: { full_name: 'fixture/repo' }, owner: { login: 'fixture' } };
const result = value => ({ stdout: JSON.stringify(value), stderr: 'diagnostic is not failure', exitCode: 0 });
function fakeGh(options = {}) {
  const calls = [];
  const gh = new Github(async (file, args, opts) => {
    calls.push({ file, args, opts });
    if (args[0] === '--version') return { stdout: 'gh version fixture\n', stderr: '', exitCode: 0 };
    if (args[0] === 'auth') return result({ hosts: { 'github.com': [{ active: true, state: options.authState ?? 'success', login: 'fixture', tokenSource: 'fixture-source' }] } });
    if (args.at(-1) === 'user') return result({ login: options.login ?? 'fixture' });
    if (args.at(-1).startsWith('user/codespaces?')) return result({ codespaces: [cs], total_count: 31 });
    return result({ ...cs, state: options.state ?? 'Available', ...options.codespace });
  }, {});
  return { gh, calls };
}
async function fixture(t, opts = {}) {
  const root = await mkdtemp(join(tmpdir(), 'm0-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { gh, calls } = fakeGh(opts);
  const store = new Store(root);
  const runner = { call: async () => handshake };
  const app = new Application(store, gh, runner);
  await app.bind(input);
  return { root, store, app, runner, gh, calls };
}

test('native argv preserves Unicode, spaces, quotes, newlines and shell metacharacters', async t => {
  const root = await mkdtemp(join(tmpdir(), 'm0 参数 '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, 'echo 参数.mjs');
  await writeFile(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2))); process.stderr.write("notice");');
  const args = ['', '空 格', '"quoted"', 'a\nb', '-leading', "a'b", '$(echo secret)', '`x`', 'a&b|c', 'C:\\path with space\\', '\\"'];
  const value = await execute(process.execPath, [script, ...args]);
  assert.deepEqual(JSON.parse(value.stdout), args);
  assert.equal(value.exitCode, 0); assert.equal(value.stderr, 'notice');
});
test('bounded process output, timeout and unavailable executable', async () => {
  await assert.rejects(execute(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000))'], { maxBytes: 10 }), { code: 'OUTPUT_LIMIT' });
  await assert.rejects(execute(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 }), { code: 'PROCESS_TIMEOUT' });
  await assert.rejects(execute('m0-nonexistent-executable', []), { code: 'EXECUTABLE_UNAVAILABLE' });
});
test('timeout terminates local descendants that retain the protocol pipe', async () => {
  const started = Date.now();
  const script = 'const {spawn}=require("node:child_process"); spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit"}); setInterval(()=>{},1000);';
  await assert.rejects(execute(process.execPath, ['-e', script], { timeoutMs: 500 }), { code: 'PROCESS_TIMEOUT' });
  assert.ok(Date.now() - started < 8000);
});
test('gh exit zero with auth error is rejected before API access', async () => {
  const { gh, calls } = fakeGh({ authState: 'error' });
  await assert.rejects(gh.identity(), { code: 'AUTH_REQUIRED' });
  assert.equal(calls.length, 2);
});
test('identity checks effective API account and bound expected account', async () => {
  await assert.rejects(fakeGh({ login: 'different' }).gh.identity(), { code: 'AUTH_IDENTITY_MISMATCH' });
  await assert.rejects(fakeGh().gh.identity('different'), { code: 'AUTH_IDENTITY_MISMATCH' });
  assert.equal((await fakeGh().gh.identity('FIXTURE')).account, 'fixture');
});
test('list remains paginated; identity responses contain no raw diagnostics', async () => {
  const { gh } = fakeGh();
  assert.equal((await gh.list(1)).nextPage, 2);
  assert.equal((await gh.list(2)).nextPage, null);
  assert.equal(JSON.stringify(await gh.identity()).includes('diagnostic'), false);
});
test('binding rejects stale version, repository and owner mismatch', async t => {
  const { app } = await fixture(t);
  await assert.rejects(app.bind(input), { code: 'BINDING_VERSION_CONFLICT' });
  assert.equal((await app.bind({ ...input, expectedVersion: 1 })).version, 2);
  await assert.rejects(fixture(t, { codespace: { repository: { full_name: 'other/repo' } } }), { code: 'REPOSITORY_MISMATCH' });
  await assert.rejects(fixture(t, { codespace: { owner: { login: 'other' } } }), { code: 'AUTH_IDENTITY_MISMATCH' });
});
test('state survives reconstruction; locale does not change prepare identity; ready is re-probed', async t => {
  const f = await fixture(t);
  const first = await f.app.prepare({ projectId: input.projectId, requestId: 'same', locale: 'en' });
  const resumed = new Application(new Store(f.root), f.gh, f.runner);
  const second = await resumed.prepare({ projectId: input.projectId, requestId: 'same', locale: 'zh-CN', operationId: first.operationId });
  assert.equal(first.state, 'ready'); assert.equal(second.operationId, first.operationId);
  f.runner.call = async () => { throw new AppError('TRANSPORT_UNAVAILABLE'); };
  const lost = await resumed.prepare({ projectId: input.projectId, requestId: 'same' });
  assert.equal(lost.state, 'unknown'); assert.equal(lost.handshake, null); assert.equal(lost.observation, 'unknown');
  f.runner.call = async () => handshake;
  assert.equal((await resumed.prepare({ projectId: input.projectId, requestId: 'same' })).state, 'ready');
  assert.equal(f.calls.some(c => c.args.includes('POST')), false);
});
test('prepare stopped instance never connects; changed binding cannot reuse old request', async t => {
  const f = await fixture(t, { state: 'Shutdown' });
  f.runner.call = async () => { assert.fail('must not connect'); };
  assert.equal((await f.app.prepare({ projectId: input.projectId, requestId: 'one' })).errorCode, 'CODESPACE_NOT_READY');
  await f.app.bind({ ...input, remoteProjectRoot: '/workspaces/new', expectedVersion: 1 });
  await assert.rejects(f.app.prepare({ projectId: input.projectId, requestId: 'one' }), { code: 'IDEMPOTENCY_CONFLICT' });
});
test('schemas reject unknown fields, paid policies and escaping paths', () => {
  for (const root of ['/tmp/x', '/workspaces/../x', '/workspaces/x//y', '/workspaces/x/./y', '/workspaces/x\ny', '/workspaces/']) assert.equal(bindingInput.safeParse({ ...input, remoteProjectRoot: root }).success, false);
  assert.equal(bindingInput.safeParse({ ...input, token: 'not-a-credential' }).success, false);
  assert.equal(prepareInput.safeParse({ projectId: 'x', requestId: 'x', policy: 'create_if_missing' }).success, false);
});
test('cross-instance storage lock and invalid state fail closed; Windows rename replaces atomically', async t => {
  const f = await fixture(t);
  await f.store.locked(async () => assert.rejects(new Store(f.root).locked(async () => 0), { code: 'STATE_BUSY' }));
  await f.store.write('sample', 'a', { version: 1 }); await f.store.write('sample', 'a', { version: 2 });
  assert.deepEqual(await f.store.read('sample', 'a'), { version: 2 });
  await writeFile(f.store.path('sample', 'a'), '{broken');
  await assert.rejects(f.store.read('sample', 'a'), { code: 'STATE_INVALID' });
  await writeFile(f.store.path('sample', 'a'), ' '.repeat(65537));
  await assert.rejects(f.store.read('sample', 'a'), { code: 'STATE_INVALID' });
});
test('runner command carries dynamic paths only in stdin and verifies build identity', async () => {
  const build = JSON.parse(await readFile('dist/build.json', 'utf8'));
  let captured;
  const gh = { command: async (args, stdin) => {
    captured = { args, stdin };
    return result({ ok: true, data: { ...handshake, ...{ runnerSha256: build.runnerSha256, version: build.version, gitSha: build.gitSha, dirty: build.dirty } }, error: null });
  } };
  const b = { ...input, remoteProjectRoot: '/workspaces/quote\' 中文 $(echo x)', schemaVersion: 1, version: 1, locale: 'en' };
  await new Runner(gh, build).call(b, 'handshake');
  assert.equal(captured.args.at(-1).includes(b.remoteProjectRoot), false);
  assert.equal(JSON.parse(captured.stdin).binding.remoteProjectRoot, b.remoteProjectRoot);
  assert.ok(captured.args.includes('BatchMode=yes'));
  const badGh = { command: async () => result({ ok: true, data: handshake, error: null }) };
  await assert.rejects(new Runner(badGh, build).call(b, 'handshake'), { code: 'RUNNER_INCOMPATIBLE' });
});
