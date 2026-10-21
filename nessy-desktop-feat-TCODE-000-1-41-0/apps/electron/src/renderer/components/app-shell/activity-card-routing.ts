/**
 * P3.24 — WHICH TRANSCRIPT ROWS RENDER AS THE SUBAGENT CARD.
 *
 * Extracted from `ChatDisplay.renderActivityCard` so the decision can be
 * exercised directly: that callback is defined inside a 3000-line component that
 * cannot be imported in a shared bun test process (see
 * `__tests__/background-task-chip.test.tsx` for the measurement of why), so as
 * an inline `if` the routing had no instrument other than reading it.
 *
 * WHAT THE USER COULD NOT SEE. P3.4 made codex's model-driven parallel agents
 * produce real `OrchestrationProgress`: a `spawn_agent` collab call anchors a
 * run, child-thread notifications are re-admitted as `task_progress` keyed to
 * that row, and `handleTaskProgress` writes it onto `message.orchestrationProgress`.
 * All of that worked. The card still never appeared, because the routing here was
 * the single literal `toolName === 'subagent'` — PI's spelling — and codex stamps
 * the wire name the model used, which is `spawn_agent`. Live data, no card.
 *
 * TWO CONDITIONS, AND THE SECOND IS NOT DECORATION. The tool name alone is not
 * enough: only the ANCHOR row of a run carries progress (`registerCollabSpawn`
 * reuses the first call that named a child, so a later `wait_agent` on the same
 * children re-uses that anchor rather than opening a second run). A collab row
 * with no progress must fall through to the ordinary `ActivityRow` — dropping the
 * progress check would hand those rows to `SubagentCard`, which renders `null`
 * for them, and the row would vanish from the transcript entirely.
 */
import { isCodexCollabTool } from '@nessy-agent/shared/utils/toolNames'
import type { ActivityItem } from '@nessy-agent/ui/chat/TurnCard'

/** The fields the routing reads — anything shaped like an `ActivityItem` works. */
export type RoutableActivity = Pick<ActivityItem, 'toolName' | 'orchestrationProgress'>

/**
 * Whether `activity` is a subagent-orchestration row: Pi's `subagent` tool or any
 * of codex's collab tools, carrying a `subagent`-kind progress snapshot.
 */
export function isSubagentCardActivity(activity: RoutableActivity): boolean {
  const toolName = activity.toolName?.toLowerCase()
  if (!toolName) return false
  if (toolName !== 'subagent' && !isCodexCollabTool(toolName)) return false
  return activity.orchestrationProgress?.kind === 'subagent'
}

/**
 * Whether `toolName` belongs to a tool whose details overlay stacks Input/Output
 * cards. Codex's collab calls carry the same structured pair a Pi subagent call
 * does, so they are stacked for the same reason — `isStackedActivityTool` in
 * `ChatDisplay` already listed `subagent` and would otherwise give the codex half
 * of the same feature the plain output-only overlay.
 */
export function isStackedOrchestrationTool(toolName: string): boolean {
  return toolName === 'subagent' || isCodexCollabTool(toolName)
}
