# Zepto for a shared household: integration plan

Researched 14 October 2026. Proposal only: no account connected, cart modified or order placed.

## Recommendation

Build a small, Pi-native Zepto adapter inside Inkling. Enable it for one explicitly configured household
group and its registered members. Everyone in that household can find products and contribute to one
shared shopping basket. One explicitly authorized person approves a particular, fully priced order.
Start with cash on delivery and, once its actual checkout contract is verified, a human-operated UPI
payment link. Keep payment credentials and account setup outside group messages and model inputs.

Do not introduce a second assistant, a shopping browser agent or another laptop service. Ellie already
has group conversations, user identity, private approval messages, encrypted storage and normal tools.
Zepto hosts the remote MCP; the Pi only needs a bounded HTTP client and household state.

## What the evidence establishes, and what it does not

Zepto's [official README](https://github.com/zeptonow/mcp/blob/main/README.md), inspected at revision
`0a5f33e1da69ceb83082ebb59c93313fcabe7b71`, documents a hosted MCP at
`https://mcp.zepto.co.in/mcp`, with search, cart operations, ordering and history. Orders are real.
It lists COD, UPI links, cards, Zepto Cash and UPI Reserve Pay. Its callback allowlist includes loopback
addresses but does not list Ellie's HTTPS host. This establishes intended capabilities, not eligibility
for our account or a tested checkout contract. The public repository contains documentation rather than
server implementation or complete tool schemas.

Read-only discovery performed for this plan returned:

- An unauthenticated MCP initialization request received HTTP 401 with OAuth metadata and `tools:read`.
- Protected-resource metadata identifies `https://mcp.zepto.co.in` as the resource, distinct from its
  `/mcp` transport URL, and `https://auth.zepto.co.in` as authorization server.
- Authorization metadata advertises code/refresh grants, S256 PKCE, registration, revocation and issuer
  validation. It also advertises granular catalog/cart/location/order/checkout scopes.

No registration, login or authenticated `tools/list` was attempted. Exact tool names, argument schemas,
response shapes, account eligibility and idempotency remain an implementation discovery gate.
Do not infer that a scope named `tools:read` makes every accessible tool read-only.

A [Zepto contributor's reply](https://github.com/zeptonow/mcp/issues/19)
describes OAuth client connection followed by account verification through `send_otp`/`verify_otp`.
The implementation must verify whether those tools are still needed for the authenticated session.
OAuth success alone must not mean “household account connected.” OTP handling belongs in a short-lived
private setup page, never a group, model prompt or ordinary chat history.

There are consequential upstream reports:

| Evidence | Design consequence |
| --- | --- |
| [Cart scoping report #62](https://github.com/zeptonow/mcp/issues/62), independently discussed in [#74](https://github.com/zeptonow/mcp/issues/74), says MCP carts may be transport-session scoped and absent from the consumer app. | Maintain our own desired basket and verify the remote cart. Do not promise app-cart handoff or assume reconnects preserve it. These are user reports, not our own reproduction. |
| [Address failure #35](https://github.com/zeptonow/mcp/issues/35) reports successful previews followed by refused order creation. | A preview is not an order. Show failures honestly; never claim dispatch until Zepto returns an identifiable order and status. |
| [Search report #33](https://github.com/zeptonow/mcp/issues/33) describes throttling and misleading empty results. | Bound searches, back off on throttling, and distinguish “no results returned” from proven unavailability. |

These reports warrant a narrow pilot. They do not prove every account has those failures today.

## How the household would use it

1. Someone says in the configured group, “Ellie, add milk, eggs and bread to our Zepto basket.”
2. Ellie resolves real products and pack sizes. Ask one targeted question if “milk” could mean several
   materially different things; remember explicit household favourites after people choose them.
3. Another member says, “Ellie, add two packets of chips too.” Both contributions remain visible.
4. “Ellie, show the basket” returns items, packs, quantities and an estimated subtotal. This is not a
   final payable bill; fees, promotions and availability can still change.
5. “Ellie, check out, maximum ₹700, COD” produces a live quote including fees, discounts, delivery alias,
   payment method, final amount and ETA if Zepto supplies one. No inferred ETA or invented free delivery.
6. The group gets a summary with an order reference such as `Z1`. An authorized approver replies **`Ellie, yes Z1`** in that same group after the exact checkout
   preview. A plain “yes,” another order reference or an approval from another group cannot buy anything.
7. Code rechecks access and the quote, submits once, then reports the actual result to that group.
   If online payment is pending, Ellie says so and supplies the verified payment link privately.

“Add two” increases quantity; “make that two” sets it. Requests for different packs remain separate.
Record who requested each line so changes can be explained, but do not build bill splitting in v1.
Cooking/party requests can propose a basket using the existing model; they still need product matching,
quantity review and the same checkout approval.

## Access, account and address

Use one Zepto account whose holder explicitly authorizes household use. A common address does not itself
mean everyone has permission to spend from that account. Setup binds:

- An explicit group ID, not “whichever group currently exists.”
- The connecting account holder and a selected saved address ID, labelled “Home.”
- Registered household members, plus a separate checkout-approver allowlist.
- INR limits per order and per day, explicitly chosen by the account holder; unset means checkout off.

Selected initial policy: registered members of the configured household group may prepare baskets
and approve purchases, as explicitly authorized by the account holder. Non-admin roommates do not need
to become Inkling admins to use household shopping. Recheck registration, household membership and approver
permission at execution. Guests and unrelated groups receive no account-backed Zepto access.

The shopping and final approval interaction stays in the configured group, as explicitly requested
by the household account holder. Private chat or a private setup page is used only for sign-in, address
setup and payment handoff. General personal Zepto shopping in DMs is outside v1. This is a new, scoped
group-purchase approval flow; existing email/browser private-confirmation rules remain unchanged.

Select the saved Home address during setup. Never let product text or the model switch accounts or
addresses. Group summaries use Home plus a deliberately approved short label; full address, phone,
other saved addresses, wallet balance and historical personal orders stay private. Order-status tools
expose only orders initiated through this household integration.

## Payment decisions

| Method | V1 policy |
| --- | --- |
| Cash on delivery | Preferred first pilot if returned as available for this exact checkout. Approval creates a real purchase obligation even though cash is paid later. Include any method-specific charge. |
| Standard UPI payment link | Next supported path after verifying the tool contract. The human opens the link and pays in their own payment app. Ellie never receives a UPI PIN or claims payment succeeded from a person's “paid” message alone. |
| Zepto Cash | Disabled initially: spending a shared account's balance needs separate account-holder authorization and verified balance/charge semantics. |
| Reserve Pay / “instant” payment | Disabled initially. Investigate the precise product and whether an existing mandate can debit without another app interaction. A friendly product name is not sufficient permission to charge. |
| Cards | No card collection or card entry through Ellie. Consider only a verified human-operated hosted checkout later. |

The [Zepto terms](https://www.zepto.com/s/terms-of-service) say accepted methods are displayed during
purchase; COD is therefore conditional on actual availability. The account's live payment-method
response and final quote decide what we offer, not a hardcoded assumption.

For online payment, determine whether generating the link itself creates an order, reserves stock or
incurs an obligation. Any such call stays behind approval. If payment-link generation requires order
creation, the preview must explicitly say that approval creates a pending-payment order. Track payment
expiry and the order separately; do not automatically switch a failed UPI order to COD or create another
order. Whitelist verified payment hosts from observed official responses; never turn arbitrary product
links into payment links or send them to a browser agent for automatic completion.

### Google Pay handoff from WhatsApp

Household preference: Google Pay should handle payment rather than WhatsApp Pay. Treat this as a
preferred handoff, not a guarantee that we can override WhatsApp's link handling.

Avoid sending a bare `upi://pay` link as the primary chat action. Proposed UX is an ordinary HTTPS link
for the approved order, followed by an explicit **Open Google Pay** action where the official payment
contract supports it. This can be two taps: open the payment page, then launch Google Pay. If WhatsApp's
embedded browser blocks app launch, provide an external-browser instruction and the original verified
provider checkout as fallback. Do not claim that an HTTPS wrapper alone bypasses WhatsApp.

[Google's Android documentation](https://developers.google.com/pay/india/api/android/in-app-payments)
shows Google Pay targeting through its Android package. [Chrome's intent documentation](https://developer.chrome.com/docs/android/intents)
allows package-targeted links from a user gesture, with a fallback. That establishes an Android browser
implementation option, not verified support in WhatsApp's embedded browser.
[Google's iOS documentation](https://developers.google.com/pay/india/api/ios/in-app-payments)
describes the Google Pay URL scheme; verify it on the actual iPhone/WhatsApp version rather than using
Android intents there. Retain another-UPI-app/provider-checkout fallback.

First inspect what Zepto returns. If it supplies a hosted checkout only, use that checkout's supported
Google Pay option. Do not scrape payment pages, create our own merchant payment request, prepend a
Google Pay scheme to an arbitrary HTTPS link, or reconstruct a payee from the bill. Only use a validated
provider-supported payment intent that preserves its complete transaction reference, amount, merchant
identity, signatures and all required parameters. Changing app routing must not break reconciliation.

An Ellie-hosted handoff page, if needed, should resolve an opaque, expiring payment reference server-side;
never accept a caller-supplied destination or put full transaction details in its URL. It initiates no new
order or charge on page load, including WhatsApp link previews. A launch failure never creates another
payment request. Payment completion still comes from Zepto/provider status, not the browser returning.
Test Android and iPhone handoffs, absent Google Pay, embedded/external browsers, expired/already-paid
links and desktop fallback before enabling UPI. No extra intermediary payment account is required.

## Architecture and code boundaries

Suggested small modules, following the existing TypeScript/ESM style:

| File | Responsibility and evidence from Inkling |
| --- | --- |
| `src/zepto-client.ts` | Pinned official MCP client library, HTTP transport, OAuth refresh, session lifecycle, timeouts and response-size limits. No model-facing generic MCP execution. `package.json` currently has no MCP client dependency. |
| `src/zepto.ts` | Typed, allowlisted adapter; validate live tool schemas and normalize product/cart/quote/order results. Expose only approved operations. Unknown or materially changed schemas disable checkout. |
| `src/household-shopping.ts` | Encrypted basket, revisions, contribution records, limits, checkout snapshots and reconciliation. Existing vault storage is enough; no graph, vector store or database service needed. |
| `src/agent.ts` | Offer a small set of shopping tools only in the permitted context; enforce the same checks in execution. Existing code already separates tool availability from authorization. |
| `src/drafts.ts` and `agent.ts` | Add a Zepto draft type linked to a durable checkout record. Existing `confirm_send` remains private-only. Add a dedicated, code-enforced household group confirmation path with a later human message, exact checkout reference and single-use approval. |
| `src/web.ts` or a narrowly scoped setup helper | Human account connection and OTP verification, with expiring setup state. Keep account secrets out of chat. |
| `src/index.ts` / scheduler | Bounded status checks for known household orders and one notification per meaningful transition. No autonomous shopping schedule. |

Proposed **Ellie tools**, not claims about Zepto's live tool names:
`household_shop_search`, `household_basket_update`, `household_basket_show`,
`household_checkout_preview`, `household_order_status`.
Only trusted confirmation code can call the remote order-creation operation. Do not expose that operation
through a generic `call_mcp_tool`, even if its description says to ask first. Tool results and descriptions
remain untrusted information, consistent with Inkling's existing external-content boundary.

All model reasoning continues through `responses()` in `ai.ts`. The integration translates selected
model tool calls into MCP operations locally; Gemini does not need native MCP support and receives
neither account tokens nor raw account history.

Configuration stays off until enabled, using proposed `INKLING_ZEPTO_*` settings and explicit household
configuration. Endpoints, address IDs and household identities belong in deployment configuration or
sealed state, never committed examples. Use fake identities and placeholder addresses in documentation.

## Cart consistency, approval and recovery

Use one durable desired basket per household, plus a mutex per linked Zepto account covering all
selection, cart and checkout calls. Existing per-chat queues alone are insufficient if group requests,
private approvals and status jobs touch the same remote account.

On quote preparation, resolve the selected address/store, build or reconcile the remote cart, read it
back, and bind approval to its actual contents. Do not blindly clear a pre-existing cart: stop and ask
whether it may be replaced unless we have verified it is our exclusive MCP session cart.

Persist a checkout record before presenting the preview:

- Order reference, account/address/payment identifiers, initiating group/requester and exact approver.
- Basket revision, product IDs, pack sizes, quantities, availability and authoritative payable bill.
- Cart/session identity if supplied, quote fingerprint, creation/expiry time and execution state.

Expire approval after five minutes. Any basket edit, address/payment change, unavailable item, changed
fee/discount/total, session replacement or permission revocation invalidates it. At confirmation, fetch a
fresh quote under the same lock and compare all material fields. A lower price still gets a fresh preview
if the approved bill changed. Require the intended checkout reference and an unconditional approval;
“yes, but remove the chips” edits the basket and buys nothing. Room microphone speech cannot approve
purchases, matching the existing microphone denial of `confirm_send`.

State sequence:

`editing → quoted → awaiting approval → submitting → placed / payment pending / failed / unknown`

Persist `submitting` before the network call. Consume each approval once. Use Zepto idempotency only if
the authenticated contract actually supports it; a local identifier alone cannot provide remote
exactly-once execution. On timeout after submission, mark **unknown**, block repeat checkout and reconcile
using the strongest remote identifier available. If history cannot uniquely identify the outcome,
require the account holder to inspect Zepto. Never retry an order blindly or match orders on amount alone.
On restart, invalidate unsent quotes; reconcile submitting/payment-pending/unknown records without
replaying them. Retry bounded reads only, not potentially mutating operations.

Retain credentials, basket and checkout journal in sealed files included in existing encrypted backups.
Do not store raw MCP payloads or OTPs. Log operation names, durations, sanitized outcomes and opaque
local references; payment URLs, tokens, addresses and product lists do not enter ordinary logs or
nightly public PR material. Household preferences stay in household memory, separate from personal
inbox/work context. Retention and disconnect should remove credentials and unnecessary shopping state.

## Authentication setup: the first implementation gate

Prefer a direct MCP client using OAuth authorization code + PKCE, state/issuer checks and the advertised
resource identifier. Use the [MCP authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
for discovery and token handling. Request least-privilege scopes, but enforce operation permissions in
our own adapter regardless of scope labels.

A phone-friendly callback on Ellie's HTTPS host is preferable long term, but Zepto's documented allowlist
does not currently include it. Do not pretend Gmail's callback or a localhost link sent to a phone solves
this. We have two legitimate setup paths:

1. One-time account-holder setup in a local browser on the Mac, using a genuinely local callback helper
   and a redirect URI Zepto accepts. Verify exact port/path registration rules first; the README's bare
   loopback entries do not prove arbitrary ports work. Transfer the resulting credentials securely to
   the Pi and seal them immediately, without chat, shell-history or plain-text token exports.
2. Request allowlisting for a dedicated HTTPS callback, then provide private in-chat connection links.
   Filing that external request needs the user's instruction; this plan does not submit one.

Verify where any account OTP is entered. If `send_otp`/`verify_otp` are required, a private setup page calls
those tools directly and discards the OTP immediately. Session-specific account login must be restored
through the supported mechanism after reconnect, not assumed to survive token refresh. Do not copy
credentials from another application or run an unpinned `npx mcp-remote` process on every shopping turn.

## Implementation order and release gates

1. **Authenticated contract check.** Complete consented setup; inspect `tools/list`, address selection,
   product search, cart reads and payment methods. Record sanitized schemas. Verify preview semantics,
   session/cart survival and account verification. No checkout tool invocation in this phase unless
   its preview-only behaviour is established.
2. **Group basket.** Enable search/add/edit/show for the configured household; use real prices and pack
   sizes, keep state across restart, enforce identity and account mutex. Checkout remains disabled.
3. **Checkout dry runs.** Add the durable state machine, live bill preview and group `Ellie, yes Z1` approval.
   Mock remote writes to test quantity edits, price changes, wrong users/groups, expired approvals,
   duplicate yes, process crashes and unknown outcomes. Test account removal and schema drift too.
4. **One explicitly approved COD order.** Confirm Home, account, limits and recipient availability.
   Verify actual order ID/status and group notification. This is a real purchase, not an automated test.
5. **UPI-link pilot.** Verify order/payment state transitions with a separately approved purchase.
   Only then enable the verified method for household use. Wallet and Reserve Pay remain later work.

Run the repository typecheck after code changes. Ad-hoc tests use isolated data and never send real
messages or orders. Measure resource use during discovery, but no Chromium or local model is needed:
normal operation is small HTTP exchanges and encrypted JSON on the Pi. Search/status calls are on demand,
with brief bounded monitoring only while a known order is active.

## Setup choices needed when we implement

The account holder selected their own account, registered household members as approvers, ₹400 per
order and ₹600 per day. The single configured household group was identified without reading chat
content. The saved Home address and available payment methods still need authenticated discovery. We need an actual authenticated tool inspection before promising
that ordering works for this account. No need to send an address, OTP or payment details in this chat.

V1 deliberately excludes automatic restocking, recurring purchases, automatic substitutions, cross-group
shopping, personal-order-history mining, expense settlement and refunds/cancellations. They can be added
only after the basic shared basket → checked approval → verified order loop works consistently.

## Implementation status, 14 October 2026

The account holder selected shared roommate approval, ₹400 per order and ₹600 per calendar day, and
explicitly requested approval in the group. Interpret the daily budget in the household's configured
local time zone; reserve amounts for approved in-flight orders so simultaneous checkouts cannot overspend.
Only registered senders in this household group may approve, in a later typed message explicitly naming
the current checkout. Generic group chatter, voice transcription, reactions, quoted/forwarded approvals,
model-generated text and scheduled jobs cannot approve. Recheck live sender registration and account
permission at execution, and validate the exact group and unchanged quote under the account lock.

Zepto's advertised dynamic-registration endpoint returned HTTP 403 from the Mac and Pi, including a
request using an explicitly documented loopback callback. Account connection, authenticated tool
inspection and checkout remain blocked. The local basket can be delivered independently, labelled
as unchecked shopping requests. No live prices, available payment methods or ordering are promised.
