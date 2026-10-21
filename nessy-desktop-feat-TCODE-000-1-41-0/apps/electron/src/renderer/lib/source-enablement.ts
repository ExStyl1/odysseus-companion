/**
 * Enable/Disable for one Sources row — WHICH write path, and WHICH single
 * action (owner decision 2026-08-01: "one button, following the current
 * status", "and in the item's details too", "for the elements that have this
 * option").
 *
 * Two kinds carry the option, and they are two DIFFERENT writes that must stay
 * separate all the way down to the click:
 *
 * - a plugin-origin row flips its plugin's activation
 *   (`plugin.manage` enable/disable → a capability policy record), and
 * - a built-in dp MCP row writes the user preference
 *   (`setBuiltinDpMcpServerEnabled` → `config.json`'s `builtinDpMcpServers`).
 *
 * A built-in has no policy record and a plugin server has no built-in
 * preference, so folding the two would write the wrong file — the same
 * separation `McpServersPanel`'s switch already keeps, stated here once for the
 * menu and the detail page (owner decision, do not unify). The discriminated
 * union is what enforces it: a `builtin` value structurally cannot reach the
 * plugin callback, and vice versa.
 *
 * Everything here is PURE. `SourceMenu` and the detail page both import
 * `menu-context` / `styled-dropdown`, whose `@nessy-agent/ui` barrel the bun
 * runner cannot load (the pdfjs-dist family), so a rendered assertion about the
 * menu is not available. Keeping the DECISION out of the component is what
 * makes "exactly one action, labelled by the current state, on these kinds and
 * no others" testable at all.
 */

import type { BuiltinDpMcpSettingsViewV1 } from '../../shared/types'
import { sourceTypeFor, type SafeSourceRow } from './capability-catalog'

export type SourceEnablementScope = 'workspace' | 'project'

/**
 * A row's enablement affordance, or nothing. Absent for every kind with no
 * enable option — a native `.mcp.json` server, an API source, a local folder —
 * so those rows never grow a dead menu item.
 */
export type SourceEnablement =
  | {
      kind: 'plugin'
      pluginKey: string
      workspaceEnabled: boolean
      projectEnabled: boolean
      /** Whether the active-project scope can be offered at all. */
      hasProjectContext: boolean
      onToggle: (scope: SourceEnablementScope, next: boolean) => void
    }
  | {
      kind: 'builtin'
      /** The dp WIRE name — the preference key, never the display name. */
      name: string
      enabled: boolean
      onToggle: (next: boolean) => void
    }

/** One menu / detail-page action. Its label and its effect follow `enabled`. */
export interface SourceEnablementAction {
  id: 'workspace' | 'project' | 'builtin'
  /** i18n key; already chosen from the CURRENT state. */
  labelKey: string
  /** Current state — the label came from it, and the icon follows it. */
  enabled: boolean
  /** The write, already bound to this row's own path. */
  run: () => void
}

/**
 * Resolve a row's enablement, or `undefined` for a display-only row.
 *
 * The built-in arm reads `logicalName` and not the display name, for the same
 * reason `buildMcpServerRows` derives `builtinDpName` that way: the preference
 * is keyed by the wire name. Its `enabled` prefers the RPC view over the
 * capability's own state because that view is the half that moves immediately —
 * nothing publishes a capability-changed event for this write
 * (`handlers/rpc/settings.ts`'s `builtinDpMcp:setEnabled`), so a menu label
 * taken from the catalog alone would still say "Disable" right after a disable.
 */
export function sourceEnablementFor(source: SafeSourceRow, input: {
  activationByPluginKey: ReadonlyMap<string, { workspace: boolean; project: boolean }>
  hasProjectContext: boolean
  builtinDp?: BuiltinDpMcpSettingsViewV1 | null
  onTogglePlugin: (pluginKey: string, scope: SourceEnablementScope, next: boolean) => void
  onToggleBuiltin: (name: string, next: boolean) => void
}): SourceEnablement | undefined {
  if (source.origin === 'builtin' && sourceTypeFor(source) === 'mcp') {
    const name = source.logicalName
    const live = input.builtinDp?.servers.find(server => server.name === name)
    return {
      kind: 'builtin',
      name,
      enabled: live?.enabled ?? source.state === 'active',
      onToggle: (next) => input.onToggleBuiltin(name, next),
    }
  }
  // A source is plugin-managed only through its connector's pluginKey — the
  // sole existing enablement mutation for source rows. No native-source toggle
  // exists, and inventing one here would be new policy machinery.
  const pluginKey = source.connectorOrigin?.pluginKey
  if (source.origin === 'plugin' && pluginKey) {
    const activation = input.activationByPluginKey.get(pluginKey)
    return {
      kind: 'plugin',
      pluginKey,
      workspaceEnabled: activation?.workspace ?? false,
      projectEnabled: activation?.project ?? false,
      hasProjectContext: input.hasProjectContext,
      onToggle: (scope, next) => input.onTogglePlugin(pluginKey, scope, next),
    }
  }
  return undefined
}

/**
 * The Enable/Disable actions for one row: never an Enable item beside a Disable
 * item, always ONE per scope that exists, and empty for a row with no option.
 *
 * A built-in has exactly one scope (the preference is global to the app), so it
 * yields exactly one action. A plugin row yields one for the workspace scope
 * and — only with a project context — one for the active project; the two
 * scopes are different states and the 2026-07-19 owner decision offers both.
 * Each is still a single action whose label follows its own state.
 */
export function sourceEnablementActions(
  enablement: SourceEnablement | undefined,
): SourceEnablementAction[] {
  if (!enablement) return []
  if (enablement.kind === 'builtin') {
    return [{
      id: 'builtin',
      labelKey: enablement.enabled ? 'sourcesManagement.disable' : 'sourcesManagement.enable',
      enabled: enablement.enabled,
      run: () => enablement.onToggle(!enablement.enabled),
    }]
  }
  const actions: SourceEnablementAction[] = [{
    id: 'workspace',
    labelKey: enablement.workspaceEnabled
      ? 'sourcesManagement.disableInWorkspace'
      : 'sourcesManagement.enableInWorkspace',
    enabled: enablement.workspaceEnabled,
    run: () => enablement.onToggle('workspace', !enablement.workspaceEnabled),
  }]
  if (enablement.hasProjectContext) {
    actions.push({
      id: 'project',
      labelKey: enablement.projectEnabled
        ? 'sourcesManagement.disableInProject'
        : 'sourcesManagement.enableInProject',
      enabled: enablement.projectEnabled,
      run: () => enablement.onToggle('project', !enablement.projectEnabled),
    })
  }
  return actions
}
