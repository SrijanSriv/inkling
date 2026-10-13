"""Private audio decoder in front of an existing whisper.cpp server. No transcript logging."""
import array
import hmac
import io
import json
import math
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BYTES = 12 * 1024 * 1024
MAX_SECONDS = 120
LOCK = threading.Lock()
UPSTREAM = os.environ.get('INKLING_WHISPER_UPSTREAM', 'http://127.0.0.1:8081').rstrip('/')
MODEL = os.environ.get('INKLING_WHISPER_MODEL', '')
SECRET = os.environ.get('INKLING_WHISPER_SECRET', '')
LANGUAGE = os.environ.get('INKLING_WHISPER_LANGUAGE', 'auto')
MIC_UPSTREAM = os.environ.get('INKLING_WHISPER_MIC_UPSTREAM', '').rstrip('/')
MIC_LANGUAGE = os.environ.get('INKLING_WHISPER_MIC_LANGUAGE', 'hi')
UNIT = os.environ.get('INKLING_WHISPER_UNIT', 'whisper-server.service')
loaded_pid = None
unavailable_until = 0


class Rejected(Exception):
    def __init__(self, status):
        self.status = status


def multipart(fields, filename=None, sound=None):
    boundary = uuid.uuid4().hex
    parts = []
    for key, value in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
    if sound is not None:
        parts.extend([f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\nContent-Type: audio/wav\r\n\r\n'.encode(), sound, b'\r\n'])
    parts.append(f'--{boundary}--\r\n'.encode())
    return b''.join(parts), f'multipart/form-data; boundary={boundary}'


def whisper(route, fields, sound=None, upstream=None):
    body, content_type = multipart(fields, 'audio.wav', sound)
    request = urllib.request.Request((upstream or UPSTREAM)+route, body, {'Content-Type': content_type})
    with urllib.request.urlopen(request, timeout=180) as response:
        raw = response.read(256_001)
    if len(raw) > 256_000:
        raise Rejected(422)
    if route == '/load':
        return {'loaded': True}  # Existing whisper.cpp versions return a plain-text success here.
    return json.loads(raw)


def ensure_model():
    global loaded_pid
    # Reload after an upstream restart, not for every recording. This also works before its system-unit override.
    result = subprocess.run(['systemctl', 'show', UNIT, '-p', 'MainPID', '--value'], capture_output=True, text=True, timeout=5)
    pid = result.stdout.strip()
    if not pid or pid == '0':
        raise Rejected(503)
    if pid != loaded_pid:
        whisper('/load', {'model': MODEL})
        loaded_pid = pid


def decoded(sound):
    executable = os.environ.get('INKLING_FFMPEG_PATH')
    if not executable:
        from imageio_ffmpeg import get_ffmpeg_exe
        executable = get_ffmpeg_exe()
    # tmpfs is outside backups and does not leave raw recordings on disk after a crash/reboot.
    with tempfile.TemporaryDirectory(prefix='inkling-speech-', dir=os.environ.get('INKLING_WHISPER_TMP', '/dev/shm')) as folder:
        os.chmod(folder, 0o700)
        source, target = Path(folder)/'input.bin', Path(folder)/'audio.wav'
        source.write_bytes(sound)
        command = [executable, '-nostdin', '-hide_banner', '-loglevel', 'error',
                   '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'ogg,mp3,wav,mov,aac,flac,matroska,webm',
                   '-i', str(source), '-t', str(MAX_SECONDS+1), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', str(target)]
        result = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=25)
        if result.returncode:
            raise Rejected(422)
        with wave.open(str(target), 'rb') as audio:
            duration = audio.getnframes()/audio.getframerate()
            samples = array.array('h', audio.readframes(audio.getnframes()))
        if duration > MAX_SECONDS:
            raise Rejected(413)
        if duration < 0.2 or not samples or math.sqrt(sum(x*x for x in samples)/len(samples)) < 25:
            raise Rejected(422)
        return target.read_bytes()


def transcript(result):
    text = result.get('text', '').strip()
    segments = result.get('segments', [])
    if not text and segments:
        text = ' '.join(s.get('text', '').strip() for s in segments).strip()
    if not text or len(text) > 16_000:
        raise Rejected(422)
    # Decoder scores are warning signals, not calibrated guarantees of accuracy.
    if segments and any(s.get('no_speech_prob', 0) > 0.8 or s.get('avg_logprob', 0) < -1.2 for s in segments):
        raise Rejected(422)
    words = text.lower().split()
    if len(words) > 24 and len(set(words))/len(words) < 0.18:
        raise Rejected(422)
    return {'text': text, 'language': result.get('language'), 'engine': 'whisper.cpp'}


def microphone_wav(sound):
    try:
        with wave.open(io.BytesIO(sound), 'rb') as audio:
            if (audio.getframerate(), audio.getnchannels(), audio.getsampwidth()) != (16000, 1, 2):
                raise Rejected(422)
            if not .3 <= audio.getnframes()/16000 <= 20:
                raise Rejected(413)
            raw = audio.readframes(audio.getnframes())
            if len(raw) != audio.getnframes()*2:
                raise Rejected(422)
        samples = array.array('h', raw)
        mean = sum(samples)/len(samples)
        energy = sum(x*x for x in samples)/len(samples)
        if math.sqrt(energy) < 25 or energy-mean*mean < 1 or sum(abs(x) >= 32700 for x in samples)/len(samples) > .01:
            raise Rejected(422)
    except (wave.Error, EOFError):
        raise Rejected(422)


def check_tail(result, wav):
    segments = result.get('segments', [])
    ends = [s['end'] for s in segments if isinstance(s.get('end'), (int, float))]
    if not ends:
        return
    with wave.open(io.BytesIO(wav), 'rb') as audio:
        duration = audio.getnframes()/audio.getframerate()
        end = max(ends)
        if duration-end <= 1.5:
            return
        audio.setpos(min(audio.getnframes(), int((end+0.25)*audio.getframerate())))
        samples = array.array('h', audio.readframes(audio.getnframes()-audio.tell()))
    # A fluent partial transcript can omit a language switch. Never treat an audible omitted ending as complete.
    if samples and math.sqrt(sum(x*x for x in samples)/len(samples)) > 100:
        raise Rejected(422)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def answer(self, status, body):
        raw = json.dumps(body, ensure_ascii=False).encode()
        try:
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def authorized(self):
        return bool(SECRET) and hmac.compare_digest(self.headers.get('Authorization', '').encode(), ('Bearer '+SECRET).encode())

    def do_GET(self):
        if not self.authorized():
            return self.answer(401, {'error': 'unauthorized'})
        if self.path != '/health':
            return self.answer(404, {'error': 'not_found'})
        try:
            with urllib.request.urlopen(UPSTREAM+'/health', timeout=2) as response:
                ready = response.status == 200 and Path(MODEL).is_file()
        except Exception:
            ready = False
        return self.answer(200 if ready else 503, {'ready': ready, 'engine': 'whisper.cpp'})

    def do_POST(self):
        global unavailable_until
        if not self.authorized():
            return self.answer(401, {'error': 'unauthorized'})
        mic = self.path == '/microphone' and bool(MIC_UPSTREAM)
        if self.path != '/transcribe' and not mic:
            return self.answer(404, {'error': 'not_found'})
        if self.headers.get('Content-Type') != 'application/octet-stream':
            return self.answer(415, {'error': 'unsupported_type'})
        try:
            size = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            size = 0
        if size <= 0 or size > MAX_BYTES or (mic and size > 644096):
            return self.answer(413, {'error': 'size_limit'})
        if time.monotonic() < unavailable_until or not LOCK.acquire(blocking=False):
            return self.answer(429, {'error': 'busy'})
        try:
            self.connection.settimeout(20)
            sound = self.rfile.read(size)
            if len(sound) != size:
                raise Rejected(422)
            if mic:
                from quality import coverage_warning
                microphone_wav(sound)
                started = time.monotonic()
                result = whisper('/inference', {'language': MIC_LANGUAGE, 'translate': 'false', 'no_context': 'true',
                    'max_context': '0', 'response_format': 'verbose_json', 'temperature': '0',
                    'prompt': os.environ.get('INKLING_WHISPER_HINT', 'English and Hindi conversation.')}, sound, MIC_UPSTREAM)
                answer = transcript(result)
                # The server emits seconds; the diagnostic CLI emits millisecond offsets.
                coverage = {'transcription': [{'text': s.get('text', ''), 'offsets':
                    {'from': s.get('start', -1)*1000, 'to': s.get('end', -1)*1000}}
                    for s in result.get('segments', [])]}
                if warning := coverage_warning(coverage, sound, answer['text']):
                    answer['warning'] = warning
                answer['seconds'] = round(time.monotonic()-started, 3)
                self.answer(200, answer)
                print('Microphone transcription completed.', flush=True)
                return
            wav = decoded(sound)
            ensure_model()
            result = whisper('/inference', {'language': LANGUAGE, 'translate': 'false', 'no_context': 'true',
                'max_context': '0', 'response_format': 'verbose_json', 'temperature': '0',
                'prompt': os.environ.get('INKLING_WHISPER_HINT', 'English and Hindi conversation, with occasional technical terms.')}, wav)
            check_tail(result, wav)
            self.answer(200, transcript(result))
            print('Transcription completed.', flush=True)
        except Rejected as error:
            self.answer(error.status, {'error': 'audio_rejected'})
        except Exception:
            # No raw errors, filenames, audio, model output or user identifiers reach journald.
            unavailable_until = time.monotonic()+60
            self.answer(503, {'error': 'unavailable'})
            print('Transcription unavailable.', flush=True)
        finally:
            LOCK.release()


if __name__ == '__main__':
    os.umask(0o077)
    if LANGUAGE not in ('auto', 'en', 'hi'):
        raise SystemExit('Configure language as auto, en or hi.')
    if MIC_LANGUAGE not in ('auto', 'en', 'hi'):
        raise SystemExit('Configure microphone language as auto, en or hi.')
    if not SECRET or not Path(MODEL).is_file() or MODEL.endswith('.en.bin'):
        raise SystemExit('Configure a secret and an existing multilingual model.')
    server = ThreadingHTTPServer(('127.0.0.1', int(os.environ.get('INKLING_WHISPER_PORT', '8102'))), Handler)
    server.daemon_threads = True
    print('Private speech gateway ready.', flush=True)
    server.serve_forever()
