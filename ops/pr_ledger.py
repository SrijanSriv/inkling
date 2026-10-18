"""Host-built evidence ledger: validated public code references, test outcomes and consented request IDs."""
from pathlib import Path, PurePosixPath
from urllib.parse import quote
from common import run


def checked_ref(work,ref,before):
    if type(ref) is not dict or set(ref)!={'path','line'} or type(ref['path']) is not str or type(ref['line']) is not int or ref['line']<1:
        raise ValueError('Invalid ledger code reference')
    path=PurePosixPath(ref['path'])
    if path.is_absolute() or '..' in path.parts or not path.parts or any(ord(c)<32 for c in str(path)) or path.parts[0] in {'.git','data','node_modules','.tmp'} or path.name.startswith('.env'):
        raise ValueError('Unsafe ledger code reference')
    if before:
        text=run(['git','show','HEAD:'+str(path)],cwd=work).stdout
    else:
        file=Path(work)/str(path)
        if any((Path(work)/Path(*path.parts[:i])).is_symlink() for i in range(1,len(path.parts)+1)): raise ValueError('Symlink in code reference')
        if file.is_symlink() or not file.is_file() or file.stat().st_size>200000: raise ValueError('Invalid changed source reference')
        text=file.read_text()
    if ref['line']>len(text.splitlines()): raise ValueError('Ledger line does not exist')
    return ref


def validate(context,result,names,work,check_public):
    rows=result.get('issueLedger')
    if type(rows) is not list or len(rows)>12 or bool(rows)!=bool(names): raise ValueError('Changed source needs an evidence ledger')
    valid={ 'probe:'+r['probe'] for r in result['softwareChecks']['results'] }
    valid.update('inspection:'+t['id'] for t in context['publicReviewTargets'])
    valid.update('feedback:'+r['id'] for r in context['approvedFeedback'])
    sources=set();covered=set()
    for row in rows:
        fields={'sources','problem','before','change','verification','limitations','beforeRefs','afterRefs'}
        if type(row) is not dict or set(row)!=fields: raise ValueError('Invalid ledger fields')
        if type(row['sources']) is not list or not 1<=len(row['sources'])<=6 or any(type(s) is not str or s not in valid for s in row['sources']) or len(set(row['sources']))!=len(row['sources']): raise ValueError('Unsupported evidence source')
        for name,limit in [('problem',600),('before',1200),('change',1000),('verification',1000),('limitations',600)]:
            if type(row[name]) is not str or not 3<=len(row[name])<=limit: raise ValueError('Invalid ledger description')
            check_public(row[name])
        for key in ['beforeRefs','afterRefs']:
            if type(row[key]) is not list or len(row[key])>8: raise ValueError('Invalid reference list')
            for ref in row[key]:
                if key=='afterRefs' and (type(ref) is not dict or ref.get('path') not in names): raise ValueError('After reference is not changed source')
                checked_ref(work,ref,key=='beforeRefs')
        if not row['beforeRefs'] and any(not s.startswith('feedback:') for s in row['sources']): raise ValueError('Software bug needs public before evidence')
        for ref in row['afterRefs']:
            if ref['path'] not in names: raise ValueError('After reference is not changed source')
            covered.add(ref['path'])
        for ref in row['beforeRefs']:
            if ref['path'] in names and not (Path(work)/ref['path']).exists(): covered.add(ref['path'])
        sources.update(row['sources'])
    if set(names)!=covered: raise ValueError('Some changed files have no ledger entry')
    for row in result['requestOutcomes']:
        if row['state']=='proposed' and 'feedback:'+row['id'] not in sources: raise ValueError('Approved request missing from ledger')
    for row in result['targetOutcomes']:
        if row['state']=='proposed' and 'inspection:'+row['id'] not in sources: raise ValueError('Inspection fix missing from ledger')
    return rows


def render(context,result,base_sha,after_sha,repository,baseline,pi_report):
    root='https://github.com/'+repository
    def refs(items,sha):
        return ', '.join('['+x['path']+':'+str(x['line'])+']('+root+'/blob/'+sha+'/'+quote(x['path'],safe='/')+'#L'+str(x['line'])+')' for x in items) or 'No existing code citation; see the approved requirement.'
    base={r['probe']:r['result'] for r in baseline['results']};after={r['probe']:r['result'] for r in result['softwareChecks']['results']}
    requests={r['id']:r for r in context['approvedFeedback']}
    lines=['## Review and privacy ledger','',result['summary'],'',
      '**Inputs:** public source at `'+base_sha+'`; the complete Pi '+pi_report['suite']+' report; a fresh '+baseline['suite']+' baseline; fixed public inspection targets; public backlog/PR metadata; and the approved descriptions disclosed below.',
      '**Not provided:** conversations, quotes, original WhatsApp message IDs, author identities, private local case counts, memories, recordings, mailbox data, credentials or recovery backups.',
      '**Sharing:** Codex/OpenAI received the listed approved wording. This PR is public. Approved prose is consented content, not guaranteed anonymous; original chat evidence and consent receipts remain private. A claimed private-chat observation would not be supported by this run.','',
      '## Changes, evidence and validation','']
    for i,row in enumerate(result['issueLedger'],1):
        lines += ['### '+str(i)+'. '+row['problem'],'','**Where this came from:**']
        for source in row['sources']:
            kind,key=source.split(':',1)
            if kind=='probe':
                lines.append('- Always-run synthetic test `'+key+'`: fresh baseline **'+base.get(key,'unsupported')+'**, after patch **'+after.get(key,'unsupported')+'**. [Public test fixture]('+root+'/blob/'+base_sha+'/ops/probes/software-probes.mjs). This is not a real-user incident trace.')
            elif kind=='inspection': lines.append('- Public source-inspection lead `'+key+'`, assessed by the reviewer; not private runtime evidence.')
            else: lines.append('- Author-approved request `'+key+'`: '+requests[key]['description']+'. No identity or original-message link is published.')
        lines += ['','**Before:** '+row['before'],'','**Public before evidence:** '+refs(row['beforeRefs'],base_sha),'',
          '**Fix / addition:** '+row['change'],'','**Changed code:** '+refs(row['afterRefs'],after_sha),'',
          '**Reviewer checks and reasoning:** '+row['verification'],'','**Limitations / unanswered questions:** '+row['limitations'],'']
    lines += ['## Independently checked by the host','',
      '- `npm run typecheck`: passed in the offline command sandbox.',
      '- Browser/coding JavaScript syntax checks: passed in the sandbox.',
      '- Trusted synthetic suite rerun; no previously passing probe regressed. These are software checks, not live messaging, real audio, purchase or email tests.','',
      '| Probe | Fresh default branch | After patch |','| --- | --- | --- |']
    for key,value in after.items(): lines.append('| `'+key+'` | '+base.get(key,'unsupported')+' | '+value+' |')
    lines += ['','## Approved requests supplied to this review','']
    if not requests: lines.append('None. No private feature-request description was provided.')
    for outcome in result['requestOutcomes']:
        req=requests[outcome['id']]
        lines.append('- `'+req['id']+'` ('+req['kind']+'): '+req['description']+' · **'+outcome['state']+'**. '+outcome['note'])
    lines += ['','## Inspection decisions and remaining work','']
    for outcome in result['targetOutcomes']: lines.append('- `'+outcome['id']+'`: **'+outcome['state']+'**. '+outcome['note'])
    for text in result['deferred']: lines.append('- Deferred: '+text)
    lines += ['','**Access and deployment:** privacy/consent/operations controls and files reserved by open PRs were protected. The model had no publishing token or deploy permission. A trusted wrapper opened this PR; human review and merge are required. Proposed changes are not deployed.']
    body='\n'.join(lines)+'\n'
    if len(body)>30000: raise ValueError('Evidence ledger is too large')
    return body


def notice_rows(result):
    return '\n'.join(str(i)+'. '+row['problem'][:80]+' → '+row['change'][:100]+' [sources: '+', '.join(row['sources'][:2])+']' for i,row in enumerate(result['issueLedger'],1))[:3500]
