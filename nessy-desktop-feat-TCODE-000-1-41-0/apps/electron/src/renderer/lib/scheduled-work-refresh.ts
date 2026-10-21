/**
 * D1.269 — the refresh signal the scheduled-work list did not have.
 *
 * ## What was measured, and what this half can and cannot close
 *
 * `sessions:listScheduledWork` is a READ and the wire carries no event for
 * "this session's cron records changed" (D1.97 built the RPC, not a feed). So
 * `useSessionScheduledWork` re-read on the only signal the renderer had: the
 * background-task atom's row count. A cron record written while the session is
 * open and nothing else happening appeared at the next such change or the next
 * session switch.
 *
 * The row's fix is a NUDGE on the stream that already reaches this renderer, from
 * the two writers that can move the answer. **This module is the renderer half
 * and it is inert until a producer exists** — the host half is
 * `SessionManager`'s and belongs to the lane that holds that file; the exact
 * diff is in `lane-reports/lane-WI-ab-report.md`. Inert rather than wrong: the
 * list keeps the task-count revision it has today, and the nudge only adds a
 * second reason to re-read.
 *
 * ## Why the event is handled as a SIGNAL and returns early
 *
 * `App.tsx` casts the wire event to `AgentEvent` and folds it into the
 * transcript through `processAgentEvent`. A nudge is not a transcript event —
 * it has no content, no role and nothing to reconstruct on a reload — so it is
 * answered beside `queue_changed`, which is the existing precedent for exactly
 * this shape: recognise, act, return.
 *
 * ## Why the revision is a STRING
 *
 * Two independent counters feed it and neither is monotonic: the task count
 * falls when a task finishes, and the nudge count only rises. Summing them can
 * cancel — one task ends in the same tick as one cron record is written and the
 * sum is unchanged, which is the single case the row exists to fix. A composite
 * cannot cancel, and `useEffect`'s `Object.is` comparison reads it the same way
 * it reads a number.
 */

/**
 * The wire name of the nudge.
 *
 * Declared HERE and exported so the host half and the renderer half cannot
 * drift into two spellings: the producer diff cites this constant by name.
 */
export const SCHEDULED_WORK_CHANGED_EVENT = 'scheduled_work_changed'

/** Does this wire event mean "this session's scheduled work moved"? */
export function isScheduledWorkChangedEvent(event: { type?: unknown } | null | undefined): boolean {
  return !!event && (event as { type?: unknown }).type === SCHEDULED_WORK_CHANGED_EVENT
}

/**
 * The value `useSessionScheduledWork` re-reads on.
 *
 * `taskCount` is the background-task atom's row count — the approximation D1.97
 * shipped, kept because it still catches the case where the work that changed IS
 * a running row. `nudges` is how many times the host has said the scheduled half
 * moved.
 */
export function scheduledWorkRevision(taskCount: number, nudges: number): string {
  return `${taskCount}:${nudges}`
}
