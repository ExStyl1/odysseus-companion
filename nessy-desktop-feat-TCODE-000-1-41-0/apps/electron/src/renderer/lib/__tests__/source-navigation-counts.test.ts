/**
 * The Sources counts in the left nav (owner report 2026-08-01).
 *
 * The nav read `MCPs 1` over a list of 29 rows, because the label and the list
 * were two different derivations of the "same" number: the label counted MCP
 * capabilities in the catalog, the list counted the rows `McpServersPanel`
 * renders — which since A7 also include the built-in dp set, and that set does
 * not live in the catalog.
 *
 * These arms pin the RELATION, never a literal: `counts.mcp` is the length of
 * the very rows the panel builds, and `total` is the sum of its own children.
 * The built-in set has already grown from 12 entries to 28 once, so any arm
 * asserting "29" would have been rewritten rather than protective.
 */

import { describe, expect, it } from 'bun:test'
import type { SafeCapabilitySummary, UserCapabilityCatalog } from '@nessy-agent/shared/protocol/capabilities'
import type { BuiltinDpMcpSettingsViewV1 } from '../../../shared/types'
import { buildMcpServerRows } from '../capability-catalog'
import { buildRuntimeResourceRows, sourceNavigationCounts } from '../runtime-resource-rows'

function summary(partial: Partial<SafeCapabilitySummary> & Pick<SafeCapabilitySummary, 'key' | 'kind' | 'logicalName'>): SafeCapabilitySummary {
  return {
    origin: 'native',
    scope: { kind: 'workspace', workspaceId: 'ws_a' },
    state: 'active',
    readOnly: false,
    trustState: 'trusted',
    credentialState: 'not-required',
    selectedAsUnqualifiedAlias: false,
    diagnosticCodes: [],
    ...partial,
  }
}

const SOURCES: SafeCapabilitySummary[] = [
  summary({ key: 'source:ws_a:my-server', kind: 'source', logicalName: 'my-server', sourceType: 'mcp' }),
  summary({ key: 'source:ws_a:my-folder', kind: 'source', logicalName: 'my-folder', sourceType: 'local' }),
  summary({ key: 'source:ws_a:my-api', kind: 'source', logicalName: 'my-api', sourceType: 'api' }),
  // A DISABLED MCP source still counts: the figure is what is configured, not
  // what is currently runnable — the meaning it has always had (there is no
  // state filter anywhere in this derivation).
  summary({ key: 'source:ws_a:off-server', kind: 'source', logicalName: 'off-server', sourceType: 'mcp', state: 'disabled' }),
]

const SKILLS: SafeCapabilitySummary[] = [
  summary({ key: 'skill:ws_a:one', kind: 'skill', logicalName: 'one' }),
  summary({ key: 'skill:ws_a:two', kind: 'skill', logicalName: 'two' }),
]

const INSTALLED: UserCapabilityCatalog['installedPlugins'] = [{
  pluginKey: 'mk.tracker',
  name: 'Tracker Toolkit',
  version: '1.0.0',
  installedAt: 1,
  capabilityKinds: ['mcp'],
  activation: { global: 'unset', workspace: 'enabled' },
  components: [{ kind: 'mcp', name: 'tracker-mcp', capabilityKey: 'plugin:mk#mcp.tracker', capabilityId: 'mcp.tracker', enabled: true }],
} as unknown as UserCapabilityCatalog['installedPlugins'][number]]

function builtinDp(names: string[]): BuiltinDpMcpSettingsViewV1 {
  return {
    available: true,
    diagnostics: [],
    servers: names.map(name => ({
      name, subcommand: name, description: `${name} server`, defaultEnabled: false, enabled: false,
    })),
  }
}

describe('sourceNavigationCounts', () => {
  it('the MCP figure IS the number of rows the MCP panel renders', () => {
    const builtin = builtinDp(['dpJira', 'dpSage', 'dpGitlab'])
    const counts = sourceNavigationCounts({
      sources: SOURCES, skills: SKILLS, installedPlugins: INSTALLED, builtinDp: builtin,
    })
    const rendered = buildMcpServerRows({ capabilities: SOURCES, installedPlugins: INSTALLED }, builtin)
    expect(counts.mcp).toBe(rendered.length)
    // Spelled out once so the relation above is not vacuously true: two MCP
    // sources + one plugin server + three built-ins.
    expect(counts.mcp).toBe(6)
  })

  it('the built-in set is IN that figure — the label cannot say 1 over a list of 6', () => {
    const withoutBuiltins = sourceNavigationCounts({ sources: SOURCES, skills: SKILLS, installedPlugins: INSTALLED })
    const withBuiltins = sourceNavigationCounts({
      sources: SOURCES, skills: SKILLS, installedPlugins: INSTALLED, builtinDp: builtinDp(['dpJira', 'dpSage', 'dpGitlab']),
    })
    expect(withoutBuiltins.mcp).toBe(3)
    expect(withBuiltins.mcp).toBe(6)
    // …and adding built-ins moves nothing else.
    expect(withBuiltins.api).toBe(withoutBuiltins.api)
    expect(withBuiltins.local).toBe(withoutBuiltins.local)
  })

  it('the Sources aggregate is the sum of its own children plus skills', () => {
    const counts = sourceNavigationCounts({
      sources: SOURCES, skills: SKILLS, installedPlugins: INSTALLED, builtinDp: builtinDp(['dpJira']),
    })
    expect(counts.total).toBe(counts.api + counts.mcp + counts.local + SKILLS.length)
  })

  it('a built-in whose name a configured server took is counted ONCE, as the list shows it', () => {
    const counts = sourceNavigationCounts({
      sources: SOURCES, skills: SKILLS, installedPlugins: INSTALLED, builtinDp: builtinDp(['my-server', 'dpJira']),
    })
    // 2 MCP sources + 1 plugin server + dpJira; `my-server` is not counted
    // twice, because `mergeBuiltinDpMcpServers` would never start it twice.
    expect(counts.mcp).toBe(4)
  })

  it('no built-in view yet (before the first RPC read) counts what the catalog has', () => {
    const counts = sourceNavigationCounts({ sources: SOURCES, skills: SKILLS, installedPlugins: INSTALLED, builtinDp: null })
    expect(counts.mcp).toBe(3)
    expect(counts.total).toBe(1 + 3 + 1 + SKILLS.length)
  })
})

/**
 * The owner's report 2026-08-01: "встроенные мсп не отображаются если выбрать
 * пункт где все sources" — the nav said `Sources 48` over an aggregate list that
 * held none of the 28 built-ins, because a built-in was not a capability and the
 * aggregate list is built from capabilities alone.
 *
 * `b57e5db3` closed that upstream, which is the fix these arms pin: the built-in
 * set is projected into the catalog as ordinary `kind:'mcp'` records, so it
 * reaches the aggregate list through `isSafeSourceRow` with no second addend and
 * no per-panel special case. The counter was NOT re-derived from the list — a
 * count taken from the thing it labels can never disagree with it and therefore
 * proves nothing. It stays an independent sum, and the equality below is the
 * assertion.
 *
 * Mutation probe: drop built-ins from the aggregate (e.g. filter
 * `origin !== 'builtin'` in `buildRuntimeResourceRows`) → the length arm goes
 * red while every count arm above stays green.
 */
describe('the aggregate Sources list', () => {
  // The catalog half of the projection: a built-in arrives as an ordinary MCP
  // capability under `builtin:mcp:<name>` (storage-runtime's
  // `builtinDpMcpCapabilityRecords`).
  const BUILTIN_CAPABILITIES: SafeCapabilitySummary[] = ['dpJira', 'dpSage', 'dpGitlab'].map(name =>
    summary({
      key: `builtin:mcp:${name}`, kind: 'mcp', logicalName: name,
      origin: 'builtin', scope: { kind: 'builtin' }, readOnly: true,
    }),
  )
  // The plugin server's own capability. `buildPluginComponents`
  // (`capabilities/views.ts`) projects components from the SAME resolved
  // entries the catalog's `capabilities` come from, so a component carrying a
  // `capabilityKey` always has its capability here too — the fixture has to say
  // so, or the equality below would be measuring a fixture gap.
  const PLUGIN_SERVER = summary({
    key: 'plugin:mk#mcp.tracker', kind: 'mcp', logicalName: 'tracker-mcp',
    origin: 'plugin', readOnly: true,
  })
  const ALL_SOURCES = [...SOURCES, PLUGIN_SERVER, ...BUILTIN_CAPABILITIES]
  const VIEW = builtinDp(['dpJira', 'dpSage', 'dpGitlab'])

  it('shows the built-ins — the list the nav counts, not a subset of it', () => {
    const rows = buildRuntimeResourceRows({ capabilities: [...ALL_SOURCES, ...SKILLS] })
    expect(rows.filter(row => row.item.origin === 'builtin').map(row => row.item.logicalName))
      .toEqual(['dpJira', 'dpSage', 'dpGitlab'])
  })

  it('is exactly as long as the `Sources` figure beside it', () => {
    const rows = buildRuntimeResourceRows({ capabilities: [...ALL_SOURCES, ...SKILLS] })
    const counts = sourceNavigationCounts({
      sources: ALL_SOURCES, skills: SKILLS, installedPlugins: INSTALLED, builtinDp: VIEW,
    })
    expect(rows).toHaveLength(counts.total)
    // Spelled out so the equality is not vacuous: 4 configured sources + 1
    // plugin server + 3 built-ins + 2 skills.
    expect(counts.total).toBe(10)
  })

  it('and the MCP filter shows the same built-ins the aggregate does', () => {
    const mcpRows = buildRuntimeResourceRows({
      capabilities: [...ALL_SOURCES, ...SKILLS], filter: { kind: 'type', sourceType: 'mcp' },
    })
    expect(mcpRows.filter(row => row.item.origin === 'builtin')).toHaveLength(3)
  })
})
