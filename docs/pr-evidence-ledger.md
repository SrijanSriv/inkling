# The evidence ledger in improvement PRs

Each nightly improvement PR is a followable record, not just a list of changes. The trusted publisher builds
this body after validation. A model cannot substitute a private-chat reference or invent a passing probe result.

## What the PR contains

1. **Input and privacy manifest:** exact public base revision, probe suites, public code-inspection targets,
   previous public backlog, and the author-approved descriptions supplied to this run. It states that
   conversations, quotes, original WhatsApp IDs, participant identities, private counts, memories, recordings,
   mailbox data, credentials and recovery backups were not provided as review evidence. The normal public repo
   identity and runtime workspace context are not anonymous.
2. **An entry for each meaningful improvement:** problem, before behavior, where it came from, change/addition,
   before and after code links, verification, limitations and unanswered questions.
3. **Host-verified checks:** typecheck, browser/coding syntax checks, and a complete fresh-default-branch versus
   after-patch table for the fixed synthetic suite. No passing check may regress. The public fixture is linked.
4. **Every selected approved request:** random ID, exact shared description, disposition and reason. This makes
   consented sharing visible rather than quietly hiding it in the prompt. The requester's identity is not included.
5. **Every public inspection target:** proposed/no-issue/deferred assessment and source-grounded note, plus
   significant remaining work and the reason it was deferred.
6. **Deployment and permissions:** what was protected, that the model had no publishing/deployment credentials,
   and that this is a proposed PR requiring human review and merge.

The owner WhatsApp notification contains the issue-to-change ledger and source IDs, plus the PR link for the
complete code, check and privacy record. It does not pretend its shorter message contains the entire PR body.

## Allowed evidence sources

| Source | What it proves | What it does not prove |
| --- | --- | --- |
| `probe:<fixed ID>` | The host's synthetic before/after result on public source | That a real person experienced the failure |
| `inspection:<public target ID>` | The reviewer examined a public-code lead and supplied real code references | That the conclusion or every runtime edge case is correct |
| `feedback:<random request ID>` | An exact general description was supplied through the author-approval path | The identity of its author, or that an alleged bug has been reproduced |

A request's approval receipt and any mapping to its owner remain encrypted on the Pi. Its author can use
`/feedback` to trace their own request. The PR does not reveal a DM link, phone number, original message ID,
private timestamp or identity to let someone else find that conversation. Original chat evidence needs separate
author permission; it is never automatically attached to improve the apparent strength of a PR.

The described input boundary is enforced in code, but it is not a promise that free-form approved prose is
anonymous. Authors must review the exact wording and omit other people's information. If a model claims it
read a private chat or mentions unsupported activity, that would be inconsistent with this run's allowed input
manifest, and should be challenged. It is not legitimate evidence merely because it sounds specific.

## Publication validation

`ops/pr_ledger.py` validates ledger sources against the fixed suite, public target catalog and selected approved
IDs. Before references must exist in the public base Git tree. After references must exist in a changed source
file. Absolute paths, parent traversal, protected data paths, nonexistent lines and symlinks are rejected.
Every changed file must have a trace, and every request/inspection target marked proposed must appear in a ledger
entry. New requested additions may lack an existing-code before reference; software bug claims must have one.

The host inserts public commit permalinks after committing the validated patch, so links trace the exact source
rather than mutable `master`. It inserts actual probe results and a fixed privacy disclosure itself. The trusted
suite must match its public fixture before starting a model turn. The body is bounded; missing or oversized
ledgers fail publication rather than silently truncating the evidence. Existing protected-path, overlap, patch
size and obvious-secret checks remain in place.

Reviewer-reported exploratory checks and reasoning are labelled separately from host-verified checks. Mechanical
line validation does not prove that a citation supports a claim, nor that a test is sufficient. Human review is
still necessary. This makes evidence and limitations inspectable; it does not turn a model's reasoning into proof.
