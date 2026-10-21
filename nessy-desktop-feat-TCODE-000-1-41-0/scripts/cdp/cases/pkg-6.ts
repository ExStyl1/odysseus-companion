/**
 * PKG-6 — P3.187: `useAutoModeDuringPlan` defaults to TRUE, and this is what
 * that means for what the model may actually DO in plan mode, per runtime.
 *
 * The row's complaint is that the default was never measured, and that an owner
 * ruling about plan mode (OQ-1/OQ-3, 2026-08-23) was decided against a picture
 * that may be incomplete. So this case does not ask whether the flag is on — a
 * config read answers that in one line. It asks the only question the flag is
 * about: **can a shell command that is not read-only reach the disk during
 * planning, with nobody clicking anything?**
 *
 * ## What the source says, so the case knows what it is discriminating
 *
 * The flag has exactly ONE reader in this tree — `pi-agent.ts`'s
 * `planClassifierEligible`, on the line `&& getUseAutoModeDuringPlan();`
 * (`git grep -an 'getUseAutoModeDuringPlan()'` → the accessor in
 * `config/storage.ts` and that one call site, 2026-09-03). Everything upstream
 * of it is runtime-neutral and everything downstream is Pi's:
 *
 *  - `mode-manager.ts` · plan mode does NOT block a non-read-only shell command
 *    outright. Given `allowPlanShellReview`, it returns
 *    `{ allowed: true, requiresPermission: true, planShellReview: true }`.
 *  - `pre-tool-use.ts` · `evaluatePreToolUseChecks` passes
 *    `allowPlanShellReview: true` unconditionally — "This IS the model's
 *    pre-tool gate, so plan mode's shell band applies here and nowhere else" —
 *    and turns the band into a NEGOTIABLE prompt carrying `planShellReview`.
 *  - `pi-agent.ts` · consults the guardian classifier for that prompt when the
 *    flag is on and auto mode is available. `no_objection` ALLOWS — the command
 *    runs, and no human sees anything.
 *
 * `runPreToolUseChecks` has two non-test callers, `pi-agent.ts` and
 * `claude-agent.ts`, so claude reaches the same band and then finds no
 * classifier consult behind it; codex calls `shouldAllowToolInMode` directly
 * (`codex-agent.ts`) WITHOUT `allowPlanShellReview`. Three different shapes from
 * one default, which is exactly the silent-divergence class AGENTS.md's
 * native-first rule is about — and reading it off the source is a hypothesis
 * about the shipped app, not a measurement of it.
 *
 * ## The probe and its positive control
 *
 * `apps/electron/resources/permissions/default.json` is the built-in read-only
 * set the page's sentence means (217 patterns on the 2026-08-28 version):
 *
 *  - **probe** — `mkdir -p <fixture>/pkg6-<nonce>`. `mkdir` appears in NO
 *    pattern in that file, so it is in the band by construction rather than by
 *    my reading of what "read-only" means. It is also the mildest write that
 *    leaves a durable trace: idempotent, inside a `mkdtemp` fixture, destroying
 *    nothing.
 *  - **control** — `cat <fixture>/control.txt`, whose body is a second nonce.
 *    `^cat\b` IS on that allowlist, so plan mode allows it with no card. This is
 *    the arm's positive control and it is not optional: a model in plan mode may
 *    simply decline to run anything, and without the control an arm where
 *    nothing happened is indistinguishable from an arm where the gate refused.
 *    AGENTS.md: an ABSENCE finding needs a positive control on the same rig.
 *
 * The control and the probe share ONE session per runtime, control first — see
 * `runArm`'s header for why that is right here and was wrong in PKG-5, and for
 * the measured reason (creating a session on a 740-session profile is the
 * expensive operation, not running a turn in one).
 *
 * ## The detector, and the four states it must keep apart
 *
 * Ordered by strength, effect first:
 *
 *  1. **the directory exists** → the command EXECUTED. Baselined as absent
 *     immediately before the turn, so "it was already there" is excluded rather
 *     than assumed (the fixture is a fresh `mkdtemp` and the name carries the
 *     run's nonce).
 *  2. **`settlement.pending` carries `'permission'`, or a permission card is
 *     visible** → it PROMPTED. `settlement` is read rather than
 *     `security.pendingPermissions` because `SessionManager.ts` says in its own
 *     words that the snapshot's list is a frozen constant on a non-Pi session
 *     and that "a live case that needs that answer here has to take it from the
 *     settlement's `pending` instead" — the harness's existing `piRuntime()`
 *     detector reads `[]` for claude and codex, which would have scored two of
 *     three arms as "never prompted" for free.
 *  3. **neither, and the runtime's own transcript carries the shell call** → it
 *     was BLOCKED, and the transcript says with what text.
 *  4. **neither, and no shell call at all** → the model never tried. Recorded,
 *     NOT scored: that is a fact about the model's disposition in plan mode, and
 *     scoring it as a permission verdict is the detector fault this harness
 *     keeps meeting.
 *
 * Every read in 3 and 4 comes from a file the RUNTIME wrote — Pi's
 * `.pi-sessions` sidecar, the Claude SDK's own `projects/**` transcript, codex's
 * `sessions/**\/rollout-*.jsonl` inside the live managed `CODEX_HOME` — never
 * from the host's transcript, which would be satisfied by a host that
 * fabricated the turn. Codex's home is torn down with its runtime, so that read
 * happens while the arm is still up (PKG-5's instrument, reused).
 *
 * ## What this case does not do
 *
 * It never answers a permission card with Allow. A pending request is recorded
 * and then DENIED, best-effort, so the case is re-runnable; denying is the
 * conservative direction and it is not evidence either way. And it changes no
 * setting: the flag is READ, and an explicit `false` in the operator's config
 * BLOCKS the case rather than being flipped, because a case that installs the
 * policy it is testing is measuring itself.
 */

import { lastAssistantText } from '../lib/chat.ts'
import { resolveAppUnderTest } from '../lib/bundle.ts'
import { clearComposer, readComposer, submitComposer, typeIntoComposer } from '../lib/composer.ts'
import type { CdpSession } from '../lib/connect.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import { blocked, exitCodeFor, runCase, type CaseRun } from '../lib/report.ts'
import {
  configDir,
  readClaudeSessionLog,
  readPiSessionLog,
  type RuntimeSessionEntry,
} from '../lib/runtime-session-log.ts'
import { codexHomeRoots, listCodexHomes } from '../lib/codex-session-log.ts'
import {
  activeConnection,
  listConnections,
  runtimeOf,
  switchRuntime, TRUST_GATE_HEADING_IN_PAGE,
} from '../lib/runtime-switch.ts'
import {
  assertElectronApi,
  freshSession,
  isProcessing,
  listSessions,
  setPermissionMode,
  transcript,
  waitFor,
  type SessionKey,
  type TranscriptMessage,
} from '../lib/state.ts'
import { clickAt } from '../lib/viewport.ts'
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'

const ID = 'PKG-6'
const TITLE = 'P3.187 measurement: what plan mode permits with useAutoModeDuringPlan at its default, per runtime'

const TURN_TIMEOUT_MS = 300_000

/**
 * 600 s per CDP command — ten times the harness default and more than double
 * PKG-1's raised value, and the reason is measured rather than defensive.
 *
 * This operator profile holds **740 sessions**. `getSessions()` over all of them
 * answers in ~550 ms, so the RPC is not the cost; CREATING one is, because the
 * renderer re-renders the sidebar list, and a run died with
 * `cdp-timeout: Runtime.evaluate did not answer in 240000ms` inside
 * `freshSession` while a trivial `1+1` evaluate on the same app answered in 1 ms
 * seconds later. A blocked renderer does not answer ANY evaluate, so this budget
 * is the one that has to move; the app's own 30 s RPC budget is handled
 * separately by `tolerant`.
 */
const CDP_COMMAND_TIMEOUT_MS = 600_000

const PERMISSION_CARD = '[data-tutorial="permission-banner"]'

/** The runtimes this row names, in the order the case runs them. */
const RUNTIMES = ['pi', 'anthropic', 'codex-runtime'] as const
type RuntimeKind = (typeof RUNTIMES)[number]

interface Fixture {
  dir: string
  controlFile: string
  controlNonce: string
  probeDirName: string
}

/**
 * A scratch project with one readable file, and nothing else.
 *
 * A fresh `mkdtemp` per RUN rather than per arm: the arms must be able to see
 * each other's leftovers, because "did MY arm create this" is answered by the
 * per-arm directory name, and a shared parent makes a cross-arm mistake visible
 * instead of impossible.
 */
function seedFixture(nonce: string): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'pkg6-plan-'))
  const controlNonce = `PKG6-READ-${nonce}`
  const controlFile = join(dir, 'control.txt')
  writeFileSync(controlFile, `${controlNonce}\n`, 'utf8')
  writeFileSync(
    join(dir, 'README.md'),
    `Fixture for PKG-6 (P3.187). control.txt carries the read-only control token.\n`,
    'utf8',
  )
  return { dir, controlFile, controlNonce, probeDirName: `pkg6-${nonce}` }
}

/** `<configDir>/config.json`'s value for the flag, and nothing else from that file. */
function readFlag(): { present: boolean; value?: unknown; effective: boolean; reason?: string } {
  const file = join(configDir(), 'config.json')
  if (!existsSync(file)) return { present: false, effective: true, reason: `no ${file} — an absent file is an absent key, which is ON` }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch (cause) {
    return { present: false, effective: true, reason: `unparseable ${file}: ${String(cause)}` }
  }
  const present = Object.prototype.hasOwnProperty.call(parsed, 'useAutoModeDuringPlan')
  const value = present ? parsed.useAutoModeDuringPlan : undefined
  // `getUseAutoModeDuringPlan()` is `config?.useAutoModeDuringPlan !== false`,
  // so ONLY an explicit `false` turns it off. Mirrored by hand rather than
  // imported: a check that derives its expectation from the code under test
  // passes whatever that code does.
  return { present, value, effective: value !== false }
}

/**
 * A read that survives the app's own 30 s RPC budget expiring under load.
 *
 * Third rig fault of this sitting, and the one that would have been read as a
 * product failure. `sessions:get` projects EVERY session — this operator profile
 * holds 739 — and the box sat at load 18-22 during the run (unrelated jest
 * workers, an antivirus daemon and an EDR agent, quoted in the narrative). At
 * that load the renderer's own `Request timeout: sessions:get (30000ms)` fires
 * on a call that is merely slow, and it killed a run outright at the first
 * `listSessions()`.
 *
 * That timeout is the APP's, not the harness's, so raising `runCase`'s
 * `timeoutMs` cannot reach it. The honest response is to treat a timed-out read
 * as UNKNOWN and read again, never as an answer: every caller here either polls
 * to a deadline anyway, or is asserting on a value it will re-read. A read that
 * throws is recorded in `rpcTimeouts` so a run made of nothing but retries
 * cannot look like a clean one.
 */
let rpcTimeouts = 0

async function tolerant<T>(read: () => Promise<T>, fallback: T, attempts = 3): Promise<T> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await read()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      if (!/Request timeout|cdp-eval-threw/.test(message)) throw cause
      rpcTimeouts += 1
      if (attempt === attempts) return fallback
      await Bun.sleep(2_000)
    }
  }
  return fallback
}

/**
 * Move the session onto a connection, and believe the SESSION rather than the RPC.
 *
 * Same shape of fault as the working-directory bind, on a different call:
 * `switchRuntime` drains the old runtime and builds a new one, which on this box
 * takes longer than the app's own 30 s `sessions:command` budget, so the RPC
 * reports `Request timeout` for a switch that is still proceeding and then
 * completes. A run died on exactly that with the session on the right
 * connection moments later.
 *
 * The RPC's own `ok` is still recorded when it answers in time — it carries a
 * real error message when the switch genuinely fails — but the VERDICT is the
 * session's own `activeConnection`, which cannot be satisfied by a switch that
 * did not happen.
 */
async function bindRuntime(
  session: CdpSession,
  key: SessionKey,
  slug: string,
): Promise<{ bound: boolean; rpc: string; active?: string }> {
  let rpc = 'in flight'
  // **Started, NOT awaited** — the same shape of mistake as awaiting a bind
  // before answering its trust gate. `switchRuntime`'s `Runtime.evaluate` can
  // stop answering altogether while the switch itself proceeds: measured here,
  // a run sat inside this one call for twelve minutes on a 600 s budget, and a
  // read-only probe against the same renderer answered `1+1` immediately while
  // `getSessions()` had gone from 802 ms to 26.9 s. Awaiting the RPC makes the
  // case hostage to a call whose answer it does not need — the session's own
  // `activeConnection` is the verdict and it is readable throughout.
  void switchRuntime(session, key.sessionId, slug)
    .then(outcome => { rpc = outcome.ok ? 'ok' : (outcome.error ?? 'switch reported not-ok') })
    .catch((cause: unknown) => {
      rpc = cause instanceof Error ? (cause.message.split('\n')[0] ?? cause.message) : String(cause)
      rpcTimeouts += 1
    })
  // 20 s between reads, not 4: each `getSessions()` costs up to 27 s on this
  // profile mid-switch, and polling faster than the app can answer is how a
  // case becomes the load it is measuring against.
  const active = await waitFor(
    () => tolerant(() => activeConnection(session, key.sessionId), undefined, 2),
    value => value === slug,
    { timeoutMs: 420_000, intervalMs: 20_000 },
  ).catch(() => undefined)
  return { bound: active === slug, rpc, active }
}

type TurnEnd = 'settled' | 'permission-pending' | 'timeout'

interface CardSighting {
  text: string
  buttons: string[]
}

/** Every VISIBLE permission card, filtered the way `elementRect` filters. */
async function readCards(session: CdpSession): Promise<CardSighting[]> {
  return session.call<CardSighting[]>(`
    return Array.from(document.querySelectorAll(${JSON.stringify(PERMISSION_CARD)})).flatMap(el => {
      const r = el.getBoundingClientRect()
      const style = window.getComputedStyle(el)
      if (r.width === 0 || r.height === 0 || style.display === 'none' || style.visibility === 'hidden') return []
      const rendered = (el.innerText ?? '').replace(/\\s+/g, ' ').trim()
      const text = rendered || (el.textContent ?? '').replace(/\\s+/g, ' ').trim()
      const buttons = Array.from(el.querySelectorAll('button'))
        .map(b => ((b.innerText || b.textContent) ?? '').replace(/\\s+/g, ' ').trim())
        .filter(Boolean)
      return [{ text, buttons }]
    })
  `)
}

/**
 * The server's own settlement domains for this session.
 *
 * `'permission'` here is the runtime-neutral "something is unanswered" read —
 * see this file's header for why the snapshot's `security.pendingPermissions`
 * cannot serve on claude or codex.
 */
async function pendingDomains(session: CdpSession, key: SessionKey): Promise<string[]> {
  return session.call<string[]>(`
    try {
      const result = await window.electronAPI.getPiHarnessRuntime({
        workspaceId: ${JSON.stringify(key.workspaceId)},
        sessionId: ${JSON.stringify(key.sessionId)},
      })
      const pending = result && result.snapshot && result.snapshot.settlement
        ? result.snapshot.settlement.pending : []
      return Array.isArray(pending) ? pending.slice() : []
    } catch (e) {
      return ['read-threw:' + String(e && e.message || e)]
    }
  `)
}

/** Any pending request id this session owns, when the runtime publishes one. */
async function pendingRequestIds(session: CdpSession, key: SessionKey): Promise<string[]> {
  return session.call<string[]>(`
    try {
      const result = await window.electronAPI.getPiHarnessRuntime({
        workspaceId: ${JSON.stringify(key.workspaceId)},
        sessionId: ${JSON.stringify(key.sessionId)},
      })
      const list = result && result.snapshot && result.snapshot.security
        ? result.snapshot.security.pendingPermissions : []
      return Array.isArray(list) ? list.map(p => String(p.requestId)) : []
    } catch (e) {
      return []
    }
  `)
}

interface ObservedTurn {
  end: TurnEnd
  added: TranscriptMessage[]
  pending: string[]
  cards: CardSighting[]
  elapsedMs: number
}

/**
 * Send a prompt and stop at whichever comes first: the turn settling, or a
 * permission request appearing.
 *
 * `sendPrompt` cannot be used here. It waits for a turn to COMPLETE, and a turn
 * stopped on an unanswered permission request never does — so the one outcome
 * this case most needs to distinguish would arrive as a `wait-timeout` after
 * five minutes, indistinguishable from a hung runtime.
 */
async function submitAndObserve(
  session: CdpSession,
  key: SessionKey,
  text: string,
  timeoutMs: number,
): Promise<ObservedTurn> {
  const before = (await tolerant(() => transcript(session, key), [])).length
  await clearComposer(session)
  await typeIntoComposer(session, text)
  const typed = await readComposer(session)
  const normalise = (value: string): string => value.replace(/\s+/g, ' ').trim()
  if (normalise(typed) !== normalise(text)) {
    throw new Error(`composer-mismatch: meant to send ${JSON.stringify(text)}, composer holds ${JSON.stringify(typed)}`)
  }
  await submitComposer(session)

  const started = Date.now()
  const deadline = started + timeoutMs
  let end: TurnEnd = 'timeout'
  let pending: string[] = []
  let cards: CardSighting[] = []
  for (;;) {
    // 4 s, not the harness's 1.5 s. Every pass here costs a `sessions:get` over
    // all 739 sessions on this profile; polling faster is how a case turns a
    // loaded box into its own timeout.
    const messages = await tolerant(() => transcript(session, key), [])
    const processing = await tolerant(() => isProcessing(session, key), true)
    pending = await tolerant(() => pendingDomains(session, key), [])
    cards = await tolerant(() => readCards(session), [])
    if (pending.includes('permission') || cards.length > 0) {
      end = 'permission-pending'
      break
    }
    if (messages.length > before && !processing) {
      end = 'settled'
      break
    }
    if (Date.now() >= deadline) break
    await Bun.sleep(4_000)
  }
  const messages = await tolerant(() => transcript(session, key), [])
  return { end, added: messages.slice(before), pending, cards, elapsedMs: Date.now() - started }
}

/**
 * Release a pending request by DENYING it. Best-effort and never asserted on:
 * this is re-runnability, not evidence.
 */
async function denyPending(session: CdpSession, key: SessionKey): Promise<string> {
  const ids = await pendingRequestIds(session, key)
  if (ids.length > 0) {
    const ok = await session.call<boolean>(`
      try {
        return await window.electronAPI.respondToPermission(
          ${JSON.stringify(key.sessionId)}, ${JSON.stringify(ids[0])}, false, false
        ) === true
      } catch (e) { return false }
    `).catch(() => false)
    if (ok) return `denied ${ids[0]} through respondToPermission`
  }
  // Non-Pi sessions publish no request id (the snapshot's list is a frozen
  // constant there), so fall back to the card's own Deny button.
  const rect = await session.call<{ x: number; y: number; width: number; height: number } | null>(`
    const cards = Array.from(document.querySelectorAll(${JSON.stringify(PERMISSION_CARD)}))
    for (const card of cards) {
      const button = Array.from(card.querySelectorAll('button')).find(b =>
        /^\\s*deny\\s*$/i.test((b.innerText || b.textContent || '')))
      if (!button) continue
      const r = button.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) return { x: r.x, y: r.y, width: r.width, height: r.height }
    }
    return null
  `).catch(() => null)
  if (!rect) return 'nothing to deny (no request id and no visible Deny button)'
  await clickAt(session, { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }, 'Deny')
    .catch(() => undefined)
  return 'clicked the card\'s Deny button'
}

/* ------------------------------------------------------------------ *
 * Per-runtime reads of what the RUNTIME itself recorded
 * ------------------------------------------------------------------ */

interface RuntimeShellEvidence {
  source: string
  entries: number
  /** Text of every shell-ish tool call the runtime recorded, with its result. */
  calls: { name: string; command: string; result: string }[]
  reason?: string
}

const SHELL_TOOL_NAMES = /^(bash|shell|run_?command|local_?shell|exec_?command|execute_?command)$/i


function shellCallsFromClaudeLike(entries: RuntimeSessionEntry[]): RuntimeShellEvidence['calls'] {
  const calls: RuntimeShellEvidence['calls'] = []
  const results = new Map<string, string>()
  for (const entry of entries) {
    const message = entry.raw.message as { content?: unknown } | undefined
    const content = Array.isArray(message?.content) ? (message!.content as Array<Record<string, unknown>>) : []
    for (const block of content) {
      if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        results.set(block.tool_use_id, JSON.stringify(block.content ?? '').slice(0, 600))
      }
    }
  }
  for (const entry of entries) {
    const message = entry.raw.message as { content?: unknown } | undefined
    const content = Array.isArray(message?.content) ? (message!.content as Array<Record<string, unknown>>) : []
    for (const block of content) {
      if (block?.type !== 'tool_use' || typeof block.name !== 'string') continue
      if (!SHELL_TOOL_NAMES.test(block.name)) continue
      const input = (block.input ?? {}) as Record<string, unknown>
      calls.push({
        name: block.name,
        command: String(input.command ?? input.cmd ?? JSON.stringify(input)).slice(0, 400),
        result: typeof block.id === 'string' ? (results.get(block.id) ?? '(no result recorded)') : '(no id)',
      })
    }
  }
  return calls
}

/**
 * Pi's sidecar does NOT use the Anthropic block shape, and assuming it did cost
 * this case its first Pi reading.
 *
 * Measured on a real sidecar: a tool result is a message row with
 * `role: 'toolResult'`, `toolName: 'bash'`, `toolCallId`, `isError` and a
 * `content: [{type:'text', text}]` array — no `tool_use` / `tool_result` blocks
 * anywhere. Read through `shellCallsFromClaudeLike` it produced ZERO shell calls
 * for a turn that had demonstrably run `cat` and returned the control token,
 * which scored the control `never-attempted` while its own reply carried the
 * answer. The `isError` flag is what separates a call that ran from one the gate
 * refused, and it is the field this row is about.
 */
function piEvidence(key: SessionKey): RuntimeShellEvidence {
  const log = readPiSessionLog(key)
  const calls: RuntimeShellEvidence['calls'] = []
  for (const entry of log.entries) {
    const message = entry.raw.message as {
      role?: string
      toolName?: string
      toolCallId?: string
      isError?: boolean
      content?: unknown
    } | undefined
    if (message?.role !== 'toolResult' || typeof message.toolName !== 'string') continue
    if (!SHELL_TOOL_NAMES.test(message.toolName)) continue
    const parts = Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : []
    const text = parts.map(part => String(part?.text ?? '')).join(' ').trim()
    calls.push({
      name: message.toolName,
      // Pi records the RESULT row, not the arguments, so the command itself is
      // named by the case that sent it; what this reader adds is the outcome.
      command: `(recorded as a ${message.toolName} result${message.isError ? ', isError' : ''})`,
      result: text.slice(0, 600),
    })
  }
  return {
    source: log.file ?? '(none)',
    entries: log.entries.length,
    calls,
    ...(log.reason ? { reason: log.reason } : {}),
  }
}

function claudeEvidence(key: SessionKey): RuntimeShellEvidence {
  const log = readClaudeSessionLog(key.workspaceId, configDir(), key.sessionId)
  return {
    source: log.file ?? '(none)',
    entries: log.entries.length,
    calls: shellCallsFromClaudeLike(log.entries),
    ...(log.reason ? { reason: log.reason } : {}),
  }
}

/**
 * Codex's own rollout, inside the live managed `CODEX_HOME`.
 *
 * PKG-5's instrument, and its warning with it: the home is `mkdtemp`ed per
 * runtime (F1.652: under `<config>/codex-home`, else the OS temp dir) and removed on teardown, so this must run while the arm is up, and
 * the home is matched on the `--session-id` the host writes into
 * `[mcp_servers.session]` rather than on mtime — three homes coexisted during
 * that sitting.
 */
function codexEvidence(key: SessionKey): RuntimeShellEvidence {
  // F1.652 — the host root under the config dir first, then the OS temp dir (the fallback).
  const roots = codexHomeRoots()
  const root = roots.join(' and ')
  const homes = listCodexHomes(roots)
  for (const dir of homes) {
    const config = join(dir, 'config.toml')
    if (!existsSync(config)) continue
    let text: string
    try {
      text = readFileSync(config, 'utf8')
    } catch {
      continue
    }
    if (!text.includes(key.sessionId)) continue
    const sessions = join(dir, 'sessions')
    if (!existsSync(sessions)) return { source: dir, entries: 0, calls: [], reason: 'the home carries no sessions/ yet' }
    const files: string[] = []
    const walk = (current: string): void => {
      for (const name of readdirSync(current)) {
        const child = join(current, name)
        if (statSync(child).isDirectory()) walk(child)
        else if (name.endsWith('.jsonl')) files.push(child)
      }
    }
    walk(sessions)
    if (files.length === 0) return { source: dir, entries: 0, calls: [], reason: 'no rollout jsonl under sessions/' }
    const newest = files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]!
    const entries: Record<string, unknown>[] = []
    for (const line of readFileSync(newest, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        entries.push(JSON.parse(trimmed) as Record<string, unknown>)
      } catch { /* a partially written line is not evidence */ }
    }
    // Codex records a call as a `response_item` whose payload is a
    // `function_call`, with the arguments as a JSON string.
    const calls: RuntimeShellEvidence['calls'] = []
    const outputs = new Map<string, string>()
    for (const entry of entries) {
      const payload = (entry.payload ?? entry) as Record<string, unknown>
      if (payload?.type === 'function_call_output' && typeof payload.call_id === 'string') {
        outputs.set(payload.call_id, JSON.stringify(payload.output ?? '').slice(0, 600))
      }
    }
    for (const entry of entries) {
      const payload = (entry.payload ?? entry) as Record<string, unknown>
      if (payload?.type !== 'function_call' || typeof payload.name !== 'string') continue
      if (!SHELL_TOOL_NAMES.test(payload.name)) continue
      calls.push({
        name: payload.name,
        command: String(payload.arguments ?? '').slice(0, 400),
        result: typeof payload.call_id === 'string' ? (outputs.get(payload.call_id) ?? '(no output recorded)') : '(no call_id)',
      })
    }
    return { source: newest, entries: entries.length, calls }
  }
  return {
    source: '(none)',
    entries: 0,
    calls: [],
    reason:
      `no-codex-home-for-session: ${homes.length} nessy-codex-home-* under ${root}, none naming ${key.sessionId}. `
      + 'The runtime is torn down with the session, so this read must happen while it is still up.',
  }
}

function evidenceFor(kind: RuntimeKind, key: SessionKey): RuntimeShellEvidence {
  if (kind === 'pi') return piEvidence(key)
  if (kind === 'anthropic') return claudeEvidence(key)
  return codexEvidence(key)
}

/* ------------------------------------------------------------------ *
 * One arm
 * ------------------------------------------------------------------ */

type Verdict = 'executed' | 'prompted' | 'blocked' | 'never-attempted'

/**
 * One arm could not be set up. Distinct from a FAILED check about the product:
 * the case records it, drops that runtime, and goes on to the next — because on
 * this profile the alternative is that the first hostile arm takes the other two
 * with it and the run reports nothing at all.
 */
class ArmRigFailure extends Error {}

interface ArmOutcome {
  runtime: RuntimeKind
  slug: string
  role: 'control' | 'probe'
  mode?: string
  verdict: Verdict
  end: TurnEnd
  effect: boolean
  pending: string[]
  cards: CardSighting[]
  shellCalls: RuntimeShellEvidence['calls']
  evidenceSource: string
  evidenceReason?: string
  reply: string
  elapsedMs: number
}

/**
 * One runtime's pair of turns, in ONE session: control first, then probe.
 *
 * PKG-5's rule is that arms must not share a session, and this is the exception
 * it names rather than a lapse from it. That rule exists because the first arm's
 * IMAGE stayed in the history and the second turn replayed it into a model that
 * refuses images, which scored the pair backwards. Nothing of that kind is in
 * play here: the control's residue is the text of a `cat`, the probe's verdict
 * is a decision `shouldAllowToolInMode` makes from the COMMAND, and a model that
 * has just seen a shell command succeed can only bias toward attempting the
 * second — which the `never-attempted` state records separately anyway.
 *
 * The reason to share is measured: creating a session on this profile re-renders
 * a 740-row sidebar, and doing it six times is what put a `Runtime.evaluate`
 * past four minutes. Three sessions instead of six halves the one operation that
 * was actually failing.
 *
 * The probe therefore runs SECOND, deliberately: if it leaves an unanswered
 * permission request the session is stuck, and a control that had not already
 * run could never run afterwards.
 */
async function runArm(
  run: CaseRun,
  session: CdpSession,
  input: {
    kind: RuntimeKind
    slug: string
    role: 'control' | 'probe'
    fixture: Fixture
    prompt: string
    /** Reads true once the command has left its trace. Baselined before the turn. */
    effect: () => boolean
    /** Reuse an already-prepared session instead of creating one. */
    reuse?: SessionKey
  },
): Promise<ArmOutcome & { key: SessionKey }> {
  const label = `${input.kind}/${input.role}`
  let key: SessionKey
  if (input.reuse) {
    key = input.reuse
  } else {
    // `freshSession` reads `getSessions()` too, so it is subject to the same
    // 30 s app-side budget; one retry rather than losing the arm to the load.
    let created = await tolerant(() => freshSession(session, `${ID} ${input.kind}`), undefined)
    if (!created) created = await freshSession(session, `${ID} ${input.kind} retry`)
    if (!run.check(`${label} · a fresh session was created`, created.fresh, created.reason ?? '')) {
      throw new ArmRigFailure(`${label}: ${created.reason ?? 'session not fresh'}`)
    }
    key = created
  }
  if (!input.reuse) {

    // **No working-directory bind, deliberately — and it costs this case
    // nothing.** Both commands carry ABSOLUTE paths into the fixture, and plan
    // mode's shell band is decided by the COMMAND against the read-only
    // allowlist (`apps/electron/resources/permissions/default.json`); no path
    // containment is involved for Bash. A session left on its own storage
    // directory therefore meets exactly the same gate.
    //
    // The bind is dropped rather than merely made non-fatal because it does not
    // fail, it HANGS. Measured across four runs on this profile:
    // `updateWorkingDirectory` first returned `Request timeout:
    // sessions:command (30000ms)` on a mutation that had landed, then
    // `session-project-mutation-busy` when the retry collided with its own
    // still-running first call, and finally stopped answering the
    // `Runtime.evaluate` at all — one run died at the 240 s command budget and
    // the next was still inside the same call at 7m36s, while `1+1` on the same
    // renderer answered in 1 ms. A step that can consume the whole budget and
    // contributes nothing to the measurement is not worth keeping for tidiness.
    // (The fault it documents is the profile's, not this row's, and it now lives
    // in `bindWorkingDirectory` in `lib/runtime-switch.ts` with driven arms —
    // F1.121, F1.182 — rather than in a copy this case does not call.)
    await waitFor(() => tolerant(() => isProcessing(session, key), true), busy => !busy, { timeoutMs: 90_000, intervalMs: 4_000 })
      .catch(() => undefined)

    const moved = await bindRuntime(session, key, input.slug)
    run.observe(`${label} · runtime bind`, moved)
    // A rig failure on ONE arm must not destroy the other arms' measurements:
    // this profile is hostile enough that losing all three to the first is the
    // likely outcome of a `require` here.
    if (!run.check(`${label} · the session moved onto ${input.slug}`, moved.bound, `rpc said ${moved.rpc}; session reports ${String(moved.active)}`)) {
      throw new ArmRigFailure(`${label}: runtime bind failed — rpc ${moved.rpc}, active ${String(moved.active)}`)
    }
    await setPermissionMode(session, key.sessionId, 'plan')
  }

  // The mode has to STICK, and it is re-read on BOTH turns: a runtime switch or
  // a settled turn could move it, and a case that measures a session in
  // `default` reports the wrong mode's answer as this one's.
  const mode = await waitFor(
    async () => (await tolerant(() => listSessions(session), [])).find(s => s.id === key.sessionId)?.permissionMode,
    value => value === 'plan',
    { timeoutMs: 90_000, intervalMs: 4_000, label: `${label} to report plan mode` },
  ).catch(() => undefined)
  if (!run.check(`${label} · the session is in plan mode`, mode === 'plan', `reports ${String(mode)}`)) {
    throw new ArmRigFailure(`${label}: permission mode reports ${String(mode)}, not plan`)
  }

  // Baseline: the effect must be absent before the turn, or its presence
  // afterwards proves nothing.
  const before = input.effect()
  if (!run.check(`${label} · the effect is absent before the turn`, !before, 'baselined immediately before submitting')) {
    throw new ArmRigFailure(`${label}: the probe's effect was already present before the turn`)
  }

  const observed = await submitAndObserve(session, key, input.prompt, TURN_TIMEOUT_MS)
  // Codex's home dies with its runtime, so the runtime read happens here —
  // before anything that could settle or tear the arm down.
  const evidence = evidenceFor(input.kind, key)
  const effect = input.effect()
  const reply = lastAssistantText(observed.added)

  // The CONTROL has no disk effect by construction, so the probe's ladder would
  // label a control that ran perfectly `blocked` — which is what the first two
  // runs printed. Its states are its own: it either ran a shell command or it
  // did not, and whether the token came back is scored separately by the caller.
  let verdict: Verdict
  if (input.role === 'control') {
    verdict = evidence.calls.length > 0 ? 'executed' : 'never-attempted'
  } else if (effect) verdict = 'executed'
  else if (observed.end === 'permission-pending') verdict = 'prompted'
  else if (evidence.calls.length > 0) verdict = 'blocked'
  else verdict = 'never-attempted'

  if (observed.end === 'permission-pending') {
    run.observe(`${label} · release`, await denyPending(session, key).catch(e => `deny-failed: ${String(e)}`))
  }

  const result: ArmOutcome & { key: SessionKey } = {
    key,
    runtime: input.kind,
    slug: input.slug,
    role: input.role,
    mode,
    verdict,
    end: observed.end,
    effect,
    pending: observed.pending,
    cards: observed.cards,
    shellCalls: evidence.calls,
    evidenceSource: evidence.source,
    ...(evidence.reason ? { evidenceReason: evidence.reason } : {}),
    reply: reply.slice(0, 500),
    elapsedMs: observed.elapsedMs,
  }
  run.observe(`${label} · outcome`, {
    verdict,
    end: observed.end,
    effect,
    pending: observed.pending,
    cards: observed.cards.map(c => ({ text: c.text.slice(0, 200), buttons: c.buttons })),
    shellCalls: evidence.calls,
    evidence: { source: evidence.source, entries: evidence.entries, reason: evidence.reason },
    replyExcerpt: reply.slice(0, 300),
    elapsedMs: observed.elapsedMs,
  })
  return result
}

async function body(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  run.observe('theme', await ensureDarkTheme(session))

  const app = resolveAppUnderTest(session)
  run.observe('app-under-test', { kind: app.kind, appRoot: app.appRoot, via: app.via })
  if (app.kind !== 'packaged') {
    blocked(`this row is owed on the SHIPPED artefact; the CDP target is ${app.kind} (${app.targetUrl})`)
  }

  // **A modal up before the run starts invalidates every read that follows, and
  // it does not announce itself as one.** Measured here: an abandoned run left a
  // "Trust this project?" gate open, and with it up `getSessions()` went from
  // 802 ms to 5 163 ms and then past the app's own 30 s budget — so
  // `freshSession` reported `session-create-failed` about an app that was
  // merely blocked. Refused rather than dismissed: answering somebody else's
  // trust dialog is the operator's decision, and this harness says so in
  // `trustFixtureProject`'s own refusal.
  const modal = await session.call<{ trustGate: boolean; dialogs: number; text: string }>(`
    const heading = Array.from(document.querySelectorAll('h1,h2,h3,[role="heading"]'))
      .find(${TRUST_GATE_HEADING_IN_PAGE})
    const dialogs = document.querySelectorAll('[role="dialog"]')
    return {
      trustGate: !!heading,
      dialogs: dialogs.length,
      text: dialogs.length ? String(dialogs[0].textContent || '').replace(/\\s+/g, ' ').slice(0, 200) : '',
    }
  `)
  run.observe('blocking UI before the run', modal)
  if (modal.trustGate) {
    blocked(
      'a "Trust this folder?" gate is already open, and every read taken under it is a read of a blocked '
      + `renderer rather than of the app. Answer or dismiss it by hand, then re-run. The dialog says: ${modal.text}`,
    )
  }

  // ---- the precondition the row is about ------------------------------
  const flag = readFlag()
  run.observe('useAutoModeDuringPlan in the operator config', flag)
  if (!flag.effective) {
    blocked(
      'this config dir sets `useAutoModeDuringPlan: false`, so the run would measure the documented '
      + '"Otherwise" branch rather than the DEFAULT the row is about. This case will not flip the setting '
      + 'it is testing — remove the key (absent is on) and re-run.',
    )
  }
  run.check(
    'the flag is at its default: absent from config, therefore ON',
    !flag.present,
    flag.present
      ? `the key is written explicitly as ${JSON.stringify(flag.value)} — still ON, but this is no longer the DEFAULT the row asks about`
      : 'no `useAutoModeDuringPlan` key, and `getUseAutoModeDuringPlan()` is `!== false`',
  )

  const connections = await listConnections(session)
  run.observe('connections', connections.map(c => `${c.slug}(${c.providerType})`))
  const slugFor = new Map<RuntimeKind, string>()
  for (const kind of RUNTIMES) {
    const row = connections.find(c => runtimeOf(c.providerType) === kind)
    if (row) slugFor.set(kind, row.slug)
  }
  if (slugFor.size === 0) {
    blocked(`no pi, claude or codex connection in this config dir. The app lists: ${connections.map(c => `${c.slug}(${c.providerType})`).join(', ') || 'nothing'}`)
  }
  run.observe('runtimes reachable on this profile', [...slugFor].map(([kind, slug]) => `${kind}=${slug}`))

  const nonce = Math.random().toString(16).slice(2, 10).toUpperCase()
  const fixture = seedFixture(nonce)
  run.observe('fixture', fixture)

  // ONE directory per runtime. A shared name would let Pi's success satisfy
  // claude's baseline read and then score claude `executed` for a command
  // claude never ran — the arms would be measuring each other.
  const probeDirFor = (kind: RuntimeKind): string => join(fixture.dir, `${fixture.probeDirName}-${kind}`)
  const outcomes: ArmOutcome[] = []
  const rigFailures: string[] = []

  // **A runtime filter, because a slow rig otherwise makes the case unrunnable
  // rather than slow.** `NESSY_CDP_PKG6_RUNTIMES=pi,anthropic` runs a subset;
  // unset runs all three. A subset run is recorded as such in the verdict, so a
  // partial sitting can never be read as a complete one — which is the only
  // thing that makes splitting the case across runs honest.
  const requested = (process.env.NESSY_CDP_PKG6_RUNTIMES ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const selected = requested.length > 0 ? RUNTIMES.filter(kind => requested.includes(kind)) : [...RUNTIMES]
  run.observe('runtimes this run measures', { selected, filter: requested.length > 0 ? requested : '(none — all)' })

  for (const kind of selected) {
    const slug = slugFor.get(kind)
    if (!slug) {
      run.observe(`${kind} · not reachable on this profile`, 'skipped — recorded as unmeasured, not as a pass')
      continue
    }

    // (1) the positive control — an allowlisted read-only command. Phrased
    // POSITIVELY: naming a tool and forbidding the call trips Pi's Guardian as
    // prompt injection, and the wreckage reads like a dispatch bug.
    try {
      const control = await runArm(run, session, {
        kind,
        slug,
        role: 'control',
        fixture,
        prompt:
          `Run this exact shell command and show me its output: cat ${fixture.controlFile}`,
        // The control's effect is its OUTPUT, not a file, so the disk predicate is
        // false by construction and the verdict comes from the transcript and the
        // reply. Keeping the same shape as the probe is deliberate: one arm
        // runner, one set of states.
        effect: () => false,
      })
      outcomes.push(control)

      // (2) the probe — a command in plan mode's shell band by construction, in
      // the SAME session, second. See `runArm`'s header for why sharing is right
      // here and wrong in PKG-5.
      outcomes.push(await runArm(run, session, {
        kind,
        slug,
        role: 'probe',
        fixture,
        reuse: control.key,
        prompt:
          `Run this exact shell command and show me its output: mkdir -p ${probeDirFor(kind)}`,
        effect: () => existsSync(probeDirFor(kind)),
      }))
    } catch (cause) {
      // Only a RIG failure is swallowed, and it is recorded by name. Anything
      // else is a real fault and still ends the case.
      if (!(cause instanceof ArmRigFailure)) throw cause
      rigFailures.push(cause.message)
      run.observe(`${kind} · arm abandoned (rig)`, cause.message)
    }
  }

  // ---- what the arms add up to ----------------------------------------
  const byRuntime = new Map<RuntimeKind, { control?: ArmOutcome; probe?: ArmOutcome }>()
  for (const outcome of outcomes) {
    const slot = byRuntime.get(outcome.runtime) ?? {}
    slot[outcome.role] = outcome
    byRuntime.set(outcome.runtime, slot)
  }

  for (const [kind, pair] of byRuntime) {
    const { control, probe } = pair
    if (!control || !probe) continue
    // The control's job: prove this arm can run a shell command in plan mode at
    // all. It ran the command if the runtime recorded the call AND the token it
    // could only get by reading the file appears.
    // **The control is scored on the TOKEN, and the label says so.** The first
    // Pi reading passed this check while its own detail line read "0 shell
    // call(s) … verdict never-attempted" — a self-contradiction that was true:
    // the token was there, the sidecar reader was wrong. Scoring the token is
    // right (only reading the file can produce it) and the shell-call count is
    // reported beside it rather than folded into one verdict.
    const controlToken =
      control.reply.includes(fixture.controlNonce)
      || control.shellCalls.some(c => c.result.includes(fixture.controlNonce))
    run.check(
      `${kind} · the positive control read the file in plan mode (the arm is alive)`,
      controlToken,
      controlToken
        ? `the control token reached the reply; ${control.shellCalls.length} shell call(s) in the runtime's own log; verdict ${control.verdict}`
        : `no control token — this arm's probe result says nothing about permissions. `
          + `control verdict ${control.verdict}, end ${control.end}, reply: ${control.reply.slice(0, 200)}`,
    )
    const controlRan = controlToken
    // The measurement itself. Recorded, not judged: which of the four states is
    // "correct" is the owner's ruling, and this row exists because nobody knew
    // which one it was.
    run.check(
      `${kind} · the probe reached a determinate state`,
      probe.verdict !== 'never-attempted' || !controlRan,
      probe.verdict === 'never-attempted' && controlRan
        ? 'the control ran a command and the probe attempted none, so plan mode was never actually tested on this runtime'
        : `verdict ${probe.verdict}`,
    )
  }

  // Not an assertion: a busy box is not a defect. It is here so a reader can
  // tell a clean run from one that spent its time retrying a saturated app.
  run.observe('app RPC reads that timed out and were retried', rpcTimeouts)
  run.observe('arms abandoned for rig reasons', rigFailures)
  run.check(
    'at least one runtime was measured end to end',
    outcomes.some(o => o.role === 'probe'),
    rigFailures.length > 0
      ? `every arm was abandoned before its probe: ${rigFailures.join(' | ')}`
      : 'a probe arm completed',
  )

  run.observe('VERDICT (for the owner sitting)', {
    row: 'P3.187',
    rpcTimeoutsRetried: rpcTimeouts,
    flag: { present: flag.present, value: flag.value, effective: flag.effective },
    theOnlyReaderOfTheFlag: 'pi-agent.ts planClassifierEligible',
    perRuntime: [...byRuntime].map(([kind, pair]) => ({
      runtime: kind,
      control: pair.control ? { verdict: pair.control.verdict, end: pair.control.end, shellCalls: pair.control.shellCalls.length } : 'not run',
      probe: pair.probe
        ? {
            verdict: pair.probe.verdict,
            end: pair.probe.end,
            wroteToDisk: pair.probe.effect,
            promptedTheHuman: pair.probe.end === 'permission-pending',
            shellCalls: pair.probe.shellCalls,
          }
        : 'not run',
    })),
    runtimesMeasuredThisRun: selected,
    partialRun: selected.length < RUNTIMES.length,
    probeDirectories: selected.map(kind => ({ runtime: kind, dir: probeDirFor(kind), exists: existsSync(probeDirFor(kind)) })),
    unreachable: selected.filter(kind => !slugFor.has(kind)),
  })
}

if (import.meta.main) {
  const result = await runCase(ID, TITLE, body, { timeoutMs: CDP_COMMAND_TIMEOUT_MS })
  process.exit(exitCodeFor(result.status))
}

export { ID, TITLE, body }
