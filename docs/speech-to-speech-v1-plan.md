# Speech-to-speech v1: one mic, one speaker, the existing assistant

Status: initial implementation built; voice-quality and live conversation acceptance remain pending. Written 2026-10-14.
For the full direction, measurements, alternatives and sources, see [the epic](speech-to-speech-epic.md).
When scope differs, this document defines v1.

The full-WAV baseline below remains available. A subsequent optional [phrase-output optimisation](speech-phrase-latency.md)
adds bounded chunks and one continuous player after the same final-text checks; it does not change input or identity.

## The smallest useful release

The owner unmutes the physical Pi microphone, speaks, then mutes. The existing transcription and assistant
produce the usual checked answer. The laptop's existing Kokoro service turns that answer into one WAV. The Pi
plays it on one explicitly configured speaker. The same answer still goes to the owner's private WhatsApp.

No new assistant, model, memory store or background listening behavior. No change to other users' conversations.

```text
Existing physical mic -> existing transcription -> existing assistant + final checks
                                                        |
                                               final answer text
                                                /             \
                                      WhatsApp text         Kokoro WAV
                                                               |
                                                     one configured Pi sink
```

## Scope boundaries

| Included | Deferred |
| --- | --- |
| Owner's physical mute-switch conversations | Browser/phone audio playback or an output selector |
| One configured Pi speaker, explicitly enabled | Automatic speaker selection or reconnect management |
| Existing English/Hinglish understanding | Guaranteed natural Hinglish synthesis or transliteration |
| One cached voice chosen after listening | Voice cloning, voice gallery or per-sentence voice switching |
| Complete validated answer, complete WAV | Model-token, sentence or PCM streaming |
| Stop old audio when a new unmute is detected | Always-on conversation, wake words or acoustic barge-in |
| WhatsApp text independent of speech success | Spoken WhatsApp replies, calls or proactive announcements |
| Clear status, bounded work and metadata logs | Music ducking or changes to the music queue |

The room speaker is a shared physical output. Enabling it intentionally makes the owner's mic replies audible
in that room. Typed replies, mail alerts, group messages and friends' microphone requests must not be read aloud.
V1 does not make room playback independent of the existing WhatsApp-connected conversation service.

## Reuse what works

Keep warm capture, mute detection, incremental recognition, final decode, encrypted history, per-person queues,
the conversation fast path and normal tools. Keep every final reply check in `agent.ts`. Only final text returned
by `respond()` is eligible for synthesis; internal routing markers and intermediate tool replies are never speech.
Outgoing messages, mail and invites retain later typed approval. Hearing a spoken yes changes none of that.

Reuse the laptop's CPU Kokoro service through the existing authenticated speech gateway/tunnel. Do not run
another model process on the laptop or move TTS to the 2 GiB Pi. Add one bounded gateway operation, one small
Pi client/playback module and a narrow hook at the final-answer boundary in `index.ts`.

Register the physical capture ID directly with the speech controller from the trusted capture callback,
never from model output or an HTTP caller. Keep this eligibility only in RAM rather than adding a persisted
source marker. Speech eligibility also requires current owner registration, feature configuration, the owner's
explicit enabled preference and a still-current runtime capture token.

## Configuration and controls

Proposed settings, all absent/off by default:

- `INKLING_MIC_SPEECH=true`: installation supports room speech.
- `INKLING_MIC_SPEECH_SINK`: exact configured PipeWire node name, not a transient numeric ID or a default sink.
- `INKLING_MIC_SPEECH_VOICE`: one allowlisted cached Kokoro voice selected during setup.

Reuse the existing speech gateway URL/secret. No model-visible shell or new public service.
Owner-private typed `/mic speech on`, `/mic speech off`, and `/mic speech status` control an encrypted preference.
Off immediately cancels speech. These controls do not disable the existing mic-to-text conversation.
The current `/mic` page may display owner-only playback status; no new audio download route is needed in v1.

## One bounded output controller

One small controller owns the current capture generation, at most one synthesis request and one playback process.
Use explicit states: `off`, `ready`, `synthesizing`, `speaking`, `unavailable`. Attach an utterance ID and a fixed
failure category to state transitions. Do not add a speech backlog or a second assistant queue.

1. On detected physical unmute, advance the generation and stop any old playback before accepting new audio.
   Cancel the old HTTP wait where possible. Preserve current first-frame capture; do not add an arbitrary delay.
2. When that turn's final answer is available, start WhatsApp delivery and the speech attempt independently.
   Catch speech failures separately. Do not hold the per-chat assistant queue until the whole audio finishes playing.
3. Before synthesis, reject disabled, stale, non-owner or non-physical turns. Resolve the exact real speaker;
   reject missing/disconnected/muted sinks and `auto_null`. Require the physical transmitter's muted baseline.
4. Submit a bounded full-answer request. Before playback, recheck generation, owner, preference, sink and muted
   input. If any changed, discard the WAV. Never speak a result merely because synthesis eventually completed.
5. Play the WAV through stdin to `pw-play` with fixed argument values. On finish, clear audio and return to ready.
   On failure, keep the text answer and report the speech-specific failure.

The existing detector needs two 100 ms nonzero frames to infer unmute; interruption follows that detection,
not the exact physical button instant. Source loss, switch disable, shutdown and removal of the owner also
invalidate current speech. Stopping speech cannot undo tools already run. Never retry a spoken answer automatically.

Restart starts with no pending speech: even a recovered encrypted incoming message must not replay room audio.
Speech eligibility requires a live in-memory capture token created in this process, not only persisted metadata.

## Explicit bounds and fallback

Start with fixed conservative limits, then change only in response to measurements:

| Resource | Initial bound / behavior |
| --- | --- |
| Synthesis text | At most 800 Unicode code points; longer answers remain text-only, with a clear reason |
| Voice and speed | One configured allowlisted voice; fixed speed 1.0 |
| Active synthesis | One, no waiting backlog; busy returns a controlled failure |
| HTTP synthesis wait | 12 seconds, bounded streamed read even though the response is a complete WAV |
| Audio | Valid 24 kHz mono PCM16 WAV, maximum 45 seconds / 2.2 MB including header |
| Playback | Maximum 50 seconds, bounded termination and kill fallback |
| Retries | None automatically; the next intentional turn is a fresh attempt |

Never silently truncate the answer or ask another model to summarize it. Apply only deterministic formatting
cleanup; if code, dense URLs, unsupported text or excessive length cannot be spoken faithfully, keep text only.
Do not claim that a synthesized file or a successful process means the user actually heard it.

Use native Hindi text only if the selected voice passes listening tests. Romanized Hindi remains an explicit
quality limitation: do not ship automatic transliteration. If it sounds poor, keep v1's spoken output in the
tested language or skip speech for that reply while preserving its written answer. Any change to the assistant's
reply-language preference must be an explicit user choice, not a hidden TTS translation call.

Aborting an HTTP request does not necessarily stop CPU inference inside the existing Kokoro process. Keep a
single-flight guard until work has actually settled, and discard stale results. The gateway must not turn
repeated interruptions into concurrent synthesis or a growing upstream lock queue. If upstream completion is
unknown after timeout, fail speech closed until health/busy recovery is established; text conversations continue.

Do not touch music state. Initial room tests run without music. If music is active, skip speech with a visible
reason rather than compete at full volume. Music coexistence can be a separate measured change later.

## Debugging without private content

Keep the normal WhatsApp answer as the baseline. Owner status should distinguish speaker unavailable, busy,
timeout, unsupported/long answer, cancelled by a new turn and successful process playback. Rate-limit user
notices so repeated failures do not spam WhatsApp; give details on the status command/page instead.

Log utterance ID, stage, duration, byte count and fixed failure category only. Add timestamps for final text,
synthesis start/finish and playback start/finish. Continue the existing transcription/agent/WhatsApp timings.
No prompts, reply text, raw audio, tokens, credentials or user names in logs. Audio exists only in bounded RAM
and process pipes. Pi-owned buffers are cleared after completion/cancellation and Python response bytes are released, with no saved files.

## Atomic implementation steps

1. **Bounded gateway/client.** Synthetic input returns a valid WAV through the private tunnel. Test caps, busy,
   timeout and authentication without playback or sending messages. Keep live speech off.
2. **One real speaker.** Connect the intended sink. Play explicit synthetic samples and select a cached voice.
   Confirm intelligibility and volume in person; compare English, Hindi and mixed text honestly.
3. **Output controller.** Test state transitions and cancellation using fake transports/player processes. Prove
   old results cannot speak after a new turn, disabled preference, source loss, owner removal or restart.
4. **Assistant integration.** Add only the final-text hook and trusted physical marker. Confirm WhatsApp still
   succeeds when TTS fails, and speech can proceed if text delivery fails after the turn has been accepted.
5. **Opt-in live trial.** Enable for the owner and run the acceptance cases below before calling v1 complete.

Use repository typechecking and isolated `src/zz-*.ts` fixtures with fictional users and scratch encrypted data.
No real WhatsApp, email or invite sends from tests. Remove fixtures afterwards. Keep all deployment identities
and secrets out of committed examples. Rollback is speech off; the working text flow must remain intact.

## Acceptance: what must work consistently

- Ten consecutive normal short turns: one checked written answer and at most one correct spoken answer each.
- Voice trial includes English, Hindi/Hinglish, negation, a number and a time; unclear pronunciation is recorded
  as a limitation rather than marked passed because the endpoint returned audio.
- New unmute during synthesis or playback: old audio never starts/resumes, and first-word capture is preserved.
- Missing speaker, disconnected laptop, busy/timeout service or failed player: text still works, status says why.
- Long/unsupported answer: no partial misleading speech, no extra model call, normal full text answer.
- Typed owner turn, friend/group turn, browser upload or proactive alert: no room speech.
- Restart, recovered message, disabled switch/preference or lost registration: no stale room playback.
- Spoken confirmation still cannot send an email, invitation or message as a person.
- Measure mute-to-first-playback latency on ten turns, report median/range and failures alongside STT/model/TTS
  durations. The observed 1.6-2.9 s synthesis samples are evidence for feasibility, not an end-to-end guarantee.

V1 is complete when these pass and the user confirms the room experience is reliable. Streaming, browser output
and music ducking require their own small follow-up plans; they are not prerequisites for releasing this version.
