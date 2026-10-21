# nessy-general-agent — CLI Reference

Terminal client for Nessy Desktop server. Connects over WebSocket (`ws://` or `wss://`) to a running headless server.

## Prerequisites

- [Bun](https://bun.sh/) runtime installed
- For `run` and `--validate-server`: an API key via `--api-key`, `$LLM_API_KEY`, or a provider-specific env var (e.g., `$ANTHROPIC_API_KEY`). Both spawn their own server.
- For `doctor`, `plugin validate|list|details` and `--version`: **nothing.** They run offline against local configuration and need neither a server nor a key.
- For every other command: a running Nessy Desktop headless server with URL and token

## Installation

```bash
# From the repository root
bun install

# Option A: Run directly
bun run apps/cli/src/index.ts <command>

# Option B: Link globally (adds nessy-general-agent to PATH)
cd apps/cli && bun link
nessy-general-agent <command>
```

### Quick Start

The fastest way to try it out — no server setup needed:

```bash
# Self-contained run (spawns a server automatically)
ANTHROPIC_API_KEY=sk-... bun run apps/cli/src/index.ts run "Hello, world!"
```

## Connection Options

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--url <ws[s]://...>` | `NESSY_SERVER_URL` | — | Server WebSocket URL |
| `--token <secret>` | `NESSY_SERVER_TOKEN` | — | Authentication token |
| `--workspace <id>` | — | auto-detect | Workspace ID |
| `--timeout <ms>` | — | `10000` | Request timeout |
| `--tls-ca <path>` | `NESSY_TLS_CA` | — | Custom CA cert for self-signed TLS |
| `--json` | — | `false` | Raw JSON output for scripting |
| `--send-timeout <ms>` | — | `300000` | Timeout for `send` command (5 min) |
| `--safe-mode` | `NESSY_SAFE_MODE=1` | `false` | Start with no CLAUDE.md, skills, plugins, hooks, MCP servers, commands or agents loaded, for troubleshooting a broken configuration. **Managed policy still applies** — safe mode is a diagnostic, not a way out of org policy. |
| `--verbose`, `-v` | — | `false` | Show server stderr output |
| `--no-spinner` / `--disable-spinner` | — | `false` | Suppress the progress spinner |
| `--help`, `-h` | — | — | Print the built-in help |
| `--version` | — | — | Print the CLI package version and exit |

Flags take precedence over environment variables. If `--workspace` is omitted, the CLI auto-detects the first available workspace.

## Commands

### Info & Health

```bash
nessy-general-agent ping              # Verify connectivity (clientId + latency)
nessy-general-agent health            # Check credential store health
nessy-general-agent versions          # Show server runtime versions
nessy-general-agent --version         # Print this CLI's own package version
```

### Offline Diagnostics (no server, no session)

These three run entirely locally. They need neither a server nor an API key,
which is what makes them usable when the thing you are diagnosing is why the
server will not start.

```bash
nessy-general-agent doctor                     # Read-only configuration checkup
nessy-general-agent plugin validate <path>     # Validate a bundle without installing
nessy-general-agent plugin list                # Installed plugins (alias: plugin ls)
nessy-general-agent plugin details <name>      # One plugin's components + token cost
```

`doctor` lists which managed settings source is in effect, every managed entry
that failed validation with its source and field, and every user settings layer
rejected whole. **It exits 1 when it finds something**, so a fleet policy push
can be gated on it:

```bash
nessy-general-agent doctor || echo "policy push is broken on this machine"
nessy-general-agent --json doctor | jq '.invalidManagedEntries'
```

The `--json` shape is a contract, exported as `DoctorJsonReportV1`
(`apps/cli/src/doctor.ts`). Read the type before writing a fleet check: it has
**no optional fields** — every key is always present, and the absence of an
answer is `null`, never a missing key — and each `| null` field documents which
absence its null means. The distinction that matters most in practice is
*"could not look"* against *"looked and found nothing"*: `searchBackend`,
`networkTrust`, `projectInstructionFiles`, `invalidAgentDefinitions` and
`unfulfilledPluginMandates` are `null` when the host could not be consulted and
an empty object or list when it could and had nothing to report.

`plugin validate` takes `--strict`, which treats warnings as errors, and exits 1
when the bundle does not pass.

```bash
nessy-general-agent plugin validate ./my-plugin --strict
nessy-general-agent --json plugin list | jq '.[] | select(.enabled == "enabled")'
```

### Resource Listing

```bash
nessy-general-agent workspaces        # List all workspaces
nessy-general-agent sessions          # List sessions in workspace
nessy-general-agent connections       # List LLM connections
nessy-general-agent sources           # List configured sources
```

### Session Operations

```bash
nessy-general-agent session create [--name <n>] [--mode <m>]  # Create session
nessy-general-agent session messages <id>                       # Print message history
nessy-general-agent session delete <id>                         # Delete session
nessy-general-agent cancel <id>                                 # Cancel processing
```

### Send Message (Streaming)

```bash
# Send a message and stream the AI response in real time
nessy-general-agent send <session-id> <message>

# Pipe text from stdin
echo "Summarize this file" | nessy-general-agent send <session-id>

# Read from stdin explicitly
cat document.txt | nessy-general-agent send <session-id> --stdin
```

Piped stdin is capped at 10 MiB. A larger pipe stops at the cap and exits 1 with
`Piped input exceeds the 10MB stdin limit.` — write the content to a file and
reference the file path in your prompt instead of piping it.

The `send` command subscribes to session events and streams them to stdout:
- `text_delta` — text streamed inline
- `tool_start` — `[tool: name]` marker
- `tool_result` — tool output (truncated to 200 chars)
- `permission_request` — auto-denied (see **Permission mode default** under Run, below), exit code 1
- `error` — printed to stderr, exit code 1
- `complete` — exit code 0
- `interrupted` — exit code 130

### Power User

```bash
# Raw RPC call — send any channel with JSON args
nessy-general-agent invoke <channel> [json-args...]

# Subscribe to push events (Ctrl+C to stop)
nessy-general-agent listen <channel>
```

Examples:
```bash
nessy-general-agent invoke system:homeDir
nessy-general-agent invoke sessions:get '"workspace-123"'
nessy-general-agent listen session:event
```

### Run (Self-Contained)

```bash
nessy-general-agent run <prompt>
nessy-general-agent run --workspace-dir ./project --source github "List open PRs"
```

The `run` command is fully self-contained — it spawns a headless server, creates a session, sends the prompt, streams the response, and exits. No separate server setup needed. An API key is resolved from `--api-key`, `$LLM_API_KEY`, or a provider-specific env var (e.g., `$ANTHROPIC_API_KEY`, `$OPENAI_API_KEY`).

| Flag | Default | Description |
|------|---------|-------------|
| `--workspace-dir <path>` | — | Select an external Project through a validated handle |
| `--source <slug>` | — | Enable a source (repeatable) |
| `--output-format <fmt>` | `text` | Output format: `text`, `json`, or `stream-json`. `json` prints **one** object when the run ends — `result` (the turn's text), `session_id`, `subtype`, `is_error`, `duration_ms`, plus `usage`, `total_cost_usd` and `model_usage` when the backend reported them — so `jq -r '.result'` and `jq -r '.session_id'` resolve. `stream-json` opens with a `system`/`init` frame carrying `session_id`, `cwd`, `model`, `plugins` and `mcp_servers`; `plugin_errors` and `mcp_server_errors` appear **only when non-empty**, so a CI gate can fail on their presence |
| `--json-schema <s>` | — | JSON Schema (draft-07) the run's final output must match. Pair with `--output-format json` and read the validated value with `jq '.structured_output'`; without `--output-format json` the bare validated object is printed on its own, as before |
| `--permission-mode <mode>` | `default` | Permission mode for the session. Also spelled `--mode` |
| `--dangerously-skip-permissions` | `false` | Alias for `--permission-mode bypassPermissions`. Takes no value |
| `--no-session-persistence` | `false` | Do not save the session: it is never written to disk and cannot be resumed. `NESSY_SKIP_PROMPT_HISTORY=1` (or `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1`) does the same |
| `--no-cleanup` | `false` | Accepted and ignored — the run keeps its session by default now |
| `--server-entry <path>` | — | Custom server entry point |

By default a `run` keeps its session: it stays resumable in the shared
`CONFIG_DIR` and its id is printed to stderr as `Session: <id>`.

**Permission mode default.** With no `--permission-mode`/`--mode` flag, `run`
creates its session in `default` mode — the same as an interactive session
with no mode selected, never a silent bypass. `send` targets an existing
session and inherits whatever mode it was created with. Either way, a
non-interactive process has no dialog to show, so a `permission_request` (e.g.
a Bash command outside your `permissions.allow` rules) arriving on a session
that is not in `bypassPermissions` is answered deny immediately: one stderr
line

```
Error: permission denied (non-interactive run): pass --permission-mode bypassPermissions or pre-approve with allow rules
```

and the run exits `1` — `headless.md`'s "the run aborts when one is
attempted", made explicit, instead of hanging until `--send-timeout`. Pass
`--permission-mode bypassPermissions` (or its alias
`--dangerously-skip-permissions`) to skip all prompts, or pre-approve specific
commands with `permissions.allow` rules so the run never needs to ask.

**Exit codes for `run`:** `0` success, `1` failure, `130` on SIGINT (Ctrl+C),
`143` on SIGTERM — the 128+signal convention, so a supervisor can tell an
operator's cancel from an infrastructure shutdown. The two signals differ in what
they do to the work: SIGINT cancels the in-flight turn, while SIGTERM stops it
without recording a result, so that resuming the session continues it. Both stop the spawned
server (which is what runs `SessionEnd`) before exiting. An unrecognized flag is reported to stderr and exits `1` before
the server is spawned; use `--` when a positional argument legitimately starts
with a dash.

Structured output — schema-constrain a run and machine-read the result:

```bash
nessy-general-agent run --output-format json \
  --json-schema '{"type":"object","properties":{"files":{"type":"array"}}}' \
  "List the TypeScript files in this directory" | jq '.structured_output.files'
```

**LLM Configuration:**

| Flag | Env Fallback | Default | Description |
|------|-------------|---------|-------------|
| `--provider <name>` | `LLM_PROVIDER` | `anthropic` | Provider: `anthropic`, `openai`, `google`, `openrouter`, `groq`, `mistral`, `xai`, etc. |
| `--model <id>` | `LLM_MODEL` | (provider default) | Model ID (e.g., `claude-sonnet-4-5-20250929`, `gpt-4o`, `gemini-2.0-flash`) |
| `--api-key <key>` | `LLM_API_KEY` | (provider env) | API key — also checks provider-specific vars like `$OPENAI_API_KEY` |
| `--base-url <url>` | `LLM_BASE_URL` | — | Custom endpoint for proxies, OpenRouter, or self-hosted models |

```bash
# Multi-provider examples
nessy-general-agent run --provider openai --model gpt-4o "Summarize this repo"
GOOGLE_API_KEY=... nessy-general-agent run --provider google --model gemini-2.0-flash "Hello"
nessy-general-agent run --provider anthropic --base-url https://openrouter.ai/api/v1 --api-key $OR_KEY "Hello"
```

Prompt can also be piped via stdin:
```bash
echo "Summarize this file" | nessy-general-agent run
cat error.log | nessy-general-agent run "What's causing these errors?"
```

The same 10 MiB cap applies here: a larger `cat` exits 1 with
`Piped input exceeds the 10MB stdin limit.` before anything is sent.

### Validate Server

```bash
# Against a running server
nessy-general-agent --validate-server --url ws://127.0.0.1:9100 --token <token>

# Self-contained (auto-spawns a server)
nessy-general-agent --validate-server
```

When no `--url` is provided, `--validate-server` automatically spawns a local headless server (same as the `run` command), runs the validation, and shuts it down.

Runs a **40-step** integration test covering the full server lifecycle. The
authoritative list is `getValidateSteps()` in `apps/cli/src/index.ts` — read it
there rather than trusting a count in prose, since this table has fallen out of
sync with the code before. The step groups, in execution order:

| Group | Steps | What it covers |
|-------|-------|----------------|
| Connect and probe | 7 | Handshake, `credentials:healthCheck`, `system:versions`, `system:homeDir`, `workspaces:get`, `sessions:get`, `LLM_Connection:list` |
| Session basics | 5 | `sources:get`, `sessions:create` (a temporary `__cli-validate-*` session), `sessions:getMessages`, send + stream, send + tool use |
| Labels and session tools | 4 | `labels:create`, then `set_session_labels`, `get_session_info` and `list_sessions` through the session-tools MCP surface |
| Session branching | 3 | `sessions:branch`, verify, and send into the branch |
| Sources and MCP auth | 4 | `sources:create`, send + source mention, and **two MCP auth modes** — `auth:none` and header-auth |
| Skills | 4 | Send + skill create (writes SKILL.md via Bash), `skills:get` verify, send + skill mention, `skills:delete` |
| Automations and webhooks | 8 | `automation:create`, trigger on status change, verify session, verify labels, `automations:getLastExecuted`, `webhook:test` over RPC, webhook failure verification, cleanup |
| Cleanup and disconnect | 5 | Branch delete, `sources:delete`, `labels:delete`, `sessions:delete`, disconnect |

**Note:** This test mutates workspace state — it creates and deletes a temporary session, source, skill, label, branch and automation. All resources are cleaned up on completion. Continues on failure and reports a summary. Use `--json` for machine-readable output and `--verbose` to see server stderr.

## Scripting Patterns

```bash
# Get workspace IDs
WORKSPACES=$(nessy-general-agent --json workspaces | jq -r '.[].id')

# Count sessions per workspace
for ws in $WORKSPACES; do
  COUNT=$(nessy-general-agent --json --workspace "$ws" sessions | jq length)
  echo "$ws: $COUNT sessions"
done

# Create a session and capture its ID
SESSION_ID=$(nessy-general-agent --json session create --name "CI Run" | jq -r '.id')

# Send a message and wait for completion
nessy-general-agent send "$SESSION_ID" "Run the test suite and report results"

# Clean up
nessy-general-agent session delete "$SESSION_ID"
```

## TLS / wss://

For remote servers with TLS:

```bash
# Trusted certificate (Let's Encrypt, etc.)
nessy-general-agent --url wss://server.example.com:9100 ping

# Self-signed certificate
nessy-general-agent --url wss://server.example.com:9100 --tls-ca /path/to/ca.pem ping
```

The `--tls-ca` flag sets `NODE_EXTRA_CA_CERTS` before connecting. You can also set `NESSY_TLS_CA` in your environment.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Connection timeout` | Server not running or unreachable | Check server is started, verify URL |
| `AUTH_FAILED` | Wrong token | Check `NESSY_SERVER_TOKEN` matches server |
| `PROTOCOL_VERSION_UNSUPPORTED` | Version mismatch | Update CLI and server to same version |
| `WebSocket connection error` | Network issue or TLS problem | For self-signed certs, use `--tls-ca` |
| `No workspace available` | Workspace not yet created | Create one via desktop app or API |
