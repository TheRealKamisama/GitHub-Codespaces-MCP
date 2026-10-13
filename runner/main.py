"""M0 handshake and fixed ten-second survival diagnostic, not a general job runner."""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import tempfile
import time


def generation():
    # A host boot alone does not identify a container lifetime.
    boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    init = Path('/proc/1/stat').read_text().rsplit(')', 1)[1].split()[19]
    return hashlib.sha256(f'{boot}:{os.stat("/proc/1/ns/pid").st_ino}:{init}'.encode()).hexdigest()


def atomic(path, value):
    fd, temporary = tempfile.mkstemp(prefix='.status-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(value, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def reconcile(status, current_generation, now):
    if status['state'] in ('accepted', 'running'):
        if status['generation'] != current_generation:
            return {**status, 'state': 'interrupted'}
        if now - status['updatedAt'] > 4:
            return {**status, 'state': 'unknown'}
    return status


def worker(path):
    status = json.loads(path.read_text())
    status['state'] = 'running'
    for _ in range(10):
        status['updatedAt'] = time.time()
        atomic(path, status)
        time.sleep(1)
    status.update(state='completed', updatedAt=time.time())
    atomic(path, status)


def main(request):
    if sys.platform != 'linux':
        raise ValueError('PLATFORM_UNSUPPORTED')
    if request.get('protocolVersion') != 1:
        raise ValueError('RUNNER_INCOMPATIBLE')
    action = request.get('action')
    if action == 'handshake':
        build = json.loads(Path(__file__).with_name('build.json').read_text())
        return {'protocolVersion': 1, 'runnerSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                'version': build['version'], 'gitSha': build['gitSha'], 'dirty': build['dirty'],
                'codespaceName': os.environ.get('CODESPACE_NAME', ''), 'generation': generation(),
                'pythonVersion': platform.python_version(), 'platform': sys.platform,
                'capabilities': ['handshake', 'bounded_diagnostic']}
    if action not in ('diagnostic_start', 'diagnostic_get'):
        raise ValueError('RUNNER_INCOMPATIBLE')
    probe_id = request.get('probeId', '')
    if not re.fullmatch('[a-f0-9]{64}', probe_id):
        raise ValueError('STATE_INVALID')
    root = Path(request['root'])
    probes = root / 'diagnostics'
    if probes.is_symlink():
        raise ValueError('PATH_INVALID')
    probes.mkdir(exist_ok=True)
    path = probes / (probe_id + '.json')
    lock_path = probes / '.lock'
    if path.is_symlink() or lock_path.is_symlink():
        raise ValueError('PATH_INVALID')
    import fcntl
    with open(lock_path, 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if path.exists():
            return reconcile(json.loads(path.read_text()), generation(), time.time())
        if action == 'diagnostic_get':
            raise ValueError('PROBE_NOT_FOUND')
        # Persist before spawning: an ambiguous crash is never resolved by starting a duplicate.
        now = time.time()
        status = {'probeId': probe_id, 'state': 'accepted', 'generation': generation(), 'startedAt': now, 'updatedAt': now}
        atomic(path, status)
        subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--worker', str(path)],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True, close_fds=True,
                         env={k: v for k, v in os.environ.items() if k not in ('GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN')})
        return status


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--worker':
        worker(Path(sys.argv[2]))
    else:
        try:
            raw = sys.stdin.buffer.read(16385)
            if len(raw) > 16384:
                raise ValueError('STATE_INVALID')
            result = main(json.loads(raw))
            print(json.dumps({'ok': True, 'data': result, 'error': None}))
        except Exception as error:
            known = {'PLATFORM_UNSUPPORTED', 'RUNNER_INCOMPATIBLE', 'STATE_INVALID', 'PATH_INVALID', 'PROBE_NOT_FOUND'}
            print(json.dumps({'ok': False, 'data': None, 'error': str(error) if str(error) in known else 'RUNNER_FAILED'}))
