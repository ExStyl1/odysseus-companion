# Примеры API Source через curl

Сначала прототипируйте API через curl, затем превращайте working command в source. Один успешный curl call даёт всё, что нужно source definition: base URL, auth style, method и response shape.

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

Каждая часть command map onto source config:

| Curl piece | Goes to |
| ---------- | ------- |
| URL up to the versioned root | `api.baseUrl` |
| `-H "Authorization: Bearer …"` | `authType: "bearer"`; token into the credential prompt |
| `-H "x-api-key: …"` | `authType: "header"` + `headerName` |
| `-u user:pass` | `authType: "basic"` |
| `?key=…` in the URL | `authType: "query"` + `queryParam` |
| A cheap authenticated `GET` | `api.testEndpoint` |

Secrets никогда не попадают в `config.json` — app prompts for them и хранит в encrypted credential store.

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

Requests, которые агент затем может выполнять:

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

Во время authentication появятся два prompts, по одному на header; оба values идут в каждый call.

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
Twilio ожидает Account SID как username и Auth Token как password.
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

Expiring bearer token renews itself через `auth/renew` — см. [renewal section](overview#token-renewal-non-oauth) для всех options.

## Common Patterns

### Versioned base URLs

Включите version в base, чтобы paths были короткими:

```json
{ "api": { "baseUrl": "https://api.example.com/v2" } }
```

### Tenant-specific hosts

Multi-tenant products обычно используют hostname:

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

Используйте `defaultHeaders` для version pins или feature flags, которые не являются secrets:

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

Хорошие test endpoints имеют три свойства: требуют authentication, отвечают быстро и не становятся useless из-за rate limits.

| Pattern | Example | Notes |
| ------- | ------- | ----- |
| Account or profile | `me`, `user`, `account` | Proves the credential, returns identity |
| Health or status | `health`, `ping`, `status` | May skip auth — pairs well with none |
| Minimal list | `items?limit=1` | Auth check with a tiny payload |

::: tip
Никогда не указывайте `testEndpoint` на то, что mutates state. Read-only `GET` requests — safe default; используйте `POST` с harmless `body` только когда API не даёт обычного read.
:::

## Working with a Configured Source

После подключения агент получает один tool на source (named `api_{slug}`) и может обращаться к любому endpoint под base URL.

### Making requests

Natural-language instructions превращаются в tool calls:

> "Fetch user 123 from the metrics API"

становится call с `path: "/users/123"`, `method: "GET"`. Агент управляет:

- Method — `GET`, `POST`, `PUT`, `DELETE` или `PATCH`
- Path — resolved against `baseUrl`
- Params — query string для `GET`, JSON body иначе
- Extra headers, если endpoint их требует

Auth headers inject automatically; агент никогда не видит credential.

### Raw (non-JSON) bodies

Request parameters JSON-encode по умолчанию. Endpoints, которым нужен plain text, XML или другой content type, обслуживаются через escape hatch `_rawBody`:

```
POST /documents/review with params: { "_rawBody": "approved", "_contentType": "text/plain" }
```

| Parameter | Type | Meaning |
| --------- | ---- | ------- |
| `_rawBody` | string | Sent verbatim as the request body, no serialization |
| `_contentType` | string | Value for the `Content-Type` header; `text/plain` when omitted |

### Response handling

- JSON возвращается parsed и readable.
- Oversized responses guarded: вместо flooding conversation они сохраняются в session folder и summarised.
- Binary payloads (PDFs, images, archives) записываются в session downloads folder и referenced by path.
- Failures показывают HTTP status и response text, чтобы rate limits и validation errors было проще debug.

## Troubleshooting

### The connection test fails

- Confirm base URL reachable с вашей машины (proxy, VPN).
- Проверьте `testEndpoint` path на typos и версию API.
- Убедитесь, что credential valid и имеет нужные endpoint scopes.
- Некоторые APIs требуют extra headers — добавьте их через `defaultHeaders`.

### Authentication is rejected

- Сверьте `authType` с provider documentation.
- Bearer tokens expire; вставьте свежий или настройте `renewEndpoint`.
- Для basic auth проверьте, какие values provider ожидает как username и password.
- Для multi-header APIs каждый header из `headerNames` должен иметь value.

### Requests error out

- Сравните path и parameters с API reference.
- Проверьте body shape — некоторые endpoints reject unknown fields.
- Следите за rate limiting: status code и message включены в tool result.
- В Plan mode разрешён только `GET`; переключите mode или добавьте rule `allowedApiEndpoints` (см. [permissions](../../core-concepts/permissions)).

### The wrong auth header is sent

- `headerName` меняет header для `header` auth.
- `queryParam` меняет parameter для `query` auth.
- `authScheme` меняет bearer prefix — `"Token"` или `""` для bare token.

Полная configuration reference — в [API sources overview](overview).
