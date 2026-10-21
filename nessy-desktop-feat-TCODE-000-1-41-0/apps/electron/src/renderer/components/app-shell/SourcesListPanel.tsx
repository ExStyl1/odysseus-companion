/* UB14.57 (R2-13): v0.15.1 `SourcesListPanel.tsx`'s row anatomy re-applied on our capability-catalog rows — the
   category as the title meta, line 2 the description or a non-connected state in its status colour with the stored
   connection error as its tooltip (both through the ONE card's `sourceCardSlots`), and the empty state's Add Source
   on `<Button variant="secondary">`. Kept ours: the P6.769 status pip (`showStatus localMcpEnabled`), the skill rows
   and the D3 project-provides block, U4 plugin enablement, and the P2.439/catalog-only reveal gate.
   UB12.113: a source row's Show in file manager is `useCapabilityReveal()` through `revealItemProps` — the ONE
   reveal and gate the Skills list and the skill page share — read here, no longer an `onOpenResource` prop from
   `AppShell`, whose copy of the reveal body is gone. */
import * as React from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from 'react-i18next'
import { DatabaseZap } from 'lucide-react'
import { SourceAvatar } from '@/components/ui/source-avatar'
import { SkillAvatar } from '@/components/ui/skill-avatar'
import { EntityPanel } from '@/components/ui/entity-panel'
import { EntityListEmptyScreen } from '@/components/ui/entity-list-empty'
import { sourceSelection } from '@/hooks/useEntitySelection'
import { sourceCardSlots, sourceRowConnection } from './SourceCardBadges'
import { SourceMenu } from './SourceMenu'
import { SendResourceToWorkspaceDialog } from './SendResourceToWorkspaceDialog'
import { useAppShellContext } from '@/context/AppShellContext'
import { usePluginEnablement } from '@/hooks/usePluginEnablement'
import { revealItemProps, useCapabilityReveal, type CapabilityReveal } from '@/hooks/useCapabilityReveal'
import { EditPopover, getAddSourceEditConfig, type AddSourceEditContextKey } from '@/components/ui/EditPopover'
import { ProjectContributionsList } from '@/components/workspace/ProjectContributionsList'
import { buildRuntimeResourceRows, type RuntimeResourceRow } from '@/lib/runtime-resource-rows'
import { sourceEnablementFor, type SourceEnablement } from '@/lib/source-enablement'
import { capabilityDisplayName, capabilityRouteId, type SafeSkillRow, type SafeSourceRow } from '@/lib/capability-catalog'
import type { ProjectContributionReport } from '@nessy-agent/shared/protocol/capabilities'
import type { SourceFilter } from '../../../shared/types'

const SOURCE_TYPE_FILTER_LABEL_KEYS: Record<string, string> = {
  api: 'sourcesList.filterApi',
  mcp: 'sourcesList.filterMcp',
  local: 'sourcesList.filterLocalFolder',
}

export interface SourcesListPanelProps {
  sources: SafeSourceRow[]
  sourceFilter?: SourceFilter | null
  onDeleteSource: (capabilityKey: string) => void
  onSourceClick: (source: SafeSourceRow) => void
  skills?: SafeSkillRow[]
  onSkillClick?: (skill: SafeSkillRow) => void
  workspaceId?: string
  selectedSourceSlug?: string | null
  /**
   * P6.769 — the workspace's "Enable stdio subprocess servers" setting.
   *
   * `AppShell` has passed it since long before the pip could use it, and this
   * component never destructured it, so the setting reached the list and stopped.
   * `mcp-pool.ts` refuses to start a stdio server while it is off ("Local MCP
   * servers are disabled for this workspace."), and the row for that server used
   * to look exactly like one nobody had tested yet. It is the input
   * `local_disabled` needs, and it is now read.
   */
  localMcpEnabled?: boolean
  className?: string
}

export function SourcesListPanel({
  sources,
  sourceFilter,
  onDeleteSource,
  onSourceClick,
  skills = [],
  onSkillClick,
  workspaceId,
  selectedSourceSlug,
  localMcpEnabled = true,
  className,
}: SourcesListPanelProps) {
  const { t } = useTranslation()
  const { workspaces, activeWorkspaceId, capabilityCatalog, capabilityContext, builtinDpMcp } = useAppShellContext()
  const resolvedWorkspaceId = workspaceId ?? activeWorkspaceId
  const hasOtherWorkspaces = workspaces.length > 1
  const reveal = useCapabilityReveal()

  // D3 post-trust re-inspect: what the active session's project contributes,
  // resolved from the SAME safe context ref the catalog uses. Read-only and
  // fail-soft — renders nothing for a workspace-only context (no project) or on
  // any error. Only fetched when the context addresses a project.
  const hasProjectRef = !!capabilityContext
    && ('sessionId' in capabilityContext || 'projectHandleId' in capabilityContext)
  const [projectReport, setProjectReport] = React.useState<ProjectContributionReport | null>(null)
  React.useEffect(() => {
    if (!capabilityContext || !hasProjectRef) { setProjectReport(null); return }
    let cancelled = false
    void window.electronAPI.capabilities
      .detectProjectContributions(capabilityContext)
      .then(report => { if (!cancelled) setProjectReport(report) })
      .catch(() => { if (!cancelled) setProjectReport(null) })
    return () => { cancelled = true }
  }, [capabilityContext, hasProjectRef])
  const pluginEnablement = usePluginEnablement()
  // Per-plugin activation, so a plugin-origin source row shows the correct
  // Enable vs Disable labels (U4). Keyed by the source's connector pluginKey.
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
  // Resolve a row's enable/disable affordance, or undefined for a display-only
  // row (native `.mcp.json`, api/local). The two write paths — the plugin
  // activation mutation and the built-in dp preference — stay separate by
  // construction; see `lib/source-enablement.ts`.
  const resolveEnablement = React.useCallback((source: SafeSourceRow): SourceEnablement | undefined =>
    sourceEnablementFor(source, {
      activationByPluginKey,
      hasProjectContext: pluginEnablement.hasProjectContext,
      builtinDp: builtinDpMcp?.view ?? null,
      onTogglePlugin: (pluginKey, scope, next) => void pluginEnablement.setEnabled(pluginKey, scope, next),
      onToggleBuiltin: (name, next) => builtinDpMcp?.toggle(name, next),
    }),
  [activationByPluginKey, builtinDpMcp, pluginEnablement])
  const [sendDialogOpen, setSendDialogOpen] = React.useState(false)
  const [sendResourceSlug, setSendResourceSlug] = React.useState<string | null>(null)
  const [sendResourceLabel, setSendResourceLabel] = React.useState('')
  const filteredItems = React.useMemo(() => buildRuntimeResourceRows({ capabilities: [...sources, ...skills], filter: sourceFilter }), [skills, sourceFilter, sources])

  const emptyMessage = React.useMemo(() => {
    if (sourceFilter?.kind === 'type') {
      const filterLabelKey = SOURCE_TYPE_FILTER_LABEL_KEYS[sourceFilter.sourceType]
      return t('sourcesList.noSourcesOfType', { type: filterLabelKey ? t(filterLabelKey) : sourceFilter.sourceType })
    }
    return t('sourcesList.noSourcesConfigured')
  }, [sourceFilter, t])

  return (
    <>
      {/* `plugins/components.md#when-the-configuration-dialog-appears` — the enable-time prompt, for a plugin-origin
          row toggled from this panel. */}
      {pluginEnablement.configurationPrompt}
      {projectReport && projectReport.items.length > 0 && (
        <div className="shrink-0 border-b border-foreground/5 px-4 py-3" data-testid="project-provides">
          <ProjectContributionsList report={projectReport} />
        </div>
      )}
      <EntityPanel<RuntimeResourceRow>
        items={filteredItems}
        getId={item => item.id}
        selection={sourceSelection}
        selectedId={selectedSourceSlug}
        onItemClick={(row) => row.kind === 'skill' ? onSkillClick?.(row.item) : onSourceClick(row.item)}
        className={className}
        containerProps={{ 'data-list-role': 'sources' }}
        emptyState={
          <EntityListEmptyScreen icon={<DatabaseZap />} title={emptyMessage} description={t('sourcesList.emptyDescription')} docKey="sources">
            {resolvedWorkspaceId && (
              <EditPopover
                align="center"
                trigger={<Button variant="secondary">{t('sourcesList.addSource')}</Button>}
                {...getAddSourceEditConfig(
                  sourceFilter?.kind === 'type' ? `add-source-${sourceFilter.sourceType}` as AddSourceEditContextKey : 'add-source',
                  resolvedWorkspaceId,
                )}
              />
            )}
          </EntityListEmptyScreen>
        }
        mapItem={(row) => row.kind === 'skill'
          // Plugin-origin skill rows are intentionally menu-less (U4 Defect-2,
          // path b): a skill's safe row carries no owning `pluginKey` (only
          // connector-materialized MCP SOURCES do, via `connectorOrigin`), and
          // there is no per-skill mutation. Skill enablement is done through the
          // owning plugin in the Plugins subsection / plugin detail.
          ? {
              icon: <SkillAvatar skill={row.item} size="sm" workspaceId={workspaceId} />,
              title: capabilityDisplayName(row.item),
              // The ONE card on the row anatomy: the whole row goes in, and the
              // card decides what reaches the markup (category meta + description).
              ...sourceCardSlots(row.item, t),
            }
          : sourceListItem(row, {
              t,
              hasOtherWorkspaces,
              onDeleteSource,
              reveal,
              setSendDialogOpen,
              setSendResourceLabel,
              setSendResourceSlug,
              enablement: resolveEnablement(row.item),
              localMcpEnabled,
            })}
      />
      {sendResourceSlug && (
        <SendResourceToWorkspaceDialog
          open={sendDialogOpen}
          onOpenChange={setSendDialogOpen}
          resourceType="source"
          resourceIds={[sendResourceSlug]}
          resourceLabel={sendResourceLabel}
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
        />
      )}
    </>
  )
}

function sourceListItem(row: Extract<RuntimeResourceRow, { kind: 'source' }>, options: {
  t: (key: string, params?: Record<string, unknown>) => string
  hasOtherWorkspaces: boolean
  onDeleteSource: (key: string) => void
  reveal: CapabilityReveal | null
  setSendDialogOpen: (open: boolean) => void
  setSendResourceLabel: (label: string) => void
  setSendResourceSlug: (slug: string) => void
  enablement?: SourceEnablement
  localMcpEnabled: boolean
}) {
  const source = row.item
  const canMutate = source.origin === 'native' && source.scope.kind === 'workspace' && !source.readOnly
  const routeId = capabilityRouteId(source.key)
  const displayName = capabilityDisplayName(source)
  return {
    icon: <SourceAvatar source={source} size="sm" showStatus localMcpEnabled={options.localMcpEnabled} />,
    title: displayName,
    // v0.15.1: the type is the title meta; line 2 is the description, or a state
    // other than connected in its status colour with the stored error as tooltip.
    ...sourceCardSlots(source, options.t, sourceRowConnection(source, options.localMcpEnabled)),
    menu: (
      <SourceMenu
        sourceSlug={routeId}
        sourceName={displayName}
        onOpenInNewWindow={() => window.electronAPI.openUrl(`nessy://sources/source/${routeId}?window=focused`)}
        {...revealItemProps(source, options.reveal, options.t('sourcesList.revealUnavailable'))}
        onDelete={canMutate ? () => options.onDeleteSource(source.key) : undefined}
        onSendToWorkspace={options.hasOtherWorkspaces && canMutate ? () => {
          options.setSendResourceSlug(source.logicalName)
          options.setSendResourceLabel(displayName)
          options.setSendDialogOpen(true)
        } : undefined}
        enablement={options.enablement}
      />
    ),
  }
}
