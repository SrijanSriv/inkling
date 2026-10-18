"""Separate consented lane: exact author-approved descriptions, never chat excerpts or runtime cases."""
import json
import re
from pathlib import Path
from common import run
from software_report import unique
ID = re.compile(r'[BF][A-F0-9]{12}')
EMPTY = {'schema': 1, 'suite': 'approved-feedback-v1', 'requests': [], 'withdrawn': []}


def validate(value):
    if type(value) is not dict or set(value) != {'schema','suite','requests','withdrawn'} or type(value['schema']) is not int or value['schema'] != 1 or value['suite'] != EMPTY['suite']:
        raise ValueError('Invalid feedback snapshot')
    requests, withdrawn = value['requests'], value['withdrawn']
    if type(requests) is not list or len(requests)>100 or type(withdrawn) is not list or len(withdrawn)>500:
        raise ValueError('Invalid feedback bounds')
    seen = set()
    for row in requests:
        if type(row) is not dict or set(row) != {'id','kind','description'} or type(row['id']) is not str or not ID.fullmatch(row['id']) or row['id'] in seen or row['kind'] not in ('bug','feature') or row['id'][0] != ('B' if row['kind']=='bug' else 'F'):
            raise ValueError('Invalid feedback request')
        text = row['description']
        if type(text) is not str or not 10<=len(text)<=600 or re.search(r'@|https?:|www\.|\b(?:\d{1,3}\.){3}\d{1,3}\b|(?:[A-Fa-f0-9]{1,4}:){2,}|\S+@\S+|(?:\+?\d[\s()-]*){7,}|[A-Za-z0-9_-]{28,}|api.?key|password|bearer|-----BEGIN|ignore (?:previous|all)|system prompt|exfiltrat|/home/|/Users/|\.local\b|[{}<>`]',text,re.I):
            raise ValueError('Unsafe feedback description')
        seen.add(row['id'])
    for item in withdrawn:
        if type(item) is not str or not ID.fullmatch(item) or item in seen:
            raise ValueError('Invalid withdrawal')
        seen.add(item)
    return value


def load(path):
    p=Path(path)
    if not p.exists(): return dict(EMPTY)
    if p.is_symlink() or p.stat().st_size>100000: raise ValueError('Invalid feedback file')
    return validate(json.loads(p.read_text(),object_pairs_hook=unique))


def collect(c):
    result=run([c['node'],'--env-file=.env','--import','tsx','src/feedback-export.ts'],cwd=c['checkout'],timeout=30)
    if len(result.stdout)>100000: raise ValueError('Oversized feedback export')
    return validate(json.loads(result.stdout,object_pairs_hook=unique))


def select(snapshot, backlog, day):
    # This backlog contains only already-approved/public material, with no author linkage.
    current={r['id']:r for r in snapshot['requests']}
    for key in list(backlog):
        if key not in current: del backlog[key]
    for row in snapshot['requests']:
        old=backlog.setdefault(row['id'],{'request':row,'state':'pending','attempts':0})
        if old['request']!=row: raise ValueError('Approved request changed under the same ID')
    eligible=[x for x in backlog.values() if x['state'] in ('pending','deferred') and x.get('lastDay')!=day and x['attempts']<5]
    eligible.sort(key=lambda x:(x['attempts'],x['request']['id']))
    return [x['request'] for x in eligible[:12]]


def dispositions(selected, result):
    expected={r['id'] for r in selected};rows=result.get('requestOutcomes')
    if type(rows) is not list or len(rows)!=len(expected): raise ValueError('Missing request outcomes')
    seen=set()
    for row in rows:
        if type(row) is not dict or set(row)!={'id','state','note'} or row['id'] not in expected or row['id'] in seen or row['state'] not in ('proposed','needs_info','deferred') or type(row['note']) is not str or len(row['note'])>500:
            raise ValueError('Invalid request outcome')
        seen.add(row['id'])
    return rows


def finish(backlog, rows, day, url):
    for row in rows:
        if row['state']=='proposed' and not url: raise ValueError('Request cannot be proposed without a PR')
        old=backlog.get(row['id'])
        if not old: continue
        if old.get('lastDay')==day and old.get('state')==row['state']: continue
        next_state='needs_info' if row['state']=='deferred' and old['attempts']>=4 else row['state']
        old.update(state=next_state,note=row['note'],pr=url if next_state=='proposed' else None,lastDay=day,attempts=old['attempts']+1)
    return [{'id':key,'state':x['state'] if x['state'] in ('proposed','needs_info','deferred') else 'sent','pr':x.get('pr')} for key,x in backlog.items()]
