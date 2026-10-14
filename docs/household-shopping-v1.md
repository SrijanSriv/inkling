# Household shopping v1

Official Swiggy Instamart MCP provides live search and checkout behind a small, explicit adapter.
The existing shared encrypted basket remains the interface; Zepto is still draft-only because its
OAuth registration failed. No generic MCP execution, provider instructions or account history is
exposed to the conversational model.

## Household use

Registered members of the configured group can ask to add groceries, search products, select a
returned P-number for an existing B-number basket line, and request checkout with Google Pay or COD.
For example: “inkling, search milk”, “inkling, choose P2 for B1”, then “inkling, checkout with Google Pay”.
The assistant posts the exact items, fees, payable total, saved delivery label and a Z-number.
Any registered member still in that group can type “inkling, yes Z1” in a later message within five
minutes. A forwarded message, voice note, caption, conditional approval or reused approval cannot
submit checkout. “inkling, cancel Z1” cancels an unsubmitted preview only.

The approver receives the official Swiggy payment bridge privately. Google Pay is selected using the
actual method returned by Swiggy; phone/browser handling still needs testing on the user's device.
This is a payment-link handoff, not a GPay collect-request push. Shopping tool responses are delivered
from code so an unrelated tool or old assistant claim cannot back an invented bill or order.
These are customer-facing messages: search shows up to five choices, baskets separate selected packs
from requests still needing a choice, and internal schema errors become plain-language failures.
We do not rewrite UPI transactions or expose payment links to everyone. COD is offered only when
Swiggy lists it. Wallet spending is disabled.

## Setup and deployment

Features are off by default. Configure `INKLING_ZEPTO_ENABLED`, `INKLING_ZEPTO_GROUP_ID`,
`INKLING_ZEPTO_ACCOUNT_USER_ID`, positive INR `INKLING_ZEPTO_ORDER_LIMIT` and
`INKLING_ZEPTO_DAILY_LIMIT`. These legacy names configure the provider-independent household policy.
Set `INKLING_SHOPPING_PROVIDER=instamart` only after account and contract review.

`npm run instamart:setup` performs official loopback OAuth, without starting WhatsApp or making orders.
Credentials are encrypted under a protected setup directory outside the repository. Provision them
into the deployment's encrypted `instamart-account` file with its own secret key, never by copying
plaintext into Git. A reviewed encrypted `instamart-settings` record is also required: exact saved
address ID and label, timezone, allowlisted live input-schema hashes, checkoutEnabled, and the verified
cart address ID plus hash of its full details. Swiggy may return a compound saved ID and a shorter
cart ID; verify their correspondence from the actual saved address and cart, rather than guessing or
stripping IDs in requests. Tokens refresh through the SDK. Reconnection is an administrator operation.

The runtime rejects changed tool schemas on connection, changed delivery details, unavailable stock,
quantity overruns, multiple stores and carts not previously written by this household flow. Human
selection of an actual P-number prevents silent substitutions. Settings and OAuth data never appear
in group messages or model input. Only the address label appears in previews.

## Approval, budget and recovery

A serialized account queue protects previews, approvals and payment polling. The live cart and
payment method are read again before submission. Basket revisions, exact bill fingerprints, a
per-start nonce and later WhatsApp timestamps invalidate stale approvals. The journal reserves
budget before the one checkout call. Duplicate approvals cannot submit twice.

The INR limits apply to the total including fees, and to orders made through Ellie, not purchases
made independently in the Swiggy app. Pending or uncertain submissions continue to reserve budget,
even across midnight. A successful order clears only its unchanged approved basket.

UPI payment status is polled at a bounded interval, then final confirmation is requested only after
verified payment success. A timeout or ambiguous result blocks further checkout; no automatic write
retry is attempted. After checking the app and establishing that an order was NOT placed, the linked
account holder can type `inkling /shopping resolve Z1 not-placed` in the group to release the reserve.
Use Swiggy directly for cancellations, refunds or uncertain orders that were actually placed.
`inkling /shopping` shows setup, `/shopping basket` the basket; asking for order status shows the last
recorded household states, not a live delivery ETA.

## Limits and validation

The provider checkout schema has no atomic expected-total/cart-version parameter. Immediate checks
reduce races but cannot prevent a simultaneous app edit or provider price change between the final
read and checkout. Keep the shared account's app cart untouched during approval. Returned amounts
are checked when supplied; a mismatch is treated as uncertain, never reported as the approved bill.
Single-store support avoids partially successful multi-store checkouts in this version.

Validation includes TypeScript checks and isolated mock tests for authorization, fees/revisions,
expiry/restarts, concurrent approvals, budgets, uncertain results and UPI finalization. Authenticated
live tests verified saved-address correspondence, search, cart read/write, available payment methods
and restored the empty cart. No live order, charge or payment-link opening was tested. The first
real household purchase remains a supervised user-approved trial. Provider availability and access
policy can change; the initial conflicting documentation is recorded in the alternatives research.
