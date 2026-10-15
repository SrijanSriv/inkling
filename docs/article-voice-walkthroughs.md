# On-request English article voice walkthroughs

## Use

Share links normally: existing summaries, link saving and chat-local lists are unchanged. With this
feature enabled, a successful automatic link summary has a separate offer asking whether you want
a detailed English voice walkthrough. Quote that offer and reply `yes`. A registered member of the
same group can accept a group offer; a DM offer is available only in that person's DM. Offers expire
after 24 hours. Quoted yes is routed in code before any email/browser draft confirmation, so accepting
a voice offer cannot approve an unrelated outgoing draft.

You can also explicitly ask “Explain this article in depth as an English voice note” with the link,
or refer to one in this chat's saved links. Ordinary text elaboration and incoming voice notes do not
by themselves request audio. Voice generation is never automatic on sharing a link.

## What is generated

The assistant fetches the public source again through the existing guarded downloader and Readability
extractor. It does not expand a 50-word summary from memory. A separate tool-free model call creates
an original English listening explanation: the author's main thesis, context, reasoning, examples,
technical concepts, caveats and implications. Interpretation is distinguished from the author's claims.
Long quotations, invented missing sections and page instructions are forbidden. Output is validated
for English script, length and format; unavailable/paywalled or insufficient content fails rather than
pretending to explain it. Extracted content is capped at 60,000 characters; any truncation is disclosed.
The public extractor does not use anyone's signed-in browser, inbox or private memory.

A substantial article usually gets 700–1100 words, adjusted for substance, capped at 1400 words and
nine minutes of synthesized audio. This is a walkthrough, not a promise of a verbatim audiobook or
exhaustive coverage of every paragraph. Static web articles are supported; PDF/video extraction and
login-required pages are not part of this version.

## Local audio and resources

Configure `INKLING_ARTICLE_VOICE=true`, `INKLING_WHISPER_URL`, `INKLING_WHISPER_SECRET`, an English
`INKLING_MIC_SPEECH_VOICE`, and install `ffmpeg` on the assistant host. Without those settings the tool
and offers remain off. No new synthesis service or paid voice provider is introduced: the existing
laptop Kokoro gateway renders short bounded chunks, respecting its text/duration limits and busy lock.
The Pi joins validated PCM and encodes one Ogg/Opus voice note through ffmpeg pipes. Nothing is played
on room speakers. Existing text-model inference remains subject to the configured provider's usual
costs and limits.

One walkthrough runs at a time across this process, with four requests per chat per hour. Busy local
synthesis is retried briefly; other failures stop the job. Jobs run in the background, with an initial
preparation update and a real voice-note delivery or a clear failure notice. Scripts can take minutes
to prepare. This shares the laptop synthesizer with room speech, so simultaneous voice activity can
be busy; this is not an independent capacity pool. No TTS service is stopped or reconfigured.

## Privacy and delivery

Chat registration and live group membership are checked before work and again before delivery.
Source URLs must already be in the current chat's conversation or tool results from its saved lists.
Receipts and offers are sealed and chat-local; the latest explanation script is also kept encrypted
for reference. Audio/PCM exist only in bounded RAM buffers and subprocess pipes, cleared after use;
no plaintext audio or scripts are written to temporary files. Do not log article contents or audio.

Request IDs deduplicate repeated tool execution. A process restart can interrupt an unfinished job;
there is no automatic replay or resend. If delivery may have happened but its acknowledgement fails,
the assistant asks the person to check the chat before retrying. Offers and recent receipt records
are bounded. The latest script replaces the previous one rather than accumulating recordings.

## Validation

Ad-hoc checks cover explicit voice intent, English/depth validation, complete chunking, real Opus
encoding, mock background delivery, deduplication, revoked access and chat-isolated quoted offers.
Tests do not send WhatsApp messages. A deployed synthetic model/local-speech smoke check verifies the
configured provider and gateway separately from personal recordings. A user's first real article
request remains the end-to-end WhatsApp listening check.
