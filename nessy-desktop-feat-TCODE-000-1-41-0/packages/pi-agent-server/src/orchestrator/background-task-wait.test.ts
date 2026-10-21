/**
 * `env-vars.md:307` — the non-interactive run's bounded wait for background
 * subagents and workflows.
 *
 * Every assertion here is made with a BOUNDED timer, never by waiting: a test
 * that proves "does not hang" by hanging proves nothing and blocks the suite.
 */
import { describe, expect, it } from 'bun:test'
import { BackgroundTaskRegistry } from './background-task-registry.ts'
import {
  DEFAULT_PRINT_BG_WAIT_CEILING_MS,
  formatPrintBackgroundWaitOutcome,
  formatUnboundedPrintBackgroundWaitNotice,
  isNonInteractivePrintMode,
  resolvePrintBackgroundWaitCeilingMs,
} from '../../../shared/src/config/print-background-wait.ts'

/** Fail loudly instead of hanging if a wait ever fails to return. */
function withinTestBudget<T>(promise: Promise<T>, budgetMs = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`wait did not return within ${budgetMs}ms`)), budgetMs)
  })
  return Promise.race([promise, guard]).finally(() => { if (timer) clearTimeout(timer) }) as Promise<T>
}

function register(registry: BackgroundTaskRegistry, taskId: string): {
  finish: () => void
  aborted: () => boolean
} {
  const controller = new AbortController()
  let resolveSettled: () => void = () => {}
  const settled = new Promise<void>(resolve => { resolveSettled = resolve })
  registry.register({ taskId, controller, settled })
  return { finish: () => resolveSettled(), aborted: () => controller.signal.aborted }
}

describe('BackgroundTaskRegistry.waitForIdle', () => {
  it('returns immediately when nothing is in flight', async () => {
    const registry = new BackgroundTaskRegistry()
    expect(await withinTestBudget(registry.waitForIdle(DEFAULT_PRINT_BG_WAIT_CEILING_MS)))
      .toEqual({ timedOut: false, outstanding: [], waitedFor: 0 })
  })

  it('waits for a task in flight and reports it, without aborting it', async () => {
    const registry = new BackgroundTaskRegistry()
    const task = register(registry, 'task-a')
    const waiting = registry.waitForIdle(DEFAULT_PRINT_BG_WAIT_CEILING_MS)
    expect(task.aborted()).toBe(false)
    task.finish()
    const outcome = await withinTestBudget(waiting)
    expect(outcome).toEqual({ timedOut: false, outstanding: [], waitedFor: 1 })
    // The wait itself never aborts; the caller's drain does that afterwards.
    expect(task.aborted()).toBe(false)
  })

  it('ends at the ceiling naming exactly what was still running', async () => {
    const registry = new BackgroundTaskRegistry()
    const finished = register(registry, 'task-done')
    register(registry, 'task-stuck')
    finished.finish()
    // A 25ms ceiling: the assertion is that the wait RETURNS, bounded, with a
    // stated outcome — not that some duration elapsed.
    const outcome = await withinTestBudget(registry.waitForIdle(25))
    expect(outcome.timedOut).toBe(true)
    expect(outcome.waitedFor).toBe(2)
    expect(outcome.outstanding).toEqual(['task-stuck'])
    expect(formatPrintBackgroundWaitOutcome(outcome, 25))
      .toBe('[background-wait] ceiling of 25ms reached with 1 of 2 background task(s) still running:'
        + ' task-stuck — terminating them and exiting.')
  })

  it('treats 0 as the documented indefinite wait, announced before it starts', async () => {
    const registry = new BackgroundTaskRegistry()
    const task = register(registry, 'task-a')
    expect(formatUnboundedPrintBackgroundWaitNotice(registry.taskIds))
      .toBe('[background-wait] NESSY_PRINT_BG_WAIT_CEILING_MS=0 — waiting indefinitely for'
        + ' 1 background task(s): task-a. Set a positive value to cap this wait.')
    const waiting = registry.waitForIdle(0)
    task.finish()
    expect(await withinTestBudget(waiting)).toEqual({ timedOut: false, outstanding: [], waitedFor: 1 })
  })

  it('still lets drain abort what the wait left running', async () => {
    const registry = new BackgroundTaskRegistry()
    const stuck = register(registry, 'task-stuck')
    const outcome = await withinTestBudget(registry.waitForIdle(25))
    expect(outcome.timedOut).toBe(true)
    const draining = registry.drain()
    expect(stuck.aborted()).toBe(true)
    stuck.finish()
    await withinTestBudget(draining)
    expect(registry.activeCount).toBe(0)
  })
})

describe('the ceiling and the mode marker', () => {
  it('defaults to the documented 600000ms and reads both spellings', () => {
    expect(resolvePrintBackgroundWaitCeilingMs({})).toBe(600_000)
    expect(DEFAULT_PRINT_BG_WAIT_CEILING_MS).toBe(600_000)
    expect(resolvePrintBackgroundWaitCeilingMs({ NESSY_PRINT_BG_WAIT_CEILING_MS: '1500' })).toBe(1500)
    expect(resolvePrintBackgroundWaitCeilingMs({ CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '1500' })).toBe(1500)
    expect(resolvePrintBackgroundWaitCeilingMs({ NESSY_PRINT_BG_WAIT_CEILING_MS: '0' })).toBe(0)
  })

  it('falls back to the default on a malformed value rather than to an unbounded wait', () => {
    for (const raw of ['', 'soon', '-1', '1.5', '9007199254740993']) {
      expect(resolvePrintBackgroundWaitCeilingMs({ NESSY_PRINT_BG_WAIT_CEILING_MS: raw })).toBe(600_000)
    }
  })

  it('lets the Nessy name win when both are set', () => {
    expect(resolvePrintBackgroundWaitCeilingMs({
      NESSY_PRINT_BG_WAIT_CEILING_MS: '10',
      CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '20',
    })).toBe(10)
  })

  it('is off unless the run is marked non-interactive', () => {
    expect(isNonInteractivePrintMode({})).toBe(false)
    expect(isNonInteractivePrintMode({ NESSY_PRINT_MODE: '1' })).toBe(true)
    expect(isNonInteractivePrintMode({ CLAUDE_CODE_PRINT_MODE: 'true' })).toBe(true)
    expect(isNonInteractivePrintMode({ NESSY_PRINT_MODE: '0', CLAUDE_CODE_PRINT_MODE: '1' })).toBe(false)
  })
})
