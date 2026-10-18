"""Pi: midnight local snapshot, verified recovery, retryable laptop mirror and diagnostics."""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import shutil
import time
from zoneinfo import ZoneInfo
from common import atomic, config, entrypoint, lock, notify, read, restic, run
from software_report import collect, load
import feedback_report


def inventory(root):
    result = {}
    for p in sorted(Path(root).rglob('*')):
        if p.is_symlink():
            raise RuntimeError('Backup source contains a symlink')
        if p.is_file() and not p.name.endswith('.tmp') and not p.name.startswith('handoff-'):
            result[str(p.relative_to(root))] = hashlib.sha256(p.read_bytes()).hexdigest()
    return result


def snapshot(c, day):
    state = Path(c['state'])
    stage = state/'stage'
    shutil.rmtree(stage, ignore_errors=True)
    stage.mkdir(mode=0o700)
    try:
        # Require a stable generation, rather than interrupting a chat or music at midnight.
        for attempt in range(5):
            before = inventory(c['data'])
            target = stage/'recovery/data'
            shutil.rmtree(target, ignore_errors=True)
            for name in before:
                out = target/name
                out.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                shutil.copyfile(Path(c['data'])/name, out)
            if before == inventory(c['data']) == inventory(target):
                break
            time.sleep(1)
        else:
            raise RuntimeError('Data did not settle for a consistent snapshot')
        shutil.copyfile(Path(c['checkout'])/'.env', stage/'recovery/.env')
        units = Path.home()/'.config/systemd/user'
        shutil.copytree(units, stage/'recovery/systemd-user', symlinks=False)
        # Public, committed source only. Credentials and untracked source never enter this archive.
        archive = stage/'recovery/source.tar'
        run(['git', 'archive', '--format=tar', '-o', archive, 'HEAD'], cwd=c['checkout'])
        atomic(stage/'recovery/manifest.json', {'schema': 1, 'day': day,
               'revision': run(['git','rev-parse','HEAD'],cwd=c['checkout']).stdout.strip(),
               'dataHashes': before, 'consistency': 'live file contents unchanged across copy; transient handoff files excluded'})
        if not (Path(c['backup_repository'])/'config').exists():
            restic(c, 'init')
        restic(c, 'backup', '--host', 'inkling', '--tag', 'nightly', 'recovery', cwd=stage)
        # Prove recoverability, including the key needed for the sealed memory. No decrypted chats are printed.
        restored = state/'restore-check'
        shutil.rmtree(restored, ignore_errors=True)
        restic(c, 'restore', 'latest', '--tag', 'nightly', '--target', restored)
        # A relative backup argument restores under its own name, not the absolute snapshot label.
        recovered = restored/'recovery'
        if inventory(stage/'recovery') != inventory(recovered):
            raise RuntimeError('Restored backup checksum mismatch')
        shutil.rmtree(restored)
        restic(c, 'check')
        restic(c, 'forget', '--tag', 'nightly', '--group-by', 'host', '--keep-daily', '30',
               '--keep-weekly', '8', '--keep-monthly', '12', '--prune')
        if dt.date.fromisoformat(day).weekday() == 6:
            restic(c, 'check', '--read-data')
        return len(before)
    finally:
        shutil.rmtree(stage, ignore_errors=True)
        shutil.rmtree(state/'restore-check', ignore_errors=True)


def transfer(c):
    host, remote = c['laptop_ssh'], c['laptop_state']
    # Configuration is trusted, still restrict shell fragments used by rsync's remote protocol.
    import shlex
    remote_rsync = 'flock '+shlex.quote(remote+'/backup.lock')+' rsync'
    run(['rsync', '-az', '--delete-delay', '--rsync-path', remote_rsync,
         '-e', 'ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3',
         c['backup_repository']+'/', host+':'+remote+'/backups/'], timeout=1800)
    # Explicitly approved wording is a separate lane. Never mix local issue counts or chat excerpts into it.
    try:
        feedback = feedback_report.collect(c)
        feedback_day = dt.datetime.now(ZoneInfo(c.get('timezone','UTC'))).date().isoformat()
        remote_feedback = remote+'/feedback-inbox/'+feedback_day+'.json'
        out = Path(c['state'])/'feedback-outbox'/'approved.json'
        atomic(out, feedback)
        run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10',host,'mkdir -p '+shlex.quote(remote+'/feedback-inbox')+' && chmod 700 '+shlex.quote(remote+'/feedback-inbox')])
        run(['scp','-q','-o','BatchMode=yes','-o','ConnectTimeout=10',out,host+':'+remote_feedback+'.tmp'])
        run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10',host,'mv '+shlex.quote(remote_feedback+'.tmp')+' '+shlex.quote(remote_feedback)])
        received = run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10',host,
            'python3 -c '+shlex.quote('import pathlib; p=pathlib.Path('+repr(remote+'/feedback-receipts.json')+'); print(p.read_text() if p.exists() and p.stat().st_size<30000 else "[]")')])
        run([c['node'],'--env-file=.env','--import','tsx','src/feedback-export.ts','--receipts'],cwd=c['checkout'],data=received.stdout,timeout=30)
        atomic(Path(c['state'])/'feedback-transfer.json',{'ok':True,'at':dt.datetime.now(dt.timezone.utc).isoformat()})
    except Exception:
        # A failed consented handoff never falls back to raw content or prevents the encrypted backup.
        atomic(Path(c['state'])/'feedback-transfer.json',{'ok':False,'at':dt.datetime.now(dt.timezone.utc).isoformat()})
        try: notify(c,'feedback-handoff-'+dt.datetime.now(dt.timezone.utc).date().isoformat(),'Approved improvement requests or their status receipts could not be transferred. Backups and synthetic checks continue; no private-log fallback was used. The handoff will retry.')
        except Exception: pass
        print('Approved feedback handoff unavailable; backup and fixed checks continue.',flush=True)
    for p in sorted((Path(c['state'])/'software-reports').glob('*.json')):
        load(p)  # Reject extra fields, legacy diagnostics and malformed reports before any transfer.
        # Publish each strictly validated software report atomically after the backup transfer is complete.
        run(['scp','-q','-o','BatchMode=yes','-o','ConnectTimeout=10',p,host+':'+remote+'/inbox/'+p.name+'.tmp'])
        run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10',host,
             'mv '+shlex.quote(remote+'/inbox/'+p.name+'.tmp')+' '+shlex.quote(remote+'/inbox/'+p.name)])
    # Only a successful mirror receives a completion marker.
    run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10',host,
         'date -u +%FT%TZ > '+shlex.quote(remote+'/backup-last-success')])
    # Notifications stay queued on the laptop until the Pi durably enqueues them.
    result = run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10',host,
                  'python3 -c '+shlex.quote('import pathlib,json; p=pathlib.Path('+repr(remote+'/notices')+'); print(json.dumps([json.loads(f.read_text()) for f in sorted(p.glob("*.json"))][:50]))')])
    notices = json.loads(result.stdout)
    for notice in notices:
        if not isinstance(notice, dict) or not isinstance(notice.get('key'), str) or not isinstance(notice.get('message'), str):
            raise RuntimeError('Invalid remote notice')
        notify(c, notice['key'], notice['message'])
        name = hashlib.sha256(notice['key'].encode()).hexdigest()+'.json'
        run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10',host,'rm -f '+shlex.quote(remote+'/notices/'+name)])


def main(c):
    state = Path(c['state'])
    with lock(state/'maintenance.lock'):
        today = dt.datetime.now(ZoneInfo(c['timezone'])).date().isoformat()
        done = read(state/'nightly.json', {})
        if done.get('day') != today or '--force' in __import__('sys').argv:
            end = dt.datetime.now(dt.timezone.utc)
            files = snapshot(c, today)
            done = {'day': today, 'until': end.isoformat(), 'files': files, 'capturedAt': end.isoformat()}
            atomic(state/'nightly.json', done)
        # Backups do not depend on a successful software check. Never fall back to private diagnostics.
        report_path = state/'software-reports'/f'{today}.json'
        audit_ok = True
        try:
            if not report_path.exists():
                atomic(report_path, collect(c))
            load(report_path)
        except Exception:
            audit_ok = False
        # Repeat this even when today's snapshot is already done: outages must not lose a night.
        transfer(c)
        if not audit_ok:
            notify(c, 'software-check-'+today, 'The backup was transferred, but isolated software checks failed. No diagnostic fallback was sent to Codex; maintenance will retry.')
        success = read(state/'transfer.json', {})
        if success.get('day') != today:
            notify(c, 'backup-'+today, 'Nightly backup saved to the laptop and restored successfully for verification. Only fixed synthetic software checks are eligible for Codex review.')
        atomic(state/'transfer.json', {'day': today, 'at': dt.datetime.now(dt.timezone.utc).isoformat()})
        # Keep bounded non-sensitive local reports; backed-up memory retention is separate.
        for p in (state/'software-reports').glob('*.json'):
            if time.time()-p.stat().st_mtime > 40*86400:
                p.unlink()
        print('Backup, restore verification and laptop transfer succeeded.', flush=True)


if __name__ == '__main__':
    entrypoint(main)
