# Natural phrase output: measured follow-up to room speech v1

2026-10-14. The physical unmute/mute input flow, voice, assistant model, final answer checks and private
WhatsApp text remain unchanged. The optimisation is in local speech output only.

## Evidence

Seven initial live room replies started their playback process 5.4-8.1 seconds after inferred mute, with
a median of 5.7 seconds. Full-WAV generation added 1.2-4.3 seconds. Speaker/music setup outside synthesis
added about 0.07-0.11 seconds, so caching or removing those checks offered little gain.

A synthetic 36-word reply was generated twice through the already-running CPU Kokoro service, with the
configured cached voice. No room audio, personal text, recordings or playback were used in the benchmark.

| Input | Synthesis time, two runs | Audio duration |
| --- | --- | --- |
| Complete reply | 4.49 / 4.44 s | 12.68 s |
| First sentence | 1.84 / 1.81 s | 5.33 s |
| Natural opening phrase, nine words | 1.01 / 1.00 s | 2.93 s |
| Four-word fragment | 0.64 / 0.63 s | 1.73 s |

Very short fragments were not selected: repeated inference and degraded prosody are a poor trade for the
extra few tenths. Kokoro's own voice guidance notes weaknesses in short utterances, especially below 10-20
tokens. Words and those tokens are not equivalent; the chunk sizes here are an empirical starting point,
not a universal model optimum. Voice naturalness still needs listening feedback.

## Decision

Use natural punctuation boundaries for a short opening phrase, then larger chunks to keep synthesis ahead
of playback. Do not insert pauses, split at arbitrary word positions, change speech speed or rewrite the answer.
Preserve abbreviations and numeric punctuation. Leave unsuitable/short answers as one chunk.

Retain complete-WAV output behind the existing route. The optional `INKLING_MIC_SPEECH_STREAMING` flag
selects framed WAV chunks through the same authenticated private tunnel. Each chunk is validated before
its PCM reaches one continuous player. Keep the eight-chunk, 800-code-point, 2.2 MB, 45-second limits,
12-second client wait and fail-closed upstream recovery behaviour. No second model/server is introduced.

An authenticated laptop-gateway benchmark of that same complete reply returned:

| Chunk | Ready after request | Audio duration | Estimated playback starvation |
| --- | --- | --- | --- |
| Opening phrase | 1.03 s | 2.93 s | 0 s |
| Larger middle | 3.32 s | 6.63 s | 0 s |
| Remainder | 4.69 s | 3.95 s | 0 s |

For this sample, first audio became available about 3.4 seconds sooner while total synthesis grew by about
0.2 seconds. The starvation estimate assumes playback starts with the first chunk; it is not a listening
or Bluetooth measurement. Short one-chunk replies have little or no expected improvement. CPU contention
or other text can still create gaps; do not promise these savings for every conversation.

## Verification and limits

Tests cover exact text preservation, punctuation/abbreviation safeguards, one synthesis lock through the
utterance, cancel release, authenticated framing, split network packets, missing success marker, oversized
or trailing frames, one player process for multiple chunks and suppression after a newer recording.

The stream may have spoken part of an answer before a later failure. Stop promptly, keep the full WhatsApp
text and never automatically replay it. Model tokens remain unspoken until the normal final answer has
passed checks. Cancellation stops audio, not actions already performed by tools.

## Sources

- [Kokoro voice limitations](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md)
- [Kokoro pipeline](https://github.com/hexgrad/kokoro/blob/main/kokoro/pipeline.py)
- [Streaming playback example](https://github.com/remsky/Kokoro-FastAPI/blob/master/examples/stream_tts_playback.py)
