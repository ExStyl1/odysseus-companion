import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  capMcpNameSegment,
  CODEX_POOL_TOOL_NAMESPACE,
  codexHookToolName,
  codexModelToolName,
  pluginIdFromInstanceId,
  pluginMcpWireName,
  sanitizeMcpNameSegment,
  translatePluginMcpToolName,
} from '../mcp-wire-name.ts'

describe('sanitizeMcpNameSegment', () => {
  // F3 (2026-08-11): the mint sanitized only inside `pluginMcpWireName`; a
  // scoped/native/builtin wire name went through `capMcpNameSegment` alone,
  // which caps but never sanitizes, so a space or a dot survived straight
  // into the wire name and broke `tryParsePiDynamicMcpBindingName`'s
  // `[A-Za-z0-9_-]` regex. This is the same transform, exported so every mint
  // site can share it.
  test('replaces disallowed characters and never leaves a __ run', () => {
    expect(sanitizeMcpNameSegment('my server.v2')).toBe('my_server_v2')
    expect(sanitizeMcpNameSegment('my server.v2')).not.toMatch(/__/)
  })
  test('is exactly the per-segment transform pluginMcpWireName already applied internally', () => {
    // Pins that extracting the transform did not change it: `pluginMcpWireName`
    // composes its output from these two segments (see the 'claude-shaped,
    // stable, sanitized' case below) — `plugin_<segment(pluginId)>_<segment(serverName)>`.
    expect(sanitizeMcpNameSegment('my plugin!')).toBe('my_plugin')
    expect(sanitizeMcpNameSegment('db.tools')).toBe('db_tools')
  })
})

describe('pluginMcpWireName', () => {
  test('claude-shaped, stable, sanitized', () => {
    expect(pluginMcpWireName('figma', 't-tracker')).toBe('plugin_figma_t-tracker')
    expect(pluginMcpWireName('my plugin!', 'db.tools')).toBe('plugin_my_plugin_db_tools')
  })
  test('never contains __ and never exceeds 40 chars', () => {
    const name = pluginMcpWireName('a__very__long__plugin__name__indeed__x', 'server__with__runs')
    expect(name).not.toMatch(/__/)
    expect(name.length).toBeLessThanOrEqual(40)
  })
  test('cap is deterministic and collision-resistant', () => {
    const a = capMcpNameSegment('x'.repeat(80), 40)
    const b = capMcpNameSegment('x'.repeat(80) + 'y', 40)
    expect(a).toHaveLength(40)
    expect(a).not.toBe(b)
    expect(capMcpNameSegment('short', 40)).toBe('short')
    // A slice ending on `_` must not form `__` at the hash joint.
    expect(capMcpNameSegment(`${'a'.repeat(32)}_${'b'.repeat(40)}`, 40)).not.toMatch(/__/)
  })
  // P6.971 — the digest behind `capMcpNameSegment`'s tail moved off
  // `node:crypto` so the RENDERER bundle stops importing a node builtin by
  // name (a hard rollup error in a Vite production build, which is what failed
  // `build-dmg.sh`). The controller's decision was that the WIRE NAMES DO NOT
  // CHANGE, so this recomputes the expected name from `node:crypto` here, in
  // the test, the way the module used to: every mint site recomputes a wire
  // name independently, so one differing byte unbinds every plugin-bundled MCP
  // tool rather than raising anything.
  test('the mint is byte-identical to the node:crypto digest it replaced', () => {
    const nodeSha6 = (value: string): string =>
      createHash('sha256').update(value).digest('hex').slice(0, 6)
    const nodeCap = (value: string, max: number): string =>
      value.length <= max ? value : `${value.slice(0, max - 7).replace(/_+$/, '')}_${nodeSha6(value)}`
    const nodeWireName = (pluginId: string, serverName: string): string => {
      const raw = `plugin_${sanitizeMcpNameSegment(pluginId) || 'plugin'}_${sanitizeMcpNameSegment(serverName) || 'server'}`
      return nodeCap(raw.replace(/_{2,}/g, '_'), 40)
    }
    const cases: Array<[string, string]> = [
      ['figma', 't-tracker'],
      ['my plugin!', 'db.tools'],
      ['a__very__long__plugin__name__indeed__x', 'server__with__runs'],
      ['Очень-Длинный-Плагин-С-Юникодом', 'сервер-документов'],
      ['x'.repeat(60), 'y'.repeat(60)],
      ['', ''],
    ]
    for (const [pluginId, serverName] of cases) {
      expect(pluginMcpWireName(pluginId, serverName)).toBe(nodeWireName(pluginId, serverName))
    }
    // The cap's hash tail on its own, including a name whose slice ends on `_`.
    for (const value of ['x'.repeat(80), `${'a'.repeat(32)}_${'b'.repeat(40)}`, '🙂'.repeat(50)]) {
      expect(capMcpNameSegment(value, 40)).toBe(nodeCap(value, 40))
    }
  })
  test('pluginIdFromInstanceId parses the v2 format', () => {
    expect(pluginIdFromInstanceId('plugin://registry-abc/figma@2.0.13#deadbeef')).toBe('figma')
    expect(pluginIdFromInstanceId('garbage')).toBeNull()
  })
  test('F3: applyCollisionPolicy wraps this output in sanitize-then-cap too — proven a no-op, including over a capped (hashed) name', () => {
    const cases: Array<[string, string]> = [
      ['figma', 't-tracker'],
      ['my plugin!', 'db.tools'],
      // Long enough that pluginMcpWireName's OWN internal cap fires, so the
      // wrapped result carries the `_<6-hex>` hash tail too.
      ['a__very__long__plugin__name__indeed__x', 'server__with__runs'],
    ]
    for (const [pluginId, serverName] of cases) {
      const minted = pluginMcpWireName(pluginId, serverName)
      expect(capMcpNameSegment(sanitizeMcpNameSegment(minted), 40)).toBe(minted)
    }
  })
})

describe('translatePluginMcpToolName', () => {
  const own = new Set(['t-tracker', 'docs'])
  test('bare own-server reference is qualified', () => {
    expect(translatePluginMcpToolName('mcp__t-tracker__list', 'figma', own))
      .toBe('mcp__plugin_figma_t-tracker__list')
  })
  test('already-qualified and foreign references pass through', () => {
    expect(translatePluginMcpToolName('mcp__plugin_figma_docs__read', 'figma', own))
      .toBe('mcp__plugin_figma_docs__read')
    expect(translatePluginMcpToolName('mcp__dpJira__search', 'figma', own))
      .toBe('mcp__dpJira__search')
    expect(translatePluginMcpToolName('Bash', 'figma', own)).toBe('Bash')
  })
})

/**
 * F1.155 — the name a codex model is handed, written out BY HAND from codex's
 * own `sanitize_responses_api_tool_name` at `rust-v0.154.0`
 * (`codex-mcp/src/mcp/mod.rs`): every character that is not an ASCII letter,
 * digit or `_` becomes one `_`, per code point, and empty is `_`. The shipped
 * binary agrees on the hyphen case: `mcp/__tests__/codex-model-tool-name-live.test.ts`.
 */
describe('codexModelToolName', () => {
  test("SIT-11's measured name: hyphens become underscores, no prefix, no bridge key", () => {
    expect(codexModelToolName('plugin_cdp-echo-probe_echo', 'whoami')).toBe('plugin_cdp_echo_probe_echo__whoami')
    expect(codexModelToolName('dpGitlab', 'dp_gitlab_whoami')).toBe('dpGitlab__dp_gitlab_whoami')
  })
  test('is NOT the host row name, and carries no namespace', () => {
    const name = codexModelToolName('plugin_cdp-echo-probe_echo', 'whoami')
    expect(name).not.toBe('mcp__sources__plugin_cdp-echo-probe_echo__whoami')
    expect(name.startsWith('mcp__')).toBe(false)
    expect(CODEX_POOL_TOOL_NAMESPACE).toBe('mcp__sources')
  })
  test('does not collapse runs the way the wire mint does: one `_` per character, per code point', () => {
    // `sanitizeMcpNameSegment` would collapse these; codex does not.
    expect(codexModelToolName('a.b c', 't-1')).toBe('a_b_c__t_1')
    expect(codexModelToolName('server-ab12', 'мой')).toBe('server_ab12_____')
    expect(codexModelToolName('', '')).toBe('__')
    // F1.394: an ASTRAL character is one code point and TWO UTF-16 units, so this is
    // the only input that tells "per code point" (Rust `chars()`) from "per unit" —
    // a mutant looping `for (let i = 0; i < s.length; i++)` answers `x__y__t`.
    expect(codexModelToolName('x😀y', 't')).toBe('x_y__t')
  })
})

/**
 * F1.219 — the name codex's OWN hooks see, written out by hand from
 * `core/src/tools/handlers/mcp.rs` at `rust-v0.154.0` (`hook_tool_name`:
 * namespace, trailing `_` trimmed, `__`, name, leading `_` trimmed). The shipped
 * binary agrees: `mcp/__tests__/codex-native-hook-matcher-live.test.ts`.
 */
describe('codexHookToolName', () => {
  test('is the sanitized name under the pool namespace — not the host row, not the model name', () => {
    expect(codexHookToolName('plugin_cdp-echo-probe_echo', 'whoami')).toBe('mcp__sources__plugin_cdp_echo_probe_echo__whoami')
    expect(codexHookToolName('plugin_cdp-echo-probe_echo', 'whoami')).not.toBe('mcp__sources__plugin_cdp-echo-probe_echo__whoami')
    expect(codexHookToolName('plugin_cdp-echo-probe_echo', 'whoami')).not.toBe(codexModelToolName('plugin_cdp-echo-probe_echo', 'whoami'))
  })
  test("trims the callable name's leading `_` the way `join_tool_name` does", () => {
    expect(codexModelToolName('-x', 't')).toBe('_x__t')
    expect(codexHookToolName('-x', 't')).toBe('mcp__sources__x__t')
  })
})

/**
 * F1.380 (origin the WJ-hh verifier on F1.272) — F1.272's shift from codex's row
 * spelling to the host's, pinned DIRECTLY. It was reached only through the codex
 * projection arms, so its two pass-through branches (a pool row with no second
 * `__`, and a server that is not the pool) were unpinned, and a mutant dropping
 * the `__` check survived.
 */
describe('hostMcpToolNameForCodexRow', () => {
  test.each([
    // A pool row: one segment shifted past the bridge.
    ['mcp__sources__linear__create_issue', 'mcp__linear__create_issue'],
    ['mcp__sources__a__b', 'mcp__a__b'],
    ['mcp__sources__plugin_cdp-echo-probe_echo__whoami', 'mcp__plugin_cdp-echo-probe_echo__whoami'],
    // A pool row with NO second `__` is the pool server's own tool, not a
    // shifted source tool: unchanged. The `__` check is this row.
    ['mcp__sources__tool_search', 'mcp__sources__tool_search'],
    // Not the pool: already the host's spelling.
    ['mcp__session__automation_update', 'mcp__session__automation_update'],
    ['mcp__session__x', 'mcp__session__x'],
    // A name that only LOOKS like the prefix (no `__` after `sources`).
    ['mcp__sourcesx__a__b', 'mcp__sourcesx__a__b'],
    ['Bash', 'Bash'],
  ])('%s -> %s', (row, host) => {
    expect(hostMcpToolNameForCodexRow(row)).toBe(host)
  })
})

// F1.380 — imported here so the import block above keeps its line count.
import { hostMcpToolNameForCodexRow } from '../mcp-wire-name.ts'
