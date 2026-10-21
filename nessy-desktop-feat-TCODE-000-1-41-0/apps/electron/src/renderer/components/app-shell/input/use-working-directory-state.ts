import * as React from 'react'
import type { IssuedProjectHandle } from '@nessy-agent/shared/projects/project-handle-service'
import type { RecentProjectSummary } from '@nessy-agent/shared/protocol'

import { useDirectoryPicker } from '@/hooks/useDirectoryPicker'
import { getPathBasename } from '@/lib/platform'

/** Threshold above which the surface should render a filter input. */
export const WORKING_DIR_FILTER_THRESHOLD = 5

export interface UseWorkingDirectoryStateInput {
  workingDirectory: string | undefined
  onProjectChange: (project: IssuedProjectHandle) => void
  onResetToSession?: () => void
  workspaceId: string | undefined
  /** Whether the consumer's surface (popover / drawer) is currently open.
   *  The hook uses this to refresh history + reset the filter on every open. */
  isOpen: boolean
  /** Called when the hook wants the consumer's surface to close
   *  (after select-recent, reset, or choose-folder). */
  onClose: () => void
}

type ServerBrowserBridge = ReturnType<typeof useDirectoryPicker>

export interface UseWorkingDirectoryStateResult {
  recentProjects: RecentProjectSummary[]
  homeDir: string
  gitBranch: string | null
  filter: string
  setFilter: (next: string) => void

  /** Recent projects minus current dir, alphabetically sorted by basename. */
  sortedRecent: RecentProjectSummary[]
  /** Whether a non-session-root folder is currently selected. */
  hasFolder: boolean
  /** Display name for the trigger badge — basename of the selected folder,
   *  or `undefined` when nothing is selected. Consumers localise their own
   *  fallback so the hook stays i18n-free. */
  folderName: string | undefined
  /** Whether the Reset action should be offered. */
  showReset: boolean
  /** Whether the surface should show a search/filter input
   *  (true when more than {@link WORKING_DIR_FILTER_THRESHOLD} sortedRecent entries). */
  showFilter: boolean

  handleSelectRecent: (project: RecentProjectSummary) => void
  handleReset: () => void
  handleChooseFolder: () => void

  serverBrowser: Pick<
    ServerBrowserBridge,
    'showServerBrowser' | 'serverBrowserMode' | 'cancelServerBrowser' | 'confirmServerBrowser'
  >
}

/**
 * Shared state machine for the working-directory selector. Powers both the
 * desktop popover (FreeFormInput.WorkingDirectoryBadge) and the compact
 * drawer (CompactWorkingDirectorySelector) so they cannot drift.
 *
 * The hook owns: recent-dirs list, home dir, git branch fetch, filter input
 * state, and all mutation handlers. The hook does **not** own: surface open
 * state, autofocus behaviour, or path-display formatting — those stay in
 * the consumer because they differ intentionally between surfaces.
 */
export function useWorkingDirectoryState(
  input: UseWorkingDirectoryStateInput,
): UseWorkingDirectoryStateResult {
  const {
    workingDirectory,
    onProjectChange,
    onResetToSession,
    workspaceId,
    isOpen,
    onClose,
  } = input

  const [recentProjects, setRecentProjects] = React.useState<RecentProjectSummary[]>([])
  const [homeDir, setHomeDir] = React.useState<string>('')
  const [gitBranch, setGitBranch] = React.useState<string | null>(null)
  const [filter, setFilter] = React.useState('')

  React.useEffect(() => {
    if (workspaceId) {
      void window.electronAPI.listRecentProjects(workspaceId).then(setRecentProjects)
    } else {
      setRecentProjects([])
    }
    window.electronAPI?.getHomeDir?.().then((dir: string) => {
      if (dir) setHomeDir(dir)
    })
  }, [workspaceId])

  React.useEffect(() => {
    if (workingDirectory) {
      window.electronAPI?.getGitBranch?.(workingDirectory).then((branch: string | null) => {
        setGitBranch(branch)
      })
    } else {
      setGitBranch(null)
    }
  }, [workingDirectory])

  React.useEffect(() => {
    if (isOpen) {
      setFilter('')
      if (workspaceId) void window.electronAPI.listRecentProjects(workspaceId).then(setRecentProjects)
    }
  }, [isOpen, workspaceId])

  const handleFolderSelected = React.useCallback((project: IssuedProjectHandle) => {
    onProjectChange(project)
    if (workspaceId) void window.electronAPI.listRecentProjects(workspaceId).then(setRecentProjects)
  }, [onProjectChange, workspaceId])

  const {
    pickDirectory,
    showServerBrowser,
    serverBrowserMode,
    cancelServerBrowser,
    confirmServerBrowser,
  } = useDirectoryPicker(workspaceId, handleFolderSelected)

  const handleSelectRecent = React.useCallback((project: RecentProjectSummary) => {
    if (!workspaceId) return
    void window.electronAPI.issueRecentProjectHandle({
      workspaceId,
      recentProjectId: project.id,
    }).then(onProjectChange)
    onClose()
  }, [onClose, onProjectChange, workspaceId])

  const handleReset = React.useCallback(() => {
    onResetToSession?.()
    onClose()
  }, [onClose, onResetToSession])

  const handleChooseFolder = React.useCallback(() => {
    onClose()
    pickDirectory()
  }, [onClose, pickDirectory])

  const sortedRecent = React.useMemo(
    () => deriveSortedRecent(recentProjects, workingDirectory),
    [recentProjects, workingDirectory],
  )

  const { hasFolder, folderName, showReset } = React.useMemo(
    () => deriveSelectionFlags(workingDirectory, Boolean(onResetToSession)),
    [onResetToSession, workingDirectory],
  )

  const showFilter = sortedRecent.length > WORKING_DIR_FILTER_THRESHOLD

  return {
    recentProjects,
    homeDir,
    gitBranch,
    filter,
    setFilter,
    sortedRecent,
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
  }
}

// — Pure helpers (exported for testing) —

/**
 * Filter out the current directory and sort alphabetically by basename.
 * Pure derivation; the surfaces use this to render their recent-folder lists.
 */
export function deriveSortedRecent(
  recentProjects: readonly RecentProjectSummary[],
  workingDirectory: string | undefined,
): RecentProjectSummary[] {
  return recentProjects
    .filter((project) => project.displayPath !== workingDirectory)
    .slice()
    .sort((a, b) => {
      const nameA = getPathBasename(a.displayPath).toLowerCase()
      const nameB = getPathBasename(b.displayPath).toLowerCase()
      return nameA.localeCompare(nameB)
    })
}

export interface SelectionFlags {
  hasFolder: boolean
  /** Basename of the selected folder, or undefined when nothing is selected. */
  folderName: string | undefined
  showReset: boolean
}

/**
 * Derive the selection flags used to label and configure the trigger badge.
 * "No folder selected" means either no working directory at all, or the
 * working directory equals the session root.
 */
export function deriveSelectionFlags(
  workingDirectory: string | undefined,
  canResetToSession = false,
): SelectionFlags {
  const hasFolder = !!workingDirectory
  const folderName = hasFolder
    ? (getPathBasename(workingDirectory!) || undefined)
    : undefined
  const showReset = hasFolder && canResetToSession
  return { hasFolder, folderName, showReset }
}
