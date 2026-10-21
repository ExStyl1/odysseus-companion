# Обзор источников

Sources связывают sessions с внешним миром. Source может быть MCP server, REST API или папкой на вашей машине — каждый добавляет tools, которые агент может вызывать во время работы. Когда session ищет issue в tracker или запрашивает internal service, под капотом работает source.

::: info
Работаете внутри одной project directory? Предпочитайте [working directory](../core-concepts/working-directory). Built-in tools вроде `Read`, `Write` и `Bash` уже работают там без настройки source. Sources особенно полезны, когда нужны external services или несколько отдельных file locations.
:::

::: tip
Самый быстрый путь настройки — обычный chat request:

- "Hook up our Linear MCP server"
- "Create a source for the internal metrics API"
- "Register my notes vault as a source"

Агент напишет config, проведёт через credentials и проверит connection за вас.
:::

## Типы источников

Nessy Desktop поддерживает три вида source:

- **[MCP servers](mcp-servers/overview)** — services, говорящие на Model Context Protocol и поставляющие собственный tool set. Работают remote HTTP/SSE endpoints и local stdio subprocesses.
- **[API sources](apis/overview)** — любой REST service. Вы задаёте base URL и auth details; агент получает flexible HTTP tool для этого API.
- **[Local folders](local-filesystems)** — named bookmarks к directories вне working directory, с optional usage notes.

Каждый source type доступен независимо от LLM connection, которую использует session — Nessy Gateway, Claude Pro/Max subscription, Anthropic API key, подписка ChatGPT (ChatGPT Plus (Pi) или ChatGPT (Codex)) или custom endpoint.

## Где живут sources

Каждый source — folder внутри workspace configuration directory:

```
~/.nessy-agent/workspaces/{workspace-id}/sources/{source-slug}/
```

Source folder может содержать:

| File | Required | Purpose |
| ---- | -------- | ------- |
| `config.json` | Yes | Connection settings, auth type и status tracking |
| `guide.md` | No | Agent-facing notes о правильном использовании source |
| `permissions.json` | No | Extra Plan-mode allowances, scoped к этому source |
| `icon.*` | No | Cached icon file (`.svg`, `.png`, `.jpg`, `.ico`, `.webp`, …) |

### config.json

Configuration file описывает, как достучаться до service, и отслеживает connection state:

```json
{
  "id": "linear_1a2b3c4d",
  "type": "mcp",
  "name": "Linear",
  "slug": "linear",
  "enabled": true,
  "provider": "linear",
  "mcp": {
    "url": "https://mcp.linear.app",
    "authType": "oauth"
  },
  "isAuthenticated": true,
  "connectionStatus": "connected"
}
```

Самые важные fields:

| Field | Meaning |
| ----- | ------- |
| `type` | Один из `mcp`, `api` или `local`; выбирает, какой config block (`mcp`, `api`, `local`) читается |
| `name` / `slug` | Display name и URL-safe identifier; slug также является folder name и tool-name prefix |
| `enabled` | Активен ли source для sessions |
| `provider` | Freeform service label (`"linear"`, `"google"`, `"my-internal-api"`); `"google"` включает Google OAuth handling |
| `icon` | Emoji или icon URL (см. ниже) |
| `tagline` | One-line summary для агента; если omitted, используется первый paragraph из `guide.md` |
| `isAuthenticated` | Сохранён ли credential для этого source |
| `connectionStatus` | Один из `connected`, `needs_auth`, `failed`, `untested`, `local_disabled` |
| `connectionError` | Failure detail, когда status `failed` или `needs_auth` |

### Icons

Icon resolution следует значению `icon` в `config.json`:

| `icon` value | Behavior |
| ------------ | -------- |
| Emoji (e.g. `"🗂️"`) | Rendered as-is |
| URL (`"https://…"`) | Downloaded into the source folder and served from the local cache |
| Not set | Existing `icon.*` file в folder подхватывается автоматически; при создании source Nessy Desktop также пытается fetch service logo |

Inline SVG markup и relative file paths отклоняются как icon values — положите настоящий `icon.svg` или `icon.png` в source folder.

### guide.md

Guide — manual source для агента. Запишите, что покрывает source, house conventions и всё, что экономит лишний call:

```markdown
# Linear

Issue tracking for the mobile team.

## Scope

The "Mobile" project, its issues, and sprint boards.

## Guidelines

- Search for an existing issue before filing a new one
- Follow the team's label taxonomy
- Confirm the sprint assignment before moving anything
```

Recognized section headings: `Scope`, `Guidelines`, `Context` и `API Notes`; всё остальное передаётся как есть.

::: tip
Для API sources guide фактически обязателен: агент должен прочитать `sources/{slug}/guide.md` перед первым вызовом tool этого source в session. Точный guide — endpoints, required parameters, quirks — напрямую улучшает каждый следующий request.
:::

## Enabling and Disabling

Sources можно выключать без удаления:

1. **In the app** — toggle source в source list workspace.
2. **On disk** — задайте `"enabled": false` в `config.json`.

Disabled source сохраняет configuration и credentials, но не добавляет tools. Отдельно source, чей auth type требует credentials, остаётся inactive до завершения authentication — проверяйте `connectionStatus`, если source кажется missing.

## Source Lifecycle

1. **Create** — folder и `config.json` записываются (агентом, app или вами).
2. **Authenticate** — credentials попадают в encrypted credential store, никогда в `config.json`.
3. **Validate** — connection проверяется, status записывается.
4. **Use** — sessions вызывают tools source.
5. **Disable or remove** — toggle off или удалите source folder, чтобы убрать source полностью.

Подробно credential flows описаны в [authentication](mcp-servers/authentication).

## Plan Mode and Sources

В Plan mode ([permissions](../core-concepts/permissions)) sources по умолчанию read-only: API tools могут выполнять только `GET` requests, а MCP tools должны match allowlist. Per-source `permissions.json` расширяет defaults — rules additive и могут только давать больше, не меньше:

```json
{
  "allowedMcpPatterns": [
    { "pattern": "list", "comment": "Listing operations" },
    { "pattern": "get", "comment": "Single-record reads" },
    { "pattern": "search", "comment": "Search operations" }
  ]
}
```

Patterns из собственного `permissions.json` source автоматически получают prefix `mcp__{slug}__`, поэтому rule вроде `list` match только tools этого source. API endpoint rules (`allowedApiEndpoints`) поддерживаются в том же file и действуют только для собственного API tool этого source. File источника может разрешать только собственные tools этого источника: bash patterns (`allowedBashPatterns`), пути записи (`allowedWritePaths`) и allow rule для любого другого tool в нём игнорируются, потому что расширили бы права всей session. Задавайте их в permissions workspace (**Settings → Permissions**). Запреты из file источника по-прежнему действуют.

## Дальше

- [MCP servers](mcp-servers/overview) — подключение services с native MCP support
- [API sources](apis/overview) — обернуть любой REST API в tool
- [Local folders](local-filesystems) — bookmark directories на вашей машине
- [Authentication](mcp-servers/authentication) — OAuth, tokens и credential storage
