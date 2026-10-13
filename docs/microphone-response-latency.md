# Microphone response latency review

The aim is a faster answer from the same assistant, with its personal notes, recent context, older-memory lookup,
configured tools and permission checks intact. This review concerns the model stage after the final transcript,
not a change to speech recognition or speculative execution of partial speech.

## Evidence

Recent production timing metadata showed final transcription around 1.3 seconds, chat queue waits of 2–4 ms,
and model/agent work of 2.6–8.8 seconds. The agent includes any tool execution and repeat model calls. These are
observations from a small window, not a latency guarantee.

A controlled alternating comparison used the deployed model and the owner's existing context with a synthetic
conversational message mentioning music. It invoked only model responses, never tools or messaging callbacks,
and saved no prompts or replies. The previous keyword hint chose the tool path:

| Request | Run 1 | Run 2 | Input tokens |
| --- | --- | --- | --- |
| Existing common tool definitions | 6.521 s | 5.724 s | 7,076 |
| Conversation, tool definitions omitted | 2.898 s | 3.348 s | 5,466 |
| Conversation, minimal reasoning requested | 2.680 s | 3.043 s | 5,466 |

The second runs reported 7,040 and 5,440 cached input tokens respectively. Tool overhead survived a near-complete
cache hit. Minimal reasoning did not consistently reduce reasoning tokens, and two trials do not establish a
benefit: the configured low effort is retained. Requests and provider conditions differ, so do not interpret
these numbers as a universal fixed penalty or compare them directly to another provider's benchmark.

Z.ai documents implicit caching and states that GLM-5.3-Flash's thinking cannot be disabled. A report in its
model repository describes a similar intermittent tool-request penalty; a collaborator says the serving team
is investigating it. This supports investigating request shape, rather than promising a client-side fix for all
provider latency:

- https://docs.z.ai/guides/capabilities/thinking-mode
- https://docs.z.ai/guides/capabilities/cache
- https://github.com/zai-org/GLM-5/issues/144

## Changes

The task hint now looks for request wording instead of bare topic nouns such as music, code and project. Clear
playback and reminder commands still start with tools. Other requests can load permitted tools through the
existing internal marker; the hint never grants or denies access. No-tool requests omit the tools field entirely.
All saved notes remain included; this change does not further shorten memory or change model/provider.

Microphone model calls now record content-free mode, step, duration, input/output/cache/reasoning token counts
and number of tool definitions. This distinguishes conversation latency from tool routing and repeated model
calls. No prompt, reply, transcript, arguments, contact name or chat identifier is added to these records.

## Capture diagnostics

The old coverage check inferred possible missing words from loudness before/after decoder timestamps. Hum,
handling noise and other background audio can satisfy that check. The text model cannot hear any of this, but
the diagnostic was appended to the user's message and saved in conversation history. This encouraged repeated
claims about a blip even when the actual sentence was complete.

For the optional faster-whisper backend, suspect leading/trailing coverage now gets a second opinion from its
already installed Silero speech detector. The detector does not trim, replace or otherwise alter the audio
transcribed. If detection fails, the conservative warning stays. Invalid timestamp and sparse-transcript guards
remain. This uses the backend's existing VAD implementation:
https://github.com/SYSTRAN/faster-whisper/blob/master/faster_whisper/vad.py

On a six-second synthetic hum probe, the old check warned and the speech-aware check did not. Warm VAD work
was about 14 ms; its first initialization was about 466 ms and is now performed on synthetic silence at startup.
Fixtures also retain warnings for uncovered speech at either boundary and invalid coverage. A speech detector
is not an accuracy guarantee and cannot distinguish a person's speech from speech on a nearby television.

Current warnings are instructions for this turn, never saved as something the person said. Historical diagnostic
lines are omitted when constructing conversation input without modifying stored history. The model is explicitly
told it receives text and must not claim to hear blips or infer audio quality from old replies. A genuine remaining
coverage warning still disables actions for that turn; coherent conversation may continue, and action requests
require a repeat. The page's diagnostic remains available for inspection.

## Remaining limits

Current tool requests still pay provider latency and sometimes require multiple model calls. Ambiguous routing
may add a conversation request before tools. Longer replies and server load vary. Model-stage improvements do
not include WhatsApp delivery or page polling. Validate the effect with ordinary English and Hinglish use and the
new timing metadata before changing providers or adding another routing model.
