#!/usr/bin/env bun
/**
 * nessy-general-agent — Terminal client for Nessy Desktop server.
 *
 * Connects over WebSocket (ws:// or wss://) to a running Nessy Desktop server
 * and provides commands for listing resources, managing sessions, sending
 * messages with real-time streaming, and validating server health.
 */

import { resolve } from 'path'
import { compileStructuredOutputSchema } from '@nessy-agent/shared/structured-output'
import { SAFE_MODE_ENV_VAR, isSafeModeEnabled } from '@nessy-agent/shared/config/safe-mode'
import { parsePermissionMode } from '@nessy-agent/shared/agent/mode-types'
import { PRINT_MODE_ENV_VAR } from '@nessy-agent/shared/config/print-background-wait'
import { FALLBACK_MODEL_ENV_VAR } from '@nessy-agent/shared/config/fallback-model-chain'
import {
  CLAUDE_FLAG_SETTINGS_ENV_VAR,
  CLAUDE_SETTING_SOURCES_ENV_VAR,
  CLAUDE_SETTING_SOURCES_NONE,
  resolveClaudeSettingSources,
} from '@nessy-agent/shared/config/claude-flag-settings'
import { isSkipPromptHistoryEnabled } from '@nessy-agent/shared/config/skip-prompt-history'
import { runtimeProducesFileCheckpoints, SKIP_REASON_TEXT } from '@nessy-agent/shared/sessions'
import type { FileCheckpointRevertResult } from '@nessy-agent/shared/sessions'
import type { PiHarnessRuntimeSnapshotV1 } from '@nessy-agent/core/types'
import { CliRpcClient } from './client.ts'

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

export interface CliArgs {
  url: string
  token: string
  workspace?: string
  timeout: number
  json: boolean
  tlsCa?: string
  sendTimeout: number
  command: string
  rest: string[]
  // run-specific flags
  sources: string[]
  mode: string
  outputFormat: string
  /** R18 headless structured output: raw --json-schema value ('' when absent). */
  jsonSchema: string
  /**
   * `--no-cleanup`. Accepted and IGNORED since the run stopped deleting its own
   * session (`best-practices.md:469`): keeping the session is now the default,
   * so the flag asks for what already happens. Still parsed, because dropping
   * the case would send the token into `rest` — and for `run`, `rest` is the
   * prompt.
   */
  noCleanup: boolean
  /**
   * `--no-session-persistence` (`cli-reference.md:105`) — "sessions are not
   * saved to disk and cannot be resumed". Maps onto `CreateSessionOptions.
   * ephemeral`, i.e. never written, not written-then-removed. Also set by
   * `NESSY_SKIP_PROMPT_HISTORY` / `CLAUDE_CODE_SKIP_PROMPT_HISTORY`.
   *
   * **"Never written" is the SESSION RECORD, and is the whole of what the two
   * documented promises cover** — `cli-reference.md`'s row above, and
   * `env-vars.md#variables`' `CLAUDE_CODE_SKIP_PROMPT_HISTORY` ("skip writing
   * prompt history and session transcripts to disk"). Both are about the record;
   * neither mentions the FILE SNAPSHOTS this product takes so a user can revert
   * an edit mid-run. Those are ours, the documentation is silent on them, and
   * P2.524 decided them the other way: written, then removed when the session
   * ends (`shared/src/sessions/file-checkpoints.ts`, `removeFileCheckpointStore`,
   * which carries the reasoning and the crash-window residue). The help text
   * below says so, because a promise a user reads has to be the promise they get.
   */
  noSessionPersistence: boolean
  noSpinner: boolean
  verbose: boolean
  serverEntry?: string
  workspaceDir?: string
  /** `--safe-mode` (`env-vars.md:318`), or the env var already being set. */
  safeMode: boolean
  // LLM configuration
  provider: string
  model: string
  /**
   * `--fallback-model a,b,c` (`model-config.md:366`), raw as typed. Exported to
   * the server this CLI spawns through NESSY_FALLBACK_MODEL, where it takes
   * precedence over the `fallbackModel` setting (`:381`).
   */
  fallbackModel: string
  /**
   * P6.439 clause (1) — `--settings <path|inline json>`, raw as typed.
   * `cli-reference.md#cli-flags`: *"Path to a settings JSON file or an inline
   * JSON string. Values you set here override the same keys in your
   * `settings.json` files for this session."* Exported through
   * `NESSY_CLAUDE_SETTINGS` to the server this CLI spawns, where the claude
   * backend hands it to the SDK's own flag-settings TIER — the host neither
   * parses precedence nor merges anything.
   */
  claudeSettings: string
  /**
   * P6.930 clause (2) — `--setting-sources <list|none>`, raw as typed.
   *
   * `agent-sdk/claude-code-features.md#control-filesystem-settings-with-settingsources`:
   * *"Pass an explicit list to opt in to specific sources, or pass an empty
   * array to disable user, project, and local settings."* Exported through
   * `NESSY_CLAUDE_SETTING_SOURCES` to the server this CLI spawns, where the
   * claude backend hands the list to the SDK's own option. Narrowing it costs
   * more than settings, so `main()` names what was dropped before the run
   * starts; {@link resolveClaudeSettingSources} owns both the parse and the
   * sentence.
   */
  claudeSettingSources: string
  /**
   * P6.930 clause (3) — `--bare`, ACCEPTED and deliberately NOT applied.
   *
   * The vendor page documents it as Claude Code's own minimal mode
   * (`cli-reference.md#cli-flags`): *"Minimal mode: skip auto-discovery of
   * hooks, skills, custom commands, subagents, plugins, MCP servers, auto
   * memory, and CLAUDE.md so scripted calls start faster. … Sets
   * `CLAUDE_CODE_SIMPLE`"*. It is NOT an alias of `--safe-mode`, and the pages
   * say so themselves — the `--safe-mode` row: *"Authentication, model
   * selection, built-in tools, and permissions work normally, which differs from
   * `--bare`."* So aliasing the two would assert an equivalence the vendor
   * denies (owner decision 2026-09-10, balance rule), and swallowing the flag
   * would leave a user who copied a documented command believing it took.
   * Recorded here, announced by {@link CLAUDE_BARE_FLAG_NOTICE}, and applied to
   * nothing.
   */
  bare: boolean
  apiKey: string
  baseUrl: string
  /**
   * Dash-leading tokens this parser does not recognize, in the order they were
   * typed. `headless.md:33` — "If you pass an invalid flag, Claude Code reports
   * the error to stderr before the run starts." Collected rather than reported
   * here so `parseArgs` stays pure and testable; `main()` is what reports and
   * exits, before anything is spawned or connected.
   */
  unknownFlags: string[]
  /**
   * P6.317 (2) — the RAW `--agents` JSON, exactly as typed.
   *
   * Kept as text rather than parsed here so `parseArgs` stays pure and
   * testable, like every other value on this interface; {@link parseAgentsArg}
   * is the reader and `main()` is what reports and exits, before anything is
   * spawned or connected (`headless.md:33`).
   */
  agents: string
  /**
   * D1.258 — the SUBSET of the spawn-only flags that arrived on ARGV, in the
   * order they were typed, by their real spellings.
   *
   * `--safe-mode`, `--fallback-model`, `--settings` and `--setting-sources` are
   * delivered to the server through the ENVIRONMENT {@link spawnLocalServer}
   * builds, so a run that ATTACHES (`--url`) cannot honour one. D1.233 printed
   * that; this field is what lets `main()` REFUSE it instead, on the documented
   * "before the run starts" discipline D1.107 and the unknown-flag gate use.
   *
   * WHY ARGV AND NOT THE PARSED VALUE. Every one of the four has an env twin
   * (`isSafeModeEnabled`, {@link FALLBACK_MODEL_ENV_VAR},
   * {@link CLAUDE_FLAG_SETTINGS_ENV_VAR}, {@link CLAUDE_SETTING_SOURCES_ENV_VAR})
   * that the fallbacks below fold into the SAME field, so refusing on
   * `args.safeMode` would exit(1) on an inherited `NESSY_SAFE_MODE=1` in the
   * user's shell — a combination nobody typed, on a diagnostic command. The
   * flag is the user's instruction and is refused; the environment is the
   * operator's ambient state and is reported.
   */
  attachInertFlags: string[]
}

/**
 * Dash-leading tokens that are NOT top-level flags but are legitimately mined
 * out of `rest` by a specific command. Without this allowlist the unknown-flag
 * gate below would reject the CLI's own documented sub-flags.
 *
 * - `--stdin` — read by {@link readPrompt} for `run` and `send`.
 * - `--name` — read by `cmdSessionCreate` for `session create`.
 * - `--strict` — read by `runPluginCommand` for `plugin validate`.
 * - `--worktree` — read by `cmdSessionCreate` for `session create` (P6.335).
 *
 * Anything else that starts with `-` and is not a case in the switch is a typo
 * or an unimplemented flag, and both must be told apart from a prompt word. Use
 * `--` when a positional legitimately begins with a dash.
 */
const PASSTHROUGH_SUBCOMMAND_FLAGS = new Set(['--stdin', '--name', '--strict', '--worktree'])

export function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2) // skip bun + script path
  let url = ''
  let token = ''
  let workspace: string | undefined
  let timeout = 10_000
  let json = false
  let tlsCa: string | undefined
  let sendTimeout = 300_000 // 5 min
  const rest: string[] = []
  let command = ''
  const sources: string[] = []
  let mode = ''
  let outputFormat = 'text'
  let jsonSchema = ''
  let noCleanup = false
  let noSessionPersistence = false
  let noSpinner = false
  const unknownFlags: string[] = []
  const attachInertFlags: string[] = []
  let claudeSettingSources = ''
  let bare = false
  let agents = ''
  let verbose = false
  let serverEntry: string | undefined
  let workspaceDir: string | undefined
  let safeMode = false
  let provider = ''
  let model = ''
  let fallbackModel = ''
  let claudeSettings = ''
  let apiKey = ''
  let baseUrl = ''

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--url':
        url = args[++i] ?? ''
        break
      case '--token':
        token = args[++i] ?? ''
        break
      case '--workspace':
        workspace = args[++i]
        break
      case '--timeout':
        timeout = parseInt(args[++i] ?? '10000', 10)
        break
      case '--json':
        json = true
        break
      case '--tls-ca':
        tlsCa = args[++i]
        break
      case '--send-timeout':
        sendTimeout = parseInt(args[++i] ?? '300000', 10)
        break
      case '--source':
        sources.push(args[++i] ?? '')
        break
      // `cli-reference.md:107` spells the permission-mode flag
      // `--permission-mode`, and `headless.md:245` uses that spelling with `-p`.
      // The VALUES already match ours (`parsePermissionMode` resolves Claude's
      // whole vocabulary), so this is one case label, not a behaviour change.
      // `--mode` stays forever: it is the spelling every existing script uses.
      case '--permission-mode':
      case '--mode':
        mode = args[++i] ?? ''
        break
      // `permission-modes.md`: "The `--dangerously-skip-permissions` flag is
      // equivalent" (to bypassPermissions). Takes no value, unlike
      // `--permission-mode` — it just sets the mode directly. No ack gate
      // here: a non-interactive run shows no dialog either way, and the CLI
      // has no `--bg` analog for `--allow-dangerously-skip-permissions` to
      // pre-arm (2026-08-12 sandbox-default-off-and-bypass-cli-parity T3).
      case '--dangerously-skip-permissions':
        mode = 'bypassPermissions'
        break
      case '--output-format':
        outputFormat = args[++i] ?? 'text'
        break
      case '--json-schema':
        jsonSchema = args[++i] ?? ''
        break
      // P6.317 (2) — subagent definitions for this run only, as JSON.
      // `sub-agents.md#choose-the-subagent-scope` gives the flag priority 2:
      // above `.claude/agents/`, `~/.claude/agents/` and plugin `agents/`,
      // below managed settings only. Nothing is written to disk.
      case '--agents':
        agents = args[++i] ?? ''
        break
      // Kept only so the token is not swallowed into `rest` (and, for `run`,
      // into the prompt). It no longer suppresses anything — see `CliArgs`.
      case '--no-cleanup':
        noCleanup = true
        break
      case '--no-session-persistence':
        noSessionPersistence = true
        break
      case '--disable-spinner':
      case '--no-spinner':
        noSpinner = true
        break
      case '--verbose':
      case '-v':
        verbose = true
        break
      // `env-vars.md:318` — "Equivalent to passing `--safe-mode`". The flag is
      // recorded here and exported as the env var before the server is
      // spawned, because the same line requires that "directly spawned child
      // processes inherit the variable": the capability funnel that actually
      // applies safe mode runs inside the server, not in this process.
      case '--safe-mode':
        safeMode = true
        attachInertFlags.push(arg)
        break
      case '--server-entry':
        serverEntry = args[++i]
        break
      case '--workspace-dir':
        workspaceDir = args[++i]
        break
      case '--provider':
        provider = args[++i] ?? ''
        break
      case '--model':
        model = args[++i] ?? ''
        break
      case '--fallback-model':
        fallbackModel = args[++i] ?? ''
        attachInertFlags.push(arg)
        break
      case '--settings':
        claudeSettings = args[++i] ?? ''
        attachInertFlags.push(arg)
        break
      // P6.930 clause (2). Recorded here and exported as the env var before the
      // server is spawned, for the same reason `--settings` is: the option is
      // built inside the claude child, which the SERVER spawns.
      case '--setting-sources':
        claudeSettingSources = args[++i] ?? ''
        attachInertFlags.push(arg)
        break
      // P6.930 clause (3). A `case` at all is the point — without one this is an
      // unknown flag and the run refuses to start; with one it is accepted, and
      // `main()` says what it does and does not do.
      case '--bare':
        bare = true
        break
      case '--api-key':
        apiKey = args[++i] ?? ''
        break
      case '--base-url':
        baseUrl = args[++i] ?? ''
        break
      case '--help':
      case '-h':
        command = 'help'
        break
      case '--version':
        command = 'version'
        break
      case '--validate-server':
        command = 'validate'
        break
      // End-of-flags sentinel. Everything after it is a positional, however it
      // is spelled — this is the escape hatch that keeps `invoke` able to pass
      // a JSON argument like `-1`, and a prompt able to start with a dash, now
      // that an unrecognized dash-token is an error rather than a prompt word.
      case '--':
        for (i = i + 1; i < args.length; i++) {
          const positional = args[i]
          if (!command) command = positional
          else rest.push(positional)
        }
        break
      default:
        if (!command && !arg.startsWith('-')) {
          command = arg
        } else if (
          arg.startsWith('-')
          && arg !== '-'
          && !PASSTHROUGH_SUBCOMMAND_FLAGS.has(arg)
        ) {
          // `headless.md:33` — an invalid flag is reported, not absorbed. It
          // used to land in `rest`, and for `run` that meant the operator's
          // flag text was concatenated into the PROMPT.
          unknownFlags.push(arg)
        } else {
          rest.push(arg)
        }
    }
  }

  // Env var fallbacks
  if (!url) url = process.env.NESSY_SERVER_URL ?? ''
  if (!token) token = process.env.NESSY_SERVER_TOKEN ?? ''
  if (!tlsCa) tlsCa = process.env.NESSY_TLS_CA
  if (!provider) provider = process.env.LLM_PROVIDER ?? 'anthropic'
  if (!model) model = process.env.LLM_MODEL ?? ''
  // The env var is the other half of the same switch, exactly like --safe-mode:
  // an inherited NESSY_FALLBACK_MODEL configures the chain without the flag.
  if (!fallbackModel) fallbackModel = process.env[FALLBACK_MODEL_ENV_VAR] ?? ''
  // The env var is the other half of the same switch, exactly like the two
  // above — an inherited NESSY_CLAUDE_SETTINGS configures the tier without the
  // flag. `cli-reference.md` gives `--settings` no env twin of its own, so
  // there is no documented Claude spelling to accept as an alias.
  if (!claudeSettings) claudeSettings = process.env[CLAUDE_FLAG_SETTINGS_ENV_VAR] ?? ''
  // The env twin again, and here it carries a documented value the flag alone
  // cannot: an inherited NESSY_CLAUDE_SETTING_SOURCES configures the list for a
  // server this CLI did not spawn.
  if (!claudeSettingSources) claudeSettingSources = process.env[CLAUDE_SETTING_SOURCES_ENV_VAR] ?? ''
  if (!apiKey) apiKey = process.env.LLM_API_KEY ?? ''
  if (!baseUrl) baseUrl = process.env.LLM_BASE_URL ?? ''
  // The env var is the other half of the same switch, so an inherited
  // `NESSY_SAFE_MODE=1` reports as safe mode even without the flag.
  if (!safeMode) safeMode = isSafeModeEnabled(process.env)
  // `cli-reference.md:105` — the env var "does the same in any mode", so an
  // inherited NESSY_SKIP_PROMPT_HISTORY / CLAUDE_CODE_SKIP_PROMPT_HISTORY makes
  // the session ephemeral without the flag.
  if (!noSessionPersistence) noSessionPersistence = isSkipPromptHistoryEnabled(process.env)

  return { url, token, workspace, timeout, json, tlsCa, sendTimeout, command, rest, sources, mode, outputFormat, jsonSchema, noCleanup, noSessionPersistence, noSpinner, verbose, serverEntry, workspaceDir, safeMode, provider, model, fallbackModel, claudeSettings, claudeSettingSources, bare, apiKey, baseUrl, unknownFlags, agents, attachInertFlags }
}

/**
 * Parse and gate the --json-schema value as JSON Schema draft-07 (R18).
 * Returns undefined when the flag is absent; throws with the documented
 * failure string (headless.md: "Error: --json-schema is not a valid JSON
 * Schema") when the value is not valid JSON or not a valid draft-07 schema.
 */
export function parseJsonSchemaArg(raw: string): Record<string, unknown> | undefined {
  if (!raw) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`--json-schema is not a valid JSON Schema (${error instanceof Error ? error.message : String(error)})`)
  }
  try {
    compileStructuredOutputSchema(parsed)
  } catch (error) {
    throw new Error(`--json-schema is not a valid JSON Schema (${error instanceof Error ? error.message : String(error)})`)
  }
  return parsed as Record<string, unknown>
}

/**
 * P6.317 (2) — parse and gate the `--agents` value.
 *
 * `sub-agents.md` describes the flag as JSON keyed by agent name, each value
 * carrying a `prompt` plus frontmatter fields. Only the OUTER shape is refused
 * here — a value that is not an object of objects can only ever be a typo — and
 * every FIELD refusal is left to the host, which reads these through the same
 * per-field validators a `.claude/agents/*.md` file goes through
 * (`buildSessionAgentDescriptor`). Validating fields twice, in two processes,
 * with two vocabularies is how the two answers drift apart; the host names the
 * agent and the field in its diagnostic, and the CLI would only be able to
 * repeat it worse.
 *
 * A malformed entry therefore does NOT fail the run: the host excludes that one
 * definition and names it, exactly as it does for a malformed file (A1). What
 * fails the run is text that is not the flag's shape at all, because then no
 * agent was registered and the operator asked for some.
 *
 * Returns undefined when the flag is absent; throws with the reason otherwise.
 */
export function parseAgentsArg(raw: string): Record<string, Record<string, unknown>> | undefined {
  if (!raw) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`--agents is not valid JSON (${error instanceof Error ? error.message : String(error)})`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--agents expects a JSON object keyed by agent name')
  }
  const entries = Object.entries(parsed as Record<string, unknown>)
  if (entries.length === 0) {
    throw new Error('--agents expects a JSON object keyed by agent name')
  }
  for (const [name, definition] of entries) {
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
      throw new Error(`--agents entry "${name}" expects an object with a prompt`)
    }
  }
  return parsed as Record<string, Record<string, unknown>>
}

// ---------------------------------------------------------------------------
// Auto workspace resolution
// ---------------------------------------------------------------------------

async function resolveWorkspace(
  client: CliRpcClient,
  explicit?: string,
): Promise<string | undefined> {
  if (explicit) {
    // Bind client to the workspace so push events reach us
    await client.invoke('window:switchWorkspace', explicit).catch(() => {})
    return explicit
  }
  try {
    const workspaces = (await client.invoke('workspaces:get')) as any[]
    if (workspaces?.length > 0) {
      const id = workspaces[0].id
      await client.invoke('window:switchWorkspace', id).catch(() => {})
      return id
    }
  } catch {
    // Fall through — workspace may not be needed
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function out(data: unknown, jsonMode: boolean): void {
  if (jsonMode) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n')
  } else if (typeof data === 'string') {
    process.stdout.write(data + '\n')
  } else {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n')
  }
}

function err(msg: string): void {
  process.stderr.write(`Error: ${msg}\n`)
}

// ---------------------------------------------------------------------------
// ANSI colors (disabled when NO_COLOR is set or stdout is not a TTY)
// ---------------------------------------------------------------------------

const _useColor = !process.env.NO_COLOR && process.stdout.isTTY !== false
const c = {
  dim: (s: string) => _useColor ? `\x1b[2m${s}\x1b[22m` : s,
  green: (s: string) => _useColor ? `\x1b[32m${s}\x1b[39m` : s,
  red: (s: string) => _useColor ? `\x1b[31m${s}\x1b[39m` : s,
  cyan: (s: string) => _useColor ? `\x1b[36m${s}\x1b[39m` : s,
  bold: (s: string) => _useColor ? `\x1b[1m${s}\x1b[22m` : s,
  yellow: (s: string) => _useColor ? `\x1b[33m${s}\x1b[39m` : s,
  blue: (s: string) => _useColor ? `\x1b[34m${s}\x1b[39m` : s,
}

// ---------------------------------------------------------------------------
// Spinner (TTY only — skipped when piped or NO_COLOR)
// ---------------------------------------------------------------------------

const _spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function createSpinner(text: string): { stop(): void } {
  let i = 0
  let stopped = false
  // Render first frame immediately — setInterval alone misses fast steps
  process.stdout.write(`${text} ${c.dim(_spinnerFrames[i++ % _spinnerFrames.length])}`)
  const timer = setInterval(() => {
    process.stdout.write(`\r\x1b[2K${text} ${c.dim(_spinnerFrames[i++ % _spinnerFrames.length])}`)
  }, 80)
  return {
    stop() {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      process.stdout.write('\r\x1b[2K')
    },
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdPing(client: CliRpcClient, args: CliArgs): Promise<void> {
  const start = performance.now()
  const clientId = await client.connect()
  const latency = Math.round(performance.now() - start)
  out(
    args.json
      ? { clientId, latencyMs: latency }
      : `Connected: clientId=${clientId} latency=${latency}ms`,
    args.json,
  )
}

async function cmdHealth(client: CliRpcClient, args: CliArgs): Promise<void> {
  await client.connect()
  const result = await client.invoke('credentials:healthCheck')
  out(result, args.json)
}

async function cmdVersions(client: CliRpcClient, args: CliArgs): Promise<void> {
  await client.connect()
  const result = await client.invoke('system:versions')
  out(result, args.json)
}

async function cmdWorkspaces(client: CliRpcClient, args: CliArgs): Promise<void> {
  await client.connect()
  const result = (await client.invoke('workspaces:get')) as any[]
  if (args.json) {
    out(result, true)
  } else {
    if (!result?.length) {
      out('No workspaces found', false)
      return
    }
    for (const ws of result) {
      out(`${ws.id}  ${ws.name ?? '(unnamed)'}  ${ws.path ?? ''}`, false)
    }
  }
}

async function cmdSessions(client: CliRpcClient, args: CliArgs): Promise<void> {
  await client.connect()
  const workspaceId = await resolveWorkspace(client, args.workspace)
  if (!workspaceId) {
    err('No workspace available. Use --workspace <id>')
    process.exit(1)
  }
  const result = (await client.invoke('sessions:get', workspaceId)) as any[]
  if (args.json) {
    out(result, true)
  } else {
    if (!result?.length) {
      out('No sessions found', false)
      return
    }
    for (const s of result) {
      const name = s.name ?? '(unnamed)'
      const preview = s.preview ? `  ${s.preview.slice(0, 60)}` : ''
      const status = s.isProcessing ? ' [processing]' : ''
      out(`${s.id}  ${name}${preview}${status}`, false)
    }
  }
}

async function cmdConnections(client: CliRpcClient, args: CliArgs): Promise<void> {
  await client.connect()
  const result = await client.invoke('LLM_Connection:list')
  out(result, args.json)
}

async function cmdSources(client: CliRpcClient, args: CliArgs): Promise<void> {
  await client.connect()
  const workspaceId = await resolveWorkspace(client, args.workspace)
  if (!workspaceId) {
    err('No workspace available. Use --workspace <id>')
    process.exit(1)
  }
  const result = await client.invoke('sources:get', workspaceId)
  out(result, args.json)
}

async function cmdSessionCreate(client: CliRpcClient, args: CliArgs): Promise<void> {
  await client.connect()
  const workspaceId = await resolveWorkspace(client, args.workspace)
  if (!workspaceId) {
    err('No workspace available. Use --workspace <id>')
    process.exit(1)
  }

  // Parse sub-args: --name <n>, --worktree [name|MR url]
  let name: string | undefined
  let worktree: string | boolean | undefined
  for (let i = 0; i < args.rest.length; i++) {
    if (args.rest[i] === '--name') name = args.rest[++i]
    // P6.335 — `--worktree` starts the session already isolated. Its optional
    // value is either a worktree slug or a merge-request URL; the HOST decides
    // which, by path segment, so the CLI does not carry a second copy of a
    // forge's URL contract. A bare `--worktree` (next token missing or another
    // flag) is the boolean form.
    else if (args.rest[i] === '--worktree') {
      const next = args.rest[i + 1]
      if (next !== undefined && !next.startsWith('-')) { worktree = next; i += 1 }
      else worktree = true
    }
  }

  const opts: Record<string, unknown> = {}
  if (name) opts.name = name
  if (worktree !== undefined) opts.worktree = worktree
  if (args.mode) opts.permissionMode = parsePermissionMode(args.mode) ?? args.mode
  // P6.317 (2) — the top-level flag, honoured by the other session-creating
  // verb too: `run` and `session create` mint the same DTO, so an operator who
  // creates a session up front and sends into it gets the same agents.
  const sessionAgents = parseAgentsArg(args.agents)
  if (sessionAgents) opts.agents = sessionAgents

  const result = await client.invoke('sessions:create', workspaceId, opts)
  out(result, args.json)
}

async function cmdSessionMessages(client: CliRpcClient, args: CliArgs): Promise<void> {
  const sessionId = args.rest[0]
  if (!sessionId) {
    err('Usage: session messages <session-id>')
    process.exit(1)
  }
  await client.connect()
  const result = await client.invoke('sessions:getMessages', sessionId)
  out(result, args.json)
}

/**
 * P6.279 — rewind a session's files without the app.
 *
 * ## The premise that shrank this row, and the one that changed its shape
 *
 * W7-j measured that the OPERATION is already reachable headlessly:
 * `sessions:command` `{ type: 'revertFileCheckpoint', checkpointId }` reaches
 * `SessionManager.revertFileCheckpoint`, and the checkpoint LIST is already
 * projected onto `sessions:getPiHarnessRuntime`'s snapshot for every provider,
 * not only Pi. So nothing host-side was missing; what was missing was a verb.
 * Building the operation again would be a second mechanism beside a working
 * one.
 *
 * The hand-off said the CLI is "flag-driven, not verb-driven" and proposed
 * `--rewind <sessionId>`. **That is wrong at HEAD** and the correction is worth
 * recording: `session create|messages|delete` is a subcommand table, and a
 * fourth entry costs no new flags, no new parse case, and no risk of a token
 * meant as a prompt landing in `rest`.
 *
 * ## Listing and reverting are one verb with two arities
 *
 * A checkpoint id is opaque, so demanding one up front would make the verb
 * unusable without the app it exists to replace. With no id the verb LISTS; with
 * one it reverts.
 *
 * ## The three refusals, and why a no-op would have been the worst outcome
 *
 * An unknown session, an unknown checkpoint id, and a runtime that produces no
 * checkpoints at all each refuse BY NAME. The third is the one the row cares
 * about: on `anthropic` (codex-runtime got a producer in C3.67) the checkpoint store is EMPTY rather
 * than absent, so a rewind there succeeds while restoring nothing — reporting
 * "rewound" for an operation that could not have happened. That is the same lie
 * `RUNTIME_FILE_CHECKPOINT_PRODUCERS` exists to stop in the app, read here from
 * the same record.
 */
async function cmdSessionRewind(client: CliRpcClient, args: CliArgs): Promise<void> {
  const sessionId = args.rest[0]
  if (!sessionId) {
    err('Usage: session rewind <session-id> [checkpoint-id]')
    process.exit(1)
  }
  const checkpointId = args.rest[1]
  await client.connect()

  let snapshot: PiHarnessRuntimeSnapshotV1
  try {
    const result = await client.invoke('sessions:getPiHarnessRuntime', sessionId) as { snapshot: PiHarnessRuntimeSnapshotV1 }
    snapshot = result.snapshot
  } catch (e) {
    // `session-not-found` is the manager's own word for it; anything else is a
    // transport or server failure and must not be reported as a bad id.
    const message = e instanceof Error ? e.message : String(e)
    if (!message.includes('session-not-found')) throw e
    err(`Unknown session: ${sessionId}`)
    process.exit(1)
  }

  if (!runtimeProducesFileCheckpoints(snapshot.provider)) {
    // NOT an error exit: the session exists and the answer is complete. What it
    // must never do is print a successful rewind.
    out(
      args.json
        ? { sessionId, provider: snapshot.provider, checkpointsProduced: false, rewound: false }
        : noCheckpointProducerMessage(snapshot.provider),
      args.json,
    )
    return
  }

  const checkpoints = snapshot.checkpoints ?? []
  if (!checkpointId) {
    if (checkpoints.length === 0) {
      out(args.json ? { sessionId, checkpoints: [] } : 'This session has no file checkpoints yet.', args.json)
      return
    }
    out(
      args.json
        ? { sessionId, checkpoints }
        : checkpoints
          .map(entry => `${entry.id}  ${entry.createdAt}  ${entry.toolName}  ${entry.fileName}`
            + `${entry.revertedAt ? '  (already reverted)' : ''}`)
          .join('\n'),
      args.json,
    )
    return
  }

  // Refused HERE rather than by the manager: the id is checked against the list
  // this command just printed, so the refusal can say which session it looked in.
  if (!checkpoints.some(entry => entry.id === checkpointId)) {
    err(`Unknown checkpoint: ${checkpointId} (session ${sessionId} has ${checkpoints.length} checkpoint(s); run "session rewind ${sessionId}" to list them)`)
    process.exit(1)
  }

  const result = await client.invoke('sessions:command', sessionId, {
    type: 'revertFileCheckpoint',
    checkpointId,
  }) as FileCheckpointRevertResult

  if (args.json) {
    out(result, true)
    if (!result.success) process.exit(1)
    return
  }

  out(renderRewindResult(result, checkpointId), false)
  if (!result.success) process.exit(1)
}

/**
 * What a runtime with no checkpoint producer is told, instead of a rewind.
 *
 * Names the provider, because "nothing to rewind" without it reads as "this
 * session made no edits" — the exact confusion `RUNTIME_FILE_CHECKPOINT_PRODUCERS`
 * exists to prevent.
 */
export function noCheckpointProducerMessage(provider: string): string {
  return `No file checkpoints were produced on this runtime (${provider}), so there is nothing to rewind. `
    + 'File edits are checkpointed on the Pi and Nestor Cloud runtimes only.'
}

/**
 * The human rendering of one rewind, restored AND skipped.
 *
 * Pure, and separate from the command, so the `done_means`'s hardest clause —
 * "the same per-reason vocabulary the UI renders" — is asserted against every
 * member of the union rather than against whichever one a fixture happened to
 * carry. `SKIP_REASON_TEXT` is imported, never restated: a second copy would
 * drift from the app on the day a reason is added.
 */
export function renderRewindResult(result: FileCheckpointRevertResult, checkpointId: string): string {
  const lines: string[] = []
  const outcome = result.restored ? 'restored' : result.deleted ? 'deleted' : result.success ? 'no change' : 'failed'
  lines.push(`${outcome}${result.partial ? ' (partial)' : ''}: ${result.filePath ?? checkpointId}`)
  if (result.error) lines.push(`  ${result.error}`)
  for (const skipped of result.skippedPaths ?? []) {
    lines.push(`  skipped ${skipped.filePath}: ${SKIP_REASON_TEXT[skipped.reason]}`)
  }
  // Named separately from a skip: a skip is a path the rewind declined to
  // touch, an irreversible effect is one it could not have undone at all.
  for (const effect of result.irreversibleEffects ?? []) {
    lines.push(`  not undone: ${effect}`)
  }
  return lines.join('\n')
}

async function cmdSessionDelete(client: CliRpcClient, args: CliArgs): Promise<void> {
  const sessionId = args.rest[0]
  if (!sessionId) {
    err('Usage: session delete <session-id>')
    process.exit(1)
  }
  await client.connect()
  await client.invoke('sessions:delete', sessionId)
  out(args.json ? { deleted: sessionId } : `Deleted session: ${sessionId}`, args.json)
}

/**
 * P6.501 — offboard a project without the app.
 *
 * ## Nothing new deletes anything
 *
 * `WorkspaceService.delete` was already complete and transactional — both roots
 * staged into `.trash`, four cleanup participants, the credentials, a delete
 * journal, all under a quiescence lease — and had exactly ONE caller, the
 * Electron `workspace:remove` IPC. So a user offboarding on a headless install
 * had no supported route at all, which is the gap the row named at the scope
 * where it is actually true. This verb is the caller; `workspaces:delete` is the
 * seam.
 *
 * ## The residue sentence is printed, not returned
 *
 * The delegated decision (Q-den 18) chose option A: purge our own state and SAY
 * that codex's `~/.codex` history is untouched. B — deleting the sibling tool's
 * data too — was refused as irreversible, cross-application and not ours to
 * bound. The sentence is a CONSTANT rather than a field on the result, because
 * it does not vary with the outcome: our own `CODEX_HOME` is `mkdtempSync`ed and
 * `rmSync`ed per session, so a durable `~/.codex` is by definition the user's
 * OTHER codex.
 *
 * ## A partial purge must not print like a complete one
 *
 * `cleanupFailures` is named on the way out. The Electron path collapsed the
 * result to `deleted` until this row, and a purge whose credential or
 * plugin-data cleanup failed reported plain success — the exact shape of "it
 * said it was gone and it was not".
 */
async function cmdWorkspaceRemove(client: CliRpcClient, args: CliArgs): Promise<void> {
  const workspaceId = args.rest[0]
  if (!workspaceId) {
    err('Usage: workspace remove <workspace-id>')
    process.exit(1)
  }
  await client.connect()
  const result = (await client.invoke('workspaces:delete', workspaceId)) as {
    deleted: boolean
    cleanupFailures: Array<{ resource: string; code: string; message: string }>
  }
  if (args.json) {
    out({ ...result, untouched: ['~/.codex'] }, true)
    return
  }
  if (!result.deleted) {
    err(`Workspace was not removed: ${workspaceId}`)
    process.exit(1)
  }
  out(renderWorkspaceRemoval(result, workspaceId), false)
}

/**
 * P6.501 — the residue sentence, verbatim and unconditional.
 *
 * Exported so it can be pinned: an option-A decision whose disclosure is one
 * `lines.push` inside a command body is a disclosure that can be deleted by
 * accident, and nothing would notice. It does not vary with the result, because
 * the fact it states does not: our own `CODEX_HOME` is `mkdtempSync`ed and
 * `rmSync`ed per session, so a durable `~/.codex` is by definition the user's
 * OTHER codex.
 */
export const WORKSPACE_REMOVAL_RESIDUE_TEXT =
  "Nessy's own records for this project are gone. Your Codex CLI history in ~/.codex belongs to a separate tool and was not touched."

export function renderWorkspaceRemoval(
  result: { deleted: boolean; cleanupFailures: Array<{ resource: string; code: string; message: string }> },
  workspaceId: string,
): string {
  const lines = [`Removed workspace: ${workspaceId}`]
  for (const failure of result.cleanupFailures) {
    lines.push(`  not cleaned up: ${failure.resource} (${failure.code}) ${failure.message}`)
  }
  lines.push(WORKSPACE_REMOVAL_RESIDUE_TEXT)
  return lines.join('\n')
}

/**
 * The ceiling on piped stdin.
 *
 * `headless.md:88`, the whole Note: "Piped stdin is capped at 10MB. If you
 * exceed the cap, Claude Code exits with a clear error and a non-zero status.
 * To work with larger inputs, write the content to a file and reference the
 * file path in your prompt instead of piping it."
 *
 * The page writes "10MB" without units. MiB is the reading taken here, because
 * it is the convention this repo's own limits already use
 * (`pi-harness/process-supervisor.ts` caps at 1 MiB / 64 KiB) and because the
 * 4.6% difference is immaterial at a ceiling that exists to stop an OOM rather
 * than to be exact. If a doc revision ever pins the decimal value, change this
 * constant and nothing else.
 */
export const MAX_PIPED_STDIN_BYTES = 10 * 1024 * 1024

/** The message the breach reports, ending in the workaround the page names. */
export const PIPED_STDIN_LIMIT_MESSAGE =
  'Piped input exceeds the 10MB stdin limit. '
  + 'Write the content to a file and reference the file path in your prompt instead of piping it.'

/**
 * P6.458 · what an UNREADABLE stdin says, and why it is a warning rather than a
 * failure.
 *
 * `headless.md#pipe-data-through-claude`, whole sentence: "If Claude Code can't
 * read stdin, for example because the process that started it disconnected its
 * end, Claude Code prints a warning to stderr and continues with the prompt
 * from the command line."
 *
 * Measured here before this branch existed (2026-09-06, darwin-arm64, stdin
 * pointed at a directory fd): `Error: EISDIR: illegal operation on a directory,
 * fstat` on stderr and **exit 1**, with the command-line prompt discarded. So
 * the run was never silent — the divergence was that it stopped. Closing the
 * descriptor instead (`0<&-`) is NOT this case on darwin: that reads as EOF and
 * the run proceeds normally.
 *
 * The cap's error is deliberately NOT routed here: it is thrown by us after a
 * successful read, so it stays a hard non-zero exit.
 */
export const PIPED_STDIN_UNREADABLE_PREFIX = 'Warning: could not read piped stdin'

/** Builds the whole warning line, so the test and the run cannot drift apart. */
export function pipedStdinUnreadableWarning(reason: string): string {
  return `${PIPED_STDIN_UNREADABLE_PREFIX} (${reason}); continuing with the prompt from the command line`
}

/**
 * Read prompt text from positional args + stdin.
 * If there are positional words, they become the base message.
 * Reads stdin when: --stdin flag is present, or no message and stdin is piped (not a TTY).
 *
 * The cap is measured on RAW BYTES off the pipe, not on the decoded string's
 * `.length` — a multibyte payload would sail past a character count — and it
 * fails FAST: the reader is cancelled the moment the running total crosses the
 * ceiling, before the offending chunk is retained. Draining first and checking
 * afterwards would let a multi-gigabyte pipe exhaust memory before the error
 * could be printed, which is the failure the cap exists to prevent.
 *
 * Throws rather than exiting, so it stays unit-testable and so each caller
 * reports it the way that caller already reports a startup failure.
 *
 * `stdinStream` is injected only for tests; production always reads `Bun.stdin`.
 */
export async function readPrompt(
  words: string[],
  restArgs?: string[],
  stdinStream?: ReadableStream<Uint8Array>,
): Promise<string> {
  let message = words.join(' ')

  const wantsStdin = restArgs?.includes('--stdin')
  const isTTY = typeof process.stdin.isTTY === 'boolean' ? process.stdin.isTTY : false
  if (wantsStdin || (!message && !isTTY)) {
    const chunks: string[] = []
    const decoder = new TextDecoder()
    let bytes = 0
    let unreadable = false
    // P6.458 · `err()` prefixes `Error: `, which would misreport a warning that
    // does not end the run, so the line goes to the same stream directly.
    const warnUnreadable = (e: unknown): void => {
      process.stderr.write(pipedStdinUnreadableWarning(e instanceof Error ? e.message : String(e)) + '\n')
      unreadable = true
    }

    // P6.458 · OPENING the stream is its own failure point, and it is the one
    // that fires in practice: measured on darwin-arm64 with stdin pointed at a
    // directory fd, `Bun.stdin.stream()` throws `EISDIR … fstat` here and the
    // read loop is never reached. A catch around `read()` alone would have left
    // the measured case behaving exactly as before.
    // Deliberately un-annotated: the two `ReadableStreamDefaultReader` types in
    // scope here (lib.dom's and `stream/web`'s) disagree on `readMany`, so an
    // explicit annotation picks a fight the inferred type does not have.
    let reader
    try {
      reader = (stdinStream ?? Bun.stdin.stream()).getReader()
    } catch (e) {
      warnUnreadable(e)
    }

    while (reader) {
      // Only the READ is caught. A rejection here is an unreadable pipe, which
      // the page answers with a warning and a continued run; the cap below is
      // our own throw after a successful read and must stay fatal.
      const outcome = await reader.read().then(
        (chunk) => ({ ok: true as const, chunk }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      if (!outcome.ok) {
        warnUnreadable(outcome.error)
        await reader.cancel().catch(() => {})
        break
      }
      const { done, value } = outcome.chunk
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_PIPED_STDIN_BYTES) {
        await reader.cancel().catch(() => {})
        throw new Error(PIPED_STDIN_LIMIT_MESSAGE)
      }
      chunks.push(decoder.decode(value, { stream: true }))
    }
    // Flush the streaming decoder: without it a trailing incomplete multibyte
    // sequence is silently dropped.
    chunks.push(decoder.decode())
    const stdinText = chunks.join('')
    // P6.458 · an unreadable pipe continues with the command-line prompt
    // EXACTLY as given: appending a separator for a read that never happened
    // would put a trailing newline into a prompt the user typed. An empty but
    // readable pipe still joins, which is unchanged.
    if (!unreadable) message = message ? `${message}\n${stdinText}` : stdinText
  }

  return message
}

/**
 * The `system/init` frame's own fields, plus whatever `capabilities:getHeadlessInit`
 * supplied. Structurally the projection in
 * `packages/shared/src/capabilities/views.ts` (`HeadlessInitView`); typed
 * loosely here so `apps/cli` keeps its narrow dependency surface.
 */
interface HeadlessInitPayload {
  plugins?: Array<{ name: string; path?: string }>
  plugin_errors?: Array<{ plugin: string; type: string; message: string }>
  mcp_servers?: Array<{ name: string; status: string }>
  mcp_server_errors?: Array<{ name: string; type: string; message: string }>
}

/**
 * Write the headless stream's mandated first line.
 *
 * `best-practices.md:482` — "The `stream-json` format prints one JSON object per
 * line, starting with an init event"; `headless.md:197` spells that frame
 * `system/init` and makes it "the first event in the stream unless startup
 * events precede it".
 *
 * CASING: this frame is snake_case, per the page, and every line after it is a
 * verbatim Nessy `session:event` in our own camelCase. The mix is deliberate and
 * documented rather than reconciled — see `HeadlessInitView` in
 * `packages/shared/src/capabilities/views.ts` for why "fixing" either side
 * breaks a real consumer.
 *
 * A failed or absent capability read degrades to a frame without the four
 * arrays; it never aborts the run. It is called AFTER the `session:event`
 * subscription is installed so no event can slip in front of it, and before the
 * send so it is genuinely line 1.
 */
function writeHeadlessInitFrame(
  sessionId: string,
  args: CliArgs,
  payload: HeadlessInitPayload | undefined,
): void {
  const mode = args.mode ? parsePermissionMode(args.mode) ?? args.mode : undefined
  process.stdout.write(JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    cwd: args.workspaceDir ? resolve(args.workspaceDir) : process.cwd(),
    ...(args.model ? { model: args.model } : {}),
    ...(mode ? { permission_mode: mode } : {}),
    ...(args.sources.length > 0 ? { sources: args.sources } : {}),
    output_format: 'stream-json',
    plugins: payload?.plugins ?? [],
    mcp_servers: payload?.mcp_servers ?? [],
    // `:211` and `:220` — both keys are OMITTED when there is nothing to
    // report, which is what lets a CI gate be `jq -e '.mcp_server_errors'`
    // rather than a length comparison. Never emit an empty array here.
    ...(payload?.plugin_errors?.length ? { plugin_errors: payload.plugin_errors } : {}),
    ...(payload?.mcp_server_errors?.length ? { mcp_server_errors: payload.mcp_server_errors } : {}),
  }) + '\n')
}

/**
 * `headless.md:222` — "When you run the command by hand in a terminal, Claude
 * Code also prints a startup warning to stderr, such as `Warning: 1 MCP server
 * skipped due to invalid config:`, followed by the reason for each skipped
 * entry."
 *
 * Read the WHOLE line: the same sentence continues "When you redirect stderr,
 * or when a program such as a CI runner or an SDK host captures it, Claude Code
 * prints no warning and reports the skipped entries only in the
 * `mcp_server_errors` field." So the warning is gated on stderr being a TTY —
 * a captured stderr must stay clean, and the stream is then the only channel.
 */
function warnSkippedMcpServers(payload: HeadlessInitPayload | undefined): void {
  const skipped = payload?.mcp_server_errors ?? []
  if (skipped.length === 0) return
  if (process.stderr.isTTY !== true) return
  process.stderr.write(`Warning: ${skipped.length} MCP server${skipped.length === 1 ? '' : 's'} skipped due to invalid config:\n`)
  for (const entry of skipped) {
    process.stderr.write(`  ${entry.name}: ${entry.message}\n`)
  }
}

/** Best-effort headless init payload; any failure degrades to `undefined`. */
async function readHeadlessInit(
  client: CliRpcClient,
  sessionId: string,
  workspaceId: string | undefined,
): Promise<HeadlessInitPayload | undefined> {
  if (!workspaceId) return undefined
  try {
    const result = await client.invoke('capabilities:getHeadlessInit', { workspaceId, sessionId })
    return (result ?? undefined) as HeadlessInitPayload | undefined
  } catch {
    return undefined
  }
}

/**
 * P6.371 · how long json mode waits for the `complete` event after a terminal
 * `text_complete`. `complete` carries the usage and cost the envelope reports,
 * and it arrives in the same burst; the grace exists so a run that emits no
 * `complete` at all ends about when `--output-format text` would have ended,
 * rather than waiting out the whole `--send-timeout`.
 */
const JSON_COMPLETE_GRACE_MS = 250

/**
 * P6.371 · the `--output-format json` envelope.
 *
 * `headless.md#get-structured-output` names the three format values and says of
 * this one, verbatim: "`json`: structured JSON with result, session ID, and
 * metadata". Its two `jq` examples are the field contract —
 * `jq -r '.result'` and `jq '.structured_output'` — and
 * `headless.md#continue-conversations` adds a third, `jq -r '.session_id'`.
 * `headless.md#pipe-data-through-claude` names `total_cost_usd` and a per-model
 * cost breakdown as part of the payload.
 *
 * Fields are snake_case because every documented `jq` path is, and a field is
 * OMITTED rather than nulled when this product has no figure for it: an absent
 * `total_cost_usd` means "this backend reported no cost", which is not the same
 * fact as zero. `num_turns` is deliberately not emitted — no page sentence in
 * this corpus defines it for our `run`/`send`, and inventing a constant 1 would
 * be a number a script could believe.
 */
export function buildResultEnvelope(input: {
  sessionId: string
  result: string
  subtype: string
  isError: boolean
  durationMs: number
  usage?: Record<string, unknown>
  structuredOutput?: unknown
  hasSchema: boolean
}): Record<string, unknown> {
  const envelope: Record<string, unknown> = {
    type: 'result',
    subtype: input.subtype,
    is_error: input.isError,
    result: input.result,
    session_id: input.sessionId,
    duration_ms: input.durationMs,
  }
  const usage = input.usage
  if (usage) {
    const tokens: Record<string, unknown> = {}
    const carry = (from: string, to: string): void => {
      if (typeof usage[from] === 'number') tokens[to] = usage[from]
    }
    carry('inputTokens', 'input_tokens')
    carry('outputTokens', 'output_tokens')
    carry('cacheReadTokens', 'cache_read_input_tokens')
    carry('cacheCreationTokens', 'cache_creation_input_tokens')
    if (Object.keys(tokens).length > 0) envelope.usage = tokens
    if (typeof usage.costUsd === 'number') envelope.total_cost_usd = usage.costUsd
    if (usage.modelUsage && typeof usage.modelUsage === 'object') envelope.model_usage = usage.modelUsage
  }
  // Present whenever a schema rode the run, so a `jq '.structured_output'` on a
  // run that failed validation reads `null` rather than nothing — the failure is
  // then told apart by `is_error` and `subtype`.
  if (input.hasSchema) envelope.structured_output = input.structuredOutput ?? null
  return envelope
}

/**
 * Subscribe to session events, send the message, stream output, wait for completion.
 * Returns the exit code (0 = success, 1 = error, 130 = interrupted).
 *
 * `workspaceId` is the caller's bound workspace, and it is what
 * `capabilities:getHeadlessInit`'s scope check compares against. Optional
 * because a `send` without `--workspace` has none; the init frame then degrades
 * to its own fields rather than failing.
 */
export async function sendAndStream(
  client: CliRpcClient,
  sessionId: string,
  message: string,
  args: CliArgs,
  workspaceId?: string,
): Promise<number> {
  let exitCode = 0
  let finished = false
  const turnText = new CliTurnText() // F1.472 — the streamed text, and the partial a text_discard voids
  const streamJson = args.outputFormat === 'stream-json'
  // R18 headless structured output: already gated by the caller; parse again
  // through the single gate to get the schema object for the send options.
  const outputSchema = parseJsonSchemaArg(args.jsonSchema)
  // Print-mode semantics when a schema rides the run: suppress streaming text
  // and print only the result's .structured_output on completion.
  const structuredMode = outputSchema !== undefined && !streamJson
  // P6.371 · `--output-format json` parsed and branched nowhere, so it printed
  // exactly what `text` prints and the documented `jq '.structured_output'`
  // resolved to null. `headless.md#get-structured-output` names the three
  // values — "`json`: structured JSON with result, session ID, and metadata" —
  // and its `jq` examples read `.result` and `.structured_output`, so those two
  // paths are the contract this envelope is built to.
  const jsonMode = args.outputFormat === 'json'
  const startedAt = Date.now()
  let resultSubtype = 'success'
  let structuredOutput: unknown
  let completeUsage: Record<string, unknown> | undefined

  const unsub = client.on('session:event', async (event: unknown) => {
    const ev = event as { type: string; sessionId: string; [key: string]: unknown }
    if (ev.sessionId !== sessionId) return

    if (streamJson) {
      process.stdout.write(JSON.stringify(ev) + '\n')
    }

    switch (ev.type) {
      case 'text_delta':
        turnText.delta((ev.displayDelta ?? ev.delta) as string, ev.turnId)
        // R32 · a MessageDisplay hook's replacement is what a DISPLAY shows;
        // absent means the original (hooks.md:740, :1311). `stream-json` above
        // already wrote the whole event verbatim — a machine consumer is not a
        // display, and it needs the original plus the override, not one of them.
        if (!jsonMode && !streamJson && !structuredMode) process.stdout.write((ev.displayDelta ?? ev.delta) as string)
        break
      case 'text_discard':
        if (turnText.discard(ev.turnId) && !jsonMode && !streamJson && !structuredMode) process.stdout.write(TEXT_DISCARD_DELIMITER)
        break
      case 'text_complete':
        // Subagent (Task) child turns emit non-intermediate text_complete with
        // parentToolUseId set — they must not finish or print the parent turn.
        if (!turnText.sawDelta && !ev.parentToolUseId && typeof ev.text === 'string') {
          const text = typeof ev.displayText === 'string' ? ev.displayText : ev.text
          turnText.append(text)
          if (!jsonMode && !streamJson && !structuredMode) process.stdout.write(text)
        }
        // In structured mode the turn result rides the complete event — wait for it.
        if (ev.isIntermediate !== true && !ev.parentToolUseId && !structuredMode) {
          // json mode's envelope carries the usage and cost that ride `complete`,
          // so finishing here would print metadata-less. Give that event a short
          // grace rather than the whole `--send-timeout`: a run that emits no
          // `complete` at all still ends about when `text` would have ended.
          if (jsonMode) setTimeout(() => { finished = true }, JSON_COMPLETE_GRACE_MS)
          else finished = true
        }
        break
      case 'tool_start':
        if (!streamJson && !structuredMode && !jsonMode) process.stdout.write(`\n[tool: ${ev.toolName}${ev.toolIntent ? ` — ${ev.toolIntent}` : ''}]\n`)
        break
      case 'tool_result': {
        if (!streamJson && !structuredMode && !jsonMode) {
          const result = String(ev.result ?? '')
          if (result.length > 200) {
            process.stdout.write(`${result.slice(0, 200)}...\n`)
          } else if (result) {
            process.stdout.write(`${result}\n`)
          }
        }
        break
      }
      // T3 (2026-08-12 sandbox-default-off-and-bypass-cli-parity): rung 1 of
      // the decision ladder — `permission_request` already rides this same
      // `session:event` channel, and `sessions:respondToPermission` is the
      // same RPC an interactive client (Electron/iOS) already calls to
      // answer one, so no new wire is needed to see or answer it here. A
      // non-interactive run has no dialog to show, so every request is
      // denied immediately instead of hanging until --send-timeout —
      // `headless.md`'s "the run aborts when one is attempted", made
      // explicit.
      case 'permission_request': {
        const requestId = (ev.request as { requestId?: string } | undefined)?.requestId
        if (typeof requestId === 'string') {
          await client.invoke('sessions:respondToPermission', sessionId, requestId, false, false).catch(() => {})
        }
        if (!streamJson) {
          err('permission denied (non-interactive run): pass --permission-mode bypassPermissions or pre-approve with allow rules')
        }
        resultSubtype = 'error_during_execution'
        exitCode = 1
        finished = true
        break
      }
      case 'error':
        if (!streamJson) err(String(ev.error))
        resultSubtype = 'error_during_execution'
        exitCode = 1
        finished = true
        break
      case 'typed_error': {
        const typed = ev.error as { title?: string; message?: string; code?: string; originalError?: string } | undefined
        const summary = [typed?.title, typed?.message].filter(Boolean).join(': ')
          || typed?.code
          || 'Session returned an error'
        const message = typed?.originalError ? `${summary} (${typed.originalError})` : summary
        if (!streamJson) err(message)
        resultSubtype = 'error_during_execution'
        exitCode = 1
        finished = true
        break
      }
      case 'complete':
        if (ev.usage && typeof ev.usage === 'object') completeUsage = ev.usage as Record<string, unknown>
        if (structuredMode) {
          // Mirror the documented result handling: success + present output is
          // the only success; exhaustion and success-without-output both fail,
          // told apart via the errors list.
          if (ev.structuredOutputSubtype === 'success' && ev.structuredOutput !== undefined) {
            structuredOutput = ev.structuredOutput
            // `--json-schema` WITHOUT `--output-format json` keeps printing the
            // bare validated object, which is today's output and stays
            // byte-identical. With `json` it rides the envelope's
            // `structured_output` instead — the path the page's `jq` example
            // reads, and the one that resolved to null before this row.
            if (!jsonMode) process.stdout.write(JSON.stringify(ev.structuredOutput, null, 2) + '\n')
          } else if (ev.structuredOutputSubtype === 'error_max_structured_output_retries') {
            resultSubtype = 'error_max_structured_output_retries'
            const errors = Array.isArray(ev.structuredOutputErrors) ? ev.structuredOutputErrors.join('; ') : ''
            err(`Could not produce valid structured output${errors ? `: ${errors}` : ''}`)
            exitCode = 1
          } else {
            resultSubtype = 'error_during_execution'
            const errors = Array.isArray(ev.structuredOutputErrors) ? ev.structuredOutputErrors.join('; ') : ''
            err(`Run ended without a structured output${errors ? `: ${errors}` : ''}`)
            exitCode = 1
          }
        } else if (!streamJson && !jsonMode) {
          process.stdout.write('\n')
        }
        finished = true
        break
      case 'interrupted':
        if (!streamJson && !jsonMode) process.stdout.write('\n[interrupted]\n')
        resultSubtype = 'interrupted'
        exitCode = 130
        finished = true
        break
    }
  })

  // The subscription above is already installed, so nothing can be written to
  // stdout ahead of this line; the send below is what starts the stream. Both
  // reads happen here, in either output format, because the stderr warning is
  // NOT stream-json-only (`headless.md:222` describes a plain terminal run).
  const headlessInit = await readHeadlessInit(client, sessionId, workspaceId)
  warnSkippedMcpServers(headlessInit)
  if (streamJson) writeHeadlessInitFrame(sessionId, args, headlessInit)

  // Only a schema-bearing send passes the extra positional args — a plain send
  // stays byte-identical on the wire (no trailing nulls after serialization).
  if (outputSchema) {
    await client.invoke('sessions:sendMessage', sessionId, message, undefined, undefined, { outputSchema })
  } else {
    await client.invoke('sessions:sendMessage', sessionId, message)
  }

  // D1.153 — a server that DIED is not a turn that is taking its time.
  //
  // Measured 2026-09-17 on this file's own mock rig: with the socket gone,
  // `finished` can never become true, so this loop ran out the entire
  // `--send-timeout` — five minutes by default — and then reported "Send
  // timeout — no completion event received". A CI gate reading that learns the
  // wrong cause, minutes late, and W19-r's real-child arm (2026-09-13, C3.103)
  // saw the same kill reported as a clean run.
  //
  // The client is the detector and no new wire is needed: it has no
  // auto-reconnect, so `isConnected` goes false on close and stays false.
  // `isDestroyed` separates the two closures that look identical here — the
  // signal handler's `cleanup()` and the normal exit destroy this client on
  // purpose, and that is an exit already under way, not a failure to report.
  let lostServer = false
  const deadline = Date.now() + args.sendTimeout
  while (!finished && Date.now() < deadline) {
    if (!client.isConnected) {
      lostServer = !client.isDestroyed
      break
    }
    await new Promise((r) => setTimeout(r, 100))
  }

  unsub()

  if (lostServer) {
    err('Connection to the server was lost before the turn completed')
    resultSubtype = 'error_during_execution'
    if (exitCode === 0) exitCode = 1
  } else if (!finished) {
    // A client this process destroyed is an exit already under way — the signal
    // handler calls `cleanup()` and then `process.exit`. Say nothing about a
    // timeout that did not happen; still never report success for a turn that
    // did not finish.
    if (!client.isDestroyed) err('Send timeout — no completion event received')
    resultSubtype = 'error_during_execution'
    exitCode = 1
  }

  if (jsonMode) {
    process.stdout.write(JSON.stringify(buildResultEnvelope({
      sessionId,
      result: turnText.text,
      subtype: resultSubtype,
      isError: exitCode !== 0,
      durationMs: Date.now() - startedAt,
      usage: completeUsage,
      structuredOutput,
      hasSchema: outputSchema !== undefined,
    }), null, 2) + '\n')
  }

  return exitCode
}

async function cmdSend(client: CliRpcClient, args: CliArgs): Promise<void> {
  const sessionId = args.rest[0]
  if (!sessionId) {
    err('Usage: send <session-id> <message>')
    process.exit(1)
  }

  const message = await readPrompt(args.rest.slice(1), args.rest)
  if (!message.trim()) {
    err('No message provided')
    process.exit(1)
  }

  // R18: gate the schema BEFORE connecting — the documented fail-at-startup shape.
  try {
    parseJsonSchemaArg(args.jsonSchema)
  } catch (e) {
    err(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }

  await client.connect()
  // `send` already binds its client to `--workspace` in the connect envelope
  // (`main()`'s `new CliRpcClient(..., { workspaceId: args.workspace })`), which
  // is what `capabilities:getHeadlessInit`'s scope check reads. Without the flag
  // there is no bound workspace and the init frame degrades to its own fields —
  // never an error, and never a second `window:switchWorkspace` that would
  // re-point this client's workspace-routed session events.
  const exitCode = await sendAndStream(client, sessionId, message, args, args.workspace)
  client.destroy()
  process.exit(exitCode)
}

interface LocalServer {
  client: CliRpcClient
  stop: () => Promise<void>
}

async function spawnLocalServer(
  args: CliArgs,
  opts?: { quiet?: boolean; printMode?: boolean },
): Promise<LocalServer> {
  const { spawnServer } = await import('./server-spawner.ts')
  process.stderr.write('Starting server...\n')
  if (args.safeMode) {
    process.stderr.write('Safe mode: no CLAUDE.md, skills, plugins, hooks, MCP servers, commands or agents will be loaded. Managed policy still applies.\n')
  }
  const server = await spawnServer({
    serverEntry: args.serverEntry,
    startupTimeout: args.timeout > 30_000 ? args.timeout : 30_000,
    quiet: opts?.quiet,
    // Inherited by the server and by every process it spawns, which is where
    // the single capability gate lives. `env-vars.md:307`'s wait for background
    // work rides the same channel: `run` is our non-interactive `-p` mode, and
    // the agent subprocess is where the wait actually happens.
    env: {
      ...(args.safeMode ? { [SAFE_MODE_ENV_VAR]: '1' } : {}),
      ...(opts?.printMode ? { [PRINT_MODE_ENV_VAR]: '1' } : {}),
      // `model-config.md:366`/`:381` — the flag's chain, ahead of the setting,
      // for every session this server runs. Not scoped to print mode: `:366`
      // sets a chain "for one session", and the whats-new line the flag comes
      // from is explicit that it applies to interactive sessions too.
      ...(args.fallbackModel ? { [FALLBACK_MODEL_ENV_VAR]: args.fallbackModel } : {}),
      // P6.439 clause (1). Same channel and the same reason as the two above:
      // the tier is applied by the claude child, which the SERVER spawns, so
      // the flag has to reach that process rather than this one.
      ...(args.claudeSettings ? { [CLAUDE_FLAG_SETTINGS_ENV_VAR]: args.claudeSettings } : {}),
      // P6.930 clause (2). Passed through raw: this side says what a narrowing
      // dropped, and the backend re-resolves the same string where the option is
      // actually built, so there is one parser rather than two spellings.
      ...(args.claudeSettingSources
        ? { [CLAUDE_SETTING_SOURCES_ENV_VAR]: args.claudeSettingSources }
        : {}),
    },
  })
  process.stderr.write(`Server ready: ${server.url}\n`)
  const client = new CliRpcClient(server.url, {
    token: server.token,
    requestTimeout: args.timeout,
  })
  return { client, stop: server.stop }
}

// ---------------------------------------------------------------------------
// LLM connection helpers
// ---------------------------------------------------------------------------

const PROVIDER_ENV_KEYS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  xai: 'XAI_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  huggingface: 'HUGGINGFACE_API_KEY',
}

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  openrouter: 'OpenRouter',
  groq: 'Groq',
  mistral: 'Mistral',
  deepseek: 'DeepSeek',
  xai: 'xAI',
  cerebras: 'Cerebras',
  huggingface: 'Hugging Face',
  'amazon-bedrock': 'Amazon Bedrock',
}

function getProviderDisplayName(provider: string): string {
  return PROVIDER_DISPLAY_NAMES[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1)
}

/**
 * D1.212 — WHICH WIRE `--base-url` SPEAKS, and why the row that asked for a
 * flag gets a sentence instead.
 *
 * The row was born reading *"the CLI cannot be pointed at a stub"*. It can, and
 * this function is the whole of the mechanism: the wire follows `--provider`
 * and never the URL. Measured at HEAD on 2026-09-17 with one loopback stub and
 * two arms four minutes apart (load 9.8, no credentials, a fabricated key):
 *
 * - `--provider openai --base-url <stub>/v1` — exit 0 in 21 s, the three stub
 *   tokens on stdout, the stub hit twice at `POST /v1/chat/completions`.
 * - `--base-url <stub>/v1` alone (so `--provider` defaults to `anthropic`) —
 *   exit 1 in 4 s, empty stdout, *"Anthropic stream ended without a stop
 *   reason"*, the stub hit three times at `POST /v1/v1/messages`.
 *
 * So the confound a credential-free signal rig hits is the DEFAULT, not a
 * missing capability, and the smallest honest repair is to say so where the
 * user chooses: `--base-url`'s own help line names both wires and both paths.
 * A `--wire` flag was declined on the owner criterion (least code, prefer what
 * the tree already ships) — it would be a second spelling of a choice
 * `--provider` already makes, and two spellings of one choice is the
 * divergence, not the fix.
 *
 * The other half of the row — *"the server needs `--timeout 300000`, it takes
 * ~200 s to print its URL"* — is a reading with a date and does not reproduce:
 * on both arms above the spawned server printed `NESSY_SERVER_URL` about three
 * seconds in, well inside the 30 000 ms floor. `--timeout` still raises the
 * startup budget as well as the request budget (they are one number here), so
 * the advice is harmless; the number is not a property of this CLI.
 */
export function buildCustomEndpointSetupFields(provider: string, explicitModel?: string): {
  customEndpoint: { api: 'anthropic-messages' | 'openai-completions' }
  defaultModel: string
  models: string[]
} {
  const defaultModel = explicitModel?.trim()
    || (provider === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-4o')

  return {
    customEndpoint: {
      api: provider === 'anthropic' ? 'anthropic-messages' : 'openai-completions',
    },
    defaultModel,
    models: [defaultModel],
  }
}

export function resolveApiKey(provider: string, explicit: string): string {
  if (explicit) return explicit
  if (provider === 'amazon-bedrock') return '' // IAM credentials, not API key
  const envKey = PROVIDER_ENV_KEYS[provider]
  if (envKey && process.env[envKey]) return process.env[envKey]!
  throw new Error(
    `No API key found. Use --api-key, set $LLM_API_KEY, or set $${envKey ?? `${provider.toUpperCase()}_API_KEY`}`,
  )
}

export function shouldSetupLlmConnection(existingConnectionCount: number, args: Pick<CliArgs, 'provider' | 'baseUrl'>): boolean {
  return existingConnectionCount === 0 || !!args.baseUrl || args.provider !== 'anthropic'
}

async function setupLlmConnection(
  client: CliRpcClient,
  args: CliArgs,
): Promise<{ connectionSlug: string }> {
  const { provider, baseUrl } = args
  const key = resolveApiKey(provider, args.apiKey)
  const connectionSlug = `${provider}-cli`

  let providerType: string
  let authType: string
  const setupPayload: Record<string, unknown> = { slug: connectionSlug, credential: key }

  if (baseUrl) {
    // Custom endpoint — send the same payload shape as the desktop UI.
    // The server handler (llm-connections.ts:102-110) detects customEndpoint + baseUrl
    // and sets providerType='pi_compat', piAuthProvider, etc.
    providerType = 'pi_compat'
    authType = 'api_key_with_endpoint'
    const endpointFields = buildCustomEndpointSetupFields(provider, args.model)
    setupPayload.baseUrl = baseUrl
    setupPayload.customEndpoint = endpointFields.customEndpoint
    setupPayload.defaultModel = endpointFields.defaultModel
    setupPayload.models = endpointFields.models
  } else if (provider === 'anthropic') {
    providerType = 'anthropic'
    authType = 'api_key'
  } else if (provider === 'amazon-bedrock') {
    // Bedrock uses IAM credentials, not a single API key
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
    const region = process.env.AWS_REGION || 'us-east-1'
    const sessionToken = process.env.AWS_SESSION_TOKEN
    if (!accessKeyId || !secretAccessKey) {
      throw new Error(
        'Amazon Bedrock requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables',
      )
    }
    providerType = 'pi'
    authType = 'iam_credentials'
    setupPayload.piAuthProvider = 'amazon-bedrock'
    setupPayload.bedrockAuthMethod = 'iam_credentials'
    setupPayload.iamCredentials = { accessKeyId, secretAccessKey, sessionToken }
    setupPayload.awsRegion = region
    delete setupPayload.credential // IAM credentials go through iamCredentials field
  } else {
    providerType = 'pi'
    authType = 'api_key'
    setupPayload.piAuthProvider = provider
  }

  await client.invoke('LLM_Connection:save', {
    slug: connectionSlug,
    name: getProviderDisplayName(provider),
    providerType,
    authType,
    createdAt: Date.now(),
  })
  const setupResult = await client.invoke('settings:setupLlmConnection', setupPayload) as { success: boolean; error?: string }
  if (!setupResult?.success) {
    throw new Error(`LLM connection setup failed: ${setupResult?.error ?? 'unknown error'}`)
  }
  await client.invoke('LLM_Connection:setDefault', connectionSlug)
  process.stderr.write(`LLM connection configured: ${provider}${baseUrl ? ` (${baseUrl})` : ''}\n`)

  return { connectionSlug }
}

/**
 * The exit status a signal-terminated non-interactive run reports.
 *
 * `headless.md#stop-a-run-with-sigterm`, quoted whole from the page as it reads
 * on 2026-09-11: "If you stop a `claude -p` run with SIGTERM, for example with
 * `kill` or from a process supervisor, Claude Code exits with code 143. Claude
 * Code leaves the turn that was in progress unfinished and records no result
 * for it. To end the turn instead, send SIGINT, or call the Agent SDK's
 * `interrupt()`, before you stop the process." The SessionEnd clause is now its
 * own sentence in the same section: "On SIGTERM, Claude Code terminates the
 * process tree of any Bash command that is still running. Claude Code then runs
 * `SessionEnd` hooks and exits."
 *
 * C3.102 — this comment carried a line-numbered anchor into that page (line 69,
 * named in words rather than in the path-plus-line form, because a correction
 * that spells a dead anchor re-creates the finding it repairs). The anchor had
 * decayed by eight lines, and re-reading the page found more than a moved line:
 * the sentence it quoted whole DOES NOT EXIST on the page any more, and one of
 * its clauses is now contradicted. The old quote said SIGTERM "aborts the
 * in-progress turn"; the page says Claude Code LEAVES it unfinished, that
 * SIGINT is what ends a turn, and that resuming the session "continues the turn
 * that SIGTERM left unfinished". The exit code, the process-tree kill and the
 * SessionEnd run are unchanged, which is why the implementation below still
 * matches. A section anchor is part of the page's published link contract; a
 * line number has a measured half-life of about two days.
 *
 * **D1.154's CLI half — the promise below, kept END TO END, measured.** The row
 * reads *"codex exits 0 on SIGTERM at the CLI where `signalExitCode` promises
 * 143 and pi and claude deliver it"*. The pure function is pinned in
 * `run.test.ts`; what had never been driven is a real `run`, with a real spawned
 * server and a real turn in flight. Measured 2026-09-17 on a credential-free
 * loopback rig (a stub OpenAI-compatible endpoint, a fabricated key, a fresh
 * `HOME`/`NESSY_CONFIG_DIR`), the CLI alive at the signal and the turn cut
 * mid-stream, on the PI runtime: `kill -INT <cli pid>` → **exit 130** and the
 * turn ends (`[interrupted]` on stdout); `kill -TERM <cli pid>` → **exit 143**
 * and the turn is left unfinished. So the pi control delivers both codes. The
 * CLAUDE control is not reachable from this rig, and that is a property of the
 * FLAGS rather than of the runtime: `--base-url` builds a `pi_compat`
 * connection ({@link buildCustomEndpointSetupFields}) and no CLI flag creates a
 * `claude-runtime` one. The codex half belongs to the codex lane.
 *
 * 128 + signal number: SIGINT is 2 -> 130, SIGTERM is 15 -> 143. Registering a
 * handler is what makes this our problem — the runtime's default SIGTERM
 * disposition already yields 143, and a handler that exits with a constant
 * overwrites it. A supervisor that cannot tell an operator's Ctrl-C from an
 * infrastructure shutdown is the bug.
 *
 * NOT the same 130 as `sendAndStream`'s streamed `interrupted` event; that path
 * keeps its own value and must not be collapsed onto this one.
 */
export function signalExitCode(signal: string | undefined): number {
  return signal === 'SIGTERM' ? 143 : 130
}

/**
 * C3.265 — whether a signal ENDS the in-flight turn, or leaves it unfinished for
 * a resume. A PRODUCT POSTURE, taken rather than queued, and written here because
 * it decides what happens to a user's in-flight work when a supervisor kills the
 * process.
 *
 * `headless.md#stop-a-run-with-sigterm` separates the two signals. Quoted as the
 * page reads on 2026-09-12, with the section anchor verified on the RENDERED
 * page: *"If you stop a `claude -p` run with SIGTERM, for example with `kill` or
 * from a process supervisor, Claude Code exits with code 143. Claude Code leaves
 * the turn that was in progress unfinished and records no result for it. To end
 * the turn instead, send SIGINT, or call the Agent SDK's `interrupt()`, before
 * you stop the process."* And of what the unfinished turn is FOR: *"When you
 * resume the session, Claude Code continues the turn that SIGTERM left
 * unfinished."*
 *
 * This CLI cancelled the session on BOTH signals until now — the SIGINT
 * behaviour applied to a signal the page gives the opposite meaning. C3.102 saw
 * that divergence, left it deliberately and recorded it as a posture rather than
 * aligning it inside a citation repair. It is taken here, in the direction the
 * page names: **SIGTERM leaves the turn unfinished; SIGINT — and any other signal
 * this process installs a handler for — ends it.**
 *
 * Why this direction. A supervisor kill is not a statement about the work: a
 * `kill`, a container stop, a CI cancellation and a service restart all arrive as
 * SIGTERM, and ENDING the turn on them records a result nobody asked for. An
 * operator who does mean *stop this turn* has SIGINT (Ctrl-C), and a program
 * driving the SDK has `interrupt()`.
 *
 * F1.594 — "unfinished" is not "still running". Left running, the turn held the
 * server's shutdown (`endManagedAgentLifecycle` waits for the turn's capability
 * lock) and the exit waited it out: 87–102 s on all three runtimes (WJ-bi), 56.6 s
 * on a 60 s Pi turn here. So SIGTERM now STOPS it too, silently (`sessions:cancel`
 * with `silent`: no result row). Measured exits: 2.2 s pi, 5.6 s claude, 22.5 s codex
 * (13–18 s of that is codex's own teardown, turn or no turn), SessionEnd on all
 * three; a resumed turn is sent the interrupted prompt. Ephemeral runs keep none.
 */
export function signalEndsTurn(signal: string | undefined): boolean {
  return signal !== 'SIGTERM'
}

async function cmdRun(args: CliArgs): Promise<void> {
  // Prompt = all positional args (no session ID needed, unlike send)
  // `run` is dispatched from `main()` OUTSIDE its try/catch, so a throw here
  // would escape as an unhandled rejection instead of the documented clear
  // error (`headless.md:88`). Same shape as the schema gate below.
  let message: string
  try {
    message = await readPrompt(args.rest, args.rest)
  } catch (e) {
    err(e instanceof Error ? e.message : String(e))
    process.exit(1)
    return
  }
  if (!message.trim()) {
    err('No prompt provided. Usage: run <message>')
    process.exit(1)
  }

  // R18: gate the schema BEFORE spawning anything — a bad schema fails the run
  // at startup with the documented error, and no server or session is created.
  try {
    parseJsonSchemaArg(args.jsonSchema)
  } catch (e) {
    err(e instanceof Error ? e.message : String(e))
    process.exit(1)
    return
  }

  // ---------------------------------------------------------------------------
  // D1.233 — `--url` ATTACHES, as `validate` has always done.
  //
  // `cmdValidate` has an `if (args.url)` branch; `cmdRun` had none, so a
  // `run --url ws://… --token …` pointed at a standing server spawned a SECOND
  // one, which then died on the storage host lease ("Server process exited
  // before printing NESSY_SERVER_URL"). Every diagnosis that wants the server's
  // own stdout, or a server under a debugger, had to go through the spawner.
  // The client options are `cmdValidate`'s attach branch verbatim, which is the
  // nearest thing in this file to a precedent.
  //
  // THE POSTURE, and it is why this prints rather than attaching quietly: the
  // flags this CLI delivers through the SPAWNED server's ENVIRONMENT cannot
  // reach a server it did not start. That is `--safe-mode`, `--fallback-model`,
  // `--claude-settings`, `--claude-setting-sources`, and the print-mode marker
  // ({@link PRINT_MODE_ENV_VAR}), whose absence turns off the non-interactive
  // background-work wait — the one difference that is NOT a flag the user can
  // see themselves passing, which is why the first line names it.
  const server = args.url ? undefined : await spawnLocalServer(args, { printMode: true })
  if (args.url) {
    process.stderr.write(
      `Server: ${args.url} (attached; this run did not spawn it, so the print-mode background wait does not apply)\n`,
    )
    // D1.258 — what reaches here is the ENVIRONMENT half only: the FLAG half is
    // refused by {@link refuseAttachInertFlags} before anything connects. So
    // this line names the VARIABLES, not the flags — D1.233 named
    // `--claude-settings` and `--claude-setting-sources`, which are not
    // spellings this CLI accepts (the flags are `--settings` and
    // `--setting-sources`, and the unknown-flag gate would have refused the
    // other two before the run started), so a reader went looking for a flag
    // they could not have typed.
    const inert = [
      args.safeMode ? SAFE_MODE_ENV_VAR : undefined,
      args.fallbackModel ? FALLBACK_MODEL_ENV_VAR : undefined,
      args.claudeSettings ? CLAUDE_FLAG_SETTINGS_ENV_VAR : undefined,
      args.claudeSettingSources ? CLAUDE_SETTING_SOURCES_ENV_VAR : undefined,
    ].filter((name): name is string => name !== undefined)
    if (inert.length > 0) {
      process.stderr.write(
        'Inert against an attached server (this CLI passes them in the environment of a server it spawns, '
        + `and this run did not spawn one): ${inert.join(', ')}\n`,
      )
    }
  }

  let client: CliRpcClient | undefined =
    server?.client ??
    new CliRpcClient(args.url!, {
      token: args.token || undefined,
      requestTimeout: args.timeout,
      connectTimeout: args.timeout,
    })
  let sessionId: string | undefined

  // `best-practices.md:469` — "The run still creates a resumable session unless
  // you pass `--no-session-persistence`." The run used to delete its session on
  // every exit path, including Ctrl-C, and that delete was a hard durable
  // removal, so an interrupted run destroyed its own partial transcript. The
  // opt-out is now `--no-session-persistence`, and it works by never writing
  // the record (`ephemeral` on `sessions:create`) rather than by removing it
  // afterwards — so there is nothing left here to delete either way.
  const cleanup = async () => {
    client?.destroy()
    // D1.233 — an ATTACHED server is not ours to stop.
    if (server) await server.stop()
  }

  // Signal handling — cancel + clean up on SIGINT/SIGTERM. `cleanup()` must stay
  // BEFORE the exit: stopping the spawned server is what runs SessionEnd, the
  // other clause of `headless.md#stop-a-run-with-sigterm` ("Claude Code then
  // runs `SessionEnd` hooks and exits"). C3.102 re-read that section at HEAD
  // and this clause survives the page's rewrite verbatim; see
  // {@link signalExitCode} for the clause that did not.
  //
  // C3.265 separated the two signals as the page does; F1.594 keeps the split and
  // changes what SIGTERM does to the turn. BOTH signals now STOP it — SIGINT with
  // the recorded Stop, SIGTERM with `cancelProcessing`'s silent mode, which writes
  // no result, so a resume continues it. Left running (C3.265 to F1.594), the turn
  // held the server's shutdown and the exit waited it out; the reason and the
  // measurements are on {@link signalEndsTurn}.
  //
  // ---------------------------------------------------------------------------
  // D1.211 — A SIGNALLED RUN LEAVES ITS BACKGROUND SHELLS BEHIND, ON BOTH
  // SIGNALS, AND THE ROW'S ASYMMETRY IS REFUTED.
  //
  // The row reads "a CANCELLED headless session leaves the supervisor's
  // background children running, where a signalled one does not … the SIGTERM
  // arm's graceful path does reap". Measured 2026-09-17 on a credential-free
  // loopback rig — a stub endpoint whose first turn returns a real `bash` tool
  // call with `run_in_background: true`, so a supervised child exists and a turn
  // is in flight when the arm signals — three arms, same rig, same hour:
  //
  //   control (no signal, the turn finishes)  exit 0    child GONE
  //   SIGINT at the CLI (the cancel runs)     exit 130   child ALIVE 5 s later
  //   SIGTERM at the CLI (the cancel skipped) exit 143   child ALIVE 5 s later
  //
  // The durable artefact agrees and is not a log: after the control the
  // supervised record ends `status: "stopped", signal: "SIGTERM"` and the
  // `.pi-processes/.running/` index is EMPTY, while after either signal it still
  // reads `status: "running"` with the surviving pid and the handle still in
  // that index. So nothing stopped the child and nothing recorded a stop.
  //
  // The discriminator is therefore NOT `sessions:cancel` — which was verified at
  // HEAD to touch no supervised process at all, `cancelProcessing` force-aborts
  // the agent and returns, against the positive control that
  // `disposeManagedAgentRuntime` and `SessionManager.cleanup()` both DO call the
  // supervisor's drain. It is signal versus no signal: the same `cleanup()` runs
  // on all three paths, and only the one whose turn had already ended reaped.
  //
  // HOW FAR THE SERVER GETS — a PAIRED reading, taken once the instrument
  // existed. The server's own INFO log now reaches the operator
  // (`server-spawner.ts` forwards the child's stdout, which this spawner
  // previously read for one line and discarded), so two more arms were run and
  // they localise this to a two-second window:
  //
  //   SIGTERM arm   18:42:47.715  INFO Shutting down...
  //                 (nothing else; the process is gone)
  //   control arm   18:51:11.531  INFO Shutting down...
  //                 18:51:13.537  INFO [session] Cleaning up resources...
  //                 18:51:13.947  DEBUG Background shell … ended (stopped)
  //                 18:51:13.953  INFO [session] Cleanup complete
  //
  // `Shutting down...` is `bootstrapServer`'s `stop()`, whose very next act is a
  // 2 000 ms client-shutdown notification sleep; `Cleaning up resources...` is
  // `SessionManager.cleanup()`'s own first line and the only path to the drain.
  // The control crosses that window in 2.006 s and reaps; the signalled arm does
  // not cross it at all. So the drain is not failing — it is not being reached,
  // and what kills the server inside its own notification sleep is the question
  // the successor row carries. (`Failed to drain session` and `Failed to clean
  // up session manager` are absent on every arm, and both are `warn`/`error`,
  // which reached this stderr even before the change — so their absence is
  // evidence rather than another blind spot.)
  //
  // WHY NO FIX IS BUILT HERE. The row proposes a call site on the supervisor's
  // `signalTree`/`signalRecoveredTree` "on the cancel path". On this measurement
  // that would repair neither arm, and a reap on cancel would additionally
  // DESTROY work a user asked for: a `run_in_background` shell is meant to
  // outlive a turn, and Stop is not "kill my background jobs". What remains
  // unidentified is WHY a shutdown that has started does not finish here while
  // the same shutdown finishes on the un-signalled path, and AGENTS.md is
  // explicit that an answer reached without that is the kind that looks
  // obviously right. The residue and the proposed row are in this lane's report.
  // ---------------------------------------------------------------------------
  //
  // D1.154 — AND THE HANDLER MUST OWN THE EXIT ONCE IT HAS STARTED.
  //
  // The row reads "codex exits 0 on SIGTERM at the CLI where `signalExitCode`
  // promises 143"; C3.103 already stopped the losing value being 0, so what
  // survived is a 1. Two exits race, and the handler is structurally last:
  // `cleanup()` is awaited BEFORE its `process.exit`, and on a codex session
  // that stop reaches `CodexRuntimeManager.kill(graceMs = 3000)` — bounded at
  // `graceMs + KILL_HARD_DEADLINE_MS`, up to 5 s — while the SAME cleanup's
  // `client.destroy()` has already released `sendAndStream`'s poll loop, so the
  // main path reaches ITS `process.exit(exitCode)` with the `!finished` value
  // in milliseconds. Whichever runs first ends a real process, so the promise
  // is kept only if the main path stops exiting at all from the moment a signal
  // is being handled.
  //
  // `return` rather than a second exit, and the reason it is safe: the handler
  // is in flight and its `await server.stop()` is awaiting a ref'd subprocess
  // handle (`proc.kill('SIGTERM')` then `await proc.exited`), so the loop
  // cannot drain out from under it; and on the path where that handle is
  // already settled the handler reaches `process.exit` in the same microtask
  // chain, before the loop is asked whether it is empty.
  let signalExiting = false
  const onSignal = async (signal?: string) => {
    signalExiting = true
    if (sessionId && client?.isConnected) {
      // F1.594 — SIGINT's Stop is the recorded one, on the unchanged wire; SIGTERM's is silent.
      const stop = signalEndsTurn(signal) ? [sessionId] : [sessionId, true]
      await client.invoke('sessions:cancel', ...stop).catch(() => {})
    }
    await cleanup()
    process.exit(signalExitCode(signal))
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  try {
    await client.connect()

    // Auto-setup LLM connection from flags / env vars.
    // When --base-url is provided, always create the custom endpoint connection
    // (even if other connections exist) so the session routes through it.
    const connections = (await client.invoke('LLM_Connection:list')) as any[]
    let connectionSlug: string | undefined
    if (shouldSetupLlmConnection(connections?.length ?? 0, args)) {
      const result = await setupLlmConnection(client, args)
      connectionSlug = result.connectionSlug
    }

    let workspaceId = await resolveWorkspace(client, args.workspace)
    if (!workspaceId && args.workspaceDir) {
      const workspace = (await client.invoke('workspaces:create', 'ci-workspace')) as { id: string }
      workspaceId = workspace.id
      await client.invoke('window:switchWorkspace', workspaceId)
    }
    if (!workspaceId) {
      err('No workspace found on server')
      process.exit(1)
    }

    let projectHandleId: string | undefined
    if (args.workspaceDir) {
      const candidatePath = resolve(args.workspaceDir)
      const project = (await client.invoke('projects:validateDirectory', {
        workspaceId,
        candidatePath,
      })) as { id: string; displayPath: string }
      projectHandleId = project.id
      process.stderr.write(`Project selected: ${project.displayPath}\n`)
    }

    const session = (await client.invoke('sessions:create', workspaceId, {
      // `headless.md` — no `--permission-mode` means `default`, never a
      // silent bypass. `permission_request` events are answered deny by
      // `sendAndStream`'s auto-responder below (2026-08-12
      // sandbox-default-off-and-bypass-cli-parity T3).
      permissionMode: (args.mode ? parsePermissionMode(args.mode) ?? args.mode : undefined) || 'default',
      enabledSourceSlugs: args.sources.length > 0 ? args.sources : undefined,
      projectHandleId,
      // `cli-reference.md:105` — "sessions are not saved to disk and cannot be
      // resumed". `ephemeral` is already on the wire DTO and already honoured
      // server-side, so this is a mapping, not a new mechanism. Left undefined
      // when the flag is absent so a plain run's options object is unchanged.
      ephemeral: args.noSessionPersistence || undefined,
      // P6.317 (2) — registered for THIS session and written nowhere. Already
      // gated in `main()`, so this cannot throw here.
      agents: parseAgentsArg(args.agents),
    })) as { id: string }
    sessionId = session.id

    // "Resumable" needs a handle, and a text-mode run never printed one — the
    // session id only ever leaked inside raw `--output-format stream-json`
    // events. stderr, alongside `Server ready:` and `Project selected:`, so it
    // never contaminates the stream a consumer parses. Nothing to print when
    // the session was deliberately not persisted.
    if (!args.noSessionPersistence) {
      process.stderr.write(`Session: ${sessionId}\n`)
    }

    if (args.model) {
      await client.invoke('session:setModel', sessionId, workspaceId, args.model, connectionSlug)
    }

    const exitCode = await sendAndStream(client, sessionId, message, args, workspaceId)
    // D1.154 — see {@link signalExitCode} and the handler above.
    if (signalExiting) return
    await cleanup()
    process.exit(exitCode)
  } catch (e) {
    // D1.154, the same rule on the throwing path — and it is the FIRST
    // statement of the catch for two reasons beyond the exit code: the throw is
    // this process's own `client.destroy()` arriving as a rejection, so the
    // message would name our teardown as the failure, and a second `cleanup()`
    // would stop the spawned server a second time while the handler's stop is
    // still awaiting `proc.exited`.
    if (signalExiting) return
    const msg = e instanceof Error ? e.message : String(e)
    err(msg)
    await cleanup()
    process.exit(1)
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}

async function cmdValidate(args: CliArgs): Promise<void> {
  let server: LocalServer | undefined
  let client: CliRpcClient

  // Use a generous timeout for validation steps — source creation and MCP
  // server startup can be slow on Windows.
  const validateArgs = { ...args, timeout: Math.max(args.timeout, 30_000) }

  if (args.url) {
    client = new CliRpcClient(args.url, {
      token: args.token || undefined,
      requestTimeout: validateArgs.timeout,
      connectTimeout: validateArgs.timeout,
    })
  } else {
    server = await spawnLocalServer(validateArgs, { quiet: !args.verbose })
    client = server.client
  }

  try {
    const exitCode = await runValidation(client, args.json, args.noSpinner, args.workspaceDir, {
      baseUrl: args.baseUrl,
      apiKey: args.apiKey,
      provider: args.provider,
      model: args.model,
    })
    client.destroy()
    if (server) await server.stop()
    process.exit(exitCode)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    err(msg)
    client.destroy()
    if (server) await server.stop()
    process.exit(1)
  }
}

async function cmdCancel(client: CliRpcClient, args: CliArgs): Promise<void> {
  const sessionId = args.rest[0]
  if (!sessionId) {
    err('Usage: cancel <session-id>')
    process.exit(1)
  }
  await client.connect()
  await client.invoke('sessions:cancel', sessionId)
  out(args.json ? { cancelled: sessionId } : `Cancelled: ${sessionId}`, args.json)
}

async function cmdInvoke(client: CliRpcClient, args: CliArgs): Promise<void> {
  const channel = args.rest[0]
  if (!channel) {
    err('Usage: invoke <channel> [json-args...]')
    process.exit(1)
  }
  await client.connect()

  // Parse remaining args as JSON
  const invokeArgs: unknown[] = []
  for (let i = 1; i < args.rest.length; i++) {
    try {
      invokeArgs.push(JSON.parse(args.rest[i]))
    } catch {
      invokeArgs.push(args.rest[i])
    }
  }

  const result = await client.invoke(channel, ...invokeArgs)
  out(result, args.json)
}

async function cmdListen(client: CliRpcClient, args: CliArgs): Promise<void> {
  const channel = args.rest[0]
  if (!channel) {
    err('Usage: listen <channel>')
    process.exit(1)
  }
  await client.connect()

  client.on(channel, (...eventArgs: unknown[]) => {
    out({ channel, args: eventArgs, timestamp: new Date().toISOString() }, true)
  })

  process.stdout.write(`Listening on ${channel} (Ctrl+C to stop)\n`)

  // Keep alive
  await new Promise(() => {
    // Never resolves — Ctrl+C exits
  })
}

// ---------------------------------------------------------------------------
// Validate server
// ---------------------------------------------------------------------------

export interface ValidateStep {
  name: string
  fn: (client: CliRpcClient, ctx: ValidateContext) => Promise<string>
}

export interface ValidateContext {
  /** External Project directory selected through --workspace-dir. */
  workspaceDir?: string
  /** Custom endpoint URL (from --base-url) */
  baseUrl?: string
  /** API key override (from --api-key) */
  apiKey?: string
  /** Provider hint (from --provider, default 'anthropic') */
  provider?: string
  /** Model override (from --model) */
  model?: string
  workspaceId?: string
  projectHandleId?: string
  createdWorkspace?: boolean
  createdSessionId?: string
  createdSourceSlug?: string
  createdSkillSlug?: string
  createdAutomationIds?: string[]
  webhookAutomationId?: string
  automationTestSessionId?: string
  /** Session created by automation that should be blocked by failing condition (if bug occurs) */
  automationBlockedSessionId?: string
  automationName?: string
  automationBlockedName?: string
  createdLabelId?: string
  branchedSessionId?: string
  /** Label ID for e2e-test label created for session tool validation */
  e2eTestLabelId?: string
  onEvent?: (ev: { type: string; [key: string]: unknown }) => void
}

/** Minimal shapes for RPC responses used in validation steps. */
interface ValidateStatus {
  id?: string
  label?: string
}

interface ValidateSession {
  id: string
  name?: string
  labels?: string[]
}

interface ValidateLabel {
  id?: string
  name?: string
}

interface ValidateMessageBlock {
  type: string
  text?: string
}

interface ValidateMessage {
  role: string
  content: string | ValidateMessageBlock[]
}

interface ValidateMessagesResponse {
  messages?: ValidateMessage[]
  conversation?: ValidateMessage[]
}

/**
 * Send a message and wait for streaming events.
 * Returns a summary of received event types.
 * If expectTool is true, validates that tool_start + tool_result events arrived.
 */
async function waitForSendEvents(
  client: CliRpcClient,
  sessionId: string,
  message: string,
  timeoutMs: number,
  expectTool: boolean,
  sendOptions?: Record<string, unknown>,
  onEvent?: (ev: { type: string; [key: string]: unknown }) => void,
  expectToolName?: string,
): Promise<string> {
  const seen = new Set<string>()
  let textChunks = 0
  let toolName = ''
  let finished = false

  const unsub = client.on('session:event', (event: unknown) => {
    const ev = event as { type: string; sessionId: string; [key: string]: unknown }
    if (ev.sessionId !== sessionId) return

    seen.add(ev.type)
    if (ev.type === 'text_delta') textChunks++
    if (ev.type === 'tool_start') toolName = String(ev.toolName ?? '')
    if (ev.type === 'complete' || ev.type === 'error' || ev.type === 'interrupted') {
      finished = true
    }
    onEvent?.(ev)
  })

  try {
    await client.invoke('sessions:sendMessage', sessionId, message,
      undefined, undefined, sendOptions)

    const deadline = Date.now() + timeoutMs
    while (!finished && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
    }

    if (!finished) throw new Error('Timed out waiting for completion')

    // Only treat as failure if error was the terminal event (no complete followed)
    if (seen.has('error') && !seen.has('complete')) throw new Error('Session returned an error event')

    if (expectTool) {
      if (!seen.has('tool_start')) throw new Error('No tool_start event received')
      if (!seen.has('tool_result')) throw new Error('No tool_result event received')
      if (expectToolName && !toolName.includes(expectToolName)) {
        throw new Error(`Expected tool containing "${expectToolName}", got "${toolName}"`)
      }
      return `tool=${toolName}, ${textChunks} text deltas, events: ${[...seen].join(', ')}`
    }

    if (!seen.has('text_delta')) throw new Error('No text_delta events received')
    return `${textChunks} text deltas, events: ${[...seen].join(', ')}`
  } finally {
    unsub()
  }
}

/**
 * Clean up automation test artifacts (config files, session, label).
 * Shared between the automation:cleanup test step and runValidation error recovery.
 */
async function cleanupAutomationArtifacts(
  client: CliRpcClient,
  ctx: ValidateContext,
): Promise<string[]> {
  const cleaned: string[] = []

  if (ctx.workspaceId && ctx.createdAutomationIds?.length && client.isConnected) {
    const remaining: string[] = []
    for (const automationId of ctx.createdAutomationIds) {
      try {
        await client.invoke('automations:delete', ctx.workspaceId, automationId)
        cleaned.push(`automation ${automationId}`)
      } catch {
        remaining.push(automationId)
      }
    }
    ctx.createdAutomationIds = remaining
    if (!remaining.includes(ctx.webhookAutomationId ?? '')) ctx.webhookAutomationId = undefined
  }

  // Delete automation-triggered sessions
  for (const key of ['automationTestSessionId', 'automationBlockedSessionId'] as const) {
    const id = ctx[key]
    if (!id || !client.isConnected) continue
    try {
      await client.invoke('sessions:delete', id)
      cleaned.push(`session ${id}`)
      ctx[key] = undefined
    } catch { /* best effort */ }
  }

  // Delete test label
  if (ctx.workspaceId && ctx.createdLabelId && client.isConnected) {
    try {
      await client.invoke('labels:delete', ctx.workspaceId, ctx.createdLabelId)
      cleaned.push(`label ${ctx.createdLabelId}`)
      ctx.createdLabelId = undefined
    } catch { /* best effort */ }
  }

  return cleaned
}

async function cleanupValidationArtifacts(
  client: CliRpcClient,
  ctx: ValidateContext,
): Promise<void> {
  if (ctx.branchedSessionId && client.isConnected) {
    await client.invoke('sessions:delete', ctx.branchedSessionId).catch(() => {})
  }
  if (ctx.createdSessionId && client.isConnected) {
    await client.invoke('sessions:delete', ctx.createdSessionId).catch(() => {})
  }

  await cleanupAutomationArtifacts(client, ctx)

  if (ctx.createdWorkspace && ctx.workspaceId && client.isConnected) {
    await client.invoke('workspaces:delete', ctx.workspaceId).catch(() => {})
  }
}

export function getValidateSteps(): ValidateStep[] {
  return [
    {
      name: 'Connect + handshake',
      fn: async (client) => {
        const start = performance.now()
        const clientId = await client.connect()
        const ms = Math.round(performance.now() - start)
        return `clientId: ${clientId}, ${ms}ms`
      },
    },
    {
      name: 'credentials:healthCheck',
      fn: async (client) => {
        const r = (await client.invoke('credentials:healthCheck')) as any
        return JSON.stringify(r)
      },
    },
    {
      name: 'system:versions',
      fn: async (client) => {
        const r = (await client.invoke('system:versions')) as any
        return r?.node ? `node=${r.node}` : JSON.stringify(r)
      },
    },
    {
      name: 'system:homeDir',
      fn: async (client) => {
        const r = await client.invoke('system:homeDir')
        return String(r)
      },
    },
    {
      name: 'workspaces:get',
      fn: async (client, ctx) => {
        if (ctx.workspaceDir) {
          const { resolve } = await import('path')
          const candidatePath = resolve(ctx.workspaceDir)
          const ws = (await client.invoke('workspaces:create', `validate-workspace-${Date.now().toString(36)}`)) as { id: string }
          ctx.workspaceId = ws.id
          ctx.createdWorkspace = true
          await client.invoke('window:switchWorkspace', ws.id)
          const project = (await client.invoke('projects:validateDirectory', {
            workspaceId: ws.id,
            candidatePath,
          })) as { id: string; displayPath: string }
          ctx.projectHandleId = project.id
          return `project selected: ${project.displayPath}`
        }
        const r = (await client.invoke('workspaces:get')) as any[]
        if (r?.length > 0) {
          ctx.workspaceId = r[0].id
          // Bind this client to the workspace so push events (e.g. session:event)
          // routed { to: 'workspace' } reach us.
          await client.invoke('window:switchWorkspace', r[0].id)
          return `${r.length} workspaces`
        }
        // Auto-bootstrap a managed Workspace for CI environments.
        const ws = (await client.invoke('workspaces:create', `validate-workspace-${Date.now().toString(36)}`)) as { id: string }
        ctx.workspaceId = ws.id
        ctx.createdWorkspace = true
        await client.invoke('window:switchWorkspace', ws.id)
        return `0 found → created validation workspace`
      },
    },
    {
      name: 'sessions:get',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId) return 'skipped (no workspace)'
        const r = (await client.invoke('sessions:get', ctx.workspaceId)) as any[]
        return `${r?.length ?? 0} sessions`
      },
    },
    {
      name: 'LLM_Connection:list',
      fn: async (client, ctx) => {
        const r = (await client.invoke('LLM_Connection:list')) as any[]

        // Custom endpoint: always create/update when --base-url is provided
        if (ctx.baseUrl) {
          const provider = ctx.provider || 'anthropic'
          let key = ''
          try {
            key = resolveApiKey(provider, ctx.apiKey || '')
          } catch (error) {
            return `0 connections (${error instanceof Error ? error.message : 'missing API key'})`
          }
          const slug = `${provider}-cli`
          const endpointFields = buildCustomEndpointSetupFields(provider, ctx.model)
          await client.invoke('LLM_Connection:save', {
            slug,
            name: `${getProviderDisplayName(provider)} (Custom Endpoint)`,
            providerType: 'pi_compat',
            authType: 'api_key_with_endpoint',
            createdAt: Date.now(),
          })
          const result = await client.invoke('settings:setupLlmConnection', {
            slug,
            credential: key,
            baseUrl: ctx.baseUrl,
            customEndpoint: endpointFields.customEndpoint,
            defaultModel: endpointFields.defaultModel,
            models: endpointFields.models,
          }) as { success: boolean; error?: string }
          if (!result?.success) return `setup failed: ${result?.error ?? 'unknown'}`
          await client.invoke('LLM_Connection:setDefault', slug)
          return `${r?.length ?? 0} existing + custom endpoint via ${ctx.baseUrl}`
        }

        // Amazon Bedrock: IAM credential setup
        if (ctx.provider === 'amazon-bedrock') {
          const accessKeyId = process.env.AWS_ACCESS_KEY_ID
          const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
          const region = process.env.AWS_REGION || 'us-east-1'
          const sessionToken = process.env.AWS_SESSION_TOKEN
          if (!accessKeyId || !secretAccessKey) {
            return '0 connections (missing AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)'
          }
          const slug = 'amazon-bedrock-cli'
          await client.invoke('LLM_Connection:save', {
            slug,
            name: 'Amazon Bedrock',
            providerType: 'pi',
            authType: 'iam_credentials',
            piAuthProvider: 'amazon-bedrock',
            createdAt: Date.now(),
          })
          const result = await client.invoke('settings:setupLlmConnection', {
            slug,
            piAuthProvider: 'amazon-bedrock',
            bedrockAuthMethod: 'iam_credentials',
            iamCredentials: { accessKeyId, secretAccessKey, sessionToken },
            awsRegion: region,
          }) as { success: boolean; error?: string }
          if (!result?.success) return `setup failed: ${result?.error ?? 'unknown'}`
          await client.invoke('LLM_Connection:setDefault', slug)
          return `${r?.length ?? 0} existing + Bedrock IAM (${region})`
        }

        const provider = ctx.provider || 'anthropic'
        if (!shouldSetupLlmConnection(r?.length ?? 0, { provider, baseUrl: ctx.baseUrl ?? '' })) {
          return `${r.length} connections`
        }
        // Auto-setup from env / flags for the requested provider.
        let key = ''
        try {
          key = resolveApiKey(provider, ctx.apiKey || '')
        } catch (error) {
          return `0 connections (${error instanceof Error ? error.message : 'missing API key'})`
        }
        const slug = `${provider}-cli`
        const providerType = provider === 'anthropic' ? 'anthropic' : 'pi'
        const authType = 'api_key'
        await client.invoke('LLM_Connection:save', {
          slug,
          name: getProviderDisplayName(provider),
          providerType,
          authType,
          createdAt: Date.now(),
        })
        const setupPayload = provider === 'anthropic'
          ? { slug, credential: key }
          : { slug, credential: key, piAuthProvider: provider }
        const result = await client.invoke('settings:setupLlmConnection', setupPayload) as { success: boolean; error?: string }
        if (!result?.success) return `setup failed: ${result?.error ?? 'unknown'}`
        await client.invoke('LLM_Connection:setDefault', slug)
        return `0 found → created ${provider} connection`
      },
    },
    {
      name: 'sources:get',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId) return 'skipped (no workspace)'
        const r = (await client.invoke('sources:get', ctx.workspaceId)) as any[]
        return `${r?.length ?? 0} sources`
      },
    },
    {
      name: 'sessions:create',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId) return 'skipped (no workspace)'
        const name = `__cli-validate-${Date.now()}`
        const r = (await client.invoke('sessions:create', ctx.workspaceId, {
          name,
          // Bypass kept: `--validate-server`'s own self-test session, not a
          // user-facing run — later steps exercise Bash/automation/skill
          // tool calls that must actually execute to prove they work (T3,
          // 2026-08-12 sandbox-default-off-and-bypass-cli-parity).
          permissionMode: 'bypassPermissions',
          projectHandleId: ctx.projectHandleId,
        })) as any
        ctx.createdSessionId = r?.id
        return ctx.createdSessionId ?? 'created'
      },
    },
    {
      name: 'sessions:getMessages',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId) return 'skipped (no session)'
        await client.invoke('sessions:getMessages', ctx.createdSessionId)
        return 'session readable'
      },
    },
    {
      name: 'send message + stream',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId) return 'skipped (no session)'
        return await waitForSendEvents(client, ctx.createdSessionId,
          'Reply with exactly: VALIDATION_OK', 60_000, false, undefined, ctx.onEvent)
      },
    },
    {
      name: 'send message + tool use',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId) return 'skipped (no session)'
        return await waitForSendEvents(client, ctx.createdSessionId,
          'Use the Bash tool to run: echo TOOL_VALIDATION_OK', 90_000, true, undefined, ctx.onEvent)
      },
    },
    // ----- Session tool validation (guards against #511 regression) -----
    {
      name: 'labels:create (e2e-test)',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId) return 'skipped (no workspace)'
        const r = (await client.invoke('labels:create', ctx.workspaceId, {
          name: 'e2e-test',
          color: 'gray',
        })) as any
        ctx.e2eTestLabelId = r?.id
        return `label created: ${r?.id}`
      },
    },
    {
      name: 'session-tools:set_session_labels',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId) return 'skipped (no session)'
        if (!ctx.e2eTestLabelId) return 'skipped (no e2e-test label)'
        const result = await waitForSendEvents(client, ctx.createdSessionId,
          'Use the set_session_labels tool to set labels: ["e2e-test"] on the current session. Do NOT use any other tool.',
          90_000, true, undefined, ctx.onEvent, 'set_session_labels')
        // Verify labels were actually applied
        const sessions = (await client.invoke('sessions:get', ctx.workspaceId)) as any[]
        const session = sessions?.find((s: any) => s.id === ctx.createdSessionId)
        const labels = session?.labels ?? session?.labelIds ?? []
        if (!labels.length) throw new Error('Labels not applied to session')
        return `${result} — labels verified: ${JSON.stringify(labels)}`
      },
    },
    {
      name: 'session-tools:get_session_info',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId) return 'skipped (no session)'
        return await waitForSendEvents(client, ctx.createdSessionId,
          'Use the get_session_info tool to get info about the current session. Do NOT use any other tool.',
          90_000, true, undefined, ctx.onEvent, 'get_session_info')
      },
    },
    {
      name: 'session-tools:list_sessions',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId) return 'skipped (no session)'
        return await waitForSendEvents(client, ctx.createdSessionId,
          'Use the list_sessions tool to list all sessions. Do NOT use any other tool.',
          90_000, true, undefined, ctx.onEvent, 'list_sessions')
      },
    },
    // ----- Session branching -----
    {
      name: 'sessions:branch',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId || !ctx.workspaceId) return 'skipped (no session)'
        const r = (await client.invoke('sessions:getMessages', ctx.createdSessionId)) as ValidateMessagesResponse
        const messages = r?.messages ?? r?.conversation ?? []
        const firstAssistant = messages.find((m) => m.role === 'assistant') as any
        if (!firstAssistant?.id) throw new Error('No assistant message found to branch from')
        const branch = (await client.invoke('sessions:create', ctx.workspaceId, {
          name: `__cli-validate-branch-${Date.now()}`,
          // Bypass kept: same self-test harness as `sessions:create` above,
          // not a user-facing run (T3, 2026-08-12
          // sandbox-default-off-and-bypass-cli-parity).
          permissionMode: 'bypassPermissions',
          branchFromSessionId: ctx.createdSessionId,
          branchFromMessageId: firstAssistant.id,
        })) as any
        ctx.branchedSessionId = branch?.id
        return `branched at message ${firstAssistant.id} → session ${branch?.id}`
      },
    },
    {
      name: 'sessions:branch verify',
      fn: async (client, ctx) => {
        if (!ctx.branchedSessionId) return 'skipped (no branch)'
        const r = (await client.invoke('sessions:getMessages', ctx.branchedSessionId)) as ValidateMessagesResponse
        const messages = r?.messages ?? r?.conversation ?? []
        const hasAssistant = messages.some((m) => m.role === 'assistant')
        if (!hasAssistant) throw new Error('Branch missing assistant message')
        const origR = (await client.invoke('sessions:getMessages', ctx.createdSessionId!)) as ValidateMessagesResponse
        const origMessages = origR?.messages ?? origR?.conversation ?? []
        if (messages.length >= origMessages.length) {
          throw new Error(`Branch has ${messages.length} messages, expected fewer than original (${origMessages.length})`)
        }
        return `branch has ${messages.length} messages (original has ${origMessages.length})`
      },
    },
    {
      name: 'sessions:branch send',
      fn: async (client, ctx) => {
        if (!ctx.branchedSessionId) return 'skipped (no branch)'
        return await waitForSendEvents(client, ctx.branchedSessionId,
          'Reply with exactly: BRANCH_OK', 60_000, false, undefined, ctx.onEvent)
      },
    },
    // ----- Source lifecycle -----
    {
      name: 'sources:create',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId) return 'skipped (no workspace)'
        const r = (await client.invoke('sources:create', ctx.workspaceId, {
          name: 'Cat Facts',
          provider: 'catfact',
          type: 'api',
          api: { baseUrl: 'https://catfact.ninja', authType: 'none' },
          icon: '🐱',
        })) as any
        ctx.createdSourceSlug = r?.slug
        return ctx.createdSourceSlug ? `slug=${ctx.createdSourceSlug}` : JSON.stringify(r)
      },
    },
    {
      name: 'send + source mention',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId || !ctx.createdSourceSlug) return 'skipped (no session or source)'
        // Enable the source on the session
        await client.invoke('sessions:command', ctx.createdSessionId, {
          type: 'setSources',
          sourceSlugs: [ctx.createdSourceSlug],
        })
        return await waitForSendEvents(client, ctx.createdSessionId,
          `[source:${ctx.createdSourceSlug}] Get me a cat fact`, 90_000, false, undefined, ctx.onEvent)
      },
    },
    // ----- MCP source validation (pre-committed in .github/agents/sources/) -----
    {
      name: 'mcp:nessy-public (auth:none)',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId) return 'skipped (no session)'
        // Enable the pre-committed nessy-public MCP source on the session
        const enableSlugs = [ctx.createdSourceSlug, 'nessy-public'].filter(Boolean) as string[]
        await client.invoke('sessions:command', ctx.createdSessionId, {
          type: 'setSources',
          sourceSlugs: enableSlugs,
        })
        return await waitForSendEvents(client, ctx.createdSessionId,
          `[source:nessy-public] List the documents under the "NessyAgents E2E Test" folder inside the "NessyAgents" folder. Just list their names.`,
          180_000, false, undefined, ctx.onEvent)
      },
    },
    {
      name: 'mcp:stitch-mcp (header-auth)',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId) return 'skipped (no session)'
        const apiKey = process.env.STITCH_API_KEY
        if (!apiKey) return 'skipped (no STITCH_API_KEY)'
        // Inject credential into store (multi-header JSON format, same as API headerNames)
        await client.invoke('sources:saveCredentials', ctx.workspaceId, 'stitch-mcp', JSON.stringify({ 'X-Goog-Api-Key': apiKey }))
        // Enable stitch-mcp + existing sources on session
        const enableSlugs = [ctx.createdSourceSlug, 'nessy-public', 'stitch-mcp'].filter(Boolean) as string[]
        await client.invoke('sessions:command', ctx.createdSessionId, {
          type: 'setSources',
          sourceSlugs: enableSlugs,
        })
        return await waitForSendEvents(client, ctx.createdSessionId,
          `Use the source_test tool to test the stitch-mcp source. Report the result.`,
          90_000, false, undefined, ctx.onEvent)
      },
    },
    // ----- Skill lifecycle -----
    {
      name: 'send + skill create',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId || !ctx.workspaceId) {
          throw new Error('Skill validation requires a Workspace session')
        }
        ctx.createdSkillSlug = '__cli-validate-skill'
        const sourceSlug = ctx.createdSourceSlug ?? 'cat-facts'
        await client.invoke('capabilities:submitManagedEdit', {
          session: { workspaceId: ctx.workspaceId, sessionId: ctx.createdSessionId },
          resource: { scope: 'workspace', workspaceId: ctx.workspaceId, kind: 'skills-root' },
          contextKey: 'add-skill',
          instructions: `Create the Workspace skill ${ctx.createdSkillSlug} named "CLI Validate Skill". Its description is "Validation skill created by nessy-general-agent" and it requires Source "${sourceSlug}". The instructions must require both checking Lake Balaton water temperature and fetching a Cat Facts fact.`,
        })
        return `managed edit requested: ${ctx.createdSkillSlug}`
      },
    },
    {
      name: 'skills:get (verify)',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId || !ctx.createdSkillSlug) {
          throw new Error('Skill catalog validation requires a managed skill request')
        }
        const deadline = Date.now() + 90_000
        let delay = 200
        while (Date.now() < deadline) {
          const catalog = (await client.invoke('capabilities:getCatalog', {
            workspaceId: ctx.workspaceId,
          })) as { capabilities?: Array<{ kind?: string; logicalName?: string }> }
          const found = catalog.capabilities?.find((capability) =>
            capability.kind === 'skill' && capability.logicalName === ctx.createdSkillSlug
          )
          if (found) return `found: ${found.logicalName}`
          await new Promise((resolve) => setTimeout(resolve, delay))
          delay = Math.min(Math.round(delay * 1.8), 1500)
        }
        throw new Error(`Skill '${ctx.createdSkillSlug}' not found in capability catalog`)
      },
    },
    {
      name: 'send + skill mention',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId || !ctx.createdSkillSlug) return 'skipped (no session or skill)'
        return await waitForSendEvents(client, ctx.createdSessionId,
          `[skill:${ctx.createdSkillSlug}] Run the skill`, 120_000, false,
          { skillSlugs: [ctx.createdSkillSlug] }, ctx.onEvent)
      },
    },
    {
      name: 'skills:delete',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId || !ctx.createdSkillSlug) return 'skipped (no skill)'
        await client.invoke('skills:delete', ctx.workspaceId, ctx.createdSkillSlug)
        return `deleted skill: ${ctx.createdSkillSlug}`
      },
    },
    // ----- Automation lifecycle -----
    {
      name: 'automation:create',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId || !ctx.workspaceId) {
          throw new Error('Automation validation requires a Workspace session')
        }
        ctx.automationBlockedName = 'CLI Validate Condition Blocked'
        ctx.automationName = 'CLI Validate Condition Pass'
        ctx.createdAutomationIds = []

        // Both automations below keep bypass: unattended self-test fixtures
        // whose triggered sessions must run their canned prompt without a
        // dialog, not user-facing runs (T3, 2026-08-12
        // sandbox-default-off-and-bypass-cli-parity).
        const inputs = [
          {
            kind: 'event',
            event: 'SessionStatusChange',
            name: ctx.automationBlockedName,
            permissionMode: 'bypassPermissions',
            conditions: [{ condition: 'state', field: 'sessionStatus', to: '__never__' }],
            actions: [{ type: 'prompt', prompt: 'Reply with exactly: AUTOMATION_BLOCKED_SHOULD_NOT_RUN' }],
          },
          {
            kind: 'event',
            event: 'SessionStatusChange',
            name: ctx.automationName,
            permissionMode: 'bypassPermissions',
            labels: ['cli-validate-label'],
            actions: [{ type: 'prompt', prompt: 'Reply with exactly: AUTOMATION_VALIDATION_OK' }],
          },
          {
            kind: 'event',
            event: 'LabelAdd',
            name: 'CLI Validate Webhook',
            actions: [{
              type: 'webhook',
              url: 'http://127.0.0.1:19999/validate-test',
              method: 'POST',
            }],
          },
        ]

        for (const input of inputs) {
          const created = (await client.invoke('automations:create', ctx.workspaceId, input)) as {
            automationId: string
          }
          ctx.createdAutomationIds.push(created.automationId)
        }
        ctx.webhookAutomationId = ctx.createdAutomationIds[2]
        return `created ${ctx.createdAutomationIds.length} validation automations`
      },
    },
    {
      name: 'automation:trigger (status change)',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId || !ctx.workspaceId) return 'skipped (no session or workspace)'
        // Get available statuses to find one containing "in-progress"
        const statuses = (await client.invoke('statuses:list', ctx.workspaceId)) as ValidateStatus[]
        const inProgress = statuses?.find((s) =>
          (s.id ?? '').toLowerCase().includes('in-progress') ||
          (s.label ?? '').toLowerCase().includes('in progress')
        )
        const statusValue = inProgress?.id ?? 'in-progress'

        // Change session status to trigger the automations
        await client.invoke('sessions:command', ctx.createdSessionId, {
          type: 'setSessionStatus',
          state: statusValue,
        })

        // Poll for expected automation behavior:
        // - pass automation MUST create a session
        // - blocked automation MUST NOT create a session
        let delay = 1000
        const deadline = Date.now() + 60_000
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, delay))
          delay = Math.min(delay * 1.5, 10_000)
          const sessions = (await client.invoke('sessions:get', ctx.workspaceId)) as ValidateSession[]

          const blockedSession = sessions?.find((s) =>
            s.name === ctx.automationBlockedName && s.id !== ctx.createdSessionId
          )
          if (blockedSession) {
            ctx.automationBlockedSessionId = blockedSession.id
            throw new Error(`Blocked automation unexpectedly triggered (session=${blockedSession.id})`)
          }

          const passSession = sessions?.find((s) =>
            s.name === ctx.automationName && s.id !== ctx.createdSessionId
          )
          if (passSession) {
            ctx.automationTestSessionId = passSession.id

            // Guard against delayed blocked-automation session creation.
            await new Promise((r) => setTimeout(r, 2000))
            const sessionsAfter = (await client.invoke('sessions:get', ctx.workspaceId)) as ValidateSession[]
            const blockedAfter = sessionsAfter?.find((s) =>
              s.name === ctx.automationBlockedName && s.id !== ctx.createdSessionId
            )
            if (blockedAfter) {
              ctx.automationBlockedSessionId = blockedAfter.id
              throw new Error(`Blocked automation unexpectedly triggered after delay (session=${blockedAfter.id})`)
            }

            return `pass triggered → session ${passSession.id}; blocked automation did not trigger (status=${statusValue})`
          }
        }
        throw new Error('Passing automation-created session not found within 60s')
      },
    },
    {
      name: 'automation:verify session',
      fn: async (client, ctx) => {
        if (!ctx.automationTestSessionId) return 'skipped (no automation session)'
        // Wait for the automation session to complete
        let delay = 1000
        const deadline = Date.now() + 90_000
        while (Date.now() < deadline) {
          const session = (await client.invoke('sessions:getMessages', ctx.automationTestSessionId)) as ValidateMessagesResponse
          const messages = session?.messages ?? session?.conversation ?? []
          const hasAssistant = messages.some((m) => m.role === 'assistant')
          if (hasAssistant) {
            const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
            const text = typeof lastAssistant?.content === 'string'
              ? lastAssistant.content
              : Array.isArray(lastAssistant?.content)
                ? lastAssistant.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join(' ')
                : ''
            return `session has assistant response (${text.slice(0, 80).trim()})`
          }
          await new Promise((r) => setTimeout(r, delay))
          delay = Math.min(delay * 1.5, 10_000)
        }
        throw new Error('Automation session did not complete within 90s')
      },
    },
    {
      name: 'automation:verify labels',
      fn: async (client, ctx) => {
        if (!ctx.automationTestSessionId || !ctx.workspaceId) return 'skipped (no automation session)'
        // Verify label was auto-created
        const labels = (await client.invoke('labels:list', ctx.workspaceId)) as ValidateLabel[]
        const found = labels?.find((l) => (l.id ?? l.name ?? '') === 'cli-validate-label')
        if (!found) throw new Error('Label cli-validate-label was not auto-created')
        ctx.createdLabelId = found.id ?? 'cli-validate-label'

        // Verify the automation session has the label
        const sessions = (await client.invoke('sessions:get', ctx.workspaceId)) as ValidateSession[]
        const automationSession = sessions?.find((s) => s.id === ctx.automationTestSessionId)
        const sessionLabels: string[] = automationSession?.labels ?? []
        const hasLabel = sessionLabels.some((l: string) => l.includes('cli-validate-label'))
        if (!hasLabel) throw new Error(`Automation session missing label (has: ${sessionLabels.join(', ')})`)
        return `label created and assigned: ${ctx.createdLabelId}`
      },
    },
    {
      name: 'automations:getLastExecuted',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId) return 'skipped (no workspace)'
        const history = (await client.invoke('automations:getLastExecuted', ctx.workspaceId)) as Record<string, number>
        const entries = Object.entries(history)
        if (entries.length === 0) throw new Error('No automation execution history found')
        // Verify at least one automation ran recently (within last 2 minutes)
        const recentThreshold = Date.now() - 120_000
        const recent = entries.find(([, ts]) => ts > recentThreshold)
        if (!recent) throw new Error(`No recent automation execution (latest: ${Math.max(...entries.map(([, ts]) => ts))})`)
        return `${entries.length} automation(s), latest ran ${Math.round((Date.now() - recent[1]) / 1000)}s ago`
      },
    },
    // ----- Webhook validation -----
    {
      name: 'webhook:test (RPC)',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId || !ctx.webhookAutomationId) {
          throw new Error('Webhook validation requires a saved automation')
        }
        const r = (await client.invoke('automations:test', {
          workspaceId: ctx.workspaceId,
          automationId: ctx.webhookAutomationId,
          actions: [],
        })) as any
        const result = r?.actions?.[0]
        if (result?.success) throw new Error('Expected webhook to fail (nothing listening)')
        if (!result?.error && result?.statusCode !== 0) throw new Error('Expected error or statusCode 0 in result')
        return `correctly failed: ${(result.error ?? `statusCode=${result.statusCode}`).slice(0, 80)}`
      },
    },
    {
      name: 'webhook:verify failure',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId || !ctx.webhookAutomationId) {
          throw new Error('Webhook history validation requires a saved automation')
        }

        const start = Date.now()
        const deadline = start + 15_000
        let delay = 200
        let lastSummary = 'no entries'

        while (Date.now() < deadline) {
          const entries = (await client.invoke(
            'automations:getHistory',
            ctx.workspaceId,
            ctx.webhookAutomationId,
          )) as Array<{
            id: string
            ts: number
            ok: boolean
            webhook?: { method: string; url: string }
          }>

          if (entries.length > 0) {
            const recentThreshold = Date.now() - 120_000
            const recentFailed = entries.find((e) =>
              !e.ok && e.ts > recentThreshold && e.webhook?.method === 'POST'
            )
            if (recentFailed) {
              return `webhook failure recorded: method=${recentFailed.webhook!.method}, url=${recentFailed.webhook!.url.slice(0, 50)}`
            }

            const latest = entries[0]
            lastSummary = `latest: ok=${String(latest?.ok)} method=${String(latest?.webhook?.method ?? 'n/a')} ts=${String(latest?.ts ?? 'n/a')}`
          }

          await new Promise((r) => setTimeout(r, delay))
          delay = Math.min(Math.round(delay * 1.8), 1500)
        }

        const waitedMs = Date.now() - start
        throw new Error(
          `No recent failed POST webhook history entry after ${waitedMs}ms (${lastSummary})`,
        )
      },
    },
    {
      name: 'automation:cleanup',
      fn: async (client, ctx) => {
        const cleaned = await cleanupAutomationArtifacts(client, ctx)
        return cleaned.length > 0 ? `cleaned: ${cleaned.join(', ')}` : 'nothing to clean'
      },
    },
    {
      name: 'sessions:branch delete',
      fn: async (client, ctx) => {
        if (!ctx.branchedSessionId) return 'skipped (no branch)'
        await client.invoke('sessions:delete', ctx.branchedSessionId)
        const id = ctx.branchedSessionId
        ctx.branchedSessionId = undefined
        return `deleted branch session: ${id}`
      },
    },
    {
      name: 'sources:delete',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId || !ctx.createdSourceSlug) return 'skipped (no source)'
        await client.invoke('sources:delete', ctx.workspaceId, ctx.createdSourceSlug)
        return `deleted source: ${ctx.createdSourceSlug}`
      },
    },
    {
      name: 'labels:delete (e2e-test)',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId || !ctx.e2eTestLabelId) return 'skipped (no e2e-test label)'
        await client.invoke('labels:delete', ctx.workspaceId, ctx.e2eTestLabelId)
        return `deleted label: ${ctx.e2eTestLabelId}`
      },
    },
    {
      name: 'sessions:delete',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId) return 'skipped (no session)'
        await client.invoke('sessions:delete', ctx.createdSessionId)
        return `deleted session: ${ctx.createdSessionId}`
      },
    },
    {
      name: 'Disconnect',
      fn: async (client, ctx) => {
        await cleanupValidationArtifacts(client, ctx)
        client.destroy()
        return 'OK'
      },
    },
  ]
}

export async function runValidation(
  client: CliRpcClient,
  jsonMode: boolean,
  noSpinner?: boolean,
  workspaceDir?: string,
  validateOptions?: { baseUrl?: string; apiKey?: string; provider?: string; model?: string },
): Promise<number> {
  const steps = getValidateSteps()
  const total = steps.length
  const ctx: ValidateContext = {
    workspaceDir,
    baseUrl: validateOptions?.baseUrl,
    apiKey: validateOptions?.apiKey,
    provider: validateOptions?.provider,
    model: validateOptions?.model,
  }
  let passed = 0
  let failed = 0
  const results: Array<{ step: string; status: string; detail: string; elapsed: number }> = []
  const totalStart = performance.now()

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const num = `[${i + 1}/${total}]`
    const plainLen = num.length + 1 + step.name.length

    // Spinner + live event printer
    // Spinner keeps running until the agent produces real output (text_delta/tool_start).
    // Early events (user_message, connection_changed, usage_update) are buffered or ignored
    // so the spinner stays visible while the agent is thinking.
    let spinner: { stop(): void } | undefined
    if (!jsonMode) {
      let headerPrinted = false
      let accText = ''
      let textFlushed = false
      let bufferedPrompt = ''

      if (_useColor && !noSpinner) {
        spinner = createSpinner(`${c.cyan(num)} ${step.name}`)
      }

      const flushText = () => {
        if (textFlushed || !accText) return
        const clean = accText.replace(/\n/g, ' ').trim()
        if (!clean) return
        const display = clean.length > 120 ? clean.slice(0, 120) + '…' : clean
        process.stdout.write(`    ${c.dim('↳')} ${c.yellow(display)}\n`)
        textFlushed = true
      }

      const ensureHeader = () => {
        if (headerPrinted) return
        spinner?.stop()
        process.stdout.write(`${c.cyan(num)} ${step.name}\n`)
        if (bufferedPrompt) {
          process.stdout.write(`    ${c.dim('→')} ${c.blue(`"${bufferedPrompt}"`)}\n`)
        }
        headerPrinted = true
      }

      ctx.onEvent = (ev) => {
        switch (ev.type) {
          // Buffer prompt — shown when agent starts responding
          case 'user_message': {
            const msg = ev.message as any
            let text = ''
            if (typeof msg?.content === 'string') {
              text = msg.content
            } else if (Array.isArray(msg?.content)) {
              text = msg.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ')
            }
            const clean = text.replace(/\n/g, ' ').trim()
            bufferedPrompt = clean.length > 100 ? clean.slice(0, 100) + '…' : clean
            break
          }
          // F1.472 · a voided partial is not the step's answer: forget it, so the
          // retried text is summarised on its own (upstream v0.13.4's validate printer).
          case 'text_discard':
            accText = ''
            textFlushed = false
            break
          // Agent text — stop spinner, show header + prompt + text
          case 'text_delta':
            ensureHeader()
            // R32 · same preference as the print-mode printer above: display the
            // hook's replacement when there is one, the original otherwise.
            accText += String(ev.displayDelta ?? ev.delta ?? '')
            if (!textFlushed && accText.length > 40) flushText()
            break
          case 'text_complete':
            ensureHeader()
            flushText()
            break
          // Tool use — stop spinner, show header + prompt + tool
          case 'tool_start': {
            ensureHeader()
            flushText()
            const name = String(ev.toolName ?? '?')
            const intent = ev.toolIntent ? ` — "${ev.toolIntent}"` : ''
            process.stdout.write(`    ${c.dim('↳')} ${c.dim(`tool: ${name}${intent}`)}\n`)
            accText = ''
            textFlushed = false
            break
          }
          // Ignore internal events (connection_changed, usage_update, etc.)
        }
      }
    } else {
      ctx.onEvent = undefined
    }

    const stepStart = performance.now()
    try {
      const detail = await step.fn(client, ctx)
      const elapsed = (performance.now() - stepStart) / 1000
      passed++
      results.push({ step: step.name, status: 'OK', detail, elapsed })
      spinner?.stop()
      if (!jsonMode) {
        const dots = c.dim('.'.repeat(Math.max(1, 50 - plainLen)))
        const time = c.dim(elapsed < 1 ? `(${Math.round(elapsed * 1000)}ms)` : `(${elapsed.toFixed(1)}s)`)
        process.stdout.write(`${c.cyan(num)} ${step.name} ${dots} ${c.green('✓')}  ${detail}  ${time}\n`)
      }
    } catch (e) {
      const elapsed = (performance.now() - stepStart) / 1000
      failed++
      const msg = e instanceof Error ? e.message : String(e)
      results.push({ step: step.name, status: 'FAIL', detail: msg, elapsed })
      spinner?.stop()
      if (!jsonMode) {
        const dots = c.dim('.'.repeat(Math.max(1, 50 - plainLen)))
        const time = c.dim(elapsed < 1 ? `(${Math.round(elapsed * 1000)}ms)` : `(${elapsed.toFixed(1)}s)`)
        process.stderr.write(`${c.cyan(num)} ${step.name} ${dots} ${c.red('✗')}  ${msg}  ${time}\n`)
      }
    }
  }

  // Error-recovery path when validation did not reach Disconnect.
  await cleanupValidationArtifacts(client, ctx)

  const totalSec = ((performance.now() - totalStart) / 1000).toFixed(1)

  if (jsonMode) {
    out({ total, passed, failed, results, elapsedSeconds: parseFloat(totalSec) }, true)
  } else {
    if (failed === 0) {
      process.stdout.write(`\n${c.green(`✓ ${passed}/${total} passed`)} ${c.dim(`in ${totalSec}s`)}\n`)
    } else {
      process.stdout.write(`\n${c.red(`✗ ${passed}/${total} passed, ${failed} failed`)} ${c.dim(`in ${totalSec}s`)}\n`)
    }
  }

  return failed > 0 ? 1 : 0
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

export function printHelp(): void {
  process.stdout.write(`nessy-general-agent — Terminal client for Nessy Desktop server

Usage: nessy-general-agent [options] <command> [args...]

Connection:
  --url <ws[s]://...>    Server URL (default: $NESSY_SERVER_URL)
  --token <secret>       Auth token (default: $NESSY_SERVER_TOKEN)
  --workspace <id>       Workspace ID (auto-detected if omitted)
  --timeout <ms>         Request timeout (default: 10000)
  --tls-ca <path>        Custom CA cert for self-signed TLS
  --json                 Raw JSON output for scripting
  --safe-mode            Start with no CLAUDE.md, skills, plugins, hooks, MCP
                         servers, commands or agents loaded, for troubleshooting
                         a broken configuration. Managed policy still applies.
                         Same as $NESSY_SAFE_MODE=1.
  --                     End of flags. Every token after it is a positional, so
                         a prompt or an 'invoke' argument may start with a dash.
                         Any other unrecognized dash-argument is an error.

LLM Configuration (for 'run' command):
  --provider <name>      LLM provider (default: anthropic, or $LLM_PROVIDER)
                         Supported: anthropic, openai, google, openrouter, groq, mistral, deepseek, xai, ...
  --model <id>           Model to use (or $LLM_MODEL)
  --fallback-model <a,b,c>
                         Comma-separated fallback chain tried in order when the
                         primary model drains, deduplicated and capped at three.
                         Takes precedence over the fallbackModel setting and
                         applies for the current turn only. Same as
                         $NESSY_FALLBACK_MODEL.
  --settings <path|json> Path to a settings JSON file, or an inline JSON string.
                         Values set here override the same keys in your
                         settings.json files for this session; keys you omit
                         keep their file-based values. Applies on the Claude
                         runtime, above user/project/local settings and below
                         managed policy. Same as $NESSY_CLAUDE_SETTINGS.
  --setting-sources <list|none>
                         Which filesystem settings the Claude runtime loads:
                         a comma-separated subset of user,project,local — or
                         'none' for the empty list, since an empty value cannot
                         travel in an environment variable. Omitted means all
                         three. Narrowing is announced, because dropping
                         'project' also stops loading skills, commands and
                         subagents from --add-dir roots. Same as
                         $NESSY_CLAUDE_SETTING_SOURCES.
  --bare                 Accepted for compatibility with Claude Code's own flag
                         and applied to nothing; it is not an alias of
                         --safe-mode, and the reason is printed when you pass it.
  --api-key <key>        API key (or $LLM_API_KEY, or provider-specific e.g. $OPENAI_API_KEY)
  --base-url <url>       Custom API endpoint (or $LLM_BASE_URL). The WIRE it speaks
                         follows --provider, never the URL: the default provider
                         (anthropic) sends Anthropic Messages to <url>/v1/messages,
                         and every other provider sends OpenAI chat completions to
                         <url>/chat/completions. To point this CLI at an
                         OpenAI-compatible endpoint, name one: --provider openai.

Commands:
  run <message>          Spawn server, send message, stream response, exit
                         --workspace-dir <path>  Select an external Project through a validated handle
                         --source <slug>     Enable source (repeatable)
                         --permission-mode   Permission mode (default: default). With no
                                             flag, a permission_request is denied and the
                                             run exits 1 — pass bypassPermissions, or
                                             pre-approve with allow rules. Also spelled
                                             --mode.
                         --dangerously-skip-permissions
                                             Alias for --permission-mode bypassPermissions.
                         --output-format     text, json, or stream-json (default: text)
                                             json prints ONE object at the end: .result (the
                                             turn's text), .session_id, .subtype, .is_error,
                                             .duration_ms, and .usage / .total_cost_usd when the
                                             backend reported them — read it with
                                             jq -r .result
                                             stream-json opens with a system/init frame carrying
                                             plugins and mcp_servers; plugin_errors and
                                             mcp_server_errors appear only when non-empty, so a CI
                                             gate can fail on their presence
                         --json-schema <s>   JSON Schema (draft-07) the run's final output must
                                             match; pair with --output-format json and read the
                                             validated value with jq .structured_output.
                                             Without --output-format json the bare validated
                                             object is printed on its own, as before
                         --agents <json>     Subagent definitions for this session only, as a
                                             JSON object keyed by agent name; each value takes a
                                             prompt plus the subagent frontmatter fields. Nothing
                                             is written to disk and the session cannot be resumed
                                             with them. A name here outranks the same name in
                                             .nessy-agent/agents and in an installed plugin. A
                                             definition the host refuses is skipped by name in
                                             the server log; the run continues with the rest
                         --no-session-persistence
                                             Do not save the session: it is never written
                                             to disk and cannot be resumed. Same as
                                             $NESSY_SKIP_PROMPT_HISTORY (or
                                             $CLAUDE_CODE_SKIP_PROMPT_HISTORY).
                                             File snapshots taken so you can revert an edit
                                             during the run are still written, and are
                                             removed when the session ends; a crash can
                                             leave them behind.
                         --no-cleanup        Accepted and ignored. The run keeps its
                                             session by default now, so this asks for
                                             what already happens.
                         --server-entry      Path to server/index.ts
                         Exit codes: 0 success, 1 failure, 130 SIGINT (Ctrl-C),
                         143 SIGTERM. An unknown flag exits 1 before the run starts.
                         SIGINT ends the turn in progress; SIGTERM stops it at
                         once but records no result, so a resume continues it.
  doctor                 Read-only configuration checkup — no server, no session.
                         Lists which managed settings source is in effect, every
                         managed entry that failed validation with its source and
                         field, and every user settings layer rejected whole.
                         It never repairs anything: every finding is yours to fix
                         by hand, in the file it names.
                         Exits 1 when it finds something, so a fleet policy push
                         can be gated on it.
  plugin validate <path> Validate a plugin bundle without installing it — no
                         server, no session. --strict treats warnings as errors.
                         Exits 1 when the bundle does not pass. Agent
                         frontmatter is checked in the path and in an 'agents'
                         folder under it, manifest or not; skills and commands
                         are not.
  plugin list            Installed plugins: version, source marketplace, global
                         enable status. Also 'plugin ls'.
  plugin details <name>  Component inventory and projected token cost for one
                         installed plugin.
  ping                   Verify connectivity (clientId + latency)
  health                 Check credential store health
  versions               Show server runtime versions
  workspaces             List workspaces
  workspace remove <id>  Purge a project's local state: transcripts, task lists,
                         debug logs, file-edit history, prompt history and the
                         config entry, transactionally. Names anything the
                         cleanup could not remove, and says that your Codex CLI
                         history in ~/.codex is a separate tool's data and was
                         not touched.
  sessions               List sessions in workspace
  connections            List LLM connections
  sources                List configured sources
  session create         Create a session (--name, --mode, --worktree [name|merge-request URL])
  session messages <id>  Print session message history
  session delete <id>    Delete a session
  session rewind <id> [checkpoint-id]
                         List a session's file checkpoints, or rewind to one.
                         Prints what it restored AND what it skipped; a runtime
                         that produces no checkpoints says so instead of
                         reporting a rewind that could not have happened.
  send <id> <message>    Send message and stream AI response
  cancel <id>            Cancel in-progress processing
  invoke <channel> [...] Raw RPC call with JSON args
  listen <channel>       Subscribe to push events (Ctrl+C to stop)
  --validate-server      Multi-step server integration test
                         --verbose, -v       Show server stderr output

Examples:
  nessy-general-agent run "What files are in the current directory?"
  nessy-general-agent run --source nessy-kb "Summarize today's daily note"
  nessy-general-agent run --workspace-dir .github/agents --source nessy-public "Read the doc"
  nessy-general-agent run --provider openai --model gpt-4o "Summarize this repo"
  OPENAI_API_KEY=sk-... nessy-general-agent run --provider openai "Hello"
  GOOGLE_API_KEY=... nessy-general-agent run --provider google --model gemini-2.0-flash "Hello"
  DEEPSEEK_API_KEY=sk-... nessy-general-agent run --provider deepseek --model deepseek-v4-flash "Hello"
  nessy-general-agent run --dangerously-skip-permissions "Fix the failing test"
  echo "Analyze this code" | nessy-general-agent run
  nessy-general-agent doctor
  nessy-general-agent --json doctor | jq '.invalidManagedEntries'
  nessy-general-agent plugin validate ./my-plugin --strict
  nessy-general-agent --json plugin list | jq '.[] | select(.enabled == "enabled")'
  nessy-general-agent plugin details my-plugin
  nessy-general-agent ping
  nessy-general-agent sessions
  nessy-general-agent send abc-123 "What files are in the current directory?"
  echo "Summarize this" | nessy-general-agent send abc-123
  nessy-general-agent --validate-server
  nessy-general-agent invoke system:homeDir
  nessy-general-agent --json workspaces | jq '.[].name'
`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * P6.930 clause (3) — what `--bare` says instead of doing something.
 *
 * The two sentences it rests on are quoted on the `bare` field above: the flag
 * is Claude Code's own minimal mode, and the `--safe-mode` row denies the
 * equivalence an alias would assert. Named alternatives rather than a bare
 * refusal, because a user who typed it wanted one of two real things.
 */
export const CLAUDE_BARE_FLAG_NOTICE =
  '--bare is accepted and NOT applied: it is Claude Code\'s own minimal mode (it sets CLAUDE_CODE_SIMPLE '
  + 'and skips auto-discovery of hooks, skills, commands, subagents, plugins, MCP servers, auto memory and '
  + 'CLAUDE.md), and this CLI drives three runtimes, only one of which has it. It is not an alias of '
  + '--safe-mode, and the vendor page says so of --safe-mode: "Authentication, model selection, built-in '
  + 'tools, and permissions work normally, which differs from --bare". Use --safe-mode to start with this '
  + `host's customizations disabled, or --setting-sources ${CLAUDE_SETTING_SOURCES_NONE} to stop the claude `
  + 'child loading user, project and local settings.'

/**
 * D1.258 — REFUSE a spawn-only flag on a run that attaches, before anything
 * connects.
 *
 * D1.233 gave `run` an `--url` attach branch and PRINTED what could not be
 * honoured. Printing is the wrong end of the documented discipline: the four
 * flags below are delivered to the server through the ENVIRONMENT
 * {@link spawnLocalServer} builds, so against a server this CLI did not start
 * they are not "degraded", they do nothing at all — and a `--safe-mode` that
 * does nothing is the failure mode `--safe-mode` exists to prevent.
 *
 * SHAPE BORROWED, NOT INVENTED. `headless.md:33` — *"If you pass an invalid
 * flag, Claude Code reports the error to stderr before the run starts"* — is
 * what the unknown-flag gate implements, and `settings-reference.md`'s
 * `disableSideloadFlags` row (*"Claude Code exits with an error naming the
 * rejected flags"*) is what D1.107 implements one screen above. Same place in
 * `main()`, same `err()` + `exit(1)`, same naming of the flags.
 *
 * ONLY THE ARGV FORMS, which is the whole reason {@link CliArgs.attachInertFlags}
 * exists: every one of the four has an env twin that `parseArgs` folds into the
 * same field, and an inherited `NESSY_SAFE_MODE=1` is the operator's ambient
 * state rather than an instruction anybody typed on this command line.
 * `cmdRun`'s notice still reports that half, by variable name.
 *
 * ONLY THE TWO COMMANDS THAT SPAWN. `run` (D1.233) and `validate` both branch
 * on `args.url` between attaching and {@link spawnLocalServer}; they are the
 * only two callers of it, so they are the only two commands for which these
 * flags ever meant anything. `[product]` residue stated rather than widened:
 * for every OTHER command the four are inert with or without `--url`, and
 * nothing says so — reported as a proposed row rather than refused here,
 * because refusing them everywhere is a posture with a blast radius.
 */
export function refuseAttachInertFlags(args: CliArgs): string | undefined {
  if (!args.url) return undefined
  if (args.command !== 'run' && args.command !== 'validate') return undefined
  if (args.attachInertFlags.length === 0) return undefined
  const flags = args.attachInertFlags.join(', ')
  const verb = args.attachInertFlags.length === 1 ? 'is' : 'are'
  return `${flags} ${verb} rejected with --url: this CLI delivers ${args.attachInertFlags.length === 1 ? 'it' : 'them'} `
    + 'in the environment of a server it spawns, and --url attaches to a server it did not start. '
    + `Drop --url to spawn a server that honours ${args.attachInertFlags.length === 1 ? 'it' : 'them'}, `
    + 'or set the matching variable in the environment of the server you are attaching to.'
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const args = parseArgs(argv)

  // `headless.md:33` — "If you pass an invalid flag, Claude Code reports the
  // error to stderr before the run starts." Before the run starts: no server is
  // spawned, no session is created and nothing is sent. This is the first thing
  // `main()` does for exactly that reason.
  //
  // An explicit `--help`/`help`/`--version` still wins, so a user who mistypes
  // a flag while asking for the usage gets the usage.
  if (args.unknownFlags.length > 0 && args.command !== 'help' && args.command !== 'version') {
    for (const flag of args.unknownFlags) err(`Unknown flag: ${flag}`)
    process.stderr.write(
      "Run 'nessy-general-agent --help' for the supported flags. "
      + 'Use `--` before a positional argument that starts with a dash.\n',
    )
    process.exit(1)
  }

  // P6.317 (2) — the same "before the run starts" discipline for `--agents`:
  // gated once here rather than per command, so `run` and `session create` fail
  // with one message and no server is spawned. Only the flag's outer shape is
  // checked; see {@link parseAgentsArg} for why the fields are the host's.
  try {
    parseAgentsArg(args.agents)
  } catch (e) {
    err(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }

  // D1.107 — the administrator's refusal of the sideload flags, which this
  // product shipped one of and could not refuse.
  //
  // `settings-reference.md#disablesideloadflags`, verbatim: "Reject the
  // `--plugin-dir`, `--plugin-url`, `--agents`, and `--mcp-config` CLI flags at
  // startup, which users could otherwise pass to bypass
  // `strictKnownMarketplaces` for a single run. Claude Code exits with an error
  // naming the rejected flags". Scope `Managed`, Type Boolean, Default `false`.
  //
  // OF THOSE FOUR NAMES WE SHIP EXACTLY ONE. `--plugin-dir`, `--plugin-url` and
  // `--mcp-config` are unknown to `parseArgs`, and the gate above refuses every
  // unrecognised dash-leading token before anything is spawned — the property
  // `sideload-flags-tripwire.test.ts` pins, which is stronger than the three
  // names because it holds for a fourth flag nobody has invented yet. So the
  // enforcement this key buys here is one flag wide, and that is a measurement
  // of our surface rather than a narrowing of the key.
  //
  // AT STARTUP and NAMING THE FLAG, because the page's behaviour is the
  // contract: dropping the value and continuing is the shape that lets an
  // operator believe a definition took. The default is unchanged (`false`,
  // absent key → accept), so nothing moves for anyone who has not set it.
  //
  // Read LAZILY, only when the flag was actually passed: resolving the enforced
  // managed policy reads the managed file and the delivered cache, and an
  // ordinary run must not pay for a flag it did not use.
  if (args.agents !== '' && args.command !== 'help' && args.command !== 'version') {
    const [{ resolveEnforcedManagedPolicy }, { isManagedSideloadFlagsDisabled }] = await Promise.all([
      import('@nessy-agent/server-core/bootstrap/managed-policy-resolution'),
      import('@nessy-agent/shared/agent/pi-harness/managed-policy'),
    ])
    if (isManagedSideloadFlagsDisabled(resolveEnforcedManagedPolicy().policy)) {
      err('--agents is rejected by managed settings (disableSideloadFlags).')
      process.exit(1)
    }
  }

  // D1.258 — the same discipline for the spawn-only flags on an attaching run.
  // After the unknown-flag gate, so a typo is still reported as a typo, and
  // before anything is spawned or connected. See {@link refuseAttachInertFlags}.
  if (args.command !== 'help' && args.command !== 'version') {
    const refusal = refuseAttachInertFlags(args)
    if (refusal !== undefined) {
      err(refusal)
      process.exit(1)
    }
  }

  // P6.930 — the two claude posture flags say their piece BEFORE the run starts,
  // on the same discipline as the invalid flag above and for the same reason: a
  // narrowing met three turns later as a missing skill reads as a defect, and a
  // silently-swallowed `--bare` reads as a flag that took.
  if (args.command !== 'help' && args.command !== 'version') {
    if (args.claudeSettingSources) {
      // Called for its DIAGNOSTICS. The value itself travels to the server raw
      // and is re-resolved where the SDK option is built, so this side never
      // becomes a second parser with its own answer.
      resolveClaudeSettingSources(
        { [CLAUDE_SETTING_SOURCES_ENV_VAR]: args.claudeSettingSources },
        message => process.stderr.write(`${message}\n`),
      )
    }
    if (args.bare) process.stderr.write(`${CLAUDE_BARE_FLAG_NOTICE}\n`)
  }

  // Set custom CA before any WS connections
  if (args.tlsCa) {
    process.env.NODE_EXTRA_CA_CERTS = args.tlsCa
  }

  if (args.command === 'help' || args.command === '') {
    printHelp()
    return
  }

  if (args.command === 'version') {
    const pkg = await import('../package.json')
    out(pkg.version ?? pkg.default?.version ?? 'unknown', false)
    return
  }

  // run is self-contained — spawns its own server
  if (args.command === 'run') {
    await cmdRun(args)
    return
  }

  // validate can spawn its own server or use --url
  if (args.command === 'validate') {
    await cmdValidate(args)
    return
  }

  // `debug-your-config.md:46` — the terminal doctor prints "read-only
  // installation and settings diagnostics WITHOUT starting a session", so it is
  // dispatched above the server-URL requirement, alongside `help` and `version`.
  // Requiring a running server would defeat the purpose:
  // `settings-reference.md#requiredminimumversion` puts `claude doctor` among the
  // commands that keep working when the version gate refuses to start the app —
  // "`claude update`, `claude install`, and `claude doctor` keep working below the
  // floor so users can recover" — and `#requiredmaximumversion` says the same
  // above the ceiling.
  if (args.command === 'doctor') {
    const { runDoctor } = await import('./doctor.ts')
    const result = runDoctor({ json: args.json })
    process.stdout.write(result.text + '\n')
    process.exitCode = result.exitCode
    return
  }

  // `plugins/cli-reference.md#plugin-validate` puts `plugin validate <path>` on a directory that
  // is not installed anywhere, and `:486` names CI as its use; `list` and
  // `details` read only the local registry and the local activation policy. So,
  // like `doctor`, all three are dispatched above the server-URL requirement.
  // Subcommand parsing follows the `session` precedent: the verb and its own
  // flags stay in `args.rest`, and the global `--json` is consumed by parseArgs.
  if (args.command === 'plugin') {
    const { runPluginCommand } = await import('./plugin.ts')
    const result = await runPluginCommand(args.rest, { json: args.json })
    process.stdout.write(result.text + '\n')
    process.exitCode = result.exitCode
    return
  }

  // All other commands need a server URL
  if (!args.url) {
    err('No server URL. Use --url <ws://...> or set $NESSY_SERVER_URL')
    process.exit(1)
  }

  const client = new CliRpcClient(args.url, {
    token: args.token || undefined,
    workspaceId: args.workspace,
    requestTimeout: args.timeout,
    connectTimeout: args.timeout,
  })

  try {
    switch (args.command) {
      case 'ping':
        await cmdPing(client, args)
        break
      case 'health':
        await cmdHealth(client, args)
        break
      case 'versions':
        await cmdVersions(client, args)
        break
      case 'workspaces':
        await cmdWorkspaces(client, args)
        break
      case 'sessions':
        await cmdSessions(client, args)
        break
      case 'connections':
        await cmdConnections(client, args)
        break
      case 'sources':
        await cmdSources(client, args)
        break
      case 'workspace': {
        const subCmd = args.rest.shift()
        switch (subCmd) {
          case 'remove':
            await cmdWorkspaceRemove(client, args)
            break
          default:
            err(`Unknown workspace subcommand: ${subCmd}`)
            process.exit(1)
        }
        break
      }
      case 'session': {
        const subCmd = args.rest.shift()
        switch (subCmd) {
          case 'create':
            await cmdSessionCreate(client, args)
            break
          case 'messages':
            await cmdSessionMessages(client, args)
            break
          case 'delete':
            await cmdSessionDelete(client, args)
            break
          case 'rewind':
            await cmdSessionRewind(client, args)
            break
          default:
            err(`Unknown session subcommand: ${subCmd}`)
            process.exit(1)
        }
        break
      }
      case 'send':
        await cmdSend(client, args)
        break // cmdSend calls process.exit
      case 'cancel':
        await cmdCancel(client, args)
        break
      case 'invoke':
        await cmdInvoke(client, args)
        break
      case 'listen':
        await cmdListen(client, args)
        break // never returns
      default:
        err(`Unknown command: ${args.command}`)
        printHelp()
        process.exit(1)
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    err(msg)
    process.exit(1)
  } finally {
    client.destroy()
  }
}

/**
 * F1.472 · what a plain-text display prints where a failed partial was voided —
 * upstream craft-agents-oss v0.13.4's words (Apache-2.0), because a terminal cannot
 * un-print and a retried answer must never read as the partial's continuation.
 */
export const TEXT_DISCARD_DELIMITER = '\n[incomplete response discarded]\n'

/**
 * F1.472 · one turn's assistant text as `sendAndStream` reads it, and the one thing a
 * stream cannot do on its own: take a failed partial back.
 *
 * `text_discard` (F1.298's `SessionTextDiscardEvent`, `{ type, sessionId, turnId }`) names
 * the still-streaming message a runtime voided before retrying; the renderer removes that
 * message (`handleTextDiscard`). Here text mode DELIMITS it ({@link TEXT_DISCARD_DELIMITER}),
 * json mode drops it from the envelope's `result`, and stream-json forwards the event
 * verbatim like every other. After a void the turn has seen no standing delta, so a retried
 * answer that arrives only as `text_complete` is printed and reported like any other.
 *
 * A discard voids only the message it names — or, when the deltas carried no `turnId`, the
 * one still open — and says whether there was one, so nothing is delimited that was never
 * printed.
 */
export class CliTurnText {
  private accumulated = ''
  private open: { turnId: unknown; start: number } | null = null
  /** A delta of a standing (not voided) message arrived — the `text_complete` fallback's gate. */
  sawDelta = false

  get text(): string {
    return this.accumulated
  }

  delta(text: string, turnId: unknown): void {
    this.sawDelta = true
    if (!this.open || this.open.turnId !== turnId) this.open = { turnId, start: this.accumulated.length }
    this.accumulated += text
  }

  /** A text the turn carried whole (`text_complete` with no delta before it). */
  append(text: string): void {
    this.accumulated += text
    this.open = null
  }

  discard(turnId: unknown): boolean {
    if (!this.open || (this.open.turnId !== undefined && this.open.turnId !== turnId)) return false
    this.accumulated = this.accumulated.slice(0, this.open.start)
    this.open = null
    this.sawDelta = false
    return true
  }
}

// Run if executed directly (not when imported by tests)
if (import.meta.main) {
  main()
}
