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

## Automatic mic review after the recognition failures

The owner subsequently confirmed that a missing beginning was audible in Listen back: capture succeeded and the
recognizer omitted words. Another Hindi/English test corrupted the requested delay in both turbo variants; the
Swift GPU comparison returned only one unrelated word. English-only turbo success therefore cannot justify
unattended reminder creation, and neither model agreement nor fluent text establishes accuracy.

`INKLING_MIC_REVIEW_MODEL` and `INKLING_MIC_REVIEW_REFERENCE` opt manual captures into an automatic same-audio
review through the configured comparison worker. The selected primary supplies the exact draft, never an LLM
rewrite or a majority-voted transcript. Missing primary output fails without silently using a fallback. Cancellation
aborts the worker and suppresses a delivery not already started. The owner is rechecked before delivery.

The deployment uses Hindi-mode turbo for the draft and the Swift reference on CPU. This is a provisional,
human-reviewed mic path, not a proven recognizer upgrade. Auto-language turbo is excluded because it repeatedly
lost reminder intent. WhatsApp voice notes continue to use the existing gateway unchanged.

`speech/quality.py` warns on very little text despite substantial audio activity, or activity outside reported
decoder segments. Activity can be TV, music or noise; timestamps can falsely span omitted speech. These checks
cannot guarantee completeness. Missing timing metadata is disclosed rather than treated as a successful check.
Reminder or negation disagreement prompts clarification. Any detected time/reminder wording requires typed
timing clarification even if both decoders agree. This deliberately avoids guessing corrupted number words, but
unrecognized wording can evade those patterns. All microphone output remains transcript-only: no agent turn,
reminder, pending-draft approval or other action runs. Enabling actions needs a separate reviewed-text flow.

Fixtures cover skipped beginnings/endings, collapsed output, missing timing metadata, reminder/negation warnings,
typed timing checks despite agreement, no fallback, cancellation, identical worker audio, CPU reference selection
and temporary cleanup. A public-sample Pi-to-laptop smoke verifies transport and execution, not owner accuracy.

## Manual conversation stage

The owner then asked to let the normal conversation model interpret phonetic errors and ask focused clarification
questions, instead of making every recording pass a transcript audit. `INKLING_MIC_CONVERSATION` is off by default.
When enabled it uses one warm, separately configured GPU recognizer through the authenticated `/microphone` route,
then queues an owner-private conversation turn. The previous transcript-only review remains available by disabling
that option, and Compare remains a manual diagnostic. Nothing listens outside a manual Listen/Done capture.

The deployment uses Hindi-mode turbo, with no automatic-language rewrite and no routine second decode. Keeping a
warm process removes repeated model loading, but does not guarantee lower decoder time: two public-sample requests
through the Pi tunnel measured 4.67 and 4.48 seconds, versus roughly six seconds for the earlier sequential review.
These are transport/ASR measurements, not full conversation latency or accuracy results. Logs now measure Done to
delivered reply, with transcription, queue and agent durations separated, without audio/transcript content.

The existing chat queue serializes mic and typed turns separately. Source markers survive encrypted pending
storage and appear in encrypted history. The model gets normal owner context, the original transcript and optional
coverage warnings, and is instructed to clarify ambiguity that changes a time, amount, person or negation. No LLM
rewrites speech before interpretation. This cannot prove a fluent transcript preserved every consequential detail.
If coverage is suspicious, the turn has no tools. Outgoing confirmation, mail-review operations, linking,
access/admin changes and self-change controls are unavailable to mic turns and rejected at execution too. The
plain-yes approval shortcut and tweet feedback shortcut also exclude mic turns. Recent mic history cannot supply
the typed words used to authorize privileged changes. Owner registration is checked again before interpretation.

Fixtures used mocked models and send/action hooks: spoken yes left a pending draft intact; forced unavailable
tools were refused; coverage warnings removed tools; provenance survived pending/history; one decode ran; cancel
suppressed enqueueing. No test sent an email, WhatsApp message or invite. Actual conversational quality and full
reply time still need ordinary owner use before wake-word work.


## Hold-to-speak control

The manual page now uses a central press-and-hold circle: pointer down starts capture, release submits that same
capture, and Space/Enter work while the circle is focused. Wait for Listening before speaking. A release arriving
before the start response is serialized afterward, with the returned capture ID. Pointer cancellation, capture
loss, page hiding and focus loss cancel rather than submit. No phone microphone permission is used.

Held captures have a three-second renewable lease (`/hold`, `/held?id=...`). The page renews every 750 ms; the Pi
watchdog cancels abandoned holds without transcription. Stale IDs and releases after lease expiry cannot submit.
This bounds recording when a browser disappears before it can send a stop request. The existing 20-second capture
limit remains. Legacy operator Listen/Done controls still work but do not receive the hold lease.

### Mic model latency tuning

Timing records for the two latest ordinary mic turns showed 4.4–4.8 seconds in transcription, 7.4–7.9 seconds in
the agent with no tools called, 2–3 milliseconds in the chat queue, and under 0.1 seconds sending. This identifies
the agent and transcription as the significant stages; the backend timer excludes browser-to-Pi release transit
and phone receipt after WhatsApp accepts the send. Tool-bearing requests can take substantially longer.

The compatible-provider default previously omitted the effort setting. `INKLING_MIC_EFFORT` now explicitly opts
mic turns into a chosen effort, forwarding only `reasoning.effort` for compatible Responses endpoints. It is off
until configured; typed turns keep their existing behavior. The deployment uses `low`, accepted by the actual
Z.ai Responses endpoint. One small public-question pair measured 3.435 seconds with defaults versus 1.769 with
low effort. This is a compatibility/smoke result, not an end-to-end speed guarantee or an accuracy evaluation.
Mic turns also skip the concurrent emoji-triage call, which had no incoming WhatsApp bubble to react to. Its full
duration was never a sequential part of the response path; removing it saves a request and potential contention.
Mocked-model fixtures verify low effort through tool-loop steps, zero mic triage calls, unchanged typed/default
compatible behavior and continued refusal of spoken approval. No fixture sent a message or executed a live tool.

DOM fixtures covered quick release before the start response, pointer loss/cancellation, page departure after
release, keyboard repeats, unrelated pointers, and exactly one capture-bound submit. Fake-clock recorder fixtures
covered lease expiry, renewal, stale IDs and expired release, with no real audio capture or message delivery.

### Optional compact mic conversations

`INKLING_MIC_COMPACT=true` enables a shorter prompt for owner-private room-mic turns only. It keeps every saved
personal note and the existing recap, and includes the last twelve history messages beginning with a user turn.
This is a prompt window, not data deletion: encrypted history remains intact. `recall` searches both stored recent
and archived messages, scoped to the current chat, plus the existing configured article memory. Typed chats keep
their normal prompt and tools.

Ordinary conversation gets one response from the same model with no tool definitions. When it needs a lookup or
action, an internal routing marker loads the existing permitted tools and continues the normal tool loop. Code
never executes model-written command text or JSON. Obvious task wording bypasses that first conversation step;
these turns start with common tools and can load the remaining permitted definitions. Unknown tasks can still
route through the model, at the cost of another model request. Loading tools grants no permissions, and calls
are checked against the definitions offered for that particular response. Mic approval and incomplete-capture
restrictions continue to apply. Internal routing markers are suppressed from final replies.

In a small alternating comparison on the deployed provider, short conversational replies took 2.199 and 2.392
seconds with this path, versus 4.994 and 4.976 seconds with the normal prompt/tools. Merely shrinking the tool
menu did not reliably improve latency; the tool-free conversation step did in this sample. Transcription was
unchanged. These are model-stage observations, not an end-to-end guarantee; tool requests, longer replies and
provider variability still matter.

Mocked fixtures covered preservation of all notes and recent context, chat-isolated recall, natural one-call
replies, lazy tool loading, refusal of unoffered calls even beside a loader call, command text never executing,
spoken approval remaining blocked and unchanged typed turns. Real model smoke checks covered a recent follow-up,
older-memory routing and browser routing without executing any tool or sending any message.

### Private mic page: source selection and replies

Registered users can now request `/mic` in their own private chat; guests and groups cannot. Each expiring link
is tied to its requester, uses their own conversation context, and is rechecked against registration. Source
markers and outgoing-approval restrictions remain in force. The capture service has one shared slot and tells
other users it is busy without exposing another person's audio, transcript, comparison or reply.

The page offers Pi microphone and this phone/laptop microphone. Browser capture requests audio permission on
selection, immediately releases the permission-check stream, and records only during a subsequent hold. It uses
an AudioWorklet and browser resampling to upload bounded 16 kHz mono PCM WAV on release, sharing the existing
recognizer and validation. Permission failure never silently falls back to recording the room. Release, cancel,
page loss, overlong capture and interrupted upload are distinct outcomes. Browser upload requires the matching
registered user's active capture ID; duplicates do not start a second transcription.

Browser microphone access requires a trusted secure context. The existing HTTP home-Wi-Fi page can still drive
the Pi microphone but cannot enable browser recording. Deploy behind an authorised HTTPS proxy, or configure
`INKLING_MIC_TLS_CERT` and `INKLING_MIC_TLS_KEY` with a certificate trusted by the user's device and a matching
HTTPS `INKLING_MIC_CONTROL_URL`. A private CA requires a one-time trust installation per device. Do not disable
browser security or expose another service just to work around this requirement.
[Browser permission and secure-context requirements](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)

After a mic turn completes, the page displays the same final reply sent to WhatsApp, plus delivery status and
elapsed time. For a release in the current tab, the browser measures release submission to the first poll showing
the reply using its monotonic clock. A refreshed page uses server submission-to-send-acceptance time instead.
Neither proves phone WhatsApp arrival. Only the latest mic reply for that person is shown; it is held in memory
for up to thirty minutes and remains separate from encrypted durable chat history. General chat history is not
served by the page. A generation/delivery failure is shown rather than leaving the page waiting silently.

Ad-hoc mocked fixtures verify non-admin registration, cross-user isolation, removal revoking links, WAV size/format
checks, cancel/stale/duplicate uploads, single enqueue, permission selection, device hold/release, safe text rendering,
elapsed-time display, worklet flush and overlong cancellation. No fixture captures real audio or sends messages.
Actual permission and acoustic behaviour still require trials on the chosen phone/laptop browser.

### Existing HTTPS entry point

The trusted operations receiver can optionally proxy `/mic/` to a loopback mic controller by configuring
`webhook_mic_port` in its private operations config. It serves only the fixed mic page/assets/control routes;
all private routes retain bearer authentication, registration and per-person checks in the controller. No inbox,
main web app, browser service or arbitrary upstream is proxied. The signed `/github` endpoint is unchanged.
The receiver bounds request threads, bodies, replies and upstream timeouts, and suppresses request logging.
Set `INKLING_MIC_CONTROL_URL` to the authorised HTTPS origin plus `/mic`; the page resolves API and worklet
URLs relative to that path. Fresh `/mic` links use the trusted HTTPS address, enabling browser permission prompts.

### Page layout and keyboard hold

The microphone selector comes first, followed by the latest private mic reply and elapsed time, then capture
status/transcript and diagnostic controls. The hold circle floats above content near 80% of viewport height,
with responsive sizing, a shorter-screen fallback and bottom scroll space so the last content can be uncovered.
Hold Command on Mac or Control on Windows/Linux anywhere outside text inputs to use the same capture lifecycle;
release submits. Repeats do not start another capture. Modifier chords, page loss and focus loss cancel; holding
both physical modifier keys does not submit until both are released. Space/Enter on the focused circle remain.
Mocked DOM checks cover both platforms, chord/repeat/focus behaviour and page structure without real recording
or message delivery.
