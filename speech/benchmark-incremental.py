"""Content-free real recognizer timings on an explicitly supplied recording. Never sends assistant messages."""
import argparse
import hashlib
import io
import json
import math
import statistics
import subprocess
import time
import urllib.parse
import wave
from server import whisper


def wav(pcm, rate=16000):
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(rate)
        audio.writeframes(pcm)
    return buffer.getvalue()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('audio', help='Explicitly authorised or public 16 kHz mono PCM WAV')
    parser.add_argument('--stream-replay', action='store_true', help='Replay the original clip at real speed through bounded sessions, never assistant actions')
    parser.add_argument('--backend', choices=['whisper.cpp','faster-whisper'], default='whisper.cpp')
    parser.add_argument('--model', help='Explicit local CTranslate2 checkpoint directory for isolated backend comparison')
    parser.add_argument('--upstream', help='Local warm diagnostic recognizer URL')
    parser.add_argument('--language', default='hi', choices=['hi', 'en', 'auto'])
    parser.add_argument('--audio-context', choices=['default','bounded'], default='default', help='Experimental: size encoder window to audio plus 2 seconds; not a production setting')
    parser.add_argument('--repeat', type=int, default=2)
    parser.add_argument('--lengths', default='2,4,8,12,20')
    args = parser.parse_args()
    if args.backend == 'whisper.cpp' and not args.upstream:
        parser.error('An explicit loopback recognizer URL is required.')
    address = urllib.parse.urlsplit(args.upstream or 'http://127.0.0.1')
    if address.scheme != 'http' or address.hostname not in ('127.0.0.1', 'localhost') or address.username or address.password:
        parser.error('Diagnostics require an explicit loopback recognizer.')
    if not 1 <= args.repeat <= 5:
        parser.error('Repeat count must be 1–5.')
    with wave.open(args.audio, 'rb') as audio:
        if (audio.getframerate(), audio.getnchannels(), audio.getsampwidth()) != (16000, 1, 2):
            parser.error('Use a 16 kHz mono PCM recording.')
        pcm = audio.readframes(audio.getnframes())
    if not pcm or len(pcm) > 640000:
        parser.error('Use a nonempty recording no longer than 20 seconds.')
    lengths = [float(value) for value in args.lengths.split(',')]
    if any(not .3 <= seconds <= 20 for seconds in lengths):
        parser.error('Lengths must be 0.3–20 seconds.')
    fields = {'language': args.language, 'translate': 'false', 'no_context': 'true', 'max_context': '0',
              'response_format': 'verbose_json', 'temperature': '0', 'prompt': 'English and Hindi conversation.'}
    # Longer probes repeat this public/authorised source. They are throughput tests, not accuracy examples.
    extended = (pcm * (640000 // len(pcm) + 1))[:640000]
    decode = lambda params, sound: whisper('/inference', params, sound, args.upstream)
    if args.backend == 'faster-whisper':
        if not args.model or args.audio_context != 'default':
            parser.error('A local model and default audio context are required for faster-whisper.')
        import numpy as np
        from faster_whisper import WhisperModel
        model = WhisperModel(args.model, device='cuda', compute_type='int8_float32', cpu_threads=2, num_workers=1, local_files_only=True)

        def decode(params, sound):
            with wave.open(io.BytesIO(sound),'rb') as audio:
                samples=np.frombuffer(audio.readframes(audio.getnframes()),dtype=np.int16).astype(np.float32)/32768
            segments, info = model.transcribe(samples, language=None if args.language=='auto' else args.language,
                task='transcribe', beam_size=5, temperature=0, condition_on_previous_text=False,
                initial_prompt='English and Hindi conversation.', word_timestamps=True, vad_filter=False)
            segments=list(segments)
            return {'text':' '.join(segment.text.strip() for segment in segments),'segments':[
                {'text':segment.text,'start':segment.start,'end':segment.end,'words':[
                    {'word':word.word,'start':word.start,'end':word.end} for word in segment.words or []]}
                for segment in segments]}
        decode(fields,wav(extended[:64000]))  # warm kernels; excluded and disclosed
    timings = {seconds: [] for seconds in lengths}
    for trial in range(args.repeat):
        order = lengths if trial % 2 == 0 else list(reversed(lengths))
        for seconds in order:
            started = time.monotonic()
            params = dict(fields)
            if args.audio_context == 'bounded':
                params['audio_ctx'] = str(min(1500,max(256,math.ceil((seconds+2)*50/32)*32)))
            result = decode(params, wav(extended[:int(seconds*32000)]))
            elapsed = time.monotonic()-started
            timings[seconds].append(elapsed)
            segments = result.get('segments', [])
            words = [word for segment in segments for word in segment.get('words', [])]
            print(json.dumps({'backend': args.backend, 'audioContext': params.get('audio_ctx', 'default'), 'trial': trial+1, 'audioSeconds': seconds, 'decodeSeconds': round(elapsed, 3),
                              'repeatedSource': seconds > len(pcm)/32000, 'segments': len(segments),
                              'wordCount': len(words), 'wordFields': sorted(words[0]) if words else [],
                              'textHash': hashlib.sha256(result.get('text', '').encode()).hexdigest()[:12]}), flush=True)
    if args.stream_replay:
        from incremental import Sessions
        from server import validate_microphone
        native = []
        original_decode = decode

        def stream_decode(raw):
            start = time.monotonic()
            result = original_decode(fields,wav(raw))
            native.append(round(time.monotonic()-start,3))
            return result

        sessions = Sessions(stream_decode,lambda result,raw:validate_microphone(result,wav(raw)))
        started = time.monotonic()
        ident = sessions.create()['id']
        drafts = set()
        try:
            for offset in range(0,len(pcm),16000):
                packet = pcm[offset:offset+16000]
                time.sleep(max(0,started+(offset+len(packet))/32000-time.monotonic()))
                snapshot = sessions.append(ident,offset,packet)
                if snapshot.get('draft'):
                    drafts.add(snapshot['draft'])
            released = time.monotonic()
            sessions.finish(ident,len(pcm))
            while time.monotonic()-released<60:
                snapshot = sessions.status(ident)
                if snapshot['state'] in ('done','failed','expired'):
                    break
                time.sleep(.05)
            print(json.dumps({'streamReplay':True,'audioSeconds':len(pcm)/32000,'state':snapshot['state'],
                'releaseToFinalSeconds':round(time.monotonic()-released,3),'distinctDrafts':len(drafts),
                'nativeDecodeSeconds':native,'coverageWarning':bool((snapshot.get('result') or {}).get('warning'))}),flush=True)
        finally:
            sessions.close()
    if args.backend == 'faster-whisper':
        memory = subprocess.run(['nvidia-smi','--query-gpu=memory.used','--format=csv,noheader,nounits'],capture_output=True,text=True)
        print(json.dumps({'observedGpuMemoryMiB':memory.stdout.strip()}),flush=True)
    print(json.dumps({'summary': [{'audioSeconds': seconds, 'medianDecodeSeconds': round(statistics.median(values),3),
                                 'worstDecodeSeconds': round(max(values),3), 'n':len(values)}
                                for seconds, values in timings.items()]}), flush=True)


if __name__ == '__main__':
    main()
