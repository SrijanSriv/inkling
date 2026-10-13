"""Bounded local Kokoro proxy. No synthesis queue, text logging or audio files."""
import io
import json
import threading
import urllib.error
import urllib.request
import wave
from urllib.parse import urlsplit

MAX_AUDIO = 2_200_000


class SpeechError(Exception):
    def __init__(self, status, code):
        self.status, self.code = status, code


def validate_wav(raw):
    if not 44 <= len(raw) <= MAX_AUDIO:
        raise SpeechError(422, 'invalid_audio')
    try:
        with wave.open(io.BytesIO(raw), 'rb') as audio:
            frames = audio.getnframes()
            if (audio.getframerate(), audio.getnchannels(), audio.getsampwidth(), audio.getcomptype()) != (24000, 1, 2, 'NONE'):
                raise ValueError()
            if not 0 < frames <= 24000 * 45 or len(audio.readframes(frames)) != frames * 2:
                raise ValueError()
    except (wave.Error, EOFError, ValueError):
        raise SpeechError(422, 'invalid_audio')


class Synthesis:
    def __init__(self, upstream, voice):
        url = urlsplit(upstream)
        if (url.scheme != 'http' or url.hostname not in ('127.0.0.1', '::1', 'localhost')
                or url.username or url.password or url.path not in ('', '/') or url.query or url.fragment
                or voice not in ('af_bella', 'af_nicole', 'am_eric', 'hf_alpha')):
            raise ValueError('Configure a loopback Kokoro upstream and supported voice.')
        self.upstream, self.voice = upstream.rstrip('/'), voice
        self.lock = threading.Lock()
        self.faulted = False

    def run(self, payload):
        if (not isinstance(payload, dict) or set(payload) != {'text', 'voice'}
                or payload.get('voice') != self.voice or not isinstance(payload.get('text'), str)
                or not payload['text'].strip() or len(payload['text']) > 800):
            raise SpeechError(400, 'invalid_request')
        if not self.lock.acquire(blocking=False):
            raise SpeechError(429, 'busy')
        try:
            if self.faulted:
                raise SpeechError(503, 'recovery_required')
            body = json.dumps({'input': payload['text'], 'voice': self.voice,
                               'speed': 1.0, 'response_format': 'wav'}).encode()
            request = urllib.request.Request(self.upstream + '/v1/audio/speech', body,
                                             {'Content-Type': 'application/json'})
            try:
                with urllib.request.urlopen(request, timeout=10) as response:
                    raw = response.read(MAX_AUDIO + 1)
            except urllib.error.HTTPError:
                raise SpeechError(503, 'upstream_rejected')
            except Exception:
                # A disconnected client does not prove inference stopped. Require an operator restart
                # after checking Kokoro, rather than stacking more work behind an unknown request.
                self.faulted = True
                raise SpeechError(503, 'recovery_required')
            validate_wav(raw)
            return raw
        finally:
            self.lock.release()
