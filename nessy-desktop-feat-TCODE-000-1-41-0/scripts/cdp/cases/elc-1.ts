/**
 * ELC-1 — an MCP server can ask the USER something, on every runtime.
 *
 * `036d30536` is brand-new behaviour and its defect is worth restating, because
 * the shape of the fix is the shape of this case. Q13-D1, measured on the
 * packaged 1.25.1: a probe server's `elicitation/create` was answered
 * `-32601 Method not found` on the Codex runtime in the same millisecond, while
 * the identical server on Pi got `elicitation: {form, url}` in the client's
 * capabilities and was held open awaiting the user. Claude shared the seam and
 * was untested.
 *
 * The capability is frozen at `initialize` — the vendored SDK refuses to send
 * `elicitation/create` at all without it — and the pool passed whatever handler
 * existed when it CONNECTED. On the shared workspace pool the connections are
 * made during session setup, before the agent that would register one exists, so
 * it was fixed as absent for the connection's life. **Wiring only the agents
 * would have passed its own tests and changed nothing live**, which is exactly
 * why this case exists: the seam that broke is the one between a unit test's
 * construction order and a real session's.
 *
 * ## The offline suite drives the same server; this drives the same USER
 *
 * `mcp/__tests__/mcp-pool-elicitation-routing.test.ts` runs a real MCP server
 * over a real transport with a fake user. Here the fixture server is the same
 * idea over stdio, and the user is the app's own `ask_user` card answered with a
 * real mouse click. Three assertions per runtime, each on a different surface so
 * one wrong detector cannot carry the case:
 *
 *   1. **the card really appears** — read out of the renderer, with its options,
 *      not inferred from "the turn did not fail";
 *   2. **the server gets an ACTION back** — read out of the transcript's tool
 *      result, which is the server's own report of what it received. `accept`
 *      with the user's value, never `refused:-32601`;
 *   3. **the client declared the capability on the wire** — read out of the
 *      SERVER's log of `initialize`, the one source the app cannot narrate for
 *      itself (AGENTS.md: confirm against a source the feature writes itself).
 *
 * A runtime with no connection on this host is NAMED and the case ends BLOCKED.
 * `scripts/cdp/README.md`: a gate that reports green while silently skipping a
 * runtime is worse than no gate, because the next person will trust it.
 */

import { lastAssistantText, sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { answerAskUserWhile, approvePermissionsWhile, type AskUserCard } from '../lib/ask-user.ts'
import { bundleFiles, resolveAppUnderTest, symbolsIn } from '../lib/bundle.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import {
  ELC_EXPECTED,
  ELC_FIXTURE,
  elicitHandshakes,
  elicitLogSince,
  elicitProxyToolName,
  elicitationPaths,
  readElicitationTokens,
  type ElicitLogEntry,
} from '../fixtures/elicitation.ts'
import { catalogRows, ensureDarkTheme, fixtureWorkspaceId } from '../lib/mcp-fixture.ts'
import {
  assertElectronApi,
  freshSession,
  listSessions,
  sessionCommand,
  transcript,
  waitFor,
  type TranscriptMessage,
} from '../lib/state.ts'
import { turnRowsSince } from '../lib/turn-evidence.ts'

const ID = 'ELC-1'
const TITLE = 'An MCP server asks the user, and gets an answer back — Pi, Claude runtime, Codex runtime'

/**
 * Symbols that must be IN THE SHIPPED HOST BUNDLE before anything is measured.
 *
 * The fix lives entirely in `packages/shared`, which esbuild bundles into the
 * Electron host: `mcp-pool.ts` (the per-client dispatcher and the leaser
 * registry), `base-agent.ts` (the bridge every backend now shares) and
 * `elicitation-ask-user.ts`. The Pi SUBPROCESS bundle does not carry it —
 * `pi-agent.ts` runs host-side and only talks to the subprocess — so this case
 * checks `dist/main.cjs` and reports the Pi bundle as context only.
 *
 * `scripts/cdp/README.md`: a source change is invisible to a CDP run until the
 * bundles are rebuilt and the app is relaunched, and the first AGT-1 run
 * measured yesterday's code and reported it as today's.
 */
const REQUIRED_HOST_SYMBOLS = [
  'registerElicitationHandler',
  'ElicitationAskUserBridge',
  'handleMcpElicitationWithAskUser',
]

interface RuntimeTarget {
  id: 'pi' | 'claude' | 'codex'
  /** `providerType`s that count as this runtime. */
  providerTypes: string[]
  label: string
}

const ALL_RUNTIMES: RuntimeTarget[] = [
  { id: 'pi', providerTypes: ['pi', 'pi_compat'], label: 'Pi' },
  { id: 'claude', providerTypes: ['claude-runtime'], label: 'Claude runtime' },
  { id: 'codex', providerTypes: ['codex-runtime'], label: 'Codex runtime' },
]

/** `NESSY_CDP_ELC_RUNTIMES=pi,codex` narrows the run; it still ends BLOCKED. */
const RUNTIMES: RuntimeTarget[] = (() => {
  const requested = (process.env.NESSY_CDP_ELC_RUNTIMES ?? '').split(',').map(v => v.trim()).filter(Boolean)
  if (requested.length === 0) return ALL_RUNTIMES
  return ALL_RUNTIMES.filter(runtime => requested.includes(runtime.id))
})()

interface Connection {
  slug: string
  providerType: string
}

/** A turn that ran, or a turn that threw — one shape, discriminated by `error`. */
interface TurnAttempt {
  added: TranscriptMessage[]
  error?: string
}

const turnAttempt = (turn: { added: TranscriptMessage[] }): TurnAttempt => ({ added: turn.added })
const turnFailure = (cause: unknown): TurnAttempt => ({
  added: [],
  error: cause instanceof Error ? cause.message : String(cause),
})

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  if (!readElicitationTokens()) {
    blocked(
      `no fixture tree at ${elicitationPaths().root} — run \`bun run scripts/cdp/fixtures/elicitation.ts\`, `
      + 'then start the app with NESSY_CONFIG_DIR=<root>/config and create the connections you want measured '
      + 'through the app\'s own one-click gateway card.',
    )
  }
  run.observe('theme', await ensureDarkTheme(session))

  // ---- the bundle carries the fix -----------------------------------------
  const app = resolveAppUnderTest(session)
  const bundles = bundleFiles(app)
  run.observe('app-under-test', { kind: app.kind, appRoot: app.appRoot, via: app.via })
  const host = symbolsIn(bundles.main, REQUIRED_HOST_SYMBOLS)
  run.observe('host-bundle', { path: host.path, modified: bundles.main.modifiedMs, counts: host.counts })
  run.observe('pi-bundle', { path: bundles.pi.path, exists: bundles.pi.exists, modified: bundles.pi.modifiedMs })
  if (host.missing.length > 0) {
    blocked(
      `stale-bundle: ${bundles.main.path} does not carry ${host.missing.join(', ')} — this app was built before `
      + '036d30536 and every result below would describe the code the fix replaced. Rebuild '
      + '(`bun run electron:build:servers`, or repackage), relaunch, then re-run.',
    )
  }

  // ---- the fixture server is live ------------------------------------------
  const workspaceId = await fixtureWorkspaceId(session)
  const rows = await catalogRows(session, workspaceId)
  const probeRow = rows.find(r => r.kind === 'mcp' && r.logicalName === ELC_FIXTURE.serverName)
  if (!probeRow) {
    blocked(
      `fixture-not-installed: no MCP row named "${ELC_FIXTURE.serverName}" in the catalog. `
      + `Check <config>/mcp.json in ${elicitationPaths().configDir}.`,
    )
  }
  run.check('the fixture server is active before any turn', probeRow.state === 'active', `state=${probeRow.state}`)

  const connections = await session.call<Connection[]>(`
    return (await window.electronAPI.listLlmConnectionsWithStatus() ?? []).map(c => ({ slug: c.slug, providerType: c.providerType }))
  `)
  run.observe('connections', connections)

  const caseStarted = Date.now()
  const gaps: string[] = ALL_RUNTIMES
    .filter(runtime => !RUNTIMES.includes(runtime))
    .map(runtime => `${runtime.label}: excluded by NESSY_CDP_ELC_RUNTIMES=${process.env.NESSY_CDP_ELC_RUNTIMES}`)

  for (const runtime of RUNTIMES) {
    const connection = connections.find(c => runtime.providerTypes.includes(c.providerType))
    if (!connection) {
      gaps.push(`${runtime.label}: no connection with providerType ${runtime.providerTypes.join('/')} exists on this host`)
      run.observe(`${runtime.id}-gap`, gaps.at(-1))
      continue
    }
    const failure = await exerciseRuntime(run, session, runtime, connection)
    if (failure) gaps.push(`${runtime.label}: ${failure}`)
  }

  // ---- the handshake, from the SERVER's side -------------------------------
  // Last, because a connection is made during session setup and the sessions
  // above are what caused the ones this run can attribute to itself.
  const mine = elicitHandshakes().filter(entry => entry.at >= caseStarted)
  const handshakes = mine.length > 0 ? mine : elicitHandshakes()
  if (mine.length === 0 && handshakes.length > 0) {
    run.observe('handshake-scope', 'no initialize since this case started — the pool reused a connection made earlier; '
      + 'reading the whole log instead')
  }
  const latest = handshakes.at(-1)
  run.observe('client-capabilities-at-initialize', {
    at: latest ? new Date(latest.at).toISOString() : '(none)',
    // The timestamp is part of the evidence: a handshake that predates this run
    // came from an earlier app launch against the same fixture tree, and the
    // reader has to be able to see that rather than take the capability on
    // trust. The fixture builder truncates this log, so nothing here can be
    // older than the tree.
    caseStartedAt: new Date(caseStarted).toISOString(),
    capabilities: latest?.clientCapabilities ?? '(no initialize logged)',
  })
  const elicitation = (latest?.clientCapabilities as { elicitation?: Record<string, unknown> } | undefined)?.elicitation
  run.check(
    'our MCP client declared the elicitation capability at initialize',
    Boolean(elicitation) && 'form' in (elicitation ?? {}) && 'url' in (elicitation ?? {}),
    elicitation
      ? `capabilities.elicitation=${JSON.stringify(elicitation)}`
      : 'the server saw NO elicitation capability — this is the pre-fix state, and the vendored SDK will not send '
        + 'elicitation/create at all without it',
  )

  if (gaps.length > 0) {
    blocked(`runtimes not exercised end to end: ${gaps.join(' | ')}`)
  }
}

async function exerciseRuntime(
  run: CaseRun,
  session: CdpSession,
  runtime: RuntimeTarget,
  connection: Connection,
): Promise<string | undefined> {
  const name = runtime.id
  const key = await freshSession(session, `CDP ${ID} ${runtime.id} ${new Date().toISOString().slice(11, 19)}`)
  run.observe(`${name}-session`, { sessionId: key.sessionId, fresh: key.fresh, reason: key.reason })
  if (!key.fresh) {
    run.check(`${runtime.label}: the case ran in a session it created`, false, key.reason ?? 'unknown')
    return 'could not create a clean session'
  }

  await sessionCommand(session, key.sessionId, { type: 'setConnection', connectionSlug: connection.slug })
  // In EFFECT, not merely requested: a prompt sent before the switch lands
  // measures the previous runtime and files the result under this one.
  const active = await waitFor(
    () => session.call<string | undefined>(`
      const s = (await window.electronAPI.getSessions() ?? []).find(x => x.id === ${JSON.stringify(key.sessionId)})
      return s ? (s.llmConnection ?? undefined) : undefined
    `),
    value => value === connection.slug,
    { timeoutMs: 30_000, intervalMs: 1_000, label: `the session to switch to ${connection.slug}` },
  ).catch(() => undefined)
  run.check(
    `${runtime.label}: the session runs on ${connection.slug}`,
    active === connection.slug,
    `llmConnection=${String(active)}`,
  )
  if (active !== connection.slug) return `the session would not switch to ${connection.slug}`

  // Every MCP tool call is classified `mcp_mutation` and asks. This case is
  // about the ELICITATION dialog, not the permission prompt (AGT-3 owns that),
  // so it takes the documented mode that does not ask and keeps an approver
  // running underneath as a net. The approver never touches the ask_user card.
  await sessionCommand(session, key.sessionId, { type: 'setPermissionMode', mode: 'bypassPermissions' }).catch(() => undefined)
  const mode = await waitFor(
    async () => (await listSessions(session)).find(s => s.id === key.sessionId)?.permissionMode,
    value => value === 'bypassPermissions',
    { timeoutMs: 20_000, intervalMs: 1_000, label: 'bypassPermissions to take effect' },
  ).catch(() => undefined)
  run.observe(`${name}-permission-mode`, mode ?? '(not applied)')
  // `dontAsk` never prompts, so an elicitation is refused there WITHOUT a card —
  // by design (`elicitation-ask-user.ts`, the same guard PiAgent states for its
  // own ask surface). A "no card appeared" result under that mode is documented
  // behaviour and NOT the regression this case is looking for, so the case
  // refuses to interpret it rather than filing a defect.
  if (mode === 'dontAsk') {
    run.check(`${runtime.label}: the session is in a mode that can ask at all`, false, 'the session sat in dontAsk')
    return 'the session sat in dontAsk, where no card can appear by design'
  }

  const expectedTool = elicitProxyToolName(ELC_FIXTURE.confirmTool, runtime.id)
  const since = Date.now()
  const approver = approvePermissionsWhile(session, key.sessionId)
  // The dialog has to be answered from UNDERNEATH the turn: a turn parked on an
  // unanswered card never ends, so `sendPrompt` would not return and its own
  // timeout could not fire either.
  const asker = answerAskUserWhile(session, card => (
    card.options.includes(ELC_EXPECTED.confirmOptions[0]) ? ELC_EXPECTED.confirmOptions[0] : undefined
  ))

  const rowsBefore = (await transcript(session, key)).length // F1.521: the fallback's baseline, read before the send
  const turn = await sendPrompt(
    session,
    key,
    `Call the tool ${expectedTool} with no arguments, then reply with exactly what it returned and nothing else. `
    + 'Do not read any file and do not guess: if the tool call fails, reply TOOL-FAILED plus the error.',
    300_000,
  ).then(turnAttempt).catch(turnFailure)
  const answered = await asker.stop()
  run.observe(`${name}-permissions-approved-mid-turn`, await approver.stop())
  if (turn.error) run.observe(`${name}-turn-error`, turn.error)

  // ---- 1. a real card, on screen ------------------------------------------
  const cards: AskUserCard[] = asker.seen
  run.observe(`${name}-cards`, cards.map(card => ({
    question: card.question.slice(0, 200),
    options: card.options,
    allButtons: card.allButtons,
  })))
  const confirmCard = cards.find(card => card.question.includes(ELC_FIXTURE.label))
  run.check(
    `${runtime.label}: an ask_user card appeared for the server's question`,
    Boolean(confirmCard),
    confirmCard
      ? undefined
      : cards.length > 0
        ? `${cards.length} card(s) appeared but none carried the fixture's message`
        : 'NO card appeared — the server\'s question never reached a user',
  )
  if (confirmCard) {
    run.check(
      `${runtime.label}: the card offers the boolean field's two options`,
      confirmCard.options.length === ELC_EXPECTED.confirmOptions.length
        && ELC_EXPECTED.confirmOptions.every(option => confirmCard.options.includes(option)),
      `options=${JSON.stringify(confirmCard.options)}`,
    )
  }
  run.observe(`${name}-answered`, answered.map(a => a.clicked))
  run.check(
    `${runtime.label}: the harness answered the card as a user would`,
    answered.length > 0,
    answered.length > 0 ? `clicked ${answered.map(a => a.clicked).join(', ')}` : 'nothing was clicked',
  )

  // ---- 2. the server got an ACTION back ------------------------------------
  const scanned = await turnRowsSince(() => transcript(session, key), turn.added, rowsBefore)
  if (turn.added.length === 0) run.observe(`${name}-scan-scope`, 'the rows since the send (it threw, so it handed back none)')
  const mcpRows = scanned.filter(m => typeof m.toolName === 'string' && m.toolName.startsWith('mcp__'))
  run.observe(`${name}-mcp-tool-rows`, mcpRows.map(m => ({ tool: m.toolName, status: m.toolStatus })))
  const minted = mcpRows.filter(m => m.toolName === expectedTool)
  run.check(
    `${runtime.label}: the app dispatched ${expectedTool}`,
    minted.length > 0,
    minted.length > 0 ? undefined : `names seen: ${JSON.stringify(mcpRows.map(m => m.toolName))}`,
  )

  const result = minted.find(m => m.toolResult)?.toolResult ?? ''
  const reply = lastAssistantText(scanned)
  run.observe(`${name}-tool-result`, result.slice(0, 300) || '(no tool result)')
  run.observe(`${name}-reply`, reply.slice(0, 300) || '(no assistant message)')
  // The server's own report of what it received. `outcome=accept confirm=true`
  // is the whole round trip: the client answered the METHOD, and the value that
  // came back is the option the harness clicked.
  run.check(
    `${runtime.label}: the server received action=accept`,
    /outcome=accept/.test(result),
    result ? `tool result: ${result.slice(0, 200)}` : 'no tool result to read',
  )
  run.check(
    `${runtime.label}: the answer carried the user's own value back to the server`,
    /confirm=true/.test(result),
    result ? `tool result: ${result.slice(0, 200)}` : 'no tool result to read',
  )
  // Named, so a future reader can tell a REGRESSION from a new failure.
  run.check(
    `${runtime.label}: the client did NOT refuse the method (${ELC_EXPECTED.preFixCodexSymptom} was the pre-fix symptom)`,
    !/outcome=refused/.test(result),
    /outcome=refused/.test(result)
      ? `the server was refused: ${result.slice(0, 200)} — this is Q13-D1's exact shape, measured on Codex on the `
        + 'packaged 1.25.1 before 036d30536'
      : undefined,
  )
  const nonce = /nonce=([0-9a-f]{12})/.exec(result)?.[1]
  run.check(
    `${runtime.label}: the model's reply carries what the tool returned`,
    Boolean(nonce) && reply.includes(nonce!),
    nonce && reply.includes(nonce) ? `nonce=${nonce}` : `reply did not carry the per-call nonce: ${reply.slice(0, 200)}`,
  )

  // ---- 3. the server's own log --------------------------------------------
  const serverSaw: ElicitLogEntry[] = elicitLogSince(since)
  run.observe(`${name}-server-log`, serverSaw.map(entry => ({
    method: entry.method, tool: entry.tool, outcome: entry.outcome, content: entry.content,
  })))
  run.check(
    `${runtime.label}: the server's own log records the elicitation and its outcome`,
    serverSaw.some(entry => entry.method === 'elicitation/create' && entry.outcome === 'accept'),
    serverSaw.length > 0
      ? `log holds ${JSON.stringify(serverSaw.map(e => `${e.method}:${e.outcome ?? ''}`))}`
      : 'the server logged nothing in this window — the call never reached a server process',
  )

  // Exercised. A failure here is a FAILURE, already on `run.checks` — not a gap:
  // a gap means "this runtime was never driven", and conflating the two is how
  // a red result launders itself into "could not run".
  return undefined
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
