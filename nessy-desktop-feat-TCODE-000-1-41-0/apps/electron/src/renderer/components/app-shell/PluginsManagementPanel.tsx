/**
 * PluginsManagementPanel (U4)
 *
 * The `sources/plugins` subsection body: INSTALLED plugins rendered as
 * SourcesManagementRow rows (the management-panel identity, R2). Data comes
 * from the existing safe catalog (`capabilityCatalog.installedPlugins` —
 * SafeInstalledPluginSummary, the same list the marketplace maps against); no
 * new IPC. Enablement reuses the EXISTING plugin enable/disable mutations via
 * usePluginEnablement — the SAME state the marketplace actions menu flips.
 *
 * Row click → the plugin detail page (the universal detail template's plugin
 * variant), routed as `sources/plugins/plugin/<key>`.
 */

import * as React from 'react'
import { navigate, routes } from '@/lib/navigate'
import {
  SourcesManagementRowList,
  type SourcesManagementRowEntry,
} from '@/components/info'
import { PluginRowMenu } from './PluginRowMenu'
import { buildPluginRowProjections } from './plugin-management-rows'
import { usePluginEnablement } from '@/hooks/usePluginEnablement'
import { useAppShellContext } from '@/context/AppShellContext'

export interface PluginsManagementPanelProps {
  className?: string
  /**
   * The pluginKey whose detail page is open, so its row highlights like the
   * open row of every sibling list (owner report 2026-08-01: it did not). Read
   * from the route by the owner (AppShell) — the SAME place and shape
   * `SourcesListPanel`'s `selectedSourceSlug` comes from, since
   * `sources/plugins/plugin/<key>` parses to `details.pluginKey` just as the
   * source route parses to `details.sourceSlug`.
   */
  selectedPluginKey?: string | null
  /**
   * P6.773 / P6.778 — the workspace's "Enable stdio subprocess servers"
   * setting, handed to each row so `SourceAvatar` can draw the `local_disabled`
   * pip instead of the untested dot.
   *
   * INERT ON TODAY'S ROWS, deliberately and said out loud: this panel's rows
   * come from `pluginRowSummary` (`kind: 'app'`, no `mcpTransport`), and that
   * verdict only fires for a stdio MCP source — so nothing here changes until a
   * management panel renders `mcp-native` rows. It is wired anyway because the
   * alternative is a row shape whose setting has no path from the shell, which
   * is exactly how P6.769 and P6.773 each found a value dropped on the way.
   *
   * A PROP and not a read: `SourcesManagementRow` is IPC-free by contract, and
   * `AppShell` already holds this state for `SourcesListPanel`. Defaults to
   * `true` for the same reason the row does — a caller that does not know the
   * setting keeps the verdict it had.
   */
  localMcpEnabled?: boolean
}

export function PluginsManagementPanel({ className, selectedPluginKey, localMcpEnabled = true }: PluginsManagementPanelProps) {
  const { capabilityCatalog } = useAppShellContext()
  const enablement = usePluginEnablement()

  const installed = React.useMemo(
    () => capabilityCatalog?.installedPlugins ?? [],
    [capabilityCatalog],
  )

  const rows = React.useMemo<SourcesManagementRowEntry[]>(() => {
    return buildPluginRowProjections(installed).map((projection) => {
      const error = enablement.errorFor(projection.id)
      return {
        id: projection.id,
        summary: projection.summary,
        displayName: projection.displayName,
        enablement: {
          enabled: projection.enabled,
          scope: 'workspace' as const,
          pending: enablement.isPending,
          ...(error ? { error } : {}),
        },
        // R83 — a user who never opens the marketplace detail page passes
        // through HERE. The row says an update exists; the row itself stays a
        // management row, so the verb list `plugins/install.md#manage-installed-plugins` names is
        // unchanged.
        ...(projection.availableUpdateVersion
          ? { updateAvailableVersion: projection.availableUpdateVersion }
          : {}),
        onClick: () => navigate(routes.view.sourcesPlugins(projection.id)),
        localMcpEnabled,
        menu: (
          <PluginRowMenu
            workspaceEnabled={projection.workspaceEnabled}
            projectEnabled={projection.projectEnabled}
            hasProjectContext={enablement.hasProjectContext}
            onToggle={(scope, next) => void enablement.setEnabled(projection.id, scope, next)}
            onOpenDetails={() => navigate(routes.view.sourcesPlugins(projection.id))}
            onUninstall={() => void enablement.uninstall(projection.id, projection.displayName)}
          />
        ),
      }
    })
  }, [enablement, installed, localMcpEnabled])

  return (
    <div className={className}>
      {/* No title/blurb (owner report 2026-08-01): every other Sources
          subsection is a bare row column, and the "Plugins" heading plus
          "Installed plugins and their components." above these rows was half of
          what made this subsection read as a different screen. The nav item
          that got here already names it. */}
      <SourcesManagementRowList rows={rows} selectedId={selectedPluginKey} />
      {/* `plugins/components.md#when-the-configuration-dialog-appears` — the enable-time prompt, raised by the same
          hook that performed the enable so it can never be wired to a different
          request than the one just sent. */}
      {enablement.configurationPrompt}
    </div>
  )
}
