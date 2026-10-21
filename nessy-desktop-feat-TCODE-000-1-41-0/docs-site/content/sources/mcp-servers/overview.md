# MCP Servers

Model Context Protocol (MCP) is an open standard for exposing tools to AI agents. Nessy Desktop speaks MCP natively: point a source at an MCP server — remote or local — and every tool that server publishes becomes available to the agent in your sessions. Issue trackers, search engines, databases, and internal services increasingly ship an MCP endpoint, and anything that runs as a local process can be wrapped in one.

## What a Connection Gives You

Adding an MCP source teaches the agent a new set of actions. A Linear connection lets it search and update issues mid-conversation; a database server lets it run queries; a filesystem server lets it browse a directory tree. No glue code is involved — the server describes its tools, and the agent picks the right one from context.

A few properties worth knowing up front:

- **Namespaced tools.** Each tool is registered as `mcp__<slug>__<toolName>`, where the slug is derived from the source name. Tools from different servers never collide.
- **Names are normalized to what a tool name can hold.** Only letters, digits, `-` and `_` survive in that slug, so a server name carrying anything else — a space, a dot — is converted rather than left to break its own tools: `my server.v2` becomes `my_server_v2`. A name with no usable character at all (an entirely Cyrillic or Japanese one) gets a stable generated `server-<short code>` slug instead of an empty one. A [permission rule](../../core-concepts/permissions) must be written against that converted slug, not against the raw string you typed — the **MCP servers** panel keeps showing the name as you wrote it. For an ordinary name the slug follows from the rule above (`my server.v2` → `my_server_v2`); a generated `server-<short code>` slug is visible in the server's own tool names, `mcp__server-<short code>__<toolName>`, the first time one of its tools asks for permission. In the rare case a name still cannot form tool names, the server is listed with **"This server's name can't be used in tool names; its tools are unavailable"** rather than appearing healthy with an empty tool list.
- **Fetched on demand.** A server's tool descriptions are not all spelled out at the start of every message. The agent receives a searchable index and pulls in a tool's full description at the moment it decides to use one, which keeps a large catalog from consuming the conversation before it starts. Nothing becomes unavailable — every connected tool stays reachable, and one that is needed arrives before it is called. On Pi a tool the agent loads is callable from its next step in the same request (not within the batch of calls that loaded it), and it stays loaded when the catalog is refreshed, unless the tool itself changed (its description, inputs or source), in which case the agent loads it again. Pin a server's tools with `alwaysLoad` when they must be present upfront; that promise is unconditional. Pinning every tool of one server does not switch the mechanism off for the rest, and the full off switch is its own setting rather than a side effect of pinning.
- **Shared pool.** MCP tools live in the same source pool as [API sources](../apis/overview) and [local folders](../local-filesystems). Each workspace runs ONE shared connection per server: however many chats use it, the server is spawned once and kept alive, and closing a chat never restarts a server another chat still uses. A session enables specific source slugs and sees only its own set — another chat's servers never appear in its tool list, and its tool responses are always saved under its own session.
- **Dynamic catalogs.** `tools/list_changed`, `resources/list_changed`, and `prompts/list_changed` notifications refresh one connection serially and swap validated routes atomically. A failed refresh keeps the last good catalog and reports degraded health; a withdrawn tool is unavailable on the next Pi turn.
- **Session-bound channels.** Bounded `notifications/claude/channel` events are delivered only to sessions holding the matching live connection lease, wrapped in a `<channel source="...">` tag whose attributes carry the event's routing keys. A notification can wake an idle session that holds the lease, and several arriving during a turn are delivered together as one group on the next turn — but it never creates a session, and one arriving before your first message is held as context for that message instead of starting a turn of its own. Channel push is off until you enable it in Settings -> Permissions.
- **Scoped secrets.** Credentials for user-created sources are stored per workspace and per source, encrypted on disk. Removing a source removes its secrets. (Plugin-owned servers differ: their credential is global to the server — see below.)

## Plugin-Provided MCP Servers

[Plugins](../../plugins/overview) can contribute MCP server descriptors. A plugin's servers — remote and stdio alike — belong to the plugin: they run from the installed plugin cache on the plugin's own runtime path, they never become source folders, and they never add slugs to the source list. Sources hold **user-created connections only**.

A few things follow from that ownership:

- **One credential per server, everywhere.** A plugin server that needs OAuth or a bearer token holds a single global credential, keyed by plugin and server name, in the encrypted vault. Sign in once and every workspace uses that grant — plugin servers are never duplicated per workspace and never ask you to authenticate the same server twice. (User-created sources keep their per-workspace scoping.)
- **One panel for every server.** The **MCP servers** panel lists all MCP servers together — plugin-owned and user-created — with each row's origin, transport, and auth state. Plugin rows carry a per-server enable switch, so one server out of a plugin's ten can be turned off without touching the rest; a plugin's detail page shows the same rows filtered to that plugin.
- **A stable, plugin-qualified wire name.** A plugin server's tools are namespaced by the plugin itself, not just the server name: the wire name is always `plugin_<pluginId>_<serverName>`, never the short `<serverName>` form a built-in or user-created source gets — even when no other server happens to share that name. Installing a new plugin can therefore never take over, move, or collide with a name a built-in or your own server already owns.
- **One copy per declared endpoint.** When two plugins declare a server at the same address (or the same local command) with the same declared credentials, only one connects; the other is listed with a **"Duplicates another server's endpoint; only one copy runs"** reason instead of starting a redundant process. Declared credentials are part of that identity, so two plugins holding different credentials to the same address count as different servers, and both run.
- **A stood-down server names what went quiet with it.** When a plugin's server is not started — as a duplicate of a built-in or of another plugin's endpoint — that plugin's own hooks and skills that referenced it stop working too, because they now point at something that will never run. The server's detail page — the page its row opens — says which ones: **"Parts of this plugin that used this server are inactive:"** followed by their names, so the reason covers the whole effect rather than the server alone. (Agents a plugin ships are not listed there yet.)

Enabled servers connect when a session starts (the default). Setting `sources.connectOnStartup: false` in `config.json` — or the managed-policy key `connectSourcesOnStartup` — restores connect-on-first-use. A server still awaiting sign-in, or one whose startup connection failed, is listed in a non-blocking notice at session start; signing in from it never interrupts the conversation.

Stdio plugin servers follow stricter rules than user-created stdio sources: the command is resolved inside the verified plugin bundle (absolute, never a PATH lookup), and the process does not inherit your environment. Enabling the plugin controls whether its servers are visible to the session.

Disabling or uninstalling a plugin withdraws its catalog from the next turn,
stops plugin-owned processes, and drains active leases before immutable plugin
bytes are released. Uninstalling also purges the plugin's credential slots.

Claude Desktop `.mcpb` and `.dxt` archives are installed as plugins, not
Sources. Configure their declared fields on the plugin page; sensitive values
stay in the encrypted credential store, and the packaged server joins the same
workspace MCP pool after configuration and activation.

## Built-In MCP Servers

Nessy ships a catalog of the tool servers the `dp` CLI provides — Jira, GitLab,
merge requests, Sage, Wiki, code search, Allure, Kubernetes and the rest of
`dp ai mcp`. They appear in **Sources → MCPs** alongside your own connections and
your plugins', as ordinary MCP sources with a **Built-in** origin badge.

What makes them worth knowing about:

- **No separate credential, but `dp` must be signed in.** Each one runs as
  `dp ai mcp <subcommand>` and authenticates from `dp`'s own session — Nessy
  passes no token and never reads the dp credentials file, so there is nothing
  to configure. If `dp` is signed out, an enabled built-in server is withheld
  and listed in the session-start notice with a one-click **Sign in**; signing
  in (from the notice, or by running `dp auth login` yourself) reconnects it
  automatically, no restart needed.
- **The binary is yours, not ours.** Nessy does not bundle `dp`; it resolves the
  one already on your `PATH`. A machine without `dp` sees the set reported as
  unavailable with a diagnostic naming it, rather than switches that cannot work.
- **Everything is off until you switch it on.** No built-in server starts
  unasked, on any machine, and a release that adds a new one leaves it off too.
  The per-server choice is stored in `config.json` under `builtinDpMcpServers`.
- **A server you configured yourself always wins.** If you have already defined a
  server under the same name — or one running the same `dp ai mcp` subcommand —
  the built-in stands down rather than shadowing it.
- **A plugin copy of an enabled built-in stands down.** If an installed plugin
  bundles its own copy of a server that runs the same `dp ai mcp` subcommand as
  a built-in you have switched on, the plugin's copy is not started — it is
  listed with a **"Duplicates a built-in server; the built-in is used"** reason
  instead of running twice, together with the plugin's own hooks and skills that
  referenced it and are therefore inactive. Turning the built-in off lets the
  plugin's copy run.
- **Runs quiet and non-interactive.** dp's own update-warning banner and any
  interactive login prompt are suppressed for these subprocesses, so a
  signed-out `dp` fails straight into the sign-in notice instead of printing
  warnings on stdout or trying to open a browser on its own.

## Source Anatomy

Every source is a folder inside your workspace:

```
~/.nessy-agent/workspaces/<workspace-id>/sources/<slug>/
├── config.json   # connection settings
└── guide.md      # usage notes the agent reads before using the source
```

A typical `config.json` for a remote MCP server:

```json
{
  "id": "linear_a1b2c3d4",
  "name": "Linear",
  "slug": "linear",
  "enabled": true,
  "provider": "linear",
  "type": "mcp",
  "tagline": "Issue tracking and project management",
  "icon": "https://linear.app/favicon.ico",
  "mcp": {
    "transport": "http",
    "url": "https://mcp.linear.app/mcp",
    "authType": "oauth"
  }
}
```

When the app creates a source for you, `id`, `slug`, and `enabled` are filled in automatically — the slug comes from the name, and duplicate names get a numeric suffix.

### Configuration Fields

| Field | Required | Purpose |
| --- | --- | --- |
| `type` | Yes | `"mcp"` selects the MCP connection type |
| `name` | Yes | Display label; also the basis for the generated slug and tool prefix |
| `provider` | Yes | Freeform label used for grouping and provider-specific behavior |
| `tagline` | No | One-line summary shown in the UI and given to the agent; falls back to the first paragraph of `guide.md` |
| `icon` | No | Emoji or image URL; if unset, an `icon.svg` or `icon.png` placed in the source folder is picked up automatically |
| `mcp.transport` | No | `"http"` (default), `"sse"`, or `"stdio"` |
| `mcp.url` | HTTP/SSE | Full endpoint URL of the remote server |
| `mcp.authType` | HTTP/SSE | `"oauth"`, `"bearer"`, or `"none"` — see [Authentication](authentication) |
| `mcp.command` | stdio | Executable that launches the local server |
| `mcp.args` | No | Argument list for the stdio command |
| `mcp.env` | No | Extra environment variables for the stdio process |
| `mcp.headers` | No | Static, non-secret headers sent with every HTTP/SSE request |
| `mcp.headerNames` | No | Names of secret headers whose values come from the credential vault |

## Transport Types

### HTTP (Remote Servers)

The default transport. The app connects over Streamable HTTP and verifies the server by listing its tools:

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

Trailing slashes on the URL are stripped, but the path is otherwise used exactly as written — nothing is appended, so include the server's full endpoint path (often ending in `/mcp`).

A `"sse"` transport value is accepted for older Server-Sent Events servers and is handed through to the agent runtime as-is. Prefer `"http"` for anything modern; the built-in connection test always speaks Streamable HTTP.

### Stdio (Local Servers)

For servers that run as a subprocess on your machine:

```json
{
  "type": "mcp",
  "name": "SQLite",
  "tagline": "Query a local SQLite database",
  "mcp": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-sqlite", "/path/to/data.db"]
  }
}
```

Common launch patterns:

| Pattern | Config |
| --- | --- |
| npm package | `"command": "npx", "args": ["-y", "some-mcp-package"]` |
| Node script | `"command": "node", "args": ["/Users/me/mcp/server.js"]` |
| Python script | `"command": "python", "args": ["/Users/me/mcp/server.py"]` |
| uv-managed tool | `"command": "uvx", "args": ["some-mcp-tool"]` |
| Compiled binary | `"command": "/usr/local/bin/my-mcp-server"` |

Stdio servers need no network authentication — see [stdio credentials](authentication#local-servers-stdio) for how to pass secrets to them safely.

## Local Process Safety

Because stdio servers are arbitrary programs, Nessy Desktop constrains what they inherit:

- **Filtered environment.** The subprocess receives your normal environment minus a blocklist of high-value secrets — `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, AWS access keys and session tokens, `GITHUB_TOKEN`, `GH_TOKEN`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `STRIPE_SECRET_KEY`, and `NPM_TOKEN`. Anything you set explicitly in `mcp.env` is passed through on top of the filtered base.
- **Workspace kill switch.** Each workspace has a `localMcpServers.enabled` setting. When it is off, stdio sources show a `local_disabled` status and only network-based servers run. The `NESSY_LOCAL_MCP_ENABLED` environment variable overrides the default — see [environment variables](../../reference/config/environment-variables).

Only connect stdio servers whose code you trust: they execute with your user account's permissions.

## Resources and Prompts

Besides tools, an MCP server can publish two other things, and the agent can use both.

**Resources** are documents or records the server addresses by a URI — a file, an issue, a page — plus **templates**: URI patterns with `{placeholders}` the agent fills in to name a resource.

- On Claude Code and Codex the agent reads them with the runtime's own resource tools. On Pi, Nessy Desktop supplies `list_mcp_resources` and `read_mcp_resource`.
- A listing follows a server's pages to the end and includes its templates. A server that does not offer templates simply lists none.
- A resource is read back as text. A binary resource is saved to the session's downloads folder and named in the reply, and a very large one is handled like any large tool result rather than flooding the conversation.

**Prompts** are reusable instructions or playbooks a server publishes, with arguments. No runtime lets the agent fetch them on its own, so Nessy Desktop gives every session two read-only tools, on Pi, Claude Code and Codex alike:

- `source_list_prompts` lists the prompts a source offers and their arguments.
- `source_get_prompt` returns one prompt with its arguments filled in, as text.

The agent uses them when you ask it to run one of a source's playbooks, or when the source's guide points at one. A prompt is only text from the server: it grants no permissions and does not override your instructions. A source with no prompts, an API source, or a server that is not connected gets a plain answer saying so. Both tools need no approval in any mode, because they only read.

## Seeing What Is Actually Connected

The MCP panel used to show what your configuration *said*, which is a different
question from what the session *has*. It now carries the live pool status — the
same inventory `/mcp` prints — so a server that failed to connect is marked as
failed on the row, with the reason, instead of looking identical to a healthy
one. A server that is connected but exposes no tools is called out too, because
that reads as "broken" and usually is not. On Pi, Codex and Claude Code sessions
alike a connected server that had to skip some of its tools is marked "Some tools
skipped"; hover the marker to read which tools were skipped and why.

A single server can be reconnected from its row without restarting anything
else. That verb did not exist before: the only recovery was a full reload of the
configuration.

## Finding MCP Servers

- The [official MCP server registry](https://github.com/modelcontextprotocol/servers) lists reference and community servers.
- Many SaaS products document a hosted MCP endpoint alongside their REST API — check their developer docs.
- Internal tools can expose their own server; the protocol SDKs make a minimal stdio server a short exercise.

::: info Plain REST API instead?
If a service has a good HTTP API but no MCP server, you may not need one — [API sources](../apis/overview) turn REST endpoints directly into tools, including Google APIs with built-in OAuth support.
:::

## Security Notes

- User-created sources and their credentials are scoped to one workspace. Another workspace connecting the same server authenticates separately. A plugin-owned server is the deliberate exception: its credential is global, so one sign-in covers every workspace.
- Secrets never sit in `config.json`. They are held in the encrypted vault at `~/.nessy-agent/credentials.enc` — see [credentials](../../reference/config/credentials).
- What the agent may do with connected tools is governed by the session's [permission mode](../../core-concepts/permissions).

## Next Steps

- [Connecting servers](connecting-servers) — step-by-step setup for remote and local servers, plus troubleshooting.
- [Authentication](authentication) — OAuth, bearer tokens, custom headers, and credential storage.
- [Organisation MCP servers](managed-servers) — remote servers an administrator delivers to every session through the managed policy.

## Graphify · Odysseus knowledge base

Run `npm run knowledge:setup` from the Odysseus root to enable the shared Graphify MCP. It discovers an Obsidian vault or creates one, persists per-project graphs, and refreshes them in a separate process while the Odysseus launchers run. Cross-project links retain their evidence; a shared dependency means a shared stack. Pass the project node’s graphify_project_path as project_path to MCP tools for detailed symbols.

The Desktop sidebar offers Knowledge base for interactive graph exploration and Knowledge agent chat for a persistent native agent conversation. Manual notes and links are stored separately and survive re-indexing.

The graph offers Folders navigation within each project and a separate Relationships mode. Read source opens evidence documents/code in Desktop. Stored graph changes appear without reloading the app.

Knowledge catalogs separate project context. My projects excludes the Odysseus source projects. Each catalog has its own native agent conversation and MCP graph; users can create catalogs and move projects.

## Obsidian catalog synchronization

Use **Sync all with Obsidian** on the knowledge map to exchange Markdown notes and manual links for every catalog. Concurrent edits are preserved as conflicts. Source-derived relations must be corrected in source files. Synchronization runs on demand in a separate process and leaves unchanged files untouched.
