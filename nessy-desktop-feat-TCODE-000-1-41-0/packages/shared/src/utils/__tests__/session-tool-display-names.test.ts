/**
 * F1.434 / F1.435 — ONE display-name table for the session server's tools.
 *
 * F1.434: fifteen snake_case session tools had no entry in either table and
 * rendered raw (`plugin_install`, `web_search`, …). F1.435: the two tables that
 * did exist — the host's `resolveToolDisplayMeta` and the renderer's
 * `getToolDisplayName` — disagreed (14 host-only names, 4 renderer-only session
 * names, plus TodoWrite), and nothing kept them in step. The table now lives
 * here, both consume it, and this suite is the thing that keeps it complete:
 * a new snake_case tool in `SESSION_TOOL_DEFS` with no label goes red.
 */

import { describe, expect, it } from 'bun:test'
import { SESSION_TOOL_DEFS } from '@nessy-agent/session-tools-core'
import { SESSION_TOOL_DISPLAY_NAMES } from '../toolNames'

const SNAKE_CASE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/

describe('SESSION_TOOL_DISPLAY_NAMES — every snake_case session tool has a label', () => {
  const snakeNames = SESSION_TOOL_DEFS.map(def => def.name).filter(name => SNAKE_CASE.test(name))

  it('positive control — the registry really has snake_case tools to check', () => {
    expect(snakeNames.length).toBeGreaterThan(30)
    expect(snakeNames).toContain('plugin_install')
  })

  it('no snake_case tool-def is missing from the table', () => {
    expect(snakeNames.filter(name => !SESSION_TOOL_DISPLAY_NAMES[name])).toEqual([])
  })

  it('negative — the table names only real session tools (no stale entry for a tool that is gone)', () => {
    const registry = new Set(SESSION_TOOL_DEFS.map(def => def.name))
    expect(Object.keys(SESSION_TOOL_DISPLAY_NAMES).filter(name => !registry.has(name))).toEqual([])
  })

  it('a label is prose, never the raw name', () => {
    for (const [name, label] of Object.entries(SESSION_TOOL_DISPLAY_NAMES)) {
      expect(label).not.toBe(name)
      expect(label).not.toContain('_')
    }
  })
})
