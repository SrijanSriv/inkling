import unittest
import review_backlog as b
class Backlog(unittest.TestCase):
    def test_proposed_is_not_resolved_until_default_branch_passes(self):
        baseline={'results':[{'probe':'date_zero','result':'fail'}]};after={'results':[{'probe':'date_zero','result':'pass'}]}
        x=b.update({},baseline,after,[],[],set(),'2026-01-01','public-revision','https://github.com/example/example/pull/1')
        self.assertEqual(x['cases']['probe:date_zero']['state'],'proposed')
        x=b.update(x,after,after,[],[],set(),'2026-01-02','new-revision',None)
        self.assertEqual(x['cases']['probe:date_zero']['state'],'passing')
        self.assertEqual(len(x['cases']['probe:date_zero']['history']),2)
    def test_reserved_pr_keeps_case_waiting_for_review(self):
        report={'results':[{'probe':'date_zero','result':'fail'}]}
        x=b.update({},report,report,[],[],{'src/dates.ts'},'day','revision',None)
        self.assertEqual(x['cases']['probe:date_zero']['state'],'awaiting_review')
    def test_old_freeform_feedback_cannot_leak_through_public_context(self):
        old={'cases':{'probe:date_zero':{'state':'failing','history':[{'note':'withdrawn private wording'}]},'feedback:PRIVATE':{'state':'deferred'}}}
        self.assertEqual(b.public_context(old,[]),[{'id':'probe:date_zero','state':'failing'}])

    def test_all_inspection_targets_need_explicit_outcomes(self):
        targets=[{'id':'a','files':['src/a.ts']}]
        with self.assertRaises(ValueError):b.target_outcomes(targets,{'targetOutcomes':[]},[])
        with self.assertRaises(ValueError):b.target_outcomes(targets,{'targetOutcomes':[{'id':'a','state':'proposed','note':'Implemented.'}]},['src/b.ts'])
        rows=[{'id':'a','state':'deferred','note':'Separate review needed.'}]
        self.assertEqual(b.target_outcomes(targets,{'targetOutcomes':rows},[]),rows)
if __name__=='__main__':unittest.main()
