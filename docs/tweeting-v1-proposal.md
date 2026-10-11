# Personal tweet editor v1

Status: design reference for the copy-and-paste implementation; see [runtime setup and limitations](tweeting.md). X account integration is outside v1. Reviewed 11 October 2026.

## Outcome

New eligible personal memories can become private, finished tweet drafts. The owner can edit, reject or postpone
them, then copy the entire tweet message into X and publish personally. They can also request a draft directly. Employment, job applications and
workplace material are excluded; personal coding projects and experiments are eligible, as the owner clarified.

The objective is to make the owner's actual curiosity, judgment and work visible. Do not invent accomplishments,
experiments, opinions or expertise to make them look impressive. Reach matters, but the owner recognizing their
own voice and wanting the post on their account matters more. A score is an editorial heuristic, not a prediction
or promise of virality.

## 1. Reuse the current system, add one small editorial layer

| Existing component | Use | Gap to address |
| --- | --- | --- |
| `store.ts`, `memory.ts` | Encrypted notes, current preferences, archive and recap | Notes are dated strings, not provenance-labelled public writing material. Do not hand the whole memory/archive to a tweet writer. |
| `reading.ts`, `reading-library.ts` | Owner-tagged article notes, links and coverage | Ellie reading something does not establish that the owner read, liked or agrees with it. |
| `link-workflow.ts` | Saved user links and summaries | Receipt completion clears temporary text; capture a source reference at successful insertion, rather than treating every list item as a new endorsement. |
| `reading-sharing.ts` | Durable receipts, budgets and uncertain-delivery handling | Its group broadcast authorization does not authorize tweeting as the owner. Keep its output and the editorial pipeline separate. |
| `drafts.ts`, `agent.ts` | Existing outgoing approval handling | Leave this slot alone. A tweet suggestion is text delivered to the owner, not an outgoing action waiting for `confirm_send`. |
| `ai.ts`, `vault.ts` | Provider-neutral model calls and encrypted atomic JSON files | Reuse them; no local model or new database is needed. |
| `ops/diagnostics.py` | Aggregate operational diagnostics | Keep tweet text, profile evidence and private sources out of laptop maintenance reports and public PRs. |

Run a serial, bounded background editorial loop in the existing Pi assistant process. HTTP model calls use the
configured provider through `responses()`/`tuned()`. They do not require a local inference server. This loop must
yield while replies are busy, use timeouts and never be awaited by normal message handling. The existing separate
reading worker continues extracting articles; it need not gain access to private editorial material.

No X connection, graph database, embeddings, general workflow engine, extra Chromium instance or compulsory laptop daemon in
v1. The laptop remains the backup/maintenance host and existing browser fallback. Measure Pi memory and reply
latency before deciding that this small queue needs its own process.

## 2. Inputs and boundaries

Eligible sources are newly saved owner-tagged public article notes, public links the owner sends in their private
chat, their own personal thoughts/observations, and owner-described personal project lessons. A direct request
such as "draft a tweet about this" can supply an idea without saving a permanent personal fact.

Use source adapters rather than a generic trigger on every `saveMemory()` write. Daily tidying, recap refreshes,
assistant replies and historical reimports must not create new ideas. Suggested integration points:

- Discover committed owner article notes after an activation timestamp, using their existing article IDs and
  encrypted processing receipts. An initial activation marks older records seen unless the owner asks for a
  bounded backfill. Discovery must recover notes saved immediately before a crash.
- At successful owner-private link insertion, record the list-item/source ID. Reconcile insertion versus receipt
  creation after a crash; never use a group link, another member's contribution or an assistant summary as an
  owner statement.
- At the end of an owner-private human turn, capture a bounded relevant thought or personal-project observation
  with its original message ID. Successful `remember` calls can reference this same item, not duplicate it.
  Explicit corrections and deletion events update or invalidate existing candidates.

Each editorial source has an owner ID, source kind/ID, content hash/version, creation time, original author,
visibility, eligibility decision and optional project label. Keep only the necessary excerpt and source pointer.
The source determines whether a claim is an owner statement, a public article claim or a proposed interpretation.

**Exclusion is applied before writing and retrieval, not just as a prompt instruction.** Deny mailbox/inbox,
calendar, linked personal WhatsApp, other people's DMs, group history, coding job transcripts and operational
logs as source types. Employment/application/workplace conversations are ineligible even if a general memory note
was saved from them. Mark mixed or uncertain passages ineligible rather than trying to sanitize them automatically.
An ingress classifier may inspect a bounded owner-authored passage to make that decision; excluded material does
not proceed to the writer, profile evidence or the editorial store. Do not forward complete chat turns/tool outputs.

Personal project material can enter from the owner's own description or a deliberately selected public artifact;
do not ingest every coding job automatically. This admits hobby experiments without opening employment work.
Private addresses, secrets, account IDs and third-party personal details remain excluded. Ambiguous content is
skipped quietly; the owner can explicitly provide a public-safe version later.

## 3. An evolving taste and voice profile

Maintain a small, encrypted editorial profile scoped to the owner. It describes:

- Topics and questions they currently care about, plus topics they do not want to tweet about.
- Their supported positions, open questions and changes of mind, with evidence references.
- Personal projects they want to discuss publicly and public-safe descriptions.
- Intended audience, initially proposed as curious builders and technically interested people.
- Voice: language, directness, humor, technical depth, length, formatting and disliked patterns.
- Positive and negative examples, including the owner's edits to actual drafts.
- Explicit exclusions and permanent boundaries, which cannot fade through time decay.

Every preference has a provenance reference, strength, last-confirmed time and status. Owner instructions override
inferences. An explicit correction supersedes the identified previous preference; contradictory evidence remains
uncertain until clarified. New source material cannot issue profile instructions.

Update immediately on explicit feedback; otherwise consolidate new eligible evidence at most daily. Recent
inferred interests can fade with a proposed 60-day half-life. This affects suggestion ranking, not deletion of
facts or expiry of explicit preferences. Weight repeated independent owner signals more than a single link.
Background article volume has **zero endorsement weight**: subscribing to a feed is not liking every post in it.

Learn the reason for feedback without forcing a questionnaire:

| Owner response | What changes |
| --- | --- |
| "Not interested in this topic" | Topic preference decreases. |
| "Interesting, but this doesn't sound like me" | Voice/example feedback; topic preference need not decrease. |
| "I don't agree with that" | Reject the proposed position; do not store it as their belief. |
| "Not now" | Snooze this candidate; no inferred dislike. |
| "Don't tweet this" | Reject this candidate; infer no broader rule without evidence. |
| A specific edit | Store the before/after and any explicit reason as a style example. |
| Silence | No approval and no negative preference update. |

Liking or posting a draft does not turn every first-person phrase into a permanent biography
or authorize wider source sharing. Offers such as "what do you think my style is?", "less AI news" and "reset my
tweet preferences" should be available in private chat. Start with a compact owner-approved profile instead of
silently treating the entire historical memory as a verified public persona.

## 4. Decide whether an idea deserves a draft

First apply code-enforced owner, source-type, exclusion, activation, freshness and duplicate checks. Then assess
eligible ideas in small batches against the current profile. Retrieve at most three relevant, eligible pieces of
context, not an unfiltered `recall()` response that could include job discussion. Public article notes and
owner-authored statements remain separately labelled.

Proposed rubric, each rated 0–5 with a short evidence-backed reason:

| Dimension | Weight | Question |
| --- | ---: | --- |
| Personal fit | 30 | Is there current evidence the owner cares about this? |
| Distinct perspective | 25 | Is there a useful observation, connection, question or personal lesson beyond a generic summary? |
| Reader value | 20 | Can someone learn something, use something or see something differently? |
| Specificity and support | 15 | Are the interesting claims concrete and supported? |
| Freshness/diversity | 10 | Is this a new angle rather than another version of a recent suggestion/post? |

Score = sum of `(rating / 5) * weight`. Start with 75/100 and personal fit at least 4/5 for proactive drafting.
Treat thresholds as tunable starting settings. Unsupported personal claims, excluded sources or unresolved
privacy concerns fail regardless of score. A direct owner request bypasses the proactive taste threshold,
but keeps grounding, privacy and length checks. Posting remains a separate manual action.

A new article can connect to an older personal observation, but only with eligible evidence. If the connection
is hypothetical, present it as an angle to consider, not "you believe X". If no worthwhile angle exists, retain
the reading normally and suggest nothing. Do not require every memory to produce content.

## 5. Writing architecture and evidence

The proposed default is a curious builder who notices interesting details and explains their implications.
This is a starting hypothesis from the assistant's use, not a settled account-specific voice. The owner's handle,
past writing and preferred accounts are still needed to calibrate it.

Research supports ingredients, not a magic template. Berger and Milkman's work found relationships between
sharing and usefulness, interest, surprise and emotion, studying news articles plus experiments. It is not a
validated scoring model for this owner's X account. Favor useful surprise and genuine enthusiasm; do not optimize
for anger simply because it can spread. [Research paper](https://doi.org/10.1509/JMR.10.0353).

Public reference writers offer different useful patterns:

- **Simon Willison:** explain what is interesting, add context or a connection, credit the original creator, and
  include a specific detail. These are drawn from his own published link-blog practice, not a statistical study
  of his tweets. [His approach](https://simonwillison.net/2024/Dec/22/link-blog/).
- **swyx:** make real learning and projects legible to other people. The useful starting formats are an experiment,
  a lesson, or a connection between ideas. [Learn in Public](https://www.swyx.io/learn-in-public).
- **Andrej Karpathy:** a memorable label can help communicate a recognizable phenomenon when backed by concrete
  experience. The original vibe-coding post is reproduced in Simon Willison's discussion; direct X fetching failed,
  so this is a limited example, not a review of his feed or engagement statistics.
  [Discussion and reproduced post](https://simonwillison.net/2025/Mar/19/vibe-coding/).
- **Paul Graham:** conversational language, revision and removing unnecessary words are useful editorial rules.
  These are writing principles, not evidence that a particular X format will go viral.
  [Writing, Briefly](https://paulgraham.com/writing44.html).

Do not imitate someone's exact voice or copy their wording. At calibration, use 10–20 owner-selected posts they
like and several they dislike, with links and brief reasons. Include ordinary posts, not just famous successes:
large accounts, timing and existing audiences make viral-only samples misleading. The reference writers above
are provisional until the owner identifies their preferred style.

### Brief → two angles → edit → validate

1. Build a compact brief: supported fact, why it matters, owner connection if any, uncertainty, source credit and
   intended reader. Enumerate evidence references for factual and first-person claims.
2. Produce two different angles internally. One might explain a surprising mechanism; another might connect it
   to a personal project. Do not merely paraphrase the same hook twice.
3. Pick and edit one. Lead with the most interesting supported observation, give a concrete detail and deliver
   the implication. The opening must earn the rest of the post rather than promise a revelation it never gives.
4. Critique for grounding, voice, usefulness, unnecessary words and public suitability. Reject generic hype,
   invented numbers, fake contrarianism and unsupported first-person experience. Allow at most one bounded repair.
5. Code validates the exact final text and links before showing it. The owner gets one recommended draft;
   alternatives are available on request.

Reusable forms, selected to fit the material rather than applied as a mandatory template:

| Form | Shape |
| --- | --- |
| Personal experiment | Concrete constraint → what was tried → result or lesson. |
| Source plus perspective | Specific sourced finding → meaningful interpretation → attribution/link. |
| Changed mind | Earlier view → evidence that changed it → current view, only with owner evidence. |
| Connection | Two apparently separate ideas → the mechanism they share → why that helps. |
| Useful question | Real observation → precise unresolved question, only when the question itself is interesting. |

Prefer a single post in v1. No automatic threads, promotional replies, engagement bait, default hashtag bundles,
"10x" claims or fabricated benchmarks. A dry joke or informal wording is useful when it sounds like the owner.
Being capable is demonstrated through constraints, decisions, artifacts and honest limitations, not self-praise.

For example, an **illustrative draft requiring owner verification**, not a claim about completed work:

> An assistant saying "done" isn't a receipt. For my home setup, I want the tool to confirm what actually
> happened before the assistant replies. A fluent status message is a surprisingly convincing substitute for evidence.

For article-derived posts, avoid "I tested" or "I read" unless the owner actually did. Credit the article's creator
and keep links when the post relies on their work. Source checks can use the existing reader for an eligible public
page; they must respect partial coverage and not launch an unrestricted research agent. Unverified timely claims
need a refresh before a new draft is shown or are skipped. Expired drafts are not presented as current news.

## 6. WhatsApp review: the tweet is a whole copyable message

Keep an encrypted editorial inbox separate from the shared outgoing draft slot. Proposed defaults: two proactive
private suggestions per day, spaced at least four hours apart, at most five live drafts, a seven-day draft lifetime, and no notifications between
22:00 and 09:00 in the owner's configured timezone. Aim for two worthwhile suggestions, but send fewer when quality does not clear the threshold. These are caps, not quotas. Manual requests work immediately.
After downtime, prioritize the best current suggestion, not a stack of catch-up notifications.

Send the finished tweet as one dedicated plain-text WhatsApp message. Its entire contents are the intended post:
no "Tweet draft:" prefix, surrounding quotation marks, character count, draft ID, source-evidence explanation,
"shall I post this?", or edit instructions. Include a source URL only when it belongs in the tweet itself.
Deliberate line breaks are preserved. There is no 50-word constraint: this is an edited tweet, not a forwarded
article summary. Validate the complete text, including any URL, against the 280-weighted-character v1 limit.

If useful, a separate short message can explain why the idea fits, identify it as `T12`, or flag a proposed opinion
for the owner's review. The owner copies only the tweet bubble. Manual requests normally need just that bubble;
background suggestions can get one brief context message plus the tweet. A notification cap counts these two
bubbles as one suggestion, with persistent delivery receipts to prevent catch-up bursts. Use the existing main
WhatsApp connection and the same conservative uncertain-send handling as article notifications.

Edits such as "shorter", "more like me", "make it less preachy" and "mention the Pi" produce a revised complete
tweet in a new clean bubble. Replying to or quoting a bubble resolves its stored draft ID/revision. If several
drafts could match, ask which one; never apply feedback to an unrelated email. Recheck owner registration and
private-chat scope at every tool entry point and notification delivery.

The owner publishes directly in X. Ellie cannot post, delete, edit, schedule or verify a post in this version.
"Yes", "looks good" or "post it" must not call `confirm_send` or approve an unrelated outgoing draft. Explicit
"post it" gets a short truthful response that the tweet is ready to copy and publish manually. If the most recent assistant preview is a tweet and an email/browser approval is also waiting, bare ambiguous
"yes" needs clarification, not an automatic send. Use recent delivered-message/quoted-message context, not the
existence of any seven-day-old tweet draft. Add this narrow ambiguity check before the current `PLAIN_YES` fast path; keep the existing later-message confirmation requirement for
real outgoing actions.

"Posted it" can record an owner-reported outcome. An optional supplied post URL can be attached as owner-provided,
not independently verified. Approval, actual posting, topic preference and voice feedback remain separate signals.
Silence is none of them. The feature must never claim "tweeted" merely because it sent the draft in WhatsApp.

## 7. Platform constraints and zero X fees

Manual copy-and-paste requires no developer account, OAuth, X token, API credit, browser automation or paid X
integration. Do not connect the account or introduce automatic metrics polling in v1. The owner asked specifically
for this approach to avoid additional platform charges.

Use X's weighted character rules, through `twitter-text` or a reviewed equivalent, rather than JavaScript string
length. V1 targets 280 weighted characters even if the account has longer-post access; URLs have their own counting
rules. Never truncate a factual qualifier or source URL silently.
[Character counting](https://docs.x.com/fundamentals/counting-characters).

The official API is the future route if direct publishing is ever requested. X prohibits non-API website
scripting in its automation rules, so the laptop browser should not be used to avoid API charges.
[Automation rules](https://help.x.com/en/rules-and-policies/x-automation).

Research found the current API create table lists $0.015 per request or $0.200 with a URL. These are deliberately
avoided by manual posting; they are not a prerequisite to drafting. Recheck prices if the scope ever changes.
[Current pricing](https://docs.x.com/x-api/getting-started/pricing).

The remaining cost is generation through the already configured AI provider. Those calls can be billed; using
an existing key does not make incremental inference free. Keep hard daily limits and report usage. If no additional
AI spend is acceptable either, leave proactive drafting off and provide only owner-requested drafts within the
existing service budget. Do not provision a paid account or make a model/pricing change as part of this proposal.

## 8. Pi budgets, storage and learning

Proposed automatic daily ceiling: 20 incoming items inspected in up to four classification/assessment batches, two draft-generation calls,
two critique/repair calls and one profile consolidation call. Nine editorial model calls maximum, including ingress classification and all retries, not a quota. Reserve
before calling; all retries count. Cap each request's inputs/outputs and process one at a time. Manual drafting
has a separate bounded per-request budget (up to three calls, including any classification), so background work cannot consume its allocation.
On-demand requests remain subject to an overall configured cost cap. Check costs with actual provider usage;
there is no justified fixed model-cost estimate without the configured model and token volume.

Store the small profile and individual candidate/draft/receipt records under the owner's encrypted data path.
Cap pending sources at 200 and keep source excerpts short; prune unseen candidates after 14 days, unreviewed
draft text after seven days, and feedback/receipts after a defined 180-day window. Promote enduring explicit
preferences into the current profile with provenance; do not keep an unlimited transcript. Retain only minimal
source/draft hashes where needed for deduplication, under a documented retention policy.

All files use `vault.ts` and are included by the current data backup inventory. Verify a scratch restore during
implementation. Forgetting an idea invalidates derived drafts and removes private feedback/examples based on it;
state honestly that old encrypted backups follow their retention and published posts are a separate public copy.
Core reset/forget handlers need corresponding editorial invalidation, not just deletion of one note string.

Initially learn from owner approval, revisions and rejection reasons. No X analytics calls are needed. The owner
can optionally share a link or tell Ellie how a post performed. Treat those as owner reports, and do not infer
interests from likes alone or one breakout post. Keep audience-performance observations separate from the owner's
beliefs. Do not build an analytics dashboard before feedback demonstrates that it would help.

## 9. Implementation sequence and release checks

1. Implement owner-only encrypted editorial records, eligible-source adapters, exclusions and deletion semantics.
   Start activation from now, with no wholesale history export or unsolicited drafts.
2. Show a compact initial taste/voice profile for correction; add on-demand drafting and private revision/rejection.
3. Add bounded background assessment and up to two daily suggestions, spaced at least four hours apart, with persistent budgets and deduplication.
4. Integrate clean tweet bubbles, quoted-reply edits, feedback and ambiguous-confirmation handling. No X credentials.
5. Evaluate real owner feedback before changing thresholds or adding features.

Focused isolated checks must cover owner versus friend/admin/group access; employment and mixed-source rejection;
personal project acceptance; article-not-endorsement; no first-person fabrication; preference correction and decay;
duplicate memory updates; no triggering from tidy/recap; concurrent drafts; silence and "not now"; quoted-reply
revision targeting; deletion/expiry; competing email confirmations; Unicode/URLs; exactly copyable tweet text;
restarts and uncertain WhatsApp delivery; queue/budget limits; and absence of private text in diagnostics. Mock
all models and sends in these checks. Run typecheck; never start a second WhatsApp session. Assert that there is
no X publishing request or browser action anywhere in the feature.

Success is a useful draft the owner recognizes, can adjust easily, and chooses to copy and publish personally. Track the
fraction accepted, the kinds of edits required, notification burden and any grounding/privacy failures before
trying to optimize engagement. The runtime implementation and its validation are documented separately. Neither version publishes to X.
