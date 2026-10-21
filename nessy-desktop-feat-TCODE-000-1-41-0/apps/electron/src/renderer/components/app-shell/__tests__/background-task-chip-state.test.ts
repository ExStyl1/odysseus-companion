/**
 * UA12.18 — ported from upstream `v0.13.4:apps/electron/src/renderer/components/app-shell/__tests__/background-task-chip-state.test.ts`
 * (Apache-2.0). The orphaned arms are dropped with `markLiveBackgroundTasksOrphaned` (see the module header); the
 * elapsed and terminal arms are ours.
 */
import { describe, expect, it } from 'bun:test'
import type { BackgroundTask } from '@/atoms/sessions'
import {
  advanceBackgroundTaskChips,
  backgroundTaskElapsedSeconds,
  confirmBackgroundTasksLive,
  isTerminalBackgroundTask,
  markBackgroundTaskSignal,
  probeShellLiveness,
  RUNNING_SIGNAL_TIMEOUT_MS,
  SHELL_LIVENESS_PROBE_LEAD_MS,
  TERMINAL_LINGER_MS,
} from '../background-task-chip-state'

const NOW = 1_000_000_000

function task(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: 'task-1',
    type: 'agent',
    toolUseId: 'tool-1',
    startTime: NOW - 1_000,
    elapsedSeconds: 1,
    status: 'running',
    ...overrides,
  }
}

describe('background task chip lifecycle', () => {
  it('keeps a recently signaled running task unchanged', () => {
    const tasks = [task({ lastSignalAt: NOW - RUNNING_SIGNAL_TIMEOUT_MS + 1 })]

    expect(advanceBackgroundTaskChips(tasks, NOW)).toBe(tasks)
  })

  it('marks a no-signal running task stale without claiming completion', () => {
    const [stale] = advanceBackgroundTaskChips([
      task({ lastSignalAt: NOW - RUNNING_SIGNAL_TIMEOUT_MS }),
    ], NOW)

    expect(stale?.status).toBe('stale')
    expect(stale?.completedAt).toBeUndefined()
  })

  it('falls back to startTime when no signal was ever recorded', () => {
    const [stale] = advanceBackgroundTaskChips([task({ startTime: NOW - RUNNING_SIGNAL_TIMEOUT_MS })], NOW)
    expect(stale?.status).toBe('stale')
  })

  it('does not auto-prune stale tasks', () => {
    const tasks = [task({
      status: 'stale',
      startTime: NOW - 10 * RUNNING_SIGNAL_TIMEOUT_MS,
      lastSignalAt: NOW - 10 * RUNNING_SIGNAL_TIMEOUT_MS,
    })]

    expect(advanceBackgroundTaskChips(tasks, NOW)).toBe(tasks)
  })

  it('retains a terminal chip inside its linger window and prunes it at the window', () => {
    const doneVisible = task({ status: 'completed', completedAt: NOW - TERMINAL_LINGER_MS + 1 })
    const doneExpired = task({ id: 'task-2', status: 'completed', completedAt: NOW - TERMINAL_LINGER_MS })
    const failedVisible = task({ id: 'task-3', status: 'failed', completedAt: NOW - 1 })
    const stoppedExpired = task({ id: 'task-4', status: 'stopped', completedAt: NOW - TERMINAL_LINGER_MS })

    const next = advanceBackgroundTaskChips([doneVisible, doneExpired, failedVisible, stoppedExpired], NOW)

    expect(next.map(item => item.id)).toEqual(['task-1', 'task-3'])
  })

  it('restores a stale task to running when progress resumes', () => {
    const stale = task({ status: 'stale', lastSignalAt: NOW - RUNNING_SIGNAL_TIMEOUT_MS })
    const next = markBackgroundTaskSignal(stale, NOW)

    expect(next.status).toBe('running')
    expect(next.lastSignalAt).toBe(NOW)
  })

  it('does not resurrect terminal tasks on late progress', () => {
    const completed = task({ status: 'completed', completedAt: NOW - 1 })

    expect(markBackgroundTaskSignal(completed, NOW)).toBe(completed)
  })

  it('names exactly the three ended states as terminal', () => {
    expect(['running', 'stale', 'completed', 'failed', 'stopped'].filter(status =>
      isTerminalBackgroundTask({ status: status as BackgroundTask['status'] }))).toEqual(['completed', 'failed', 'stopped'])
  })
})

describe('UB14.7 — the chip whose card is open stays (v0.15.1 keepId)', () => {
  it('keeps an expired terminal chip while its card is open, and prunes it once keepId is null', () => {
    const expired = task({ status: 'completed', completedAt: NOW - TERMINAL_LINGER_MS })
    const other = task({ id: 'task-2', status: 'failed', completedAt: NOW - TERMINAL_LINGER_MS })
    const kept = advanceBackgroundTaskChips([expired, other], NOW, 'task-1')
    expect(kept.map(item => item.id)).toEqual(['task-1'])
    expect(advanceBackgroundTaskChips(kept, NOW, null)).toEqual([])
  })

  it('keeps a held chip past its unreported-end grace while its card is open (ours)', () => {
    const held = task({ unlistedAt: NOW - TERMINAL_LINGER_MS })
    expect(advanceBackgroundTaskChips([held], NOW, 'task-1')).toEqual([held])
    expect(advanceBackgroundTaskChips([held], NOW)).toEqual([])
  })
})

describe('the chip\'s elapsed time', () => {
  it('a live chip counts wall-clock from startTime, with no progress at all', () => {
    const row = task({ startTime: NOW, elapsedSeconds: 0 })
    expect(backgroundTaskElapsedSeconds(row, NOW + 5_000)).toBe(5)
    expect(backgroundTaskElapsedSeconds(row, NOW + 45_000)).toBe(45)
  })

  it('never shows less than the progress the runtime reported', () => {
    expect(backgroundTaskElapsedSeconds(task({ startTime: NOW, elapsedSeconds: 90 }), NOW + 5_000)).toBe(90)
  })

  it('a terminal chip freezes at completedAt', () => {
    const done = task({ startTime: NOW, status: 'completed', completedAt: NOW + 12_000 })
    expect(backgroundTaskElapsedSeconds(done, NOW + 60_000)).toBe(12)
  })
})

// UA12.192 (P-LF-6-4) — a long-running Pi shell (a dev server) gets no progress events, so its chip turned "unknown"
// after 20 min while the supervisor knew it was running. The ticker now asks the supervisor (the read the View Output
// item uses, `isRunning`) shortly before a shell's signal runs out; a confirmed shell keeps running.
describe('a shell chip asks the supervisor before it turns stale — UA12.192', () => {
  const due = NOW - RUNNING_SIGNAL_TIMEOUT_MS + SHELL_LIVENESS_PROBE_LEAD_MS
  const shell = (overrides: Partial<BackgroundTask> = {}) =>
    task({ id: 'shell-1', type: 'shell', startTime: due - 5_000, lastSignalAt: due, ...overrides })

  it('the supervisor says running: the shell is confirmed, and still reads running past the 20 min mark', async () => {
    const reads: string[] = []
    const rows = [shell()]
    const ids = await probeShellLiveness(rows, NOW, new Set(), async id => { reads.push(id); return { success: true, isRunning: true } })
    expect(reads).toEqual(['shell-1'])
    expect(ids).toEqual(['shell-1'])
    const confirmed = confirmBackgroundTasksLive(rows, ids, NOW)
    expect(confirmed[0]).toMatchObject({ status: 'running', lastSignalAt: NOW })
    // Past the moment the unconfirmed chip would have turned stale (its signal + 20 min).
    const past = due + RUNNING_SIGNAL_TIMEOUT_MS + 1_000
    expect(advanceBackgroundTaskChips(confirmed, past)[0]!.status).toBe('running')
    // A stale shell the supervisor still runs recovers too.
    const stale = [shell({ status: 'stale' })]
    expect(confirmBackgroundTasksLive(stale, await probeShellLiveness(stale, NOW, new Set(), async () => ({ success: true, isRunning: true })), NOW)[0]!.status).toBe('running')
  })

  it('NEGATIVE: ended, unreadable (a Claude or codex shell) or refused — no confirmation, and the chip turns stale at 20 min as before', async () => {
    for (const read of [
      async () => ({ success: true, isRunning: false }),
      async () => ({ success: false }),
      async () => { throw new Error('transport gone') },
    ]) {
      const rows = [shell()]
      const ids = await probeShellLiveness(rows, NOW, new Set(), read)
      expect(ids).toEqual([])
      expect(confirmBackgroundTasksLive(rows, ids, NOW)).toBe(rows)
      expect(advanceBackgroundTaskChips(rows, due + RUNNING_SIGNAL_TIMEOUT_MS)[0]!.status).toBe('stale')
    }
  })

  it('BOUNDARY: asked once per signal window; never an agent, a shell not yet due, an ended or a held chip', async () => {
    const reads: string[] = []
    const read = async (id: string) => { reads.push(id); return { success: false } }
    const asked = new Set<string>()
    const rows = [
      shell(),
      shell({ id: 'agent-1', type: 'agent' }),
      shell({ id: 'young', lastSignalAt: due + 5_000 }),
      shell({ id: 'done', status: 'completed', completedAt: NOW }),
      shell({ id: 'held', unlistedAt: NOW - 10 }),
    ]
    await probeShellLiveness(rows, NOW, asked, read)
    await probeShellLiveness(rows, NOW + 1_000, asked, read)
    expect(reads).toEqual(['shell-1'])
  })
})
