"""Offline strict-boundary and migration checks. No real messages or service changes."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import nightly
import review
from software_report import PROBES, fixture, from_stdout, loads, validate


def report():
    return {'schema': 1, 'suite': 'software-probes-v1',
            'results': [{'probe': p, 'result': 'fail'} for p in PROBES]}


class StrictBoundary(unittest.TestCase):
    def test_only_complete_fixed_schema(self):
        original = report()
        self.assertEqual(loads(json.dumps(original)), original)
        reversed_report = report()
        reversed_report['results'].reverse()
        self.assertEqual(validate(reversed_report), original)
        variants = [dict(original, events={'private': 1}), dict(original, schema=True),
                    dict(original, results=original['results'][:-1]),
                    dict(original, results=original['results']+[original['results'][0]])]
        for field, value in [('probe', 'a private request'), ('result', 'private text'), ('extra', 'secret')]:
            variant = report(); variant['results'][0][field] = value; variants.append(variant)
        variant = report(); variant['results'][0] = dict(variant['results'][1]); variants.append(variant)
        for variant in variants:
            with self.assertRaises(ValueError): validate(variant)
        with self.assertRaises(ValueError): loads('{"schema":1,"schema":1}')
        with self.assertRaises(ValueError): loads('x'*4097)

    def test_python_and_node_boundaries_agree(self):
        module = (Path(__file__).parent/'software-report.mjs').resolve().as_uri()
        program = 'import {validateReport} from '+json.dumps(module)+';let s="";for await(const b of process.stdin)s+=b;try{process.stdout.write(JSON.stringify(validateReport(JSON.parse(s))))}catch{process.exitCode=1}'
        cases = [report(), dict(report(), extra='private-canary')]
        for field in ('probe', 'result', 'private'):
            value=report();value['results'][0][field]='private-canary';cases.append(value)
        for value in cases:
            result=subprocess.run(['node','--input-type=module','-e',program],input=json.dumps(value),text=True,capture_output=True)
            try:
                expected=validate(value)
            except ValueError:
                self.assertNotEqual(result.returncode,0)
            else:
                self.assertEqual(result.returncode,0,result.stderr)
                self.assertEqual(json.loads(result.stdout),expected)

    def test_no_private_input_slot(self):
        expected = json.dumps(validate(report()), sort_keys=True)
        for i in range(5000):
            value = report(); value['private'] = f'personal-canary-{i}'
            with self.assertRaises(ValueError): validate(value)
            self.assertEqual(json.dumps(validate(report()), sort_keys=True), expected)

    def test_runner_output_and_no_partial_fallback(self):
        self.assertEqual(from_stdout('synthetic log\nAUDIT_PROBES='+json.dumps(report()['results'])), report())
        for text in ['private error', 'AUDIT_PROBES=[]', 'AUDIT_PROBES=[]\nAUDIT_PROBES=[]']:
            with self.assertRaises(ValueError): from_stdout(text)

    def test_legacy_inbox_quarantined_before_model_or_github(self):
        with tempfile.TemporaryDirectory() as d:
            state = Path(d); (state/'inbox').mkdir()
            legacy = state/'inbox/2026-01-01.json'; legacy.write_text('{"events":{"some operation":3}}')
            with patch('review.github') as github, patch('review.run') as run:
                review.main({'state': d})
            github.assert_not_called(); run.assert_not_called()
            self.assertFalse(legacy.exists())
            self.assertTrue((state/'legacy-report-quarantine'/legacy.name).exists())

    def test_old_local_reports_never_transferred(self):
        with tempfile.TemporaryDirectory() as d:
            state = Path(d); (state/'reports').mkdir(); (state/'software-reports').mkdir()
            (state/'reports/private.json').write_text('{"private":"canary"}')
            (state/'software-reports/2026-01-01.json').write_text(json.dumps(report()))
            calls = []
            def fake(args, **kw):
                calls.append(list(map(str,args)))
                return subprocess.CompletedProcess(args, 0, '[]', '')
            with patch('nightly.run', side_effect=fake):
                nightly.transfer({'state': d, 'laptop_ssh': 'example', 'laptop_state': '/example', 'backup_repository': '/backup'})
            copies = [args for args in calls if args[0]=='scp']
            self.assertEqual(len(copies), 1)
            self.assertIn('software-reports', ' '.join(copies[0]))
            self.assertNotIn('private.json', json.dumps(calls))

    def test_invalid_strict_report_not_transferred(self):
        with tempfile.TemporaryDirectory() as d:
            state=Path(d); (state/'software-reports').mkdir()
            (state/'software-reports/2026-01-01.json').write_text('{"private":"canary"}')
            calls=[]
            def fake(args, **kw):
                calls.append(args)
                return subprocess.CompletedProcess(args,0,'','')
            with patch('nightly.run', side_effect=fake), self.assertRaises(ValueError):
                nightly.transfer({'state':d,'laptop_ssh':'example','laptop_state':'/example','backup_repository':'/backup'})
            self.assertFalse(any(args[0]=='scp' for args in calls))

    def test_audit_failure_still_transfers_backup(self):
        with tempfile.TemporaryDirectory() as d:
            state=Path(d)
            from common import atomic
            import datetime as dt
            day=dt.datetime.now(dt.timezone.utc).date().isoformat()
            atomic(state/'nightly.json',{'day':day})
            with patch('nightly.collect',side_effect=RuntimeError),patch('nightly.transfer') as transfer,patch('nightly.notify'):
                nightly.main({'state':d,'timezone':'UTC'})
            transfer.assert_called_once()
            self.assertFalse((state/'software-reports'/f'{day}.json').exists())


if __name__ == '__main__': unittest.main()
