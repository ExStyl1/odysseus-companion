/**
 * F1.277 — the MCP-W2 codex arm asks for the name codex is ACTUALLY handed,
 * because the fixture reads the product's helper instead of spelling it by hand.
 *
 * `modelToolName`'s codex branch was `${wire}__${tool}` with hyphens replaced —
 * a rule read off the one hyphenated name SIT-11 measured. The product's rule is
 * `codexModelToolName` (`packages/shared/src/capabilities/mcp-wire-name.ts`,
 * read at `rust-v0.154.0`, F1.155/F1.217): EVERY character outside
 * `[A-Za-z0-9_]` becomes `_`, one per code point, and an empty name is `_`. The
 * two agree on the measured wire and part company on any other character a
 * wire can carry — a `.` in a source slug, a non-ASCII letter — where the case
 * would ask the model for a name it was never given and report a working pool
 * as broken (the F1.153 failure, from the other side).
 */
import { describe, expect, it } from 'bun:test'
import { codexModelToolName } from '@nessy-agent/shared/capabilities/mcp-wire-name'
import { EXPECTED, modelToolName } from './mcp-naming.ts'

describe('F1.277 · modelToolName asks a codex model for codexModelToolName\'s spelling', () => {
  it('CONTROL: the measured wire reads the same both ways (SIT-11 C4)', () => {
    expect(modelToolName(EXPECTED.pluginEchoWire, 'codex')).toBe('plugin_cdp_echo_probe_echo__whoami')
    expect(modelToolName(EXPECTED.pluginEchoWire, 'codex')).toBe(codexModelToolName(EXPECTED.pluginEchoWire, 'whoami'))
  })

  it('a character the hand rule did not know is sanitized the way codex sanitizes it', () => {
    for (const [wire, tool] of [['acme.docs', 'search'], ['wiki-ü', 'read'], ['a b', 'c-d']] as const) {
      expect(modelToolName(wire, 'codex', tool)).toBe(codexModelToolName(wire, tool))
    }
    expect(modelToolName('acme.docs', 'codex', 'search')).toBe('acme_docs__search')
  })

  // F1.393 — the three inputs above all part company through the WIRE, which the
  // resolver's mint (`sanitizeMcpNameSegment`) never lets carry those characters.
  // A server-supplied TOOL name is the axis nothing upstream sanitizes, so it is
  // where the hand rule (`${wire}__${tool}` with hyphens replaced) really fails:
  // it answered 'plugin_cdp_echo_probe_echo__files.read'.
  it('a server-supplied TOOL name is sanitized too — the axis the wire mint never reaches', () => {
    expect(modelToolName(EXPECTED.pluginEchoWire, 'codex', 'files.read')).toBe('plugin_cdp_echo_probe_echo__files_read')
  })

  it('Pi is untouched: the pool name is the model name there', () => {
    expect(modelToolName('acme.docs', 'pi', 'search')).toBe('mcp__acme.docs__search')
  })

  // F1.390 — Claude Code builds `mcp__${ln(server)}__${ln(tool)}`, where `ln`
  // replaces every character outside `[a-zA-Z0-9_-]` with `_` (vendored claude
  // 2.1.251, read in its own bytes: `function ln(_){let e=_.replace(/[^a-zA-Z0-9_-]/g,"_")`).
  it('claude normalises the server and the tool the way Claude Code does, and keeps the hyphen', () => {
    expect(modelToolName('acme.docs', 'claude', 'search')).toBe('mcp__acme_docs__search')
    expect(modelToolName(EXPECTED.pluginEchoWire, 'claude')).toBe('mcp__plugin_cdp-echo-probe_echo__whoami')
    expect(modelToolName(EXPECTED.pluginEchoWire, 'claude', 'files.read')).toBe('mcp__plugin_cdp-echo-probe_echo__files_read')
  })
})
