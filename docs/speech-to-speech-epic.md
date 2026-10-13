# Speech-to-speech epic: give the existing assistant a local voice

Research and read-only service inspection: 2026-10-14. Proposal only; speech playback is not enabled.

This document describes the overall direction and supporting evidence. The implementation scope for the first
release is deliberately smaller: see [the v1 plan](speech-to-speech-v1-plan.md). Browser playback, mixed-language
rendering, music ducking and streaming below are later candidates, not requirements for the first release.

## Decision

Keep incremental microphone transcription and the existing assistant turn. Add the laptop's already-running
Kokoro service as an optional output renderer. Play approved final reply text on an explicitly selected endpoint.
Send the same reply to WhatsApp independently. Do not create a second assistant or a separate memory system.

```text
Pi mic / page mic -> existing incremental transcription on laptop
                 -> existing Pi assistant queue, private memory, model, tools, final checks
                 -> final reply -> laptop Kokoro -> Pi speaker OR originating browser
                                -> WhatsApp text, independently
```

## What is installed and what was measured

The laptop has whisper.cpp for voice notes, a warm microphone whisper.cpp recognizer, the incremental GPU
gateway, and a running custom Kokoro service. Kokoro listens on loopback port 8880 and exposes `/health` and
`/v1/audio/speech`. English and Hindi pipelines are loaded. Its implementation produces 24 kHz mono PCM16 WAV,
uses CPU inference, serializes synthesis with one lock, and buffers the whole reply before responding.
It is not the full Kokoro-FastAPI distribution; upstream streaming examples do not mean this deployment streams.

The existing Kokoro process accounts for roughly 2.8 GiB in its service memory cgroup. The laptop had about
7.6 GiB available memory during inspection; the two GPU recognition processes used about 2.1 GiB of 4 GiB VRAM.
Reuse the service rather than loading another TTS model or moving synthesis onto the 2 GiB Pi.

Synthetic requests were generated in RAM and discarded, without room playback, real user text or file storage:

| Sample | Synthesis / first response | Generated audio duration |
| --- | --- | --- |
| English, 19 words, existing male voice | 1.75 s; repeat 1.69 s | 4.88 s |
| Hindi in Devanagari, existing female voice | 2.81 s | 8.15 s |
| Romanized Hinglish, same Hindi voice | 2.90 s | 8.38 s |
| Short English reply, cached female voice | 1.74 s | 3.77 s |
| Short Hindi reply, same female voice | 1.56 s | 4.38 s |

These establish successful synthesis and rough speed, not pronunciation or voice quality. First-response timing
includes HTTP setup and synthesis because the installed endpoint buffers the entire WAV. Measurements were sequential,
not a concurrency or cold-boot benchmark. Listening tests remain required, especially for Hinglish.

The Pi has `pw-play` and PipeWire. At inspection its only sink was `auto_null`: no real speaker was connected.
Playback must reject that sink rather than report a successful but silent response.

## Which existing steps are necessary?

| Step | Decision and evidence |
| --- | --- |
| Warm capture, unmute/mute detection | Keep. This is the user's working explicit turn boundary; no wake-word migration. |
| Incremental transcription and full final decode | Keep. Already overlaps work with speaking and supports the tested English/Hinglish input. Partial text must not trigger tools. |
| Per-user queue and encrypted context | Keep. They make this the same assistant and prevent races with typed messages. |
| Normal model and tool loop | Keep. Needed for personal answers and actual actions. Keep the no-tool conversation fast path. |
| Final reply validation and cleaning | Keep. `agent.ts` can reroute, retry or replace a draft after detecting internal markers, missing results or false action claims. |
| WhatsApp delivery before output | Remove as a dependency. Once final text is ready, launch speech and text delivery independently. |
| Ogg/Opus voice-note packaging | Skip for room/browser speech. PCM or WAV goes directly to playback. |
| Second model to rewrite every reply for speech | Skip. It adds latency and can alter meaning. Use deterministic formatting cleanup and keep replies concise. |
| Cloud audio upload / native audio model | Not needed for v1. Current transcription works; a local synthesizer already exists. |

`src/index.ts` currently waits for `respond()` and then sends microphone replies through WhatsApp. Add speech at
that final-text boundary, before awaiting delivery. Preserve the current encrypted history and outgoing-approval
rules. A spoken yes must still not authorize an email, invitation or message sent as a person.

## Output and interaction design

Room mode is owner-only and explicitly enabled. Use a configured real PipeWire sink with a bounded `pw-play`
process and stdin audio, never a model-supplied command or default fallback sink. Verify sink presence before
synthesis and playback. Do not reconnect to an arbitrary speaker or read a private answer into a different room.

Page mode plays only in the initiating authenticated session, with an explicit Enable spoken replies gesture
to unlock browser audio. Device-mic replies should default to that device rather than the room speaker.
An output selector can offer Text only, This device and Pi speaker, independently of input selection.
Do not broadcast audio to every open page or expose one person's reply to another session.

Turn behavior: listening -> processing -> speaking -> ready. Physical unmute or a new page hold immediately
stops that endpoint's old playback and discards queued speech before starting the next capture. This stops audio,
not already executed tools. Preserve the current source debounce and first-frame capture. Suppress stale output
using request IDs; after a new turn begins, an older completion must not begin speaking.

With physical control, the transmitter is muted while Ellie replies. If it becomes unmuted before playback begins,
hold or drop speech rather than play into an open room microphone. Use explicit interruption instead of automatic
speech detection: the nearby TV has no available playback reference for reliable echo cancellation.

Do not modify the music queue for TTS. If music ducking is added, implement a temporary gain lease that respects
manual volume/pause changes and restores on failure. It can follow the first room-speaking test; never implement
it as stop/clear/requeue. Missing speakers or failed synthesis leave WhatsApp text available, with clear page status.

## English and Hinglish

Keep recognition language independent of reply voice. Kokoro has English and Hindi voices, but Hindi support is
not evidence of reliable Romanized Hinglish pronunciation. Use cached female English and Hindi voices for a
short listening trial, including names, negation, dates, numbers and English words inside Hindi sentences.

Prefer native Hindi script for Hindi speech input to the synthesizer. Do not blindly map Roman letters to Hindi
or silently rewrite numeric/time meaning. First ship understandable English spoken replies if mixed-language
quality is inadequate, with the normal written reply preserved. If Hindi speech requires a separate rendering,
evaluate adding it to the same existing model response rather than adding a second model round trip. Validate
any dual rendering for matching numbers, negations and action status before using it.

## Latency and streaming

First establish one bounded full-WAV reply through the existing service. On these samples TTS adds roughly
1.6-2.9 seconds after final text; speaker/Bluetooth/browser buffering adds more. This is not yet a measured
end-to-end speech latency. Measure mute -> final transcription -> final model text -> first audio byte ->
playback start, alongside WhatsApp timing. Playback start is not proof of audible sound in the room.

Then extend the small existing server with a bounded authenticated gateway route for PCM streaming. Consume
Kokoro's generator and forward generated chunks as available; the earliest chunk still requires model inference.
Start from the first sensible sentence of the validated final reply, and synthesize later sentences while it plays.
Do not chop decimals, abbreviations, URLs or Hindi sentence endings. Avoid tiny fragments that degrade prosody.
Bound the queue and cancel producer/playback together. Do not add a full streaming framework for one user.

Do not speak raw model tokens yet: the compact microphone answer may contain structured routing data, and
post-generation validation may replace it. Once spoken, a false action claim cannot be retracted by text cleanup.
Safe model-token speech would require a redesigned commit boundary and is a separate optimization.

## Transport, limits and failure behavior

Reuse the authenticated private Pi-to-laptop speech tunnel. Keep Kokoro loopback-only. The current raw endpoint
has no application-level authentication or input cap: expose only a gateway operation with strict text length,
allowed voices, speed range, timeout, byte limits and one active request per endpoint. Avoid logging text/audio.
Cancel or expire queued work; never let an abandoned request hold synthesis indefinitely. Avoid a public TTS route.

Audio stays in bounded RAM, deleted after playback/expiry. Browser audio access uses the existing private session
and request identity, with no public cache. Structured logs contain timings, byte counts and failure categories only.
Do not automatically speak a backlog after reconnect, restart, permission loss or an interrupted turn.
Feature flags remain off until configured; text delivery survives independent speech failure.

## Alternatives and why they are later options

- Piper is a fast local engine and a possible lighter fallback. Installing and evaluating it adds work while
  Kokoro is already operational; no measured advantage on this hardware has been established.
- Gemini Live can consume and emit audio, supports tools and interruption, and may improve natural conversation.
  It requires a different model/session integration, replicated context/permissions and separately checked API
  availability/quotas. The currently configured Flash-Lite model outputs text and does not support Live API.
  Treat this as a future controlled comparison, not a reason to replace the working speech path immediately.
- Browser/OS speech synthesis could be a quick demo, but ties voice and language behavior to each device.
  It cannot deliver consistent physical-mic-to-room-speaker behavior across clients.

Local Kokoro adds no external TTS API fee; it still uses electricity and laptop resources. Existing assistant
model usage continues under its own quota/billing. No new billing or services were enabled during this research.

## Epic milestones and acceptance

1. **V1: owner physical mic to one Pi speaker.** Follow the bounded full-WAV plan in the companion document.
2. **Device-page playback.** Add one initiating browser session, audio unlock, endpoint selection and expiry tests.
3. **Language quality.** Improve Hindi/Hinglish rendering only after controlled listening establishes a need.
4. **Streaming.** Measure first-audio latency; add validated-answer sentence/PCM streaming only if it improves it.
5. **Coexistence.** Consider music ducking and broader access independently, with explicit routing and interruption tests.
6. **Native audio comparison.** Consider a Live model only if the cascade still prevents the desired experience.

Each milestone is independently useful. There is no requirement to complete every candidate; stop adding complexity
when the user has consistent conversations with acceptable latency. None of these milestones adds WhatsApp calls.

Success means the same assistant answers aloud with no additional model call, no extra cloud speech fee, no wrong
recipient, no unintended outgoing confirmation, no stale reply playback, and text fallback when speech cannot play.

## Primary references

- [Kokoro model and generator API](https://github.com/hexgrad/kokoro)
- [Official voice list and language/short-utterance limitations](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md)
- [Kokoro PCM streaming playback example](https://github.com/remsky/Kokoro-FastAPI/blob/master/examples/stream_tts_playback.py)
- [Piper local engine](https://github.com/OHF-Voice/piper1-gpl)
- [Flash-Lite supported inputs and text-only output](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite)
- [Gemini Live audio, tools and interruption](https://ai.google.dev/gemini-api/docs/live-api)
- [Browser autoplay requirements](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay)
