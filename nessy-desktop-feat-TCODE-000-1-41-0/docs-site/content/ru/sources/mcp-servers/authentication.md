# MCP Authentication

Большинство полезных MCP-серверов требуют аутентификации. Nessy Desktop
поддерживает три режима для удалённых серверов, требования к окружению и
конфигурации для локальных процессов и общий Developer Platform (DP) SSO для
квалифицированных корпоративных MCP.

## Authentication Types

Поле `mcp.authType` выбирает mechanism для HTTP/SSE servers:

| Type | Best for | What happens |
| --- | --- | --- |
| `oauth` | Servers with user accounts and scoped access | Browser-based authorization; tokens refresh automatically |
| `bearer` | Static API keys and personal tokens | You're prompted once for the token; it's sent as `Authorization: Bearer …` |
| `none` | Public or network-trusted servers | Requests go out unauthenticated |

Обычные stdio-серверы игнорируют `authType` Source. При этом им может требоваться
явно объявленная конфигурация или переменные окружения, а серверы
`dp ai mcp ...` используют отдельный общий DP-процесс ниже.

## Developer Platform SSO

Все supervised plugin-серверы, у которых нормализованная команда равна `dp`, а
аргументы начинаются с `ai mcp`, используют одну server-side сессию Spirit CLI.
Nessy проверяет её через общий broker и не запускает такие MCP, пока состояние
не станет `ready`. Если нужен вход, одна DP-карточка запускает `dp auth login`;
этот вход действует для всех серверов `dp ai mcp ...`. Их subprocess получает
`DP_AI_MCP_SKIP_LOGIN=true` и не открывает собственный login flow.

Владельцем DP-учётных данных остаётся Spirit CLI в `DP_WORKDIR` или его обычном
каталоге по умолчанию (`~/.dp` — туда же попадает и вход, запущенный
приложением, поэтому его видят и `dp` в вашем терминале, и серверы
`dp ai mcp`). Nessy никогда не записывает, не копирует, не сохраняет, не
логирует и не отправляет raw DP token в renderer. Читает его приложение в одном
случае: если `dp auth print-token` не удаётся запустить, он не отвечает вовремя
или его ответ не разобрать, вход в Nessy Gateway один раз читает запись
пользователя из собственного файла сессии dp (только чтение) и обменивает её на
gateway JWT. Сохранённая сессия, которой осталось меньше пяти минут, не
используется, а вход, который её использовал, сообщает об этом. Файл
`~/.nessy/dp_auth_creds.json` — другое: это JWT для Nessy Gateway. Формат файла —
контракт nessy-cli, но сам файл принадлежит Nessy: единственный, кто его пишет, —
собственный вход через dp (атомарно, с правами 0600 и сохраняя чужие ключи), а
другие инструменты, например nessy-cli, только читают его; см.
[Что Nessy Desktop делает с `dp_auth_creds.json`](../../reference/config/credentials).
Токен в нём не подтверждает готовность DP SSO для plugin MCP.

Источник истины — нормализованные command и args. Названия в Marketplace и
имена серверов вроде `dpGitlab` используются только для отображения: похожее
имя у bundled executable не делает его DP-сервером.

## OAuth

Declare `authType: "oauth"` для servers, implementing MCP authorization spec:

```json
{
  "type": "mcp",
  "name": "Linear",
  "tagline": "Issue tracking and project management",
  "mcp": {
    "transport": "http",
    "url": "https://mcp.linear.app/mcp",
    "authType": "oauth"
  }
}
```

### How the Flow Works

Весь flow идёт между вашей machine, MCP server и его authorization server — intermediary relay service нет.

1. **Discovery.** App fetches OAuth metadata server, follows RFC 9728 protected-resource metadata и RFC 8414 authorization-server metadata, пробуя standard well-known locations in order.
2. **Proof setup.** Для flow генерируются PKCE verifier/challenge pair (S256) и random `state` value.
3. **Local callback server.** One-shot HTTP listener bind on `localhost`, пробуя ports 8914 through 8924 до свободного, serving path `/oauth/callback`.
4. **Client registration.** Если authorization server offers dynamic client registration, app registers itself as public client with callback URL as redirect URI. Если registration unavailable or gated (401/403), используется default client ID.
5. **Browser authorization.** Default browser opens authorization URL. Вы входите и approve access на provider pages.
6. **Callback.** Provider redirects to `http://localhost:<port>/oauth/callback`. Listener verifies `state` value (rejecting mismatches as possible CSRF attempt), captures authorization code, shows success page and shuts down.
7. **Token exchange.** Code плюс PKCE verifier exchange at token endpoint for access token and, when granted, refresh token.
8. **Storage.** Tokens, expiry и client ID попадают в encrypted vault, а source switches to `connected`.

Если callback не приходит за 5 minutes, flow times out и его можно начать заново. Если server issues no `expires_in`, app assumes one-hour lifetime so refresh logic still works.

::: info Local-only callback
Redirect target всегда loopback address на вашей machine. No third-party domain participates in the exchange, что также значит, что flow работает с servers in private networks — пока browser can reach authorization pages.
:::

### Token Refresh

Refresh automatic and proactive:

- Tokens renew when expired **or within 5 minutes of expiring**, checked at session start and before requests.
- Concurrent refresh attempts for same source deduplicated into one request.
- Failed refresh marks source `needs_auth` (with error recorded on source) and starts 5-minute cooldown, so broken provider is not hammered. Re-authentication from source view clears state.

### Triggering Authentication

Агент может сам начать OAuth dance через tool `source_oauth_trigger` — useful, когда mid-session tool call обнаруживает expired grant. Tool принимает либо созданный пользователем source (`sourceSlug`), либо plugin-owned server (`pluginKey` плюс `serverName`; его credential глобальный — один вход действует во всех workspaces). В read-only режиме Plan ([permission mode](../../core-concepts/permissions)) этот tool blocked, а Don't ask его denies, поэтому unattended sessions не могут pop browser windows.

## Bearer Tokens

Declare `authType: "bearer"` для servers, keyed by static token:

```json
{
  "type": "mcp",
  "name": "Exa Search",
  "tagline": "Web search and content extraction",
  "mcp": {
    "transport": "http",
    "url": "https://mcp.exa.ai/mcp",
    "authType": "bearer"
  }
}
```

При first use app asks for token через masked credential prompt (tool агента `source_credential_prompt`, также blocked в режиме Plan). Value идёт прямо в encrypted vault — never written to `config.json` — и каждый request к server несёт `Authorization: Bearer <token>`.

Static tokens не имеют refresh mechanism. Когда token expires or revoked, server начинает returning 401/403, source shows `needs_auth`, и вы вставляете новый token. Mid-session updates apply on next tool call; restart not needed.

## Custom Header Authentication

Некоторые servers хотят key в custom header вместо `Authorization`. Declare header names, и values будут храниться как secrets:

```json
{
  "type": "mcp",
  "name": "Internal Search",
  "tagline": "Company search cluster",
  "mcp": {
    "transport": "http",
    "url": "https://mcp.internal.example.com/mcp",
    "authType": "none",
    "headers": { "X-Org-Id": "platform-team" },
    "headerNames": ["X-API-Key"]
  }
}
```

Headers layered in fixed precedence, later entries overriding earlier ones:

1. `mcp.headers` — static values from config file (non-secret).
2. `mcp.headerNames` — secret values pulled from credential vault at request time.
3. `Authorization: Bearer …` — OAuth или bearer token, when `authType` is not `none`.

## Public Servers

`authType: "none"` полностью disables credential handling — ничего не prompted, stored or read:

```json
{
  "type": "mcp",
  "name": "Docs Search",
  "tagline": "Public documentation index",
  "mcp": {
    "transport": "http",
    "url": "https://docs.example.com/mcp",
    "authType": "none"
  }
}
```

## Local Servers (Stdio)

Stdio servers authenticate как любой local process — through environment variables или own config files:

```json
{
  "type": "mcp",
  "name": "Postgres",
  "tagline": "Query the analytics database",
  "mcp": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "some-postgres-mcp"],
    "env": {
      "PGHOST": "localhost",
      "PGDATABASE": "analytics"
    }
  }
}
```

Обратите внимание: values `mcp.env` хранятся plain text внутри `config.json`. Не кладите туда genuinely sensitive material, если server offers alternative (credentials file, system keychain). Inherited environment subprocess уже stripped of common high-value secrets — см. [local process safety](overview#local-process-safety).

## Credential Storage

OAuth, bearer и значения секретных headers для Sources находятся в одном
encrypted file. `CONFIG_DIR` равен
`NESSY_CONFIG_DIR`, если переменная задана, иначе — `~/.nessy-agent`:

```
CONFIG_DIR/credentials.enc
```

- Encryption — AES-256-GCM with key derived from stable machine identifier; file useless if copied to another computer (expect decryption error and re-authentication prompt after migrating machines).
- Записи созданных пользователем sources keyed by type, workspace and source: `source_oauth::<workspace-id>::<source-slug>` для OAuth tokens, `source_bearer::…` для static tokens. Workspaces этими credentials не делятся, а два source, указывающие на один сервер, держат независимые grants.
- Plugin-owned MCP-серверы используют глобальные слоты: `plugin_mcp_oauth::<plugin-key>::<server-name>` и `plugin_mcp_bearer::…` — один credential на сервер, общий для всех workspaces, вычищается при uninstall плагина.
- OAuth entries carry access token, refresh token, expiry and OAuth client ID needed for refresh.
- DP credentials в этот vault не попадают: ими владеет Spirit CLI в
  `DP_WORKDIR`. Объявленные несекретные stdio environment/configuration
  остаются конфигурацией, а не OAuth credential.

Подробнее о vault — в [credentials reference](../../reference/config/credentials).

::: warning Переход на storage v2
Старый `credentials.enc` в карантине v1 никогда не импортируется и не читается.
В v2 нужно повторно авторизовать MCP Sources и ввести их bearer/API credentials.
Отдельный файл `~/.nessy/dp_auth_creds.json` используется только Nessy Gateway.
Он лежит вне v2 home, поэтому storage cutover его не импортирует и не
переписывает, а валидный сохранённый в нём Gateway JWT продолжает работать;
единственным, кто его пишет, остаётся собственный вход приложения через dp.
Этот файл не авторизует MCP Sources.
:::

### Removing Credentials

- Deleting source deletes its vault entries.
- Чтобы force fresh login without deleting source, remove and re-add it, или rerun authentication from source view — new tokens overwrite old ones.
- Deleting `CONFIG_DIR/credentials.enc` wipes **every** stored secret (LLM keys included); every connection will ask for auth again.

## Example: Mixed Auth in One Workspace

```json
[
  {
    "type": "mcp",
    "name": "Linear",
    "mcp": { "transport": "http", "url": "https://mcp.linear.app/mcp", "authType": "oauth" }
  },
  {
    "type": "mcp",
    "name": "Exa Search",
    "mcp": { "transport": "http", "url": "https://mcp.exa.ai/mcp", "authType": "bearer" }
  },
  {
    "type": "mcp",
    "name": "Docs Search",
    "mcp": { "transport": "http", "url": "https://docs.example.com/mcp", "authType": "none" }
  },
  {
    "type": "mcp",
    "name": "SQLite",
    "mcp": { "transport": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-sqlite", "/Users/me/data/app.db"] }
  }
]
```

Linear один раз открывает browser и затем refreshes silently; Exa один раз asks for API key; docs server just works; SQLite runs locally with no credentials.

## Troubleshooting

#### OAuth-карточка завершилась ошибкой

Failed-карточка показывает server-owned diagnostic, включая отсутствие MCP
OAuth metadata. Ошибка generic OAuth терминальна: у карточки нет действия
Retry. Новую попытку начинает только отдельный, заново опубликованный pending
request с новым идентификатором. Nessy не превращает невалидный generic URL,
включая GitLab URL, в DP по его имени.

У DP другая семантика: Desktop сохраняет соответствующий server-only replay в
pending и позволяет повторить общий broker flow на той же DP-карточке. Cancel
или cleanup сессии удаляет этот replay.

#### Browser never opens

- Проверьте, что default browser задан и reachable from app.
- При необходимости copy authorization URL из auth prompt в browser manually.
- Firewall blocking loopback connections will break callback — ports 8914–8924 on `localhost` must be reachable from browser.
- Если app reports every callback port busy, another process (or stuck previous flow) holds them; restarting app releases its own listeners.

#### "State mismatch" on the callback page

Callback принёс `state` value, который app не выдавала — обычно stale tab from earlier attempt. Закройте old authorization tabs и запустите flow once, fresh.

#### Server rejects the token

- Confirm account you authorized has access to resources touched by tools, and requested scopes sufficient.
- Verify `mcp.url` points at same environment you authenticated against (staging vs production mix-ups common).
- Проверьте, что `authType` matches server: server expecting plain API key will reject OAuth token and vice versa.

#### Repeated re-authentication prompts

- Provider may be revoking tokens (session policies, password change, admin action).
- Refresh failure puts source into `needs_auth` — source view shows recorded error, usually naming cause.
- После переезда на новую machine ожидается one full re-auth per source: vault key is machine-bound.

#### Wrong account got connected

Providers reuse browser's active session. Log out of provider (or use private window), then rerun authentication for source.

## Security Recommendations

- Предпочитайте OAuth, где server offers it — grants scoped, revocable and rotate themselves.
- Let credential prompt collect secrets; never paste tokens into `config.json`, `guide.md` or session messages.
- Issue narrowest key integration needs, and rotate long-lived static tokens on schedule.
- Treat `mcp.env` как visible-on-disk configuration, not secret storage.
- Review connected sources per workspace occasionally and remove ones no longer used — their credentials go with them.
