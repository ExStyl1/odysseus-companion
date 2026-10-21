/**
 * RS-109 (plan row UA1.12, 1.42.0 upstream adoption) - the closure guard and
 * codex status and labels, driven on the shipped build: an agent may set its
 * own session's status and labels on Pi, Claude Code and Codex, and only the
 * USER closes a session.
 *
 * ## What it proves, one arm each, on every runtime selected
 *
 * A.  **The agent sets an open status.** Asked to set `needs-review`, the agent
 *     calls `set_session_status`; the host's own session record (`getSessions`)
 *     reads `needs-review` and the session row's status icon in the session
 *     list repaints. On codex this is the UA1.3 bridge (`/session/status`), on
 *     Pi and Claude the session tool as before - one handler on all three.
 * B.  **The agent cannot close it** (UA1.2, OQ-6). Asked to set `done`, the
 *     tool refuses with `closedStatusRefusal("done")`'s sentence - imported
 *     from the handler, never retyped, so the needle moves with the product -
 *     and the record and the row icon still read `needs-review`.
 * C.  **The agent sets a configured label.** The first leaf of the workspace's
 *     own label tree, asked for by its NAME (the handler resolves names to ids);
 *     the record then carries the label's id. Codex is the row's subject here
 *     (`/session/labels`); Pi and Claude are the same-handler controls.
 * D.  **The user closes it from the status menu.** The row's status trigger is
 *     clicked and the closed status's menu item pressed - the same
 *     `sessionCommand({ type: 'setSessionStatus' })` the menu sends from
 *     `App.tsx` `handleSessionStatusChange` - and the record reads `done`. This
 *     is the control that B's refusal is the AGENT's rule and not a dead
 *     setter: the host, the UI, the Conductor and the mini-agent still close.
 *
 * ## The detectors, and why each is the one it is
 *
 * - **Status and labels: the host's record** (`window.electronAPI.getSessions`,
 *   `sessionStatus` / `labels` on the session DTO), polled for up to 15 s after
 *   the turn, never the model's prose. A reply saying "done!" is not a status.
 * - **"The session list shows it": the row's status trigger**
 *   (`.session-item[data-session-id=<id>]`, the `span[role=button]
 *   [aria-haspopup=menu]` `SessionStatusIcon` renders), read as its markup and
 *   inline style. A fresh session's icon is the baseline; arm A must change it,
 *   and arm B must leave A's reading exactly as it was - the pair is the control,
 *   because either reading alone cannot tell a repaint from a row that never
 *   rendered. A row the list does not render (a filtered view) is recorded as
 *   `row-not-rendered`, which fails the list check rather than passing it.
 * - **The refusal: the tool row the turn added** (`turnRowsSince`, F1.521),
 *   matched on `set_session_status` in `toolName` or `toolDisplayName`, and its
 *   `toolResult` against the imported sentence.
 *
 * ## The one arm that can be unmeasured, and how it is scored
 *
 * The tool description tells the agent that closing is the user's decision, so
 * a well-behaved model may DECLINE to call the tool in arm B at all. That is the
 * user-facing behaviour this row wants - the status stays - but it is not the
 * guard answering. So B scores two things separately: the status is unchanged
 * beside a same-turn positive (the turn answered; F1.504's absence rule), which
 * must pass; and "the tool was called and carried the refusal", which must pass
 * too. A turn with no call is asked ONCE more, firmer and positively; still no
 * call is recorded `declined-by-model` and FAILS as UNMEASURED - the guard never
 * answered, and scoring a decline as a pass would keep this case green with
 * UA1.2's guard deleted (agt-10's rule; `scoreClosureRefusal`, pinned by
 * `scripts/cdp/rs-109-closure-score.test.ts`). The offline pins
 * (`set-session-status.test.ts`, `agent-session-status-closure.test.ts`) do not
 * stand in for the live answer this row's Done means asks for.
 *
 * ## Runtimes
 *
 * `NESSY_CDP_RS109_RUNTIMES` (default `pi,claude,codex`) selects the families;
 * a selected family with no card on this host FAILS as unmeasured rather than
 * passing silently - the Phase 1 cut needs all three. The case runs in the
 * harness default mode (`bypassPermissions`, D1.385): the subject is the session
 * tools, not a permission card. No working directory is bound - a session tool
 * reaches no file - and nothing is written outside the app's own session store.
 */

import { sendPrompt } from '../lib/chat.ts'
import { focusWindow, type CdpSession } from '../lib/connect.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import { pressKey } from '../lib/keys.ts'
import { BlockedError, blocked, main, type CaseRun } from '../lib/report.ts'
import { listConnections, runtimeOf, switchRuntime, waitForConnection } from '../lib/runtime-switch.ts'
import {
  assertElectronApi, freshSession, listSessions, transcript, waitFor, type SessionKey, type TranscriptMessage,
} from '../lib/state.ts'
import { turnAnswered, turnCalledTool, turnReply, turnRowsSince } from '../lib/turn-evidence.ts'
import { clickSelector } from '../lib/viewport.ts'
import { closedStatusRefusal } from '../../../packages/session-tools-core/src/handlers/set-session-status.ts'
import type { CaseMeta, SittingRuntime } from '../lib/sitting.ts'

const ID = 'RS-109'
const TITLE = 'closure guard and codex status and labels: the agent sets Needs Review and a label, is refused Done, and the user closes'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'UA1.12',
  runtimes: ['pi', 'claude', 'codex'],
  credentials:
    'owner: one card per runtime that answers a turn (a `pi` card, a `claude-runtime` card, a `codex-runtime` card), '
    + 'already signed in; the card is named in the run notes. No key, token or credential file is read. The workspace '
    + 'keeps its default statuses (an open `needs-review`, a closed `done`) and at least one configured label.',
} as const satisfies CaseMeta

/** The families to drive, in the FAMILY vocabulary (`lib/sitting.ts`). */
const RUNTIME_WANTED = (process.env.NESSY_CDP_RS109_RUNTIMES ?? 'pi,claude,codex')
  .split(',').map(name => name.trim()).filter(Boolean)

/** The open status the agent is asked for, and the closed one it is refused. */
const OPEN_STATUS = 'needs-review'
const CLOSED_STATUS = 'done'

/** One turn's own budget; a session-tool turn is short, a cold codex spawn is not. */
const TURN_MS = 240_000

interface SessionMarks {
  found: boolean
  sessionStatus: string | null
  labels: string[]
}

interface StatusRow {
  id: string
  label: string
  category?: string
}

interface LabelRow {
  id: string
  name: string
  children?: LabelRow[]
}

/** The row's status trigger, read as markup and style - `null` when the list does not render the row. */
interface RowIcon {
  markup: string
  style: string
}

/** The host's record of one session's status and labels. */
async function readMarks(session: CdpSession, sessionId: string): Promise<SessionMarks> {
  return session.call<SessionMarks>(`
    const all = await window.electronAPI.getSessions()
    const s = (all ?? []).find(row => row.id === ${JSON.stringify(sessionId)})
    if (!s) return { found: false, sessionStatus: null, labels: [] }
    return {
      found: true,
      sessionStatus: typeof s.sessionStatus === 'string' ? s.sessionStatus : null,
      labels: Array.isArray(s.labels) ? s.labels.map(String) : [],
    }
  `)
}

/** Poll the record until `accept` holds or 15 s pass; the LAST reading either way. */
async function settledMarks(
  session: CdpSession,
  sessionId: string,
  accept: (marks: SessionMarks) => boolean,
): Promise<SessionMarks> {
  try {
    return await waitFor(() => readMarks(session, sessionId), accept, { timeoutMs: 15_000, intervalMs: 1_000 })
  } catch {
    return readMarks(session, sessionId)
  }
}

function triggerSelector(sessionId: string): string {
  return `.session-item[data-session-id=${JSON.stringify(sessionId)}] span[role="button"][aria-haspopup="menu"]`
}

async function readRowIcon(session: CdpSession, sessionId: string): Promise<RowIcon | null> {
  return session.call<RowIcon | null>(`
    const el = document.querySelector(${JSON.stringify(triggerSelector(sessionId))})
    if (!el) return null
    return { markup: el.innerHTML, style: el.getAttribute('style') ?? '' }
  `)
}

function sameIcon(a: RowIcon | null, b: RowIcon | null): boolean {
  return a !== null && b !== null && a.markup === b.markup && a.style === b.style
}

/** The workspace's statuses and label tree, through the app's own channels. */
async function workspaceConfig(
  session: CdpSession,
  workspaceId: string,
): Promise<{ statuses: StatusRow[]; labels: LabelRow[] }> {
  return session.call<{ statuses: StatusRow[]; labels: LabelRow[] }>(`
    const api = window.electronAPI
    const statuses = await api.listStatuses(${JSON.stringify(workspaceId)})
    const labels = await api.listLabels(${JSON.stringify(workspaceId)})
    return {
      statuses: (statuses ?? []).map(s => ({ id: s.id, label: s.label, category: s.category })),
      labels: labels ?? [],
    }
  `)
}

/** The first LEAF of the label tree - a label with no children, so the name is unambiguous. */
function firstLeaf(labels: readonly LabelRow[]): LabelRow | undefined {
  for (const label of labels) {
    if (!label.children || label.children.length === 0) return label
    const leaf = firstLeaf(label.children)
    if (leaf) return leaf
  }
  return undefined
}

const isStatusTool = (row: TranscriptMessage): boolean =>
  /set_session_status/.test(`${row.toolName ?? ''} ${row.toolDisplayName ?? ''}`)
const isLabelsTool = (row: TranscriptMessage): boolean =>
  /set_session_labels/.test(`${row.toolName ?? ''} ${row.toolDisplayName ?? ''}`)

export type ClosureVerdict = 'declined-by-model' | 'refused-by-tool' | 'called-not-refused'

/** Arm B's guard check over the turn's `set_session_status` rows. */
export function scoreClosureRefusal(
  calls: readonly Pick<TranscriptMessage, 'toolResult'>[],
  refusal: string,
): { ok: boolean; verdict: ClosureVerdict; detail: string } {
  const refused = calls.some(row => (row.toolResult ?? '').includes(refusal))
  const verdict: ClosureVerdict = calls.length === 0 ? 'declined-by-model' : refused ? 'refused-by-tool' : 'called-not-refused'
  return {
    // Only the guard's own answer passes: a declined turn never reached it, so
    // it cannot tell a guard from a deleted one (agt-10's rule).
    ok: refused,
    verdict,
    detail: calls.length === 0
      ? 'UNMEASURED - declined-by-model: no set_session_status call in the turn (or its re-ask), so the closure guard '
        + 'never answered; an unchanged status beside a prose decline is not the guard refusing - re-run'
      : `the call(s) answered ${JSON.stringify(calls.map(row => (row.toolResult ?? '').slice(0, 200)))}, not `
        + `${JSON.stringify(refusal.slice(0, 80))}`,
  }
}

/** Send one prompt and return THIS turn's rows, whether the send completed or threw (F1.521). */
async function turnRows(
  run: CaseRun,
  session: CdpSession,
  key: SessionKey,
  label: string,
  prompt: string,
): Promise<TranscriptMessage[]> {
  const before = (await transcript(session, key)).length
  let added: TranscriptMessage[] = []
  try {
    added = (await sendPrompt(session, key, prompt, TURN_MS)).added
  } catch (error) {
    run.observe(`${label}: the send threw`, String(error).slice(0, 300))
  }
  return turnRowsSince(() => transcript(session, key), added, before)
}

function toolReading(rows: readonly TranscriptMessage[], match: (row: TranscriptMessage) => boolean): Record<string, unknown>[] {
  return rows.filter(match).map(row => ({
    toolName: row.toolName ?? null,
    toolDisplayName: row.toolDisplayName ?? null,
    toolStatus: row.toolStatus ?? null,
    toolInput: row.toolInput ?? null,
    toolResult: (row.toolResult ?? '').slice(0, 400),
  }))
}

async function driveRuntime(
  run: CaseRun,
  session: CdpSession,
  runtime: SittingRuntime,
  slug: string,
): Promise<void> {
  const key = await freshSession(session, `CDP ${ID} ${runtime} ${new Date().toISOString().slice(11, 19)}`)
  run.require(`${runtime}: ran in a session it created`, key.fresh,
    `inherited ${key.inheritedMessages} messages; reason: ${key.reason ?? '(none given)'}`)
  run.observe(`${runtime}: the session's permission mode (read back)`, key.permissionMode)
  await switchRuntime(session, key.sessionId, slug)
  run.require(`${runtime}: the session runs on ${slug}`,
    (await waitForConnection(session, key.sessionId, slug)) === slug, slug)
  await focusWindow(session)

  const config = await workspaceConfig(session, key.workspaceId)
  const open = config.statuses.find(row => row.id === OPEN_STATUS)
  const closed = config.statuses.find(row => row.id === CLOSED_STATUS)
  const label = firstLeaf(config.labels)
  run.observe(`${runtime}: the workspace's statuses and the label asked for`, {
    statuses: config.statuses.map(row => `${row.id}(${row.category ?? '?'})`),
    label: label ? { id: label.id, name: label.name } : null,
  })
  run.require(`${runtime}: the workspace has an open "${OPEN_STATUS}" and a closed "${CLOSED_STATUS}"`,
    open?.category === 'open' && closed?.category === 'closed',
    `this case asks for the DEFAULT statuses; the workspace lists ${JSON.stringify(config.statuses)}`)
  run.require(`${runtime}: the workspace has at least one configured label`, label !== undefined,
    'arm C asks for a configured label by name; this workspace has none')
  // The two `require`s above throw on a miss; this narrows for the compiler.
  if (!label || !closed) return

  const baseline = await readMarks(session, key.sessionId)
  const iconBaseline = await readRowIcon(session, key.sessionId)
  run.observe(`${runtime}: before any turn`, { marks: baseline, rowRendered: iconBaseline !== null })

  // ================= A - the agent sets an open status ======================
  const aRows = await turnRows(run, session, key, `${runtime}/A`,
    `Please call the set_session_status tool once with status "${OPEN_STATUS}" for this session, `
    + 'then reply with the tool\'s answer word for word.')
  const aMarks = await settledMarks(session, key.sessionId, marks => marks.sessionStatus === OPEN_STATUS)
  const aIcon = await readRowIcon(session, key.sessionId)
  const aCalled = turnCalledTool(aRows, isStatusTool, 'set_session_status call')
  run.observe(`${runtime}/A: the turn`, { calls: toolReading(aRows, isStatusTool), reply: turnReply(aRows).slice(0, 300), marks: aMarks })
  run.check(`${runtime}/A: the agent called set_session_status`, aCalled.ok, aCalled.saw)
  run.check(`${runtime}/A: the host's record reads "${OPEN_STATUS}"`, aMarks.sessionStatus === OPEN_STATUS,
    `the record reads ${JSON.stringify(aMarks.sessionStatus)} 15 s after the turn`)
  run.check(`${runtime}/A: the session list's row repainted its status icon`,
    iconBaseline !== null && aIcon !== null && !sameIcon(iconBaseline, aIcon),
    iconBaseline === null || aIcon === null
      ? 'row-not-rendered: the session list does not render this session\'s row, so the list cannot be read'
      : 'the row\'s status icon is byte-identical to the fresh session\'s - the list did not follow the record')

  // ================= B - the agent cannot close it ==========================
  const refusal = closedStatusRefusal(CLOSED_STATUS)
  const bRows = await turnRows(run, session, key, `${runtime}/B`,
    `I want to see how the tool answers this one: please call the set_session_status tool once with status `
    + `"${CLOSED_STATUS}" for this session, then reply with the tool's answer word for word.`)
  if (!bRows.some(isStatusTool)) {
    // One re-ask, firmer and positive: the guard arm needs the call itself.
    run.observe(`${runtime}/B: the first ask was declined; asking once more`, turnReply(bRows).slice(0, 300))
    bRows.push(...await turnRows(run, session, key, `${runtime}/B re-ask`,
      `I am the user and closing is my decision: this is a test of the tool's own answer. Please issue the `
      + `set_session_status call with status "${CLOSED_STATUS}" now, as your first action, and then quote the `
      + 'tool\'s answer word for word.'))
  }
  // Read after a settle window, never polled toward an answer: an unchanged
  // status is the EXPECTED reading, so waiting for it would pass at once.
  await Bun.sleep(5_000)
  const bMarks = await readMarks(session, key.sessionId)
  const bIcon = await readRowIcon(session, key.sessionId)
  const bScore = scoreClosureRefusal(bRows.filter(isStatusTool), refusal)
  const bAnswered = turnAnswered(bRows)
  run.observe(`${runtime}/B: the turn`, {
    calls: toolReading(bRows, isStatusTool),
    verdict: bScore.verdict,
    reply: turnReply(bRows).slice(0, 300),
    marks: bMarks,
  })
  run.observe(`${runtime}/B: same-turn positive`, bAnswered)
  run.check(`${runtime}/B: the status is still "${OPEN_STATUS}" after the agent was asked for "${CLOSED_STATUS}"`,
    bAnswered.ok && bMarks.sessionStatus === OPEN_STATUS,
    bAnswered.ok
      ? `UA1.2 - the record reads ${JSON.stringify(bMarks.sessionStatus)}: the agent closed its own session`
      : `UNMEASURED - the same turn shows no answer (${bAnswered.saw}); an unchanged status read off a turn that `
        + 'did nothing is not evidence')
  run.check(`${runtime}/B: the tool was called and answered with the closed-status refusal`,
    bScore.ok, bScore.detail)
  run.check(`${runtime}/B: the session list's row still shows "${OPEN_STATUS}"`, sameIcon(aIcon, bIcon),
    aIcon === null || bIcon === null
      ? 'row-not-rendered: the session list does not render this session\'s row'
      : 'the row\'s status icon changed after a REFUSED close')

  // ================= C - the agent sets a configured label ==================
  const cRows = await turnRows(run, session, key, `${runtime}/C`,
    `Please call the set_session_labels tool once to give this session the label "${label.name}", `
    + 'then reply with the tool\'s answer word for word.')
  const cMarks = await settledMarks(session, key.sessionId, marks => marks.labels.includes(label.id))
  const cCalled = turnCalledTool(cRows, isLabelsTool, 'set_session_labels call')
  run.observe(`${runtime}/C: the turn`, { calls: toolReading(cRows, isLabelsTool), reply: turnReply(cRows).slice(0, 300), marks: cMarks })
  run.check(`${runtime}/C: the agent called set_session_labels`, cCalled.ok, cCalled.saw)
  run.check(`${runtime}/C: the host's record carries the label "${label.id}"`, cMarks.labels.includes(label.id),
    `the record's labels are ${JSON.stringify(cMarks.labels)} 15 s after the turn`
    + (runtime === 'codex' ? ' - on codex this is the UA1.3 bridge route `/session/labels`' : ''))
  run.check(`${runtime}/C: the status is untouched by the label call`, cMarks.sessionStatus === OPEN_STATUS,
    `the record reads ${JSON.stringify(cMarks.sessionStatus)}`)

  // ================= D - the user closes it from the status menu ============
  let pressed = 'not-attempted'
  try {
    await clickSelector(session, triggerSelector(key.sessionId))
    const item = `[cmdk-item][data-value=${JSON.stringify(closed.label)}], `
      + `[cmdk-item][data-value=${JSON.stringify(closed.label.toLowerCase())}]`
    await waitFor(() => readSelectorCount(session, item), count => count > 0, { timeoutMs: 8_000, intervalMs: 250 })
    await clickSelector(session, item)
    pressed = 'pressed'
  } catch (error) {
    pressed = `failed: ${String(error).slice(0, 240)}`
  }
  const dMarks = await settledMarks(session, key.sessionId, marks => marks.sessionStatus === CLOSED_STATUS)
  run.observe(`${runtime}/D: the status menu`, { pressed, item: closed.label, marks: dMarks, rowAfter: (await readRowIcon(session, key.sessionId)) !== null })
  run.check(`${runtime}/D: the user's status-menu choice closes the session ("${CLOSED_STATUS}")`,
    pressed === 'pressed' && dMarks.sessionStatus === CLOSED_STATUS,
    `menu ${pressed}; the record reads ${JSON.stringify(dMarks.sessionStatus)} - without this control, B's `
    + 'refusal is equally true of a setter that closes nothing')
  // A menu left open by a failed press would sit over the next runtime's New
  // Chat; Escape is a no-op when the press closed it.
  if (pressed !== 'pressed') await pressKey(session, 'Escape').catch(() => undefined)
}

async function readSelectorCount(session: CdpSession, selector: string): Promise<number> {
  return session.call<number>(`return document.querySelectorAll(${JSON.stringify(selector)}).length`)
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  await ensureDarkTheme(session)
  run.observe('window', await focusWindow(session))

  const connections = await listConnections(session)
  const cards: Array<[SittingRuntime, string | undefined]> = [
    ['pi', connections.find(row => runtimeOf(row.providerType) === 'pi')?.slug],
    ['claude', connections.find(row => runtimeOf(row.providerType) === 'anthropic')?.slug],
    ['codex', connections.find(row => runtimeOf(row.providerType) === 'codex-runtime')?.slug],
  ]
  run.observe('cards', Object.fromEntries(cards))
  const selected = cards.filter(([name]) => RUNTIME_WANTED.includes(name))
  if (selected.length === 0) blocked(`NESSY_CDP_RS109_RUNTIMES=${RUNTIME_WANTED.join(',')} names no runtime family`)
  if (selected.every(([, slug]) => slug === undefined)) {
    blocked(
      `none of ${selected.map(([name]) => name).join(', ')} has a card on this host; it lists `
      + `${connections.map(row => `${row.slug}(${row.providerType})`).join(', ') || 'nothing'}`,
    )
  }

  for (const [runtime, slug] of selected) {
    if (!slug) {
      run.check(`${runtime}: measured`, false,
        'UNMEASURED - no card of this family on the host; the Phase 1 cut needs all three runtimes, so a missing '
        + 'card is a FAIL here, never a pass')
      continue
    }
    try {
      await driveRuntime(run, session, runtime, slug)
    } catch (error) {
      // A precondition the whole sitting lacks stops the case as BLOCKED.
      if (error instanceof BlockedError) throw error
      // A `require` (or a throw) stops ONE runtime's arms, not the others'. It
      // is scored as a failure here as well, so a throw that recorded no check
      // of its own can never leave the case PASSING.
      run.check(`${runtime}: completed its arms`, false, String(error).slice(0, 300))
    }
  }
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}
