"""Approved-lane privacy, durable backlog and non-overlapping review checks. Entirely offline."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import feedback_report as f
import review
from common import atomic, run as real_run

REQ={'id':'FABCDEF123456','kind':'feature','description':'Support optional relevant GIF replies.'}

class FeedbackReport(unittest.TestCase):
    def test_closed_schema_and_private_payload_rejection(self):
        good={**f.EMPTY,'requests':[REQ]};self.assertEqual(f.validate(good),good)
        cases=[dict(good,actor='private'),dict(good,counts={}),dict(good,requests=[dict(REQ,quoted='private')]),dict(good,withdrawn=[REQ['id']])]
        for text in ['Contact user@realmail.test please','See https://example.com/private context','Use sk-'+'x'*35,'Read /home/private/secret','Call 447700900001 now','Use private address 192.168.5.9']:
            cases.append(dict(good,requests=[dict(REQ,description=text)]))
        for value in cases:
            with self.assertRaises(ValueError):f.validate(value)

    def test_backlog_selection_withdrawal_and_no_false_completion(self):
        backlog={};snapshot={**f.EMPTY,'requests':[REQ]}
        selected=f.select(snapshot,backlog,'2026-01-01');self.assertEqual(selected,[REQ])
        rows=f.dispositions(selected,{'requestOutcomes':[{'id':REQ['id'],'state':'deferred','note':'Needs a safe implementation.'}]})
        receipt=f.finish(backlog,rows,'2026-01-01',None)
        self.assertEqual(receipt[0]['state'],'deferred')
        self.assertEqual(f.select(snapshot,backlog,'2026-01-01'),[])
        self.assertEqual(f.select(snapshot,backlog,'2026-01-02'),[REQ])
        with self.assertRaises(ValueError):f.finish(backlog,[dict(rows[0],state='proposed')],'2026-01-02',None)
        with self.assertRaises(ValueError):f.dispositions(selected,{'requestOutcomes':[]})
        with self.assertRaises(ValueError):f.select({**f.EMPTY,'requests':[dict(REQ,description='Changed under same ID')]},backlog,'2026-01-02')
        self.assertEqual(f.select({**f.EMPTY,'withdrawn':[REQ['id']]},backlog,'2026-01-02'),[])
        self.assertEqual(backlog,{})

    def exercise_review(self,overlap=False):
        with tempfile.TemporaryDirectory() as d:
            base=Path(d);root=base/'source';root.mkdir();state=base/'state';state.mkdir();(root/'src').mkdir()
            def git(*args):return real_run(['git',*args],cwd=root).stdout.strip()
            git('init','-q');(root/'package.json').write_text('{}');(root/'src/dates.ts').write_text('export const old = true;\n');git('add','.');git('-c','user.name=Test','-c','user.email=test@example.com','commit','-qm','fixture');sha=git('rev-parse','HEAD');git('update-ref','refs/remotes/origin/master',sha)
            atomic(state/'inbox/2026-01-01.json',{'schema':1,'suite':'software-probes-v1','results':[{'probe':p,'result':'fail'} for p in __import__('software_report').LEGACY_PROBES]})
            atomic(state/'feedback-inbox/2026-01-01.json',{**f.EMPTY,'requests':[REQ]})
            token=base/'token';token.write_text('not-a-real-token')
            c={'state':str(state),'checkout':str(root),'repository':'example/example','branch':'master','github_token':str(token),'node':'fake-node','tool_path':'/usr/bin:/bin'}
            def github(c,args):
                if args[:2]==['pr','list']:
                    value=[] if '--head' in args else [{'headRefName':'codex/nightly-older','title':'Date fix','url':'https://github.com/example/example/pull/1'}]
                elif args[:2]==['pr','view']:value={'files':[{'path':'src/dates.ts'}]}
                else:return subprocess.CompletedProcess(args,0,'https://github.com/example/example/pull/2','')
                return subprocess.CompletedProcess(args,0,json.dumps(value),'')
            def run(args,**kw):
                if args[:2]==['git','fetch'] or args[0]=='npm' or args[:2]==['git','-c'] and 'push' in args:
                    return subprocess.CompletedProcess(args,0,'','')
                if args[0]=='fake-node':
                    work=Path(args[3]);target=work/('src/dates.ts' if overlap else 'src/extra.ts');target.write_text('export const safe = true;\n')
                    context=json.loads(Path(args[6]).read_text());self.assertEqual(context['reservedFiles'],['src/dates.ts']);self.assertEqual(context['approvedFeedback'],[REQ])
                    atomic(state/'last-software-review-input.json',{'current':{'schema':1,'suite':'software-probes-v2','results':[{'probe':p,'result':'fail'} for p in __import__('software_report').PROBES]}})
                    atomic(args[5],{'title':'Implement a safe source improvement','summary':'Implemented approved improvement.','body':'A focused source change with synthetic validation.','advice':[],'deferred':[],'requestOutcomes':[{'id':REQ['id'],'state':'proposed','note':'Implemented in this PR.'}],'typecheckPassed':True,'softwareChecks':{'schema':1,'suite':'software-probes-v2','results':[{'probe':p,'result':'fail'} for p in __import__('software_report').PROBES]},'issueLedger':[{'sources':['feedback:'+REQ['id']],'problem':'An approved capability is missing.','before':'No implementation existed in the fixture.','change':'Add a safe source fixture.','verification':'Synthetic wrapper checks only.','limitations':'No real sends were used.','beforeRefs':[],'afterRefs':[{'path':'src/dates.ts' if overlap else 'src/extra.ts','line':1}]}],'targetOutcomes':[{'id':t['id'],'state':'deferred','note':'Separate source inspection remains queued.'} for t in context['publicReviewTargets']]})
                    return subprocess.CompletedProcess(args,0,'','')
                return real_run(args,**kw)
            with patch('review.github',side_effect=github),patch('review.run',side_effect=run),patch('review.laptop_notice'):
                if overlap:
                    with self.assertRaisesRegex(RuntimeError,'overlaps'):review.main(c)
                else:
                    review.main(c)
                    receipt=json.loads((state/'feedback-receipts.json').read_text())[0]
                    self.assertEqual(receipt['id'],REQ['id']);self.assertEqual(receipt['state'],'proposed');self.assertTrue(receipt['pr'].endswith('/2'))

    def test_open_pr_allows_unrelated_work(self):self.exercise_review()
    def test_open_pr_overlap_rejected(self):self.exercise_review(True)

if __name__=='__main__':unittest.main()
