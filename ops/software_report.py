"""Trusted strict export boundary. No journals, private state, or free text accepted."""
import base64
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
from common import run

PROBES = ('protocol_output', 'email_outcome', 'offer_followup', 'date_zero',
          'date_invalid', 'date_empty_remove', 'watch_completion', 'link_delivery', 'reminder_evidence')
SUITE = 'software-probes-v1'


def unique(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError('Duplicate report field')
        value[key] = item
    return value


def validate(value):
    if type(value) is not dict or set(value) != {'schema', 'suite', 'results'}:
        raise ValueError('Unexpected software report fields')
    if type(value['schema']) is not int or value['schema'] != 1 or value['suite'] != SUITE:
        raise ValueError('Unsupported software report')
    rows = value['results']
    if type(rows) is not list or len(rows) != len(PROBES):
        raise ValueError('Incomplete software suite')
    found = {}
    for row in rows:
        if type(row) is not dict or set(row) != {'probe', 'result'}:
            raise ValueError('Unexpected probe fields')
        probe, result = row['probe'], row['result']
        if type(probe) is not str or probe not in PROBES or probe in found:
            raise ValueError('Unexpected or duplicate probe')
        if type(result) is not str or result not in ('pass', 'fail', 'unsupported'):
            raise ValueError('Unexpected probe result')
        found[probe] = result
    return {'schema': 1, 'suite': SUITE, 'results': [{'probe': p, 'result': found[p]} for p in PROBES]}


def loads(text):
    if len(text) > 4096:
        raise ValueError('Oversized software report')
    return validate(json.loads(text, object_pairs_hook=unique))


def load(path):
    p = Path(path)
    if p.is_symlink() or p.stat().st_size > 4096:
        raise ValueError('Invalid software report file')
    return loads(p.read_text())


def from_stdout(text):
    rows = [line.removeprefix('AUDIT_PROBES=') for line in text.splitlines() if line.startswith('AUDIT_PROBES=')]
    if len(rows) != 1:
        raise ValueError('Missing software suite result')
    return loads(json.dumps({'schema': 1, 'suite': SUITE, 'results': json.loads(rows[0], object_pairs_hook=unique)}))


def fixture(scratch):
    Path(scratch, 'users.json').write_text(json.dumps({'users': [{
        'id': 'audit', 'name': 'Example', 'phone': '447700900001', 'timezone': 'UTC',
        'admin': True, 'owner': True}]}))


def collect(c):
    """Linux only: OS filesystem/network namespaces, committed source, synthetic state."""
    root = Path(c['checkout']).resolve()
    node = Path(c['node']).resolve()
    suite = Path(__file__).with_name('probes').resolve()
    with tempfile.TemporaryDirectory(prefix='inkling-software-') as temporary:
        stage = Path(temporary)
        archive = stage/'source.tar'
        run(['git', 'archive', '--format=tar', '-o', archive, 'HEAD'], cwd=root)
        public = stage/'source'
        public.mkdir()
        with tarfile.open(archive) as tar:
            tar.extractall(public, filter='data')
        dependency_source = Path(c['releases'])/'current' if c.get('releases') else root
        if (dependency_source/'package-lock.json').read_bytes() != (public/'package-lock.json').read_bytes():
            raise RuntimeError('Source and installed dependency lock differ')
        dependencies = (dependency_source/'node_modules').resolve()
        (public/'node_modules').mkdir(exist_ok=True)
        scratch = stage/'audit-probe-data'
        scratch.mkdir()
        fixture(scratch)
        # No home directory, host /tmp, config, journal, .env, data or credentials are mounted.
        command = ['bwrap', '--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
                   '--ro-bind', '/usr', '/usr', '--symlink', 'usr/lib', '/lib',
                   '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
                   '--ro-bind', public, '/workspace', '--ro-bind', dependencies, '/workspace/node_modules',
                   '--ro-bind', node.parent, '/runtime', '--ro-bind', suite, '/probes',
                   '--bind', scratch, '/tmp/audit-probe-data', '--chdir', '/tmp/audit-probe-data',
                   '--clearenv', '--setenv', 'PATH', '/runtime:/usr/bin', '--setenv', 'HOME', '/tmp',
                   '--setenv', 'INKLING_DATA_DIR', '/tmp/audit-probe-data',
                   '--setenv', 'AUDIT_SCRATCH', '/tmp/audit-probe-data', '--setenv', 'AUDIT_SOURCE_ROOT', '/workspace',
                   '--setenv', 'INKLING_SECRET_KEY', base64.b64encode(os.urandom(32)).decode(),
                   '/runtime/'+node.name, '--import', '/probes/pi-isolation.mjs', '--import', '/workspace/node_modules/tsx/dist/loader.mjs',
                   '/probes/software-probes.mjs']
        if Path('/lib64').exists():
            command[command.index('--proc'):command.index('--proc')] = ['--ro-bind', '/lib64', '/lib64']
        result = run(command, timeout=90)
        return from_stdout(result.stdout)


if __name__ == '__main__':
    from common import config
    # Deliberately withhold raw errors/output, including during a manual run.
    try:
        print(json.dumps(collect(config()), indent=2))
    except Exception:
        raise SystemExit('Isolated software checks failed; no report released')
