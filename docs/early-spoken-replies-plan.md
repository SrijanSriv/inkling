# Speaking before the complete answer: a plan for Ellie

Research and repository review: 14 October 2026. The architecture below distinguishes preparation from
unchecked early playback. Implementation status: the preparation-first phase is implemented as the
optional `/mic flow early` mode; `/mic flow current` preserves the previous path. The early mode omits the
starting filler as requested. Actual playback before complete-answer validation remains a later experiment.
See [operation and mode switching](../speech/README.md#switchable-early-preparation).

## Recommendation

Keep the working unmute → speak → mute interface, incremental recognition, existing assistant, and laptop Kokoro service. Overlap answer generation with speech synthesis. Introduce audible output before final answer validation only as a separate, opt-in experiment for ordinary conversation.

These are two different changes:

1. **Prepare early, play after validation.** Kokoro generates an opening phrase while Ellie finishes her answer. Audio stays in memory until the complete answer passes today's checks. This is the recommended first implementation.
2. **Prepare and play early.** A complete conversational sentence can reach the speaker while later sentences are still being generated. This needs a different delivery contract: once spoken, a sentence cannot be silently replaced by a retry.

The second option is possible, but it cannot preserve the guarantee that the *whole* answer was checked before any of it was heard. Keeping tool permissions intact is achievable; guaranteeing that an unfinished model response never says something mistaken is not. We should make that distinction explicit rather than calling streamed text “validated” too broadly.

## Why this fits the existing system

Ellie already overlaps transcription with recording and generates speech in natural phrases. The remaining serial boundary is between the assistant's complete checked answer and Kokoro starting work.

```text
Today:
mute → final transcript → complete model answer + checks → first TTS phrase → speaker

First implementation:
mute → final transcript → model streams ───────────→ complete answer + checks
                              └→ first TTS phrase → held audio ─┘ → speaker

Later experiment, eligible conversation only:
mute → final transcript → model streams → checked complete sentence → TTS → speaker
                              └──────────── subsequent sentences ─────────────→

Actions, live lookups and uncertain requests:
mute → final transcript → existing tool loop → complete checked result → speech
```

This remains the same Ellie: same personal context, provider abstraction, permissions, model and WhatsApp history. No second conversational agent, new speech subscription, wake word, or replacement recognition stack is necessary.

### Repository evidence

| Existing component | What it does now | Implication |
| --- | --- | --- |
| `src/ai.ts`, `ResponseStream` | Exposes tool-start events and a final response | Add a normalized text-delta event; do not call provider SDKs from the agent |
| `src/gemini.ts`, `streamed()` | Consumes provider text fragments internally, accumulates them, validates stream completion | Text is already arriving incrementally, but downstream code cannot use it yet |
| `src/voice-context.ts` | Conversation-only draft, or `<VOICE_TOOLS>` to request the permitted tools | Routing is plain text plus a marker, not JSON; the marker must never reach speech |
| `src/agent.ts`, `respond()` | Waits for the complete response, checks claims and tool results, may retry or replace text | A generated prefix is provisional, even if it sounds fluent |
| `src/index.ts` | Starts room speech after `respond()` returns | Add an optional turn-scoped preparation hook without breaking ordinary callers |
| `src/room-speech.ts` | Checks owner, capture identity, mute state, music and speaker; plays bounded audio through one player | Keep these gates at actual playback, including when preparation began earlier |
| `speech/synthesis.py` | Takes complete supplied text, splits it and generates sequential WAV chunks | The existing streaming route streams audio output; it does not accept an expanding text input |

`voiceTask()` explicitly describes itself as a speed hint, not an access check. Likewise, `CLAIMS_ACTION` and reply cleanup catch known patterns; they cannot establish that every English or Hinglish sentence is semantically safe. Neither should become the sole authority for early playback.

## What research supports, and what it does not

**Streaming text into speech is a standard architecture.** ElevenLabs documents beginning speech after enough model words and a comma, rather than waiting for complete sentences. Its streaming guidance also describes the tradeoff between early audio and enough text context for natural pronunciation. This supports overlapping the stages, but does not establish an appropriate chunk size for our CPU Kokoro service. [Conversation flow](https://elevenlabs.io/docs/eleven-agents/customization/conversation-flow), [audio streaming](https://elevenlabs.io/docs/eleven-api/concepts/audio-streaming).

**Streaming validation has an exposure window.** ElevenLabs explicitly distinguishes streaming guardrails, where audio can escape before a block, from blocking validation, which waits first. This is why “check in the background and cancel if wrong” is not equivalent to our existing full-answer gate. [Guardrails, execution mode](https://elevenlabs.io/docs/eleven-agents/best-practices/guardrails#execution-mode).

**Speculative computation and speculative delivery are different.** LiveKit documents starting generation before a confirmed turn end, with optional speculative TTS and discarded work when context changes. Our first step applies that separation after the final transcript: compute ahead, but hold delivery. Starting from provisional recognition before mute is a different optimization and remains out of scope. [Preemptive speech generation](https://docs.livekit.io/agents/multimodality/audio/#preemptive-speech-generation).

**A chained architecture remains useful for control.** OpenAI describes both speech-to-speech and chained voice architectures. We already have the latter, with explicit text and tool boundaries worth retaining. This does not tell us the exact internal implementation of ChatGPT Voice, and we should not claim that it does. [Voice agents](https://developers.openai.com/api/docs/guides/voice-agents).

**Tiny Kokoro fragments are not automatically better.** Kokoro's voice guidance warns about short inputs; our own measurements already favored natural openings over four-word fragments. Keep that evidence rather than copying another vendor's comma policy. [Kokoro voice guidance](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md), [local measurements](speech-phrase-latency.md).

## First implementation: speculative opening audio

### 1. Expose text through the provider abstraction

Extend `ResponseStream` with a typed text-delta event containing output identity and appended text. Keep tool events separate. Add cancellation support through `responses().stream()` and its adapters.

For Gemini, emit only user-visible content fragments. Never emit function arguments, signatures, refusal metadata or reasoning as speech. Preserve the existing function-fragment assembly and stream-completion checks. Its current listener array ignores event names, so it must become event-specific before introducing another event type.

Register listeners before starting consumption; invoke `finalResponse()` once and continue awaiting it while preparation runs. Native, Gemini and Claude adapters must share documented semantics. Unsupported adapters fall back to today's complete-answer behavior. Text callbacks must not block model consumption or start another model request.

### 2. Prepare one opening phrase, without playing it

Only the live owner's physical-microphone turn is eligible initially. Do not prepare from partial transcription, recovered messages, automatic jobs, group replies or another person's turn.

An optional callback in `respond()` sends provisional text to a small preparation coordinator. Start with the existing conversation-only draft path; no synthesis during tool-capable steps, correction generations, uncertain recording coverage, or draft confirmations.

Buffer enough text to find one natural opening boundary. Reuse the existing punctuation and abbreviation logic, with its measured minimum sizes. No per-token synthesis, arbitrary word slicing or generated filler sentence. If the first phrase is incomplete, unsuitable, or already the whole short answer, use the normal path.

Permit at most one speculative opening synthesis per turn. Keep its exact source text and validated PCM in bounded memory. This deliberately limits wasted CPU and avoids occupying Kokoro with an entire rejected draft. A task can still route to tools later; discard the prepared phrase if it does.

### 3. Commit only against the final checked answer

After `respond()` finishes its normal checks, apply the same deterministic speech-text conversion to the final answer. Reuse prepared audio only if the opening phrase matches an exact prefix of that converted answer, with a valid phrase boundary.

If a retry, cleanup, refusal, routing marker, tool call, unsupported text or normalization changes the opening, discard it and synthesize the final reply normally. Do not use approximate similarity, an LLM decision or a hash alone to authorize reuse. Unsuccessful provider completion never commits prepared audio.

Play the cached opening once, then synthesize the exact remaining text using the existing natural phrase policy. Preserve the single player and utterance-wide bounds. Match across Unicode boundaries and account for separators explicitly so words are neither duplicated nor omitted.

This requires a prepared-opening input to the speech coordinator, not a second call to `RoomSpeech.reply()` that would play the answer twice. The agent still returns one final WhatsApp answer and stores history once.

### 4. Preserve cancellation and resource ownership

Tie preparation, held buffers and playback to the existing capture generation. A newer unmute, disabled speech, removed owner or lost source invalidates that generation. Recheck speaker and music immediately before playback; earlier successful checks are not sufficient.

Keep the current 800-code-point, eight-chunk, 2.2 MB and 45-second audio limits across the combined prepared and remaining audio. Keep existing synthesis deadlines and upstream recovery behavior. One synthesis operation may remain busy briefly after cancellation; do not start overlapping replacement requests until it has settled.

Retain the cached curious acknowledgement. Cancel it when actual answer playback starts, and wait for its player to close before starting the answer. Prepared audio alone must not suppress the cue if validation still needs time.

This phase needs no new public endpoint, long-lived text session, extra inference model or persistent audio cache. Any small gateway change must retain the existing authentication and single-flight synthesis ownership.

## Later experiment: actual early conversational playback

Only attempt this if measurements show enough generation time remains after the opening sentence. It is a distinct feature flag, off by default, with the preparation-only mode as its fallback.

### Eligibility and routing

Use a complete, fixed route prefix for this experimental conversation-only model step, for example `CHAT\n` or `TOOLS\n`. Consume that prefix in code, never in speech. In `TOOLS` mode, buffer and use the existing permitted tool loop. In `CHAT` mode, no tools are offered or executable by this generation.

This changes the current draft protocol and requires explicit parser tests. Malformed prefixes, mixed control text, tool events or unexpected output stop early delivery. The route is a model decision, not a permission grant or proof that the answer needs no lookup. Existing input checks may veto streaming; an unfamiliar request defaults to the checked path. Do not add a second routing model call by default: its latency could consume the entire benefit.

Initially exclude action requests, current-state questions, outgoing drafts, ambiguous times/names/negation, high-stakes advice and responses needing links/code/structured data. This exclusion reduces exposure, but it is not a mathematically complete classifier, especially in Hinglish.

### Sentence commits instead of raw token playback

Start with complete sentences, not comma fragments. Validate each candidate sentence together with the already committed prefix for unsupported formatting, control markers, known action claims and other existing deterministic constraints. Buffer sentence fragments and dependent openings such as “Yes, but…” until complete. Short answers may finish before this helps; that is acceptable.

Passing these checks means only “eligible for this experimental delivery policy.” It does not mean factually verified or immune to later contradiction. Even a complete sentence can be revised by a later one. More aggressive phrase playback can follow only if listening tests show a worthwhile gain.

### One bounded utterance coordinator

For this experiment, use a Pi-side coordinator feeding sequential complete phrase requests to the authenticated gateway. Reuse the existing WAV validation and one continuous player; do not build a general WebSocket platform first.

The coordinator needs explicit `begin`, `append`, `finish` and `cancel` lifecycle operations locally. Each phrase is immutable once committed, gets a sequence number, and counts toward cumulative limits. Bound pending work to two text phrases and one synthesis request. If generation outruns that queue, stop speculative advancement and retain remaining text for the final path; never drop words. Avoid hundreds of tiny HTTP calls.

No gateway lock should wait indefinitely for future model text. Proposed additional limits: five seconds without a new complete phrase and a 30-second overall text-generation deadline. Expiry cancels remaining early speech and reports a partial-delivery outcome. Tune these from observed timings, rather than extending the existing 12-second synthesis timeout to cover model thinking.

At normal model completion, reconcile all committed text against the final speech text. Exact agreement permits the remaining suffix to finish. A final completion marker is still required; transport EOF alone cannot mean success.

### Failure after something has been spoken

Before playback, discard and fall back silently. After playback, stop unsent audio immediately. Never silently retry a different answer as though the first sentence was never heard.

If the final checks reject or revise a spoken sentence, produce an explicit correction through the checked path, such as “I need to correct that…” followed by the actual correction. If generation simply fails, tell the owner that the spoken answer was incomplete. Do not invent an action failure when no action ran. An interrupted user turn cancels the rest without forcing a correction over their new speech.

Tool execution remains behind the existing complete-response and access checks. A cancelled speaker does not undo a reminder or email already sent. Action confirmations remain on the complete checked path in this version, even after successful tools; streaming their later explanation would need a separate review.

## History, privacy and diagnostics

Keep generated text, WhatsApp delivery and room playback as separate outcomes. A player accepting PCM does not prove that a person heard it. Record only estimated playback progress, interrupted/incomplete status and the capture identifier. If a correction was spoken, preserve that correction in the encrypted conversation record too; do not let future turns assume the full original answer was heard.

Audio and speculative text remain in memory and are released on completion or cancellation. Operational logs contain timings, sizes and reason codes, not transcript fragments, personal context or raw audio. No new access to other users' memories or mail is introduced.

## How much faster could this be?

Our earlier observations put no-tool model turns around 1–1.5 seconds and a warmed nine-word Kokoro opening around 0.9 seconds. These are historical samples, not a fresh benchmark of every present request.

Let `M` be complete model time, `P` the time when an opening phrase becomes available, and `S` its synthesis time. Ignoring unchanged transport/setup costs:

```text
Current first audio:       M + S
Prepare, validate, play:   max(M, P + S)
Actually play early:       P + S
```

The first phase saves at most `min(S, M − P)`. If the phrase arrives near the end, the saving is small. Actual early playback buys additional time only when synthesis finishes before model validation does. For a one-sentence answer, both schemes may converge on the same timing. Do not promise several seconds from removing a roughly one-second model boundary.

Example only: `M=1.5 s`, `P=0.5 s`, `S=0.9 s` gives 2.4 seconds today, 1.5 seconds with prepared audio, and 1.4 seconds with actual early delivery. Here the riskier mode buys only another 0.1 seconds. Long streamed answers could benefit more; measurement decides.

## Implementation order and acceptance

1. Add normalized provider deltas and cancellation; run in shadow mode with timing-only logs. Verify identical final responses and one model request per generation.
2. Add one speculative opening plus final-prefix reconciliation. Keep playback gated. Compare matched synthetic conversations with the feature on/off.
3. Enable preparation for the owner after cancellation, routing and failure checks pass. Keep it only if first-answer playback improves without noticeable gaps or added failures.
4. Consider the actual-early-speech experiment separately, after measuring how often prepared audio is ready before validation. If that interval is usually negligible, stop at step three.

Tests should cover split routing markers, provider refusals and incomplete streams; English/Hinglish action claims; later negation; cleanup changing the prefix; non-owner/recovered turns; tool routing after preparation; mute/unmute races; music or speaker loss; cancellation during synthesis; cumulative bounds; exactly-once playback/history; and no action execution from a speculative step. Use synthetic fixtures and mocked playback, not messages, emails or room recordings.

Measure mute-to-final-transcript, first visible model delta, eligible opening, synthesis start/ready, final validation, first PCM feed, total playback and discarded preparations. Report p50/p95 and fallback/failure rates separately for conversation, tools and English/Hinglish. Label PCM-feed timing as an estimate of audible onset; Bluetooth buffering remains outside it.

The practical target is a modest, repeatable reduction in waiting while preserving the reliability that already works. The preparation-only phase gets most of the plausible gain on short replies without making the speaker an irreversible preview of unchecked model output.
