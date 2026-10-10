"""Pi: poll only the configured reviewed default branch; stage, check, switch, health-check, roll back."""
import datetime as dt
import json
import os
from pathlib import Path
import re
import shutil
import tarfile
import tempfile
import time
import urllib.request
from common import atomic, entrypoint, lock, notify, read, run
from nightly import snapshot
from webhook_queue import delivery_checkpoint


def point(link, target):
    temp = link.with_name(link.name+'.new')
    temp.unlink(missing_ok=True)
    temp.symlink_to(target, target_is_directory=True)
    os.replace(temp,link)


def healthy(c, sha, seconds=120):
    end = time.monotonic()+seconds
    while time.monotonic()<end:
        try:
            with urllib.request.urlopen(c['health_url'], timeout=3) as response:
                body=json.load(response)
            if body.get('whatsapp') is True and body.get('version')==sha:
                return True
        except (OSError, ValueError):
            pass
        time.sleep(3)
    return False


def main(c):
    state, root = Path(c['state']), Path(c['checkout'])
    with lock(state/'maintenance.lock'), delivery_checkpoint(c):
        dirty = run(['git','status','--porcelain'],cwd=root).stdout.strip()
        if dirty:
            notify(c,'update-dirty','Automatic update paused because the Pi source has local edits. They have been preserved; reconcile them before deploying GitHub changes.')
            return
        run(['git','fetch','--prune','origin',c['branch']],cwd=root)
        sha=run(['git','rev-parse','origin/'+c['branch']],cwd=root).stdout.strip()
        if not re.fullmatch('[a-f0-9]{40}',sha):
            raise RuntimeError('Invalid deployment revision')
        releases=Path(c['releases'])
        releases.mkdir(parents=True,exist_ok=True,mode=0o700)
        current=releases/'current'
        prior=current.resolve() if current.is_symlink() else root
        prior_sha=read(prior/'version.json',{}).get('sha','dev')
        status=read(state/'deploy.json',{})
        if sha==prior_sha and healthy(c,sha,3):
            return
        if status.get('failed')==sha and '--retry' not in __import__('sys').argv:
            return
        # A diverged local branch is never reset or overwritten.
        old=run(['git','rev-parse','HEAD'],cwd=root).stdout.strip()
        run(['git','merge-base','--is-ancestor',old,sha],cwd=root)
        changed=run(['git','diff','--name-only',old,sha],cwd=root).stdout.splitlines()
        music_changed=c.get('music_service') and any(n.startswith('src/music') or n in {'package.json','package-lock.json'} for n in changed)
        candidate=releases/sha
        if candidate.exists() and candidate != prior:
            shutil.rmtree(candidate)
        if candidate==prior:
            raise RuntimeError('Current release is unhealthy; manual attention needed')
        candidate.mkdir(mode=0o700)
        archive=state/'deploy-source.tar'
        switched=False
        try:
            run(['git','archive','--format=tar','-o',archive,sha],cwd=root)
            with tarfile.open(archive) as tar:
                # New Python extraction filter rejects escaping links and special files.
                tar.extractall(candidate,filter='data')
            if (candidate/'.env').exists() or (candidate/'data').exists() or (candidate/'version.json').exists():
                raise RuntimeError('Deployment contains private runtime paths')
            env=dict(os.environ,PATH=c['tool_path'])
            run(['npm','ci','--ignore-scripts','--no-audit','--no-fund'],cwd=candidate,env=env,timeout=300)
            run(['npm','run','typecheck'],cwd=candidate,env=env,timeout=120)
            for folder in ['browser','coding']:
                for file in (candidate/folder).glob('*.mjs'):
                    run([c['node'],'--check',file],cwd=candidate,timeout=10)
            run([c['node'],'--input-type=module','-e','await import("tsx"); await import("sharp");'],cwd=candidate,timeout=30)
            # Recoverable encrypted checkpoint before code changes, independent of laptop reachability.
            snapshot(c,dt.datetime.now().date().isoformat())
            (candidate/'.env').symlink_to(root/'.env')
            (candidate/'data').symlink_to(c['data'],target_is_directory=True)
            atomic(candidate/'version.json',{'sha':sha})
            point(current,candidate)
            switched=True
            if music_changed:
                run(['systemctl','--user','restart',c['music_service']],timeout=100)
            run(['systemctl','--user','restart',c['service']],timeout=90)
            if not healthy(c,sha):
                raise RuntimeError('New release did not reconnect WhatsApp')
            run(['git','merge','--ff-only',sha],cwd=root)
            atomic(state/'deploy.json',{'live':sha,'previous':prior_sha,'at':dt.datetime.now(dt.timezone.utc).isoformat()})
            notify(c,'deploy-'+sha,'GitHub update is live on the Pi ('+sha[:7]+'). Code checks passed and WhatsApp reconnected. A recovery backup was made before the update.')
            # Bounded dependency copies; keep the live and previous versions plus recent releases.
            keep={candidate,prior}
            others=sorted((p for p in releases.iterdir() if p.is_dir() and not p.is_symlink() and re.fullmatch('[a-f0-9]{40}',p.name)),key=lambda p:p.stat().st_mtime,reverse=True)
            keep.update(others[:3])
            for p in others:
                if p not in keep:
                    shutil.rmtree(p)
            print('Deployment healthy.',flush=True)
        except Exception:
            if switched:
                point(current,prior)
                if music_changed:
                    run(['systemctl','--user','restart',c['music_service']],timeout=100,check=False)
                run(['systemctl','--user','restart',c['service']],timeout=90)
                rolled_back=healthy(c,prior_sha) if prior_sha!='dev' else run(['curl','-fsS','--max-time','10',c['health_url']],check=False).returncode==0
            else:
                rolled_back=True
            atomic(state/'deploy.json',{'failed':sha,'previous':prior_sha,'rollbackHealthy':rolled_back,'at':dt.datetime.now(dt.timezone.utc).isoformat()})
            notify(c,'deploy-failed-'+sha,'GitHub update '+sha[:7]+' failed its checks. '+('The previous version is running.' if rolled_back else 'The previous version also needs attention; check the Pi.')+' Automatic retries for this revision are paused.')
            raise
        finally:
            archive.unlink(missing_ok=True)


if __name__=='__main__':
    entrypoint(main)
