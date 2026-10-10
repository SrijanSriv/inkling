# Coding through Inkling: v1 proposal

Status: implemented initial release. Scope agreed: general coding projects first. The README's coding section
documents the delivered behavior and limitations; this document retains the original architecture proposal below.

Implementation uses dependency-free JavaScript worker modules, sanitized revision snapshots rather than Git
worktrees, source `.tar.gz` delivery, and optional static previews. Separate Codex processes per project are necessary
because standalone verification inherits the app-server's initial workspace permissions. Up to three project sessions
are retained; eviction preserves files and sealed task context, and the next continuation starts a new thread.
Public GitHub source imports now run in a bounded preparation step before the sandbox starts. Built-in hosted web
search is enabled independently of offline project commands. Dependency installation, backend preview servers and
public publishing remain outside this release.

## What the owner can do

Ask in a private WhatsApp chat to create a project, explain an approved codebase, fix a bug, add a feature, write relevant tests, or refactor code. Follow up with changes to the same job, ask for status or the diff, and cancel work. The result is code in a persistent laptop workspace, a downloadable source archive or patch, and a short report of what changed and what was actually checked.

Start with small scripts and Node/TypeScript/web projects supported by the installed toolchain. Existing repositories are registered by the owner under friendly aliases. New projects go into a dedicated projects directory. Unsupported languages or missing dependencies produce a clear setup requirement rather than an invented successful result.

Normal coding requests start immediately. Ask only for information that materially affects the result, such as which of two projects to edit. Use sensible defaults for reversible implementation choices. Publishing, installing software on the host, running production migrations, and deploying services are outside v1. So are self-changes to Inkling, group access, and access to personal WhatsApp, Gmail, music, or authenticated browser sessions.

Example conversation, illustrative rather than a receipt of work already done:

> Owner: Ellie, make a small expense tracker with CSV import.
>
> Ellie: Started C12 on the laptop. I’m making a local web app with CSV import and a monthly summary.
>
> Ellie: C12 is ready. CSV import and monthly totals work in the checks I ran. I’ve attached the source. Bank connections aren’t included.
>
> Owner: Add categories and make it dark.
>
> Ellie: Continuing C12 with categories and a dark theme.

“Started” requires acknowledgement that the laptop began the job; an offline laptop gets “queued”. “Ready” requires an independently collected change/check report, not just Codex saying it finished. Failed or absent checks remain visible.

## Architecture

```text
Owner's WhatsApp
      |
Inkling on Pi: permissions, intent, short replies, notification delivery
      |
Private SSH tunnel: narrow authenticated job API
      |
Laptop coding worker: durable queue, workspaces, checks, artifacts
      |
Codex app-server over local stdio: one active coding job
      |
Isolated project workspace and explicitly approved dependencies
```

Use a small TypeScript worker in this repository, deployed as a separate laptop user service. The worker controls `codex app-server` through JSONL on stdin/stdout. It uses the existing ChatGPT login; Inkling's normal conversation model remains unchanged. The app-server is a local child process, never exposed directly to the Pi or LAN.

Use a separate SSH forward and authenticated loopback worker endpoint, following the browser deployment pattern. Configure addresses and credentials through environment variables, not source code. Only expose project/job operations; there is no generic shell, arbitrary path, or raw Codex RPC endpoint.

Why app-server: it provides thread/turn events, interruption, steering, and structured questions/approval requests for a custom client. `codex exec --json` is useful for a one-shot batch job but would require more wrapper work for this conversational lifecycle. Pin the installed CLI version and generate its protocol types; the installed version is 0.162.1 at inspection time. Validate protocol compatibility before accepting jobs after an upgrade.

## Jobs and conversation

The worker owns the authoritative job record:

- Job ID, owner ID, project alias, stable incoming-request ID and creation time.
- Original brief, follow-up requests and any answers, encrypted at rest.
- Workspace ID, source baseline, current revision/diff digest and artifact manifest.
- Codex thread/turn IDs while alive; structured checkpoints for recovery.
- Current state, event sequence, check results, limits, expiry and cancellation status.

States: `queued`, `preparing`, `running`, `waiting_for_input`, `checking`, `ready`, `failed`, `interrupted`, `cancelled`. A continuation creates a new revision of the same job; it does not silently rebase onto unrelated changes. One job runs at a time, with at most five waiting. An initial configurable active-work timeout of 30 minutes and bounded retries prevent endless loops. Waiting for the owner's answer does not consume that active-work budget.

Submission returns quickly after durable acknowledgement. No Codex turn runs inside Inkling's WhatsApp message handler. The owner can keep chatting, playing music, and browsing while coding continues.

Use incoming WhatsApp message IDs for submission deduplication. A network timeout means “status unknown, checking”, not permission to start another job. Persist worker events and the Pi's notification cursor. Reconnect retrieves missed events. Notifications are delivered when WhatsApp is connected; transport retries may produce duplicates, so include job/revision identifiers and deduplicate wherever possible.

Send only meaningful events: accepted/started, an essential question, a blocker, completion, or cancellation. No command-by-command transcript, reasoning stream, raw JSON, shell output, or artificial progress percentage. Status requests get the actual current phase and latest verified milestone. Coalesce repetitive progress.

“Continue that” resolves only when one recent job is unambiguous. If several jobs fit, ask which one. Questions have a persistent job/question ID. Route answers to that question explicitly; never let a coding “yes” confirm an unrelated email or browser draft. Cancellation interrupts the active Codex turn, terminates remaining job processes, closes its preview, and preserves files for inspection. Discarding a project is a separate explicit action.

## Workspace and execution boundaries

Register existing repositories through trusted setup: an alias, canonical source location, supported toolchain, check commands and optional preview command. The model chooses only an alias, never an arbitrary host path. A trusted helper snapshots the source into a private worker-owned Git repository and creates an isolated job checkout/branch. Credentials, hooks, `.env`, runtime data, dependency directories and unrelated files are excluded. Handle symlinks, submodules and secret-like tracked files explicitly; a `.gitignore` alone is insufficient. Record the baseline and all exclusions.

Uncommitted source is not silently discarded. Either include the owner's explicitly selected working snapshot, including reviewed new files, or use a chosen commit. If the source changes later, the job remains based on its recorded snapshot. Applying a patch elsewhere is an explicit operation and refuses a conflicting baseline. The worker never edits the running service or the owner's original checkout in place.

Git worktrees isolate changes, not permissions. All model commands and all project check/preview processes need the same enforced sandbox:

- Write access only to the job workspace and its disposable scratch directories.
- Restricted read access to that workspace, platform necessities, and approved tool/dependency locations. Default workspace-write alone does not provide this restriction.
- No read access to SSH keys, Codex authentication, Inkling data, personal browser profiles, other jobs, or the rest of the laptop home directory.
- Network access off for project commands by default. The app-server's own authenticated model connection is separate from project command access.
- Controlled environment, no inherited secrets, no login shell, no inherited personal MCP servers, plugins or hooks.
- Process-tree cancellation and per-job resource limits, including children, checks and previews. Measure limits on this laptop alongside the browser; start with one active job rather than guessing a high concurrency.

Use the app-server's explicit restricted sandbox policy and verify it with canary tests. Never fall back to full access when a sandbox or tool is unavailable. In particular, do not use `thread/shellCommand`: the documented API runs it outside the sandbox. Worker verification must use a sandboxed execution path too; invoking `npm test` directly from the trusted worker would bypass the boundary.

Dependency setup is a separate controlled preparation operation, using approved package sources and a recorded lockfile. Treat install scripts as untrusted code and keep them sandboxed; do not run them against the host with user credentials. A dependency that needs additional access becomes a specific setup blocker. Repository instructions guide coding style but cannot grant more host access or change worker policy.

## Persistence and recovery

Reuse Inkling's encrypted-state approach, with a distinct worker key on the laptop. Keep raw briefs, questions, responses and detailed logs out of systemd logs and plaintext state files. Code and requested code artifacts are normal project files; private WhatsApp histories are not copied into them.

Codex normally stores session material, so use `ephemeral: true` threads and a worker-owned volatile runtime for session/log storage. Verify that no prompt-bearing files escape that runtime. Keep the existing login credential in its protected location without exposing it to project commands. Test configuration overrides and authentication separately before production; do not copy the whole personal Codex configuration into jobs.

An Inkling restart reconnects to the still-running worker. A worker/laptop restart restores sealed job records and files, marks the former active turn interrupted, and starts a fresh Codex thread from the saved brief, checkpoint, diff and check report when continued. This preserves the project, not an exact reconstruction of hidden reasoning. Do not promise transparent Codex session restoration from an ephemeral thread.

Login expiry, usage limits, missing tools, unavailable laptop, sandbox failure, disk pressure and timeout are explicit states with a useful next action. Avoid automatic infinite retries or silently switching accounts/models. Cleanup expires volatile previews and old temporary files but does not delete accepted projects without an explicit retention policy.

## Verification and delivery

Codex proposes the summary; the worker independently collects the actual changed/new/deleted paths and runs the configured checks under the job sandbox. A check record contains argv, exit status, bounded output, revision/diff digest and timestamp. Missing checks mean “not checked”. If code changes after checking, those results no longer certify the new revision.

Return a short natural-language report: what was built, the important behavior, which checks passed or failed, and any practical limitation. Keep raw diagnostics available on request. Preserve the complete source and a patch including new files and deletions. Generate archives from an explicit safe manifest, excluding dependencies, secrets, logs and runtime state.

V1 needs a small WhatsApp document-sending adapter: the current `ChatActions` exposes images but not document attachments. Send the requested source ZIP or patch only to the owner's private chat, with size limits. This is delivery to the requester; it does not need an unrelated `confirm_send` email draft.

For supported web projects, provide an optional temporary preview on home Wi-Fi through a token-protected worker gateway. Run only the registered preview command in the job sandbox, bind its server to loopback, proxy only that job's port, and stop it on cancellation/expiry. A working HTTP response alone is not a functional browser test. Keep authenticated personal browser sessions separate. The current browser service blocks private URLs, so automated browser inspection needs a separately designed narrow preview-origin permission; do not globally disable its private-address protections. Away-from-home previews, public deployment and production integrations are deferred.

## Changes to this repository

| Location | Responsibility |
| --- | --- |
| New `coding/` worker modules | Queue, sealed state, project registry, workspace preparation, Codex adapter, sandboxed checks, artifacts and optional previews |
| New `src/coding-client.ts`, `src/coding.ts` | Bounded job requests, runtime validation, status mapping and notification polling |
| `src/agent.ts` | Owner/private tool offering and runtime enforcement; `coding_projects`, `coding_start`, `coding_status`, `coding_continue`, `coding_cancel`, `coding_artifacts` |
| `src/index.ts` | Background event delivery, reconnect handling, coding question routing and document actions |
| `src/whatsapp.ts` | Bounded document delivery to the requester |
| `src/config.ts`, `.env.example` | Optional coding endpoint/secret; feature off unless configured |
| `scripts/`, README | Laptop worker and Pi tunnel user-service templates, install/preflight/recovery instructions |

Existing `src/changes.ts` remains the optional GitHub/Claude self-change flow. Its workflows target Azure deployment, not a generic laptop project workflow. V1 does not redirect it to Codex or grant the coding worker deployment credentials.

Do not extend `src/drafts.ts` as a catch-all coding queue: it is an in-memory, single-slot, 30-minute confirmation store. Coding jobs/questions require their own persistent records. Follow the music client's bounded request/response pattern and the change tracker's reconnect-aware notification pattern, with durable events added.

## Rollout and acceptance

1. Implement and exercise the worker against a fake Codex transport: duplicate submissions, state transitions, continuation, cancellation, timeouts and recovery. No live WhatsApp session in tests.
2. On the laptop, run a disposable real Codex task in a scratch project. Prove denied access to canary files outside the workspace, blocked project networking, bounded resources and sandboxed checks. Verify login works without credential exposure and prompts do not persist in plaintext.
3. Add the Pi client and owner/private tools. Test that group members, guests and non-owner private users cannot submit or inspect jobs, including direct runtime dispatch attempts.
4. Test delivery with a fake WhatsApp sender, including disconnect/restart, a concurrent email draft, two outstanding coding questions, and a retried submission. Run repository typecheck after code changes.
5. Enable with one disposable project. Ask for a script, request an edit, inspect the artifact, induce a failed check, cancel a job, and restart each service separately. Confirm music/browser service processes remain independent.

Definition of ready: those checks pass; artifacts can be retrieved; the owner can continue/cancel a job; failures are reported honestly; neither an offline laptop nor a restart causes duplicate coding work. Public publishing, Inkling self-edits and automatic deployment need a later design.

## Inspection and primary references

Inspection confirmed a ChatGPT-authenticated Codex CLI on the laptop, a working basic Codex sandbox invocation and Linux namespace preflight, and an active separate browser service. These are prerequisites, not proof that the proposed isolation and worker are already implemented. Installed protocol schemas confirm `thread/start` supports `ephemeral`, and `turn/start` accepts an explicit `sandboxPolicy`.

- [Codex app-server](https://learn.chatgpt.com/docs/app-server): custom-client protocol, events, questions, sandbox policies and execution methods.
- [Codex approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security): read/write/network boundaries and platform sandbox behavior.
- [Non-interactive Codex](https://learn.chatgpt.com/docs/non-interactive-mode): the batch CLI alternative and JSON output.
- [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk): SDK alternative for embedding coding runs.

The architecture, limits, rollout and WhatsApp behavior above are project design recommendations, rather than features supplied automatically by Codex.
