/**
 * PluginRowMenu (U4)
 *
 * Enable/Disable menu content for a plugin-origin management row (the plugins
 * subsection + plugin-origin source rows). The AutomationMenu pattern: renders
 * inside the EntityRow "…" dropdown / right-click context menu via
 * useMenuComponents(). NO inline switch on the row itself.
 *
 * Menu items (owner decision 2026-07-19):
 *   - Enable/Disable in workspace — ALWAYS
 *   - Enable/Disable in <active project> — ONLY when a project context exists
 * plus an "Open details" entry. The action wires the EXISTING plugin
 * enable/disable mutations (via usePluginEnablement); no new machinery.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Power, PowerOff, Info, Trash2 } from 'lucide-react'
import { useMenuComponents } from '@/components/ui/menu-context'

export interface PluginRowMenuProps {
  /** Current workspace-scope enabled state (drives Enable vs Disable label). */
  workspaceEnabled: boolean
  /** Current project-scope enabled state (only meaningful with a project ctx). */
  projectEnabled?: boolean
  /** Whether the active project menu item should be offered. */
  hasProjectContext: boolean
  /** Localized active project name for the label (fallback used when absent). */
  projectName?: string
  /** Flip enablement at a scope. */
  onToggle: (scope: 'workspace' | 'project', next: boolean) => void
  /** Open the plugin detail page. */
  onOpenDetails?: () => void
  /** Uninstall the plugin (same mutation the marketplace actions menu uses). */
  onUninstall?: () => void
}

export function PluginRowMenu({
  workspaceEnabled,
  projectEnabled,
  hasProjectContext,
  projectName,
  onToggle,
  onOpenDetails,
  onUninstall,
}: PluginRowMenuProps) {
  const { t } = useTranslation()
  const { MenuItem, Separator } = useMenuComponents()

  return (
    <>
      {onOpenDetails && (
        <>
          <MenuItem onClick={onOpenDetails}>
            <Info className="h-3.5 w-3.5" />
            <span className="flex-1">{t('sourcesManagement.openDetails')}</span>
          </MenuItem>
          <Separator />
        </>
      )}

      {/* Workspace scope — always present */}
      <MenuItem onClick={() => onToggle('workspace', !workspaceEnabled)}>
        {workspaceEnabled ? <PowerOff className="h-3.5 w-3.5" /> : <Power className="h-3.5 w-3.5" />}
        <span className="flex-1">
          {workspaceEnabled
            ? t('sourcesManagement.disableInWorkspace')
            : t('sourcesManagement.enableInWorkspace')}
        </span>
      </MenuItem>

      {/* Project scope — only when a concrete project context exists */}
      {hasProjectContext && (
        <MenuItem onClick={() => onToggle('project', !projectEnabled)}>
          {projectEnabled ? <PowerOff className="h-3.5 w-3.5" /> : <Power className="h-3.5 w-3.5" />}
          <span className="flex-1">
            {projectEnabled
              ? t('sourcesManagement.disableInProject', { project: projectName ?? t('sourcesManagement.activeProject') })
              : t('sourcesManagement.enableInProject', { project: projectName ?? t('sourcesManagement.activeProject') })}
          </span>
        </MenuItem>
      )}

      {/* Uninstall — the same mutation the marketplace actions menu runs */}
      {onUninstall && (
        <>
          <Separator />
          <MenuItem onClick={onUninstall} variant="destructive">
            <Trash2 className="h-3.5 w-3.5" />
            <span className="flex-1">{t('plugins.uninstall')}</span>
          </MenuItem>
        </>
      )}
    </>
  )
}
