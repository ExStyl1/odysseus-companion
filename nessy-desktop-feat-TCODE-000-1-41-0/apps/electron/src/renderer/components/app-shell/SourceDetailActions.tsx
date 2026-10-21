/**
 * The source detail page's actions slot (owner decision 2026-08-01: the same
 * single Enable/Disable the row's "…" menu offers, "and in the item's details
 * too").
 *
 * It is deliberately the SAME two functions the row menu uses —
 * `sourceEnablementFor` decides which write path this row takes, and
 * `sourceEnablementActions` decides how many actions there are and what each is
 * labelled — rendered through the SAME `SourceEnablementMenuItems` component.
 * A row and its detail page cannot disagree about what a source can do, because
 * neither one decides it.
 *
 * Renders NOTHING for a source with no enablement option, so the detail page of
 * a native `.mcp.json` server, an API source or a local folder grows no dead
 * "…" button. That is the `null` return below, and it is load-bearing: the slot
 * is only mounted when there is an action in it.
 *
 * It also carries CONNECT, for the one case that has no enablement action at
 * all (owner report 2026-08-01: "the Connect button is on the plugin's page but
 * not in the details of the MCP server that needs authorising"). The MCP list
 * row used to own it; the row now only STATES that sign-in is required, and
 * this is the page it points at. The button and its target are the SAME two
 * exports the plugin page's authentication section uses
 * (`PluginServerConnectButton` / `capabilityConnectTarget`) — a third Connect
 * is exactly what the list-row version already proved goes stale.
 *
 * The two halves are independently optional: a plugin MCP server awaiting
 * OAuth shows Connect with no menu, an enableable source shows the menu with no
 * Connect, and a source with neither still renders nothing.
 *
 * Connected on purpose (the row menus are too): the catalog, the built-in dp
 * view and the plugin mutations all come from the app shell, and this is the
 * one place the detail page needs them.
 *
 * UB14.59 — the two halves now sit where v0.15.1's detail pages put them: the
 * menu is the page HEADER's "⋯" (`Info_HeaderMenu`, v0.15.1 `pages/SourceInfoPage.tsx`
 * — the name lives in the hero, so the menu no longer hangs off a title), and
 * Connect is a hero action beside the name. Each half is its own component and
 * each still renders nothing when it has nothing to offer, so the header grows
 * no dead "⋯" and the hero no empty button. They share no state: the menu's
 * enable path owns the configuration prompt it raises (`usePluginEnablement`),
 * and Connect reads only the catalog.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Info_HeaderMenu } from '@/components/info/Info_HeaderMenu'
import { useAppShellContext } from '@/context/AppShellContext'
import { usePluginEnablement } from '@/hooks/usePluginEnablement'
import { sourceEnablementActions, sourceEnablementFor } from '@/lib/source-enablement'
import { SourceEnablementMenuItems } from './SourceMenu'
import { capabilityConnectTarget, PluginServerConnectButton } from './McpServersPanel'
import type { SafeSourceRow } from '@/lib/capability-catalog'

/** The header's "⋯": the source's Enable/Disable actions, or nothing when it has none. */
export function SourceDetailMenu({ source }: { source: SafeSourceRow }) {
  const { t } = useTranslation()
  const { capabilityCatalog, builtinDpMcp } = useAppShellContext()
  const pluginEnablement = usePluginEnablement()

  const activationByPluginKey = React.useMemo(() => {
    const map = new Map<string, { workspace: boolean; project: boolean }>()
    for (const plugin of capabilityCatalog?.installedPlugins ?? []) {
      map.set(plugin.pluginKey, {
        workspace: plugin.activation.workspace === 'enabled',
        project: plugin.activation.project === 'enabled',
      })
    }
    return map
  }, [capabilityCatalog])

  const enablement = sourceEnablementFor(source, {
    activationByPluginKey,
    hasProjectContext: pluginEnablement.hasProjectContext,
    builtinDp: builtinDpMcp?.view ?? null,
    onTogglePlugin: (pluginKey, scope, next) => void pluginEnablement.setEnabled(pluginKey, scope, next),
    onToggleBuiltin: (name, next) => builtinDpMcp?.toggle(name, next),
  })

  if (sourceEnablementActions(enablement).length === 0) return null

  return (
    <>
      {/* `plugins/components.md#when-the-configuration-dialog-appears` — an enable from this page raises the same
          prompt every other enable path does, and it is raised by the hook that
          performed the enable so it cannot be wired to a different request. */}
      {pluginEnablement.configurationPrompt}
      <Info_HeaderMenu label={t('sourcesManagement.actions')}>
        <SourceEnablementMenuItems enablement={enablement} />
      </Info_HeaderMenu>
    </>
  )
}

/** The hero's Connect, for the one case with no enablement action (a plugin MCP server awaiting sign-in). */
export function SourceDetailConnect({ source }: { source: SafeSourceRow }) {
  const { capabilityCatalog } = useAppShellContext()

  // Addressed by capability key, because that is all a detail page has. The
  // join and the who-can-be-signed-in-here rule both stay in McpServersPanel.
  const connectTarget = React.useMemo(
    () => capabilityConnectTarget(source.key, capabilityCatalog),
    [capabilityCatalog, source.key],
  )
  if (!connectTarget) return null

  return (
    <PluginServerConnectButton
      target={connectTarget}
      testId={`source-detail-connect-${source.logicalName}`}
    />
  )
}
