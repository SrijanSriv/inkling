# Private copy-and-paste tweets

Optional, off until `INKLING_TWEETS_ENABLED=true` and `INKLING_TWEETS_USER_ID` names the registered owner. Set both
in the protected environment and restart the existing assistant process. Do not start another WhatsApp session.
There is no X login, publisher, API token, browser automation or metrics scraper. The owner posts manually.

## Use

- "Write a tweet about [a personal thought or experiment]."
- "Draft a tweet from the latest article." Uses newly eligible saved sources, not unfiltered chat recall.
- Reply to a tweet bubble: "shorter", "make it more specific", "less preachy", "looks good", "skip", "not now".
- "Show my tweet profile" or "For my tweet style, prefer [your preference]."
- "Pause tweet suggestions", "resume tweet suggestions", "clear my tweet profile".
- "Show tweets" lists current IDs. "Show T2" sends its complete text again on explicit request.

Drafts are sent as single intact plain-text bubbles, with no labels, approval text or metadata inside them. Source
links are appended by code when relevant. The whole bubble fits X's weighted 280-character limit, validated with
`twitter-text`. Replying to any retained revision resolves the same current draft; replies to expired drafts may
need a new request. No action in this feature publishes to X. "Posted it" records an owner report, not a verified
publication. A plain yes to a recent tweet cannot consume an unrelated outgoing email/browser approval.

## Selection, taste and budgets

The background loop runs in the existing Pi process, using the configured model through the provider-neutral AI
adapter. It skips work while chat queues are busy, processes tasks serially, and gives each provider request a
30-second timeout with SDK retries disabled. There is no extra local model or browser.

Automatic assessment uses up to four batches of five inputs daily, one in each local window: 09:00–12:00,
12:00–15:00, 15:00–18:00 and 18:00–22:00. It waits 15 minutes to batch a smaller queue. Classification and eligibility
come before writing. A 75/100 score and personal fit of at least 4/5 qualify a proactive idea; direct requests bypass
those taste scores, not privacy or grounding. The rubric weights fit 30, perspective 25, reader value 20, support 15
and novelty 10. These are adjustable editorial heuristics, not a claim to predict viral reach.

Up to two suggestions are delivered daily, at least four hours apart, between 09:00 and 22:00 in the owner's
configured timezone. Caps and gaps persist across restarts and midnight. At most five unreviewed drafts are live;
feedback closes a reviewed draft. Fewer suggestions are normal when quality, source availability or quotas prevent
two. There is no catch-up burst after an outage.

Background budgets: four assessment calls, two angle-writing calls, two critique calls and one daily profile
consolidation call, maximum nine editorial model calls daily. Manual drafting/revision has a separate daily cap
of twelve calls; a new idea takes up to three, an edit or an existing-source draft up to two. All attempted calls
count, including malformed or rejected responses. "Show tweets" reports today's model-call count. There are no
X fees; configured AI-provider usage remains billable. Token limits and call limits bound usage, not a guaranteed
currency amount.

Writing uses two candidate angles, an independent critique, supported source material, current preferences and
at most two related eligible owner observations. Unsupported first-person claims require exact owner-source
quotes and otherwise fail. The critic rejects generic summaries, fabricated results, hype and repetition. The
code also rejects invalid length, invented links, mentions, employment terms and obvious credentials/addresses.
A failed validation does not send the model's raw response to the user.

Explicit editorial preferences take priority and immediately invalidate queued rankings/unsent drafts. Feedback
and current owner observations inform a bounded daily inferred profile; recency weights decay with a 60-day
half-life. Article intake itself never counts as an owner endorsement. "Not now" closes the suggestion without
assuming topic dislike. The owner can request a new draft later. Generated wording is never promoted to biography.

## Sources, privacy and recovery

Sources: owner-private human messages, successful owner-private saved links, and owner-tagged public article notes.
Activation starts now, with no automatic historical backfill. No mailbox, calendar, linked-personal-WhatsApp,
group history or coding transcripts are retrieved. Personal projects can enter through the owner's own words.
A conservative code filter and model classification reject employment, applications, workplace material, mixed or
uncertain inputs. These are fallible classifiers; manual posting remains the owner's final review.

Unclassified text is not copied into the editorial store. The inbox persists bounded references to the existing
encrypted owner history/list or public article note; successful classification retains only bounded eligible text.
Message-source IDs in stored history allow a restart to resolve pending references without bulk history mining.
A missing source is not reconstructed from another person's chat. Pending references expire after 24 hours; at
most three classification attempts with an hour backoff, within the daily/window budget. Article recovery examines
the latest 50 owner-tagged notes. Feed coverage and long-outage recovery are therefore bounded.

Data lives in the owner's `tweet-editor.sealed`, encrypted by the existing vault. Sources expire after 14 days,
drafts after seven days, and profile feedback after 180 days; counts, IDs and queues are bounded. The existing
whole-data backup includes this file. Logs contain static outcome labels only; nightly maintenance diagnostics
must not export draft/profile/source text. Public examples and deployment settings contain no real identities.

A memory forget, saved-list removal or `/reset` conservatively clears the entire editorial profile, sources and drafts and moves its
activation boundary forward, so forgotten material cannot be recreated from old article notes. Daily budgets stay
intact. Pausing keeps manual drafting available. Deleting local memory does not remove older encrypted backups or
posts the owner already published manually. Those follow their separate retention/deletion procedures.

Before delivery, save a stable message ID and a `sending` receipt. A restart changes abandoned `sending` receipts
to `uncertain`; uncertain sends are not automatically repeated. This may lose a suggestion if acceptance cannot be
established, rather than creating duplicate notifications. An explicit "show T2" can send it again. Source/profile
changes during model work invalidate the result before delivery.

## Validation

Isolated scratch-data checks cover access restrictions, exact tweet text, URL/Unicode counting, source exclusion,
score weighting, manual drafts/edits, revision quoting, feedback, direct/automatic quotas, persistent cooldown,
preference correction, uncertain sends, forget-during-generation and encryption. Separate processes verified
reference recovery after restart. A confirmation-dispatch check verified that a tweet yes neither sends nor removes
a waiting email. All test model calls and WhatsApp sends were mocked. Ad-hoc scripts are removed after checks.

The architectural research and deliberately deferred features are in [the proposal](tweeting-v1-proposal.md).
