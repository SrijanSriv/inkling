"""Deterministic session tests with fake decoding; no audio devices, models or external messages."""
import threading
import unittest
from incremental import Sessions, SessionError, MAX_BYTES


class Incremental(unittest.TestCase):
    def setUp(self):
        self.now = [100.0]
        self.decoded = []
        self.validated = []

        def decode(pcm):
            self.decoded.append(pcm)
            return {'text':'a complete fixture transcript'}

        def validate(result, pcm):
            self.validated.append(pcm)
            return {'text':result['text'], 'warning':'fixture coverage warning'}

        self.sessions = Sessions(decode, validate, clock=lambda:self.now[0], start=False)
        self.addCleanup(self.sessions.close)

    def append(self, ident, size, offset=0):
        for at in range(0,size,16000):
            self.sessions.append(ident,offset+at,b'\x01\x02'*min(8000,(size-at)//2))

    def test_drafts_never_validated_and_final_uses_all_audio(self):
        ident = self.sessions.create()['id']
        self.append(ident,128000)
        self.assertTrue(self.sessions.step())
        self.assertEqual(self.validated, [])
        self.assertEqual(self.sessions.status(ident)['state'],'capturing')
        self.append(ident,32000,128000)
        self.sessions.finish(ident,160000)
        self.assertTrue(self.sessions.step())
        self.assertEqual(len(self.validated[0]),160000)
        self.assertEqual(self.sessions.status(ident)['result']['warning'],'fixture coverage warning')
        self.assertEqual(self.sessions.status(ident)['receivedBytes'],160000)
        self.assertEqual(self.sessions.finish(ident,160000)['state'],'done')
        self.assertFalse(self.sessions.step())
        self.assertEqual(len(self.decoded),2)
        self.assertEqual(self.sessions.session.audio,b'')

    def test_identical_retry_allowed_conflicts_gaps_sizes_rejected(self):
        ident = self.sessions.create()['id']
        self.sessions.append(ident,0,b'\x01\x02'*8000)
        self.sessions.append(ident,0,b'\x01\x02'*8000)
        for offset,audio in [(0,b'\x03\x04'),(16002,b'\x00\x00'),(16000,b'x'),(16000,b'x'*32002)]:
            with self.assertRaises(SessionError):
                self.sessions.append(ident,offset,audio)
        with self.assertRaises(SessionError):
            self.sessions.finish(ident,16002)
        self.assertEqual(self.sessions.status(ident)['receivedBytes'],16000)

    def test_limit_and_expiry(self):
        ident = self.sessions.create()['id']
        self.append(ident,MAX_BYTES)
        with self.assertRaises(SessionError):
            self.sessions.append(ident,MAX_BYTES,b'\x01\x02')
        self.now[0]+=11
        self.assertEqual(self.sessions.status(ident)['state'],'expired')
        self.assertFalse(self.sessions.step())
        self.assertEqual(self.sessions.session.audio,b'')
        self.assertEqual(self.sessions.session.draft,'')

    def test_cancel_during_native_work_cannot_publish_or_start_second_model_call(self):
        entered, release = threading.Event(), threading.Event()

        def blocked(pcm):
            entered.set()
            release.wait(2)
            return {'text':'must be discarded'}

        self.sessions.decode=blocked
        ident=self.sessions.create()['id']
        self.append(ident,128000)
        worker=threading.Thread(target=self.sessions.step)
        worker.start()
        self.assertTrue(entered.wait(1))
        self.sessions.cancel(ident)
        with self.assertRaises(SessionError):
            self.sessions.create()
        release.set()
        worker.join(1)
        self.assertFalse(worker.is_alive())
        result=self.sessions.status(ident)
        self.assertEqual(result['state'],'cancelled')
        self.assertEqual(result['draft'],'')
        self.assertIsNone(result['result'])
        self.assertEqual(self.validated,[])

    def test_append_and_release_during_preview_finalises_new_tail(self):
        entered, release = threading.Event(), threading.Event()
        original=self.sessions.decode

        def blocked(pcm):
            entered.set()
            release.wait(2)
            return original(pcm)

        self.sessions.decode=blocked
        ident=self.sessions.create()['id']
        self.append(ident,128000)
        worker=threading.Thread(target=self.sessions.step)
        worker.start()
        self.assertTrue(entered.wait(1))
        self.append(ident,32000,128000)
        self.sessions.finish(ident,160000)
        release.set()
        worker.join(1)
        self.assertEqual(self.sessions.status(ident)['state'],'finishing')
        self.sessions.step()
        self.assertEqual(len(self.validated[0]),160000)

    def test_failure_pauses_admission_and_never_returns_partial_as_final(self):
        self.sessions.decode=lambda _: (_ for _ in ()).throw(RuntimeError('private fixture error'))
        ident=self.sessions.create()['id']
        self.append(ident,128000)
        self.sessions.step()
        state=self.sessions.status(ident)
        self.assertEqual(state['error'],'unavailable')
        self.assertIsNone(state['result'])
        self.assertEqual(state['draft'],'')
        with self.assertRaises(SessionError):
            self.sessions.create()
        self.now[0]+=61
        self.assertEqual(self.sessions.create()['state'],'capturing')

    def test_native_stall_restarts_only_supervised_worker_after_deadline(self):
        restarted=[]
        self.sessions.fatal=lambda:restarted.append(True)
        self.sessions.active=True
        self.sessions.native_started=self.now[0]
        self.now[0]+=190
        self.sessions.watchdog()
        self.assertEqual(restarted,[])
        self.now[0]+=6
        self.sessions.watchdog()
        self.sessions.watchdog()
        self.assertEqual(restarted,[True])
        self.sessions.active=False


if __name__ == '__main__':
    unittest.main()
