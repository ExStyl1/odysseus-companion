# Configuration File

The `config.json` file holds the non-secret, app-level state for Nessy Desktop:
your workspace list, your LLM connections, the default connection, appearance
and input settings, and optional network proxy configuration. Secrets never
live here — those go in the [encrypted credential store](/reference/config/credentials).

## Location

`CONFIG_DIR` is `NESSY_CONFIG_DIR` when set, otherwise `~/.nessy-agent`:

```
CONFIG_DIR/config.json
```

See [Environment Variables](/reference/config/environment-variables).
Multi-instance development runs use suffixed directories such as
`~/.nessy-agent-1`.

The same directory also contains:

| File / folder                | Purpose                                                     |
| ---------------------------- | ----------------------------------------------------------- |
| `config.json`                | App state described on this page                            |
| `preferences.json`           | Personal [preferences](/reference/config/preferences)       |
| `credentials.enc`            | Encrypted [credential store](/reference/config/credentials) |
| `config-defaults.json`       | Bundled default values, refreshed on each launch            |
| `recent-projects.json`       | Backend-owned external Project history by opaque ID          |
| `sessions/<workspace-id>/`   | Global conversation partition for one Workspace              |
| `workspaces/<workspace-id>/` | Workspace configuration and managed resources                |
| `plugins/`                   | Plugin registry, immutable cache, and scoped data             |
| `logs/`                      | Auto-update and main-process logs                            |

On macOS the Electron main-process log is written to
`~/Library/Logs/Nessy Desktop/main.log`.

## Structure

```json
{
  "storageLayoutVersion": 2,
  "llmConnections": [
    {
      "slug": "nessy-gateway",
      "name": "Nessy Gateway",
      "providerType": "pi_compat",
      "authType": "bearer_token",
      "piAuthProvider": "openai",
      "baseUrl": "https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1",
      "defaultModel": "tgpt/deepseek-v4-flash-0731",
      "createdAt": 1737451800000
    }
  ],
  "defaultLlmConnection": "nessy-gateway",
  "workspaceRefs": [
    {
      "id": "ws-abc123",
      "lastAccessedAt": 1737538200000
    }
  ],
  "activeWorkspaceId": "ws-abc123",
  "activeSessionId": "260121-swift-falcon",
  "notificationsEnabled": true,
  "colorTheme": "default"
}
```

## Top-level fields

### llmConnections

Array of [LLM connection](/reference/config/llm-connections) records. Each entry
describes one provider setup — the built-in Nessy Gateway, a direct Anthropic
connection, a Claude subscription login, or a ChatGPT login (the ChatGPT Plus (Pi)
or ChatGPT (Codex) card). Only non-secret routing metadata lives here; API keys
and OAuth tokens are stored in the credential file, keyed by the connection `slug`.

### defaultLlmConnection

Slug of the connection used for new sessions when neither the session nor the
workspace pins one. If this field is missing, the first entry in
`llmConnections` is used as the fallback.

### defaultThinkingLevel

App-wide default thinking level applied to new sessions on models that support
it.

The level you pick for a model is also remembered for that model, and a
remembered level outranks this app-wide default. Picking is the whole gesture:
choose a thinking level in the model picker once, and the next conversation on
that model starts there — the same on Pi, Claude Code and Codex, because the
memory is kept here rather than by whichever integration happens to run the
model. A level you set for the conversation in front of you still wins for that
conversation. When a model has no remembered level and no app-wide default is
set, a model whose catalogue publishes its own recommended effort starts at that
level.

### workspaceRefs

Ordered references to configured Workspaces. Names, defaults, timestamps, local
MCP policy, and remote bindings live in each
`CONFIG_DIR/workspaces/<workspace-id>/config.json`.

```json
{
  "id": "ws-abc123",
  "lastAccessedAt": 1737538200000
}
```

| Field            | Required | Description                        |
| ---------------- | -------- | ---------------------------------- |
| `id`             | Yes      | Immutable Workspace identifier     |
| `lastAccessedAt` | Yes      | Last-access time, used for sorting |

A Workspace config may include a secret-free remote binding:

```json
{
  "id": "ws-abc123",
  "name": "Personal",
  "defaults": {},
  "remoteServer": {
    "url": "wss://nessy.example.internal",
    "remoteWorkspaceId": "remote-ws-42"
  }
}
```

The remote token lives only in `credentials.enc`. An optional default Project
is an external `workingDirectory`, not Workspace storage; UI and RPC selection
uses an opaque backend handle and the server revalidates project identity before
use. `recent-projects.json` is convenience history, never authorization.

See [Workspaces](/go-further/workspaces) for how workspaces are created and
used.

### activeWorkspaceId

Identifier of the workspace selected on launch, or `null` when none is chosen.

### activeSessionId

Identifier of the selected session within `activeWorkspaceId`, or `null`.
Together the two fields form the active `{ workspaceId, sessionId }` pair.
Sessions are stored under `CONFIG_DIR/sessions/<workspace-id>/<session-id>`
rather than inside the Workspace resource folder.

### notificationsEnabled

Toggles desktop notifications for task-completion events. Defaults to `true`.

### colorTheme

Identifier of the selected preset theme (for example `"dracula"` or `"nord"`).
Defaults to `"default"`.

### networkProxy

Optional HTTP/HTTPS proxy settings. See [Network Proxy](/reference/config/network-proxy)
for the field shape and behaviour.

### dismissedUpdateVersion

The version the user opted to skip. Once set, the app quits nagging about that
exact release.

### Sessions, retention, and context

| Key | Default | Purpose |
| --- | --- | --- |
| `outputStyleId` | — | Active output style for new sessions |
| `retentionDays` | `30` | Days to keep session data before the age-based sweep (minimum 1) |
| `retentionSweepEnabled` | `true` | Explicit `false` disables the sweep entirely, whatever the window says |
| `autoCompactEnabled` | `true` | Automatic context compaction; a manual `/compact` works either way |
| `askUserQuestionTimeout` | `"never"` | Idle time before an unanswered agent question auto-continues with the selections made so far: `"60s"`, `"5m"`, `"10m"`, or `"never"` |
| `sessionMirror` | — | Best-effort transcript mirroring into an adapter (`{ "adapter": "directory", "path": "/abs/path" }`); local disk stays authoritative |
| `extendedPromptCache` | `false` | Use the 1-hour prompt-cache TTL instead of 5 minutes |
| `enable1MContext` | — | **Ignored since 1.41.0**, still accepted so an older file loads. There is no switch any more: each model runs with its own context window, so a Claude model with a 1M-token window gets it. To cap the window, an operator sets `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` (200K) or `CLAUDE_CODE_AUTO_COMPACT_WINDOW` in the environment |
| `memoryEnabled` | `true` | Auto-memory notes that persist across sessions |
| `reopenCompactPromptTokens` | `100000` | Token size above which reopening an idle conversation offers *Resume from summary* or *Resume full session as-is*. **Zero or a negative number turns the dialog off** — that is the supported "don't ask me again", not an error |
| `sessionAgent` | — | Name of the agent a new session runs **as**: its system prompt and its tool restrictions apply to the whole conversation, not just to spawned children. The composer shows `@<name>` beside the permission mode. A name that matches no agent in the workspace is reported where the roster is known, not here |
| `crossSessionInbound` | unset | What a session does with text arriving from your other sessions: `"accept"`, `"hold"` (queue it for your approval) or `"refuse"`. Unset keeps the per-message default. An unrecognised value is **ignored and reported** — messages are held while it is there, and correcting it releases them. `NESSY_CROSS_SESSION_INBOUND` lets an operator set it for the machine, and the in-app selector hides itself when that variable is present |
| `lastReviewEffortLevel` | — | The effort level the last `/code-review`, `/simplify` or `/security-review` ran at, so it is not forgotten every session. Written by the app; one of the thinking levels |

### Agent execution and safety

| Key | Default | Purpose |
| --- | --- | --- |
| `sandbox` | — | Sandbox settings for supervised command execution. **`enabled` is the master switch — default `false`** (2026-08-12 owner decision: off until the agent loop is proven stable running unwrapped), so a fresh install runs every supervised command WITHOUT OS-level isolation (seatbelt/bwrap/firejail/the Windows profile). A managed policy that sets `enabled` wins outright over any locally-set value, in either direction — unlike `allowUnsandboxedCommands` below, a managed floor here is not merely a lock a user value cannot loosen. Set `sandbox.enabled: true` in user or managed settings to restore isolation. The path controls are nested under `sandbox.filesystem`: `allowWrite`, `denyWrite`, `denyRead`, `allowRead`, `allowManagedReadPathsOnly`, `disabled`. The flat forms `additionalWritableRoots`, `deniedWriteRoots` and `deniedReadRoots` stay accepted as aliases of the first three; write both spellings and the entries are combined, not replaced. Alongside them sit `excludedCommands` glob patterns that run outside isolation, the `allowUnsandboxedCommands` escape-hatch lock, and a `network` block (`allowedDomains`, `deniedDomains`, `allowManagedDomainsOnly`). Path prefixes: `/tmp/build` is absolute — **not** project-relative; `~/.kube` resolves against your home directory; `./out` or a bare `out` resolves against the config directory (`~/.nessy-agent`); the older `//tmp/build` form still works and normalises to `/tmp/build`. An entry that resolves to the filesystem root is refused. A managed policy layer merges above this one — it has no config directory to anchor to, so a `./` or bare entry there is dropped with a named reason instead. The one exception: the `script_sandbox` session tool keeps its own isolation unconditionally, whatever `sandbox.enabled` says. Known limitation on macOS with `sandbox.enabled: true`, measured on Pi: a headless Chromium started by a Pi command inside the sandbox (for example Playwright's `chrome-headless-shell`) crashes at launch with a segmentation fault in IOKit, because Nessy's macOS isolation profile does not grant what Chromium needs to start; list such commands in `excludedCommands`, which is Pi's way out (Claude Code and Codex run commands in their own sandboxes, `excludedCommands` is not passed to either, and this crash was not measured there), or leave the master switch off |
| `macosSeatbeltBashSandboxEnabled` | off | macOS Seatbelt isolation for Bash commands. Outranked by `sandbox.enabled`: while the master switch is off, this key's `true` has no effect — it keeps its meaning only while the master switch is on |
| `worktree` | — | Session worktree settings: `baseRef` (`"fresh"` or `"head"`), `symlinkDirectories`, `sparsePaths`, and `bgIsolation` (`"worktree"` or `"none"`) |
| `workflow` | — | Workflow governance: `disableWorkflows` (hard off switch; an org-level `true` cannot be re-enabled locally), `sizeGuideline` (advice, not a cap), `keywordTriggerEnabled` |
| `additionalDirectories` | `[]` | Extra absolute filesystem roots tools may write to beyond the session's own; widening a root is a permission decision |
| `primaryDirectory` | — | Which of the already-attached folders is shown and ordered first. Set it from **Settings → Permissions**, where the select lists the attached folders and nothing else. It is a **display and ordering** choice: the resolver can only ever answer with a folder that is already attached, so no value here widens what the agent may read or write, and discovery still runs on the project root. To add a root, use `additionalDirectories` or the outside-root approval |
| `guardianEnabled` | `true` | Consult the guardian safety judge for borderline (`auto`) and high-risk (`bypassPermissions`) actions. Wired for Pi-runtime sessions |
| `guardianJudgeModels` | `{}` | Judge model **per connection slug** (`{ "<slug>": "<modelId>" }`), set from Settings → the Guardian section. Resolution order: this connection's entry → the legacy global `guardianJudgeModelId` if it is valid on this connection → the gateway `fast` alias → the session model. A stale or disallowed entry **falls through** rather than failing — a model restriction must not become a reduction in safety. Clearing the id removes the entry |
| `guardianJudgeModelId` | — | Legacy global judge model. Still read, never migrated; a per-connection entry outranks it |
| `useAutoModeDuringPlan` | `true` | Let the safe-command classifier review Plan-mode shell commands instead of prompting. Read by Pi-runtime sessions only (P3.187) — `claude-runtime` and `codex-runtime` never consult the classifier for this band. Even on Pi the review happens only when the guardian actually resolves a verdict; on every other outcome, and on the other two runtimes, a Plan-mode shell command outside the read-only set prompts, which is the documented "Otherwise" branch. Measured live on a packaged build (PKG-6, 2026-09-03): with the flag at its default, `mkdir -p` reached a human on all three |
| `rtkEnabled` | `false` | Route Bash commands through `rtk` to compress tool output (Pi and Claude Code sessions; `rtk` 0.44.0 or newer — see [Performance](../../go-further/performance)) |
| `rtkExcludeCommands` | `[]` | Base command names never routed through `rtk`, for tools whose output you always want verbatim (`["grep", "jq"]`). Read on every command |
| `decisionLayer` | off | The optional [decision model](../../core-concepts/decision-model): master switch, provider, address, model and per-feature switches. Set from **Settings → AI → Decision model (Jev)**; the key lives in the credential vault, never here |
| `mcpChannelPushEnabled` | `false` | Push channel updates to MCP clients |
| `blockReadsOutsideWorkingDirectories` | `false` | A read-side boundary to match the write side. Only a literal `true` raises the fence; anything else leaves it down. It binds in **every** permission mode, Bypass included. With the fence down, auto mode still asks once the first time a session reads outside its working directories, and *Block from now on* on that card is what writes `true` here |
| `codexAutoReviewEnabled` | `false` | Turn on Codex's own model-backed reviewer for the approvals Codex would otherwise escalate to you: when an action needs approval, Codex asks this reviewer first instead of interrupting you. A denial can be overruled with `/approve`, and a run of denials interrupts the turn. **While it is on, the reviewer can also approve what this app would otherwise refuse or always put in front of you** — this app's safety floors (removing your home or root folder among them), the paths you have denied, and any deny rule Codex cannot enforce itself — because Codex asks its reviewer before it asks this app. The reviewer answers only in Auto and Bypass permissions — in Manual, Accept edits and Plan the approval comes to you, and Don't ask refuses it — and a change to what an unattended automation does or when it runs is refused instead of reviewed (if Codex cannot run that check, the turn says so and the reviewer decides). If your organisation's Codex policy allows only the reviewer, that policy wins: the reviewer answers in Manual, Accept edits and Don't ask too, Codex refuses Plan turns, and the session says so. Turning it off applies from the next message in open Codex sessions; turning it on, and a change to `codexAutoReviewPolicy`, applies to Codex sessions started afterwards. Codex sessions only. **Settings → AI** has the two controls, and a value set here in the file takes effect the same way |
| `codexAutoReviewPolicy` | `""` | Optional instruction text handed to that reviewer |
| `codexSubagentsEnabled` | `true` | Let a Codex session spawn its own agents. The default matches Codex's own; only an explicit `false` travels, written as `[agents] enabled = false` in the config file the app hands the runtime. **Settings → AI** has the toggle. Conditional, and the control says so: an enabled `features.multi_agent_v2` in Codex's own configuration takes precedence over this key |

### Settings with no in-app control

These have a reader, a strict-envelope entry and tests, and no control anywhere
in the app — deliberately: they are operator-shaped, so they surface in
`nessy-general-agent doctor` (section *Settings with no in-app control*) and in
Settings → Settings diagnosis rather than beside the model picker. **None of them
has a managed layer or an environment override**: the value below is the whole
answer.

| Key | Default | Set in | Purpose |
| --- | --- | --- | --- |
| `claudeExplorePlanAgentsEnabled` | unset | `config.json` | Explicit `false` removes claude's own Explore and Plan subagents from the roster (it emits `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS=1`). Unset leaves the runtime's default, which is on — unset is **not** the same as `true`, and only an explicit `false` travels |
| `claudeSwitchModelsOnFlag` | unset | `config.json` | Explicit `false` stops the vendored SDK silently re-running a classifier-flagged turn on a different model. Unset leaves the SDK's own default, which is on |
| `systemPromptAppend` | — | `config.json` | Text appended to the main model's system prompt on all three runtimes. Append only: there is no replacing key and there will not be one |
| `fileCheckpointingEnabled` | `true` | `config.json` | Turn off or on the file snapshots that `/rewind` restores. Claude's own spelling, host-side here. It governs all three runtimes: Pi and Codex take the snapshots themselves — Codex from its own pre-write `fileChange` announcement, so a Codex rewind restores the turn's edits and `/diff` offers them — and Claude Code takes its own under the same setting |
| `sessionAllowedTools` | `[]` | `config.json` | The session's tool whitelist. Empty means no restriction. **Claude Code:** narrows the built-in tools the session is offered to the names listed, plus `ToolSearch`, which the app keeps so MCP tools still load on demand. It does not govern MCP tools (use `sessionDisallowedTools` for those), and a scoped rule such as `Bash(ls:*)` does not keep a tool: list the bare name. `nessy-general-agent doctor` names every entry Claude Code ignores, and why. What a listed tool may do is still decided by your mode and rules. **Pi:** the whole tool list, MCP tools included, so list every tool the session may use. **Codex:** not applied; Codex offers no setting that narrows its built-in tools |
| `sessionDisallowedTools` | `[]` | `config.json` | Tools removed from the session. Empty means no restriction. Claude Code only: the list is added to the tools the app already withholds, and it can name MCP tools too (`mcp__<server>__*`). Pi and Codex do not apply it |

::: tip
These two moved into `config.json` and now work. Until then they were read from
`config-defaults.json`'s `workspaceDefaults`, and that file is **not a user
file**: Nessy overwrites your copy with the bundled asset on every launch, and
the bundled asset ships neither key — so a hand-written entry was gone by the
next start and both resolved to the empty list on every install. If you wrote
one there, move it into `config.json`; nothing migrates it, because no copy of
it could have survived a restart.
:::

### Other UI and behaviour flags

`config.json` also persists smaller toggles set from Settings — input options
(`autoCapitalisation`, `sendMessageKey`, `spellCheck`), appearance
(`zoomFactor`), power settings (`keepAwakeWhileRunning`), and tool metadata
(`richToolDescriptions`, `browserToolEnabled`). These are normally managed
through Settings rather than by hand.

Workspace `config.json` files can also carry agent lifecycle `hooks` and
workspace defaults such as the permission mode, thinking level, and the
Shift+Tab rotation (`cyclablePermissionModes`, minimum two modes). This is a
workspace-scoped setting, not a global app secret store; see
[Automations](/automations/overview#lifecycle-hook-config) for the hook shape and
the safer `hooks.json` alternative.

## Storage v2 cutover and backups

Nessy runs only storage layout v2. On the default path, an eligible unversioned
or v1 `~/.nessy-agent` is renamed beside the new home to
`~/.nessy-agent.legacy-v1.<transactionId>`, then a fresh v2 home is installed.
The quarantine is inert: Nessy never imports or reads its settings, sessions,
plugins, skills, or `credentials.enc`, and never deletes it automatically. Keep
or delete that sibling manually only outside the automatic cutover.

A legacy or incompatible custom `NESSY_CONFIG_DIR` blocks startup and is left
untouched; custom roots are never auto-quarantined.

A full v2 backup is the entire `CONFIG_DIR`, not only `config.json`. External
Projects and `~/.agents` are not inside that backup and must be backed up
separately. Nessy does not modify either during cutover. The shared Gateway file
`~/.nessy/dp_auth_creds.json` is external too.

## Editing the file

Prefer Settings for routine changes:

| Setting        | Where to change it                          |
| -------------- | ------------------------------------------- |
| LLM connection | Settings → AI                               |
| Model          | Model picker in the chat input or status UI |
| Workspace      | Workspace dropdown in the sidebar           |

::: warning
Quit Nessy Desktop before editing `config.json` by hand, and keep a backup.
Invalid JSON prevents the app from starting. Never place secrets in this file —
use the [credential store](/reference/config/credentials).
:::
