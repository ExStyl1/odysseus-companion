/**
 * P6.109 — a backgrounded claude subagent becomes a task ROW, not only an info
 * line.
 *
 * The feed has REPLACE semantics, so what is pinned here is a reconciliation
 * rather than an add/remove pair: the claude SDK carries the whole live set on
 * every membership change and has no per-task start or end message to map onto.
 */
import { describe, expect, it } from 'bun:test'
import {
  applyBackgroundTaskEvent,
  dismissBackgroundTask,
  isBackgroundingToolResult,
  isShownBackgroundTask,
  reconcileReplacedBackgroundTasks,
  type ReconcilableTaskRow,
} from '../background-task-rows'
import {
  advanceBackgroundTaskChips,
  backgroundTaskElapsedSeconds,
  TERMINAL_LINGER_MS,
  UNREPORTED_END_GRACE_MS,
} from '../../components/app-shell/background-task-chip-state'
import { markTaskStopping, requestTaskStop, type StopTaskRoutes } from '../../hooks/useBackgroundTasks.ts'

const shellRow: ReconcilableTaskRow = {
  id: 'shell-1', type: 'shell', toolUseId: 'tu-shell', startTime: 1_000, elapsedSeconds: 7, status: 'running',
  intent: 'npm run dev',
}

describe('reconcileReplacedBackgroundTasks', () => {
  it('turns the set into agent rows carrying each task\'s own id and description', () => {
    // The row itself: before this, the same payload produced one info line and
    // no affordance at all. The DESCRIPTION is asserted beside the id — an
    // id-only row is a bar of opaque handles.
    const rows = reconcileReplacedBackgroundTasks([], [
      { taskId: 'b1', description: 'Review the diff', taskType: 'agent' },
      { taskId: 'b2', taskType: 'shell' },
    ], 5_000)

    expect(rows).toEqual([
      { id: 'b1', type: 'agent', toolUseId: 'b1', startTime: 5_000, elapsedSeconds: 0, status: 'running', lastSignalAt: 5_000, intent: 'Review the diff', listed: true },
      // No description: `task_type` is the SDK's own fallback, and a row with
      // neither carries no intent rather than an empty string.
      { id: 'b2', type: 'agent', toolUseId: 'b2', startTime: 5_000, elapsedSeconds: 0, status: 'running', lastSignalAt: 5_000, intent: 'shell', listed: true },
    ])
  })

  it('retires every agent row on an empty set, and touches no shell row', () => {
    // The negative, and the two ways it can be wrong at once: a stale agent row
    // would offer a Stop that could only be refused, and dropping the shell rows
    // would delete the user's running commands from the bar on a claude
    // membership change they have nothing to do with.
    // UA12.18 follow-up: "retires" is no longer "drops at once" — the agent row is
    // HELD (`unlistedAt`, no Stop) for its end report, and the ticker retires it.
    const rows = reconcileReplacedBackgroundTasks([
      shellRow,
      { id: 'b1', type: 'agent', toolUseId: 'b1', startTime: 1, elapsedSeconds: 30, status: 'running' },
    ], [], 5_000)

    expect(rows).toEqual([
      shellRow,
      { id: 'b1', type: 'agent', toolUseId: 'b1', startTime: 1, elapsedSeconds: 30, status: 'running', unlistedAt: 5_000 },
    ])
    expect(advanceBackgroundTaskChips(rows, 5_000 + UNREPORTED_END_GRACE_MS)).toEqual([shellRow])
  })

  it('carries startTime and elapsedSeconds for a task that was already showing', () => {
    // The boundary: the feed fires once per membership change, so rebuilding
    // these would restart every visible timer whenever any OTHER task started.
    const rows = reconcileReplacedBackgroundTasks([
      { id: 'b1', type: 'agent', toolUseId: 'b1', startTime: 1_234, elapsedSeconds: 42, status: 'running', intent: 'Review the diff' },
    ], [
      { taskId: 'b1', description: 'Review the diff' },
      { taskId: 'b2', description: 'Run the suite' },
    ], 9_999)

    expect(rows[0]).toMatchObject({ id: 'b1', startTime: 1_234, elapsedSeconds: 42 })
    expect(rows[1]).toMatchObject({ id: 'b2', startTime: 9_999, elapsedSeconds: 0 })
  })

  it('drops an entry with no usable id rather than rendering a row with no Stop target', () => {
    const rows = reconcileReplacedBackgroundTasks([], [
      { taskId: '', description: 'nameless' },
      { description: 'also nameless' },
      { taskId: 'b1' },
    ])

    expect(rows.map(row => row.id)).toEqual(['b1'])
  })

  it('is applied by App.tsx on the replace event, and the Stop route needs no new wiring', () => {
    // Two source reads the pure function cannot make. The first: the handler
    // really calls this. The second is the row's own "do not buy it twice" —
    // the chip's Stop (UB12.79: v0.15.1's `onStopTask(task)`, the hook's `stopTask`)
    // already routes to `killTask` with the row's type, so an `agent` row's Stop
    // reaches `stopAgentTask` -> `stopBackgroundTask` through the route that already ships.
    const app = Bun.file(new URL('../../App.tsx', import.meta.url).pathname).text()
    const chat = Bun.file(new URL('../../hooks/useBackgroundTasks.ts', import.meta.url).pathname).text()
    const reducer = Bun.file(new URL('../background-task-rows.ts', import.meta.url).pathname).text()
    return Promise.all([app, chat, reducer]).then(([appSource, chatSource, reducerSource]) => {
      // UA12.18 — the handler now delegates every event to the pure reducer, and the reducer applies this
      // function on the replace event (driven, not read, in the "applyBackgroundTaskEvent" describe below).
      expect(appSource).toContain('applyBackgroundTaskEvent(currentTasks, event.type,')
      expect(reducerSource).toContain("type === 'background_tasks_replaced'")
      expect(reducerSource).toContain('reconcileReplacedBackgroundTasks(current,')
      // UA12.135 — upstream v0.13.4 L1923 spells this default `?.type === 'shell'
      // ? 'shell' : 'agent'`: only a row the list itself calls a shell goes to
      // `killShell`; any other kind (and any future non-shell one) defaults to the
      // agent stop route. UB12.79: the chip hands the row itself, so its own type decides.
      expect(chatSource).toContain("killTask(task.id, task.type === 'shell' ? 'shell' : 'agent')")
      expect(chatSource).not.toContain("type ?? 'shell'")
    })
  })

  it('UA12.135 — an id missing from backgroundTasks routes to stopAgentTask, killShell uncalled', async () => {
    // The pin above covers the EXPRESSION ChatDisplay ships; this arm drives the
    // mechanism it feeds. A missing id makes the find yield `undefined`, the
    // fixed default turns that into 'agent', and the agent arm of
    // `requestTaskStop` must be the only route taken — the old `?? 'shell'`
    // default would have sent the same id to `killShell` instead.
    const backgroundTasks: Array<{ id: string; type: 'agent' | 'shell' }> = [
      { id: 'shell-1', type: 'shell' },
      { id: 'b1', type: 'agent' },
    ]
    const routes: StopTaskRoutes & { calls: string[] } = {
      calls: [],
      killShell: async id => { throw new Error(`killShell must not be called (id ${id})`) },
      stopAgentTask: async id => {
        routes.calls.push(`stopAgentTask:${id}`)
        return { success: true }
      },
    }
    const type = backgroundTasks.find(t => t.id === 'ghost-id')?.type === 'shell' ? 'shell' : 'agent'
    expect(type).toBe('agent')
    const outcome = await requestTaskStop('ghost-id', type, routes)
    expect(outcome).toEqual({ removeRow: true })
    expect(routes.calls).toEqual(['stopAgentTask:ghost-id'])
  })
})

// ---------------------------------------------------------------------------
// UA12.18 — the chip lifecycle on the native feed
// ---------------------------------------------------------------------------

const T0 = 1_000_000

function row(overrides: Partial<ReconcilableTaskRow> = {}): ReconcilableTaskRow {
  return { id: 'b1', type: 'agent', toolUseId: 'b1', startTime: T0, elapsedSeconds: 0, status: 'running', ...overrides }
}

describe('reconcileReplacedBackgroundTasks — UA12.18', () => {
  it('a row rebuilt from the feed is keyed by the starting call the feed names, not by its task id', () => {
    const rows = reconcileReplacedBackgroundTasks([], [{ taskId: 'agent-1', description: 'Review', toolUseId: 'toolu_1' }], T0)
    expect(rows).toEqual([{
      id: 'agent-1', type: 'agent', toolUseId: 'toolu_1', startTime: T0, elapsedSeconds: 0,
      status: 'running', lastSignalAt: T0, intent: 'Review', listed: true,
    }])
  })

  it('keeps the call id a launch receipt gave the row when the feed names none', () => {
    const rows = reconcileReplacedBackgroundTasks([row({ id: 'a1', toolUseId: 'toolu_receipt' })], [{ taskId: 'a1' }], T0 + 5)
    expect(rows[0]?.toolUseId).toBe('toolu_receipt')
  })

  it('a local_workflow task is a workflow row', () => {
    const rows = reconcileReplacedBackgroundTasks([], [{ taskId: 'wf-1', taskType: 'local_workflow', description: 'spec' }], T0)
    expect(rows[0]).toMatchObject({ id: 'wf-1', type: 'workflow', intent: 'spec' })
  })

  it('a stale row the set still names recovers to running; a live row it stops naming is HELD, never guessed terminal', () => {
    const rows = reconcileReplacedBackgroundTasks([
      row({ id: 'a1', status: 'stale', lastSignalAt: T0 }),
      row({ id: 'a2' }),
    ], [{ taskId: 'a1' }], T0 + 60_000)
    expect(rows.map(r => [r.id, r.status, r.unlistedAt])).toEqual([['a2', 'running', T0 + 60_000], ['a1', 'running', undefined]])
    expect(rows.find(r => r.id === 'a1')?.lastSignalAt).toBe(T0 + 60_000)
  })

  it('a row already terminal lingers when the set stops naming it, with its status and completedAt intact', () => {
    const done = row({ id: 'a1', status: 'completed', completedAt: T0 + 1 })
    const rows = reconcileReplacedBackgroundTasks([done], [], T0 + 2)
    expect(rows).toEqual([done])
  })

  it('an id a shell row already shows is not drawn a second time as an agent row', () => {
    const shell = row({ id: 'sh-1', type: 'shell', toolUseId: 'toolu_bash' })
    const rows = reconcileReplacedBackgroundTasks([shell], [{ taskId: 'sh-1', taskType: 'local_bash' }], T0)
    expect(rows).toEqual([shell])
  })
})

describe('applyBackgroundTaskEvent — UA12.18', () => {
  it('a receipt appends one running row, and a second receipt for the same call adds nothing', () => {
    const once = applyBackgroundTaskEvent([], 'task_backgrounded', { taskId: 'a1', toolUseId: 'toolu_1', intent: 'Scan' }, T0)
    expect(once).toEqual([{
      id: 'a1', type: 'agent', toolUseId: 'toolu_1', startTime: T0, elapsedSeconds: 0, lastSignalAt: T0, status: 'running', intent: 'Scan',
    }])
    expect(applyBackgroundTaskEvent(once, 'task_backgrounded', { taskId: 'a1', toolUseId: 'toolu_1' }, T0 + 1)).toBe(once)
  })

  it('a receipt for a task the feed already shows adopts the call id: one row, not two', () => {
    const fromFeed = applyBackgroundTaskEvent([], 'background_tasks_replaced', { tasks: [{ taskId: 'a1', description: 'Scan' }] }, T0)
    const next = applyBackgroundTaskEvent(fromFeed, 'task_backgrounded', { taskId: 'a1', toolUseId: 'toolu_1' }, T0 + 1)
    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({ id: 'a1', toolUseId: 'toolu_1', intent: 'Scan', startTime: T0 })
  })

  it('a rebuilt row takes the progress addressed to its starting call, and its elapsed time advances', () => {
    // THE DEFECT: before, the row was keyed by the task id and `task_progress` (keyed by the call) never matched.
    let rows = applyBackgroundTaskEvent([], 'background_tasks_replaced', { tasks: [{ taskId: 'a1', toolUseId: 'toolu_1' }] }, T0)
    expect(backgroundTaskElapsedSeconds(rows[0]!, T0 + 5_000)).toBe(5)
    rows = applyBackgroundTaskEvent(rows, 'task_progress', { toolUseId: 'toolu_1', elapsedSeconds: 40 }, T0 + 40_000)
    expect(rows[0]).toMatchObject({ elapsedSeconds: 40, lastSignalAt: T0 + 40_000, status: 'running' })
    expect(backgroundTaskElapsedSeconds(rows[0]!, T0 + 45_000)).toBe(45)
  })

  it('progress for a call no row carries changes nothing (same array)', () => {
    const rows = [row()]
    expect(applyBackgroundTaskEvent(rows, 'task_progress', { toolUseId: 'toolu_other', elapsedSeconds: 3 }, T0)).toBe(rows)
  })

  it('progress for a terminal row leaves its status alone', () => {
    const rows = [row({ status: 'completed', completedAt: T0 })]
    const next = applyBackgroundTaskEvent(rows, 'task_progress', { toolUseId: 'b1', elapsedSeconds: 9 }, T0 + 1)
    expect(next[0]?.status).toBe('completed')
  })

  it('task_completed keeps the row as completed / failed / stopped with completedAt, and the ticker prunes it later', () => {
    for (const status of ['completed', 'failed', 'stopped'] as const) {
      const next = applyBackgroundTaskEvent([row()], 'task_completed', { taskId: 'b1', status }, T0 + 10)
      expect(next).toEqual([row({ status, completedAt: T0 + 10 })])
      expect(advanceBackgroundTaskChips(next, T0 + 10 + TERMINAL_LINGER_MS - 1)).toHaveLength(1)
      expect(advanceBackgroundTaskChips(next, T0 + 10 + TERMINAL_LINGER_MS)).toEqual([])
    }
  })

  it('UA12.210 — task_completed marks the row readable only when its end carries an output file or a summary', () => {
    // The host's completed-task read (`SessionManager.getTaskOutput`) answers from exactly these two fields of the same
    // event; with neither it answers nothing, so the row must not promise a read.
    const shell = row({ id: '4242', type: 'shell' })
    // NEGATIVE: codex's `syncBackgroundTerminals` ends a terminal with neither field.
    const codexEnd = applyBackgroundTaskEvent([shell], 'task_completed', { taskId: '4242', status: 'completed' }, T0 + 5)
    expect(codexEnd).toEqual([{ ...shell, status: 'completed', completedAt: T0 + 5 }])
    expect(codexEnd[0]?.endOutput).toBeUndefined()
    // BOUNDARY: empty strings are what the host stores for an absent field — still nothing to read.
    const blank = applyBackgroundTaskEvent([shell], 'task_completed', { taskId: '4242', status: 'completed', outputFile: '', summary: '' }, T0 + 5)
    expect(blank[0]?.endOutput).toBeUndefined()
    // POSITIVE: Claude's `task_notification` names the output file; Pi's orchestration end carries a summary.
    const claudeEnd = applyBackgroundTaskEvent([row({ id: 'bmvrmj7vs', type: 'shell' })], 'task_completed', { taskId: 'bmvrmj7vs', status: 'completed', outputFile: '/tmp/t/bmvrmj7vs.output' }, T0 + 5)
    expect(claudeEnd[0]?.endOutput).toBe(true)
    const piEnd = applyBackgroundTaskEvent([row()], 'task_completed', { taskId: 'b1', status: 'failed', summary: 'boom' }, T0 + 5)
    expect(piEnd[0]?.endOutput).toBe(true)
    // The host overwrites its record on a later end of the same id, so a later empty end clears the mark.
    const reEnded = applyBackgroundTaskEvent(claudeEnd, 'task_completed', { taskId: 'bmvrmj7vs', status: 'stopped' }, T0 + 6)
    expect(reEnded[0]?.endOutput).toBeUndefined()
    // shell_killed writes no record: the mark is neither set nor dropped by it.
    expect(applyBackgroundTaskEvent([shell], 'shell_killed', { shellId: '4242' }, T0 + 3)[0]?.endOutput).toBeUndefined()
  })

  it('UA12.210 follow-up — the mark survives the feed re-stating an ended row, and shell_killed does not drop it', () => {
    // Claude re-states its whole known set on another task's start and on every level, so an end that arrives before
    // the level stops naming the task is followed by a rebuild of that (terminal) row.
    const listed = reconcileReplacedBackgroundTasks([], [{ taskId: 'A', taskType: 'agent' }, { taskId: 'B', taskType: 'agent' }], T0)
    const ended = applyBackgroundTaskEvent(listed, 'task_completed', { taskId: 'A', status: 'completed', outputFile: '/tmp/A.output' }, T0 + 2)
    // POSITIVE: re-stated {A,B} — A stays completed and still readable.
    const restated = reconcileReplacedBackgroundTasks(ended, [{ taskId: 'A', taskType: 'agent' }, { taskId: 'B', taskType: 'agent' }], T0 + 3)
    expect(restated.find(t => t.id === 'A')).toMatchObject({ status: 'completed', completedAt: T0 + 2, endOutput: true })
    // NEGATIVE: an end with neither field stays unmarked through the same re-statement, and B never gains a mark.
    const bare = applyBackgroundTaskEvent(listed, 'task_completed', { taskId: 'A', status: 'completed' }, T0 + 2)
    const bareRestated = reconcileReplacedBackgroundTasks(bare, [{ taskId: 'A', taskType: 'agent' }, { taskId: 'B', taskType: 'agent' }], T0 + 3)
    expect(bareRestated.find(t => t.id === 'A')?.status).toBe('completed')
    expect(bareRestated.find(t => t.id === 'A')?.endOutput).toBeUndefined()
    expect(restated.find(t => t.id === 'B')?.endOutput).toBeUndefined()
    // shell_killed after a marked end keeps the mark (it writes no host record).
    const shell = row({ id: 'bmvrmj7vs', type: 'shell' })
    const marked = applyBackgroundTaskEvent([shell], 'task_completed', { taskId: 'bmvrmj7vs', status: 'completed', outputFile: '/tmp/t/bmvrmj7vs.output' }, T0 + 5)
    expect(applyBackgroundTaskEvent(marked, 'shell_killed', { shellId: 'bmvrmj7vs' }, T0 + 6)[0]?.endOutput).toBe(true)
  })

  it('shell_killed keeps a shell row as stopped', () => {
    const shell = row({ id: 'sh-1', type: 'shell' })
    expect(applyBackgroundTaskEvent([shell], 'shell_killed', { shellId: 'sh-1' }, T0 + 3)).toEqual([{ ...shell, status: 'stopped', completedAt: T0 + 3 }])
  })

  it('a foreground result removes its row; each backgrounding wording keeps it', () => {
    const rows = [row({ toolUseId: 'toolu_1' })]
    expect(applyBackgroundTaskEvent(rows, 'tool_result', { toolUseId: 'toolu_1', result: 'Found 3 files.' }, T0)).toEqual([])
    for (const receipt of [
      'Async agent launched successfully.\nagentId: a1b2',
      'Command running in background with ID: bash_9',
      'Command was manually backgrounded by user with ID: bash_9',
      'Command moved to the background (ID: bash_9)',
      'Monitor started (task mon_3, timeout 300000ms)',
    ]) {
      expect(isBackgroundingToolResult(receipt)).toBe(true)
      expect(applyBackgroundTaskEvent(rows, 'tool_result', { toolUseId: 'toolu_1', result: receipt }, T0)).toBe(rows)
    }
  })

  it('a turn\'s end clears nothing', () => {
    const rows = [row()]
    for (const type of ['complete', 'error', 'interrupted']) expect(applyBackgroundTaskEvent(rows, type, {}, T0)).toBe(rows)
  })

  it('a Pi workflow receipt makes a workflow row', () => {
    const next = applyBackgroundTaskEvent([], 'task_backgrounded', { taskId: 'task-run1', toolUseId: 'toolu_wf', kind: 'workflow' }, T0)
    expect(next[0]?.type).toBe('workflow')
  })
})

describe('UB14.7 — what a running task is doing, and a pending Stop (v0.15.1)', () => {
  it('task_activity gives the matching chip its live line and step count, by task id or by its call, as a signal', () => {
    const rows = [row({ id: 'a1', toolUseId: 'toolu_a', status: 'stale', lastSignalAt: T0 }), row({ id: 'a2', toolUseId: 'toolu_b' })]
    const byId = applyBackgroundTaskEvent(rows, 'task_activity', { taskId: 'a1', lastToolName: 'Grep', toolUses: 3 }, T0 + 9)
    expect(byId[0]).toMatchObject({ status: 'running', lastSignalAt: T0 + 9, activity: { lastToolName: 'Grep', toolUses: 3 } })
    // A later event merges into what the chip already shows (a summary keeps the count).
    const merged = applyBackgroundTaskEvent(byId, 'task_activity', { taskId: 'other', toolUseId: 'toolu_a', summary: 'Reading callers' }, T0 + 10)
    expect(merged[0]?.activity).toEqual({ lastToolName: 'Grep', toolUses: 3, summary: 'Reading callers' })
    expect(merged[1]).toBe(rows[1])
  })

  it('NEGATIVE — task_activity for a task no chip shows writes nothing (the same array)', () => {
    const rows = [row({ id: 'a1', toolUseId: 'toolu_a' })]
    expect(applyBackgroundTaskEvent(rows, 'task_activity', { taskId: 'zz', toolUseId: 'toolu_zz', toolUses: 4 }, T0)).toBe(rows)
    expect(applyBackgroundTaskEvent(rows, 'task_activity', { toolUses: 4 }, T0)).toBe(rows)
  })

  it('the end clears a pending Stop and keeps the end\'s summary; shell_killed clears it too', () => {
    const [ended] = applyBackgroundTaskEvent([row({ id: 'a1', stopping: true })], 'task_completed', { taskId: 'a1', status: 'stopped', summary: 'Stopped by user' }, T0 + 5)
    expect(ended).toMatchObject({ status: 'stopped', completedAt: T0 + 5, summary: 'Stopped by user', endOutput: true })
    expect(ended?.stopping).toBeUndefined()
    const [killed] = applyBackgroundTaskEvent([row({ id: 's1', type: 'shell', stopping: true })], 'shell_killed', { shellId: 's1' }, T0 + 5)
    expect(killed?.status).toBe('stopped')
    expect('stopping' in (killed ?? {})).toBe(false)
  })

  it('a row the live set rebuilds keeps its live line, its pending Stop and its summary', () => {
    const kept = row({ id: 'a1', activity: { toolUses: 7 }, stopping: true, summary: 'half done' })
    const [rebuilt] = reconcileReplacedBackgroundTasks([kept], [{ taskId: 'a1' }], T0 + 1)
    expect(rebuilt).toMatchObject({ activity: { toolUses: 7 }, stopping: true, summary: 'half done', listed: true })
  })

  it('markTaskStopping sets and clears the mark on one row; a no-op returns the same array', () => {
    const rows = [row({ id: 'a1' }), row({ id: 'a2' })]
    const marked = markTaskStopping(rows, 'a1', true)
    expect(marked[0]?.stopping).toBe(true)
    expect(marked[1]).toBe(rows[1])
    expect(markTaskStopping(marked, 'a1', true)).toBe(marked)
    const cleared = markTaskStopping(marked, 'a1', false)
    expect('stopping' in cleared[0]!).toBe(false)
    // BOUNDARY: a late timer for a row that already ended (its end cleared the mark) or left changes nothing.
    expect(markTaskStopping(rows, 'a1', false)).toBe(rows)
    expect(markTaskStopping(rows, 'gone', false)).toBe(rows)
  })
})

describe('dismissBackgroundTask — UA12.18, UA12.186', () => {
  it('hides one chip (dismissedAt), leaves the others shown, and is a no-op for an unknown or already-dismissed id', () => {
    const rows = [row({ id: 'a1', status: 'completed', completedAt: T0 }), row({ id: 'a2' })]
    const dismissed = dismissBackgroundTask(rows, 'a1', T0 + 5)
    expect(dismissed.map(r => [r.id, r.dismissedAt])).toEqual([['a1', T0 + 5], ['a2', undefined]])
    expect(dismissed.filter(isShownBackgroundTask).map(r => r.id)).toEqual(['a2'])
    expect(dismissBackgroundTask(rows, 'ghost')).toBe(rows)
    expect(dismissBackgroundTask(dismissed, 'a1', T0 + 9)).toBe(dismissed)
  })

  // UA12.186 — the live set re-states every task it names on each membership change. Before, Dismiss REMOVED the row,
  // so the next update rebuilt it as a new running chip with its clock at 0.
  const twoLive = () => applyBackgroundTaskEvent([], 'background_tasks_replaced', {
    tasks: [{ taskId: 'A', description: 'Scan', toolUseId: 'toolu_A' }, { taskId: 'B', description: 'Build', toolUseId: 'toolu_B' }],
  }, T0)

  it('{A,B}, dismiss A, the set shrinks to {A}: A stays hidden with its start time; B is held, still shown', () => {
    const dismissed = dismissBackgroundTask(twoLive(), 'A', T0 + 10)
    const shrunk = applyBackgroundTaskEvent(dismissed, 'background_tasks_replaced', {
      tasks: [{ taskId: 'A', description: 'Scan', toolUseId: 'toolu_A' }],
    }, T0 + 20)
    const a = shrunk.find(r => r.id === 'A')
    expect(a).toMatchObject({ dismissedAt: T0 + 10, startTime: T0, status: 'running' })
    expect(shrunk.filter(isShownBackgroundTask).map(r => r.id)).toEqual(['B'])
    // Named again and again: still hidden, never a second row.
    const again = applyBackgroundTaskEvent(shrunk, 'background_tasks_replaced', {
      tasks: [{ taskId: 'A', toolUseId: 'toolu_A' }, { taskId: 'B', toolUseId: 'toolu_B' }],
    }, T0 + 30)
    expect(again.filter(r => r.id === 'A')).toHaveLength(1)
    expect(again.filter(isShownBackgroundTask).map(r => r.id)).toEqual(['B'])
  })

  it('a dismissed task\'s end leaves no chip; an undismissed one still shows how it ended (control)', () => {
    const dismissed = dismissBackgroundTask(twoLive(), 'A', T0 + 10)
    const shrunk = applyBackgroundTaskEvent(dismissed, 'background_tasks_replaced', { tasks: [] }, T0 + 20)
    const endedA = applyBackgroundTaskEvent(shrunk, 'task_completed', { taskId: 'A', status: 'completed' }, T0 + 21)
    expect(endedA.map(r => r.id)).toEqual(['B'])
    const endedB = applyBackgroundTaskEvent(endedA, 'task_completed', { taskId: 'B', status: 'failed' }, T0 + 22)
    expect(endedB).toHaveLength(1)
    expect(endedB[0]).toMatchObject({ id: 'B', status: 'failed', completedAt: T0 + 22 })
    expect(isShownBackgroundTask(endedB[0]!)).toBe(true)
    // A dismissed shell's own end: shell_killed prunes it too.
    const shell = dismissBackgroundTask([shellRow], 'shell-1', T0)
    expect(applyBackgroundTaskEvent(shell, 'shell_killed', { shellId: 'shell-1' }, T0 + 1)).toEqual([])
  })
})

// UA12.18 follow-up — the Claude end order. The vendored SDK's own doc on `SDKBackgroundTasksChangedMessage`
// (claudeCodeVersion 2.1.274): "Ordering relative to the bookends for the same transition is unspecified (in practice
// the level precedes them)". So the set SHRINKS first and `task_notification` (our `task_completed`) follows; a live
// row the shrink dropped left that report nothing to mark, and a Claude chip never showed how its task ended.
describe('the Claude end order — UA12.18 follow-up', () => {
  const live = () => applyBackgroundTaskEvent([], 'background_tasks_replaced', {
    tasks: [{ taskId: 'a1', description: 'Scan', toolUseId: 'toolu_1' }],
  }, T0)

  it('the set shrinks first, task_notification second: the chip shows the reported status for the linger', () => {
    for (const status of ['completed', 'failed', 'stopped'] as const) {
      const shrunk = applyBackgroundTaskEvent(live(), 'background_tasks_replaced', { tasks: [] }, T0 + 10)
      const ended = applyBackgroundTaskEvent(shrunk, 'task_completed', { taskId: 'a1', status }, T0 + 11)
      expect(ended).toHaveLength(1)
      expect(ended[0]).toMatchObject({ id: 'a1', status, completedAt: T0 + 11, intent: 'Scan' })
      expect(advanceBackgroundTaskChips(ended, T0 + 11 + TERMINAL_LINGER_MS - 1)).toHaveLength(1)
      expect(advanceBackgroundTaskChips(ended, T0 + 11 + TERMINAL_LINGER_MS)).toEqual([])
    }
  })

  it('no end report: the held row stays live-looking but unlisted, and the ticker retires it at the grace, claiming no end', () => {
    const shrunk = applyBackgroundTaskEvent(live(), 'background_tasks_replaced', { tasks: [] }, T0 + 10)
    expect(shrunk[0]).toMatchObject({ status: 'running', unlistedAt: T0 + 10 })
    // A second shrink does not restart the grace.
    const again = applyBackgroundTaskEvent(shrunk, 'background_tasks_replaced', { tasks: [] }, T0 + 500)
    expect(again[0]?.unlistedAt).toBe(T0 + 10)
    expect(advanceBackgroundTaskChips(again, T0 + 10 + UNREPORTED_END_GRACE_MS - 1)).toEqual(again)
    expect(advanceBackgroundTaskChips(again, T0 + 10 + UNREPORTED_END_GRACE_MS)).toEqual([])
  })

  it('a held row the set names again is live again: no unlistedAt', () => {
    const shrunk = applyBackgroundTaskEvent(live(), 'background_tasks_replaced', { tasks: [] }, T0 + 10)
    const back = applyBackgroundTaskEvent(shrunk, 'background_tasks_replaced', { tasks: [{ taskId: 'a1', toolUseId: 'toolu_1' }] }, T0 + 20)
    expect(back).toHaveLength(1)
    expect('unlistedAt' in back[0]!).toBe(false)
    expect(back[0]).toMatchObject({ status: 'running', startTime: T0 })
  })

  it('a Workflow launch receipt keeps the row its call id now keys (CLI 2.1.274 wording)', () => {
    const rows = [row({ type: 'workflow', toolUseId: 'toolu_wf' })]
    const receipt = 'Workflow launched in background. Task ID: wf_7k2. Output: /tmp/x'
    expect(isBackgroundingToolResult(receipt)).toBe(true)
    expect(applyBackgroundTaskEvent(rows, 'tool_result', { toolUseId: 'toolu_wf', result: receipt }, T0)).toBe(rows)
  })
})

// UA12.18 follow-up 2 — a launch call's tool_result never retires a row Claude's live set names. sdk.d.ts
// (claudeCodeVersion 2.1.274), on `task_notification`: "A backgrounded task's tool_result is the placeholder text and
// its real result arrives as this notification". Since `task_started` re-states the feed, the row the level built is
// keyed by the launch call BEFORE that placeholder arrives; a wording no receipt pattern knows used to delete it.
describe('the launch placeholder of a task the live set names — UA12.18 follow-up 2', () => {
  // CLI 2.1.274 wordings no BACKGROUNDING_RESULT_PATTERNS entry matches (`grep -aoF` on the native binary, 2026-10-09):
  // MCP auto-background, cloud agent, agent-teams teammate, remote workflow — and one the CLI may add later.
  const placeholders = [
    'MCP tool "scan" is still running after 120s. It was moved to the background as task k1a2b3c4d and keeps running; you\'ll receive a notification with the result when it completes.',
    'Cloud agent launched. Track it in the tasks panel.\ntaskId: r9x8',
    'Spawned successfully.\nagent_id: tm-1@team',
    'Workflow launched in a remote CCR session. Task ID: wf_r1',
    'A wording no pattern has heard of yet.',
  ]
  // The documented order: the level first (no call id yet), then `task_started`'s re-stated feed with the call id.
  const keyed = () => {
    const level = applyBackgroundTaskEvent([], 'background_tasks_replaced', { tasks: [{ taskId: 'k1a2b3c4d', taskType: 'mcp_task' }] }, T0)
    return applyBackgroundTaskEvent(level, 'background_tasks_replaced', {
      tasks: [{ taskId: 'k1a2b3c4d', taskType: 'mcp_task', toolUseId: 'toolu_mcp' }],
    }, T0 + 1)
  }

  it('the placeholder keeps the row (visible, stoppable, timer intact); the set and task_completed end it', () => {
    for (const placeholder of placeholders) {
      const rows = keyed()
      expect(rows[0]).toMatchObject({ id: 'k1a2b3c4d', toolUseId: 'toolu_mcp', status: 'running', startTime: T0 })
      expect(isBackgroundingToolResult(placeholder)).toBe(false)
      expect(applyBackgroundTaskEvent(rows, 'tool_result', { toolUseId: 'toolu_mcp', result: placeholder }, T0 + 2)).toBe(rows)
      const shrunk = applyBackgroundTaskEvent(rows, 'background_tasks_replaced', { tasks: [] }, T0 + 3)
      const ended = applyBackgroundTaskEvent(shrunk, 'task_completed', { taskId: 'k1a2b3c4d', status: 'completed' }, T0 + 4)
      expect(ended[0]).toMatchObject({ status: 'completed', completedAt: T0 + 4, startTime: T0 })
    }
  })

  it('BOUNDARY: a row the set no longer names, and a receipt-built (Pi) row, are still retired by their call\'s result', () => {
    const held = applyBackgroundTaskEvent(keyed(), 'background_tasks_replaced', { tasks: [] }, T0 + 3)
    expect(applyBackgroundTaskEvent(held, 'tool_result', { toolUseId: 'toolu_mcp', result: 'done: 3 files' }, T0 + 4)).toEqual([])
    const pi = applyBackgroundTaskEvent([], 'task_backgrounded', { taskId: 'a1', toolUseId: 'toolu_pi' }, T0)
    expect(applyBackgroundTaskEvent(pi, 'tool_result', { toolUseId: 'toolu_pi', result: 'done: 3 files' }, T0 + 1)).toEqual([])
  })
})

// UA12.192 — a Claude background Bash is a Shell chip. The level names the task first (an agent row), `task_started`
// re-states the feed with the call id, and the adapter's `shell_backgrounded` (same task id, same call id) must turn
// THAT row into a shell — not be dropped because a row already carries the call id.
describe('a Claude background Bash becomes a Shell chip — UA12.192', () => {
  const levelThenStarted = () => {
    const level = applyBackgroundTaskEvent([], 'background_tasks_replaced', {
      tasks: [{ taskId: 'bash-1', description: 'Sleep two minutes', taskType: 'local_bash' }],
    }, T0)
    return applyBackgroundTaskEvent(level, 'background_tasks_replaced', {
      tasks: [{ taskId: 'bash-1', description: 'Sleep two minutes', taskType: 'local_bash', toolUseId: 'toolu_bash' }],
    }, T0 + 1)
  }

  it('the shell receipt adopts the feed row by task id: one Shell row, its start time kept; the set skips it after', () => {
    for (const rows of [levelThenStarted(), applyBackgroundTaskEvent([], 'background_tasks_replaced', {
      tasks: [{ taskId: 'bash-1', description: 'Sleep two minutes', taskType: 'local_bash' }],
    }, T0)]) {
      const shell = applyBackgroundTaskEvent(rows, 'shell_backgrounded', {
        shellId: 'bash-1', toolUseId: 'toolu_bash', intent: 'Sleep two minutes', command: 'sleep 120',
      }, T0 + 2)
      expect(shell).toHaveLength(1)
      expect(shell[0]).toMatchObject({ id: 'bash-1', type: 'shell', toolUseId: 'toolu_bash', startTime: T0, status: 'running' })
      // The set keeps naming it, then shrinks: a shell row is not the feed's, so it is neither redrawn nor held.
      const named = applyBackgroundTaskEvent(shell, 'background_tasks_replaced', {
        tasks: [{ taskId: 'bash-1', toolUseId: 'toolu_bash', taskType: 'local_bash' }],
      }, T0 + 3)
      expect(named.map(r => [r.id, r.type])).toEqual([['bash-1', 'shell']])
      const shrunk = applyBackgroundTaskEvent(named, 'background_tasks_replaced', { tasks: [] }, T0 + 4)
      expect(shrunk[0]!.unlistedAt).toBeUndefined()
      // Its own receipt does not retire it; its end shows how it ended.
      expect(applyBackgroundTaskEvent(shrunk, 'tool_result', {
        toolUseId: 'toolu_bash', result: 'Command running in background with ID: bash-1. Output is being written to: /tmp/x',
      }, T0 + 5)).toBe(shrunk)
      const ended = applyBackgroundTaskEvent(shrunk, 'task_completed', { taskId: 'bash-1', status: 'completed' }, T0 + 6)
      expect(ended[0]).toMatchObject({ type: 'shell', status: 'completed', completedAt: T0 + 6 })
    }
  })

  it('CONTROL: a repeated receipt changes nothing (same array); a new shell is appended', () => {
    const shell = applyBackgroundTaskEvent(levelThenStarted(), 'shell_backgrounded', { shellId: 'bash-1', toolUseId: 'toolu_bash' }, T0 + 2)
    expect(applyBackgroundTaskEvent(shell, 'shell_backgrounded', { shellId: 'bash-1', toolUseId: 'toolu_bash' }, T0 + 3)).toBe(shell)
    const two = applyBackgroundTaskEvent(shell, 'shell_backgrounded', { shellId: 'process_x', toolUseId: 'toolu_pi' }, T0 + 4)
    expect(two.map(r => [r.id, r.type])).toEqual([['bash-1', 'shell'], ['process_x', 'shell']])
  })
})
