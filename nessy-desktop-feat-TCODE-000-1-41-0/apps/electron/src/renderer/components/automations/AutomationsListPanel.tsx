/**
 * Source: v0.15.1:apps/electron/src/renderer/components/automations/AutomationsListPanel.tsx (UB14.44; the
 * restyle re-applied on ours: trigger · actions as one quiet subtitle line, the last run as the title line's
 * meta, disabled rows dimmed by the tertiary title (AA) instead of a 50% row, `Button secondary` add, role text
 * tokens). Kept ours: `getManagedEditConfig` + `getAutomationAddPopoverKey` (managed edit, no raw
 * `automations.json` path), `compactTimeLabel`/`renderRelativeTime` (upstream `formatShortRelativeTime`), and
 * F1.795's "off by policy" chip, now an `Info_Badge` after the title. Apache-2.0, LICENSE and NOTICE kept.
 */
/**
 * AutomationsListPanel
 *
 * Navigator panel for displaying automations in the 2nd column.
 * Follows the SourcesListPanel pattern with avatar, title, subtitle, badges.
 * Title and Plus button are handled by the shared PanelHeader in AppShell.
 *
 * Supports CMD/CTRL+click multi-select and Shift+click range select,
 * using the shared EntityRow + createEntitySelection infrastructure.
 */

import * as React from 'react'
import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Webhook } from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent } from '@nessy-agent/ui'
import { ScrollArea } from '@/components/ui/scroll-area'
import { EntityListEmptyScreen } from '@/components/ui/entity-list-empty'
import { EntityRow } from '@/components/ui/entity-row'
import { EditPopover, getManagedEditConfig, type EditContextKey } from '@/components/ui/EditPopover'
import { SessionSearchHeader } from '@/components/app-shell/SessionSearchHeader'
import { AutomationMenu } from './AutomationMenu'
import { BatchAutomationMenu } from './BatchAutomationMenu'
import { AutomationAvatar } from './AutomationAvatar'
import { SendResourceToWorkspaceDialog } from '@/components/app-shell/SendResourceToWorkspaceDialog'
import { useAppShellContext } from '@/context/AppShellContext'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Info_Badge } from '@/components/info/Info_Badge'
import { automationSelection } from '@/hooks/useEntitySelection'
import { APP_EVENTS, AGENT_EVENTS, getEventDisplayName, type AutomationListItem, type AutomationListFilter } from './types'
import { compactTimeLabel, relativeTimeLabel, renderRelativeTime } from './utils'

const {
  useSelection: useAutomationSelection,
} = automationSelection

type AutomationAddPopoverKey = Extract<EditContextKey, 'add-automation' | 'add-automation-scheduled' | 'add-automation-event' | 'add-automation-agentic'>

function getAutomationAddPopoverKey(filter?: AutomationListFilter | null): AutomationAddPopoverKey {
  if (filter?.kind === 'scheduled') return 'add-automation-scheduled'
  if (filter?.kind === 'app') return 'add-automation-event'
  if (filter?.kind === 'agent') return 'add-automation-agentic'
  return 'add-automation'
}


// ============================================================================
// Automation Item
// ============================================================================

interface AutomationItemProps {
  automation: AutomationListItem
  isSelected: boolean
  isInMultiSelect: boolean
  isMultiSelectActive: boolean
  isFirst: boolean
  onClick: () => void
  onToggleSelect?: () => void
  onRangeSelect?: () => void
  onDelete: () => void
  onToggleEnabled: () => void
  onTest: () => void
  onDuplicate: () => void
  onSendToWorkspace?: () => void
}

function AutomationItem({
  automation,
  isSelected,
  isInMultiSelect,
  isMultiSelectActive,
  isFirst,
  onClick,
  onToggleSelect,
  onRangeSelect,
  onDelete,
  onToggleEnabled,
  onTest,
  onDuplicate,
  onSendToWorkspace,
}: AutomationItemProps) {
  const { t } = useTranslation()
  const handleClick = useCallback((e: React.MouseEvent) => {
    if (e.button === 2) {
      // Right-click: auto-add to selection if multi-select active
      if (isMultiSelectActive && !isInMultiSelect && onToggleSelect) onToggleSelect()
      return
    }
    if ((e.metaKey || e.ctrlKey) && onToggleSelect) {
      e.preventDefault()
      onToggleSelect()
      return
    }
    if (e.shiftKey && onRangeSelect) {
      e.preventDefault()
      onRangeSelect()
      return
    }
    onClick()
  }, [isMultiSelectActive, isInMultiSelect, onToggleSelect, onRangeSelect, onClick])

  return (
    <EntityRow
      className="automation-item"
      // Disabled automations read dimmer through the solved tertiary text (AA), not a 50% opacity row
      titleClassName={!automation.enabled ? 'text-tertiary' : undefined}
      showSeparator={!isFirst}
      separatorClassName="pl-10 pr-4"
      isSelected={isSelected}
      isInMultiSelect={isInMultiSelect}
      onMouseDown={handleClick}
      icon={<AutomationAvatar event={automation.event} size="sm" className={!automation.enabled ? 'opacity-50' : undefined} />}
      title={automation.name}
      // Trigger · actions as one quiet line (it was two pills per row): the same anatomy as the session
      // and source rows, with the last run as the title line's meta.
      subtitle={[
        getEventDisplayName(automation.event),
        automation.actions.some(a => a.type === 'prompt') ? t('automations.badgePrompt') : null,
        automation.actions.some(a => a.type === 'webhook') ? t('automations.badgeWebhook') : null,
      ].filter(Boolean).join(' · ')}
      // F1.795 (ours) — the managed codex policy keeps this automation from running: a destructive chip right
      // after the title (it was a pill in the badge row upstream removed), named by its hint.
      titleSuffix={automation.managedDisabled ? (
        <Info_Badge color="destructive" title={t('automations.managedDisabledHint')} data-managed-disabled="">
          {t('automations.badgeManagedDisabled')}
        </Info_Badge>
      ) : undefined}
      titleTrailing={
        automation.lastExecutedAt ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="shrink-0 cursor-default whitespace-nowrap text-label-sm text-tertiary tabular-nums">
                {renderRelativeTime(compactTimeLabel(automation.lastExecutedAt), t)}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              {t('automations.lastRan', { time: renderRelativeTime(relativeTimeLabel(automation.lastExecutedAt), t) })}
            </TooltipContent>
          </Tooltip>
        ) : undefined
      }
      menuContent={
        <AutomationMenu
          automationId={automation.id}
          automationName={automation.name}
          enabled={automation.enabled}
          onToggleEnabled={onToggleEnabled}
          onTest={onTest}
          onDuplicate={onDuplicate}
          onDelete={onDelete}
          onSendToWorkspace={onSendToWorkspace}
        />
      }
      contextMenuContent={isMultiSelectActive && isInMultiSelect ? <BatchAutomationMenu /> : undefined}
    />
  )
}

// ============================================================================
// AutomationsListPanel
// ============================================================================

export interface AutomationsListPanelProps {
  automations: AutomationListItem[]
  automationFilter?: AutomationListFilter | null
  onAutomationClick: (automationId: string) => void
  onDeleteAutomation?: (automationId: string) => void
  onToggleAutomation?: (automationId: string) => void
  onTestAutomation?: (automationId: string) => void
  onDuplicateAutomation?: (automationId: string) => void
  selectedAutomationId?: string | null
  className?: string
}

export function AutomationsListPanel({
  automations,
  automationFilter,
  onAutomationClick,
  onDeleteAutomation,
  onToggleAutomation,
  onTestAutomation,
  onDuplicateAutomation,
  selectedAutomationId,
  className,
}: AutomationsListPanelProps) {
  const { t } = useTranslation()
  const [searchQuery, setSearchQuery] = useState('')
  const [searchActive, setSearchActive] = useState(false)
  const { workspaces, activeWorkspaceId } = useAppShellContext()
  const hasOtherWorkspaces = workspaces.length > 1

  // Send to Workspace dialog state
  const [sendDialogOpen, setSendDialogOpen] = useState(false)
  const [sendResourceId, setSendResourceId] = useState<string | null>(null)
  const [sendResourceLabel, setSendResourceLabel] = useState('')

  const {
    select: selectAutomation,
    toggle: toggleAutomation,
    selectRange,
    isMultiSelectActive,
    isSelected: isInSelection,
  } = useAutomationSelection()

  const isSearchMode = searchActive && searchQuery.length >= 2

  // Filter automations based on sidebar-driven filter (from route)
  const categoryFiltered = React.useMemo(() => {
    const kind = automationFilter?.kind ?? 'all'
    if (kind === 'all') return automations
    if (kind === 'scheduled') return automations.filter(a => a.event === 'SchedulerTick')
    if (kind === 'app') return automations.filter(a => (APP_EVENTS as string[]).includes(a.event) && a.event !== 'SchedulerTick')
    if (kind === 'agent') return automations.filter(a => (AGENT_EVENTS as string[]).includes(a.event))
    return automations
  }, [automations, automationFilter?.kind])

  // Further filter by search query (name, summary, event display name)
  const searchFiltered = React.useMemo(() => {
    if (!isSearchMode) return categoryFiltered
    const q = searchQuery.toLowerCase()
    return categoryFiltered.filter(a =>
      a.name.toLowerCase().includes(q) ||
      a.summary.toLowerCase().includes(q) ||
      getEventDisplayName(a.event).toLowerCase().includes(q)
    )
  }, [categoryFiltered, isSearchMode, searchQuery])

  // Sort: most recently executed first, never-run at the bottom
  const filteredAutomations = React.useMemo(() => {
    return [...searchFiltered].sort((a, b) => {
      if (!a.lastExecutedAt && !b.lastExecutedAt) return 0
      if (!a.lastExecutedAt) return 1
      if (!b.lastExecutedAt) return -1
      return new Date(b.lastExecutedAt).getTime() - new Date(a.lastExecutedAt).getTime()
    })
  }, [searchFiltered])

  const handleItemClick = useCallback((automationId: string, index: number) => {
    selectAutomation(automationId, index)
    onAutomationClick(automationId)
  }, [selectAutomation, onAutomationClick])

  const handleToggleSelect = useCallback((automationId: string, index: number) => {
    toggleAutomation(automationId, index)
  }, [toggleAutomation])

  const handleRangeSelect = useCallback((toIndex: number) => {
    const allIds = filteredAutomations.map(a => a.id)
    selectRange(toIndex, allIds)
  }, [filteredAutomations, selectRange])

  // Empty state
  if (automations.length === 0) {
    return (
      <div className={cn('flex flex-col flex-1 min-h-0', className)}>
        <EntityListEmptyScreen
          icon={<Webhook />}
          title={t('automations.noAutomationsConfigured')}
          description={t('automations.emptyDescription')}
          docKey="automations"
        >
          {activeWorkspaceId && (
            <EditPopover
              align="center"
              trigger={
                <Button variant="secondary" size="md">
                  {t('automations.addAutomation')}
                </Button>
              }
              {...getManagedEditConfig(getAutomationAddPopoverKey(automationFilter), {
                scope: 'workspace', workspaceId: activeWorkspaceId, kind: 'automations',
              })}
            />
          )}
        </EntityListEmptyScreen>
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col flex-1 min-h-0', className)}>
      {/* Search header */}
      {searchActive && (
        <SessionSearchHeader
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onSearchClose={() => {
            setSearchActive(false)
            setSearchQuery('')
          }}
          placeholder={t('automations.searchPlaceholder')}
          resultCount={isSearchMode ? filteredAutomations.length : undefined}
        />
      )}

      {/* Filtered empty state */}
      {filteredAutomations.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-1">
          <p className="text-label text-tertiary">
            {isSearchMode ? t('automations.noAutomationsFound') : t('automations.noAutomationsConfigured')}
          </p>
          {isSearchMode && (
            <button
              onClick={() => setSearchQuery('')}
              className="rounded-xs text-label-sm text-accent hover:underline"
            >
              {t('automations.clearSearch')}
            </button>
          )}
        </div>
      ) : (
        <ScrollArea className="flex-1">
          <div className="pb-2" data-list-role="automations">
            <div className="pt-1">
              {filteredAutomations.map((automation, index) => (
                <AutomationItem
                  key={automation.id}
                  automation={automation}
                  isSelected={selectedAutomationId === automation.id}
                  isInMultiSelect={isMultiSelectActive && isInSelection(automation.id)}
                  isMultiSelectActive={isMultiSelectActive}
                  isFirst={index === 0}
                  onClick={() => handleItemClick(automation.id, index)}
                  onToggleSelect={() => handleToggleSelect(automation.id, index)}
                  onRangeSelect={() => handleRangeSelect(index)}
                  onDelete={() => onDeleteAutomation?.(automation.id)}
                  onToggleEnabled={() => onToggleAutomation?.(automation.id)}
                  onTest={() => onTestAutomation?.(automation.id)}
                  onDuplicate={() => onDuplicateAutomation?.(automation.id)}
                  onSendToWorkspace={hasOtherWorkspaces ? () => {
                    setSendResourceId(automation.id)
                    setSendResourceLabel(automation.name)
                    setSendDialogOpen(true)
                  } : undefined}
                />
              ))}
            </div>
          </div>
        </ScrollArea>
      )}

      {/* Send to Workspace dialog */}
      {sendResourceId && (
        <SendResourceToWorkspaceDialog
          open={sendDialogOpen}
          onOpenChange={setSendDialogOpen}
          resourceType="automation"
          resourceIds={[sendResourceId]}
          resourceLabel={sendResourceLabel}
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
        />
      )}
    </div>
  )
}
