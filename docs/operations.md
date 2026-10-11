# Nightly recovery, diagnostics and reviewed deployment

These optional host jobs are off until installed and configured. They use the existing Pi/laptop SSH connection,
not a public API. There is no cloud backup subscription. Codex reviews consume the logged-in account's ordinary
usage allowance. GitHub Pages is unrelated to these private backups.

## What runs

- The Pi captures a snapshot at **00:00 in the configured timezone**, with a persistent systemd timer. A boot
  trigger catches missed nights; a 15-minute retry transfers pending backups/reports when the laptop returns.
  The supplied timer uses Asia/Kolkata: edit it and the JSON timezone together for another location.
- Restic encrypts a private local repository, then rsync mirrors it over SSH to the laptop. Local snapshots remain
  available during laptop outages. Memory, history, archives, notes, reminders, queues, accounts and WhatsApp
  sessions are included, together with `.env` (including the data encryption key), service definitions and committed
  source. Only regular data files are accepted. Transient `.tmp` and handoff files are excluded.
- The copy is accepted only if the source content hashes remain unchanged across it and the copied files match.
  This avoids stopping chats or music. It is a stable file snapshot, not a database transaction across all files.
  Busy data is retried rather than silently accepted. Temporary private staging copies are removed in `finally`.
- Every backup is restored into private scratch storage and compared by checksum, then the scratch copy is removed.
  Restic metadata is checked daily and all repository data on Sundays. Retention is 30 daily, 8 weekly and 12 monthly
  recovery points. Pruning follows a successful restore check. The laptop mirror is guarded by `backup.lock`;
  its completion marker is written only after a successful transfer.
- A separate report contains aggregate event/tool/error counts, known error categories, source locations, the public
  code revision and a connection-health boolean. Unknown logger text is discarded. No chat history, memory,
  message text, tool arguments, addresses, contact identifiers, raw errors, mailbox data or credentials enter the
  report. It cannot establish whether replies were helpful, actions were semantically correct or music was audible.
- The laptop clones the configured public GitHub repository. Once per report date, Codex inspects current source
  and diagnostics in a disposable workspace, with command networking disabled and private host files inaccessible.
  It can research public documentation through hosted web search. Permission and filesystem/network canary checks
  must pass before a model turn starts. The same pinned Codex adapter as the general coding worker is used.
- The wrapper verifies typecheck and browser/coding syntax checks in that sandbox. Changes to `.github/`, `ops/`,
  instruction files, credentials and runtime data are refused. Change count/size, symlinks and obvious private
  information are checked before upload. The model has no GitHub token, backup password or deploy credentials.
  A separate wrapper pushes `codex/nightly-YYYY-MM-DD` and opens a PR. It never merges. An existing maintenance
  PR suppresses new code edits, preventing duplicate speculative PRs while you review.
- Findings and usage advice are sent only to the configured owner's private WhatsApp chat. Backups, PR links,
  update successes and failures use the same encrypted, retryable local notification inbox. GitHub PR notifications
  also apply according to your GitHub preferences. Advice without a code change is kept in the private report and
  message rather than creating an empty PR. A report with nothing actionable produces a short completion notice.
- Every five minutes the Pi fetches the configured default branch (typically `master`, not necessarily `main`).
  It refuses dirty or diverged checkouts. A fresh release installs dependencies without lifecycle scripts, runs
  typecheck and syntax checks, and takes a recovery snapshot. It switches the service's release symlink, restarts
  one assistant instance and checks the exact commit plus WhatsApp connection. Failure switches back and alerts
  the owner; the failed revision is not retried indefinitely. Only merged default-branch code is eligible.
  Rollback restores code, not application data; review data/schema changes for backward compatibility.
  This updater deploys the Pi assistant and its music service. When `reading_service` is configured and active,
  it stops intake before switching releases and resumes it after a healthy deployment or rollback. Separately installed laptop browser/coding services
  and trusted maintenance wrappers need manual installation after review; a merge does not update those services.

## Immediate updates with a GitHub webhook

The optional `inkling-webhook.service` runs a separate Python receiver on loopback (default port 8789).
Expose only this receiver with a persistent HTTPS tunnel such as Tailscale Funnel, never the assistant, browser,
coding worker or a data directory. Funnel requires its account-level HTTPS/Funnel setup; `tailscale funnel --bg
http://127.0.0.1:8789` persists across reboots. Its public URL plus `/github` is the webhook endpoint.
If the client says `serve config denied`, an administrator must run that command with `sudo`. A node-not-found
error on the setup link can mean the browser is signed into a different Tailscale network from the Pi.

Add `webhook_repository_id` (GitHub's numeric repository ID), `webhook_secret` (a private file containing a random
signing secret of at least 32 bytes) and optional `webhook_port` to the Pi's private operations configuration.
Install the current `ops/` trusted wrappers, including `webhook_queue.py`, then install and enable the receiver's
user service. Register a repository webhook for **push** events, JSON content, SSL verification enabled and the
same secret. Do not put secrets or deployment URLs in source. The publisher's Contents/PR token deliberately
does not have webhook-administration access; creating the webhook needs a repository administrator once.

The receiver checks `X-Hub-Signature-256` against the raw body, the repository ID, the configured branch and a
non-deletion push. Invalid signatures fail closed. It persists a bounded delivery-ID ledger and coalesced queue
before returning, without retaining payloads, commit messages or request headers. Retries of a delivery are
deduplicated. A background dispatcher wakes the existing checked updater; the request cannot supply a command,
repository URL or deployment revision. Git is still fetched from the configured origin. Updates received while
backup/deployment is busy stay queued, and a push received during deployment causes another fetch afterward.

Verify a GitHub ping and an actual default-branch push, then install
`scripts/inkling-update.timer.d/webhook.conf` as a user-timer drop-in and reload systemd. This changes the fallback
from five minutes to **hourly**, retaining a boot check. Keep five-minute polling until the webhook works.
The hourly/boot check catches changes missed while the Pi or tunnel was offline. GitHub delivery failures can be
inspected and redelivered in repository webhook settings. `webhook-queue.json` records only delivery IDs and times;
an empty `pending` field means the updater handled the latest queued hint, including deliberately paused updates.
Backups and checked deployment/rollback are unchanged.

To disable immediate updates, disable `inkling-webhook.service`, remove its tunnel mapping and deactivate the
GitHub webhook. Remove the timer drop-in and reload/restart the timer to restore five-minute polling.

## Installation

Requirements: Python 3.12+, SSH/rsync, Restic, Node/npm, systemd user services with lingering enabled; the laptop also
needs GitHub CLI and the supported pinned Codex binary plus its existing ChatGPT sign-in. Install tools from trusted
package registries. The jobs do not need root. Keep configuration/state directories mode 700, files mode 600.

Copy `ops/` and `coding/codex.mjs` into `~/.local/lib/inkling-ops/`, preserving their relative paths. This installed
trusted wrapper is **not automatically replaced by model-generated PRs**. Changes to maintenance controls require
manual installation after review. Configure each host using `ops/pi.example.json` or `ops/laptop.example.json` at
`~/.config/inkling-ops/config.json`. All deployment identities and locations belong in private configuration.

Generate a random Restic password outside the repository and put it at `backup_password` on both hosts. Keep a
separate recovery copy on another trusted device: losing the Pi and the only copy of this password would make the
laptop backup unreadable. The password is not stored inside its own encrypted backup. Restic's encryption protects
stored backup contents; the operator and anyone holding the password can restore them. Two copies on the same home
network are not an off-site disaster-recovery plan; an occasional independent offline copy is recommended.

The laptop publisher uses a fine-grained GitHub token restricted to the chosen repository with **Contents** and
**Pull requests** read/write. Metadata read is implicit. Store it in the configured private `github_token` file.
The model's sandbox must not include that file or its containing directory. It needs no Actions, administration,
workflow or merge automation permissions. Renew it before expiry. The review job waits without consuming a report
when the token is absent.

Configure the assistant service's `WorkingDirectory` to `<releases>/current`, initially a symlink to the existing
checkout. Keep `.env` and data in the canonical checkout; release candidates link them only after code checks pass.
Set `INKLING_OPERATIONS_NOTIFICATIONS=true` in that private `.env`. This only enables owner notices, not new tools.
Adjust the service PATH and executable for the installed Node. The music service can use the same current-release
working directory; it only restarts on music/dependency changes.

Copy the matching `scripts/inkling-{nightly,update,review}.{service,timer}` into `~/.config/systemd/user/`: nightly and
update on the Pi, review on the laptop. Add the Node tool PATH as a service environment override where needed.
Reload systemd, enable the timers and check their next trigger times. Run a first backup and checked deployment
manually before relying on the timers. Never start a second copy of the WhatsApp assistant for a test.

## Recovery and operations

On the laptop, with paths from its private config:

```sh
export RESTIC_REPOSITORY=/path/to/operations-state/backups
export RESTIC_PASSWORD_FILE=/path/to/private/restic-password
flock /path/to/operations-state/backup.lock restic snapshots
# Restore into a NEW private directory, never over the running service:
flock /path/to/operations-state/backup.lock restic restore latest --target /path/to/private/restore
```

The restore directory contains `recovery/`: data, `.env`, systemd definitions, source and a manifest.
Stop the assistant before restoring data in place. Install the saved source and dependencies, restore `.env` with
mode 600 and `data/` privately, then adjust service paths for the replacement machine. Start only one WhatsApp
instance. Tokens may have been revoked since backup; reconnect Google if needed. No backup test sends messages or
emails or reconnects a copied WhatsApp session.

Useful status files in the private state directory: `nightly.json`, `transfer.json`, `deploy.json`,
`backup-last-success` (laptop), `review-state.json`, `last-review-validation.json`. `systemctl --user list-timers`
shows schedules; journal entries report sanitized maintenance outcomes, never subprocess output or model text.
`python3 ~/.local/lib/inkling-ops/ops/nightly.py --force` forces a recovery point;
`python3 ~/.local/lib/inkling-ops/ops/deploy.py --retry` retries a previously failed revision after investigation.
Stop a feature by disabling its timer. A failed laptop review leaves the report pending for retry; a completed PR
is rediscovered after a crash instead of publishing a duplicate. Transfer notices can be delayed while either
host or WhatsApp is offline. A crash between sending a notice and recording its receipt can duplicate that notice.
