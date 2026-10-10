"""Trusted host helpers. Configuration and credentials never enter review workspaces."""
import contextlib
import fcntl
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

os.umask(0o077)
CONFIG = Path(os.environ.get('INKLING_OPS_CONFIG', Path.home() / '.config/inkling-ops/config.json'))


class MaintenanceBusy(Exception):
    pass


def config():
    return json.loads(CONFIG.read_text())


def run(args, *, cwd=None, env=None, timeout=120, data=None, check=True):
    p = subprocess.run([str(a) for a in args], cwd=cwd, env=env, input=data,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=timeout)
    if check and p.returncode:
        # Commands can mention credentials, paths or mail. Never relay their output to journald.
        raise RuntimeError(f'{Path(args[0]).name} failed (exit {p.returncode})')
    return p


def atomic(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temp = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(value, f, indent=2)
            f.write('\n')
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, path)
    finally:
        Path(temp).unlink(missing_ok=True)


def read(path, fallback=None):
    try:
        return json.loads(Path(path).read_text())
    except FileNotFoundError:
        return fallback


@contextlib.contextmanager
def lock(path, blocking=False):
    Path(path).parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(path, 'a') as f:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        except BlockingIOError:
            raise MaintenanceBusy()
        yield


def notify(c, key, message):
    run([c['node'], '--env-file=.env', '--import', 'tsx', 'src/operations-notify.ts'],
        cwd=c['checkout'], data=json.dumps({'key': key, 'message': message}))


def laptop_notice(c, key, message):
    import hashlib
    atomic(Path(c['state']) / 'notices' / (hashlib.sha256(key.encode()).hexdigest() + '.json'),
           {'key': key, 'message': message})


def restic(c, *args, cwd=None):
    env = dict(os.environ, RESTIC_REPOSITORY=c['backup_repository'],
               RESTIC_PASSWORD_FILE=c['backup_password'], RESTIC_CACHE_DIR=str(Path(c['state'])/'restic-cache'))
    return run([c['restic'], *args], env=env, cwd=cwd, timeout=1800)


def entrypoint(fn):
    try:
        fn(config())
    except MaintenanceBusy:
        print('Another maintenance run is active; deferred to the next timer tick.', flush=True)
    except Exception as e:
        # Type only, not arbitrary exception strings which may include server responses.
        print(f'Maintenance failed: {type(e).__name__}', flush=True)
        try:
            c = config()
            if c.get('role') == 'pi':
                notify(c, 'ops-failure-' + time.strftime('%Y-%m-%d-%H'),
                       'Maintenance needs attention: a backup, transfer or update check failed. The service will retry; check its private maintenance status on the Pi.')
            elif c.get('role') == 'laptop':
                laptop_notice(c, 'review-failure-' + time.strftime('%Y-%m-%d'),
                              'Nightly Codex review needs attention. No unchecked changes were deployed. It will retry up to three times for this report; inspect the laptop maintenance status if it remains blocked.')
        except Exception:
            pass
        raise SystemExit(1)
