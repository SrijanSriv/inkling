# Public reading intake v1

A separate, opt-in worker discovers and reads public articles. It imports no WhatsApp sending, Gmail, personal
memory, or chat tools. There are no digests, recommendations or automatic outgoing messages. Chat/group delivery
and model-tool access to this library are deliberately separate future work.

## Run

Use Node 24 (the deployment runtime), install dependencies, and set `INKLING_READING_ENABLED=true` in the same
protected environment as Inkling. Run `npm run reading:worker`. `scripts/inkling-reading.service` is an optional
user service template; adapt its directory and Node PATH, then enable it with the host's normal systemd procedure.
Do not start the WhatsApp entry point to run intake. Set `reading_service` to the installed unit name in the trusted Pi operations configuration so the updater
pauses intake before switching releases and resumes it after health checks or rollback. Install the reviewed
`ops/deploy.py` wrapper manually too; source deployment does not replace trusted wrappers. Without that integration,
stop intake before changing its source/packages and restart it afterwards. This new service is not installed automatically.

Commands:

- `npm run reading:worker -- once`: one bounded tick (up to two due feeds and one article).
- `npm run reading:worker -- status`: counts, feed health and next-check times. No article contents.
- `npm run reading:worker -- search "robotics"`: local/operator search of saved notes. Keep output private.

An exclusive renewable filesystem lock prevents two workers writing the same data. Stale locks recover after a
crash. No WhatsApp session is opened. Service limits cap memory and lower CPU priority. Validate real resource
usage on the host before increasing the default budgets.

## Discovery and reading

`src/reading-sources.ts` contains the 14 agreed sources and check intervals: HN/Lobsters 30 minutes, technical
publishers 60 minutes, other publishers 120 minutes. HN uses hnrss.org, a third-party feed route; all other feeds
are publisher endpoints. Operators can replace the entire list with `INKLING_READING_SOURCES_FILE`, an absolute
JSON path containing `{id,url,minutes,category}` objects (`category`: `tech` or `other`). Minimum interval is 15
minutes; at most 50 sources. Restart after changing configuration.

Feed checks have no model calls. RSS and Atom are parsed as XML; custom entities/DOCTYPE are rejected. HTTP
validators avoid unchanged downloads; cache max-age and Retry-After are respected, with exponential backoff,
staggering, download limits and timeouts. Redirect destinations must remain public HTTP(S). Failed parsing never
advances a successful checkpoint. Finite feeds cannot guarantee recovery of posts lost during a long outage.

First discovery considers up to 20 entries per source from the past seven days (undated entries remain eligible).
At most 300 pending articles are retained; pending/failed records expire after 14 days. IDs use normalized URLs,
removing fragments and common tracking parameters. Equal URLs across feeds deduplicate; different URLs to the
same story may remain. Discovering a link does not mean it has been read.

Reading waits for initial feed checks, then attempts at most one article per hour and ten daily by default.
Rotation prevents a prolific source dominating; optional `INKLING_READING_INTERESTS` comma-separated keywords
rank entries within that rotation. Two early daily slots prefer non-tech if available. This is deterministic,
not a second selection agent, and intentionally does not inspect anyone's private history or memory.

Direct HTTP fetch plus Mozilla Readability extracts text with scripts/subresources disabled. Unreadable pages can
use the configured laptop browser, at most twice daily. Fallback sessions are anonymous and closed afterwards;
no personal cookies, sign-ins, clicks, payments or browser-driving model are used. Laptop failure leaves work
retryable; the rest of intake continues. Visible paywall/challenge text is rejected, though no heuristic can
prove a publisher served the complete article. Browser snapshots are always labelled partial. Images, audio,
interactive charts and PDFs are not understood by this text-only v1.

Articles are capped at 60,000 characters, processed in sections of 20,000 through `responses()`/`tuned()` and the
configured model. Longer content is explicitly marked partial. Each section has a bounded validated JSON note
and topics; model calls cannot exceed three times the daily article budget. Counters reserve before network/model
operations; failed attempts count toward limits. Up to three article attempts, with delayed retries, survive
restarts. Budgets reset in `INKLING_READING_TIMEZONE` (UTC by default). Per-section notes are retained rather than
spending another model call to merge them. `extracted-text` describes accessible extracted text, not proof of a
complete publication or verification that the article is true.

## Storage and privacy

State and individual article notes live in `INKLING_DATA_DIR/reading`, encrypted with the existing vault/key.
Notes retain source, original link, author/date when supplied, reading time, extraction method/coverage and
section summaries. Notes expire after 180 days; raw article bodies are not persisted. These files are included
in existing whole-data-directory backups. Notes are not injected into personal memory or prompts automatically.
Local keyword retrieval is available now; chat retrieval/sharing needs a separate permission design later.

Logs report aggregate counts only, never page bodies, note text, interest keywords, browser secrets or links.
External text is information, never instructions. Summarization has no tools and cannot send messages or execute
article instructions. Feed parsing and content extraction are fallible: inspect status, failures and coverage,
not merely the number of discovered URLs. Changes in publisher layout or access may need source-specific fixes.

## Configuration

- `INKLING_READING_ENABLED`: exactly `true` enables run/once; off by default.
- `INKLING_READING_DAILY`: 1–50, default 10 attempts, including failures.
- `INKLING_READING_BROWSER_DAILY`: 0–10, default 2 fallback attempts, including failures.
- `INKLING_READING_TIMEZONE`: IANA zone, default UTC.
- `INKLING_READING_INTERESTS`: optional comma-separated keywords, max 30.
- `INKLING_READING_SOURCES_FILE`: optional replacement source registry.

Existing `INKLING_MODEL`, provider keys, `INKLING_DATA_DIR`, `INKLING_SECRET_KEY` and browser settings are reused.
The worker does not need Gmail, WhatsApp, GitHub or deployment credentials. Run under a restricted host account
when practical; this v1 uses the existing installation's environment and encryption key.

## Validation

Implementation checks: TypeScript typecheck and whitespace checks; 31 assertions covering feed parsing,
entity rejection, URL normalization, conditional requests, quotas, encryption, source failure/retry, singleton
locking, concurrent ticks, long-article sections, retention, recovery after a saved note, and a full queue not
advancing the feed validator. Tests used scratch encrypted data and injected model/browser functions; no messages,
emails or invites were sent. Live public feed checks parsed all 14 sources, and sample article extraction worked
for Aeon, IEEE Spectrum and Latent Space. No paid model call or live browser fallback was exercised in these checks.
The service has not been installed or enabled on a deployment by this source change.
