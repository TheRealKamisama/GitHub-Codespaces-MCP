import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, chmod, readFile } from 'node:fs/promises';
import { accessSync, constants, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Github } from '../dist/github.js';
import { Store } from '../dist/storage.js';
import { Application } from '../dist/application.js';
import { Runner, buildSchema } from '../dist/transport/runner.js';

function writableWorkspaces() {
  try { return process.platform === 'linux' && statSync('/workspaces').isDirectory() && (accessSync('/workspaces', constants.W_OK), true); } catch { return false; }
}

// Real TypeScript client → bootstrap → runner chain. Only SSH is replaced: a stub gh runs the fixed remote command locally.
test('Linux end-to-end: local Application drives the real runner through the fixed SSH entry point', { skip: !writableWorkspaces() && 'NOT RUN: Linux with writable /workspaces required' }, async t => {
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
const args = process.argv.slice(2), out = v => process.stdout.write(JSON.stringify(v));
if (args[0] === '--version') process.stdout.write('gh version stub\\n');
else if (args[0] === 'auth') out({ hosts: { 'github.com': [{ active: true, state: 'success', login: 'fixture' }] } });
else if (args.at(-1) === 'user') out({ login: 'fixture' });
else if (args[0] === 'api') out({ name: 'fixture-space', state: 'Available', repository: { full_name: 'fixture/repo' }, owner: { login: 'fixture' } });
else if (args[0] === 'codespace' && args[1] === 'ssh') {
  const r = require('node:child_process').spawnSync('sh', ['-c', args.at(-1)], { input: require('node:fs').readFileSync(0), env: { ...process.env, CODESPACE_NAME: 'fixture-space' } });
  process.stdout.write(r.stdout); process.exit(r.status ?? 1);
} else process.exit(2);
`);
  await chmod(stub, 0o755);
  // Github hands this environment to the stub, which passes it to the "remote" side: git sees the redirect there.
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.file://${root}/remote/.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/' };
  const build = buildSchema.parse(JSON.parse(await readFile('dist/build.json', 'utf8')));
  const gh = new Github(undefined, env);
  const app = new Application(new Store(join(root, 'state')), gh, new Runner(gh, build));
  const projectId = 'dev/e2e';
  await app.bind({ projectId, expectedAccount: 'fixture', repository: 'fixture/repo', codespaceName: 'fixture-space', remoteProjectRoot: resolve(root, 'project'), githubHost: 'github.com', ownership: 'shared', preparePolicy: 'reuse_only' });
  const prepared = await app.prepare({ projectId, requestId: 'prepare-1' });
  assert.equal(prepared.state, 'ready', prepared.errorCode ?? '');
  assert.ok(prepared.handshake.capabilities.includes('revision_jobs'));
  const plan = { projectId, requestId: 'job-1', source: { ref: 'refs/heads/main', commit }, steps: [{ id: 'unit', role: 'test', kind: 'shell', shell: 'sh', script: 'sh test.sh' }] };
  const record = await app.submitJob(plan);
  assert.equal(record.submission, 'accepted', record.errorCode ?? '');
  let status;
  for (let i = 0; i < 6 && !status?.settled; i++) status = await app.getJob({ projectId, jobId: record.jobId, waitSeconds: 10 });
  assert.equal(status.state, 'succeeded'); assert.equal(status.source.resolvedCommit, commit);
  assert.deepEqual(status.summary, { execution: 'PASS', verification: 'PASS', cleanup: 'NOT_CONFIGURED' });
  const logs = await app.jobLogs({ projectId, jobId: record.jobId });
  assert.match(logs.text, new RegExp(`ran ${commit.slice(0, 7)}`)); assert.equal(logs.complete, true);
  assert.equal((await app.submitJob(plan)).status.acceptedAt, status.acceptedAt);
  assert.equal((await app.cancelJob({ projectId, jobId: record.jobId })).cancelRequested, false);
});
