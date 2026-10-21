/**
 * F1.550 (origin WJ-aw proposed row 1) — `modelToolName`'s Pi branch asks a Pi
 * model for the name the POOL publishes, and this file holds the fixture's mirror
 * of that rule to the pool's own helper on fixed inputs.
 *
 * The Pi branch spelled the tool segment RAW (`mcp__${wire}__${tool}`) while the
 * pool's `buildPoolProxyBaseName` (`packages/shared/src/mcp/mcp-pool.ts`) turns
 * every character outside `[A-Za-z0-9_-]` into `_` and caps the name at 64, so a
 * case asking Pi for a tool named `files.read` would have asked for a name no
 * session carries. No live input was affected: every tool the fixtures and cases
 * use is already `[A-Za-z0-9_-]` and short.
 *
 * The fixture MIRRORS the helper rather than importing it (every case loads the
 * fixture, and the helper's module cost 51.5 s to import from `scripts/cdp` on
 * 2026-09-24). This file pays that import once, so the mirror cannot drift from
 * the helper without going red here. The literal beside each input is the
 * helper's own output, read on 2026-09-24 with `bun` from `scripts/cdp` — it says
 * what the name looks like; the helper arm says the product still answers it.
 */
import { describe, expect, it } from 'bun:test'
import { buildPoolProxyBaseName } from '@nessy-agent/shared/mcp/mcp-pool'
import { EXPECTED, modelToolName, proxyToolName } from './mcp-naming.ts'

const ECHO = EXPECTED.pluginEchoWire // `plugin_cdp-echo-probe_echo`: a 33-character prefix, 31 left for the tool

const INPUTS: ReadonlyArray<{ why: string; wire: string; tool: string; literal: string }> = [
  { why: 'CONTROL — the fixture\'s own tool, untouched', wire: ECHO, tool: 'whoami', literal: 'mcp__plugin_cdp-echo-probe_echo__whoami' },
  { why: 'a punctuated tool name: the dot becomes `_`', wire: 'w', tool: 'files.read', literal: 'mcp__w__files_read' },
  { why: 'the same on the fixture wire', wire: ECHO, tool: 'files.read', literal: 'mcp__plugin_cdp-echo-probe_echo__files_read' },
  { why: 'one `_` per UTF-16 unit: an astral character is two', wire: 'w', tool: 'x😀y', literal: 'mcp__w__x__y' },
  { why: 'the WIRE is left as minted (the pool sanitizes only the tool)', wire: 'acme.docs', tool: 'search', literal: 'mcp__acme.docs__search' },
  { why: 'exactly 64 characters: not cut', wire: ECHO, tool: 'q'.repeat(31), literal: `mcp__plugin_cdp-echo-probe_echo__${'q'.repeat(31)}` },
  { why: '65 characters: the tool segment is cut, with a hash tail', wire: ECHO, tool: 'q'.repeat(32), literal: `mcp__plugin_cdp-echo-probe_echo__${'q'.repeat(24)}_3e4413` },
  { why: 'far over 64 on a short wire', wire: 'w', tool: 'q'.repeat(200), literal: `mcp__w__${'q'.repeat(49)}_ff5504` },
  { why: 'punctuated AND over 64: sanitized first, then cut', wire: ECHO, tool: 'read the Ünïcode page, v2.1 (fast)', literal: 'mcp__plugin_cdp-echo-probe_echo__read_the__n_code_page__v_af1974' },
]

describe('F1.550 · modelToolName asks a Pi model for the name the pool publishes', () => {
  for (const input of INPUTS) {
    it(`${input.why}: ${JSON.stringify(input.tool.length > 40 ? `${input.tool.slice(0, 8)}…(${input.tool.length})` : input.tool)}`, () => {
      expect(modelToolName(input.wire, 'pi', input.tool)).toBe(input.literal)
      // The drift arm: the product's own helper still answers the same name.
      expect(buildPoolProxyBaseName(input.wire, input.tool)).toBe(input.literal)
    })
  }

  it('the host row the fixture spells for its own tool is the same pool name', () => {
    expect(modelToolName(ECHO, 'pi')).toBe(proxyToolName(ECHO, 'pi'))
  })
})
