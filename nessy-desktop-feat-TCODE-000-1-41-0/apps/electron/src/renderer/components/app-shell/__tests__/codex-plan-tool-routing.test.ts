/**
 * P3.295 — THE CODEX PLAN ROW IS ROUTED.
 *
 * Same defect shape as P3.24's collab card, one layer over: the host has two
 * plan/todo views and both chose on a single vocabulary — `TodoWrite`, which is
 * how Pi and claude write a plan. Codex writes one with `update_plan`, and its
 * app-server emits NO thread item for that call at all (measured on the shipped
 * binary: a real `update_plan` produced exactly one `turn/plan/updated` and no
 * `item/started`/`item/completed`), so `backend/codex/event-adapter.ts`
 * synthesizes the row and stamps codex's own name on it. Without the vocabulary
 * both views would have ignored a live plan.
 *
 * WHAT EACH TEST KILLS:
 *  - "routes a codex update_plan row" dies if `isTodoWriteActivity` goes back to
 *    the single `todowrite` suffix — the state this row found.
 *  - "still routes the two TodoWrite spellings" dies if the codex name REPLACES
 *    the Pi/claude one instead of joining it.
 *  - "does not route an unrelated tool" dies if the predicate is widened to any
 *    row carrying a `todos` input, or if `update_plan` is matched loosely enough
 *    to catch a future `UpdatePlanSomething`.
 *  - "the checklist panel reads a codex plan" dies if only the inline card was
 *    taught the name — the two views have separate matchers and only one of them
 *    was the obvious one.
 *  - "newest wins across both vocabularies" dies if the two are matched
 *    separately rather than through one predicate: one codex session can carry
 *    BOTH its native plan and a bridged `mcp__session__TodoWrite`.
 *  - the drift guard dies if the adapter's stamped name and the shared
 *    vocabulary stop agreeing — a silent repeat of the original defect.
 */
import { describe, expect, it } from 'bun:test'
import { CODEX_PLAN_TOOL_NAME, isPlanWritingTool } from '@nessy-agent/shared/utils/toolNames'
import type { ActivityItem } from '@nessy-agent/ui/chat/TurnCard'
import { extractChecklistFromActivities } from '@nessy-agent/ui/chat/task-checklist'
import { getTodoListItems, isTodoCardActivity } from '../TodoListCard'

const TODOS = [
  { content: 'read the file', status: 'completed' },
  { content: 'write the fix', status: 'in_progress' },
  { content: 'run the tests', status: 'pending' },
]

function planRow(toolName: string, timestamp = 1_700_000_000_000): ActivityItem {
  return {
    id: `activity-${toolName}-${timestamp}`,
    type: 'tool',
    status: 'completed',
    toolName,
    timestamp,
    toolInput: { todos: TODOS },
    content: JSON.stringify({ todos: TODOS }),
  } as ActivityItem
}

describe('P3.295 · the codex plan row reaches both host plan views', () => {
  it('routes a codex update_plan row to the inline card', () => {
    expect(isTodoCardActivity(planRow(CODEX_PLAN_TOOL_NAME))).toBe(true)
    expect(getTodoListItems(planRow(CODEX_PLAN_TOOL_NAME))).toHaveLength(3)
  })

  it('still routes the two TodoWrite spellings', () => {
    expect(isTodoCardActivity(planRow('TodoWrite'))).toBe(true)
    expect(isTodoCardActivity(planRow('mcp__session__TodoWrite'))).toBe(true)
  })

  it('does not route an unrelated tool that happens to carry todos', () => {
    expect(isTodoCardActivity(planRow('Read'))).toBe(false)
    expect(isPlanWritingTool('UpdatePlanSomething')).toBe(false)
    expect(isPlanWritingTool(undefined)).toBe(false)
  })

  it('the checklist panel reads a codex plan', () => {
    expect(extractChecklistFromActivities([planRow(CODEX_PLAN_TOOL_NAME)])).toEqual([
      { content: 'read the file', status: 'completed' },
      { content: 'write the fix', status: 'in_progress' },
      { content: 'run the tests', status: 'pending' },
    ])
  })

  it('newest wins across both vocabularies in one session', () => {
    const bridged: ActivityItem = {
      ...planRow('mcp__session__TodoWrite', 1_700_000_000_000),
      toolInput: { todos: [{ content: 'the bridged list', status: 'pending' }] },
    }
    const native = planRow(CODEX_PLAN_TOOL_NAME, 1_700_000_009_999)
    expect(extractChecklistFromActivities([bridged, native]).map(i => i.content))
      .toEqual(['read the file', 'write the fix', 'run the tests'])
    expect(extractChecklistFromActivities([native, { ...bridged, timestamp: 1_700_000_099_999 }]).map(i => i.content))
      .toEqual(['the bridged list'])
  })
})

describe('P3.295 · drift guard', () => {
  it('the name the adapter stamps is the name both views accept', () => {
    // The pin is in TWO halves on purpose, and neither restates a literal:
    // `codex-reasoning-and-plan.test.ts` asserts the adapter stamps
    // `CODEX_PLAN_TOOL_NAME` on the row it synthesizes, and this asserts both
    // host views accept that same constant. The adapter itself is deliberately
    // NOT imported here — it pulls `@nessy-agent/codex-agent-server` into a
    // renderer test process for no extra evidence.
    expect(isPlanWritingTool(CODEX_PLAN_TOOL_NAME)).toBe(true)
    expect(isTodoCardActivity(planRow(CODEX_PLAN_TOOL_NAME))).toBe(true)
  })
})
