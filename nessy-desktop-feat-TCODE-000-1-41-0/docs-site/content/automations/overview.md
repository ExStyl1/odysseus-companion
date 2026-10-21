# Automations

Automations react to events inside Nessy Desktop and run work for you — kick off a new session, fire an HTTP webhook, or log activity to disk. Lifecycle hooks can also run command hooks around an agent turn. Each workspace stores the final configuration in JSON, but normal creation and updates go through the guided UI or agent tools.

::: tip
**Ask the agent instead of hand-editing.** Say something like "create an automation that starts a session when I flag one" or "run a morning briefing every weekday at 9". The agent uses `automation_create` or `automation_update`, then runs `automation_validate`.
:::

## Getting Started

The quickest path is to describe the outcome in plain language. A few prompts to try:

| Goal                   | Ask                                                                          |
| ---------------------- | ---------------------------------------------------------------------------- |
| Scheduled briefing     | "Run a standup briefing every weekday morning at 9"                          |
| Webhook on flag        | "When I flag a session, POST to my Slack incoming-webhook URL"               |
| Audit trail            | "Record every permission-mode change to a log"                               |
| Status-driven work     | "When a session moves to done, summarise what changed"                       |
| Weekly report          | "Every Friday at 5pm, open a session that recaps the week"                   |

Add Automation is type-aware. Opening it from **Scheduled**, **Event**, or **Agentic** starts a matching guided prompt:

- **Scheduled** automations use `SchedulerTick` plus `cron`.
- **Event** automations use app events such as `LabelAdd`, `LabelRemove`, `SessionStatusChange`, or `PermissionModeChange`.
- **Agentic** automations use agent lifecycle events such as `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, or `PermissionRequest`.

Agents manage automations with `automation_list`, `automation_create`, `automation_update`, and `automation_validate`. They should not edit `automations.json` directly.

An automation the agent creates or edits is limited to **Accept edits** or a narrower mode: a wider one is refused with the reason, and you can still set any mode yourself on the Automations page. Changing what an unattended automation in Auto or Bypass permissions does — its actions, re-enabling it, or moving its trigger or schedule — asks you with a card that names the automation and its mode, and a saved answer never skips it: on Pi and Claude Code the card offers no Always Allow. A session in Don't ask refuses such a change, and a session that is itself in Bypass permissions does not ask. On Codex the same change is never approved for you when nobody is watching. With Codex auto-review on, a session in Auto — where the reviewer answers — refuses it before the reviewer is asked, while Manual and Accept edits show you the card as above; if your organisation's Codex policy allows only the reviewer, every mode but Bypass permissions refuses it. If Codex cannot run that check, the turn says so and the reviewer decides.

### Your First Automation

The smallest useful automation sends a webhook whenever a label is added. The event data lands in `NESSY_EVENT_DATA` and named fields become their own variables:

```json
{
  "version": 2,
  "automations": {
    "LabelAdd": [
      {
        "actions": [
          {
            "type": "webhook",
            "url": "${NESSY_WH_SLACK_URL}",
            "body": { "text": "Label added: $NESSY_LABEL" }
          }
        ]
      }
    ]
  }
}
```

This is the resulting file shape. To create it, use Add Automation or ask the agent so the config is validated before it is written.

### Scheduling a Prompt

To make the agent do something on a timer, attach a cron expression to a `SchedulerTick` matcher and use a prompt action:

```json
{
  "version": 2,
  "automations": {
    "SchedulerTick": [
      {
        "cron": "0 9 * * 1-5",
        "timezone": "Europe/Budapest",
        "labels": ["Scheduled"],
        "actions": [
          { "type": "prompt", "prompt": "Check @github for issues assigned to me and summarise them" }
        ]
      }
    ]
  }
}
```

A new session is created each weekday at 9, the `@github` source is activated, and the session is labelled `Scheduled` so you can filter it later.

## How Automations Work

When an event fires — a label change, a tool run, or a scheduler tick — Nessy Desktop looks up the matchers configured for that event, checks each matcher's filter and conditions, and runs the actions that pass.

Actions come in four kinds for `automations.json`:

- **Prompt actions** — start a new session with a prompt (App events only).
- **Webhook actions** — send an HTTP request to an external endpoint.
- **Script actions** — run an approved workspace script.
- **Event log actions** — record the event for later inspection.

::: info
`command` and `decision` actions are only available from lifecycle hook config (`hooks.json` or the workspace `config.json` `hooks` field). General app-event automations still use prompts, webhooks, and event logging. [Plugins](../plugins/overview) can contribute further hook handler kinds — HTTP, MCP tool, prompt, and agent hooks — described under [Plugin And Project Hooks](#plugin-and-project-hooks).
:::

## Configuration File

Automations live per workspace in `automations.json`:

```
~/.nessy-agent/workspaces/<workspace-id>/automations.json
```

### Basic Structure

```json
{
  "version": 2,
  "automations": {
    "EventName": [
      {
        "matcher": "regex-pattern",
        "actions": [
          { "type": "prompt", "prompt": "Do the thing" }
        ]
      }
    ]
  }
}
```

Each event name maps to an array of matcher entries. Every matcher carries an array of actions that run when the matcher matches the event's value.

### Lifecycle Hook Config

Agent lifecycle hooks can live in either workspace `hooks.json` or a top-level `hooks` object in workspace `config.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^Bash$",
        "actions": [
          {
            "type": "command",
            "command": "node .nessy-agent/hooks/check-bash.js"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "actions": [
          {
            "type": "webhook",
            "url": "${NESSY_WH_SLACK_URL}",
            "body": { "text": "Prompt submitted: $NESSY_PROMPT" }
          }
        ]
      }
    ]
  }
}
```

A hooks file can also use Claude Code's settings shape, where each matcher entry lists its handlers under `hooks` instead of `actions`. The `matcher` of such an entry follows Claude's rules (a plain list of names is compared exactly, `*` matches everything, anything else is a regular expression), and a handler's `if` filter applies to that handler. A command handler in this shape also follows Claude's exit-code rule: exit 2 blocks, and any other non-zero exit is a non-blocking error that shows a hook error notice and lets the action go on (on `WorktreeCreate` any non-zero exit still aborts), unless the handler sets `blockOnNonZero` itself. A handler's `args` list is read: the command then runs directly with those arguments and no shell. The handler fields `timeout`, `statusMessage` and `onFailure` are read (`timeout` is seconds and becomes `timeoutMs`, clamped to the 120-second command ceiling; a spelled `timeoutMs` wins; `onFailure` is described under plugin hooks below); `once` stays ignored, as Claude honors it only in skill frontmatter. Of Claude's handler types only `command` runs from a hooks file: an `http`, `mcp_tool`, `prompt` or `agent` handler loads with a warning and never runs. An entry that has both `hooks` and `actions` is rejected.

Hook config accepts every [agent lifecycle event](#agent-events) — `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, and the rest of the table below. Webhooks are delivered through the same automation path as `automations.json`. Command hooks receive sanitized `NESSY_*` environment variables, run in the workspace/working directory, time out after 30 seconds by default, and have output capped and redacted before it can be surfaced.

For `PreToolUse`, a non-zero command exit blocks the tool unless `blockOnNonZero` is set to `false` (a handler in Claude's settings shape gets `false`, see above). A command can also print a JSON decision to stdout:

```json
{ "decision": "allow", "updatedInput": { "command": "npm ci --offline" } }
```

Allowed decision values are `allow`, `ask`, `block`, and `deny`.

A `PreToolUse` guard sees only the tools its matcher names, so a `^Bash$` guard does not stop the same command sent through the session's own script tools: `script_sandbox` and `transform_data` run a Python, Node or Bun script in an isolated subprocess, and a model the Bash guard refused can run the command there instead. To guard them as well, add their names to the matcher. A hook sees them as `mcp__session__script_sandbox` and `mcp__session__transform_data` on the Claude runtime and as `script_sandbox` and `transform_data` on Pi sessions, so `"matcher": "^(Bash|(mcp__session__)?(script_sandbox|transform_data))$"` covers both spellings and both hooks-file shapes.

**Before a command hook runs, its own command passes Nessy's permission check.** A hook from your global `hooks.json`, or from a trusted project's `.nessy-agent/hooks.json`, runs without a card; a workspace, plugin, skill or agent hook that needs approval gets one. In Plan and Don't ask the check judges a hook as it would in Manual, because those modes restrict what the agent's own tools may do, not your hooks: a `UserPromptSubmit` or `PreToolUse` hook of yours keeps running there instead of being refused by the read-only allowlist. Don't ask never shows a card, so a hook that would need one is refused there with a reason; a refused native hook blocks only a `PreToolUse` tool call or a `WorktreeCreate` worktree (see below), while a plugin's reports a hook error and blocks nothing. To have a workspace hook run in Don't ask, move it into your global `hooks.json` (`~/.nessy-agent/hooks.json`), which the agent cannot write. A deny rule or a denied path refuses a hook in every mode. A refused hook never runs. On `PreToolUse` it still blocks the tool call, and on `WorktreeCreate` the worktree is not created. On every other event the action goes on as if the hook were not set: a refused `UserPromptSubmit` or `UserPromptExpansion` hook does not stop your prompt (the prompt is answered), a refused `Stop` or `SubagentStop` hook does not keep the agent working, a refused `PreCompact` hook does not skip compaction, a refused `PermissionRequest` hook does not deny the request (the normal permission card shows), a refused `ConfigChange` hook does not hold back the change, a refused `PostToolBatch` hook does not stop the loop, a refused `PostToolUse` or `PostToolUseFailure` hook sends nothing to the agent, a refused `TaskCreated` or `TaskCompleted` hook does not undo the task or keep it open, a refused `PreModelSwitch` hook does not hold back the model switch, and a refused elicitation hook does not decline the request. A "Command hook not run" notice shows the hook's command and why it was refused, naming the rule when a rule refused it.

To temporarily switch off every hook without deleting the config, set the root-level key `"disableAllHooks": true` in `hooks.json` or in the workspace `config.json`. Removing the key (or setting `false`) turns the hooks back on. A managed policy can also disable hooks fleet-wide; that switch outranks the local one.

### Plugin And Project Hooks

Native user/global hooks live in `~/.nessy-agent/hooks.json`. Workspace hooks can live in workspace `hooks.json` or the workspace `config.json` `hooks` field. Project hooks live under `.nessy-agent`, and [plugin hooks](../plugins/overview) are projected from installed plugin bundles after trust checks.

During an agent turn, Nessy runs internal permission and pre-tool checks first, then native user/global and workspace hooks, then project `.nessy-agent` hooks, then trusted plugin hooks. Changing user/global, workspace, project, or plugin hook configuration invalidates active runtime sessions so the next queued turn uses fresh hook state.

Five hook handler kinds run in total: `command` hooks (shell or executable),
HTTP hooks, MCP tool hooks, prompt hooks (inject one-shot context through a
bounded model call), and agent hooks (spawn a declared subagent). Native
config files carry `command`, `webhook`, and `decision` actions; the other
kinds arrive from imported plugin bundles. Support is per event: the core
tool, prompt, task, and permission events accept all five kinds;
`SessionStart` accepts only `command` and MCP tool hooks; every
other event accepts `command`, HTTP, and MCP tool hooks.

Imported plugin command hooks can also carry fields the Claude hook format
defines: a per-hook `timeout` budget, a `statusMessage` spinner label, `async`
for background hooks that never block, and an exec-form argument vector that
bypasses the shell. Plugin HTTP, MCP-tool and agent hooks honour their declared
`timeout` too, with the Claude format's defaults when they declare none: 600
seconds for HTTP and MCP-tool hooks (30 on `UserPromptSubmit`, `PreModelSwitch`
and `PostModelSwitch`, 10 on `MessageDisplay`) and 60 for agent hooks. The cap
is 600 seconds.

Trusted plugin agent hooks use the existing child-session owner, MCP tool
hooks call only through the session's pinned MCP lease, and HTTP hooks use the
normal permission-checked webhook executor. Plugin HTTP hooks are
credentialless: authentication fields, sensitive headers/query/body values,
and URL userinfo fail closed before policy or network access.

An HTTP hook (a native `webhook` action included) that Nessy refuses to start
does not run, and it is never silent about it: the project is not trusted, the
URL is outside the managed `allowedHttpHookUrls` list, or the session's
permission mode would have to ask before sending it (a hook cannot ask). The
transcript shows one hook-error warning per hook and reason, the tool call or
event goes ahead, and every refused run is still recorded.

An MCP tool hook that Nessy refuses to start is reported the same way: the
project is not trusted, or the session's permission mode would have to ask
before calling the tool.

An HTTP hook's answer is read the way Claude Code reads it. An empty 2xx
response is a clean run, and a JSON object can block, allow or add context the
way a command hook's JSON output does. Any other 2xx body is a non-blocking
error, handled like a non-2xx status: plain text such as a notification
service's `ok`, a JSON array, or a quoted string. The transcript shows a
hook-error warning for that run, the tool call or event goes ahead, and the
text never reaches the agent's context. MCP tool hooks keep the command-hook
rule instead: their plain text is added as context on `UserPromptSubmit`,
`UserPromptExpansion`, `SessionStart` and `PostModelSwitch`.

A native `webhook` action on an agent event is a notification, so its 2xx
answer counts as delivered: plain text such as a Slack incoming webhook's `ok`
is a clean run with no warning, and the text still never reaches the agent's
context. A JSON object in its answer is read as above when it is valid hook
output, so it can still block, allow or add context. Any other object is a
clean delivery too, with no warning and nothing taken from it: one the schema
check below rejects, such as a service's own `{"continue":"yes"}`, or a body
that starts with `{` and is not one JSON object, such as newline-delimited
JSON. Such an answer never blocks the tool call; for an endpoint whose broken
answer must block, use an HTTP hook with `"onFailure": "block"`. A non-2xx
status is still a hook-error warning.

A native `webhook` action on an agent event expands its templates before it is
sent, as it does on an App event. In its `url`, header values and body,
`$NESSY_*` reads the hook input: `NESSY_EVENT`, `NESSY_EVENT_DATA` (the whole
input as JSON) and one variable per input field, such as `NESSY_TOOL_NAME`,
`NESSY_TOOL_INPUT` or `NESSY_PROMPT` (the names a command hook reads).
`$NESSY_WH_*` reads your exported secrets. An unset name expands to an empty
string. Text a variable inserts is not expanded again, and each string value of
a JSON body is expanded on its own, so a prompt with quotes keeps the body
valid. The checks above read the expanded request: a secret that expands into
a `token=` query or a URL with a user name is refused like one written in the
config. A webhook on `SessionStart` never runs, because Claude Code runs no
HTTP hooks there, and validation warns about it.

A `PostModelSwitch` hook's context (a command or MCP tool hook's plain text on
exit 0, or `additionalContext` from its JSON) is added to your next prompt after
the model switch, on every runtime, and only once. When the model changes again
before that prompt, only the last switch's context is sent; a hook that is still
running when you send the prompt adds its context to the prompt after that.

A `PreModelSwitch` or `PostModelSwitch` matcher is compared with the canonical
name of the model the session switches to, as in Claude Code. A `[1m]` suffix,
a date (`claude-sonnet-4-5-20250929`), a Bedrock or Vertex id and a provider
prefix such as `anthropic/` all reduce to one name, so `claude-opus-5` or
`.*opus.*` matches every spelling of Opus 5. When the target has no Claude
canonical name, every model-switch hook runs whatever its matcher says. That
covers a Nessy Gateway or other non-Claude model, an alias such as `opus`, and
a switch back to the default model. A hook that blocks a switch should
therefore check `to_model` from its input.

JSON output is checked against Claude Code's hook output schema when it comes
from a Claude-format command hook (a Claude plugin's, or a hooks file handler
in Claude's settings shape) that exits 0, from an HTTP hook, or from an MCP
tool hook. Output fails the schema when a field holds the wrong type (`null`
included), when the top-level `decision` is anything but `approve` or `block`
(`allow`, `deny`, `ask` and `defer` go in `hookSpecificOutput.permissionDecision`),
or when `hookSpecificOutput` has no `hookEventName`, names an event that has no
`hookSpecificOutput`, or names an event other than the one that fired; fields
the schema does not know are ignored. On `McpElicitation` that name is Claude
Code's, `Elicitation`, and a Claude-format command hook also reads
`Elicitation` as its input's `hook_event_name`. Command hooks in this page's
own `actions` shape read `McpElicitation`. Only the schema's own fields are
applied, as in Claude Code: a top-level `additionalContext`, `updatedInput` or
`updatedToolOutput` does nothing, nor does a field that belongs to another
event's `hookSpecificOutput`, and a top-level `"continue": true` allows nothing.
Output that fails is a non-blocking error: the transcript shows a hook-error warning
that names the problem, the action goes ahead, and nothing from that output is
applied or added to the agent's context, even on the events that take plain
text as context. A Claude-format command hook that prints a JSON object that
cannot be parsed is treated the same way. Command hooks in this page's own
`actions` shape and a Codex plugin's command hooks keep the decision format
described above and are not checked against the schema. Output from them that
starts with `{` and cannot be parsed as one JSON object is still the same
non-blocking error: the warning shows, and the text is not added to the
agent's context. A background (`async`) hook's output
is read for the fields it can use (a Claude-format one's `additionalContext`
only from its own event's `hookSpecificOutput`).

A command or HTTP hook that sets `"onFailure": "block"` fails closed: when it
cannot start (Nessy refused it, or its script is missing), exits with a code
other than 0 or 2, times out, gets a non-2xx response or no connection, or
answers with JSON that cannot be read or fails the schema check above, the
action is blocked as if the hook had
exited 2. A `PreToolUse` tool call is blocked, a `UserPromptSubmit` prompt is
blocked, and a `PermissionRequest` is denied; the block's reason starts with
`failed; blocking because onFailure is "block"` (or `timed out`), and the
failure's own hook-error warning still shows. The field has no effect on
`Stop`, `SubagentStop` and `TaskCompleted` hooks, on `async` hooks, or on a
turn you stopped. Without it, or with `"continue"`, a failed hook lets the
action go on, as described above. Plugin hooks, a hooks file's command
handlers and skill or agent frontmatter hooks all read it; Codex's own hook
format has no such field.

A plugin monitor joins the existing `SchedulerTick` path only when its
descriptor has an explicit five-field cron expression, an optional valid IANA
timezone, and installation trust. It reaches the agent only while a turn is
running: a tick that fires while the session is idle is skipped, not queued, and
`/tasks` lists each such monitor with that note. Imported monitors without a
schedule remain visible but inert. Disabling or uninstalling the plugin stops its scheduled
work before the runtime lease is released.

## Managing Automations

### In the UI

Open **Automations** in the sidebar to see everything configured for the workspace. From there you can:

- **Enable / Disable** — toggle a matcher without deleting it.
- **Duplicate** — copy an existing automation.
- **Delete** — remove it.
- **Test** — trigger it by hand to confirm it works before the real event happens.
- **History** — each automation records its runs. History is written to `automations-history.jsonl`, capped at the last 20 runs per automation and 1000 entries in total.

### In a chat

A chat's own background-task row now lists the scheduled work and the watches
that belong to that session, beside the tasks already running in it. A scheduled
automation appears as a chip carrying its cadence — **Runs once** or **Repeats** —
and a watch appears under the name the hook payload already uses for it. Work
that has a row of its own is not drawn a second time.

Three answers are deliberately kept apart. **Nothing scheduled** means the
session was asked and has nothing queued. *This session's background work could
not be read* means the host could not answer. No line at all means it has not
been asked yet. The "nothing scheduled" line only appears beside work that is
already on screen, where it answers the question the chips raise; to ask about a
session that is otherwise idle, type
[`/tasks`](/core-concepts/interactions#slash-commands), which prints the same
inventory into the transcript and leaves it there.

### In the Config File

Use this section as a reference for what the automation tools write. Direct edits to `automations.json` are blocked in agent sessions; ask the agent to use `automation_update` and `automation_validate` instead.

**Disable a matcher** with `"enabled": false`. Drop the field, or flip it to `true`, to switch it back on.

```json
{
  "matcher": "^urgent$",
  "enabled": false,
  "actions": [
    { "type": "webhook", "url": "${NESSY_WH_SLACK_URL}" }
  ]
}
```

**Delete** by removing the matcher entry. If an event ends up with no matchers, drop the whole event key.

::: tip
Ask the agent to manage them: "disable all my scheduled automations" or "remove the urgent webhook". It calls `automation_list`, then `automation_update` or `automation_create`, and finishes with `automation_validate`.
:::

## Events

### App Events

Raised by Nessy Desktop itself. Support both prompt and webhook actions.

| Event                  | Fires when                   | Match value                |
| ---------------------- | ---------------------------- | -------------------------- |
| `LabelAdd`             | A label is added to a session | Label ID (e.g. `urgent`)  |
| `LabelRemove`          | A label is removed           | Label ID                   |
| `LabelConfigChange`    | Label configuration changes  | Always matches             |
| `PermissionModeChange` | Permission mode changes      | New mode name              |
| `FlagChange`           | A session is flagged/unflagged | `true` or `false`        |
| `SessionStatusChange`  | Session status changes       | New status (e.g. `done`)   |
| `SchedulerTick`        | Every minute (use cron)      | Matched via cron           |

::: info
**Renamed.** `TodoStateChange` is now `SessionStatusChange`. The old name is still accepted as a deprecated alias — the config loader rewrites it to `SessionStatusChange` and logs a warning — but you should update your configs.
:::

::: tip
To act on a specific transition (e.g. a session reaching `done`), match `SessionStatusChange` and use a matcher like `"^done$"`, since the match value is the new status.
:::

### Agent Events

Delivered to the agent backend as hooks during a session's lifecycle. Webhook, event-log, command, and decision actions apply (command and decision from [hook config](#lifecycle-hook-config) only).

**Session lifecycle:**

| Event                | Fires when              |
| -------------------- | ----------------------- |
| `InstructionsLoaded` | An instruction file (project memory, rules) is loaded into context — once per file |
| `SessionStart`       | A session starts, and again after each completed compaction |
| `SessionEnd`         | The session is torn down; matches on the exit reason |
| `CwdChanged`         | The effective working directory changes |
| `ConfigChange`       | A runtime configuration change is committed |

**Prompts and turns:**

| Event                 | Fires when              |
| --------------------- | ----------------------- |
| `UserPromptSubmit`    | A prompt is submitted, before any expansion |
| `UserPromptExpansion` | After the prompt is expanded, before the agent starts |
| `Stop`                | The current turn finishes |
| `StopFailure`         | A turn ends in a terminal failure, just before `Stop` |
| `PreCompact`          | Before context compaction; matches `manual` or `auto` |
| `PostCompact`         | After context compaction |
| `Notification`        | The agent surfaces a notification; matches on the notification type |

**Tools and permissions:**

| Event                | Fires when              |
| -------------------- | ----------------------- |
| `PreToolUse`         | Before a tool runs; a hook can block or rewrite the call |
| `PermissionRequest`  | Interactive approval is required |
| `PermissionDenied`   | A permission decision was denied |
| `PostToolUse`        | After a tool succeeds |
| `PostToolUseFailure` | After a tool fails |
| `PostToolBatch`      | After all tool results of a turn are in |
| `FileChanged`        | A file mutation completes |

**Subagents, tasks, and worktrees:**

| Event            | Fires when              |
| ---------------- | ----------------------- |
| `SubagentStart`  | A subagent spawns       |
| `SubagentStop`   | A subagent finishes     |
| `TaskCreated`    | Before a task-list entry is kept; a blocking hook rolls it back |
| `TaskCompleted`  | Before a task is marked completed |
| `WorktreeCreate` | Before a session worktree is created; a hook may replace the path |
| `WorktreeRemove` | A session worktree is removed |

**MCP interactions:**

| Event               | Fires when              |
| ------------------- | ----------------------- |
| `McpElicitation`    | An MCP server requests user input, before the dialog opens |
| `ElicitationResult` | The user answers an MCP elicitation, before the response reaches the server |
| `McpResult`         | An external MCP interaction completes |

## Action Types

### Prompt Actions

Start a new session with a prompt. App events only.

```json
{
  "type": "prompt",
  "prompt": "Run the @weather skill and summarise today's forecast",
  "ephemeral": true
}
```

| Field           | Type                                                                | Default           | Description                                    |
| --------------- | ------------------------------------------------------------------- | ----------------- | ---------------------------------------------- |
| `type`          | `"prompt"`                                                          | Required          | Action type                                    |
| `prompt`        | string                                                              | Required          | Prompt text (must be non-empty)                |
| `llmConnection` | string                                                              | Workspace default | LLM connection slug from AI Settings           |
| `model`         | string                                                              | Workspace default | Model ID for the created session               |
| `thinkingLevel` | `"off"` \| `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` \| `"max"` | Workspace default | Thinking level for the created session         |
| `ephemeral`     | boolean                                                             | `false`           | Run the created session in memory only         |

**Features:**

- Reference sources and skills with `@mentions` (e.g. `@github`) — mentioned sources are activated for the new session.
- Environment variables are expanded in the prompt text (e.g. `$NESSY_LABEL`, `${NESSY_SESSION_NAME}`).

**Per-action overrides.** `llmConnection`, `model`, and `thinkingLevel` stand on their own — leave any out and it picks up the workspace default. Point one at a connection or model that doesn't exist and it quietly reverts to the default instead of erroring.

Set `ephemeral: true` for notification-style or high-frequency prompt actions
whose transcript does not need review. The session is created in memory only:
it does not write a session record or metadata to disk, does not reappear after
restart, and is gone once closed. Leave the field out for automations whose
output should stay in the workspace history.

```json
{
  "type": "prompt",
  "prompt": "Quick review of recent changes",
  "llmConnection": "openrouter",
  "model": "anthropic/claude-sonnet-4.6",
  "thinkingLevel": "high",
  "ephemeral": true
}
```

The legacy `thinkingLevel` value `"think"` from old configs is migrated to `"medium"` automatically.

### Webhook Actions

Send an HTTP request when the event fires.

```json
{
  "type": "webhook",
  "url": "${NESSY_WH_SLACK_URL}",
  "method": "POST",
  "bodyFormat": "json",
  "body": { "text": "Session $NESSY_SESSION_NAME changed" },
  "captureResponse": false
}
```

| Field             | Type                                          | Default | Description                                         |
| ----------------- | --------------------------------------------- | ------- | --------------------------------------------------- |
| `type`            | `"webhook"`                                    | Required | Action type                                        |
| `url`             | string                                         | Required | `http`/`https` URL, or a `$VAR` template           |
| `method`          | `GET` \| `POST` \| `PUT` \| `PATCH` \| `DELETE` | `POST`  | HTTP method                                        |
| `headers`         | object                                         | —       | Header name → value pairs                          |
| `bodyFormat`      | `json` \| `form` \| `raw`                       | —       | How the body is encoded                            |
| `body`            | any                                            | —       | Request body                                       |
| `captureResponse` | boolean                                        | `false` | Store the response body in history (truncated)     |
| `auth`            | object                                         | —       | `{ "type": "basic", ... }` or `{ "type": "bearer", ... }` |

**Secrets.** Webhook actions run with a restricted environment: only variables named `NESSY_WH_*` are read from your shell, and `process.env` is not otherwise exposed. Export your secrets, then reference them from the config:

```bash
export NESSY_WH_SLACK_URL="https://hooks.slack.com/services/T.../B.../xxx"
```

```json
{ "url": "${NESSY_WH_SLACK_URL}", "headers": { "Authorization": "Bearer ${NESSY_WH_TOKEN}" } }
```

### Script Actions

A `script` action runs a script from the workspace on your computer when an app event fires — with no agent session and no tokens.

```json
{
  "type": "script",
  "script": "scripts/daily-report.ts",
  "args": ["--yesterday"],
  "runtime": "bun",
  "timeoutMs": 120000
}
```

- `script` is relative to the workspace root and must stay inside it; `runtime` is `bun` (the default), `node` or `python3`; `timeoutMs` defaults to 60 s (1 s–15 min).
- It runs only after you approve it: the automation's page shows "Not approved — will not run" with an **Approve** button. The approval covers the script's exact bytes with its path, arguments and runtime, and any change asks again. A refused run is recorded in history with its reason, and **Run test** follows the same rule.
- The script runs without a shell, from the workspace root, as one self-contained file, with network access and no secrets in its environment — only the `NESSY_*` event variables, `NESSY_WORKSPACE_PATH` and `HOME`.
- Script actions run on app events only. A policy that turns off local automations turns them off too.

### Command Hook Actions

Command actions are lifecycle-hook only.

```json
{
  "type": "command",
  "command": "node .nessy-agent/hooks/pretool-policy.js",
  "timeoutMs": 30000,
  "env": { "POLICY": "strict" }
}
```

| Field            | Type        | Default | Description                                      |
| ---------------- | ----------- | ------- | ------------------------------------------------ |
| `type`           | `"command"` | Required | Action type                                      |
| `command`        | string      | Required | Shell command run from the workspace             |
| `args`           | string list | —       | Run `command` directly with these arguments, without a shell (`shell` is then ignored); anything but a list of strings is rejected |
| `cwd`            | string      | Workspace directory | Working directory for this command      |
| `env`            | object      | —       | Extra non-secret environment variables           |
| `timeoutMs`      | number      | `30000` | Timeout, capped at 120 seconds                   |
| `shell`          | `"bash"` \| `"powershell"` | Platform default | Shell to run the command in; a requested shell that is not installed is an execution error |
| `blockOnNonZero` | boolean     | `true` (`false` in Claude's settings shape) | Whether non-zero `PreToolUse` exits block a tool |

## Matchers

### Regex Matching

Most events filter their match value with a regular expression:

```json
{
  "matcher": "^urgent$",
  "actions": [
    { "type": "webhook", "url": "${NESSY_WH_SLACK_URL}" }
  ]
}
```

Omit `matcher` to fire on every event of that type.

| Pattern        | Matches                       |
| -------------- | ----------------------------- |
| `^urgent$`     | Exactly "urgent"              |
| `bug\|feature` | "bug" or "feature"            |
| `^prod-`       | Anything starting with "prod-" |
| *(omitted)*    | All events of the type        |

Patterns are limited to 500 characters and rejected if they look prone to catastrophic backtracking (ReDoS protection).

### Cron Matching

`SchedulerTick` matchers use a cron expression instead of a regex:

```json
{
  "cron": "0 9 * * 1-5",
  "timezone": "Europe/Budapest",
  "actions": [
    { "type": "prompt", "prompt": "Morning briefing" }
  ]
}
```

**Format:** `minute hour day-of-month month day-of-week`

| Field        | Range          | Examples    |
| ------------ | -------------- | ----------- |
| Minute       | 0–59           | `0`, `*/15` |
| Hour         | 0–23           | `9`, `14`   |
| Day of month | 1–31           | `1`, `15`   |
| Month        | 1–12           | `1`, `*/3`  |
| Day of week  | 0–6 (0 Sunday) | `1-5`, `0,6` |

| Cron           | Schedule                   |
| -------------- | -------------------------- |
| `*/15 * * * *` | Every 15 minutes           |
| `0 9 * * *`    | Daily at 9:00              |
| `0 9 * * 1-5`  | Weekdays at 9:00           |
| `30 14 1 * *`  | 1st of the month at 14:30  |
| `0 */6 * * *`  | Every 6 hours              |

**Timezone** uses IANA names (`Europe/Budapest`, `America/New_York`) and falls back to the system timezone. The validator rejects invalid cron and timezone values.

**Missed runs.** On startup, and when the computer wakes from sleep, a scheduled matcher whose most recent occurrence was missed gets exactly one catch-up run — older misses are discarded, and a time that passed while the app was running is never replayed. A catch-up run carries **prompt actions only**: a `script` or `webhook` action whose occurrence fell while the app was closed or asleep is skipped, and its schedule is marked as accounted for so it is not replayed later.

## Conditions

Conditions are an optional gate applied once the matcher (or cron) has matched, and just ahead of running the actions. The whole array has to pass — it's an implicit AND — and leaving it empty or off means nothing holds the actions back.

```json
{
  "cron": "0 9 * * *",
  "conditions": [
    { "condition": "time", "weekday": ["mon", "tue", "wed", "thu", "fri"] }
  ],
  "actions": [
    { "type": "prompt", "prompt": "Good morning — here's your briefing." }
  ]
}
```

### Time Conditions

Gate on the clock time and weekday within a given timezone.

```json
{
  "condition": "time",
  "after": "09:00",
  "before": "17:00",
  "weekday": ["mon", "tue", "wed", "thu", "fri"],
  "timezone": "Europe/Budapest"
}
```

| Field      | Type       | Description                                                    |
| ---------- | ---------- | -------------------------------------------------------------- |
| `after`    | `"HH:MM"`  | Start of the window                                            |
| `before`   | `"HH:MM"`  | End of the window                                              |
| `weekday`  | `string[]` | Allowed days: `mon`, `tue`, `wed`, `thu`, `fri`, `sat`, `sun`  |
| `timezone` | string     | IANA timezone; falls back to the matcher timezone, then system |

If `after` is later than `before` the range wraps across midnight.

### State Conditions

Check a field from the event payload. Use exactly **one** operator group per condition.

```json
{
  "condition": "state",
  "field": "permissionMode",
  "from": "plan",
  "to": "bypassPermissions"
}
```

| Field       | Description                                        |
| ----------- | -------------------------------------------------- |
| `field`     | Payload field name (required)                      |
| `value`     | Exact match                                        |
| `from`/`to` | Previous / new value for transition events         |
| `contains`  | Array membership check                             |
| `not_value` | Matches anything except this value                 |

A state condition must use one of `value`, `from`/`to`, `contains`, or `not_value` — mixing operator groups is a validation error.

### Logical Composition

Group conditions using `and`, `or`, and `not` — each expects a non-empty `conditions` array.

```json
{
  "condition": "or",
  "conditions": [
    { "condition": "state", "field": "permissionMode", "value": "bypassPermissions" },
    { "condition": "state", "field": "isFlagged", "value": true }
  ]
}
```

| Type  | Behaviour                       |
| ----- | ------------------------------- |
| `and` | All sub-conditions must pass    |
| `or`  | At least one must pass          |
| `not` | None may pass                   |

::: warning
Conditions may nest up to 8 levels deep (top level is depth 0). A simplification warning is emitted past depth 4. Keep them shallow.
:::

### Semantic Condition

`conditions` compare fields. A `semanticCondition` asks a yes/no question in plain words instead, answered by the [decision model](../core-concepts/decision-model) when its **Automation conditions** switch is on:

```json
{
  "matcher": "^needs-triage$",
  "semanticCondition": {
    "question": "Is the user reporting a bug or crash, rather than asking a question?",
    "threshold": 0.6
  },
  "actions": [{ "type": "prompt", "prompt": "Triage the bug in session $NESSY_SESSION_NAME" }]
}
```

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `question` | string | Required | The yes/no question, up to 500 characters |
| `threshold` | number | `0.5` | The "yes" probability a run needs, above 0 and at most 1 |

- It is asked **last**: after the matcher, the `conditions` array and the [loop guard](#loop-guard), so a run that would not start anyway costs no question.
- The decision model sees the event's name, the automation's name and the event's fields; for a session event also the session's name, labels, status and its latest user and assistant messages (up to 1,500 characters each).
- Below the threshold the run is skipped, and the automation's history shows it as **Skipped**, with the probability, instead of as a failure.
- A matcher is judged once per event: all of its prompt actions run, or none do.
- It gates prompt actions only. Webhook and script actions are not gated.
- With the decision model off, unreachable or without an answer, the automation runs as if the condition were not there. A semantic condition never switches a working automation off.

## Matcher Options

Each matcher entry accepts these fields:

| Field            | Type       | Default    | Description                                                              |
| ---------------- | ---------- | ---------- | ------------------------------------------------------------------------ |
| `id`             | string     | —          | Stable identifier (auto-generated in the UI)                             |
| `name`           | string     | —          | Display name                                                             |
| `matcher`        | string     | Match all  | Regex filter for the event value                                         |
| `cron`           | string     | —          | Cron expression (SchedulerTick)                                          |
| `timezone`       | string     | System TZ  | IANA timezone for cron                                                   |
| `conditions`     | array      | `[]`       | Conditions that must all pass                                            |
| `semanticCondition` | object | —          | A yes/no question the decision model must answer "yes" to before prompt actions run — see [Semantic Condition](#semantic-condition) |
| `permissionMode` | string     | `plan`     | `dontAsk`, `plan`, `default`, `acceptEdits`, `auto`, or `bypassPermissions` for the spawned session (the retired `explore` and legacy spellings such as `safe`, `ask`, and `allow-all` stay readable) |
| `labels`         | string[]   | `[]`       | Labels applied to prompt-created sessions                                |
| `enabled`        | boolean    | `true`     | Set `false` to disable without deleting                                  |
| `actions`        | array      | Required   | One or more actions                                                      |

## Environment Variables

### Common

Set for every action:

| Variable             | Description                       |
| -------------------- | --------------------------------- |
| `NESSY_EVENT`        | Event name                        |
| `NESSY_EVENT_DATA`   | Full event payload as JSON        |
| `NESSY_SESSION_ID`   | Session ID                        |
| `NESSY_SESSION_NAME` | Session name                      |
| `NESSY_SESSION_METADATA` | Session id/name as JSON       |
| `NESSY_WORKSPACE_ID` | Workspace ID                      |

### App Event Variables

Derived from the payload:

- **Label events** (`LabelAdd`, `LabelRemove`): `NESSY_LABEL`
- **PermissionModeChange**: `NESSY_OLD_MODE`, `NESSY_NEW_MODE`
- **FlagChange**: `NESSY_IS_FLAGGED`
- **SessionStatusChange**: `NESSY_OLD_STATE`, `NESSY_NEW_STATE`
- **SchedulerTick**: `NESSY_LOCAL_TIME` (`HH:MM`), `NESSY_LOCAL_DATE` (`YYYY-MM-DD`)

### Agent Event Variables

- **Tool events** (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`): `NESSY_TOOL_NAME`, `NESSY_TOOL_INPUT`, `NESSY_TOOL_RESPONSE` (post-success), `NESSY_ERROR` (on failure)
- **Session start**: `NESSY_SOURCE`, `NESSY_MODEL`
- **Prompt submit**: `NESSY_PROMPT`
- **Subagent events**: `NESSY_AGENT_ID`, `NESSY_AGENT_TYPE`
- **Notifications**: `NESSY_MESSAGE`, `NESSY_TITLE`

## Permission Modes for Prompt Sessions

A matcher's `permissionMode` sets the security mode of the session a prompt action creates:

| Mode        | Behaviour                             |
| ----------- | ------------------------------------- |
| `dontAsk`     | Never prompts; anything not pre-approved by rules or the read-only allowlist is denied |
| `plan`        | Read-only; Bash is checked against the allowlist; writes only a plan and the session's data folder |
| `default`     | Bash prompts for approval                        |
| `acceptEdits` | File edits auto-approved; other actions prompt   |
| `auto`        | Low-risk work proceeds; risky or ambiguous actions still prompt |
| `bypassPermissions` | No approval prompts                        |

Legacy spellings (`safe`, `ask`, `allow-all`, and the older `execute`/`ask-to-edit`/`automatic`) stay readable in existing automations and resolve to the modes above; new automations should use the current spellings. An automation saved in the retired `explore` mode (or as `safe`) shows and runs as `plan`, and the file says `plan` the next time any automation is saved; an automation with no `permissionMode` runs in `plan` too.

See [Permissions](../core-concepts/permissions) for what each mode allows.

## Labels for Prompt Actions

Prompt actions can tag their sessions so scheduled work is easy to filter:

```json
{
  "cron": "0 9 * * *",
  "labels": ["Scheduled", "morning-briefing"],
  "actions": [
    { "type": "prompt", "prompt": "Today's priorities" }
  ]
}
```

Labels support variable expansion (`"priority::${NESSY_LABEL}"`) and must reference labels that exist in the workspace — the validator flags unknown label IDs. See [Labels](../labels/overview).

## Loop Guard

A prompt action whose session sets off its own matcher again — a `LabelAdd` automation that puts its label on the session it created, for example — would otherwise run without end. Before a prompt action starts a session, Nessy Desktop checks where the event came from:

- **An automation never runs for an event about a session it created itself.** The first run happens; the event that run's own session raises is skipped.
- **Chains of different automations stop at three sessions deep.** Automation A's session may set off B, and B's session may set off C; a fourth link is skipped.
- A skipped run is listed in the automation's history as **Skipped**, with the reason in your language, rather than disappearing into a log.
- A scheduled catch-up run (after the app was closed or the computer asleep) is a fresh run, never a loop.

The guard applies to prompt actions, the ones that create sessions. It is in addition to the rate limits below.

## Rate Limits

To stop runaway loops, the event bus caps how often each event fires:

| Event            | Max per minute |
| ---------------- | -------------- |
| `SchedulerTick`  | 60             |
| All other events | 10             |

Anything past the cap is discarded until the current 60-second window rolls over.

## Examples

### Daily Morning Briefing

```json
{
  "version": 2,
  "automations": {
    "SchedulerTick": [
      {
        "cron": "0 9 * * 1-5",
        "timezone": "Europe/Budapest",
        "labels": ["Scheduled", "briefing"],
        "actions": [
          { "type": "prompt", "prompt": "Run the @daily-standup skill" }
        ]
      }
    ]
  }
}
```

### Notify on Permission Escalation

Only fire when the mode moves from `plan` to `bypassPermissions`:

```json
{
  "version": 2,
  "automations": {
    "PermissionModeChange": [
      {
        "conditions": [
          { "condition": "state", "field": "permissionMode", "from": "plan", "to": "bypassPermissions" }
        ],
        "actions": [
          {
            "type": "webhook",
            "url": "${NESSY_WH_SLACK_URL}",
            "body": { "text": "Permission escalated to bypassPermissions in $NESSY_SESSION_NAME" }
          }
        ]
      }
    ]
  }
}
```

### Two Schedules, One Disabled

```json
{
  "version": 2,
  "automations": {
    "SchedulerTick": [
      {
        "cron": "0 9 * * 1-5",
        "timezone": "Europe/Budapest",
        "labels": ["Scheduled"],
        "actions": [
          { "type": "prompt", "prompt": "Morning briefing" }
        ]
      },
      {
        "cron": "0 17 * * 5",
        "timezone": "Europe/Budapest",
        "enabled": false,
        "labels": ["Scheduled"],
        "actions": [
          { "type": "prompt", "prompt": "Recap this week's work" }
        ]
      }
    ]
  }
}
```

That Friday recap stays dormant until you flip `"enabled"` back to `true` or delete the field.

## Validation

Tell the agent to "validate my automations configuration", or call the `config_validate` tool with `target: "all"`. It looks for:

- JSON syntax and unknown event names
- Empty action arrays
- Invalid cron expressions and timezones
- Over-long or unsafe regex patterns (ReDoS)
- Labels that don't exist in the workspace
- Invalid condition types, field names, weekdays, and nesting depth
- Missing `llmConnection` slugs (error) and model/provider mismatches (warning)
- Legacy `thinkingLevel: "think"` (migrated to `"medium"`)

## Security

Automations ship with several safeguards:

- **Secret isolation** — webhook actions only see `NESSY_WH_*` variables, never your full environment.
- **ReDoS protection** — regex patterns are length-limited and screened for catastrophic backtracking.
- **Rate limiting** — prevents feedback loops between automations.
- **Loop guard** — an automation never re-runs for its own session, and chains of automations stop at three sessions deep.
- **Shell-safe expansion** — user-controlled values (session names, labels) are escaped where they reach a shell context.
- **Governed plugin effects** — child, MCP, HTTP, and scheduled plugin actions revalidate pinned trust, capability generation, permission, timeout, and cancellation before any side effect.

### Troubleshooting

**Automation not firing**

1. Check the event name — it's case-sensitive (`LabelAdd`, not `labeladd`).
2. Check the matcher regex against the event's match value.
3. For `SchedulerTick`, verify the cron expression.
4. Make sure the matcher isn't `"enabled": false`.
5. Look for `[automations]` lines in the application logs.
6. Read the notes in a chat of that workspace. An `automations.json` that did
   not load is named there with its first error: after an edit the automations
   from before it stay in effect, and at startup none from the file are. A broken
   `hooks.json` gets a note of its own and no longer stops `automations.json`
   from reloading.
7. Consider when it was missed: if the app was closed or the computer asleep at
   the scheduled time, only prompt actions catch up on the next start or wake —
   a missed script or webhook action is skipped.
8. Open the automation's history. A run stopped by the [loop guard](#loop-guard)
   or by a [semantic condition](#semantic-condition) is listed as **Skipped**,
   with the reason.

**Prompt not creating a session**

1. Prompt actions only work with App events, not agent events.
2. The prompt text must be non-empty.
3. `@mentions` must reference valid sources or skills.

**Condition never matches**

1. Weekdays must be 3-letter lowercase (`mon`, `tue`, …).
2. Times must be `HH:MM` 24-hour (`09:00`, not `9:00 AM`).
3. Invalid timezones fall back to system local silently.
4. Don't nest deeper than 8 levels.
