# API Sources

API sources give the agent a flexible HTTP tool for any REST service. If something exposes HTTP endpoints — a SaaS API, an internal dashboard, a search service — the agent can call it without waiting for an MCP server to exist.

::: tip
Setup is a chat message away:

- "Create a source for the JSONPlaceholder API"
- "Connect our internal metrics API, it uses a bearer token"
- "Add the weather API — I have an API key"

The agent generates the config, prompts for the credential, and runs a connection test.
:::

## How It Works

When an API source is configured, Nessy Desktop:

1. **Registers** one tool named `api_{slug}` that accepts a path, an HTTP method, and parameters
2. **Stores** the credential in the encrypted [credential store](../../reference/config/credentials) and injects it into every request
3. **Validates** connectivity against the configured test endpoint
4. **Scopes** requests to the configured base URL — the agent may call any endpoint under it

Before the first call in a session, the agent must read the source's `guide.md`; document your endpoints there and every request benefits.

## Configuration

An API source is defined by the `api` block in its `config.json`:

```json
{
  "type": "api",
  "name": "Metrics API",
  "slug": "metrics",
  "enabled": true,
  "provider": "custom",
  "tagline": "Internal service metrics and dashboards",
  "api": {
    "baseUrl": "https://metrics.internal.example.com/",
    "testEndpoint": {
      "method": "GET",
      "path": "health"
    },
    "authType": "bearer"
  }
}
```

### Field Reference

| Field | Required | Description |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `type` | Yes | Always `"api"` |
| `name` | Yes | Label shown in the source list |
| `tagline` | No | One-line summary shown to the agent |
| `icon` | No | Emoji or URL; local `icon.svg`/`icon.png` files are picked up automatically |
| `api.baseUrl` | Yes | Root URL that all request paths resolve against |
| `api.authType` | Yes | `bearer`, `header`, `query`, `basic`, `oauth`, or `none` |
| `api.testEndpoint` | No | Connection check: `{ "method": "GET" \| "POST", "path": "…", "body"?: {}, "headers"?: {} }` |
| `api.headerName` | No | Header used by `header` auth (default `x-api-key`) |
| `api.headerNames` | No | Multiple auth headers prompted for together, for example Datadog's `DD-API-KEY` and `DD-APPLICATION-KEY` |
| `api.queryParam` | No | Query parameter used by `query` auth (default `api_key`) |
| `api.authScheme` | No | Prefix for `bearer` auth; default `"Bearer"`, `"Token"` also common, `""` sends the raw token |
| `api.defaultHeaders`| No | Static headers attached to every request (e.g. version pins, feature flags) |
| `api.oauth` | No | Generic OAuth 2.0 endpoints and client settings (below) |
| `api.renewEndpoint` | No | Custom token-renewal endpoint for non-OAuth bearer APIs (below) |

## Authentication Types

### Bearer Token

```json
{
  "api": {
    "baseUrl": "https://api.example.com",
    "authType": "bearer"
  }
}
```

The stored token is sent as `Authorization: Bearer {token}`. Set `authScheme` to change the prefix — `"Token"` for token-style APIs, or an empty string for services that expect the bare value with no prefix at all.

### Header Authentication

```json
{
  "api": {
    "baseUrl": "https://api.example.com",
    "authType": "header",
    "headerName": "X-API-Key"
  }
}
```

The credential travels in the header you name: `X-API-Key: {token}`.

### Multi-Header Authentication

```json
{
  "api": {
    "baseUrl": "https://api.datadoghq.com",
    "authType": "header",
    "headerNames": ["DD-API-KEY", "DD-APPLICATION-KEY"]
  }
}
```

When an API expects two or more secrets at once, list each header name in `headerNames`. Authentication prompts for one value per header, and all of them ride along on every request. Typical cases: services that split identity from authorization, or pair an API key with an application secret.

### Query Parameter Authentication

```json
{
  "api": {
    "baseUrl": "https://api.example.com",
    "authType": "query",
    "queryParam": "api_key"
  }
}
```

The credential is appended to the URL as `?api_key={token}` — common in older APIs.

### Basic Authentication

```json
{
  "api": {
    "baseUrl": "https://api.example.com",
    "authType": "basic"
  }
}
```

You are asked for a username and password; requests carry `Authorization: Basic {base64(username:password)}`.

### No Authentication

```json
{
  "api": {
    "baseUrl": "https://api.example.com",
    "authType": "none"
  }
}
```

For public endpoints. The tool works immediately, no credential prompt.

### OAuth 2.0

Generic OAuth comes in two flavors: automatic discovery, and an explicit endpoint block.

#### Auto-discovery

If the API publishes OAuth metadata per RFC 9728 / RFC 8414, `authType: "oauth"` alone is enough:

```json
{
  "api": {
    "baseUrl": "https://api.example.com/v1/",
    "authType": "oauth"
  }
}
```

Nessy Desktop probes the base URL, follows the `WWW-Authenticate` metadata, registers a client dynamically, and launches the browser authorization flow — no `oauth` block required.

#### Explicit configuration

Providers without discoverable metadata (GitHub, Linear, and most others) need their endpoints spelled out, along with an OAuth app you create with that provider:

```json
{
  "api": {
    "baseUrl": "https://api.github.com/",
    "authType": "oauth",
    "oauth": {
      "authorizationUrl": "https://github.com/login/oauth/authorize",
      "tokenUrl": "https://github.com/login/oauth/access_token",
      "clientId": "your_client_id",
      "clientSecret": "your_client_secret",
      "scopes": ["repo", "read:user"]
    }
  }
}
```

| Field | Required | Description |
| ------------------------ | -------- | ------------------------------------------------ |
| `oauth.authorizationUrl` | Yes | Authorization endpoint |
| `oauth.tokenUrl` | Yes | Token exchange endpoint |
| `oauth.clientId` | Yes | Client ID of your OAuth app |
| `oauth.clientSecret` | No | Omit for public PKCE clients |
| `oauth.scopes` | No | Scopes to request |
| `oauth.audience` | No | Audience parameter (Auth0-style providers) |
| `oauth.extraParams` | No | Extra query parameters on the authorization URL |

Both modes run the full OAuth 2.0 flow with PKCE. Access tokens refresh automatically and are sent as `Authorization: Bearer {token}`.

### Google APIs

Google services get dedicated handling: set `provider` to `"google"` and the source authenticates through Google OAuth with the right scopes.

```json
{
  "type": "api",
  "name": "Google Calendar",
  "provider": "google",
  "api": {
    "baseUrl": "https://www.googleapis.com/calendar/v3",
    "authType": "oauth",
    "googleService": "calendar",
    "googleOAuthClientId": "1234567890-abc.apps.googleusercontent.com",
    "googleOAuthClientSecret": "GOCSPX-..."
  }
}
```

- `googleService` selects a predefined scope set: `gmail`, `calendar`, `drive`, `docs`, `sheets`, `youtube`, or `searchconsole`. When omitted, the service is inferred from `baseUrl` where possible.
- `googleScopes` overrides the service presets with explicit scopes.

::: warning
Nessy Desktop ships no Google OAuth client of its own. You must create an OAuth client in your own Google Cloud project and supply it either through `googleOAuthClientId` / `googleOAuthClientSecret` in the source config or through the `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` environment variables. Without one of these, Google authentication fails with a configuration error.
:::

## Test Endpoint

`testEndpoint` names a request used to verify the source. Running a connection test confirms three things at once: the base URL resolves, the credential is accepted, and the API answers sensibly.

```json
{
  "api": {
    "testEndpoint": {
      "method": "GET",
      "path": "me"
    }
  }
}
```

Common choices:

| API style | Endpoint to test |
| ------------- | ---------------------- |
| Account-aware | `/me`, `/user` |
| Health check | `/health`, `/ping` |
| Status | `/status` |

::: tip
Pick a cheap `GET` endpoint that still requires authentication — connectivity and credentials get validated in a single round trip. `POST` test endpoints with a `body` are supported for APIs that offer nothing else.
:::

## Token Renewal (Non-OAuth)

Some internal APIs issue bearer tokens with their own refresh endpoint rather than OAuth. The optional `renewEndpoint` block lets Nessy Desktop renew such tokens automatically when they expire, instead of asking you to paste a new one:

```json
{
  "api": {
    "baseUrl": "https://api.example.com/",
    "authType": "bearer",
    "renewEndpoint": {
      "path": "auth/renew",
      "method": "POST",
      "tokenField": "access_token",
      "expiresInField": "expires_in"
    }
  }
}
```

| Field | Required | Default | Description |
| ----------------- | -------- | ---------------- | ------------------------------------------------------------------------ |
| `path` | Yes | — | Relative path (joined with `baseUrl`) or absolute URL |
| `method` | No | `"POST"` | `"GET"` or `"POST"` |
| `body` | No | — | JSON body; `{{token}}` placeholders are filled with the live token |
| `headers` | No | — | Additional request headers; placeholder filling applies to these values too |
| `tokenField` | No | `"access_token"` | Response field holding the new token |
| `expiresInField` | No | `"expires_in"` | Response field holding the lifetime in seconds |
| `fallbackTtlSecs` | No | — | Assumed lifetime when the response reports none |

Details worth knowing:

- Without a `body`, the current token is presented via the `Authorization` header (respecting `authScheme`). With a `body`, `{{token}}` is replaced in string values, including nested objects and arrays.
- `defaultHeaders` are included beneath any `renewEndpoint.headers`; an explicit `Authorization` entry there suppresses the automatic one.
- If the response carries no expiry and no `fallbackTtlSecs` is set, the token is renewed again at the next session start — safe, just chatty.
- A failed renewal marks the source `needs_auth` so the app can prompt you.

::: tip
This mechanism is for bespoke renewal endpoints only. If the provider speaks OAuth, use `authType: "oauth"` and let the standard refresh flow handle it.
:::

## Plan Mode Behavior

In Plan mode, API tools may only send `GET` requests. To allow specific write operations while staying in Plan, add `allowedApiEndpoints` rules to the source's `permissions.json`:

```json
{
  "allowedApiEndpoints": [
    { "method": "POST", "path": "^/search$", "comment": "Search is read-only despite POST" }
  ]
}
```

Each rule pairs an HTTP method with a regex over the request path. See [permissions](../../core-concepts/permissions) for the wider mode model.

## Why Use API Sources?

- **Reach** — anything with a REST interface can become a tool, first-party MCP support or not.
- **Low ceremony** — a base URL plus an auth type is a working integration.
- **Flexible requests** — JSON in and out by default, plus raw bodies when an endpoint wants plain text, XML, or another content type.
- **Safe credential handling** — secrets live in the encrypted store, never in `config.json`, and credential updates apply to the next request without restarting the session.

## MCP Sources vs API Sources

| Aspect | MCP sources | API sources |
| -------- | ---------------------------- | ------------------------------------------------ |
| Setup | Server URL or local command | Base URL plus auth settings |
| Tools | Fixed set defined by server | One flexible HTTP tool |
| Auth | OAuth, bearer, headers | Bearer, header, multi-header, query, basic, OAuth, none |
| Best for | Services with MCP offerings | Everything else with an HTTP API |

Prefer an MCP server when the service provides one — purpose-built tools are easier for the agent to use precisely. Reach for an API source when there is no MCP option or you want raw endpoint access.

## Next Steps

- [Curl examples](curl-examples) — worked configurations and request patterns
- [Sources overview](../overview) — folder layout, guides, and lifecycle
