# CLI Client

The terminal client connects to a [headless server](/server/headless) over WebSocket and covers the day-to-day loop: create sessions, send prompts with live streaming, list resources, and health-check a deployment. This page is workflow-oriented; every flag, event, and exit code is documented in the [CLI Reference](/reference/cli).

## Installation

From the repository root:

```bash
bun install --frozen-lockfile

# Option A — invoke the entry point directly (used in all examples)
bun run apps/cli/src/index.ts <command>

# Option B — put it on your PATH as `nessy-general-agent`
cd apps/cli && bun link
```

The linked binary keeps the upstream name `nessy-general-agent` for compatibility; both invocations run the same code.

## Quick Start

### 1. Start a server

```bash
export NESSY_SERVER_TOKEN=$(openssl rand -hex 32)
echo "$NESSY_SERVER_TOKEN"   # keep this — you need it on the client side
bun run packages/server/src/index.ts
```

The server refuses tokens shorter than 16 characters; `bun run packages/server/src/index.ts --generate-token` prints a strong one if you prefer. On startup it echoes its address as a `NESSY_SERVER_URL=` line.

### 2. Point the client at it

```bash
export NESSY_SERVER_URL=ws://127.0.0.1:9100
export NESSY_SERVER_TOKEN=<your-token>
```

Flags (`--url`, `--token`) override these variables when set.

### 3. Check connectivity

```bash
bun run apps/cli/src/index.ts ping
# Connected: clientId=a1b2c3d4-... latency=12ms
```

### 4. Work

```bash
bun run apps/cli/src/index.ts sessions
bun run apps/cli/src/index.ts send <session-id> "What changed in the last commit?"
```

## Common Workflows

### Diagnose a configuration without any server

Two command families need no server at all — they read local state and exit:

```bash
# Which managed settings source is in effect, what failed validation, which
# user settings layers were rejected whole. Exit 1 when something is found.
bun run apps/cli/src/index.ts doctor
bun run apps/cli/src/index.ts --json doctor | jq '.invalidManagedEntries'

# Plugin authoring and inventory
bun run apps/cli/src/index.ts plugin validate ./my-plugin --strict
bun run apps/cli/src/index.ts plugin list
bun run apps/cli/src/index.ts plugin details my-plugin
```

When a broken skill, plugin, hook, or MCP server keeps sessions from working,
start with `--safe-mode` (or `NESSY_SAFE_MODE=1`): no third-party
configuration is loaded, while managed policy still applies — then fix the
offending piece and restart normally.

### One-off prompts without a server

`run` boots a private server, creates a session, streams the answer, and cleans everything up:

```bash
# Anthropic key from the environment
ANTHROPIC_API_KEY=sk-... bun run apps/cli/src/index.ts run "Summarize the project structure"

# Register a directory as the workspace and enable a source
bun run apps/cli/src/index.ts run --workspace-dir ./my-project --source my-api "List open items"

# Nessy Gateway
JWT=$(python3 -c "import json;print(json.load(open('$HOME/.nessy/dp_auth_creds.json'))['jwt'])")
bun apps/cli/src/index.ts run \
  --provider openai \
  --base-url https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1 \
  --api-key "$JWT" \
  --model tgpt/deepseek-v4-flash-0731 \
  --workspace-dir "$TMPDIR/ws" \
  "What is 2+2?"

# Line-delimited JSON events for CI logs
bun run apps/cli/src/index.ts run --output-format stream-json "Run the test suite"
```

The credential is taken from `--api-key`, `$LLM_API_KEY`, or a provider-specific variable such as `$OPENAI_API_KEY` — the resolution order and provider table are in the [reference](/reference/cli#run-one-shot-and-self-contained). A rejected gateway JWT shows up as a 401-class `Invalid API Key` error.

### Validate a deployment

After installing or updating a server, run the built-in integration pass:

```bash
# Against the running server
bun run apps/cli/src/index.ts --validate-server --url ws://127.0.0.1:9100 --token "$NESSY_SERVER_TOKEN"

# Or let it spawn (and stop) a throwaway local server
bun run apps/cli/src/index.ts --validate-server
```

The pass walks 40 steps: connectivity, credential health, workspace and session listing, streaming turns, tool use, session tools, branching, source/skill/automation lifecycles, and cleanup.

::: warning
Validation creates and deletes temporary resources (sessions, a source, a skill, labels, automation config). Existing automation files are backed up and restored, but avoid running it against a workspace you care about.
:::

For scripts, `--json` returns a summary object:

```bash
bun run apps/cli/src/index.ts --validate-server --json | jq '.failed'
# 0 means every step passed
```

### Manage sessions

```bash
# Create one with a name and a permission mode
bun run apps/cli/src/index.ts session create --name "Code Review" --mode plan

# Inspect
bun run apps/cli/src/index.ts sessions
bun run apps/cli/src/index.ts session messages <id>

# Stop a runaway turn, then remove the session
bun run apps/cli/src/index.ts cancel <id>
bun run apps/cli/src/index.ts session delete <id>
```

`--mode` accepts `dontAsk`, `plan`, `default`, `acceptEdits`, `auto`, or `bypassPermissions` — see [Permissions](/core-concepts/permissions). The retired `explore` (read as `plan`) and legacy spellings such as `safe`, `ask`, and `allow-all` stay accepted and resolve to the current modes.

### Stream replies and pipe input

`send` prints the assistant's answer to stdout as it is generated, with `[tool: …]` markers for tool calls:

```bash
bun run apps/cli/src/index.ts send abc-123 "Explain the authentication flow"
```

When no inline message is given, the prompt is read from piped stdin:

```bash
cat error.log | bun run apps/cli/src/index.ts send abc-123
git diff HEAD~1 | bun run apps/cli/src/index.ts send abc-123
```

Exit codes distinguish outcomes: `0` on completion, `1` on error or send timeout, `130` when the turn was interrupted.

### Script with JSON output

Every command accepts `--json`:

```bash
# All workspace IDs
bun run apps/cli/src/index.ts --json workspaces | jq -r '.[].id'

# Session count
bun run apps/cli/src/index.ts --json sessions | jq length

# Create a session and capture its ID
SESSION=$(bun run apps/cli/src/index.ts --json session create --name "CI" | jq -r '.id')
```

### CI pipeline example

```bash
#!/bin/bash
set -e

# Fail the job unless the server passes validation
bun run apps/cli/src/index.ts --validate-server --json | jq -e '.failed == 0'

# One session per pipeline run
SESSION=$(bun run apps/cli/src/index.ts --json session create --name "CI-${CI_BUILD_ID}" | jq -r '.id')

bun run apps/cli/src/index.ts send "$SESSION" "Run the test suite and report failures"

bun run apps/cli/src/index.ts session delete "$SESSION"
```

## Raw RPC Access

Channels without a dedicated command are reachable through the escape hatches:

```bash
# One-off request on any channel (arguments parsed as JSON)
bun run apps/cli/src/index.ts invoke system:homeDir
bun run apps/cli/src/index.ts invoke sessions:get '"workspace-123"'

# Print push events until Ctrl+C
bun run apps/cli/src/index.ts listen session:event
```

## Going Further

The [CLI Reference](/reference/cli) documents every flag with defaults, the streaming event table, output formats, exit codes, and troubleshooting. Server-side configuration lives in [Headless Server](/server/headless).
