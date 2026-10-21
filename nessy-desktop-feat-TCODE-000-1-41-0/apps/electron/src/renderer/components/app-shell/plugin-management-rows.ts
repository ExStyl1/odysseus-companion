/**
 * Pure projection for the Plugins subsection rows (U4).
 *
 * Extracted from PluginsManagementPanel so the mapping (installed plugin →
 * management-row display state) is testable WITHOUT the info barrel (pdfjs) or
 * React. The panel composes these fields with the row callbacks/menu.
 */

import type {
  SafeCapabilitySummary,
  SafeInstalledPluginSummary,
} from '@nessy-agent/shared/protocol/capabilities'
// R83 — the update decision is R81/R82's, and it lives in ONE place. This
// module imports it rather than reading `availableUpdateVersion` itself, so a
// later change to what the field means cannot leave this surface behind.
import { pluginUpdateVersion } from '@/pages/plugin-update-affordance'

export interface PluginRowProjection {
  /** Stable row id / the pluginKey the toggle acts on. */
  id: string
  /** Path-free summary driving the avatar / name / origin badge. */
  summary: SafeCapabilitySummary
  displayName: string
  /** Effective enabled state (drives the row dim). */
  enabled: boolean
  /** Per-scope activation for the row menu labels. */
  workspaceEnabled: boolean
  projectEnabled: boolean
  /**
   * R83 — the version the WIRE advertises as available, when it advertises one.
   * Straight off `pluginUpdateVersion`, never re-derived: R81 withholds the
   * field server-side for a dependency-held plugin, and deriving it here would
   * put back the indicator that withholding exists to suppress.
   */
  availableUpdateVersion?: string
}

/**
 * Synthesize the path-free summary a SourcesManagementRow needs from an
 * installed-plugin summary. A plugin is `origin: 'plugin'`, `kind: 'app'` (the
 * umbrella kind for a plugin package) and reuses its presentation badge.
 */
export function pluginRowSummary(plugin: SafeInstalledPluginSummary): SafeCapabilitySummary {
  return {
    key: `plugin:${plugin.pluginKey}`,
    kind: 'app',
    logicalName: plugin.name,
    displayName: plugin.name,
    origin: 'plugin',
    ...(plugin.presentation ? { presentation: plugin.presentation } : {}),
    scope: { kind: 'workspace' },
    state: plugin.activation.effective === 'active' ? 'active' : 'disabled',
    readOnly: false,
    trustState: 'not-required',
    credentialState: 'not-required',
    selectedAsUnqualifiedAlias: false,
    diagnosticCodes: [],
  }
}

/** Project one installed plugin into its management-row display state. */
export function pluginRowProjection(plugin: SafeInstalledPluginSummary): PluginRowProjection {
  const availableUpdateVersion = pluginUpdateVersion(plugin)
  return {
    id: plugin.pluginKey,
    summary: pluginRowSummary(plugin),
    displayName: plugin.name,
    enabled: plugin.activation.effective === 'active',
    workspaceEnabled: plugin.activation.workspace === 'enabled',
    projectEnabled: plugin.activation.project === 'enabled',
    ...(availableUpdateVersion ? { availableUpdateVersion } : {}),
  }
}

/** Project every installed plugin (empty in → empty out → the empty-state). */
export function buildPluginRowProjections(
  installed: readonly SafeInstalledPluginSummary[],
): PluginRowProjection[] {
  return installed.map(pluginRowProjection)
}
