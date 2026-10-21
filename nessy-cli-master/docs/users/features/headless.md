# Headless Mode

Headless mode allows you to run Nessy CLI programmatically from command line
scripts and automation tools without any interactive UI. This is ideal for
scripting, automation, CI/CD pipelines, and building AI-powered tools.

## Overview

The headless mode provides a headless interface to Nessy CLI that:

- Accepts prompts via command line arguments or stdin
- Returns structured output (text or JSON)
- Supports file redirection and piping
- Enables automation and scripting workflows
- Provides consistent exit codes for error handling
- Can resume previous sessions scoped to the current project for multi-step automation

## Basic Usage

### Direct Prompts

Use the `--prompt` (or `-p`) flag to run in headless mode:

```bash
nessy --prompt "What is machine learning?"
```

### Stdin Input

Pipe input to Nessy CLI from your terminal:

```bash
echo "Explain this code" | nessy
```

### Combining with File Input

Read from files and process with Nessy CLI:

```bash
cat README.md | nessy --prompt "Summarize this documentation"
```

### Resume Previous Sessions (Headless)

Reuse conversation context from the current project in headless scripts:

```bash
# Continue the most recent session for this project and run a new prompt
nessy --continue -p "Run the tests again and summarize failures"

# Resume a specific session ID directly (no UI)
nessy --resume 123e4567-e89b-12d3-a456-426614174000 -p "Apply the follow-up refactor"
```

> [!note]
>
> - Session data is project-scoped JSONL under `~/.nessy/projects/<sanitized-cwd>/chats`.
> - Restores conversation history, tool outputs, and chat-compression checkpoints before sending the new prompt.

## Customize the Main Session Prompt

You can change the main session system prompt for a single CLI run without editing shared memory files.

### Override the Built-in System Prompt

Use `--system-prompt` to replace Nessy CLI's built-in main-session prompt for the current run:

```bash
nessy -p "Review this patch" --system-prompt "You are a terse release reviewer. Report only blocking issues."
```

### Append Extra Instructions

Use `--append-system-prompt` to keep the built-in prompt and add extra instructions for this run:

```bash
nessy -p "Review this patch" --append-system-prompt "Be terse and focus on concrete findings."
```

You can combine both flags when you want a custom base prompt plus an extra run-specific instruction:

```bash
nessy -p "Summarize this repository" \
  --system-prompt "You are a migration planner." \
  --append-system-prompt "Return exactly three bullets."
```

> [!note]
>
> - `--system-prompt` applies only to the current run's main session.
> - Loaded memory and context files such as `NESSY.md` are still appended after `--system-prompt`.
> - `--append-system-prompt` is applied after the built-in prompt and loaded memory, and can be used together with `--system-prompt`.

## Output Formats

Nessy CLI supports multiple output formats for different use cases:

### Text Output (Default)

Standard human-readable output:

```bash
nessy -p "What is the capital of France?"
```

Response format:

```
The capital of France is Paris.
```

### JSON Output

Returns structured data as a JSON array. All messages are buffered and output together when the session completes. This format is ideal for programmatic processing and automation scripts.

The JSON output is an array of message objects. The output includes multiple message types: system messages (session initialization), assistant messages (AI responses), and result messages (execution summary).

#### Example Usage

```bash
nessy -p "What is the capital of France?" --output-format json
```

Output (at end of execution):

```json
[
  {
    "type": "system",
    "subtype": "session_start",
    "uuid": "...",
    "session_id": "...",
    "model": "qwen3-coder-plus",
    ...
  },
  {
    "type": "assistant",
    "uuid": "...",
    "session_id": "...",
    "message": {
      "id": "...",
      "type": "message",
      "role": "assistant",
      "model": "qwen3-coder-plus",
      "content": [
        {
          "type": "text",
          "text": "The capital of France is Paris."
        }
      ],
      "usage": {...}
    },
    "parent_tool_use_id": null
  },
  {
    "type": "result",
    "subtype": "success",
    "uuid": "...",
    "session_id": "...",
    "is_error": false,
    "duration_ms": 1234,
    "result": "The capital of France is Paris.",
    "usage": {...}
  }
]
```

### Stream-JSON Output

Stream-JSON format emits JSON messages immediately as they occur during execution, enabling real-time monitoring. This format uses line-delimited JSON where each message is a complete JSON object on a single line.

```bash
nessy -p "Explain TypeScript" --output-format stream-json
```

Output (streaming as events occur):

```json
{"type":"system","subtype":"session_start","uuid":"...","session_id":"..."}
{"type":"assistant","uuid":"...","session_id":"...","message":{...}}
{"type":"result","subtype":"success","uuid":"...","session_id":"..."}
```

When combined with `--include-partial-messages`, additional stream events are emitted in real-time (message_start, content_block_delta, etc.) for real-time UI updates.

```bash
nessy -p "Write a Python script" --output-format stream-json --include-partial-messages
```

### Input Format

The `--input-format` parameter controls how Nessy CLI consumes input from standard input:

- **`text`** (default): Standard text input from stdin or command-line arguments
- **`stream-json`**: JSON message protocol via stdin for bidirectional communication

> **Note:** Stream-json input mode is currently under construction and is intended for SDK integration. It requires `--output-format stream-json` to be set.

### File Redirection

Save output to files or pipe to other commands:

```bash
# Save to file
nessy -p "Explain Docker" > docker-explanation.txt
nessy -p "Explain Docker" --output-format json > docker-explanation.json

# Append to file
nessy -p "Add more details" >> docker-explanation.txt

# Pipe to other tools
nessy -p "What is Kubernetes?" --output-format json | jq '.response'
nessy -p "Explain microservices" | wc -w
nessy -p "List programming languages" | grep -i "python"

# Stream-JSON output for real-time processing
nessy -p "Explain Docker" --output-format stream-json | jq '.type'
nessy -p "Write code" --output-format stream-json --include-partial-messages | jq '.event.type'
```

## Configuration Options

Key command-line options for headless usage:

| Option                       | Description                                                                     | Example                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `--prompt`, `-p`             | Run in headless mode                                                            | `nessy -p "query"`                                                        |
| `--output-format`, `-o`      | Specify output format (text, json, stream-json)                                 | `nessy -p "query" --output-format json`                                   |
| `--input-format`             | Specify input format (text, stream-json)                                        | `nessy --input-format text --output-format stream-json`                   |
| `--include-partial-messages` | Include partial messages in stream-json output                                  | `nessy -p "query" --output-format stream-json --include-partial-messages` |
| `--system-prompt`            | Override the main session system prompt for this run                            | `nessy -p "query" --system-prompt "You are a terse reviewer."`            |
| `--append-system-prompt`     | Append extra instructions to the main session system prompt for this run        | `nessy -p "query" --append-system-prompt "Focus on concrete findings."`   |
| `--debug`, `-d`              | Enable debug mode                                                               | `nessy -p "query" --debug`                                                |
| `--all-files`, `-a`          | Include all files in context                                                    | `nessy -p "query" --all-files`                                            |
| `--include-directories`      | Include additional directories                                                  | `nessy -p "query" --include-directories src,docs`                         |
| `--approval-mode`            | Set approval mode                                                               | `nessy -p "query" --approval-mode auto_edit`                              |
| `--continue`                 | Resume the most recent session for this project                                 | `nessy --continue -p "Pick up where we left off"`                         |
| `--resume [sessionId]`       | Resume a specific session (or choose interactively)                             | `nessy --resume 123e... -p "Finish the refactor"`                         |
| `--max-session-turns`        | Cap the number of user/model/tool turns in the run                              | `nessy -p "..." --max-session-turns 30`                                   |
| `--max-wall-time`            | Wall-clock budget; accepts `90` (s), `30s`, `5m`, `1h`, `1.5h`                  | `nessy -p "..." --max-wall-time 10m`                                      |
| `--max-tool-calls`           | Cumulative tool-call budget for the run                                         | `nessy -p "..." --max-tool-calls 50`                                      |
| `--bare`                     | Minimal mode: ignore settings-based startup discovery, use a fixed core toolset | `nessy -p "query" --bare`                                                 |

For complete details on all available configuration options, settings files, and environment variables, see the [Configuration Guide](../configuration/settings).

### Bare mode

`--bare` (env equivalent: `NESSY_CLI_SIMPLE=1`) drops every implicit startup input and honors only what you pass on the command line. Intended for batch / unattended runs where startup discovery is both slow and unnecessary.

Not applied in bare mode:

- user / workspace / system `settings.json` are not loaded at all, the settings watcher does not start, and nothing is ever persisted back (including the model resolved by `--auth-type dp-auth`)
- tool configuration from settings (`tools.core`, `tools.allowed`, `tools.exclude`, `permissions.allow` / `ask` / `deny`) and the `--core-tools` flag
- MCP servers from `settings.json` and `.mcp.json`, plus `mcp.allowed` / `mcp.excluded`
- all hooks (`disableAllHooks` is forced on), managed auto-memory, auto-dream, auto-skill, LSP
- `context.includeDirectories`, `output-language.md`, `tools.discoveryCommand`, `tools.callCommand`, `tools.approvalMode`, `security.auth.selectedType`

Still honored: the fixed core toolset (`read_file`, `edit`, `notebook_edit`, `shell`) and explicit flags — `--allowed-tools`, `--include-directories`, `--mcp-config`, `--approval-mode`, `--model`, `--auth-type`.

**Caveat — `--bare --approval-mode auto`:** the startup denylist that a normal `nessy -p` run builds for write/execute tools is not applied in bare mode. Under `default` / `plan` / `auto-edit` this changes nothing observable — a tool that would need confirmation is still refused at call time, because non-interactive runs cannot prompt. Under `auto` it does: without the denylist the AUTO classifier is reached, so `shell`, `edit` and `write_file` can be approved and actually run, where a non-bare `-p --approval-mode auto` refuses them outright. Use `--bare --approval-mode auto` only in directories you trust.

#### Combining with other flags

| Combination                          | Notes                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `--bare --auth-type dp-auth`         | `--auth-type` is required: `security.auth.selectedType` from settings is ignored. The resolved model is not saved. |
| `--bare -p "…" --output-format json` | Standard headless batch shape; the JSON envelope is unaffected by bare mode.                                       |
| `--bare --mcp-config …`              | The only way to get MCP servers in bare mode — settings-based servers are dropped.                                 |
| `--bare --allowed-tools shell,edit`  | Explicit allow rules from the CLI still apply.                                                                     |

```bash
nessy -p "reply with a single word: Pong" --bare --auth-type dp-auth
```

### Run-level budgets

Nessy CLI can abort an unattended run when it crosses one of the following thresholds. Each is `-1` (unlimited) by default; setting any one is enough to bound runaway behavior. They are enforced cooperatively against the same `AbortController` that already carries SIGINT, so a budget abort emits a structured `FatalBudgetExceededError` (exit code **55**) — distinct from the turn-cap exit code 53 and SIGINT's 130 so CI scripts can branch on the reason.

| Flag                  | Settings key               | What it bounds                                                                                                                                                                                                |
| --------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--max-wall-time`     | `model.maxWallTimeSeconds` | Wall-clock duration of the whole run. Flag accepts `90` (s), `30s`, `5m`, `1h`, `1.5h` (fractional units supported). Minimum 1s — sub-second values are rejected as typos. Settings is seconds.               |
| `--max-tool-calls`    | `model.maxToolCalls`       | Cumulative top-level tool calls dispatched by the main run loop (counts successes _and_ failures — the model still consumes tokens on errors). See "Scope" below for subagent / structured-output exemptions. |
| `--max-session-turns` | `model.maxSessionTurns`    | Number of user/model/tool turns; pre-existing. Exits with code 53 on overrun (distinct from budget exit 55).                                                                                                  |

#### Scope

- **`--max-tool-calls` counts top-level dispatches only.** When the model calls the `agent` tool, the dispatch counts as **1**; inner tool calls performed by the spawned subagent are **not** counted. A model that funnels work through subagents can do unbounded inner work under a small top-level budget. Combine with `--exclude-tools agent` if you need a tighter cap.
- **`structured_output` is exempt from `--max-tool-calls`.** Under `--json-schema`, the model's terminal `structured_output` call is the "I'm done" contract, not real work — it doesn't count against `--max-tool-calls` so a budget-edge completion isn't aborted as a false positive. The exemption is unconditional (including failed Ajv validations), so a model stuck in a malformed-output retry loop is NOT bounded by `--max-tool-calls`; combine with `--max-session-turns` or `--max-wall-time` to cap retries.
- **`structured_output` is NOT exempt from `--max-session-turns`.** That counter is pre-existing and bumps for every turn including the terminal contract. Size `--max-session-turns` to `N+1` if you want to allow `N` real-work turns under `--json-schema`.
- **Single-shot vs `--input-format stream-json`:** in stream-json input mode the daemon resets the budget counters at the start of every user message; the budget is per-message, not per-process.
- **`nessy serve` / ACP sessions:** the daemon ACP session path does NOT currently consult `--max-wall-time` / `--max-tool-calls` from settings.json. These budgets only apply to single-shot `nessy -p` runs and to `--input-format stream-json` sessions.

### Recommended combinations

- **Trusted, isolated environment (ephemeral CI runner, container):** `nessy -p "..." --aoprove-mode=auto --max-session-turns N --max-wall-time 10m --output-format json`. Pin a turn budget and a wall-clock budget so a stuck agent can't burn through your CI minutes, and capture `--output-format json` for post-run usage / tool-call auditing.
- **Local machine or shared infra:** also pass `--sandbox` (or set `NESSY_SANDBOX=1`) so shell / write / edit tools run inside the sandbox image.
- **Long-running CI with retry-on-rate-limit:** combine `NESSY_CLI_UNATTENDED_RETRY=1` with `--max-wall-time`. The retry env keeps the run alive past transient 429 / 529 responses; the wall-clock budget ensures a persistently-failing provider can't extend the job indefinitely.
- **Bounded auditing / exploration:** for read-only tasks, `--max-tool-calls 25` caps how aggressively the model can grep / read. Combine with `--exclude-tools shell,write,edit` to make the bound meaningful.

## Examples

### Code review

```bash
cat src/auth.py | nessy -p "Review this authentication code for security issues" > security-review.txt
```

### Generate commit messages

```bash
result=$(git diff --cached | nessy -p "Write a concise commit message for these changes" --output-format json)
echo "$result" | jq -r '.response'
```

### API documentation

```bash
result=$(cat api/routes.js | nessy -p "Generate OpenAPI spec for these routes" --output-format json)
echo "$result" | jq -r '.response' > openapi.json
```

### Batch code analysis

```bash
for file in src/*.py; do
    echo "Analyzing $file..."
    result=$(cat "$file" | nessy -p "Find potential bugs and suggest improvements" --output-format json)
    echo "$result" | jq -r '.response' > "reports/$(basename "$file").analysis"
    echo "Completed analysis for $(basename "$file")" >> reports/progress.log
done
```

### MR code review

```bash
result=$(git diff origin/main...HEAD | nessy -p "Review these changes for bugs, security issues, and code quality" --output-format json)
echo "$result" | jq -r '.response' > pr-review.json
```

### Log analysis

```bash
grep "ERROR" /var/log/app.log | tail -20 | nessy -p "Analyze these errors and suggest root cause and fixes" > error-analysis.txt
```

### Release notes generation

```bash
result=$(git log --oneline v1.0.0..HEAD | nessy -p "Generate release notes from these commits" --output-format json)
response=$(echo "$result" | jq -r '.response')
echo "$response"
echo "$response" >> CHANGELOG.md
```

### Model and tool usage tracking

```bash
result=$(nessy -p "Explain this database schema" --include-directories db --output-format json)
total_tokens=$(echo "$result" | jq -r '.stats.models // {} | to_entries | map(.value.tokens.total) | add // 0')
models_used=$(echo "$result" | jq -r '.stats.models // {} | keys | join(", ") | if . == "" then "none" else . end')
tool_calls=$(echo "$result" | jq -r '.stats.tools.totalCalls // 0')
tools_used=$(echo "$result" | jq -r '.stats.tools.byName // {} | keys | join(", ") | if . == "" then "none" else . end')
echo "$(date): $total_tokens tokens, $tool_calls tool calls ($tools_used) used with models: $models_used" >> usage.log
echo "$result" | jq -r '.response' > schema-docs.md
echo "Recent usage trends:"
tail -5 usage.log
```

## Persistent Retry Mode

When Nessy CLI runs in CI/CD pipelines or as a background daemon, a brief API outage (rate limiting or overload) should not kill a multi-hour task. **Persistent retry mode** makes Nessy CLI retry transient API errors indefinitely until the service recovers.

### How it works

- **Transient errors only**: HTTP 429 (Rate Limit) and 529 (Overloaded) are retried indefinitely. Other errors (400, 500, etc.) still fail normally.
- **Exponential backoff with cap**: Retry delays grow exponentially but are capped at **5 minutes** per retry.
- **Heartbeat keepalive**: During long waits, a status line is printed to stderr every **30 seconds** to prevent CI runners from killing the process due to inactivity.
- **Graceful degradation**: Non-transient errors and interactive mode are completely unaffected.

### Activation

Set the `NESSY_CLI_UNATTENDED_RETRY` environment variable to `true` or `1` (strict match, case-sensitive):

```bash
export NESSY_CLI_UNATTENDED_RETRY=1
```

> [!important]
> Persistent retry requires an **explicit opt-in**. `CI=true` alone does **not** activate it — silently turning a fast-fail CI job into an infinite-wait job would be dangerous. Always set `NESSY_CLI_UNATTENDED_RETRY` explicitly in your pipeline configuration.

### Examples

#### GitHub Actions

```yaml
- name: Automated code review
  env:
    NESSY_CLI_UNATTENDED_RETRY: '1'
  run: |
    nessy -p "Review all files in src/ for security issues" \
      --output-format json \
      > review.json
```

#### Overnight batch processing

```bash
export NESSY_CLI_UNATTENDED_RETRY=1
nessy -p "Migrate all callback-style functions to async/await in src/" --approve-mode=auto
```

#### Background daemon

```bash
NESSY_CLI_UNATTENDED_RETRY=1 nohup nessy -p "Audit all dependencies for known CVEs" \
  --output-format json > audit.json 2> audit.log &
```

### Monitoring

During persistent retry, heartbeat messages are printed to **stderr**:

```
[nessy-cli] Waiting for API capacity... attempt 3, retry in 45s
[nessy-cli] Waiting for API capacity... attempt 3, retry in 15s
```

These messages keep CI runners alive and let you monitor progress. They do not appear in stdout, so JSON output piped to other tools remains clean.

## Resources

- [CLI Configuration](../configuration/settings#command-line-arguments) - Complete configuration guide
- [Authentication](../configuration/settings#environment-variables-for-api-access) - Setup authentication
- [Commands](../features/commands) - Interactive commands reference
- [Tutorials](../quickstart) - Step-by-step automation guides
