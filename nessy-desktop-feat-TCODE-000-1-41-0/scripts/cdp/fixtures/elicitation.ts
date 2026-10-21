/**
 * Fixture tree for the elicitation wave (`cases/elc-1.ts`, `cases/elc-2.ts`)
 * and for `CDX-147`'s MCP half.
 *
 * ```bash
 * bun run scripts/cdp/fixtures/elicitation.ts          # build/refresh the tree
 * bun run scripts/cdp/fixtures/elicitation.ts --print  # just say where it is
 * ```
 *
 * **The harness never builds this for itself.** `scripts/cdp/README.md` states
 * the rule — a case that installs plugins or rewrites config can break the
 * machine it is measuring — so the cases read this tree, assert against it, and
 * report BLOCKED when it is absent.
 *
 * Everything lands under one root (`NESSY_CDP_ELC_ROOT`, default
 * `~/nessy-cdp-elc`) including the app's `NESSY_CONFIG_DIR`, so the whole
 * fixture is `rm -rf`-able and the operator's own `~/.nessy-agent` is never
 * touched. `~/.nessy/dp_auth_creds.json` is read by the APP, never by this file.
 *
 * ## Why the server is declared in `<config>/mcp.json` and not in a plugin
 *
 * `<configDir>/mcp.json` is the GLOBAL native scope (`native-sources.ts`), so
 * the server needs no project, no project-trust grant and no marketplace
 * install — three variables this wave does not want. It matters twice over
 * here: a plugin-bundled MCP process is sandboxed to its own plugin data root
 * and could not write this fixture's log, which is the SERVER-side ground truth
 * both ELC cases read (measured in the MCP-W wave; see `mcp-w2.ts`).
 *
 * The name `elicit-probe` is deliberately already wire-legal: `[A-Za-z0-9_-]`
 * survives the mint untouched, so the wire name is the logical name and neither
 * ELC case has to reason about F3's sanitize rules. That question belongs to
 * `MCP-W1`/`MCP-W2` and mixing it in here would give a failure two possible
 * causes.
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

export function elicitationRoot(): string {
  return process.env.NESSY_CDP_ELC_ROOT ?? join(homedir(), 'nessy-cdp-elc')
}

export interface ElicitationPaths {
  root: string
  configDir: string
  logFile: string
  tokensFile: string
  serverFile: string
}

export function elicitationPaths(root = elicitationRoot()): ElicitationPaths {
  return {
    root,
    configDir: join(root, 'config'),
    logFile: join(root, 'elicit-calls.jsonl'),
    tokensFile: join(root, 'tokens.json'),
    serverFile: join(root, 'probe', 'elicit-server.mjs'),
  }
}

export interface ElicitationTokens {
  /** The probe server's secret, minted at BUILD time and read back from disk. */
  elicitProbe: string
}

export const ELC_FIXTURE = {
  /** The `mcpServers` key in `<config>/mcp.json`, and therefore the wire name. */
  serverName: 'elicit-probe',
  /** The identity this server stamps on every line it logs. */
  label: 'elicit-probe',
  /** Asks nothing; the elicitation-free positive control and CDX-147's probe. */
  whoamiTool: 'whoami',
  /** Form mode, one boolean field — one two-option card. */
  confirmTool: 'ask_confirm',
  /** URL mode with a non-http(s) url — the visible refusal. */
  badUrlTool: 'ask_bad_url',
  badUrl: 'file:///etc/passwd',
} as const

/**
 * What the cases assert, written out LITERALLY.
 *
 * Deliberately not imported from the code under test. A case that derives its
 * expectation from the function it is testing passes whatever that function
 * does, including a regression; these strings are read off
 * `packages/shared/src/mcp/elicitation.ts` and `pool-server.ts` by hand, and a
 * change has to come and edit them.
 */
export const ELC_EXPECTED = {
  /** A native global server keeps its (already legal) logical name. */
  wireName: 'elicit-probe',
  /**
   * `declineVisibly`'s reason for a non-http(s) URL, verbatim from
   * `mcp/elicitation.ts` `handleUrlElicitation`.
   */
  badUrlReason: 'Refused: this server did not supply an http(s) URL to open.',
  /** `declineVisibly` asks with exactly one option. */
  badUrlOption: 'OK',
  /** `planSingleField`'s rendering of a lone `boolean` property. */
  confirmOptions: ['Yes', 'No'] as const,
  /**
   * The pre-fix symptom, so a future reader can tell a REGRESSION from a new
   * failure. Q13-D1, measured on the packaged 1.25.1: the Codex runtime
   * answered `elicitation/create` with JSON-RPC `-32601 Method not found` in
   * the same millisecond, because the pool advertised no `elicitation`
   * capability at `initialize` unless a session had already registered a
   * handler — and on the shared workspace pool the connection is made during
   * session setup, before any such session exists.
   */
  preFixCodexSymptom: 'refused:-32601',
  /**
   * The OTHER pre-fix symptom, and the one ELC-2 exists for: on Pi,
   * `pi-agent.ts` validated an ask with the `ask_user` TOOL's documented 2-4
   * option bound, so `declineVisibly`'s single `OK` threw — and the throw
   * degraded to `{action:'cancel'}` with NO card ever shown. A silent drop of
   * the very dialog the decline-visibly rule exists to guarantee.
   */
  preFixPiSymptom: 'cancel with no card on screen',
} as const

/**
 * The tool name a MODEL sees, per runtime.
 *
 * Pi and the Claude runtime consume the pool per-server, so the pool's own
 * `mcp__<wire>__<tool>` reaches the model unchanged. The Codex runtime consumes
 * the WHOLE pool through one aggregating bridge declared in its config.toml as
 * `[mcp_servers.sources]`, which strips the `mcp__` prefix before the pool sees
 * the call and lets codex-app-server prefix it with its own server key — so the
 * same tool surfaces as `mcp__sources__<wire>__<tool>`
 * (`packages/shared/src/mcp/pool-server.ts`,
 * `packages/codex-responses-adapter/src/config-writer.ts`, and
 * `agent/backend/codex/event-adapter.ts` `mcpRowToolName` for the transcript
 * row). Forcing the Pi shape on Codex once made the runtime answer "Unknown
 * tool" to a name it never had — a broken detector reading as a product defect.
 */
export function elicitProxyToolName(tool: string, runtime: 'pi' | 'claude' | 'codex' = 'pi'): string {
  const poolName = `mcp__${ELC_EXPECTED.wireName}__${tool}`
  return runtime === 'codex' ? `mcp__sources__${poolName.slice('mcp__'.length)}` : poolName
}

// ---------------------------------------------------------------------------
// The server's own log — ground truth that does not come from the app
// ---------------------------------------------------------------------------

export interface ElicitLogEntry {
  at: number
  label: string
  method: string
  tool?: string
  mode?: string
  url?: string
  nonce?: string
  outcome?: string
  content?: Record<string, unknown>
  clientCapabilities?: Record<string, unknown> | null
  clientInfo?: Record<string, unknown> | null
  error?: unknown
}

/**
 * Sync on purpose: every caller is an assertion inside a case, and the file is
 * a few KB. An async read would only put an `await` in the middle of an
 * evidence gather.
 */
export function readElicitLog(root = elicitationRoot()): ElicitLogEntry[] {
  const path = elicitationPaths(root).logFile
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap(line => {
      try {
        return [JSON.parse(line) as ElicitLogEntry]
      } catch {
        return []
      }
    })
}

/** Log entries since `since` (epoch ms). */
export function elicitLogSince(since: number, root = elicitationRoot()): ElicitLogEntry[] {
  return readElicitLog(root).filter(entry => entry.at >= since)
}

/**
 * Every `initialize` this server has seen, newest last.
 *
 * The one read that answers "did OUR client declare the elicitation capability
 * on the wire" without asking the app about itself.
 */
export function elicitHandshakes(root = elicitationRoot()): ElicitLogEntry[] {
  return readElicitLog(root).filter(entry => entry.method === 'initialize')
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/**
 * Write the probe server with its identity BAKED IN — never passed as `env`.
 *
 * Measured in the MCP-W wave: a value declared in an MCP server's `env` block is
 * a credential to the runtime, which scrubs it from tool OUTPUT, and the first
 * live Pi turn came back `[REDACTED] [REDACTED]` instead of the probe's answer.
 * Correct product behaviour; fatal to a detector that reads a token out of a
 * reply.
 */
async function writeProbeServer(path: string, identity: { label: string; token: string; log: string }): Promise<void> {
  const source = await Bun.file(join(HERE, 'elicit-server.mjs')).text()
  // The hashbang has to STAY on line 1. Node strips `#!` only at byte 0; one
  // line lower it is a SyntaxError and the copy dies before it can speak MCP —
  // which surfaces as the server refusing every call, i.e. exactly like a
  // product-side connect bug.
  const hashbang = source.startsWith('#!') ? source.slice(0, source.indexOf('\n') + 1) : ''
  const body = source.slice(hashbang.length)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${hashbang}globalThis.ELC_BAKED = ${JSON.stringify(identity)}\n${body}`, 'utf8')
}

function token(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`
}

export async function buildElicitationFixture(root = elicitationRoot()): Promise<{
  paths: ElicitationPaths
  tokens: ElicitationTokens
}> {
  const paths = elicitationPaths(root)
  // Everything EXCEPT the config dir is rebuilt from scratch: the config dir
  // accumulates the app's own state (connections, sessions) across a wave, and
  // wiping it would throw away the gateway sign-in the operator performed
  // through the app's own card.
  await rm(join(root, 'probe'), { recursive: true, force: true })
  await mkdir(paths.configDir, { recursive: true })

  const tokens: ElicitationTokens = { elicitProbe: token('ELCPROBE') }
  await writeJson(paths.tokensFile, tokens)

  await writeProbeServer(paths.serverFile, {
    label: ELC_FIXTURE.label,
    token: tokens.elicitProbe,
    log: paths.logFile,
  })

  // `<configDir>/mcp.json` — the global native scope. Merged into whatever is
  // already there so a config dir shared with another fixture is not clobbered.
  const mcpPath = join(paths.configDir, 'mcp.json')
  const existing = existsSync(mcpPath)
    ? JSON.parse(await Bun.file(mcpPath).text()) as { mcpServers?: Record<string, unknown> }
    : {}
  await writeJson(mcpPath, {
    ...existing,
    mcpServers: {
      ...(existing.mcpServers ?? {}),
      // `alwaysLoad` pins the probe out of Pi's deferred-MCP surface. The host
      // contributes its own builtin dp servers to EVERY profile, and once the
      // session's MCP tool count crosses `PI_DEFERRED_MCP_TOOL_THRESHOLD` (48)
      // every unpinned tool moves behind tool_search/tool_load — measured
      // 2026-08-21: "20 total (55 deferred MCP tools hidden)", and the ELC
      // cases' direct calls answered `Tool … not found` on Pi. These cases test
      // ELICITATION, not deferral (deferral has its own rows), so the probe is
      // pinned rather than the prompt taught to tool_load.
      [ELC_FIXTURE.serverName]: { command: 'node', args: [paths.serverFile], alwaysLoad: true },
    },
  })

  await writeFile(paths.logFile, '', 'utf8')
  return { paths, tokens }
}

export function readElicitationTokens(root = elicitationRoot()): ElicitationTokens | undefined {
  const path = elicitationPaths(root).tokensFile
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, 'utf8')) as ElicitationTokens
}

if (import.meta.main) {
  const paths = elicitationPaths()
  if (process.argv.includes('--print')) {
    console.log(JSON.stringify({ paths, expected: ELC_EXPECTED, fixture: ELC_FIXTURE }, null, 2))
  } else {
    const { tokens } = await buildElicitationFixture()
    console.log(JSON.stringify({ paths, tokens, expected: ELC_EXPECTED }, null, 2))
    console.error(
      `\nStart the app against this tree:\n  NESSY_CONFIG_DIR=${paths.configDir} NESSY_CDP_PORT=9225 <the packaged app or bun run electron:dev>\n`
      + '\nThen, in the app: sign in through the one-click Nessy Gateway card and create the\n'
      + 'Pi, Claude Code (Nessy Gateway) and Codex connections you want measured. ELC-1 drives\n'
      + 'whichever of the three exist and reports the rest as gaps.\n',
    )
  }
}
