/**
 * Enable/Disable on a Sources row and on its detail page (owner decision
 * 2026-08-01): ONE action whose label follows the current state, only on the
 * kinds that carry the option, and always down the write path that kind
 * already used.
 *
 * The two write paths are the whole risk. A built-in dp MCP server's switch is
 * a USER PREFERENCE (`setBuiltinDpMcpServerEnabled` → `config.json`); a
 * plugin-origin source's is a CAPABILITY POLICY RECORD (`plugin.manage`). They
 * are separate by owner decision, and routing one through the other writes the
 * wrong file with no error. Every arm here therefore asserts BOTH that the
 * right callback fired and that the wrong one never did — the second half is
 * what a mis-route trips.
 *
 * Pure by necessity, not by preference: `SourceMenu` and `SourceDetailActions`
 * both import `menu-context` / `styled-dropdown`, whose `@nessy-agent/ui`
 * barrel the bun runner cannot load, so a rendered assertion about the menu is
 * unavailable. Keeping the decision here is what makes it testable.
 *
 * Mutation probes:
 *   a) route the built-in's `run()` through `onTogglePlugin` → the write-path
 *      arms go red;
 *   b) return an action for a native `.mcp.json` / api / local row → the
 *      dead-item arm goes red.
 */

import { describe, expect, it } from 'bun:test'
import type { SafeCapabilitySummary } from '@nessy-agent/shared/protocol/capabilities'
import type { BuiltinDpMcpSettingsViewV1 } from '../../../shared/types'
import type { SafeSourceRow } from '../capability-catalog'
import {
  sourceEnablementActions,
  sourceEnablementFor,
  type SourceEnablementScope,
} from '../source-enablement'

function summary(
  partial: Partial<SafeCapabilitySummary> & Pick<SafeCapabilitySummary, 'key' | 'kind' | 'logicalName'>,
): SafeSourceRow {
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
  } as SafeSourceRow
}

const BUILTIN = summary({
  key: 'builtin:mcp:dpJira', kind: 'mcp', logicalName: 'dpJira',
  displayName: 'DP Jira', origin: 'builtin', scope: { kind: 'builtin' },
})
const PLUGIN_CONNECTOR = summary({
  key: 'plugin:mk#mcp.tracker', kind: 'mcp', logicalName: 'tracker', origin: 'plugin', readOnly: true,
  connectorOrigin: { pluginKey: 'mk.tracker', connectorId: 'tracker', serverName: 'tracker' },
})
const NATIVE_MCP = summary({
  key: 'source:ws_a:my-server', kind: 'mcp', logicalName: 'my-server',
})
const API = summary({ key: 'source:ws_a:my-api', kind: 'source', logicalName: 'my-api', sourceType: 'api' })
const LOCAL = summary({ key: 'source:ws_a:files', kind: 'source', logicalName: 'files', sourceType: 'local' })
// A plugin-origin row with NO connector provenance: there is no per-source
// mutation for it, so it must stay display-only rather than reach for the
// owning plugin's activation by guesswork.
const PLUGIN_NO_CONNECTOR = summary({
  key: 'plugin:mk#mcp.orphan', kind: 'mcp', logicalName: 'orphan', origin: 'plugin', readOnly: true,
})

function builtinDp(entries: Array<{ name: string; enabled: boolean }>): BuiltinDpMcpSettingsViewV1 {
  return {
    available: true,
    diagnostics: [],
    servers: entries.map(entry => ({
      name: entry.name, subcommand: entry.name, description: `${entry.name} server`,
      defaultEnabled: false, enabled: entry.enabled,
    })),
  }
}

interface Calls {
  plugin: Array<[string, SourceEnablementScope, boolean]>
  builtin: Array<[string, boolean]>
}

function harness(overrides: {
  activation?: Map<string, { workspace: boolean; project: boolean }>
  hasProjectContext?: boolean
  builtinDp?: BuiltinDpMcpSettingsViewV1 | null
} = {}) {
  const calls: Calls = { plugin: [], builtin: [] }
  return {
    calls,
    input: {
      activationByPluginKey: overrides.activation ?? new Map(),
      hasProjectContext: overrides.hasProjectContext ?? false,
      builtinDp: overrides.builtinDp ?? null,
      onTogglePlugin: (pluginKey: string, scope: SourceEnablementScope, next: boolean) => {
        calls.plugin.push([pluginKey, scope, next])
      },
      onToggleBuiltin: (name: string, next: boolean) => { calls.builtin.push([name, next]) },
    },
  }
}

describe('which kinds carry the option', () => {
  it('a built-in dp MCP server does, through the built-in preference', () => {
    const { input } = harness({ builtinDp: builtinDp([{ name: 'dpJira', enabled: true }]) })
    const enablement = sourceEnablementFor(BUILTIN, input)
    expect(enablement?.kind).toBe('builtin')
    // The WIRE name, not the display name: the preference is keyed by it.
    expect(enablement).toMatchObject({ name: 'dpJira', enabled: true })
  })

  it('a plugin-origin connector does, through the plugin activation', () => {
    const { input } = harness({
      activation: new Map([['mk.tracker', { workspace: true, project: false }]]),
    })
    const enablement = sourceEnablementFor(PLUGIN_CONNECTOR, input)
    expect(enablement).toMatchObject({ kind: 'plugin', pluginKey: 'mk.tracker', workspaceEnabled: true })
  })

  it('nothing else does — a dead menu item is the defect this prevents', () => {
    const { input } = harness()
    for (const row of [NATIVE_MCP, API, LOCAL, PLUGIN_NO_CONNECTOR]) {
      expect(sourceEnablementFor(row, input), row.key).toBeUndefined()
      expect(sourceEnablementActions(sourceEnablementFor(row, input)), row.key).toEqual([])
    }
  })
})

describe('the built-in row', () => {
  it('takes its state from the LIVE view, not the catalog half', () => {
    // The catalog says active; the preference has just been switched off and
    // nothing publishes a capability-changed event for that write, so a label
    // read from the catalog would still say "Disable".
    const { input } = harness({ builtinDp: builtinDp([{ name: 'dpJira', enabled: false }]) })
    const actions = sourceEnablementActions(sourceEnablementFor(BUILTIN, input))
    expect(actions).toHaveLength(1)
    expect(actions[0]!.labelKey).toBe('sourcesManagement.enable')
    expect(actions[0]!.enabled).toBe(false)
  })

  it('falls back to the catalog state before the first RPC read', () => {
    const { input } = harness({ builtinDp: null })
    const actions = sourceEnablementActions(sourceEnablementFor(BUILTIN, input))
    expect(actions[0]!.labelKey).toBe('sourcesManagement.disable')
  })

  it('offers exactly ONE action, and it writes the SETTINGS key', () => {
    const { calls, input } = harness({ builtinDp: builtinDp([{ name: 'dpJira', enabled: true }]) })
    const actions = sourceEnablementActions(sourceEnablementFor(BUILTIN, input))
    expect(actions.map(action => action.id)).toEqual(['builtin'])
    expect(actions[0]!.labelKey).toBe('sourcesManagement.disable')
    actions[0]!.run()
    expect(calls.builtin).toEqual([['dpJira', false]])
    // The write path a built-in must never take.
    expect(calls.plugin).toEqual([])
  })
})

describe('the plugin-origin row', () => {
  it('offers one action per scope that exists, each labelled by its own state', () => {
    const { input } = harness({
      activation: new Map([['mk.tracker', { workspace: true, project: false }]]),
      hasProjectContext: true,
    })
    const actions = sourceEnablementActions(sourceEnablementFor(PLUGIN_CONNECTOR, input))
    expect(actions.map(action => [action.id, action.labelKey])).toEqual([
      ['workspace', 'sourcesManagement.disableInWorkspace'],
      ['project', 'sourcesManagement.enableInProject'],
    ])
  })

  it('drops the project scope with no project context', () => {
    const { input } = harness({
      activation: new Map([['mk.tracker', { workspace: false, project: false }]]),
      hasProjectContext: false,
    })
    const actions = sourceEnablementActions(sourceEnablementFor(PLUGIN_CONNECTOR, input))
    expect(actions.map(action => action.id)).toEqual(['workspace'])
    expect(actions[0]!.labelKey).toBe('sourcesManagement.enableInWorkspace')
  })

  it('writes the POLICY record, never the built-in preference', () => {
    const { calls, input } = harness({
      activation: new Map([['mk.tracker', { workspace: true, project: false }]]),
      hasProjectContext: true,
    })
    const actions = sourceEnablementActions(sourceEnablementFor(PLUGIN_CONNECTOR, input))
    actions[0]!.run()
    actions[1]!.run()
    expect(calls.plugin).toEqual([
      ['mk.tracker', 'workspace', false],
      ['mk.tracker', 'project', true],
    ])
    expect(calls.builtin).toEqual([])
  })
})
