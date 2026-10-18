"""Persistent public software backlog. Never accepts operational events or conversation data."""
PROBE_FILES={
 'protocol_output':['src/tool-replies.ts'], 'email_outcome':['src/tool-replies.ts'],
 'offer_followup':['src/article-audio.ts'], 'date_zero':['src/dates.ts'],
 'date_invalid':['src/dates.ts'], 'date_empty_remove':['src/dates.ts'],
 'watch_completion':['src/watches.ts','src/schedule.ts','src/index.ts'],
 'link_delivery':['src/link-workflow.ts','src/index.ts'], 'reminder_evidence':['src/tool-replies.ts'],
 'email_conditional_approval':['src/drafts.ts'],'draft_expiry':['src/drafts.ts'],'draft_restart':['src/drafts.ts']}


def target_outcomes(targets,result,names):
    expected={t['id']:t for t in targets};rows=result.get('targetOutcomes')
    if type(rows) is not list or len(rows)!=len(expected): raise ValueError('Missing inspection target outcomes')
    seen=set()
    for row in rows:
        if type(row) is not dict or set(row)!={'id','state','note'} or type(row['id']) is not str or row['id'] not in expected or row['id'] in seen or row['state'] not in ('proposed','no_issue','deferred') or type(row['note']) is not str or not 3<=len(row['note'])<=500:
            raise ValueError('Invalid inspection outcome')
        if row['state']=='proposed' and not set(expected[row['id']]['files']).intersection(names): raise ValueError('Inspection fix has no related source change')
        seen.add(row['id'])
    return rows


def update(previous,baseline,after,targets,rows,reserved,day,revision,url):
    cases=previous.get('cases',{})
    base={r['probe']:r['result'] for r in baseline['results']}
    for result in after['results']:
        key='probe:'+result['probe'];old=cases.get(key,{})
        state='passing' if base.get(result['probe'])=='pass' else 'awaiting_review' if set(PROBE_FILES[result['probe']]).intersection(reserved) else 'proposed' if result['result']=='pass' and url else 'unsupported' if result['result']=='unsupported' else 'failing'
        event={'day':day,'revision':revision,'state':state,'pr':url if state=='proposed' else None}
        cases[key]={'kind':'synthetic','state':state,'history':[*old.get('history',[]),event][-5:]}
    for row in rows:
        key='inspection:'+row['id'];old=cases.get(key,{})
        event={'day':day,'revision':revision,'state':row['state'],'note':row['note'],'pr':url if row['state']=='proposed' else None}
        cases[key]={'kind':'inspection_lead','state':row['state'],'history':[*old.get('history',[]),event][-5:]}
    return {'schema':1,'cases':cases}


def public_context(previous,targets):
    # Do not resend historical reviewer prose: it could repeat subsequently withdrawn request wording.
    allowed={'probe:'+p for p in PROBE_FILES}|{'inspection:'+t['id'] for t in targets}
    states={'passing','failing','awaiting_review','proposed','unsupported','no_issue','deferred'}
    return [{'id':key,'state':row['state']} for key,row in sorted(previous.get('cases',{}).items()) if key in allowed and row.get('state') in states]
