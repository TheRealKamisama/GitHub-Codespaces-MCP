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


if __name__ == '__main__':
    unittest.main(verbosity=2)
