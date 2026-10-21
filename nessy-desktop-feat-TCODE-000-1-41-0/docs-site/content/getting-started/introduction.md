# Introduction

Nessy Desktop is T-Bank's internal desktop client for agent-assisted work. It pairs a coding-capable agent with an inbox of persistent sessions, so implementation tasks, research, and operational chores can run side by side, keep their full history, and resume exactly where they stopped. Out of the box the app talks to the internal Nessy Gateway; Claude and ChatGPT subscription logins stay available as opt-in connections.

## Why a Desktop App

### Sessions live in an inbox

Conversations here are not throwaway terminal scrollback. Every session carries a status, optional labels, and its complete history, and the inbox groups sessions the way a mail client groups messages. When the agent drafts a plan, you read it in a document-style view and approve or redirect it before anything runs — closer to reviewing a colleague's proposal than to babysitting a shell.

### Connect to anything

**Sources** are how the agent reaches beyond the chat window:

| Source type | Typical examples | What it enables |
| ----------- | ---------------- | --------------- |
| MCP servers | Issue trackers, wikis, internal platforms | Tool-level integrations, with auth handled per server |
| REST APIs | Any HTTP service with an API description | The agent reads the spec and issues requests itself |
| Local folders | Code checkouts, notes vaults | Direct file reading and editing on your machine |

A single session can mix sources freely: pull a ticket through an MCP server, call an internal REST endpoint, then edit files in a local checkout — all in one thread.

### Several tasks at once

Sessions run independently. Kick off a long refactor, answer a quick question in another workspace, and come back later; background sessions keep working, and the inbox shows which ones are waiting on you.

### Plan before you execute

A session can start in **Plan**, the read-only mode where the agent investigates and drafts without touching anything. Once the plan looks right, switch to **Manual**, **Accept edits**, **Auto**, or **Bypass permissions** and let the work proceed at the autonomy level you want. Cycle modes with **Shift+Tab** or from the chat input.

### A durable record

Because sessions persist, the reasoning behind a change stays attached to it: what was tried, what was rejected, and why the final shape won. Reopening an old session restores that context immediately.

::: info
Sharing a chat publishes a masked snapshot to t-artifacts after a confirmation card — see [Sharing](/go-further/sharing).
:::

### Server and CLI included

The engine behind the app also runs headless. Start the [server](../server/headless) from a repository checkout and drive it with the [CLI](../reference/cli) for scripted or remote use. v1 publishes no prebuilt server distribution, so this path is source-only for now.

### Configuration the agent can edit

Themes, statuses, skills, and permission rules are plain files under `~/.nessy-agent`. You can ask the agent to adjust them instead of digging through settings screens.

| What | Format | Scope |
| ---- | ------ | ----- |
| [**Skills**](../skills/overview) | Folder with a `SKILL.md` entry point | Invoked by mention or applied automatically |
| [**Themes**](../go-further/themes) | Semantic color tokens | App-wide or per workspace, light and dark |
| [**Statuses**](../statuses/overview) | Workflow-state config | Names, colors, icons, inbox grouping |
| [**Permissions**](../core-concepts/permissions) | Layered rules | App, then workspace, then source |

## Model Access

### Nessy Gateway (default)

First-run setup preselects the internal gateway, configured as an OpenAI-compatible `pi_compat` connection:

| Setting | Value |
| ------- | ----- |
| Chat endpoint | `https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1` |
| Models endpoint | `https://code-completion-nestor.tcsbank.ru/api/v1/cli/models` |
| Auth header | `Nestor-Token: <JWT>` |
| Sign-in | One-click via the corporate `dp` auth flow; the resulting JWT is cached in `~/.nessy/dp_auth_creds.json` |

The gateway model list refreshes automatically at app start; per-model overrides you make in the connection config survive the refresh. Current lineup (measured 2026-09-11):

| Model ID | Alias | Role |
| -------- | ----- | ---- |
| `tgpt/deepseek-v4-flash-0731` | `coder` | Default coding model — the row the gateway aliases `coder` (and flags default when it does); the app reads the lineup from the gateway at start and follows that alias, so this id can change without an app release (the previous coder model, a Qwen 3.5 build, was retired by the gateway in September 2026) |
| `tgpt/qwen36-35b-a3b-fp8` | `fast` | Lightweight model for quick and utility turns |

See [LLM Connections](../reference/config/llm-connections) for the full connection format.

### Optional connections

The default build also offers:

- **Nessy · Codex agent** — one-click gateway sign-in; sessions run the bundled Codex harness (`codex-app-server`) against the Nessy Gateway through a local adapter. See [Codex (Nessy Gateway)](../reference/config/llm-connections#codex-nessy-gateway).
- **Nessy · Claude Code agent** — one-click gateway sign-in, no Anthropic account; sessions run the bundled Claude Agent SDK against the Nessy Gateway through a local translation adapter. See [Claude Code (Nessy Gateway)](../reference/config/llm-connections#claude-code-nessy-gateway).
- **Custom runtime endpoint** — the single personal-key entrance since 1.26.0 (the separate "API key" card was merged into it). Pick the runtime — Pi agent, Claude Code or Codex — paste your key, and fetch the model list from the endpoint; on the Pi arm an Anthropic or OpenAI provider preset is available instead of a custom endpoint. See [Custom runtime endpoints](../reference/config/llm-connections#custom-runtime-endpoints).

Behind build-time provider flags (disabled in the default build):

- **Claude Pro/Max** — OAuth sign-in; sessions run through the bundled Claude Agent SDK.
- **ChatGPT Plus (Pi)** — ChatGPT subscription sign-in; sessions run on the Pi agent.
- **ChatGPT (Codex)** — the same ChatGPT sign-in; sessions run the bundled Codex harness on your subscription. See [ChatGPT (Codex)](../reference/config/llm-connections#chatgpt-codex).
- **Local model** — Ollama or another local OpenAI-compatible server.

GitHub Copilot sign-in, Slack and Microsoft OAuth sources, and Sentry telemetry were removed from this fork and are not available.

## Nessy Desktop and Claude Code

| Aspect | Claude Code | Nessy Desktop |
| ------ | ----------- | ------------- |
| **Interface** | Terminal CLI | Desktop app with a session inbox |
| **Model access** | Anthropic accounts | Nessy Gateway by default, plus Claude, ChatGPT, and API-key connections |
| **Data sources** | MCP servers | MCP servers, REST APIs, and local folders |
| **Session organization** | `-c` / `--resume` flags | Inbox with statuses and labels |
| **Configuration** | Per-project `.claude/` | Multiple isolated workspaces under `~/.nessy-agent` |
| **Permissions** | Fixed per-mode behavior | Claude Code's six modes, and [rules](../core-concepts/permissions) layered per workspace and source |
| **Remote use** | SSH into a machine | [Headless server](../server/headless) with desktop and CLI clients (source-only in v1) |

When a session uses a Claude connection, Nessy Desktop drives the same Claude Agent SDK that powers Claude Code, so the built-in tool set (Read, Edit, Write, Bash, Glob, Grep), MCP wiring, and the skills format behave the way Claude Code users expect. The **Nessy · Claude Code agent** connection — in the default build — puts that same harness on the Nessy Gateway's models, with no Anthropic account, and the **Nessy · Codex agent** card does the same with the Codex harness. Other gateway and API-key connections route through the Pi backend instead.

## Key Concepts

[**Sources**](../sources/overview) attach external capability to a session — an MCP server, a REST API, or a folder on disk. Enable only what the task needs.

[**Workspaces**](../go-further/workspaces) isolate sources, skills, statuses, labels, preferences, and session history from each other. Use one per project or per context.

[**Permission modes**](../core-concepts/permissions) bound what the agent may do:

| Mode | Config value | What it allows |
| ---- | ------------ | -------------- |
| **Don't ask** | `dontAsk` | Never prompts; runs only pre-approved actions and denies the rest |
| **Plan** | `plan` | Read-only investigation, optionally ending in a plan; writes only its plan and the session's data folder |
| **Manual** | `default` | Stops for approval on risky actions |
| **Accept edits** | `acceptEdits` | Auto-accepts file edits within session roots, still asks for other side effects |
| **Auto** | `auto` | Lets low-risk work proceed while a safety judge reviews borderline actions |
| **Bypass permissions** | `bypassPermissions` | Autonomous edits and commands, no prompts |

Older configs using the previous spellings (`safe`, `ask`, `allow-all`, …) keep working — they are permanent aliases for the modes above. Nessy Desktop's own Explore mode (`explore`) is retired since 1.41.0 and opens as Plan.

[**Sessions**](../core-concepts/conversations) hold the conversation plus its model choice, permission mode, status, labels, and selected sources.

[**Skills**](../skills/overview) are reusable instruction folders — a review checklist, a release routine — that the agent loads on demand.

[**Automations**](../automations/overview) trigger prompts or commands from schedules and app events, so routine follow-ups can start without manual prompting.

## Lineage

Nessy Desktop is an internal fork of the upstream OSS codebase (Apache 2.0), rebranded and pointed at internal infrastructure: configuration lives in `~/.nessy-agent`, deep links use the `nessy://` scheme.

## Next Steps

- [Install Nessy Desktop](installation) — one-line install from the internal release feed.
- [Add sources](../sources/overview) — connect MCP servers, APIs, and local folders.
- [Review LLM connections](../reference/config/llm-connections) — gateway details and alternatives.
