import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, chmod, readFile } from 'node:fs/promises';
import { accessSync, constants, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Github } from '../dist/github.js';
import { Store } from '../dist/storage.js';
import { Application } from '../dist/application.js';
import { Controller } from '../dist/lifecycle.js';
import { Runner, buildSchema } from '../dist/transport/runner.js';

function writableWorkspaces() {
  try { return process.platform === 'linux' && statSync('/workspaces').isDirectory() && (accessSync('/workspaces', constants.W_OK), true); } catch { return false; }
}
const skip = !writableWorkspaces() && 'NOT RUN: Linux with writable /workspaces required';

// Real TypeScript client → bootstrap → runner chain. Only SSH and the GitHub API are replaced: a stub gh runs the fixed
// remote command locally and keeps the instance state in a file, so stop/start requests change what later reads see.
async function fixture(t, ownership) {
  const root = await mkdtemp('/workspaces/m1-e2e-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=f', '-c', 'user.email=f@example.invalid', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();
  const remote = join(root, 'remote', 'fixture', 'repo.git'), work = join(root, 'work');
  git(root, 'init', '-q', '--bare', remote); git(root, 'init', '-q', work);
  await writeFile(join(work, 'test.sh'), 'echo "ran $(git rev-parse --short HEAD)"\n');
  git(work, 'add', '-A'); git(work, 'commit', '-q', '-m', 'one');
  git(work, 'push', '-q', remote, 'HEAD:refs/heads/main');
  const commit = git(work, 'rev-parse', 'HEAD');
  const bin = join(root, 'bin');
  await mkdir(bin);
  const stub = join(bin, 'gh');
  await writeFile(stub, `#!/usr/bin/env node
const fs = require('node:fs'), args = process.argv.slice(2), out = v => process.stdout.write(JSON.stringify(v));
const stateFile = process.env.STUB_STATE_FILE, state = () => fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : 'Available';
if (args[0] === '--version') process.stdout.write('gh version stub\\n');
else if (args[0] === 'auth') out({ hosts: { 'github.com': [{ active: true, state: 'success', login: 'fixture' }] } });
else if (args.at(-1) === 'user') out({ login: 'fixture' });
else if (args[0] === 'api' && args.includes('POST')) { fs.appendFileSync(stateFile + '.posts', args.at(-1) + '\\n'); fs.writeFileSync(stateFile, args.at(-1).endsWith('/stop') ? 'Shutdown' : 'Available'); }
else if (args[0] === 'api') out({ name: 'fixture-space', state: state(), repository: { full_name: 'fixture/repo' }, owner: { login: 'fixture' } });
else if (args[0] === 'codespace' && args[1] === 'cp') {
  // Like scp: copy the literal remote path (this "remote" is the local file system) to the local destination.
  const [source, destination] = args.slice(-2);
  fs.cpSync(source.replace(/^remote:/, ''), destination, { recursive: args.includes('-r'), errorOnExist: true, force: false });
}
else if (args[0] === 'codespace' && args[1] === 'ssh') {
  const r = require('node:child_process').spawnSync('sh', ['-c', args.at(-1)], { input: fs.readFileSync(0), maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CODESPACE_NAME: 'fixture-space' } });
  // process.exit() would drop unflushed pipe output for large responses; let the stream drain instead.
  process.stdout.write(r.stdout); process.exitCode = r.status ?? 1;
} else process.exit(2);
`);
  await chmod(stub, 0o755);
  // Github hands this environment to the stub, which passes it to the "remote" side: git sees the redirect there.
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_STATE_FILE: join(root, 'instance-state'), CODESPACE_MCP_INSTANCE_ROOT: join(root, 'instance'),
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.file://${root}/remote/.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/' };
  const build = buildSchema.parse(JSON.parse(await readFile('dist/build.json', 'utf8')));
  const gh = new Github(undefined, env);
  const app = new Application(new Store(join(root, 'state')), gh, new Runner(gh, build));
  const projectId = 'dev/e2e';
  const extra = ownership === 'dedicated' ? { ownership, preparePolicy: 'start_existing', resourcePolicy: { releaseMode: 'stop_after_export', graceSeconds: 0, exportTimeoutSeconds: 120 } } : { ownership, preparePolicy: 'reuse_only' };
  await app.bind({ projectId, expectedAccount: 'fixture', repository: 'fixture/repo', codespaceName: 'fixture-space', remoteProjectRoot: resolve(root, 'project'), githubHost: 'github.com', ...extra });
  return { root, app, projectId, commit, work, posts: async () => (await readFile(join(root, 'instance-state.posts'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean) };
}
async function settled(app, projectId, jobId) {
  let status;
  for (let i = 0; i < 12 && !status?.settled; i++) status = await app.getJob({ projectId, jobId, waitSeconds: 10 });
  return status;
}

test('Linux end-to-end: local Application drives the real runner through the fixed SSH entry point', { skip }, async t => {
  const { app, projectId, commit } = await fixture(t, 'shared');
  const prepared = await app.prepare({ projectId, requestId: 'prepare-1' });
  assert.equal(prepared.state, 'ready', prepared.errorCode ?? '');
  assert.ok(prepared.handshake.capabilities.includes('revision_jobs'));
  const plan = { projectId, requestId: 'job-1', source: { ref: 'refs/heads/main', commit }, steps: [{ id: 'unit', role: 'test', kind: 'shell', shell: 'sh', script: 'sh test.sh' }] };
  const record = await app.submitJob(plan);
  assert.equal(record.submission, 'accepted', record.errorCode ?? '');
  const status = await settled(app, projectId, record.jobId);
  assert.equal(status.state, 'succeeded'); assert.equal(status.source.resolvedCommit, commit);
  assert.deepEqual(status.summary, { execution: 'PASS', verification: 'PASS', cleanup: 'NOT_CONFIGURED' });
  const logs = await app.jobLogs({ projectId, jobId: record.jobId });
  assert.match(logs.text, new RegExp(`ran ${commit.slice(0, 7)}`)); assert.equal(logs.complete, true);
  assert.equal((await app.submitJob(plan)).status.acceptedAt, status.acceptedAt);
  assert.equal((await app.cancelJob({ projectId, jobId: record.jobId })).cancelRequested, false);
});

test('Linux end-to-end: dedicated instance is exported, closed and stopped by the real controller and runner', { skip }, async t => {
  const { app, projectId, commit, posts } = await fixture(t, 'dedicated');
  // About 1.6 MB of multi-byte log text: export must page across 1 MiB pages without corrupting characters.
  const script = 'i=0; while [ $i -lt 100000 ]; do echo "line $i 中文"; i=$((i+1)); done';
  const record = await app.submitJob({ projectId, requestId: 'job-1', source: { ref: 'refs/heads/main', commit }, steps: [{ id: 'noisy', role: 'build', kind: 'shell', shell: 'sh', script }] });
  assert.equal(record.submission, 'accepted', record.errorCode ?? '');
  assert.equal((await settled(app, projectId, record.jobId)).state, 'succeeded');
  const controller = new Controller(app);
  let release;
  for (let i = 0; i < 6 && release?.state !== 'stopped'; i++) {
    await controller.tick();
    release = (await app.release({ projectId, action: 'status' })).release;
  }
  assert.deepEqual([release.state, release.computeRelease, release.storageRelease, release.exportStatus], ['stopped', 'RELEASED', 'RETAINED', 'COMPLETE'], JSON.stringify(release));
  assert.deepEqual(await posts(), ['user/codespaces/fixture-space/stop']);
  // The instance is "stopped": reads come from the local archive and match the runner's log byte for byte.
  const archived = await app.getJob({ projectId, jobId: record.jobId });
  assert.equal(archived.state, 'succeeded');
  let cursor = 'v1:0', text = '';
  for (;;) { const page = await app.jobLogs({ projectId, jobId: record.jobId, cursor, maxBytes: 262144 }); text += page.text; if (page.complete) break; cursor = page.nextCursor; }
  const remoteLog = await readFile(join(resolve(app.store.root, '..', 'project'), '.codespace-mcp', 'jobs', record.jobId, 'job.log'));
  assert.ok(remoteLog.length > 1024 * 1024);
  assert.equal(createHash('sha256').update(text).digest('hex'), createHash('sha256').update(remoteLog).digest('hex'));
  assert.ok(text.includes('line 99999 中文'));
  // Intake stayed closed after the release: a late submission is refused rather than racing the stop.
  const late = await app.submitJob({ projectId, requestId: 'late', source: { ref: 'refs/heads/main', commit }, steps: [{ id: 'x', role: 'build', kind: 'command', argv: ['true'] }] });
  assert.equal(late.submission, 'not_sent'); assert.equal(late.errorCode, 'CODESPACE_NOT_READY');
});

test('Linux end-to-end: the artifact demo is built, frozen, downloaded with verified bytes, exported before stop and downloaded offline', { skip }, async t => {
  const { root, app, projectId, commit, work, posts } = await fixture(t, 'dedicated');
  const example = JSON.parse(await readFile('examples/jobs/artifact-build-and-download.json', 'utf8'));
  const record = await app.submitJob({ projectId, requestId: 'artifact-demo', source: { ref: 'refs/heads/main', commit }, ...example.plan });
  assert.equal(record.submission, 'accepted', record.errorCode ?? '');
  const status = await settled(app, projectId, record.jobId);
  assert.equal(status.state, 'succeeded', JSON.stringify(status.artifacts));
  assert.deepEqual(Object.fromEntries(status.artifacts.map(a => [a.name, a.state])), example.expect.artifacts);
  // Expected bytes, recomputed locally rather than trusted from the runner.
  const expectedTar = execFileSync('git', ['archive', '--format=tar', commit], { cwd: work });
  const blob = Buffer.concat(Array.from({ length: 163840 }, (_, i) => createHash('sha256').update(`blob-${i}`).digest()));
  const out = join(root, 'downloads');
  await mkdir(out);
  const fetched = {};
  for (const name of ['package', 'blob', 'build-report', 'notes', 'junit']) {
    fetched[name] = await app.downloadArtifact({ projectId, jobId: record.jobId, artifact: name, localDestination: join(out, `live-${name}`) });
    assert.equal(fetched[name].source, 'codespace');
  }
  assert.ok((await readFile(join(out, 'live-package'))).equals(expectedTar), 'package equals a local git archive of the same commit');
  assert.ok((await readFile(join(out, 'live-blob'))).equals(blob), 'blob equals the locally recomputed bytes');
  assert.equal(JSON.parse(await readFile(join(out, 'live-build-report', 'summary.json'), 'utf8')).tarSha256, createHash('sha256').update(expectedTar).digest('hex'));
  assert.equal(await readFile(join(out, 'live-notes'), 'utf8'), `构建于 ${commit}\n`);
  assert.match(await readFile(join(out, 'live-junit'), 'utf8'), /failures="0"/);
  // The controller exports the artifacts with the job, then stops the instance; downloads keep working offline.
  const controller = new Controller(app);
  let release;
  for (let i = 0; i < 6 && release?.state !== 'stopped'; i++) { await controller.tick(); release = (await app.release({ projectId, action: 'status' })).release; }
  assert.deepEqual([release.state, release.exportStatus], ['stopped', 'COMPLETE']);
  assert.deepEqual((await app.archive.read(record.jobId)).receipt.artifactsExported.sort(), ['blob', 'build-report', 'junit', 'notes', 'package']);
  assert.deepEqual(await posts(), ['user/codespaces/fixture-space/stop']);
  const offline = await app.downloadArtifact({ projectId, jobId: record.jobId, artifact: 'blob', localDestination: join(out, 'offline-blob') });
  assert.equal(offline.source, 'archive');
  assert.ok((await readFile(join(out, 'offline-blob'))).equals(blob));
  const report = await app.downloadArtifact({ projectId, jobId: record.jobId, artifact: 'build-report', localDestination: join(out, 'offline-report') });
  assert.deepEqual([report.source, report.files], ['archive', 2]);
});
