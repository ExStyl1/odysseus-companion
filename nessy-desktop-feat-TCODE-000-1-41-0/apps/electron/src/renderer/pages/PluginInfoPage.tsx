/**
 * PluginInfoPage (U4)
 *
 * Installed-plugin detail, reached from the Sources > Plugins subsection rows.
 * Reuses the universal CapabilityDetailTemplate (the plugin variant) with the
 * plugin's FULL component inventory rendered via PluginComponentsSection.
 *
 * Data path is ADDITIVE + IPC-reuse only: the installed-plugin summary (incl.
 * the new path-free `components` inventory) comes from the existing safe
 * catalog (`capabilityCatalog.installedPlugins`) — no new RPC. Component rows
 * for skills / sources / connectors are clickable through to their own detail
 * pages via the capability key already in the payload. Toggleable kinds carry
 * a per-component switch bound to the `set-capability-enabled` management
 * action at the workspace scope, reflecting the RESOLVED enablement.
 *
 * UB14.59 — v0.15.1's detail-page anatomy (`pages/SourceInfoPage.tsx`,
 * `AutomationInfoPage.tsx`): the plugin's "⋯" menu is the header's
 * `Info_HeaderMenu` (the name lives in the hero only), the update badges are the
 * hero's actions, and the authentication, configuration and MCP-servers blocks
 * are `Info_Section` cards like every other section on the page.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Package } from 'lucide-react'
import {
  CapabilityDetailTemplate,
  Info_HeaderMenu,
  Info_Section,
  PluginComponentsSection,
  type CapabilityMetadataField,
  type PluginComponentGroup,
} from '@/components/info'
import { toGroups } from './plugin-components-groups'
import { pluginDetailDiagnostics, pluginShippedNoUsableComponents } from './plugin-detail-diagnostics'
import { PluginUpdateBadge, PluginUpdateStalledBadge } from './plugin-update-affordance'
import { PluginRowMenu } from '@/components/app-shell/PluginRowMenu'
import { Button } from '@/components/ui/button'
import {
  PluginConfigurationFields,
  pluginConfigurationValues,
  type PluginConfigurationDraft,
} from '@/components/plugins/PluginConfigurationFields'
import { usePluginEnablement } from '@/hooks/usePluginEnablement'
import { McpServersPanel } from '@/components/app-shell/McpServersPanel'
import { useAppShellContext } from '@/context/AppShellContext'
import { navigate, routes } from '@/lib/navigate'
import { capabilityRouteId } from '@/lib/capability-catalog'
import { sourceListSkillId } from '@/lib/source-list-ids'
import { isPlaceholderPluginVersion } from '@nessy-agent/shared/plugins/types'
import type {
  SafeCapabilityDetail,
  SafeCapabilityDiagnostic,
  SafeCapabilityKind,
  SafeInstalledPluginSummary,
  SafePluginConfigurationStatus,
} from '@nessy-agent/shared/protocol/capabilities'

interface PluginInfoPageProps {
  pluginKey: string
  workspaceId: string
}

/** Path-free display metadata rows for the plugin. */
function buildMetadata(
  plugin: SafeInstalledPluginSummary,
  diagnostics: readonly SafeCapabilityDiagnostic[],
  t: (key: string, options?: Record<string, unknown>) => string,
): CapabilityMetadataField[] {
  // sev-3: a bundle whose every declared component was refused used to read a
  // bare "Active", which is true of the activation policy and false of what the
  // user gets. The activation word stays — it is still the accurate answer to
  // "is this plugin turned on" — qualified by what it delivered.
  const activation = t(`pluginDetail.activation.${plugin.activation.effective}`)
  const fields: CapabilityMetadataField[] = [
    // Q10-4: the placeholder a bundle gets when its manifest declares no
    // `version` — Claude's `plugin.json` requires only `name`, so `playwright`
    // and friends genuinely ship without one. Printing it told the user the
    // author released 0.0.0. Omitting the row is what this surface already does
    // for every other absent field (the Capabilities row below, and the
    // `if (detailItem.version)` guard on the marketplace detail panel in
    // `PluginsPage`), so there is no new idiom and no new string.
    //
    // P6.577 — there are now TWO placeholders and this row must omit both:
    // `plugins/loading.md#how-claude-code-computes-the-version` step 5 spells the floor
    // `unknown`, which the install path applies when no step of the chain
    // answers, while `0.0.0` remains what the format adapter writes before the
    // chain runs. `isPlaceholderPluginVersion` is the one predicate that knows
    // both, so a third spelling cannot leak past this row unnoticed.
    ...(plugin.version && !isPlaceholderPluginVersion(plugin.version)
      ? [{ label: t('pluginDetail.metaVersion'), value: plugin.version }]
      : []),
    {
      label: t('pluginDetail.metaState'),
      value: pluginShippedNoUsableComponents(plugin, diagnostics)
        ? t('pluginDetail.metaStateNoComponents', { state: activation })
        : activation,
    },
  ]
  if (plugin.capabilityKinds.length > 0) {
    fields.push({ label: t('pluginDetail.metaCapabilities'), value: plugin.capabilityKinds.join(', ') })
  }
  return fields
}

export default function PluginInfoPage({ pluginKey, workspaceId }: PluginInfoPageProps) {
  const { t } = useTranslation()
  const { capabilityCatalog, refreshPluginState } = useAppShellContext()
  const enablement = usePluginEnablement()
  const [configuration, setConfiguration] = React.useState<SafePluginConfigurationStatus | null>(null)
  const [configurationDraft, setConfigurationDraft] = React.useState<PluginConfigurationDraft>({})
  const [configurationError, setConfigurationError] = React.useState<string | null>(null)
  const [configurationPending, setConfigurationPending] = React.useState(false)

  const loadConfiguration = React.useCallback(async () => {
    setConfigurationError(null)
    try {
      const result = await window.electronAPI.plugin.manage({
        pluginKey,
        action: 'configuration-status',
        workspaceId,
      })
      setConfiguration(result.configuration ?? null)
    } catch (cause) {
      setConfigurationError(cause instanceof Error ? cause.message : t('pluginDetail.configurationError'))
    }
  }, [pluginKey, t, workspaceId])

  React.useEffect(() => {
    setConfiguration(null)
    setConfigurationDraft({})
    void loadConfiguration()
  }, [loadConfiguration])

  const saveConfiguration = React.useCallback(async () => {
    if (!configuration) return
    const values = pluginConfigurationValues(configuration.fields, configurationDraft)
    setConfigurationPending(true)
    setConfigurationError(null)
    try {
      const result = await window.electronAPI.plugin.manage({
        pluginKey,
        action: 'configure',
        workspaceId,
        values,
      })
      setConfiguration(result.configuration ?? null)
      setConfigurationDraft({})
      await refreshPluginState?.()
    } catch (cause) {
      setConfigurationError(cause instanceof Error ? cause.message : t('pluginDetail.configurationError'))
    } finally {
      setConfigurationPending(false)
    }
  }, [configuration, configurationDraft, pluginKey, refreshPluginState, t, workspaceId])

  const clearConfiguration = React.useCallback(async () => {
    if (!window.confirm(t('pluginDetail.configurationClearConfirm'))) return
    setConfigurationPending(true)
    setConfigurationError(null)
    try {
      const result = await window.electronAPI.plugin.manage({
        pluginKey,
        action: 'clear-configuration',
        workspaceId,
      })
      setConfiguration(result.configuration ?? null)
      setConfigurationDraft({})
      await refreshPluginState?.()
    } catch (cause) {
      setConfigurationError(cause instanceof Error ? cause.message : t('pluginDetail.configurationError'))
    } finally {
      setConfigurationPending(false)
    }
  }, [pluginKey, refreshPluginState, t, workspaceId])

  const plugin = React.useMemo(
    () => capabilityCatalog?.installedPlugins.find(p => p.pluginKey === pluginKey),
    [capabilityCatalog, pluginKey],
  )

  // `undefined` catalog = still loading; loaded-but-missing = not installed.
  const loading = capabilityCatalog === undefined
  const error = !loading && !plugin ? t('pluginDetail.notInstalled') : undefined

  const components = React.useMemo(() => plugin?.components ?? [], [plugin])

  // C6 (ADR § 6): MCP servers render through the UNIFIED panel filtered to
  // this plugin — a view of the same rows the workspace-wide panel lists, not
  // a second surface — so they leave the generic components section.
  const nonMcpComponents = React.useMemo(
    () => components.filter(component => component.kind !== 'mcp'),
    [components],
  )
  const hasMcpServers = components.length !== nonMcpComponents.length

  const groups = React.useMemo<PluginComponentGroup[] | undefined>(
    () => (plugin
      ? toGroups(nonMcpComponents, { pendingCapabilityId: enablement.pendingCapabilityId })
      : undefined),
    [nonMcpComponents, plugin, enablement.pendingCapabilityId],
  )

  // capabilityKey → kind, so a clickable component row routes to the correct
  // detail page (skills open through the source-list skill id; sources/mcp/
  // connectors open the source detail).
  const kindByKey = React.useMemo(() => {
    const map = new Map<string, SafeCapabilityKind>()
    for (const component of components) {
      if (component.capabilityKey) map.set(component.capabilityKey, component.kind)
    }
    return map
  }, [components])

  const openComponent = React.useCallback((capabilityKey: string) => {
    const kind = kindByKey.get(capabilityKey)
    if (kind === 'skill') {
      navigate(routes.view.sources({ sourceSlug: sourceListSkillId(capabilityKey) }))
      return
    }
    navigate(routes.view.sources({ sourceSlug: capabilityRouteId(capabilityKey) }))
  }, [kindByKey])

  // sev-3: the adapter's refusals, read off the persisted compatibility report
  // (the only path-free record of them that crosses the safe boundary).
  const diagnostics = React.useMemo(
    () => (plugin ? pluginDetailDiagnostics(plugin) : []),
    [plugin],
  )

  const metadata = React.useMemo(
    () => (plugin ? buildMetadata(plugin, diagnostics, t) : []),
    [diagnostics, plugin, t],
  )

  const summary: SafeCapabilityDetail['summary'] = plugin
    ? {
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
    : EMPTY_SUMMARY

  const actions = plugin ? (
    <>
      {/* R83 — this page is where BOTH new indicators lead (the browse strip's
          dot and the Sources row's note), so it is where the sentence has to
          survive the click. Full badge here: a detail hero has the width the
          32 px tile does not. */}
      <PluginUpdateBadge
        installed={plugin}
        formatLabel={version => t('plugins.updateAvailable', { version })}
      />
      <PluginUpdateStalledBadge
        installed={plugin}
        formatLabel={() => t('plugins.updateVersionUncomparable')}
      />
    </>
  ) : undefined

  // UB14.59 — the header's "⋯" (v0.15.1 `Info_HeaderMenu`): the same row menu, a named trigger.
  const headerActions = plugin ? (
    <Info_HeaderMenu label={t('sourcesManagement.actions')}>
      <PluginRowMenu
        workspaceEnabled={plugin.activation.workspace === 'enabled'}
        projectEnabled={plugin.activation.project === 'enabled'}
        hasProjectContext={enablement.hasProjectContext}
        onToggle={(scope, next) => void enablement.setEnabled(plugin.pluginKey, scope, next)}
        onUninstall={() => {
          void enablement.uninstall(plugin.pluginKey, plugin.name).then((ok) => {
            // The detail page's subject is gone — return to the list.
            if (ok) navigate(routes.view.sources())
          })
        }}
      />
    </Info_HeaderMenu>
  ) : undefined

  return (
    <>
    {/* `plugins/components.md#when-the-configuration-dialog-appears` — an enable from this page's actions menu
        raises the same prompt every other enable path does. */}
    {enablement.configurationPrompt}
    <CapabilityDetailTemplate
      loading={loading}
      error={error}
      summary={summary}
      displayName={plugin?.name ?? pluginKey}
      avatar={
        <div className="grid size-full place-items-center bg-fill-hover">
          <Package className="size-5 text-secondary" aria-hidden />
        </div>
      }
      actions={actions}
      headerActions={headerActions}
      content={{ status: 'empty' }}
      metadata={metadata}
      diagnostics={diagnostics}
      kindSections={
        plugin ? (
          <>
            {(plugin.authRequirements?.length ?? 0) > 0 && (
              // INFORMATIONAL ONLY (owner decision 2026-08-01). The sign-in
              // itself lives on the server's own row in the MCP section below,
              // which states the problem ("Sign in required") beside the
              // control that solves it. A Connect button here as well was the
              // same action twice on one page, ten lines apart.
              //
              // The text stays because it says what no row can: WHICH KIND of
              // credential a server needs (OAuth vs API token vs environment —
              // a row only knows that one is missing), and the
              // `unsupported-app` requirement, which names apps rather than
              // servers and therefore has no row at all.
              <Info_Section title={t('pluginDetail.authenticationTitle')}>
                <div className="space-y-3 px-3.5 py-3">
                  {plugin.authRequirements!.map((requirement, index) => (
                    <div key={`${requirement.kind}:${index}`}>
                      <p className="text-label text-foreground">{t(`pluginDetail.authentication.${requirement.kind}`)}</p>
                      {requirement.kind === 'unsupported-app' ? (
                        <p className="text-label-sm text-tertiary">{requirement.appIds.join(', ')}</p>
                      ) : (
                        <div className="text-label-sm text-tertiary">
                          {requirement.serverNames.map(serverName => (
                            <div
                              key={serverName}
                              className="py-0.5"
                              data-testid={`plugin-auth-server-${serverName}`}
                            >
                              <span className="min-w-0 truncate">{serverName}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </Info_Section>
            )}
            {configuration && configuration.fields.length > 0 && (
              <Info_Section
                title={t('pluginDetail.configurationTitle')}
                description={configuration.state === 'needs_configuration'
                  ? t('pluginDetail.configurationRequired')
                  : t('pluginDetail.configurationReady')}
              >
                <div className="space-y-4 px-3.5 py-3.5">
                  <PluginConfigurationFields
                    fields={configuration.fields}
                    draft={configurationDraft}
                    onDraftChange={setConfigurationDraft}
                  />
                  {configurationError && <p className="text-label text-destructive">{configurationError}</p>}
                  <div className="flex gap-2">
                    <Button variant="primary" onClick={() => void saveConfiguration()} disabled={configurationPending}>
                      {t('pluginDetail.configurationSave')}
                    </Button>
                    {configuration.fields.some(field => field.configured) && (
                      <Button variant="secondary" onClick={() => void clearConfiguration()} disabled={configurationPending}>
                        {t('pluginDetail.configurationClear')}
                      </Button>
                    )}
                  </div>
                </div>
              </Info_Section>
            )}
            {configurationError && !configuration && <p className="text-label text-destructive">{configurationError}</p>}
            {hasMcpServers && (
              <Info_Section
                title={t('mcpServers.pluginSectionTitle')}
                description={t('mcpServers.pluginSectionDescription')}
              >
                <McpServersPanel
                  catalog={capabilityCatalog}
                  pluginKey={plugin.pluginKey}
                  pendingCapabilityId={enablement.pendingCapabilityId}
                  onToggleServer={(target, next) =>
                    void enablement.setCapabilityEnabled(target.pluginKey, target.capabilityId, next)}
                  onOpenServer={openComponent}
                />
              </Info_Section>
            )}
            <PluginComponentsSection
              groups={groups}
              onOpen={openComponent}
              onToggle={(capabilityId, next) =>
                void enablement.setCapabilityEnabled(plugin.pluginKey, capabilityId, next)}
            />
          </>
        ) : undefined
      }
    />
    </>
  )
}

const EMPTY_SUMMARY = {} as SafeCapabilityDetail['summary']
