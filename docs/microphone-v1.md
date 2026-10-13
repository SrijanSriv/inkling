# Microphone to WhatsApp: reliability-first v1

Research and hardware inspection: 2026-10-13. The full loop below is the proposed implementation and acceptance
plan. Stage one is implemented: owner-private `/mic`, an expiring Listen/Done page, bounded capture, the existing
Whisper gateway and a transcript-only WhatsApp receipt. Wake detection and assistant answers remain later stages.
`speech/mic-check.py` is a working, recording-free diagnostic.

## Decision

Keep the microphone open locally, run a lightweight **Hey Jarvis** detector on the Pi, and send only deliberately
captured utterances through the existing laptop Whisper gateway. Provide an equally supported manual Listen/Done
button on a phone page. Send the exact accepted transcript and the assistant's answer to the owner's WhatsApp DM.

Do not transcribe the room continuously, invent ambient context, or enable spontaneous contributions in v1.
Do not treat a USB receiver, successful playback, a wake score, or a fluent transcript as proof of successful human
interaction. Each stage must have its own observable success/failure state.

## Evidence from the existing setup

The owner authorized review of earlier Codex microphone work. Relevant chats were **Research Pi consciousness
system** and **Check Hindi audio transcription**. They show:

- A generated wake phrase scored well while a live human attempt scored below threshold. Synthetic success did not
  establish acoustic wake performance.
- The owner repeatedly could not tell whether the assistant woke. Short Bluetooth cues and a disconnected output
  route were plausible separate failures.
- An earlier system reported a transcript the owner denied saying. A subsequent correctly captured test phrase
  still got an incorrect LLM-generated answer. Capture and answer construction need separate tests.
- One corrected human wake/capture/repeat test eventually passed. Long-duration and noisy-room acceptance remained
  unfinished. That is useful evidence of feasibility, not reliable-room performance.
- Minute-long ambient batches produced late or out-of-context responses. Additional listening/context/voice features
  made diagnosis harder before the basic loop was reliable.

Current inspection found a 2 GB Pi with approximately 586 MiB available at that moment, a single-channel Jieli USB
capture receiver exposing 48 kHz signed 16-bit audio, and an existing PipeWire source. The older project listeners
were inactive and disabled. The wake-word environment already contains openWakeWord, ONNX Runtime and Silero VAD.
No new Home Assistant installation or another model server is needed.

Initial PipeWire recordings contained all-zero samples despite the receiver being present and unmuted in software.
The owner then reported a discharged transmitter and switched to the other transmitter. A subsequent direct USB
48 kHz check captured 190,096 samples, 189,399 nonzero, peak 5,056/32,768. This establishes that signal arrived during
that check; it does not establish intelligible speech or correct transcription. No recordings were saved or sent to
an assistant during these level checks. Recheck the normal PipeWire route after changing transmitters.

The follow-up PipeWire check captured 7.94 seconds of varying signal, peak -20.0 dBFS, RMS -37.5 dBFS, with no clipped
samples. This confirms both routes carried a varying signal after the transmitter change. It does not establish
word accuracy or identify what sound was captured.

The owner reports that TV/music usually comes from a separate device. The Pi does not have its playback reference.
At inspection the Pi itself had only a Dummy Output sink, so speaker chimes must not be the only feedback route.

## What the experience should be

1. The phone page says **Armed** only when microphone frames are arriving and the detector is healthy. Show a level
   meter and separate signal status; a connected receiver is not a battery or transmitter-health report.
2. Say **Hey Jarvis**, pause for acknowledgement, then speak. The page immediately says **Listening**. An optional
   chime is additional feedback only when a real speaker route exists. Failure to play it must be visible.
3. A short pause closes the utterance. The page says **Transcribing**, then shows the transcript, followed by
   **Answering** and **Sent to WhatsApp** when the send call actually succeeds.
4. WhatsApp receives a clearly labelled `Heard: ...` using Whisper's actual accepted text, followed by the assistant's
   answer. These are distinct outcomes: if transcription succeeds and answering fails, preserve that distinction.
5. Failed/empty/stalled/clipped/overlong captures produce a concrete retry notice, never an invented transcript or
   an LLM explanation of what the microphone allegedly did.

The manual button uses **the Pi's Grenaro**, not the phone microphone. A small authenticated home-Wi-Fi page has
Listen, Done, Cancel and Mute. Listen acknowledges only after the capture worker has armed; Done closes the same
utterance. This bypasses wake-word detection, so it remains useful when the TV prevents a reliable wake or endpoint.
A WhatsApp `/listen` command can use that same control path, but it is a fallback: chat delivery is slower feedback
than the live page. These are not unofficial WhatsApp interactive buttons and need no new physical switch.

Use explicit statuses rather than a generic green light:

| Status | What is established | What is not established |
| --- | --- | --- |
| Device present | The receiver exists | Transmitter power/pairing, useful audio |
| Frames arriving | Capture is progressing | Speech or intelligibility |
| Signal present | Samples vary | The speaker is the owner, not TV |
| Wake detected | Detector threshold crossed | Correct speaker identity or complete request |
| Listening | A bounded utterance is being captured | Correct transcript |
| Transcribed | Whisper returned accepted text | Semantic accuracy |
| Sent | WhatsApp send succeeded | Human read receipt or satisfaction |

All-zero audio for several seconds is a **no signal** warning: check transmitter power, mute, pairing or routing.
It does not identify the battery as the cause. Constant/DC input and a stalled stream are separate faults. Ordinary
quiet-room audio must not be called a disconnected microphone merely because its volume is low.

## Capture and endpointing

Use a separately supervised capture process, not synchronous audio inference inside the Baileys event loop.
Select the actual microphone by its configured stable PipeWire `node.name`, not a numeric node id, auto-default or
speaker-monitor source. Validate it exists on reconnect. PipeWire performs conversion from native 48 kHz mono to
16 kHz mono PCM for the detector and Whisper; do not repeatedly restart capture between waking and speaking.

Keep about 1.5 seconds of pre-roll in RAM, approximately 48 KB at 16 kHz/16-bit mono. Preserve the wake-to-command
transition so a first syllable is not lost. In v1 ask for a short pause after the wake phrase; support continuous
wake-plus-command only after it passes tests. A cue must not stop microphone capture or become part of the command.

Starting settings, **to be tuned on real room trials**, not claimed optimal:

- Wake model: existing Hey Jarvis ONNX; start from its established baseline threshold, then measure misses versus
  false wakes. Do not lower sensitivity indiscriminately to make one test pass.
- VAD: Silero ONNX, independent of wake scoring; sustained onset and about 1.0-1.2 seconds of trailing silence.
- No-speech timeout: around 6 seconds. Max command: 20 seconds, bounded in memory. No silent truncation.
- One active capture/inference/answer, no growing background queue. Show Busy and provide Cancel. Discard stale
  work rather than answering minutes later. After a timeout, wait for the shared gateway's recovery policy.
- Pause wake detection while processing the current command; reset detector/VAD state before rearming. A manual
  capture and a wake capture must compete for the same slot.

**TV dialogue is speech to VAD.** It may prevent an automatic endpoint or enter a command even if the wake was
correct. The manual Done control must work independently of VAD. If a wake capture reaches the duration cap without
an endpoint, report that it could not finish cleanly; do not execute a potentially incomplete instruction. Increasing
silence thresholds or allowing minutes of audio is not a solution to continuous TV speech.

Do not normalize already clipped audio into apparent quality. Report clipping. Retain a raw capture path for
controlled A/B testing before adding suppression; do not stack the microphone's hardware suppression, software
noise gating and aggressive AGC without measuring their effect on quiet words, names and Hindi/English switching.

## What software can and cannot remove

[PipeWire echo cancellation](https://docs.pipewire.org/page_module_echo_cancel.html) compares microphone audio with
an available playback signal. It can be tested for media actually routed through the Pi. It cannot subtract a
separate TV merely because both devices are in the same room. This installation has no TV reference path.

[RNNoise](https://github.com/xiph/rnnoise) and WebRTC noise suppression are candidates for steady environmental noise.
They are not enrolled-speaker selection. Start with no extra suppression, then compare a mild setting on the same
captured trials. Keep it only if command accuracy improves without dropping syllables. A less noisy recording is
not automatically more intelligible to Whisper.

[Targeted speaker separation research](https://research.google/blog/improving-on-device-speech-recognition-with-voicefilter-lite/)
addresses overlapping voices using enrolled-speaker information. It is a distinct problem from denoising and would
need a reproducible compatible model, enrollment, latency measurements and Hindi/English tests. Do not promise it
as a configuration switch or add it to v1 before the simpler path has been measured. If needed, evaluate on the laptop.

Start with the lavalier on the collar, then a nearby table position, then the actual TV/music position. Move the mic
closer to the talker than the competing speaker. [Shure's placement guidance](https://service.shure.com/articles/en_US/Knowledge/critical-distance-and-microphone-placement)
explains why microphone distance and background level matter to intelligibility. A one-channel lapel receiver does
not provide the spatial channels needed for array beamforming. It may work on a table under some conditions; that
must be measured rather than guaranteed.

If the table/TV condition fails after tuning, the honest options are nearer placement, lower TV volume during a
request, manual activation/Done, obtaining a usable TV playback reference, or evaluating suitable far-field hardware.
A different language-model prompt cannot reconstruct words that the microphone did not capture intelligibly.

## Reuse the existing assistant

The laptop keeps the existing multilingual Whisper model and private speech gateway. Do not change the working
WhatsApp-voice-note transcription settings for an untested room-microphone experiment. Reuse `queueVoice()` and
`transcribe()` on the Pi, respecting the shared gateway's serial inference, size caps and failure cooldown.

The accepted microphone transcript enters the owner's existing private chat and serialized turn queue, with an
explicit microphone source marker and request id. Use the normal `responses()` provider abstraction and the existing
WhatsApp connection. No second assistant identity, Baileys session, LLM service or parallel personal memory.

Ambient audio does not authenticate the owner. V1 may answer questions and use a deliberately limited set of
read/search tools. Do not let room speech confirm a pending email/payment/browser final step, change roles, execute
coding jobs or modify security settings. These restrictions need a source flag and code checks, including the plain
Yes fast path; prompt instructions alone are insufficient. A spoken yes or a line from the TV must not confirm an
unrelated draft waiting in WhatsApp. Approvals remain an explicit later authenticated chat message.

Do not automatically turn room speech into durable owner preferences or tweet candidates. Store accepted turns
through normal encrypted chat history with source provenance. Add explicit intentional memory support later if
needed, separately from ambient observation.

## Resource and privacy bounds

Idle audio stays in a short RAM ring on the Pi. Send only a deliberately triggered, bounded clip to the private
laptop gateway. Never archive raw room audio, background transcripts or wake-word negatives automatically. Debug
recordings require a named short test and explicit retention; the default diagnostic records only signal statistics.
RAM is not a promise against OS swapping. Keep temporary gateway audio in its existing protected tmpfs workflow.

The control page needs authenticated, expiring owner access, no third-party scripts, no permissive CORS and no
public forwarding. Keep transcript/status text in short-lived memory and out of HTTP/access logs. Bind the internal
capture-to-assistant endpoint to loopback or a mode-600 Unix socket. A local HTTP button page does not need to use
browser microphone APIs and so can work over home Wi-Fi without browser mic permissions.

Default the feature off unless configured. Use environment variables with `INKLING_` prefixes, a watchdog for frame
stalls, reconnect with bounded backoff, and supervised process restart. Do not rely solely on cgroup memory limits:
measure the actual capture/detector RSS and CPU on this Pi. Aim for under 150 MiB additional RSS and no sustained
capture backpressure; these are initial budgets, not measured results. Heavy transcription remains on the laptop.

## Implementation order and acceptance

Stage-one configuration requires existing `INKLING_WHISPER_URL`/`INKLING_WHISPER_SECRET` plus
`INKLING_MIC_SOURCE` (stable PipeWire node name), `INKLING_MIC_CONTROL_URL` (home-network origin),
`INKLING_MIC_HOST` (loopback by default; explicitly choose the home-network binding) and optionally
`INKLING_MIC_PORT` (8792). `pw-record` must be available to the existing assistant service. No additional daemon,
model download or Python dependency is needed for this manual stage. Keep this port off public forwarding.

Send `/mic` privately as the owner, open the link on home Wi-Fi, tap Listen, wait for Listening, speak, then tap Done
before 20 seconds. The token is in the URL fragment, never in HTTP request paths; fresh links revoke the owner's old
link. Every control/status call rechecks owner registration. A restart invalidates all links. Only the latest result
is held in short-lived process memory; it clears after a minute. **Listen back** retrieves the exact captured PCM
as WAV through the same owner-authenticated control page. A separate copy stays in RAM for 60 seconds after Done,
then is zeroed and released even if no page polls. Starting another capture or cancelling clears it sooner. It is
bound to the capture id and cannot be retrieved by another owner or after expiry. The page releases its playback
blob when the recording expires or the connection becomes unavailable. No recordings are written to disk on the Pi.
The existing gateway still uses its documented transient decoding workflow. In-flight transcription cancellation
suppresses delivery but waits for the shared service call to finish. A send already started cannot be recalled.

Isolated stage-one fixtures covered PCM/WAV framing, access and origin checks, registration changes, partial audio
frames, silent/constant/clipped/short/overlong input, device loss/stall, cancellation and uncertain-delivery no-retry.
No real emails or WhatsApp messages were sent in those tests. These software fixtures do not substitute for the
owner's requested-phrase test or the room-noise trials below.

Replay fixtures additionally verified exact PCM bytes, authentication, capture-id binding, cancellation, expiry,
role revocation and that clearing the replay copy does not corrupt an in-flight transcription request.

1. Verify varying input on the normal capture route. `mic-check.py` tests this without saving speech. All-zero,
   disconnected, stalled and clipping fixtures must be distinguishable.
2. Build manual capture, live state/level display and a deterministic transcript-only mode. Test a requested phrase
   before introducing the LLM. This separates capture/transcription from reply-quality failures.
3. Connect accepted transcripts to the existing assistant and owner WhatsApp. Echo the observed text, never the
   requested test phrase. Test chat-queue ordering and a pending email draft plus a spoken yes.
4. Add the Hey Jarvis trigger using exactly the same capture pipeline. Test missed/false wakes independently of
   transcript accuracy. The button path stays available.
5. Compare collar, nearby table, table with TV, and table with music at recorded distances/volume settings. Test
   English and natural Hinglish, including names, numbers, negatives and mid-sentence pauses. Count clipped starts,
   clipped endings, wrong words, no-replies, duplicate replies and false activations separately.
6. Run at least 50 intended human commands across those conditions and several hours of TV/music with no commands.
   Initial acceptance targets: >=95% wake success in quiet collar/near-table trials, >=90% complete correctly
   understood commands in each claimed supported condition, and no unintended actions. These are product targets,
   not statistical proof from a small sample. If a condition fails, label it unsupported instead of averaging it away.
7. Measure wake-to-indicator, speech-end-to-transcript, transcript-to-answer and WhatsApp delivery separately. Target
   local acknowledgement within 250 ms of detection (not phrase onset), plus transcription receipt within 5 seconds
   for short requests under normal gateway load. Report actual medians and tail latencies, not synthetic estimates
   as user-experienced measurements.
8. Exercise discharged/muted transmitter, USB removal/replug, server sleep/tunnel outage, restart, long TV dialogue,
   concurrent WhatsApp voice notes and interrupted captures. No stale replay or silent retries after ambiguity.

## Sources and alternatives

- [openWakeWord](https://github.com/dscripka/openWakeWord): local frame-based detection, threshold/false-wake tradeoffs,
  optional suppression and the need to evaluate in the deployment environment. Detector scores are not calibrated
  probabilities of correctly understanding a command.
- [Hey Jarvis model documentation](https://github.com/dscripka/openWakeWord/blob/main/docs/models/hey_jarvis.md): short
  pause recommendation and sensitivity to competing playback. Its test conditions do not establish this owner's
  accent/room performance.
- [Silero VAD](https://github.com/snakers4/silero-vad): small CPU speech detector. Speech detection is not speech
  recognition or identification of the intended speaker.
- [Custom wake verifier](https://github.com/dscripka/openWakeWord/blob/main/docs/custom_verifier_models.md): optional
  later reduction of false wakes using examples from the actual speaker/environment. Explicitly not a security
  speaker-verification system. A recording of the owner's voice must never become authorization.
- [Linux Voice Assistant](https://github.com/OHF-Voice/linux-voice-assistant) and its
  [configuration](https://github.com/OHF-Voice/linux-voice-assistant/blob/main/docs/configuration.md): useful references
  for feedback, mute and detector tuning. Its Home Assistant/ESPHome stack is unnecessary to close this existing
  WhatsApp loop. [Wyoming Satellite](https://github.com/rhasspy/wyoming-satellite) is deprecated in its favor.
- Existing repo: `src/voice.ts`, `src/voice-intake.ts`, `speech/server.py`, `src/index.ts`, `src/agent.ts`, `src/drafts.ts`.
  Extend these integration boundaries rather than porting an earlier assistant backend or cognitive-memory stack.

## Additional normal-volume probe

With permission to sample the owner's ongoing talking/singing, a 9.76-second bounded capture measured RMS -36.1
and peak -17.2 dBFS with zero clipped samples. Silero marked 17.2% of frames as speech; the maximum Hey Jarvis score
was .0188. These are detector outputs, not ground truth labels. Singing is not necessarily treated as ordinary
speech, and this short sample does not measure a false-wake rate. Whisper accepted the clip in 2.964 seconds and
returned three words. Without the intended wording that is **not an accuracy pass**, nor evidence that all of the
sample was understood. No raw recording, transcript copy or WhatsApp message was retained/sent by this probe.

The Python wake-plus-VAD diagnostic process peaked at 213.6 MiB RSS, exceeding the proposed 150 MiB idle-detector
budget. It exited after the probe. Do not enable that exact stack continuously and claim it met the budget. Measure
steady RSS, startup peaks and CPU in a separate next step; reduce imports/runtime overhead or evaluate a smaller
runtime before changing the always-on design. The deployed manual stage does not load those models at all.

The manual control page was reachable over the home network and returned HTTP 403 for unauthenticated status
requests. Use a reachable home-network address in `INKLING_MIC_CONTROL_URL`; `.local` name resolution varies by
client. A numeric address requires a DHCP reservation or updating the configuration when the Pi's LAN address
changes. Do not assume that an SSH hostname resolving on one computer proves phone-browser reachability.

## Same-audio recognizer comparison

The owner's playback checks found intelligible recorded speech but errors in ordinary clauses and proper nouns.
Treat this as evidence to investigate ASR, not proof that capture is perfect in every environment. Do not hide
meaning-changing errors behind an LLM cleanup pass.

A remotely timed twenty-second trial returned a fragment from the current model and an unrelated sentence from
Whisper small. The owner reported following the speaking cue, but the diagnostic did not retain playback for
checking that the full intended utterance was inside the capture window. Neither timing failure nor recognizer
failure was isolated. This trial is invalid for ranking accuracy. On two lower-priority CPU threads, the fresh CLI
calls took 1.869 and 18.349 seconds respectively; these are one-trial diagnostic runtimes, not production latency
estimates or proof that the larger model is better.

The optional **Compare recognizers** button fixes that test procedure: manually capture, verify the complete audio
with Listen back, then compare the exact same PCM before its replay window expires. Results appear on
the page and in the owner's private WhatsApp. The owner compares them with intended words. No expected sentence is
sent to either decoder. Compare English and natural Hindi/English separately before selecting a replacement.

`INKLING_MIC_COMPARE_COMMAND` is an optional JSON argv array supplied by the trusted operator. The worker reads WAV
on stdin and returns bounded JSON with two or three labelled transcripts and elapsed times. There is no local
shell, no tool for the model to invoke, and no user-supplied executable/model/path. One comparison runs at a time;
at most four start per ten minutes. Cancellation suppresses a result not already being sent. A timed-out SSH
connection may leave its remote CLI finishing until the worker's own per-model timeout; no automatic retry occurs.
Working copies are transient, not a recording archive. The replay copy expires one minute after transcription finishes, capped at three minutes after Done. This prevents a slow transcription from consuming the comparison window.

`speech/compare-whisper.py` is the supplied offline worker. It uses independent low-priority CLI processes rather
than the shared server's `/load` route. The shared operational model remains unchanged. Fixtures verified exact
input reuse, private temporary cleanup, output validation, Unicode handling, owner reauthorization, cancellation
and suppression of duplicate/unauthorized sends. These do not establish real recognition accuracy.

The first owner-controlled English comparison favored Whisper small for wording and one proper noun, at about
7.9 seconds versus 2.5 seconds. The following Hindi/English comparison favored the current Swift model for intent:
the general model's English output omitted the request to set a reminder. This blocks selecting it as a replacement.
Both candidates had been forced to `en`; that was the tested setting for Swift, but is an unresolved decoding
confound for a general multilingual model. The diagnostic now supports explicit per-model language settings. Keep
Swift at its established setting and evaluate general Whisper with automatic language detection on the same clip.
Do not infer that a larger model is universally better, or that English output preserved the complete request.

The next owner-controlled comparison used automatic language detection for small. It took 15.5 seconds versus
2.1 seconds for Swift and returned Urdu-script text with remaining word errors. This does not establish that small
is a useful replacement. Keep the production recognizer unchanged while evaluating another candidate.

An isolated CPU smoke test of `large-v3-turbo-q5_0` took 43.66 seconds on the public Whisper JFK sample, with two
threads and beam size five. It reproduced that sample's phrase, but this is neither a test of the owner's accent
nor acceptable conversational latency. GPU acceleration must be verified separately before another live test.
Build GPU binaries in a separate directory and verify actual CUDA offload, memory use and elapsed time. Do not
replace the shared speech server or select a model merely because the GPU is detected. Human English/Hinglish
comparisons must still check negation, reminder intent and named entities on the identical recording.

The isolated CUDA build subsequently processed that same public sample in 4.892 seconds and logged the model on
the CUDA backend, versus 43.66 seconds for CPU. Peak child host RSS was 424.4 MiB; this is not GPU memory usage.
This supports a human comparison, not a production-model switch. The deployed diagnostic compares Swift (`en`)
with turbo (`auto`) and turbo (`hi`) on the same recording, using the separate CUDA CLI for all three. These new
timings must not be attributed solely to the model when comparing with earlier CPU trials. Hindi decoding may
produce Devanagari; do not rewrite output into Romanized Hindi or English to conceal recognition mistakes.
