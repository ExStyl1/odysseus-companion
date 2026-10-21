/**
 * SourceMenu - Shared menu content for source actions
 *
 * Used by:
 * - SourcesListPanel (dropdown via "..." button, context menu via right-click)
 * - SourceInfoPage (title dropdown menu)
 *
 * Uses MenuComponents context to render with either DropdownMenu or ContextMenu
 * primitives, allowing the same component to work in both scenarios.
 *
 * Provides consistent source actions:
 * - Enable / Disable (one action per scope, label following the current state,
 *   and only for the kinds that carry the option — see `lib/source-enablement.ts`)
 * - Open in New Window
 * - Show in file manager
 * - Delete
 */

import * as React from 'react'
import { useTranslation } from "react-i18next"
import {
  Trash2,
  FolderOpen,
  AppWindow,
  Send,
  Power,
  PowerOff,
} from 'lucide-react'
import { useMenuComponents } from '@/components/ui/menu-context'
import { getFileManagerName } from '@/lib/platform'
import { sourceEnablementActions, type SourceEnablement } from '@/lib/source-enablement'

export interface SourceMenuProps {
  /** Source slug */
  sourceSlug: string
  /** Source name for display */
  sourceName: string
  /** Callbacks */
  onOpenInNewWindow: () => void
  onShowInFinder?: () => void | Promise<void>
  onDelete?: () => void
  /** Tooltip shown when Show-in-Finder is disabled (catalog-only/non-file capability, A9). */
  showInFinderDisabledReason?: string
  /** Send to another workspace (omit to hide the option) */
  onSendToWorkspace?: () => void
  /**
   * The row's enable/disable affordance; omit for a row that has no such
   * option, so no dead menu item is rendered. See `lib/source-enablement.ts`
   * for which kinds carry one and which write each takes.
   */
  enablement?: SourceEnablement
}

/**
 * The Enable/Disable items themselves, so the row menu and the source detail
 * page render ONE definition rather than two that can drift — the owner asked
 * for the same action in both places, and "the same" has to mean the same
 * component, not the same intention.
 */
export function SourceEnablementMenuItems({ enablement }: { enablement?: SourceEnablement }) {
  const { t } = useTranslation()
  const { MenuItem } = useMenuComponents()
  return (
    <>
      {sourceEnablementActions(enablement).map((action) => (
        <MenuItem key={action.id} onClick={action.run}>
          {action.enabled ? <PowerOff className="h-3.5 w-3.5" /> : <Power className="h-3.5 w-3.5" />}
          <span className="flex-1">
            {action.id === 'project'
              ? t(action.labelKey, { project: t('sourcesManagement.activeProject') })
              : t(action.labelKey)}
          </span>
        </MenuItem>
      ))}
    </>
  )
}

/**
 * SourceMenu - Renders the menu items for source actions
 * This is the content only, not wrapped in a DropdownMenu or ContextMenu
 */
export function SourceMenu({
  sourceSlug,
  sourceName,
  onOpenInNewWindow,
  onShowInFinder,
  onDelete,
  showInFinderDisabledReason,
  onSendToWorkspace,
  enablement,
}: SourceMenuProps) {
  const { t } = useTranslation()

  // Get menu components from context (works with both DropdownMenu and ContextMenu)
  const { MenuItem, Separator } = useMenuComponents()
  // ONE action per scope, its label and effect taken from the CURRENT state —
  // never an Enable item beside a Disable item. Empty for a row with no
  // enablement option, which is what keeps a display-only row menu-clean.
  const hasEnablement = sourceEnablementActions(enablement).length > 0

  return (
    <>
      {hasEnablement && (
        <>
          <SourceEnablementMenuItems enablement={enablement} />
          <Separator />
        </>
      )}

      {/* Open in New Window */}
      <MenuItem onClick={onOpenInNewWindow}>
        <AppWindow className="h-3.5 w-3.5" />
        <span className="flex-1">{t("sidebarMenu.openInNewWindow")}</span>
      </MenuItem>

      {/* Show in file manager */}
      <MenuItem
        onClick={onShowInFinder}
        disabled={!onShowInFinder}
        title={!onShowInFinder ? showInFinderDisabledReason : undefined}
      >
        <FolderOpen className="h-3.5 w-3.5" />
        <span className="flex-1">{t("sessionMenu.showInFileManager", { fileManager: getFileManagerName() })}</span>
      </MenuItem>

      {/* Send to another workspace */}
      {onSendToWorkspace && (
        <MenuItem onClick={onSendToWorkspace}>
          <Send className="h-3.5 w-3.5" />
          <span className="flex-1">{t("sessionMenu.sendToWorkspace")}</span>
        </MenuItem>
      )}

      <Separator />

      {/* Delete */}
      <MenuItem onClick={onDelete} variant="destructive" disabled={!onDelete}>
        <Trash2 className="h-3.5 w-3.5" />
        <span className="flex-1">{t("sidebarMenu.deleteSource")}</span>
      </MenuItem>
    </>
  )
}
