import * as React from "react"
import { useTranslation, Trans } from "react-i18next"
import { useRef, useState, useEffect, useCallback, useMemo } from "react"
import { useAtomValue, useStore } from "jotai"
import { motion, AnimatePresence } from "motion/react"
import {
  Archive,
  Terminal,
  Settings,
  ChevronRight,
  ChevronDown,
  MoreHorizontal,
  RotateCw,
  Flag,
  ListFilter,
  Tag,
  Check,
  X,
  Search,
  Plus,
  Trash2,
  DatabaseZap,
  Zap,
  Inbox,
  Globe,
  FolderOpen,
  Cake,
  Calendar,
  Layers,
  ListTodo,
  Clock,
  Radio,
  Bot,
  Info,
  MailOpen,
  Puzzle,
  Webhook,
} from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
// SessionStatusIcons no longer used - icons come from dynamic sessionStatuses
import { SourceAvatar } from "@/components/ui/source-avatar"
import { TopBar } from "./TopBar"
import { SquarePenRounded } from "../icons/SquarePenRounded"
import { McpIcon } from "../icons/McpIcon"
import { cn } from "@/lib/utils"
import { isMac } from "@/lib/platform"
import { Button } from "@/components/ui/button"
import { HeaderIconButton } from "@/components/ui/HeaderIconButton"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipTrigger, TooltipContent, DocumentFormattedMarkdownOverlay } from "@nessy-agent/ui"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuSub,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
  StyledDropdownMenuSubTrigger,
  StyledDropdownMenuSubContent,
} from "@/components/ui/styled-dropdown"
import {
  ContextMenu,
  ContextMenuTrigger,
  StyledContextMenuContent,
} from "@/components/ui/styled-context-menu"
import { ContextMenuProvider } from "@/components/ui/menu-context"
import { SidebarMenu } from "./SidebarMenu"
import { ScrollArea } from "@/components/ui/scroll-area"
import { FadingText } from "@/components/ui/fading-text"
// UB14.4 (v0.15.1): the sidebar frame (New session, the scrolling navigation, the pinned footer) and the two
// seam handles are their own files; the Collapsible import, dead since UB13.11, is gone. Seven lines replace
// seven, so citations of lines above the sidebar toggles keep their numbers (lint:ledger-citations).
import type { SidebarItem as SidebarNavItem } from "./LeftSidebar"
import { SidebarPane } from "./SidebarPane"
import { ShellResizeHandle } from "./ShellResizeHandle"
import { SessionList, type ChatGroupingMode } from "./SessionList"
import { MainContentPanel } from "./MainContentPanel"
import { describeBrowserRefusal } from "./browser-refusal-toast"
import { PanelStackContainer } from "./PanelStackContainer"
import { CompactSessionListFilter } from "./CompactSessionListFilter"
import type { ChatDisplayHandle } from "./ChatDisplay"
// (LeftSidebar renders inside SidebarPane.)
import { useSession } from "@/hooks/useSession"
import { invalidateMarketplaceQueries } from "@/hooks/useMarketplaceInstall"
import { ensureSessionMessagesLoadedAtom } from "@/atoms/sessions"
import { AppShellProvider, type AppShellContextType } from "@/context/AppShellContext"
import { EscapeInterruptProvider, useEscapeInterrupt } from "@/context/EscapeInterruptContext"
import { useTheme } from "@/context/ThemeContext"
import { getResizeGradientStyle } from "@/hooks/useResizeGradient"
import { useAction, useActionLabel } from "@/actions"
import { useFocusZone } from "@/hooks/keyboard"
import { useFocusContext } from "@/context/FocusContext"
import { getSessionTitle } from "@/utils/session"
import { useSetAtom } from "jotai"
import type { Session, FileAttachment, PermissionRequest, PermissionMode, SourceFilter, AutomationFilter, CustomSlashCommand } from "../../../shared/types"
import type {
  ComposerCatalogView,
  SafeCapabilitySummary,
  UserCapabilityCatalog,
} from '@nessy-agent/shared/protocol/capabilities'
import { sessionMetaMapAtom, sendToWorkspaceAtom, type SessionMeta } from "@/atoms/sessions"
import { sourcesAtom } from "@/atoms/sources"
import { skillsAtom } from "@/atoms/skills"
import { agentsAtom } from "@/atoms/agents"
import { panelStackAtom, panelCountAtom, focusedPanelIdAtom, focusedSessionIdAtom, focusNextPanelAtom, focusPrevPanelAtom, parseSessionIdFromRoute } from "@/atoms/panel-stack"
import { type SessionStatusId, type SessionStatus, statusConfigsToSessionStatuses } from "@/config/session-status-config"
import { useStatuses } from "@/hooks/useStatuses"
import { useLabels } from "@/hooks/useLabels"
import { useViews } from "@/hooks/useViews"
import { useContainerWidth } from "@/hooks/useContainerWidth"
import { LabelIcon, LabelValueTypeIcon } from "@/components/ui/label-icon"
import { filterSessionStatuses as filterLabelMenuStates } from "@/components/ui/label-menu"
import { createLabelMenuItems, filterItems as filterLabelMenuItems, type LabelMenuItem } from "@/components/ui/label-menu-utils"
import { buildLabelTree, getLabelDisplayName, extractLabelId, findLabelById, matchesLabelFilter, sortLabelsForDisplay, type LabelConfig, type LabelTreeNode } from "@nessy-agent/shared/labels"
import {
  getVisibleComposerPermissionModes,
  nextCyclePermissionMode,
  resolveWorkspaceCyclablePermissionModes, resolveWorkspaceDefaultModeDisplay,
} from "@/lib/composer-permission-modes"
import { resolveEntityColor } from "@nessy-agent/shared/colors"
import * as storage from "@/lib/local-storage"
import { toast } from "sonner"
import { Network as KnowledgeIcon, MessagesSquare } from 'lucide-react'
import { UI_SKILLS } from "@/lib/odysseus-skills"
import { navigate, routes } from "@/lib/navigate"
import { sourceNavigationCounts } from "@/lib/runtime-resource-rows"
import { countSessionsPerLabel } from "@/lib/label-session-counts"
import { useBuiltinDpMcpServers } from "@/hooks/useBuiltinDpMcpServers"
import {
  useNavigation,
  useNavigationState,
  isSessionsNavigation,
  isSourcesNavigation,
  isSettingsNavigation,
  isSkillsNavigation,
  isAutomationsNavigation,
  isPluginsNavigation,
  type NavigationState,
} from "@/contexts/NavigationContext"
import type { SettingsSubpage } from "../../../shared/types"
import { SourcesListPanel } from "./SourcesListPanel"
import { ConnectedMcpServersPanel } from "./ConnectedMcpServersPanel"
import { PluginsManagementPanel } from "./PluginsManagementPanel"
import { SkillsListPanel } from "./SkillsListPanel"
import { AutomationsListPanel } from "../automations/AutomationsListPanel"
import { APP_EVENTS, AGENT_EVENTS, type AutomationFilterKind, AUTOMATION_TYPE_TO_FILTER_KIND } from "../automations/types"
import { useAutomations } from "@/hooks/useAutomations"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { PanelHeader } from "./PanelHeader"
import { FabNewChat } from "./FabNewChat"
import { SendToWorkspaceDialog } from "./SendToWorkspaceDialog"
import { RtkUpdatePrompt } from "@/components/RtkUpdateDialog"
import { EditPopover, getManagedEditConfig, getAddSourceEditConfig, getAddSkillEditConfig, type EditContextKey } from "@/components/ui/EditPopover"
import SettingsNavigator from "@/pages/settings/SettingsNavigator"
import {
  PANEL_GAP,
  PANEL_EDGE_INSET,
  PANEL_SASH_HALF_HIT_WIDTH,
  PANEL_SASH_HIT_WIDTH,
  PANEL_SASH_LINE_WIDTH,
  PANEL_STACK_VERTICAL_OVERFLOW,
  RADIUS_EDGE,
  RADIUS_INNER,
} from "./panel-constants"
import { hasOpenOverlay } from "@/lib/overlay-detection"
import { dispatchFocusInputEvent } from "./input/focus-input-events"
import { DEFAULT_CYCLABLE_PERMISSION_MODES } from "@nessy-agent/shared/agent/modes"
import { sourceListSkillId } from "@/lib/source-list-ids"
import {
  capabilityContext,
  capabilityRouteId,
  isComposerSelectableSkillRow,
  isComposerSelectableSourceRow,
  isSafeSkillRow,
  isSafeSourceRow,
  type SafeSkillRow,
  type SafeSourceRow,
} from '@/lib/capability-catalog'
import { refreshCapabilityDependentsOnChange } from '@/lib/capability-invalidation-refresh'
import { MARKETPLACE_AUTO_UPDATE_REASON_CODE } from '@nessy-agent/shared/marketplace/auto-update'

/**
 * AppShellProps - Minimal props interface for AppShell component
 *
 * Data and callbacks come via contextValue (AppShellContextType).
 * Only UI-specific state is passed as separate props.
 *
 * Adding new features:
 * 1. Add to AppShellContextType in context/AppShellContext.tsx
 * 2. Update App.tsx to include in contextValue
 * 3. Use via useAppShellContext() hook in child components
 */
interface AppShellProps {
  /** All data and callbacks - passed directly to AppShellProvider */
  contextValue: AppShellContextType
  /** UI-specific props */
  defaultLayout?: number[]
  defaultCollapsed?: boolean
  menuNewChatTrigger?: number
  /** Focused mode - hides sidebars, shows only the chat content */
  isFocusedMode?: boolean
}

/** Filter mode for tri-state filtering: include shows only matching, exclude hides matching */
type FilterMode = 'include' | 'exclude'

type AutomationAddType = 'scheduled' | 'event' | 'agentic'
type AutomationAddPopoverKey = Extract<EditContextKey, 'add-automation' | 'add-automation-scheduled' | 'add-automation-event' | 'add-automation-agentic'>
type AppShellEditPopoverKey =
  | 'statuses'
  | 'labels'
  | 'views'
  | 'add-source'
  | 'add-source-api'
  | 'add-source-mcp'
  | 'add-source-local'
  | 'add-skill'
  | 'add-label'
  | 'automation-config'
  | AutomationAddPopoverKey

function getAutomationAddPopoverKey(type?: AutomationAddType): AutomationAddPopoverKey {
  if (type === 'scheduled') return 'add-automation-scheduled'
  if (type === 'event') return 'add-automation-event'
  if (type === 'agentic') return 'add-automation-agentic'
  return 'add-automation'
}

// UB14.5 (v0.15.1): the session list's filter dropdown and its row helpers (AltExcludeTooltip, FilterModeBadge,
// FilterModeSubMenuItems, FilterMenuRow, FilterLabelItems) live in ./SessionFilterMenu; AppShell keeps the filter maps.

/**
 * AppShell - Main 3-panel layout container
 *
 * Layout: [LeftSidebar 20%] | [NavigatorPanel 32%] | [MainContentPanel 48%]
 *
 * Session Filters:
 * - 'allSessions': Shows all sessions
 * - 'flagged': Shows flagged sessions
 * - 'state': Shows sessions with a specific todo state
 */
export function AppShell(props: AppShellProps) {
  // Wrap with EscapeInterruptProvider so AppShellContent can use useEscapeInterrupt
  return (
    <EscapeInterruptProvider>
      <AppShellContent {...props} />
    </EscapeInterruptProvider>
  )
}

/**
 * AppShellContent - Inner component that contains all the AppShell logic
 * Separated to allow useEscapeInterrupt hook to work (must be inside provider)
 */
function AppShellContent({
  contextValue,
  defaultLayout = [20, 32, 48],
  defaultCollapsed = false,
  menuNewChatTrigger,
  isFocusedMode = false,
}: AppShellProps) {
  // Destructure commonly used values from context
  // Note: sessions is NOT destructured here - we use sessionMetaMapAtom instead
  // to prevent closures from retaining the full messages array
  const {
    workspaces,
    activeWorkspaceId,
    sessionOptions,
    onSelectWorkspace,
    onRefreshWorkspaces,
    onDeleteSession,
    onFlagSession,
    onUnflagSession,
    onArchiveSession,
    onUnarchiveSession,
    onMarkSessionRead,
    onMarkSessionUnread,
    onSessionStatusChange,
    onRenameSession,
    onOpenSettings,
    onOpenKeyboardShortcuts,
    onOpenStoredUserPreferences,
    onReset,
    onSendMessage,
    openNewChat,
    pendingPermissions,
  } = contextValue

  const { t, i18n } = useTranslation()
  const [odysseusStatus, setOdysseusStatus] = useState<import('../../../shared/types').OdysseusSyncStatus | null>(null)
  const [cliOpening, setCliOpening] = useState(false)
  useEffect(() => {
    let disposed = false
    const refresh = async () => {
      try {
        const status = await window.electronAPI.getOdysseusStatus()
        if (disposed) return
        setOdysseusStatus(previous => {
          const visible = (s: typeof status | null) => s && [s.enabled,s.error,s.language,s.conflicts?.length,s.deferred?.length]
          return JSON.stringify(visible(previous)) === JSON.stringify(visible(status)) ? previous : status
        })
        if (status.language && status.language !== i18n.language) void i18n.changeLanguage(status.language)
      } catch { /* Older standalone hosts do not provide the optional bridge. */ }
    }
    void refresh()
    const timer = setInterval(() => { void refresh() }, 5000)
    return () => { disposed = true; clearInterval(timer) }
  }, [i18n])
  const queryClient = useQueryClient()

  // Get hotkey labels from centralized action registry
  const newChatHotkey = useActionLabel('app.newChat').hotkey

  const [isSidebarVisible, setIsSidebarVisible] = React.useState(() => {
    return storage.get(storage.KEYS.sidebarVisible, !defaultCollapsed)
  })
  const [sidebarWidth, setSidebarWidth] = React.useState(() => {
    return storage.get(storage.KEYS.sidebarWidth, 232) // UB14.4 (v0.15.1): was 220; a persisted width wins
  })
  // Session list width in pixels (min 240, max 480)
  const [sessionListWidth, setSessionListWidth] = React.useState(() => {
    return storage.get(storage.KEYS.sessionListWidth, 304) // UB14.4 (v0.15.1): was 300
  })

  // Hides both sidebar and navigator (CMD+. toggle)
  // Seed from either focused window param or persisted preference, then keep it toggleable.
  const [isSidebarAndNavigatorHidden, setIsSidebarAndNavigatorHidden] = React.useState(() => {
    return isFocusedMode || storage.get(storage.KEYS.focusModeEnabled, false)
  })

  // Auto-compact mode: shell width below mobile threshold hides sidebar/navigator
  // and switches to single-panel mode. Works in both webui (narrow viewport) and
  // desktop (narrow window or small screen).
  const shellRef = useRef<HTMLDivElement>(null)
  const shellWidth = useContainerWidth(shellRef)
  const MOBILE_THRESHOLD = 768
  const isAutoCompact = shellWidth > 0 && shellWidth < MOBILE_THRESHOLD

  const effectiveSidebarAndNavigatorHidden = isSidebarAndNavigatorHidden || isAutoCompact

  // What's New overlay
  const [showWhatsNew, setShowWhatsNew] = React.useState(false)
  const [releaseNotesContent, setReleaseNotesContent] = React.useState('')
  const [hasUnseenReleaseNotes, setHasUnseenReleaseNotes] = React.useState(false)

  // Check for unseen release notes on mount
  useEffect(() => {
    window.electronAPI.getLatestReleaseVersion().then((latestVersion) => {
      if (!latestVersion) return
      const lastSeen = storage.get(storage.KEYS.whatsNewLastSeenVersion, '')
      setHasUnseenReleaseNotes(lastSeen !== latestVersion)
    })
  }, [])

  const [isResizing, setIsResizing] = React.useState<'sidebar' | 'session-list' | null>(null)
  const [sidebarHandleY, setSidebarHandleY] = React.useState<number | null>(null)
  const [sessionListHandleY, setSessionListHandleY] = React.useState<number | null>(null)
  const resizeHandleRef = React.useRef<HTMLDivElement>(null)
  const sessionListHandleRef = React.useRef<HTMLDivElement>(null)
  const [session, setSession] = useSession()
  const { resolvedMode, isDark, setMode } = useTheme()
  const { canGoBack, canGoForward, goBack, goForward, navigateToSource, navigateToSession } = useNavigation()

  // Double-Esc interrupt feature: first Esc shows warning, second Esc interrupts
  const { handleEscapePress } = useEscapeInterrupt()

  // UNIFIED NAVIGATION STATE - single source of truth from NavigationContext
  // Derived from focused panel's route — all panels are peers
  const navState = useNavigationState()

  const store = useStore()
  const panelStack = useAtomValue(panelStackAtom)
  const panelCount = useAtomValue(panelCountAtom)
  const focusedSessionId = useAtomValue(focusedSessionIdAtom)

  // Navigate the focused panel to a session.
  // If the session is already open in another panel, focus that panel instead.
  const setFocusedPanel = useSetAtom(focusedPanelIdAtom)
  const navigateToSessionInPanel = useCallback((sessionId: string) => {
    // Check if the session is already open in any panel — focus it instead of navigating
    const stack = store.get(panelStackAtom)
    for (const entry of stack) {
      if (parseSessionIdFromRoute(entry.route) === sessionId) {
        setFocusedPanel(entry.id)
        return
      }
    }

    // Not open in any panel — navigate() updates the focused panel
    navigateToSession(sessionId)
  }, [store, setFocusedPanel, navigateToSession])

  const sessionsContext = React.useMemo(() => {
    if (isSessionsNavigation(navState)) {
      return {
        filter: navState.filter,
        sessionId: navState.details?.sessionId ?? null,
      }
    }
    return null
  }, [navState])

  const sessionFilter = sessionsContext?.filter ?? null

  // Derive source filter from navigation state (only when in sources navigator)
  const sourceFilter: SourceFilter | null = isSourcesNavigation(navState) ? navState.filter ?? null : null

  // Derive automation filter from navigation state (only when in automations navigator)
  const automationFilter: AutomationFilter | null = isAutomationsNavigation(navState) ? navState.filter ?? null : null

  // Per-view filter storage: each session list view (allSessions, flagged, state:X, label:X, view:X)
  // has its own independent set of status and label filters.
  // Each filter entry stores a mode ('include' or 'exclude') for tri-state filtering.
  type FilterEntry = Record<string, FilterMode> // id → mode
  type ViewFiltersMap = Record<string, { statuses: FilterEntry, labels: FilterEntry, projects?: FilterEntry, groupingMode?: ChatGroupingMode }> // UA5.9 (v0.13.4): projects

  // Compute a stable key for the current chat filter view
  const sessionFilterKey = useMemo(() => {
    if (!sessionFilter) return null
    switch (sessionFilter.kind) {
      case 'allSessions': return 'allSessions'
      case 'flagged': return 'flagged'
      case 'archived': return 'archived'
      case 'state': return `state:${sessionFilter.stateId}`
      case 'label': return `label:${sessionFilter.labelId}`
      case 'view': return `view:${sessionFilter.viewId}`
      default: return 'allSessions'
    }
  }, [sessionFilter])

  const [viewFiltersMap, setViewFiltersMap] = React.useState<ViewFiltersMap>(() => {
    const saved = storage.get<ViewFiltersMap>(storage.KEYS.viewFilters, {})
    // Backward compat: migrate old format (arrays) into new format (Record<string, FilterMode>)
    if (saved.allSessions && Array.isArray((saved.allSessions as any).statuses)) {
      // Old format: { statuses: string[], labels: string[] } → new: { statuses: Record, labels: Record }
      for (const key of Object.keys(saved)) {
        const entry = saved[key] as any
        if (Array.isArray(entry.statuses)) {
          const newStatuses: FilterEntry = {}
          for (const id of entry.statuses) newStatuses[id] = 'include'
          const newLabels: FilterEntry = {}
          for (const id of entry.labels) newLabels[id] = 'include'
          saved[key] = { statuses: newStatuses, labels: newLabels }
        }
      }
    }
    // Also migrate legacy global filters if no allSessions entry exists
    if (!saved.allSessions) {
      const oldStatuses = storage.get<SessionStatusId[]>(storage.KEYS.listFilter, [])
      const oldLabels = storage.get<string[]>(storage.KEYS.labelFilter, [])
      if (oldStatuses.length > 0 || oldLabels.length > 0) {
        const statuses: FilterEntry = {}
        for (const id of oldStatuses) statuses[id] = 'include'
        const labels: FilterEntry = {}
        for (const id of oldLabels) labels[id] = 'include'
        saved.allSessions = { statuses, labels }
      }
    }
    return saved
  })

  // Derive current view's status filter as a Map<SessionStatusId, FilterMode>
  const listFilter = useMemo(() => {
    if (!sessionFilterKey) return new Map<SessionStatusId, FilterMode>()
    const entry = viewFiltersMap[sessionFilterKey]?.statuses ?? {}
    return new Map<SessionStatusId, FilterMode>(Object.entries(entry) as [SessionStatusId, FilterMode][])
  }, [viewFiltersMap, sessionFilterKey])

  // Derive current view's label filter as a Map<string, FilterMode>
  const labelFilter = useMemo(() => {
    if (!sessionFilterKey) return new Map<string, FilterMode>()
    const entry = viewFiltersMap[sessionFilterKey]?.labels ?? {}
    return new Map<string, FilterMode>(Object.entries(entry) as [string, FilterMode][])
  }, [viewFiltersMap, sessionFilterKey])

  // Setter for status filter — updates only the current view's entry in the map
  const setListFilter = useCallback((updater: Map<SessionStatusId, FilterMode> | ((prev: Map<SessionStatusId, FilterMode>) => Map<SessionStatusId, FilterMode>)) => {
    setViewFiltersMap(prev => {
      if (!sessionFilterKey) return prev
      const current = new Map<SessionStatusId, FilterMode>(Object.entries(prev[sessionFilterKey]?.statuses ?? {}) as [SessionStatusId, FilterMode][])
      const next = typeof updater === 'function' ? updater(current) : updater
      return {
        ...prev,
        [sessionFilterKey]: { ...prev[sessionFilterKey], statuses: Object.fromEntries(next), labels: prev[sessionFilterKey]?.labels ?? {} } // UA5.9: keeps projects + groupingMode, as upstream
      }
    })
  }, [sessionFilterKey])

  // Setter for label filter — updates only the current view's entry in the map
  const setLabelFilter = useCallback((updater: Map<string, FilterMode> | ((prev: Map<string, FilterMode>) => Map<string, FilterMode>)) => {
    setViewFiltersMap(prev => {
      if (!sessionFilterKey) return prev
      const current = new Map<string, FilterMode>(Object.entries(prev[sessionFilterKey]?.labels ?? {}) as [string, FilterMode][])
      const next = typeof updater === 'function' ? updater(current) : updater
      return {
        ...prev,
        [sessionFilterKey]: { ...prev[sessionFilterKey], statuses: prev[sessionFilterKey]?.statuses ?? {}, labels: Object.fromEntries(next) } // UA5.9: keeps projects + groupingMode, as upstream
      }
    })
  }, [sessionFilterKey])
  // Search state for session list
  const [searchActive, setSearchActive] = React.useState(false)
  const [searchQuery, setSearchQuery] = React.useState('')

  // Grouping mode for chat list: per-view (stored in viewFiltersMap), forced to 'date' for state sub-views
  const isStateSubView = sessionFilter?.kind === 'state'

  const chatGroupingMode: ChatGroupingMode = isStateSubView
    ? 'date'
    : (viewFiltersMap[sessionFilterKey ?? '']?.groupingMode ?? 'date')

  const setChatGroupingMode = useCallback((mode: ChatGroupingMode) => {
    setViewFiltersMap(prev => {
      if (!sessionFilterKey) return prev
      const existing = prev[sessionFilterKey] ?? { statuses: {}, labels: {} }
      return {
        ...prev,
        [sessionFilterKey]: { ...existing, groupingMode: mode }
      }
    })
  }, [sessionFilterKey])

  // Ref for ChatDisplay navigation (exposed via forwardRef)
  const chatDisplayRef = React.useRef<ChatDisplayHandle>(null)
  // Track match count and index from ChatDisplay (for SessionList navigation UI)
  const [chatMatchInfo, setChatMatchInfo] = React.useState<{ sessionId: string | null; count: number; index: number; isHighlighting?: boolean }>({ sessionId: null, count: 0, index: 0 })

  // Callback for immediate match info updates from ChatDisplay
  // Memo guard prevents render feedback loops from identical updates
  const handleChatMatchInfoChange = React.useCallback((info: { sessionId: string | null; count: number; index: number; isHighlighting: boolean }) => {
    setChatMatchInfo(prev => {
      if (prev.sessionId === info.sessionId && prev.count === info.count && prev.index === info.index && prev.isHighlighting === info.isHighlighting) {
        return prev
      }
      return info
    })
  }, [])

  // Reset match info when search is deactivated
  React.useEffect(() => {
    if (!searchActive || !searchQuery) {
      setChatMatchInfo({ sessionId: null, count: 0, index: 0 })
    }
  }, [searchActive, searchQuery])

  // Reset search only when navigator or filter changes (not when selecting sessions)
  const navFilterKey = React.useMemo(() => {
    if (isSessionsNavigation(navState)) {
      const filter = navState.filter
      return `chats:${filter.kind}:${filter.kind === 'state' ? filter.stateId : ''}`
    }
    return navState.navigator
  }, [navState])

  React.useEffect(() => {
    setSearchActive(false)
    setSearchQuery('')
  }, [navFilterKey])

  // Cmd+F to activate search
  useAction('app.search', () => setSearchActive(true))

  // Unified sidebar keyboard navigation state
  // Load expanded folders from localStorage (default: all collapsed)
  const [expandedFolders, setExpandedFolders] = React.useState<Set<string>>(() => {
    const saved = storage.get<string[]>(storage.KEYS.expandedFolders, [])
    return new Set(saved)
  })
  const [focusedSidebarItemId, setFocusedSidebarItemId] = React.useState<string | null>(null)
  const sidebarItemRefs = React.useRef<Map<string, HTMLElement>>(new Map())
  // Track which expandable sidebar items are collapsed
  // Labels are collapsed by default; user preference is persisted once toggled
  const [collapsedItems, setCollapsedItems] = React.useState<Set<string>>(() => {
    const saved = storage.get<string[] | null>(storage.KEYS.collapsedSidebarItems, null)
    if (saved !== null) return new Set(saved)
    return new Set(['nav:labels'])
  })
  const isExpanded = React.useCallback((id: string) => !collapsedItems.has(id), [collapsedItems])
  const toggleExpanded = React.useCallback((id: string) => {
    setCollapsedItems(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const [capabilityCatalog, setCapabilityCatalog] = React.useState<UserCapabilityCatalog | null | undefined>(undefined)
  const [composerCatalog, setComposerCatalog] = React.useState<ComposerCatalogView | null | undefined>(undefined)
  const sources = React.useMemo(() => capabilityCatalog?.capabilities.filter(isSafeSourceRow) ?? [], [capabilityCatalog])
  const skills = React.useMemo(() => capabilityCatalog?.capabilities.filter(isSafeSkillRow) ?? [], [capabilityCatalog])
  // A7: read ONCE here, not in the panel, because the nav count and the MCP
  // list both derive from it — two reads would be two states that can disagree.
  const builtinDpMcp = useBuiltinDpMcpServers()
  // Composer picker + @mention: folder/API sources only (R3-C). MCP is
  // activation-governed, not a per-session composer toggle.
  const composerSources = React.useMemo(() => composerCatalog?.items.filter(isComposerSelectableSourceRow) ?? [], [composerCatalog])
  const composerSkills = React.useMemo(() => composerCatalog?.items.filter(isComposerSelectableSkillRow) ?? [], [composerCatalog])
  const agents = React.useMemo(() => composerCatalog?.items.filter(item => item.kind === 'agent') ?? [], [composerCatalog])
  // Sync sources to atom for NavigationContext auto-selection
  const setSourcesAtom = useSetAtom(sourcesAtom)
  React.useEffect(() => {
    setSourcesAtom(sources)
  }, [sources, setSourcesAtom])

  // Sync skills to atom for NavigationContext auto-selection
  const setSkillsAtom = useSetAtom(skillsAtom)
  React.useEffect(() => {
    setSkillsAtom(skills)
  }, [skills, setSkillsAtom])

  // Custom slash commands state (workspace/project-scoped)
  const [customSlashCommands, setCustomSlashCommands] = React.useState<CustomSlashCommand[]>([])

  const setAgentsAtom = useSetAtom(agentsAtom)
  React.useEffect(() => {
    setAgentsAtom(agents)
  }, [agents, setAgentsAtom])
  // Automations — state, handlers, loading, subscriptions
  const activeWorkspace = workspaces.find(w => w.id === activeWorkspaceId)

  // Send to Workspace dialog state (driven by sendToWorkspaceAtom set from SessionMenu/BatchSessionMenu)
  const sendToWorkspaceIds = useAtomValue(sendToWorkspaceAtom)
  const setSendToWorkspaceIds = useSetAtom(sendToWorkspaceAtom)
  const handleTransferComplete = useCallback((targetWorkspaceId: string, _newSessionIds: string[]) => {
    onSelectWorkspace(targetWorkspaceId)
  }, [onSelectWorkspace])
  const {
    automations, automationTestResults,
    automationPendingDelete, pendingDeleteAutomation, setAutomationPendingDelete,
    handleTestAutomation, handleToggleAutomation, handleDuplicateAutomation, handleDeleteAutomation, confirmDeleteAutomation,
    getAutomationHistory, handleReplayAutomation,
  } = useAutomations(activeWorkspaceId)

  // Whether local MCP servers are enabled (affects stdio source status)
  const [localMcpEnabled, setLocalMcpEnabled] = React.useState(true)

  // Enabled permission modes for Shift+Tab cycling (min 2 modes). The seed and every fallback below are the
  // shared default cycle, which since D1.369 OFFERS bypassPermissions (owner 2026-09-18); the first activation
  // is still held by App.tsx's responsibility dialog, and `dontAsk` is still never in it.
  const [enabledModes, setEnabledModes] = React.useState<PermissionMode[]>(DEFAULT_CYCLABLE_PERMISSION_MODES)
  const [defaultPermissionMode, setDefaultPermissionMode] = React.useState<PermissionMode | undefined>(undefined) // F1.1052: the picker's "Default" badge
  // Load workspace settings (localMcpEnabled, cyclablePermissionModes, the default mode) on workspace change, and again whenever
  // Workspace Settings saves one (F1.1191: `onWorkspaceSettingsChanged`, else the "Default" badge kept the old mode until a reload)
  const loadWorkspaceSettings = React.useCallback(() => {
    if (!activeWorkspaceId) return
    window.electronAPI.getWorkspaceSettings(activeWorkspaceId).then((settings) => {
      if (settings) {
        setLocalMcpEnabled(settings.localMcpEnabled ?? true)
        // Resolve cyclablePermissionModes through the shared fallback so a workspace without one (or with a
        // degenerate < 2 list) gets the gated default cycle — including on a switch away from one that had its own.
        setEnabledModes(resolveWorkspaceCyclablePermissionModes(settings.cyclablePermissionModes))
        // The mode a new session here starts in — what Workspace Settings shows as the default (P2.489, P4.8).
        setDefaultPermissionMode(resolveWorkspaceDefaultModeDisplay(settings.permissionMode, settings.effectiveDefaultPermissionMode, settings.managedDefaultPermissionMode).mode)
      }
    }).catch((err) => {
      console.error('[Chat] Failed to load workspace settings:', err)
    })
  }, [activeWorkspaceId])
  React.useEffect(loadWorkspaceSettings, [loadWorkspaceSettings])
  // Reset UI state when workspace changes
  // This prevents stale search queries, focused items, and filter state from persisting
  const previousWorkspaceRef = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (!activeWorkspaceId) return

    const previousWorkspaceId = previousWorkspaceRef.current

    // Clear transient UI state only on workspace SWITCH (not initial mount)
    if (previousWorkspaceId !== null && previousWorkspaceId !== activeWorkspaceId) {
      // Clear search state
      setSearchActive(false)
      setSearchQuery('')

      // (The filter dropdown's own query state resets by remounting per workspace — see SessionFilterMenu key.)

      // Clear focused sidebar item
      setFocusedSidebarItemId(null)
    }

    // Load workspace-scoped state on BOTH initial mount AND workspace switch
    // This fixes CMD+R losing filters - previously only ran on workspace switch
    if (previousWorkspaceId !== activeWorkspaceId) {
      const newViewFilters = storage.get<ViewFiltersMap>(storage.KEYS.viewFilters, {}, activeWorkspaceId)
      setViewFiltersMap(newViewFilters)

      const newExpandedFolders = storage.get<string[]>(storage.KEYS.expandedFolders, [], activeWorkspaceId)
      setExpandedFolders(new Set(newExpandedFolders))

      const newCollapsedItems = storage.get<string[] | null>(storage.KEYS.collapsedSidebarItems, null, activeWorkspaceId)
      setCollapsedItems(newCollapsedItems !== null ? new Set(newCollapsedItems) : new Set(['nav:labels']))
    }

    previousWorkspaceRef.current = activeWorkspaceId
  }, [activeWorkspaceId])

  // Handle session source selection changes
  const handleSessionSourcesChange = React.useCallback(async (sessionId: string, sourceSlugs: string[]) => {
    try {
      await window.electronAPI.sessionCommand(sessionId, { type: 'setSources', sourceSlugs })
      // Session will emit a 'sources_changed' event that updates the session state
    } catch (err) {
      console.error('[Chat] Failed to set session sources:', err)
    }
  }, [])

  // Handle session label changes (add/remove via # menu or badge X)
  const handleSessionLabelsChange = React.useCallback(async (sessionId: string, labels: string[]) => {
    try {
      await window.electronAPI.sessionCommand(sessionId, { type: 'setLabels', labels })
      // Session will emit a 'labels_changed' event that updates the session state
    } catch (err) {
      console.error('[Chat] Failed to set session labels:', err)
    }
  }, [])


  // Load dynamic statuses from workspace config
  const { statuses: statusConfigs, isLoading: isLoadingStatuses } = useStatuses(activeWorkspace?.id || null)
  const [sessionStatuses, setSessionStatuses] = React.useState<SessionStatus[]>([])

  // Convert StatusConfig to SessionStatus with resolved icons
  React.useEffect(() => {
    if (!activeWorkspace?.id || statusConfigs.length === 0) {
      setSessionStatuses([])
      return
    }

    setSessionStatuses(statusConfigsToSessionStatuses(statusConfigs, activeWorkspace.id, isDark))
  }, [statusConfigs, activeWorkspace?.id, isDark])

  // Optimistic status order: immediately reflects drag-drop order while IPC propagates.
  // Cleared when statusConfigs changes (config watcher is source of truth).
  const [optimisticStatusOrder, setOptimisticStatusOrder] = React.useState<string[] | null>(null)

  // Clear optimistic state when the config watcher fires (statusConfigs changes)
  React.useEffect(() => {
    setOptimisticStatusOrder(null)
  }, [statusConfigs])

  // Derive effective todo states: apply optimistic reorder if active, otherwise use canonical order
  const effectiveSessionStatuses = React.useMemo(() => {
    if (!optimisticStatusOrder) return sessionStatuses
    // Reorder sessionStatuses array to match optimistic order
    const stateMap = new Map(sessionStatuses.map(s => [s.id, s]))
    const reordered: SessionStatus[] = []
    for (const id of optimisticStatusOrder) {
      const state = stateMap.get(id)
      if (state) reordered.push(state)
    }
    // Append any states not in the optimistic order (shouldn't happen, but defensive)
    for (const state of sessionStatuses) {
      if (!optimisticStatusOrder.includes(state.id)) reordered.push(state)
    }
    return reordered
  }, [sessionStatuses, optimisticStatusOrder])

  // Load labels from workspace config
  const { labels: labelConfigs, isLoaded: labelsLoaded, error: labelsError } = useLabels(activeWorkspace?.id || null)
  const displayLabelConfigs = useMemo(() => sortLabelsForDisplay(labelConfigs), [labelConfigs])

  // Views: compiled once on config load, evaluated per session in list/chat
  const { evaluateSession: evaluateViews, viewConfigs } = useViews(activeWorkspace?.id || null)

  // Build hierarchical label tree from the display-sorted label config structure
  const labelTree = useMemo(() => buildLabelTree(displayLabelConfigs), [displayLabelConfigs])

  // Ensure session messages are loaded when selected
  const ensureMessagesLoaded = useSetAtom(ensureSessionMessagesLoadedAtom)

  // Handle selecting a source from the list (preserves current filter type)
  const handleSourceSelect = React.useCallback((source: SafeSourceRow) => {
    if (!activeWorkspaceId) return
    navigateToSource(capabilityRouteId(source.key))
  }, [activeWorkspaceId, navigateToSource])

  const handleSourceListSkillSelect = React.useCallback((skill: SafeSkillRow) => {
    if (!activeWorkspaceId) return
    navigateToSource(sourceListSkillId(skill.key))
  }, [activeWorkspaceId, navigateToSource])

  // Handle selecting a skill from the list
  const handleSkillSelect = React.useCallback((skill: SafeSkillRow) => {
    if (!activeWorkspaceId) return
    navigate(routes.view.skills(capabilityRouteId(skill.key)))
  }, [activeWorkspaceId, navigate])

  // Handle selecting an automation from the list
  const handleAutomationSelect = React.useCallback((automationId: string) => {
    // Preserve current automation filter when selecting an automation
    const type = isAutomationsNavigation(navState) ? navState.filter?.automationType : undefined
    navigate(routes.view.automations({ automationId, type }))
  }, [navState, navigate])

  const openAutomations = useCallback(() => {
    navigate(routes.view.automations())
  }, [])

  // Focus zone management
  const { focusZone, focusNextZone, focusPreviousZone } = useFocusContext()

  // Register focus zones
  const { zoneRef: sidebarRef, isFocused: sidebarFocused } = useFocusZone({ zoneId: 'sidebar' })

  // Global keyboard shortcuts using centralized action registry
  // Actions are defined in @/actions/definitions.ts

  // Zone navigation - explicit keyboard intent, always move DOM focus
  useAction('nav.focusSidebar', () => focusZone('sidebar', { intent: 'keyboard' }))
  useAction('nav.focusNavigator', () => focusZone('navigator', { intent: 'keyboard' }))
  useAction('nav.focusChat', () => focusZone('chat', { intent: 'keyboard' }))

  // Tab navigation between zones
  useAction('nav.nextZone', () => {
    focusNextZone()
  }, { enabled: () => !document.querySelector('[role="dialog"]') })

  // Shift+Tab cycles permission mode through enabled modes — the ONE handler for it (D1.338: the composer reads Tab only for its open menus)
  // In multi-panel, targets the focused panel's session
  const effectiveSessionId = focusedSessionId ?? session.selected

  // Focus chat input for the target session only (multi-panel safe).
  const focusChatInputForSession = useCallback((targetSessionId?: string | null) => {
    if (!targetSessionId) return
    dispatchFocusInputEvent({ sessionId: targetSessionId })
  }, [])

  useAction('chat.cyclePermissionMode', () => {
    if (effectiveSessionId) {
      const currentOptions = contextValue.sessionOptions.get(effectiveSessionId)
      const currentMode = currentOptions?.permissionMode ?? 'default'
      const composerCapabilities = sessionMetaMap.get(effectiveSessionId)?.composerCapabilities
      // F1.1052: the picker's own list in its order (Auto, Manual, Accept edits,
      // Plan, Bypass permissions) — with no capabilities yet too, where this fell
      // back to the whole strictness order and so could reach the hidden `dontAsk`.
      const capabilityModes = getVisibleComposerPermissionModes(composerCapabilities)
      const workspaceModes = resolveWorkspaceCyclablePermissionModes(enabledModes)
      const intersectedModes = capabilityModes.filter(mode => workspaceModes.includes(mode))
      const modes = intersectedModes.length >= 2 ? intersectedModes : capabilityModes
      // A mode outside the ring (dontAsk, or one the workspace left out) steps to
      // Manual first, never to a coerced mode's neighbour (`nextCyclePermissionMode`).
      const nextMode = nextCyclePermissionMode(currentMode, modes)
      if (!nextMode) return
      // (the old coerce-then-step read Plan → Bypass permissions from dontAsk)
      contextValue.onSessionOptionsChange(effectiveSessionId, { permissionMode: nextMode })
    }
  })

  // UB14.4 (v0.15.1): whether the next sidebar/list show-hide animates — pointer toggles glide (FLIP),
  // keyboard toggles (⌘B, ⌘., menu accelerators) are instant. Set in the same batch as the toggle.
  const [animateShellLayout, setAnimateShellLayout] = React.useState(true)

  const handleToggleSidebar = useCallback(() => {
    if (isSidebarAndNavigatorHidden) {
      setIsSidebarAndNavigatorHidden(false)
      return
    }
    setIsSidebarVisible(v => !v)
  }, [isSidebarAndNavigatorHidden])

  const handleToggleSidebarFromPointer = useCallback(() => {
    setAnimateShellLayout(true)
    handleToggleSidebar()
  }, [handleToggleSidebar])

  const handleToggleFocusModeFromPointer = useCallback(() => {
    setAnimateShellLayout(true)
    setIsSidebarAndNavigatorHidden(v => !v)
  }, [])

  // Sidebar toggle (CMD+B)
  useAction('view.toggleSidebar', () => {
    setAnimateShellLayout(false)
    handleToggleSidebar()
  })

  // Focus mode toggle (CMD+.) - hides both sidebars
  useAction('view.toggleFocusMode', () => {
    setAnimateShellLayout(false)
    setIsSidebarAndNavigatorHidden(v => !v)
  })

  // Panel focus navigation (CMD+SHIFT+[ / ])
  const focusNextPanel = useSetAtom(focusNextPanelAtom)
  const focusPrevPanel = useSetAtom(focusPrevPanelAtom)
  useAction('panel.focusNext', focusNextPanel, { enabled: () => panelCount > 1 })
  useAction('panel.focusPrev', focusPrevPanel, { enabled: () => panelCount > 1 })

  // New chat
  useAction('app.newChat', () => handleNewChat())
  useAction('app.newChatInPanel', () => handleNewChat(true))

  // Settings
  useAction('app.settings', onOpenSettings)

  // Keyboard shortcuts
  useAction('app.keyboardShortcuts', onOpenKeyboardShortcuts)

  // New window
  useAction('app.newWindow', () => window.electronAPI.menuNewWindow())

  // Quit (note: also handled by native menu on macOS)
  useAction('app.quit', () => window.electronAPI.menuQuit())

  // History navigation
  useAction('nav.goBack', goBack)
  useAction('nav.goForward', goForward)

  // History navigation (arrow key alternatives)
  useAction('nav.goBackAlt', goBack)
  useAction('nav.goForwardAlt', goForward)

  // Search match navigation (CMD+G next, CMD+SHIFT+G prev)
  useAction('chat.nextSearchMatch', () => chatDisplayRef.current?.goToNextMatch(), {
    enabled: () => searchActive && (chatMatchInfo.count ?? 0) > 0
  })
  useAction('chat.prevSearchMatch', () => chatDisplayRef.current?.goToPrevMatch(), {
    enabled: () => searchActive && (chatMatchInfo.count ?? 0) > 0
  })

  // ESC to stop processing - requires double-press within 1 second
  // First press shows warning overlay, second press interrupts
  // In multi-panel, targets the focused panel's session
  useAction('chat.stopProcessing', () => {
    if (effectiveSessionId) {
      const meta = sessionMetaMap.get(effectiveSessionId)
      if (meta?.isProcessing) {
        // handleEscapePress returns true on second press (within timeout)
        if (handleEscapePress()) {
          window.electronAPI.cancelProcessing(effectiveSessionId, false).catch(err => {
            console.error('[AppShell] Failed to cancel processing:', err)  // D1.377 — and it must not LOOK like a Stop that worked:
            toast.error(t('chat.submit.stopFailed'), { description: err instanceof Error ? err.message : t('toast.unknownError') })
          })
        }
      }
    }
  }, {
    // Only active when no overlay is open and session is processing
    // Overlays (dialogs, menus, popovers, etc.) should handle their own Escape
    enabled: () => {
      if (hasOpenOverlay()) return false
      if (!effectiveSessionId) return false
      const meta = sessionMetaMap.get(effectiveSessionId)
      return meta?.isProcessing ?? false
    }
  }, [effectiveSessionId, handleEscapePress])

  // Theme toggle (CMD+SHIFT+A)
  useAction('app.toggleTheme', () => setMode(resolvedMode === 'dark' ? 'light' : 'dark'))

  // Global paste listener for file attachments
  // Fires when Cmd+V is pressed anywhere in the app (not just textarea)
  React.useEffect(() => {
    const handleGlobalPaste = (e: ClipboardEvent) => {
      // Skip if a dialog or menu is open
      if (document.querySelector('[role="dialog"], [role="menu"]')) {
        return
      }

      // Skip if there are no files in the clipboard
      const files = e.clipboardData?.files
      if (!files || files.length === 0) return

      // Skip if the active element is an input/textarea/contenteditable (let it handle paste directly)
      const activeElement = document.activeElement as HTMLElement | null
      if (
        activeElement?.tagName === 'TEXTAREA' ||
        activeElement?.tagName === 'INPUT' ||
        activeElement?.isContentEditable
      ) {
        return
      }

      // Prevent default paste behavior
      e.preventDefault()

      // Dispatch custom event for FreeFormInput to handle (target focused session only)
      const filesArray = Array.from(files)
      const targetSessionId = focusedSessionId ?? session.selected
      if (!targetSessionId) return
      window.dispatchEvent(new CustomEvent('nessy:paste-files', {
        detail: { files: filesArray, sessionId: targetSessionId }
      }))
    }

    document.addEventListener('paste', handleGlobalPaste)
    return () => document.removeEventListener('paste', handleGlobalPaste)
  }, [focusedSessionId, session.selected])

  // Resize effect for sidebar, session list, browser host lane, and metadata right sidebar.
  React.useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      if (isResizing === 'sidebar') {
        const newWidth = Math.min(Math.max(e.clientX, 180), 320)
        setSidebarWidth(newWidth)
        if (resizeHandleRef.current) {
          const rect = resizeHandleRef.current.getBoundingClientRect()
          setSidebarHandleY(e.clientY - rect.top)
        }
      } else if (isResizing === 'session-list') {
        const offset = isSidebarVisible ? sidebarWidth : 0
        const newWidth = Math.min(Math.max(e.clientX - offset, 240), 480)
        setSessionListWidth(newWidth)
        if (sessionListHandleRef.current) {
          const rect = sessionListHandleRef.current.getBoundingClientRect()
          setSessionListHandleY(e.clientY - rect.top)
        }
      }
    }

    const handleMouseUp = () => {
      if (isResizing === 'sidebar') {
        storage.set(storage.KEYS.sidebarWidth, sidebarWidth)
        setSidebarHandleY(null)
      } else if (isResizing === 'session-list') {
        storage.set(storage.KEYS.sessionListWidth, sessionListWidth)
        setSessionListHandleY(null)
      }
      setIsResizing(null)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [
    isResizing,
    sidebarWidth,
    sessionListWidth,
    isSidebarVisible,
  ])

  // Spring transition config - shared between sidebar and header
  // Critical damping (no bounce): damping = 2 * sqrt(stiffness * mass)
  const springTransition = {
    type: "spring" as const,
    stiffness: 600,
    damping: 49,
  }

  // Use session metadata from Jotai atom (lightweight, no messages)
  // This prevents closures from retaining full message arrays
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)
  const setSessionMetaMap = useSetAtom(sessionMetaMapAtom)

  const hasPendingPrompt = React.useCallback((sessionId: string) => {
    return (pendingPermissions.get(sessionId)?.length ?? 0) > 0
  }, [pendingPermissions])

  // Workspace-level unread indicators (needed for workspace selectors across all workspaces)
  const [workspaceUnreadMap, setWorkspaceUnreadMap] = useState<Record<string, boolean>>({})

  const activeSessionWorkingDirectory = session.selected
    ? sessionMetaMap.get(session.selected)?.workingDirectory
    : undefined
  // The session's runtime is part of what decides its slash-command list: the
  // bundled `loop` skill is withheld wherever its cron tools are not mounted.
  // The server has always applied that; the renderer never asked again after a
  // mid-session switch, so the pre-switch list stayed on screen and `/loop`
  // remained offered on a runtime that cannot honour it — measured live as
  // RTS-11 on packaged 1.26.1.
  //
  // P2.295 — the parenthetical here said "(they are `visibility: 'pi-only'`)",
  // and that has been false since T1/T3: `CronCreate`, `CronList`, `CronDelete`
  // and `ScheduleWakeup` carry no `visibility` at all, so they are projected
  // onto every runtime. The condition is `cronToolsAbsentFor` and the membership
  // is `SCHEDULED_DELIVERY_RUNTIMES` (pi, anthropic, codex-runtime), so the
  // runtime this actually withholds for is `nestor-cloud-agent` — the one member
  // of `AgentProvider` outside that set, which runs no host-side tool loop for a
  // scheduled fire to wake. Read the predicate, not this comment, for the
  // membership; the fuller account, including why codex's membership is
  // CONDITIONAL on its callback bridge having started, is at the filter itself in
  // `server-core/src/handlers/rpc/capabilities.ts`.
  //
  // This was the SEVENTH site of that dead claim, found only because another
  // lane happened to read this file — P2.211 swept six and this one was in the
  // renderer, where none of its searches looked. The class was measured
  // unguardable by a prose scanner (23 of 31 false positives, 0 of 6 caught), so
  // the answer is not a better grep: it is P2.291's enumerating-doc guard,
  // extended to wherever the renderer states per-runtime truth as a value.
  const activeSessionConnection = session.selected
    ? sessionMetaMap.get(session.selected)?.llmConnection
    : undefined
  const capabilityContextRef = React.useMemo(
    () => activeWorkspaceId ? capabilityContext(activeWorkspaceId, session.selected) : undefined,
    [activeWorkspaceId, session.selected],
  )
  const capabilityRequestRef = React.useRef(0)
  const refreshCapabilityViews = React.useCallback(async () => {
    const requestId = ++capabilityRequestRef.current
    if (!activeWorkspaceId) {
      setCapabilityCatalog(null)
      setComposerCatalog(null)
      return
    }
    try {
      const context = capabilityContext(activeWorkspaceId, session.selected)
      let [user, composer] = await Promise.all([
        window.electronAPI.capabilities.getCatalog(context),
        window.electronAPI.capabilities.getComposerCatalog(context),
      ])
      if (user.generation !== composer.generation) {
        ;[user, composer] = await Promise.all([
          window.electronAPI.capabilities.getCatalog(context),
          window.electronAPI.capabilities.getComposerCatalog(context),
        ])
      }
      if (user.generation !== composer.generation) throw new Error('Capability views changed during refresh')
      if (capabilityRequestRef.current !== requestId) return
      setCapabilityCatalog(user)
      setComposerCatalog(composer)
    } catch (err) {
      if (capabilityRequestRef.current !== requestId) return
      console.error('[Chat] Failed to load capability views:', err)
      setCapabilityCatalog(null)
      setComposerCatalog(null)
    }
  // The safe request is session-keyed, but the server resolves project-scoped
  // capabilities from that session's current working directory. Recreate this
  // callback when the directory changes so the effect above refreshes the
  // composer immediately instead of waiting for a reload/navigation event.
  }, [activeSessionWorkingDirectory, activeWorkspaceId, session.selected])

  React.useEffect(() => {
    void refreshCapabilityViews()
  }, [refreshCapabilityViews])

  const refreshCustomSlashCommands = React.useCallback(async () => {
    if (!activeWorkspaceId || !session.selected) {
      setCustomSlashCommands([])
      return
    }

    try {
      const loaded = await window.electronAPI.listCustomSlashCommands({
        workspaceId: activeWorkspaceId,
        sessionId: session.selected,
      })
      setCustomSlashCommands(loaded || [])
    } catch (err) {
      console.error('[Chat] Failed to load custom slash commands:', err)
      setCustomSlashCommands([])
    }
  }, [activeWorkspaceId, session.selected])

  const refreshPluginState = refreshCapabilityViews

  React.useEffect(() => {
    if (!activeWorkspaceId) return
    return window.electronAPI.capabilities.onChanged((event) => {
      const refreshed = refreshCapabilityDependentsOnChange(
        event,
        { workspaceId: activeWorkspaceId, sessionId: session.selected },
        {
          refreshCapabilityViews,
          refreshCustomSlashCommands,
          invalidateMarketplaceQueries: () => invalidateMarketplaceQueries(queryClient),
        },
      )
      // `plugins/loading.md#when-auto-update-runs` — "If any plugins were updated, you'll see a
      // notification prompting you to run `/reload-plugins`, or the new versions
      // load on your next launch." This fork has no `/reload-plugins`; the
      // equivalent action is Plugins → Refresh runtime, which the notice names.
      // Keyed on the reason code so an interactive mutation the user just made
      // never toasts at them.
      if (refreshed && event.reasonCode === MARKETPLACE_AUTO_UPDATE_REASON_CODE) {
        toast.info(t('plugins.autoUpdateNoticeTitle'), { description: t('plugins.autoUpdateNoticeBody') })
      }
    })
  }, [activeWorkspaceId, queryClient, refreshCapabilityViews, refreshCustomSlashCommands, session.selected, t])

  React.useEffect(() => {
    if (navState.navigator !== 'sources' && navState.navigator !== 'skills' && navState.navigator !== 'plugins') {
      return
    }
    void refreshCapabilityViews()
  }, [navState.navigator, refreshCapabilityViews])

  React.useEffect(() => {
    void refreshCustomSlashCommands()
  }, [activeSessionWorkingDirectory, activeSessionConnection, refreshCustomSlashCommands])

  // Filter session metadata by active workspace
  // Also exclude hidden sessions (mini-agent sessions) from all counts and lists
  // For remote workspaces, sessions have the remote workspace ID (not the local one),
  // so we match against both the local and remote workspace IDs.
  const remoteWorkspaceId = activeWorkspace?.remoteServer?.remoteWorkspaceId
  const workspaceSessionMetas = useMemo(() => {
    const metas = Array.from(sessionMetaMap.values())
    if (!activeWorkspaceId) return metas.filter(s => !s.hidden)
    return metas.filter(s =>
      !s.hidden && (s.workspaceId === activeWorkspaceId || (remoteWorkspaceId && s.workspaceId === remoteWorkspaceId))
    )
  }, [sessionMetaMap, activeWorkspaceId, remoteWorkspaceId])

  // Active sessions exclude archived - use this for all counts and filters except archived view
  const activeSessionMetas = useMemo(() => {
    return workspaceSessionMetas.filter(s => !s.isArchived)
  }, [workspaceSessionMetas])

  const refreshWorkspaceUnreadMap = useCallback(async () => {
    try {
      const summary = await window.electronAPI.getUnreadSummary()
      const next: Record<string, boolean> = {}

      for (const workspace of workspaces) {
        next[workspace.id] = !!summary.hasUnreadByWorkspace[workspace.id]
      }

      setWorkspaceUnreadMap(next)
    } catch (error) {
      console.error('[AppShell] Failed to refresh workspace unread indicators:', error)
    }
  }, [workspaces])

  // Initial + workspace-list refresh
  useEffect(() => {
    void refreshWorkspaceUnreadMap()
  }, [refreshWorkspaceUnreadMap])

  // Keep active workspace unread indicator in sync with live metadata updates
  useEffect(() => {
    if (!activeWorkspaceId) return
    const activeHasUnread = activeSessionMetas.some((session) => !!session.hasUnread)
    setWorkspaceUnreadMap((prev) => ({ ...prev, [activeWorkspaceId]: activeHasUnread }))
  }, [activeWorkspaceId, activeSessionMetas])

  // Keep cross-workspace indicators in sync with global unread updates from main process
  useEffect(() => {
    const cleanup = window.electronAPI.onUnreadSummaryChanged((summary) => {
      const next: Record<string, boolean> = {}
      for (const workspace of workspaces) {
        next[workspace.id] = !!summary.hasUnreadByWorkspace[workspace.id]
      }
      setWorkspaceUnreadMap(next)
    })

    return cleanup
  }, [workspaces])

  // Count sessions by todo state (scoped to workspace)
  const isMetaDone = (s: SessionMeta) => s.sessionStatus === 'done' || s.sessionStatus === 'cancelled'
  const flaggedCount = activeSessionMetas.filter(s => s.isFlagged).length
  const archivedCount = workspaceSessionMetas.filter(s => s.isArchived).length

  // Compute session counts per label (cumulative: parent includes descendants).
  // Uses activeSessionMetas to exclude archived sessions from counts.
  //
  // F1.357 — each chat is counted ONCE per label, over the SAME rule the
  // 'label' filter lists by. This block used to set a direct count in one pass
  // and then ADD a descendant count over an overlapping set in a second
  // (inherited verbatim from craft-agents-oss v0.13.4), so a chat tagged both
  // `parent` and `parent/child` scored 2 on the parent while the list under it
  // showed that chat once — the badge and the list it labels disagreed.
  //
  // `countSessionsPerLabel` (lib/label-session-counts.ts) counts every chat
  // against `matchesLabelFilter` (@nessy-agent/shared/labels, F1.353): the
  // label plus its descendants, valued entries such as "priority::3" by base
  // id. That is the predicate useSessionSearch and NavigationContext filter by
  // too, and the 'label' branch of filteredSessionMetas below routes through it
  // as well (UA12.13 retired its inline union) — so a count here is a count of
  // the rows a click on that label lists.
  //
  // Residue, stated: the SECONDARY include/exclude label filter narrows the
  // list and not these counts, as before — a badge counts the label's chats,
  // not the chats the current secondary filter would still show.
  const labelCounts = useMemo(
    () => countSessionsPerLabel(activeSessionMetas, labelConfigs),
    [activeSessionMetas, labelConfigs],
  )

  // Count sessions by individual todo state (dynamic based on effectiveSessionStatuses)
  // Uses activeSessionMetas to exclude archived sessions from counts.
  const sessionStatusCounts = useMemo(() => {
    const counts: Record<SessionStatusId, number> = {}
    // Initialize counts for all dynamic statuses
    for (const state of effectiveSessionStatuses) {
      counts[state.id] = 0
    }
    // Count sessions
    for (const s of activeSessionMetas) {
      const state = (s.sessionStatus || 'todo') as SessionStatusId
      // Increment count (initialize to 0 if status not in effectiveSessionStatuses yet)
      counts[state] = (counts[state] || 0) + 1
    }
    return counts
  }, [activeSessionMetas, effectiveSessionStatuses])

  // Count sources by type for the Sources dropdown subcategories. The MCP
  // figure counts the rows the MCP panel renders — built-ins included — so the
  // label and the list it labels cannot disagree.
  const sourceTypeCounts = useMemo(() => sourceNavigationCounts({
    sources,
    skills,
    ...(capabilityCatalog?.installedPlugins ? { installedPlugins: capabilityCatalog.installedPlugins } : {}),
    builtinDp: builtinDpMcp.view,
  }), [builtinDpMcp.view, capabilityCatalog, skills, sources])

  // Count automations by type for the Automations dropdown subcategories
  const automationTypeCounts = useMemo(() => {
    const counts = { scheduled: 0, event: 0, agentic: 0 }
    for (const automation of automations) {
      if (automation.event === 'SchedulerTick') counts.scheduled++
      else if ((APP_EVENTS as string[]).includes(automation.event)) counts.event++
      else if ((AGENT_EVENTS as string[]).includes(automation.event)) counts.agentic++
    }
    return counts
  }, [automations])

  // Filter session metadata based on sidebar mode and chat filter
  const filteredSessionMetas = useMemo(() => {
    // When in sources mode, return empty (no sessions to show)
    if (!sessionFilter) {
      return []
    }

    let result: SessionMeta[]

    switch (sessionFilter.kind) {
      case 'allSessions':
        // "All Sessions" - shows active (non-archived) sessions
        result = activeSessionMetas
        break
      case 'flagged':
        result = activeSessionMetas.filter(s => s.isFlagged)
        break
      case 'archived':
        // Archived view shows only archived sessions
        result = workspaceSessionMetas.filter(s => s.isArchived)
        break
      case 'state':
        // Filter by specific todo state (excludes archived)
        result = activeSessionMetas.filter(s => (s.sessionStatus || 'todo') === sessionFilter.stateId)
        break
      case 'label': {
        if (sessionFilter.labelId === '__all__') {
          // "Labels" header: show all active sessions that have at least one label
          result = activeSessionMetas.filter(s => s.labels && s.labels.length > 0)
        } else {
          // Specific label: tagged with this label or any descendant — THE single
          // predicate (F1.353) that the list, the auto-select and the badge counts
          // read (UA12.13 retired the hand-built {label, …descendants} union).
          result = activeSessionMetas.filter(
            s => matchesLabelFilter(s, { labelId: sessionFilter.labelId }, labelConfigs)
          )
        }
        break
      }
      case 'view': {
        // Filter by view: __all__ shows any session matched by any view,
        // otherwise filter to the specific view (excludes archived)
        result = activeSessionMetas.filter(s => {
          const matched = evaluateViews(s)
          if (sessionFilter.viewId === '__all__') {
            return matched.length > 0
          }
          return matched.some(v => v.id === sessionFilter.viewId)
        })
        break
      }
      default:
        result = activeSessionMetas
    }

    // Apply secondary filters (status + labels, AND-ed together) in ALL views.
    // These layer on top of the primary sessionFilter to allow further narrowing.
    // Each filter supports include/exclude modes:
    //   - Includes: if any exist, only matching items pass
    //   - Excludes: matching items are removed (applied after includes)
    if (listFilter.size > 0) {
      const statusIncludes = new Set<SessionStatusId>()
      const statusExcludes = new Set<SessionStatusId>()
      for (const [id, mode] of listFilter) {
        if (mode === 'include') statusIncludes.add(id)
        else statusExcludes.add(id)
      }
      if (statusIncludes.size > 0) {
        result = result.filter(s => statusIncludes.has((s.sessionStatus || 'todo') as SessionStatusId))
      }
      if (statusExcludes.size > 0) {
        result = result.filter(s => !statusExcludes.has((s.sessionStatus || 'todo') as SessionStatusId))
      }
    }
    // Filter by labels — supports include/exclude with descendant expansion
    if (labelFilter.size > 0) {
      const labelIncludes = new Set<string>()
      const labelExcludes = new Set<string>()
      for (const [id, mode] of labelFilter) {
        // Expand to include descendant label IDs — UA12.154: an id no config carries (a deleted label) matches nothing, never blanks the list
        const ids = expandLabelFilterIds(labelConfigs, id)
        for (const expandedId of ids) {
          if (mode === 'include') labelIncludes.add(expandedId)
          else labelExcludes.add(expandedId)
        }
      }
      if (labelIncludes.size > 0) {
        result = result.filter(s =>
          s.labels?.some(l => labelIncludes.has(extractLabelId(l)))
        )
      }
      if (labelExcludes.size > 0) {
        result = result.filter(s =>
          !s.labels?.some(l => labelExcludes.has(extractLabelId(l)))
        )
      }
    }

    return result
  }, [workspaceSessionMetas, activeSessionMetas, sessionFilter, listFilter, labelFilter, labelConfigs])

  // Derive "pinned" (non-removable) filters from the current sessionFilter path.
  // These represent filters that are implicit in the current deeplink/route and
  // should be displayed as fixed chips in the filter bar that users cannot remove.
  const pinnedFilters = useMemo(() => {
    if (!sessionFilter) return { pinnedStatusId: null as string | null, pinnedLabelId: null as string | null, pinnedFlagged: false }
    switch (sessionFilter.kind) {
      case 'state':
        return { pinnedStatusId: sessionFilter.stateId, pinnedLabelId: null, pinnedFlagged: false }
      case 'label':
        // Don't pin the __all__ pseudo-label — that just means "any label"
        return { pinnedStatusId: null, pinnedLabelId: sessionFilter.labelId !== '__all__' ? sessionFilter.labelId : null, pinnedFlagged: false }
      case 'flagged':
        return { pinnedStatusId: null, pinnedLabelId: null, pinnedFlagged: true }
      default:
        return { pinnedStatusId: null, pinnedLabelId: null, pinnedFlagged: false }
    }
  }, [sessionFilter])

  // Ensure session messages are loaded when selected
  React.useEffect(() => {
    if (session.selected) {
      ensureMessagesLoaded(session.selected)
    }
  }, [session.selected, ensureMessagesLoaded])

  // Wrap delete handler to clear selection when deleting the currently selected session
  // This prevents stale state during re-renders that could cause crashes
  const handleDeleteSession = useCallback(async (sessionId: string, skipConfirmation?: boolean): Promise<boolean> => {
    // Clear selection first if this is the selected session
    if (session.selected === sessionId) {
      setSession({ selected: null })
    }
    return onDeleteSession(sessionId, skipConfirmation)
  }, [session.selected, setSession, onDeleteSession])
  const handleJumpToTaskSessions = useCallback((sessionId: string, scope: TaskSessionsScope) => { setViewFiltersMap(prev => withTaskScopeFilters(prev, scope)); navigate(routes.view.allSessions(sessionId)) }, []) // UA5.10 (v0.13.4 L795–L817): the board's scoped jump — task-scope-filters.ts; one line, so the cited lines keep their numbers
  // Extend context value with local overrides (wrapped onDeleteSession, sources, skills, labels, enabledModes, rightSidebarOpenButton, effectiveSessionStatuses)
  const appShellContextValue = React.useMemo<AppShellContextType>(() => ({
    ...contextValue,
    onDeleteSession: handleDeleteSession,
    enabledSources: composerSources,
    capabilityContext: capabilityContextRef,
    capabilityCatalog,
    composerCatalog,
    // Shared, never re-read: the nav count, the MCP list, the Sources row
    // menus and the source detail page all take the built-in set from here.
    builtinDpMcp,
    refreshPluginState,
    skills: composerSkills,
    customSlashCommands,
    agents,
    activeSessionWorkingDirectory,
    labels: displayLabelConfigs,
    onSessionLabelsChange: handleSessionLabelsChange, onJumpToTaskSessions: handleJumpToTaskSessions, // UA5.10 (v0.13.4 L1711)
    enabledModes, defaultPermissionMode, onWorkspaceSettingsChanged: loadWorkspaceSettings,
    sessionStatuses: effectiveSessionStatuses,
    onSessionSourcesChange: handleSessionSourcesChange,
    openAutomations,
    rightSidebarButton: null,
    isCompactMode: isAutoCompact,
    // Search state for ChatDisplay highlighting
    sessionListSearchQuery: searchActive ? searchQuery : undefined,
    isSearchModeActive: searchActive,
    chatDisplayRef,
    onChatMatchInfoChange: handleChatMatchInfoChange,
    onTestAutomation: handleTestAutomation,
    onToggleAutomation: handleToggleAutomation,
    onDuplicateAutomation: handleDuplicateAutomation,
    onDeleteAutomation: handleDeleteAutomation,
    automationTestResults,
    getAutomationHistory,
    onReplayAutomation: handleReplayAutomation,
  }), [contextValue, handleDeleteSession, composerSources, capabilityContextRef, capabilityCatalog, composerCatalog, builtinDpMcp, refreshPluginState, composerSkills, customSlashCommands, agents, activeSessionWorkingDirectory, displayLabelConfigs, handleSessionLabelsChange, enabledModes, defaultPermissionMode, loadWorkspaceSettings, effectiveSessionStatuses, handleSessionSourcesChange, openAutomations, isAutoCompact, searchActive, searchQuery, handleChatMatchInfoChange, handleTestAutomation, handleToggleAutomation, handleDuplicateAutomation, handleDeleteAutomation, automationTestResults, getAutomationHistory, handleReplayAutomation, handleJumpToTaskSessions])

  // Persist expanded folders to localStorage (workspace-scoped)
  React.useEffect(() => {
    if (!activeWorkspaceId) return
    storage.set(storage.KEYS.expandedFolders, [...expandedFolders], activeWorkspaceId)
  }, [expandedFolders, activeWorkspaceId])

  // Persist sidebar visibility to localStorage
  React.useEffect(() => {
    storage.set(storage.KEYS.sidebarVisible, isSidebarVisible)
  }, [isSidebarVisible])

  // Persist focus mode state to localStorage
  React.useEffect(() => {
    storage.set(storage.KEYS.focusModeEnabled, isSidebarAndNavigatorHidden)
  }, [isSidebarAndNavigatorHidden])

  // Listen for focus mode toggle from menu (View → Focus Mode)
  React.useEffect(() => {
    const cleanup = window.electronAPI.onMenuToggleFocusMode?.(() => {
      setAnimateShellLayout(false)
      setIsSidebarAndNavigatorHidden(v => !v)
    })
    return cleanup
  }, [])

  // Listen for sidebar toggle from menu (View → Toggle Sidebar)
  React.useEffect(() => {
    const cleanup = window.electronAPI.onMenuToggleSidebar?.(() => {
      setAnimateShellLayout(false)
      handleToggleSidebar()
    })
    return cleanup
  }, [handleToggleSidebar])

  // Persist per-view filter map to localStorage (workspace-scoped)
  React.useEffect(() => {
    if (!activeWorkspaceId) return
    storage.set(storage.KEYS.viewFilters, viewFiltersMap, activeWorkspaceId)
  }, [viewFiltersMap, activeWorkspaceId])

  // Persist sidebar section collapsed states (workspace-scoped)
  React.useEffect(() => {
    if (!activeWorkspaceId) return
    storage.set(storage.KEYS.collapsedSidebarItems, [...collapsedItems], activeWorkspaceId)
  }, [collapsedItems, activeWorkspaceId])

  const handleAllSessionsClick = useCallback(() => {
    navigate(routes.view.allSessions())
  }, [])

  const handleFlaggedClick = useCallback(() => {
    navigate(routes.view.flagged())
  }, [])

  const handleArchivedClick = useCallback(() => {
    navigate(routes.view.archived())
  }, [])

  // Handler for individual todo state views
  const handleSessionStatusClick = useCallback((stateId: SessionStatusId) => {
    navigate(routes.view.state(stateId))
  }, [])

  // Handler for label filter views (hierarchical — includes descendant labels)
  const handleLabelClick = useCallback((labelId: string) => {
    navigate(routes.view.label(labelId))
  }, [])

  const handleViewClick = useCallback((viewId: string) => {
    navigate(routes.view.view(viewId))
  }, [])

  // DnD handler: reorder statuses (flat list drag-and-drop)
  // Sets optimistic order immediately for instant UI feedback, then fires IPC.
  const handleStatusReorder = useCallback((orderedIds: string[]) => {
    if (!activeWorkspaceId) return
    setOptimisticStatusOrder(orderedIds)
    window.electronAPI.reorderStatuses(activeWorkspaceId, orderedIds)
  }, [activeWorkspaceId])

  // Handler for sources view (all sources)
  const handleSourcesClick = useCallback(() => {
    navigate(routes.view.sources())
  }, [])

  // Handlers for source type filter views (subcategories in Sources dropdown)
  const handleSourcesApiClick = useCallback(() => {
    navigate(routes.view.sourcesApi())
  }, [])

  const handleSourcesMcpClick = useCallback(() => {
    navigate(routes.view.sourcesMcp())
  }, [])

  const handleSourcesLocalClick = useCallback(() => {
    navigate(routes.view.sourcesLocal())
  }, [])

  // Plugins management subsection under Sources (U4)
  const handleSourcesPluginsClick = useCallback(() => {
    navigate(routes.view.sourcesPlugins())
  }, [])

  const handleSourcesHooksClick = useCallback(() => {
    navigate(routes.view.sourcesHooks())
  }, [])

  // Handler for skills view
  const handleSkillsClick = useCallback(() => {
    navigate(routes.view.skills())
  }, [])

  // Handlers for automations view
  const handleAutomationsClick = openAutomations

  const handleAutomationsScheduledClick = useCallback(() => {
    navigate(routes.view.automationsScheduled())
  }, [])

  const handleAutomationsEventClick = useCallback(() => {
    navigate(routes.view.automationsEvent())
  }, [])

  const handleAutomationsAgenticClick = useCallback(() => {
    navigate(routes.view.automationsAgentic())
  }, [])

  // Handler for settings view. With no arg → bare `settings` route (navigator-only
  // in compact mode, App fallback on desktop). With an arg → `settings/<subpage>`.
  const handleSettingsClick = useCallback((subpage?: SettingsSubpage) => {
    navigate(routes.view.settings(subpage))
  }, [])

  const handlePluginsClick = useCallback(() => {
    navigate(routes.view.plugins())
  }, [])

  // Handler for What's New overlay
  const handleWhatsNewClick = useCallback(async () => {
    const content = await window.electronAPI.getReleaseNotes()
    setReleaseNotesContent(content)
    setShowWhatsNew(true)
    setHasUnseenReleaseNotes(false)
    // Update last seen version
    const latestVersion = await window.electronAPI.getLatestReleaseVersion()
    if (latestVersion) {
      storage.set(storage.KEYS.whatsNewLastSeenVersion, latestVersion)
    }
  }, [])

  // ============================================================================
  // EDIT POPOVER STATE
  // ============================================================================
  // State to control which EditPopover is open (triggered from context menus).
  // We use controlled popovers instead of deep links so the user can type
  // their request in the popover UI before opening a new chat window.
  // add-source variants: add-source (generic), add-source-api, add-source-mcp, add-source-local
  // add-automation variants: add-automation (generic), add-automation-scheduled, add-automation-event, add-automation-agentic
  const [editPopoverOpen, setEditPopoverOpen] = useState<AppShellEditPopoverKey | null>(null)

  // Stores the Y position of the last right-clicked sidebar item so the EditPopover
  // appears near it rather than at a fixed location. Updated synchronously before
  // the setTimeout that opens the popover, ensuring the ref is set before render.
  const editPopoverAnchorY = useRef<number>(120)
  // Tracks which label was right-clicked when opening label EditPopovers,
  // so the agent knows the target for commands like "make this red" or "add below this"
  const editLabelTargetId = useRef<string | undefined>(undefined)

  // Stores the trigger element (button) so we can keep it highlighted while the
  // EditPopover is open (after Radix removes data-state="open" on context menu close).
  const editPopoverTriggerRef = useRef<Element | null>(null)

  // Captures the bounding rect of the currently-open context menu trigger (the button).
  // Radix sets data-state="open" on the button (via ContextMenuTrigger asChild)
  // while the menu is visible, so we can locate it in the DOM at click time.
  const captureContextMenuPosition = useCallback(() => {
    const trigger = document.querySelector('.group\\/section > [data-state="open"]')
    if (trigger) {
      const rect = trigger.getBoundingClientRect()
      editPopoverAnchorY.current = rect.top
      editPopoverTriggerRef.current = trigger
    }
  }, [])

  // Sync data-edit-active attribute on the trigger element with EditPopover open state.
  // This keeps the sidebar item visually highlighted while the popover is shown,
  // since Radix's data-state="open" disappears when the context menu closes.
  useEffect(() => {
    const el = editPopoverTriggerRef.current
    if (!el) return
    if (editPopoverOpen) {
      el.setAttribute('data-edit-active', 'true')
    } else {
      el.removeAttribute('data-edit-active')
      editPopoverTriggerRef.current = null
    }
  }, [editPopoverOpen])

  // Handler for "Configure Statuses" context menu action
  // Opens the EditPopover for status configuration
  // Uses setTimeout to delay opening until after context menu closes,
  // preventing the popover from immediately closing due to focus shift
  const openConfigureStatuses = useCallback(() => {
    captureContextMenuPosition()
    setTimeout(() => setEditPopoverOpen('statuses'), 50)
  }, [captureContextMenuPosition])

  // Handler for "Configure Labels" context menu action
  // Opens the EditPopover for label configuration, storing which label was right-clicked
  const openConfigureLabels = useCallback((labelId?: string) => {
    editLabelTargetId.current = labelId
    captureContextMenuPosition()
    setTimeout(() => setEditPopoverOpen('labels'), 50)
  }, [captureContextMenuPosition])

  // Handler for "Edit Views" context menu action
  // Opens the EditPopover for view configuration
  const openConfigureViews = useCallback(() => {
    captureContextMenuPosition()
    setTimeout(() => setEditPopoverOpen('views'), 50)
  }, [captureContextMenuPosition])

  // Handler for "Delete View" context menu action
  // Removes the view from config by filtering it out and saving
  const handleDeleteView = useCallback(async (viewId: string) => {
    if (!activeWorkspace?.id) return
    try {
      const updated = viewConfigs.filter(v => v.id !== viewId)
      await window.electronAPI.saveViews(activeWorkspace.id, updated)
    } catch (err) {
      console.error('[AppShell] Failed to delete view:', err)
    }
  }, [activeWorkspace?.id, viewConfigs])

  // Handler for "Add New Label" context menu action
  // Opens the EditPopover with 'add-label' context, storing which label was right-clicked
  // so the agent knows to add the new label relative to it
  const handleAddLabel = useCallback((parentId?: string) => {
    editLabelTargetId.current = parentId
    captureContextMenuPosition()
    setTimeout(() => setEditPopoverOpen('add-label'), 50)
  }, [captureContextMenuPosition])

  // Handler for "Delete Label" context menu action
  // Deletes the label and all its descendants, stripping from sessions
  const handleDeleteLabel = useCallback(async (labelId: string) => {
    if (!activeWorkspace?.id) return
    try {
      await window.electronAPI.deleteLabel(activeWorkspace.id, labelId)
    } catch (err) {
      console.error('[AppShell] Failed to delete label:', err); toast.error(t('toast.failedToDeleteLabel'), { description: err instanceof Error ? err.message : t('toast.unknownError') }) // UA12.41 — the user sees the failure, not only the console
    }
  }, [activeWorkspace?.id, t])

  // Handler for "Add Source" context menu action
  // Opens the EditPopover for adding a new source
  // Optional sourceType param allows filter-aware context (from subcategory menus or filtered views)
  const openAddSource = useCallback((sourceType?: 'api' | 'mcp' | 'local') => {
    captureContextMenuPosition()
    const key = sourceType ? `add-source-${sourceType}` as const : 'add-source' as const
    setTimeout(() => setEditPopoverOpen(key), 50)
  }, [captureContextMenuPosition])

  // Handler for "Add Skill" context menu action
  // Opens the EditPopover for adding a new skill
  const openAddSkill = useCallback(() => {
    captureContextMenuPosition()
    setTimeout(() => setEditPopoverOpen('add-skill'), 50)
  }, [captureContextMenuPosition])

  // Handler for "Add Automation" context menu action
  // Opens the EditPopover for adding a new automation
  const openAddAutomation = useCallback((type?: AutomationAddType) => {
    captureContextMenuPosition()
    setTimeout(() => setEditPopoverOpen(getAutomationAddPopoverKey(type)), 50)
  }, [captureContextMenuPosition])

  // UA5.9 (v0.13.4 L712–L716, L757–L792, L941–L955, L1639–L1660, L2021–L2030) — the session list's project
  // filter, the jump to a project's sessions, the Projects submenu's options and setter, and the "inherit the sole
  // active filter" rule for new sessions. Placed here, below the docs' highest cited line of this file (2037 on
  // 2026-10-02); the project filter is applied on top of `filteredSessionMetas` (which sits above that line).
  // Derive current view's project filter as a Map<projectId, FilterMode>
  const projectFilter = useMemo(() => {
    if (!sessionFilterKey) return new Map<string, FilterMode>()
    const entry = viewFiltersMap[sessionFilterKey]?.projects ?? {}
    return new Map<string, FilterMode>(Object.entries(entry) as [string, FilterMode][])
  }, [viewFiltersMap, sessionFilterKey])

  // Setter for project filter — updates only the current view's entry in the map
  const setProjectFilter = useCallback((updater: Map<string, FilterMode> | ((prev: Map<string, FilterMode>) => Map<string, FilterMode>)) => {
    setViewFiltersMap(prev => {
      if (!sessionFilterKey) return prev
      const current = new Map<string, FilterMode>(Object.entries(prev[sessionFilterKey]?.projects ?? {}) as [string, FilterMode][])
      const next = typeof updater === 'function' ? updater(current) : updater
      const existing = prev[sessionFilterKey]
      return {
        ...prev,
        [sessionFilterKey]: {
          statuses: existing?.statuses ?? {},
          labels: existing?.labels ?? {},
          projects: Object.fromEntries(next),
          groupingMode: existing?.groupingMode,
        }
      }
    })
  }, [sessionFilterKey])

  // Jump to All Sessions filtered by a single project. Used by the Projects list
  // context menu — sets the allSessions view's project filter (preserving its
  // other filters), then navigates.
  const handleJumpToProjectSessions = useCallback((projectId: string) => {
    setViewFiltersMap(prev => {
      const existing = prev['allSessions']
      return {
        ...prev,
        allSessions: {
          statuses: existing?.statuses ?? {},
          labels: existing?.labels ?? {},
          projects: { [projectId]: 'include' },
          groupingMode: existing?.groupingMode,
        }
      }
    })
    navigate(routes.view.allSessions())
  }, [])

  // Workspace projects — the Projects sidebar entry and navigator (UA5.8), the session menus, the filter and the grouping
  const { projects } = useProjects(activeWorkspaceId)
  const projectMenuOptions = useMemo(
    () => projects.map(p => ({ id: p.config.id, slug: p.config.slug, name: p.config.name, color: p.config.color })),
    [projects],
  )
  const handleSessionProjectChange = useCallback(async (sessionId: string, projectId: string | null) => {
    try {
      await window.electronAPI.sessionCommand(sessionId, { type: 'setProjectId', projectId })
    } catch (err) {
      console.error('[AppShell] Failed to update session project:', err)
      toast.error(t('toast.failedToUpdateProject'))
    }
  }, [t])

  // Filter by project — supports include/exclude on session.projectId
  const projectFilteredSessionMetas = useMemo(() => {
    if (projectFilter.size === 0) return filteredSessionMetas
    let result = filteredSessionMetas
    const projectIncludes = new Set<string>()
    const projectExcludes = new Set<string>()
    for (const [id, mode] of projectFilter) {
      if (mode === 'include') projectIncludes.add(id)
      else projectExcludes.add(id)
    }
    if (projectIncludes.size > 0) {
      result = result.filter(s => s.projectId !== undefined && projectIncludes.has(s.projectId))
    }
    if (projectExcludes.size > 0) {
      result = result.filter(s => s.projectId === undefined || !projectExcludes.has(s.projectId))
    }
    return result
  }, [filteredSessionMetas, projectFilter])

  // UA12.164 — the pinned sidebar route `label:<deleted-id>` (boot restore, stale deeplink) used
  // to blank the label's view silently: a filter that matches nothing rendered the generic "No
  // sessions yet" screen under a title titlecased from the dead id. The navigator now renders an
  // explicit deleted-label empty-state instead, and the title falls back to the section name the
  // way the dead view branch does.
  // Follow-up (2026-10-08 verification): only once labels LOADED without error ("not loaded yet"
  // is not "deleted"), and never while search is active (SessionList owns the search header).
  // "Loaded" is this workspace's list loaded ONCE, not "no load running": refresh() flips
  // isLoading on every LABELS_CHANGED over the last good list, which made a real deleted view
  // flash back to the generic blank on every label-config change (re-verification of 6da39447a).
  const labelsReady = labelsLoaded && !labelsError
  const deletedLabelView = useMemo(
    () => isDeletedLabelView(sessionFilter, labelConfigs, { labelsReady, searchActive }),
    [sessionFilter, labelConfigs, labelsReady, searchActive]
  )

  /**
   * Resolve the "inherit sole active filter" rule for new sessions. Only
   * include-mode filters are candidates — an excluded status/label/project must
   * never be inherited (#970). See resolveInheritedFilterParams.
   * UA12.163 — the label liveness the rule requires is the SAME prune the lists
   * use (expandLabelFilterIds, UA12.154): a dead-only label filter (SIT-D F4)
   * inherits nothing, and a dead id beside a live one is no false ambiguity.
   */
  const resolveInheritedNewSessionParams = useCallback(
    () => resolveInheritedFilterParams(
      listFilter,
      labelFilter,
      projectFilter,
      (id) => expandLabelFilterIds(labelConfigs, id).length > 0
    ),
    [listFilter, labelFilter, projectFilter, labelConfigs]
  )

  // Create a new chat and select it
  const handleNewChat = useCallback((newPanel: boolean = false) => {
    if (!activeWorkspace) return

    // Exit search mode and switch to All Sessions
    setSearchActive(false)
    setSearchQuery('')

    // UA5.9 (v0.13.4) — Inherit sole-active filter into the new session when unambiguous.
    const inherited = resolveInheritedNewSessionParams()

    // Delegate to NavigationContext which handles session creation
    navigate(
      routes.action.newSession(inherited ?? undefined),
      newPanel ? { newPanel: true, targetLaneId: 'main' } : undefined
    )

    // Focus the chat input after navigation completes
    setTimeout(() => focusZone('chat', { intent: 'programmatic' }), 50)
  }, [activeWorkspace, focusZone, navigate, resolveInheritedNewSessionParams])

  /**
   * P6.133 — the first user-reachable caller of the host worktree port.
   *
   * The port has existed since P6.20 and is provider-free: Pi, claude and codex
   * all get it and get it identically, because it is the HOST mechanism rather
   * than any runtime's own flag. It refuses instead of falling back — a session
   * that asked for isolation and got the live checkout is the one outcome the
   * request rules out — and the refusal is now named by
   * `describeSessionCreateFailure`, so a user learns the session was discarded
   * rather than meeting a bare git sentence.
   *
   * Routed through `navigate` rather than a deep link ON PURPOSE: the handler
   * honours `worktree` only for a trusted (in-app) route, since creating one
   * runs git and takes a host lease.
   */
  const handleNewChatInWorktree = useCallback(() => {
    if (!activeWorkspace) return
    setSearchActive(false)
    setSearchQuery('')
    navigate(routes.action.newSession({ worktree: true }))
    setTimeout(() => focusZone('chat', { intent: 'programmatic' }), 50)
  }, [activeWorkspace, focusZone, navigate])

  // Create a brand new dedicated browser window and focus it.
  // Intentionally unbound: this action should always create a NEW window.
  const handleNewBrowserWindow = useCallback(async () => {
    try {
      const instanceId = await window.electronAPI.browserPane.create({
        show: true,
      })
      await window.electronAPI.browserPane.focus(instanceId)
    } catch (error) {
      // P2.464 — a managed refusal is not a failure, and the two have OPPOSITE
      // remedies, so they must not share a sentence. Until this branch existed
      // both arrived as "Failed to create browser window", so a user met a
      // policy as a malfunction — the distinction P2.429 drew for a refused
      // marketplace, in its browser instance.
      //
      // The rule and both of the things a caller would otherwise re-derive
      // (branch on the wire CODE, never `instanceof`; SHOW the server's
      // sentence, because it names which administrator's document decided) live
      // in `browser-refusal-toast.ts`, where they can be asserted on values —
      // this component cannot be imported by a suite.
      const refusal = describeBrowserRefusal(error)
      if (refusal) {
        toast.error(t(refusal.titleKey), { description: refusal.description })
        return
      }
      console.error('[Chat] Failed to create browser window:', error)
      toast.error(t('toast.failedToCreateBrowser'))
    }
  }, [t])

  const handleDeleteSource = useCallback(async (capabilityKey: string) => {
    if (!activeWorkspace || !capabilityContextRef) return
    try {
      const detail = await window.electronAPI.capabilities.getDetail(capabilityContextRef, capabilityKey)
      const ref = detail.resources.find(item => item.ref.scope === 'source')?.ref
      if (!ref || ref.scope !== 'source') throw new Error('Source is not mutable')
      await window.electronAPI.deleteSource(activeWorkspace.id, ref.sourceId)
      await refreshCapabilityViews()
      toast.success(t('toast.deletedSource'))
    } catch (error) {
      console.error('[Chat] Failed to delete source:', error)
      toast.error(t('toast.failedToDeleteSource'))
    }
  }, [activeWorkspace, capabilityContextRef, refreshCapabilityViews, t])

  // UB12.80 — a skill's reveal and delete live in `hooks/useSkillActions.ts`, shared by the
  // Skills list and the skill detail page's header "⋯". UB12.113 — the Sources list reads the same
  // reveal itself (`hooks/useCapabilityReveal.ts`), so this shell carries no reveal handler.

  // Respond to menu bar "New Chat" trigger
  const menuTriggerRef = useRef(menuNewChatTrigger)
  useEffect(() => {
    // Skip initial render
    if (menuTriggerRef.current === menuNewChatTrigger) return
    menuTriggerRef.current = menuNewChatTrigger
    handleNewChat()
  }, [menuNewChatTrigger, handleNewChat])

  // UA7.3 (v0.13.4 L942, L1839–L1842) — the Pages entry's list and handler. Placed here, below the
  // docs' highest cited line of this file (2037 on 2026-10-02), so no cited line moves.
  const { pages } = usePages(activeWorkspaceId)
  const handlePagesClick = useCallback(() => {
    navigate(routes.view.pages())
  }, [])

  // UA5.8 (v0.13.4 L941, L1834–L1837, L2001–L2020) — the Projects entry's list, handler and Create Project
  // dialog, below the docs' highest cited line of this file (2037 on 2026-10-02), as UA7.3's. The jump to a
  // project's sessions, the project filter and the `projects` list are UA5.9's (above handleNewChat).
  const handleProjectsClick = useCallback(() => {
    navigate(routes.view.projects())
  }, [])
  // Open the "Create Project" dialog so the user can provide a name up front.
  // The previous flow auto-created with the default name and produced ugly
  // permanent slugs (new-project, new-project-1, …).
  const [createProjectDialogOpen, setCreateProjectDialogOpen] = useState(false)
  const openAddProject = useCallback(() => {
    if (!activeWorkspace?.id) return
    setCreateProjectDialogOpen(true)
  }, [activeWorkspace?.id])
  const handleCreateProjectSubmit = useCallback(async (name: string) => {
    if (!activeWorkspace?.id) return
    setCreateProjectDialogOpen(false)
    try {
      const project = await window.electronAPI.createProject(activeWorkspace.id, { name })
      navigate(routes.view.projects(project.slug))
    } catch (err) {
      console.error('[AppShell] Failed to create project:', err)
      toast.error(t('projectsList.createFailed'))
    }
  }, [activeWorkspace?.id, t])

  // Unified sidebar items: nav buttons only (agents system removed)
  type SidebarItem = {
    id: string
    type: 'nav'
    action?: () => void
  }

  const unifiedSidebarItems = React.useMemo((): SidebarItem[] => {
    const result: SidebarItem[] = []

    // 1. Sessions section: All Sessions (expandable) with status items, Flagged, Archived as children
    result.push({ id: 'nav:allSessions', type: 'nav', action: handleAllSessionsClick })
    for (const state of effectiveSessionStatuses) {
      result.push({ id: `nav:state:${state.id}`, type: 'nav', action: () => handleSessionStatusClick(state.id) })
    }
    result.push({ id: 'nav:flagged', type: 'nav', action: handleFlaggedClick })
    result.push({ id: 'nav:archived', type: 'nav', action: handleArchivedClick })

    // 2. Labels section header + regular label tree for keyboard nav
    result.push({ id: 'nav:labels', type: 'nav', action: () => handleLabelClick('__all__') })
    // Flatten regular label tree for keyboard navigation (depth-first)
    const flattenTree = (nodes: LabelTreeNode[]) => {
      for (const node of nodes) {
        if (node.label) {
          result.push({ id: `nav:label:${node.fullId}`, type: 'nav', action: () => handleLabelClick(node.fullId) })
        }
        if (node.children.length > 0) flattenTree(node.children)
      }
    }
    flattenTree(labelTree)

    // 3. Sources, Pages, Automations, Settings (visual order; UA7.3 — Pages directly after Sources
    //    until Projects lands, then after Projects: plan OQ-19)
    result.push({ id: 'nav:sources', type: 'nav', action: handleSourcesClick })
    result.push({ id: 'nav:sources:skills', type: 'nav', action: handleSkillsClick })
    result.push({ id: 'nav:projects', type: 'nav', action: handleProjectsClick }) // UA5.8 — Projects, then Pages (OQ-19)
    result.push({ id: 'nav:pages', type: 'nav', action: handlePagesClick })
    result.push({ id: 'nav:automations', type: 'nav', action: handleAutomationsClick })
    result.push({ id: 'nav:settings', type: 'nav', action: () => handleSettingsClick() })
    result.push({ id: 'nav:plugins', type: 'nav', action: handlePluginsClick })
    result.push({ id: 'nav:whats-new', type: 'nav', action: handleWhatsNewClick })

    return result
  }, [handleAllSessionsClick, handleFlaggedClick, handleArchivedClick, handleSessionStatusClick, effectiveSessionStatuses, handleLabelClick, labelConfigs, labelTree, viewConfigs, handleViewClick, handleSourcesClick, handleSkillsClick, handleProjectsClick, handlePagesClick, handleAutomationsClick, handleSettingsClick, handlePluginsClick, handleWhatsNewClick])

  // Toggle folder expanded state
  const handleToggleFolder = React.useCallback((path: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }, [])

  // Get props for any sidebar item (unified roving tabindex pattern)
  const getSidebarItemProps = React.useCallback((id: string) => ({
    tabIndex: focusedSidebarItemId === id ? 0 : -1,
    'data-focused': focusedSidebarItemId === id,
    ref: (el: HTMLElement | null) => {
      if (el) {
        sidebarItemRefs.current.set(id, el)
      } else {
        sidebarItemRefs.current.delete(id)
      }
    },
  }), [focusedSidebarItemId])

  // Unified sidebar keyboard navigation
  const handleSidebarKeyDown = React.useCallback((e: React.KeyboardEvent) => {
    if (!sidebarFocused || unifiedSidebarItems.length === 0) return

    const currentIndex = unifiedSidebarItems.findIndex(item => item.id === focusedSidebarItemId)
    const currentItem = currentIndex >= 0 ? unifiedSidebarItems[currentIndex] : null

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault()
        const nextIndex = currentIndex < unifiedSidebarItems.length - 1 ? currentIndex + 1 : 0
        const nextItem = unifiedSidebarItems[nextIndex]
        setFocusedSidebarItemId(nextItem.id)
        sidebarItemRefs.current.get(nextItem.id)?.focus()
        break
      }
      case 'ArrowUp': {
        e.preventDefault()
        const prevIndex = currentIndex > 0 ? currentIndex - 1 : unifiedSidebarItems.length - 1
        const prevItem = unifiedSidebarItems[prevIndex]
        setFocusedSidebarItemId(prevItem.id)
        sidebarItemRefs.current.get(prevItem.id)?.focus()
        break
      }
      case 'ArrowLeft': {
        e.preventDefault()
        // At boundary - do nothing (Left doesn't change zones from sidebar)
        break
      }
      case 'ArrowRight': {
        e.preventDefault()
        // Move to next zone (navigator) - keyboard navigation
        focusZone('navigator', { intent: 'keyboard' })
        break
      }
      case 'Enter':
      case ' ': {
        e.preventDefault()
        if (currentItem?.type === 'nav' && currentItem.action) {
          currentItem.action()
        }
        break
      }
      case 'Home': {
        e.preventDefault()
        if (unifiedSidebarItems.length > 0) {
          const firstItem = unifiedSidebarItems[0]
          setFocusedSidebarItemId(firstItem.id)
          sidebarItemRefs.current.get(firstItem.id)?.focus()
        }
        break
      }
      case 'End': {
        e.preventDefault()
        if (unifiedSidebarItems.length > 0) {
          const lastItem = unifiedSidebarItems[unifiedSidebarItems.length - 1]
          setFocusedSidebarItemId(lastItem.id)
          sidebarItemRefs.current.get(lastItem.id)?.focus()
        }
        break
      }
    }
  }, [sidebarFocused, unifiedSidebarItems, focusedSidebarItemId, focusZone])

  // Focus sidebar item when sidebar zone gains focus
  React.useEffect(() => {
    if (sidebarFocused && unifiedSidebarItems.length > 0) {
      // Set focused item if not already set
      const itemId = focusedSidebarItemId || unifiedSidebarItems[0].id
      if (!focusedSidebarItemId) {
        setFocusedSidebarItemId(itemId)
      }
      // Actually focus the DOM element
      requestAnimationFrame(() => {
        sidebarItemRefs.current.get(itemId)?.focus()
      })
    }
  }, [sidebarFocused, focusedSidebarItemId, unifiedSidebarItems])

  // Get title based on navigation state
  const listTitle = React.useMemo(() => {
    // Sources navigator
    if (isSourcesNavigation(navState)) {
      return t("sidebar.sources")
    }

    // Skills navigator
    if (isSkillsNavigation(navState)) {
      return t("sidebar.allSkills")
    }

    // Automations navigator
    if (isAutomationsNavigation(navState)) {
      if (!automationFilter) return t("sidebar.allAutomations")
      switch (automationFilter.automationType) {
        case 'scheduled': return t("sidebar.scheduled")
        case 'event': return t("sidebar.eventBased")
        case 'agentic': return t("sidebar.agentic")
        default: return t("sidebar.allAutomations")
      }
    }

    // Settings navigator
    if (isSettingsNavigation(navState)) return t("sidebar.settings")

    if (navState.navigator === 'knowledge') return t("knowledge.title")
    if (navState.navigator === 'knowledge-chat') return t("knowledge.chat")
    if (isPluginsNavigation(navState)) return t("sidebar.plugins")

    // UA7.3 (v0.13.4 L2265–L2268) — Pages navigator
    if (isPagesNavigation(navState)) return t("sidebar.allPages")

    // UA5.8 (v0.13.4 L2260–L2263) — Projects navigator
    if (isProjectsNavigation(navState)) return t("sidebar.allProjects")

    // Sessions navigator - use sessionFilter
    if (!sessionFilter) return t("sidebar.allSessions")

    switch (sessionFilter.kind) {
      case 'flagged':
        return t("sidebar.flagged")
      case 'state': {
        const state = effectiveSessionStatuses.find(s => s.id === sessionFilter.stateId)
        return state ? t(`status.${state.id}`, state.label) : t("sidebar.allSessions")
      }
      case 'label':
        // UA12.164 — a deleted label's route falls back to the section name, the way the dead
        // view branch falls back to t("sidebar.views"): no title titlecased from a dead id. Until
        // labels are ready the id's own name stays (a not-yet-loaded label is not a dead one).
        return sessionFilter.labelId === '__all__'
          ? t("sidebar.labels")
          : findLabelById(labelConfigs, sessionFilter.labelId) || !labelsReady
            ? getLabelDisplayName(labelConfigs, sessionFilter.labelId)
            : t("sidebar.labels")
      case 'view':
        return sessionFilter.viewId === '__all__' ? t("sidebar.views") : viewConfigs.find(v => v.id === sessionFilter.viewId)?.name || t("sidebar.views")
      default:
        return t("sidebar.allSessions")
    }
  }, [navState, t, sessionFilter, automationFilter, labelConfigs, labelsReady, viewConfigs, effectiveSessionStatuses])

  // Build recursive sidebar items from the shared display-sorted label tree.
  // Each node renders with condensed height (compact: true) since many labels expected.
  // Clicking any label navigates to its filter view; the chevron toggles expand/collapse.
  const buildLabelSidebarItems = useCallback((nodes: LabelTreeNode[]): any[] => {
    return nodes.map(node => {
      const hasChildren = node.children.length > 0
      const isActive = sessionFilter?.kind === 'label' && sessionFilter.labelId === node.fullId
      const count = labelCounts[node.fullId] || 0

      const item: any = {
        id: `nav:label:${node.fullId}`,
        title: node.label?.name || node.segment.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
        label: count > 0 ? String(count) : undefined,
        // Show label type icon (Hash/Calendar/Type) right-aligned before count, with tooltip explaining the type
        afterTitle: node.label?.valueType ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex items-center"><LabelValueTypeIcon valueType={node.label.valueType} size={10} /></span>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              {t("sidebar.labelValueTypeTooltip", { valueType: t(`sidebar.labelValueType.${node.label.valueType}`) })}
            </TooltipContent>
          </Tooltip>
        ) : undefined,
        icon: node.label && activeWorkspace?.id ? (
          <LabelIcon
            label={node.label}
            size="sm"
            hasChildren={hasChildren}
          />
        ) : <Tag className="h-3.5 w-3.5" />,
        variant: isActive ? "default" : "ghost",
        compact: true, // Reduced height for label items (many labels expected)
        // All labels navigate on click — parent and leaf alike
        onClick: () => handleLabelClick(node.fullId),
        contextMenu: {
          type: 'labels' as const,
          labelId: node.fullId,
          onConfigureLabels: openConfigureLabels,
          onAddLabel: handleAddLabel,
          onDeleteLabel: handleDeleteLabel,
        },
      }

      if (hasChildren) {
        item.expandable = true
        item.expanded = isExpanded(`nav:label:${node.fullId}`)
        // Chevron toggles expand/collapse independently of navigation
        item.onToggle = () => toggleExpanded(`nav:label:${node.fullId}`)
        item.items = buildLabelSidebarItems(node.children)
      }

      return item
    })
  }, [sessionFilter, labelCounts, activeWorkspace?.id, handleLabelClick, isExpanded, toggleExpanded, openConfigureLabels, handleAddLabel, handleDeleteLabel])

  // UA2.2 (v0.13.4 L633–L635, L3625, L3666) — the board collapses the navigator and its handle at desktop widths only; compact keeps the list (navigator-layout.ts).
  const isBoardView = isSessionsNavigation(navState) && navState.viewMode === 'board'
  // UA7.3 (v0.13.4 L637–L639) — Pages, like Plugins, has no navigator list: the grid and an open page render full-width.
  const showNavigator = navState.navigator !== 'knowledge' && navState.navigator !== 'knowledge-chat' && !isPluginsNavigation(navState) && !isPagesNavigation(navState) && !(isSkillsNavigation(navState) && !navState.details)
  const navigatorLayout = { showNavigator, isBoardView, isAutoCompact, isSidebarAndNavigatorHidden: effectiveSidebarAndNavigatorHidden, sessionListWidth }

  // UB14.4 (v0.15.1): the sidebar navigation (scrolls) and the pinned footer (always visible at any window
  // height). Ours: Plugins, Hooks and Skills nest under Sources; Projects → Pages → Automations (UA5.8/UA7.3);
  // the footer is Settings, our top-level Plugins and What's New.
  const sidebarLinks: SidebarNavItem[] = [
    // --- Sessions Section ---
    // All Sessions: expandable with status children (sortable) + Flagged & Archived as trailing items
    {
      id: "nav:allSessions",
      title: t("sidebar.allSessions"),
      label: String(workspaceSessionMetas.length),
      icon: Inbox,
      variant: sessionFilter?.kind === 'allSessions' ? "default" : "ghost",
      onClick: handleAllSessionsClick,
      expandable: true,
      expanded: isExpanded('nav:allSessions'),
      onToggle: () => toggleExpanded('nav:allSessions'),
      contextMenu: {
        type: 'allSessions',
        onConfigureStatuses: openConfigureStatuses,
        onMarkAllRead: () => {
          if (!activeWorkspaceId) return
          // Optimistic: clear hasUnread on all workspace session metas
          setSessionMetaMap(prev => {
            const next = new Map(prev)
            for (const [id, meta] of next) {
              if (meta.workspaceId === activeWorkspaceId && meta.hasUnread) {
                next.set(id, { ...meta, hasUnread: false })
              }
            }
            return next
          })
          window.electronAPI.markAllSessionsRead(activeWorkspaceId)
        },
      },
      // Enable flat DnD reorder for status items
      sortable: { onReorder: handleStatusReorder },
      items: [
        // Status items (sortable via SortableStatusList)
        ...effectiveSessionStatuses.map(state => ({
          id: `nav:state:${state.id}`,
          title: t(`status.${state.id}`, state.label),
          label: String(sessionStatusCounts[state.id] || 0),
          icon: state.icon,
          iconColor: state.resolvedColor,
          iconColorable: state.iconColorable,
          variant: (sessionFilter?.kind === 'state' && sessionFilter.stateId === state.id ? "default" : "ghost") as "default" | "ghost",
          onClick: () => handleSessionStatusClick(state.id),
          contextMenu: {
            type: 'status' as const,
            statusId: state.id,
            onConfigureStatuses: openConfigureStatuses,
          },
        })),
        // Separator: SortableStatusList splits here — items after become non-sortable trailingItems
        { id: 'separator:states-flagged', type: 'separator' as const },
        // Flagged (trailing, non-sortable)
        {
          id: "nav:flagged",
          title: t("sidebar.flagged"),
          label: String(flaggedCount),
          icon: <Flag className="h-3.5 w-3.5" />,
          variant: (sessionFilter?.kind === 'flagged' ? "default" : "ghost") as "default" | "ghost",
          onClick: handleFlaggedClick,
        },
        // Archived (trailing, non-sortable)
        {
          id: "nav:archived",
          title: t("sidebar.archived"),
          label: archivedCount > 0 ? String(archivedCount) : undefined,
          icon: Archive,
          variant: (sessionFilter?.kind === 'archived' ? "default" : "ghost") as "default" | "ghost",
          onClick: handleArchivedClick,
        },
      ],
    },
    // Labels: navigable header (shows all labeled sessions) + hierarchical tree (drag-and-drop reorder + re-parent)
    {
      id: "nav:labels",
      title: t("sidebar.labels"),
      icon: Tag,
      // Only highlighted when "Labels" itself is selected (not sub-labels)
      variant: (sessionFilter?.kind === 'label' && sessionFilter.labelId === '__all__') ? "default" as const : "ghost" as const,
      // Clicking navigates to "all labeled sessions" view
      onClick: () => handleLabelClick('__all__'),
      expandable: true,
      expanded: isExpanded('nav:labels'),
      onToggle: () => toggleExpanded('nav:labels'),
      contextMenu: {
        type: 'labels' as const,
        onConfigureLabels: openConfigureLabels,
        onAddLabel: handleAddLabel,
      },
      items: buildLabelSidebarItems(labelTree),
    },
    // --- Workspace section --- (UB14.4, v0.15.1: a quiet heading, not focusable, replaces the separator)
    { id: "section:workspace", type: "section", title: t("sidebar.workspaceSection") },
    // --- Sources & Skills Section ---
    {
      id: "nav:sources",
      title: t("sidebar.sources"),
      label: String(sourceTypeCounts.total),
      icon: DatabaseZap,
      variant: ((isSourcesNavigation(navState) && !sourceFilter) || isSkillsNavigation(navState)) ? "default" : "ghost",
      onClick: handleSourcesClick,
      dataTutorial: "sources-nav",
      expandable: true,
      expanded: isExpanded('nav:sources'),
      onToggle: () => toggleExpanded('nav:sources'),
      contextMenu: {
        type: 'sources',
        onAddSource: () => openAddSource(),
      },
      items: [
        {
          id: "nav:sources:api",
          title: t("sidebar.apis"),
          label: String(sourceTypeCounts.api),
          icon: Globe,
          variant: (sourceFilter?.kind === 'type' && sourceFilter.sourceType === 'api') ? "default" : "ghost",
          onClick: handleSourcesApiClick,
          contextMenu: {
            type: 'sources' as const,
            onAddSource: () => openAddSource('api'),
            sourceType: 'api',
          },
        },
        {
          id: "nav:sources:mcp",
          title: t("sidebar.mcps"),
          label: String(sourceTypeCounts.mcp),
          icon: <McpIcon className="h-3.5 w-3.5" />,
          variant: (sourceFilter?.kind === 'type' && sourceFilter.sourceType === 'mcp') ? "default" : "ghost",
          onClick: handleSourcesMcpClick,
          contextMenu: {
            type: 'sources' as const,
            onAddSource: () => openAddSource('mcp'),
            sourceType: 'mcp',
          },
        },
        {
          id: "nav:sources:local",
          title: t("sidebar.localFolders"),
          label: String(sourceTypeCounts.local),
          icon: FolderOpen,
          variant: (sourceFilter?.kind === 'type' && sourceFilter.sourceType === 'local') ? "default" : "ghost",
          onClick: handleSourcesLocalClick,
          contextMenu: {
            type: 'sources' as const,
            onAddSource: () => openAddSource('local'),
            sourceType: 'local',
          },
        },
        {
          id: "nav:sources:plugins",
          title: t("sidebar.plugins"),
          label: String(capabilityCatalog?.installedPlugins.length ?? 0),
          icon: Puzzle,
          variant: (sourceFilter?.kind === 'plugins') ? "default" : "ghost",
          onClick: handleSourcesPluginsClick,
        },
        {
          id: "nav:sources:hooks",
          title: t("sidebar.hooks"),
          icon: Webhook,
          variant: (sourceFilter?.kind === 'hooks') ? "default" : "ghost",
          onClick: handleSourcesHooksClick,
        },
        {
          id: "nav:sources:skills",
          title: t("sidebar.skills"),
          label: String(UI_SKILLS.length),
          icon: Zap,
          variant: isSkillsNavigation(navState) ? "default" : "ghost",
          onClick: handleSkillsClick,
          contextMenu: {
            type: 'skills',
            onAddSkill: openAddSkill,
          },
        },
      ],
    },
    // UA5.8 (v0.13.4 L2610–L2633) — Projects, after Sources and before Pages (OQ-19). Its rows jump to
    // the project's sessions (UA5.9), as upstream.
    {
      id: "nav:projects",
      title: t("sidebar.projects"),
      label: String(projects.length),
      icon: FolderKanban,
      // Highlight only when on Projects view itself, not when a child is "active" (jumped-to filter)
      variant: isProjectsNavigation(navState) ? "default" : "ghost",
      onClick: handleProjectsClick,
      expandable: projects.length > 0,
      expanded: isExpanded('nav:projects'),
      onToggle: () => toggleExpanded('nav:projects'),
      contextMenu: {
        type: 'projects' as const,
        onAddProject: openAddProject,
      },
      items: projects.map(p => ({
        id: `nav:projects:${p.config.id}`,
        title: p.config.name,
        icon: FolderKanban,
        // Highlight when on allSessions view AND filter includes this project (the jump-to state)
        variant: (sessionFilter?.kind === 'allSessions' && projectFilter.get(p.config.id) === 'include') ? "default" as const : "ghost" as const,
        onClick: () => handleJumpToProjectSessions(p.config.id),
      })),
    },
    // UA7.3 (v0.13.4 L2634–L2652) — Pages, directly after Projects (OQ-19)
    {
      id: "nav:pages",
      title: t("sidebar.pages"),
      label: String(pages.length),
      icon: PanelsTopLeft,
      // Highlight on the library grid only, not when a page is open (mirrors Projects)
      variant: (isPagesNavigation(navState) && !navState.details) ? "default" : "ghost",
      onClick: handlePagesClick,
      expandable: pages.length > 0,
      expanded: isExpanded('nav:pages'),
      onToggle: () => toggleExpanded('nav:pages'),
      items: pages.map(p => ({
        id: `nav:pages:${p.config.id}`,
        title: p.config.name,
        icon: PanelsTopLeft,
        variant: (isPagesNavigation(navState) && navState.details?.pageSlug === p.config.slug) ? "default" as const : "ghost" as const,
        onClick: () => navigate(routes.view.pages(p.config.slug)),
      })),
    },
    {
      id: "nav:automations",
      title: t("sidebar.automations"),
      label: String(automations.length),
      icon: ListTodo,
      variant: (isAutomationsNavigation(navState) && !automationFilter) ? "default" : "ghost",
      onClick: handleAutomationsClick,
      expandable: true,
      expanded: isExpanded('nav:automations'),
      onToggle: () => toggleExpanded('nav:automations'),
      contextMenu: {
        type: 'automations' as const,
        onAddAutomation: openAddAutomation,
      },
      items: [
        {
          id: "nav:automations:scheduled",
          title: t("sidebar.scheduled"),
          label: String(automationTypeCounts.scheduled),
          icon: Clock,
          variant: (automationFilter?.kind === 'type' && automationFilter.automationType === 'scheduled') ? "default" : "ghost",
          onClick: handleAutomationsScheduledClick,
          contextMenu: { type: 'automations' as const, onAddAutomation: () => openAddAutomation('scheduled') },
        },
        {
          id: "nav:automations:event",
          title: t("sidebar.eventBased"),
          label: String(automationTypeCounts.event),
          icon: Radio,
          variant: (automationFilter?.kind === 'type' && automationFilter.automationType === 'event') ? "default" : "ghost",
          onClick: handleAutomationsEventClick,
          contextMenu: { type: 'automations' as const, onAddAutomation: () => openAddAutomation('event') },
        },
        {
          id: "nav:automations:agentic",
          title: t("sidebar.agentic"),
          label: String(automationTypeCounts.agentic),
          icon: Bot,
          variant: (automationFilter?.kind === 'type' && automationFilter.automationType === 'agentic') ? "default" : "ghost",
          onClick: handleAutomationsAgenticClick,
          contextMenu: { type: 'automations' as const, onAddAutomation: () => openAddAutomation('agentic') },
        },
      ],
    },
  ]
  const sidebarFooterLinks: SidebarNavItem[] = [
    ...(odysseusStatus?.enabled ? [{id:'nav:knowledge',title:t('knowledge.title'),icon:KnowledgeIcon,variant:navState.navigator === 'knowledge' ? 'default' as const : 'ghost' as const,onClick:()=>navigate(routes.view.knowledge())},{id:'nav:knowledge-chat',title:t('knowledge.chat'),icon:MessagesSquare,variant:navState.navigator === 'knowledge-chat' ? 'default' as const : 'ghost' as const,onClick:()=>navigate(routes.view.knowledgeChat())}] : []),
    ...(odysseusStatus?.enabled ? [{
      id: 'nav:odysseus-cli', title: cliOpening ? t('odysseus.opening') : t('odysseus.openCli'),
      icon: Terminal, variant: 'ghost' as const,
      onClick: () => {
        if (cliOpening) return
        setCliOpening(true)
        void window.electronAPI.launchOdysseusCli(effectiveSessionId || undefined)
          .catch(() => toast.error(t('odysseus.cliFailed')))
          .finally(() => setCliOpening(false))
      },
    }, {
      id: 'nav:odysseus-sync',
      title: odysseusStatus.error ? t('odysseus.failed') : odysseusStatus.conflicts?.length ? t('odysseus.conflicts', {count:odysseusStatus.conflicts.length}) : t('odysseus.sync'),
      icon: RotateCw, variant: 'ghost' as const,
      onClick: () => {
        void window.electronAPI.syncOdysseus().then(status => {
          setOdysseusStatus(status)
          if (status.error) toast.error(t('odysseus.failed'))
          else if (status.conflicts?.length) toast.warning(t('odysseus.conflicts', {count:status.conflicts.length}), {description:t('odysseus.conflictHelp')})
          else toast.success(t('odysseus.done'), {description:status.deferred?.length ? t('odysseus.deferred') : undefined})
        }).catch(() => toast.error(t('odysseus.failed')))
      },
    }] : []),
    // --- Settings ---
    {
      id: "nav:settings",
      title: t("sidebar.settings"),
      icon: Settings,
      variant: isSettingsNavigation(navState) ? "default" : "ghost",
      onClick: () => handleSettingsClick(),
    },
    {
      id: "nav:plugins",
      title: t("sidebar.plugins"),
      icon: Puzzle,
      variant: isPluginsNavigation(navState) ? "default" : "ghost",
      onClick: handlePluginsClick,
    },
    // --- What's New ---
    {
      id: "nav:whats-new",
      title: t("sidebar.whatsNew"),
      icon: hasUnseenReleaseNotes ? (
        <span className="relative">
          <Cake className="h-3.5 w-3.5" />
          <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-accent" />
        </span>
      ) : Cake,
      variant: "ghost" as const,
      onClick: handleWhatsNewClick,
    },
  ]

  return (
    <AppShellProvider value={appShellContextValue}>
        {/* === TOP BAR === */}
        <TopBar
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
          onSelectWorkspace={onSelectWorkspace}
          workspaceUnreadMap={workspaceUnreadMap}
          onWorkspaceCreated={() => onRefreshWorkspaces?.()}
          onWorkspaceRemoved={() => onRefreshWorkspaces?.()}
          activeSessionId={effectiveSessionId}
          onNewChat={() => handleNewChat()}
          onNewWindow={() => window.electronAPI.menuNewWindow()}
          onOpenSettings={onOpenSettings}
          onOpenSettingsSubpage={handleSettingsClick}
          onOpenKeyboardShortcuts={onOpenKeyboardShortcuts}
          onOpenStoredUserPreferences={onOpenStoredUserPreferences}
          onBack={goBack}
          onForward={goForward}
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          onToggleSidebar={handleToggleSidebarFromPointer}
          onToggleFocusMode={handleToggleFocusModeFromPointer}
          onAddSessionPanel={() => handleNewChat(true)}
          onAddBrowserPanel={() => { void handleNewBrowserWindow() }}
          isCompact={isAutoCompact}
        />

      {/* === OUTER LAYOUT: Unified Panel Stack | Right Sidebar === */}
      <div
        ref={shellRef}
        className="flex items-stretch relative"
        style={{
          height: '100%',
          paddingRight: isAutoCompact ? 0 : PANEL_EDGE_INSET,
          paddingBottom: isAutoCompact ? 0 : PANEL_EDGE_INSET,
          paddingLeft: 0,
          gap: PANEL_GAP,
        }}
      >
        <PanelStackContainer
          sidebarSlot={
            <SidebarPane
              paneRef={sidebarRef}
              width={sidebarWidth}
              focused={sidebarFocused}
              onKeyDown={handleSidebarKeyDown}
              links={sidebarLinks}
              footerLinks={sidebarFooterLinks}
              getItemProps={getSidebarItemProps}
              focusedItemId={focusedSidebarItemId}
              onNewSession={(openInNewWindow) => handleNewChat(openInNewWindow)}
              newSessionLabel={t("session.newSession")}
              newSessionHotkey={newChatHotkey}
              onNewChatInWorktree={handleNewChatInWorktree}
            />
          }
          sidebarWidth={effectiveSidebarAndNavigatorHidden ? 0 : (isSidebarVisible ? sidebarWidth : 0)}
          navigatorSlot={
            <div
              style={{ width: isAutoCompact ? '100%' : sessionListWidth }}
              className="h-full flex flex-col min-w-0 relative z-panel"
            >
            <PanelHeader
              title={isSidebarVisible ? listTitle : undefined}
              compensateForStoplight={!isSidebarVisible}
              badge={automationFilter?.automationType === 'scheduled' ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="text-muted-foreground/50 cursor-default flex items-center titlebar-no-drag">
                      <Info className="h-3 w-3" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-[220px]">
                    {t('automations.schedulingRequiresMachine')}
                  </TooltipContent>
                </Tooltip>
              ) : undefined}
              actions={
                <>
                  {/* UA2.2 (v0.13.4 L2753–L2761) — List ⇄ Board view switch (sessions mode, desktop widths only).
                      In board view the navigator is collapsed, so the board hosts its own copy. */}
                  {!isAutoCompact && isSessionsNavigation(navState) && (
                    <BoardListToggle
                      value="list"
                      onChange={view => {
                        if (view === 'board') navigate(routes.view.board())
                      }}
                    />
                  )}
                  {/* Filter dropdown - available in ALL chat views.
                      Shows user-added filters (removable) and pinned filters (non-removable, derived from route).
                      Pinned filters: state views pin a status, label views pin a label, flagged pins the flag. */}
                  {isSessionsNavigation(navState) && (
                    isAutoCompact ? (
                      <CompactSessionListFilter
                        listFilter={listFilter}
                        setListFilter={setListFilter}
                        labelFilter={labelFilter}
                        setLabelFilter={setLabelFilter}
                        pinnedFilters={pinnedFilters}
                        effectiveSessionStatuses={effectiveSessionStatuses}
                        displayLabelConfigs={displayLabelConfigs}
                        labelConfigs={labelConfigs}
                        chatGroupingMode={chatGroupingMode}
                        setChatGroupingMode={setChatGroupingMode}
                        projectsAvailable={projectMenuOptions.length > 0}
                        isStateSubView={isStateSubView}
                        onOpenSearch={() => setSearchActive(true)}
                      />
                    ) : (
                    <SessionFilterMenu
                      key={activeWorkspaceId ?? undefined}
                      listFilter={listFilter}
                      setListFilter={setListFilter}
                      labelFilter={labelFilter}
                      setLabelFilter={setLabelFilter}
                      projectFilter={projectFilter}
                      setProjectFilter={setProjectFilter}
                      pinnedFilters={pinnedFilters}
                      effectiveSessionStatuses={effectiveSessionStatuses}
                      labelConfigs={labelConfigs}
                      displayLabelConfigs={displayLabelConfigs}
                      projectMenuOptions={projectMenuOptions}
                      isStateSubView={isStateSubView}
                      chatGroupingMode={chatGroupingMode}
                      setChatGroupingMode={setChatGroupingMode}
                      onOpenSearch={() => setSearchActive(true)}
                    />
                    )
                  )}
                  {/* Add Source button (only for sources mode) - uses filter-aware edit config */}
                  {isSourcesNavigation(navState) && sourceFilter?.kind !== 'hooks' && activeWorkspace && (
                    <EditPopover
                      trigger={
                        <HeaderIconButton
                          icon={<Plus className="h-4 w-4" />}
                          tooltip={t("sidebarMenu.addSource")}
                          data-tutorial="add-source-button"
                        />
                      }
                      {...getAddSourceEditConfig(
                        sourceFilter?.kind === 'type' ? `add-source-${sourceFilter.sourceType}` : 'add-source',
                        activeWorkspace.id,
                      )}
                    />
                  )}
                  {/* Add Skill button (only for skills mode) */}
                  {isSkillsNavigation(navState) && activeWorkspace && (
                    <EditPopover
                      trigger={
                        <HeaderIconButton
                          icon={<Plus className="h-4 w-4" />}
                          tooltip={t("sidebarMenu.addSkill")}
                          data-tutorial="add-skill-button"
                        />
                      }
                      {...getAddSkillEditConfig(activeWorkspace.id)}
                    />
                  )}
                  {/* Add Automation button (only for automations mode) */}
                  {isAutomationsNavigation(navState) && activeWorkspace && (
                    <EditPopover
                      trigger={
                        <HeaderIconButton
                          icon={<Plus className="h-4 w-4" />}
                          tooltip={t("sidebarMenu.addAutomation")}
                        />
                      }
                      {...getManagedEditConfig(getAutomationAddPopoverKey(automationFilter?.automationType), {
                        scope: 'workspace', workspaceId: activeWorkspace.id, kind: 'automations',
                      })}
                    />
                  )}
                  {/* UA5.8 (v0.13.4 L3491–L3498) — Add Project button (only for projects mode) */}
                  {isProjectsNavigation(navState) && activeWorkspace && (
                    <HeaderIconButton
                      icon={<Plus className="h-4 w-4" />}
                      tooltip={t("sidebarMenu.addProject")}
                      onClick={openAddProject}
                    />
                  )}
                </>
              }
            />
            {/* Content: SessionList, SourcesListPanel, or SettingsNavigator based on navigation state */}
            {isSourcesNavigation(navState) && sourceFilter?.kind === 'plugins' && (
              /* Plugins management subsection (U4): installed plugins as
                 management rows with enable/disable menus. The open plugin's
                 row highlights, read from the route exactly as
                 `SourcesListPanel`'s `selectedSourceSlug` is below. */
              <PluginsManagementPanel
                selectedPluginKey={isSourcesNavigation(navState) && navState.details?.type === 'plugin' ? navState.details.pluginKey : null}
                localMcpEnabled={localMcpEnabled}
              />
            )}
            {isSourcesNavigation(navState) && sourceFilter?.kind === 'hooks' && (
              <div className="p-4" data-testid="sources-hooks-navigator">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Webhook className="h-4 w-4" />
                  {t("sourcesHooks.title")}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">{t("sourcesHooks.navigatorDescription")}</p>
              </div>
            )}
            {isSourcesNavigation(navState) && sourceFilter?.kind === 'type' && sourceFilter.sourceType === 'mcp' && (
              /* C6 (ADR § 6): the ONE panel for ALL MCP servers — plugin-owned,
                 user-created and the built-in dp set (A7) together, with
                 per-server enable. The built-ins are ROWS of this list, not a
                 section under it (owner decision 2026-08-01): a built-in is an
                 ordinary MCP entry and a card inside a surface that already
                 means "list" was a second surface for no reason.
                 Rendered as a DIRECT child, exactly like `SourcesListPanel`
                 below: the `flex flex-col` wrapper that used to hold the panel
                 and the built-in card had no height constraint, so the list's
                 own ScrollArea could never size itself and 28 extra rows went
                 unreachable. */
              <ConnectedMcpServersPanel
                builtinDp={builtinDpMcp}
                onOpenServer={(capabilityKey) => {
                  const row = capabilityCatalog?.capabilities.find(item => item.key === capabilityKey)
                  if (row && isSafeSourceRow(row)) handleSourceSelect(row)
                }}
              />
            )}
            {isSourcesNavigation(navState) && sourceFilter?.kind !== 'plugins' && sourceFilter?.kind !== 'hooks'
              && !(sourceFilter?.kind === 'type' && sourceFilter.sourceType === 'mcp') && (
              /* Sources List - filtered by type if sourceFilter is active */
              <SourcesListPanel
                sources={sources}
                sourceFilter={sourceFilter}
                onDeleteSource={handleDeleteSource}
                onSourceClick={handleSourceSelect}
                skills={skills}
                onSkillClick={handleSourceListSkillSelect}
                workspaceId={activeWorkspaceId ?? undefined}
                selectedSourceSlug={isSourcesNavigation(navState) && navState.details?.type === 'source' ? navState.details.sourceSlug : null}
                localMcpEnabled={localMcpEnabled}
              />
            )}
            {isSkillsNavigation(navState) && activeWorkspaceId && (
              /* Skills List */
              <SkillsListPanel
                skills={skills}
                workspaceId={activeWorkspaceId}
                onSkillClick={handleSkillSelect}
                selectedSkillSlug={isSkillsNavigation(navState) && navState.details?.type === 'skill' ? navState.details.skillSlug : null}
              />
            )}
            {isProjectsNavigation(navState) && activeWorkspaceId && (
              /* UA5.8 (v0.13.4 L3526–L3536) — Projects List */
              <ProjectsListPanel
                projects={projects}
                workspaceId={activeWorkspaceId}
                onProjectClick={(slug) => navigate(routes.view.projects(slug))}
                onAddProject={openAddProject}
                onJumpToSessions={handleJumpToProjectSessions}
                selectedProjectSlug={isProjectsNavigation(navState) ? navState.details?.projectSlug ?? null : null}
              />
            )}
            {isAutomationsNavigation(navState) && (
              /* Automations List - filtered by type if automationFilter is active */
              <AutomationsListPanel
                automations={automations}
                automationFilter={automationFilter ? { kind: AUTOMATION_TYPE_TO_FILTER_KIND[automationFilter.automationType] ?? 'all' } : undefined}
                onAutomationClick={handleAutomationSelect}
                onTestAutomation={handleTestAutomation}
                onToggleAutomation={handleToggleAutomation}
                onDuplicateAutomation={handleDuplicateAutomation}
                onDeleteAutomation={handleDeleteAutomation}
                selectedAutomationId={isAutomationsNavigation(navState) && navState.details ? navState.details.automationId : null}
              />
            )}
            {isSettingsNavigation(navState) && (
              /* Settings Navigator */
              <SettingsNavigator
                selectedSubpage={navState.subpage}
                onSelectSubpage={(subpage) => handleSettingsClick(subpage)}
              />
            )}
            {isSessionsNavigation(navState) && (
              /* Sessions List */
              <>
                {/* UA12.164 — a deleted label's route renders an explicit empty-state, never the
                    generic "No sessions yet" blank (the label's view cannot exist any more). */}
                {deletedLabelView ? (
                  <EntityListEmptyScreen
                    icon={<Tag className="h-4 w-4" />}
                    title={t("sidebar.deletedLabelTitle")}
                    description={t("sidebar.deletedLabelDesc")}
                    className="h-full"
                  />
                ) : (
                /* SessionList: Scrollable list of session cards */
                /* Key on sidebarMode forces full remount when switching views, skipping animations */
                <SessionList
                  key={sessionFilter?.kind}
                  items={searchActive ? workspaceSessionMetas : projectFilteredSessionMetas}
                  onDelete={handleDeleteSession}
                  onFlag={onFlagSession}
                  onUnflag={onUnflagSession}
                  onArchive={onArchiveSession}
                  onUnarchive={onUnarchiveSession}
                  onMarkUnread={onMarkSessionUnread}
                  onSessionStatusChange={onSessionStatusChange}
                  onRename={onRenameSession}
                  onFocusChatInput={(targetSessionId) => {
                    focusChatInputForSession(targetSessionId ?? focusedSessionId ?? session.selected)
                  }}
                  onSessionSelect={(selectedMeta) => {
                    navigateToSession(selectedMeta.id)
                  }}
                  onOpenInNewWindow={(selectedMeta) => {
                    if (activeWorkspaceId) {
                      window.electronAPI.openSessionInNewWindow(activeWorkspaceId, selectedMeta.id)
                    }
                  }}
                  onNavigateToView={(view) => {
                    if (view === 'allSessions') {
                      navigate(routes.view.allSessions())
                    } else if (view === 'flagged') {
                      navigate(routes.view.flagged())
                    }
                  }}
                  sessionOptions={sessionOptions}
                  searchActive={searchActive}
                  searchQuery={searchQuery}
                  onSearchChange={setSearchQuery}
                  onSearchClose={() => {
                    setSearchActive(false)
                    setSearchQuery('')
                  }}
                  sessionStatuses={effectiveSessionStatuses}
                  evaluateViews={evaluateViews}
                  labels={displayLabelConfigs}
                  onLabelsChange={handleSessionLabelsChange}
                  projects={projectMenuOptions}
                  onSetProjectId={handleSessionProjectChange}
                  groupingMode={chatGroupingMode}
                  workspaceId={activeWorkspaceId ?? undefined}
                  statusFilter={listFilter}
                  labelFilterMap={labelFilter}
                  focusedSessionId={panelCount === 0 ? null : panelCount > 1 ? focusedSessionId : undefined}
                  onNavigateToSession={panelCount > 1 ? navigateToSessionInPanel : undefined}
                  hasPendingPrompt={hasPendingPrompt}
                  activeChatMatchInfo={chatMatchInfo}
                />
                )}
              </>
            )}
            {/* Mobile/compact-only FAB for starting a new chat — only on the
                session list itself, not when a chat is open (it would overlap
                the chat input). */}
            {isAutoCompact && isSessionsNavigation(navState) && !navState.details && (
              <FabNewChat onClick={() => handleNewChat()} />
            )}
            </div>
          }
          navigatorWidth={resolveNavigatorWidth(navigatorLayout)}
          isSidebarAndNavigatorHidden={effectiveSidebarAndNavigatorHidden}
          isRightSidebarVisible={false}
          isCompact={isAutoCompact}
          isResizing={!!isResizing}
          animateLayout={animateShellLayout}
        />

        {/* Seam handles (absolute, hidden in focused mode) — instant, never animated (UB14.4, v0.15.1 ShellResizeHandle) */}
        {/* Sidebar Resize Handle. Deliberately NOT gated on showNavigator:
            navigator-less routes (Plugins marketplace) keep the two-column
            layout (sidebar + content) with a working sidebar drag; only the
            session-list sash below is navigator-bound. */}
        {!effectiveSidebarAndNavigatorHidden && (
          <ShellResizeHandle
            handleRef={resizeHandleRef}
            left={isSidebarVisible ? sidebarWidth + (PANEL_GAP / 2) - PANEL_SASH_HALF_HIT_WIDTH : -PANEL_GAP}
            hoverY={sidebarHandleY}
            onHoverYChange={setSidebarHandleY}
            keepHoverOnLeave={!!isResizing}
            onDragStart={() => setIsResizing('sidebar')}
          />
        )}

        {/* Session List Resize Handle (absolute, hidden in focused mode).
            Also gated on showNavigator: on navigator-less routes (Plugins
            marketplace) the session list is not rendered, and an unguarded
            handle floated as an INVISIBLE col-resize zone over the content,
            silently resizing the hidden list (live-audit finding 2026-07-20).
            The list and the content share one card (UB14.2), so this seam is the
            card's inner hairline — no half gap (v0.15.1). */}
        {showSessionListResizeHandle(navigatorLayout) && (
          <ShellResizeHandle
            handleRef={sessionListHandleRef}
            left={(isSidebarVisible ? sidebarWidth + PANEL_GAP : PANEL_EDGE_INSET) + sessionListWidth - PANEL_SASH_HALF_HIT_WIDTH}
            hoverY={sessionListHandleY}
            onHoverYChange={setSessionListHandleY}
            keepHoverOnLeave={isResizing === 'session-list'}
            onDragStart={() => setIsResizing('session-list')}
          />
        )}

      </div>

      {/* ============================================================================
       * CONTEXT MENU TRIGGERED EDIT POPOVERS
       * ============================================================================
       * These EditPopovers are opened programmatically from sidebar context menus.
       * They use controlled state (editPopoverOpen) and invisible anchors for positioning.
       * The anchor Y position is captured from the right-clicked item (editPopoverAnchorY ref)
       * so the popover appears near the triggering item rather than at a fixed location.
       * modal={true} prevents auto-close when focus shifts after context menu closes.
       */}
      {activeWorkspace && (
        <>
          {/* Configure Statuses EditPopover - anchored near sidebar */}
          <EditPopover
            open={editPopoverOpen === 'statuses'}
            onOpenChange={(isOpen) => setEditPopoverOpen(isOpen ? 'statuses' : null)}
            modal={true}
            trigger={
              <div
                className="fixed w-0 h-0 pointer-events-none"
                style={{ left: sidebarWidth + 20, top: editPopoverAnchorY.current }}
                aria-hidden="true"
              />
            }
            side="bottom"
            align="start"
            {...getManagedEditConfig('edit-statuses', {
              scope: 'workspace', workspaceId: activeWorkspace.id, kind: 'statuses',
            })}
          />
          {/* Configure Labels EditPopover - anchored near sidebar */}
          <EditPopover
            open={editPopoverOpen === 'labels'}
            onOpenChange={(isOpen) => setEditPopoverOpen(isOpen ? 'labels' : null)}
            modal={true}
            trigger={
              <div
                className="fixed w-0 h-0 pointer-events-none"
                style={{ left: sidebarWidth + 20, top: editPopoverAnchorY.current }}
                aria-hidden="true"
              />
            }
            side="bottom"
            align="start"
            {...getManagedEditConfig('edit-labels', {
              scope: 'workspace', workspaceId: activeWorkspace.id, kind: 'labels',
            })}
          />
          {/* Edit Views EditPopover - anchored near sidebar */}
          <EditPopover
            open={editPopoverOpen === 'views'}
            onOpenChange={(isOpen) => setEditPopoverOpen(isOpen ? 'views' : null)}
            modal={true}
            trigger={
              <div
                className="fixed w-0 h-0 pointer-events-none"
                style={{ left: sidebarWidth + 20, top: editPopoverAnchorY.current }}
                aria-hidden="true"
              />
            }
            side="bottom"
            align="start"
            {...getManagedEditConfig('edit-views', {
              scope: 'workspace', workspaceId: activeWorkspace.id, kind: 'views',
            })}
          />
          {/* Add Source EditPopovers - one hidden managed session per variant. */}
          {(['add-source', 'add-source-api', 'add-source-mcp', 'add-source-local'] as const).map((variant) => (
            <EditPopover
              key={variant}
              open={editPopoverOpen === variant}
              onOpenChange={(isOpen) => setEditPopoverOpen(isOpen ? variant : null)}
              modal={true}
              trigger={
                <div
                  className="fixed w-0 h-0 pointer-events-none"
                  style={{ left: sidebarWidth + 20, top: editPopoverAnchorY.current }}
                  aria-hidden="true"
                />
              }
              side="bottom"
              align="start"
              {...getAddSourceEditConfig(variant, activeWorkspace.id)}
            />
          ))}
          {/* Add Skill EditPopover — hidden managed session with inline result. */}
          <EditPopover
            open={editPopoverOpen === 'add-skill'}
            onOpenChange={(isOpen) => setEditPopoverOpen(isOpen ? 'add-skill' : null)}
            modal={true}
            trigger={
              <div
                className="fixed w-0 h-0 pointer-events-none"
                style={{ left: sidebarWidth + 20, top: editPopoverAnchorY.current }}
                aria-hidden="true"
              />
            }
            side="bottom"
            align="start"
            {...getAddSkillEditConfig(activeWorkspace.id)}
          />
          {/* Add Automation EditPopover - triggered from "Add Automation" context menu in automations */}
          <EditPopover
            open={editPopoverOpen === 'automation-config'}
            onOpenChange={(isOpen) => setEditPopoverOpen(isOpen ? 'automation-config' : null)}
            modal={true}
            trigger={
              <div
                className="fixed w-0 h-0 pointer-events-none"
                style={{ left: sidebarWidth + 20, top: editPopoverAnchorY.current }}
                aria-hidden="true"
              />
            }
            side="bottom"
            align="start"
            {...getManagedEditConfig('automation-config', {
              scope: 'workspace', workspaceId: activeWorkspace.id, kind: 'automations',
            })}
          />
          {/* Add Automation EditPopovers - generic + type-specific */}
          {(['add-automation', 'add-automation-scheduled', 'add-automation-event', 'add-automation-agentic'] as const).map((variant) => (
            <EditPopover
              key={variant}
              open={editPopoverOpen === variant}
              onOpenChange={(isOpen) => setEditPopoverOpen(isOpen ? variant : null)}
              modal={true}
              trigger={
                <div
                  className="fixed w-0 h-0 pointer-events-none"
                  style={{ left: sidebarWidth + 20, top: editPopoverAnchorY.current }}
                  aria-hidden="true"
                />
              }
              side="bottom"
              align="start"
              {...getManagedEditConfig(variant, {
                scope: 'workspace', workspaceId: activeWorkspace.id, kind: 'automations',
              })}
            />
          ))}
          {/* Add Label EditPopover - triggered from "Add New Label" context menu on labels */}
          <EditPopover
            open={editPopoverOpen === 'add-label'}
            onOpenChange={(isOpen) => setEditPopoverOpen(isOpen ? 'add-label' : null)}
            modal={true}
            trigger={
              <div
                className="fixed w-0 h-0 pointer-events-none"
                style={{ left: sidebarWidth + 20, top: editPopoverAnchorY.current }}
                aria-hidden="true"
              />
            }
            side="bottom"
            align="start"
            {...getManagedEditConfig('add-label', {
              scope: 'workspace', workspaceId: activeWorkspace.id, kind: 'labels',
            })}
          />
        </>
      )}

      {/* What's New overlay */}
      <DocumentFormattedMarkdownOverlay
        isOpen={showWhatsNew}
        onClose={() => setShowWhatsNew(false)}
        content={releaseNotesContent}
        onOpenUrl={(url) => window.electronAPI.openUrl(url)}
      />

      {/* Delete automation confirmation dialog */}
      <Dialog open={!!automationPendingDelete} onOpenChange={(open) => { if (!open) setAutomationPendingDelete(null) }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t("dialog.deleteAutomation.title")}</DialogTitle>
            <DialogDescription>
              <Trans
                i18nKey="dialog.deleteAutomation.description"
                values={{ name: pendingDeleteAutomation?.name }}
                components={{ strong: <strong /> }}
              />
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAutomationPendingDelete(null)}>{t("common.cancel")}</Button>
            <Button variant="destructive" onClick={confirmDeleteAutomation}>{t("common.delete")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Send to Workspace dialog (driven by sendToWorkspaceAtom) */}
      <SendToWorkspaceDialog
        open={sendToWorkspaceIds.length > 0}
        onOpenChange={(open) => { if (!open) setSendToWorkspaceIds([]) }}
        sessionIds={sendToWorkspaceIds}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        onTransferComplete={handleTransferComplete}
      />

      {/* UA5.8 (v0.13.4 L3919–L3924) — Create Project dialog — prompts for a name so slugs stay meaningful */}
      <CreateProjectDialog
        open={createProjectDialogOpen}
        onCancel={() => setCreateProjectDialogOpen(false)}
        onSubmit={handleCreateProjectSubmit}
      />

      {/* UB7.4 — asks to update rtk when Token Optimization is on but the installed rtk corrupts output (upstream v0.15.1 AppShell.tsx:2915) */}
      <RtkUpdatePrompt workspaceId={activeWorkspaceId} />

    </AppShellProvider>
  )
}

// UA2.2 (v0.13.4 AppShell.tsx L77) — imported at the file end so the lines above keep the numbers
// the docs cite (AppShell.tsx, highest cited line 2037 on 2026-10-02).
import { BoardListToggle } from "./kanban/BoardListToggle"
import { resolveNavigatorWidth, showSessionListResizeHandle } from "./navigator-layout"
// UA7.3 (v0.13.4 AppShell.tsx L36, L121, L132) — imported at the file end, as UA2.2's, so the lines
// above keep the numbers the docs cite (highest cited line 2037 on 2026-10-02).
import { PanelsTopLeft } from "lucide-react"
import { isPagesNavigation } from "@/contexts/NavigationContext"
import { usePages } from "@/hooks/usePages"
// UA5.8 (v0.13.4 AppShell.tsx L120, L128, L131, L137) — imported at the file end, as UA2.2's and UA7.3's, so the
// lines above keep the numbers the docs cite (highest cited line 2037 on 2026-10-02).
import { FolderKanban } from "lucide-react"
import { isProjectsNavigation } from "@/contexts/NavigationContext"
import { useProjects } from "@/hooks/useProjects"
import { ProjectsListPanel } from "./ProjectsListPanel"
import { CreateProjectDialog } from "../projects/CreateProjectDialog"
// UA5.9 (v0.13.4 AppShell.tsx L139) — imported at the file end, as the rows above, so the cited lines keep their numbers.
import { resolveInheritedFilterParams } from "./inherited-filter-params"
// UA5.10 (v0.13.4 AppShell.tsx L795–L817) — imported at the file end, as the rows above, so the cited lines keep their numbers.
import { expandLabelFilterIds, isDeletedLabelView, withTaskScopeFilters, type TaskSessionsScope } from "./task-scope-filters"
// UA12.164 — imported at the file end, as the rows above, so the cited lines keep their numbers.
import { EntityListEmptyScreen } from "@/components/ui/entity-list-empty"
// UB14.5 (v0.15.1 AppShell.tsx L77) — imported at the file end, as the rows above, so the cited lines keep their numbers.
import { SessionFilterMenu } from "./SessionFilterMenu"
