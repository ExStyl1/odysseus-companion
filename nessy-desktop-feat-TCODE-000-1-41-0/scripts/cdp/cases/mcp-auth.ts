/**
 * MCP-AUTH — MCP authorization, measured on the two paths that are NOT the
 * elicitation bridge: an http server whose sign-in the APP itself drives over
 * OAuth (figma, `authType: oauth` + `oauthResource` in the plugin manifest),
 * and the built-in dp-backed servers, which carry no credentials of their own
 * and hang off the workspace's dp session.
 *
 * ## What each half must prove (VERIFICATION-STATE.md § 4)
 *
 * Figma half:
 *   1. HONEST STATUS before sign-in: the app's own pending-auth summary
 *      (`getWorkspacePendingAuth`, the data source of the "Some sources need
 *      sign-in" notice) names the figma source with a reason.
 *   2. NEGATIVE CONTROL before sign-in: a real tool call against the figma
 *      server fails or the tool surface is absent — measured in a session, not
 *      inferred from the summary.
 *   3. After the OWNER completes the OAuth round (the harness never signs in
 *      for them — that is a browser login on their account): the summary row
 *      is gone, and the server ANSWERS — a real `tools/call` whose result the
 *      app could not have fabricated. The witness is the server's answer
 *      reaching the transcript, never our own log.
 *
 * Dp half:
 *   4. With the dp session NOT in `needs-login`, an ENABLED built-in dp server
 *      is materialized and a real call returns corp data (default probe:
 *      dpGitlab whoami — the caller's own username from the corp service).
 *      This is the live positive of the narrow gate at
 *      `runtime-pool-servers.ts` (`dpSessionState === 'needs-login'` is the
 *      ONLY state that withholds builtins — owner decision 2026-08-06); the
 *      needs-login negative would require logging the operator out and stays
 *      with the unit suite (`builtin-dp-servers.test.ts`,
 *      `runtime-pool-servers.test.ts`).
 *
 * ## BOTH arms go through the deferred-MCP surface (dp: T12; figma: T16)
 *
 * MATERIALIZED IS NOT REGISTERED, and this case read the two as one word until
 * the 1.31.0 close-out measured it (`docs/testing/cdp-runs/2026-08-21-1.31.0-close-out.md`,
 * MCP-AUTH 3/4). Since deferral became the default, a session whose MCP tool
 * count crosses `PI_DEFERRED_MCP_TOOL_THRESHOLD`
 * (`shared/src/agent/pi-harness/harness-manifest.ts`, 48) hides every unpinned
 * MCP tool behind `mcp__tool_search`/`mcp__tool_load`
 * (`pi-agent-server/src/deferred-mcp-tools.ts`) — and the operator profile is
 * always past it (that run measured "20 total (55 deferred MCP tools hidden)").
 * A prompt that just names the tool then answers `NO-DP-TOOL` about a server
 * that is connected, materialized and one `tool_load` away, and the case
 * reported it as the built-in being disabled.
 *
 * **The figma arm failed the same way and was scoped out of T12 by instruction:**
 * `Tool mcp__plugin_figma_figma__get_metadata not found` while
 * `mcpHealth.connected` named `plugin_figma_figma` — an unauthenticated-looking
 * failure that had nothing to do with OAuth. T16 applies T12's identical
 * pattern to it. What the deferral fix does NOT touch is the OAuth precondition:
 * when figma is genuinely not signed in, the arm still reports its honest
 * negative control and BLOCKS with the owner action named. All the fix removes
 * is the false "the tool is not in my list" answer while the server is connected.
 *
 * So both probes drive the app's OWN path — search, load, then call — which is
 * the same route a user's turn takes, and it is deliberately NOT the
 * `alwaysLoad` pin the ELC fixture uses: ELC tests elicitation and pins the
 * probe out of the way, while THIS case is about servers the operator enabled
 * and signed into, whose registration is the product behaviour under test.
 *
 * **It takes TWO turns — a shape measured before F1.803 and kept after it.**
 * Measured 2026-08-21 in one session: the model searched, loaded (the load tool
 * reported success, naming `mcp__dpGitlab__dp_gitlab_whoami`), then called the
 * tool nine seconds later in a separate model turn and got `Tool
 * mcp__dpGitlab__dp_gitlab_whoami not found` — twice; the SAME tool, called on
 * the next user request in the SAME session, ran and returned the corp identity.
 * F1.803 (`722c67605`, 2026-09-25) found why: the live session's `tools`
 * allowlist filtered out every tool `mcp__tool_load` registered mid-request. The
 * allowlist now also names the loadable candidates and Pi re-reads the active
 * set before every model call, so a loaded tool is callable from the NEXT STEP
 * of the same request (never inside the load's own batch of tool calls) and
 * stays selected afterwards. The second turn is therefore no longer required;
 * it is kept because every earlier run measured this shape, and it still holds.
 *
 * **This case pins NO wording of the load tool's own message, and must not.**
 * The 2026-08-21 run believed it was the pre-T15 "MCP tools available on the
 * next model turn of this request"; T15 (2026-08-21) made it "MCP tools loaded
 * and available from the user's next message (not callable in this request)",
 * and F1.803 "Tools loaded and callable from your next step (not in the same
 * batch of tool calls as this load)". T12's header quoted the first as current
 * (corrected by T16), and this header the second (corrected by F1.836). What
 * the arms assert is the MECHANISM (load in turn one, call in turn two), so no
 * wording change can make this case lie; the load result is only ever
 * OBSERVED, never matched.
 *
 * The absence branch is no longer the model's word either. `mcpHealth.connected`
 * off the session's own Pi harness snapshot (`getPiHarnessRuntime` →
 * `McpClientPool.health`) says whether the server is connected in this session
 * at all, which is precisely "genuinely absent" vs "merely deferred"; the
 * assertions themselves are unchanged and still unfakeable — the corp service's
 * own answer, and figma's own answer, reached through a real `tools/call`.
 *
 * ## Preconditions the case will not create
 *
 * - The figma plugin installed (it ships the `figma` MCP server declaration).
 * - For (4): at least one built-in dp server ENABLED in settings — the case
 *   names the toggle rather than flipping it; enabling is an operator action.
 * - For (3): the owner has pressed Connect and finished the browser OAuth.
 *   Until then the case reports the measurable halves and BLOCKS on the rest,
 *   naming exactly what is missing.
 *
 * ## The default figma probe is `whoami`, not `get_metadata` (T16, 2026-08-21)
 *
 * `get_metadata` cannot be the arm's post-auth positive, and the deferral fix is
 * what made that visible: with the tool finally reachable, the call died at
 * Pi's OWN argument validation — `Validation failed for tool
 * "mcp__plugin_figma_figma__get_metadata": - fileKey: must have required
 * properties fileKey`, thrown by `validateToolCall` before anything left the
 * client. The remote (OAuth) figma server is not the desktop one: 31 of its 32
 * tools require a `fileKey` or a node id, i.e. a real Figma file the harness
 * cannot invent. A local schema refusal is NOT the server answering, so it can
 * never satisfy "the witness is the server's answer".
 *
 * `whoami` is the one that can, and it is the same probe shape the dp half
 * already uses (`dp_gitlab_whoami`): no arguments, and an answer only an
 * AUTHENTICATED server can give — which is exactly what this arm is measuring.
 * The arm still refuses to fake it: if an override names a tool whose arguments
 * the harness does not have, the local-validation refusal is reported as a
 * BLOCK naming the knob, never as the figma server failing.
 *
 * Env overrides: NESSY_CDP_FIGMA_TOOL / _ARGS / _EXPECT (the post-auth real
 * call; default `whoami` with no args), NESSY_CDP_DP_WIRE / _TOOL / _EXPECT
 * (the dp probe).
 */

import { lastAssistantText, sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { approvePermissionsWhile } from '../lib/ask-user.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import {
  assertElectronApi,
  freshSession,
  listSessions,
  piReadNote,
  piRuntime,
  type PiRuntime,
  sessionCommand,
  transcript,
  waitFor,
  type SessionKey,
  type TranscriptMessage,
} from '../lib/state.ts'
import { checkAbsence, positive, turnRowsSince } from '../lib/turn-evidence.ts'

/** Both probe turns force real MCP calls; Explore's write gate must not
 * pre-empt the auth question this case is actually asking. */
async function bypassPermissions(session: CdpSession, sessionId: string): Promise<void> {
  await sessionCommand(session, sessionId, { type: 'setPermissionMode', mode: 'bypassPermissions' }).catch(() => undefined)
  await waitFor(
    async () => (await listSessions(session)).find(s => s.id === sessionId)?.permissionMode,
    value => value === 'bypassPermissions',
    { timeoutMs: 20_000, intervalMs: 1_000, label: 'bypassPermissions to take effect' },
  ).catch(() => undefined)
}

const ID = 'MCP-AUTH'
const TITLE = 'MCP authorization: the app-driven OAuth path (figma) is honest before sign-in and answers after; built-in dp servers answer outside needs-login'

/** See the header: `get_metadata` needs a `fileKey`; `whoami` needs nothing and
 * only an authenticated server can answer it. */
const FIGMA_TOOL = process.env.NESSY_CDP_FIGMA_TOOL ?? 'whoami'
const FIGMA_ARGS = process.env.NESSY_CDP_FIGMA_ARGS ?? ''
const FIGMA_EXPECT = process.env.NESSY_CDP_FIGMA_EXPECT
const DP_WIRE = process.env.NESSY_CDP_DP_WIRE ?? 'dpGitlab'
const DP_TOOL = process.env.NESSY_CDP_DP_TOOL ?? 'dp_gitlab_whoami'
/** Something the corp service knows and the app does not invent: the login. */
const DP_EXPECT = new RegExp(process.env.NESSY_CDP_DP_EXPECT ?? 'gavrikov', 'i')

/**
 * The two model-facing tools of the deferred-MCP surface, verbatim from
 * `DEFERRED_MCP_TOOL_SEARCH_NAME` / `DEFERRED_MCP_TOOL_LOAD_NAME`
 * (`packages/pi-agent-server/src/deferred-mcp-tools.ts`). Not imported: this
 * harness drives the app from outside and must not link its subprocess bundle.
 */
const DEFERRED_SEARCH_TOOL = 'mcp__tool_search'
const DEFERRED_LOAD_TOOL = 'mcp__tool_load'

interface PendingAuthSummary {
  dp?: { serverNames: string[] } | null
  sources: Array<{ sourceSlug: string; name: string; reason: string }>
  failedServers: string[]
}

async function pendingAuth(session: CdpSession, workspaceId: string): Promise<PendingAuthSummary | null> {
  return await session.call<PendingAuthSummary | null>(`
    return (await window.electronAPI.getWorkspacePendingAuth?.(${JSON.stringify(workspaceId)})) ?? null
  `)
}

const isFigmaRow = (row: { sourceSlug: string; name: string }): boolean =>
  /figma/i.test(row.sourceSlug) || /figma/i.test(row.name)

/** The turn's MCP rows for a server whose wire name mentions `needle`. */
function mcpRowsFor(messages: TranscriptMessage[], needle: string): TranscriptMessage[] {
  return messages.filter(m =>
    typeof m.toolName === 'string' && m.toolName.startsWith('mcp__') && m.toolName.toLowerCase().includes(needle.toLowerCase()))
}

/** Rows for one exact tool name. Used for the two deferred-surface tools. */
function rowsNamed(messages: TranscriptMessage[], toolName: string): TranscriptMessage[] {
  return messages.filter(m => m.toolName === toolName)
}

interface DeferredLoadTurn {
  scanned: TranscriptMessage[]
  reply: string
  searchRows: TranscriptMessage[]
  loadRows: TranscriptMessage[]
  /** Every `mcp__tool_search` result concatenated — the deferred catalogue's own answer. */
  catalogueText: string
  error?: string
}

/**
 * TURN ONE of a deferred-aware probe: select the tool, never call it.
 *
 * Shared by both arms because both hit the same threshold — the mechanics are
 * identical and only the prompt's prose differs (the dp arm names an exact wire
 * tool, the figma arm names the SHAPE of one, because a plugin server's wire
 * name is decided by the install). The prompts stay written out at their call
 * sites for that reason: the dp arm's is byte-identical to the one T12 measured,
 * which is what makes it a regression control for T16's change.
 *
 * A failed turn is data, not a throw: the caller reports what it reached.
 */
async function deferredLoadTurn(session: CdpSession, key: SessionKey, prompt: string): Promise<DeferredLoadTurn> {
  const rowsBefore = (await transcript(session, key)).length // F1.521: the fallback's baseline, read before the send
  const turn = await sendPrompt(session, key, prompt, 240_000)
    .then(r => ({ added: r.added, error: undefined as string | undefined }))
    .catch(cause => ({ added: [] as TranscriptMessage[], error: cause instanceof Error ? cause.message : String(cause) }))
  const scanned = await turnRowsSince(() => transcript(session, key), turn.added, rowsBefore)
  const searchRows = rowsNamed(scanned, DEFERRED_SEARCH_TOOL)
  const loadRows = rowsNamed(scanned, DEFERRED_LOAD_TOOL)
  return {
    scanned,
    reply: lastAssistantText(scanned),
    searchRows,
    loadRows,
    catalogueText: searchRows.map(m => m.toolResult ?? '').join('\n'),
    ...(turn.error ? { error: turn.error } : {}),
  }
}

interface McpPoolHealth {
  /** False when this session runs a non-Pi runtime, or the snapshot is absent. */
  available: boolean
  reason?: string
  status?: string
  connected: string[]
  failed: string[]
}

/**
 * Whether the dp server is CONNECTED in this session's own MCP pool.
 *
 * The host-side half of the absent-vs-deferred question, read off the same
 * snapshot the agent panel reads (`getPiHarnessRuntime` →
 * `McpClientPool.health(leaserId)`, whose `connected` is keyed by wire name).
 * A model saying `NO-DP-TOOL` cannot distinguish "the built-in is disabled"
 * from "the built-in is deferred and I did not look"; this read can, and it is
 * the app's own state rather than the case's narration.
 *
 * Degrades to `available: false` rather than throwing: on a Claude or Codex
 * session there is no Pi harness to ask, and the case still has the deferred
 * catalogue's own answer to fall back on.
 */
async function mcpPoolHealth(session: CdpSession, key: SessionKey): Promise<McpPoolHealth> {
  const runtime: PiRuntime = await piRuntime(session, key).catch((cause: unknown) => ({
    available: false,
    // D1.310 — the defensive fallback carries the same flag the helper's own
    // catch sets, so `piReadNote` below reports a failed read whichever of the
    // two produced it.
    readFailed: true,
    unavailableReason: `read-failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    children: [],
    pendingPermissions: [],
    raw: {} as Record<string, unknown>,
  }))
  // Keyed off `mcpHealth` itself, NOT off `snapshot.available`. That flag is
  // `!!managed.agent?.getHarnessDiagnostics?.()` — it says a Pi turn is live,
  // and it reads false between turns, which is exactly when this case looks.
  // `mcpHealth` is emitted from `managed.mcpPool` on the same snapshot and
  // survives the gap: measured 2026-08-21, `available:false,
  // unavailableReason:'pi-runtime-not-started'` alongside a perfectly good
  // `connected:["dpGitlab","plugin_figma_figma"]`. Reading the flag first threw
  // that answer away and blocked the case on "no Pi harness snapshot to ask".
  const health = (runtime.raw as { mcpHealth?: { status?: string; connected?: string[]; failed?: string[] } }).mcpHealth
  if (!health) {
    // D1.310 — a snapshot that could not be READ is named as such. Without it
    // this reason reads as "no MCP pool on this session", which is a statement
    // about the product made out of an instrument failure.
    const note = piReadNote(runtime)
    return {
      available: false,
      reason: note.readFailed
        ? `THE SNAPSHOT READ FAILED (${runtime.unavailableReason ?? 'no reason reported'}) — the pool was not measured; see \`rs-56.ts\``
        : runtime.unavailableReason ?? 'the snapshot carries no mcpHealth (no MCP pool on this session)',
      connected: [],
      failed: [],
    }
  }
  return {
    available: true,
    ...(health.status ? { status: health.status } : {}),
    connected: [...(health.connected ?? [])],
    failed: [...(health.failed ?? [])],
  }
}

const namesServer = (names: string[], wire: string): boolean =>
  names.some(name => name.toLowerCase() === wire.toLowerCase())

/**
 * The figma server is matched by SHAPE, not by an exact wire name: the name a
 * plugin's MCP server takes is decided by the install (`plugin_figma_figma` on
 * the operator profile), and hard-coding it would report "absent" on a
 * perfectly good install that happened to name it differently.
 */
const FIGMA_WIRE = /figma/i
const namesMatching = (names: string[], pattern: RegExp): string[] => names.filter(name => pattern.test(name))

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  run.observe('session', { workspaceId: key.workspaceId, sessionId: key.sessionId })
  run.observe('session-origin', key.fresh ? 'created by this run' : `CONTAMINATED: ${key.reason}`)
  run.require('the case ran in a session it created', key.fresh, key.fresh ? undefined : String(key.reason))

  // ---- 1. the app's own pending-auth summary --------------------------------
  const summary = await pendingAuth(session, key.workspaceId)
  run.observe('pending-auth-summary', summary)
  if (!summary) blocked('getWorkspacePendingAuth returned nothing — this build predates the pending-auth surface')
  const figmaRow = summary.sources.find(isFigmaRow)
  const figmaSignedIn = !figmaRow

  if (figmaRow) {
    run.check(
      'figma half, honest status: before sign-in the app\'s own summary names the figma source and why',
      Boolean(figmaRow.reason),
      `sourceSlug=${figmaRow.sourceSlug} reason=${figmaRow.reason}`,
    )
  } else {
    run.observe('figma-pending', 'absent — treating this run as POST-sign-in and measuring the positive half')
  }

  // ---- 2. the call itself, in a real session --------------------------------
  // Pre-auth this is the NEGATIVE CONTROL (the very call that must succeed
  // after sign-in must fail now); post-auth it is the positive proof. One
  // prompt shape for both, so the two runs differ only in the app's auth state.
  await bypassPermissions(session, key.sessionId)
  const approver = approvePermissionsWhile(session, key.sessionId)

  // TURN ONE — select, do not call. Same two-turn shape as the dp arm below and
  // for the same reason: on this profile the figma tools are deferred, and a
  // tool must be LOADED before any call. Without this turn the arm asked for a tool
  // the session had not registered and read the resulting `Tool
  // mcp__plugin_figma_figma__get_metadata not found` as an auth failure — while
  // `mcpHealth.connected` named the server. The prompt names the tool by SHAPE
  // rather than by wire name (see FIGMA_WIRE), and is ONE LINE, like every
  // prompt here: the composer swallows a newline outright and `sendPrompt`'s
  // read-back then refuses the prompt with `composer-mismatch`.
  const figmaLoad = await deferredLoadTurn(
    session,
    key,
    `Do NOT call any figma tool in this turn. If a tool whose name contains "figma" and ends with `
    + `"__${FIGMA_TOOL}" is already in your tool list, reply with exactly FIGMA-TOOL-READY. Otherwise it may be `
    + `deferred rather than absent, so: (1) call ${DEFERRED_SEARCH_TOOL} with query "figma ${FIGMA_TOOL}"; (2) if the `
    + `result names such a tool, call ${DEFERRED_LOAD_TOOL} with that exact tool name and then reply with exactly `
    + `FIGMA-TOOL-LOADED; (3) if the result names no such tool, or ${DEFERRED_SEARCH_TOOL} does not exist either, `
    + 'reply with exactly NO-FIGMA-TOOL. Do not read any files.',
  )
  if (figmaLoad.error) run.observe('figma-load-turn-error', figmaLoad.error)
  const figmaCatalogued = figmaLoad.searchRows.length > 0
    ? new RegExp(`mcp__[a-z0-9_]*figma[a-z0-9_]*__${FIGMA_TOOL}`, 'i').test(figmaLoad.catalogueText)
    : undefined
  run.observe('figma-load-turn', {
    reply: figmaLoad.reply.slice(0, 200),
    searched: figmaLoad.searchRows.length,
    loaded: figmaLoad.loadRows.length,
    catalogueNamesTool: figmaCatalogued,
    // OBSERVED, never matched: T15 rewrote this text and a later task may again.
    loadResults: figmaLoad.loadRows.map(m => (m.toolResult ?? '').slice(0, 160)),
  })

  // TURN TWO — the call. Unchanged from the arm this task inherited.
  const rowsBefore = (await transcript(session, key)).length // F1.521: the fallback's baseline, read before the send
  const turn = await sendPrompt(
    session,
    key,
    `Call the MCP tool whose name contains "figma" and ends with "__${FIGMA_TOOL}"${FIGMA_ARGS ? ` with ${FIGMA_ARGS}` : ' with no arguments'}. `
    + 'If no such tool exists in your tool list, reply with exactly NO-FIGMA-TOOL. '
    + 'If the call fails, reply FIGMA-FAILED plus the error text, verbatim. '
    + 'Otherwise reply with exactly what the tool returned. Do not read any files.',
    240_000,
  ).then(r => ({ added: r.added, error: undefined as string | undefined }))
    .catch(cause => ({ added: [] as TranscriptMessage[], error: cause instanceof Error ? cause.message : String(cause) }))
  run.observe('figma-approved-cards', await approver.stop())
  if (turn.error) run.observe('figma-turn-error', turn.error)

  const scanned = await turnRowsSince(() => transcript(session, key), turn.added, rowsBefore)
  const figmaTools = mcpRowsFor(scanned, 'figma')
  const reply = lastAssistantText(scanned)
  run.observe('figma-mcp-rows', figmaTools.map(m => ({ tool: m.toolName, status: m.toolStatus, result: (m.toolResult ?? '').slice(0, 200) })))
  run.observe('figma-reply', reply.slice(0, 400))

  // ABSENT vs merely DEFERRED vs UNAUTHENTICATED — three states the model's own
  // word cannot separate, and the arm used to collapse all three into "not in
  // my tool list". The app's own snapshot separates the first from the other
  // two; the sign-in summary above separates the third.
  const figmaHealth = await mcpPoolHealth(session, key)
  const figmaConnected = figmaHealth.available ? namesMatching(figmaHealth.connected, FIGMA_WIRE).length > 0 : undefined
  run.observe('figma-pool-health', figmaHealth)
  run.observe('figma-reached-by', figmaTools.length === 0
    ? 'the tool was never called'
    : figmaLoad.loadRows.length > 0
      ? `${DEFERRED_SEARCH_TOOL} → ${DEFERRED_LOAD_TOOL} → the tool on the next request (deferred)`
      : 'called directly — registered on the session surface, below the deferral threshold')
  // A negative control is only as strong as the reachability of the thing it
  // says failed: "the call did not succeed" proves nothing about AUTH if the
  // server was never there. Recorded rather than asserted, because a weak
  // negative is still an honest one.
  const figmaReachable = figmaConnected === true || figmaCatalogued === true || figmaTools.length > 0
  run.observe('figma-reachable', {
    reachable: figmaReachable,
    connectedServers: figmaHealth.available ? namesMatching(figmaHealth.connected, FIGMA_WIRE) : 'unknown',
    failedServers: figmaHealth.available ? namesMatching(figmaHealth.failed, FIGMA_WIRE) : 'unknown',
    catalogueNamesTool: figmaCatalogued ?? 'not searched',
  })
  // A LOCAL refusal is not the server answering. Pi validates a tool call's
  // arguments against the tool's own schema and THROWS before dispatch
  // (`validateToolCall`, pi-ai), so this row means the figma server never saw
  // the request — it can satisfy neither half of this arm.
  const localRefusal = figmaTools.find(m => /^Validation failed for tool /.test((m.toolResult ?? '').trim()))
  const localRefusalNote = 'the call never left the client: Pi\'s own validateToolCall refused the arguments — '
    + `"${(localRefusal?.toolResult ?? '').split('\n').slice(0, 2).join(' ').trim()}". That is a missing INPUT, not a `
    + `figma verdict. Set NESSY_CDP_FIGMA_ARGS to arguments ${FIGMA_TOOL} accepts, or NESSY_CDP_FIGMA_TOOL to a figma `
    + 'tool the harness can call with none (the default, `whoami`, is one), and re-run.'
  const notThere =
    `the figma MCP server is in neither this session's tool surface nor its deferred capability catalogue`
    + `${figmaHealth.available ? ` (mcpHealth.connected=${JSON.stringify(figmaHealth.connected)})` : ` (no mcpHealth to ask: ${figmaHealth.reason ?? 'unknown'})`}`
    + ' — that is the PRECONDITION this case does not create, not an auth verdict: install/enable the figma plugin '
    + '(it ships the figma MCP server declaration) and re-run.'

  // The dp half below is INDEPENDENT of figma's sign-in state, so a missing
  // OAuth must not cost its measurement — the block is deferred to the end.
  let figmaBlockReason: string | undefined
  if (!figmaSignedIn) {
    const succeeded = figmaTools.some(m => m.toolStatus === 'completed' && !/error|fail/i.test(m.toolResult ?? ''))
    // F1.504 — the positive is read off THIS turn's rows only: when the send
    // threw, `scanned` is the rows since it (F1.521), and an empty turn
    // "does NOT succeed" at anything.
    const ownFigma = mcpRowsFor(turn.added, 'figma')
    const ownReply = lastAssistantText(turn.added)
    checkAbsence(
      run,
      'figma half, negative control: before sign-in the same call does NOT succeed',
      !succeeded && (reply.includes('NO-FIGMA-TOOL') || reply.includes('FIGMA-FAILED') || figmaTools.length === 0
        || figmaTools.every(m => m.toolStatus !== 'completed' || /error|fail/i.test(m.toolResult ?? ''))),
      positive(ownFigma.length > 0 || ownReply.trim().length > 0, 'figma call or reply in this turn',
        `${ownFigma.length} figma row(s); ${ownReply.trim().length} chars of reply; turn error ${turn.error ?? 'none'}`),
      `rows=${figmaTools.length} reachable=${figmaReachable} reply=${reply.slice(0, 120)}`,
    )
    figmaBlockReason =
      'figma OAuth needs the OWNER: press Connect on the "Some sources need sign-in" notice (or Sources → figma) and '
      + 'finish the browser OAuth on the figma account, then re-run this case — it will then require the summary row '
      + 'to be gone and the SAME call to succeed. The harness never performs a browser login. (The dp half above this '
      + `block WAS measured.)${figmaReachable ? '' : ` NOTE: ${notThere} So the negative control above is the weak `
      + 'kind — it says the call did not succeed, not that authorization is what stopped it.'}`
      + (localRefusal ? ` NOTE: ${localRefusalNote} So is this negative — the call never reached figma.` : '')
  } else if (localRefusal) {
    // Signed in, the tool was reached, and the call died in OUR client. The
    // arm has no verdict about figma to give, and inventing one from a local
    // schema error is exactly the false product defect T16 exists to remove.
    run.check(
      'figma half, after sign-in: the pending-auth summary no longer names figma',
      figmaSignedIn,
    )
    figmaBlockReason = `${localRefusalNote} (Deferral is NOT the blocker: the probe reached `
      + `${localRefusal.toolName} through ${figmaLoad.loadRows.length > 0 ? 'search → load → next request' : 'the session surface'}. `
      + 'The dp half above this block WAS measured.)'
  } else if (figmaTools.length === 0 && !figmaReachable) {
    // Signed in, and the server is not in the session at all. Asserting "it
    // ANSWERS" here would report a product defect for a missing precondition,
    // which is the exact mistake T12 found on the dp arm.
    run.check(
      'figma half, after sign-in: the pending-auth summary no longer names figma',
      figmaSignedIn,
    )
    figmaBlockReason = `${notThere} (The dp half above this block WAS measured.)`
  } else {
    // ---- 3. post-sign-in: the server answers --------------------------------
    run.check(
      'figma half, after sign-in: the pending-auth summary no longer names figma',
      figmaSignedIn,
    )
    const answered = figmaTools.find(m => m.toolStatus === 'completed' && (m.toolResult ?? '').length > 0)
    run.check(
      'figma half, after sign-in: the figma server ANSWERS a real tools/call — the result is the server\'s, not our log\'s',
      Boolean(answered) && !reply.includes('NO-FIGMA-TOOL'),
      answered
        ? `${answered.toolName} → ${(answered.toolResult ?? '').slice(0, 120)}`
        : `no completed figma row; connected=${figmaConnected === undefined ? 'unknown' : String(figmaConnected)}`
          + `, catalogue names it=${figmaCatalogued === undefined ? 'not searched' : String(figmaCatalogued)}`
          + `, loaded=${figmaLoad.loadRows.length}; reply=${reply.slice(0, 120)}`,
    )
    if (FIGMA_EXPECT) {
      const expect = new RegExp(FIGMA_EXPECT)
      run.check(
        `figma half: the result carries the operator-named marker ${String(expect)}`,
        expect.test(answered?.toolResult ?? ''),
      )
    }
  }

  // ---- 4. the dp half -------------------------------------------------------
  // `summary.dp` present means the workspace's dp-backed servers are waiting on
  // a dp sign-in (needs-login). The builtins-withheld state is exactly then, so
  // a present row makes the positive half unmeasurable — and that is a BLOCK
  // with the owner's action named, not a failure.
  if (summary.dp) {
    blocked(
      `dp needs sign-in (${summary.dp.serverNames.length} server(s) waiting) — run the gateway sign-in first, then `
      + 're-run. The withheld state itself is pinned by the unit suite; this case measures the READY side live.',
    )
  }
  const dpKey = await freshSession(session, `CDP ${ID}-dp ${new Date().toISOString().slice(11, 19)}`)
  run.require('the dp probe ran in its own fresh session', dpKey.fresh, dpKey.reason)
  await bypassPermissions(session, dpKey.sessionId)
  const dpApprover = approvePermissionsWhile(session, dpKey.sessionId)
  const dpWireTool = `mcp__${DP_WIRE}__${DP_TOOL}`
  // Deferral-aware BY THE APP'S OWN PATH, in TWO turns.
  //
  // Turn 1 SELECTS the tool and is forbidden to call it: on a profile past the
  // threshold that means `mcp__tool_search` → `mcp__tool_load`, and on one below
  // it means answering that the tool is already there. Turn 2 CALLS it. The
  // split was the product's contract until F1.803 (a same-request call answered
  // `Tool … not found` however honestly it was loaded); since then a loaded tool
  // is callable from the next step, and the split is kept — see the header note.
  //
  // Every prompt here is ONE LINE deliberately: the composer's contenteditable
  // swallows a newline outright rather than collapsing it to a space, so
  // `sendPrompt`'s normalised read-back refuses a multi-line prompt with
  // `composer-mismatch` — measured on this very prompt, 2026-08-21.
  const dpLoad = await deferredLoadTurn(
    session,
    dpKey,
    `Do NOT call the MCP tool ${dpWireTool} in this turn. If ${dpWireTool} is already in your tool list, reply with `
    + `exactly DP-TOOL-READY. Otherwise it may be deferred rather than absent, so: (1) call ${DEFERRED_SEARCH_TOOL} `
    + `with query "${DP_TOOL}"; (2) if the result names ${dpWireTool}, call ${DEFERRED_LOAD_TOOL} with name `
    + `"${dpWireTool}" and then reply with exactly DP-TOOL-LOADED; (3) if the result does NOT name it, or `
    + `${DEFERRED_SEARCH_TOOL} does not exist either, reply with exactly NO-DP-TOOL. Do not read any files.`,
  )
  if (dpLoad.error) run.observe('dp-load-turn-error', dpLoad.error)
  const { searchRows, loadRows, catalogueText } = dpLoad
  run.observe('dp-load-turn', {
    reply: dpLoad.reply.slice(0, 200),
    searched: searchRows.length,
    loaded: loadRows.length,
    catalogueNamesTool: catalogueText.includes(dpWireTool),
    // OBSERVED, never matched — see the header note on T15's rewording.
    loadResults: loadRows.map(m => (m.toolResult ?? '').slice(0, 160)),
  })

  const dpRowsBefore = (await transcript(session, dpKey)).length // F1.521: the fallback's baseline, read before the send
  const dpTurn = await sendPrompt(
    session,
    dpKey,
    `Call the MCP tool ${dpWireTool} with no arguments, then reply with exactly what it returned. `
    + 'If the tool is not in your tool list, reply with exactly NO-DP-TOOL. Do not read any files.',
    240_000,
  ).then(r => ({ added: r.added, error: undefined as string | undefined }))
    .catch(cause => ({ added: [] as TranscriptMessage[], error: cause instanceof Error ? cause.message : String(cause) }))
  run.observe('dp-approved-cards', await dpApprover.stop())
  if (dpTurn.error) run.observe('dp-turn-error', dpTurn.error)

  const dpScanned = await turnRowsSince(() => transcript(session, dpKey), dpTurn.added, dpRowsBefore)
  // `mcpRowsFor` matches on the wire name, so the two deferred-surface tools
  // (`mcp__tool_search`, `mcp__tool_load`) can never be mistaken for the probe.
  const dpRows = mcpRowsFor(dpScanned, DP_WIRE)
  const dpReply = lastAssistantText(dpScanned)
  const health = await mcpPoolHealth(session, dpKey)
  run.observe('dp-mcp-rows', dpRows.map(m => ({ tool: m.toolName, status: m.toolStatus, result: (m.toolResult ?? '').slice(0, 200) })))
  run.observe('dp-reached-by', dpRows.length === 0
    ? 'the tool was never called'
    : loadRows.length > 0
      ? `${DEFERRED_SEARCH_TOOL} → ${DEFERRED_LOAD_TOOL} → the tool on the next request (deferred)`
      : 'called directly — registered on the session surface, below the deferral threshold')
  run.observe('dp-pool-health', health)
  run.observe('dp-reply', dpReply.slice(0, 300))

  // ABSENT, not merely DEFERRED — and the two are separated by the app's own
  // state, never by the model's word. `mcpHealth.connected` is authoritative
  // when it can be read; when it cannot (a session with no MCP pool), the
  // deferred catalogue's own answer stands in, and a run that reached neither is
  // reported as the unmeasured thing it is instead of blocking on a guess.
  if (dpRows.length === 0) {
    const connected = health.available ? namesServer(health.connected, DP_WIRE) : undefined
    const catalogued = searchRows.length > 0 ? catalogueText.includes(dpWireTool) : undefined
    if (connected === false || (connected === undefined && catalogued === false)) {
      blocked(
        `${dpWireTool} is in neither the session's tool surface nor its deferred capability catalogue`
        + `${health.available ? ` (mcpHealth.connected=${JSON.stringify(health.connected)})` : ''}. Built-in dp `
        + `servers are all disabled by default — enable "${DP_WIRE}" in Settings → Sources (built-in dp set) and `
        + 're-run. The case does not flip operator settings itself.',
      )
    }
    if (connected === undefined && catalogued === undefined) {
      blocked(
        `the dp probe neither called ${dpWireTool} nor consulted ${DEFERRED_SEARCH_TOOL}, and this session's `
        + `snapshot carries no MCP pool health to ask (${health.reason ?? 'unknown'}) — so nothing here separates a `
        + `disabled built-in from a deferred one. Re-run with the dp probe on a Pi connection. `
        + `reply=${dpReply.slice(0, 120)}`,
      )
    }
    // Connected (or catalogued) and still not called: that is a real failure,
    // and it falls through to the check below, which says so.
  }
  const dpAnswer = dpRows.find(m => m.toolStatus === 'completed')?.toolResult ?? ''
  run.check(
    'dp half: an enabled built-in dp server is materialized outside needs-login and ANSWERS a real call',
    DP_EXPECT.test(dpAnswer) || DP_EXPECT.test(dpReply),
    `expected ${String(DP_EXPECT)}; result=${(dpAnswer || dpReply).slice(0, 160)}`
    + (dpRows.length === 0
      ? ` — no ${DP_WIRE} tool row at all; connected=${health.available ? String(namesServer(health.connected, DP_WIRE)) : 'unknown'}`
      + `, catalogue names it=${searchRows.length > 0 ? String(catalogueText.includes(dpWireTool)) : 'not searched'}`
      : ''),
  )

  if (figmaBlockReason) blocked(figmaBlockReason)
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
