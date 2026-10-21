/**
 * ELC-2 — the refusal a user must SEE.
 *
 * `mcp/elicitation.ts` `declineVisibly` is one rule in one function: *tell the
 * user why, then decline it, never silently.* It is reached whenever an
 * elicitation cannot be honoured — an unrenderable schema, a missing required
 * field, and the case this drives: a URL-mode elicitation whose url is not
 * http(s).
 *
 * That gate matters on its own. A URL-mode elicitation carries a
 * SERVER-SUPPLIED string on its way to `shell.openExternal`, i.e. untrusted
 * input reaching an OS protocol dispatcher. `safeHttpUrl` puts an http(s)
 * allowlist on top of the repo's existing blocklist, because the blocklist is
 * calibrated for user-authored links — passing `obsidian://` / `vscode://`
 * through is the point there — and `mcp.md` only ever describes "a browser URL".
 *
 * ## Why the dialog is the assertion, not the decline
 *
 * The decline was never in doubt; the DIALOG was, and on Pi it was missing until
 * `036d30536`. `pi-agent.ts` validated every ask against the `ask_user` TOOL's
 * documented 2-4 option bound, and `declineVisibly` asks with a single `OK`. So
 * the validation threw, `handleMcpElicitationWithAskUser`'s outer `catch`
 * mapped the throw to `{action: 'cancel'}` — a settled, correct-looking MCP
 * answer — and the user saw nothing at all. A silent drop of the exact dialog
 * the rule exists to guarantee, on the one runtime where elicitation worked.
 *
 * So the checks are, in order: a card is on screen; it carries the reason a
 * human can read; it offers EXACTLY ONE option, `OK`; it does not offer to open
 * anything; and only then, that the server got `decline`. A case that asserted
 * the decline alone would have passed throughout the entire pre-fix period.
 *
 * ## The one-option count is why this reads the option grid, not the card
 *
 * `AskUserRequest.tsx` always renders a Cancel button in its own footer.
 * Counting every button in the card would make the single-`OK` acknowledgement
 * look like a two-option question and quietly delete this case's whole point —
 * `lib/ask-user.ts` scopes `options` to the grid and reports `allButtons`
 * separately so a DOM change surfaces as a shape mismatch instead.
 */

import { sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { answerAskUserWhile, approvePermissionsWhile, requireApproverSaw, type AskUserCard } from '../lib/ask-user.ts'
import { bundleFiles, resolveAppUnderTest, symbolsIn } from '../lib/bundle.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import {
  ELC_EXPECTED,
  ELC_FIXTURE,
  elicitLogSince,
  elicitProxyToolName,
  elicitationPaths,
  readElicitationTokens,
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

const ID = 'ELC-2'
const TITLE = 'A refused URL-mode elicitation still shows the user why, with one OK, and declines to the server'

/**
 * The host-bundle symbols this case depends on.
 *
 * `askUserForElicitation` is the override `036d30536` added to `pi-agent.ts`;
 * it is the line that lowers the option floor to 1 for this one dialog, and it
 * did not exist before the fix (verified against `036d30536^`). `declineVisibly`
 * predates it and is included as the positive control on the technique: if the
 * scan reports 0 for BOTH, the bundle path is wrong rather than the build being
 * stale.
 */
const REQUIRED_HOST_SYMBOLS = ['askUserForElicitation', 'ElicitationAskUserBridge']
const CONTROL_HOST_SYMBOL = 'declineVisibly'

interface RuntimeTarget {
  id: 'pi' | 'claude' | 'codex'
  providerTypes: string[]
  label: string
}

const ALL_RUNTIMES: RuntimeTarget[] = [
  { id: 'pi', providerTypes: ['pi', 'pi_compat'], label: 'Pi' },
  { id: 'claude', providerTypes: ['claude-runtime'], label: 'Claude runtime' },
  { id: 'codex', providerTypes: ['codex-runtime'], label: 'Codex runtime' },
]

/**
 * Pi is REQUIRED and the other two are best-effort.
 *
 * Not a preference: Pi is where the regression lived and is the only runtime on
 * which this dialog has ever been shown to be missing. A run without it cannot
 * make the claim in the title, so it blocks before driving anything rather than
 * banking two green arms.
 */
const REQUIRED_RUNTIME = 'pi'

const RUNTIMES: RuntimeTarget[] = (() => {
  const requested = (process.env.NESSY_CDP_ELC_RUNTIMES ?? '').split(',').map(v => v.trim()).filter(Boolean)
  if (requested.length === 0) return ALL_RUNTIMES
  return ALL_RUNTIMES.filter(runtime => requested.includes(runtime.id))
})()

interface Connection {
  slug: string
  providerType: string
}

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
      + 'then start the app with NESSY_CONFIG_DIR=<root>/config.',
    )
  }
  run.observe('theme', await ensureDarkTheme(session))
  run.observe('refused-url', ELC_FIXTURE.badUrl)

  const app = resolveAppUnderTest(session)
  const bundles = bundleFiles(app)
  const host = symbolsIn(bundles.main, [...REQUIRED_HOST_SYMBOLS, CONTROL_HOST_SYMBOL])
  run.observe('app-under-test', { kind: app.kind, appRoot: app.appRoot, via: app.via })
  run.observe('host-bundle', { path: host.path, modified: bundles.main.modifiedMs, counts: host.counts })
  if ((host.counts[CONTROL_HOST_SYMBOL] ?? 0) <= 0) {
    blocked(
      `bundle-unreadable: ${bundles.main.path} does not even carry ${CONTROL_HOST_SYMBOL}, which predates the fix. `
      + 'The path is wrong or the file is not the bundle this app loaded — set NESSY_CDP_APP_ROOT.',
    )
  }
  const missing = REQUIRED_HOST_SYMBOLS.filter(symbol => (host.counts[symbol] ?? 0) <= 0)
  if (missing.length > 0) {
    blocked(
      `stale-bundle: ${bundles.main.path} carries ${CONTROL_HOST_SYMBOL} but not ${missing.join(', ')} — this app `
      + 'was built before 036d30536, so the Pi arm would measure the very code that dropped the dialog. Rebuild, '
      + 'relaunch, re-run.',
    )
  }

  const workspaceId = await fixtureWorkspaceId(session)
  const rows = await catalogRows(session, workspaceId)
  const probeRow = rows.find(r => r.kind === 'mcp' && r.logicalName === ELC_FIXTURE.serverName)
  if (!probeRow) {
    blocked(`fixture-not-installed: no MCP row named "${ELC_FIXTURE.serverName}" in the catalog.`)
  }
  run.check('the fixture server is active before any turn', probeRow.state === 'active', `state=${probeRow.state}`)

  const connections = await session.call<Connection[]>(`
    return (await window.electronAPI.listLlmConnectionsWithStatus() ?? []).map(c => ({ slug: c.slug, providerType: c.providerType }))
  `)
  run.observe('connections', connections)
  const piTarget = ALL_RUNTIMES.find(runtime => runtime.id === REQUIRED_RUNTIME)!
  if (!connections.some(c => piTarget.providerTypes.includes(c.providerType))) {
    blocked(
      'no Pi connection on this host. Pi is the runtime this dialog was missing on, so a run without it cannot '
      + 'make the case\'s claim — create the Pi card and re-run.',
    )
  }

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

  await sessionCommand(session, key.sessionId, { type: 'setPermissionMode', mode: 'bypassPermissions' }).catch(() => undefined)
  const mode = await waitFor(
    async () => (await listSessions(session)).find(s => s.id === key.sessionId)?.permissionMode,
    value => value === 'bypassPermissions',
    { timeoutMs: 20_000, intervalMs: 1_000, label: 'bypassPermissions to take effect' },
  ).catch(() => undefined)
  run.observe(`${name}-permission-mode`, mode ?? '(not applied)')
  // `dontAsk` never prompts, so an elicitation is refused there WITHOUT a card,
  // by design (`elicitation-ask-user.ts`; PiAgent states the same guard for its
  // own ask surface). That is the pre-fix symptom's twin — same absence, wholly
  // different cause — so the case refuses to interpret it rather than filing the
  // regression.
  if (mode === 'dontAsk') {
    run.check(`${runtime.label}: the session is in a mode that can ask at all`, false, 'the session sat in dontAsk')
    return 'the session sat in dontAsk, where no card can appear by design'
  }

  const expectedTool = elicitProxyToolName(ELC_FIXTURE.badUrlTool, runtime.id)
  const since = Date.now()
  const approver = approvePermissionsWhile(session, key.sessionId)
  // Answer the acknowledgement from underneath the turn. `OK` is matched by
  // LABEL rather than by position: clicking "whatever the first option is"
  // would also click `Open separately` if the URL gate ever stopped refusing,
  // which is the one outcome this case must never manufacture.
  const asker = answerAskUserWhile(session, card => (
    card.options.includes(ELC_EXPECTED.badUrlOption) ? ELC_EXPECTED.badUrlOption : undefined
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
  // D1.356 — the case reads the ask_user card out of `asker.seen`, and a turn
  // parked on an unanswered TOOL-permission card never reaches the elicitation.
  // `cards: []` would then read as "the server asked nothing".
  requireApproverSaw(run, approver, name)
  if (turn.error) run.observe(`${name}-turn-error`, turn.error)

  // ---- the dialog, which is the whole case --------------------------------
  const cards: AskUserCard[] = asker.seen
  run.observe(`${name}-cards`, cards.map(card => ({
    question: card.question.slice(0, 300),
    options: card.options,
    allButtons: card.allButtons,
    urlConsent: card.urlConsent,
  })))
  const refusal = cards.find(card => card.question.includes(ELC_EXPECTED.badUrlReason))
  run.check(
    `${runtime.label}: the user is SHOWN why the URL was refused`,
    Boolean(refusal),
    refusal
      ? undefined
      : cards.length > 0
        ? `${cards.length} card(s) appeared but none carried "${ELC_EXPECTED.badUrlReason}"`
        : `NO card appeared. On Pi this is the pre-fix symptom exactly: ${ELC_EXPECTED.preFixPiSymptom} — the `
          + 'single-OK ask failed the 2-4 option bound, the throw degraded to a settled `cancel`, and the refusal '
          + 'the rule exists to make visible was the one thing the user never saw',
  )
  if (refusal) {
    run.check(
      `${runtime.label}: the acknowledgement offers exactly one option, "${ELC_EXPECTED.badUrlOption}"`,
      refusal.options.length === 1 && refusal.options[0] === ELC_EXPECTED.badUrlOption,
      `options=${JSON.stringify(refusal.options)} (every button on the card: ${JSON.stringify(refusal.allButtons)})`,
    )
    // The open dialog is what a PERMITTED url gets. Its absence is the
    // observable proof that `shell.openExternal` was never reached — the
    // strongest read available from the renderer, since the opener itself is a
    // main-process seam no case can watch.
    run.check(
      `${runtime.label}: the card never offered to open ${ELC_FIXTURE.badUrl}`,
      !refusal.options.some(option => /open/i.test(option)),
      `options=${JSON.stringify(refusal.options)}`,
    )
  }
  run.observe(`${name}-answered`, answered.map(a => a.clicked))
  run.check(
    `${runtime.label}: the acknowledgement was answered`,
    answered.some(a => a.clicked === ELC_EXPECTED.badUrlOption),
    answered.length > 0 ? `clicked ${answered.map(a => a.clicked).join(', ')}` : 'nothing was clicked',
  )

  // ---- and only then, the decline -----------------------------------------
  const scanned = await turnRowsSince(() => transcript(session, key), turn.added, rowsBefore)
  if (turn.added.length === 0) run.observe(`${name}-scan-scope`, 'the rows since the send (it threw, so it handed back none)')
  const minted = scanned.filter(m => m.toolName === expectedTool)
  run.check(
    `${runtime.label}: the app dispatched ${expectedTool}`,
    minted.length > 0,
    minted.length > 0
      ? undefined
      : `names seen: ${JSON.stringify(scanned.filter(m => m.toolName).map(m => m.toolName))}`,
  )
  const result = minted.find(m => m.toolResult)?.toolResult ?? ''
  run.observe(`${name}-tool-result`, result.slice(0, 300) || '(no tool result)')
  run.check(
    `${runtime.label}: the server received action=decline`,
    /outcome=decline/.test(result),
    result
      ? `tool result: ${result.slice(0, 200)}`
      : 'no tool result to read',
  )
  // `cancel` is the abort/teardown path, NOT a user decision — and it is what
  // the pre-fix Pi bug produced. Distinguishing the two is the difference
  // between "the user refused this" and "nobody was ever asked".
  run.check(
    `${runtime.label}: it is a decline, not the silent cancel the pre-fix path produced`,
    !/outcome=cancel/.test(result),
    /outcome=cancel/.test(result)
      ? 'the server got `cancel`: handleMcpElicitationWithAskUser\'s outer catch ran, which means the ask itself '
        + 'threw and no dialog was ever shown'
      : undefined,
  )

  const serverSaw = elicitLogSince(since)
  run.observe(`${name}-server-log`, serverSaw.map(entry => ({
    method: entry.method, tool: entry.tool, mode: entry.mode, url: entry.url, outcome: entry.outcome,
  })))
  run.check(
    `${runtime.label}: the server's own log records the url-mode elicitation and its decline`,
    serverSaw.some(entry => entry.method === 'elicitation/create' && entry.outcome === 'decline'),
    serverSaw.length > 0
      ? `log holds ${JSON.stringify(serverSaw.map(e => `${e.method}:${e.outcome ?? ''}`))}`
      : 'the server logged nothing in this window — the call never reached a server process',
  )

  return undefined
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
