/**
 * `turn-preview.ts`'s tool display name, asserted on VALUES — P2.493, F1.434/F1.435, F1.251.
 *
 * UB14.11 (v0.15.1's work log) retired `getPreviewText`: the collapsed header's text is
 * `turn/work-log-summary.ts`'s `getWorkLogPreview` now, and its priority-order cases moved to
 * `turn/__tests__/work-log-summary.test.ts` (the error-suffix cases became the failed-chip count
 * there, because the count is no longer a tail of the text). What this module still decides — the
 * name a tool row and the running-tools preview read — stays asserted here.
 */
import { describe, expect, it } from 'bun:test'

import { getToolDisplayName } from '../turn-preview'

describe('the module loads at all — the control this file exists for', () => {
  it('imports, which `TurnCard.tsx` does not', () => {
    expect(typeof getToolDisplayName).toBe('function')
  })
})

describe('tool display names', () => {
  it('applies the friendly table', () => {
    expect(getToolDisplayName('TodoWrite')).toBe('Todo List Updated')
    expect(getToolDisplayName('set_session_labels')).toBe('Set Session Labels')
  })

  it('strips an MCP prefix before consulting the table', () => {
    expect(getToolDisplayName('mcp__session__list_sessions')).toBe('List Sessions')
  })

  it('passes an unknown name through unchanged', () => {
    expect(getToolDisplayName('Read')).toBe('Read')
  })

  // F1.251 — three real session tools (session-tools-core `tool-defs.ts`) had
  // no entry, so a row whose model supplied no `_displayName` showed the raw
  // snake_case name. Upstream v0.13.4's TurnCard table carries all three.
  it('names the three session tools the table was missing, prefixed or bare', () => {
    expect(getToolDisplayName('mcp__session__spawn_session')).toBe('Spawn Session')
    expect(getToolDisplayName('mcp__session__archive_session')).toBe('Archive Session')
    expect(getToolDisplayName('mcp__session__send_agent_message')).toBe('Send Agent Message')
    expect(getToolDisplayName('spawn_session')).toBe('Spawn Session')
  })

  it('an unknown session tool still falls through unchanged', () => {
    expect(getToolDisplayName('mcp__session__no_such_tool')).toBe('no_such_tool')
  })
})
