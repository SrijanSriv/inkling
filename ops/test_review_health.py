import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from common import atomic, read
from review_health import newest_pending, tracking, progress, ReviewBlocked

class Health(unittest.TestCase):
    def test_public_inspection_targets_point_to_existing_source(self):
        root=Path(__file__).resolve().parent.parent
        targets=json.loads((root/'ops/review-targets.json').read_text())
        for target in targets:
            for name in target['files']:
                with self.subTest(target=target['id'],path=name):self.assertTrue((root/name).is_file())

    def test_exhausted_old_day_cannot_block_newest_source(self):
        paths=[Path('2026-01-01.json'),Path('2026-01-02.json'),Path('2026-01-03.json')]
        newest,old=newest_pending(paths,{'2026-01-01':{'pr':'public'}})
        self.assertEqual(newest.stem,'2026-01-03');self.assertEqual([p.stem for p in old],['2026-01-02'])
        self.assertEqual(newest_pending(paths,{p.stem:{} for p in paths}),(None,[]))
        with self.assertRaises(ValueError):newest_pending([Path('private-name.json')],{})
    def test_error_messages_never_enter_health(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(RuntimeError),tracking(root):
                progress(root,'validation',day='2026-01-03')
                raise RuntimeError('private-canary@example.test')
            text=(Path(root)/'review-health.json').read_text();self.assertNotIn('private-canary',text)
            self.assertEqual(json.loads(text)['stage'],'validation');self.assertEqual(json.loads(text)['status'],'failed')
            with self.assertRaises(ReviewBlocked),tracking(root):raise ReviewBlocked('private')
            self.assertEqual(read(Path(root)/'review-health.json')['status'],'blocked')
    def test_worker_category_is_closed(self):
        with tempfile.TemporaryDirectory() as root:
            for category,expected in [('quota','quota'),('private-canary','other')]:
                atomic(Path(root)/'review-worker-health.json',{'status':'failed','category':category})
                with self.assertRaises(RuntimeError),tracking(root):
                    progress(root,'worker');raise RuntimeError('raw private response')
                self.assertEqual(read(Path(root)/'review-health.json')['category'],expected)
    def test_server_errors_are_classified_without_raw_output(self):
        module=(Path(__file__).parent/'review-health.mjs').resolve().as_uri()
        code='import {category,turnFailure} from '+json.dumps(module)+'; console.log(JSON.stringify([category("Usage limit reached private-canary"),category("invalid output schema private-canary"),category({codexErrorInfo:"usageLimitExceeded"}),turnFailure({method:"turn/completed",params:{turn:{status:"completed"}}})]));'
        result=subprocess.run(['node','--input-type=module','-e',code],capture_output=True,text=True,check=True)
        self.assertEqual(json.loads(result.stdout),['quota','request_schema','quota',None]);self.assertNotIn('private-canary',result.stdout)

class PublicationRecovery(unittest.TestCase):
    def test_only_our_recorded_commit_can_be_replaced_with_a_lease(self):
        import review
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as root:
            day='2026-01-03';branch='codex/nightly-'+day;ref='refs/heads/'+branch
            c={'state':root,'repository':'example/example'};old='a'*40;new='b'*40
            marker=Path(root)/('review-branch-'+day+'.json');atomic(marker,[old]);calls=[]
            def run(args,**kwargs):
                calls.append(args)
                out=new+'\n' if args[1]=='rev-parse' else old+'\t'+ref+'\n' if 'ls-remote' in args else ''
                return subprocess.CompletedProcess(args,0,out,'')
            with patch('review.run',side_effect=run):review.publish_branch(c,Path(root),{},branch,day)
            push=next(x for x in calls if 'push' in x)
            self.assertIn('--force-with-lease='+ref+':'+old,push)
            self.assertEqual(read(marker),[old,new])
            marker.unlink();calls.clear()
            with patch('review.run',side_effect=run),self.assertRaisesRegex(RuntimeError,'unrecognized'):review.publish_branch(c,Path(root),{},branch,day)
            self.assertFalse(any('push' in x for x in calls));self.assertFalse(marker.exists())

if __name__=='__main__':unittest.main()
