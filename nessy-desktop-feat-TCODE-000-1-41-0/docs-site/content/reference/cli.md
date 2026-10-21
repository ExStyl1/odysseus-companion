# CLI Reference

Nessy Desktop includes a terminal client that speaks the same WebSocket RPC protocol as the desktop app. It can attach to an already running [headless server](/server/headless), or — for one-shot prompts — boot a private server, run the prompt, and tear everything down afterwards.

Examples call the checked-in entry point directly so they always match the source tree:

```bash
bun run apps/cli/src/index.ts <command> [flags]
```

Running `cd apps/cli && bun link` registers the same entry point on your `PATH` as `nessy-general-agent` (the binary name is a compatibility holdover from the upstream codebase).

This page documents the `apps/cli` client only. The [headless server](/server/headless) is a separate binary (`nessy-server`, from `packages/server`) with its own flags and environment variables, documented on its own page.

## Quick Start

A fully self-contained run against the Nessy Gateway:

```bash
JWT=$(python3 -c "import json;print(json.load(open('$HOME/.nessy/dp_auth_creds.json'))['jwt'])")
bun apps/cli/src/index.ts run \
  --provider openai \
  --base-url https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1 \
  --api-key "$JWT" \
  --model tgpt/deepseek-v4-flash-0731 \
  --workspace-dir "$TMPDIR/ws" \
  --output-format stream-json \
  "What is 2+2?"
```

No server setup is needed: `run` starts one for you. See [run](#run-one-shot-and-self-contained) below for the full lifecycle.

## Global Options

| Flag | Environment fallback | Default | Purpose |
| --- | --- | --- | --- |
| `--url <ws[s]://…>` | `NESSY_SERVER_URL` | — | WebSocket address of the server |
| `--token <secret>` | `NESSY_SERVER_TOKEN` | — | Bearer token presented during the handshake |
| `--workspace <id>` | — | first workspace | Workspace the command operates on |
| `--timeout <ms>` | — | `10000` | Per-request RPC timeout |
| `--send-timeout <ms>` | — | `300000` | How long `send`/`run` wait for a turn to finish |
| `--tls-ca <path>` | `NESSY_TLS_CA` | — | Extra CA certificate for self-signed TLS (exported as `NODE_EXTRA_CA_CERTS`) |
| `--json` | — | off | Machine-readable JSON output |
| `--agents <json>` | — | — | Register subagents for this run from JSON, without writing any file: an object keyed by agent name, each value carrying at least a `prompt`. Honoured by `run` and by `session create`, so a session created up front and sent into gets the same agents. The flag's own shape is checked before any server is spawned; a single malformed entry is excluded and named by the host rather than failing the run. An administrator can refuse the flag outright with the managed setting `disableSideloadFlags`: the run then exits at startup with an error naming the flag and the key, before any server is spawned |
| `--safe-mode` | `NESSY_SAFE_MODE` | off | Start with no instructions files, skills, plugins, hooks, MCP servers, commands, or agents loaded, for troubleshooting a broken configuration. Managed policy still applies |
| `--fallback-model <a,b,c>` | `NESSY_FALLBACK_MODEL` | — | Comma-separated chain of models tried in order when the primary model drains, deduplicated and capped at three. It takes precedence over the `fallbackModel` setting and lasts for the current turn only — your next message tries the primary model first again |
| `--settings <path\|json>` | `NESSY_CLAUDE_SETTINGS` | — | A settings JSON file, or an inline JSON string. Values set here override the same keys in your `settings.json` files for this session; keys you omit keep their file-based values. Applies on the Claude runtime, above user/project/local settings and below managed policy. Unparseable inline JSON is dropped with a diagnostic instead of failing the run |
| `--setting-sources <list\|none>` | `NESSY_CLAUDE_SETTING_SOURCES` | all three | Which filesystem settings the Claude runtime loads: a comma-separated subset of `user`, `project`, `local` — or `none` for the empty list, which needs a word of its own because an empty value cannot travel in an environment variable. A narrowing is announced, because dropping `project` also stops loading skills, commands, and subagents from `--add-dir` roots, and dropping `user` drops your own permission rules. An unrecognized value keeps all three rather than being read as the empty list |
| `--no-spinner` | — | off | Suppress the progress spinner (alias: `--disable-spinner`) |
| `--verbose`, `-v` | — | off | Show spawned-server stderr during validation |
| `--help`, `-h` | — | — | Print usage |
| `--version` | — | — | Print the CLI package version |

Command-line flags take precedence over their environment fallbacks. Colors and the spinner turn off automatically when `NO_COLOR` is set or stdout is not a terminal.

`--safe-mode`, `--fallback-model`, `--settings`, and `--setting-sources` reach the agent through the environment of the server the CLI spawns, so they only mean something for the two commands that spawn one — `run` and `--validate-server`. Pass any of them to either command together with `--url` and the run is refused before it connects, because a server the CLI did not start never sees them; see [run](#run-one-shot-and-self-contained).

Several commands operate without a server address: `run` and `--validate-server` spawn their own server (give either one a `--url` and it attaches to that server instead of spawning one), while `doctor` and the `plugin` verbs read local state only and start no server at all. Every other command exits with code 1 if neither `--url` nor `$NESSY_SERVER_URL` is set.

When `--workspace` is omitted, the CLI asks the server for its workspace list and binds to the first entry. Commands that need a workspace (`sessions`, `sources`, `session create`) exit with code 1 if none exists.

## Commands

### Diagnostics

| Command | RPC channel | Output |
| --- | --- | --- |
| `ping` | handshake only | assigned client id and round-trip latency |
| `health` | `credentials:healthCheck` | credential store status |
| `versions` | `system:versions` | runtime versions reported by the server |

### doctor: configuration checkup

```bash
bun run apps/cli/src/index.ts doctor
bun run apps/cli/src/index.ts --json doctor | jq '.invalidManagedEntries'
```

A read-only installation and settings diagnosis — no server, no session. It
reports which managed settings source is in effect, every managed entry that
failed validation (with its source and field), and every user settings layer
that was rejected whole. The exit code is 1 when it finds something, so a
fleet policy push can be gated on it.

### plugin: authoring and inventory

Three server-less verbs for plugin authors and administrators:

| Command | Purpose |
| --- | --- |
| `plugin validate <path> [--strict]` | Validate a plugin bundle directory without installing it — manifest, component frontmatter, and hook config. `--strict` treats warnings as errors. Exits 1 when the bundle does not pass, which makes it CI-friendly |
| `plugin list` (alias `plugin ls`) | Installed plugins with version, source marketplace, and global enable status |
| `plugin details <name>` | Component inventory and projected token cost for one installed plugin |

All three accept the global `--json` for machine-readable output:

```bash
bun run apps/cli/src/index.ts plugin validate ./my-plugin --strict
bun run apps/cli/src/index.ts --json plugin list | jq '.[] | select(.enabled == "enabled")'
bun run apps/cli/src/index.ts plugin details my-plugin
```

### Listing resources

| Command | RPC channel | Output |
| --- | --- | --- |
| `workspaces` | `workspaces:get` | one line per workspace: id, name, path |
| `sessions` | `sessions:get` | id, name, message preview, `[processing]` marker |
| `connections` | `LLM_Connection:list` | configured [LLM connections](/reference/config/llm-connections) |
| `sources` | `sources:get` | sources in the active workspace |

### Session management

| Command | RPC channel | Purpose |
| --- | --- | --- |
| `session create [--name <text>] [--mode <mode>]` | `sessions:create` | create a session, print its record |
| `session messages <id>` | `sessions:getMessages` | dump the message history |
| `session delete <id>` | `sessions:delete` | delete a session |
| `cancel <id>` | `sessions:cancel` | stop in-flight processing |

`--mode` accepts the [permission modes](/core-concepts/permissions) `dontAsk`, `plan`, `default`, `acceptEdits`, `auto`, and `bypassPermissions`. The retired `explore` and legacy spellings (`safe`, `ask`, `allow-all`, `execute`, `ask-to-edit`, `automatic`, `manual`) stay accepted and resolve to the current modes; `explore` and `safe` resolve to `plan`.

### send: stream a reply

```bash
bun run apps/cli/src/index.ts send <session-id> "Explain the auth flow"
git diff | bun run apps/cli/src/index.ts send <session-id>
```

The prompt comes from the positional arguments; when no inline message is given and stdin is piped, the prompt is read from stdin instead.

`send` subscribes to `session:event` and renders events as they arrive:

| Event | Text-mode rendering | Effect |
| --- | --- | --- |
| `text_delta` | chunk appended to stdout | — |
| `text_complete` | full text printed only if no deltas arrived | ends the turn |
| `tool_start` | `[tool: <name> — <intent>]` | — |
| `tool_result` | result body, truncated at 200 characters | — |
| `error`, `typed_error` | message on stderr | ends the turn, exit code 1 |
| `complete` | trailing newline | ends the turn, exit code 0 |
| `interrupted` | `[interrupted]` | ends the turn, exit code 130 |

::: info Subagent turns
Child turns from subagents (the Task tool) arrive as `text_complete` events carrying a `parentToolUseId`. The CLI neither prints them nor treats them as the end of the parent turn. Only a top-level, non-intermediate `text_complete` — or a `complete`, `error`, or `interrupted` event — finishes the stream.
:::

If no terminal event arrives within `--send-timeout` (5 minutes by default), the CLI prints `Send timeout — no completion event received` and exits with code 1.

### Output formats

`--output-format` applies to `send` and `run`:

- `text` (default) — human-readable rendering per the table above.
- `json` — for structured runs: pair it with `--json-schema` to print the validated structured output as a single JSON document (see below).
- `stream-json` — the stream opens with a `system`/`init` frame, then every session event is written to stdout as one JSON object per line, including event types the text renderer ignores (`user_message`, `usage_update`, and so on). Nothing else is printed; exit-code behavior is unchanged.

#### The stream-json init frame

Line 1 of a `stream-json` run is session metadata, not a turn event:

```json
{"type":"system","subtype":"init","session_id":"…","cwd":"…","model":"…","output_format":"stream-json","plugins":[{"name":"…","path":"…"}],"mcp_servers":[{"name":"…","status":"pending"}]}
```

`plugin_errors` and `mcp_server_errors` are present **only when non-empty**, so a
CI job can gate on their presence rather than on a length comparison:

- `plugin_errors` — one entry per plugin that failed to load (`plugin`, `type`, `message`). A plugin listed here is absent from `plugins`. Causes: an unsatisfied declared dependency, an unset required `user_config` key, an unresolved app connector, or a missing required MCP environment variable.
- `mcp_server_errors` — one entry per MCP declaration skipped by config validation (`name`, `type`, `message`). A server listed here is absent from `mcp_servers`. Causes: a Source `config.json` that does not parse or declares no recognised `type`, an `mcp.json` / `.mcp.json` that does not parse, or a plugin-bundled MCP server whose command the format adapter refused.

```bash
nessy-general-agent run --output-format stream-json "…" \
  | head -1 | jq -e 'has("mcp_server_errors") or has("plugin_errors")' && exit 1
```

The frame is snake_case because it follows Claude Code's headless contract; the
event lines after it stay in Nessy's own camelCase. The mix is intentional.

`mcp_servers[].status` is `pending` at init time on a fresh session — live
connection state does not exist until the agent runtime has started, which is
after the first turn. `mcp_server_errors` is unaffected: it is computed while
the inventory is scanned, which is why it is the array worth gating on.

When stderr is a terminal, a skipped MCP entry also prints a `Warning: N MCP
servers skipped due to invalid config:` line. When stderr is redirected or
captured — a CI runner, a pipe — nothing is printed and the stream is the only
channel for that state.

### Structured output: --json-schema

`--json-schema <schema>` (for `send` and `run`) takes a JSON Schema
(draft-07) the run's final output must match. Streaming text is suppressed;
on completion the CLI prints only the validated structured output. An invalid
schema fails at startup with `--json-schema is not a valid JSON Schema`; a run
that cannot produce schema-valid output within the bounded retries exits with
code 1 and an error naming the validation failures.

```bash
bun run apps/cli/src/index.ts run \
  --json-schema '{"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"]}' \
  --output-format json \
  "Summarize this repository"
```

### run: one-shot and self-contained

`run` needs no pre-existing server. Its lifecycle:

1. Spawns a headless server as a child process (`bun run packages/server/src/index.ts`, located from the monorepo layout or overridden with `--server-entry`). The child gets a random token and binds `127.0.0.1` on an ephemeral port; the CLI waits for the `NESSY_SERVER_URL=` line on its stdout, up to 30 seconds (or `--timeout` when larger).
2. Creates or reuses a name-only Workspace for the run. If `--workspace-dir` is given, the server validates it as an external Project and selects it through a Workspace-bound opaque handle; the directory never becomes Workspace storage.
3. Sets up an LLM connection when the server has none, when `--base-url` is set, or when the provider is anything other than `anthropic`. The connection is saved as `<provider>-cli` and made the default. Because the spawned server shares the active `CONFIG_DIR` with the desktop app (`~/.nessy-agent` by default, or `NESSY_CONFIG_DIR` when set), connections you configured in the app are reused when this step is skipped.
4. Creates a session with the requested permission mode and sources, then applies `--model` when given.
5. Sends the prompt (positional arguments, or stdin when piped), streams the reply exactly like `send`, and adopts the stream's exit code. Piped stdin is capped at 10 MiB; a larger pipe stops at the cap and exits 1 with `Piped input exceeds the 10MB stdin limit.` Write the content to a file and reference the path in the prompt instead.
6. Stops the server, keeping the session. It stays resumable in the shared `CONFIG_DIR` and its id is printed to stderr as `Session: <id>`, unless `--no-session-persistence` was passed — in which case the session was never written at all.

Ctrl+C (SIGINT) cancels the in-flight turn, performs cleanup, and exits with code 130. SIGTERM also performs cleanup and exits with code 143 — so a supervisor can tell an operator's cancel from an infrastructure shutdown — and stops the turn in progress at once, but records no result for it, so resuming the session continues it. A run that passed `--no-session-persistence` has no session to resume, so its unfinished turn is lost either way.

An unrecognized flag is reported to stderr and exits 1 before the server is spawned. Use `--` when a positional argument legitimately starts with a dash.

**With `--url`, `run` attaches instead of spawning.** Step 1 is skipped and the run uses the server already listening at that address — which is how you point a run at a server you started yourself, under a debugger or with its own stdout in view. Four flags are refused in that combination, before anything connects: `--safe-mode`, `--fallback-model`, `--settings` and `--setting-sources`. The CLI delivers all four through the environment of the server it spawns, so against a server it did not start they would do nothing at all, and a `--safe-mode` that does nothing is the failure `--safe-mode` exists to prevent. The message names the flags and the two ways out: drop `--url` to spawn a server that honours them, or set the matching variable in the environment of the server you are attaching to. Only the command-line forms are refused — an inherited `NESSY_SAFE_MODE` is your ambient environment rather than something you typed on this command line, and the run reports that half by variable name instead.

| Flag | Default | Purpose |
| --- | --- | --- |
| `--workspace-dir <path>` | — | select an external Project through a validated Workspace-bound handle |
| `--source <slug>` | — | enable a source on the session; repeatable |
| `--permission-mode <mode>` | `bypassPermissions` | permission mode for the session; also spelled `--mode` |
| `--output-format <fmt>` | `text` | `text`, `json`, or `stream-json` |
| `--json-schema <schema>` | — | JSON Schema (draft-07) the final output must match; see [Structured output](#structured-output-json-schema) |
| `--no-session-persistence` | off | do not save the session: it is never written to disk and cannot be resumed. `NESSY_SKIP_PROMPT_HISTORY=1` (or `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1`) does the same |
| `--no-cleanup` | off | accepted and ignored — the run keeps its session by default now |
| `--server-entry <path>` | auto-detected | alternative server entry file |

**LLM configuration:**

| Flag | Environment fallback | Default | Purpose |
| --- | --- | --- | --- |
| `--provider <name>` | `LLM_PROVIDER` | `anthropic` | provider id (see key table below) |
| `--model <id>` | `LLM_MODEL` | provider default | model to run |
| `--api-key <key>` | `LLM_API_KEY` | provider-specific variable | credential for the provider |
| `--base-url <url>` | `LLM_BASE_URL` | — | custom OpenAI- or Anthropic-compatible endpoint |

The API key is resolved in order: `--api-key`, then `$LLM_API_KEY`, then the provider-specific variable:

| Provider | Environment variable |
| --- | --- |
| `anthropic` | `ANTHROPIC_API_KEY` |
| `openai` | `OPENAI_API_KEY` |
| `google` | `GOOGLE_API_KEY` |
| `openrouter` | `OPENROUTER_API_KEY` |
| `groq` | `GROQ_API_KEY` |
| `mistral` | `MISTRAL_API_KEY` |
| `deepseek` | `DEEPSEEK_API_KEY` |
| `xai` | `XAI_API_KEY` |
| `cerebras` | `CEREBRAS_API_KEY` |
| `huggingface` | `HUGGINGFACE_API_KEY` |

`amazon-bedrock` is the exception: it authenticates with IAM credentials from `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (plus optional `AWS_SESSION_TOKEN`; `AWS_REGION` defaults to `us-east-1`).

With `--base-url`, the connection is stored as a [custom endpoint](/reference/config/custom-endpoint) — and it is created even when other connections already exist, so the session is guaranteed to route through it. `--provider anthropic` selects the Anthropic Messages wire format; any other provider selects the OpenAI Completions format. If `--model` is omitted, the endpoint defaults to `claude-sonnet-4-6` (anthropic) or `gpt-4o` (everything else).

```bash
# Default provider (requires $ANTHROPIC_API_KEY)
bun run apps/cli/src/index.ts run "Summarize this repository"

# OpenAI
OPENAI_API_KEY=sk-... bun run apps/cli/src/index.ts run --provider openai --model gpt-4o "Hello"

# Prompt piped from another command
git log --oneline -20 | bun run apps/cli/src/index.ts run

# Nessy Gateway (see Quick Start for extracting the JWT)
bun run apps/cli/src/index.ts run --provider openai \
  --base-url https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1 \
  --api-key "$JWT" --model tgpt/deepseek-v4-flash-0731 "What is 2+2?"
```

::: warning Rejected keys
A rejected or expired gateway JWT surfaces as a 401-class `Invalid API Key` error during the first turn. Re-read the token from `~/.nessy/dp_auth_creds.json` and retry.
:::

### invoke and listen: raw RPC

```bash
bun run apps/cli/src/index.ts invoke system:homeDir
bun run apps/cli/src/index.ts invoke sessions:get '"<workspace-id>"'
bun run apps/cli/src/index.ts listen session:event
```

`invoke` sends a single request on any channel and prints the response; extra arguments are parsed as JSON when possible and passed as plain strings otherwise. `listen` subscribes to a push channel and prints each event as JSON until you press Ctrl+C.

### --validate-server

```bash
# Against a running server
bun run apps/cli/src/index.ts --validate-server --url ws://127.0.0.1:9100 --token "$TOKEN"

# Spawn a throwaway server and validate it
bun run apps/cli/src/index.ts --validate-server --verbose
```

Runs a 40-step integration pass over a single connection. Steps keep executing after a failure; the exit code is 0 only when every step passes. The steps cover:

- handshake, credential health, server versions, home directory
- workspace, session, connection, and source listing
- session lifecycle: create, read history, a plain streaming turn, a Bash tool turn
- session tools: label creation plus `set_session_labels`, `get_session_info`, `list_sessions`
- branching: branch from an assistant message, verify the shorter history, stream on the branch
- sources: create a REST API source, mention it in a prompt, exercise a pre-committed MCP source (plus a header-auth MCP step that is skipped unless `$STITCH_API_KEY` is set)
- skills: create a skill file through the Bash tool, verify it is listed, invoke it, delete it
- automations: install a config template, trigger it via a status change, verify the created session and auto-label, check execution history, and confirm a failing webhook is recorded
- cleanup of every temporary session, branch, source, skill, label, automation file, and (when bootstrapped) workspace

::: warning Validation mutates state
The pass creates and deletes real resources: sessions named `__cli-validate-*`, a Cat Facts API source, a validation skill, labels, and automation config (existing `automations.json` / `automations-history.jsonl` are backed up and restored). Do not point it at a workspace you care about. Run it from the repository root — the automation template is read from `.github/agents/automations.json` relative to the working directory.
:::

Behavior details:

- Without `--url`, a local server is spawned and stopped automatically; its stderr is shown only with `--verbose`.
- The per-step RPC timeout is raised to at least 30 seconds.
- `--workspace-dir` validates the given directory as an external Project and selects it through an opaque Workspace-bound handle; otherwise the first existing Workspace is used, and a name-only temporary one is created when the server has none.
- `--provider`, `--model`, `--api-key`, and `--base-url` configure the LLM connection the same way `run` does.
- `--json` emits `{ total, passed, failed, results: [{ step, status, detail, elapsed }], elapsedSeconds }`.

```bash
bun run apps/cli/src/index.ts --validate-server --json | jq '.failed'
```

## Exit Codes

| Code | Meaning |
| --- | --- |
| `0` | turn completed normally, or all validation steps passed |
| `1` | error: missing URL/workspace/message, RPC failure, `error`/`typed_error` event, send timeout, or at least one failed validation step |
| `130` | interrupted: the session emitted `interrupted`, or `run` received SIGINT |
| `143` | `run` received SIGTERM: the turn in progress was stopped without recording a result |

## Environment Variables

| Variable | Used for |
| --- | --- |
| `NESSY_SERVER_URL` | server address when `--url` is omitted |
| `NESSY_SERVER_TOKEN` | auth token when `--token` is omitted |
| `NESSY_TLS_CA` | CA certificate path when `--tls-ca` is omitted |
| `NESSY_SAFE_MODE` | `1` starts in safe mode, same as `--safe-mode` |
| `NESSY_FALLBACK_MODEL` | fallback chain when `--fallback-model` is omitted |
| `NESSY_CLAUDE_SETTINGS` | Claude flag-settings tier when `--settings` is omitted |
| `NESSY_CLAUDE_SETTING_SOURCES` | Claude setting sources when `--setting-sources` is omitted |
| `LLM_PROVIDER`, `LLM_MODEL`, `LLM_API_KEY`, `LLM_BASE_URL` | defaults for `run`'s LLM flags |
| `NO_COLOR` | disable colored output and the spinner |

Server-side variables are documented in [Headless Server](/server/headless#environment-variables); the app-wide list lives in [Environment Variables](/reference/config/environment-variables).

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `No server URL` and exit 1 | neither `--url` nor `$NESSY_SERVER_URL` set | pass `--url` or export the variable |
| `Connection timeout (10000ms)` | server not running or unreachable | check the server process and address; raise `--timeout` |
| Handshake rejected with `AUTH_FAILED` | token mismatch | use the exact value of the server's `NESSY_SERVER_TOKEN` |
| `PROTOCOL_VERSION_UNSUPPORTED` | client and server built from different checkouts | rebuild both from the same revision |
| TLS errors against `wss://` | self-signed certificate not trusted | pass `--tls-ca <path>` with the CA file |
| `Invalid API Key` (401) during `run` | rejected or expired gateway JWT, or wrong provider key | refresh the JWT from `~/.nessy/dp_auth_creds.json` or pass a valid `--api-key` |
| `Send timeout — no completion event received` | the turn ran longer than `--send-timeout` | raise `--send-timeout` |

See also the task-oriented [CLI client guide](/server/cli) and the [Headless Server](/server/headless) setup page.

## Odysseus local integration

The optional Odysseus source build adds **Open in CLI** and **Synchronize CLI ↔ Desktop** in the sidebar when launched through `tools/run-component.mjs desktop` from the parent Odysseus folder. This explicitly opens the macOS system Terminal and starts the separate Nessy CLI project, resuming the mapped conversation in its working folder. Startup succeeds only after the CLI launcher writes a receipt. Bulk synchronization runs in a background Node process, and periodic status checks avoid rerendering the app shell when the visible status is unchanged. It is distinct from the WebSocket client documented above.

The local bridge synchronizes compatible transcript text, model catalogs and API credentials, UI language, and light/dark appearance every five seconds. Shared project skills and MCP configuration use Odysseus's existing profile synchronizer. Conflicting branches remain separate; incoming edits to a session with a live agent wait until release or restart. Attachments and original transcripts are retained in the private archive, while tool history is informational text. Native permissions, SDK sessions, OAuth subscriptions and unsupported settings remain native.

Private data and backups live outside both applications in `~/.odysseus` (override: `ODYSSEUS_DATA_DIR`). Desktop API keys are read and written through the verified native credential manager; a private AES-GCM bridge cache supplies only the child CLI environment. Independent source updates retain these files. Reapply the parent `tools/install-desktop-bridge.mjs` integration and rebuild Desktop after replacing its source snapshot; a stock installed-app update does not carry these source modifications.

## Local Odysseus launchers

From the project folder, open `Запустить Odysseus CLI.command` or `Запустить Odysseus Desktop.command`. These macOS launchers locate an installed Node.js 22+ and resolve the component relative to the current project folder. The `tools/run-component.mjs` and `tools/odysseus.mjs` command entry points remain available.

## Odysseus macOS distribution

After installing and opening Odysseus.app, run `od` in a new terminal window. The application bundles the CLI and its runtime; no source checkout is required. Build from the integration root using `npm run build:mac`.

The general CLI button runs `od` in Terminal. The chat-header Continue in CLI action flushes and synchronizes the selected chat, verifies its native history, then runs `od --resume` in the project directory. An empty chat starts a new CLI session. macOS may request Terminal Automation permission on first use.
