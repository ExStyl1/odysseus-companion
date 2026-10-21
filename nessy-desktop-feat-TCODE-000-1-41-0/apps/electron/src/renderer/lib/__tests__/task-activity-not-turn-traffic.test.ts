/**
 * UB9.8 — the host now forwards `task_activity` (a running background task's step count and last tool, between
 * turns as well as in them). craft-agents-oss v0.15.1 `App.tsx` (Apache-2.0) answers it BEFORE the session's own
 * processing: it is not turn traffic, so it must not reset the stale-session watchdog nor go through
 * `processAgentEvent`, whose default branch copies the session and rebuilds the metadata map — a re-render of the
 * session for every progress tick. UB14.7 — the branch now writes the chip (its card's live line and step count)
 * through `handleBackgroundTaskEvent`, whose rule (`applyBackgroundTaskEvent`) is pinned in `background-task-rows.test.ts`.
 *
 * Asserted over source, this renderer's standing instrument for a React seam it has no DOM harness for (the same as
 * `scheduled-work-refresh.test.ts`). Positive: the branch exists and returns before both. Negative: it calls
 * neither.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const app = readFileSync(resolve(import.meta.dir, '..', '..', 'App.tsx'), 'utf8')

describe('UB9.8 — task_activity is answered before turn processing', () => {
  it('returns before the watchdog and before processAgentEvent', () => {
    const at = app.indexOf("if (event.type === 'task_activity') {")
    expect(at).toBeGreaterThan(-1)
    expect(at).toBeLessThan(app.indexOf('trackSessionActivity(sessionId)'))
    expect(at).toBeLessThan(app.indexOf('processAgentEvent('))
  })

  it('NEGATIVE — the branch itself neither tracks activity nor processes the event', () => {
    const at = app.indexOf("if (event.type === 'task_activity') {")
    const branch = app.slice(at, app.indexOf('}', at) + 1)
    expect(branch).toContain('return')
    // UB14.7 — and it writes the chip before it returns.
    expect(branch).toContain('handleBackgroundTaskEvent(store, sessionId, event, event)')
    expect(branch).not.toContain('trackSessionActivity')
    expect(branch).not.toContain('processAgentEvent')
  })
})
