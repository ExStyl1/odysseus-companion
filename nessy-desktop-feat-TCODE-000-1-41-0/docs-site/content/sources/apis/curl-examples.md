# API Source Curl Examples

Prototype an API with curl first, then turn the working command into a source. One successful curl call tells you everything a source definition needs: the base URL, the auth style, the method, and the response shape.

## Prototyping with Curl

### Bearer token

```bash
curl -fsS https://api.internal.example/v1/items \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/json"
```

### Custom header key

```bash
curl -fsS https://api.exa.ai/search \
  -H "x-api-key: $EXA_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"release notes"}'
```

### Basic auth

```bash
curl -fsS -u "$USERNAME:$PASSWORD" \
  https://api.internal.example/v1/reports
```

## From Curl to a Source

Each part of the command maps onto the source config:

| Curl piece | Goes to |
| ------------------------------------- | -------------------------------------------------- |
| URL up to the versioned root | `api.baseUrl` |
| `-H "Authorization: Bearer …"` | `authType: "bearer"`; token into the credential prompt |
| `-H "x-api-key: …"` | `authType: "header"` + `headerName` |
| `-u user:pass` | `authType: "basic"` |
| `?key=…` in the URL | `authType: "query"` + `queryParam` |
| A cheap authenticated `GET` | `api.testEndpoint` |

Secrets never go into `config.json` — the app prompts for them and keeps them in the encrypted credential store.

## Configuration Examples

### GitHub

```json
{
  "type": "api",
  "name": "GitHub",
  "tagline": "Repositories, issues, and pull requests",
  "api": {
    "baseUrl": "https://api.github.com",
    "testEndpoint": { "method": "GET", "path": "user" },
    "authType": "bearer"
  }
}
```

Requests the agent can then issue:

```
GET  /user/repos                      — list your repositories
POST /repos/{owner}/{repo}/issues     — open an issue
GET  /repos/{owner}/{repo}/pulls/42   — inspect a pull request
```

### Exa Search

```json
{
  "type": "api",
  "name": "Exa",
  "tagline": "Web search API",
  "api": {
    "baseUrl": "https://api.exa.ai",
    "testEndpoint": {
      "method": "POST",
      "path": "search",
      "body": { "query": "ping", "numResults": 1 }
    },
    "authType": "header",
    "headerName": "x-api-key"
  }
}
```

### Datadog (multi-header)

```json
{
  "type": "api",
  "name": "Datadog",
  "tagline": "Monitoring and dashboards",
  "api": {
    "baseUrl": "https://api.datadoghq.com/api/v1",
    "testEndpoint": { "method": "GET", "path": "validate" },
    "authType": "header",
    "headerNames": ["DD-API-KEY", "DD-APPLICATION-KEY"]
  }
}
```

Two prompts appear during authentication, one per header; both values accompany every call.

### Twilio (basic auth)

```json
{
  "type": "api",
  "name": "Twilio",
  "tagline": "SMS and voice",
  "api": {
    "baseUrl": "https://api.twilio.com/2010-04-01",
    "authType": "basic"
  }
}
```

::: info
Twilio expects the Account SID as the username and the Auth Token as the password.
:::

### Internal service with token renewal

```json
{
  "type": "api",
  "name": "Billing API",
  "tagline": "Internal billing backend",
  "api": {
    "baseUrl": "https://billing.internal.example.com/api/",
    "testEndpoint": { "method": "GET", "path": "v1/status" },
    "authType": "bearer",
    "renewEndpoint": {
      "path": "auth/renew",
      "method": "POST",
      "tokenField": "access_token"
    }
  }
}
```

The expiring bearer token renews itself against `auth/renew` — see the [renewal section](overview#token-renewal-non-oauth) for every knob.

## Common Patterns

### Versioned base URLs

Bake the version into the base so paths stay short:

```json
{ "api": { "baseUrl": "https://api.example.com/v2" } }
```

### Tenant-specific hosts

Multi-tenant products usually key the hostname:

```json
{ "api": { "baseUrl": "https://acme.api.example.com" } }
```

### Self-hosted and internal services

```json
{
  "api": {
    "baseUrl": "https://tools.corp.example.com/api",
    "testEndpoint": { "method": "GET", "path": "health" }
  }
}
```

### Static headers on every request

Use `defaultHeaders` for version pins or feature flags that are not secrets:

```json
{
  "api": {
    "baseUrl": "https://api.example.com",
    "authType": "bearer",
    "defaultHeaders": { "X-Api-Version": "2026-01-01" }
  }
}
```

## Choosing a Test Endpoint

Good test endpoints share three traits: they demand authentication, they answer fast, and they are never rate-limited into uselessness.

| Pattern | Example | Notes |
| ------------------ | ----------------------------------- | ---------------------------------------- |
| Account or profile | `me`, `user`, `account` | Proves the credential, returns identity |
| Health or status | `health`, `ping`, `status` | May skip auth — pairs well with none |
| Minimal list | `items?limit=1` | Auth check with a tiny payload |

::: tip
Never point `testEndpoint` at anything that mutates state. Read-only `GET` requests are the safe default; use a `POST` with a harmless `body` only when the API offers no plain read.
:::

## Working with a Configured Source

Once connected, the agent owns one tool per source (named `api_{slug}`) and can reach any endpoint under the base URL.

### Making requests

Natural-language instructions translate into tool calls:

> "Fetch user 123 from the metrics API"

becomes a call with `path: "/users/123"`, `method: "GET"`. The agent controls:

- Method — `GET`, `POST`, `PUT`, `DELETE`, or `PATCH`
- Path — resolved against `baseUrl`
- Params — query string for `GET`, JSON body otherwise
- Extra headers when an endpoint needs them

Auth headers are injected automatically; the agent never sees the credential.

### Raw (non-JSON) bodies

Request parameters are JSON-encoded by default. Endpoints that want plain text, XML, or another content type are served through the `_rawBody` escape hatch:

```
POST /documents/review with params: { "_rawBody": "approved", "_contentType": "text/plain" }
```

| Parameter | Type | Meaning |
| -------------- | ------ | ---------------------------------------------------------------- |
| `_rawBody` | string | Sent verbatim as the request body, no serialization |
| `_contentType` | string | Value for the `Content-Type` header; `text/plain` when omitted |

### Response handling

- JSON comes back parsed and readable.
- Oversized responses are guarded: rather than flooding the conversation, they are saved to the session folder and summarized.
- Binary payloads (PDFs, images, archives) are written to the session downloads folder and referenced by path.
- Failures surface the HTTP status plus the response text, so rate limits and validation errors are debuggable.

## Troubleshooting

### The connection test fails

- Confirm the base URL is reachable from your machine (proxy, VPN).
- Check the `testEndpoint` path for typos and verify it exists on this API version.
- Make sure the credential is valid and has the scopes the endpoint needs.
- Some APIs insist on extra headers — add them via `defaultHeaders`.

### Authentication is rejected

- Re-check the `authType` against the provider's documentation.
- Bearer tokens expire; paste a fresh one or configure `renewEndpoint`.
- For basic auth, verify which values the provider expects as username and password.
- For multi-header APIs, every header listed in `headerNames` must have a value.

### Requests error out

- Compare the path and parameters against the API reference.
- Verify the body shape — some endpoints reject unknown fields.
- Watch for rate limiting: the status code and message are included in the tool result.
- In Plan mode only `GET` is allowed; switch modes or add an `allowedApiEndpoints` rule (see [permissions](../../core-concepts/permissions)).

### The wrong auth header is sent

- `headerName` renames the header for `header` auth.
- `queryParam` renames the parameter for `query` auth.
- `authScheme` changes the bearer prefix — `"Token"`, or `""` for a bare token.

For the full configuration reference, head back to the [API sources overview](overview).
