/**
 * D1.269 — the refresh signal, and the two halves of it that can be wrong.
 *
 * The PURE half is tested directly. The WIRING is asserted over source, which is
 * this renderer's standing instrument for a React seam it has no DOM harness for
 * (the same reason `background-task-chip.test.tsx` pins its mount that way);
 * the four assertions below each fail on their own if a link is removed.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  isScheduledWorkChangedEvent,
  SCHEDULED_WORK_CHANGED_EVENT,
  scheduledWorkRevision,
} from '../scheduled-work-refresh'

function source(relative: string): string {
  return readFileSync(resolve(import.meta.dir, '..', relative), 'utf8')
}

describe('the nudge is recognised, and nothing else is', () => {
  it('accepts the event and refuses its neighbours', () => {
    expect(isScheduledWorkChangedEvent({ type: SCHEDULED_WORK_CHANGED_EVENT })).toBe(true)
    // The neighbours it sits beside in the dispatcher, plus the shapes a
    // malformed event can take. Recognising one of these would either swallow a
    // transcript event or count a nudge that never happened.
    expect(isScheduledWorkChangedEvent({ type: 'queue_changed' })).toBe(false)
    expect(isScheduledWorkChangedEvent({ type: 'task_backgrounded' })).toBe(false)
    expect(isScheduledWorkChangedEvent({ type: 'scheduled_work_changed_v2' })).toBe(false)
    expect(isScheduledWorkChangedEvent({})).toBe(false)
    expect(isScheduledWorkChangedEvent(null)).toBe(false)
    expect(isScheduledWorkChangedEvent(undefined)).toBe(false)
  })
})

describe('the revision is a composite, and that is the whole point', () => {
  it('changes when either half changes', () => {
    expect(scheduledWorkRevision(0, 0)).not.toBe(scheduledWorkRevision(1, 0))
    expect(scheduledWorkRevision(0, 0)).not.toBe(scheduledWorkRevision(0, 1))
  })

  it('cannot CANCEL — the single case the row exists to fix', () => {
    // One task finishes in the same tick as one cron record is written. A sum
    // would be unchanged (1 + 0 === 0 + 1) and the list would not re-read, which
    // is exactly the invisible-cron-record symptom.
    expect(scheduledWorkRevision(1, 0)).not.toBe(scheduledWorkRevision(0, 1))
    // And the separator is load-bearing: without it, 1 task + 11 nudges and
    // 11 tasks + 1 nudge would both be "111".
    expect(scheduledWorkRevision(1, 11)).not.toBe(scheduledWorkRevision(11, 1))
  })
})

describe('the wiring — every link from the wire event to the read', () => {
  it('App.tsx answers the nudge as a SIGNAL and never folds it into the transcript', () => {
    const app = source('../App.tsx')
    expect(app).toContain('isScheduledWorkChangedEvent')
    const at = app.indexOf('if (isScheduledWorkChangedEvent(event)) {')
    expect(at).toBeGreaterThan(-1)
    const branch = app.slice(at, app.indexOf('}', app.indexOf('return', at)))
    // It bumps the per-session counter and returns — before `processAgentEvent`,
    // which would otherwise try to reconstruct a transcript row out of a signal
    // that has no content.
    expect(branch).toContain('scheduledWorkNudgeAtomFamily(sessionId)')
    expect(branch).toContain('+ 1')
    expect(branch).toContain('return')
    expect(at).toBeLessThan(app.indexOf('processAgentEvent('))
  })

  it('ActiveOptionBadges feeds BOTH signals into the read', () => {
    const badges = source('../components/app-shell/ActiveOptionBadges.tsx')
    expect(badges).toContain('scheduledWorkRevision(tasks.length, scheduledWorkNudges)')
    expect(badges).toContain('scheduledWorkNudgeAtomFamily(')
  })

  it('the hook re-reads on the revision, or the nudge reaches nothing', () => {
    const hook = source('../hooks/useSessionScheduledWork.ts')
    expect(hook).toContain('[sessionId, revision]')
  })

  it('the per-session counter is removed at BOTH cleanup sites', () => {
    // A per-session atom nobody removes is the leak the comment beside
    // `backgroundTasksAtomFamily.remove` names; the workspace switch and the
    // session delete are two different call sites and each can be forgotten.
    const atoms = source('../atoms/sessions.ts')
    expect([...atoms.matchAll(/scheduledWorkNudgeAtomFamily\.remove\(/g)]).toHaveLength(2)
  })
})
