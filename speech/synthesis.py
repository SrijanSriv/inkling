"""Bounded local Kokoro proxy. No synthesis queue, text logging or audio files."""
import io
import json
import re
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

    def stream(self, payload, phrases=True):
        if (not isinstance(payload, dict) or set(payload) != {'text', 'voice'}
                or payload.get('voice') != self.voice or not isinstance(payload.get('text'), str)
                or not payload['text'].strip() or len(payload['text']) > 800):
            raise SpeechError(400, 'invalid_request')
        if not self.lock.acquire(blocking=False):
            raise SpeechError(429, 'busy')
        try:
            if self.faulted:
                raise SpeechError(503, 'recovery_required')
            total = 0
            total_seconds = 0
            for text in speech_chunks(payload['text']) if phrases else [payload['text']]:
                raw = self.audio(text)
                total += len(raw)
                if total > MAX_AUDIO:
                    raise SpeechError(422, 'invalid_audio')
                with wave.open(io.BytesIO(raw), 'rb') as audio:
                    # Header overhead is excluded from the aggregate duration cap below.
                    seconds = audio.getnframes() / 24000
                total_seconds += seconds
                if total_seconds > 45:
                    raise SpeechError(422, 'invalid_audio')
                yield raw
        finally:
            self.lock.release()

    def run(self, payload):
        return next_and_close(self.stream(payload, phrases=False))

    def audio(self, text):
        body = json.dumps({'input': text, 'voice': self.voice,
                           'speed': 1.0, 'response_format': 'wav'}).encode()
        request = urllib.request.Request(self.upstream + '/v1/audio/speech', body,
                                         {'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                raw = response.read(MAX_AUDIO + 1)
        except urllib.error.HTTPError:
            raise SpeechError(503, 'upstream_rejected')
        except Exception:
            # Disconnect does not prove CPU work stopped. Preserve the existing recovery latch.
            self.faulted = True
            raise SpeechError(503, 'recovery_required')
        validate_wav(raw)
        return raw


def next_and_close(iterator):
    try:
        return next(iterator)
    finally:
        iterator.close()


def speech_chunks(text):
    """Small opening clause, larger remainder chunks; never invent punctuation or cut at a word count."""
    boundaries = []
    for match in re.finditer(r'[,.!?;:।][\"\')]*\s+', text):
        end = match.end()
        before, after = text[:match.start()], text[end:]
        token = before.split()[-1] if before.split() else ''
        if text[match.start()] == '.' and (token.lower() in ('mr','mrs','ms','dr','prof','sr','jr','st','vs','etc','e.g','i.e','jan','feb','mar','apr','jun','jul','aug','sep','sept','oct','nov','dec')
                or re.fullmatch(r'(?:[A-Za-z]\.)*[A-Za-z]', token)):
            continue
        if text[match.start()] in ',:' and before[-1:].isdigit() and after[:1].isdigit():
            continue
        boundaries.append(end)
    chunks, start = [], 0
    while start < len(text):
        target, minimum, maximum = (10, 8, 18) if not chunks else (26, 14, 40)
        candidates = [(abs(len(text[start:end].split())-target), end) for end in boundaries
                      if end > start and minimum <= len(text[start:end].split()) <= maximum]
        if not candidates or len(chunks) >= 7:
            chunks.append(text[start:])
            break
        end = min(candidates)[1]
        # Avoid leaving a tiny final fragment, which sounds worse and adds a synthesis call.
        if len(text[end:].split()) < 8:
            chunks.append(text[start:])
            break
        chunks.append(text[start:end])
        start = end
    return chunks
