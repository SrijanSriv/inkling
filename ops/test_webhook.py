"""Offline signature, branch and queue-race checks. No deployment or notifications."""
import hashlib
import hmac
import json
from pathlib import Path
import tempfile
import unittest
from common import read
from webhook import delivery
from webhook_queue import delivery_checkpoint, queue_delivery, queue_file


class Webhook(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.c = {'state': self.temp.name, 'branch': 'master', 'webhook_repository_id': 123}
        self.secret = b'x'*64
        self.ident = '00000000-0000-0000-0000-000000000001'
        self.other = '00000000-0000-0000-0000-000000000002'
        self.payload = {'repository': {'id': 123}, 'ref': 'refs/heads/master', 'after': 'a'*40, 'deleted': False}

    def signed(self, payload=None, event='push', ident=None):
        body = json.dumps(self.payload if payload is None else payload).encode()
        headers = {'X-Hub-Signature-256': 'sha256='+hmac.new(self.secret, body, hashlib.sha256).hexdigest(),
                   'X-GitHub-Event': event, 'X-GitHub-Delivery': ident or self.ident}
        return headers, body

    def test_unsigned_and_tampered_deliveries_cannot_queue(self):
        headers, body = self.signed()
        self.assertEqual(delivery(self.c, self.secret, {}, body)[0], 401)
        self.assertEqual(delivery(self.c, self.secret, headers, body+b' ')[0], 401)
        headers['X-Hub-Signature-256'] = 'non-ascii-\u00e9'
        self.assertEqual(delivery(self.c, self.secret, headers, body)[0], 401)
        self.assertFalse(queue_file(self.c).exists())

    def test_only_target_repository_branch_non_deletion_can_queue(self):
        for changed in [{'ref': 'refs/heads/feature'}, {'deleted': True}, {'repository': {'id': 999}}, {'after': '0'*40}]:
            headers, body = self.signed({**self.payload, **changed})
            self.assertFalse(delivery(self.c, self.secret, headers, body)[1])
        headers, body = self.signed(event='ping')
        self.assertEqual(delivery(self.c, self.secret, headers, body), (200, False))
        self.assertFalse(queue_file(self.c).exists())

    def test_duplicate_and_restart_are_durable(self):
        headers, body = self.signed()
        self.assertEqual(delivery(self.c, self.secret, headers, body), (202, True))
        self.assertEqual(delivery(dict(self.c), self.secret, headers, body), (202, False))
        self.assertEqual(read(queue_file(self.c))['pending'], self.ident)
        with delivery_checkpoint(self.c):
            pass
        self.assertIsNone(read(queue_file(self.c))['pending'])

    def test_new_push_during_deployment_requires_second_fetch(self):
        queue_delivery(self.c, self.ident)
        with delivery_checkpoint(self.c):
            queue_delivery(self.c, self.other)
        self.assertEqual(read(queue_file(self.c))['pending'], self.other)
        with self.assertRaises(RuntimeError):
            with delivery_checkpoint(self.c):
                raise RuntimeError('simulated failed deployment')
        self.assertEqual(read(queue_file(self.c))['pending'], self.other)


if __name__ == '__main__':
    unittest.main()
