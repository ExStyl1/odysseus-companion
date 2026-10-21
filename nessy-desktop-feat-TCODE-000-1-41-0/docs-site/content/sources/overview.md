# Sources Overview

Sources connect sessions to the outside world. A source can be an MCP server, a REST API, or a folder on your machine — each one contributes tools the agent may call while it works. When a session looks up an issue in your tracker or queries an internal service, a source is doing the work underneath.

::: info
Working inside a single project directory? Prefer the [working directory](../core-concepts/working-directory). Built-in tools such as `Read`, `Write`, and `Bash` already operate there with no source setup. Sources earn their keep when you need external services or several separate file locations.
:::

::: tip
The quickest setup path is a plain chat request:

- "Hook up our Linear MCP server"
- "Create a source for the internal metrics API"
- "Register my notes vault as a source"

The agent writes the config, walks you through credentials, and verifies the connection for you.
:::

## Source Types

Nessy Desktop supports three kinds of source:

- **[MCP servers](mcp-servers/overview)** — services that speak the Model Context Protocol and ship their own tool set. Remote HTTP/SSE endpoints and local stdio subprocesses both work.
- **[API sources](apis/overview)** — any REST service. You supply a base URL and auth details; the agent gets a flexible HTTP tool for that API.
- **[Local folders](local-filesystems)** — named bookmarks to directories outside the working directory, with optional usage notes.

Every source type is available regardless of which LLM connection a session uses — Nessy Gateway, a Claude Pro/Max subscription, an Anthropic API key, a ChatGPT subscription (ChatGPT Plus (Pi) or ChatGPT (Codex)), or a custom endpoint.

## Where Sources Live

Each source is a folder inside the workspace configuration directory:

```
~/.nessy-agent/workspaces/{workspace-id}/sources/{source-slug}/
```

A source folder may contain:

| File | Required | Purpose |
| ------------------ | -------- | ------------------------------------------------------------ |
| `config.json` | Yes | Connection settings, auth type, and status tracking |
| `guide.md` | No | Agent-facing notes on how to use the source well |
| `permissions.json` | No | Extra Plan-mode allowances scoped to this source |
| `icon.*` | No | Cached icon file (`.svg`, `.png`, `.jpg`, `.ico`, `.webp`, …) |

### config.json

The configuration file describes how to reach the service and tracks connection state:

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

The most important fields:

| Field | Meaning |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| `type` | One of `mcp`, `api`, or `local`; selects which config block (`mcp`, `api`, `local`) is read |
| `name` / `slug` | Display name and URL-safe identifier; the slug is also the folder name and the tool-name prefix |
| `enabled` | Whether the source is active for sessions |
| `provider` | Freeform service label (`"linear"`, `"google"`, `"my-internal-api"`); `"google"` triggers Google OAuth handling |
| `icon` | Emoji or icon URL (see below) |
| `tagline` | One-line summary shown to the agent; when omitted, the first paragraph of `guide.md` is used |
| `isAuthenticated` | Whether a credential is stored for this source |
| `connectionStatus` | One of `connected`, `needs_auth`, `failed`, `untested`, `local_disabled` |
| `connectionError` | Failure detail when the status is `failed` or `needs_auth` |

### Icons

Icon resolution follows the `icon` value in `config.json`:

| `icon` value | Behavior |
| ---------------------- | ---------------------------------------------------------------------------------- |
| Emoji (e.g. `"🗂️"`) | Rendered as-is |
| URL (`"https://…"`) | Downloaded into the source folder and served from the local cache |
| Not set | An existing `icon.*` file in the folder is picked up automatically; when the source is created, Nessy Desktop also tries to fetch the service's logo |

Inline SVG markup and relative file paths are rejected as icon values — drop a real `icon.svg` or `icon.png` into the source folder instead.

### guide.md

The guide is the agent's manual for the source. Write down what the source covers, house conventions, and anything that saves a wasted call:

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

Recognized section headings are `Scope`, `Guidelines`, `Context`, and `API Notes`; everything else is passed through untouched.

::: tip
For API sources the guide is effectively mandatory: the agent is required to read `sources/{slug}/guide.md` before its first call to that source's tool in a session. A precise guide — endpoints, required parameters, quirks — directly improves every request that follows.
:::

## Enabling and Disabling

Sources can be switched off without deleting anything:

1. **In the app** — toggle the source in the workspace's source list.
2. **On disk** — set `"enabled": false` in `config.json`.

A disabled source keeps its configuration and credentials but contributes no tools. Separately, a source whose auth type requires credentials stays inactive until authentication completes — check `connectionStatus` when a source seems missing.

## Source Lifecycle

1. **Create** — the folder and `config.json` are written (by the agent, the app, or you).
2. **Authenticate** — credentials go into the encrypted credential store, never into `config.json`.
3. **Validate** — the connection is tested and the status recorded.
4. **Use** — sessions call the source's tools.
5. **Disable or remove** — toggle it off, or delete the source folder to remove it entirely.

See [authentication](mcp-servers/authentication) for the credential flows in detail.

## Plan Mode and Sources

In Plan mode ([permissions](../core-concepts/permissions)) sources default to a read-only posture: API tools may only issue `GET` requests, and MCP tools must match an allowlist. A per-source `permissions.json` extends the defaults — rules are additive and can only grant more, never less:

```json
{
  "allowedMcpPatterns": [
    { "pattern": "list", "comment": "Listing operations" },
    { "pattern": "get", "comment": "Single-record reads" },
    { "pattern": "search", "comment": "Search operations" }
  ]
}
```

Patterns from a source's own `permissions.json` are automatically prefixed with `mcp__{slug}__`, so a rule like `list` only ever matches that source's tools. API endpoint rules (`allowedApiEndpoints`) are supported in the same file, and apply only to that source's own API tool. A source's file can only grant for that source's own tools: bash patterns (`allowedBashPatterns`), write paths (`allowedWritePaths`) and an allow rule for any other tool are ignored there, because they would widen the whole session. Put those in the workspace's permissions (**Settings → Permissions**). The source file's deny rules still apply.

## Next Steps

- [MCP servers](mcp-servers/overview) — connect services with native MCP support
- [API sources](apis/overview) — wrap any REST API in a tool
- [Local folders](local-filesystems) — bookmark directories on your machine
- [Authentication](mcp-servers/authentication) — OAuth, tokens, and credential storage
