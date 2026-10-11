# Memory reliability v1: improve the existing system

Status: implemented; deployment is installation-specific.  
Prepared: 11 October 2026.  
Baseline inspected: `c4805e3`.  
Primary host: Raspberry Pi. The laptop remains the optional coding/browser worker.

## Goal and boundary

Make Ellie retain corrections, execute one useful recurring instruction and continue existing coding work without repeatedly asking for context. Reuse the current memory, scheduler, lists, browser and coding paths.

This is a reliability release, not a knowledge-graph release. It adds no database, embeddings, new model provider, general workflow engine or always-on service. The broader [architecture proposal](memory-architecture-proposal.md) is background and a list of possible later directions, not the v1 checklist.

Success means fewer repeated instructions and accurate reports of what actually happened. A larger store or more extracted facts is not itself success.

## What already exists

| Existing component | Keep and extend | Actual remaining gap |
| --- | --- | --- |
| Encrypted per-chat notes, `remember`, `forget`, recent history, archive, recap and keyword `recall` | [`store.ts`](../src/store.ts), [`memory.ts`](../src/memory.ts), [`agent.ts`](../src/agent.ts) | Saving a correction currently appends a string. Contradictory notes can survive together. |
| Daily note cleanup, concurrent-change check, excessive-deletion guard and encrypted previous-notes backup | `tidyNotes` in `memory.ts` | Model output is parsed without runtime shape validation. Invalid responses fail cleanup and can be tried repeatedly. |
| Reminders, scheduled jobs, watches and phrase-triggered auto-replies | [`schedule.ts`](../src/schedule.ts), [`auto-replies.ts`](../src/auto-replies.ts) | These do not implement a standing instruction to read, summarize and save a bare link. |
| Per-chat lists, link reading and browser tools | [`lists.ts`](../src/lists.ts), [`browse.ts`](../src/browse.ts), [`web-agent.ts`](../src/web-agent.ts) | A saved note cannot connect these capabilities into an enabled recurring action. Lists in different chats remain separate. |
| Persistent laptop coding projects/jobs, continuation, queue, request deduplication and Pi notification cursor | [`coding.ts`](../src/coding.ts), [`coding/worker.mjs`](../coding/worker.mjs) | A continuation can unnecessarily include a repository URL. A request that never reaches the worker has no Pi-local pending record. |
| Encrypted nightly recovery and sanitized maintenance diagnostics | [`ops/`](../ops/), [operations documentation](operations.md) | No replacement backup or analysis system is needed for this work. |

Evidence from the earlier deployment review is summarized in the architecture proposal. It includes conflicting saved instructions, repeated link-workflow explanations, coding context repeated after failures and 18 cleanup parsing failures in the reviewed window. These observations establish concrete targets; they do not prove the current cause of every poor reply. Recheck affected paths when implementing.

## 1. Make note cleanup safe and predictable

### Change

Extend the existing `tidyNotes` routine:

- Parse inside a guarded path and validate that the result is exactly a supported object containing an array of strings. Apply conservative size limits before accepting it.
- On invalid output, preserve notes and the last valid backup. Record a content-free error category and a persisted next-attempt time in the existing encrypted upkeep state.
- Separate last successful cleanup from failed attempts. Back off failures, with a bounded delay, rather than calling the same failing model path every hourly pass indefinitely. New notes must still be eligible for a later retry.
- Preserve the existing note-hash concurrency check and excessive-deletion guard.
- Treat cleanup input as untrusted information. Do not log malformed responses or extract permission changes from them.

Keep cleanup sequential and off the reply path. Continue using `responses()` and `tuned()`; do not introduce a second extraction service.

### Why this belongs in v1

Parsing failures are observed, and the implementation contains a direct `JSON.parse(...).notes.map(...)`. The existing preservation guards are useful and should be retained, not rebuilt.

### Done when

Malformed JSON, wrong types, oversized output, concurrent edits and excessive deletion all preserve valid notes. Failed cleanup backs off across a restart. Valid cleanup still works. Ordinary replies continue if upkeep fails.

## 2. Apply explicit corrections in one operation

### Change

Extend `remember` with an optional list of exact existing notes to replace. Validate every supplied target against the current chat's saved notes before doing anything; a stale or invalid target leaves the operation unchanged and asks the agent to reload the notes.

Save the replacement and retained notes in one existing encrypted memory-file write. Clear the old tidy backup after a successful replacement, as `forget` already does. Preserve the current string-note format and dated notes; no archive migration is required.

The agent should use replacement only when a human explicitly corrects or withdraws an earlier instruction. For an ordinary new fact, continue appending. Do not infer a correction merely from an assistant reply, a web page, a scheduled prompt or a same-day timestamp. Ambiguous conflicts remain unresolved until clarified.

When the model reads archived discussion, active saved notes govern current preferences. Old archive text can explain a past state; it must not silently reinstate a superseded instruction. This is a behavioral constraint, not a claim that all historical contradictions can be resolved automatically.

### Why this belongs in v1

The reviewed notes contain contradictory instructions. The current separate `forget` and `remember` tools can already handle this in principle, but a single validated write avoids a partially applied correction and gives the agent a clearer operation.

### Done when

An explicit correction leaves one current instruction; unrelated notes survive. Invalid replacement targets cause no mutation. A concurrent cleanup cannot restore the removed note. Existing memory files and `/memory` still work without conversion.

Full source attribution, historical fact versions and deletion across every archive/backup are deferred. Keep the existing privacy and retention semantics documented; this change must not promise universal forgetting.

## 3. Implement one standing workflow: bare link → summary + saved item

### Change

Add one small supported rule type, stored encrypted per chat. Suggested fields: enabled state, configuring user ID, allowed sender IDs, destination list, summary language and approximate length. Keep configuration inspectable, editable and removable through narrow tools. This is not an arbitrary sequence of model-authored steps.

Use existing link reading, list writing and the normal per-chat queue. Do not add a second agent loop. The rule should work in a private chat and in an explicitly enabled group, with these boundaries:

- Off by default. Enable only after an authorized explicit request. Group configuration requires an admin; permitted senders must be registered users.
- Trigger only on a single HTTP(S) link with no additional request text. Ignore preview metadata; captioned or multi-link messages follow the ordinary addressed-message path in v1.
- In groups, evaluate this specific rule before the normal name gate, after permission checks. Do not make all unaddressed messages reach the model.
- An addressed bare link follows one path, never both the rule and normal agent dispatch.
- Default to direct link reading. Do not open an interactive browser merely because a URL arrived. Existing browser security and confirmation requirements still apply when separately requested.
- If reading fails or requires a sign-in, report the limitation. Do not invent a summary or mark processing complete.
- Save a minimal item containing the URL, available title and summary in the chat-local list. Never enrich a group summary with private notes or inbox content.
- Deduplicate using the originating message ID. Bound pending work and persist the minimum encrypted receipt needed to prevent duplicate list additions after restart. Reconcile a partially completed addition before retrying.
- Permission changes and disabling the rule apply to queued work as well as new messages. Use existing rate/queue protections and add a small workflow limit if necessary.

Persisting a note about the workflow is not activation. Reply “enabled” only after the rule has actually been stored successfully.

### Why this belongs in v1

The user repeatedly described this behavior, including group use, and had to repeat it. The current group name gate and phrase auto-replies cannot execute it. A narrow rule addresses the actual request without building a generic automation framework.

### Done when

An enabled, permitted bare link produces one summary and one saved item. Disabled rules, unpermitted senders and ordinary unaddressed conversation do not trigger. Duplicate delivery, restart and partial failure do not create duplicate items. Failed reading does not produce a success claim.

### Explicit limitation

DM and group destinations remain separate. The previously requested shared collection is **not delivered by this v1**. Ellie must state that limitation when asked, rather than claim that identically named lists are shared. Shared collections need their own small design and explicit migration permissions.

Hiring classification, application reminders, form filling and browser-tab lifecycle changes are deferred. Existing reminders and browser tools remain available through ordinary requests.

## 4. Tighten coding continuation and retain a blocked request

### Change

First fix normal continuation using existing worker project/status tools. Existing job or project references should not require a fresh repository URL. Keep the source-import check when a repository is actually being imported or changed; do not simply remove it.

For an explicit continuation of an identified project, save a minimal encrypted Pi-local submission record before sending it: owner, project/job reference, requested continuation, original request ID and submission state. This is a small outbox for coding continuations, not a second job manager.

On acceptance, record the worker job reference and let the existing worker and notification loop take over. If the response is lost, use the same request ID and the worker's persisted receipt when reconciling. Inspect the worker protocol and add a narrow receipt lookup if necessary; absence from a casual status listing is not proof that a request was never accepted.

If the laptop is unavailable, say the request is saved on the Pi and has not been confirmed by the worker. Default to resuming when the owner asks again, not automatically launching work when connectivity returns. Cancellation removes or cancels the local pending request and reconciles any worker acceptance before claiming the job stopped. Expired or ambiguous requests need a new owner instruction.

Limit v1 to continuation of an existing project. New-project offline queuing, general task graphs and autonomous retries are deferred.

### Why this belongs in v1

The worker already persists projects and jobs. The observed gaps concern referencing those projects correctly and preserving a request before external acceptance. Duplicating worker state would introduce more failure cases.

### Done when

An unambiguous continuation does not request the same repository URL again. A Pi restart during laptop downtime retains the blocked request. A lost acceptance response and later retry cannot create two jobs. A cancelled pending request cannot run later. Owner-private restrictions remain enforced.

## Implementation order and release gate

1. Ship cleanup validation/backoff and atomic note replacement first. These are small fixes with independent value.
2. Add the narrow link rule and verify its permissions and dispatch behavior.
3. Add coding continuation reconciliation and the small Pi outbox.

For each step, run `npm run typecheck` and focused, isolated checks using fake users and scratch encrypted storage. Mock model/worker responses for failure cases. Do not send real messages, emails or invites in tests, and do not start a second live WhatsApp session.

Compare against a short set of synthetic examples based on the observed failures: contradictory preference, stale archive passage, malformed cleanup, bare group link, duplicate link, captioned link, existing project continuation, laptop outage, lost submission response and cancellation. Passing means correct stored state and permission behavior, not merely reassuring wording.

After deployment, use existing content-free diagnostics to track cleanup success/failure, workflow outcomes and blocked coding submissions. The owner can try the real interactions. More extraction calls or a bigger prompt are not default remedies for a failed check.

## Resource, privacy and compatibility rules

- No new local model, database, graph index, daemon or mandatory laptop connection for memory.
- No wholesale history reprocessing, bulk inbox ingestion or copy of private chats into maintenance reports.
- Keep new files under the existing encrypted data directory so the backup system includes them. Verify their inclusion and a scratch restore; leave installed backup/deployment controls unchanged.
- Bound records and queues, define expiry for receipts/pending requests and keep failures out of normal reply latency.
- Keep private and group data separate, recheck tool permissions and preserve all existing outgoing-action confirmations.
- Public code and examples contain no real identities, deployment settings or private evidence.

## Deliberately deferred

Knowledge graph; embeddings and semantic search; a new memory schema with complete provenance; temporal reasoning engine; general workflow builder; shared-list migration; automatic self-improvement from conversations; operational shell access; unified task manager; new backup infrastructure.

Revisit these only after the small release is working and a specific remaining failure demonstrates the need. The existing encrypted notes, recap and recall remain the memory system for v1.


## Implementation and validation record

Implemented using the existing note format and encrypted data directory:

- `memory.ts`: validated cleanup output, persisted retry backoff and single-write note replacement; `agent.ts` supplies the replacement tool field and blocks scheduled preference replacement.
- `link-workflow.ts`: one opt-in rule per chat, with serial dispatch in `index.ts`, current registration/admin/member checks, prepared receipts and idempotent list additions. Uses existing public-link reading and one summary call through the configured provider; no browser session or additional agent loop.
- `coding-outbox.ts`: at most ten unresolved continuations per owner, with seven-day resume eligibility and explicit resume/cancel tools. Uncertain requests are not silently expired or replayed.
- `coding/worker.mjs`: persisted receipt lookup and atomic withdrawal. Withdrawal blocks a delayed original request; cancellation never automatically stops a later revision of the job.

Focused isolated checks covered 21 cases, including malformed cleanup, stale writes, correction backup invalidation, explicit activation, group permissions, duplicate links, prepared-receipt recovery, laptop downtime, lost acceptance responses, expiry and unacknowledged cancellation. Additional checks covered media-caption exclusion, removal of finished receipt text, receipt expiry and encrypted scratch-file restore. Separate worker checks covered receipt persistence across restart, owner isolation, duplicate submission, late arrival after withdrawal and later-revision protection. TypeScript and coding service syntax checks passed. No real WhatsApp message, email, invite, coding project or model request was sent during these checks. Ad-hoc test files were removed afterwards.

The existing backup inventory includes every regular data file except temporary/handoff files, so both new sealed stores are covered without changing installed maintenance controls. Encrypted-file creation was checked; an end-to-end deployed Restic restore was not rerun for this local change.

These isolated checks do not constitute a live-model evaluation. The link rule remains disabled until explicitly configured in each chat. The new worker protocol must be installed before testing Pi-side resume/withdrawal; an older worker fails safely rather than blindly resubmitting uncertain requests.

A registered non-admin fixture also verified DM/group tool availability for link saving, public browsing and shared-mail sending, while withholding inbox, coding and admin tools. Installation-time owner-authorized provisioning can initialize a registered person’s private link rule; existing personal settings are preserved.
