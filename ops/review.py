"""Laptop: strict synthetic report -> isolated Codex -> checked, human-reviewed PR."""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
from common import atomic, entrypoint, laptop_notice, lock, read, run
from software_report import load as load_software_report
import feedback_report
import review_backlog
import pr_ledger


def github(c, args):
    token = Path(c['github_token']).read_text().strip()
    if not token:
        raise RuntimeError('GitHub publishing credential missing')
    env = dict(os.environ, GH_TOKEN=token, GH_HOST='github.com', GH_PROMPT_DISABLED='1')
    return run([c['gh'], *args], env=env, timeout=120)


def safe_public(text):
    # Reject obvious accidental identities, credentials and private deployment addresses before public upload.
    text = re.sub(r'[\w.+-]+@(?:example\.(?:com|org|net)|users\.noreply\.github\.com)\b', '[example address]', text)
    if len(text) > 200_000 or re.search(r'(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|GOCSPX-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|-----BEGIN .*PRIVATE KEY|Bearer\s+[A-Za-z0-9._-]{20,}|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b(?:10|192\.168|127)\.\d+\.\d+|\b[a-z0-9][a-z0-9-]*\.local\b|/home/[^/\s]+/|\+\d{10,15})', text):
        raise RuntimeError('Public output failed privacy check')


def changed_files(work):
    names = run(['git','diff','--name-only','-z','HEAD'],cwd=work).stdout.split('\0')
    names += run(['git','ls-files','--others','--exclude-standard','-z'],cwd=work).stdout.split('\0')
    names = sorted(set(n for n in names if n))
    if len(names) > 20:
        raise RuntimeError('Review change is too large')
    for name in names:
        p = Path(name)
        if p.is_absolute() or '..' in p.parts or any(ord(x)<32 for x in name):
            raise RuntimeError('Invalid review path')
        if p.parts[0] in {'.github','ops','.git','.codex','.agents','data','node_modules','.tmp','.inkling','experiments'} or p.name in {'AGENTS.md','CLAUDE.md'} or p.name.startswith('.env'):
            raise RuntimeError('Protected review path')
        if name in {'src/feedback.ts','src/feedback-export.ts','src/reliability-store.ts','src/command-announcements.ts'}:
            raise RuntimeError('Protected privacy or announcement control')
        if name.startswith(('scripts/inkling-nightly.', 'scripts/inkling-update.', 'scripts/inkling-review.', 'scripts/inkling-webhook.')):
            raise RuntimeError('Protected maintenance service')
        dest = work/p
        if dest.is_symlink() or any((work/Path(*p.parts[:i])).is_symlink() for i in range(1,len(p.parts))):
            raise RuntimeError('Review symlink rejected')
        if dest.exists():
            if not dest.is_file() or dest.stat().st_size > 200_000:
                raise RuntimeError('Review output is not bounded source text')
            dest.read_text()  # Require text, not binary artifacts.
    return names


def quarantine_legacy(state):
    # Old aggregate reports never reach a model, even when pending during migration.
    state = Path(state)
    for candidate in sorted((state/'inbox').glob('*.json')):
        try:
            load_software_report(candidate)
        except (ValueError, OSError):
            quarantine = state/'legacy-report-quarantine'
            quarantine.mkdir(mode=0o700, exist_ok=True)
            candidate.replace(quarantine/candidate.name)


def review_notice_key(day, url):
    # A later PR must not be deduplicated against an earlier advice-only result.
    return 'review-'+day+('-'+hashlib.sha256(url.encode()).hexdigest()[:12] if url else '')


def main(c):
    state = Path(c['state'])
    with lock(state/'review.lock'):
        quarantine_legacy(state)
        receipts = read(state/'review-state.json', {})
        pending = sorted(p for p in (state/'inbox').glob('*.json') if p.stem not in receipts)
        if not pending:
            return
        # Don't consume a night or start costly work while publishing credentials are absent.
        if not Path(c['github_token']).is_file():
            print('Review waiting for repository-scoped GitHub credential.', flush=True)
            return
        report = pending[0]
        day = report.stem
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', day):
            raise RuntimeError('Invalid report date')
        branch = 'codex/nightly-'+day
        # Crash recovery: a previously published PR is the receipt, never open a duplicate.
        existing = json.loads(github(c,['pr','list','--repo',c['repository'],'--head',branch,'--state','all','--json','url']).stdout)
        if existing:
            url = existing[0]['url']
            laptop_notice(c,review_notice_key(day,url),'Nightly review opened a PR for you: '+url+'\nReview and merge it when ready; it has not been deployed.')
            staged=read(state/('review-feedback-'+day+'.json'),None)
            if staged:
                backlog=read(state/'feedback-backlog.json',{})
                feedback_report.dispositions(staged['selected'],{'requestOutcomes':staged['outcomes']})
                atomic(state/'feedback-receipts.json',feedback_report.finish(backlog,staged['outcomes'],day,url))
                atomic(state/'feedback-backlog.json',backlog)
            receipts[day] = {'pr': url}
            atomic(state/'review-state.json',receipts)
            return
        attempts = read(state/'review-attempts.json', {})
        if attempts.get(day, 0) >= 3:
            laptop_notice(c, 'review-blocked-'+day, 'Nightly review for '+day+' stopped after three failed attempts. Your backups continue normally. Check the laptop review service before retrying.')
            return
        opens = json.loads(github(c,['pr','list','--repo',c['repository'],'--state','open','--json','headRefName,title,url']).stdout)
        maintenance = [p for p in opens if p['headRefName'].startswith('codex/nightly-')]
        if len(maintenance)>10: raise RuntimeError('Too many outstanding maintenance PRs')
        reserved = set()
        for pr in maintenance:
            details=json.loads(github(c,['pr','view',pr['url'],'--repo',c['repository'],'--json','files']).stdout)
            paths=[f['path'] for f in details['files']]
            if len(paths)>100: raise RuntimeError('Oversized maintenance PR')
            pr['files']=paths;reserved.update(paths)
        feedback_file=state/'feedback-inbox'/(day+'.json')
        feedback_backlog=read(state/'feedback-backlog.json',{})
        # No stale consented snapshot fallback across nights. Missing input leaves backlog intact.
        latest_feedback=max((p.name for p in (state/'feedback-inbox').glob('????-??-??.json')),default='')
        fresh=feedback_file.exists() and feedback_file.name==latest_feedback and time.time()-feedback_file.stat().st_mtime<3600
        selected=feedback_report.select(feedback_report.load(feedback_file),feedback_backlog,day) if fresh else []
        atomic(state/'feedback-backlog.json',feedback_backlog)
        root = Path(c['checkout'])
        if not (root/'.git').exists():
            run(['git','clone','--origin','origin','https://github.com/'+c['repository']+'.git',root],timeout=180)
        run(['git','fetch','--prune','origin'],cwd=root)
        base = 'origin/'+c['branch']
        work = state/'review-workspace'
        # Never edit a human checkout or an active worker's project.
        shutil.rmtree(work,ignore_errors=True)
        run(['git','clone','--no-hardlinks',root,work],timeout=180)
        run(['git','checkout','--detach',run(['git','rev-parse',base],cwd=root).stdout.strip()],cwd=work)
        run(['git','remote','remove','origin'],cwd=work)
        # Preparation is outside the model sandbox. No lifecycle scripts run on the host.
        env = dict(os.environ, PATH=c['tool_path'])
        run(['npm','ci','--ignore-scripts','--no-audit','--no-fund'],cwd=work,env=env,timeout=300)
        context = state/'review-context.json'
        targets=json.loads(Path(__file__).with_name('review-targets.json').read_text())
        atomic(context,{'openMaintenancePRs':maintenance,'reservedFiles':sorted(reserved),'approvedFeedback':selected,
            'publicReviewTargets':targets,'publicBacklog':review_backlog.public_context(read(state/'software-backlog.json',{}),targets),'instruction':'Review all failed probe families, public inspection targets and approved requests. Address several justified, non-overlapping issues where safe. Never edit reservedFiles or privacy controls; leave unrelated open PRs for human review.'})
        output = state/'review-result.json'
        output.unlink(missing_ok=True)
        attempts[day] = attempts.get(day, 0)+1
        atomic(state/'review-attempts.json', attempts)
        run([c['node'],Path(__file__).with_name('review.mjs'),os.environ.get('INKLING_OPS_CONFIG',Path.home()/'.config/inkling-ops/config.json'),work,report,output,context],env=env,timeout=1900)
        shutil.rmtree(work/'.tmp',ignore_errors=True)
        result = json.loads(output.read_text())
        for field in ['title','summary','body']:
            if not isinstance(result.get(field),str):
                raise RuntimeError('Invalid review result')
            safe_public(result[field])
        if len(result['title'])>100 or len(result['summary'])>1000 or len(result['body'])>6000: raise RuntimeError('Review prose is oversized')
        advice = result.get('advice',[])
        if not isinstance(advice,list) or len(advice)>3 or any(not isinstance(a,str) or len(a)>1000 for a in advice):
            raise RuntimeError('Invalid review advice')
        for a in advice:
            safe_public(a)
        review_context=read(context,{})
        baseline=read(state/'last-software-review-input.json',{})['current']
        pi_report=load_software_report(report)
        outcomes=feedback_report.dispositions(selected,result)
        for row in outcomes: safe_public(row['note'])
        deferred=result.get('deferred',[])
        if not isinstance(deferred,list) or len(deferred)>12 or any(not isinstance(x,str) or len(x)>500 for x in deferred):
            raise RuntimeError('Invalid deferred findings')
        for text in deferred: safe_public(text)
        names = changed_files(work)
        inspection_rows=review_backlog.target_outcomes(targets,result,names)
        for row in inspection_rows: safe_public(row['note'])
        pr_ledger.validate(review_context,result,names,work,safe_public)
        if reserved.intersection(names): raise RuntimeError('Review overlaps an open maintenance PR')
        if not names and any(r['state']=='proposed' for r in outcomes): raise RuntimeError('No implementation for proposed feedback')
        atomic(state/('review-feedback-'+day+'.json'),{'selected':selected,'outcomes':outcomes})
        url = None
        if names:
            base_sha=run(['git','rev-parse','HEAD'],cwd=work).stdout.strip()
            if not result.get('typecheckPassed') or len(result['title'])>100 or len(result['body'])>6000:
                raise RuntimeError('Review validation failed')
            run(['git','checkout','-b',branch],cwd=work)
            run(['git','add','--',*names],cwd=work)
            run(['git','diff','--cached','--check'],cwd=work)
            patch = run(['git','diff','--cached','--binary'],cwd=work).stdout
            if len(patch) > 200_000:
                raise RuntimeError('Review patch is too large')
            safe_public('\n'.join(line[1:] for line in patch.splitlines() if line.startswith('+') and not line.startswith('+++')))
            atomic(state/'last-review-validation.json',{'day':day,'files':names,'typecheck':True,'patchSha256':hashlib.sha256(patch.encode()).hexdigest()})
            run(['git','-c','user.name=Inkling maintenance','-c','user.email=maintenance@users.noreply.github.com','commit','-m',result['title']],cwd=work)
            # Only this host wrapper has GitHub access. The model cannot push, merge or read this token.
            helper = state/'askpass'
            helper.write_text('#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" x-access-token;; *) cat "$INKLING_TOKEN_FILE";; esac\n')
            helper.chmod(0o700)
            publish_env = dict(env,GIT_ASKPASS=str(helper),GIT_TERMINAL_PROMPT='0',INKLING_TOKEN_FILE=c['github_token'])
            # A GitHub token is sent only to this configured repository on github.com.
            run(['git','-c','credential.helper=','push','https://github.com/'+c['repository']+'.git','HEAD:refs/heads/'+branch],cwd=work,env=publish_env,timeout=180)
            body = state/'pr-body.md'
            after_sha=run(['git','rev-parse','HEAD'],cwd=work).stdout.strip()
            ledger_body=pr_ledger.render(review_context,result,base_sha,after_sha,c['repository'],baseline,pi_report)
            safe_public(ledger_body)
            body.write_text(ledger_body)
            url = github(c,['pr','create','--repo',c['repository'],'--base',c['branch'],'--head',branch,'--title',result['title'],'--body-file',str(body)]).stdout.strip()
        feedback_receipts=feedback_report.finish(feedback_backlog,outcomes,day,url)
        atomic(state/'feedback-backlog.json',feedback_backlog)
        atomic(state/'feedback-receipts.json',feedback_receipts)
        if result.get('softwareChecks'):
            baseline=read(state/'last-software-review-input.json',{})['current']
            revision=run(['git','rev-parse',base],cwd=root).stdout.strip()
            atomic(state/'software-backlog.json',review_backlog.update(read(state/'software-backlog.json',{}),baseline,result['softwareChecks'],targets,inspection_rows,reserved,day,revision,url))
        message = ('Nightly review opened a PR: '+url+'\n'+result['summary']+'\nReview and merge it when ready; it has not been deployed.') if url else ('Nightly review finished. No code changes proposed. '+result['summary'])
        if url:
            message += '\nEvidence ledger highlights (complete trace in PR):\n'+pr_ledger.notice_rows(result)+'\nFull before/after code, test results and privacy disclosure are in the PR.'
        if deferred:
            message += '\nStill queued: '+' '.join(deferred[:3])
        if advice:
            message += '\nUsage advice: '+' '.join(advice)
        laptop_notice(c,review_notice_key(day,url),message[:5500])
        receipts[day]={'pr':url,'at':dt.datetime.now(dt.timezone.utc).isoformat(),'summary':result['summary'],'advice':advice,'deferred':deferred}
        atomic(state/'review-state.json',receipts)
        shutil.rmtree(work,ignore_errors=True)
        print('Nightly source review completed.',flush=True)


if __name__ == '__main__':
    entrypoint(main)
