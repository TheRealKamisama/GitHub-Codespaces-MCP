"""Handshake, fixed ten-second survival diagnostic and M1 exact-revision jobs."""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time

TOKEN_VARIABLES = ('GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GITHUB_CODESPACE_TOKEN')
TERMINAL = ('succeeded', 'failed', 'timed_out', 'cancelled', 'interrupted')
HEARTBEAT_SECONDS = 2
STALE_SECONDS = 10
LOG_LIMIT = 64 * 1024 * 1024
TERM_GRACE_SECONDS = 5
CLEANUP_DEFAULT_SECONDS = 300
GIT_TIMEOUT_SECONDS = 600
HEX64 = re.compile('[a-f0-9]{64}')
HEX32 = re.compile('[a-f0-9]{32}')
NAME = re.compile('[A-Za-z0-9][A-Za-z0-9_.-]{0,63}')
ARTIFACT_LIMIT = 256 * 1024 * 1024
ARTIFACT_FILE_LIMIT = 1000
CLOSE_TTL_SECONDS = 600
MAX_HOLD_SECONDS = 14400
LOG_PAGE_LIMIT = 1048576


def generation():
    # A host boot alone does not identify a container lifetime.
    boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    init = Path('/proc/1/stat').read_text().rsplit(')', 1)[1].split()[19]
    return hashlib.sha256(f'{boot}:{os.stat("/proc/1/ns/pid").st_ino}:{init}'.encode()).hexdigest()


def atomic(path, value):
    fd, temporary = tempfile.mkstemp(prefix='.status-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            stream.write(value) if isinstance(value, str) else json.dump(value, stream)
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


def without_tokens(environment):
    return {k: v for k, v in environment.items() if k not in TOKEN_VARIABLES}


def read_json(path):
    if path.is_symlink():
        raise ValueError('PATH_INVALID')
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        raise ValueError('STATE_INVALID')


def process_start_time(pid):
    try:
        return Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19]
    except (OSError, IndexError):
        return None


def group_alive(pgid):
    # Zombies keep their group until an init that may never reap them; they cannot run, so ignore them.
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            fields = (entry / 'stat').read_text().rsplit(')', 1)[1].split()
        except (OSError, IndexError):
            continue
        if int(fields[2]) == pgid and fields[0] != 'Z':
            return True
    return False


def summarize(steps, phase_error=None):
    """Aggregate per-step outcomes; never turns missing evidence into PASS."""
    main_steps = [s for s in steps if s['role'] != 'cleanup' and not s['optional']]
    tests = [s for s in main_steps if s['role'] == 'test']
    cleanups = [s for s in steps if s['role'] == 'cleanup']
    if phase_error is not None or not main_steps or all(s['state'] in ('pending', 'not_run') for s in main_steps):
        execution = 'NOT_RUN'
    elif any(s['state'] in ('failed', 'timed_out') for s in main_steps):
        execution = 'FAIL'
    elif all(s['state'] == 'passed' for s in main_steps):
        execution = 'PASS'
    else:
        execution = 'INCOMPLETE'
    if not tests:
        verification = 'NOT_CONFIGURED'
    elif any(s['state'] in ('failed', 'timed_out') for s in tests):
        verification = 'FAIL'
    elif all(s['state'] == 'passed' for s in tests):
        verification = 'PASS'
    else:
        verification = 'NOT_RUN'
    if not cleanups:
        cleanup = 'NOT_CONFIGURED'
    elif any(s['state'] in ('failed', 'timed_out') for s in cleanups):
        cleanup = 'FAIL'
    elif all(s['state'] == 'passed' for s in cleanups):
        cleanup = 'PASS'
    else:
        cleanup = 'NOT_RUN'
    return {'execution': execution, 'verification': verification, 'cleanup': cleanup}


def safe_relative(raw):
    if not isinstance(raw, str) or len(raw) > 240 or raw.startswith('/') or '\\' in raw or any(ord(c) < 32 for c in raw):
        return None
    parts = [p for p in raw.split('/') if p not in ('', '.')]
    if any(p == '..' for p in parts):
        return None
    return parts


def copy_frozen(source, destination):
    """Copy one regular file without following a final symlink; returns the SHA-256 of the bytes written."""
    digest = hashlib.sha256()
    descriptor = os.open(source, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    try:
        with os.fdopen(descriptor, 'rb') as reader, open(destination, 'xb') as writer:
            descriptor = None
            for chunk in iter(lambda: reader.read(1024 * 1024), b''):
                digest.update(chunk)
                writer.write(chunk)
    finally:
        if descriptor is not None:
            os.close(descriptor)
    os.chmod(destination, 0o444)
    return digest.hexdigest()


def collect_artifacts(workdir, specs, store, limit=ARTIFACT_LIMIT, file_limit=ARTIFACT_FILE_LIMIT):
    """Freeze declared outputs into the job's store, so later steps or jobs cannot change what is downloaded.

    A link anywhere on an artifact's path, or inside a directory artifact, is rejected and never followed: it could
    point outside the checked-out source. Quotas reject an artifact rather than truncate it.
    """
    workdir, store = Path(workdir), Path(store)
    store.mkdir(exist_ok=True)
    entries, used, files_used = [], 0, 0
    for spec in specs:
        entry = {'name': spec['name'], 'path': spec['path'], 'required': spec.get('required', True), 'kind': None,
                 'state': 'missing', 'size': None, 'sha256': None, 'files': [], 'errorCode': 'ARTIFACT_MISSING'}
        entries.append(entry)
        parts = safe_relative(spec['path'])
        source, linked = workdir, False
        for part in parts:
            source = source / part
            linked = linked or source.is_symlink()
        if linked:
            entry.update(state='rejected', errorCode='ARTIFACT_PATH_INVALID')
            continue
        if not source.exists():
            continue
        destination = store / spec['name']
        try:
            if source.is_file():
                size = source.stat().st_size
                if used + size > limit:
                    entry.update(state='too_large', errorCode='ARTIFACT_TOO_LARGE', size=size)
                    continue
                entry.update(kind='file', state='collected', size=size, sha256=copy_frozen(source, destination), errorCode=None)
                used += size
            elif source.is_dir():
                members, invalid = [], False
                for root, directories, files in os.walk(source, followlinks=False):
                    for name in directories + files:
                        member = Path(root) / name
                        if member.is_symlink() or (name in files and not member.is_file()):
                            invalid = True
                    members.extend(Path(root) / name for name in files)
                if invalid:
                    entry.update(state='rejected', errorCode='ARTIFACT_PATH_INVALID')
                    continue
                total = sum(m.stat().st_size for m in members)
                if used + total > limit or files_used + len(members) > file_limit:
                    entry.update(state='too_large', errorCode='ARTIFACT_TOO_LARGE', size=total)
                    continue
                listed = []
                for member in sorted(members):
                    relative = member.relative_to(source)
                    target = destination.joinpath(*relative.parts)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    listed.append({'path': relative.as_posix(), 'size': member.stat().st_size, 'sha256': copy_frozen(member, target)})
                destination.mkdir(exist_ok=True)
                entry.update(kind='directory', state='collected', size=total, files=listed, errorCode=None)
                used += total
                files_used += len(members)
            else:
                entry.update(state='rejected', errorCode='ARTIFACT_PATH_INVALID')
        except OSError:
            # A partial copy is never presented as collected.
            shutil.rmtree(destination, ignore_errors=True) if destination.is_dir() else destination.unlink(missing_ok=True)
            entry.update(kind=None, state='rejected', size=None, sha256=None, files=[], errorCode='ARTIFACT_COPY_FAILED')
    return entries


def require_value(condition):
    if not condition:
        raise ValueError('CONFIG_INVALID')


def open_lock(path):
    if path.is_symlink():
        raise ValueError('PATH_INVALID')
    return open(path, 'a')


def validate_job(job, binding):
    """Defence in depth: the local schema is authoritative, but the runner never trusts the transport blindly."""
    require_value(isinstance(job, dict) and job.get('schemaVersion') == 1)
    if job.get('projectId') != binding.get('projectId'):
        raise ValueError('CONFIG_INVALID')
    require_value(HEX64.fullmatch(str(job.get('jobId', ''))) and HEX64.fullmatch(str(job.get('digest', ''))))
    source = job.get('source') or {}
    require_value(source.get('mode') == 'revision')
    if str(source.get('repository', '')).lower() != str(binding.get('repository', '')).lower():
        raise ValueError('REPOSITORY_MISMATCH')
    require_value(re.fullmatch('[a-f0-9]{40}', str(source.get('commit', ''))))
    ref = str(source.get('ref', ''))
    require_value(re.fullmatch(r'refs/(heads|tags)/[A-Za-z0-9._/-]{1,200}', ref) and '..' not in ref and not ref.endswith(('/', '.lock')))
    require_value(isinstance(job.get('timeoutSeconds'), int) and 1 <= job['timeoutSeconds'] <= 21600)
    steps = job.get('steps')
    require_value(isinstance(steps, list) and 1 <= len(steps) <= 32)
    seen = set()
    for step in steps:
        require_value(re.fullmatch('[A-Za-z0-9][A-Za-z0-9_.-]{0,63}', str(step.get('id', ''))) and step['id'] not in seen)
        seen.add(step['id'])
        require_value(step.get('role') in ('setup', 'build', 'test', 'analysis', 'cleanup'))
        require_value(safe_relative(step.get('cwd', '.')) is not None)
        if step.get('kind') == 'command':
            require_value(isinstance(step.get('argv'), list) and 1 <= len(step['argv']) <= 256 and all(isinstance(a, str) and '\x00' not in a for a in step['argv']))
        else:
            require_value(step.get('kind') == 'shell' and step.get('shell') in ('bash', 'sh') and isinstance(step.get('script'), str) and '\x00' not in step['script'])
        env = step.get('env', {})
        require_value(isinstance(env, dict) and all(re.fullmatch('[A-Za-z_][A-Za-z0-9_]{0,127}', k) and isinstance(v, str) and '\x00' not in v for k, v in env.items()))
        timeout = step.get('timeoutSeconds')
        require_value(timeout is None or (isinstance(timeout, int) and 1 <= timeout <= 21600))
        require_value(isinstance(step.get('optional', False), bool))
    artifacts = job.get('artifacts', [])
    require_value(isinstance(artifacts, list) and len(artifacts) <= 32)
    names = set()
    for artifact in artifacts:
        require_value(isinstance(artifact, dict) and set(artifact) <= {'name', 'path', 'required'})
        require_value(NAME.fullmatch(str(artifact.get('name', ''))) and artifact['name'] not in names)
        names.add(artifact['name'])
        require_value(safe_relative(artifact.get('path')))
        require_value(isinstance(artifact.get('required', True), bool))


class Instance:
    """Instance-wide usage registry shared by every project and client on this Codespace.

    Submitting a new job and closing the instance for release both run under one instance lock, so an idle check
    can never be followed by a newly accepted job. A closing marker is void after a restart (new generation) or
    after CLOSE_TTL_SECONDS, which lets work resume if the stop request never takes effect.
    """

    def __init__(self, root):
        self.root = Path(root)
        for path in (self.root, self.root / 'projects', self.root / 'holds'):
            if path.is_symlink():
                raise ValueError('PATH_INVALID')
            path.mkdir(exist_ok=True)

    def locked(self):
        import fcntl
        lock = open_lock(self.root / '.lock')
        fcntl.flock(lock, fcntl.LOCK_EX)
        return lock

    def closing(self):
        path = self.root / 'closing.json'
        if not path.exists():
            return None
        marker = read_json(path)
        if marker.get('generation') != generation() or marker.get('expiresAt', 0) <= time.time():
            return None
        return marker

    def require_open(self):
        if self.closing() is not None:
            raise ValueError('CODESPACE_RELEASING')

    def holds(self):
        current, now, result = generation(), time.time(), []
        for path in sorted((self.root / 'holds').glob('*.json')):
            hold = read_json(path)
            if hold.get('generation') == current and hold.get('expiresAt', 0) > now:
                result.append({'holdId': hold['holdId'], 'expiresAt': hold['expiresAt']})
        return result

    def active_jobs(self):
        active = []
        for entry in sorted((self.root / 'projects').glob('*.json')):
            project = Path(read_json(entry)['projectRoot'])
            jobs_dir = project / '.codespace-mcp' / 'jobs'
            if not jobs_dir.is_dir() or jobs_dir.is_symlink():
                continue
            store = Jobs(project / '.codespace-mcp')
            for directory in sorted(p for p in jobs_dir.iterdir() if p.is_dir() and HEX64.fullmatch(p.name)):
                if (directory / 'status.json').exists():
                    status = store.present(directory)
                    if not status['settled']:
                        active.append({'projectRoot': str(project), 'jobId': status['jobId'], 'state': status['state']})
        return active

    def status(self):
        return {'generation': generation(), 'activeJobs': self.active_jobs(), 'holds': self.holds(), 'closing': self.closing()}

    def close(self, close_id):
        if not HEX32.fullmatch(str(close_id)):
            raise ValueError('STATE_INVALID')
        with self.locked():
            status = self.status()
            if status['activeJobs'] or status['holds']:
                return {**status, 'closed': False}
            now = time.time()
            atomic(self.root / 'closing.json', {'closeId': close_id, 'generation': status['generation'], 'createdAt': now, 'expiresAt': now + CLOSE_TTL_SECONDS})
            return {**self.status(), 'closed': True}

    def reopen(self, close_id):
        with self.locked():
            marker = self.closing()
            if marker is not None and marker['closeId'] == close_id:
                (self.root / 'closing.json').unlink()
            return {**self.status(), 'closed': False}

    def hold(self, hold_id, seconds):
        if not HEX32.fullmatch(str(hold_id)) or not isinstance(seconds, int) or not 60 <= seconds <= MAX_HOLD_SECONDS:
            raise ValueError('STATE_INVALID')
        with self.locked():
            self.require_open()
            atomic(self.root / 'holds' / f'{hold_id}.json', {'holdId': hold_id, 'generation': generation(), 'expiresAt': time.time() + seconds})
            return {**self.status(), 'closed': False}

    def unhold(self, hold_id):
        if not HEX32.fullmatch(str(hold_id)):
            raise ValueError('STATE_INVALID')
        with self.locked():
            path = self.root / 'holds' / f'{hold_id}.json'
            if path.exists():
                path.unlink()
            return {**self.status(), 'closed': False}


class Jobs:
    """Remote job store. status.json has a single writer: the job's supervisor (after the accepted record)."""

    def __init__(self, managed):
        self.managed = Path(managed)
        self.project = self.managed.parent
        self.jobs = self.managed / 'jobs'
        for path in (self.jobs, self.project / 'runs'):
            if path.is_symlink():
                raise ValueError('PATH_INVALID')
            path.mkdir(exist_ok=True)

    def directory(self, job_id):
        if not HEX64.fullmatch(str(job_id)):
            raise ValueError('STATE_INVALID')
        path = self.jobs / job_id
        if path.is_symlink():
            raise ValueError('PATH_INVALID')
        return path

    def present(self, directory):
        status = read_json(directory / 'status.json')
        cancel_requested = (directory / 'cancel.json').exists()
        observation = 'reachable'
        settled = bool(status.get('settled'))
        if not settled and status['state'] not in TERMINAL:
            supervisor = read_json(directory / 'supervisor.json') if (directory / 'supervisor.json').exists() else None
            alive = supervisor is not None and process_start_time(supervisor['pid']) == supervisor['startTime']
            stale = time.time() - status['updatedAt'] > STALE_SECONDS
            if status['generation'] != generation():
                status.update(state='interrupted', errorCode='JOB_INTERRUPTED')
                settled = True
            elif not alive and stale:
                # The accepted record precedes spawn; a lost supervisor is never silently re-run.
                status.update(state='interrupted', errorCode='SUPERVISOR_LOST')
                settled = True
            else:
                observation = 'stale' if stale else 'reachable'
                if cancel_requested:
                    status['state'] = 'cancel_requested'
        steps = [{k: s[k] for k in ('id', 'role', 'optional', 'state', 'exitCode', 'signal', 'errorCode', 'startedAt', 'endedAt')} for s in status['steps']]
        if status['state'] == 'interrupted' and not status.get('settled'):
            # The supervisor never finished: a running step was cut short, pending steps never started.
            for step in steps:
                step['state'] = {'running': 'interrupted', 'pending': 'not_run'}.get(step['state'], step['state'])
        # The stored summary is final only once the supervisor settled the job; otherwise derive it from the steps.
        summary = status['summary'] if status.get('settled') else summarize(steps, 'source' if status['state'] in ('accepted', 'preparing') else None)
        return {'jobId': status['jobId'], 'projectId': status['projectId'], 'digest': status['digest'], 'state': status['state'],
                'settled': settled, 'observation': observation, 'errorCode': status['errorCode'], 'cancelRequested': cancel_requested,
                'generation': status['generation'], 'acceptedAt': status['acceptedAt'], 'startedAt': status['startedAt'],
                'endedAt': status['endedAt'], 'updatedAt': status['updatedAt'], 'source': status['source'], 'steps': steps,
                'summary': summary, 'artifacts': status.get('artifacts', [])}

    def submit(self, job, binding, instance):
        validate_job(job, binding)
        import fcntl
        # Lock order: instance, then project jobs. The instance lock makes "not closing" and "job accepted" atomic.
        with instance.locked(), open_lock(self.jobs / '.lock') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            directory = self.directory(job['jobId'])
            if directory.exists():
                if read_json(directory / 'request.json')['digest'] != job['digest']:
                    raise ValueError('IDEMPOTENCY_CONFLICT')
                return self.present(directory)
            instance.require_open()
            directory.mkdir(mode=0o700)
            atomic(directory / 'request.json', job)
            now = time.time()
            steps = [{'id': s['id'], 'role': s['role'], 'optional': s.get('optional', False), 'state': 'pending', 'exitCode': None,
                      'signal': None, 'errorCode': None, 'startedAt': None, 'endedAt': None} for s in job['steps']]
            source = job['source']
            status = {'schemaVersion': 1, 'jobId': job['jobId'], 'projectId': job['projectId'], 'digest': job['digest'],
                      'state': 'accepted', 'errorCode': None, 'generation': generation(), 'settled': False,
                      'acceptedAt': now, 'startedAt': None, 'endedAt': None, 'updatedAt': now,
                      'source': {'mode': 'revision', 'repository': source['repository'], 'ref': source['ref'],
                                 'requestedCommit': source['commit'], 'resolvedCommit': None, 'sourceModified': None, 'workdir': None},
                      'steps': steps, 'summary': summarize(steps, 'pending'),
                      'artifacts': [{'name': a['name'], 'path': a['path'], 'required': a.get('required', True), 'kind': None, 'state': 'pending',
                                     'size': None, 'sha256': None, 'files': [], 'errorCode': None} for a in job.get('artifacts', [])]}
            # Persist before spawning: an ambiguous crash is reported, never resolved by starting a duplicate.
            atomic(directory / 'status.json', status)
            # The supervisor keeps git credentials for fetch; step processes receive a token-free environment.
            subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--supervise', str(directory)],
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             start_new_session=True, close_fds=True)
            return self.present(directory)

    def get(self, job_id, wait_seconds=0):
        directory = self.directory(job_id)
        if not (directory / 'status.json').exists():
            raise ValueError('JOB_NOT_FOUND')
        deadline = time.time() + max(0, min(int(wait_seconds or 0), 20))
        while True:
            result = self.present(directory)
            if result['settled'] or time.time() >= deadline:
                return result
            time.sleep(0.5)

    def cancel(self, job_id):
        directory = self.directory(job_id)
        if not (directory / 'status.json').exists():
            raise ValueError('JOB_NOT_FOUND')
        if not self.present(directory)['settled'] and not (directory / 'cancel.json').exists():
            atomic(directory / 'cancel.json', {'requestedAt': time.time()})
        return self.present(directory)

    def logs(self, job_id, cursor, max_bytes):
        directory = self.directory(job_id)
        if not (directory / 'status.json').exists():
            raise ValueError('JOB_NOT_FOUND')
        match = re.fullmatch('v1:([0-9]{1,15})', cursor or 'v1:0')
        if not match or not isinstance(max_bytes, int) or not 1 <= max_bytes <= LOG_PAGE_LIMIT:
            raise ValueError('CURSOR_INVALID')
        offset = int(match.group(1))
        path = directory / 'job.log'
        if path.is_symlink():
            raise ValueError('PATH_INVALID')
        size = path.stat().st_size if path.exists() else 0
        if offset > size:
            raise ValueError('CURSOR_INVALID')
        data = b''
        if size:
            with open(path, 'rb') as stream:
                stream.seek(offset)
                data = stream.read(max_bytes)
        # Never split a UTF-8 sequence across pages; the remainder starts the next page.
        text = None
        for cut in range(0, min(4, len(data)) + 1):
            try:
                text = data[:len(data) - cut].decode('utf-8')
                data = data[:len(data) - cut]
                break
            except UnicodeDecodeError:
                continue
        if text is None:
            text = data.decode('utf-8', errors='replace')
        next_offset = offset + len(data)
        settled = self.present(directory)['settled']
        return {'jobId': job_id, 'cursor': f'v1:{offset}', 'nextCursor': f'v1:{next_offset}', 'text': text,
                'size': size, 'complete': settled and next_offset >= size}


class Supervisor:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.request = read_json(self.directory / 'request.json')
        self.status = read_json(self.directory / 'status.json')
        self.managed = self.directory.parent.parent
        self.project = self.managed.parent
        self.lock = threading.Lock()
        self.log_path = self.directory / 'job.log'
        # None, 'confirmed' (every step process group verified gone) or 'unconfirmed'.
        self.cancel_outcome = None
        self.base_env = without_tokens(os.environ)

    def write(self, **changes):
        with self.lock:
            self.status.update(changes)
            self.status['updatedAt'] = time.time()
            atomic(self.directory / 'status.json', self.status)

    def write_step(self, entry, **changes):
        with self.lock:
            entry.update(changes)
        self.write()

    def heartbeat(self):
        while True:
            time.sleep(HEARTBEAT_SECONDS)
            self.write()

    def note(self, line):
        with open(self.log_path, 'ab') as stream:
            stream.write((line + '\n').encode('utf-8'))

    def cancel_requested(self):
        return (self.directory / 'cancel.json').exists()

    def git(self, *args):
        env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0', 'GCM_INTERACTIVE': 'never'}
        with open(self.log_path, 'ab') as log:
            return subprocess.run(['git', *args], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                  stderr=log, timeout=GIT_TIMEOUT_SECONDS)

    def prepare_source(self):
        import fcntl
        source = self.request['source']
        commit, ref = source['commit'], source['ref']
        cache = self.managed / 'cache.git'
        workdir = self.project / 'runs' / self.request['jobId'] / 'src'
        for path in (cache, workdir.parent, workdir):
            if path.is_symlink():
                raise ValueError('PATH_INVALID')
        self.note(f'==> source: fetch {ref} from {source["repository"]} and check out {commit}')
        with open_lock(self.managed / 'cache.lock') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            git = lambda *args: self.git('-C', str(cache), *args)
            if not cache.exists() and self.git('init', '--bare', '--quiet', str(cache)).returncode != 0:
                raise ValueError('SOURCE_FETCH_FAILED')
            if git('fetch', '--no-tags', '--quiet', f'https://github.com/{source["repository"]}.git', ref).returncode != 0:
                raise ValueError('SOURCE_FETCH_FAILED')
            fetched = git('rev-parse', '--verify', 'FETCH_HEAD^{commit}').stdout.decode().strip()
            # The requested commit must be reachable from the named ref; a moved branch never redirects to its new tip.
            if not fetched or git('cat-file', '-e', f'{commit}^{{commit}}').returncode != 0 or \
                    git('merge-base', '--is-ancestor', commit, fetched).returncode != 0:
                raise ValueError('REVISION_UNREACHABLE')
            # Pin the commit so cache maintenance cannot collect a job's source.
            if git('update-ref', f'refs/codespace-mcp/jobs/{self.request["jobId"]}', commit).returncode != 0:
                raise ValueError('SOURCE_FETCH_FAILED')
            tree = git('ls-tree', '-r', '--full-tree', commit)
            if tree.returncode != 0:
                raise ValueError('SOURCE_FETCH_FAILED')
            if any(line.startswith(b'160000 ') for line in tree.stdout.splitlines()):
                raise ValueError('SUBMODULES_UNSUPPORTED')
            lfs = git('grep', '--quiet', '-e', 'filter=lfs', commit, '--', ':(glob)**/.gitattributes').returncode
            if lfs == 0:
                raise ValueError('LFS_UNSUPPORTED')
            if lfs != 1:
                raise ValueError('SOURCE_FETCH_FAILED')
            workdir.parent.mkdir(exist_ok=True)
            if workdir.exists():
                raise ValueError('WORKSPACE_CONFLICT')
            if git('worktree', 'add', '--quiet', '--detach', str(workdir), commit).returncode != 0:
                raise ValueError('SOURCE_FETCH_FAILED')
        resolved = self.git('-C', str(workdir), 'rev-parse', 'HEAD').stdout.decode().strip()
        if resolved != commit:
            raise ValueError('SOURCE_MISMATCH')
        with self.lock:
            self.status['source'].update(resolvedCommit=resolved, workdir=str(workdir))
        return workdir

    def wait_for_slot(self):
        """One running job per project; queued time does not consume the job deadline."""
        import fcntl
        slot = open_lock(self.managed / 'run.lock')
        while True:
            try:
                fcntl.flock(slot, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return slot
            except BlockingIOError:
                if self.cancel_requested():
                    slot.close()
                    return None
                time.sleep(1)

    def terminate(self, process):
        """TERM, bounded grace, KILL; True only when the whole group is verified gone."""
        pgid = process.pid
        for sig, grace in ((signal.SIGTERM, TERM_GRACE_SECONDS), (signal.SIGKILL, 2)):
            try:
                os.killpg(pgid, sig)
            except ProcessLookupError:
                pass
            deadline = time.time() + grace
            while time.time() < deadline:
                if process.poll() is not None and not group_alive(pgid):
                    return True
                time.sleep(0.1)
        return process.poll() is not None and not group_alive(pgid)

    def run_step(self, index, step, workdir, deadline, honour_cancel):
        """Returns (step state, stop reason or None)."""
        entry = self.status['steps'][index]
        now = time.time()
        cwd = workdir.joinpath(*safe_relative(step.get('cwd', '.')))
        if not cwd.is_dir() or not (cwd.resolve() == workdir.resolve() or workdir.resolve() in cwd.resolve().parents):
            self.write_step(entry, state='failed', errorCode='CWD_INVALID', startedAt=now, endedAt=now)
            return 'failed', None
        if step['kind'] == 'shell':
            if shutil.which(step['shell']) is None:
                self.write_step(entry, state='failed', errorCode='CAPABILITY_MISSING', startedAt=now, endedAt=now)
                return 'failed', None
            # Scripts run from a file; they never become part of an SSH or shell command line.
            scripts = self.directory / 'steps'
            scripts.mkdir(exist_ok=True)
            script = scripts / f'{index}.sh'
            atomic(script, step['script'])
            argv = [step['shell'], str(script)]
        else:
            argv = step['argv']
        env = {**self.base_env, **step.get('env', {}), 'CODESPACE_MCP_JOB_ID': self.request['jobId'],
               'CODESPACE_MCP_SOURCE_DIR': str(workdir), 'CODESPACE_MCP_STEP_ID': step['id']}
        self.note(f'==> step {step["id"]} ({step["role"]})')
        try:
            with open(self.log_path, 'ab') as log:
                process = subprocess.Popen(argv, cwd=str(cwd), env=env, stdin=subprocess.DEVNULL, stdout=log,
                                           stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
        except OSError:
            self.write_step(entry, state='failed', errorCode='EXECUTABLE_UNAVAILABLE', startedAt=now, endedAt=time.time())
            self.note(f'==> step {step["id"]} failed EXECUTABLE_UNAVAILABLE')
            return 'failed', None
        self.write_step(entry, state='running', startedAt=now)
        step_deadline = now + step['timeoutSeconds'] if step.get('timeoutSeconds') else None
        reason = None
        while reason is None and process.poll() is None:
            now = time.time()
            if honour_cancel and self.cancel_requested():
                reason = 'cancelled'
            elif now >= deadline:
                reason = 'job_timeout'
            elif step_deadline is not None and now >= step_deadline:
                reason = 'step_timeout'
            elif self.log_path.stat().st_size > LOG_LIMIT:
                reason = 'output_limit'
            else:
                time.sleep(0.2)
        if reason:
            confirmed = self.terminate(process)
            state = {'cancelled': 'cancelled', 'job_timeout': 'timed_out', 'step_timeout': 'timed_out', 'output_limit': 'failed'}[reason]
            code = {'cancelled': None, 'job_timeout': 'JOB_TIMED_OUT', 'step_timeout': 'STEP_TIMED_OUT', 'output_limit': 'OUTPUT_LIMIT'}[reason]
        else:
            # Ordinary steps may not leave background descendants running into the next step.
            confirmed = not group_alive(process.pid) or self.terminate(process)
            state, code = ('passed' if process.returncode == 0 else 'failed'), None
        if not confirmed:
            code = 'PROCESS_CLEANUP_UNCONFIRMED'
        if reason == 'cancelled':
            self.cancel_outcome = 'confirmed' if confirmed else 'unconfirmed'
        returncode = process.returncode
        self.write_step(entry, state=state, errorCode=code, endedAt=time.time(),
                        exitCode=returncode if returncode is not None and returncode >= 0 else None,
                        signal=signal.Signals(-returncode).name if returncode is not None and returncode < 0 else None)
        outcome = '' if returncode is None else f' signal={signal.Signals(-returncode).name}' if returncode < 0 else f' exit={returncode}'
        self.note(f'==> step {step["id"]} {state}{outcome}')
        return state, reason

    def run(self):
        atomic(self.directory / 'supervisor.json', {'pid': os.getpid(), 'startTime': process_start_time(os.getpid())})
        threading.Thread(target=self.heartbeat, daemon=True).start()
        try:
            if self.cancel_requested():
                return self.finish('cancelled', None, phase_error='cancelled')
            self.write(state='preparing')
            try:
                workdir = self.prepare_source()
            except subprocess.TimeoutExpired:
                return self.finish('failed', 'SOURCE_FETCH_FAILED', phase_error='source')
            except ValueError as error:
                return self.finish('failed', str(error), phase_error='source')
            self.write(state='queued')
            slot = self.wait_for_slot()
            if slot is None:
                return self.finish('cancelled', None, phase_error='cancelled')
            with slot:
                return self.execute(workdir)
        except Exception:
            return self.finish('failed', 'RUNNER_FAILED')

    def execute(self, workdir):
        self.write(state='running', startedAt=time.time())
        deadline = time.time() + self.request['timeoutSeconds']
        failure = None
        for index, step in enumerate(self.request['steps']):
            if step['role'] == 'cleanup':
                continue
            if failure is None and self.cancel_outcome is None and self.cancel_requested():
                self.cancel_outcome = 'confirmed'  # Nothing is running between steps.
            if failure is None and self.cancel_outcome is None and time.time() >= deadline:
                failure = 'timed_out'
            if failure is not None or self.cancel_outcome is not None:
                self.write_step(self.status['steps'][index], state='not_run')
                continue
            state, reason = self.run_step(index, step, workdir, deadline, honour_cancel=True)
            if reason == 'job_timeout':
                failure = 'timed_out'
            elif reason != 'cancelled' and state != 'passed' and not step.get('optional', False):
                failure = 'failed'
        # Outputs are frozen before cleanup steps, which commonly delete them; failing runs keep their reports.
        if self.request.get('artifacts'):
            entries = collect_artifacts(workdir, self.request['artifacts'], self.directory / 'artifacts')
            with self.lock:
                self.status['artifacts'] = entries
            self.note('==> artifacts: ' + ', '.join(f'{a["name"]} {a["state"]}' for a in entries))
        # Cleanup runs after success, failure, timeout and cancellation, with its own bounded deadline.
        for index, step in enumerate(self.request['steps']):
            if step['role'] == 'cleanup':
                limit = step.get('timeoutSeconds') or CLEANUP_DEFAULT_SECONDS
                self.run_step(index, step, workdir, time.time() + limit, honour_cancel=False)
        modified = self.git('-C', str(workdir), 'status', '--porcelain', '--untracked-files=no')
        with self.lock:
            self.status['source']['sourceModified'] = None if modified.returncode != 0 else bool(modified.stdout.strip())
        if self.cancel_outcome == 'unconfirmed':
            return self.finish('cancel_requested', 'CANCEL_UNCONFIRMED')
        if self.cancel_outcome == 'confirmed':
            return self.finish('cancelled', None)
        if failure == 'timed_out':
            return self.finish('timed_out', 'JOB_TIMED_OUT')
        if failure == 'failed':
            return self.finish('failed', 'STEP_FAILED')
        problem = next((a for a in self.status['artifacts'] if a['required'] and a['state'] != 'collected'), None)
        if problem is not None:
            return self.finish('failed', problem['errorCode'] or 'ARTIFACT_MISSING')
        if any(s['state'] != 'passed' for s in self.status['steps'] if s['role'] == 'cleanup'):
            return self.finish('failed', 'CLEANUP_FAILED')
        return self.finish('succeeded', None)

    def finish(self, state, error, phase_error=None):
        with self.lock:
            for entry in self.status['steps']:
                if entry['state'] in ('pending', 'running'):
                    entry['state'] = 'not_run'
            for artifact in self.status.setdefault('artifacts', []):
                if artifact['state'] == 'pending':
                    artifact.update(state='not_collected', errorCode=None)
            summary = summarize(self.status['steps'], phase_error)
        self.note(f'==> job {state}' + (f' {error}' if error else ''))
        self.write(state=state, errorCode=error, endedAt=time.time(), settled=True, summary=summary)


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
                'capabilities': ['handshake', 'bounded_diagnostic', 'revision_jobs', 'instance_lifecycle']}
    if action in ('instance_status', 'instance_close', 'instance_reopen', 'hold_set', 'hold_clear'):
        instance = Instance(request['instanceRoot'])
        if action == 'instance_status':
            return {**instance.status(), 'closed': False}
        if action == 'instance_close':
            return instance.close(request.get('closeId'))
        if action == 'instance_reopen':
            return instance.reopen(request.get('closeId'))
        if action == 'hold_set':
            return instance.hold(request.get('holdId'), request.get('holdSeconds'))
        return instance.unhold(request.get('holdId'))
    if action in ('job_submit', 'job_get', 'job_cancel', 'job_logs'):
        if shutil.which('git') is None:
            raise ValueError('CAPABILITY_MISSING')
        jobs = Jobs(request['root'])
        if action == 'job_submit':
            return jobs.submit(request.get('job'), request.get('binding') or {}, Instance(request['instanceRoot']))
        if action == 'job_get':
            return jobs.get(request.get('jobId'), request.get('waitSeconds', 0))
        if action == 'job_cancel':
            return jobs.cancel(request.get('jobId'))
        return jobs.logs(request.get('jobId'), request.get('cursor'), request.get('maxBytes', 32768))
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
                         env=without_tokens(os.environ))
        return status


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--worker':
        worker(Path(sys.argv[2]))
    elif len(sys.argv) == 3 and sys.argv[1] == '--supervise':
        Supervisor(sys.argv[2]).run()
    else:
        try:
            raw = sys.stdin.buffer.read(262145)
            if len(raw) > 262144:
                raise ValueError('STATE_INVALID')
            result = main(json.loads(raw))
            print(json.dumps({'ok': True, 'data': result, 'error': None}))
        except Exception as error:
            known = {'PLATFORM_UNSUPPORTED', 'RUNNER_INCOMPATIBLE', 'STATE_INVALID', 'PATH_INVALID', 'PROBE_NOT_FOUND',
                     'CAPABILITY_MISSING', 'CONFIG_INVALID', 'REPOSITORY_MISMATCH', 'IDEMPOTENCY_CONFLICT', 'JOB_NOT_FOUND', 'CURSOR_INVALID',
                     'CODESPACE_RELEASING'}
            print(json.dumps({'ok': False, 'data': None, 'error': str(error) if str(error) in known else 'RUNNER_FAILED'}))
