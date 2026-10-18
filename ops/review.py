"""Laptop: strict synthetic report -> isolated Codex -> checked, human-reviewed PR."""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
from common import atomic, entrypoint, laptop_notice, lock, read, run
from software_report import load as load_software_report


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
            receipts[day] = {'pr': url}
            atomic(state/'review-state.json',receipts)
            return
        attempts = read(state/'review-attempts.json', {})
        if attempts.get(day, 0) >= 3:
            laptop_notice(c, 'review-blocked-'+day, 'Nightly review for '+day+' stopped after three failed attempts. Your backups continue normally. Check the laptop review service before retrying.')
            return
        opens = json.loads(github(c,['pr','list','--repo',c['repository'],'--state','open','--json','headRefName,title,url']).stdout)
        maintenance = [p for p in opens if p['headRefName'].startswith('codex/nightly-')]
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
        atomic(context,{'openMaintenancePRs':maintenance,'instruction':'If a maintenance PR is already open, do not modify any files. Report only new, supported advice; avoid duplicate fixes.' if maintenance else 'No maintenance PR is open.'})
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
        advice = result.get('advice',[])
        if not isinstance(advice,list) or len(advice)>3 or any(not isinstance(a,str) or len(a)>1000 for a in advice):
            raise RuntimeError('Invalid review advice')
        for a in advice:
            safe_public(a)
        names = changed_files(work)
        url = None
        if names:
            if maintenance:
                raise RuntimeError('A maintenance PR is already open')
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
            body.write_text(result['body']+'\n\nValidation: `npm run typecheck` and browser/coding JavaScript syntax checks passed in the offline sandbox.\n\nAutomated nightly review using a fixed public synthetic software suite only. No private messages, mailbox data or credentials were provided. Human review and merge are required; this job cannot deploy.\n')
            url = github(c,['pr','create','--repo',c['repository'],'--base',c['branch'],'--head',branch,'--title',result['title'],'--body-file',str(body)]).stdout.strip()
        message = ('Nightly review opened a PR: '+url+'\n'+result['summary']+'\nReview and merge it when ready; it has not been deployed.') if url else ('Nightly review finished. No code changes proposed. '+result['summary'])
        if advice:
            message += '\nUsage advice: '+' '.join(advice)
        laptop_notice(c,review_notice_key(day,url),message[:5500])
        receipts[day]={'pr':url,'at':dt.datetime.now(dt.timezone.utc).isoformat(),'summary':result['summary'],'advice':advice}
        atomic(state/'review-state.json',receipts)
        shutil.rmtree(work,ignore_errors=True)
        print('Nightly source review completed.',flush=True)


if __name__ == '__main__':
    entrypoint(main)
