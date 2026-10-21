/**
 * P3.24 — THE CODEX SUBAGENT CARD IS ROUTED.
 *
 * The defect this pins was not missing data and not a broken card: it was one
 * literal. `ChatDisplay` chose the subagent card on `toolName === 'subagent'`,
 * which is PI's spelling, while a codex collab call reaches the transcript as the
 * wire name the model used — `spawn_agent`. P3.4's adapter work already delivered
 * `OrchestrationProgress` onto that row, so every ingredient was live and the user
 * saw a plain tool row where Pi and Claude both show a card.
 *
 * WHAT EACH TEST KILLS, named because a test that names no mutation is decoration:
 *
 *  - "routes a codex spawn_agent row" dies if the routing goes back to the single
 *    `toolName === 'subagent'` literal — the exact shipped defect.
 *  - "does not route a collab row that carries no progress" dies if the
 *    `orchestrationProgress.kind` half of the condition is dropped. That mutation
 *    is not cosmetic: `SubagentCard` renders `null` without progress, and
 *    `renderActivity`'s result is used instead of `ActivityRow`, so a
 *    progress-less `wait_agent`/`close_agent` row would DISAPPEAR from the
 *    transcript rather than render plainly.
 *  - "still routes the Pi subagent row" dies if the codex names REPLACE the Pi
 *    name instead of joining it.
 *  - "does not route an unrelated tool" dies if the predicate is widened to any
 *    row carrying subagent progress, which would hand `Bash` rows to the card.
 *  - the drift guard dies if a collab tool is added to the adapter's
 *    `COLLAB_TOOL_WIRE_NAMES` and not to `CODEX_COLLAB_TOOLS` — a silent repeat of
 *    the original defect for the new tool.
 *  - the mount pin dies if `ChatDisplay` stops calling the predicate. It is a
 *    source assertion because `ChatDisplay` cannot be imported in a bun test
 *    process — and P6.849 CORRECTED WHY. This bullet used to blame a sibling
 *    suite's spread-less `mock.module('@nessy-agent/ui')` amputating the package
 *    process-wide; `ef9bb426c` deleted all three of those registrations, so that
 *    cause no longer exists. Measured at HEAD 2026-09-08 by importing
 *    `ChatDisplay.tsx` in a bare bun process, the real wall is the barrel's own
 *    graph: `SyntaxError: Missing 'default' export in module`
 *    `pdfjs-dist/build/pdf.worker.min.mjs?url`, a Vite-only specifier bun cannot
 *    resolve. Nothing about ordering suites or spreading someone else's mock can
 *    reach it. Same instrument, better reason, and it was verified to fail
 *    against a reverted routing condition.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CODEX_COLLAB_TOOLS } from '@nessy-agent/shared/utils/toolNames'
import { COLLAB_TOOL_WIRE_NAMES } from '@nessy-agent/shared/agent/backend/codex/event-adapter'
import {
  isStackedOrchestrationTool,
  isSubagentCardActivity,
  type RoutableActivity,
} from '../activity-card-routing'

const CHAT_DISPLAY = join(import.meta.dir, '..', 'ChatDisplay.tsx')

/** A subagent-kind progress snapshot, the shape `handleTaskProgress` writes. */
function progress(): RoutableActivity['orchestrationProgress'] {
  return {
    kind: 'subagent',
    runId: 'collab-call-1',
    agents: [
      {
        id: 'thread-child-1',
        label: 'thread-child-1',
        agentType: 'subagent',
        status: 'running',
        tokensIn: 120,
        tokensOut: 40,
      },
    ],
  }
}

describe('P3.24 · codex collab rows route to the subagent card', () => {
  it('routes a codex spawn_agent row', () => {
    // The adapter's OWN wire name, not a copy of it — if that mapping changes,
    // this test follows it instead of passing against a stale literal.
    expect(COLLAB_TOOL_WIRE_NAMES.spawnAgent).toBe('spawn_agent')
    expect(isSubagentCardActivity({
      toolName: COLLAB_TOOL_WIRE_NAMES.spawnAgent,
      orchestrationProgress: progress(),
    })).toBe(true)
  })

  it('routes every codex collab tool the adapter can stamp', () => {
    for (const wireName of Object.values(COLLAB_TOOL_WIRE_NAMES)) {
      expect(isSubagentCardActivity({ toolName: wireName, orchestrationProgress: progress() })).toBe(true)
    }
  })

  it('does not route a collab row that carries no progress', () => {
    expect(isSubagentCardActivity({ toolName: 'wait_agent' })).toBe(false)
    // A workflow-kind snapshot on a collab row is not this card's row either.
    expect(isSubagentCardActivity({
      toolName: 'spawn_agent',
      orchestrationProgress: { kind: 'workflow', runId: 'r', agents: [] },
    })).toBe(false)
  })

  it('still routes the Pi subagent row', () => {
    expect(isSubagentCardActivity({ toolName: 'subagent', orchestrationProgress: progress() })).toBe(true)
    expect(isSubagentCardActivity({ toolName: 'Subagent', orchestrationProgress: progress() })).toBe(true)
  })

  it('does not route an unrelated tool that happens to carry progress', () => {
    expect(isSubagentCardActivity({ toolName: 'Bash', orchestrationProgress: progress() })).toBe(false)
    expect(isSubagentCardActivity({ orchestrationProgress: progress() })).toBe(false)
  })

  it('stacks the collab details overlay the way it stacks a Pi subagent', () => {
    expect(isStackedOrchestrationTool('subagent')).toBe(true)
    expect(isStackedOrchestrationTool('spawn_agent')).toBe(true)
    expect(isStackedOrchestrationTool('read')).toBe(false)
  })
})

describe('P3.24 · drift guard', () => {
  it('every wire name the adapter stamps is a known collab tool', () => {
    const stamped = Object.values(COLLAB_TOOL_WIRE_NAMES)
    expect(stamped.length).toBeGreaterThan(0)
    for (const wireName of stamped) {
      expect(CODEX_COLLAB_TOOLS.has(wireName)).toBe(true)
    }
    // Both directions: a name here the adapter can never stamp is dead weight
    // that would hide the next real omission.
    expect([...CODEX_COLLAB_TOOLS].sort()).toEqual([...new Set(stamped)].sort())
  })
})

describe('P3.24 · ChatDisplay uses the routing', () => {
  it('calls isSubagentCardActivity exactly once and no longer inlines the Pi literal', () => {
    const source = readFileSync(CHAT_DISPLAY, 'utf8')
    const calls = source.match(/isSubagentCardActivity\(activity\)/g) ?? []
    expect(calls.length).toBe(1)
    expect(source).toContain('isStackedOrchestrationTool(toolName)')
    // The shipped defect, verbatim. Its absence is the point.
    expect(source).not.toContain("toolName === 'subagent' && activity.orchestrationProgress")
  })
})
