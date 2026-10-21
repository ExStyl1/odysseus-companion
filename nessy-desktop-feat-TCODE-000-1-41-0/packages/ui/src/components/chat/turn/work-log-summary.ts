/**
 * Source: v0.15.1:packages/ui/src/components/chat/turn/work-log-summary.ts (ADDED in v0.15.0; UB14.11, R3-05).
 *
 * Upstream's signature and priority order, OUR text (the row's Method):
 * - a settled turn names what it DID — `summarizeTurnRun` (`../run-summary.ts`: "Read 3 files, edited
 *   1 file") — where upstream returns `{}` and lets the lead say "N steps completed". The `{}` stays for
 *   a settled turn with no tool call at all (commentary or reasoning only): the run summary would say
 *   "Completed 3 steps" beside a lead that already says "3 steps", so the lead's own
 *   `turnCard.stepsCompletedCount` carries it, as upstream;
 * - the error count is NOT in the text any more (it was a " · N errors" tail of it): it is the
 *   work log's "N failed" chip, counted by `countFailedActivities`;
 * - tool names come from `../turn-preview` (`getToolDisplayName`, the shared session-tool table and the
 *   `__` split), never from `./tool-display`: that module reaches `../../code-viewer` and
 *   `@pierre/diffs`, and a DECISION lives in a module the bun runner loads cheaply (P2.493, the
 *   convention stated in `../turn-preview.ts`'s header);
 * - the input is structural (`PreviewActivity`) rather than `ActivityItem`, so this module never names
 *   `TurnCard.tsx` (which the runner cannot load) even as a type. `ActivityItem[]` is assignable.
 *
 * Text for the collapsed work log row. Same sources as before (intent, running tools, latest
 * commentary, task description); the error count moved out of the text into a failure chip.
 */
import i18n from 'i18next'
import { isParentTaskTool } from '@nessy-agent/shared/utils/toolNames'
import { summarizeTurnRun } from '../run-summary'
import { getToolDisplayName, type PreviewActivity } from '../turn-preview'

export interface WorkLogPreview {
  /** Preview text after the step count, or undefined for the plain "N steps completed" summary */
  text?: string
}

/** Activities whose status is `error` — shown as a "N failed" chip on the collapsed row. */
export function countFailedActivities(activities: readonly PreviewActivity[]): number {
  let failed = 0
  for (const activity of activities) {
    if (activity.status === 'error') failed++
  }
  return failed
}

/** Get the preview text for the collapsed state */
export function getWorkLogPreview(
  activities: readonly PreviewActivity[],
  intent?: string,
  isStreaming?: boolean,
  hasResponse?: boolean,
  isComplete?: boolean
): WorkLogPreview {
  // If we have an explicit intent, use it
  if (intent) return { text: intent }

  // Find the most relevant activity intent
  const activityWithIntent = activities.find(a => a.intent)
  if (activityWithIntent?.intent) return { text: activityWithIntent.intent }

  // Check if we're in responding state
  if (isStreaming && hasResponse) return { text: i18n.t('turnCard.responding') }

  // Find running Task tools and show their description
  const runningTask = activities.find(a => isParentTaskTool(a.toolName ?? '') && a.status === 'running')
  if (runningTask?.toolInput?.description) {
    return { text: runningTask.toolInput.description as string }
  }

  // While still streaming, show the latest intermediate message content
  // This gives visibility into what the LLM is "thinking"
  if (isStreaming && !isComplete) {
    const latestIntermediate = [...activities]
      .reverse()
      .find(a => a.type === 'intermediate' && a.content)
    if (latestIntermediate?.content) {
      return { text: latestIntermediate.content }
    }
  }

  // Show running tool names
  const runningTools = activities.filter(a => a.status === 'running' && a.toolName)
  if (runningTools.length > 0) {
    const toolNames = runningTools
      .map(a => getToolDisplayName(a.toolName!))
      .slice(0, 3) // Max 3 names
    return { text: `${toolNames.join(', ')}...` }
  }

  // When complete, show first Task's description if available
  const firstTask = activities.find(a => isParentTaskTool(a.toolName ?? ''))
  if (firstTask?.toolInput?.description) {
    return { text: firstTask.toolInput.description as string }
  }

  // When complete, name what the turn actually did (ours: the run summary); a turn with no tool
  // call leaves it to the lead ("N steps completed"), as upstream does for every settled turn
  if (isComplete || (!isStreaming && activities.length > 0)) {
    return activities.some(a => a.toolName) ? { text: summarizeTurnRun(activities) } : {}
  }

  return { text: i18n.t('turnCard.starting') }
}
