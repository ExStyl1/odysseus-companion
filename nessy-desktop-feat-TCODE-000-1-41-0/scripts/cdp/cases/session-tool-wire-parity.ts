/**
 * WIRE-PARITY — one session tool, one wire name, on all three runtimes.
 *
 * The close-out gate for `docs/superpowers/plans/2026-08-15-session-tool-wire-name-unification.md`.
 * T1 collapsed Pi's `piName` onto the registry id and T2 renamed Codex's bundled
 * MCP server key `nessy_session` → `session`; both were proven by unit tests
 * computed from live registries (`session-tool-wire-parity.test.ts`). What no
 * test can reach is the thing the plan is actually about: the bytes that leave
 * for the model on a real turn, on the artifact a user downloads.
 *
 * ## Why this needs a PACKAGED build
 *
 * `electron:dev` runs the host and the Pi subprocess from built bundles, so a
 * source change is invisible until they are rebuilt — but worse, a dev run does
 * not exercise the shipped resolution at all. `resolveInterceptorBundlePath`
 * preloads the `.ts` source when `!isPackaged`; the Codex arm's whole subject,
 * the emitted `config.toml`, is written by the packaged `codex-app-server`'s own
 * `CODEX_HOME`. The plan says packaged and means it.
 *
 * ## The instrument, per runtime, and the one that had to be invented
 *
 * The claim is "the model-facing wire name is byte-identical", so every capture
 * has to come from a file the RUNTIME wrote, not from a host-side value the host
 * could be computing consistently-but-wrongly on both sides:
 *
 *   - **Pi** — `<session>/.pi-sessions/*.jsonl`, the Pi SDK's own append-as-
 *     produced transcript (`lib/runtime-session-log.ts`).
 *   - **Claude** — `<workspace>/claude-config/projects/…/*.jsonl`, the Agent
 *     SDK's own transcript, narrowed to this session's directory.
 *   - **Codex — there is no such file, and `lib/runtime-session-log.ts` says so
 *     in as many words**: `codex-agent.ts` mints its `CODEX_HOME` with
 *     `mkdtempSync` and `rmSync`es it on teardown, so anything the app-server
 *     rolled out is gone before a case could read it. That note is about a case
 *     that reads AFTER the session ends. This one reads WHILE it is alive: the
 *     directory is `mkdtemp`ed under `<config>/codex-home` (F1.652; else `tmpdir()`), which a
 *     driver running as the same user shares, so snapshotting the set of
 *     `nessy-codex-home-*` before the turn and diffing after it names the one
 *     this session created. Inside sits `config.toml` — the emitted artifact
 *     whose `[mcp_servers.<key>]` IS the wire prefix, because the binary joins
 *     it as `mcp__<server>__<tool>` — plus whatever rollout `.jsonl` the binary
 *     wrote. Both are read; the config key is the load-bearing one, since it is
 *     what the binary advertises to the model.
 *
 * The app transcript row is read on every runtime too, but it is the SECOND
 * instrument on purpose: it is what the app dispatched, and a case that asserted
 * only on it would be asking the host to confirm its own arithmetic.
 *
 * ## F7, and why it is not a code read
 *
 * T2 newly routes Codex rows through the hard-coded `'session'`-segment
 * consumers — `BUILT_IN_MCP_SERVERS` in `pre-tool-use.ts`, the
 * `internalMcpServers` table in `SessionManager.resolveToolDisplayMeta`. Before
 * it, a Codex `mcp__nessy_session__*` call was neither a built-in nor a known
 * source and fell into the `source_activation_needed` branch. So the assertion
 * is the CONSEQUENCE, not the constant: the row resolves to the internal
 * session-tool table's own display name, the call actually ran and returned,
 * no permission card appeared at any point during the turn, and none of the
 * activation-denial texts (`pi-agent.ts` `"is not active"` / `"not available
 * yet"`) is in the transcript.
 *
 * ## A runtime that cannot be driven is NAMED and the case BLOCKS
 *
 * Never a pass. `scripts/cdp/README.md`: a gate that reports green while
 * silently skipping a runtime is worse than no gate.
 *
 * Usage (packaged, dark theme forced by the case itself):
 *   PATH=<PATH without /usr/sbin> "release/mac-arm64/Nessy Desktop.app/Contents/MacOS/Nessy Desktop" \
 *     --remote-debugging-port=9230
 *   NESSY_CDP_PORT=9230 bun run scripts/cdp/cases/session-tool-wire-parity.ts
 *   NESSY_CDP_WIRE_RUNTIMES=pi,codex …   narrows the matrix (still BLOCKS)
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { CdpSession } from '../lib/connect.ts'
import { sendPrompt } from '../lib/chat.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { clickSelector } from '../lib/viewport.ts'
import { codexHomeRoots, listCodexHomes } from '../lib/codex-session-log.ts'
import {
  configDir,
  readClaudeSessionLog,
  readPiSessionLog,
  type RuntimeSessionEntry,
} from '../lib/runtime-session-log.ts'
import {
  assertElectronApi,
  freshSession,
  listSessions,
  sessionCommand,
  transcript,
  visibleElements,
  waitFor,
  type SessionKey,
  type TranscriptMessage,
} from '../lib/state.ts'

const ID = 'WIRE-PARITY'
const TITLE = 'One session tool reaches the model as a byte-identical mcp__session__<id> on Pi, Claude and Codex'

/**
 * The anchor tool.
 *
 * The plan names `config_validate` or `transform_data`: snake-spelled (so its
 * registry id needs no casing argument), `executionMode: 'registry'` and
 * host-callback-free (so it is Codex-visible at all — `browser_tool` is not),
 * `safeMode: 'allow'` + `readOnly: true` (so a refusal is a finding rather than
 * the expected outcome), and NOT `visibility: 'pi-only'` (so it is on all three
 * surfaces without `NESSY_ENABLE_TASKS`).
 */
const ANCHOR = process.env.NESSY_CDP_WIRE_ANCHOR?.trim() || 'config_validate'
const SESSION_PREFIX = 'mcp__session__'
const EXPECTED_WIRE = `${SESSION_PREFIX}${ANCHOR}`
/** The pre-unification Codex segment. Must appear in NO capture. */
const LEGACY_SEGMENT = 'nessy_session'
/** `resolveToolDisplayMeta`'s own label for the anchor — F7's built-in evidence. */
const ANCHOR_DISPLAY_NAME = 'Validate Config'

const PROMPT = process.env.NESSY_CDP_WIRE_PROMPT?.trim()
  || `Call your ${ANCHOR} tool with target preferences (search your tools for it first if you must), then reply with exactly WIRE-OK.`

const TURN_TIMEOUT_MS = Number(process.env.NESSY_CDP_WIRE_TIMEOUT_MS ?? 420_000)

interface RuntimeTarget {
  id: 'pi' | 'claude' | 'codex'
  label: string
  providerTypes: string[]
  slugEnv: string
}

const ALL_RUNTIMES: RuntimeTarget[] = [
  { id: 'pi', label: 'Pi', providerTypes: ['pi', 'pi_compat'], slugEnv: 'NESSY_CDP_WIRE_PI_SLUG' },
  { id: 'claude', label: 'Claude runtime', providerTypes: ['claude-runtime'], slugEnv: 'NESSY_CDP_WIRE_CLAUDE_SLUG' },
  { id: 'codex', label: 'Codex runtime', providerTypes: ['codex-runtime'], slugEnv: 'NESSY_CDP_WIRE_CODEX_SLUG' },
]

interface StoredConnection {
  slug: string
  providerType?: string
  baseUrl?: string
}

/**
 * Every `mcp__server__tool` token in a blob of runtime-written text.
 *
 * Deliberately a BYTE scan rather than a structured read: the claim under test
 * is about the exact characters, and a parser that normalised anything on the
 * way in would be able to hide the very drift this exists to catch. The
 * structured pass below runs too, and answers the different question of whether
 * the model CALLED the name or was merely offered it.
 */
function mcpNamesIn(text: string): string[] {
  return [...text.matchAll(/mcp__[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+/g)].map(match => match[0])
}

/**
 * Names that appear as a tool CALL rather than anywhere in the file.
 *
 * Both SDKs write a call as an object carrying a `name` beside its arguments —
 * `{type:'tool_use',name,input}` for Anthropic-shaped entries, `{name,arguments}`
 * for function-call-shaped ones. Walking for that pair rather than for a fixed
 * `type` literal keeps the reader working across all three writers without a
 * per-runtime table that would rot the way the two production renames did.
 */
function toolCallNamesIn(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > 14 || value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) toolCallNamesIn(item, out, depth + 1)
    return
  }
  const record = value as Record<string, unknown>
  const name = record.name
  // `toolCall` is the Pi SDK's own part discriminator, measured on a live
  // sidecar 2026-08-15; the rest are the Anthropic/function-call shapes.
  const looksLikeCall = record.type === 'tool_use' || record.type === 'tool_call'
    || record.type === 'toolCall' || record.type === 'function_call'
    || 'input' in record || 'arguments' in record
  if (typeof name === 'string' && name.startsWith('mcp__') && looksLikeCall) out.add(name)
  for (const nested of Object.values(record)) toolCallNamesIn(nested, out, depth + 1)
}

interface WireCapture {
  /** The file(s) the bytes came from — named in the report so a reader can go look. */
  files: string[]
  /** Every `mcp__*__*` token in those files, deduped. */
  names: string[]
  /** The subset that appears as an actual tool call. */
  called: string[]
  /** Why nothing could be captured, when nothing could. */
  reason?: string
}

const empty = (reason: string): WireCapture => ({ files: [], names: [], called: [], reason })

function captureFromFiles(files: string[], entries: RuntimeSessionEntry[]): WireCapture {
  const names = new Set<string>()
  for (const file of files) {
    for (const name of mcpNamesIn(readFileSync(file, 'utf8'))) names.add(name)
  }
  const called = new Set<string>()
  for (const entry of entries) toolCallNamesIn(entry.raw, called)
  return { files, names: [...names].sort(), called: [...called].sort() }
}

/** Pi's own sidecar. */
function capturePi(key: SessionKey): WireCapture {
  const log = readPiSessionLog(key)
  if (!log.file) return empty(log.reason ?? 'no-pi-sidecar')
  if (log.sidecarCount > 1) {
    // A second sidecar means a fork branched this session; averaging two
    // conversations is exactly the ambiguity the lib exists to refuse.
    return empty(`ambiguous-pi-sidecar: ${log.sidecarCount} .jsonl files — this session was forked`)
  }
  return captureFromFiles([log.file], log.entries)
}

/**
 * The Claude Agent SDK's own transcript, narrowed to this session's directory.
 *
 * `readClaudeSessionLog(…, sessionId)` narrows by `entry.endsWith(sessionId)`,
 * and that is not always true: the SDK slugifies the session's working
 * directory and **truncates the result, appending a short hash**, so a deep
 * config path produces `…-05e2ccbe-1797-4d7e-b727-wwr101` for session
 * `05e2ccbe-1797-4d7e-b727-11d5caf0d4ed`. Measured 2026-08-15 running under a
 * scratch config dir; a run under `~/.nessy-agent` stays short enough that the
 * suffix survives, which is exactly the kind of environment-dependent narrowing
 * that reports "this runtime wrote nothing" about a runtime that wrote plenty.
 *
 * So: exact suffix first (the lib), then the longest surviving PREFIX of the
 * session id, and the directory actually used is reported either way. Falling
 * back to "newest across the workspace" is deliberately NOT done — that is the
 * ambiguity `runtime-session-log.ts` documents as having once let a previous
 * run's marker be read as this run's.
 */
function captureClaude(key: SessionKey): WireCapture {
  const log = readClaudeSessionLog(key.workspaceId, configDir(), key.sessionId)
  const exact = log.files ?? (log.file ? [log.file] : [])
  if (exact.length > 0) return captureFromFiles(exact, log.entries)

  const projects = join(configDir(), 'workspaces', key.workspaceId, 'claude-config', 'projects')
  if (!existsSync(projects)) return empty(log.reason ?? 'no-claude-transcript')
  // Longest prefix of the session id that some directory name still carries.
  let matched: string | undefined
  for (let length = key.sessionId.length; length >= 8 && !matched; length -= 1) {
    const prefix = key.sessionId.slice(0, length)
    const hits = readdirSync(projects).filter(name => name.includes(prefix))
    if (hits.length === 1) matched = hits[0]
  }
  if (!matched) {
    return empty(`${log.reason ?? 'no-claude-transcript'} — and no directory under ${projects} carries a unique prefix of ${key.sessionId}`)
  }
  const dir = join(projects, matched)
  const files = readdirSync(dir).filter(name => name.endsWith('.jsonl')).map(name => join(dir, name))
  if (files.length === 0) return empty(`claude-transcript-dir-empty: ${dir} holds no .jsonl`)
  const entries = files.flatMap(file =>
    readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => {
      try { return [{ type: 'unknown', text: '', raw: JSON.parse(line) as Record<string, unknown> }] } catch { return [] }
    }))
  return captureFromFiles(files, entries)
}

/** Every `nessy-codex-home-*` directory that exists right now (F1.652: under the host root, then the OS temp dir). */
function codexHomes(): string[] {
  return listCodexHomes()
    .filter(path => { try { return statSync(path).isDirectory() } catch { return false } })
}

function jsonlUnder(dir: string, out: string[], depth = 0): void {
  if (depth > 6 || !existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    const child = join(dir, name)
    let stat
    try { stat = statSync(child) } catch { continue }
    if (stat.isDirectory()) jsonlUnder(child, out, depth + 1)
    else if (name.endsWith('.jsonl')) out.push(child)
  }
}

interface CodexCapture extends WireCapture {
  /** `[mcp_servers.<key>]` keys read out of the emitted config.toml. */
  configKeys: string[]
  home?: string
}

/**
 * The live `CODEX_HOME`, identified by diffing against the pre-turn snapshot.
 *
 * `before` is the set that existed before the runtime was created, so anything
 * new is this session's. When exactly one is new the answer is unambiguous;
 * when several are (a second Codex session running concurrently), the newest is
 * taken and the count is reported so the reader can distrust it.
 */
function captureCodex(before: Set<string>): CodexCapture {
  const fresh = codexHomes().filter(dir => !before.has(dir))
  if (fresh.length === 0) {
    return {
      ...empty(`no-codex-home: no new nessy-codex-home-* appeared under ${codexHomeRoots().join(' or ')} — the runtime was not created, or it was torn down before the read`),
      configKeys: [],
    }
  }
  const home = fresh.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]!
  const configPath = join(home, 'config.toml')
  const configKeys = existsSync(configPath)
    ? [...readFileSync(configPath, 'utf8').matchAll(/^\[mcp_servers\.([^\]]+)\]$/gm)].map(m => m[1]!)
    : []
  const files = existsSync(configPath) ? [configPath] : []
  const rollouts: string[] = []
  jsonlUnder(home, rollouts)
  files.push(...rollouts)
  if (files.length === 0) return { ...empty(`empty-codex-home: ${home} holds neither config.toml nor a rollout .jsonl`), configKeys, home }
  const names = new Set<string>()
  const called = new Set<string>()
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const name of mcpNamesIn(text)) names.add(name)
    if (!file.endsWith('.jsonl')) continue
    for (const line of text.split('\n').filter(Boolean)) {
      let parsed: unknown
      try { parsed = JSON.parse(line) } catch { continue /* a partial last line is normal on a live file */ }
      toolCallNamesIn(parsed, called)
      for (const joined of codexNamespacedCalls(parsed)) { names.add(joined); called.add(joined) }
    }
  }
  return { files, names: [...names].sort(), called: [...called].sort(), configKeys, home }
}

/**
 * Codex records an MCP call SPLIT, so the joined name appears nowhere in the file.
 *
 * Measured on the rollout of a live 2026-08-15 turn (`codex 0.147`):
 * `{"type":"function_call","name":"config_validate","namespace":"mcp__session",…}`.
 * The wire name the model used is `<namespace>__<name>` — the same join
 * `event-adapter.ts` `mcpRowToolName` performs — but a byte scan for
 * `mcp__x__y` finds only the namespace and concludes the tool was never called.
 * That is the shape of a false negative that would have read as a Codex-side
 * regression, so the join is done here explicitly rather than left to the regex.
 */
function codexNamespacedCalls(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 14 || value === null || typeof value !== 'object') return out
  if (Array.isArray(value)) {
    for (const item of value) codexNamespacedCalls(item, out, depth + 1)
    return out
  }
  const record = value as Record<string, unknown>
  const { name, namespace } = record
  if (typeof name === 'string' && typeof namespace === 'string' && namespace.startsWith('mcp__')) {
    out.push(`${namespace}__${name}`)
  }
  for (const nested of Object.values(record)) codexNamespacedCalls(nested, out, depth + 1)
  return out
}

/**
 * Codex's own MCP approval card — structural, and NOT what F7 is about.
 *
 * Measured 2026-08-15 on the packaged build: a Codex session in `explore` mode
 * emits `approval_policy = "on-request"` into its config.toml, and under that
 * policy the codex binary asks the client to approve every MCP tool call. The
 * card reads *«Allow the session MCP server to run tool "config_validate"?»*
 * and it is raised by `codex-agent.ts`'s approval BRIDGE, not by
 * `pre-tool-use.ts`. **Positive control that the rename did not cause it:** the
 * pre-T2 `nessy-codex-home-*` directories still on this machine carry the very
 * same `approval_policy = "on-request"`, so the identical prompt fired under
 * the old server key. Treating it as a regression would have filed a defect
 * against a policy the permission mode chose.
 */
const CODEX_MCP_APPROVAL = /Allow the .*MCP server to run tool/i
/** The card a `source_activation_needed` classification would put up instead. */
const SOURCE_ACTIVATION_CARD = /not active|activate it by @mentioning|not available yet/i

interface PermissionWatch {
  /** Most cards on screen at once. */
  seen: number
  /** Every distinct non-empty card text observed. */
  texts: string[]
  /** How many structural Codex approvals this watcher answered. */
  answered: number
}

/**
 * Watch for permission cards for as long as the turn runs — and answer the
 * structural one so an unattended run can finish.
 *
 * A card that appeared and was answered leaves nothing behind, so a read taken
 * after the turn cannot see it; a card left unanswered hangs the turn until the
 * timeout. Neither end-state distinguishes "a prompt regressed" from "the
 * runtime always asks", which is why the text of every card is captured here
 * and the assertions are made against the text.
 *
 * The watcher answers ONLY `CODEX_MCP_APPROVAL`, and only ever with Allow for
 * the read-only anchor tool this case itself asked for, in the case's own
 * scratch config dir — the card states the grant applies to one connection and
 * is not remembered. A source-activation card is deliberately left UNANSWERED:
 * it is the failure this is looking for, and clicking it away would launder it.
 */
function watchPermissionCards(session: CdpSession, answerStructural: boolean): { stop: () => Promise<PermissionWatch> } {
  const texts = new Set<string>()
  let seen = 0
  let answered = 0
  let running = true
  const loop = (async () => {
    while (running) {
      const cards = await visibleElements(session, '[data-tutorial="permission-banner"]').catch(() => [])
      if (cards.length > seen) seen = cards.length
      let structural = false
      for (const card of cards) {
        if (!card.text) continue
        texts.add(card.text)
        if (CODEX_MCP_APPROVAL.test(card.text)) structural = true
      }
      if (structural && answerStructural) {
        const clicked = await clickSelector(session, '[data-tutorial="permission-allow-button"]')
          .then(() => true).catch(() => false)
        if (clicked) answered += 1
      }
      await Bun.sleep(1_500)
    }
  })()
  return {
    stop: async () => {
      running = false
      await loop.catch(() => undefined)
      return { seen, texts: [...texts], answered }
    },
  }
}

/**
 * Force the dark theme before anything can screenshot.
 *
 * Local rather than imported from `lib/mcp-fixture.ts`, whose module scope pulls
 * in the MCP-W fixture tree this case has nothing to do with.
 */
async function ensureDarkTheme(session: CdpSession): Promise<'already-dark' | 'forced-dark'> {
  if (await session.call<boolean>(`return document.documentElement.classList.contains('dark')`)) return 'already-dark'
  await session.call<null>(`
    const raw = localStorage.getItem('nessy-theme')
    const stored = raw ? JSON.parse(raw) : {}
    localStorage.setItem('nessy-theme', JSON.stringify({ ...stored, mode: 'dark', isUserOverride: true }))
    return null
  `)
  await session.send('Page.reload', {})
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await Bun.sleep(500)
    if (await session.call<boolean>(`return document.documentElement.classList.contains('dark')`).catch(() => false)) {
      return 'forced-dark'
    }
  }
  throw new Error('theme-not-dark: the app did not apply the dark class after the preference write and a reload')
}

/**
 * One transcript tool row, with the display metadata `state.ts` does not carry.
 *
 * `toolDisplayMeta.category` is `resolveToolDisplayMeta`'s own verdict —
 * `'native'` when the name resolved through the internal session-tool table,
 * something else when it was taken for a connected source's tool. That is F7's
 * question asked directly rather than inferred, so it is worth the extra read.
 * It is not populated on every path (the Pi backend fills `toolDisplayName` from
 * its own intent instead), so the case reports which evidence it had.
 */
interface ToolRow {
  toolName?: string
  toolDisplayName?: string
  toolStatus?: string
  resultChars: number
  metaDisplayName?: string
  metaCategory?: string
}

async function toolRows(session: CdpSession, key: SessionKey): Promise<ToolRow[]> {
  return session.call<ToolRow[]>(`
    const s = await window.electronAPI.getSessionMessages(${JSON.stringify(key.sessionId)})
    return (s?.messages ?? []).filter(m => m.role === 'tool').map(m => ({
      toolName: m.toolName,
      toolDisplayName: m.toolDisplayName,
      toolStatus: m.toolStatus,
      resultChars: typeof m.toolResult === 'string' ? m.toolResult.length : 0,
      metaDisplayName: m.toolDisplayMeta ? m.toolDisplayMeta.displayName : undefined,
      metaCategory: m.toolDisplayMeta ? m.toolDisplayMeta.category : undefined,
    }))
  `)
}

/**
 * Rows for the anchor tool — BARE or PREFIXED, because the two are both correct.
 *
 * Measured 2026-08-15 on packaged 1.26.0: the Pi backend records the bare
 * `config_validate` (the host has already stripped the segment by the time the
 * row is written — `tool-parsers.ts:433` is the renderer's half of the same
 * rule), while the Codex path records the wire name whole. A filter written for
 * one shape reports "no tool row" about the other, which is exactly how a
 * healthy runtime gets recorded as a failure.
 */
function anchorRows(rows: ToolRow[]): ToolRow[] {
  return rows.filter(r => typeof r.toolName === 'string' && (r.toolName === ANCHOR || r.toolName.endsWith(`__${ANCHOR}`)))
}

/**
 * The name a reader sees — the row's own tool id, with any of OUR server
 * segments removed. Mirrors `normalizeToolCommandName`'s prefix list rather
 * than importing it: the renderer package is not on this harness's path, and a
 * check that imported the function under test would pass whatever it did.
 */
const OWN_PREFIXES = ['mcp__session__', 'mcp__nessy_session__', 'mcp__workspace__']
function cleanId(toolName: string): string {
  const prefix = OWN_PREFIXES.find(candidate => toolName.startsWith(candidate))
  return prefix ? toolName.slice(prefix.length) : toolName
}

/** The activation-denial texts `pi-agent.ts` emits for `source_activation_needed`. */
const ACTIVATION_DENIALS = [/is not active\./i, /is not available yet\./i, /Activate it by @mentioning/i]

interface ArmResult {
  runtime: RuntimeTarget
  connection: string
  key: SessionKey
  wireNames: string[]
  recorded?: string
  capture: WireCapture
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  run.observe('anchor tool', { tool: ANCHOR, expected: EXPECTED_WIRE })

  // Dark theme, per the standing rule for anything that may screenshot.
  run.observe('theme', await ensureDarkTheme(session))

  const connections = await session.call<StoredConnection[]>(`
    const res = await window.electronAPI.listLlmConnections()
    return (res?.connections ?? res ?? []).map(c => ({
      slug: c.slug, providerType: c.providerType, baseUrl: c.baseUrl ?? undefined,
    }))
  `)
  run.observe('connections', connections.map(c => `${c.slug}=${c.providerType}`))

  const requested = (process.env.NESSY_CDP_WIRE_RUNTIMES ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const targets = requested.length > 0
    ? ALL_RUNTIMES.filter(r => requested.includes(r.id))
    : ALL_RUNTIMES
  const narrowed = requested.length > 0 ? ALL_RUNTIMES.filter(r => !requested.includes(r.id)).map(r => r.id) : []

  const results: ArmResult[] = []
  const unmeasured: string[] = []

  for (const runtime of targets) {
    const pinned = process.env[runtime.slugEnv]?.trim()
    const connection = connections.find(c =>
      runtime.providerTypes.includes(c.providerType ?? '') && (!pinned || c.slug === pinned))
    if (!connection) {
      unmeasured.push(`${runtime.id}: no ${runtime.providerTypes.join('/')} connection${pinned ? ` matching ${pinned}` : ''}`)
      continue
    }

    const key = await freshSession(session, `CDP ${ID} ${runtime.id} ${new Date().toISOString().slice(11, 19)}`)
    if (!key.fresh) {
      // A contaminated session would read another conversation's tool rows and
      // report them as this arm's. Never silently.
      run.check(`${runtime.label}: the arm ran in a session it created`, false, key.reason ?? 'unknown')
      unmeasured.push(`${runtime.id}: could not get a fresh session — ${key.reason ?? 'unknown'}`)
      continue
    }
    run.observe(`${runtime.id} session`, { ...key, connection: connection.slug })

    await sessionCommand(session, key.sessionId, { type: 'setConnection', connectionSlug: connection.slug })
    const active = await waitFor(
      () => session.call<string | undefined>(`
        const s = (await window.electronAPI.getSessions() ?? []).find(x => x.id === ${JSON.stringify(key.sessionId)})
        return s ? (s.llmConnection ?? undefined) : undefined
      `),
      value => value === connection.slug,
      { timeoutMs: 30_000, intervalMs: 1_000, label: `session to switch to ${connection.slug}` },
    ).catch(() => undefined)
    if (active !== connection.slug) {
      unmeasured.push(`${runtime.id}: the session would not switch to ${connection.slug} (stayed ${active ?? 'unknown'})`)
      continue
    }

    // The permission mode is left exactly as the app created it. Setting
    // `bypassPermissions` here would make F7's "no permission prompt regressed"
    // assertion vacuous — it would be measuring the lever, not the product.
    const mode = (await listSessions(session)).find(s => s.id === key.sessionId)?.permissionMode
    run.observe(`${runtime.id} permission mode`, mode ?? 'unknown')

    const homesBefore = runtime.id === 'codex' ? new Set(codexHomes()) : new Set<string>()
    const watcher = watchPermissionCards(session, runtime.id === 'codex')

    let turnError: string | undefined
    let messages: TranscriptMessage[] = []
    try {
      messages = (await sendPrompt(session, key, PROMPT, TURN_TIMEOUT_MS)).messages
    } catch (cause) {
      turnError = cause instanceof Error ? cause.message : String(cause)
      messages = await transcript(session, key).catch(() => [])
    }
    const cards = await watcher.stop()
    if (cards.texts.length > 0) run.observe(`${runtime.id} permission cards`, cards)

    // Read the runtime's own file BEFORE anything can tear it down. For Codex
    // that is the whole ballgame: the CODEX_HOME is removed on dispose.
    const capture: WireCapture = runtime.id === 'pi'
      ? capturePi(key)
      : runtime.id === 'claude'
        ? captureClaude(key)
        : captureCodex(homesBefore)
    const codex = runtime.id === 'codex' ? capture as CodexCapture : undefined

    run.observe(`${runtime.id} capture`, {
      files: capture.files.map(f => f.replace(configDir(), '<config>')),
      ...(codex ? { home: codex.home, configKeys: codex.configKeys } : {}),
      sessionToolNames: capture.names.filter(n => n.includes('session')).slice(0, 12),
      called: capture.called,
      ...(capture.reason ? { reason: capture.reason } : {}),
      ...(turnError ? { turnError } : {}),
    })

    const rows = anchorRows(await toolRows(session, key))
    const row = rows[0]
    const recorded = row?.toolName
    run.observe(`${runtime.id} transcript row`, rows)

    // --- the arm's own assertions ----------------------------------------
    const runtimeNames = capture.names.filter(n => n.endsWith(`__${ANCHOR}`))
    const measured = runtimeNames.length > 0 || recorded !== undefined

    if (!measured) {
      unmeasured.push(
        `${runtime.id}: the anchor never appeared — no ${EXPECTED_WIRE} in the runtime's own file and no transcript row`
        + `${capture.reason ? ` (${capture.reason})` : ''}${turnError ? ` (turn: ${turnError})` : ''}`,
      )
      continue
    }

    // (1) THE CLAIM: the bytes the runtime itself wrote down.
    if (runtimeNames.length > 0) {
      run.check(
        `${runtime.label}: the runtime's OWN file spells the anchor ${EXPECTED_WIRE}`,
        runtimeNames.every(n => n === EXPECTED_WIRE),
        `${[...new Set(runtimeNames)].join(', ')} — ${capture.files.length} file(s)`,
      )
      run.check(
        `${runtime.label}: the model CALLED it under that name (not merely offered it)`,
        capture.called.includes(EXPECTED_WIRE),
        capture.called.join(', ') || 'no call entry found in the runtime file',
      )
    }
    // (2) no capture, on any runtime, may still carry the pre-unification segment.
    run.check(
      `${runtime.label}: no ${LEGACY_SEGMENT} anywhere in the capture`,
      !capture.names.some(n => n.includes(LEGACY_SEGMENT)) && recorded?.includes(LEGACY_SEGMENT) !== true,
      capture.names.filter(n => n.includes(LEGACY_SEGMENT)).join(', ') || 'none',
    )
    // (3) THE RENDERING: whatever the row stores, a reader sees the tool's own
    // id. Pi stores it bare and Codex stores it whole, and both must read the
    // same — that identity is the point, not the storage shape.
    if (recorded !== undefined) {
      run.check(
        `${runtime.label}: the row reads as the clean id "${ANCHOR}"`,
        cleanId(recorded) === ANCHOR,
        `${recorded} → ${cleanId(recorded)}`,
      )
    }

    if (codex) {
      // T2's own artifact: the config key IS the prefix the binary joins.
      run.check(
        'Codex: the emitted config.toml mounts the session server as [mcp_servers.session]',
        codex.configKeys.includes('session') && !codex.configKeys.includes(LEGACY_SEGMENT),
        codex.configKeys.join(', ') || 'no config.toml read',
      )

      // --- F7 -----------------------------------------------------------
      // `resolveToolDisplayMeta`'s own verdict when the path populates it —
      // `'native'` is reached ONLY through the `internalMcpServers` table T2
      // made Codex rows match. When the meta is absent (some backends fill
      // `toolDisplayName` from their own intent instead and leave it unset,
      // measured on Pi), the label is the fallback evidence and the check says
      // which one answered rather than quietly weakening.
      const category = row?.metaCategory
      run.check(
        'F7 Codex: the row classifies as a BUILT-IN session tool, not an unknown source',
        category !== undefined
          ? category === 'native'
          : typeof row?.toolDisplayName === 'string'
            && row.toolDisplayName.length > 0
            && !row.toolDisplayName.startsWith('mcp__')
            && row.toolDisplayName !== ANCHOR,
        category !== undefined
          ? `toolDisplayMeta.category=${category} (native ⇒ internalMcpServers matched)`
          : `no toolDisplayMeta; fell back to the label: ${JSON.stringify(row?.toolDisplayName)} `
            + `(the internal table's own is "${ANCHOR_DISPLAY_NAME}")`,
      )
      run.check(
        'F7 Codex: the call RAN — it was not held behind source activation',
        (row?.resultChars ?? 0) > 0 && row?.toolStatus !== 'error',
        `status=${row?.toolStatus ?? 'none'} result=${row?.resultChars ?? 0} chars`,
      )
      const denials = messages.filter(m => ACTIVATION_DENIALS.some(re => re.test(m.content)))
      run.check(
        'F7 Codex: no source-activation denial in the transcript',
        denials.length === 0,
        denials.map(m => m.content.slice(0, 120)).join(' | ') || 'none',
      )
      // The permission half of F7, asked of the card's TEXT rather than of its
      // existence — because `approval_policy = "on-request"` means a card is
      // the NORMAL outcome here and always was (see CODEX_MCP_APPROVAL).
      const activationCards = cards.texts.filter(text => SOURCE_ACTIVATION_CARD.test(text))
      run.check(
        'F7 Codex: no SOURCE-ACTIVATION prompt appeared — the built-in was never taken for a source',
        activationCards.length === 0,
        activationCards.join(' | ') || `none; ${cards.texts.length} card(s) seen, all structural`,
      )
      const foreign = cards.texts.filter(text => !CODEX_MCP_APPROVAL.test(text))
      run.check(
        "F7 Codex: every card was the runtime's own MCP approval, naming the unified server",
        foreign.length === 0 && cards.texts.every(text => !text.includes(LEGACY_SEGMENT)),
        cards.texts.map(text => text.slice(0, 140)).join(' | ') || 'no card at all',
      )
      run.observe('F7 Codex: structural approvals answered by the case', cards.answered)
    }

    results.push({
      runtime,
      connection: connection.slug,
      key,
      wireNames: [...new Set(runtimeNames)],
      recorded,
      capture,
    })
  }

  // --- the cross-runtime claim ------------------------------------------
  run.observe('per-arm wire names', results.map(r => ({
    runtime: r.runtime.id,
    connection: r.connection,
    runtimeFile: r.wireNames,
    transcriptRow: r.recorded,
    rowReadsAs: r.recorded ? cleanId(r.recorded) : undefined,
  })))

  // The WIRE claim is about the runtimes' own files and the Codex config key;
  // the row is not folded in, because Pi stores it bare by design and mixing
  // the two would turn a correct arm into a second spelling.
  const wireNames = new Set(results.flatMap(r => r.wireNames))
  if (results.length >= 2) {
    run.check(
      `all ${results.length} measured runtimes put the SAME bytes on the wire`,
      wireNames.size === 1 && wireNames.has(EXPECTED_WIRE),
      [...wireNames].join(', ') || 'no runtime-side capture on any arm',
    )
    const readsAs = new Set(results.filter(r => r.recorded).map(r => cleanId(r.recorded!)))
    run.check(
      `all ${results.length} measured runtimes render the same clean id`,
      readsAs.size === 1 && readsAs.has(ANCHOR),
      [...readsAs].join(', ') || 'no transcript row on any arm',
    )
  }

  if (unmeasured.length > 0 || narrowed.length > 0) {
    blocked(
      `${results.length} of ${ALL_RUNTIMES.length} runtimes measured. `
      + `${unmeasured.length > 0 ? `NOT measured — ${unmeasured.join('; ')}. ` : ''}`
      + `${narrowed.length > 0 ? `Narrowed out by NESSY_CDP_WIRE_RUNTIMES: ${narrowed.join(', ')}. ` : ''}`
      + 'A partial matrix is not the gate: the claim is byte-identity ACROSS runtimes.',
    )
  }
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
