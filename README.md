<p align="center"><img src="assets/inkling-card.jpg" alt="inkling" width="480"></p>
<p align="center"><em>free intelligence for all</em></p>
<p align="center">Say hello: <a href="mailto:hello@inkling.free">hello@inkling.free</a></p>
<p align="center"><a href="https://buymeacoffee.com/inklingfree"><img src="https://img.shields.io/badge/Buy%20me%20a%20coffee-inklingfree-FFDD00?logo=buymeacoffee&amp;logoColor=black" alt="Buy me a coffee"></a></p>

# inkling

Optional local voice-note transcription: run the [private speech gateway](speech/README.md) beside an existing
whisper.cpp server on another machine. Registered users can speak English or Hindi/English and get text replies;
the Pi keeps the normal chat permissions and encrypted history.

Optional Pi microphone calibration: the owner's private **`/mic`** command opens a short-lived home-network
Listen/Done page. It records the Pi microphone only while requested, shows input levels, and sends the actual
Whisper transcript to the owner's WhatsApp without acting on it. This first stage has no wake-word detector or
automatic assistant answer. See [the microphone design and acceptance plan](docs/microphone-v1.md).

A personal assistant that lives in WhatsApp, for you and a few friends. You text it the way you'd text a friend, on
your own or in a group chat, and it texts back. Each person gets their own private conversation, memory and
connected accounts.

> **Recommended default: it thinks with GPT models on Azure AI Foundry (Azure OpenAI) and runs on its own spare
> WhatsApp number as a linked device.**
>
> The models are plug and play: OpenAI directly, Claude, or any server that speaks OpenAI's Responses API work too
> (see [Models](#1-the-models)). It runs anywhere that keeps a Node.js process going, and `docker compose up` gets you
> started (see [Hosting](#4-hosting-it)).

inkling is self-hosted: you run your own copy, with your own model provider, Google and WhatsApp accounts, for
people you choose. It only ever replies to people on your list.

> **Heads up:** inkling connects to WhatsApp through [Baileys](https://github.com/WhiskeySockets/Baileys), an
> unofficial library that links to WhatsApp the way WhatsApp Web does. It is not an official WhatsApp API,
> WhatsApp's terms don't allow unofficial clients, and numbers used this way can be banned. **Use a spare number**,
> never one you can't afford to lose, and keep usage personal and low volume. Linking your own WhatsApp (an optional
> admin feature) carries the same risk for your own number.

> **You're responsible for your copy.** Whoever runs inkling is responsible for the data it holds and for using it
> lawfully and with the consent of the people it talks to. It comes with no warranty. See the [Disclaimer](#disclaimer).

## What it can do

- **Chat** in private or in groups, texting short and in the sender's style (no em dashes), with memory (`/memory`).
  Slow requests get a fitting emoji reaction within a second or two, then the answer. Saved notes carry the date
  they were saved (newer wins) and are tidied once a day; older messages are summarised into a running recap and can
  be searched ("what was that dentist called?").
- **Search the web** (your model provider's built-in web search) and read pages; recommendations arrive one per message with a
  real link. Finds tickets and tables near you and sends the booking page; once you say "booked", it sets a
  reminder and a calendar event.
- **See photos and understand voice notes** (gpt-4o-transcribe, with a per-person language hint). In groups, saying
  its name in a voice note calls it just like typing it. With an ElevenLabs key (`INKLING_ELEVENLABS_API_KEY`), a
  short reply to a voice note comes back as a voice note, and spoken reminders use that voice.
- **Reminders** ("remind me at 6", "every Monday at 9"; urgent ones also arrive as a spoken voice note), WhatsApp
  **polls** with readable votes, and emoji reactions.
- **Google**, with several accounts per person (`/connect google`, `/google`, `/disconnect google [email]`): search
  and read Gmail and save drafts; find and read Drive files (Docs, Sheets, Slides), make and add to Docs and Sheets,
  and manage Google Tasks; see, add and change Calendar events ("add the location", "move it to 12"), including "add
  it to everyone's calendar" in groups; Google Calendar "add to calendar" links; Google invites by email, from a
  private chat or a group (in a group, only to emails people posted there, confirmed in your private chat); and
  emails from your Gmail.
- **Lists** (shopping, packing), birthdays and yearly dates, **watches** ("tell me when tickets go on sale"), a daily
  **morning brief**, travel help from booking emails (calendar, check-in reminders, flight status), **images** made
  or edited with FLUX, shared location pins, and **auto-replies** ("every time someone says hype, send this").
- **Resends** a photo, GIF, video or sticker from the chat as a fresh message, not "Forwarded".
- **Your own WhatsApp** (admins, optional, `/link whatsapp`): it can say what's waiting for a reply, read a chat,
  and send a message as you after you say yes. It runs in its own process and stays in your private chat.
- **Websites** (optional): does things on websites in its own browser (search, fill forms, book, order, check in,
  cancel), including booking widgets embedded in the page. You sign in yourself through a live link (it never sees
  passwords); card fields stay out of its view; final steps come to you as a screenshot for a yes; buying is off
  until you set your own spending limit.
- **Changes itself** (optional): the owner can ask for a change in a private chat. After a yes, Claude Code makes it
  on GitHub; you get a summary, and after a second yes it's merged and deployed, with an automatic rollback if it
  doesn't come back healthy. "undo that" takes it back out.
- **People and roles**: the owner (one person, `"owner": true` in `users.json`) can make admins. Admins manage who it
  talks to by messaging it ("add Sam +44 7700 900042", "remove Sam", `/people`) and open groups. People can have
  several numbers.
- A **waiting list**: people who aren't on the list get a short, fixed reply (after a natural pause, at most once a
  day) with their place in the queue. Admins send `/waitlist` for a private 30-minute page to approve or decline
  them; approved people get their recent messages answered or a welcome. Replies to strangers are capped at 30 an
  hour, so a rush doesn't get the number banned.
- A **public home page** with `robots.txt`, a sitemap and `llms.txt` for search engines, and a short link
  (`/chat`, with an optional `?ref=` to count where people came from) that opens a WhatsApp chat with the assistant.
- **Usage analytics** (optional, PostHog): model costs and speed, tools used, answered messages and errors, with
  anonymous ids and never message contents.
- A plain **public home page** at the site root (`assets/home.html`) with a "say hello" link that opens WhatsApp to
  its number, and a privacy page at `/privacy` (Google's consent screen needs one).

Anything that goes out in your name (a WhatsApp message from your number, an email, a calendar invite) or costs
money is always shown to you first and only happens after you reply yes.

### Guests (optional)

Set `INKLING_GUEST_MESSAGES` (for example `50`) to let people who aren't on the list try it in a private chat, as a
guest: chat, web search, reminders, lists, polls and images, but no Google, calendars, websites or morning briefs.
Each guest gets that many messages a day; near the end it mentions that running your own copy is free (with
`INKLING_SOURCE_URL`), and at the limit it says so and goes quiet until tomorrow. At most 30 new guests an hour, so a
rush of new chats doesn't get the number banned. Off by default: strangers get the waiting list.

### Groups

It answers when someone says its name, @mentions it, or replies to it, and only to people on the list. An admin can
say "inkling speak to everyone" (or `/open`) to let anyone in that group talk to it there, and "inkling only talk to
people on your list" (or `/close`) to undo it. With `INKLING_OPEN_GROUPS=true`, a group with someone from the list in it
is open from the start (an admin can still `/close` it); a group with nobody from the list always stays closed.
Groups have their own memory. Personal inbox and WhatsApp tools are never available there, and calendars only
share when people are busy, never what the events are.

Optional shared sending uses one assistant mailbox already connected through Google. Configure
`INKLING_MAIL_USER_ID` (the connecting user id) and `INKLING_MAIL_ACCOUNT` (the exact Gmail address) to let everyone
in `data/users.json` request mail in DMs. Set `INKLING_MAIL_GROUPS` to comma-separated internal group chat ids to
allow requests in selected groups too. Shared sending defaults to the assistant mailbox; personal Gmail accounts
remain private to their owners. Each request gets an exact preview and needs the requester's yes in a later private
message within 30 minutes. Group requests are previewed privately, and another person cannot confirm them. Access
is checked again before sending, including current registration, group permission and the connected account.
The shared mailbox does not grant inbox/search access to other users. Sent mail is visible to whoever owns that
mailbox. The feature stays off unless configured.

With `INKLING_MAIL_REVIEW_ENABLED=true`, the shared mailbox also gets **owner-private important-mail reviews**.
The Pi checks new Primary inbox mail every 15 minutes, starting from activation rather than importing the old
inbox. It reads bounded thread text, uses the owner's private memory, recent words and previously approved replies
to propose a grounded response, and identifies itself as the owner's assistant. Other registered users retain
shared sending only; they never receive these alerts or gain shared-inbox access.

Alerts arrive between 09:00 and 22:00 in the owner's timezone, at most four a day and at least 30 minutes apart.
These are ceilings, not targets. Up to 20 messages are assessed per day; pending work carries over. Ordinary
newsletters and routine receipts are skipped. Important informational/security messages can get an alert without
a reply. If the answer needs an unknown fact or the owner's decision, the assistant asks rather than inventing it.
Attachments are not downloaded, links are not followed, and reading does not mark messages read.

Each review has an `M` number. Say **“list important emails”**, **“read email M1”**, **“open email M1”**,
**“skip email M1”**, **“pause mail alerts”** or **“resume mail alerts”**. A preview shows the actual recipient,
sending account, subject and exact reply. Say **“make it shorter”** to get a revised preview, then **“yes”** or
**“yes send email M1”**. Changes always require another yes. Reply-to headers, subject and Gmail thread ID are
set by code. Sending rechecks access and refuses if the conversation changed or was answered after the preview.
V1 replies to one address, never reply-all. A changed recipient requires a separate new-email preview.

Review records and writing examples are encrypted with the normal data and included in its backups. Approvals
expire after 30 minutes and do not survive a restart; opening the review shows a fresh preview. Important reviews
are kept for seven days. The monitor never replaces an active preview for another action. An uncertain delivery
is not automatically retried; open the review manually. Repeatedly unassessable messages are reported in the
important-mail list. Model triage can miss importance; it is assistance, not a guaranteed inbox alarm.

## How it works

Tool results are checked before a reply is sent. If the model invents an internal completion note or replies only
"checking"/"one second", inkling asks it to finish the work and answer. Completed actions are not rerun during
that final-answer retry. For simple lookups such as birthdays, lists and reminders, the code can send the actual
result if the model still fails to answer. Dependent tool calls run in order, and unavailable tools are refused.

```
WhatsApp (spare number) ──linked device──▶ inkling (Node.js) ──▶ GPT on Azure AI Foundry (or OpenAI, Claude, ...)
                                              │
                                              ├── data/            everything private, encrypted at rest
                                              ├── :8787            home page, Google sign-in callback, local-only QR page
                                              ├── personal worker  a forked process for an admin's own linked WhatsApp
                                              └── browser service  optional, browser/ (Chromium behind a small API)
```

- One Node.js process, run from TypeScript source with `tsx`. No database: per-person files under `data/`,
  encrypted with AES-256-GCM using `INKLING_SECRET_KEY`.
- Each message is one model turn with tools (OpenAI's Responses API, `store: false`, so nothing is kept on the
  provider's side between messages). Claude is reached through its own API, translated in `src/claude.ts`.
- Commands, sign-in links, confirmations and anything that sends are handled in code, never left to the model.
- Scheduled jobs (morning brief, reminders, dates, watches, travel checks) run inside the same process.

## Setup

You need: Node.js 24 or newer (or Docker), an account with a model provider (Azure recommended), a spare WhatsApp
number on a phone you control, and a computer or server to run it on. Google and the browser service are optional.

### The quick way: let a coding agent do it

A coding agent such as [Claude Code](https://claude.com/claude-code) can do most of the setup below: the repo's
`CLAUDE.md` (also `AGENTS.md`) tells it how inkling fits together. Open it in the cloned repo and paste:

```text
Set up inkling in this repository for me. Read CLAUDE.md and README.md first, then follow the README's Setup:
1. Check Node.js 24+ and run npm install.
2. Create .env from .env.example and generate INKLING_SECRET_KEY with `openssl rand -base64 32`. Ask me for anything
   you can't create yourself (the model provider's keys) and never print secrets back to me.
3. Set up the models (the README's "1. The models"). Recommend the default, GPT on Azure AI Foundry, using the az CLI
   if I'm signed in or telling me exactly what to click; use OpenAI, Claude or another server if I ask.
4. Create data/users.json from users.example.json with me as the owner and admin; ask me for names and numbers.
5. Run npm run typecheck, then npm start, and walk me through linking the spare WhatsApp number on its phone.
6. Only if I ask for them: Google sign-in, hosting with a public HTTPS address, the browser service, self-changes.
Stop and ask me before anything that costs money, sends a message, or changes anything outside this folder.
```

You'll still do a few things yourself: create the accounts (your model provider, and Google Cloud if you want Google), pay for
what you use, and scan the QR code with the spare phone. Expect 30 to 60 minutes the first time.

### 1. The models

Pick one provider with `INKLING_AI_PROVIDER`. **The recommended default is `azure`: GPT models on Azure AI Foundry.**

| `INKLING_AI_PROVIDER` | What it uses | Keys in `.env` | Default models |
| --- | --- | --- | --- |
| **`azure` (recommended)** | GPT on Azure AI Foundry | `AZURE_AI_RESOURCE`, `AZURE_AI_API_KEY` | `gpt-5-mini`; browser agent `gpt-5.4-mini` |
| `openai` | OpenAI directly | `OPENAI_API_KEY` | the same |
| `anthropic` | Claude | `ANTHROPIC_API_KEY` | `claude-opus-5-5` for both |
| `compatible` | any server that speaks OpenAI's Responses API: a gateway such as LiteLLM or OpenRouter in front of other models, or a local server | `INKLING_AI_BASE_URL`, `INKLING_AI_API_KEY` | set `INKLING_MODEL` and `INKLING_WEB_MODEL` |

Change models with `INKLING_MODEL` (chat) and `INKLING_WEB_MODEL` (the browser agent), for example a cheaper Claude
with `INKLING_MODEL=claude-sonnet-5-5`.

**Azure (recommended):**

1. In the [Azure AI Foundry portal](https://ai.azure.com), create a Foundry (Azure OpenAI) resource.
2. Deploy these models (by default each deployment is named after its model; set the `INKLING_*_MODEL` variables if
   you name them differently):
   - a chat model, e.g. `gpt-5-mini` (`INKLING_MODEL`), with web search available to it
   - `gpt-4o-transcribe` for voice notes (`INKLING_TRANSCRIBE_MODEL`)
   - optional: `gpt-4o-mini-tts` for spoken urgent reminders, `FLUX.1-Kontext-pro` for images, and a model for the
     browser agent (`INKLING_WEB_MODEL`, default `gpt-5.4-mini`)
3. Note the resource name (the `my-inkling` in `https://my-inkling.openai.azure.com`) and an API key.

**What changes with each provider:**

- **Web search** uses the provider's own search tool (Azure, OpenAI and Claude have one). It's billed per search, so
  it stops after `INKLING_DAILY_SEARCHES` a day (default 50). With `compatible` it's off unless you set
  `INKLING_WEB_SEARCH=on` and your server supports OpenAI's `web_search` tool.
- **Voice notes and images** use OpenAI-style audio and image models (`gpt-4o-transcribe`, `gpt-4o-mini-tts`, FLUX on
  Azure or `gpt-image-1` on OpenAI). Claude has neither, so with Claude add Azure or OpenAI keys as well if you want
  them; without, voice notes aren't transcribed and the image tool is hidden.
- **Claude** gets adaptive thinking, prompt caching and Anthropic's refusal fallback. The browser agent can't force a
  tool call on the newest Claude models, so it's asked to in its prompt instead.

### 2. Configure and run

```sh
git clone <your copy of this repo> inkling && cd inkling
npm install
cp .env.example .env              # fill in your model provider's keys and INKLING_SECRET_KEY
openssl rand -base64 32           # use this for INKLING_SECRET_KEY, and back it up
mkdir -p data && cp users.example.json data/users.json
```

Edit `data/users.json` with real names and numbers (digits only, country code first, like `447700900001`). Make
yourself `"owner": true` and `"admin": true`. Edits are picked up without a restart.

```sh
npm start
```

Then open http://localhost:8787/whatsapp **on the same computer** and scan the QR code with the spare phone
(WhatsApp, Settings, Linked devices, Link a device). The page only works from that computer, because whoever scans
it controls the number. Text the spare number from your own phone to say hello.

Only run one copy at a time: two copies on one WhatsApp session keep kicking each other off.

### 3. Google: Gmail, Calendar, Drive, Docs, Sheets, Tasks (optional)

1. In Google Cloud Console, create a project and enable the **Gmail**, **Google Calendar**, **Google Drive**,
   **Google Docs**, **Google Sheets** and **Google Tasks** APIs.
2. Set up the OAuth consent screen (External). inkling asks for `gmail.readonly`, `gmail.compose`,
   `calendar.events`, `drive.readonly`, `drive.file`, `documents`, `spreadsheets` and `tasks`. Use your
   `/privacy` page as the privacy policy URL.
3. Publish the app ("In production"). Leaving it in "Testing" makes everyone's connection expire every 7 days.
   Until Google verifies it, people see a "Google hasn't verified this app" warning (they tap Advanced to go on),
   and at most 100 people can ever connect; that cap can't be reset. Tell the people you add that the app is
   unverified and that connecting is at their own risk, for example on your home page next to the waiting list.
   Going past 100 means Google's verification: free for Calendar, Docs, Sheets and Tasks, but Gmail reading and
   drafts (`gmail.readonly`, `gmail.compose`) and `drive.readonly` are restricted scopes that also need a paid
   security assessment (CASA) every year.
4. Create an OAuth client (type **Web application**) with the redirect URI
   `<INKLING_PUBLIC_URL>/oauth/google/callback`, and put its ID and secret in `.env`.

People then text `/connect google` (or just ask) and get a one-time sign-in link. `http://localhost:8787` only works
on the computer running inkling; for friends' phones, run it somewhere with a public HTTPS address (next step).

For a mail-only deployment, set `INKLING_GOOGLE_SERVICES=gmail` and enable only the Gmail API. This limits new
sign-ins to Gmail reading and drafts/sending. The optional comma-separated setting also accepts `calendar`,
`drive`, `docs`, `sheets` and `tasks`; include at least Gmail, Calendar or Drive to identify the connected account.
Without the setting, sign-in continues to request all six services. Existing grants remain until disconnected.

### 4. Hosting it

inkling needs a long-lived process and a persistent disk for `data/`. A public HTTPS address is only needed for
Google sign-in and for the browser service's live sign-in links.

**With Docker (any server or VPS):**

```sh
cp .env.example .env          # fill it in (step 2), then:
mkdir -p data && cp users.example.json data/users.json
docker compose up -d
docker compose logs -f inkling        # first run: scan the WhatsApp QR code printed here
```

Everything private stays in `./data` on the host. To give it a public HTTPS address, put any reverse proxy in front of
port 8787 (for example `caddy reverse-proxy --from inkling.example.com --to localhost:8787`) and set
`INKLING_PUBLIC_URL` to that address.

**Anywhere else** (a small VM, Fly.io, Railway, Render, Azure App Service with `/home`, and so on):

- Set `INKLING_PUBLIC_URL` to its public HTTPS address, `INKLING_HOST=0.0.0.0` (it listens on `PORT` if the host
  sets one), and `INKLING_DATA_DIR` to a persistent directory. Run one copy only. If your host starts the new
  version before stopping the old one (Azure App Service does), they hand WhatsApp over without dropping messages:
  the old copy finishes its replies, lets go, and the new one answers anything that came in meanwhile.
- Copy `data/` (including the WhatsApp session in `data/auth/`) and the same `INKLING_SECRET_KEY` when you move it.
- `GET /health` returns the running commit (from a `version.json` written at deploy time) and whether WhatsApp is
  connected, which is handy for deploy checks.
- `.github/workflows/deploy.yml` and `.github/deploy.sh` are an **optional example** for deploying to Azure App
  Service from GitHub Actions, with a health check and automatic rollback. They do nothing until you set the
  repository variables listed at the top of the workflow. Delete them if you host elsewhere.

### 5. Websites: the browser service (optional)

`browser/` is a small separate service: one Chromium (Playwright) behind an HTTP API, plus a live view people use to
sign in to sites themselves. Run it as a container anywhere with HTTPS:

```sh
docker build -t inkling-browser browser
docker run -p 8080:8080 -e BROWSER_SECRET="$(openssl rand -hex 32)" inkling-browser
```

Optional: `BROWSER_LOCALE` (default `en-GB`) and `BROWSER_TIMEZONE` (default the container's) set what websites
see. Then set `INKLING_BROWSER_URL` (its public HTTPS address) and `INKLING_BROWSER_SECRET` (the same secret) for
inkling. Without them the feature is off. With Docker Compose, set both in `.env` and run
`docker compose --profile browser up -d`; it still needs a public HTTPS address, because people open its live
sign-in links on their phones. `.github/workflows/browser.yml` is an optional template for Azure
Container Apps, again driven entirely by repository variables.

#### Browser on another computer

The browser can run on a laptop while Inkling stays on a Raspberry Pi. The laptop does the Chromium work;
the Pi sends browser API requests. No browser CLI is needed on the Pi. Keep the laptop awake and reachable.

For a first version, ask in a **private chat** to search within a website, read JavaScript-rendered pages,
compare options with source links, or send a screenshot. Sign in yourself using the short-lived live link,
then say you're done so Inkling can continue. Cookies are saved encrypted per person on the Pi. Downloads,
file uploads and media playback aren't supported by these tools; use the music tool for speaker playback.
Purchases, bookings and other final submissions still need the existing screenshot approval.
Groups can browse public pages, search sites, compare options and request screenshots, including guests
in groups where they're allowed to talk. Group browsing uses a separate session for that group, never
anyone's saved logins, private memory or personal details. Sign-ins, live takeover, bookings, purchases
and personal forms remain in private chats. Private-chat guests do not get browser tools.

On the browser computer, install Node 20+ and the browser's dependencies:

```sh
cd browser
npm ci --omit=dev
npx playwright-core install chromium
```

Chromium also needs the system libraries listed by Playwright's installer (`install-deps chromium`, with
administrator access where needed). Copy `browser/.env.example` to `~/.config/inkling-browser.env`, generate
a secret, and install `scripts/inkling-browser.service` as a user service. Adjust its working directory and
runtime path to your checkout. Enable lingering if the service should run after logout or reboot.
The service reads its environment file; plain `npm start` needs these variables exported separately.

The browser defaults to loopback, two simultaneous sessions, four pages per session, and a 30-minute idle
session timeout. These are configurable in `browser/.env.example`. Completed tasks close their context;
Chromium exits within a minute of the last context closing. The service template limits browser memory
to 2 GB. Each person's browser context is separate; stored browser state only returns to their own account.

For private control traffic, forward a local Pi port over SSH to the laptop's browser port:

```sh
ssh -NT -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 \
  -L 127.0.0.1:18099:127.0.0.1:8099 browser-user@browser-host
```

Then set `INKLING_BROWSER_URL=http://127.0.0.1:18099` and the matching `INKLING_BROWSER_SECRET` on Inkling.
Run the SSH connection as a restarting user service for unattended use. If the laptop is offline, Inkling
reports that it couldn't verify a result. Compatible providers use `INKLING_MODEL` for browsing unless
`INKLING_WEB_MODEL` overrides it; choose a model that supports images for visual browsing.

Phone takeover links need a different address from a loopback tunnel. Set `INKLING_BROWSER_LIVE_URL` to the
address your phone can reach. For trusted home Wi-Fi, bind the browser to its LAN interface (or `0.0.0.0`)
and use `http://<browser-lan-ip>:8099`. Reserve that LAN address in your router. HTTP live links are for a
trusted LAN only: use HTTPS and a private network such as Tailscale Serve for access away from home.
Do not port-forward the browser service onto the internet. Live links expire after 20 minutes and stop
working when their session closes; anyone with an active link can control that session, so don't share it.

### 6. Self-changes (optional)

The owner can ask the assistant to change its own code. This needs your own copy of this repository on GitHub with
Actions enabled, and:

- `INKLING_GITHUB_REPO` (`owner/name`) and `INKLING_GITHUB_TOKEN`: a fine-grained token for that repository only,
  with Actions, Contents and Pull requests read/write. Without both, the feature is off.
- The repository secret `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), used by
  `.github/workflows/change.yml`, where Claude Code makes the change and the workflow opens a pull request.
- A deploy that runs on pushes to `master` and is named `deploy.yml` (the template above), so merged changes go
  live and can be rolled back; `.github/workflows/undo.yml` reverts a change and redeploys.

The coding job never gets deploy credentials, and it may not change `.github/`, `.env` or `data/`.

## Local music on a Pi

The optional native music service plays YouTube audio on the host's speakers. Members can control it in groups
where they can talk to Inkling, including guests in open groups. In private chats, only the owner has music
access. Everyone shares the same player and queue. It uses `yt-dlp` to search and resolve audio and `mpv` to play it; no `ym`, terminal session,
Bun binary or second WhatsApp instance is needed. Install `mpv` and a working `yt-dlp` on the host first.

Set these in the checkout's `.env` (replace the user ID and speaker name for your host):

```dotenv
INKLING_MUSIC_SOCKET=/run/user/1000/inkling-music/control.sock
# Optional exact description from mpv --audio-device=help. A missing speaker produces an error, not fallback audio.
INKLING_MUSIC_SPEAKER=My Bluetooth Speaker
# Optional executable overrides if they are not on the service's PATH:
# INKLING_MPV=/usr/bin/mpv
# INKLING_YTDLP=/usr/local/bin/yt-dlp
```

`INKLING_SECRET_KEY` encrypts music state just like chat data. The socket needs its own directory owned by the
service user, mode 700; the service sets the socket itself to 600. Nothing listens on a network port.
Without `INKLING_MUSIC_SOCKET` or custom command configuration, music stays off.

Copy `scripts/inkling-music.service` to `~/.config/systemd/user/inkling-music.service`. Adjust its checkout path
and Node executable for the host. It runs independently of Inkling, so restarting the assistant does not interrupt
music. The template creates the private runtime directory and restarts the player service after crashes.

```sh
systemctl --user daemon-reload
systemctl --user enable --now inkling-music.service
```

Enable user lingering if these services must start at boot without a login (`loginctl enable-linger USER`, which
may need an administrator). Add `Wants=inkling-music.service` and `After=inkling-music.service` to the assistant's
user unit if it should bring up music automatically. Restart the existing Inkling process after configuring it.
For foreground development, create a private socket directory and run `npm run music:service` separately.

### Behavior

- Search returns actual videos, excluding channels and playlists. Ellie inspects titles/artists, then supplies
  a chosen video URL. A text `play` or queue request returns candidates without changing audio. Conditional
  requests must match the condition; there is no automatic fallback to an unrelated result.
- Before replacing audio, the service resolves that exact video's audio stream. Unavailable/private videos fail
  without interrupting the current song. Transient source failures retry once; failures never clear requests.
- Replies summarize the song title, supplied artist/channel, speaker and upcoming queue in natural language.
  Raw player JSON and internal confirmations never become WhatsApp replies; a code fallback covers incomplete model answers.
- Playback success requires a loaded track, an active audio output and advancing playback time. Status reads
  the engine afresh, distinguishing stopped, loading, playing, paused, buffering, error and a disconnected
  configured speaker. Software cannot establish whether someone in the room can hear it.
- `play` changes the current song and preserves requested songs. `queue_add` appends requests in order;
  `queue_next` puts a song immediately next. Manual next and natural EOF consume the same queue, only after a
  successful load. A failed queued song stays at its position for retry; remaining songs are never silently lost.
- The queue is finite by default. `radio_on` explicitly enables related tracks after requests; `radio_off` removes
  radio tracks and retains requests. Clearing empties upcoming songs and disables radio without stopping the
  current song. Late radio lookups cannot undo a clear.
- Queueing while stopped saves songs without starting audio; `resume` starts the saved current song or first
  queued song. Stop retains the current position and upcoming requests. Previous returns to playback history
  and puts the song you left at the front of the queue.
- `volume` sets 0–100%; `volume_delta` adjusts by signed percentage points with clamping. This is player volume,
  separate from speaker/system volume. Titles such as “Volume One” should be searched as songs.
- `playlist_save` saves the current song and requested queue under a name (updates an existing name).
  `playlist_play` explicitly replaces playback/queue with that saved playlist; list/delete manage saved playlists.
- Current song, position (checkpointed every ten seconds), volume, queue, history and up to 30 playlists are
  encrypted in `data/music.sealed`. Queues support 200 upcoming songs. An orderly restart checkpoints playback;
  a crash may replay up to ten seconds. Previously playing music resumes, paused music restores paused, and
  stopped music stays stopped. Stream URLs are resolved afresh and never persisted.
- Mutations are ordered; stop cancels in-flight loads. Per-call IDs prevent retries from queueing twice, including
  after a restart. An interrupted request with an uncertain result is reported as uncertain rather than repeated.
  The assistant must never use reminders, polls, stop or queue clearing to work around a playback error.

The local CLI uses the same service and queue:

```sh
npm run music -- search "Veridis Quo Daft Punk"
# Choose a returned video's URL, then:
npm run music -- play "https://www.youtube.com/watch?v=EXAMPLE1234"
npm run music -- queue
npm run music -- next
npm run music -- volume_delta -15
npm run music -- playlist_save "Evening"
npm run music -- status
```

For another player, the legacy optional `INKLING_MUSIC_COMMANDS` JSON map still accepts fixed executable/argument
arrays for `search`, `play`, `pause`, `resume`, `stop`, `next`, `previous`, `volume`, `status`, `queue_add`,
`queue_next`, `queue`, `queue_clear`. Search/play/queue additions need `{query}`; volume needs `{volume}`.
Execution never uses a shell. Native socket configuration takes priority over these custom commands.

## Commands

`/help`, `/connect google`, `/google`, `/disconnect google [email]`, `/memory`, `/reset`.
Admins: `/people`, `/add Name +44...`, `/remove Name`, `/waitlist`, `/link whatsapp`, `/unlink whatsapp`, and in groups
`/open`, `/close`.

## Security model

- **Strangers only get the waiting list**, unless you turn on guests or open groups. It only works for numbers in
  `users.json` (and, in groups an admin has opened, or with `INKLING_OPEN_GROUPS=true` any group with someone from the
  list in it, for anyone in that group). Others get a fixed reply written by code with their place in the queue; the
  model never sees their messages. With `INKLING_GUEST_MESSAGES` set, strangers in a private chat are guests instead:
  the model answers them, but they get no Google, calendars, websites or anything that acts as someone, and only that
  many messages a day. Adding people requires the number to be in an admin's own message, so a web page
  or email can't add anyone, and approving someone from the waiting list always adds a new person, never another
  number for someone already listed.
- **Nothing goes out as you without your yes.** Emails, Google invites, WhatsApp messages from your number, the final
  step on a website, and changes to its own code are drafted, shown to you word for word by code, and only happen
  after you reply yes in a new message (within 30 minutes). The model can't skip this: it's enforced in code. The one
  exception is opt-in: with `INKLING_GROUP_INVITES_NOW=true`, Google invites asked for in a group go straight away,
  but only for the asker's own event, only to people on the list in that group or to emails posted there.
- **Content is not instructions.** Emails, web pages, documents and other people's messages are passed to the model
  as information, and a prompt injection in them can't trigger a send on its own because of the rule above.
- **Encrypted at rest** with `INKLING_SECRET_KEY` (AES-256-GCM): chat history, memory, Google refresh tokens, the
  linked personal WhatsApp session and inbox, website cookies, older messages and their recap, the waiting list,
  reminders, lists and the other per-chat files.
  `users.json` and the assistant's own WhatsApp session (`data/auth/`) are plain files: protect the data directory.
- **Google** sign-in happens on Google's own page (OAuth with PKCE). Links are single-use, expire after 10 minutes and
  are tied to the person who asked. `/disconnect google` revokes access at Google too.
- **Privacy between people.** Each person's data is separate; group chats never get email or personal WhatsApp
  tools, and calendars there only show when people are busy. A linked personal WhatsApp never leaves its owner's
  private chat, and session keys are filtered out of the logs.
- **Websites.** Pages are only opened for links already in the conversation, never private or local addresses. The
  browser agent never types passwords or card numbers, never presses a final button itself, and never spends over
  the limit each person sets for themselves.
- **Third parties.** Messages are processed by your model provider (`store: false` where the API has it). On Azure,
  web search goes through Grounding with Bing, which Microsoft runs outside Azure's data-protection terms; OpenAI
  and Claude use their own search. If you set a PostHog key, usage
  numbers go there (anonymous ids; no prompts, replies, tool arguments or names; error text is scrubbed).
- Everything private lives in `data/` and `.env`, both gitignored.

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Notes

- Some conveniences are UK-flavoured: postcodes are looked up with postcodes.io, and a local number starting with 0
  is read in the admin's country when that's the UK. Everything else works anywhere.
- It's a personal project for a handful of people, not a multi-tenant service. There's no test suite;
  `npm run typecheck` is the check. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Disclaimer

inkling is provided as is, without warranty of any kind (see the [MIT license](LICENSE)). It's a personal project,
not a service: nobody behind this repository runs, hosts, monitors or supports your copy, or has access to its data.

If you run a copy, you're responsible for it and for everything it handles:

- **Your data, and other people's.** Messages, notes, connected Google accounts, linked WhatsApp chats and website
  sign-ins are stored on infrastructure you control. Keeping them secure (your `INKLING_SECRET_KEY`, `.env`, `data/`
  and any backups), deleting them when someone asks, and getting the consent of the people you add are up to you.
  Group chats include people who never signed up for anything; bear that in mind before adding it to one.
- **The law where you and your users are**, including data protection law (for example the UK GDPR and EU GDPR) and
  any rules about processing other people's messages and personal information.
- **The services it uses.** Your use of WhatsApp, Google's APIs (including the Google API Services User Data
  Policy), Azure, PostHog and any website it visits is under their terms, between you and them. The privacy policy
  and terms pages it serves are a starting point written for a small private copy; review and adapt them for yours.
- **What it does.** AI makes mistakes. inkling asks for a yes before anything goes out as someone or costs money,
  but whoever says yes is responsible for that action. Check anything important it tells you (dates, money, health,
  legal matters) before relying on it.

inkling isn't affiliated with, or endorsed by, WhatsApp or Meta, Google, Microsoft, OpenAI, Anthropic or PostHog.
Their names are trademarks of their owners and are used here only to say what inkling works with.

## License

[MIT](LICENSE), for inkling's own code. Its dependencies are installed by npm, aren't part of this repository and
keep their own licences. Most are MIT or Apache-2.0, but Baileys depends on `libsignal`, which is GPL-3.0, and
sharp's prebuilt `libvips` is LGPL-3.0. If you distribute inkling together with its dependencies (for example as a
container image), follow those licences for that distribution.
## Coding projects on another computer

The optional coding worker runs Codex on a Linux laptop while Inkling stays on the Pi. It is available only to the
owner in a private chat. It can create projects, continue named projects, report status and actual diffs, cancel work,
and send a completed source archive. It does not change Inkling itself, publish repositories, or deploy applications.

Examples: “make an expense tracker called expenses”, “continue expenses and add categories”, “what coding jobs are
pending?”, “show the diff for C1”, “send me C1's source”, and “stop C2”. Inkling returns promptly while the work runs
in the background. One job runs at a time; up to five wait. Projects have separate workspaces and Codex sessions.
An essential question can be answered with the job ID, for example “C1: use blue”.

The laptop needs Node.js 22+, Python 3, Git/diff/tar, Linux namespace support, a systemd user manager, and the pinned Codex CLI version in
`coding/.env.example`, already signed in with `codex login`. Copy `coding/` to `~/inkling-coding/coding/`, put worker
settings in `~/.config/inkling-coding.env` (mode 600), and install `scripts/inkling-coding.service` and `scripts/inkling-coding.slice` in the systemd user-unit folder.
Generate independent API and state secrets with `openssl rand -base64 32`. Set `INKLING_CODING_BIN` to the actual
pinned executable, and `INKLING_CODING_TOOL_ROOTS` to colon-separated read-only installation folders for that
executable, Node/npm, and other approved tools. Never use the whole home directory as a tool root.

The worker listens only on laptop loopback port 8100. Install `scripts/inkling-coding-tunnel.service` on the Pi and
set `INKLING_CODING_SSH_TARGET` in `~/.config/inkling-coding-tunnel.env`. SSH host keys and key authentication must
already work. Then configure Inkling:

```dotenv
INKLING_CODING_URL=http://127.0.0.1:18100
INKLING_CODING_SECRET=<same API secret as laptop>
```

Enable both user services, enable user lingering for startup without an interactive login, and restart Inkling after
typechecking. No public ports or remote Codex endpoint are needed. Changing the installed Codex version deliberately
fails the worker's version check until its protocol and permissions are revalidated.

Public GitHub repositories can also be requested by their exact HTTPS repository URL. A separate preparation step
downloads the default-branch source before Codex starts, without GitHub credentials or Git hooks. Downloads are
capped at 20 MB compressed / 50 MB extracted; unsafe archive paths, escaping links and links to directories are rejected. Internal file symlinks are
materialized as ordinary files. Imports require an empty
project and never overwrite existing source. Failed imports can be retried by continuing the same job with its URL.
Codex can research online documentation through its built-in hosted web search, independently of command
networking. `INKLING_CODING_WEB_SEARCH` selects `live` (default), `cached`, or `disabled`. Project command
networking remains disabled. Private repositories, arbitrary download URLs and dependency
installation are not supported. Imported source is a snapshot, without Git metadata.

Existing source folders can be registered through a trusted `INKLING_CODING_IMPORTS_FILE` JSON mapping of aliases
to absolute paths. On worker startup, each new alias gets a separate sanitized source copy; originals are never
edited. An alias is lowercase letters/digits/hyphens, starting with a letter. No paths or arbitrary host commands are
accepted from the chat. Runtime data, credentials, dependencies and symlinks are excluded or rejected. Review which
source files are appropriate to import; name-based filtering is not a general secret detector.

Jobs, briefs, questions, detailed check logs and notification cursors are encrypted at rest. Source projects, revision
snapshots and archives are ordinary code files. Codex sessions run ephemerally under `/run/user/<uid>/`, separately
from personal Codex settings. The worker proves outside-file/auth access is blocked and command networking is off
before every coding turn. Verification commands use the same sandbox. It checks JavaScript syntax and configured
`typecheck`/`test` package scripts; unavailable dependencies or failed checks remain visible. New projects should
prefer installed tools and dependency-free solutions. Automatic dependency installation is not included in v1.

Up to three recently used project sessions stay in memory for follow-ups. Older sessions are evicted to bound RAM.
After eviction or a laptop/worker restart, continuing creates a fresh Codex thread using saved requests, the last
report and existing files. A Pi/Inkling restart reconnects without stopping laptop jobs. Cancellation stops that
project's transient service and all of its child processes and preserves its files. Active jobs have a 30-minute limit. State and projects live in
`~/.local/share/inkling-coding` by default; do not delete it to restart the service.

Source delivery uses `.tar.gz` archives, capped at 16 MB for WhatsApp. Diffs include new files and deletions, and large
diffs fall back to requesting the archive. No source is uploaded to a public host. Optional static `index.html`
previews use `INKLING_CODING_PREVIEW_URL`, `INKLING_CODING_PREVIEW_HOST`, and port 8101. Each link expires in one
hour and is revoked when work continues or is cancelled. Preview links are for home Wi-Fi only; the separate preview
listener exposes no job API. External resources, network requests and form submissions are blocked by its content
policy. Backend servers and automatic browser testing are outside this initial preview implementation.

### Optional nightly operations

[The host operations guide](docs/operations.md) describes encrypted Pi-to-laptop recovery backups, private aggregate
runtime diagnostics, an isolated nightly Codex review that proposes GitHub PRs, owner-only WhatsApp notifications,
and checked deployment of the reviewed default branch with rollback. These jobs need explicit host installation and
private configuration; they are not enabled by cloning the repository or starting Inkling.


### Memory reliability and recurring links

Saved notes keep their existing encrypted format. An explicit correction can replace exact older notes in one
write. Note cleanup validates model output and backs off failures, preserving the existing notes and backup.
Ambiguous contradictions are retained for clarification instead of choosing an instruction solely by its date.

A registered user can opt into bare-link processing in their private chat, for example:
“Automatically summarize every bare link I send in English, about 50 words, and save it to my links list.”
An admin can enable the same rule in a group, explicitly naming whether it applies to themselves or all registered
members. Ask to show the link rule or disable automatic links to inspect or stop it. It stays off until configured. An operator can also provision a registered person’s initial private rule on an explicit owner request, without granting admin privileges; existing personal settings are preserved.

The rule reads one plain HTTP(S) URL, summarizes readable page text and saves one item to a list in that chat.
Captions, multiple links and ordinary group conversation retain normal addressed-message behavior. It does not
open a browser, sign in, fill forms or add hiring reminders. Private and group lists remain separate. Work is
bounded to twenty new workflow links per hour per chat and twenty pending entries; duplicate receipts expire after
fourteen days on next access, up to five hundred entries. Finished receipts retain no duplicate summary text. Links beyond these limits are ignored by the automatic rule.
Prepared receipts and source IDs protect list additions during recovery; delivery of a WhatsApp reply is not an
exactly-once guarantee. Queued links older than thirty minutes are not processed after recovery.

Coding continuations that encounter an unreachable laptop are saved encrypted on the Pi, with unknown acceptance
reported honestly. Ask for pending coding requests, then explicitly resume or cancel one. Nothing automatically
launches when the laptop reconnects. Resume reconciles the original request ID with the worker; cancellation
withdraws it atomically, including delayed submissions. Completed work is not undone and later job revisions are
not automatically cancelled. Ten unresolved requests are allowed; requests older than seven days must be
reconciled/cancelled before a fresh instruction. New-project offline queuing is not supported.

When updating an existing installation, update the separate laptop coding worker as well as the Pi before using
saved-request resume/cancellation. Use the existing service installation procedure with the worker idle; preserve
its configuration, encryption key and job data. The new worker reads existing state without rewriting projects.
Older workers reject the new reconciliation operations, so the Pi keeps uncertain requests rather than replaying
them unsafely. New state stays in the existing data directory and is included in normal backups.

See [the v1 plan](docs/memory-v1-plan.md) for scope, evidence, limitations and validation.

### Background reading (optional, intake only)

A separate low-priority worker can check public RSS/Atom feeds, read selected articles and save encrypted,
source-linked notes. It uses direct text extraction on the host and the optional remote browser as a fallback.
Daily limits, duplicate tracking and retry state survive restarts. Intake itself sends no messages. Optional
sharing posts a 50-word summary and source link to one explicitly configured group through the existing WhatsApp
connection. Optional owner-only article memory is searchable through recall in that owner's private chat,
without filling their always-loaded personal notes. All three features are off by default; see
[reading setup, sharing and memory](docs/reading-intake.md).

### Private tweet drafts (optional)

The configured owner can get up to two ready-to-copy tweets daily, drawn from eligible personal thoughts, personal
projects and public article notes. Employment and workplace material, private inboxes and group history are
excluded. Suggestions are sent privately, at least four hours apart, and only when the idea clears the editorial
threshold. Reply to the tweet bubble to revise or reject it, or ask for a draft directly. The entire tweet is one
plain-text message. You copy and publish it yourself; no X account connection or API fee. Existing AI usage still
applies. See [setup, budgets and privacy](docs/tweeting.md) and [the design proposal](docs/tweeting-v1-proposal.md).
