# Grocery MCP alternatives and the Zepto registration failure

Research snapshot: 14 October 2026. Follow-up: official Instamart OAuth connected successfully.
Live search, saved-address matching, cart updates and payment-method discovery were verified; the
temporary test item was removed. No order/payment was placed and no issue was posted.
See [the implemented v1](household-shopping-v1.md). The research below records the initial assessment.

## Zepto: matching reports, no verified client fix

- [Issue #12](https://github.com/zeptonow/mcp/issues/12) reproduces the generic registration HTTP 403.
  A collaborator called it intermittent and said it was fixed in April. No client patch is supplied.
- [Open issue #64](https://github.com/zeptonow/mcp/issues/64) reports registration HTTP 403 with the
  same documented `http://127.0.0.1/callback` used in our independent test. No response was present.
- [Issue #45](https://github.com/zeptonow/mcp/issues/45) and [#43](https://github.com/zeptonow/mcp/issues/43)
  describe different registration server errors and have maintainer replies saying they were fixed.
  Those older fixes are not evidence that today's 403 is solved or caused by the same failure.

Our latest independent registration request still received HTTP 403. Both previously tested machines
share a home network, so this does not establish a worldwide outage. It could be a service or network
policy problem; no supported workaround was found. Do not substitute another application's client
credentials or assume a new MCP wrapper fixes a failure at the same authorization service.

## Best official alternative: Swiggy Instamart

Swiggy publishes an [official MCP repository](https://github.com/Swiggy/swiggy-mcp-server-manifest)
and [builder documentation](https://mcp.swiggy.com/builders/docs/start/developer/).
The current documented transport is `https://mcp.swiggy.com/im`. Our unauthenticated initialization
received the expected HTTP 401 with protected-resource metadata. Discovery returned its OAuth issuer
and registration endpoint. This verifies reachability/discovery only, not successful sign-in or ordering.

The newer [Instamart checkout reference](https://mcp.swiggy.com/builders/docs/reference/instamart/checkout/)
documents Cash/COD, UPI and wallet options, conditional on live availability. It has explicit UPI app
selection plus intent/bridge URLs. These could fit the household's Google Pay preference, subject to
real authenticated tool inspection and phone testing. Wallet spending should remain disabled initially.
Multi-store checkout can create multiple orders or partly succeed, so the existing desired group budget
must cover the entire checkout and reconciliation must handle each returned order separately.

**Documentation conflict:** the GitHub README says COD-only and that third-party app development is
not currently permitted. The newer builder quickstart says local development is self-serve and free,
with reviewed production access. Treat the builder program as a promising supported route, not blanket
permission for an always-on WhatsApp integration. Confirm the applicable access conditions before live
household ordering. We have not registered a Swiggy client or established account eligibility.

## Other options reviewed

| Option | What is documented | Assessment for this household |
| --- | --- | --- |
| [Unofficial Blinkit MCP](https://github.com/yniks/blinkit-mcp) | Reverse-engineered APIs, browser TLS impersonation, OTP login and checkout/UPI operations. | Not the first choice for a reliability-focused assistant. Requires a separate audit and live validation; not an official supported integration. |
| [Quick Commerce MCP](https://github.com/Hardik500/quick-commerce-mcp) | A local Chrome automation server spanning several providers. Its README distinguishes verified search/cart flows from checkout/payment flows not reverified in its current release. | A possible laptop-hosted browser experiment, not a proven replacement for official checkout. Reuses browser automation and adds site-change maintenance. |
| Blinkit / BigBasket official hosted grocery MCP | No comparable official public ordering MCP was identified in this research. | This is a search finding, not proof none exists. Do not mistake price-data MCPs for account/cart/order integrations. |

## Recommended next experiment

Keep the shared encrypted basket, group approval design and ₹400/order, ₹600/day policy. They do not
require Zepto as the eventual provider. Try a bounded official Instamart connection/discovery experiment
before rewriting runtime shopping code: confirm client registration, account consent, actual tool schemas,
saved-address serviceability, cart/quote behaviour and payment methods. No order during discovery.
Clarify production eligibility through the supported program before activating ongoing group ordering.

If that succeeds, implement an Instamart adapter behind the existing household interface, with strict
server-side approval and durable unknown-outcome handling. Prefer a single-store first pilot. If access
also blocks, seek provider guidance rather than promising an untested unofficial ordering path.
