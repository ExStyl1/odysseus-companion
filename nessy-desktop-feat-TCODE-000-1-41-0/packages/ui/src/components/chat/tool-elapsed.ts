/**
 * The trailing "how long has this been running" text on a tool activity row.
 *
 * P4.9 · P0.7 built a 30-second heartbeat at the shared executor seam and
 * carried `elapsedSeconds` all the way into renderer state for EVERY beating
 * tool — but the only painter was gated on the backgrounded branch, so a
 * silent, non-backgrounded tool carried a live elapsed value that nothing drew.
 * P0.7's own note records the residue and says widening it is a renderer change
 * that row deliberately forbade. This is that widening.
 *
 * WHY A MODULE. Same measured reason as `intermediate-row.ts`: `TurnCard.tsx`
 * cannot be loaded by the bun runner (pdfjs via `Markdown`; recorded twice
 * in-tree, 2026-08-21), so a rendered assertion is not available and a
 * source-text assertion cannot tell a painted value from a stale or absent one.
 * P4.9's acceptance asks specifically that the value be asserted AND that it be
 * shown to CHANGE, which only a value-returning function can answer.
 *
 * WHAT MAKES IT TICK, and what does not. Nothing here holds a timer, and that
 * is deliberate. The value changes because a new `task_progress` heartbeat
 * lands — the executor re-arms a 30s timeout per call, the Pi and claude
 * adapters forward it as `task_progress { toolUseId, elapsedSeconds }`, and
 * `event-processor/handlers/tool.ts` → `handleTaskProgress` writes it onto the
 * tool MESSAGE by `toolUseId` with no status filter, so ordinary running rows
 * were already being updated before this row existed. Only the paint was
 * missing. A per-row 1s interval would be a second, competing clock — one timer
 * per running tool row, disagreeing with the executor's own measurement — so
 * the row shows what the beat last reported and the granularity is 30 seconds.
 * That is visible to the user as a value that steps rather than sweeps, and it
 * is the honest reading of what the host actually knows.
 */
import { formatDuration } from './turn-utils'

/**
 * P2.494 · the three user-visible strings this module composes, INJECTED rather
 * than resolved here.
 *
 * A Russian-locale user read all three in English, and they were the last of
 * the trailing-text literals to be keyed because P4.9 was a paint widening that
 * deliberately kept the pre-existing text byte-identical. Injection rather than
 * an `i18next` import is the sibling module's own precedent —
 * `describeIntermediateRow(activity, streamingPlaceholder)` already takes its
 * one user-visible string as a parameter — and it is what keeps this module
 * loadable under `bun test`, which is the whole reason it exists. It also keeps
 * the measured `i18n.t`-before-`setupI18n` trap out of a presentation module:
 * an uninitialized i18next returns `undefined` from `t()`, not the key.
 */
export interface ToolElapsedLabels {
  /** `turnCard.elapsed` — "{{duration}} elapsed". */
  elapsed: (duration: string) => string
  /** `turnCard.backgroundTaskId` — "Task ID: {{id}}". */
  taskId: (id: string) => string
  /** `turnCard.backgroundShellId` — "Shell ID: {{id}}". */
  shellId: (id: string) => string
}

export type ToolElapsedKind =
  /** Backgrounded agent task: its id, plus elapsed when a beat has landed. */
  | 'backgrounded-task'
  /** Backgrounded shell: its id, plus elapsed when a beat has landed. */
  | 'backgrounded-shell'
  /** P4.9's new arm: an ordinary running tool with a heartbeat behind it. */
  | 'running-heartbeat'
  /** Nothing to say. */
  | 'none'

export interface ToolElapsedInfo {
  kind: ToolElapsedKind
  /** Exactly the string the trailing span paints, or null when it paints nothing. */
  text: string | null
}

/**
 * The minimum a row needs. `ActivityItem` (`TurnCard.tsx`) is structurally
 * assignable to this; declared here rather than imported so this module stays
 * loadable under `bun test` — the same one-way dependency `run-summary.ts` keeps.
 */
export interface ToolElapsedActivity {
  status: string
  taskId?: string
  shellId?: string
  elapsedSeconds?: number
}

const NONE: ToolElapsedInfo = { kind: 'none', text: null }

/**
 * A zero is not a reading. The executor's first beat lands at 30s, so an
 * `elapsedSeconds` of 0 means "backgrounded, no beat yet" — painting "0.0s
 * elapsed" would assert a measurement nobody took, and on the new arm it would
 * put a stopwatch on every tool that has barely started. Both existing
 * backgrounded arms already skipped it by truthiness; this names the rule
 * instead of relying on that.
 */
function elapsedText(
  elapsedSeconds: number | undefined,
  labels: ToolElapsedLabels,
): string | null {
  if (typeof elapsedSeconds !== 'number' || !Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) {
    return null
  }
  return labels.elapsed(formatDuration(elapsedSeconds * 1000))
}

export function describeToolElapsed(
  activity: ToolElapsedActivity,
  labels: ToolElapsedLabels,
): ToolElapsedInfo {
  const elapsed = elapsedText(activity.elapsedSeconds, labels)

  if (activity.status === 'backgrounded') {
    // Unchanged from the pre-P4.9 painter, including the case it declines: a
    // backgrounded row with neither id says nothing, because the id is the
    // thing the user needs in order to act on it.
    if (activity.taskId) {
      return {
        kind: 'backgrounded-task',
        // The `, ` join stays here rather than becoming a fourth key: it is
        // punctuation between two already-translated halves, and folding it
        // into either key would make the elapsed suffix conditional inside a
        // translation string.
        text: `${labels.taskId(activity.taskId)}${elapsed ? `, ${elapsed}` : ''}`,
      }
    }
    if (activity.shellId) {
      return {
        kind: 'backgrounded-shell',
        text: `${labels.shellId(activity.shellId)}${elapsed ? `, ${elapsed}` : ''}`,
      }
    }
    return NONE
  }

  // P4.9 · the widening. A running tool with a beat behind it says how long it
  // has been running, and nothing else — there is no id to show, because there
  // is nothing to detach from or kill.
  if (activity.status === 'running' && elapsed) {
    return { kind: 'running-heartbeat', text: elapsed }
  }

  // A completed, errored or pending row never shows elapsed. Completed rows in
  // particular keep a stale `elapsedSeconds` from their last beat, and painting
  // it would leave a frozen clock next to a finished tool.
  return NONE
}
