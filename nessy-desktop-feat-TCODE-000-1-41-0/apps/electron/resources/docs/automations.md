# Automations Configuration Guide

This guide explains how to configure automations in Nessy to automate workflows based on events.

> **Tool-first workflow (recommended):** Use the session automation tools instead of editing JSON directly.
> - `automation_list` to inspect existing automations
> - `automation_create` for new automations
> - `automation_update` for existing automations
> - `automation_validate` after create/update

## What Are Automations?

Automations allow you to trigger actions automatically when specific events occur in Nessy. You can:
- Send prompts to create agent sessions based on events
- Send webhook HTTP requests to external services (Slack, Discord, custom APIs, etc.)
- Execute actions on a schedule using cron expressions
- Automate workflows based on permission mode changes, flags, or session status changes

## automations.json Location

`CONFIG_DIR` is `NESSY_CONFIG_DIR` when set, otherwise `~/.nessy-agent`.
Automations are configured in the Workspace identified by its immutable `workspaceId`:

```
CONFIG_DIR/workspaces/{workspaceId}/automations.json
```

## Recommended Tools

Agents should use `automation_create` for new automations, `automation_update` for
existing automations, and `automation_validate` after changes. Use
`automation_list` first when you need the id of an existing automation. Direct
JSON editing is kept as a reference format for understanding the schema, not as
the preferred write path.

## Basic Structure

```json
{
  "version": 2,
  "automations": {
    "EventName": [
      {
        "name": "Optional display name",
        "matcher": "regex-pattern",
        "actions": [
          { "type": "prompt", "prompt": "Check for updates and report status" }
        ]
      }
    ]
  }
}
```

## Supported Events

### App Events (triggered by Nessy)

| Event | Trigger | Match Value |
|-------|---------|-------------|
| `LabelAdd` | Label added to session | The label entry: the ID for a plain label (`bug`, not `Bug`), `id::value` for a valued one (`priority::3`; match it with `^priority(::|$)`) |
| `LabelRemove` | Label removed from session | The label entry, as for `LabelAdd` |
| `LabelConfigChange` | Label configuration changed | Always matches |
| `PermissionModeChange` | Permission mode changed | New mode name |
| `FlagChange` | Session flagged/unflagged | `true` or `false` |
| `SessionStatusChange` | Session status changed | New status (e.g., `done`, `needs-review`) |
| `SchedulerTick` | Runs every minute | Uses cron matching |

> **Note:** `TodoStateChange` is a deprecated alias for `SessionStatusChange`. Existing configs using the old name will continue to work but will show a deprecation warning during validation.

### Agent Events (passed to Claude SDK)

| Event | Trigger | Match Value |
|-------|---------|-------------|
| `PreToolUse` | Before a tool executes | Tool name |
| `PostToolUse` | After a tool executes successfully | Tool name |
| `PostToolUseFailure` | After a tool execution fails | Tool name |
| `Notification` | Notification received | - |
| `UserPromptSubmit` | User submits a prompt | - |
| `SessionStart` | Session starts | - |
| `SessionEnd` | Session ends | - |
| `Stop` | Agent stops | - |
| `SubagentStart` | Subagent spawned | - |
| `SubagentStop` | Subagent completes | - |
| `PreCompact` | Before context compaction | - |
| `PermissionRequest` | Permission requested | - |
| `Setup` | Initial setup | - |

## Action Types

### Prompt Actions

Send a prompt to Nessy (creates a new session for scheduled prompts).

```json
{
  "type": "prompt",
  "prompt": "Run the @weather skill and summarize the forecast"
}
```

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `type` | `"prompt"` | Required | Action type |
| `prompt` | string | Required | Prompt text to send |
| `llmConnection` | string | Workspace default | LLM connection slug (configured in AI Settings) |
| `model` | string | Workspace default | Model ID for the created session |

**Features:**
- Use `@mentions` to reference sources or skills
- Environment variables are expanded (e.g., `$NESSY_LABEL`)

**LLM Connection & Model:** Optionally specify which AI provider and model to use for the created session. If omitted, the workspace default connection and model are used.

```json
{
  "type": "prompt",
  "prompt": "Quick code review of recent changes",
  "llmConnection": "my-chatgpt-connection",
  "model": "gemini-2.5-flash"
}
```

The `llmConnection` value is the slug of an LLM connection configured in AI Settings. The `model` value is a model ID supported by the provider. If either is invalid or not found, it gracefully falls back to the workspace default. Both can be used independently or together.

**Loop guard:** an automation never runs for an event about a session it created itself — a matcher that matches the label its own automation put on that session fires once, and the timeline shows the run as **skipped** with the reason instead of creating a duplicate. Chains of *different* automations reacting to each other are allowed, but stop at three sessions deep. Scheduled catch-up runs (after your computer was asleep) count as fresh runs and are never treated as loops.

### Webhook Actions

Send an HTTP request to an external endpoint when an event fires. Useful for notifications (Slack, Discord), logging to external services, or triggering external workflows.

```json
{
  "type": "webhook",
  "url": "https://hooks.slack.com/services/${NESSY_WH_SLACK_PATH}",
  "method": "POST",
  "body": {
    "text": "Session ${NESSY_SESSION_NAME} status changed to ${NESSY_NEW_STATE}"
  }
}
```

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `type` | `"webhook"` | Required | Action type |
| `url` | string | Required | Target URL (http or https) |
| `method` | `"GET"` \| `"POST"` \| `"PUT"` \| `"PATCH"` \| `"DELETE"` | `"POST"` | HTTP method |
| `headers` | `Record<string, string>` | `{}` | HTTP headers as key-value pairs |
| `bodyFormat` | `"json"` \| `"form"` \| `"raw"` | `"json"` | Body serialization format |
| `body` | object or string | - | Request body (omitted for GET requests) |
| `auth` | object | - | Authentication shorthand (see below) |
| `captureResponse` | boolean | `false` | Capture response body in result (truncated to 4KB) |

> **URL validation:** Literal URLs are validated at config load time. Templated URLs (containing `$VAR`) are validated at runtime after variable expansion. Both must resolve to `http://` or `https://` — other protocols are rejected.

**Body format:**
- `json` (default) — Body is serialized as JSON. `Content-Type: application/json` is set automatically unless you override it in `headers`.
- `form` — Body object keys are URL-encoded as `application/x-www-form-urlencoded`. Useful for OAuth token endpoints, Stripe, and legacy APIs. Each value supports `$VAR` expansion.
- `raw` — Body is sent as a plain string. Set `Content-Type` in `headers` yourself.

**Authentication:**

Instead of manually constructing `Authorization` headers, you can use the `auth` shorthand:

**Bearer token:**
```json
{
  "type": "webhook",
  "url": "https://api.example.com/events",
  "auth": {
    "type": "bearer",
    "token": "${NESSY_WH_API_TOKEN}"
  },
  "body": { "event": "$NESSY_EVENT" }
}
```

**Basic auth (username/password):**
```json
{
  "type": "webhook",
  "url": "https://legacy.example.com/webhook",
  "auth": {
    "type": "basic",
    "username": "${NESSY_WH_USER}",
    "password": "${NESSY_WH_PASS}"
  }
}
```

The `auth` field is applied before custom `headers`, so you can override the generated `Authorization` header if needed. All auth field values support `$VAR` expansion.

**Response capture:** By default, webhook response bodies are discarded after reading (to release connections). Set `captureResponse: true` to capture the response body (truncated to 4KB). The captured body is included in the execution result and recorded in automation history (truncated to 500 chars).

```json
{
  "type": "webhook",
  "url": "https://api.example.com/status",
  "method": "GET",
  "captureResponse": true
}
```

> **Note:** Response capture adds memory overhead proportional to the response size. Only enable it for endpoints where you need to inspect the response.

**Variable expansion:** The `url`, `headers` values, `body`, and `auth` fields all support `$VAR` and `${VAR}` syntax for environment variable expansion. See [Environment Variables](#environment-variables) below.

**Security:** Webhook actions only have access to `NESSY_*` system variables and `NESSY_WH_*` user-defined secrets. They do **not** have access to your full system environment (e.g., `$HOME`, `$PATH`, or other process variables).

### Script Actions

Run a script from the workspace on your computer when an app event fires — deterministic work with no agent session and no tokens (export a report every morning, pull a metric when a label is added).

```json
{
  "type": "script",
  "script": "scripts/daily-report.ts",
  "args": ["--yesterday"],
  "runtime": "bun",
  "timeoutMs": 120000
}
```

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `type` | `"script"` | Required | Action type |
| `script` | string | Required | Path relative to the workspace root; it must stay inside the workspace (no absolute path, no `..`) |
| `args` | string[] | `[]` | Extra arguments after the script path |
| `runtime` | `"bun"` \| `"node"` \| `"python3"` | `"bun"` | Interpreter the script runs under |
| `timeoutMs` | number | `60000` | Per-run timeout, between 1 s and 15 min; then the process is stopped (SIGTERM, SIGKILL 5 s later) |

**Approval — a script runs only after the user approves it.** Writing a script action into `automations.json` does not make it run. The automation's page in the app shows the action with "Not approved — will not run" and an **Approve** button; the approval covers the script's exact bytes together with its path, arguments and runtime. **Any change** — to the file, the arguments or the runtime — needs a new approval, and until then every run is refused. A refused run is not silent: it appears in the automation's history with the reason (not approved, changed since approval, or turned off by policy). "Run test" follows the same rule. When you write a script action for the user, tell them to approve it in the app.

**How it runs:**
- **Never through a shell:** the interpreter is started with the script path and `args` as separate arguments. The working directory is the workspace root. Runs of one automation never overlap — a tick while the previous run is still going is skipped and recorded.
- **One self-contained file.** The approved bytes run from a private copy, so a script cannot import sibling files or the workspace's packages; keep it to one file (the interpreter's built-ins are available).
- **Network: allowed.** The script can call external services.
- **No secrets in its environment.** It gets the event variables below (`NESSY_EVENT`, `NESSY_EVENT_DATA`, `NESSY_SESSION_ID`, …), `NESSY_WORKSPACE_PATH`, and `HOME` — nothing else from the app's environment: no `PATH`, no `NESSY_WH_*` webhook secrets, no app tokens. A script that needs a credential reads it itself (for example from a file the user controls); never write a secret into the script.
- **Output** is captured (up to 16 KB each of stdout and stderr) and the outcome is recorded in automation history.

**App events only.** A script action runs on app events (`SchedulerTick`, `LabelAdd`, `LabelRemove`, `LabelConfigChange`, `PermissionModeChange`, `FlagChange`, `SessionStatusChange`). On an agent event (`PreToolUse`, `Stop`, …) it never runs — the configuration check warns about it; use a command hook in `hooks.json` for those.

An organisation policy that turns off local automations refuses script actions too, including a run already scheduled.

Scheduled refresh of a Page is the same mechanism with the script written by the app: see `pages.md`.

## Environment Variables

Both prompt and webhook actions support variable expansion using `$VAR` or `${VAR}` syntax. Script actions receive the `NESSY_*` event variables in their environment instead (see [Script Actions](#script-actions)).

### System Variables (NESSY_*)

These are automatically set by the automation system based on the triggering event:

| Variable | Description | Available For |
|----------|-------------|---------------|
| `$NESSY_EVENT` | Event name (e.g., `LabelAdd`) | All events |
| `$NESSY_EVENT_DATA` | Full event payload as JSON | All events |
| `$NESSY_SESSION_ID` | Session ID | Events with session context |
| `$NESSY_SESSION_NAME` | Session name | Events with session context |
| `$NESSY_WORKSPACE_ID` | Workspace ID | All events |

**Per-event variables:**

| Event | Variable | Description |
|-------|----------|-------------|
| `LabelAdd` / `LabelRemove` | `$NESSY_LABEL` | The label entry that was added/removed (`bug`, `priority::3`) |
| `PermissionModeChange` | `$NESSY_OLD_MODE`, `$NESSY_NEW_MODE` | Previous and new permission mode |
| `FlagChange` | `$NESSY_IS_FLAGGED` | `true` or `false` |
| `SessionStatusChange` | `$NESSY_OLD_STATE`, `$NESSY_NEW_STATE` | Previous and new status |
| `SchedulerTick` | `$NESSY_LOCAL_TIME`, `$NESSY_LOCAL_DATE` | Current time (`14:30`) and date (`2026-03-09`) |

### User-Defined Webhook Secrets (NESSY_WH_*)

For webhook actions, you can define your own secrets by setting environment variables with the `NESSY_WH_` prefix in your shell profile (e.g., `~/.zshrc`, `~/.bashrc`):

```bash
# In your shell profile
export NESSY_WH_SLACK_URL="https://hooks.slack.com/services/T.../B.../xxx"
export NESSY_WH_DISCORD_URL="https://discord.com/api/webhooks/123/abc"
export NESSY_WH_API_TOKEN="your-secret-token"
```

Then reference them in `automations.json`:

```json
{
  "type": "webhook",
  "url": "${NESSY_WH_SLACK_URL}",
  "method": "POST",
  "body": { "text": "Hello from Nessy!" }
}
```

```json
{
  "type": "webhook",
  "url": "https://api.example.com/events",
  "headers": { "Authorization": "Bearer ${NESSY_WH_API_TOKEN}" },
  "body": { "event": "${NESSY_EVENT}", "session": "${NESSY_SESSION_NAME}" }
}
```

This keeps secrets out of `automations.json` (which may be shared or committed to version control).

> **Note:** Only variables prefixed with `NESSY_WH_` are injected into webhook actions. Other environment variables (like `$HOME` or `$DATABASE_URL`) are not accessible to webhooks.

> **Note:** Environment variables are not expanded during test runs (the "Test" button in the UI). Tests send the raw URL/body as configured.

## Matcher Configuration

### Display Name

Use the optional `name` field to give an automation a human-readable display name. If omitted, the name is automatically derived from the first action.

```json
{
  "name": "Morning Weather Report",
  "cron": "0 8 * * *",
  "actions": [
    { "type": "prompt", "prompt": "Run the @weather skill" }
  ]
}
```

### Regex Matching (for most events)

Use the `matcher` field to filter which events trigger your automations:

```json
{
  "matcher": "^urgent$",
  "actions": [
    { "type": "prompt", "prompt": "An urgent label was added. Review the session and summarise the issue." }
  ]
}
```

If `matcher` is omitted, the automation triggers for all events of that type.

### Cron Matching (for SchedulerTick)

For `SchedulerTick` events, use cron expressions instead of regex:

```json
{
  "cron": "0 9 * * 1-5",
  "timezone": "America/New_York",
  "actions": [
    { "type": "prompt", "prompt": "Give me a morning briefing" }
  ]
}
```

**Cron format:** `minute hour day-of-month month day-of-week`

| Field | Values |
|-------|--------|
| Minute | 0-59 |
| Hour | 0-23 |
| Day of month | 1-31 |
| Month | 1-12 |
| Day of week | 0-6 (0 = Sunday) |

**Examples:**
- `*/15 * * * *` - Every 15 minutes
- `0 9 * * *` - Daily at 9:00 AM
- `0 9 * * 1-5` - Weekdays at 9:00 AM
- `30 14 1 * *` - 1st of each month at 2:30 PM

**Timezone:** Use IANA timezone names (e.g., `Europe/Budapest`, `America/New_York`). Defaults to system timezone if not specified.

**Missed runs:** On startup, and when the computer wakes from sleep, a scheduled matcher whose most recent occurrence in the last seven days was missed gets exactly one catch-up run (anything older is discarded, and a matcher seen for the first time is only recorded, never fired). Catch-up runs carry **prompt actions only** — a `script` or `webhook` action missed while the app was closed or asleep is skipped, and its schedule is marked as accounted for so it is not replayed later.

## Conditions

Conditions are optional filters that run **after** the matcher/cron matches but **before** actions fire. All conditions in the array must pass (implicit AND). If the array is empty or omitted, actions fire unconditionally.

```json
{
  "cron": "0 9 * * *",
  "timezone": "Europe/Budapest",
  "conditions": [
    {
      "condition": "time",
      "weekday": ["mon", "tue", "wed", "thu", "fri"]
    }
  ],
  "actions": [
    { "type": "prompt", "prompt": "Good morning! Here's your daily briefing." }
  ]
}
```

### Time Conditions

Check time-of-day and day-of-week in a given timezone.

```json
{
  "condition": "time",
  "after": "09:00",
  "before": "17:00",
  "weekday": ["mon", "tue", "wed", "thu", "fri"],
  "timezone": "Europe/Budapest"
}
```

| Property | Type | Description |
|----------|------|-------------|
| `after` | `"HH:MM"` | Start of time window (inclusive) |
| `before` | `"HH:MM"` | End of time window (exclusive) |
| `weekday` | `string[]` | Allowed days: `mon`, `tue`, `wed`, `thu`, `fri`, `sat`, `sun` |
| `timezone` | string | IANA timezone. Falls back to matcher timezone, then system local |

**Overnight ranges:** If `after` is later than `before` (e.g., `"after": "22:00", "before": "06:00"`), the range wraps across midnight.

### State Conditions

Check fields from the event payload. Useful for filtering on specific transitions or values.

```json
{
  "condition": "state",
  "field": "permissionMode",
  "from": "plan",
  "to": "bypassPermissions"
}
```

| Property | Type | Description |
|----------|------|-------------|
| `field` | string | Payload field name (e.g., `permissionMode`, `sessionStatus`, `labels`, `isFlagged`) |
| `value` | any | Exact match |
| `from` | any | Previous value (for transition events) |
| `to` | any | New value (for transition events) |
| `contains` | string | Array membership check (e.g., check if a label is present) |
| `not_value` | any | Matches anything except this value |

**Transition fields:** For `permissionMode` and `sessionStatus`, `from`/`to` automatically resolve to the correct payload keys (`oldMode`/`newMode`, `oldState`/`newState`).

### Logical Composition

Combine conditions with `and`, `or`, and `not`:

```json
{
  "condition": "and",
  "conditions": [
    { "condition": "time", "weekday": ["mon", "tue", "wed", "thu", "fri"] },
    { "condition": "time", "after": "09:00", "before": "17:00" }
  ]
}
```

```json
{
  "condition": "or",
  "conditions": [
    { "condition": "state", "field": "permissionMode", "value": "bypassPermissions" },
    { "condition": "state", "field": "isFlagged", "value": true }
  ]
}
```

```json
{
  "condition": "not",
  "conditions": [
    { "condition": "time", "weekday": ["sat", "sun"] }
  ]
}
```

| Type | Behaviour |
|------|-----------|
| `and` | All sub-conditions must pass |
| `or` | At least one sub-condition must pass |
| `not` | None of the sub-conditions may pass |

**Nesting depth:** Conditions can be nested up to 8 levels deep. A simplification warning is emitted at depth 4. Unknown condition types fail closed (evaluate to false).

### Semantic Condition (requires the Decision Model)

`conditions` can only compare fields. `semanticCondition` asks a yes/no question that the decision model (Settings → AI → Decision model, toggle "Automation conditions") answers before a prompt action starts a session. Deterministic gates run first and for free — the matcher, the `conditions` array and the loop guard above — so the model is asked only about a run that would otherwise start:

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

| Property | Type | Description |
|----------|------|-------------|
| `question` | string | **Required.** The yes/no question (max 500 characters). |
| `threshold` | number | "Yes" probability needed to run, `0 < threshold <= 1`. Default `0.5`. |

- The model sees the event (name, automation name, payload fields) and, for session events, the session's name, labels, status and its latest user and assistant messages (1,500 characters each).
- Below the threshold the run is skipped and the automation history records it as **skipped** — with the probability, shown in your language — not as failed.
- A matcher is judged once per event: all of its prompt actions run, or all are skipped.
- **Inert without the decision model:** when it is off, unavailable or fails, the automation runs as it would without the condition. A `semanticCondition` never turns a working automation off.
- It gates prompt actions only; webhook and script actions are not gated.

## Permission Mode

The `permissionMode` field controls the permission level of sessions created by prompt actions.

```json
{
  "cron": "*/10 * * * *",
  "permissionMode": "plan",
  "actions": [
    { "type": "prompt", "prompt": "Check system health and log the results" }
  ]
}
```

**Permission modes** (Claude Code's six; an automation with no `permissionMode` runs in `plan`):
- `plan` - Read-only: reads, searches and read-only commands; writes only a plan and the session's data folder (default)
- `dontAsk` - Never prompts: runs only what rules pre-approve and denies the rest
- `default` - Manual: asks before changes
- `acceptEdits` - File edits inside the session's folders run without a prompt; other actions ask
- `auto` - Low-risk actions run; borderline ones are checked
- `bypassPermissions` - Auto-approves all operations

Older spellings still load and are saved in the current spelling: `safe` and the retired `explore` as `plan`, `ask` as `default`, `allow-all` as `bypassPermissions`. The `automation_create` and `automation_update` tools accept only the six current names, and an automation you create or edit is limited to `acceptEdits` or a narrower mode. State conditions and matchers compare the current names, so write `plan` and `bypassPermissions`, not `safe` or `allow-all`.

## Labels for Prompt Actions

Prompt actions can specify labels that will be applied to the session they create:

```json
{
  "cron": "0 9 * * *",
  "labels": ["Scheduled", "morning-briefing"],
  "actions": [
    { "type": "prompt", "prompt": "Give me today's priorities" }
  ]
}
```

This creates a session with the "Scheduled" and "morning-briefing" labels applied automatically.

## Complete Examples

### Daily Weather Report

```json
{
  "version": 2,
  "automations": {
    "SchedulerTick": [
      {
        "name": "Daily Weather Report",
        "cron": "0 8 * * *",
        "timezone": "Europe/Budapest",
        "labels": ["Scheduled", "weather"],
        "actions": [
          { "type": "prompt", "prompt": "Run the @weather skill and give me today's forecast" }
        ]
      }
    ]
  }
}
```

### Weekday-Only AI News (with Conditions)

Use a `time` condition to restrict a daily schedule to weekdays only:

```json
{
  "version": 2,
  "automations": {
    "SchedulerTick": [
      {
        "name": "Morning AI news",
        "cron": "0 9 * * *",
        "timezone": "Europe/Budapest",
        "conditions": [
          {
            "condition": "time",
            "weekday": ["mon", "tue", "wed", "thu", "fri"],
            "timezone": "Europe/Budapest"
          }
        ],
        "labels": ["Scheduled", "ai-news"],
        "actions": [
          { "type": "prompt", "prompt": "Run the @ai-news skill and summarize today's AI developments" }
        ]
      }
    ]
  }
}
```

### Permission Mode Gate (with Conditions)

Only notify when permission mode changes specifically from `plan` to `bypassPermissions`:

```json
{
  "version": 2,
  "automations": {
    "PermissionModeChange": [
      {
        "conditions": [
          {
            "condition": "state",
            "field": "permissionMode",
            "from": "plan",
            "to": "bypassPermissions"
          }
        ],
        "actions": [
          {
            "type": "webhook",
            "url": "${NESSY_WH_SLACK_URL}",
            "method": "POST",
            "body": { "text": ":warning: Permission escalated from plan to bypassPermissions in *${NESSY_SESSION_NAME}*" }
          }
        ]
      }
    ]
  }
}
```

### Log Label Changes

```json
{
  "version": 2,
  "automations": {
    "LabelAdd": [
      {
        "actions": [
          { "type": "prompt", "prompt": "The label $NESSY_LABEL was added. Log this change with a timestamp." }
        ]
      }
    ],
    "LabelRemove": [
      {
        "actions": [
          { "type": "prompt", "prompt": "The label $NESSY_LABEL was removed. Log this change with a timestamp." }
        ]
      }
    ]
  }
}
```

### Urgent Label Notification

```json
{
  "version": 2,
  "automations": {
    "LabelAdd": [
      {
        "matcher": "^urgent$",
        "actions": [
          { "type": "prompt", "prompt": "An urgent label was added to this session. Triage the session and summarise what needs immediate attention." }
        ]
      }
    ]
  }
}
```

### Permission Mode Change Notification

```json
{
  "version": 2,
  "automations": {
    "PermissionModeChange": [
      {
        "matcher": "bypassPermissions",
        "actions": [
          { "type": "prompt", "prompt": "The permission mode was changed to bypassPermissions. Log the change and note any security implications." }
        ]
      }
    ]
  }
}
```

### Slack Notification on Status Change

Sends a Slack message when a session is marked as done. Requires `NESSY_WH_SLACK_URL` in your shell profile.

```json
{
  "version": 2,
  "automations": {
    "SessionStatusChange": [
      {
        "name": "Notify Slack on Done",
        "matcher": "^done$",
        "actions": [
          {
            "type": "webhook",
            "url": "${NESSY_WH_SLACK_URL}",
            "method": "POST",
            "body": {
              "text": ":white_check_mark: Session *${NESSY_SESSION_NAME}* marked as done"
            }
          }
        ]
      }
    ]
  }
}
```

### Mixed Actions (Prompt + Webhook)

A single automation can have both prompt and webhook actions. They execute in order.

```json
{
  "version": 2,
  "automations": {
    "LabelAdd": [
      {
        "name": "Urgent: Notify and Triage",
        "matcher": "^urgent$",
        "actions": [
          {
            "type": "webhook",
            "url": "${NESSY_WH_SLACK_URL}",
            "method": "POST",
            "body": { "text": ":rotating_light: Urgent label added to *${NESSY_SESSION_NAME}*" }
          },
          {
            "type": "prompt",
            "prompt": "An urgent label was added. Triage the session and summarise what needs immediate attention."
          }
        ]
      }
    ]
  }
}
```

### Form-Encoded Request (OAuth / Stripe)

```json
{
  "version": 2,
  "automations": {
    "SchedulerTick": [
      {
        "name": "Refresh API Token",
        "cron": "0 */6 * * *",
        "actions": [
          {
            "type": "webhook",
            "url": "https://auth.example.com/oauth/token",
            "method": "POST",
            "bodyFormat": "form",
            "body": {
              "grant_type": "client_credentials",
              "client_id": "${NESSY_WH_CLIENT_ID}",
              "client_secret": "${NESSY_WH_CLIENT_SECRET}"
            }
          }
        ]
      }
    ]
  }
}
```

### Webhook with Custom Headers

```json
{
  "version": 2,
  "automations": {
    "SessionStatusChange": [
      {
        "name": "Log to External API",
        "actions": [
          {
            "type": "webhook",
            "url": "https://api.example.com/nessy-events",
            "method": "POST",
            "headers": {
              "Authorization": "Bearer ${NESSY_WH_API_TOKEN}",
              "X-Source": "nessy"
            },
            "body": {
              "event": "${NESSY_EVENT}",
              "session_id": "${NESSY_SESSION_ID}",
              "old_status": "${NESSY_OLD_STATE}",
              "new_status": "${NESSY_NEW_STATE}"
            }
          }
        ]
      }
    ]
  }
}
```

## Validation

Automations are validated when:
1. The workspace is loaded
2. You edit automations.json (via PreToolUse hook)
3. You run `config_validate` with target `automations` or `all`

**Using config_validate:**

Ask Nessy to validate your automations configuration:

```
Validate my automations configuration
```

Or use the `config_validate` tool directly with `target: "automations"`.

**Common validation errors:**
- Invalid JSON syntax
- Unknown event names
- Empty actions array
- Invalid cron expression
- Invalid timezone
- Invalid regex pattern
- Potentially unsafe regex patterns (nested quantifiers)

**To validate manually:**

```bash
# Check automations.json syntax
jq . "${NESSY_CONFIG_DIR:-$HOME/.nessy-agent}/workspaces/{workspaceId}/automations.json"
```

## Retry Behavior

Webhook actions have two levels of automatic retry:

### Immediate retry (transient failures)

When a webhook fails with a server error (5xx), timeout, or connection error, it is automatically retried up to **2 times** with exponential backoff (1s → 2s → 4s). Client errors (4xx) are not retried — they indicate a configuration problem.

### Deferred retry (extended outages)

If all immediate retries fail, the webhook is added to a **persistent retry queue**. The queue retries at increasing intervals:

| Attempt | Delay | Cumulative |
|---------|-------|------------|
| 1st deferred | 5 minutes | 5 min |
| 2nd deferred | 30 minutes | 35 min |
| 3rd deferred | 1 hour | ~1.5 hours |

After the final deferred attempt fails, the webhook is marked as permanently failed in the history. Deferred retries survive app restarts.

> **Note:** Only transient failures (5xx, timeouts, connection errors) are retried. Client errors (4xx) indicate a configuration problem and should be fixed in `automations.json`.

> **Retry and rate limiting:** Retried webhook requests count toward the per-endpoint rate limit (30/min per origin). If a retry would exceed the limit, it is deferred to the next retry window.

## Rate Limits

To protect against runaway automations (e.g., an automation that indirectly triggers itself in a loop), the event bus enforces per-event-type rate limits:

| Event | Max fires / minute |
|-------|--------------------|
| `SchedulerTick` | 60 (1/sec) |
| All others (`LabelAdd`, `FlagChange`, `PreToolUse`, etc.) | 10 |

When a limit is hit, further events of that type are **silently dropped** for the remainder of the 60-second window. A warning is logged. The window resets automatically.

**Example:** If you have a `LabelAdd` task that triggers a prompt which adds a label back to a session, it will fire at most 10 times before being rate-limited — preventing infinite session creation.

## Troubleshooting

### Automation not firing

1. **Check event name** - Must be exact (e.g., `LabelAdd` not `labeladd`)
2. **Check matcher** - Regex must match the event value
3. **Check cron** - For SchedulerTick, verify cron expression with an online tool
4. **Check logs** - Look for `[automations]` or `[Scheduler]` in the logs
5. **Check when it was missed** - If the app was closed or the computer asleep at the scheduled time, only prompt actions catch up on the next start or wake; a missed script or webhook action is skipped

### Prompt not creating session

1. Check that the prompt is not empty
2. Verify @mentions reference valid sources/skills

### Webhook not working

1. **Check URL** — Must be a valid `http://` or `https://` URL. Other protocols (ftp, ws, etc.) are rejected at runtime with a clear error.
2. **Check env vars** — Ensure `NESSY_WH_*` variables are set in your shell profile and Nessy was restarted after adding them. URLs using `$VAR` templates are validated after variable expansion — if the variable is empty or unset, the URL will be invalid.
3. **Use the Test button** — Tests connectivity to the URL (note: env vars are not expanded during test)
4. **Check method** — Some endpoints require specific HTTP methods (POST, PUT, etc.)
5. **Check response** — The automation history shows HTTP status codes for webhook executions

### Retrying failed webhooks

When a webhook execution fails (shown with a red indicator in the timeline), you can retry it:

1. Open the automation's detail page
2. In the "Recent Activity" timeline, failed webhook entries show a **Retry** button
3. Click "Retry" to re-execute the webhook actions immediately
4. The retry result is recorded as a new history entry

> **Note:** Retries execute the webhook actions as currently configured. If you've changed the URL or headers since the original failure, the retry uses the updated configuration. Environment variables are not expanded during replay (same as the Test button).

## Best Practices

1. **Start simple** - Test with a basic prompt before building complex workflows
2. **Use labels** - Tag scheduled sessions for easy filtering
3. **Be specific** - Use matchers to avoid triggering on every event
4. **Test cron** - Use [crontab.guru](https://crontab.guru/) to verify expressions
5. **Keep secrets out of config** - Use `NESSY_WH_*` env vars for webhook URLs and tokens instead of hardcoding them in automations.json
6. **Combine actions** - Use both webhook and prompt actions in a single automation for notification + AI response workflows
