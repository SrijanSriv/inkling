# Private issue tracking and approved improvement requests

This adds three things to the existing nightly system: local technical candidates, author-approved requests,
and a broader public-source review backlog. It does not export chats or run an extra model over them.

## How to use it

In your DM or a group, send a description in your own words:

- `/bug Internal commands appear in replies after a memory operation`
- `/feature Support an optional series of article voice walkthroughs`
- Reply to a message with `/bug` or `/feature`, or just `bug` / `feature`.

Ellie sends the preview privately. Reply **yes to that preview**, or use the approval command printed on it.
A free-standing yes is deliberately left to the existing mail/calendar confirmation flow. Group approval,
forwarded approval and conditional yes-with-edits do not approve a feedback request.

The preview says exactly what will go to **Codex/OpenAI on the laptop and potentially a public GitHub PR**.
Nothing enters that queue until the same registered author approves it within 30 minutes. This is approval to
share a request, not permission to send mail, change roles, spend money, merge a PR or deploy.

Quoted text is never copied into a report. The parser derives only a fixed local topic from the quotation,
then proposes a general template. If it cannot identify a useful topic, Ellie asks for a description in your
own words. A quoted message does not give its reader permission to export its author's content.

For clearly phrased new feature suggestions, a deterministic rule can offer a private preview automatically.
Known topics use general templates. Novel ideas can preview the sender's own new typed wording after safety
checks; no quoted content is included. The author still reviews the exact wording and approves separately.
Offers are limited to once per person per day, and only addressed conversations are considered in groups.
This detector will miss some suggestions and may occasionally mistake a normal message for a feature idea.

Useful commands:

| Command | Result |
| --- | --- |
| `/bug list`, `/feature list` | Your own bug or feature list, sent privately |
| `/feedback` | Your combined request list and current status |
| `/feedback issues` | Local technical candidates for your DM, never exported |
| `/feedback withdraw <ID>` | Stop sharing the request in future snapshots |
| `/feedback off` / `/feedback on` | Mute or enable proactive feature offers |
| `/help` | Role-aware command guide, including `/mic` |

You cannot list, approve or withdraw someone else's requests. Registration is checked again on approval and
export. Removing a registered user stops exporting their requests. Withdrawal cannot recall a running review
that already received the description, or information already published in a PR. To revise a submitted request,
withdraw it and submit fresh wording with a new ID and approval.

Statuses distinguish preview, approved/waiting for transfer, queued, deferred, needs more detail, and PR proposed.
A proposed PR is never described as deployed. Requests needing clarification are not endlessly retried; a user
can submit a clearer description. Repeated deferrals stop after five review attempts and need manual detail.

## Local technical candidates

Code records fixed outcome categories at actual boundaries: failed tools, unsupported action claims caught by
validation, raw protocol text detected before cleanup, reply failures, failed link delivery, failed/uncertain
article audio, skipped/failed scheduled work and unfinished handover work. These are **candidates**, not proof
of a bug: for example, a permission denial may be expected and a corrected claim may never have reached a user.

The per-scope ledger contains only category, bounded count and local first/latest times. It contains no message
text, tool arguments, raw errors, URL, transcript or audio. These private counts do not select exported software
cases, appear in the review prompt or reach Codex. A local candidate can motivate a human to submit a general
bug description; it is not automatically converted into a shareable incident report.

This is new-event instrumentation, not a periodic archive or DM scanner. It does not perform semantic scoring
of conversations, claim to detect all misunderstood intent, or introduce a local generative model.

## Storage and privacy boundary

Set both `INKLING_RELIABILITY_DIR` and `INKLING_RELIABILITY_KEY_FILE` to enable this feature. Both are off by
default. The directory must be canonical, mode 700, outside `INKLING_DATA_DIR` and **all recovery/backup roots**.
Use a different mode-600 file containing a newly generated 32-byte base64 key, also outside all backup roots and
outside the ledger directory. Do not reuse `INKLING_SECRET_KEY` or put the new key's contents in `.env`.
Only the path belongs in configuration. The default backup copies `.env`, which must not contain this key.

Ledgers use AES-256-GCM, scope-bound authenticated data, random IVs and HMAC filenames. Request previews and
approved wording live in the author's encrypted ledger; there is no central plaintext conversation copy.
Previews expire after 30 minutes. Other requests have a 90-day limit and technical candidates a 30-day logical
window. Reads remove expired records; an hourly cleanup deletes inactive encrypted files older than 90 days.
This is ordinary retention, not a promise of forensic erasure from storage hardware.

Runtime guards reject a store or key in the standard data backup root, symlink aliases and unsafe permissions.
An operator must also exclude them from any additional custom backup roots. The installed layout keeps them
separate from operations state, source, backups and the Codex sandbox. Unapproved local records are deliberately
not recoverable from the normal laptop backup; preserve a separate offline key/store only if its participants
want that. Approved descriptions have a separate laptop copy as disclosed in the preview.

Description checks reject common credentials, addresses, phone numbers, URLs, local paths, raw structured tool
output and registered users' names. These are defense in depth, **not anonymization or a guarantee that all
personal context is detected**. Authors must approve only general wording they may share and omit other people's
private details. Consent permits the exact description to leave the device; it does not make it anonymous.
The assistant's ordinary conversations still use its configured conversation provider, as before. This feature
adds no model call for detection, intake, storage or export.

## Nightly review

The existing midnight backup remains separate. It is encrypted, copied to the laptop and unavailable to Codex.
The Pi's trusted feedback adapter reads only approved request records, produces a closed-schema snapshot with
random request IDs, kind and exact description, and transfers it over SSH. No author, chat, quote, private case,
count, recording or original-message ID enters that snapshot. Withdrawals contain only previously approved IDs.

Only the newest dated snapshot, refreshed within the last hour, can supply requests to a new review; older pending nights cannot replay withdrawn wording. Historical free-form reviewer notes are not fed back as prompt context.

The laptop keeps a durable backlog of those approved descriptions and selects up to twelve per review, favouring
unattempted entries. Every selected request must receive a result: PR proposed, needs more information, or deferred
with a reason. A crash after PR creation recovers the staged outcomes instead of opening another PR. Fixed status
receipts come back to the Pi; `/feedback` displays each person's matching records only.

Software review now includes **twelve always-run synthetic checks**, ten public code-inspection targets, and the
approved-request queue. The three added checks cover conditional email approval, draft expiry and restart durability.
Public inspection targets cover pending drafts, scheduler outcomes, article restart/follow-up, link delivery,
mail confirmation routing, reply integrity, dates, mic-link lifetime and partial source content. These are
code-review leads, not incident reports. The reviewer must verify each against current default-branch source.

An open maintenance PR reserves its changed files instead of pausing every other improvement. Both prompt and
host checks forbid overlap. The reviewer may address several justified issue families in a bounded PR of at most
twenty files, explaining significant deferred findings rather than stopping at the easiest fix. Typecheck,
JavaScript syntax checks and the trusted synthetic suite still run; passing probes must not regress. Privacy,
approval, announcement and operations controls are protected from model edits. Human review and merge remain
required. There is no promise of a particular number of safe fixes each night.

## Evidence ledger in each PR

The host builds the PR body from structured, validated entries rather than publishing a loose model summary.
Every meaningful improvement lists its source IDs, problem, before behavior, fix/addition, real before/after
code references, verification and limitations. All changed files and proposed requests/inspection targets must
be accounted for. References must point to existing one-based lines; the host inserts commit-specific GitHub
links. Missing source IDs, fabricated line numbers, unknown chat-origin IDs and uncovered files reject publication.

Synthetic evidence is labelled with the independently measured fresh-baseline and after-patch outcome. Public
code inspections are explicitly reviewer assessments. Approved feedback cites only the random request ID and
exact approved description, not its author or a WhatsApp message. The body discloses all approved descriptions
supplied, including deferred requests, their decisions, significant remaining work and the actual privacy boundary.
Reviewer-reported extra checks are distinguished from host-verified typecheck, syntax and full-suite results.
The source fixture must match the trusted installed runner before a model turn begins.

This creates a trace a human can follow, not a mathematical proof that the reasoning or fix is correct.
Original conversations are deliberately unavailable as evidence. The owner notification includes an issue-to-change
ledger and points to the complete PR for code links, checks and privacy disclosures. See
[the PR ledger guide](pr-evidence-ledger.md).

## Command announcement

The operator sets `INKLING_COMMAND_ANNOUNCEMENT` to a rollout version after explicitly authorizing a broadcast.
The existing single WhatsApp process sends the current role-aware guide privately to each registered person,
one at a time. Encrypted per-user receipts stop the same rollout from repeating after restart. Stable message
IDs reduce duplicates after an ambiguous send; a crash at the delivery boundary can still cause a retry.
Retries back off, and the sender attempts at most thirty guides per hour. The guide includes `/mic`, the
feedback consent rules and ordinary Google/memory/reset commands, plus administrative and room controls only
where applicable. An unchanged rollout also introduces the guide to newly registered people.
