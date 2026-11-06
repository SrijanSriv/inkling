"""Closed, content-free review health. Never persist subprocess output or exception messages."""
import contextlib
import datetime as dt
from pathlib import Path
from common import atomic, read

STAGES = {'queue', 'credentials', 'github', 'feedback', 'source', 'dependencies', 'worker',
          'validation', 'publication', 'receipts', 'complete'}
CATEGORIES = {'authentication', 'quota', 'model', 'request_schema', 'transport', 'timeout',
              'sandbox', 'validation', 'disconnected', 'other'}

class ReviewBlocked(RuntimeError):
    pass


def progress(state, stage, **fields):
    if stage not in STAGES or set(fields)-{'day','status'}:
        raise ValueError('Invalid health fields')
    if 'day' in fields: dt.date.fromisoformat(fields['day'])
    if fields.get('status','running') not in {'running','idle','completed','blocked'}:
        raise ValueError('Invalid health status')
    previous = read(Path(state)/'review-health.json', {})
    value = {'schema':1, 'status':fields.get('status','running'), 'stage':stage,
             'at':dt.datetime.now(dt.timezone.utc).isoformat()}
    if 'day' in fields: value['day']=fields['day']
    elif previous.get('status')=='running' and previous.get('day'): value['day']=previous['day']
    atomic(Path(state)/'review-health.json',value)


@contextlib.contextmanager
def tracking(state):
    progress(state,'queue')
    try:
        yield
    except Exception as error:
        value=read(Path(state)/'review-health.json',{})
        value.update(status='blocked' if isinstance(error,ReviewBlocked) else 'failed',
                     category='validation' if value.get('stage')=='validation' else 'other',at=dt.datetime.now(dt.timezone.utc).isoformat())
        worker=read(Path(state)/'review-worker-health.json',{})
        if value.get('stage')=='worker' and worker.get('status')=='failed':
            category=worker.get('category')
            if category in CATEGORIES: value['category']=category
        atomic(Path(state)/'review-health.json',value)
        # Only trusted enums, no error text, paths, request descriptions or model output.
        print('Review stage failed: '+value['stage']+' / '+value['category'],flush=True)
        raise
    else:
        value=read(Path(state)/'review-health.json',{})
        if value.get('status')=='running': progress(state,'complete',status='completed')


def newest_pending(paths, receipts):
    """One fresh source review subsumes old fixed suites, never old approved wording."""
    pending=sorted((p for p in paths if p.stem not in receipts),key=lambda p:p.stem)
    for p in pending: dt.date.fromisoformat(p.stem)
    return (pending[-1],pending[:-1]) if pending else (None,[])
