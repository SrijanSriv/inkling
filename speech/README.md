# Local voice notes

For controlled microphone diagnosis, `compare-whisper.py` reads one 0.3-20-second, 16 kHz mono PCM WAV from stdin
and runs two or three explicitly configured local Whisper models on that exact recording. It uses independent CLI
processes with two CPU threads and lower scheduling priority; it never reloads the live server. Supply `--cli`,
repeat `--model Label=/absolute/model/path`, and choose `--language en`, `auto` or `hi`. An optional neutral `--prompt`
is identical for all candidates and must not contain the expected test sentence. All working files are removed from
protected RAM-backed temporary storage afterward. Results go only to stdout for the operator; do not redirect real
transcripts into logs or a repository. Compare outputs against what was actually said; a fluent output is not a
quality score. Run English and natural Hindi/English trials before replacing the operational model.

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
