/**
 * An MCP row label splits on the real boundary — the DOUBLE underscore.
 *
 * The renderer used to split with `/^mcp__([^_]+)__(.+)$/`, and `[^_]+` stops at
 * the FIRST underscore. Two shapes that ships in production broke on it:
 *
 * 1. A wire name that contains a single underscore — `mcp__my_server_v2__whoami`
 *    is exactly what the 1.24.0/1.25.0 sanitizer mints from a server called
 *    `my server.v2` — did not match the regex AT ALL, so the row fell back to
 *    the raw `mcp__…` name.
 * 2. The Codex `sources` bridge row, `mcp__sources__<wire>__<tool>`, matched but
 *    split in the wrong place: the wire name leaked into the tool half.
 *
 * The rule mirrors `resolveToolDisplayMeta` in
 * `packages/server-core/src/sessions/SessionManager.ts` (~:988-1057, fixed in
 * 4a2b38d67): split on `__`, require ≥3 segments, and when segment 1 is
 * `sources` AND there are ≥4 segments AND segment 2 is non-empty, the real
 * server is segment 2. A degenerate `mcp__sources__x` keeps the plain shape.
 * The renderer and server-core must never disagree about what a row is called.
 */
import { describe, expect, it } from 'bun:test'
import { parseMcpToolName, stripMcpToolPrefix } from '../mcp-tool-name'

describe('parseMcpToolName', () => {
  it('splits a simple Pi/Claude name', () => {
    expect(parseMcpToolName('mcp__t-tracker__list')).toEqual({
      server: 't-tracker',
      tool: 'list',
    })
  })

  it('splits a wire name that contains single underscores', () => {
    // `my server.v2` → sanitized to `my_server_v2`. The old `[^_]+` regex
    // no-matched this entirely and the raw name reached the label.
    expect(parseMcpToolName('mcp__my_server_v2__whoami')).toEqual({
      server: 'my_server_v2',
      tool: 'whoami',
    })
  })

  it('reads the REAL server out of a codex sources-bridge row', () => {
    expect(parseMcpToolName('mcp__sources__plugin_cdp-echo-probe_echo__whoami')).toEqual({
      server: 'plugin_cdp-echo-probe_echo',
      tool: 'whoami',
    })
  })

  it('splits a hash fallback server name', () => {
    expect(parseMcpToolName('mcp__server-ab518e32f3__whoami')).toEqual({
      server: 'server-ab518e32f3',
      tool: 'whoami',
    })
  })

  it('leaves a degenerate sources shape on the plain lookup', () => {
    // Only 3 segments: there is no wire-name segment to shift to, so `sources`
    // stays the server — same fallback server-core takes rather than throwing.
    expect(parseMcpToolName('mcp__sources__x')).toEqual({
      server: 'sources',
      tool: 'x',
    })
  })

  it('keeps a multi-segment tool half joined', () => {
    expect(parseMcpToolName('mcp__linear__list__issues')).toEqual({
      server: 'linear',
      tool: 'list__issues',
    })
  })

  it('returns undefined for names that are not MCP wire names', () => {
    expect(parseMcpToolName('Bash')).toBeUndefined()
    expect(parseMcpToolName('TodoWrite')).toBeUndefined()
    expect(parseMcpToolName('api_stripe')).toBeUndefined()
    // Fewer than 3 segments — nothing to split.
    expect(parseMcpToolName('mcp__lonely')).toBeUndefined()
  })
})

describe('stripMcpToolPrefix', () => {
  it('strips the prefix on every MCP shape', () => {
    expect(stripMcpToolPrefix('mcp__t-tracker__list')).toBe('list')
    expect(stripMcpToolPrefix('mcp__my_server_v2__whoami')).toBe('whoami')
    expect(stripMcpToolPrefix('mcp__sources__plugin_cdp-echo-probe_echo__whoami')).toBe('whoami')
    expect(stripMcpToolPrefix('mcp__server-ab518e32f3__whoami')).toBe('whoami')
    expect(stripMcpToolPrefix('mcp__sources__x')).toBe('x')
  })

  it('leaves every non-MCP name byte-unchanged', () => {
    for (const name of ['Bash', 'TodoWrite', 'set_session_labels', 'api_stripe', 'mcp__lonely', '']) {
      expect(stripMcpToolPrefix(name)).toBe(name)
    }
  })
})
