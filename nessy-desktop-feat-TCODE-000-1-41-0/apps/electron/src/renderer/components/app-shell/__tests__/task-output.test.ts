/**
 * L9 — `requestTaskOutput`, and the honest-empty case it exists for.
 *
 * Pure and therefore testable: the repo has no DOM/user-event library, so a
 * decision that lives inside a click handler cannot be exercised at all. This is
 * the same reason `requestTaskStop` was extracted, and the same shape of decision.
 *
 * WHAT THIS REPLACED WAS A WRONG ANSWER, not a missing one. The old handler did
 * `output || t('chat.noOutputYet')` over `getTaskOutput`, a route whose only writer
 * is the `task_completed` handler — the same event that retires the row — so for
 * every row on screen it returned `null` and the overlay said "No output available
 * yet" about a command that had printed megabytes. `null` meant "I have no record
 * of this", never "nothing was printed". Those are three different facts here.
 */
import { describe, expect, it } from 'bun:test'
import type { BackgroundTaskOutputResult } from '@nessy-agent/shared/protocol'
import { requestTaskOutput, taskOutputOverlayTitle, type TaskOutputSubject } from '../task-output'

const shell: TaskOutputSubject = { id: 'shell_1', type: 'shell', intent: 'watch the build' }

function routes(answer: BackgroundTaskOutputResult | (() => never)) {
  const calls: Array<{ taskId: string; cursor?: number }> = []
  return {
    calls,
    routes: {
      readOutput: async (taskId: string, cursor?: number): Promise<BackgroundTaskOutputResult> => {
        calls.push({ taskId, cursor })
        if (typeof answer === 'function') answer()
        return answer as BackgroundTaskOutputResult
      },
    },
  }
}

describe('requestTaskOutput — the success paths', () => {
  it('prefers the HOST\'s command over the row\'s label', async () => {
    // The row only knows a synthesised "shell task"/intent; the supervisor's
    // ownership map holds the real command line, which is what a terminal header
    // should say.
    const { routes: r, calls } = routes({
      success: true,
      command: 'npm run build -- --watch',
      output: 'built\n',
      nextCursor: 7,
      isRunning: true,
    })
    const outcome = await requestTaskOutput(shell, r)
    expect(outcome).toEqual({
      show: true,
      data: {
        command: 'npm run build -- --watch',
        output: 'built\n',
        description: 'watch the build',
        toolType: 'bash',
        isRunning: true,
        // Carried so the renderer can re-check the running claim against the live
        // task list rather than trusting this snapshot for as long as the overlay
        // stays open — see `TerminalOverlayData.isRunning`.
        taskId: 'shell_1',
      },
    })
    // FETCH ONCE, from the start: no cursor is passed on open.
    expect(calls).toEqual([{ taskId: 'shell_1', cursor: undefined }])
  })

  it('AN EMPTY OUTPUT IS SHOWN, not turned into "no output available yet"', async () => {
    // The whole reason this function exists. A task that has printed nothing yet is
    // a success, and the overlay must render an empty terminal for a running
    // command rather than a sentence claiming it produced nothing.
    const { routes: r } = routes({ success: true, command: 'sleep 300', output: '', nextCursor: 0, isRunning: true })
    const outcome = await requestTaskOutput(shell, r)
    expect(outcome.show).toBe(true)
    if (!outcome.show) throw new Error('unreachable')
    expect(outcome.data.output).toBe('')
    expect(outcome.data.isRunning).toBe(true)
  })

  it('omits exitCode while the process runs and carries it once it ended', async () => {
    const running = await requestTaskOutput(shell, routes({ success: true, output: '', isRunning: true }).routes)
    if (!running.show) throw new Error('unreachable')
    // Absent rather than undefined-valued: the overlay renders its exit badge off
    // the key's presence.
    expect('exitCode' in running.data).toBe(false)

    const ended = await requestTaskOutput(shell, routes({ success: true, output: 'FAIL\n', isRunning: false, exitCode: 1 }).routes)
    if (!ended.show) throw new Error('unreachable')
    expect(ended.data.exitCode).toBe(1)
  })

  it('falls back to the row\'s own labels when the host has no command', async () => {
    const withIntent = await requestTaskOutput(shell, routes({ success: true, output: 'x' }).routes)
    if (!withIntent.show) throw new Error('unreachable')
    expect(withIntent.data.command).toBe('watch the build')

    const bare = await requestTaskOutput({ id: 'shell_2', type: 'shell' }, routes({ success: true, output: 'x' }).routes)
    if (bare.show === false) throw new Error('unreachable')
    // Never blank — a terminal with no header reads as a broken overlay.
    expect(bare.data.command).toBe('shell task')
  })

  it('passes a cursor through when one is given, so following is a later change', async () => {
    const { routes: r, calls } = routes({ success: true, output: 'more\n', nextCursor: 12 })
    await requestTaskOutput(shell, r, 7)
    expect(calls).toEqual([{ taskId: 'shell_1', cursor: 7 }])
  })
})

/**
 * UB12.79 — Open hands an AGENT's digest up as itself, so `ChatDisplay` shows v0.15.1's document (the message, then
 * the steps) instead of the terminal, where `output` carries the message alone; a command stays the terminal's.
 */
describe('requestTaskOutput — an agent digest goes up as itself (UB12.79)', () => {
  const agentRow: TaskOutputSubject = { id: 'a1b2c3', type: 'agent', intent: 'Review the label fix' }
  const digest = {
    kind: 'agent' as const,
    message: 'Two callers; both safe.',
    steps: [{ tool: 'Read', label: 'filter.ts' }, { tool: 'Grep', label: 'extractLabelId' }],
    truncated: false,
  }

  it('POSITIVE — an agent digest arrives whole, message AND steps, beside the terminal data', async () => {
    const outcome = await requestTaskOutput(agentRow, routes({ success: true, output: digest.message, isRunning: true, digest }).routes)
    if (!outcome.show) throw new Error('unreachable')
    expect(outcome.agent).toEqual(digest)
    expect(outcome.data.output).toBe('Two callers; both safe.')
  })

  it('NEGATIVE (control) — a text digest (a Claude shell\'s tail) and a Pi store read carry no agent: the terminal opens', async () => {
    const tail = { kind: 'text' as const, text: 'built\n', truncated: false }
    const claudeShell = await requestTaskOutput(shell, routes({ success: true, output: 'built\n', isRunning: true, digest: tail }).routes)
    const piStore = await requestTaskOutput(shell, routes({ success: true, output: 'built\n', nextCursor: 6, isRunning: true }).routes)
    for (const outcome of [claudeShell, piStore]) {
      if (!outcome.show) throw new Error('unreachable')
      expect('agent' in outcome).toBe(false)
      expect(outcome.data).toMatchObject({ output: 'built\n', isRunning: true, taskId: 'shell_1' })
    }
  })
})

describe('requestTaskOutput — a failure is a translated sentence, never an empty overlay', () => {
  it('maps every host reason to its own key', async () => {
    const cases = [
      ['session-not-found', 'toast.taskOutputSessionMissing'],
      ['unknown-task', 'toast.taskOutputUnknown'],
      ['unavailable', 'toast.taskOutputUnavailable'],
      ['failed', 'chat.backgroundTask.loadFailed'],
    ] as const
    for (const [reason, key] of cases) {
      const outcome = await requestTaskOutput(shell, routes({ success: false, reason }).routes)
      expect(outcome, reason).toMatchObject({ show: false, failureKey: key })
    }
  })

  it('NEVER shows the overlay for an unreadable id — that was the lie', async () => {
    // An `unknown-task` rendered as an empty terminal tells the user the command
    // produced nothing. It is the same shape of lie as the row that used to vanish
    // without stopping anything.
    const outcome = await requestTaskOutput(shell, routes({ success: false, reason: 'unknown-task' }).routes)
    expect(outcome.show).toBe(false)
  })

  it('keeps backend prose in the DETAIL, and only on the generic key', async () => {
    const generic = await requestTaskOutput(shell, routes({
      success: false,
      reason: 'failed',
      error: 'EACCES: permission denied',
    }).routes)
    expect(generic).toEqual({
      show: false,
      failureKey: 'chat.backgroundTask.loadFailed',
      failureDetail: 'EACCES: permission denied',
    })

    // A specific key already says it; carrying the prose too is how backend English
    // ended up under a Russian headline once already.
    const specific = await requestTaskOutput(shell, routes({
      success: false,
      reason: 'unavailable',
      error: 'process-recovery-host-owner-unavailable',
    }).routes)
    expect(specific).toEqual({ show: false, failureKey: 'toast.taskOutputUnavailable' })
  })

  it('A THROWN CALL IS A FAILURE, not an empty overlay', async () => {
    // A transport reconnect and a command that printed nothing must not look the
    // same on screen.
    const outcome = await requestTaskOutput(shell, routes(() => { throw new Error('transport closed') }).routes)
    expect(outcome).toEqual({
      show: false,
      failureKey: 'chat.backgroundTask.loadFailed',
      failureDetail: 'transport closed',
    })
  })

  it('an unrecognised reason still lands on a translated key', async () => {
    // Forwards-compatibility: the host may grow a reason before this table does,
    // and the fallback must not be `undefined` reaching `t()`.
    const outcome = await requestTaskOutput(
      shell,
      routes({ success: false, reason: 'some-future-reason' as never }).routes,
    )
    expect(outcome).toMatchObject({ show: false, failureKey: 'chat.backgroundTask.loadFailed' })
  })
})

/**
 * THE HEADER, and the reason it is tested at all: `isRunning` used to reach the
 * overlay state and be read by NOTHING, while `TerminalOutput` printed `(no output)`
 * for an empty string — a finished command's words for a command that has simply
 * printed nothing yet.
 */
describe('taskOutputOverlayTitle — a snapshot says so', () => {
  it('asks for the running notice while the process runs, and not once it ended', () => {
    expect(taskOutputOverlayTitle({ command: 'sleep 300', isRunning: true })).toEqual({
      subject: 'sleep 300',
      runningKey: 'chat.taskOutputRunningTitle',
    })
    expect(taskOutputOverlayTitle({ command: 'make test', isRunning: false })).toEqual({ subject: 'make test' })
    // A completed-record read carries no flag at all; it is not running.
    expect(taskOutputOverlayTitle({ command: 'make test' })).toEqual({ subject: 'make test' })
  })

  it('names the row\'s intent when it has one, and never comes out blank', () => {
    expect(taskOutputOverlayTitle({ command: 'npm run build', description: 'watch the build', isRunning: true })).toEqual({
      subject: 'watch the build',
      runningKey: 'chat.taskOutputRunningTitle',
    })
    // The command is the floor — `requestTaskOutput` guarantees it is non-empty, so
    // a header with no text (which reads as a broken overlay) is unreachable.
    expect(taskOutputOverlayTitle({ command: 'shell task', description: '' }).subject).toBe('shell task')
  })

  it('the key it names exists in EVERY locale, with the subject it interpolates', async () => {
    // A `runningKey` that no locale carries renders as the raw key on screen; and
    // the notice is worthless without the `{{subject}}` it wraps.
    const en = await import('@nessy-agent/shared/i18n/locales/en.json')
    const ru = await import('@nessy-agent/shared/i18n/locales/ru.json')
    const { runningKey } = taskOutputOverlayTitle({ command: 'x', isRunning: true })
    for (const locale of [en.default, ru.default] as Array<Record<string, string>>) {
      expect(typeof locale[runningKey!]).toBe('string')
      expect(locale[runningKey!]).toContain('{{subject}}')
    }
  })
})
