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

## Follow-up: CPU tuning and complete-sentence boundaries

The same cached CPU model/voice was benchmarked in one offline candidate process at 6, 4, 2, 1, 3 and then
6 threads again. Each setting received a warm-up and two runs of a nine-word phrase, an 18-word sentence
and the same 36-word reply above. No live model parameters were changed during this comparison.

| CPU threads | Nine-word phrase | Sentence | Complete reply |
| --- | --- | --- | --- |
| 6, initial baseline | 0.92-0.96 s | 1.89-1.90 s | 4.31-4.39 s |
| 4 | 0.83-0.87 s | 1.68-1.69 s | 3.84-3.99 s |
| 2 | 1.29-1.32 s | 2.59-2.60 s | 6.23-6.54 s |
| 1 | 2.21-2.23 s | 4.36-4.39 s | 10.75-10.78 s |
| 3 | 1.03-1.05 s | 2.06-2.08 s | 4.99-5.06 s |
| 6, repeated baseline | 1.04-1.08 s | 2.04-2.10 s | 4.59-4.71 s |

Four threads beat both six-thread baselines by roughly 10-20%, depending on length and baseline. Timing
drift is visible, so this is not a universal speed claim. The measured CPU has four physical cores and eight
logical threads. Generated audio durations were unchanged across these thread settings. The live user unit
now uses a `KOKORO_THREADS=4` drop-in; the voice/model/speed and GPU recognizers are unchanged. A warmed
HTTP request on the actual restarted service generated the nine-word phrase in 0.90 seconds.

The initial splitter rejected every complete opening sentence below eight or above eighteen words, even
when it had a natural full stop. Its follow-up keeps comma fragments at 8-18 words but allows complete
opening sentences at 6-24 words. The target remains ten and the eight-word minimum final tail is retained.
It still does not cut names or timing expressions at arbitrary word positions or rewrite the text.

A fictional 17-word reply with a six-word opening sentence stayed in one chunk under the previous rule.
On the tuned live service, two runs measured:

| Input | Synthesis time | Audio duration |
| --- | --- | --- |
| Full 17-word reply | 1.88 / 1.84 s | 6.08 s |
| Six-word opening sentence | 0.92 / 0.91 s | 3.23 s |
| Eleven-word remainder | 1.00 / 0.97 s | 3.40 s |

That example makes first audio available roughly 0.9 seconds earlier, with ample synthesis overlap for the
remainder. Some additional pause/prosody differences are possible; listening feedback remains necessary.
Short replies without a suitable boundary still stay whole. These gains cannot be added to predict a fixed
end-to-end improvement for different live questions.

Rollback: remove the Kokoro thread-count drop-in and restart that service to restore its previous default;
the pre-change synthesis source is preserved on the laptop for restoring the older boundary rule. Setting
`INKLING_MIC_SPEECH_STREAMING=false` still restores complete-WAV output independently of CPU tuning.
