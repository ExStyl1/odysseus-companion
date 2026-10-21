# Workspaces

Think of a Workspace as one sealed bundle of Nessy-managed setup — its own
sources, skills, statuses, labels, automations, defaults, and conversation
history. Flip to a different Workspace and the whole context swaps in one move.

A Workspace is not a project directory. A **Workspace** is Nessy-owned state
identified by an immutable `workspaceId`; a **Project** is an optional external
folder or repository used as a session's working directory. One Workspace can
be used with several Projects, and the same Project can be used from several
Workspaces without being copied into Nessy storage.

## What a Workspace Owns

| Component     | Description |
| ------------- | ---------------------------------------------------------------- |
| Sources       | MCP servers, APIs, and local folders connected here |
| Skills        | Reusable instructions invoked with `@mention` |
| Statuses      | Workflow states used to organize sessions |
| Labels        | Session tags |
| Automations   | Scheduled and event-driven runs |
| Sessions      | Chat history scoped to this workspace |

Credentials are referenced by the Workspace but stored in the encrypted
credential store, never inside Workspace config. Project files remain external.

## Where Workspaces Live

`CONFIG_DIR` is `NESSY_CONFIG_DIR` when set, otherwise `~/.nessy-agent`. Each
Workspace is stored under its immutable ID:

```
CONFIG_DIR/workspaces/{workspace-id}/
```

A typical layout:

```
CONFIG_DIR/
  config.json
  credentials.enc
  capabilities.json
  project-trust.json
  capability-trust.json
  mcp.json
  hooks.json
  skills/
  agents/
  plugins/
  logs/
  recent-projects.json
  sessions/
    {workspace-id}/
      {session-id}/
        session.jsonl
        attachments/
        plans/
        data/
        downloads/
        long_responses/
  workspaces/
    {workspace-id}/
      config.json           # Workspace configuration
      capabilities.json     # Workspace activation policy
      sources/
        {source-slug}/
          config.json
          guide.md
      skills/
        {skill-slug}/
          SKILL.md
      agents/
      hooks.json
      automations.json
      permissions.json
      labels/
        config.json
      statuses/
        config.json
      views.json
```

Workspace resources and sessions are created and maintained by the app; you
rarely edit them by hand. Sessions are globally partitioned by `workspaceId`,
not nested inside the Workspace resource folder.

## config.json

The workspace config file holds identity and per-workspace defaults:

```json
{
  "id": "ws_1a2b3c4d",
  "name": "Client A",
  "defaults": {
    "defaultLlmConnection": "nessy-gateway",
    "colorTheme": "nord",
    "permissionMode": "plan"
  }
}
```

The `defaults` block can set the LLM connection, model, color theme, permission
mode and cyclable modes, an external Project, thinking level, and the sources
enabled by default for new sessions in this Workspace. Project selection in the
UI uses an opaque backend handle. The backend canonicalizes and revalidates the
Project before updating the default or a session.

`CONFIG_DIR/recent-projects.json` is backend-owned convenience history. It
stores external project paths behind opaque IDs and may keep a stable-identity
hint, but every selection is revalidated. A recent entry is never a trust or
authorization grant.

## Custom Agent Definitions

The `agents/` folders hold custom orchestration agents — the subagents Nessy can
spawn to fan out work. Each is a markdown file with YAML frontmatter and a
system-prompt body:

```markdown
---
description: Audit one narrow concern.
toolset: read-only
tier: small
maxTurns: 4
permissionMode: plan
---
Audit only the requested concern and report findings first, with file references.
```

The built-ins are `scout`, `planner`, `worker`, and `reviewer`; a custom entry
with the same name replaces the built-in.

| Field | Meaning |
| ----- | ------- |
| `description` | Short summary shown when the agent is offered. |
| `toolset` | `read-only` or `full`; selects the default tool set. |
| `tier` | `small`, `medium`, or `big`; picks the model for that tier. |
| `model` | Explicit model override for this agent. |
| `effort` | `off`, `low`, `medium`, `high`, `xhigh`, or `max`; narrows the reasoning effort for this agent. |
| `tools` | Tool patterns the agent may use; omitted means it inherits the `toolset` default. |
| `disallowedTools` | Tool patterns removed from the agent's set. |
| `maxTurns` | Optional positive integer capping how many model round trips the agent makes in one run. At the limit it stops, its output is returned marked as partial, and it can be resumed to continue (each resume runs under the same cap). Omitted means unbounded. Codex has no counterpart for it: on a Codex session the agent runs with the session's own bounds, and the session says so in a notice. |
| `permissionMode` | Optional starting [permission mode](../core-concepts/permissions) for the agent. |

### Tool Patterns

`tools` and `disallowedTools` accept a YAML list, or a single string whose
entries are separated by spaces or commas. A comma **inside** parentheses
belongs to its entry, so `Agent(reviewer, planner)` is one entry and not two —
in `tools` that keeps the grant the author wrote, and in `disallowedTools` it
keeps the denial doing what it says.

Both fields also accept a server-level MCP pattern: `mcp__<server>` or
`mcp__<server>__*` grants or removes every tool that server publishes. The
server name must match in full, so a rule naming `mcp__git` never reaches
`mcp__github__create_issue`.

Listing `Agent` lets the agent spawn subagents of its own while the depth limit
allows it; any type list inside its parentheses is ignored, which is why
`Agent(reviewer)` and `Agent` mean the same thing. Any *other* tool written with
a parenthesised specifier does not name a tool that can be resolved, so it is
left out of the agent's set and reported in the session log rather than ending
the turn.

`maxTurns` and `permissionMode` can only ever tighten, never loosen. A child's
`permissionMode` is clamped so it is never broader than the session that spawned
it (`dontAsk < plan < default < acceptEdits < auto < bypassPermissions`; the
retired `explore` and legacy spellings such as `safe`, `ask`, and `allow-all`
still resolve to these). `maxTurns` is capped by any bound
it inherits. Omitted fields inherit the parent/default.
Present-invalid ceilings, models, tiers, effort values, or empty/malformed tool
lists reject the definition before it can be advertised or spawned.

## Adding and Switching

Your first workspace is created during onboarding. To add another:

1. Open the workspace dropdown in the sidebar.
2. Choose **Add Workspace…**.
3. Name it; it is created with default settings.

To switch, click any entry in that same dropdown. The active workspace's name shows in the sidebar, and selecting another one pulls in its sources, skills, statuses, and sessions.

## Connection Resolution

When a session needs an LLM connection, Nessy Desktop resolves it in order:

1. The session's own connection, if set.
2. The workspace default (`defaults.defaultLlmConnection`).
3. The global default.
4. The first connection in the list.

## Multiple Windows

You can keep more than one window open — commonly one per workspace — to hold different contexts side by side. The title bar adapts:

| Open windows | Title on each window |
| ------------ | ---------------------------------------- |
| 1            | `Nessy Desktop` (the app name) |
| 2 or more    | The workspace name that window is viewing |

Titles update as you open, close, or reassign windows, which makes it easy to pick the right one from the app switcher.

## Remote Workspaces

You can connect to workspaces hosted on a [headless server](../server/headless); they appear in the switcher next to local ones.

To connect:

1. Open the workspace dropdown and choose **Add Workspace… → Connect to Remote Server**.
2. Enter the server URL (for example `wss://192.168.1.100:9100`) and the server token.
3. Test the connection.
4. Select an existing remote workspace or create a new one.

A single server can host several workspaces, and you can connect to more than
one server. The saved remote binding contains only the URL and remote Workspace
ID. Its token is stored separately in `CONFIG_DIR/credentials.enc` and is never
returned in Workspace data or prefilled on reconnect. Remote Workspaces show a
connectivity indicator in the switcher and are health-checked when you open it.
Removing a remote Workspace drops the local reference only — it does not delete
anything on the server.

### Sending a Session to Another Workspace

**Send to Workspace** (in the session menu) copies a session — plus a summary for context — into another workspace, local or remote. The result is a standalone duplicate: edits made afterward in either place stay put and never sync across. A remote destination must be online; a local one is always available.

## The CLI and Workspaces

The [command-line client](../reference/cli) targets a workspace with a global flag:

- `--workspace <id>` selects an existing workspace on the server.

## Use Cases

- **Personal vs work.** Keep separate sources, skills, and history with no cross-contamination.
- **Client projects.** One workspace per client, each with its own sources and skills.
- **Environments.** Separate dev, staging, and production workspaces with the right endpoints and permissions.
- **Reusable context.** Use one Workspace with several external Projects while keeping its Nessy-managed resources together.

::: tip
Start with one workspace and add more only when sources, permissions, or review practices genuinely diverge. Name each one clearly so its context is obvious at a glance. Per-workspace rules for what Plan mode runs without asking live in a `permissions.json` file — see [permissions](../core-concepts/permissions).
:::
