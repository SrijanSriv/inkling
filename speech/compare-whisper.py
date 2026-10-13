"""Offline same-recording Whisper comparison. Reads WAV from stdin; never reloads a running server."""
import argparse
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import wave


def comparison_text(result):
    segments = result.get('transcription')
    if not isinstance(segments, list) or not segments:
        raise ValueError('No transcription segments returned')
    if any(not isinstance(segment, dict) or not isinstance(segment.get('text'), str) for segment in segments):
        raise ValueError('Invalid transcription segments')
    text = ' '.join(' '.join(segment['text'] for segment in segments).split())
    if not text or len(text) > 16000:
        raise ValueError('Empty or oversized transcription')
    return text


def compare(sound, executable, models, language='en', prompt='', temp_root='/dev/shm'):
    if len(sound) > 644096:
        raise ValueError('Recording exceeds the diagnostic size limit')
    with wave.open(io.BytesIO(sound), 'rb') as audio:
        if (audio.getframerate(), audio.getnchannels(), audio.getsampwidth()) != (16000, 1, 2):
            raise ValueError('Use 16 kHz mono signed 16-bit WAV')
        seconds = audio.getnframes() / audio.getframerate()
        if not .3 <= seconds <= 20:
            raise ValueError('Use a recording between 0.3 and 20 seconds')
        if len(audio.readframes(audio.getnframes())) != audio.getnframes() * 2:
            raise ValueError('The recording is incomplete')
    results = []
    with tempfile.TemporaryDirectory(prefix='inkling-compare-', dir=temp_root) as folder:
        os.chmod(folder, 0o700)
        source, output = Path(folder)/'input.wav', Path(folder)/'result'
        source.write_bytes(sound)
        for label, model in models:
            started = time.monotonic()
            command = ['nice', '-n', '10', executable, '-m', model, '-f', str(source), '-l', language,
                       '-t', '2', '-bs', '5', '-oj', '-of', str(output)]
            if prompt:
                command.extend(['--prompt', prompt])
            try:
                subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=90, check=True)
                raw = output.with_suffix('.json').read_bytes()
                if len(raw) > 1000000:
                    raise ValueError('Oversized diagnostic output')
                text = comparison_text(json.loads(raw))
                results.append({'model': label, 'text': text, 'seconds': round(time.monotonic()-started, 3)})
            except (OSError, ValueError, subprocess.SubprocessError):
                results.append({'model': label, 'error': 'Comparison failed; no result to assess'})
            finally:
                output.with_suffix('.json').unlink(missing_ok=True)
    return {'audioSeconds': seconds, 'language': language, 'results': results,
            'accuracy': 'Compare with intended words; not automatically scored', 'serverChanged': False, 'audioArchived': False}


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cli', required=True)
    parser.add_argument('--model', action='append', required=True, help='Label=/absolute/model/path; repeat for each candidate')
    parser.add_argument('--language', choices=['en', 'auto', 'hi'], default='en')
    parser.add_argument('--prompt', default='', help='Same neutral vocabulary hint for every candidate; never the expected answer')
    args = parser.parse_args()
    try:
        models = [tuple(item.split('=', 1)) for item in args.model]
        if not 2 <= len(models) <= 3 or any(len(item) != 2 or not Path(item[1]).is_file() for item in models):
            raise ValueError('Supply two or three existing model paths')
        print(json.dumps(compare(sys.stdin.buffer.read(644097), args.cli, models, args.language, args.prompt,
                                 os.environ.get('INKLING_WHISPER_TMP', '/dev/shm')), ensure_ascii=False))
    except (OSError, ValueError, wave.Error, EOFError):
        print(json.dumps({'error': 'Diagnostic failed. Check WAV format, duration, RAM temporary directory and configured model paths.'}))
        sys.exit(2)
