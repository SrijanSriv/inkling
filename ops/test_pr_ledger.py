import copy
import tempfile
from pathlib import Path
import unittest
import pr_ledger as ledger
from common import run

class Ledger(unittest.TestCase):
    def fixture(self,root):
        run(['git','init','-q'],cwd=root);(root/'src').mkdir();(root/'src/example.ts').write_text('export const value = false;\n');run(['git','add','.'],cwd=root);run(['git','-c','user.name=Test','-c','user.email=test@example.com','commit','-qm','fixture'],cwd=root)
        (root/'src/example.ts').write_text('export const value = true;\n')
        context={'publicReviewTargets':[{'id':'example'}],'approvedFeedback':[]}
        result={'softwareChecks':{'results':[{'probe':'protocol_output','result':'pass'}]},'requestOutcomes':[],'targetOutcomes':[{'id':'example','state':'proposed','note':'Changed the relevant source fixture.'}],
          'issueLedger':[{'sources':['probe:protocol_output','inspection:example'],'problem':'Protocol text reaches a reply.','before':'A synthetic declaration is retained.','change':'Strip the declaration before returning a reply.','verification':'The fixed probe changes from fail to pass.','limitations':'No live conversations were used.','beforeRefs':[{'path':'src/example.ts','line':1}],'afterRefs':[{'path':'src/example.ts','line':1}]}]}
        return context,result
    def test_code_references_sources_and_coverage_are_verified(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);context,result=self.fixture(root);names=['src/example.ts'];check=lambda x:None
            ledger.validate(context,result,names,root,check)
            for field,value in [('sources',['chat:private']),('afterRefs',[{'path':'src/example.ts','line':500}]),('afterRefs',[{'path':'../secret','line':1}]),('afterRefs',[]),('beforeRefs',[])]:
                altered=copy.deepcopy(result);altered['issueLedger'][0][field]=value
                with self.subTest(field=field),self.assertRaises((ValueError,RuntimeError)):ledger.validate(context,altered,names,root,check)
            altered=copy.deepcopy(result);altered['issueLedger'][0]['sources']=['probe:protocol_output']
            with self.assertRaises(ValueError):ledger.validate(context,altered,names,root,check)
    def test_render_discloses_inputs_and_measured_results(self):
        with tempfile.TemporaryDirectory() as d:
            context,result=self.fixture(Path(d));result.update(summary='A synthetic source fix.',deferred=['Other issues remain.']);baseline={'suite':'software-probes-v2','results':[{'probe':'protocol_output','result':'fail'}]}
            text=ledger.render(context,result,'a'*40,'b'*40,'example/example',baseline,baseline)
            self.assertIn('Codex/OpenAI',text);self.assertIn('**Not provided:**',text);self.assertIn('fresh baseline **fail**, after patch **pass**',text);self.assertIn('/blob/'+'a'*40+'/src/example.ts#L1',text);self.assertIn('/blob/'+'b'*40+'/src/example.ts#L1',text);self.assertIn('not deployed',text)
if __name__=='__main__':unittest.main()
