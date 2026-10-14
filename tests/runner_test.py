"""Portable units plus opt-in-by-platform Linux integration. No GitHub calls."""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('runner', ROOT / 'runner/main.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class PortableTests(unittest.TestCase):
    def test_atomic_replace_unicode(self):
        with tempfile.TemporaryDirectory(prefix='m0-') as temporary:
            path = Path(temporary) / '状态.json'
            runner.atomic(path, {'version': 1})
            runner.atomic(path, {'version': 2, 'text': '中文'})
            self.assertEqual(json.loads(path.read_text(encoding='utf-8')), {'version': 2, 'text': '中文'})
            self.assertEqual(list(Path(temporary).iterdir()), [path])

    def test_generation_change_is_interruption_not_success(self):
        status = {'state': 'running', 'generation': 'old', 'updatedAt': 1}
        self.assertEqual(runner.reconcile(status, 'new', 10)['state'], 'interrupted')
        self.assertEqual(status['state'], 'running')

    def test_stale_observation_is_unknown_not_execution_failure(self):
        status = {'state': 'running', 'generation': 'same', 'updatedAt': 1}
        self.assertEqual(runner.reconcile(status, 'same', 10)['state'], 'unknown')
        self.assertEqual(runner.reconcile(status, 'same', 2)['state'], 'running')
        self.assertEqual(runner.reconcile({**status, 'state': 'completed'}, 'new', 10)['state'], 'completed')

    def test_worker_is_bounded_and_persists_completion(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'probe.json'
            runner.atomic(path, {'state': 'accepted'})
            with patch.object(runner.time, 'sleep') as sleep:
                runner.worker(path)
            self.assertEqual(sleep.call_count, 10)
            self.assertEqual(json.loads(path.read_text())['state'], 'completed')

    def test_non_linux_fails_explicitly(self):
        with patch.object(runner.sys, 'platform', 'win32'):
            with self.assertRaisesRegex(ValueError, 'PLATFORM_UNSUPPORTED'):
                runner.main({'protocolVersion': 1, 'action': 'handshake'})

    def test_summary_never_turns_missing_evidence_into_pass(self):
        step = lambda role, state, optional=False: {'role': role, 'state': state, 'optional': optional}
        self.assertEqual(runner.summarize([step('build', 'passed')]), {'execution': 'PASS', 'verification': 'NOT_CONFIGURED', 'cleanup': 'NOT_CONFIGURED'})
        self.assertEqual(runner.summarize([step('build', 'failed'), step('test', 'not_run'), step('cleanup', 'passed')]),
                         {'execution': 'FAIL', 'verification': 'NOT_RUN', 'cleanup': 'PASS'})
        self.assertEqual(runner.summarize([step('test', 'passed'), step('test', 'failed', True)])['verification'], 'PASS')
        self.assertEqual(runner.summarize([step('test', 'cancelled')]), {'execution': 'INCOMPLETE', 'verification': 'NOT_RUN', 'cleanup': 'NOT_CONFIGURED'})
        self.assertEqual(runner.summarize([step('test', 'pending')], 'source')['execution'], 'NOT_RUN')

    def test_job_validation_rejects_escapes_and_mismatched_binding(self):
        job = {'schemaVersion': 1, 'jobId': 'a' * 64, 'digest': 'b' * 64, 'projectId': 'p', 'timeoutSeconds': 60,
               'source': {'mode': 'revision', 'repository': 'Owner/Repo', 'ref': 'refs/heads/main', 'commit': 'c' * 40},
               'steps': [{'id': 'one', 'role': 'test', 'kind': 'command', 'argv': ['true'], 'cwd': '.', 'env': {}, 'optional': False}]}
        binding = {'projectId': 'p', 'repository': 'owner/repo'}
        runner.validate_job(job, binding)
        for bad in ({'cwd': '../x'}, {'cwd': '/etc'}, {'argv': []}, {'env': {'1BAD': 'x'}}, {'role': 'service'}, {'kind': 'shell', 'shell': 'zsh', 'script': ''}):
            with self.assertRaisesRegex(ValueError, 'CONFIG_INVALID'):
                runner.validate_job({**job, 'steps': [{**job['steps'][0], **bad}]}, binding)
        for ref in ('refs/heads/../x', 'main', 'refs/heads/x.lock', 'refs/pull/1/head'):
            with self.assertRaisesRegex(ValueError, 'CONFIG_INVALID'):
                runner.validate_job({**job, 'source': {**job['source'], 'ref': ref}}, binding)
        with self.assertRaisesRegex(ValueError, 'REPOSITORY_MISMATCH'):
            runner.validate_job(job, {**binding, 'repository': 'other/repo'})
        with self.assertRaisesRegex(ValueError, 'CONFIG_INVALID'):
            runner.validate_job(job, {**binding, 'projectId': 'other'})
        self.assertEqual(runner.safe_relative('./a//b/'), ['a', 'b'])


@unittest.skipUnless(sys.platform == 'linux' and Path('/workspaces').is_dir() and os.access('/workspaces', os.W_OK), 'NOT RUN: Linux with writable /workspaces required')
class LinuxIntegration(unittest.TestCase):
    def test_install_disconnect_reconnect_conflicts_and_hash(self):
        root = Path(tempfile.mkdtemp(prefix='m0-test-', dir='/workspaces')).resolve()
        try:
            source = (ROOT / 'runner/main.py').read_bytes()
            build = json.loads((ROOT / 'dist/build.json').read_text())
            build['runnerSha256'] = hashlib.sha256(source).hexdigest()
            request = {'protocolVersion': 1, 'action': 'handshake', 'source': base64.b64encode(source).decode(), 'build': build,
                       'binding': {'codespaceName': 'local-linux-fixture', 'projectId': 'test', 'expectedAccount': 'fixture', 'repository': 'fixture/repo', 'remoteProjectRoot': str(root / "中文 ' path")}}
            def call(payload=request):
                completed = subprocess.run([sys.executable, str(ROOT / 'runner/bootstrap.py')], input=json.dumps(payload), text=True, capture_output=True, timeout=10,
                                           env={**os.environ, 'CODESPACE_NAME': 'local-linux-fixture'})
                self.assertEqual(completed.returncode, 0)
                return json.loads(completed.stdout)
            self.assertTrue(call()['ok'])
            probe = {**request, 'action': 'diagnostic_start', 'probeId': 'a' * 64}
            accepted = call(probe)
            self.assertTrue(accepted['ok'])
            started = accepted['data']['startedAt']
            # Each invocation closes its pipe/parent; the detached diagnostic must continue.
            for _ in range(14):
                observed = call({**probe, 'action': 'diagnostic_get'})
                if observed['data']['state'] == 'completed':
                    break
                time.sleep(1)
            self.assertEqual(observed['data']['state'], 'completed')
            self.assertEqual(call(probe)['data']['startedAt'], started)
            self.assertEqual(call({**request, 'build': {**build, 'runnerSha256': '0' * 64}})['error'], 'HASH_MISMATCH')
            conflict = root / 'existing'; conflict.mkdir(); (conflict / 'user.txt').write_text('preserve')
            conflict_request = {**request, 'binding': {**request['binding'], 'remoteProjectRoot': str(conflict)}}
            self.assertEqual(call(conflict_request)['error'], 'WORKSPACE_CONFLICT')
            self.assertEqual([p.name for p in conflict.iterdir()], ['user.txt'])
            symlink = root / 'link'; symlink.symlink_to(conflict, target_is_directory=True)
            self.assertEqual(call({**request, 'binding': {**request['binding'], 'remoteProjectRoot': str(symlink)}})['error'], 'PATH_INVALID')
        finally:
            # Only this test's verified disposable directory is removed.
            assert root.parent == Path('/workspaces') and root.name.startswith('m0-test-')
            shutil.rmtree(root)


def git(cwd, *args):
    return subprocess.run(['git', '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'init.defaultBranch=main', *args],
                          cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def commit(work, files, message):
    for name, content in files.items():
        path = Path(work) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
    git(work, 'add', '-A')
    git(work, 'commit', '-q', '-m', message)
    return git(work, 'rev-parse', 'HEAD')


def marker_processes(marker):
    found = []
    for entry in Path('/proc').iterdir():
        try:
            if entry.name.isdigit() and marker in (entry / 'cmdline').read_bytes().decode(errors='replace') and \
                    (entry / 'stat').read_text().rsplit(')', 1)[1].split()[0] != 'Z':
                found.append(int(entry.name))
        except OSError:
            pass
    return found


@unittest.skipUnless(sys.platform == 'linux' and Path('/workspaces').is_dir() and os.access('/workspaces', os.W_OK) and shutil.which('git'), 'NOT RUN: Linux with writable /workspaces and git required')
class LinuxJobs(unittest.TestCase):
    """Exact-revision jobs through the real bootstrap entry; a local bare repository stands in for github.com."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='m1-test-', dir='/workspaces')).resolve()
        remote = self.root / 'remote' / 'fixture' / 'repo.git'
        remote.parent.mkdir(parents=True)
        git(self.root, 'init', '-q', '--bare', str(remote))
        self.work = self.root / 'work'
        git(self.root, 'init', '-q', str(self.work))
        git(self.work, 'remote', 'add', 'origin', str(remote))
        self.base = commit(self.work, {'tracked.txt': 'original\n', 'sub/dir/keep.txt': 'x\n'}, 'base')
        git(self.work, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
        # The branch moves on after the requested commit was pushed.
        self.tip = commit(self.work, {'tracked.txt': 'newer\n'}, 'tip')
        git(self.work, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
        source = (ROOT / 'runner/main.py').read_bytes()
        build = json.loads((ROOT / 'dist/build.json').read_text())
        build['runnerSha256'] = hashlib.sha256(source).hexdigest()
        self.binding = {'codespaceName': 'local-linux-fixture', 'projectId': 'test', 'expectedAccount': 'fixture',
                        'repository': 'fixture/repo', 'remoteProjectRoot': str(self.root / 'project 中文')}
        self.request = {'protocolVersion': 1, 'source': base64.b64encode(source).decode(), 'build': build, 'binding': self.binding}
        self.env = {**os.environ, 'CODESPACE_NAME': 'local-linux-fixture', 'GH_TOKEN': 'must-not-reach-steps',
                    'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': f'url.file://{self.root}/remote/.insteadOf',
                    'GIT_CONFIG_VALUE_0': 'https://github.com/'}
        self.counter = 0

    def tearDown(self):
        for marker in ('m1-marker-',):
            for pid in marker_processes(marker):
                try:
                    os.kill(pid, 9)
                except OSError:
                    pass
        assert self.root.parent == Path('/workspaces') and self.root.name.startswith('m1-test-')
        shutil.rmtree(self.root)

    def call(self, action, **fields):
        completed = subprocess.run([sys.executable, str(ROOT / 'runner/bootstrap.py')], input=json.dumps({**self.request, 'action': action, **fields}),
                                   text=True, capture_output=True, timeout=40, env=self.env)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout)

    def job(self, steps, commit=None, ref='refs/heads/main', timeout=60, **extra):
        self.counter += 1
        return {'schemaVersion': 1, 'jobId': hashlib.sha256(f'job-{self.counter}'.encode()).hexdigest(),
                'digest': hashlib.sha256(json.dumps(steps).encode()).hexdigest(), 'projectId': 'test', 'requestId': f'r{self.counter}',
                'timeoutSeconds': timeout, 'source': {'mode': 'revision', 'repository': 'fixture/repo', 'ref': ref, 'commit': commit or self.base},
                'steps': [{'cwd': '.', 'env': {}, 'optional': False, 'kind': 'command', **s} for s in steps], **extra}

    def settle(self, job_id, limit=60):
        deadline = time.time() + limit
        while time.time() < deadline:
            result = self.call('job_get', jobId=job_id, waitSeconds=5)
            self.assertTrue(result['ok'], result)
            if result['data']['settled']:
                return result['data']
        self.fail('job did not settle')

    def wait_state(self, job_id, state, limit=30):
        deadline = time.time() + limit
        while time.time() < deadline:
            data = self.call('job_get', jobId=job_id)['data']
            if data['state'] == state:
                return data
            time.sleep(0.3)
        self.fail(f'job never reached {state}')

    def logs(self, job_id, page):
        cursor, chunks = 'v1:0', []
        while True:
            result = self.call('job_logs', jobId=job_id, cursor=cursor, maxBytes=page)
            self.assertTrue(result['ok'], result)
            chunks.append(result['data']['text'])
            if result['data']['nextCursor'] == cursor:
                return ''.join(chunks), result['data']
            cursor = result['data']['nextCursor']

    def test_exact_commit_steps_logs_cleanup_and_idempotency(self):
        job = self.job([
            {'id': 'build', 'role': 'build', 'kind': 'shell', 'shell': 'sh', 'cwd': 'sub/dir',
             'script': 'echo "构建 $(cat ../../tracked.txt) in ${PWD##*/} token=${GH_TOKEN:-absent} job=${CODESPACE_MCP_STEP_ID}"\nprintf changed > ../../tracked.txt\n'},
            {'id': 'head', 'role': 'analysis', 'argv': ['git', 'rev-parse', 'HEAD']},
            {'id': 'flaky', 'role': 'test', 'argv': ['sh', '-c', 'exit 5'], 'optional': True},
            {'id': 'unit', 'role': 'test', 'argv': ['sh', '-c', 'echo "$GREETING"; exit 3'], 'env': {'GREETING': 'hello 世界'}},
            {'id': 'after', 'role': 'test', 'argv': ['true']},
            {'id': 'tidy', 'role': 'cleanup', 'argv': ['sh', '-c', 'echo cleaned']},
        ])
        accepted = self.call('job_submit', job=job)
        self.assertTrue(accepted['ok'], accepted)
        self.assertIn(accepted['data']['state'], ('accepted', 'preparing', 'queued', 'running'))
        data = self.settle(job['jobId'])
        self.assertEqual((data['state'], data['errorCode']), ('failed', 'STEP_FAILED'))
        self.assertEqual(data['source']['requestedCommit'], self.base)
        self.assertEqual(data['source']['resolvedCommit'], self.base)
        self.assertTrue(data['source']['sourceModified'])
        self.assertEqual(data['source']['workdir'], str(Path(self.binding['remoteProjectRoot']) / 'runs' / job['jobId'] / 'src'))
        states = {s['id']: (s['state'], s['exitCode']) for s in data['steps']}
        self.assertEqual(states, {'build': ('passed', 0), 'head': ('passed', 0), 'flaky': ('failed', 5), 'unit': ('failed', 3),
                                  'after': ('not_run', None), 'tidy': ('passed', 0)})
        self.assertEqual(data['summary'], {'execution': 'FAIL', 'verification': 'FAIL', 'cleanup': 'PASS'})
        text, last = self.logs(job['jobId'], 7)
        self.assertTrue(last['complete'])
        self.assertIn('构建 original in dir token=absent job=build', text)
        self.assertIn(self.base, text)
        self.assertNotIn(self.tip, text)
        self.assertIn('hello 世界', text)
        self.assertIn('cleaned', text)
        self.assertNotIn('�', text)
        self.assertEqual(self.call('job_logs', jobId=job['jobId'], cursor='v1:99999999', maxBytes=10)['error'], 'CURSOR_INVALID')
        # A lost submit response is reconciled with the same job; a different plan under the same id is refused.
        again = self.call('job_submit', job=job)['data']
        self.assertEqual((again['acceptedAt'], again['state']), (data['acceptedAt'], 'failed'))
        self.assertEqual(self.call('job_submit', job={**job, 'digest': 'f' * 64})['error'], 'IDEMPOTENCY_CONFLICT')
        self.assertEqual(self.call('job_get', jobId='e' * 64)['error'], 'JOB_NOT_FOUND')
        self.assertEqual(self.call('job_cancel', jobId=job['jobId'])['data']['cancelRequested'], False)

    def test_unreachable_lfs_and_submodule_sources_fail_before_steps(self):
        git(self.work, 'checkout', '-q', '-b', 'side', self.base)
        orphan = commit(self.work, {'side.txt': 'x'}, 'side only')
        lfs = commit(self.work, {'.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n'}, 'lfs')
        git(self.work, 'push', '-q', 'origin', 'HEAD:refs/heads/lfs')
        git(self.work, 'checkout', '-q', '-b', 'mod', self.base)
        git(self.work, 'update-index', '--add', '--cacheinfo', f'160000,{self.base},vendor/lib')
        git(self.work, 'commit', '-q', '-m', 'gitlink')
        submodule = git(self.work, 'rev-parse', 'HEAD')
        git(self.work, 'push', '-q', 'origin', 'HEAD:refs/heads/mod')
        cases = [(orphan, 'refs/heads/main', 'REVISION_UNREACHABLE'), (lfs, 'refs/heads/lfs', 'LFS_UNSUPPORTED'),
                 (submodule, 'refs/heads/mod', 'SUBMODULES_UNSUPPORTED'), (self.base, 'refs/heads/missing', 'SOURCE_FETCH_FAILED')]
        for sha, ref, code in cases:
            job = self.job([{'id': 'never', 'role': 'test', 'argv': ['sh', '-c', 'echo m1-marker-ran']}], commit=sha, ref=ref)
            self.assertTrue(self.call('job_submit', job=job)['ok'])
            data = self.settle(job['jobId'])
            self.assertEqual((data['state'], data['errorCode']), ('failed', code))
            self.assertEqual(data['steps'][0]['state'], 'not_run')
            self.assertEqual(data['summary']['execution'], 'NOT_RUN')
            self.assertIsNone(data['source']['resolvedCommit'])
        self.assertEqual(self.call('job_submit', job={**self.job([{'id': 'x', 'role': 'test', 'argv': ['true']}]), 'source': {
            'mode': 'revision', 'repository': 'other/repo', 'ref': 'refs/heads/main', 'commit': self.base}})['error'], 'REPOSITORY_MISMATCH')

    def test_cancel_terminates_the_whole_process_group_and_still_cleans_up(self):
        job = self.job([{'id': 'long', 'role': 'test', 'argv': ['sh', '-c', 'sleep 3001 & sleep 3002; wait', 'm1-marker-cancel']},
                        {'id': 'later', 'role': 'test', 'argv': ['true']},
                        {'id': 'tidy', 'role': 'cleanup', 'argv': ['true']}])
        self.assertTrue(self.call('job_submit', job=job)['ok'])
        self.wait_state(job['jobId'], 'running')
        deadline = time.time() + 10
        while not any('3001' in Path(f'/proc/{p}/cmdline').read_bytes().decode(errors='replace') for p in marker_processes('sleep')) and time.time() < deadline:
            time.sleep(0.2)
        self.assertLess(time.time(), deadline, 'background child never started')
        requested = self.call('job_cancel', jobId=job['jobId'])['data']
        self.assertEqual((requested['state'], requested['cancelRequested']), ('cancel_requested', True))
        data = self.settle(job['jobId'])
        self.assertEqual((data['state'], data['errorCode']), ('cancelled', None))
        self.assertEqual([s['state'] for s in data['steps']], ['cancelled', 'not_run', 'passed'])
        self.assertEqual(data['summary']['verification'], 'NOT_RUN')
        survivors = [p for p in marker_processes('sleep') if any(m in Path(f'/proc/{p}/cmdline').read_bytes().decode(errors='replace') for m in ('3001', '3002'))]
        self.assertEqual(survivors, [])

    def test_job_timeout_and_project_run_slot_queue(self):
        slow = self.job([{'id': 'slow', 'role': 'build', 'argv': ['sleep', '30']}], timeout=3)
        quick = self.job([{'id': 'quick', 'role': 'build', 'argv': ['true']}])
        self.assertTrue(self.call('job_submit', job=slow)['ok'])
        self.wait_state(slow['jobId'], 'running')
        self.assertTrue(self.call('job_submit', job=quick)['ok'])
        self.wait_state(quick['jobId'], 'queued')
        timed_out = self.settle(slow['jobId'])
        self.assertEqual((timed_out['state'], timed_out['errorCode'], timed_out['steps'][0]['state']), ('timed_out', 'JOB_TIMED_OUT', 'timed_out'))
        self.assertEqual(timed_out['steps'][0]['signal'], 'SIGTERM')
        done = self.settle(quick['jobId'])
        self.assertEqual((done['state'], done['summary']), ('succeeded', {'execution': 'PASS', 'verification': 'NOT_CONFIGURED', 'cleanup': 'NOT_CONFIGURED'}))
        self.assertFalse(done['source']['sourceModified'])

    def test_lost_supervisor_is_interrupted_not_rerun(self):
        job = self.job([{'id': 'long', 'role': 'test', 'argv': ['sh', '-c', 'sleep 3003', 'm1-marker-lost']}])
        self.assertTrue(self.call('job_submit', job=job)['ok'])
        self.wait_state(job['jobId'], 'running')
        directory = Path(self.binding['remoteProjectRoot']) / '.codespace-mcp' / 'jobs' / job['jobId']
        supervisor = json.loads((directory / 'supervisor.json').read_text())
        os.kill(supervisor['pid'], 9)
        time.sleep(1)
        self.assertEqual(self.call('job_get', jobId=job['jobId'])['data']['state'], 'running')
        time.sleep(runner.STALE_SECONDS + 1)
        data = self.call('job_get', jobId=job['jobId'])['data']
        self.assertEqual((data['state'], data['errorCode'], data['settled']), ('interrupted', 'SUPERVISOR_LOST', True))
        self.assertEqual(self.call('job_submit', job=job)['data']['state'], 'interrupted')
        for pid in marker_processes('3003'):
            os.kill(pid, 9)


if __name__ == '__main__':
    unittest.main(verbosity=2)
