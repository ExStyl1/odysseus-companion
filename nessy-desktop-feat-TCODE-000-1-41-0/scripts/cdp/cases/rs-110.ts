/**
 * RS-110 (plan row UA2.7, 1.42.0 upstream adoption) - the Kanban board on the
 * shipped build: the List / Board toggle, a drag into Done with and without a
 * drop status, the placement surviving a reload, and the needs-input badge and
 * runtime chip of a session holding a permission card on Pi, Claude Code and
 * Codex.
 *
 * ## What it proves, one arm each
 *
 * Per runtime selected (`NESSY_CDP_RS110_RUNTIMES`, default `pi,claude,codex`):
 *
 * N.  **Needs input.** A fresh session on the runtime's card, set to `default`
 *     (read back), is asked to run a shell command that writes OUTSIDE any
 *     workspace (`mkdir -p ~/.nessy-cdp-rs110/<runtime>-<stamp>`), so a card is
 *     raised. Precondition read on the HOST: `awaitingApprovalCount > 0` on the
 *     session record. Then the board is opened and the session's tile must carry
 *     the needs-input badge (`[data-kanban-needs-input]`) and the runtime chip
 *     (`[data-kanban-runtime]`) naming the runtime (UA2.5).
 * N'. **The control on the same instrument.** The card is DENIED from the chat;
 *     once the host reads `awaitingApprovalCount` 0 the same tile must show NO
 *     badge, and the marker directory must not exist (the denied command did not
 *     run). Without it, N is equally true of a badge that is always on.
 *
 * Once, on two plain sessions of this run (no turn, status `todo`):
 *
 * T.  **The toggle.** From the session list, the list header's Board segment
 *     mounts the board (three `[data-kanban-column]` hooks); the board header's
 *     List segment returns to the list; Board again (UA2.2).
 * D1. **No drop status, no status change** (the negative). Done's drop status is
 *     cleared from its header pill; tile A dragged into Done gets
 *     `kanbanColumn: done` on the host record and renders under Done, while its
 *     status stays `todo` - placement is independent of the badge.
 * D2. **A drop status applies** (the positive). Done's drop status is set to the
 *     workspace's `done` from the same pill (read back from the per-viewer map
 *     `nessy-kanban-column-status`); tile B dragged into Done gets
 *     `kanbanColumn: done` AND `sessionStatus: done`; tile A is untouched (the
 *     mapping is not retroactive).
 * P.  **Persistence.** After a renderer reload, both records still read
 *     `kanbanColumn: done`, B still `done` and A still `todo`, both tiles render
 *     under Done, and Done's drop status is still `done`.
 *
 * ## The detectors, and why each is the one it is
 *
 * - **Placement and status: the host's own record** (`getSessions`:
 *   `kanbanColumn`, `sessionStatus`, `awaitingApprovalCount`), polled, never the
 *   tile's look. **"The board shows it": the DOM hooks** `data-kanban-column` on
 *   a column root and `data-kanban-task` on a tile's draggable wrapper
 *   (`KanbanColumn.tsx`, added by UA2.7 and pinned by
 *   `kanban/__tests__/board-dom-hooks.test.tsx`), so a tile is found by its
 *   session id and its column by id - no class name, no localised copy. A tile
 *   the board does not render reads `tile-not-rendered`, which FAILS.
 * - **The drag is a real pointer drag** (`Input.dispatchMouseEvent`: press on
 *   the tile's title, eight moves past dnd-kit's 5 px activation distance, release
 *   over the target column), at a grab point checked to sit under no
 *   `data-no-dnd` control. A synthetic `dragend` would skip the sensor this
 *   row ships.
 * - **The toggle is found by its own copy** (`kanban.board` / `kanban.list`, en
 *   or ru, {@link QUOTED_COPY}, pinned against the live locale by
 *   `harness.test.ts`) among `button[aria-pressed="false"]` — read from the
 *   segment's `aria-label` first (UB14.52: v0.15.1's segments are icon-only, the
 *   copy is their accessible name and tooltip), then its text.
 *
 * ## Runtimes, mode, and what it writes
 *
 * A selected family with no card on this host FAILS as unmeasured. The harness
 * default (`bypassPermissions`, D1.385) is applied at creation; the N arm's
 * sessions then set `default` THEMSELVES, read back - the card is the subject of
 * N (the `sets-its-own-mode` shape of `lib/permission-mode.ts`, as RS-108). The
 * board arms run no turn. The case writes only the app's own session store, the
 * per-viewer drop-status map (restored in a `finally` to its exact prior bytes),
 * and nothing on disk outside it (a marker directory is only ever created by a
 * command this case DENIES; it is removed in the `finally` if it exists). Every
 * session it creates is deleted in the `finally`. Not here: two windows
 * (UA2.1's ASK) and the playground sweep (UA2.6) - manual add-ons.
 */

import { existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { sendPrompt } from '../lib/chat.ts'
import { focusWindow, type CdpSession } from '../lib/connect.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import { ensureNoCard, readCard } from '../lib/permission-card.ts'
import { BlockedError, blocked, main, type CaseRun } from '../lib/report.ts'
import { listConnections, runtimeOf, switchRuntime, waitForConnection } from '../lib/runtime-switch.ts'
import {
  assertElectronApi, ensureSessionName, freshSession, sessionCommand, setPermissionMode, waitFor,
  type SessionKey,
} from '../lib/state.ts'
import { clickAt, clickSelector, getViewport, assertInViewport, type Point } from '../lib/viewport.ts'
import type { CaseMeta, SittingRuntime } from '../lib/sitting.ts'

const ID = 'RS-110'
const TITLE = 'Kanban board: the List / Board toggle, a drag into Done with and without a drop status, reload persistence, and needs-input on Pi, Claude Code and Codex'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'UA2.7',
  runtimes: ['pi', 'claude', 'codex'],
  credentials:
    'owner: one card per runtime that answers a turn (a `pi` card, a `claude-runtime` card, a `codex-runtime` card), '
    + 'already signed in; the card is named in the run notes. No key, token or credential file is read. The workspace '
    + 'keeps its default statuses (an open `todo`, a closed `done`). The window is wide enough for the session list '
    + 'header to show the List / Board toggle (desktop widths; a compact shell hides it).',
} as const satisfies CaseMeta

/**
 * The toggle's two segments, as the live locale spells them - pinned by
 * `harness.test.ts` ("a case's quoted copy against the live locale").
 */
export const QUOTED_COPY = {
  'kanban.board': { en: 'Board', ru: 'Доска' },
  'kanban.list': { en: 'List', ru: 'Список' },
} as const

/**
 * The runtime chip's label per family: `runtimeLabel` in
 * `apps/electron/src/renderer/components/app-shell/input/runtime-switch-copy.ts`
 * (`RUNTIME_LABELS`), which this harness may not import (its module graph needs
 * the renderer's path aliases). Pinned against that file's source by
 * `scripts/cdp/rs-110-board-score.test.ts`.
 */
export const RUNTIME_CHIP_LABEL: Readonly<Record<SittingRuntime, string>> = {
  pi: 'Pi',
  claude: 'Claude',
  codex: 'Codex',
}

/** The board's built-in column ids, in board order (`status-column.ts` `KANBAN_COLUMNS`, pinned by the score test). */
export const BOARD_COLUMNS = ['todo', 'in-progress', 'done'] as const

/** The per-viewer drop-status map (`atoms/kanban.ts` `kanbanColumnStatusAtom`, pinned by the score test). */
export const DROP_STATUS_STORAGE_KEY = 'nessy-kanban-column-status'

const RUNTIME_WANTED = (process.env.NESSY_CDP_RS110_RUNTIMES ?? 'pi,claude,codex')
  .split(',').map(name => name.trim()).filter(Boolean)

const OPEN_STATUS = 'todo'
const CLOSED_STATUS = 'done'
const DONE_COLUMN = 'done'
/** A card can take a cold codex spawn to appear; the turn after the denial is short. */
const CARD_MS = 240_000
const TURN_MS = 300_000

/** One tile as the board renders it - `null` when the board does not render it. */
export interface TileReading {
  column: string | null
  needsInput: boolean
  runtime: string | null
}

/** The host's record of one session, as the board derives a tile from it. */
interface SessionRecord {
  found: boolean
  sessionStatus: string | null
  kanbanColumn: string | null
  awaitingApprovalCount: number
  permissionMode: string | null
}

export interface Verdict {
  ok: boolean
  detail: string
}

/**
 * Score a tile against what an arm wants of it. An unrendered tile always
 * fails - never "no badge, so the badge is absent" - and every wanted field is
 * compared, so a tile in the right column with the wrong badge fails too.
 */
export function tileVerdict(
  tile: TileReading | null,
  want: { column?: string; needsInput?: boolean; runtime?: string },
): Verdict {
  if (tile === null) {
    return { ok: false, detail: 'tile-not-rendered: no [data-kanban-task] for this session on the board, so nothing about it can be read' }
  }
  const misses: string[] = []
  if (want.column !== undefined && tile.column !== want.column) misses.push(`column ${JSON.stringify(tile.column)}, not ${JSON.stringify(want.column)}`)
  if (want.needsInput !== undefined && tile.needsInput !== want.needsInput) {
    misses.push(want.needsInput ? 'no needs-input badge' : 'a needs-input badge is still shown')
  }
  if (want.runtime !== undefined && tile.runtime !== want.runtime) misses.push(`runtime chip ${JSON.stringify(tile.runtime)}, not ${JSON.stringify(want.runtime)}`)
  return { ok: misses.length === 0, detail: misses.length === 0 ? 'as wanted' : misses.join('; ') }
}

/** Score a session record after a drop: the placement, and the status the drop should (or should not) have applied. */
export function dropVerdict(
  record: Pick<SessionRecord, 'found' | 'kanbanColumn' | 'sessionStatus'>,
  want: { column: string; status: string },
): Verdict {
  if (!record.found) return { ok: false, detail: 'the session record is gone' }
  const misses: string[] = []
  if (record.kanbanColumn !== want.column) misses.push(`kanbanColumn ${JSON.stringify(record.kanbanColumn)}, not ${JSON.stringify(want.column)}`)
  if (record.sessionStatus !== want.status) misses.push(`sessionStatus ${JSON.stringify(record.sessionStatus)}, not ${JSON.stringify(want.status)}`)
  return { ok: misses.length === 0, detail: misses.length === 0 ? 'as wanted' : misses.join('; ') }
}

const tileSelector = (sessionId: string): string => `[data-kanban-task=${JSON.stringify(sessionId)}]`
const columnSelector = (columnId: string): string => `[data-kanban-column=${JSON.stringify(columnId)}]`

async function readRecord(session: CdpSession, sessionId: string): Promise<SessionRecord> {
  return session.call<SessionRecord>(`
    const s = ((await window.electronAPI.getSessions()) ?? []).find(row => row.id === ${JSON.stringify(sessionId)})
    if (!s) return { found: false, sessionStatus: null, kanbanColumn: null, awaitingApprovalCount: 0, permissionMode: null }
    return {
      found: true,
      sessionStatus: typeof s.sessionStatus === 'string' ? s.sessionStatus : null,
      kanbanColumn: typeof s.kanbanColumn === 'string' ? s.kanbanColumn : null,
      awaitingApprovalCount: typeof s.awaitingApprovalCount === 'number' ? s.awaitingApprovalCount : 0,
      permissionMode: typeof s.permissionMode === 'string' ? s.permissionMode : null,
    }
  `)
}

async function settledRecord(
  session: CdpSession,
  sessionId: string,
  accept: (record: SessionRecord) => boolean,
  timeoutMs = 15_000,
): Promise<SessionRecord> {
  try {
    return await waitFor(() => readRecord(session, sessionId), accept, { timeoutMs, intervalMs: 1_000 })
  } catch {
    return readRecord(session, sessionId)
  }
}

async function readTile(session: CdpSession, sessionId: string): Promise<TileReading | null> {
  return session.call<TileReading | null>(`
    const tile = document.querySelector(${JSON.stringify(tileSelector(sessionId))})
    if (!tile) return null
    const column = tile.closest('[data-kanban-column]')
    const chip = tile.querySelector('[data-kanban-runtime]')
    return {
      column: column ? column.getAttribute('data-kanban-column') : null,
      needsInput: tile.querySelector('[data-kanban-needs-input]') !== null,
      runtime: chip ? chip.getAttribute('data-kanban-runtime') : null,
    }
  `)
}

/** Poll the tile until `accept` holds or 15 s pass; the last reading either way. */
async function settledTile(
  session: CdpSession,
  sessionId: string,
  accept: (tile: TileReading | null) => boolean,
): Promise<TileReading | null> {
  try {
    return await waitFor(() => readTile(session, sessionId), accept, { timeoutMs: 15_000, intervalMs: 500 })
  } catch {
    return readTile(session, sessionId)
  }
}

async function boardColumns(session: CdpSession): Promise<string[]> {
  return session.call<string[]>(`
    return Array.from(document.querySelectorAll('[data-kanban-column]')).map(el => el.getAttribute('data-kanban-column') ?? '')
  `)
}

async function navigateRoute(session: CdpSession, route: string): Promise<void> {
  await session.call<null>(`
    window.dispatchEvent(new CustomEvent('nessy-agent-navigate', { detail: { route: ${JSON.stringify(route)} }, bubbles: true }))
    return null
  `)
}

/** Wait until the board is mounted (all three built-in column hooks) or it is not, per `want`. */
async function waitForBoard(session: CdpSession, want: boolean, timeoutMs = 15_000): Promise<boolean> {
  const mounted = (columns: string[]): boolean => BOARD_COLUMNS.every(id => columns.includes(id))
  try {
    await waitFor(() => boardColumns(session), columns => mounted(columns) === want, { timeoutMs, intervalMs: 500 })
    return true
  } catch {
    return false
  }
}

/**
 * Press one of the toggle's segments by its own copy. Only an UNPRESSED segment
 * is a target (the active one is `aria-pressed="true"`), so the list header's
 * Board and the board header's List are the only candidates in their views.
 */
async function pressToggle(session: CdpSession, key: 'kanban.board' | 'kanban.list'): Promise<string> {
  const labels = Object.values(QUOTED_COPY[key])
  const marked = await session.call<number>(`
    document.querySelectorAll('[data-rs110-target]').forEach(el => el.removeAttribute('data-rs110-target'))
    const labels = ${JSON.stringify(labels)}
    const hits = Array.from(document.querySelectorAll('button[aria-pressed="false"]'))
      .filter(el => labels.includes((el.getAttribute('aria-label') || el.innerText || el.textContent || '').trim()))
    hits.forEach(el => el.setAttribute('data-rs110-target', 'toggle'))
    return hits.length
  `)
  if (marked === 0) return `not-found: no unpressed ${JSON.stringify(labels)} segment on screen`
  await clickSelector(session, '[data-rs110-target="toggle"]')
  return marked === 1 ? 'pressed' : `pressed (the first of ${marked} matches)`
}

/** Open a session's chat by the renderer's own navigation event, and wait for its row to be selected. */
async function openSession(session: CdpSession, sessionId: string): Promise<boolean> {
  await navigateRoute(session, `allSessions/session/${sessionId}`)
  try {
    await waitFor(
      () => session.call<string | null>(`
        const rows = document.querySelectorAll('.session-item[data-selected]')
        return rows.length === 1 ? rows[0].getAttribute('data-session-id') : null
      `),
      selected => selected === sessionId,
      { timeoutMs: 20_000, intervalMs: 500 },
    )
    return true
  } catch {
    return false
  }
}

/** The per-viewer drop-status map, raw (`null` when the key is absent). */
async function readDropStatusRaw(session: CdpSession): Promise<string | null> {
  return session.call<string | null>(`return window.localStorage.getItem(${JSON.stringify(DROP_STATUS_STORAGE_KEY)})`)
}

function parseDropStatus(raw: string | null): Record<string, unknown> {
  try {
    const value: unknown = raw === null ? {} : JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** Open Done's header pill and press one menu item (a status by its label, or the clear item). */
async function pickDropStatus(session: CdpSession, item: { label: string } | 'clear'): Promise<string> {
  try {
    await clickSelector(session, `${columnSelector(DONE_COLUMN)} > div:first-child button`)
    const selector = item === 'clear'
      ? '[cmdk-item][data-value="clear-status"]'
      : `[cmdk-item][data-value=${JSON.stringify(item.label)}], [cmdk-item][data-value=${JSON.stringify(item.label.toLowerCase())}]`
    await waitFor(
      () => session.call<number>(`return document.querySelectorAll(${JSON.stringify(selector)}).length`),
      count => count > 0,
      { timeoutMs: 8_000, intervalMs: 250 },
    )
    await clickSelector(session, selector)
    return 'pressed'
  } catch (error) {
    return `failed: ${String(error).slice(0, 240)}`
  }
}

/**
 * A real pointer drag of a tile into a column. The grab point is on the tile
 * and under no `data-no-dnd` control (the pencil, the status picker and the
 * subtask toggle all carry it); the moves cross dnd-kit's 5 px activation
 * distance before the release over the column's body.
 */
async function dragTile(session: CdpSession, sessionId: string, toColumn: string): Promise<string> {
  const geometry = await session.call<{ start?: Point; end?: Point; why?: string }>(`
    const tile = document.querySelector(${JSON.stringify(tileSelector(sessionId))})
    const column = document.querySelector(${JSON.stringify(columnSelector(toColumn))})
    if (!tile) return { why: 'tile-not-rendered' }
    if (!column) return { why: 'column-not-rendered' }
    tile.scrollIntoView({ block: 'center' })
    const t = tile.getBoundingClientRect()
    const c = column.getBoundingClientRect()
    let start
    for (const [fx, dy] of [[0.25, 18], [0.2, 30], [0.4, 18], [0.3, 44]]) {
      const x = t.x + t.width * fx
      const y = t.y + Math.min(dy, t.height / 2)
      const el = document.elementFromPoint(x, y)
      if (el && tile.contains(el) && !el.closest('[data-no-dnd="true"]')) { start = { x: Math.round(x), y: Math.round(y) }; break }
    }
    if (!start) return { why: 'no grab point on the tile is free of data-no-dnd controls' }
    return { start, end: { x: Math.round(c.x + c.width / 2), y: Math.round(c.y + Math.min(c.height / 2, 220)) } }
  `)
  if (!geometry.start || !geometry.end) return `not-dragged: ${geometry.why ?? 'no geometry'}`
  const viewport = await getViewport(session)
  assertInViewport(viewport, geometry.start, 'drag start')
  assertInViewport(viewport, geometry.end, 'drag end')
  const mouse = async (type: 'mouseMoved' | 'mousePressed' | 'mouseReleased', point: Point, buttons: number): Promise<void> => {
    await session.send('Input.dispatchMouseEvent', {
      type, x: point.x, y: point.y, button: 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1,
    })
  }
  const { start, end } = geometry
  await mouse('mouseMoved', start, 0)
  await mouse('mousePressed', start, 1)
  const STEPS = 8
  for (let step = 1; step <= STEPS; step += 1) {
    await mouse('mouseMoved', {
      x: Math.round(start.x + ((end.x - start.x) * step) / STEPS),
      y: Math.round(start.y + ((end.y - start.y) * step) / STEPS),
    }, 1)
    await Bun.sleep(40)
  }
  await Bun.sleep(150)
  await mouse('mouseReleased', end, 0)
  return 'dragged'
}

/** A session this case owns, deleted in the `finally`. */
async function ownSession(
  run: CaseRun,
  session: CdpSession,
  owned: string[],
  label: string,
): Promise<SessionKey> {
  const name = `CDP ${ID} ${label} ${new Date().toISOString().slice(11, 19)}`
  const key = await freshSession(session, name)
  run.require(`${label}: ran in a session it created`, key.fresh,
    `inherited ${key.inheritedMessages} messages; reason: ${key.reason ?? '(none given)'}`)
  owned.push(key.sessionId)
  return key
}

async function driveNeedsInput(
  run: CaseRun,
  session: CdpSession,
  runtime: SittingRuntime,
  slug: string,
  owned: string[],
  markers: string[],
): Promise<void> {
  const key = await ownSession(run, session, owned, runtime)
  await switchRuntime(session, key.sessionId, slug)
  run.require(`${runtime}: the session runs on ${slug}`,
    (await waitForConnection(session, key.sessionId, slug)) === slug, slug)
  const renamed = await ensureSessionName(session, key, `CDP ${ID} ${runtime} needs-input`)
  if (renamed) run.observe(`${runtime}: the name after the runtime switch`, renamed)
  await sessionCommand(session, key.sessionId, { type: 'setSessionStatus', state: OPEN_STATUS }).catch(() => undefined)
  await setPermissionMode(session, key.sessionId, 'default')
  const mode = (await settledRecord(session, key.sessionId, record => record.permissionMode === 'default')).permissionMode
  run.require(`${runtime}: the session really is in \`default\`, so the command asks`, mode === 'default',
    `resolved ${String(mode)} - bypassPermissions or auto would run it with no card, and N would read nothing`)
  await focusWindow(session)

  // ============ N - a held card shows as a needs-input badge on the tile ============
  const marker = join(homedir(), '.nessy-cdp-rs110', `${runtime}-${Date.now()}`)
  markers.push(marker)
  const prompt = 'Run this exact shell command and show me its output. Use it verbatim as the whole command, '
    + `with nothing before it and nothing after it: mkdir -p ${marker}`
  const turn = sendPrompt(session, key, prompt, TURN_MS).then(() => 'completed', error => `threw: ${String(error).slice(0, 200)}`)
  const held = await settledRecord(session, key.sessionId, record => record.awaitingApprovalCount > 0, CARD_MS)
  run.observe(`${runtime}/N: the host record while the turn runs`, held)
  const measured = run.check(`${runtime}/N: a permission card is held (host awaitingApprovalCount > 0)`,
    held.awaitingApprovalCount > 0,
    `UNMEASURED - no card in ${CARD_MS / 1000} s, so the badge cannot be read; the card on screen: `
    + `${JSON.stringify((await readCard(session)).text.slice(0, 200))}`
    + (runtime === 'codex' ? ' - on codex check the mode mapped to an approval policy that asks' : ''))

  const toBoard = await pressToggle(session, 'kanban.board')
  if (!(await waitForBoard(session, true))) {
    run.observe(`${runtime}/N: the list header's Board segment did not mount the board (${toBoard}); using the route`, toBoard)
    await navigateRoute(session, 'board')
    await waitForBoard(session, true)
  }
  const tileHeld = await settledTile(session, key.sessionId, tile => tile?.needsInput === true)
  const heldVerdict = tileVerdict(tileHeld, { needsInput: true, runtime: RUNTIME_CHIP_LABEL[runtime] })
  run.observe(`${runtime}/N: the tile`, tileHeld)
  if (measured) run.check(`${runtime}/N: the tile shows the needs-input badge and the ${RUNTIME_CHIP_LABEL[runtime]} chip`, heldVerdict.ok, heldVerdict.detail)

  // ============ N' - the denied card clears the badge (the control) ==================
  const opened = await openSession(session, key.sessionId)
  run.observe(`${runtime}/N': the chat reopened for the denial`, opened)
  const leftover = await ensureNoCard(session, `${runtime}/N'`)
  const turnEnd = await turn
  const cleared = await settledRecord(session, key.sessionId, record => record.awaitingApprovalCount === 0, 30_000)
  run.observe(`${runtime}/N': after the denial`, { leftover, turn: turnEnd, record: cleared })
  await navigateRoute(session, 'board')
  await waitForBoard(session, true)
  const tileCleared = await settledTile(session, key.sessionId, tile => tile !== null && !tile.needsInput)
  const clearedVerdict = tileVerdict(tileCleared, { needsInput: false, runtime: RUNTIME_CHIP_LABEL[runtime] })
  run.observe(`${runtime}/N': the tile`, tileCleared)
  if (measured) {
    run.check(`${runtime}/N': the host reads no held card after the denial`, cleared.awaitingApprovalCount === 0,
      `awaitingApprovalCount ${cleared.awaitingApprovalCount} 30 s after the denial; leftover: ${leftover ?? 'none'}`)
    run.check(`${runtime}/N': the same tile shows no badge once the card is answered`, clearedVerdict.ok, clearedVerdict.detail)
  }
  run.check(`${runtime}/N': the denied command did not run`, !existsSync(marker),
    `${marker} exists - the command ran although its card was denied (or was never asked)`)
}

async function driveBoard(run: CaseRun, session: CdpSession, owned: string[]): Promise<void> {
  const a = await ownSession(run, session, owned, 'drag A')
  const b = await ownSession(run, session, owned, 'drag B')
  const statuses = await session.call<Array<{ id: string; label: string; category?: string }>>(`
    return ((await window.electronAPI.listStatuses(${JSON.stringify(a.workspaceId)})) ?? [])
      .map(s => ({ id: s.id, label: s.label, category: s.category }))
  `)
  const open = statuses.find(row => row.id === OPEN_STATUS)
  const closed = statuses.find(row => row.id === CLOSED_STATUS)
  run.observe('the workspace statuses', statuses.map(row => `${row.id}(${row.category ?? '?'})`))
  run.require(`the workspace has an open "${OPEN_STATUS}" and a closed "${CLOSED_STATUS}"`,
    open?.category === 'open' && closed?.category === 'closed',
    `this case asks for the DEFAULT statuses; the workspace lists ${JSON.stringify(statuses)}`)
  const doneLabel = closed?.label ?? CLOSED_STATUS
  for (const key of [a, b]) {
    await sessionCommand(session, key.sessionId, { type: 'setSessionStatus', state: OPEN_STATUS }).catch(() => undefined)
  }
  for (const [label, key] of [['A', a], ['B', b]] as const) {
    const record = await settledRecord(session, key.sessionId, row => row.sessionStatus === OPEN_STATUS)
    run.require(`drag ${label}: starts in "${OPEN_STATUS}" with no stored column`,
      record.sessionStatus === OPEN_STATUS && record.kanbanColumn === null, JSON.stringify(record))
  }

  // ================= T - the toggle ===================================================
  await navigateRoute(session, 'allSessions')
  await waitForBoard(session, false)
  const t1 = await pressToggle(session, 'kanban.board')
  const t1Board = await waitForBoard(session, true)
  const t2 = await pressToggle(session, 'kanban.list')
  const t2List = await waitForBoard(session, false)
  const t3 = await pressToggle(session, 'kanban.board')
  const t3Board = await waitForBoard(session, true)
  run.observe('T: the toggle presses', { t1, t2, t3, columns: await boardColumns(session) })
  run.check('T: the list header\'s Board segment opens the board', t1 === 'pressed' && t1Board, `${t1}; board mounted: ${t1Board}`)
  run.check('T: the board header\'s List segment returns to the list', t2 === 'pressed' && t2List, `${t2}; board unmounted: ${t2List}`)
  run.check('T: Board again opens the board', t3 === 'pressed' && t3Board, `${t3}; board mounted: ${t3Board}`)
  if (!t3Board) {
    await navigateRoute(session, 'board')
    run.require('the board is mounted for the drag arms', await waitForBoard(session, true), 'no [data-kanban-column] hooks after the board route')
  }
  for (const [label, key] of [['A', a], ['B', b]] as const) {
    const tile = await settledTile(session, key.sessionId, reading => reading?.column === 'todo')
    const verdict = tileVerdict(tile, { column: 'todo' })
    run.require(`drag ${label}: its tile starts under To do`, verdict.ok, verdict.detail)
  }

  // ================= D1 - no drop status, no status change ============================
  const cleared = await pickDropStatus(session, 'clear')
  const clearedMap = parseDropStatus(await readDropStatusRaw(session))
  run.observe('D1: Done\'s drop status cleared from its pill', { pressed: cleared, map: clearedMap })
  run.require('D1: Done has no drop status', !(DONE_COLUMN in clearedMap), `${cleared}; the map reads ${JSON.stringify(clearedMap)}`)
  const dragA = await dragTile(session, a.sessionId, DONE_COLUMN)
  const aRecord = await settledRecord(session, a.sessionId, record => record.kanbanColumn === DONE_COLUMN)
  await Bun.sleep(3_000)
  const aSettled = await readRecord(session, a.sessionId)
  const aTile = await settledTile(session, a.sessionId, tile => tile?.column === DONE_COLUMN)
  run.observe('D1: tile A dragged into Done', { drag: dragA, record: aSettled, firstRead: aRecord, tile: aTile })
  const aDrop = dropVerdict(aSettled, { column: DONE_COLUMN, status: OPEN_STATUS })
  run.check('D1: A is placed in Done and keeps its status (no drop status mapped)', dragA === 'dragged' && aDrop.ok, `${dragA}; ${aDrop.detail}`)
  const aView = tileVerdict(aTile, { column: DONE_COLUMN })
  run.check('D1: the board renders A under Done', aView.ok, aView.detail)

  // ================= D2 - a drop status applies =======================================
  const set = await pickDropStatus(session, { label: doneLabel })
  const setMap = parseDropStatus(await readDropStatusRaw(session))
  run.observe('D2: Done\'s drop status set from its pill', { pressed: set, map: setMap })
  run.require(`D2: Done's drop status reads "${CLOSED_STATUS}"`, setMap[DONE_COLUMN] === CLOSED_STATUS,
    `${set}; the map reads ${JSON.stringify(setMap)}`)
  const dragB = await dragTile(session, b.sessionId, DONE_COLUMN)
  const bRecord = await settledRecord(session, b.sessionId,
    record => record.kanbanColumn === DONE_COLUMN && record.sessionStatus === CLOSED_STATUS)
  const bTile = await settledTile(session, b.sessionId, tile => tile?.column === DONE_COLUMN)
  const aAfter = await readRecord(session, a.sessionId)
  run.observe('D2: tile B dragged into Done', { drag: dragB, record: bRecord, tile: bTile, aAfter })
  const bDrop = dropVerdict(bRecord, { column: DONE_COLUMN, status: CLOSED_STATUS })
  run.check(`D2: B is placed in Done AND its status becomes "${CLOSED_STATUS}"`, dragB === 'dragged' && bDrop.ok, `${dragB}; ${bDrop.detail}`)
  const bView = tileVerdict(bTile, { column: DONE_COLUMN })
  run.check('D2: the board renders B under Done', bView.ok, bView.detail)
  const aKept = dropVerdict(aAfter, { column: DONE_COLUMN, status: OPEN_STATUS })
  run.check('D2: A is untouched by the new mapping (not retroactive)', aKept.ok, aKept.detail)

  // ================= P - persistence across a reload ==================================
  await session.send('Page.reload', {})
  await waitFor(
    () => session.call<boolean>(`return typeof window.electronAPI?.getSessions === 'function'`).catch(() => false),
    ready => ready,
    { timeoutMs: 30_000, intervalMs: 500 },
  ).catch(() => undefined)
  await Bun.sleep(2_000)
  await focusWindow(session)
  await navigateRoute(session, 'board')
  const boardBack = await waitForBoard(session, true, 30_000)
  const aReload = await readRecord(session, a.sessionId)
  const bReload = await readRecord(session, b.sessionId)
  const aTileReload = await settledTile(session, a.sessionId, tile => tile?.column === DONE_COLUMN)
  const bTileReload = await settledTile(session, b.sessionId, tile => tile?.column === DONE_COLUMN)
  const mapReload = parseDropStatus(await readDropStatusRaw(session))
  run.observe('P: after the reload', { boardBack, aReload, bReload, aTileReload, bTileReload, mapReload })
  const aP = dropVerdict(aReload, { column: DONE_COLUMN, status: OPEN_STATUS })
  const bP = dropVerdict(bReload, { column: DONE_COLUMN, status: CLOSED_STATUS })
  run.check('P: A\'s placement survives the reload (Done, status kept)', aP.ok, aP.detail)
  run.check('P: B\'s placement and status survive the reload (Done, done)', bP.ok, bP.detail)
  const aPView = tileVerdict(aTileReload, { column: DONE_COLUMN })
  const bPView = tileVerdict(bTileReload, { column: DONE_COLUMN })
  run.check('P: the reloaded board renders both tiles under Done', boardBack && aPView.ok && bPView.ok,
    `board mounted: ${boardBack}; A: ${aPView.detail}; B: ${bPView.detail}`)
  run.check(`P: Done's drop status is still "${CLOSED_STATUS}"`, mapReload[DONE_COLUMN] === CLOSED_STATUS, JSON.stringify(mapReload))
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
  if (selected.length === 0) blocked(`NESSY_CDP_RS110_RUNTIMES=${RUNTIME_WANTED.join(',')} names no runtime family`)

  const owned: string[] = []
  const markers: string[] = []
  const dropStatusBefore = await readDropStatusRaw(session)
  run.observe('the drop-status map before the case', dropStatusBefore)
  try {
    for (const [runtime, slug] of selected) {
      if (!slug) {
        run.check(`${runtime}: measured`, false,
          'UNMEASURED - no card of this family on the host; the board needs-input row names all three runtimes, so a '
          + 'missing card is a FAIL here, never a pass')
        continue
      }
      try {
        await driveNeedsInput(run, session, runtime, slug, owned, markers)
      } catch (error) {
        if (error instanceof BlockedError) throw error
        run.check(`${runtime}: completed its arms`, false, String(error).slice(0, 300))
      }
    }

    try {
      await driveBoard(run, session, owned)
    } catch (error) {
      if (error instanceof BlockedError) throw error
      run.check('board: completed its arms', false, String(error).slice(0, 300))
    }
  } finally {
    const restored = await session.call<string>(`
      const raw = ${JSON.stringify(dropStatusBefore)}
      if (raw === null) window.localStorage.removeItem(${JSON.stringify(DROP_STATUS_STORAGE_KEY)})
      else window.localStorage.setItem(${JSON.stringify(DROP_STATUS_STORAGE_KEY)}, raw)
      return String(window.localStorage.getItem(${JSON.stringify(DROP_STATUS_STORAGE_KEY)}))
    `).catch(error => `restore failed: ${String(error).slice(0, 200)}`)
    const deleted: Record<string, string> = {}
    for (const id of owned) {
      deleted[id] = await session.call<string>(`
        try { await window.electronAPI.deleteSession(${JSON.stringify(id)}); return 'deleted' }
        catch (e) { return 'delete failed: ' + String(e && e.message || e).slice(0, 160) }
      `).catch(error => `delete failed: ${String(error).slice(0, 160)}`)
    }
    for (const marker of markers) {
      if (existsSync(marker)) rmSync(marker, { recursive: true, force: true })
    }
    run.observe('cleanup', { dropStatusRestored: restored, deleted })
    // The drop-status atom reads storage when the board mounts again; a reload makes the restore take now.
    await session.send('Page.reload', {}).catch(() => undefined)
  }
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}
