/**
 * RS-111 (plan row UA3.9, 1.42.0 upstream adoption) - durable tasks on the
 * shipped build: a two-subtask task shows 0/2 on its tile, the agent's
 * `create_board_task` lands a task in To do WITHOUT running it on Pi, Claude
 * Code and Codex, and the tool refuses - with its reason, creating nothing - a
 * foreign folder, a source the calling session has not enabled, and another
 * connection.
 *
 * ## What it proves, one arm each
 *
 * Once:
 *
 * A.  **Two subtasks read 0/2.** A task with two nodes (B depends on A) is
 *     created through `tasks:create` - the channel and request shape the
 *     TaskEditor's Create sends (`buildTaskCreateRequest`: the spec as text, no
 *     folder) - and its orchestrator's tile carries a subtask progress bar
 *     reading 0 of 2 (`[role=progressbar]` `aria-valuenow` / `aria-valuemax`),
 *     merged from the spec's never-run nodes (UA3.6). The editor's FORM is not
 *     driven here: the form -> spec path is pinned offline by
 *     `kanban/__tests__/task-spec-form.test.ts`, and the editor's on-screen
 *     checks are the UA3.6 manual add-on in the sitting ASK.
 *
 * Per runtime selected (`NESSY_CDP_RS111_RUNTIMES`, default `pi,claude,codex`),
 * in a fresh `bypassPermissions` session on the runtime's card:
 *
 * B.  **Created in To do, not running.** Asked to call `create_board_task` with a
 *     stamped title, the tool answers `{ slug, orchestratorSessionId, ... }`; the
 *     host then lists the slug (`tasks:list`), its spec has exactly ONE node,
 *     `main` (`tasks:get`), the orchestrator's record reads `todo` with its
 *     `taskSlug`, and 10 s later it is still idle in `todo`, its LIVE transcript
 *     (`getSessionMessages`) is empty and no session was dispatched for the task
 *     (none with it as `parentSessionId`, none with its `taskSlug` and a
 *     `taskNodeId`) - never the list row's `messageCount`, a header-only count
 *     that does not move while a session runs (UA3.9 follow-up) - and its tile
 *     renders under To do (`data-kanban-column` / `data-kanban-task`,
 *     UA2.7's hooks). On codex the tool row is also the evidence that the
 *     host-callback bridge is up (UA3.5 offers the tool only with it).
 * B2. **The same title again takes `-2`.** The second call's slug is the first
 *     one's plus `-2`, and both specs exist.
 * C1. **A foreign folder is refused** (`workingDirectory: "/etc"`):
 *     `project-handle-required`.
 * C2. **A source not enabled in this session is refused**: the session's sources
 *     are first set to none (a session state write, read back), then a workspace
 *     source is asked for: `board-task-source-not-enabled`.
 * C3. **Another connection is refused** (any other card's slug):
 *     `board-task-connection-refused`.
 *     For each of C1-C3, `tasks:list` is unchanged after the turn - nothing was
 *     created - and the refusal is the TOOL's own result naming the code, never
 *     the model's prose. A turn with no tool call is asked once more, firmer and
 *     positive; still no call is `declined-by-model` and FAILS as UNMEASURED
 *     (RS-109's rule, `scoreBoardTaskRefusal`).
 *
 * ## Detectors
 *
 * The host's own records (`getSessions`, `tasks:list`, `tasks:get`) and the
 * turn's own tool rows (`turnRowsSince`, F1.521), matched on `create_board_task`
 * in `toolName` / `toolDisplayName`. The refusal codes are the literals of
 * `packages/server-core/src/tasks/create-board-task.ts`, pinned against that
 * source by `scripts/cdp/rs-111-tasks-score.test.ts`.
 *
 * ## What it writes
 *
 * Only the app's own session store and the workspace's `tasks/<slug>/` folders
 * of the tasks it creates; every session it created is deleted in a `finally`
 * (an orchestrator's delete removes its task folder, UA3.8) and a folder left
 * behind is removed through `tasks:delete`. C2 needs at least one source in the
 * workspace (any); without one that arm FAILS as unmeasured. Not here: the
 * delete-dialog and archive checks of UA3.8 and the editor's on-screen checks of
 * UA3.6 - manual add-ons in the ASK.
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { sendPrompt } from '../lib/chat.ts'
import { focusWindow, type CdpSession } from '../lib/connect.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import { BlockedError, blocked, main, type CaseRun } from '../lib/report.ts'
import { listConnections, resolveConfigDir, runtimeOf, switchRuntime, waitForConnection } from '../lib/runtime-switch.ts'
import {
  assertElectronApi, ensureSessionName, freshSession, sessionCommand, transcript, waitFor,
  type SessionKey, type TranscriptMessage,
} from '../lib/state.ts'
import { turnReply, turnRowsSince } from '../lib/turn-evidence.ts'
import type { CaseMeta, SittingRuntime } from '../lib/sitting.ts'

const ID = 'RS-111'
const TITLE = 'Durable tasks: two subtasks read 0/2, create_board_task lands in To do without running on Pi, Claude Code and Codex, and a foreign folder, a source not enabled and another connection are refused'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'UA3.9',
  runtimes: ['pi', 'claude', 'codex'],
  credentials:
    'owner: one card per runtime that answers a turn (a `pi` card, a `claude-runtime` card, a `codex-runtime` card), '
    + 'already signed in; the card is named in the run notes; at least TWO cards in all (C3 asks for another one). '
    + 'No key, token or credential file is read. The workspace keeps its default `todo` status and holds at least '
    + 'one source (any - C2 only turns sources off in its own session).',
} as const satisfies CaseMeta

/** The refusal codes of `create-board-task.ts`, one per restriction (pinned against that source by the score test). */
export const REFUSAL_CODES = {
  folder: 'project-handle-required',
  source: 'board-task-source-not-enabled',
  connection: 'board-task-connection-refused',
} as const

const RUNTIME_WANTED = (process.env.NESSY_CDP_RS111_RUNTIMES ?? 'pi,claude,codex')
  .split(',').map(name => name.trim()).filter(Boolean)

const OPEN_STATUS = 'todo'
const TURN_MS = 240_000
const FOREIGN_FOLDER = '/etc'

export type RefusalVerdict = 'declined-by-model' | 'refused-by-tool' | 'called-not-refused'

/** A refusal arm's score over the turn's `create_board_task` rows: only the tool's own answer naming `code` passes. */
export function scoreBoardTaskRefusal(
  calls: readonly Pick<TranscriptMessage, 'toolResult'>[],
  code: string,
): { ok: boolean; verdict: RefusalVerdict; detail: string } {
  const refused = calls.some(row => (row.toolResult ?? '').includes(code))
  const verdict: RefusalVerdict = calls.length === 0 ? 'declined-by-model' : refused ? 'refused-by-tool' : 'called-not-refused'
  return {
    ok: refused,
    verdict,
    detail: calls.length === 0
      ? 'UNMEASURED - declined-by-model: no create_board_task call in the turn (or its re-ask), so the restriction '
        + 'never answered; a prose refusal is not the tool refusing - re-run'
      : `the call(s) answered ${JSON.stringify(calls.map(row => (row.toolResult ?? '').slice(0, 200)))}, not ${code}`,
  }
}

/** The `{ slug, orchestratorSessionId }` a successful `create_board_task` result carries, or `null`. */
export function parseCreateResult(toolResult: string | undefined): { slug: string; orchestratorSessionId: string } | null {
  const text = toolResult ?? ''
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as { slug?: unknown; orchestratorSessionId?: unknown }
    return typeof value.slug === 'string' && value.slug && typeof value.orchestratorSessionId === 'string' && value.orchestratorSessionId
      ? { slug: value.slug, orchestratorSessionId: value.orchestratorSessionId }
      : null
  } catch {
    return null
  }
}

/** B's "not run" reading: the orchestrator's record, its live transcript length, and the sessions dispatched for the task. */
export interface NotRunReading {
  found: boolean
  isProcessing: boolean
  sessionStatus: string | null
  orchestratorMessages: number
  children: string[]
}

/** Not run = found, idle, still `todo`, nothing in its live transcript, and no child node session dispatched. */
export function scoreTaskNotRun(reading: NotRunReading): { ok: boolean; detail: string } {
  const faults = [
    ...(reading.found ? [] : ['orchestrator-not-found']),
    ...(reading.isProcessing ? ['orchestrator-processing'] : []),
    ...(reading.sessionStatus === OPEN_STATUS ? [] : [`status ${JSON.stringify(reading.sessionStatus)}`]),
    ...(reading.orchestratorMessages === 0 ? [] : [reading.orchestratorMessages < 0
      ? `the orchestrator's transcript was unreadable`
      : `${reading.orchestratorMessages} message(s) in the orchestrator's transcript`]),
    ...(reading.children.length === 0 ? [] : [`child session(s) dispatched: ${JSON.stringify(reading.children)}`]),
  ]
  return { ok: faults.length === 0, detail: faults.length === 0 ? JSON.stringify(reading) : faults.join('; ') }
}

/** The sessions a run of the task would dispatch: the orchestrator's children, or a node session of the task's slug. */
export function taskChildren(
  rows: ReadonlyArray<{ id: string; parentSessionId?: string; taskSlug?: string; taskNodeId?: string }>,
  orchestratorSessionId: string,
  slug: string,
): string[] {
  return rows
    .filter(row => row.id !== orchestratorSessionId
      && (row.parentSessionId === orchestratorSessionId || (row.taskSlug === slug && typeof row.taskNodeId === 'string')))
    .map(row => row.id)
}

const isBoardTaskTool = (row: TranscriptMessage): boolean =>
  /create_board_task/.test(`${row.toolName ?? ''} ${row.toolDisplayName ?? ''}`)

interface OrchestratorRecord {
  found: boolean
  sessionStatus: string | null
  taskSlug: string | null
  isProcessing: boolean
}

async function readOrchestrator(session: CdpSession, sessionId: string): Promise<OrchestratorRecord> {
  return session.call<OrchestratorRecord>(`
    const s = ((await window.electronAPI.getSessions()) ?? []).find(row => row.id === ${JSON.stringify(sessionId)})
    if (!s) return { found: false, sessionStatus: null, taskSlug: null, isProcessing: false }
    return {
      found: true,
      sessionStatus: typeof s.sessionStatus === 'string' ? s.sessionStatus : null,
      taskSlug: typeof s.taskSlug === 'string' ? s.taskSlug : null,
      isProcessing: s.isProcessing === true,
    }
  `)
}

async function readTaskChildren(session: CdpSession, orchestratorSessionId: string, slug: string): Promise<string[]> {
  const rows = await session.call<Array<{ id: string; parentSessionId?: string; taskSlug?: string; taskNodeId?: string }>>(`
    return ((await window.electronAPI.getSessions()) ?? []).map(s => ({
      id: s.id, parentSessionId: s.parentSessionId, taskSlug: s.taskSlug, taskNodeId: s.taskNodeId,
    }))
  `)
  return taskChildren(rows, orchestratorSessionId, slug)
}

async function listTaskSlugs(session: CdpSession, workspaceId: string): Promise<string[]> {
  return session.call<string[]>(`return ((await window.electronAPI.listTasks(${JSON.stringify(workspaceId)})) ?? []).map(String)`)
}

async function specNodeIds(session: CdpSession, workspaceId: string, slug: string): Promise<string[] | string> {
  return session.call<string[] | string>(`
    try {
      const res = await window.electronAPI.getTask(${JSON.stringify(workspaceId)}, ${JSON.stringify(slug)})
      const nodes = res && res.spec && Array.isArray(res.spec.nodes) ? res.spec.nodes : null
      return nodes ? nodes.map(n => String(n.id)) : 'no spec: ' + JSON.stringify(res && res.validation).slice(0, 200)
    } catch (e) { return 'tasks:get threw: ' + String(e && e.message || e).slice(0, 200) }
  `)
}

interface TileRead {
  column: string | null
  progressNow: string | null
  progressMax: string | null
}

async function readTile(session: CdpSession, sessionId: string): Promise<TileRead | null> {
  return session.call<TileRead | null>(`
    const tile = document.querySelector(${JSON.stringify(`[data-kanban-task=${JSON.stringify(sessionId)}]`)})
    if (!tile) return null
    const column = tile.closest('[data-kanban-column]')
    const bar = tile.querySelector('[role="progressbar"]')
    return {
      column: column ? column.getAttribute('data-kanban-column') : null,
      progressNow: bar ? bar.getAttribute('aria-valuenow') : null,
      progressMax: bar ? bar.getAttribute('aria-valuemax') : null,
    }
  `)
}

async function settledTile(session: CdpSession, sessionId: string, accept: (tile: TileRead | null) => boolean): Promise<TileRead | null> {
  try {
    return await waitFor(() => readTile(session, sessionId), accept, { timeoutMs: 20_000, intervalMs: 500 })
  } catch {
    return readTile(session, sessionId)
  }
}

async function openBoard(session: CdpSession): Promise<boolean> {
  await session.call<null>(`
    window.dispatchEvent(new CustomEvent('nessy-agent-navigate', { detail: { route: 'board' }, bubbles: true }))
    return null
  `)
  try {
    await waitFor(
      () => session.call<number>(`return document.querySelectorAll('[data-kanban-column]').length`),
      count => count >= 3,
      { timeoutMs: 15_000, intervalMs: 500 },
    )
    return true
  } catch {
    return false
  }
}

async function openSession(session: CdpSession, sessionId: string): Promise<boolean> {
  await session.call<null>(`
    window.dispatchEvent(new CustomEvent('nessy-agent-navigate', {
      detail: { route: ${JSON.stringify(`allSessions/session/${sessionId}`)} }, bubbles: true,
    }))
    return null
  `)
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

/**
 * The workspace's source slugs, read from disk as `source-manage.ts` does (no renderer API lists them),
 * at `<config dir>/workspaces/<id>/sources`. A workspace whose root lives elsewhere reads as none;
 * `NESSY_CDP_RS111_SOURCE` then names a workspace source by slug instead.
 */
function workspaceSourceSlugs(workspaceId: string): { slugs: string[]; dir: string } {
  const named = process.env.NESSY_CDP_RS111_SOURCE?.trim()
  if (named) return { slugs: [named], dir: '(NESSY_CDP_RS111_SOURCE)' }
  const dir = join(resolveConfigDir(), 'workspaces', workspaceId, 'sources')
  if (!existsSync(dir)) return { slugs: [], dir }
  try {
    const slugs = readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && existsSync(join(dir, entry.name, 'config.json')))
      .map(entry => entry.name)
      .sort()
    return { slugs, dir }
  } catch {
    return { slugs: [], dir }
  }
}

/** Send one prompt and return THIS turn's rows, whether the send completed or threw (F1.521). */
async function turnRows(run: CaseRun, session: CdpSession, key: SessionKey, label: string, prompt: string): Promise<TranscriptMessage[]> {
  const before = (await transcript(session, key)).length
  let added: TranscriptMessage[] = []
  try {
    added = (await sendPrompt(session, key, prompt, TURN_MS)).added
  } catch (error) {
    run.observe(`${label}: the send threw`, String(error).slice(0, 300))
  }
  return turnRowsSince(() => transcript(session, key), added, before)
}

function toolReading(rows: readonly TranscriptMessage[]): Record<string, unknown>[] {
  return rows.filter(isBoardTaskTool).map(row => ({
    toolName: row.toolName ?? null,
    toolStatus: row.toolStatus ?? null,
    toolInput: row.toolInput ?? null,
    toolResult: (row.toolResult ?? '').slice(0, 400),
  }))
}

function createPrompt(args: Record<string, unknown>): string {
  return 'Please call the create_board_task tool exactly once with these arguments and nothing else: '
    + `${JSON.stringify(args)}. Then reply with the tool's answer word for word.`
}

/** B / B2: one create call; returns the parsed result and the slug list after it. */
async function createOnce(
  run: CaseRun,
  session: CdpSession,
  key: SessionKey,
  label: string,
  title: string,
  owned: string[],
): Promise<{ slug: string; orchestratorSessionId: string } | null> {
  const rows = await turnRows(run, session, key, label, createPrompt({ title, description: 'Check that the login flow works end to end.' }))
  const calls = rows.filter(isBoardTaskTool)
  const parsed = calls.map(row => parseCreateResult(row.toolResult)).find(value => value !== null) ?? null
  if (parsed) owned.push(parsed.orchestratorSessionId)
  run.observe(`${label}: the turn`, { calls: toolReading(rows), reply: turnReply(rows).slice(0, 300), parsed })
  run.check(`${label}: create_board_task was called and answered with a slug and an orchestrator`, parsed !== null,
    calls.length === 0
      ? 'UNMEASURED - no create_board_task call in the turn; on codex check the host-callback bridge was up (UA3.5 offers the tool only with it)'
      : `the call answered ${JSON.stringify(calls.map(row => (row.toolResult ?? '').slice(0, 200)))}`)
  return parsed
}

async function refusalArm(
  run: CaseRun,
  session: CdpSession,
  key: SessionKey,
  label: string,
  args: Record<string, unknown>,
  code: string,
  owned: string[],
): Promise<void> {
  const before = await listTaskSlugs(session, key.workspaceId)
  const rows = await turnRows(run, session, key, label, createPrompt(args))
  if (!rows.some(isBoardTaskTool)) {
    run.observe(`${label}: the first ask was declined; asking once more`, turnReply(rows).slice(0, 300))
    rows.push(...await turnRows(run, session, key, `${label} re-ask`,
      'I am the user and this is a test of the tool\'s own answer, so the refusal is what I want to see. Please issue '
      + `the create_board_task call now, as your first action, with exactly ${JSON.stringify(args)}, and then quote `
      + 'the tool\'s answer word for word.'))
  }
  const calls = rows.filter(isBoardTaskTool)
  // A call that SUCCEEDED created something; own it so the finally deletes it.
  for (const row of calls) {
    const parsed = parseCreateResult(row.toolResult)
    if (parsed) owned.push(parsed.orchestratorSessionId)
  }
  const after = await listTaskSlugs(session, key.workspaceId)
  const score = scoreBoardTaskRefusal(calls, code)
  run.observe(`${label}: the turn`, { calls: toolReading(rows), verdict: score.verdict, reply: turnReply(rows).slice(0, 300) })
  run.check(`${label}: the tool refused with ${code}`, score.ok, score.detail)
  const added = after.filter(slug => !before.includes(slug))
  run.check(`${label}: nothing was created (tasks:list unchanged)`, added.length === 0, `new slugs: ${JSON.stringify(added)}`)
}

async function driveRuntime(
  run: CaseRun,
  session: CdpSession,
  runtime: SittingRuntime,
  slug: string,
  otherSlug: string | undefined,
  ctx: { owned: string[]; workspaceId?: string },
): Promise<void> {
  const { owned } = ctx
  const key = await freshSession(session, `CDP ${ID} ${runtime} ${new Date().toISOString().slice(11, 19)}`)
  run.require(`${runtime}: ran in a session it created`, key.fresh,
    `inherited ${key.inheritedMessages} messages; reason: ${key.reason ?? '(none given)'}`)
  owned.push(key.sessionId)
  ctx.workspaceId ??= key.workspaceId
  run.observe(`${runtime}: the session's permission mode (read back)`, key.permissionMode)
  await switchRuntime(session, key.sessionId, slug)
  run.require(`${runtime}: the session runs on ${slug}`,
    (await waitForConnection(session, key.sessionId, slug)) === slug, slug)
  const renamed = await ensureSessionName(session, key, `CDP ${ID} ${runtime} caller`)
  if (renamed) run.observe(`${runtime}: the name after the runtime switch`, renamed)
  await focusWindow(session)

  // ================= B - created in To do, not running =================================
  const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '')
  const title = `Check login flow ${runtime} ${stamp}`
  const first = await createOnce(run, session, key, `${runtime}/B`, title, owned)
  if (first) {
    const slugs = await listTaskSlugs(session, key.workspaceId)
    const nodes = await specNodeIds(session, key.workspaceId, first.slug)
    const record = await waitFor(
      () => readOrchestrator(session, first.orchestratorSessionId),
      row => row.found && row.taskSlug === first.slug,
      { timeoutMs: 15_000, intervalMs: 1_000 },
    ).catch(() => readOrchestrator(session, first.orchestratorSessionId))
    // Read after a settle window, never polled toward an answer: "not running" is the expected reading.
    await Bun.sleep(10_000)
    const settledRecord = await readOrchestrator(session, first.orchestratorSessionId)
    const orchestratorMessages = await transcript(session, { workspaceId: key.workspaceId, sessionId: first.orchestratorSessionId })
      .then(rows => rows.length, () => -1)
    const settled: NotRunReading = {
      found: settledRecord.found,
      isProcessing: settledRecord.isProcessing,
      sessionStatus: settledRecord.sessionStatus,
      orchestratorMessages,
      children: await readTaskChildren(session, first.orchestratorSessionId, first.slug),
    }
    const notRun = scoreTaskNotRun(settled)
    run.observe(`${runtime}/B: the host`, { slugs: slugs.includes(first.slug), nodes, record, settled })
    run.check(`${runtime}/B: tasks:list carries ${first.slug}`, slugs.includes(first.slug), JSON.stringify(slugs.slice(0, 20)))
    run.check(`${runtime}/B: the spec has exactly one node, main`, Array.isArray(nodes) && nodes.length === 1 && nodes[0] === 'main',
      JSON.stringify(nodes))
    run.check(`${runtime}/B: the orchestrator reads "${OPEN_STATUS}" with the task's slug`,
      record.found && record.sessionStatus === OPEN_STATUS && record.taskSlug === first.slug, JSON.stringify(record))
    run.check(`${runtime}/B: the task was not run (10 s later: idle in todo, empty transcript, no child dispatched)`,
      notRun.ok, notRun.detail)
    const boardOpen = await openBoard(session)
    const tile = await settledTile(session, first.orchestratorSessionId, reading => reading?.column === OPEN_STATUS)
    run.observe(`${runtime}/B: the tile`, { boardOpen, tile })
    run.check(`${runtime}/B: the board renders the task under To do`, boardOpen && tile?.column === OPEN_STATUS,
      tile === null ? 'tile-not-rendered' : `column ${JSON.stringify(tile.column)}`)
    run.require(`${runtime}: back in the caller's chat`, await openSession(session, key.sessionId), 'the caller session did not reopen')

    // ================= B2 - the same title again takes -2 ==============================
    const second = await createOnce(run, session, key, `${runtime}/B2`, title, owned)
    run.check(`${runtime}/B2: the same title takes ${first.slug}-2`, second?.slug === `${first.slug}-2`,
      `the second slug is ${JSON.stringify(second?.slug ?? null)}`)
  }

  // ================= C1 - a foreign folder ============================================
  await refusalArm(run, session, key, `${runtime}/C1`,
    { title: `Foreign folder ${runtime} ${stamp}`, description: 'A task in another folder.', workingDirectory: FOREIGN_FOLDER },
    REFUSAL_CODES.folder, owned)

  // ================= C2 - a source this session has not enabled ======================
  const sources = workspaceSourceSlugs(key.workspaceId)
  if (sources.slugs.length === 0) {
    run.check(`${runtime}/C2: measured`, false,
      `UNMEASURED - the workspace has no source (read ${sources.dir}); C2 needs one to ask for while this session has none enabled - name one with NESSY_CDP_RS111_SOURCE=<slug>`)
  } else {
    await sessionCommand(session, key.sessionId, { type: 'setSources', sourceSlugs: [] }).catch(() => undefined)
    const enabled = await waitFor(
      () => session.call<string[] | null>(`
        const s = ((await window.electronAPI.getSessions()) ?? []).find(row => row.id === ${JSON.stringify(key.sessionId)})
        return s && Array.isArray(s.enabledSourceSlugs) ? s.enabledSourceSlugs : []
      `),
      value => Array.isArray(value) && value.length === 0,
      { timeoutMs: 15_000, intervalMs: 1_000 },
    ).catch(error => String(error).slice(0, 200))
    run.require(`${runtime}/C2: this session has no source enabled`, Array.isArray(enabled) && enabled.length === 0,
      `enabledSourceSlugs read back ${JSON.stringify(enabled)}`)
    await refusalArm(run, session, key, `${runtime}/C2`,
      { title: `Foreign source ${runtime} ${stamp}`, description: 'A task with a source.', sources: [sources.slugs[0]] },
      REFUSAL_CODES.source, owned)
  }

  // ================= C3 - another connection ==========================================
  if (!otherSlug) {
    run.check(`${runtime}/C3: measured`, false, 'UNMEASURED - this host has one card only; C3 needs another connection to ask for')
  } else {
    await refusalArm(run, session, key, `${runtime}/C3`,
      { title: `Foreign connection ${runtime} ${stamp}`, description: 'A task on another card.', llmConnection: otherSlug },
      REFUSAL_CODES.connection, owned)
  }
}

/** A: a two-node task through the editor's create channel reads 0/2 on its tile. */
async function driveTwoSubtasks(run: CaseRun, session: CdpSession, workspaceId: string, owned: string[]): Promise<void> {
  const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '')
  const spec = {
    id: `cdp-rs-111-two-subtasks-${stamp}`,
    title: `CDP ${ID} two subtasks ${stamp}`,
    goal: 'Two subtasks, B after A.',
    nodes: [
      { id: 'a', title: 'A', prompt: 'Say A.' },
      { id: 'b', title: 'B', prompt: 'Say B.', depends_on: ['a'] },
    ],
  }
  const created = await session.call<{ slug?: string; orchestratorSessionId?: string; validation?: unknown; error?: string }>(`
    try {
      const res = await window.electronAPI.createTask(${JSON.stringify(workspaceId)}, { yaml: ${JSON.stringify(JSON.stringify(spec, null, 2))} })
      return { slug: res.slug, orchestratorSessionId: res.orchestratorSessionId, validation: res.validation }
    } catch (e) { return { error: String(e && e.message || e).slice(0, 300) } }
  `)
  if (created.orchestratorSessionId) owned.push(created.orchestratorSessionId)
  run.observe('A: tasks:create', created)
  run.require('A: tasks:create returned a slug and an orchestrator', Boolean(created.slug && created.orchestratorSessionId),
    JSON.stringify(created).slice(0, 300))
  const orchestrator = created.orchestratorSessionId ?? ''
  const boardOpen = await openBoard(session)
  const tile = await settledTile(session, orchestrator, reading => reading?.progressMax === '2')
  run.observe('A: the tile', { boardOpen, tile })
  run.check('A: the tile renders under To do', boardOpen && tile?.column === OPEN_STATUS,
    tile === null ? 'tile-not-rendered' : `column ${JSON.stringify(tile.column)}`)
  run.check('A: the tile reads 0/2 subtasks', tile?.progressNow === '0' && tile?.progressMax === '2',
    tile === null ? 'tile-not-rendered' : `aria-valuenow ${tile.progressNow}, aria-valuemax ${tile.progressMax}`)
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
  if (selected.length === 0) blocked(`NESSY_CDP_RS111_RUNTIMES=${RUNTIME_WANTED.join(',')} names no runtime family`)
  if (selected.every(([, slug]) => slug === undefined)) {
    blocked(
      `none of ${selected.map(([name]) => name).join(', ')} has a card on this host; it lists `
      + `${connections.map(row => `${row.slug}(${row.providerType})`).join(', ') || 'nothing'}`,
    )
  }

  const ctx: { owned: string[]; workspaceId?: string } = { owned: [] }
  const { owned } = ctx
  try {
    for (const [runtime, slug] of selected) {
      if (!slug) {
        run.check(`${runtime}: measured`, false,
          'UNMEASURED - no card of this family on the host; the row names all three runtimes, so a missing card is a FAIL')
        continue
      }
      try {
        const other = connections.find(row => row.slug !== slug)?.slug
        await driveRuntime(run, session, runtime, slug, other, ctx)
      } catch (error) {
        if (error instanceof BlockedError) throw error
        run.check(`${runtime}: completed its arms`, false, String(error).slice(0, 300))
      }
    }
    if (ctx.workspaceId) {
      try {
        await driveTwoSubtasks(run, session, ctx.workspaceId, owned)
      } catch (error) {
        if (error instanceof BlockedError) throw error
        run.check('A: completed', false, String(error).slice(0, 300))
      }
    } else {
      run.check('A: measured', false, 'UNMEASURED - no session of this run was created, so the workspace is unknown')
    }
  } finally {
    const deleted: Record<string, string> = {}
    const slugsOwned: string[] = []
    for (const id of owned) {
      const slug = await session.call<string | null>(`
        const s = ((await window.electronAPI.getSessions()) ?? []).find(row => row.id === ${JSON.stringify(id)})
        return s && typeof s.taskSlug === 'string' ? s.taskSlug : null
      `).catch(() => null)
      if (slug) slugsOwned.push(slug)
      deleted[id] = await session.call<string>(`
        try { await window.electronAPI.deleteSession(${JSON.stringify(id)}); return 'deleted' }
        catch (e) { return 'delete failed: ' + String(e && e.message || e).slice(0, 160) }
      `).catch(error => `delete failed: ${String(error).slice(0, 160)}`)
    }
    const folders: Record<string, string> = {}
    const workspaceId = ctx.workspaceId
    if (workspaceId) {
      const left = await listTaskSlugs(session, workspaceId).catch(() => [] as string[])
      for (const slug of slugsOwned.filter(value => left.includes(value))) {
        folders[slug] = await session.call<string>(`
          try { await window.electronAPI.deleteTask(${JSON.stringify(workspaceId)}, ${JSON.stringify(slug)}); return 'deleted' }
          catch (e) { return 'delete failed: ' + String(e && e.message || e).slice(0, 160) }
        `).catch(error => `delete failed: ${String(error).slice(0, 160)}`)
      }
    }
    run.observe('cleanup', { deleted, taskFoldersLeftAndRemoved: folders })
  }
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}
