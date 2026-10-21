/**
 * MCP-W2 — a real model turn calls a real MCP tool, on every runtime.
 *
 * This is the check nothing before it performed. The 1.24.0 wire-name work and
 * the F2–F4 follow-ups were verified by unit tests, by a full repo wave, and by
 * an in-process live pass — and in every one of them the seam stopped at "which
 * name reaches the pool". Three things were therefore never observed:
 *
 *   - a live MCP connection (every server in the bundles F1 drove was
 *     OAuth-gated, so a fake `PoolClient` stood in);
 *   - a model actually invoking one of those tools;
 *   - any of it on the Claude or Codex runtime, which consume the same mint
 *     through different mechanics.
 *
 * ## The detectors, and the two that had to be thrown away
 *
 * 1. **"the assistant said the token"** — DEAD, twice over. The token sits on
 *    disk in the fixture's own bundle, so quoting it proves reading; and when
 *    it was passed as the server's `env` the runtime REDACTED it out of the
 *    tool result, so the first live Pi turn answered `[REDACTED] [REDACTED]`.
 *    Correct product behaviour that destroys the detector. Replaced by a
 *    per-call `nonce=` the server mints at call time and no file contains.
 * 2. **"a tool message appeared"** — kept, but for what it actually proves: it
 *    names the tool the APP dispatched, which IS the mint under test, and says
 *    nothing about whether a server answered.
 * 3. **"the probe log has a `tools/call`"** — the server's own account, the one
 *    reading independent of the app. It works for the two NATIVE servers and
 *    not for the plugin-bundled one, whose process is sandboxed to its plugin
 *    data root and cannot write the fixture's log. That asymmetry is not
 *    guessed: the native lines in the same file are the positive control that
 *    the logging works at all, which is what AGENTS.md demands before any
 *    absence is reported.
 *
 * A runtime passes when the app dispatched the minted name AND a fresh nonce
 * came back through the tool result into the reply. A runtime that cannot be
 * exercised is NAMED and the case ends BLOCKED — never PASS.
 * `scripts/cdp/README.md`: a gate that reports green while silently skipping a
 * runtime is worse than no gate, because the next person will trust it.
 *
 * ## The Pi arm SELECTS its tools in a turn of their own (T20, 2026-08-21)
 *
 * Since deferred MCP became the default (T12/T15), a Pi session past
 * `PI_DEFERRED_MCP_TOOL_THRESHOLD` (`shared/src/agent/pi-harness/harness-manifest.ts`,
 * 48) hides every unpinned MCP tool behind `mcp__tool_search`/`mcp__tool_load`
 * (`pi-agent-server/src/deferred-mcp-tools.ts`). Until F1.803 (`722c67605`) a
 * loaded tool was callable only **from the user's NEXT message**, and this case
 * asked for the call in ONE turn — the drift T16 fixed for MCP-AUTH, in the Pi
 * arm's own words: *"I cannot call the tool in this same turn"*. So the arm runs
 * a SELECTION turn first, forbidden to call anything, then the inventory and the
 * call as separate requests. F1.803 made a loaded tool callable from the next step
 * of the SAME request; the split still holds, and the half below still needs it.
 *
 * **The selection turn also repairs three checks the deferral had made
 * unmeasurable, and that is the half the T20 row did not predict.** The
 * inventory turn reads the model's OWN tool list — and a deferred tool is
 * deliberately absent from it, so `mcp__plugin_cdp-echo-probe_echo__whoami` and
 * both F3 names went red on Pi about tools the product was hiding on purpose.
 * Measured on the dev build 2026-08-21: Pi's TOOLS line carried
 * `mcp__tool_load, mcp__tool_search` and nothing else, six reds in total, of
 * which only three were the single-turn call. The selection turn loads every
 * fixture `__whoami` tool the catalogue names, so the inventory turn that
 * follows reads a surface that carries them, and all six measure the mint again.
 *
 * **The Claude runtime has NO deferred surface** — deferral lives in the Pi
 * harness and nowhere else — so its selection turn takes the "already in your
 * tool list" branch and loads nothing. It is kept for that arm because the
 * packaged wave measured a single `MCP error -32601` there whose cause was
 * never diagnosed, and the same two-turn control cleared it on the same build
 * (`docs/testing/cdp-runs/2026-08-21-w-pkg-packaged-wave.md`). An extra turn
 * that only ever OBSERVES cannot make the case lie about the mint.
 *
 * **The Codex arm is untouched.** It was green end to end in the same wave, its
 * pool rides the `sources` bridge rather than the Pi tool surface, and its three
 * model-self-report reds are the detector limitation the checklist has recorded
 * since codex 0.147 put MCP tools behind its own tool search.
 *
 * **No wording of the load result is pinned here.** T15 rewrote all three of
 * those strings on 2026-08-21 and F1.803 on 2026-09-25; this case asserts the
 * MECHANISM (select in one request, call in a later one). The load result is
 * recorded, never matched (AGENT-INSTALL reads it only to name the bundle).
 *
 * ## The three model-self-report checks are UNRELIABLE on every arm
 *
 * Detector 2's caveat above ("a model can under- or over-report") is not
 * theoretical, and T20 measured how large it is. On three consecutive Claude
 * sittings of the same build and the same fixture profile minutes apart, the
 * model's own TOOLS line carried all three minted names once and none of them
 * twice — and the run that under-reported was not truncated: it enumerated
 * `mcp__session__*` and `mcp__t-tracker__*` exhaustively, in full, and simply
 * stopped before the fixture's servers, closing with a well-formed `SKILL=YES`.
 * **The control is the pre-T20 shape**: with the selection turn removed
 * entirely, the same three checks were red again, so the extra turn is not the
 * cause. What is being measured there is the model's willingness to enumerate
 * ~100 names, not the mint.
 *
 * That is the same class as the four Codex reds the checklist has carried since
 * 0.147 (`TOOLS= NONE`, while the very next turn dispatches the minted name and
 * a server answers). The three checks are KEPT — this is the only surface where
 * a user-visible wire name appears at all (G5 deviation log), so it is the only
 * place the F3 names can be asserted live — but a red among them is evidence
 * about the model's answer, and the run's verdict on the MINT is the tool-call
 * trio below it: the app dispatched the minted name, the RESULT carried a fresh
 * per-call nonce, and the reply carried it back.
 */

import type { CdpSession } from '../lib/connect.ts'
import { EXPECTED, FIXTURE, modelToolName, proxyToolName } from '../fixtures/mcp-naming.ts'
import { lastAssistantText, sendPrompt } from '../lib/chat.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import {
  catalogRows,
  ensureDarkTheme,
  fixtureWorkspaceId,
  mcpTools,
  probeCalls,
  probeToolCalls,
  requireTokens,
} from '../lib/mcp-fixture.ts'
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
import { turnRowsSince } from '../lib/turn-evidence.ts'
import { clickSelector } from '../lib/viewport.ts'

const ID = 'MCP-W2'
const TITLE = 'A live model turn invokes a plugin-bundled MCP tool under its minted wire name — Pi, Claude runtime, Codex runtime'

/** The label the fixture's plugin server stamps on every line it logs. */
const PROBE_LABEL = 'plugin-echo'

/**
 * The two model-facing tools of Pi's deferred-MCP surface, verbatim from
 * `DEFERRED_MCP_TOOL_SEARCH_NAME` / `DEFERRED_MCP_TOOL_LOAD_NAME`
 * (`packages/pi-agent-server/src/deferred-mcp-tools.ts`). Not imported: this
 * harness drives the app from outside and must not link its subprocess bundle —
 * the same reason MCP-AUTH spells them out.
 */
const DEFERRED_SEARCH_TOOL = 'mcp__tool_search'
const DEFERRED_LOAD_TOOL = 'mcp__tool_load'

interface RuntimeTarget {
  id: 'pi' | 'claude' | 'codex'
  /** `providerType`s that count as this runtime. */
  providerTypes: string[]
  label: string
  /**
   * Whether this arm runs the selection turn described in the header.
   *
   * True where a tool can be DEFERRED (Pi) or where the single-turn shape has
   * been measured failing for a reason nobody diagnosed (the Claude runtime's
   * `-32601` in the packaged wave). False for Codex, whose arm is green end to
   * end and whose pool arrives through the `sources` bridge, not through the Pi
   * tool surface — a selection turn there would be a change to a passing arm,
   * which T20 explicitly does not make.
   */
  selectsTools: boolean
}

const ALL_RUNTIMES: RuntimeTarget[] = [
  { id: 'pi', providerTypes: ['pi', 'pi_compat'], label: 'Pi', selectsTools: true },
  { id: 'claude', providerTypes: ['claude-runtime'], label: 'Claude runtime', selectsTools: true },
  { id: 'codex', providerTypes: ['codex-runtime'], label: 'Codex runtime', selectsTools: false },
]

/**
 * `NESSY_CDP_MCP_RUNTIMES=pi,claude` narrows the run — for the packaged-build
 * repeat, where the brief asks for the single most important assertion rather
 * than the whole matrix. A narrowed run still ends BLOCKED and names what it
 * did not drive, so it can never be mistaken for the full gate.
 */
const RUNTIMES: RuntimeTarget[] = (() => {
  const requested = (process.env.NESSY_CDP_MCP_RUNTIMES ?? '').split(',').map(v => v.trim()).filter(Boolean)
  if (requested.length === 0) return ALL_RUNTIMES
  return ALL_RUNTIMES.filter(runtime => requested.includes(runtime.id))
})()

interface Connection {
  slug: string
  providerType: string
}

/**
 * The tool call, as the APP recorded it.
 *
 * `toolName` is `mcp__<wire>__<tool>` — the mint's output as it reached the
 * model, which is the one place a user or a permission rule can ever read a
 * wire name (G5 deviation log: the renderer never displays it).
 */
function mcpToolMessages(messages: TranscriptMessage[]): TranscriptMessage[] {
  return messages.filter(m => typeof m.toolName === 'string' && m.toolName.startsWith('mcp__'))
}

/**
 * A turn that ran, or a turn that threw — ONE shape, discriminated by `error`.
 *
 * `sendPrompt` rejects on timeout, so every call site needs both arms. Giving
 * them different shapes bought two `'messages' in x` guards that are always
 * true (both arms carry `messages`) and therefore assert nothing; `error` is
 * the only field that actually distinguishes them.
 */
interface TurnAttempt {
  /** Messages this turn added. Empty when the turn threw. */
  added: TranscriptMessage[]
  error?: string
}

const turnAttempt = (turn: { added: TranscriptMessage[] }): TurnAttempt => ({ added: turn.added })

const turnFailure = (cause: unknown): TurnAttempt => ({
  added: [],
  error: cause instanceof Error ? cause.message : String(cause),
})

/**
 * Answer permission prompts while a turn is in flight.
 *
 * `sendPrompt` awaits the whole turn, and a turn parked on an unanswered card
 * never ends — so the case cannot answer one after the fact, and its own turn
 * timeout cannot save it either. This runs underneath.
 *
 * Driven from `Session.awaitingApprovalCount` (dto.ts:184 — derived at read
 * time from the live pending map, so it cannot go stale) and answered with a
 * REAL mouse click on the card's own Allow button. A raw in-page `.click()` is
 * not the same thing: measured on the first run, one removed both cards from
 * the DOM and left the request unanswered in the backend, which is the
 * "the card is gone but the backend still waits" divergence in reverse.
 */
function approvePermissionsWhile(session: CdpSession, sessionId: string): { stop: () => Promise<number> } {
  const ALLOW_BUTTON = '[data-tutorial="permission-allow-button"]'
  let approved = 0
  let running = true
  const loop = (async () => {
    while (running) {
      await Bun.sleep(2_000)
      const waiting = await session.call<number>(`
        const s = (await window.electronAPI.getSessions() ?? []).find(x => x.id === ${JSON.stringify(sessionId)})
        return s && typeof s.awaitingApprovalCount === 'number' ? s.awaitingApprovalCount : 0
      `).catch(() => 0)
      if (waiting < 1) continue
      const buttons = await visibleElements(session, ALLOW_BUTTON).catch(() => [])
      if (buttons.length === 0) continue
      await clickSelector(session, ALLOW_BUTTON).catch(() => undefined)
      approved += 1
    }
  })()
  return {
    stop: async () => {
      running = false
      await loop
      return approved
    },
  }
}

/** What the selection turn reached, for the report. Nothing here is matched. */
interface SelectionTurn {
  reply: string
  searchRows: TranscriptMessage[]
  loadRows: TranscriptMessage[]
  /** Every `mcp__tool_search` result concatenated — the deferred catalogue's own answer. */
  catalogueText: string
  approvedCards: number
  error?: string
}

/**
 * TURN ONE of a deferral-aware arm: select the tools, never call one.
 *
 * The shape MCP-AUTH's `deferredLoadTurn` established (T12/T16) and the reason
 * is the product's own contract, not a courtesy: `mcp__tool_load` registers a
 * tool for the NEXT `handlePrompt`, so a same-request call answers `Tool … not
 * found` however honestly it was loaded. Written out here rather than imported
 * from `cases/mcp-auth.ts` deliberately — cases do not import one another, and
 * coupling two live cases' evidence to one helper is how a change to one
 * silently invalidates the other's recorded run.
 *
 * A failed turn is DATA, not a throw: the arm carries on and the checks below
 * report what the surface actually held.
 *
 * The approver runs underneath because `mcp__tool_load` is itself a mutation
 * (`harness-tool-descriptor.ts`: `mutate('mcp_tool_load', …)`) and raises a card
 * that `bypassPermissions` does not suppress — measured on the run before this
 * change, where the case's one approved card was the load.
 */
async function selectDeferredTools(
  session: CdpSession,
  key: SessionKey,
  prompt: string,
): Promise<SelectionTurn> {
  const approver = approvePermissionsWhile(session, key.sessionId)
  const rowsBefore = (await transcript(session, key)).length // F1.521: the fallback's baseline, read before the send
  const turn = await sendPrompt(session, key, prompt, 240_000).then(turnAttempt).catch(turnFailure)
  const approvedCards = await approver.stop()
  const scanned = await turnRowsSince(() => transcript(session, key), turn.added, rowsBefore)
  const searchRows = scanned.filter(m => m.toolName === DEFERRED_SEARCH_TOOL)
  return {
    reply: lastAssistantText(scanned),
    searchRows,
    loadRows: scanned.filter(m => m.toolName === DEFERRED_LOAD_TOOL),
    catalogueText: searchRows.map(m => m.toolResult ?? '').join('\n'),
    approvedCards,
    ...(turn.error ? { error: turn.error } : {}),
  }
}

/**
 * F1.153 — what each runtime's MODEL is asked for, and what its own report is
 * read against. On Pi and the Claude runtime that is the pool name the host
 * also records, and every string here is the one those two arms passed 9/9
 * with at SIT-11. On codex the model is handed a DIFFERENT name from the one
 * the host records ({@link modelToolName} against `proxyToolName`), and the
 * arm used to ask the model for the host's: `TOOLS=NONE` (the line asked for
 * names starting `mcp__`, and none of codex's do), then `TOOL-FAILED: tool
 * mcp__sources__plugin_cdp-echo-probe_echo__whoami is not available in this
 * session` — 3 of 9 on a pool whose tool a real codex turn called under its own
 * spelling and got a per-call nonce back (C4). The dispatch assertion still
 * keys on the HOST's row name, where that name is a fact; only the questions
 * put to the model change, and only on codex.
 */
export function inventoryToolsLine(runtime: RuntimeTarget['id']): string {
  return runtime === 'codex'
    ? 'Line 1: TOOLS= followed by every MCP tool name you can call, spelled exactly as your own tool list spells it, comma-separated, or NONE. '
    : 'Line 1: TOOLS= followed by every tool name you can call that starts with mcp__, comma-separated, or NONE. '
}

export function callPrompt(runtime: RuntimeTarget['id']): string {
  return `Call the tool ${modelToolName(EXPECTED.pluginEchoWire, runtime)} with no arguments, then reply with exactly what it returned and nothing else. `
    + 'Do not read any file and do not guess: if the tool call fails, reply TOOL-FAILED plus the error.'
}

/**
 * The three names the model's own TOOLS line is read for, in the spelling THAT runtime's model uses.
 * F1.391: the hash-fallback pattern is `modelToolName` itself run over a sample `server-<10 hex>`
 * wire, the sample hash then widened to `[0-9a-f]{10}` — on codex that is `codexModelToolName`,
 * so no spelling here is written by hand.
 */
export function modelSurfaceExpectations(runtime: RuntimeTarget['id']): { echo: string; sanitized: string; hashFallback: RegExp } {
  const SAMPLE_HASH = '0123456789'
  const [before, after] = modelToolName(`${EXPECTED.scopedCyrillicWirePrefix}${SAMPLE_HASH}`, runtime).split(SAMPLE_HASH)
  const literal = (text = ''): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return {
    echo: modelToolName(EXPECTED.pluginEchoWire, runtime),
    sanitized: modelToolName(EXPECTED.scopedSanitizedWire, runtime),
    hashFallback: new RegExp(`${literal(before)}[0-9a-f]{10}${literal(after)}`),
  }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  const tokens = requireTokens()
  run.observe('theme', await ensureDarkTheme(session))

  const workspaceId = await fixtureWorkspaceId(session)
  const rows = await catalogRows(session, workspaceId)
  const echoRow = rows.find(r => r.kind === 'mcp' && r.origin === 'plugin' && r.logicalName === FIXTURE.echoServerName)
  if (!echoRow) {
    blocked(`fixture-not-installed: no plugin MCP row named "${FIXTURE.echoServerName}". `
      + 'Install the probe plugins first (see the MCP-W row in docs/testing/cdp-live-checklist.md).')
  }
  run.check(`the fixture server is active before any turn`, echoRow.state === 'active', `state=${echoRow.state}`)

  const connections = await session.call<Connection[]>(`
    return (await window.electronAPI.listLlmConnectionsWithStatus() ?? []).map(c => ({ slug: c.slug, providerType: c.providerType }))
  `)
  run.observe('connections', connections)

  const gaps: string[] = ALL_RUNTIMES
    .filter(runtime => !RUNTIMES.includes(runtime))
    .map(runtime => `${runtime.label}: excluded by NESSY_CDP_MCP_RUNTIMES=${process.env.NESSY_CDP_MCP_RUNTIMES}`)
  for (const runtime of RUNTIMES) {
    const connection = connections.find(c => runtime.providerTypes.includes(c.providerType))
    if (!connection) {
      gaps.push(`${runtime.label}: no connection with providerType ${runtime.providerTypes.join('/')} exists on this host`)
      run.observe(`${runtime.id}-gap`, gaps.at(-1))
      continue
    }
    const failure = await exerciseRuntime(run, session, workspaceId, runtime, connection, tokens.pluginEcho, echoRow.key)
    if (failure) gaps.push(`${runtime.label}: ${failure}`)
  }

  if (gaps.length > 0) {
    blocked(`runtimes not exercised end to end: ${gaps.join(' | ')}`)
  }
}

async function exerciseRuntime(
  run: CaseRun,
  session: CdpSession,
  workspaceId: string,
  runtime: RuntimeTarget,
  connection: Connection,
  token: string,
  echoCapabilityKey: string,
): Promise<string | undefined> {
  const name = runtime.id
  const key = await freshSession(session, `CDP ${ID} ${runtime.id} ${new Date().toISOString().slice(11, 19)}`)
  run.observe(`${name}-session`, { sessionId: key.sessionId, fresh: key.fresh, reason: key.reason })
  if (!key.fresh) {
    run.check(`${runtime.label}: the case ran in a session it created`, false, key.reason ?? 'unknown')
    return 'could not create a clean session'
  }

  await sessionCommand(session, key.sessionId, { type: 'setConnection', connectionSlug: connection.slug })
  // Wait for the switch to be IN EFFECT rather than merely requested — AGT-10's
  // detector 3: a prompt sent before the change lands measures the old runtime.
  // `Session.llmConnection` (dto.ts:190) is the persisted slug — the field the
  // `setConnection` command writes and the composer's own picker reads.
  const active = await waitFor(
    async () => (await session.call<string | undefined>(`
      const s = (await window.electronAPI.getSessions() ?? []).find(x => x.id === ${JSON.stringify(key.sessionId)})
      return s ? (s.llmConnection ?? undefined) : undefined
    `)),
    value => value === connection.slug,
    { timeoutMs: 30_000, intervalMs: 1_000, label: `session to switch to ${connection.slug}` },
  ).catch(() => undefined)
  run.check(
    `${runtime.label}: the session runs on ${connection.slug}`,
    active === connection.slug,
    `connectionSlug=${String(active)}`,
  )
  if (active !== connection.slug) return `the session would not switch to ${connection.slug}`

  // **Every MCP tool call is classified `mcp_mutation` and asks.** Measured:
  // the first run's Pi turn sat in `toolStatus: "executing"` for ten minutes
  // behind an unanswered card while the case's own 240 s turn timeout could not
  // even fire, because the turn had not ended. AGT-3 owns the prompt path; this
  // case is about naming, so it takes the documented mode that does not ask and
  // keeps an approver running underneath as a net.
  await sessionCommand(session, key.sessionId, { type: 'setPermissionMode', mode: 'bypassPermissions' }).catch(() => undefined)
  const mode = await waitFor(
    async () => (await listSessions(session)).find(s => s.id === key.sessionId)?.permissionMode,
    value => value === 'bypassPermissions',
    { timeoutMs: 20_000, intervalMs: 1_000, label: 'bypassPermissions to take effect' },
  ).catch(() => undefined)
  run.observe(`${name}-permission-mode`, mode ?? '(not applied)')

  // ---- turn one: SELECT the tools, call nothing (T20) ----------------------
  // On Pi this is what puts the fixture's tools on the surface at all; on the
  // Claude runtime it takes the "already listed" branch. Everything it reaches
  // is OBSERVED — no wording of the load result is pinned (T15 rewrote it).
  const expectedEchoTool = proxyToolName(EXPECTED.pluginEchoWire, runtime.id)
  let selection: SelectionTurn | undefined
  if (runtime.selectsTools) {
    selection = await selectDeferredTools(
      session,
      key,
      // ONE LINE, like every prompt here: the composer's contenteditable
      // swallows a newline outright and `sendPrompt`'s normalised read-back then
      // refuses the prompt with `composer-mismatch`.
      //
      // **The "do not call it" half is phrased as a POSITIVE restriction, and
      // that is not a style choice.** The first wording named the tool under
      // test and forbade calling it in the same sentence that asked for it to be
      // loaded, and Pi's Guardian read the pair as an injection and denied the
      // load outright: `Guardian denied this action [prompt_injection]: The
      // planned action loads four MCP tool names, including one explicitly
      // forbidden by the embedded instruction, which attempts to masquerade as
      // authorized`. The model then retried WITHOUT the forbidden name, so the
      // one tool the case exists to call was the one tool the selection turn
      // left out, and the call turn reported `Tool … not found` — a red that
      // looks exactly like a deferral bug and was the case's own prompt.
      // RTS-14's header records the same lesson from the other direction.
      `In this turn use only ${DEFERRED_SEARCH_TOOL} and ${DEFERRED_LOAD_TOOL}, and no other tool. Step 1: if `
      + `${DEFERRED_SEARCH_TOOL} is not in your tool list, reply with exactly MCP-TOOLS-READY and stop. Step 2: call `
      + `${DEFERRED_SEARCH_TOOL} with query "${FIXTURE.toolName}". Step 3: call ${DEFERRED_LOAD_TOOL} ONCE, with its `
      + `"names" argument set to every tool name that result listed which ends with "__${FIXTURE.toolName}" — all of `
      + 'them, leaving none out. Step 4: reply with exactly MCP-TOOLS-LOADED. Do not read any files.',
    )
    if (selection.error) run.observe(`${name}-selection-turn-error`, selection.error)
    run.observe(`${name}-selection-turn`, {
      reply: selection.reply.slice(0, 200),
      searched: selection.searchRows.length,
      loaded: selection.loadRows.length,
      catalogueNamesEchoTool: selection.searchRows.length > 0
        ? selection.catalogueText.includes(expectedEchoTool)
        : undefined,
      approvedCards: selection.approvedCards,
      // Whether the tool the CALL turn will ask for was among the ones the load
      // actually took. A load that quietly dropped it (the Guardian denial
      // above) turns the next turn's `Tool … not found` from a mystery into a
      // named cause — see the dispatch check's detail below.
      loadedEchoTool: selection.loadRows.length > 0
        ? selection.loadRows.some(m => (m.toolResult ?? '').includes(expectedEchoTool))
        : undefined,
      // OBSERVED, never matched: T15 rewrote this text and a later task may again.
      loadResults: selection.loadRows.map(m => (m.toolResult ?? '').slice(0, 300)),
    })
  }
  /** Set only when a selection turn ran and its load result did not name the probe tool. */
  const selectionMissedEchoTool = Boolean(selection?.loadRows.length)
    && !selection!.loadRows.some(m => (m.toolResult ?? '').includes(expectedEchoTool))
  run.observe(`${name}-tool-surface-reached-by`, !runtime.selectsTools
    ? 'no selection turn on this arm — the pool arrives through the sources bridge'
    : (selection?.loadRows.length ?? 0) > 0
      ? `${DEFERRED_SEARCH_TOOL} → ${DEFERRED_LOAD_TOOL} → the tools on the next request (deferred)`
      : 'already registered on the session surface — nothing was deferred')

  // ---- what the model can SEE (owner addendum) ----------------------------
  // The model's OWN report of its tool surface. Labelled as that: it is not an
  // independent read, and a model can under- or over-report. The independent
  // read is `capabilities.listMcpTools`, recorded beside it.
  const poolView = await mcpTools(session, workspaceId, echoCapabilityKey)
  run.observe(`${name}-listMcpTools`, poolView)
  const inventory = await sendPrompt(
    session,
    key,
    'Answer with two lines and nothing else. ' + inventoryToolsLine(runtime.id)
    + `Line 2: SKILL= followed by YES if a skill named ${FIXTURE.pluginTrackerId.replace('-probe', '-helper')} is available to you, otherwise NO. `
    // Naming a skill invites the model to RUN it, which perturbs the question
    // after this one. It used to perturb it fatally: an invoked skill's
    // `allowed-tools` was a CEILING, and on the packaged Pi run the next turn's
    // call came back `Tool "…" is outside the invoked skill tool ceiling`
    // because the fixture skill lists only `mcp__t-tracker__*`. Since
    // 2026-08-13 that refusal cannot happen — `allowed-tools` only
    // pre-approves — but the guard stays: an invoked skill still injects its
    // instructions into the turn.
    + 'Do NOT invoke, run or load that skill — only say whether it is listed.',
    240_000,
  ).then(turnAttempt).catch(turnFailure)
  if (inventory.error) run.observe(`${name}-inventory-turn-error`, inventory.error)
  // NOT `lastAssistantText`: a turn can add several assistant messages, and on
  // the packaged Pi run the model answered the TOOLS line and THEN wrote a
  // reasoning message about a skill it had invoked — so the last message won
  // and the case recorded "(no answer)" for a question that was answered
  // perfectly. Scan the turn for the line that was asked for. A failed turn
  // carries no messages, so this reads empty without needing a guard.
  const inventoryText = inventory.added.filter(m => m.role === 'assistant' && /TOOLS\s*=/.test(m.content)).at(-1)?.content
    ?? lastAssistantText(inventory.added)
  // Kept WHOLE on purpose: this list IS the evidence that the mint reached the
  // model — `mcp__my_server_v2__…` and `mcp__server-<hash>__…` are the two F3
  // names, and truncating it would throw away the only place a user-visible
  // wire name appears at all (G5 deviation log).
  //
  // It used to be sliced at 2 000 characters, which on this fixture profile cut
  // the evidence off BEFORE the names it exists to show: the `t-tracker`
  // built-in alone contributes ~60 tool names, and every recorded
  // `*-model-reported-surface` observation ended mid-`t-tracker` at exactly
  // 2 000. The checks read the full text, so a red and a green looked
  // identical in the report and the difference between them was unreadable.
  run.observe(`${name}-model-reported-surface`, inventoryText || '(no answer)')
  const surface = modelSurfaceExpectations(runtime.id)
  // Pi/claude: the wire, case-insensitively, exactly as before F1.153. Codex:
  // the model's OWN spelling, exactly — a model that answers with the host's
  // spelling instead is a different product fact, recorded below, not a pass.
  const sawEchoTool = runtime.id === 'codex'
    ? inventoryText.includes(surface.echo)
    : new RegExp(EXPECTED.pluginEchoWire.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(inventoryText)
  run.check(
    `${runtime.label}: the model reports the fixture MCP tool among its own tools`,
    sawEchoTool,
    sawEchoTool ? undefined : `the model's TOOLS line did not mention ${runtime.id === 'codex' ? surface.echo : EXPECTED.pluginEchoWire} — recorded, not fatal to the tool call below`,
  )
  // The two F3 names, asserted against the model's own list rather than left as
  // prose in a report: `my server.v2` must arrive sanitized and `мой сервер`
  // must arrive as the `server-<hash>` fallback, both as `mcp__<wire>__whoami`.
  // A change to either SHAPE now fails a check instead of quietly changing a
  // sentence — and this is the only surface where a wire name is visible at all
  // (G5 deviation log), so it is the only place either can be asserted live.
  // Names are runtime-shaped, and on the MODEL's side (see modelToolName): the
  // codex model's list spells them without a prefix and with underscores, so
  // asking it for the host's `mcp__sources__…` read `TOOLS=NONE` (F1.153).
  for (const [label, expected] of [
    ['sanitized', surface.sanitized],
    ['hash-fallback', surface.hashFallback],
  ] as const) {
    const found = typeof expected === 'string'
      ? (inventoryText.includes(expected) ? expected : undefined)
      : expected.exec(inventoryText)?.[0]
    run.check(
      `${runtime.label}: the model's tool list carries the F3 ${label} name`,
      Boolean(found),
      found ?? `no ${label} name matching ${String(expected)} in the model's TOOLS line`,
    )
    if (found) run.observe(`${name}-f3-${label}`, found)
  }
  const skillLine = /SKILL\s*=\s*(YES|NO)/i.exec(inventoryText)?.[1]
  run.observe(`${name}-model-reported-skill`, skillLine ?? '(not answered)')
  run.check(
    `${runtime.label}: the model reports the plugin's bundled skill as available`,
    skillLine?.toUpperCase() === 'YES',
    skillLine ? `SKILL=${skillLine}` : 'the model did not answer the SKILL line',
  )

  // ---- the tool call, a REQUEST of its own ---------------------------------
  // On a deferral-aware arm this is the request the selection turn above loaded
  // for: `mcp__tool_load` arms the tool for the next `handlePrompt`, never for
  // the one it ran in.
  const since = Date.now()
  const expectedTool = expectedEchoTool
  // The name the model is asked for, and the name the host will record: one
  // name on pi/claude, two on codex. Recorded every run, so the divergence
  // F1.155 owns is a reading in each report and never an assumption.
  run.observe(`${name}-model-vs-host-name`, { model: surface.echo, host: expectedTool, differ: surface.echo !== expectedTool })
  const approver = approvePermissionsWhile(session, key.sessionId)
  const rowsBefore = (await transcript(session, key)).length // F1.521: the fallback's baseline, read before the send
  const turn = await sendPrompt(session, key, callPrompt(runtime.id), 240_000).then(turnAttempt).catch(turnFailure)
  run.observe(`${name}-permissions-approved-mid-turn`, await approver.stop())
  if (turn.error) run.observe(`${name}-turn-error`, turn.error)
  // THIS turn's messages, not the session's. A turn that threw carries none, so
  // fall back to the rows since the send and say so (F1.521 — the whole
  // transcript let an earlier turn's tool call satisfy a check about this one).
  const scanned = await turnRowsSince(() => transcript(session, key), turn.added, rowsBefore)
  if (turn.added.length === 0) run.observe(`${name}-scan-scope`, 'the rows since the send (it threw, so it handed back none)')

  const toolMessages = mcpToolMessages(scanned)
  run.observe(`${name}-mcp-tool-calls`, toolMessages.map(m => ({ tool: m.toolName, status: m.toolStatus })))
  // Every read below is keyed on THIS tool, by exact name. The nonce check used
  // to scan any `mcp__*` message, which would have accepted a nonce from some
  // other server's call — not what the checklist row claims.
  const mintedCalls = toolMessages.filter(m => m.toolName === expectedTool)
  const calledUnderMint = mintedCalls.length > 0
  run.check(
    `${runtime.label}: the app dispatched ${expectedTool}`,
    calledUnderMint,
    calledUnderMint
      ? undefined
      : `tool names seen: ${JSON.stringify(toolMessages.map(m => m.toolName))}`
        + (selectionMissedEchoTool
          ? ` — and the selection turn's own load result never named ${expectedTool}, so this turn asked for a tool `
            + 'that was never put on the surface: read `-selection-turn` before reading this as a dispatch defect'
          : ''),
  )

  // Ground truth from the server itself, watermarked to this runtime's turn.
  // OBSERVED, not checked, for the plugin server: its process is sandboxed to
  // its own plugin data root and cannot write the fixture log. The two NATIVE
  // servers' entries in the same file are the positive control that the
  // logging mechanism works — without one, "the server logged nothing" would
  // be an absence with no meaning.
  run.observe(`${name}-plugin-server-log-calls`, probeToolCalls(PROBE_LABEL, since))
  run.observe(`${name}-log-positive-control`, {
    nativeLinesEver: probeCalls().filter(c => c.label.startsWith('scoped-')).length,
    note: 'plugin MCP processes are sandboxed to their plugin data root, so the fixture log is native-only',
  })

  const answer = lastAssistantText(scanned)
  // The per-call nonce: minted inside the server process at call time, present
  // in no file, so it cannot be read or guessed. `toolResult` is written by the
  // app from the MCP response, so a nonce there means a server answered.
  const nonce = mintedCalls.map(m => /nonce=([0-9a-f]{12})/.exec(m.toolResult ?? '')?.[1]).find(Boolean)
  run.observe(`${name}-answer`, answer.slice(0, 300))
  run.observe(`${name}-tool-result`, (mintedCalls.find(m => m.toolResult)?.toolResult ?? '(no tool result)').slice(0, 200))
  run.check(
    `${runtime.label}: the tool RESULT carried a fresh per-call nonce back into the turn`,
    Boolean(nonce),
    nonce ? `nonce=${nonce}` : 'no tool result carried a nonce — nothing proves a server answered',
  )
  run.check(
    `${runtime.label}: the model's reply carries what the tool returned`,
    Boolean(nonce) && answer.includes(nonce!),
    nonce && answer.includes(nonce) ? undefined : `reply did not carry the nonce: ${answer.slice(0, 200)}`,
  )
  // The token is expected to be REDACTED in the reply — the runtime scrubs a
  // server's own declared credential values out of tool output. Recorded rather
  // than asserted: the fixture bakes the token in precisely to avoid depending
  // on it, and this observation is what keeps the next reader from re-deriving
  // that lesson the hard way.
  run.observe(`${name}-token-visible-in-reply`, answer.includes(token))
  // Exercised. A failure here is a FAILURE, already on `run.checks` — not a
  // gap: a gap means "this runtime was never driven", and conflating the two is
  // how a red result launders itself into "could not run".
  return undefined
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
