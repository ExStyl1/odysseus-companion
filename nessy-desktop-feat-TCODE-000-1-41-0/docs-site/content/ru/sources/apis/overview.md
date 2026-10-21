# API Sources

API sources дают агенту flexible HTTP tool для любого REST service. Если что-то exposes HTTP endpoints — SaaS API, internal dashboard, search service — агент может вызвать это, не дожидаясь появления MCP server.

::: tip
Setup — это один chat message:

- "Create a source for the JSONPlaceholder API"
- "Connect our internal metrics API, it uses a bearer token"
- "Add the weather API — I have an API key"

Агент сгенерирует config, запросит credential и запустит connection test.
:::

## Как это работает

Когда API source настроен, Nessy Desktop:

1. **Registers** один tool с именем `api_{slug}`, принимающий path, HTTP method и parameters
2. **Stores** credential в encrypted [credential store](../../reference/config/credentials) и injects его в каждый request
3. **Validates** connectivity через configured test endpoint
4. **Scopes** requests к configured base URL — агент может вызвать любой endpoint под ним

Перед первым call в session агент должен прочитать `guide.md` source; документируйте там endpoints, и каждый request станет лучше.

## Configuration

API source определяется блоком `api` в `config.json`:

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
| ----- | -------- | ----------- |
| `type` | Yes | Всегда `"api"` |
| `name` | Yes | Label, показанный в source list |
| `tagline` | No | One-line summary, показанный агенту |
| `icon` | No | Emoji или URL; local `icon.svg`/`icon.png` files подхватываются automatically |
| `api.baseUrl` | Yes | Root URL, относительно которого resolve все request paths |
| `api.authType` | Yes | `bearer`, `header`, `query`, `basic`, `oauth` или `none` |
| `api.testEndpoint` | No | Connection check: `{ "method": "GET" \| "POST", "path": "…", "body"?: {}, "headers"?: {} }` |
| `api.headerName` | No | Header для `header` auth (default `x-api-key`) |
| `api.headerNames` | No | Несколько auth headers, запрашиваемых вместе, например Datadog `DD-API-KEY` и `DD-APPLICATION-KEY` |
| `api.queryParam` | No | Query parameter для `query` auth (default `api_key`) |
| `api.authScheme` | No | Prefix для `bearer` auth; default `"Bearer"`, также часто `"Token"`, `""` отправляет raw token |
| `api.defaultHeaders`| No | Static headers на каждый request (например version pins, feature flags) |
| `api.oauth` | No | Generic OAuth 2.0 endpoints и client settings (ниже) |
| `api.renewEndpoint` | No | Custom token-renewal endpoint для non-OAuth bearer APIs (ниже) |

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

Stored token отправляется как `Authorization: Bearer {token}`. Задайте `authScheme`, чтобы изменить prefix — `"Token"` для token-style APIs или empty string для services, ожидающих bare value без prefix.

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

Credential передаётся в указанном header: `X-API-Key: {token}`.

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

Если API ожидает два или больше secrets одновременно, перечислите header names в `headerNames`. Authentication prompts запросит значение для каждого header, и все они пойдут в каждый request. Типичные случаи: services, которые разделяют identity и authorization, или pairing API key с application secret.

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

Credential добавляется к URL как `?api_key={token}` — часто в старых APIs.

### Basic Authentication

```json
{
  "api": {
    "baseUrl": "https://api.example.com",
    "authType": "basic"
  }
}
```

Вас попросят username и password; requests несут `Authorization: Basic {base64(username:password)}`.

### No Authentication

```json
{
  "api": {
    "baseUrl": "https://api.example.com",
    "authType": "none"
  }
}
```

Для public endpoints. Tool работает сразу, без credential prompt.

### OAuth 2.0

Generic OAuth бывает двух видов: automatic discovery и explicit endpoint block.

#### Auto-discovery

Если API публикует OAuth metadata по RFC 9728 / RFC 8414, достаточно `authType: "oauth"`:

```json
{
  "api": {
    "baseUrl": "https://api.example.com/v1/",
    "authType": "oauth"
  }
}
```

Nessy Desktop probes base URL, follows `WWW-Authenticate` metadata, registers client dynamically и запускает browser authorization flow — блок `oauth` не нужен.

#### Explicit configuration

Providers без discoverable metadata (GitHub, Linear и большинство других) требуют endpoints и OAuth app, созданный у этого provider:

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
| ----- | -------- | ----------- |
| `oauth.authorizationUrl` | Yes | Authorization endpoint |
| `oauth.tokenUrl` | Yes | Token exchange endpoint |
| `oauth.clientId` | Yes | Client ID вашего OAuth app |
| `oauth.clientSecret` | No | Omit для public PKCE clients |
| `oauth.scopes` | No | Scopes to request |
| `oauth.audience` | No | Audience parameter (Auth0-style providers) |
| `oauth.extraParams` | No | Extra query parameters на authorization URL |

Оба режима выполняют полный OAuth 2.0 flow с PKCE. Access tokens refresh automatically и отправляются как `Authorization: Bearer {token}`.

### Google APIs

Google services обрабатываются отдельно: задайте `provider` как `"google"`, и source authenticates through Google OAuth с нужными scopes.

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

- `googleService` выбирает predefined scope set: `gmail`, `calendar`, `drive`, `docs`, `sheets`, `youtube` или `searchconsole`. Если omitted, service по возможности inferred from `baseUrl`.
- `googleScopes` overrides service presets explicit scopes.

::: warning
Nessy Desktop не поставляет собственный Google OAuth client. Нужно создать OAuth client в своём Google Cloud project и передать его через `googleOAuthClientId` / `googleOAuthClientSecret` в source config или через environment variables `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`. Без одного из этих вариантов Google authentication завершится configuration error.
:::

## Test Endpoint

`testEndpoint` задаёт request для проверки source. Connection test подтверждает сразу три вещи: base URL resolves, credential accepted, API отвечает разумно.

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

Частые варианты:

| API style | Endpoint to test |
| --------- | ---------------- |
| Account-aware | `/me`, `/user` |
| Health check | `/health`, `/ping` |
| Status | `/status` |

::: tip
Выбирайте дешёвый `GET` endpoint, который всё же требует authentication — connectivity и credentials проверяются одним round trip. `POST` test endpoints с `body` поддерживаются для APIs, где нет ничего другого.
:::

## Token Renewal (Non-OAuth)

Некоторые internal APIs выдают bearer tokens с собственным refresh endpoint вместо OAuth. Optional block `renewEndpoint` позволяет Nessy Desktop автоматически renew такие tokens при expiry, а не просить вставить новый:

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
| ----- | -------- | ------- | ----------- |
| `path` | Yes | — | Relative path (joined with `baseUrl`) или absolute URL |
| `method` | No | `"POST"` | `"GET"` или `"POST"` |
| `body` | No | — | JSON body; placeholders `{{token}}` заполняются live token |
| `headers` | No | — | Additional request headers; placeholder filling применяется и к этим values |
| `tokenField` | No | `"access_token"` | Response field с новым token |
| `expiresInField` | No | `"expires_in"` | Response field с lifetime в seconds |
| `fallbackTtlSecs` | No | — | Assumed lifetime, если response ничего не сообщает |

Что важно знать:

- Без `body` текущий token передаётся через `Authorization` header (respecting `authScheme`). С `body` `{{token}}` заменяется в string values, включая nested objects и arrays.
- `defaultHeaders` включаются ниже любых `renewEndpoint.headers`; explicit `Authorization` entry там suppresses automatic one.
- Если response не содержит expiry и `fallbackTtlSecs` не задан, token renew снова на следующем session start — безопасно, просто chatty.
- Failed renewal помечает source как `needs_auth`, чтобы app могла запросить вас.

::: tip
Этот механизм только для bespoke renewal endpoints. Если provider speaks OAuth, используйте `authType: "oauth"` и стандартный refresh flow.
:::

## Plan Mode Behavior

В Plan mode API tools могут отправлять только `GET` requests. Чтобы разрешить specific write operations, оставаясь в Plan, добавьте rules `allowedApiEndpoints` в `permissions.json` source:

```json
{
  "allowedApiEndpoints": [
    { "method": "POST", "path": "^/search$", "comment": "Search is read-only despite POST" }
  ]
}
```

Каждый rule связывает HTTP method с regex по request path. См. [permissions](../../core-concepts/permissions) для общей модели modes.

## Зачем API Sources

- **Reach** — всё с REST interface может стать tool, с first-party MCP support или без.
- **Low ceremony** — base URL плюс auth type уже дают working integration.
- **Flexible requests** — JSON in and out по умолчанию, плюс raw bodies, когда endpoint ожидает plain text, XML или другой content type.
- **Safe credential handling** — secrets живут в encrypted store, никогда в `config.json`, а credential updates применяются к следующему request без restart session.

## MCP Sources vs API Sources

| Aspect | MCP sources | API sources |
| ------ | ----------- | ----------- |
| Setup | Server URL или local command | Base URL плюс auth settings |
| Tools | Fixed set, defined by server | Один flexible HTTP tool |
| Auth | OAuth, bearer, headers | Bearer, header, multi-header, query, basic, OAuth, none |
| Best for | Services with MCP offerings | Всё остальное с HTTP API |

Предпочитайте MCP server, когда service его предоставляет — purpose-built tools проще использовать precisely. Выбирайте API source, когда MCP option нет или нужен raw endpoint access.

## Дальше

- [Curl examples](curl-examples) — worked configurations и request patterns
- [Sources overview](../overview) — folder layout, guides и lifecycle
