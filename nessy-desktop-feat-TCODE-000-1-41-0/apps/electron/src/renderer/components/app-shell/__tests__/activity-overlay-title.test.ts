/**
 * F1.433 — the activity overlay's title and its type badge showed the raw wire
 * name for a tool the row itself names.
 *
 * ChatDisplay built both from `activity.displayName || activity.toolName`, and
 * never consulted `toolDisplayMeta` or `getToolDisplayName`. Every `mcp__` tool
 * is routed to the stacked overlay (`isStackedActivityTool`), so on codex —
 * which never sets `displayName` — the same `send_agent_message` event read
 * "Send Agent Message" on the row (the host's `toolDisplayMeta`, F1.251) and
 * "mcp__session__send_agent_message" in the overlay it opens.
 *
 * Both sites now go through `formatToolDisplay`, the resolver the ROW uses,
 * exported through `@nessy-agent/ui`. It used to live in TurnCard.tsx, which
 * cannot be loaded under `bun test` (turn-preview.ts's header records why: a
 * Vite-only worker specifier behind Markdown → react-pdf), so this file could
 * only pin the wiring on source. F1.477 (P4) moved it to `chat/tool-display.ts`,
 * which loads, so the resolver's answer for the F1.433 event is now asserted as
 * a VALUE; the rendered title is still a sitting ask.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import { formatToolDisplay } from '../../../../../../../packages/ui/src/components/chat/tool-display'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')

describe('F1.433 — the overlay title is the row\'s own name', () => {
  const chatDisplay = read('../ChatDisplay.tsx')

  it('both title sites (the stacked overlay and the output overlay\'s badge) call the row\'s resolver', () => {
    const calls = chatDisplay.match(/formatToolDisplay\(overlayState\.activity\)\.name/g) ?? []
    expect(calls.length).toBe(2)
  })

  it('negative — no title site reads displayName-or-toolName any more', () => {
    expect(chatDisplay).not.toContain('overlayState.activity.displayName || overlayState.activity.toolName')
  })

  it('the resolver is the row\'s: the work-log row calls tool-display\'s formatToolDisplay and @nessy-agent/ui re-exports it', () => {
    expect(read('../../../../../../../packages/ui/src/components/chat/tool-display.ts')).toContain('export function formatToolDisplay(')
    // UB14.11 — v0.15.1's row lives in turn/ActivityRow.tsx and reads turn/tool-display.ts, which
    // re-exports OURS (never upstream's regex split; F1.477).
    expect(read('../../../../../../../packages/ui/src/components/chat/turn/tool-display.ts')).toContain("export { formatToolDisplay } from '../tool-display'")
    expect(read('../../../../../../../packages/ui/src/components/chat/turn/ActivityRow.tsx')).toMatch(/formatToolDisplay,[\s\S]*?\} from '\.\/tool-display'/)
    expect(read('../../../../../../../packages/ui/src/components/chat/index.ts')).toMatch(/export \{ formatToolDisplay \} from '\.\/tool-display'/)
    expect(read('../../../../../../../packages/ui/src/index.ts')).toContain('formatToolDisplay,')
  })

  it('F1.477 (P4) — the resolver, driven: the F1.433 event reads the host\'s name, and the wire name only without one', () => {
    const activity = { id: 'a1', type: 'tool', status: 'running', toolName: 'mcp__session__send_agent_message', timestamp: 1 } as const
    expect(formatToolDisplay({ ...activity, toolDisplayMeta: { displayName: 'Send Agent Message', category: 'native' } } as never).name)
      .toBe('Send Agent Message')
    // A source's MCP tool keeps its slug beside the source name.
    expect(formatToolDisplay({ ...activity, toolName: 'mcp__linear__create_issue', toolDisplayMeta: { displayName: 'Linear', category: 'source' } } as never).name)
      .toBe('Linear: create_issue')
    // CONTROL — no meta and no model name: the wire name goes through getToolDisplayName, never the raw mcp__ string.
    expect(formatToolDisplay(activity as never).name).not.toBe('mcp__session__send_agent_message')
  })
})
