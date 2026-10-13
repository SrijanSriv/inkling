"""Synthesis bounds, single-flight and private HTTP boundary; no real models or messages."""
import http.client
import io
import json
import threading
import unittest
import wave
from unittest.mock import patch
from http.server import ThreadingHTTPServer
import server
from synthesis import Synthesis, SpeechError, validate_wav


def wav():
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(24000)
        audio.writeframes(b'\x01\x00' * 2400)
    return buffer.getvalue()


class SynthesisChecks(unittest.TestCase):
    def setUp(self):
        self.engine = Synthesis('http://127.0.0.1:8880', 'af_bella')

    def test_voice_text_and_url_bounds(self):
        for upstream in ['https://example.com', 'http://127.0.0.1/private', 'http://user:pass@localhost']:
            with self.assertRaises(ValueError):
                Synthesis(upstream, 'af_bella')
        for payload in [{'text':'x'*801,'voice':'af_bella'}, {'text':'hi','voice':'other'},
                        {'text':'hi','voice':'af_bella','speed':10}, {'text':' ','voice':'af_bella'}]:
            with self.assertRaises(SpeechError) as caught:
                self.engine.run(payload)
            self.assertEqual(caught.exception.status, 400)

    def test_valid_wav_and_malformed_audio(self):
        validate_wav(wav())
        for audio in [b'not wav', wav()[:-10], b'\0'*2_200_001]:
            with self.assertRaises(SpeechError):
                validate_wav(audio)

    def test_success_is_local_fixed_speed_and_validated(self):
        with patch('synthesis.urllib.request.urlopen', return_value=io.BytesIO(wav())) as upstream:
            self.assertEqual(self.engine.run({'text':'Hello fixture.','voice':'af_bella'}), wav())
            args, kwargs = upstream.call_args
            self.assertEqual(args[0].full_url, 'http://127.0.0.1:8880/v1/audio/speech')
            self.assertEqual(json.loads(args[0].data)['speed'], 1.0)
            self.assertEqual(kwargs['timeout'], 10)

    def test_abandoned_or_stalled_work_cannot_spawn_a_backlog(self):
        entered, release = threading.Event(), threading.Event()
        def upstream(*_args, **_kwargs):
            entered.set()
            release.wait(2)
            return io.BytesIO(wav())
        with patch('synthesis.urllib.request.urlopen', side_effect=upstream):
            worker = threading.Thread(target=lambda:self.engine.run({'text':'hello','voice':'af_bella'}))
            worker.start()
            self.assertTrue(entered.wait(1))
            try:
                with self.assertRaises(SpeechError) as caught:
                    self.engine.run({'text':'another','voice':'af_bella'})
                self.assertEqual(caught.exception.status, 429)
            finally:
                release.set()
                worker.join(2)
        with patch('synthesis.urllib.request.urlopen', side_effect=TimeoutError()):
            with self.assertRaises(SpeechError):
                self.engine.run({'text':'hello','voice':'af_bella'})
        with patch('synthesis.urllib.request.urlopen') as upstream:
            with self.assertRaises(SpeechError) as caught:
                self.engine.run({'text':'hello','voice':'af_bella'})
            self.assertEqual(caught.exception.code, 'recovery_required')
            upstream.assert_not_called()

    def test_authenticated_bounded_route_and_feature_off(self):
        previous = server.SYNTHESIS, server.SECRET
        server.SYNTHESIS, server.SECRET = self.engine, 'fixture-secret'
        httpd = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        def request(body, **headers):
            connection = http.client.HTTPConnection('127.0.0.1', httpd.server_port, timeout=2)
            try:
                connection.request('POST', '/synthesize', body, {'Authorization':'Bearer fixture-secret',
                    'Content-Type':'application/json', **headers})
                response=connection.getresponse()
                return response.status, response.read()
            finally:
                connection.close()
        try:
            body=json.dumps({'text':'Hello fixture.','voice':'af_bella'}).encode()
            self.assertEqual(request(body, Authorization='Bearer wrong')[0], 401)
            self.assertEqual(request(b'x'*6001)[0], 400)
            self.assertEqual(request(b'not json')[0], 400)
            with patch('synthesis.urllib.request.urlopen', return_value=io.BytesIO(wav())):
                self.assertEqual(request(body), (200, wav()))
            server.SYNTHESIS=None
            self.assertEqual(request(body)[0], 404)
        finally:
            httpd.shutdown()
            httpd.server_close()
            server.SYNTHESIS, server.SECRET = previous


if __name__ == '__main__':
    unittest.main()
