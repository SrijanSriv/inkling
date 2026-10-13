# Incremental microphone transcription: research and implementation plan

Date: 2026-10-13. Original research plan, followed by the implementation outcome below.
The initial alternatives and acceptance targets are retained as research context; the outcome section governs the implemented v1.
Baseline inspected: repository revision `6662806` and the existing mic/speech implementation.

## 1. Decision

Keep the manual hold-to-speak circle and the current multilingual recognizer. First run an isolated,
real-time replay experiment to establish whether overlapping recognition can reduce **release-to-final-transcript**
latency on the actual laptop. Build session transport and integrate it only if that experiment passes.

The initial candidate is a small adapter around the warm whisper.cpp GPU server, with provisional hypotheses,
conservative agreement across updates, and a final overlapping-tail decode. It is an experiment, not an assumed
speedup. A whole-recording decode remains the correctness fallback. Do not ship preview-only streaming as a
latency improvement.

If repeated whisper.cpp calls cannot beat the baseline without harming recognition, stop that approach. Evaluate
a quantized faster-whisper backend separately, then consider a more specialised streaming decoder only if its
hardware requirements and English/Hinglish results justify it. No new paid transcription API is required by this plan.

No wake word, continuous room transcription, spoken output, or speculative assistant actions are included.

## 2. What exists and what needs changing

| Existing component | Evidence in the repository | Consequence |
| --- | --- | --- |
| Pi captures 16 kHz mono signed 16-bit PCM | `src/microphone.ts`: `RATE`, recorder data handler, `microphoneWav` | Send those samples directly; no audio conversion is needed for this path. |
| Entire capture is buffered before decoding | `stop()` builds a WAV; `finish()` invokes `transcribeMicrophone` | Currently recognition starts after release. |
| Authenticated laptop gateway | `src/microphone-transcription.ts`, `speech/server.py` | Extend this boundary instead of adding a public service. |
| Warm GPU mic recognizer | `speech/microphone-whisper.service.example`, deployed mic service | Avoid spawning a model or loading weights for every update. |
| Gateway handles complete uploads under one global lock | `speech/server.py`: `LOCK`, `do_POST`, `/microphone` | Streaming requires session state and explicit scheduling; holding this lock for a whole recording would block other voice requests. |
| Pi voice queue limits jobs, not audio chunks | `src/voice-intake.ts`: `queueVoice` | One recording must count as one admission; each packet/update must not consume a new allowance. |
| Coverage checks use audio and decoder timestamps | `speech/quality.py`, mic branch of `speech/server.py` | Preserve checks on the final result; segment stitching requires global offsets. They are warnings, not proof of accuracy. |
| Phone polls local status every 500 ms | `assets/microphone.html` | Can display provisional text using the existing poll; no browser WebSocket is necessary. |
| Final transcript enters the normal owner-private queue | `src/index.ts`: `startMicrophone` / `converse` | Keep this entry point and microphone provenance. Never enqueue partial transcripts. |
| Manual cancellation, capture IDs, hold lease, audio cap | `src/microphone.ts`, `assets/microphone.html` | Preserve these behaviours across network/inference races. |

The deployed mic recognizer uses quantized Whisper large-v3-turbo with Hindi-mode transcription and translation
disabled. This is the baseline for **both** English and Hinglish. Do not switch language mode or add automatic
language detection per chunk while also testing streaming: that would confound the comparison.

Recent observed backend timings were approximately 4.5–5.1 seconds for transcription, 2.3–2.7 seconds for several
ordinary model replies, and 6.1 seconds for one slower model reply. The owner reports roughly eight seconds for
English and 11–14 seconds for Hinglish. Timing logs do not identify language, so they do not establish a causal
language difference. Incremental transcription can address the transcription wait; it cannot remove GLM/tool latency.

The laptop GPU was observed as a GTX 1650 with 4,096 MiB total memory and roughly 936 MiB in use. This is a snapshot,
not a memory reservation or proof that another backend fits. The Pi is the capture/controller, not the inference host.

## 3. Research findings

### Whisper.cpp's stream example

The official example repeatedly recognises microphone windows and offers a basic VAD mode. Its default terminal
output is rewritten in place; the example also owns local microphone capture through SDL2. Our microphone is on
the Pi while recognition is on the laptop. Therefore use the existing raw-audio boundary, not this CLI as an
unmodified service. [Official streaming example](https://github.com/ggml-org/whisper.cpp/tree/master/examples/stream)

The upstream HTTP server accepts complete inference requests, serialises model access, and exposes parameters
including token timestamps, audio context and beam size. It does not make our existing `/microphone` route a
stateful incremental session. Verify the installed build's actual response schema before relying on word/token
alignment. Upstream source is evidence of capabilities, not evidence that our binary has every latest option.
[Server source](https://github.com/ggml-org/whisper.cpp/blob/master/examples/server/server.cpp)

### Local agreement

Whisper-Streaming adapts an offline recognizer by repeatedly decoding available audio and confirming a common
prefix across successive hypotheses. This supplies an explicit stability policy instead of concatenating whatever
text each chunk returns. Its reported 3.3-second latency is from its own long-form evaluation, not a predicted
release-to-reply time on this laptop. The project now points to SimulStreaming as its successor.
[Paper](https://aclanthology.org/2023.ijcnlp-demo.3/),
[project](https://github.com/ufal/whisper_streaming)

Its implementation tracks timestamps, removes overlapping output and separates committed and provisional words.
Borrow the principle, with attribution/license review if copying code. Agreement is correlated model output,
not independent confirmation that a number or negation was heard correctly.
[Hypothesis-buffer implementation](https://github.com/ufal/whisper_streaming/blob/main/whisper_online.py)

### SimulStreaming / AlignAtt

SimulStreaming uses an attention-based policy to stop decoding near the uncertain end of available audio. Its
speech and translation components can run separately; a translation LLM is unnecessary here. The current README
recommends at least 10 GB VRAM for its best large-v3 model and its backend uses PyTorch. This rules out assuming
that the recommended configuration fits our 4 GB card. Smaller-model feasibility remains an experiment.
[Project and requirements](https://github.com/ufal/SimulStreaming),
[system paper](https://aclanthology.org/2025.iwslt-1.41/)

### Faster-whisper

Faster-whisper supports GPU quantization and timestamped output. Its published comparisons use different models,
long recordings and larger hardware, so they do not establish a win over our quantized whisper.cpp turbo setup.
Current GPU installation requires compatible CUDA/cuDNN libraries. Treat it as a separately benchmarked backend,
not a promised speedup or a drop-in reuse of the current GGML model file.
[Official implementation, benchmarks and requirements](https://github.com/SYSTRAN/faster-whisper)

### What these findings mean here

- Sending audio packets sooner saves upload delay, but upload alone is unlikely to explain our multi-second wait.
- Live preview and faster finalisation are different outcomes. Measure both.
- Repeated whole-prefix decoding spends more GPU time and can leave an obsolete decode running at release.
- A shorter tail is not guaranteed to decode proportionally faster. Measure the short-input latency floor first.
- Small independent chunks can cut words, lose code-switch context and repeat/drop overlap. Do not concatenate them.
- A stable prefix can still be wrong. Keep the full bounded recording available for fallback until finalisation.
- Do not ask GLM to repair missing chunks or resolve a transport gap by guessing.

## 4. Phase 0: prove feasibility before building transport

Create an offline diagnostic that replays audio at its original rate, through the current warm recognizer, without
starting another assistant or sending messages. Use the same samples for baseline and candidate. Public samples
are suitable for plumbing; owner-authorized live recordings are required for actual accent/Hinglish assessment.
Do not reuse expired recordings or turn on background capture for this test.

Record installed whisper.cpp revision/build flags, model checksum, language, translation setting, beam size,
timestamp schema, GPU memory and warm-up state. Check whether timestamps are per segment, token or word, their
units, and whether they span padded audio. These are compatibility gates.

Run these experiments in order:

1. **Decode-cost floor:** 2, 4, 8, 12 and 20-second inputs at unchanged settings. This answers whether decoding a
   short final tail can plausibly save time. Include useful speech, not only padded silence.
2. **Baseline:** a single full decode after simulated release.
3. **Preview control:** occasional cumulative-prefix decodes plus a full final decode. This measures extra work
   and release contention; it is not expected to be a latency solution by itself.
4. **Candidate:** agreement-derived prefix plus a final overlapping tail, using timestamp alignment and fallback
   rules below. Test continuous speech as well as pauses. Charge all in-flight decode time to the candidate.

Alternate baseline/candidate order and run repeated warm trials. Report median, p90, worst case, sample counts,
GPU busy time, fallback rate and result correctness separately for English and Hinglish. Do not subtract recognition
performed while speaking from the resource-cost report. Do not use a simulation that pauses wall-clock time while
inference runs: it hides the actual backlog we need to measure.

If the tail floor or finalisation contention eliminates the benefit, do not implement production sessions just to
show subtitles. Move to the separately scoped backend comparison or keep today's pipeline.

## 5. Candidate recognition policy

Starting parameters below are experimental, not established optimal values:

- First provisional decode after about four seconds of captured audio; short utterances use baseline decoding.
- One inference in flight. At most one pending snapshot, replaced by newer audio rather than queued repeatedly.
- Next preview only after the preceding decode ends and at least two seconds of new audio are available.
- At most three preview decodes in the existing twenty-second recording limit; final work has priority over previews.
- Compare two hypotheses covering the same global audio interval. Initially use cumulative audio, avoiding
  unnecessary rolling-window trimming within our short capture limit.
- Mark a matching prefix stable only behind a 1.5–2 second provisional margin. Preserve original text; normalise
  Unicode/spacing for alignment only. Do not equate different numbers, transliterations or negations heuristically.
- A matching prefix can be revised before submission. “Stable” describes preview agreement, not semantic certainty.

At release, stop scheduling previews and freeze the exact final sample count. Finalisation options:

1. If an already-running decode covers exactly the final samples, await/reuse that result.
2. If there is a usable stable boundary, decode from at least two seconds before it through the exact last sample.
   Merge only when timestamp order and the textual overlap agree unambiguously. The tail is authoritative for its
   overlap; conflicting text, repeated phrases or uncertain boundaries trigger full-recording fallback.
3. With no safe boundary, decode the full recording. Do not force a split to manufacture a latency gain.

The final tail always includes the release boundary, including the last word. Never reuse a result that ends before
newly captured speech merely because VAD thinks the remainder is silent. VAD can later inform scheduling; it must
not end the hold, drop audio or authorise cached-result reuse in v1. TV dialogue is speech to VAD too.

Keep global sample offsets for every decode. Validate coverage on the assembled transcript and original recording,
and inspect each decode's local coverage. Do not assume broad timestamps prove every word is present. Existing
coverage warnings continue to disable tools for the accepted turn. Suspected stitch loss first triggers full decode;
if that also fails, report failure/uncertainty using the existing path, never execute a fragment silently.

An HTTP abort does not reliably interrupt native GPU inference. Finalisation may have to wait for an obsolete
preview, then decode the tail/full recording. Count this explicitly; there is no assumed preemption benefit.

## 6. Session transport, only after Phase 0 passes

Use small authenticated HTTP requests over the existing Pi-to-laptop connection. Reuse browser status polling.
A WebSocket, Redis, database, external broker or second browser service is unnecessary for one manual session.

Proposed gateway contract (new routes; not implemented):

| Request | Purpose and validation |
| --- | --- |
| `POST /microphone/session` | Create one bounded session; server generates an unpredictable ID and generation. Fixed PCM format; no client model/path/options. Return protocol capabilities. |
| `POST /microphone/session/<id>/audio` | Binary PCM with sequence number and starting sample offset. Require contiguous, even-sized data and cap body size. Exact retries are idempotent; conflicting duplicates/gaps are rejected. |
| `GET /microphone/session/<id>` | Return revision, received-through offset, decode-through offset, provisional/stable text and state. Bearer authentication and no-store headers. |
| `POST /microphone/session/<id>/finish` | Supply exact final sample count after every packet is acknowledged. Seal input; finalise once. Duplicate finishes return the same state/result, not another job. |
| `DELETE /microphone/session/<id>` | Cancel and discard pending work. Late native results cannot publish into this or a newer session. |

Transport starts with 250–500 ms packets (8–16 KB at 32 KB/s), one append in flight, and at most one second of
unsent audio. Packets transport samples; they are not independent transcription jobs. Retain the full original PCM
on the Pi, at most 640,000 bytes per capture. Never drop packets just to stay “live.” A slow connection disables
streaming for that capture and preserves baseline fallback.

The create/append/status handlers must not wait for GPU inference. Protect state with short locks and hand off
immutable snapshots to a worker. Use one active GPU job across previews, finalisation and GPU diagnostics.
Final jobs outrank pending previews; cancel obsolete previews that have not started. Never preempt/restart the
recognizer to cancel an in-flight job. Existing CPU WhatsApp transcription may remain independent, with its own
bounded scheduling; preserve its admission limits and the native-timeout recovery policy.

Do not acquire the current gateway-wide lock for the entire held session. Refactor scheduling explicitly, or the
new feature would make other people's voice notes fail while the owner is speaking.

## 7. Lifetime, failures and privacy

Use separate capture identity, transport session identity and monotonically increasing status revision. The browser
receives Pi status only; it never receives the laptop secret or direct access to recognition routes. Maintain the
current owner checks, expiring control link, origin restrictions, hold lease and capture limit.

Initial server bounds: one active mic session, 20 seconds/640 KB PCM, ten-second append inactivity expiry, and
thirty-second absolute lifetime while capturing. Finishing has a separate bounded inference deadline, initially
aligned with the existing recognizer request timeout; expiry cancels publication even if native inference continues.
Hold expiry/cancel on the Pi closes the laptop session promptly. Network failure also expires server state without
requiring a cleanup message to arrive.

Keep at most one completed result for sixty seconds to make retries idempotent; keep cancelled/expired identifiers
as bounded tombstones without content. Release audio after finalisation or expiry. The Pi's existing manual replay
copy keeps its current limits. No streaming audio, partial text or model debug files enter disk backups/journald.
Python/native allocators can retain freed memory; do not claim secure zeroisation across all runtime copies.

Failure behaviour:

- Before release: if streaming breaks, keep local capture and use the full-WAV path on release.
- After release: use one full-recording fallback only after the worker is known idle/healthy. A timed-out native
  job may still own the GPU; respect recovery instead of immediately submitting another decode.
- Cancel, lease expiry or capture-limit failure: no baseline fallback, no assistant turn.
- Lost final response: fetch the existing session result, not a new transcription job or assistant invocation.
- Laptop/Pi restart: do not replay partial recordings. Report interruption and require a fresh hold.
- Unknown protocol or streaming disabled: preserve the current `/microphone` route.

Exactly one accepted final transcript may enter `converse` for a capture ID. Late results must fail a generation
and cancellation check immediately before enqueueing. Partial text never reaches the model, memory, reminders,
music or outgoing drafts. Preserve spoken-approval restrictions in `agent.ts`; this change grants no abilities.
Cancellation after a final turn is already enqueued retains the existing limitation: it cannot recall an action or
WhatsApp send already underway. Make that state visible instead of promising absolute cancellation.

## 8. UI and observability

Keep the circle, level meter and current controls. While held, show “Draft hearing…” and provisional text. Clearly
separate this from the final “Heard…” text. Do not announce every revision through the accessibility live region.
On release show “Finishing transcription,” then the existing assistant-queue status. On streaming fallback show
“Finishing with the full recording,” without exposing backend jargon. Phone page visibility must not be required
for finalisation after a valid release.

Use monotonic clocks for durations; do not subtract Pi and laptop wall clocks. Record content-free counters:

- capture duration, first partial delay, last partial lag;
- audio append RTT, release-to-last-ack, release-to-final transcript;
- native decode durations, GPU wait, preview count, processed-audio seconds;
- fallback reason enum, cancellation count and transport-gap count;
- existing queue/model/send acceptance times.

Keep `transcriptionMs` meaning release-to-final, even though work began earlier. Add pre-release work separately.
If measuring button-release transit, send a browser performance duration rather than mixing unsynchronised clocks.
WhatsApp send acceptance remains distinct from arrival on the owner's phone. No transcript-derived language labels
or content should enter general logs; use manually labelled benchmark cases for per-language comparisons.

## 9. Acceptance gates

These are proposed engineering thresholds, not measured results or promises.

Use at least 24 distinct utterances: eight English, eight Hinglish and eight boundary/stress cases, with three warm
replays each. Treat 72 runs as repeated measurements of 24 examples, not 72 independent accuracy examples.
Include short/long speech, continuous speech, pauses, mid-word release, stutters/corrections, quiet voice, TV,
code switches at a boundary, technical names, “don't/mat,” “fifteen/fifty,” relative times and two requests in one turn.
Have the speaker provide the actual words independently; never feed expected text into recognition prompts.

Ship only if:

- English and Hinglish each show a useful median release-to-final reduction, initially target at least one second.
- p90 does not worsen by more than 0.5 seconds versus paired baseline on either language; investigate all outliers.
- No new number/negation/action/person/time error appears in the reviewed set; investigate any critical error even
  if both baseline and candidate make it. Report transcription error rate alongside semantic cases.
- No missing/duplicated boundary speech; full fallback remains exceptional (initial target below 20% overall,
  with per-language rates reported). A high fallback rate means the approach is not ready.
- Short inputs are not routinely slower; concurrency with ordinary voice notes stays bounded and responsive.
- No GPU OOM, unexplained memory growth or dropped transport samples in a 50-session soak.

Tests cannot prove perfect understanding. If gains are confined to a subset, report that honestly and keep the
feature opt-in rather than automatically detecting language to select a path.

## 10. Implementation sequence and files

| Stage | Files / work | Exit condition |
| --- | --- | --- |
| A: diagnostic | Add `speech/benchmark-incremental.py` and machine-readable aggregate output | Real-time replay compares unchanged baseline, preview control and tail candidate. No assistant starts or sends. |
| B: algorithm | Add `speech/incremental.py`: backend adapter, hypotheses, offsets, reconciliation, worker state | Fake-backend race/alignment fixtures and actual-language corpus pass; measured benefit established. |
| C: gateway | Extend `speech/server.py`; add protocol fixtures | Auth, bounded sessions, idempotent appends/finish, TTL, generation checks and native recovery work. Old endpoints remain compatible. |
| D: Pi client | Add `src/microphone-stream.ts`; integrate capture/finish/cancel in `src/microphone.ts` | Packet order, exact final count, fallback and exactly-one enqueue verified with mocked transport. |
| E: UI/config | Extend `assets/microphone.html`, `src/config.ts`, `.env.example`, speech/docs | Optional `INKLING_MIC_INCREMENTAL=true`, default off; provisional/final states clear. |
| F: canary | Laptop gateway first, Pi client second; enable owner manual mic only | Real English/Hinglish trials pass, then review before leaving enabled. |

Keep backend details behind the adapter; avoid exposing tuning knobs for every experimental parameter in production
configuration. Maintain existing provider abstraction and compact voice replies unchanged.

Test cases must include release during decode, rapid release before session creation, release with final packet in
flight, identical/conflicting retries, missing/out-of-order samples, stale status, cancel versus finish races,
hold expiry, hidden page, unregistered owner, oversized input, stalled capture, final timeout, lost responses,
repeated words in overlap, Hindi script changes, invalid timestamps and native work continuing after HTTP abort.
All model/action/message hooks are mocked for integration fixtures. No fixture sends an email, invite or WhatsApp.
Use scratch encrypted stores for TypeScript fixtures and remove them afterwards. Run `npm run typecheck`, Python
syntax checks and `git diff --check` for implementation changes. Do not run a second WhatsApp instance.

Roll back by disabling `INKLING_MIC_INCREMENTAL` and restarting only the affected assistant service; keep the
warm recognizer and full-WAV endpoint. No data migration is needed. A new backend, if needed, gets a separate
installation/memory test and explicit cutover, not an implicit replacement of the working service.

## 11. Deferred alternatives and stop conditions

If the existing decoder's tail latency floor is too high, compare **batch and incremental** faster-whisper turbo
using a suitable quantized configuration. A faster batch backend might beat a complicated streaming adapter.
Do not run two resident GPU backends blindly on a 4 GB card; schedule an isolated trial and restore the baseline.
Verify CUDA/cuDNN and checkpoint conversion without modifying the system driver to chase an unmeasured gain.

SimulStreaming is a later candidate only after a smaller model's fit, recognition quality and dependency costs
are demonstrated. Its recommended full-size setup exceeds this GPU's memory. A different true-streaming ASR model
would require a separate Hinglish/accent evaluation; multilingual marketing is not evidence of code-switch accuracy.

Defer speculative GLM responses, early tool execution, extra transcription models, speaker identification, VAD
endpointing and wake words. They do not answer the current question: can useful recognition be finished while the
owner is still speaking, preserving the transcript quality already achieved?

The first deliverable should be the benchmark and an honest go/no-go result. If it fails, the correct outcome is
to keep the reliable eight-second English loop and target the measured bottleneck through another approach.

## 12. Implemented v1 and measured decision

The initial whisper.cpp approach failed the cost-floor gate: two warm public-sample probes per length measured
median 4.268 seconds for 2 seconds of audio, 4.222 for 4, 4.255 for 8, 4.414 for 12 and 4.481 for 20. The 12/20
second probes repeated the eleven-second public source; they measure compute cost, not independent accuracy.
Reducing the encoder window made some decodes faster but produced inconsistent results, including a four-second
clip returning one token in one trial and extensive output in another. That setting is not enabled.

A separately installed CTranslate2 backend, faster-whisper 1.2.1 / CTranslate2 4.7.2, runs the multilingual turbo
checkpoint using `int8_float32`, beam five, Hindi-mode transcription, fixed neutral hint, no translation and no
previous-text conditioning. On the same warm probes, medians were 1.057, 1.074, 1.109, 1.161 and 1.278 seconds.
These runs used the local GPU; they do not establish owner-accent or Hinglish accuracy.

This changes the implementation decision: recognise cumulative audio for live drafts, then decode the **entire
exact final recording once** at release. No agreement-derived text is spliced into the actionable transcript.
The faster backend supplies the main latency saving; streaming supplies early visibility. A fast whole-recording
pass avoids the additional uncertainty and complexity of tail merging. Comparison with this backend in batch
mode must not be misrepresented as a streaming speedup.

The session worker starts previews at four seconds, permits at most four with four seconds of fresh audio
between them, runs one native decode at a time, and discards stale/cancelled results. Local agreement is only
display metadata, never proof of correctness. The final pass preserves coverage warnings and existing tool restrictions.
Both the Pi mic and supported browser mics feed 16 kHz PCM. Browser packets are batched into roughly half-second
requests and the streamed prefix is hashed against the final WAV; missing trailing samples come from that WAV.
Backpressure, conflicts or failed streaming trigger a bounded fallback only after native work is known idle.
Normal CPU voice-note transcription remains separately queued; finishing a GPU session does not wait behind it.

A real-time replay of the eleven-second public sample produced two distinct drafts and a final result 1.258
seconds after release locally. Through the actual Pi client and authenticated laptop connection it took 1.429
seconds, with no coverage warning; the known English negative phrase was preserved. This excludes GLM and
WhatsApp. Observed GPU use with both recognizers resident was 2,032 MiB of 4,096 MiB; gateway resident memory
was approximately 1 GB. These are observations, not hard resource reservations.

Nine Python fixtures cover native-stall recovery, worker/protocol ordering, TTL, cancelled native calls, exact retry, conflicts, full
final coverage and idempotent finish. Mocked TypeScript/browser fixtures cover exact PCM packets, hash mismatch,
backpressure, private partials and a single final enqueue. Existing webhook/proxy tests pass. No fixture sends
messages, emails or invites. No live room recording was taken for these benchmarks.

Rollout is **opt-in**: configure the laptop's local incremental model and `INKLING_MIC_INCREMENTAL=true` on the
Pi, then select “Live transcript (experimental)” on the private mic page. It starts unchecked. The default path
remains the previously working recognizer. User English/Hinglish trials, noisy-room cases and the larger
acceptance corpus are still required before making it the default or claiming representative accuracy.
