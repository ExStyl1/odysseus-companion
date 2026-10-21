/**
 * Playground registry for the UNIFIED MCP SERVERS PANEL (C6, capability-path
 * plan / ADR § 6): ONE surface for plugin-owned, user-created AND built-in dp
 * servers, mirroring Claude's `/mcp` — origin label, transport, auth state, and
 * the per-server enable toggle (capabilityId-scoped policy records for plugin
 * rows, the built-in preference for dp rows).
 *
 * IPC-free: the catalog and the built-in view are synthesized from knobs,
 * toggles are no-ops, and NOTHING here resolves or runs `dp`. The
 * plugin-filtered variant is the plugin detail page's view of the SAME rows —
 * and it never carries built-ins.
 */

import * as React from 'react'
import { McpServersPanel } from '@/components/app-shell/McpServersPanel'
import type { UserCapabilityCatalog, SafeCapabilitySummary } from '@nessy-agent/shared/protocol/capabilities'
import type { BuiltinDpMcpSettingsViewV1 } from '../../../shared/types'
import type { ComponentEntry } from './types'

interface PanelKnobs {
  pluginServers: number
  userServers: number
  builtinDpServers: number
  builtinDpEnabled: number
  dpMissing: boolean
  needsAuth: boolean
  expired: boolean
  disabledServer: boolean
  filterToPlugin: boolean
}

const PLUGIN_KEY = 'bWs.dHJhY2tlcg'

function summary(partial: Partial<SafeCapabilitySummary> & Pick<SafeCapabilitySummary, 'key' | 'kind' | 'logicalName'>): SafeCapabilitySummary {
  return {
    origin: 'plugin',
    scope: { kind: 'workspace', workspaceId: 'ws-preview' },
    state: 'active',
    readOnly: true,
    trustState: 'trusted',
    credentialState: 'not-required',
    selectedAsUnqualifiedAlias: false,
    diagnosticCodes: [],
    ...partial,
  }
}

function buildCatalog(knobs: PanelKnobs): Pick<UserCapabilityCatalog, 'installedPlugins' | 'capabilities'> {
  const capabilities: SafeCapabilitySummary[] = []
  const components: NonNullable<UserCapabilityCatalog['installedPlugins'][number]['components']> = []
  for (let index = 0; index < Math.max(0, knobs.pluginServers); index += 1) {
    const name = `tracker-mcp-${index + 1}`
    const key = `plugin:${PLUGIN_KEY}#mcp.${name}`
    const disabled = knobs.disabledServer && index === 0
    const credentialState = knobs.needsAuth && index === 0
      ? 'missing' as const
      : knobs.expired && index === 1 ? 'expired' as const : 'ready' as const
    capabilities.push(summary({
      key, kind: 'mcp', logicalName: name, mcpTransport: index % 2 ? 'sse' : 'http',
      credentialState,
      state: disabled ? 'disabled' : 'active',
      description: 'Issues, boards and sprints from the tracker',
    }))
    components.push({
      kind: 'mcp', name, capabilityKey: key, capabilityId: `mcp.${name}`,
      enabled: !disabled,
    })
  }
  for (let index = 0; index < Math.max(0, knobs.userServers); index += 1) {
    const name = `my-server-${index + 1}`
    capabilities.push(summary({
      key: `source:workspace:ws-preview:${name}`, kind: 'source', logicalName: name,
      sourceType: 'mcp', origin: 'native', readOnly: false, mcpTransport: index % 2 ? 'stdio' : 'http',
      description: 'A server declared in this workspace\'s own .mcp.json',
    }))
  }
  return {
    capabilities,
    installedPlugins: [{
      pluginKey: PLUGIN_KEY,
      marketplaceId: 'internal',
      pluginId: 'tracker',
      version: '1.0.0',
      name: 'Tracker Toolkit',
      installedAt: 1,
      capabilityKinds: ['mcp'],
      diagnostics: [],
      activation: { global: 'unset', workspace: 'enabled' },
      components,
    } as unknown as UserCapabilityCatalog['installedPlugins'][number]],
  }
}

/** The A7 payload exactly as it arrives over RPC — a literal, never from dp. */
function buildBuiltinDp(knobs: PanelKnobs): BuiltinDpMcpSettingsViewV1 | null {
  const total = Math.max(0, knobs.builtinDpServers)
  if (total === 0) return null
  const names = ['dpGitlab', 'dpJira', 'dpMR', 'dpSage', 'dpWiki', 'dpAllure', 'dpFs', 'dpGit']
  return {
    available: !knobs.dpMissing,
    diagnostics: knobs.dpMissing
      ? [{
        code: 'builtin_dp_mcp.dp_not_found',
        // DA1.52 · verbatim from `packages/shared/src/mcp/builtin-dp-servers.ts`
        // symbol `materializeBuiltinDpMcpServers`, the only producer of this
        // diagnostic. A literal by design (see the comment above — the payload
        // arrives over RPC and this surface never runs dp), so it has to be
        // re-copied whenever that sentence changes; it promised the pre-DA1.6
        // two-place lookup for as long as the four-rung ladder had shipped.
        message: 'The built-in Nessy MCP servers need the `dp` CLI, which was not found in any of the four '
          + 'places Nessy looks: the path in NESSY_DP, the system `dp` (PATH, then /usr/local/bin/dp), '
          + '<CONFIG_DIR>/dp/bin/dp and <NESSY_HOME>/dp_latest/dp. Install Spirit CLI (`dp`), or point '
          + 'NESSY_DP at the copy you want, and reopen the workspace; nothing else in the app is affected.',
      }]
      : [],
    servers: Array.from({ length: total }, (_, index) => ({
      name: names[index % names.length] + (index >= names.length ? `-${Math.floor(index / names.length)}` : ''),
      subcommand: 'jira',
      description: 'Tool for working with Jira issues',
      defaultEnabled: false,
      enabled: index < Math.max(0, knobs.builtinDpEnabled),
    })),
  }
}

function PanelPreview(knobs: PanelKnobs) {
  return (
    <div className="w-[640px] rounded-lg border">
      <McpServersPanel
        catalog={buildCatalog(knobs)}
        builtinDp={buildBuiltinDp(knobs)}
        pluginKey={knobs.filterToPlugin ? PLUGIN_KEY : undefined}
        onToggleServer={() => {}}
        onToggleBuiltinDp={() => {}}
        onOpenServer={() => {}}
      />
    </div>
  )
}

const KNOBS: ComponentEntry['props'] = [
  { name: 'pluginServers', description: 'Plugin-owned servers (toggle rides capabilityId-scoped policy records)', control: { type: 'number', min: 0, max: 14 }, defaultValue: 3 },
  { name: 'userServers', description: 'User-created MCP sources listed in the SAME panel (ADR § 6)', control: { type: 'number', min: 0, max: 6 }, defaultValue: 2 },
  { name: 'builtinDpServers', description: 'Built-in dp servers (A7) as ordinary rows of the same list — 28 ship in the product', control: { type: 'number', min: 0, max: 28 }, defaultValue: 6 },
  { name: 'builtinDpEnabled', description: 'How many of those built-ins are switched ON (they all ship off)', control: { type: 'number', min: 0, max: 28 }, defaultValue: 1 },
  { name: 'dpMissing', description: 'dp is not installed: every built-in row says so and its switch still works', control: { type: 'boolean' }, defaultValue: false },
  { name: 'needsAuth', description: 'First plugin server has an EMPTY credential slot — the row says "Sign in required" bottom-right', control: { type: 'boolean' }, defaultValue: true },
  { name: 'expired', description: 'Second plugin server holds an expired token — the row says "Sign-in expired"', control: { type: 'boolean' }, defaultValue: false },
  { name: 'disabledServer', description: 'First plugin server disabled via its per-capability policy record', control: { type: 'boolean' }, defaultValue: false },
  { name: 'filterToPlugin', description: "The plugin detail page's view: SAME rows filtered by pluginKey", control: { type: 'boolean' }, defaultValue: false },
]

export const mcpServersPanelComponents: ComponentEntry[] = [
  {
    id: 'mcp-servers-panel',
    name: 'MCP Servers Panel',
    category: 'Sources',
    description:
      'C6 (ADR § 6): ONE panel for ALL MCP servers — plugin-owned, user-created and built-in dp together, on the SAME Sources card as the aggregate list, in the same slots (UB12.74, v0.15.1\'s row anatomy): status-bearing icon, name, the "MCP" meta at the end of the title line, the description on line 2, and NOTHING else (owner ruling 2026-08-01 — a row may carry an extra CONTROL, never an extra BADGE). Origin, transport and the dp-missing reason moved to the detail page the row opens. The row\'s only CONTROL is the per-server switch: Connect moved to the detail page too (owner report 2026-08-01), and what stays here is the STATEMENT — "Sign in required" / "Sign-in expired" on line 2 in place of the description, as the aggregate list prints a non-connected source; silent on a healthy server. A built-in is an ordinary row: same shape, same alphabetical order, its own write path. The plugin detail page is a filtered VIEW of these rows, never a second surface.',
    component: PanelPreview,
    layout: 'centered',
    props: KNOBS,
    variants: [
      { name: 'Mixed origins', description: 'Plugin, user and built-in servers in one list', props: { pluginServers: 3, userServers: 2, builtinDpServers: 6, builtinDpEnabled: 1, dpMissing: false, needsAuth: true, expired: false, disabledServer: false, filterToPlugin: false } },
      { name: 'Auth states', description: 'Empty slot ("Sign in required"), expired token ("Sign-in expired") — each on line 2 in place of the description — and a healthy row that reads its description', props: { pluginServers: 3, userServers: 0, builtinDpServers: 0, builtinDpEnabled: 0, dpMissing: false, needsAuth: true, expired: true, disabledServer: false, filterToPlugin: false } },
      { name: 'Per-server disable', description: 'One server off via its capability policy record', props: { pluginServers: 3, userServers: 1, builtinDpServers: 0, builtinDpEnabled: 0, dpMissing: false, needsAuth: false, expired: false, disabledServer: true, filterToPlugin: false } },
      { name: 'Built-in set, all off', description: 'The shipped default: 28 built-ins, none enabled, beside two real servers', props: { pluginServers: 1, userServers: 1, builtinDpServers: 28, builtinDpEnabled: 0, dpMissing: false, needsAuth: false, expired: false, disabledServer: false, filterToPlugin: false } },
      { name: 'Built-in set, no dp', description: 'dp is not installed: every built-in row says so, switches stay live', props: { pluginServers: 0, userServers: 1, builtinDpServers: 6, builtinDpEnabled: 2, dpMissing: true, needsAuth: false, expired: false, disabledServer: false, filterToPlugin: false } },
      { name: 'Plugin detail view', description: 'The SAME rows filtered to one plugin — never a built-in', props: { pluginServers: 3, userServers: 2, builtinDpServers: 6, builtinDpEnabled: 1, dpMissing: false, needsAuth: true, expired: false, disabledServer: false, filterToPlugin: true } },
      { name: 'Empty', description: 'No MCP servers anywhere', props: { pluginServers: 0, userServers: 0, builtinDpServers: 0, builtinDpEnabled: 0, dpMissing: false, needsAuth: false, expired: false, disabledServer: false, filterToPlugin: false } },
    ],
  },
]
