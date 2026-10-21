/**
 * Source: v0.15.1:apps/electron/src/renderer/components/app-shell/input/WorkingDirectorySelector.tsx (UB14.31; Apache-2.0).
 * Ours had never split it out: this is OUR `WorkingDirectoryBadge` popover body (FreeFormInput) moved into upstream's
 * trigger-agnostic shape (`renderTrigger`) and onto v0.15.1's menu material (`min-h-row-menu` rows, `bg-fill-selected`,
 * `text-tertiary`, `border-subtle`). Kept ours over upstream:
 * - the change callback is an issued project HANDLE (`IssuedProjectHandle`, owner 2026-09-23), never a raw path, and a
 *   recent row is a `RecentProjectSummary` (keyed by its id, shown by its `displayPath`);
 * - `onResetToSession` stands for upstream's `sessionFolderPath` (the host owns the session root), and `workspaceId` is
 *   required — it scopes the recent list and the `ServerDirectoryBrowser` (which takes it);
 * - a recent row has NO "remove recent" button: our state hook exposes no remove (`handleRemoveRecent` does not exist),
 *   a pre-delta divergence, so upstream's v0.15.1 `aria-label` hunk on that button is N/A.
 * The trigger (and with it D1.251's session-storage line and UA12.206's `chat.workInFolder`) stays with the consumer.
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Command as CommandPrimitive } from 'cmdk'
import { Check } from 'lucide-react'
import { Icon_Folder } from '@nessy-agent/ui'
import type { IssuedProjectHandle } from '@nessy-agent/shared/projects/project-handle-service'

import { ServerDirectoryBrowser } from '@/components/ServerDirectoryBrowser'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { PATH_SEP, getPathBasename } from '@/lib/platform'
import { useWorkingDirectoryState } from './use-working-directory-state'

/**
 * Format a path for display with the home directory shortened, e.g.
 * "in Workspace/kanban-view". Returns "" for an empty path.
 */
export function formatPathForDisplay(path: string | undefined, homeDir: string): string {
  if (!path) return ''
  let displayPath = path
  if (homeDir && path.startsWith(homeDir)) {
    const relativePath = path.slice(homeDir.length)
    // Remove leading separator if present, show root separator if empty
    displayPath = relativePath.startsWith(PATH_SEP)
      ? relativePath.slice(1)
      : (relativePath || PATH_SEP)
  }
  return `in ${displayPath}`
}

/** State handed to {@link WorkingDirectorySelectorProps.renderTrigger}. */
export interface WorkingDirectoryTriggerState {
  /** Whether the popover is currently open. */
  open: boolean
  /** A non-session-root folder is selected. */
  hasFolder: boolean
  /** Basename of the selected folder, or undefined when nothing is selected. */
  folderName: string | undefined
  /** The raw selected path (for tooltips / path display). */
  workingDirectory: string | undefined
  /** Home directory, for shortening displayed paths. */
  homeDir: string
  /** Current git branch of the selected folder, or null. */
  gitBranch: string | null
}

export interface WorkingDirectorySelectorProps {
  workingDirectory?: string
  /** A picked folder arrives as an issued project handle (ours; upstream passes a path). */
  onWorkingDirectoryChange: (project: IssuedProjectHandle) => void
  /** Reset the backend-owned project selection to the session's own directory. Undefined disables reset. */
  onResetToSession?: () => void
  workspaceId: string
  /**
   * Renders the popover trigger. The returned element is wrapped in
   * `<PopoverTrigger asChild>`, so it must forward a ref (a DOM element or a
   * ref-forwarding component).
   */
  renderTrigger: (state: WorkingDirectoryTriggerState) => React.ReactElement
  /** Popover side/align — defaults match the chat input badge. */
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
  sideOffset?: number
}

/**
 * WorkingDirectorySelector — trigger-agnostic working-directory picker.
 *
 * Owns the folder state machine ({@link useWorkingDirectoryState}), the Radix
 * popover with its cmdk recent-folders list, and the ServerDirectoryBrowser.
 * The trigger itself is supplied by the consumer via `renderTrigger`.
 */
export function WorkingDirectorySelector({
  workingDirectory,
  onWorkingDirectoryChange,
  onResetToSession,
  workspaceId,
  renderTrigger,
  side = 'top',
  align = 'start',
  sideOffset = 8,
}: WorkingDirectorySelectorProps) {
  const { t } = useTranslation()
  const [popoverOpen, setPopoverOpen] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const closePopover = React.useCallback(() => setPopoverOpen(false), [])

  const {
    homeDir,
    gitBranch,
    filter,
    setFilter,
    sortedRecent: filteredRecent,
    hasFolder,
    folderName,
    showReset,
    showFilter,
    handleSelectRecent,
    handleReset,
    handleChooseFolder,
    serverBrowser: {
      showServerBrowser,
      serverBrowserMode,
      cancelServerBrowser,
      confirmServerBrowser,
    },
  } = useWorkingDirectoryState({
    workingDirectory,
    onProjectChange: onWorkingDirectoryChange,
    onResetToSession,
    workspaceId,
    isOpen: popoverOpen,
    onClose: closePopover,
  })

  // Autofocus the filter input on popover open. Lives in the consumer (not
  // the hook) because the compact drawer surface has no autofocus.
  React.useEffect(() => {
    if (popoverOpen && showFilter) {
      const timer = setTimeout(() => {
        inputRef.current?.focus()
      }, 0)
      return () => clearTimeout(timer)
    }
  }, [popoverOpen, showFilter])

  // Floating menu material (PopoverContent: popover-styled + motion-popover), 30px rows
  const MENU_CONTAINER_STYLE = 'min-w-[200px] max-w-[400px] overflow-hidden p-0'
  const MENU_LIST_STYLE = 'max-h-[200px] overflow-y-auto p-1 [&_[cmdk-list-sizer]]:space-y-px'
  const MENU_ITEM_STYLE = 'flex min-h-row-menu cursor-pointer select-none items-center gap-2 rounded-md px-2 text-label outline-none'

  return (
    <>
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          {renderTrigger({ open: popoverOpen, hasFolder, folderName, workingDirectory, homeDir, gitBranch })}
        </PopoverTrigger>
        <PopoverContent side={side} align={align} sideOffset={sideOffset} className={MENU_CONTAINER_STYLE}>
          <CommandPrimitive shouldFilter={showFilter}>
            {/* Filter input - only shown when more than 5 recent folders */}
            {showFilter && (
              <div className="flex h-control-xl items-center border-b border-subtle px-3">
                <CommandPrimitive.Input
                  ref={inputRef}
                  value={filter}
                  onValueChange={setFilter}
                  placeholder={t('chat.filterFolders')}
                  className="w-full bg-transparent text-label outline-none placeholder:text-tertiary placeholder:select-none"
                />
              </div>
            )}

            <CommandPrimitive.List className={MENU_LIST_STYLE}>
              {/* Current Folder Display - shown at top with checkmark */}
              {hasFolder && (
                <CommandPrimitive.Item
                  value={`current-${workingDirectory}`}
                  className={cn(MENU_ITEM_STYLE, 'pointer-events-none bg-fill-selected')}
                  disabled
                >
                  <Icon_Folder className="h-4 w-4 shrink-0 text-secondary" />
                  <span className="flex-1 min-w-0 truncate">
                    <span>{folderName}</span>
                    <span className="text-tertiary ml-1.5">{formatPathForDisplay(workingDirectory, homeDir)}</span>
                  </span>
                  <Check className="h-4 w-4 shrink-0 text-secondary" />
                </CommandPrimitive.Item>
              )}

              {/* Separator after current folder */}
              {hasFolder && filteredRecent.length > 0 && (
                <div className="bg-separator my-1 mx-1 h-px" />
              )}

              {/* Recent projects - filterable (the current directory is already filtered out via filteredRecent) */}
              {filteredRecent.map((project) => {
                const path = project.displayPath
                const recentFolderName = getPathBasename(path) || 'Folder'
                return (
                  <CommandPrimitive.Item
                    key={project.id}
                    value={`${recentFolderName} ${path}`}
                    onSelect={() => handleSelectRecent(project)}
                    className={cn(MENU_ITEM_STYLE, 'group/item data-[selected=true]:bg-fill-hover')}
                  >
                    <Icon_Folder className="h-4 w-4 shrink-0 text-secondary" />
                    <span className="flex-1 min-w-0 truncate">
                      <span>{recentFolderName}</span>
                      <span className="text-tertiary ml-1.5">{formatPathForDisplay(path, homeDir)}</span>
                    </span>
                  </CommandPrimitive.Item>
                )
              })}

              {/* Empty state when filtering */}
              {showFilter && (
                <CommandPrimitive.Empty className="py-3 text-center text-label text-tertiary">
                  {t('chat.noFoldersFound')}
                </CommandPrimitive.Empty>
              )}
            </CommandPrimitive.List>

            {/* Bottom actions - always visible, outside scrollable area */}
            <div className="border-t border-subtle p-1">
              <button
                type="button"
                onClick={handleChooseFolder}
                className={cn(MENU_ITEM_STYLE, 'w-full hover:bg-fill-hover')}
              >
                {t('chat.chooseFolder')}
              </button>
              {showReset && (
                <button
                  type="button"
                  onClick={handleReset}
                  className={cn(MENU_ITEM_STYLE, 'w-full hover:bg-fill-hover')}
                >
                  {t('common.reset')}
                </button>
              )}
            </div>
          </CommandPrimitive>
        </PopoverContent>
      </Popover>
      <ServerDirectoryBrowser
        open={showServerBrowser}
        mode={serverBrowserMode}
        workspaceId={workspaceId}
        onSelect={confirmServerBrowser}
        onCancel={cancelServerBrowser}
        initialPath={workingDirectory}
      />
    </>
  )
}
