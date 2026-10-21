# Connecting MCP Servers

This page walks through adding MCP servers as sources — remote endpoints over HTTP, local subprocess servers over stdio, and how to diagnose a connection that refuses to come up.

::: tip Let the agent do the setup
The fastest path is the **Add Source** action in the sidebar. Describe what you want — "connect the Exa search MCP server", "add the SQLite server for ~/data/app.db" — and the agent writes the source config, runs the connection test, and walks you through authentication if the server needs it.
:::

## Configuration Schema

Every MCP source follows the same shape (see the [overview](overview#configuration-fields) for the full field reference):

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

Source configs live at `~/.nessy-agent/workspaces/<workspace-id>/sources/<slug>/config.json`. You can edit them by hand; the app watches the folder and picks up changes.

## Remote Servers (HTTP)

Set `transport` to `"http"` (or omit it — HTTP is the default) and provide the full endpoint URL:

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

Two details that trip people up:

- The URL is used verbatim (minus trailing slashes). If the server lives at `/mcp` or `/v1/mcp`, that path must be part of `mcp.url`.
- `authType` must match what the server expects — `"oauth"`, `"bearer"`, or `"none"`. The [authentication guide](authentication) covers each mode.

Legacy Server-Sent Events endpoints can be declared with `"transport": "sse"`; the config is passed through to the agent runtime unchanged. New integrations should use Streamable HTTP.

## Local Servers (Stdio)

Set `transport` to `"stdio"` and give the command that starts the server. Nessy Desktop spawns and supervises the process itself.

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

If the server reads configuration from environment variables, add an `env` block:

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

The spawned process inherits your environment with common secret variables stripped out; `env` entries are applied on top. Details in the [overview](overview#local-process-safety).

::: warning Stdio servers run as you
A local MCP server is an ordinary process with your user's filesystem and network access. Vet the package or script before wiring it into a workspace, and prefer pinned versions over floating `latest` tags.
:::

## Custom Headers

Remote servers sometimes want extra headers — an org identifier, an API version, or a non-standard auth header:

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

- `headers` holds static, non-secret values written directly in the config.
- `headerNames` declares secret headers; their values are collected via a prompt and kept in the encrypted credential vault, never in `config.json`.

See [custom header authentication](authentication#custom-header-authentication) for precedence rules.

## Connection Testing

When a source is added (and whenever you re-test it from the source's detail view), Nessy Desktop performs a real handshake:

1. Connects using the configured transport — for stdio, this spawns the actual process.
2. Runs `tools/list` against the server; a server that cannot enumerate tools fails the check.
3. Validates every tool's input schema. Property names must match `^[a-zA-Z0-9_.-]{1,64}$` — a constraint enforced by the Anthropic API — and offending tools are reported by name.

A single tool the app cannot offer does not fail the server. A tool whose definition does not have the MCP tool shape (for example an input schema whose root is not typed `object`), or whose input schema does not compile as JSON Schema, is skipped with its reason, and the server's other tools keep working. So is a tool whose name repeats one the server already listed: the first tool of that name that the app keeps wins, and names that differ only in letter case are two tools. The test still passes and the agent's `source_test` prints the skipped tools as a warning line; on Pi, Codex and Claude Code sessions alike `/mcp` names them on the server's connected line, and the model is told which tools were left out and why. The server's row in the MCP panel is marked "Some tools skipped" too; hover the marker to read the same list.

The result is recorded on the source as a connection status: `connected`, `needs_auth`, `failed`, `untested`, or `local_disabled`. HTTP responses of 401/403 map to `needs_auth` so the UI can offer re-authentication instead of a generic failure.

Stdio tests get a startup budget of about 30 seconds, with a watchdog that distinguishes "still installing dependencies" (stderr activity resets the timer) from "hung" (silence). Cold `npx`/`uvx` first runs that download packages are therefore fine.

## Multiple Servers

A workspace can hold as many MCP sources as you like. Tools stay separated by slug:

```
mcp__linear__create_issue
mcp__exa-search__web_search
mcp__sqlite__query
```

Each session enables a subset of source slugs, so connecting many servers does not force every tool into every conversation. Connections themselves are shared per workspace: a server used by several chats runs as ONE process, kept alive; ending one chat only releases that chat's claim, never a server another chat (or the Sources browser) still uses. By default, enabled servers are connected when a session starts, so their tools are ready before the first message; setting `sources.connectOnStartup: false` in `config.json` (or the managed-policy key `connectSourcesOnStartup`) restores lazy connect-on-first-need. Still, keep the enabled set per session lean — a giant tool list slows responses and gives the model more ways to pick the wrong tool.

## Refreshing a Connection

If a server's tool list changes or the connection goes stale:

- Open the source in the sidebar and re-run its connection test, or ask the agent to test the source — it has a built-in `source_test` tool.
- Toggling the source off and on, or restarting the app, re-establishes all MCP connections from scratch.

## Troubleshooting

#### Remote server won't connect

- Confirm the URL, including the path — a missing `/mcp` suffix is the most common cause.
- Check whether the endpoint needs authentication and whether `authType` matches.
- Test reachability from a terminal (`curl -i <url>`) to separate network problems from protocol problems.
- Corporate proxies and VPNs can block streaming responses; see [network proxy settings](../../reference/config/network-proxy).

#### Stdio server won't start

- `Command not found` means the executable isn't on the PATH the app sees — use an absolute path, or install the dependency (`which npx`, `which uvx`).
- Run the exact command from a terminal; its stderr usually names the real problem. The connection test also surfaces the tail of stderr in its error message.
- If the test reports that the initialize handshake never completed, verify the server speaks MCP's newline-delimited JSON-RPC on stdout. Servers ported from LSP-style tooling that emit `Content-Length` framing produce exactly this symptom.
- Make sure the command starts a server rather than just installing one — a package installer that exits after downloading will hit the startup ceiling.
- If every stdio source shows `local_disabled`, local MCP servers are switched off for that workspace.

#### Tools not appearing in sessions

- Open the source and check its connection status and last error.
- Confirm the source is enabled and selected for the session in question.
- If the test reports invalid property names, the server's tool schemas need fixing before those tools can be exposed.

#### Authentication keeps failing

- Verify the token or key is current and has the scopes the server demands.
- Make sure `authType` matches the server's expectation — a bearer-token server declared as `oauth` will loop through discovery and fail.
- Walk through the [authentication troubleshooting](authentication#troubleshooting) list.

## Best Practices

- **Name sources for their job.** `github-issues` or `company-wiki` reads better than `server1` in tool names and session context.
- **Write a tagline.** It shows up in the source list and is part of what the agent reads when deciding which source fits a task.
- **Fill in `guide.md`.** A few sentences about what the server is for and any quirks pays off every session.
- **Add an icon.** A URL, an emoji, or an `icon.svg` dropped into the source folder makes the source easy to spot.
- **Connect what you need, not what you can.** Fewer, well-described sources beat an exhaustive catalog.

## Next Steps

- [Authentication](authentication) — OAuth flows, bearer tokens, header-based auth, and credential storage.
- [Sources overview](../overview) — how MCP servers sit alongside API sources and local folders.
