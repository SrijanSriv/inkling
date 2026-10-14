# OAuth dynamic client registration returns HTTP 403 for documented loopback callback

We are integrating the official hosted MCP with a self-hosted household assistant. Before any account
login or shopping operation, dynamic client registration is rejected.

Observed on 14 October 2026 from a Mac and Raspberry Pi on the same home network:

- MCP initialization without credentials returns 401 with protected-resource metadata, as expected.
- Protected-resource and authorization-server metadata are reachable.
- Authorization metadata advertises `https://auth.zepto.co.in/register`.
- POST to that endpoint returns HTTP 403 and a generic HTML “403 Forbidden” response.
- This occurs both with the official TypeScript MCP client 2.3.1 and an independent HTTP request.

Minimal registration body:

```json
{
  "client_name": "Inkling household shopping",
  "redirect_uris": ["http://127.0.0.1/callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none"
}
```

Headers: `Content-Type: application/json`, `Accept: application/json`.
The loopback redirect above is listed in this repository's README. No authentication token or account
phone number is involved in this request, and no order was attempted.

Is dynamic registration currently restricted, or does it require a different documented setup?
Please advise how a self-hosted MCP client should register, or whether a supported pre-registered client
can be issued. If this is a network restriction, we can provide additional diagnostics privately.
