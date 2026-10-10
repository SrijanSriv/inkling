"""Fail-closed log projection: public source literals and aggregate counts only."""
from collections import Counter
import datetime as dt
import json
from pathlib import Path
import re
from common import run


def source_labels(root):
    # Only final, static logger messages from public code are eligible for export.
    labels = set()
    for p in (Path(root)/'src').glob('*.ts'):
        s = p.read_text()
        for match in re.finditer(r'''\blog\.(?:info|warn|error|debug)\([^;\n]*?(?:"([^"\\\n]{1,180})"|'([^'\\\n]{1,180})')\s*\)''', s):
            value = match.group(1) or match.group(2)
            if not any(x in value for x in ['@', 'http', '${', '\\']):
                labels.add(value)
    return labels


def collect(c, since, until):
    labels = source_labels(c['checkout'])
    source = '\n'.join(p.read_text() for p in (Path(c['checkout'])/'src').glob('*.ts'))
    known_tools = set(re.findall(r'''["']([a-z][a-z_]{1,60})["']''', source))
    counts, tools, errors, locations = Counter(), Counter(), Counter(), Counter()
    raw = run(['journalctl', '_SYSTEMD_USER_UNIT='+c['service'], '--since', since, '--until', until,
               '-o', 'cat', '--no-pager'], timeout=60).stdout
    parsed = ignored = 0
    for line in raw.splitlines():
        try:
            x = json.loads(line)
            if not isinstance(x, dict):
                raise ValueError()
        except (ValueError, TypeError):
            ignored += 1
            continue
        parsed += 1
        label = x.get('msg')
        counts[label if isinstance(label, str) and label in labels else 'unclassified event'] += 1
        tool = x.get('tool')
        # Names are structural identifiers; tool arguments and all contact fields are discarded.
        if label == 'tool' and isinstance(tool, str):
            tools[tool if tool in known_tools else 'unrecognized_tool'] += 1
        if isinstance(x.get('level'), int) and x['level'] >= 40:
            err = x.get('err') if isinstance(x.get('err'), dict) else {}
            code = err.get('code', err.get('status', x.get('code')))
            code = str(code) if isinstance(code, (str, int)) else ''
            if not re.fullmatch(r'(?:[A-Z][A-Z_]{1,35}|[1-5][0-9]{2})', code):
                code = 'unspecified'
            errors[(label if isinstance(label, str) and label in labels else 'unclassified warning/error')+' / '+code] += 1
            detail = str(err.get('message', '')).lower()
            for category in ['timeout', 'rate limit', 'schema', 'connection', 'authentication', 'permission', 'not found', 'quota', 'expired', 'disconnected', 'network']:
                if category in detail:
                    errors['error text category: '+category] += 1
            for loc in re.findall(r'/src/([a-zA-Z0-9_-]+\.ts:\d+:\d+)', str(err.get('stack', ''))):
                locations[loc] += 1
    health = run(['curl', '-fsS', '--max-time', '10', c['health_url']], check=False)
    healthy = False
    if health.returncode == 0:
        try:
            healthy = json.loads(health.stdout).get('whatsapp') is True
        except ValueError:
            pass
    return {'schema': 1, 'from': since, 'until': until,
            'revision': run(['git', 'rev-parse', 'HEAD'], cwd=c['checkout']).stdout.strip(),
            'whatsappConnected': healthy, 'records': parsed, 'ignoredNonJsonLines': ignored,
            'events': dict(counts.most_common(80)), 'tools': dict(tools.most_common(80)),
            'warningAndErrorCategories': dict(errors.most_common(50)), 'sourceLocations': dict(locations.most_common(30)),
            'limitations': 'No conversations, prompts, replies, arguments, names, IDs, emails, URLs, raw errors or stack contents are exported. Counts are evidence of operations, not proof of reply quality or audible playback.'}
