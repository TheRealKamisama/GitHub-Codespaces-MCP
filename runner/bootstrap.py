"""Fixed SSH entry point. Dynamic values are read as JSON from stdin, never shell text."""
import base64
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


ACTIONS = ('handshake', 'diagnostic_start', 'diagnostic_get', 'job_submit', 'job_get', 'job_cancel', 'job_logs')
FORWARDED = ('probeId', 'job', 'jobId', 'cursor', 'maxBytes', 'waitSeconds')


PLATFORM_ENV = '/workspaces/.codespaces/shared/.env'


def platform_environment(environ, path=PLATFORM_ENV):
    """Non-login `gh codespace ssh` sessions lack the Codespaces platform variables (CODESPACE_NAME, git token).

    Login shells get them from profile scripts, but those may also run user dotfiles that write to stdout and
    corrupt the protocol. Read the platform file directly instead; existing variables are never overridden.
    """
    if environ.get('CODESPACE_NAME'):
        return dict(environ)
    merged = dict(environ)
    try:
        with open(path, encoding='utf-8') as stream:
            text = stream.read(65537)
    except OSError:
        return merged
    if len(text) > 65536:
        return merged
    for line in text.splitlines():
        key, separator, value = line.partition('=')
        if separator and re.fullmatch('[A-Z_][A-Z0-9_]{0,127}', key) and key not in environ:
            merged[key] = value
    return merged


def require(condition, code):
    if not condition:
        raise ValueError(code)


def safe_path(raw):
    path = Path(raw)
    require(path.is_absolute() and str(path).startswith('/workspaces/'), 'PATH_INVALID')
    require(all(p not in ('', '.', '..') for p in raw.split('/')[2:]), 'PATH_INVALID')
    require(not any(ord(c) < 32 for c in raw) and '\\' not in raw, 'PATH_INVALID')
    for part in [path, *path.parents]:
        require(not part.is_symlink(), 'PATH_INVALID')
    require(str(path.resolve()) == raw, 'PATH_INVALID')
    return path


def atomic(path, data):
    fd, name = tempfile.mkstemp(prefix='.write-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def main():
    require(sys.platform == 'linux', 'PLATFORM_UNSUPPORTED')
    os.environ.update(platform_environment(os.environ))
    import fcntl
    raw = sys.stdin.buffer.read(524289)
    require(len(raw) <= 524288, 'STATE_INVALID')
    request = json.loads(raw)
    require(request['protocolVersion'] == 1 and request['action'] in ACTIONS, 'RUNNER_INCOMPATIBLE')
    binding, build = request['binding'], request['build']
    require(os.environ.get('CODESPACE_NAME') == binding['codespaceName'], 'CODESPACE_IDENTITY_MISMATCH')
    require(shutil.which('git') is not None, 'CAPABILITY_MISSING')
    source = base64.b64decode(request['source'], validate=True)
    sha = hashlib.sha256(source).hexdigest()
    require(sha == build['runnerSha256'], 'HASH_MISMATCH')
    root = safe_path(binding['remoteProjectRoot'])
    # A nonempty existing project cannot be silently adopted. A marker is installed only in an empty directory.
    root.mkdir(parents=True, exist_ok=True)
    if not (root / '.codespace-mcp').exists():
        require(not any(p.name != '.m0-install.lock' for p in root.iterdir()), 'WORKSPACE_CONFLICT')
    lock_path = root / '.m0-install.lock'
    require(not lock_path.is_symlink(), 'PATH_INVALID')
    with open(lock_path, 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        managed = root / '.codespace-mcp'
        owner = {'schemaVersion': 1, 'projectId': binding['projectId'], 'account': binding['expectedAccount'].lower(), 'repository': binding['repository'].lower(), 'codespaceName': binding['codespaceName'], 'remoteProjectRoot': str(root)}
        if not managed.exists():
            require(set(p.name for p in root.iterdir()) == {'.m0-install.lock'}, 'WORKSPACE_CONFLICT')
            managed.mkdir(mode=0o700)
            atomic(managed / 'owner.json', json.dumps(owner).encode())
        safe_path(str(managed))
        owner_path = managed / 'owner.json'
        require(not owner_path.is_symlink() and owner_path.is_file(), 'WORKSPACE_CONFLICT')
        require(json.loads(owner_path.read_text()) == owner, 'WORKSPACE_CONFLICT')
        runners = safe_path(str(managed / 'runner'))
        runners.mkdir(exist_ok=True)
        # Include build identity: equal runner content can accompany different local builds.
        build_key = hashlib.sha256(json.dumps(build, sort_keys=True).encode()).hexdigest()
        destination = safe_path(str(runners / build_key))
        destination.mkdir(exist_ok=True)
        executable = destination / 'main.py'
        metadata = destination / 'build.json'
        for file in (executable, metadata):
            require(not file.is_symlink(), 'PATH_INVALID')
        if executable.exists():
            require(hashlib.sha256(executable.read_bytes()).hexdigest() == sha, 'HASH_MISMATCH')
        else:
            atomic(executable, source)
        if metadata.exists():
            require(json.loads(metadata.read_text()) == build, 'RUNNER_INCOMPATIBLE')
        else:
            atomic(metadata, json.dumps(build).encode())
    forwarded = {key: request[key] for key in FORWARDED if key in request}
    payload = {**forwarded, 'protocolVersion': 1, 'action': request['action'], 'root': str(managed),
               'binding': {'projectId': binding['projectId'], 'repository': binding['repository']}}
    wait = request.get('waitSeconds', 0)
    require(isinstance(wait, int) and 0 <= wait <= 20, 'STATE_INVALID')
    result = subprocess.run([sys.executable, str(executable)], input=json.dumps(payload), text=True, capture_output=True, timeout=10 + wait)
    require(result.returncode == 0, 'RUNNER_FAILED')
    print(result.stdout.strip())


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        known = {'PLATFORM_UNSUPPORTED', 'PATH_INVALID', 'WORKSPACE_CONFLICT', 'CODESPACE_IDENTITY_MISMATCH', 'CAPABILITY_MISSING', 'HASH_MISMATCH', 'RUNNER_INCOMPATIBLE', 'STATE_INVALID', 'RUNNER_FAILED'}
        code = str(error) if str(error) in known else 'RUNNER_FAILED'
        print(json.dumps({'ok': False, 'data': None, 'error': code}))
