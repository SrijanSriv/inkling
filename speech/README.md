# Local voice notes

### Optional waiting acknowledgement

`INKLING_MIC_SPEECH_FILLER=true` on the Pi enables one quiet cached "hmm" one second after a valid physical
recording is sealed by mute. The existing room-speech owner preference must also be enabled. The sound is
generated once when room speech starts, validated as at most 1.5 seconds, kept only in RAM and attenuated
to 45% amplitude. There is no language-model call or per-turn synthesis for the acknowledgement.

No acknowledgement plays if its cache is unavailable, the owner/mute checks fail, music is active or the
speaker is unavailable. Fast replies cancel the timer when their audio is ready. The actual reply aborts
any acknowledgement and waits for its player to close before starting, avoiding two voices at once.
New unmute, source loss, disabling speech or a turn error cancel it too. It is never repeated or sent to
WhatsApp and does not claim understanding or tool success. The real answer and its timing logs are unchanged.
Disable the flag and restart Ellie to remove this waiting cue; it does not accelerate transcription or reasoning.

## Optional room speech output

The gateway also supports `/synthesize` when `INKLING_TTS_UPSTREAM=http://127.0.0.1:8880` and
`INKLING_TTS_VOICE=af_bella` are configured in its protected environment. Install `synthesis.py` beside
`server.py`. Reuse an existing warm Kokoro service; the upstream stays loopback-only. Supported configured
voices are `af_bella`, `af_nicole`, `am_eric`, and `hf_alpha`; cache the selected voice before live use.

The authenticated request is JSON `{ "text": "Hello.", "voice": "af_bella" }`, with at most 800 code points
and one matching configured voice. Successful output is bounded 24 kHz mono PCM16 WAV. No audio files are
created. The gateway allows one request and has no synthesis queue, independently of recognition locks.
If a lost/timed-out upstream request leaves compute completion unknown, further synthesis fails with
`recovery_required`. Check Kokoro has finished/has no stuck request, restart it if needed, then restart the
speech gateway to reset that latch. Do not repeatedly restart the gateway while Kokoro is still stuck.

On the Pi, configure `INKLING_MIC_SPEECH=true`, `INKLING_MIC_SPEECH_SINK` to an exact real PipeWire node name,
and `INKLING_MIC_SPEECH_VOICE` to the same voice. Physical mic-switch and conversation mode must already work.
Then the owner can send `/mic speech on`, `/mic speech off`, or `/mic speech status` privately. The preference
is encrypted and initially off. Only live owner physical-mic turns can speak; recovered turns and other input
sources cannot. WhatsApp text remains independent. Audio is dropped on interruption, absent/muted speakers,
active/unknown music state, oversized/unsupported answers or any speech failure. There are no automatic retries.
The status command and owner mic page explain speech state; logs contain fixed reasons and timings, no content.
English voices skip Devanagari text rather than pretending to speak Hindi. Romanized Hinglish pronunciation
needs a listening trial; no automatic transliteration or extra model rewrite is performed.

See [the v1 plan](../docs/speech-to-speech-v1-plan.md) and [the epic](../docs/speech-to-speech-epic.md).

### Optional phrase output

`INKLING_MIC_SPEECH_STREAMING=true` on the Pi selects the authenticated `/synthesize/stream` route.
The gateway makes a short opening chunk at a natural punctuation boundary, closest to ten words.
Comma/semicolon/colon clauses require 8-18 words; complete sentences can use 6-24 words because they
have their own natural ending. Later chunks target 26 words, bounded by natural breaks at 14-40 words. Tiny tails are merged.
If no suitable boundary exists the text stays together. Wording is preserved, and known abbreviations,
decimal numbers and numeric comma/colon pairs are protected. This is deterministic punctuation splitting,
not a complete language parser; no text is rewritten and no additional model call is made.

The gateway uses the existing warm Kokoro endpoint for each chunk, holding its single-flight lock for the
entire utterance. It forwards validated complete WAV chunks framed as a four-byte big-endian byte length
and that WAV. A zero length ends a successful stream. Missing completion, trailing data, malformed WAV,
more than eight chunks, more than 2.2 MB total or more than 45 seconds of aggregate audio stop playback.
The content type is `application/x-inkling-wav-stream`. Neither route is public.

The Pi strips each WAV header and writes PCM into one `pw-play` stdin, respecting backpressure. The bounded network response is prefetched in RAM independently of the player,
so slow playback does not incorrectly trip the synthesis HTTP deadline. Later
synthesis overlaps current playback; a separate audio device/process is not opened for each phrase.
Unmute cancels playback and the HTTP stream. The gateway finishes at most its current upstream call before
noticing a disconnected client; it does not abandon the single-flight lock or queue replacement work.
Network failures can leave already-spoken partial content, so there is no automatic restart/replay of the answer.
WhatsApp retains the full final text. A busy replacement turn stays text-only rather than accumulating audio.

Logs add `room speech first chunk ready` (`firstChunkMs`) and `room speech stream completed` (`chunks`,
`bytes`, `feedMs`). First-playback timings still start after Ellie's final answer checks. Audio device
buffering and actual audibility are outside those process-start timings. Set the flag false and restart Ellie
to restore full-WAV output; owner controls and the voice remain unchanged.

For CPU Kokoro, benchmark `KOKORO_THREADS` rather than assuming more is faster. In the measured four-core,
eight-thread laptop, four inference threads beat the server's default six; one, two and three were slower.
`kokoro-threads.service.example` is an optional user-unit drop-in for that measured setting. It changes only
the thread count, not the voice, playback speed or recognition worker. Remove the drop-in and restart Kokoro
to restore its previous default. Warm the configured cached voice with synthetic text after restarting.

For controlled microphone diagnosis, `compare-whisper.py` reads one 0.3-20-second, 16 kHz mono PCM WAV from stdin
and runs two or three explicitly configured local Whisper models on that exact recording. It uses independent CLI
processes with two CPU threads and lower scheduling priority; it never reloads the live server. Supply `--cli`,
repeat `--model Label=/absolute/model/path`, and choose `--language en`, `auto` or `hi`. An optional neutral `--prompt`
is identical for all candidates and must not contain the expected test sentence. All working files are removed from
protected RAM-backed temporary storage afterward. Results go only to stdout for the operator; do not redirect real
transcripts into logs or a repository. Compare outputs against what was actually said; a fluent output is not a
quality score. Run English and natural Hindi/English trials before replacing the operational model.
Use `--model-language Label=auto` (or `en`/`hi`) when candidates need different language settings. In particular,
the tested Swift fine-tune uses `en`, while a general multilingual model should also be evaluated with `auto` for
mixed Hindi/English speech. Forcing every model to `en` does not establish its best code-switching performance.
Keep `quality.py` beside this worker. It adds conservative coverage warnings; audio activity is not proof of speech,
and decoder timestamps can cover audio whose words were omitted. `--model-cpu Label` keeps a reference on CPU when
the supplied CLI also supports CUDA. Warnings preserve the original candidate text rather than rewriting it.

Optional microphone review uses `INKLING_MIC_REVIEW_MODEL` and `INKLING_MIC_REVIEW_REFERENCE`, exact labels from
the comparison worker. This only affects manual Pi mic captures, not WhatsApp voice notes. The selected primary
provides a draft transcript, while reference errors, coverage warnings and reminder/negation disagreement prompt
review. Any detected time or reminder wording requires typed timing clarification even when both models agree.
These are conservative checks, not a completeness guarantee or a semantic parser. Unrecognized wording may evade
them, so microphone output stays transcript-only and never enters the agent or confirms a pending draft.

### Manual microphone conversations (optional)

`INKLING_MIC_CONVERSATION=true` replaces the diagnostic double decode with one authenticated `/microphone` request
through the existing speech gateway. Set `INKLING_WHISPER_MIC_UPSTREAM` on the laptop gateway to a separate warm
Whisper server on loopback, and `INKLING_WHISPER_MIC_LANGUAGE=hi` (or explicitly choose `auto`/`en`). The existing
`/transcribe` service/model for WhatsApp voice notes is unchanged. The new route is off without its upstream.
Use `microphone-whisper.service.example` as a user-service template and a mode-600 environment file containing
`WHISPER_SERVER`, `WHISPER_MODEL`, and `WHISPER_PORT`; these are absolute binary/model paths and an unused loopback
port. Build the GPU binary separately, install `quality.py` alongside the gateway, enable the unit, and verify
authenticated public-sample decoding before enabling conversation mode on the Pi. Upstream output is discarded
because some Whisper versions print recognized words. No public binding or new public route is needed.

Manual mic transcripts carry a source marker through the encrypted pending queue into the owner's normal private
chat. They never mix with typed batches or run slash commands. The model receives normal history plus recognition
warnings, interprets ordinary phonetic errors, and asks targeted questions where uncertainty changes an action.
There is no blanket typed-time requirement in this mode. Coverage warnings remove all tools for that turn; they
are conservative activity checks, not a proof of recognition accuracy. A fluent but wrong number can still evade
them. Outgoing confirmations and access/admin changes are blocked in code, including the plain-yes fast path.
Mic transcripts are excluded from recent typed words used to authorize privileged changes. Raw audio remains
transient; intentional conversation transcripts use the usual encrypted history. Wake detection is still off.

The Pi logs only transcription, queue, agent and total reply durations for this path, without recording content.
Total starts at Done and ends after the text reply is delivered; it includes model/tool work and WhatsApp delivery.

`INKLING_MIC_EFFORT=low` optionally tunes the main model on mic turns, including subsequent tool-loop steps.
For compatible Responses endpoints this explicitly forwards only `reasoning.effort`; configure it only after
verifying support. Other compatible requests remain plain, and typed turns retain their normal settings.
Mic turns skip the separate emoji-triage model call because there is no incoming WhatsApp bubble to react to.
The owner/private source checks and outgoing approval restrictions do not depend on model effort.

The Pi checks sender access, downloads bounded audio and sends it through an SSH tunnel to `server.py` on a laptop.
The gateway decodes with FFmpeg and calls an **existing** whisper.cpp HTTP service. It does not run another model
server. The transcript enters the normal assistant turn, with the same identity, private history, tools and
confirmation rules. Whisper mode returns text, even if ElevenLabs is configured. Urgent reminder audio is unchanged.

## Setup

1. Build whisper.cpp's `whisper-server` and download a multilingual model. English-only `.en` models cannot serve Hindi/Hinglish.
   For English/Hinglish on CPU, the [Oriserve Swift GGML conversion](https://huggingface.co/anish2305/airnote-hinglish-stt-ggml)
   (`ggml-oriserve-hinglish-fp16.bin`, revision `d4f718b3eb4f3f8026a54c315bcfc54277225b02`) is a tested option.
   Set `INKLING_WHISPER_LANGUAGE=en` for this fine-tune, following the original model's generation settings.
   Despite the language token, this model outputs Romanized Hindi mixed with English. The conversion card suggests
   `hi`, but that produced nonsense in our mixed-audio test; test your exact model and settings. Generic `small`
   and `large-v3-turbo` both omitted a language portion in that test.
2. Configure the existing Whisper service to listen on localhost, use automatic language detection, and suppress
   raw stdout/stderr. `configure-whisper.sh /absolute/path/to/whisper.cpp`, run as root, provides an override for an
   existing `whisper-server.service`; it uses `models/ggml-small.bin`. Review the script before running it.
3. Run `server.py` with Python 3.10+ as an ordinary user, under a restarting service. Set:
   - `INKLING_WHISPER_MODEL`: absolute multilingual model path, also accessible to the existing Whisper service.
   - `INKLING_WHISPER_LANGUAGE`: `auto` by default; `en` for the tested Oriserve Swift fine-tune (`hi` also allowed).
   - `INKLING_WHISPER_SECRET`: long random bearer secret shared with the Pi, in a protected environment file.
   - `INKLING_FFMPEG_PATH`: executable FFmpeg path. Alternatively install pinned `imageio-ffmpeg==0.6.0` into the
     service's virtual environment; its wheel supplies FFmpeg.
   - Optional `INKLING_WHISPER_UPSTREAM` (default `http://127.0.0.1:8081`), `INKLING_WHISPER_PORT` (8102),
     `INKLING_WHISPER_UNIT` (`whisper-server.service`) and `INKLING_WHISPER_HINT` (a short public vocabulary hint).
4. Forward a Pi loopback port to laptop loopback port 8102 using a supervised SSH tunnel with keepalives,
   `ExitOnForwardFailure=yes` and automatic restart. Never publish either speech endpoint.
5. On the Pi set `INKLING_WHISPER_URL`, `INKLING_WHISPER_SECRET` and `INKLING_VOICE_REPLIES=text`, then restart the
   existing assistant. Do not start a second WhatsApp session. Off when unconfigured: existing cloud transcription
   remains available. Configured Whisper failures never silently upload recordings to a paid cloud provider.

Only `/transcribe` and `/health` are exposed by the authenticated gateway. `/load`, arbitrary decoding settings,
filenames and model paths cannot be supplied by a caller. The trusted gateway reloads its configured model after
an upstream process restart. Use a dedicated existing Whisper instance if other local applications need a different
model: reloading changes the shared instance's model.

## Behaviour and limits

Registered people all get audio input. Guests follow the existing open-group/private-guest policy. Declined or
unapproved private senders are not transcribed. In groups, spoken names, mentions and replies wake the assistant;
unaddressed allowed audio stays short-term group context. Add alternative name spellings, including Devanagari,
to `INKLING_ALIASES` if the recognizer writes the assistant's name that way. Spoken-name matching supports Unicode
word boundaries. A failed group recording gets a notice only when an explicit mention/reply addressed the assistant.

Requests are serial within each chat, so a later text cannot overtake an earlier recording. Other chats continue.
Across transcription requests: one active, at most eight waiting, at most two outstanding per sender and twelve
admissions per sender per ten minutes. Waiting work expires after two minutes. Downloads are streamed with a
12 MiB cap and 30-second stream timeout. Recordings longer than two minutes are rejected, not silently truncated.
The gateway has one active request and refuses concurrent callers instead of growing another queue.

FFmpeg converts Ogg/Opus and other supported audio into 16 kHz mono PCM WAV. Decode timeout is 25 seconds, each
Whisper HTTP operation 180 seconds, and the Pi gateway request timeout 190 seconds. No automatic retries.
Upstream failures pause new gateway requests for 60 seconds, because a timed-out native inference may still be
finishing. A timeout does not reliably cancel native Whisper work. A gateway failure is a code-generated text notice,
never a fabricated transcript or a model turn. Pending preprocessing is in memory; a process restart can require
the sender to resend a recording. It is not a durable audio inbox.

Whisper uses the configured language token, translation disabled and context reset between recordings. Depending
on the model, Hindi can be Romanized or Devanagari; the existing chat model can reply in the person's usual style without
rewriting the transcript in a separate LLM pass. Code-switching accuracy is imperfect and must be assessed on real
English/Hinglish examples. Decoder scores, silence, repetition and an audible omitted-ending check reject some bad results but cannot prove
correct transcription. Names, numbers and uncertain instructions need clarification; existing outgoing-action
preview/confirmation requirements remain intact. Spoken yes retains the existing voice-note handling rules.

The gateway uses mode-700 temporary directories in `/dev/shm`, removed after each request, outside backups. Audio
can survive a process crash in tmpfs until cleanup/reboot; tmpfs can also be swapped by the OS. There is no durable
recording archive. Accepted transcripts are saved only through normal encrypted chat history. Logging uses static
outcomes, no recordings, transcript text, prompts, credentials or user IDs. No transcription API bill; normal
assistant-model usage and laptop electricity remain.

On one CPU-only four-core laptop, the Swift fine-tune processed an eleven-second public English clip and a
ten-second synthetic Hindi/English clip in about two seconds each, preserving both language portions and the
negative instruction. These are smoke checks, not a representative accuracy evaluation of natural WhatsApp audio.

References: [original fine-tune](https://huggingface.co/Oriserve/Whisper-Hindi2Hinglish-Swift), [Whisper server](https://github.com/ggml-org/whisper.cpp/tree/master/examples/server),
[audio format and model sizes](https://github.com/ggml-org/whisper.cpp),
[Hindi-English code-switching research](https://www.isca-archive.org/interspeech_2025/biswas25_interspeech.pdf).

Owner-private room-mic conversations can optionally use `INKLING_MIC_COMPACT=true`: ordinary replies use a shorter
prompt and one tool-free model response, while tasks load the same permitted tools. All personal notes remain
in context; older conversation remains encrypted and searchable. This does not change WhatsApp voice-note
transcription or the recognizer. See [mic architecture and measurements](../docs/microphone-v1.md#optional-compact-mic-conversations).

## Optional incremental microphone mode

The laptop gateway can preload a local CTranslate2 multilingual turbo checkpoint when
`INKLING_WHISPER_INCREMENTAL_MODEL` is set to its directory. Install the optional versions in
`requirements-incremental.txt` in a separate environment, with compatible CUDA 12/cuBLAS and cuDNN 9 libraries.
The tested deployment uses cuDNN 9.1.1.17 and the system cuBLAS library; CUDA library paths must be supplied to
the service environment. Do not replace system GPU drivers for this feature. Keep the original warm whisper.cpp
mic server available for fallback and install `server.py`, `incremental.py`, `faster_backend.py` and `quality.py`
together. Point the existing gateway user service at the optional environment, allow up to 3 GB RAM / two CPU
cores, and check authenticated `/health` reports `incremental: true` before enabling the Pi flag. The model
is local-only at service start: downloads and credentials do not belong in the assistant or its coding jobs.

Set `INKLING_MIC_INCREMENTAL=true` on the Pi. The private page then offers “Live transcript (experimental),”
unchecked by default. Audio goes over the existing authenticated connection while held; drafts are visible only
to the requester and never reach the assistant. Release seals the exact recording and a complete final pass
runs before normal interpretation. No wake word or automatic endpoint is added. Browser mics request 16 kHz
Web Audio; if that rate is unavailable, full-recording fallback remains available. Keep the updated
`ops/mic_proxy.py` installed if serving this page through the optional HTTPS proxy, so `/mic/chunk` is routed.

Raw audio stays bounded in RAM: one active session, at most twenty seconds, a one-second transport buffer,
ten-second capture inactivity expiry, thirty-second capture lifetime and a separate bounded finish deadline.
Cancelled/expired native work may finish internally but cannot publish. A native stall beyond 195 seconds
restarts the supervised gateway; interrupted recordings need a fresh manual request. Completed text is cached for at most
sixty seconds for idempotent result fetching; no audio or draft text is logged or backed up. Final accepted
conversation text uses the existing encrypted chat store. Other people's sessions/history are never exposed.

`benchmark-incremental.py` measures explicit public/authorised WAV inputs without an assistant instance or any
message delivery. Its default output is hashes/timings/schema only; `--stream-replay` replays actual wall time.
Longer cost-floor probes repeat the input, so those are throughput tests, not accuracy examples. The experimental
`--audio-context bounded` probe is diagnostic only and must not be used as a production setting.

See [implementation measurements and rollout limits](../docs/incremental-transcription-plan.md#12-implemented-v1-and-measured-decision).
Rollback: uncheck live mode or disable the Pi flag; remove the optional laptop model variable/service override
to unload the new backend. The existing full-WAV and WhatsApp voice-note paths need no data migration.
