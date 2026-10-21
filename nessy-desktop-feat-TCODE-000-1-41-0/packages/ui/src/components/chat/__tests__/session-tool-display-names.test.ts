/**
 * F1.434 — the renderer's `getToolDisplayName` names every session-server tool
 * from the ONE shared table (`SESSION_TOOL_DISPLAY_NAMES`,
 * `@nessy-agent/shared/utils/toolNames`), not from a private copy that knew
 * seven of them. Before this row `mcp__session__plugin_install` rendered as
 * `plugin_install` beside `Spawn Session` for `spawn_session`.
 */

import { describe, expect, it } from 'bun:test'
import { SESSION_TOOL_DISPLAY_NAMES } from '@nessy-agent/shared/utils/toolNames'
import { getToolDisplayName } from '../turn-preview'

describe('F1.434 — the renderer names the whole session-tool class from the shared table', () => {
  it('positive — a tool neither old table knew gets its label, prefixed or bare', () => {
    expect(getToolDisplayName('mcp__session__plugin_install')).toBe('Plugin Install')
    expect(getToolDisplayName('mcp__session__list_mcp_resources')).toBe('List MCP Resources')
    expect(getToolDisplayName('web_search')).toBe('Web Search')
  })

  it('a host-only name reaches the renderer too (the tables agree)', () => {
    expect(getToolDisplayName('mcp__session__call_llm')).toBe(SESSION_TOOL_DISPLAY_NAMES['call_llm'] ?? 'missing from the shared table')
    expect(getToolDisplayName('mcp__session__call_llm')).toBe('LLM Query')
  })

  it('every table entry is what the renderer shows for the prefixed name', () => {
    for (const [name, label] of Object.entries(SESSION_TOOL_DISPLAY_NAMES)) {
      expect(getToolDisplayName(`mcp__session__${name}`)).toBe(label)
    }
  })

  it('negative — an unknown name still falls through unchanged, and TodoWrite keeps its renderer label', () => {
    expect(getToolDisplayName('mcp__session__no_such_tool')).toBe('no_such_tool')
    expect(getToolDisplayName('mcp__linear__create_issue')).toBe('create_issue')
    // Scoped to the session server: another server's tool that happens to share a name stays raw.
    expect(getToolDisplayName('mcp__brave__web_search')).toBe('web_search')
    expect(getToolDisplayName('mcp__nessy_session__web_search')).toBe('Web Search')
    expect(getToolDisplayName('TodoWrite')).toBe('Todo List Updated')
  })
})
