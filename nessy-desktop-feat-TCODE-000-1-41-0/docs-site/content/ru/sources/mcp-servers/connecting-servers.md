# Подключение MCP Servers

Эта страница показывает, как добавлять MCP servers как sources — remote endpoints over HTTP, local subprocess servers over stdio, и как диагностировать connection, который не поднимается.

::: tip Let the agent do the setup
Самый быстрый путь — action **Add Source** в sidebar. Опишите, что нужно: "connect the Exa search MCP server", "add the SQLite server for ~/data/app.db" — и агент напишет source config, запустит connection test и проведёт через authentication, если server её требует.
:::

## Configuration Schema

Каждый MCP source имеет одну shape (см. [overview](overview#configuration-fields) для full field reference):

```json
{
  "type": "mcp",
  "name": "Server Name",
  "tagline": "What this server is for",
  "icon": "https://example.com/favicon.ico",
  "mcp": {
    "transport": "http",
    "url": "https://mcp.example.com/mcp",
    "authType": "oauth"
  }
}
```

Source configs живут в `~/.nessy-agent/workspaces/<workspace-id>/sources/<slug>/config.json`. Их можно править вручную; app watches folder и подхватывает changes.

## Remote Servers (HTTP)

Задайте `transport` как `"http"` (или omit — HTTP default) и укажите full endpoint URL:

```json
{
  "type": "mcp",
  "name": "Exa Search",
  "tagline": "Web search and content extraction",
  "icon": "https://exa.ai/favicon.ico",
  "mcp": {
    "transport": "http",
    "url": "https://mcp.exa.ai/mcp",
    "authType": "bearer"
  }
}
```

Две частые ошибки:

- URL используется verbatim (minus trailing slashes). Если server живёт на `/mcp` или `/v1/mcp`, этот path должен быть частью `mcp.url`.
- `authType` должен соответствовать ожиданиям server — `"oauth"`, `"bearer"` или `"none"`. [Authentication guide](authentication) описывает каждый mode.

Legacy Server-Sent Events endpoints можно объявить через `"transport": "sse"`; config передаётся в agent runtime unchanged. Для новых integrations используйте Streamable HTTP.

## Local Servers (Stdio)

Задайте `transport` как `"stdio"` и command, которая запускает server. Nessy Desktop сам spawns and supervises process.

**npm package via npx:**

```json
{
  "type": "mcp",
  "name": "SQLite",
  "tagline": "Query a local SQLite database",
  "mcp": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-sqlite", "/Users/me/data/app.db"]
  }
}
```

**Node.js script:**

```json
{
  "type": "mcp",
  "name": "Custom Tools",
  "tagline": "In-house MCP server",
  "mcp": {
    "transport": "stdio",
    "command": "node",
    "args": ["/Users/me/mcp/server.js"]
  }
}
```

**Python script:**

```json
{
  "type": "mcp",
  "name": "Data Pipeline",
  "tagline": "Python MCP server",
  "mcp": {
    "transport": "stdio",
    "command": "python",
    "args": ["/Users/me/mcp/server.py"]
  }
}
```

**Compiled binary:**

```json
{
  "type": "mcp",
  "name": "Fast Indexer",
  "tagline": "Native MCP server",
  "mcp": {
    "transport": "stdio",
    "command": "/usr/local/bin/mcp-indexer"
  }
}
```

Если server читает configuration из environment variables, добавьте block `env`:

```json
{
  "mcp": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "some-db-mcp"],
    "env": {
      "DB_HOST": "localhost",
      "DB_NAME": "analytics"
    }
  }
}
```

Spawned process наследует environment с удалёнными common secret variables; entries `env` применяются поверх. Details в [overview](overview#local-process-safety).

::: warning Stdio servers run as you
Local MCP server — обычный process с filesystem и network access вашего user. Проверьте package или script перед подключением к workspace и предпочитайте pinned versions вместо floating `latest` tags.
:::

## Custom Headers

Remote servers иногда требуют extra headers — org identifier, API version или non-standard auth header:

```json
{
  "mcp": {
    "transport": "http",
    "url": "https://mcp.internal.example.com/mcp",
    "authType": "none",
    "headers": {
      "X-Org-Id": "platform-team"
    },
    "headerNames": ["X-API-Key"]
  }
}
```

- `headers` хранит static, non-secret values прямо в config.
- `headerNames` объявляет secret headers; их values собираются prompt-ом и хранятся в encrypted credential vault, never in `config.json`.

См. [custom header authentication](authentication#custom-header-authentication) для precedence rules.

## Connection Testing

Когда source добавлен (и когда вы повторно test его из detail view), Nessy Desktop выполняет real handshake:

1. Connects using configured transport — для stdio это запускает actual process.
2. Runs `tools/list` against server; server, который не может enumerate tools, fails check.
3. Validates every tool's input schema. Property names must match `^[a-zA-Z0-9_.-]{1,64}$` — constraint, enforced by Anthropic API — offending tools reported by name.

Один tool, который приложение не может предложить, не валит server. Tool, определение которого не имеет формы MCP tool (например, input schema, корень которой не typed `object`), или input schema которого не компилируется как JSON Schema, пропускается с указанием причины, а остальные tools server продолжают работать. Так же пропускается tool, имя которого повторяет уже перечисленное server-ом: побеждает первый tool с этим именем, который приложение оставило, а имена, отличающиеся только регистром букв, — это два разных tool. Test при этом проходит, а `source_test` агента выводит пропущенные tools строкой-предупреждением; в sessions Pi, Codex и Claude Code одинаково `/mcp` называет их в строке подключённого server, а модели сообщается, какие tools исключены и почему. Строка server в панели MCP тоже помечена «Часть инструментов пропущена»; наведите курсор на метку, чтобы прочитать тот же список.

Result записывается на source как connection status: `connected`, `needs_auth`, `failed`, `untested` или `local_disabled`. HTTP responses 401/403 map to `needs_auth`, чтобы UI мог предложить re-authentication вместо generic failure.

Stdio tests получают startup budget около 30 seconds, с watchdog, который отличает "still installing dependencies" (stderr activity resets timer) от "hung" (silence). Cold `npx`/`uvx` first runs, скачивающие packages, therefore fine.

## Multiple Servers

Workspace может хранить сколько угодно MCP sources. Tools разделены slug:

```
mcp__linear__create_issue
mcp__exa-search__web_search
mcp__sqlite__query
```

Каждая session включает subset source slugs, поэтому connecting many servers не заставляет каждый tool попадать в каждый conversation. Сами соединения общие per workspace: сервер, который используют несколько чатов, работает как ОДИН процесс и живёт keep-alive; завершение одного чата снимает только его claim и никогда не трогает сервер, который ещё использует другой чат (или Sources browser). По умолчанию включённые серверы подключаются при старте сессии, так что их tools готовы до первого сообщения; `sources.connectOnStartup: false` в `config.json` (или managed-ключ `connectSourcesOnStartup`) возвращает lazy-подключение по первой необходимости. Но держите enabled set per session lean — giant tool list замедляет responses и даёт model больше способов выбрать wrong tool.

## Refreshing a Connection

Если tool list server изменился или connection stale:

- Откройте source в sidebar и rerun connection test, либо попросите агента test source — у него есть built-in tool `source_test`.
- Toggling source off and on или restart app re-establishes all MCP connections from scratch.

## Troubleshooting

#### Remote server won't connect

- Confirm URL, including path — missing `/mcp` suffix is the most common cause.
- Проверьте, нужна ли endpoint authentication и совпадает ли `authType`.
- Test reachability from terminal (`curl -i <url>`) to separate network problems from protocol problems.
- Corporate proxies and VPNs can block streaming responses; см. [network proxy settings](../../reference/config/network-proxy).

#### Stdio server won't start

- `Command not found` значит executable не на PATH, который видит app — используйте absolute path или установите dependency (`which npx`, `which uvx`).
- Run exact command from terminal; stderr обычно называет real problem. Connection test тоже показывает tail stderr в error message.
- Если test сообщает, что initialize handshake never completed, проверьте, что server говорит MCP newline-delimited JSON-RPC on stdout. Servers, ported from LSP-style tooling and emitting `Content-Length` framing, produce exactly this symptom.
- Убедитесь, что command starts a server, а не просто installs one — package installer, exiting after download, hit startup ceiling.
- Если every stdio source shows `local_disabled`, local MCP servers switched off for that workspace.

#### Tools not appearing in sessions

- Откройте source и проверьте connection status и last error.
- Confirm source enabled and selected for the session in question.
- Если test reports invalid property names, tool schemas server нужно исправить before tools exposed.

#### Authentication keeps failing

- Проверьте, что token/key current и имеет scopes, которые server demands.
- Убедитесь, что `authType` соответствует expectation server — bearer-token server, declared as `oauth`, будет loop through discovery and fail.
- Пройдите список [authentication troubleshooting](authentication#troubleshooting).

## Best Practices

- **Name sources for their job.** `github-issues` или `company-wiki` читаются лучше, чем `server1`, в tool names и session context.
- **Write a tagline.** Он показывается в source list и входит в то, что агент читает, выбирая source для task.
- **Fill in `guide.md`.** Несколько sentences о назначении server и quirks окупаются в каждой session.
- **Add an icon.** URL, emoji или `icon.svg` в source folder помогает быстро увидеть source.
- **Connect what you need, not what you can.** Fewer, well-described sources лучше exhaustive catalog.

## Дальше

- [Authentication](authentication) — OAuth flows, bearer tokens, header-based auth и credential storage.
- [Sources overview](../overview) — как MCP servers стоят рядом с API sources и local folders.
