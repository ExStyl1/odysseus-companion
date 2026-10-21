/**
 * NavigationContext
 *
 * Provides a global `navigate()` function that decouples components from
 * direct session/action imports. All navigation goes through typed routes.
 *
 * PEER PANEL MODEL:
 * All panels are equal. The **focused** panel drives the NavigationState
 * (which determines sidebar highlight, navigator content, etc.).
 * `navigate(route)` updates the focused panel's route.
 *
 * URL-DRIVEN HISTORY:
 * The URL is the source of truth. Every meaningful navigation pushes a
 * browser history entry via pushState. Back/forward uses the browser's
 * native popstate, with smart panel reconciliation to preserve React keys
 * (and thus scroll position, streaming state, etc.).
 *
 * Usage:
 *   import { useNavigation, useNavigationState } from '@/contexts/NavigationContext'
 *   import { routes } from '@/shared/routes'
 *
 *   const { navigate } = useNavigation()
 *   const navState = useNavigationState()
 *
 *   navigate(routes.view.allSessions())
 *   navigate(routes.action.newChat())
 */

import {
  createContext, useContext,
  useCallback, useEffect,
  useRef,
  useState,
  useMemo,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { useSession } from '@/hooks/useSession'
import { useLabels } from '@/hooks/useLabels'
import { matchesLabelFilter } from '@nessy-agent/shared/labels'
import {
  parseRoute,
  parseRouteToNavigationState,
  buildRouteFromNavigationState,
  buildRightSidebarParam,
  type ParsedRoute,
} from '../../shared/route-parser'
import { routes, type Route, type ViewRoute } from '../../shared/routes'
import { parsePermissionMode } from '@nessy-agent/shared/agent/mode-types'
import { NAVIGATE_EVENT, type NavigateOptions } from '../lib/navigate'
import { INSTALL_PLUGIN_ACTION, resolveDeepLinkAction, type DeepLinkOrigin } from './deep-link-policy'
import { pendingPluginInstallAtom } from '@/atoms/plugin-install-link'
import { isWorkspaceSwitchPending, normalizePanelRouteForReconcile, resolveInitialPanelRoute } from './navigation-reconcile'
import { buildSemanticHistoryKey, canRunInitialRestore } from './navigation-history'
import * as storage from '@/lib/local-storage'
import type {
  DeepLinkNavigation,
  Session,
  NavigationState,
  SessionFilter,
  SourceFilter,
  RightSidebarPanel,
  ContentBadge,
} from '../../shared/types'
import {
  isSessionsNavigation,
  isSourcesNavigation,
  isSettingsNavigation,
  isSkillsNavigation,
  isAutomationsNavigation,
  isPluginsNavigation, isPagesNavigation, isProjectsNavigation, // UA7.3, UA5.8 (v0.13.4) — one line, so the docs' cited lines keep their numbers
  DEFAULT_NAVIGATION_STATE,
} from '../../shared/types'
import { sessionMetaMapAtom, updateSessionMetaAtom, type SessionMeta } from '@/atoms/sessions'
import { sourcesAtom } from '@/atoms/sources'
import { skillsAtom } from '@/atoms/skills'
import { buildRuntimeResourceRows, firstSelectableRowId } from '@/lib/runtime-resource-rows'
import { capabilityRouteId } from '@/lib/capability-catalog'
import {
  panelStackAtom,
  pushPanelAtom,
  reconcilePanelStackAtom,
  focusedPanelIdAtom,
  focusedPanelRouteAtom,
  focusedPanelIndexAtom,
  updateFocusedPanelRouteAtom,
  parseSessionIdFromRoute,
} from '@/atoms/panel-stack'

// Re-export routes for convenience
export { routes }
export type { Route }

// Re-export navigation state types for consumers
export type { NavigationState, SessionFilter }
export { isSessionsNavigation, isSourcesNavigation, isSettingsNavigation, isSkillsNavigation, isAutomationsNavigation, isPluginsNavigation, isPagesNavigation, isProjectsNavigation }

// =============================================================================
// Session-creation failures
// =============================================================================

/**
 * The workspace pins a default project folder that cannot be used, so every
 * `createSession` in that workspace throws. Shipped in 1.25.0; d5ab20711
 * removed the unreachable-folder route into it, and the identity-change route
 * (the pinned path resolves to a DIFFERENT directory) still throws by design.
 */
const WORKSPACE_DEFAULT_PROJECT_INVALID = 'workspace-default-project-invalid'

/**
 * A session asked to start isolated in a git worktree and the host refused
 * (P6.133). A PREFIX, not an equality: `SessionManager.createSession` throws
 * `session-worktree-failed: <reason>`, where the reason is git's or the lease
 * service's own sentence — which is the actionable half and is shown verbatim
 * underneath.
 *
 * The refusal is deliberate: the host deletes the half-made session rather than
 * silently starting it in the live checkout, because "isolated or not at all" is
 * the whole of what the request asked for. So this is the one string in this
 * file that must NOT fall through to the raw-message branch — a user who asked
 * for isolation and got a bare git error has no way to know the session is gone.
 */
const SESSION_WORKTREE_FAILED = 'session-worktree-failed:'

/**
 * Turn a rejected `createSession` into something the user can read and act on.
 *
 * Until now nothing did: `openNewChat`, this file's `new-session` action and
 * SessionList's empty-state button each dropped the rejection, so a workspace
 * with a bad default-project pin answered the New Chat button with nothing at
 * all — no toast, no row, no error. Reproducing that took a CDP probe; a user
 * has no such option, which is the entire reason this exists.
 *
 * Matching is on `error.message` because it is the only part of the throw that
 * survives the hop: `WsRpcServer` puts `err.message` on the wire verbatim
 * (transport/server.ts:689) and `WsRpcClient` rebuilds a plain `Error` from it
 * (transport/client.ts:595), so class identity is gone by the time we see it.
 * `err.code` survives too, but only a `CodedError` carries one and
 * `createSession` throws bare `Error`s — every string below arrives under
 * `HANDLER_ERROR`, so the code field cannot tell them apart.
 *
 * **This paragraph said "only the ONE string a new-chat click can actually
 * produce is named", and P6.133 falsified it by adding a second control.** A
 * New Chat in Worktree passes `worktree: true`, and that call site can now
 * produce `session-worktree-failed:` — a refusal whose consequence (the
 * half-made session is DELETED) no raw git sentence conveys. So there are two
 * named strings, and the rule behind them is the durable part: **a string is
 * named here when a control in this app can produce it AND its raw text would
 * mislead about what happened.**
 *
 * The rest of `createSession`'s throws still need inputs these call sites never
 * send: no `projectHandleId` (so no `project-handle-invalid`), only the
 * `user_default` / `none` sentinels for `workingDirectory` (so no
 * `project-handle-required`), and no `branchFrom*` (so none of the branch
 * refusals, which ChatDisplay already reports under its own toast). A key for
 * those would be dead weight. Everything unnamed still surfaces, carrying its
 * raw message as the description — "it failed, and here is what it said" is the
 * whole difference from a button that appears broken.
 */
export function describeSessionCreateFailure(
  error: unknown,
  t: (key: string) => string,
): { title: string; description: string } {
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (message.startsWith(SESSION_WORKTREE_FAILED)) {
    const reason = message.slice(SESSION_WORKTREE_FAILED.length).trim()
    return {
      title: t('worktree.newChat.failedTitle'),
      // The host's own sentence is kept: it names WHICH git or lease condition
      // refused, which is the only part a user can act on. The key supplies
      // what the sentence cannot — that nothing was left behind.
      description: reason
        ? `${t('worktree.newChat.failedDesc')} ${reason}`
        : t('worktree.newChat.failedDesc'),
    }
  }
  return {
    title: t('toast.couldNotOpenChat'),
    description: message === WORKSPACE_DEFAULT_PROJECT_INVALID
      ? t('toast.couldNotOpenChatDefaultFolder')
      : message || t('toast.unknownError'),
  }
}

/** Show that failure. Also logged, because a toast is gone in five seconds. */
export function reportSessionCreateFailure(error: unknown, t: (key: string) => string): void {
  console.error('[Navigation] Could not create session:', error)
  const { title, description } = describeSessionCreateFailure(error, t)
  toast.error(title, { description })
}

// =============================================================================
// Context
// =============================================================================

interface NavigationContextValue {
  /** Navigate to a route */
  navigate: (route: Route, options?: NavigateOptions) => void | Promise<void>
  /** Check if navigation is ready */
  isReady: boolean
  /** Unified navigation state — derived from focused panel + right sidebar */
  navigationState: NavigationState
  /** Whether we can go back in history */
  canGoBack: boolean
  /** Whether we can go forward in history */
  canGoForward: boolean
  /** Go back in history */
  goBack: () => void
  /** Go forward in history */
  goForward: () => void
  /** Update right sidebar panel */
  updateRightSidebar: (panel: RightSidebarPanel | undefined) => void
  /** Toggle right sidebar (with optional panel) */
  toggleRightSidebar: (panel?: RightSidebarPanel) => void
  /** Navigate to a source (or source list if no slug), preserving the current filter type */
  navigateToSource: (sourceSlug?: string) => void
  /** Navigate to a session, preserving the current filter type */
  navigateToSession: (sessionId: string) => void
}

export const NavigationContext = createContext<NavigationContextValue | null>(null)

interface NavigationProviderProps {
  children: ReactNode
  /** Current workspace ID */
  workspaceId: string | null
  /** Switch to a Workspace by immutable ID when URL history crosses scopes. */
  onSwitchWorkspaceById?: (workspaceId: string) => void
  /** Session creation handler */
  onCreateSession: (workspaceId: string, options?: import('../../shared/types').CreateSessionOptions) => Promise<Session>
  /**
   * Input change handler for pre-filling chat input.
   *
   * `promptOrigin` marks the draft as coming from a link Nessy did not produce,
   * which is what the composer's disclosure line reads. Omitted means the text
   * was typed or came from a trusted in-app surface.
   */
  onInputChange?: (sessionId: string, value: string, promptOrigin?: import('@nessy-agent/shared/config').SessionDraft['promptOrigin']) => void
  /** Get draft input text for a session (reads from ref, no re-render) */
  getDraft?: (sessionId: string) => string
  /** Auto-delete an empty session (no confirmation needed) */
  onAutoDeleteEmptySession?: (sessionId: string) => void
  /** Whether the app is ready to navigate */
  isReady?: boolean
  /** Whether session metadata has been initialized (required for deterministic route restoration) */
  isSessionsReady?: boolean
  /** Remote workspace ID — when set, sessions with this ID are also considered part of the workspace */
  remoteWorkspaceId?: string | null
}

export function NavigationProvider({
  children,
  workspaceId,
  onSwitchWorkspaceById,
  onCreateSession,
  onInputChange,
  getDraft,
  onAutoDeleteEmptySession,
  isReady = true,
  isSessionsReady = true,
  remoteWorkspaceId,
}: NavigationProviderProps) {
  const { t } = useTranslation()
  const [, setSession] = useSession()

  // Read session metadata directly from atom (reactive to session changes)
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)
  const sessionMetas = useMemo(() => Array.from(sessionMetaMap.values()), [sessionMetaMap])
  const updateSessionMeta = useSetAtom(updateSessionMetaAtom)

  const pushPanel = useSetAtom(pushPanelAtom)

  // P6.512 — where an `install-plugin` link leaves its (untrusted) text for the
  // Plugins page to resolve against the marketplaces this machine has.
  const setPendingPluginInstall = useSetAtom(pendingPluginInstallAtom)

  // Store reference for reading fresh atom values in callbacks (avoids stale closures)
  const store = useStore()

  // Read sources from atom (populated by AppShell)
  const sources = useAtomValue(sourcesAtom)
  const { labels: labelConfigs } = useLabels(workspaceId) // F1.353 — the tree the 'label' filter matches descendants through
  // Read skills from atom (populated by AppShell)
  const skills = useAtomValue(skillsAtom)

  // =========================================================================
  // DERIVED NAVIGATION STATE (from focused panel + right sidebar)
  // =========================================================================

  const focusedRoute = useAtomValue(focusedPanelRouteAtom)

  // Right sidebar is independent of panels (not per-panel state)
  const [rightSidebar, setRightSidebar] = useState<RightSidebarPanel | undefined>()
  const rightSidebarRef = useRef<RightSidebarPanel | undefined>(rightSidebar)
  useEffect(() => { rightSidebarRef.current = rightSidebar }, [rightSidebar])

  // NavigationState derived from the focused panel's route
  const navigationState: NavigationState = useMemo(() => {
    const base = focusedRoute
      ? parseRouteToNavigationState(focusedRoute) ?? DEFAULT_NAVIGATION_STATE
      : DEFAULT_NAVIGATION_STATE
    return rightSidebar ? { ...base, rightSidebar } : base
  }, [focusedRoute, rightSidebar])

  // =========================================================================
  // BROWSER HISTORY TRACKING
  // =========================================================================

  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)

  // Sequence numbers stored in history.state for tracking position
  const historySeqRef = useRef(0)                // Current history position
  const historyMaxSeqRef = useRef(0)              // Highest pushed seq (for canGoForward)
  const nextHistorySeqRef = useRef(1)             // Next seq to assign on pushState

  // Suppress pushState in atom subscriptions during restore/reconciliation
  const suppressPushRef = useRef(false)

  // Coalesce compound atom writes (e.g. pushPanelAtom sets both panelStackAtom
  // and focusedPanelIdAtom) into a single pushState via microtask debounce
  const pendingPushRef = useRef(false)

  // Flag: workspace switch was triggered by popstate (URL already correct)
  const isPopstateSwitchRef = useRef(false)

  // Queue navigation if not ready yet. The options travel with the route so a
  // deep link that lands before the renderer is ready keeps its origin.
  const pendingNavigationRef = useRef<{ parsed: ParsedRoute; options?: NavigateOptions; route: Route } | null>(null)

  // Suppress auto-select for one cycle (used by skipAutoSelect to prevent the effect from re-selecting)
  const suppressAutoSelectRef = useRef(false)

  // Track whether initial route restoration has been attempted
  const initialRouteRestoredRef = useRef(false)

  // Semantic key for the last history entry we intentionally pushed/reconciled.
  // Excludes layout-only values (like panel proportions) so resize does not create history entries.
  const lastSemanticHistoryKeyRef = useRef('')

  const updateCanGoBackForward = useCallback(() => {
    setCanGoBack(historySeqRef.current > 0)
    setCanGoForward(historySeqRef.current < historyMaxSeqRef.current)
  }, [])

  const getSemanticHistoryKey = useCallback(() => {
    const panels = store.get(panelStackAtom)
    const focusedIdx = store.get(focusedPanelIndexAtom)
    const sidebarKey = buildRightSidebarParam(rightSidebarRef.current) ?? ''
    return buildSemanticHistoryKey({
      workspaceId,
      panelRoutes: panels.map(p => p.route),
      focusedPanelIndex: focusedIdx,
      sidebarParam: sidebarKey,
    })
  }, [store, workspaceId])

  // =========================================================================
  // URL SYNC (builds URL from current state, push or replace)
  // =========================================================================

  /**
   * Build the current URL from atom state and either push or replace.
   *
   * push=true: creates a new browser history entry (meaningful navigation)
   * push=false: updates the current entry (resize, auto-select, etc.)
   *
   * Also persists the URL per-workspace in localStorage for workspace switch restoration.
   */
  const syncUrl = useCallback((push: boolean = false) => {
    const panels = store.get(panelStackAtom)
    const focusedIdx = store.get(focusedPanelIndexAtom)
    if (panels.length === 0 || isWorkspaceSwitchPending(previousWorkspaceIdRef.current, workspaceId)) return // UA12.179 follow-up: the old panels are still mounted until the switch is consumed — never save them under the new workspace's key

    const focusedPanel = panels[focusedIdx] ?? panels[0]
    const url = new URL(window.location.href)

    // ?ws= immutable Workspace ID
    if (workspaceId) {
      url.searchParams.set('ws', workspaceId)
    }

    // ?route= is the focused panel's route
    url.searchParams.set('route', focusedPanel.route)

    // ?panels= encodes ALL panels in stack order
    if (panels.length > 1) {
      const encoded = panels.map(p => `${p.route}:${p.proportion.toFixed(4)}`).join(',')
      url.searchParams.set('panels', encoded)
    } else {
      url.searchParams.delete('panels')
    }

    // ?fi= is focused panel index (for multi-panel layouts)
    if (panels.length > 1) {
      url.searchParams.set('fi', String(focusedIdx))
    } else {
      url.searchParams.delete('fi')
    }

    // ?sidebar=
    const sidebarParam = buildRightSidebarParam(rightSidebarRef.current)
    if (sidebarParam) {
      url.searchParams.set('sidebar', sidebarParam)
    } else {
      url.searchParams.delete('sidebar')
    }

    const urlStr = url.toString()

    if (push) {
      const seq = nextHistorySeqRef.current++
      history.pushState({ seq }, '', urlStr)
      historySeqRef.current = seq
      historyMaxSeqRef.current = seq // Forward history discarded by browser
      updateCanGoBackForward()
    } else {
      history.replaceState({ ...history.state, seq: historySeqRef.current }, '', urlStr)
    }

    // Persist per-workspace URL for workspace switch restoration
    if (workspaceId) {
      storage.set(storage.KEYS.workspaceUrl, url.search, workspaceId)
    }
  }, [store, workspaceId, updateCanGoBackForward])

  const syncUrlRef = useRef(syncUrl)
  useEffect(() => { syncUrlRef.current = syncUrl }, [syncUrl])

  const maybePushHistoryForSemanticChange = useCallback(() => {
    const currentSemanticKey = getSemanticHistoryKey()
    if (currentSemanticKey === lastSemanticHistoryKeyRef.current) return

    syncUrlRef.current?.(true)
    lastSemanticHistoryKeyRef.current = currentSemanticKey
  }, [getSemanticHistoryKey])

  // replaceState sync when panel stack, focus, or sidebar changes (catches resize, etc.)
  const panelStack = useAtomValue(panelStackAtom)
  const focusedPanelId = useAtomValue(focusedPanelIdAtom)
  useEffect(() => {
    if (!initialRouteRestoredRef.current) return
    syncUrlRef.current(false)
  }, [panelStack, focusedPanelId, rightSidebar])

  // =========================================================================
  // ATOM SUBSCRIPTIONS FOR pushState (meaningful navigation)
  // =========================================================================

  // Panel stack changes: push history on add/remove/route change (NOT resize)
  useEffect(() => {
    let prevRoutes = store.get(panelStackAtom).map(p => p.route)
    const unsub = store.sub(panelStackAtom, () => {
      if (suppressPushRef.current || !initialRouteRestoredRef.current) return
      const currRoutes = store.get(panelStackAtom).map(p => p.route)
      if (currRoutes.length !== prevRoutes.length || !currRoutes.every((r, i) => r === prevRoutes[i])) {
        if (!pendingPushRef.current) {
          pendingPushRef.current = true
          queueMicrotask(() => { pendingPushRef.current = false; maybePushHistoryForSemanticChange() })
        }
      }
      prevRoutes = currRoutes
    })
    return unsub
  }, [store, maybePushHistoryForSemanticChange])

  // Focus changes: push history when active panel changes
  useEffect(() => {
    let prevFocusId = store.get(focusedPanelIdAtom)
    const unsub = store.sub(focusedPanelIdAtom, () => {
      if (suppressPushRef.current || !initialRouteRestoredRef.current) return
      const newFocusId = store.get(focusedPanelIdAtom)
      if (newFocusId !== prevFocusId) {
        if (!pendingPushRef.current) {
          pendingPushRef.current = true
          queueMicrotask(() => { pendingPushRef.current = false; maybePushHistoryForSemanticChange() })
        }
        prevFocusId = newFocusId
      }
    })
    return unsub
  }, [store, maybePushHistoryForSemanticChange])

  // Right sidebar changes: push history
  const prevSidebarTypeRef = useRef(rightSidebar?.type)
  useEffect(() => {
    if (rightSidebar?.type === prevSidebarTypeRef.current) return
    prevSidebarTypeRef.current = rightSidebar?.type
    if (suppressPushRef.current) return
    if (!initialRouteRestoredRef.current) return
    maybePushHistoryForSemanticChange()
  }, [rightSidebar, maybePushHistoryForSemanticChange])

  // =========================================================================
  // RECONCILE PANELS FROM URL PARAMS
  // =========================================================================

  /**
   * Parse URL search params and reconcile the panel stack + sidebar.
   * Uses reconcilePanelStackAtom for smart matching (preserves React keys).
   */
  const reconcileFromUrlParams = useCallback(
    (params: URLSearchParams) => {
      const initialRoute = params.get('route')
      const sidebarParam = params.get('sidebar') || undefined
      const panelsParam = params.get('panels')
      const focusedIndexParam = params.get('fi')

      // Restore right sidebar
      if (sidebarParam) {
        const parsed = parseRouteToNavigationState('allSessions', sidebarParam)
        if (parsed?.rightSidebar) {
          setRightSidebar(parsed.rightSidebar)
        } else {
          setRightSidebar(undefined)
        }
      } else {
        setRightSidebar(undefined)
      }

      // Parse panel entries from URL
      let entries: { route: ViewRoute; proportion: number }[] = []
      let focusedIndex = 0

      if (panelsParam) {
        // Canonical format: ?panels= contains ALL panels, ?fi= is focused index.
        // We intentionally no longer support older mixed route/panels formats.
        entries = panelsParam.split(',').filter(Boolean).map(entry => {
          const colonIdx = entry.lastIndexOf(':')
          if (colonIdx > 0) {
            const proportion = parseFloat(entry.slice(colonIdx + 1))
            if (!isNaN(proportion) && proportion > 0 && proportion < 1) {
              const rawRoute = entry.slice(0, colonIdx) as ViewRoute
              const route = normalizePanelRouteForReconcile(rawRoute, (state) => resolveAutoSelectionRef.current(state))
              return { route, proportion }
            }
          }
          const rawRoute = entry as ViewRoute
          const route = normalizePanelRouteForReconcile(rawRoute, (state) => resolveAutoSelectionRef.current(state))
          return { route, proportion: 0 }
        })

        const hasProportions = entries.some(e => e.proportion > 0)
        if (!hasProportions) {
          const equal = 1 / entries.length
          entries.forEach(e => { e.proportion = equal })
        } else {
          const total = entries.reduce((s, e) => s + e.proportion, 0)
          if (total > 0 && Math.abs(total - 1) > 0.001) {
            entries.forEach(e => { e.proportion = e.proportion / total })
          }
        }

        focusedIndex = focusedIndexParam != null ? (parseInt(focusedIndexParam, 10) || 0) : 0
      } else if (initialRoute) {
        // Single panel from ?route= — UA12.155: a detail route whose target was deleted resolves to a
        // LIVE route (the auto-selected fallback, else the plain view) instead of booting into
        // session-not-found with a dead route and a stale composer (SIT-D F5); a live target keeps the
        // URL verbatim and a filter-only route auto-selects, exactly as before (navigation-reconcile.ts).
        const finalRoute = resolveInitialPanelRoute(initialRoute, (state) => resolveAutoSelectionRef.current(state))
        if (finalRoute) {
          entries = [{ route: finalRoute, proportion: 1 }]
        }
      }

      if (entries.length > 0) {
        store.set(reconcilePanelStackAtom, { entries, focusedIndex })
      }
    },
    [store]
  )

  // Keep ref fresh for use in event handlers / effects that capture stale closures
  const reconcileFromUrlParamsRef = useRef(reconcileFromUrlParams)
  useEffect(() => { reconcileFromUrlParamsRef.current = reconcileFromUrlParams }, [reconcileFromUrlParams])

  // =========================================================================
  // EMPTY SESSION CLEANUP (reactive — covers navigate, close tab, etc.)
  // =========================================================================

  // Track which session IDs are visible across all panels. When a session ID
  // disappears (navigate away, close tab, Cmd+W), check if it was empty and
  // auto-delete it. This is the single codepath for all navigate-away cleanup.
  const prevVisibleSessionIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const currentIds = new Set<string>()
    for (const entry of panelStack) {
      const sessionId = parseSessionIdFromRoute(entry.route)
      if (sessionId) currentIds.add(sessionId)
    }

    // Only check after we've seen at least one set of IDs
    // (skip first render to avoid false positives during initialization)
    if (onAutoDeleteEmptySession && prevVisibleSessionIdsRef.current.size > 0) {
      for (const prevId of prevVisibleSessionIdsRef.current) {
        if (!currentIds.has(prevId)) {
          const meta = store.get(sessionMetaMapAtom).get(prevId)
          const isEmpty = meta && !meta.lastFinalMessageId && !meta.name && !meta.isProcessing
          const hasDraft = getDraft?.(prevId)?.trim()
          if (isEmpty && !hasDraft) {
            onAutoDeleteEmptySession(prevId)
          }
        }
      }
    }

    prevVisibleSessionIdsRef.current = currentIds
  }, [panelStack, onAutoDeleteEmptySession, store, getDraft])

  // =========================================================================
  // SESSION SELECTION SYNC
  // =========================================================================

  // Keep the global session selection in sync with the focused panel
  useEffect(() => {
    if (isSessionsNavigation(navigationState) && navigationState.details) {
      setSession({ selected: navigationState.details.sessionId })
      if (workspaceId) {
        // Only persist if the session belongs to this workspace (prevents cross-workspace
        // pollution during workspace switch, when workspaceId changed but navigationState
        // still reflects the old workspace's focused panel)
        const meta = store.get(sessionMetaMapAtom).get(navigationState.details.sessionId)
        if (meta && meta.workspaceId === workspaceId) {
          storage.set(storage.KEYS.lastSelectedSessionId, navigationState.details.sessionId, workspaceId)
        }
      }
    }
  }, [navigationState, setSession, workspaceId, store])

  // =========================================================================
  // HELPERS
  // =========================================================================

  // Helper: Filter sessions by SessionFilter
  // Always excludes hidden sessions - they should never appear in navigation
  const filterSessionsByFilter = useCallback(
    (filter: SessionFilter): SessionMeta[] => {
      // First filter out hidden sessions - they should never appear in any view
      const visibleSessions = sessionMetas.filter(
        s => !s.hidden && (!workspaceId || s.workspaceId === workspaceId)
      )

      return visibleSessions.filter((session) => {
        switch (filter.kind) {
          case 'allSessions':
            return session.isArchived !== true
          case 'flagged':
            return session.isFlagged === true && session.isArchived !== true
          case 'archived':
            return session.isArchived === true
          case 'state':
            return session.sessionStatus === filter.stateId && session.isArchived !== true
          case 'label': {
            if (session.isArchived === true) return false
            if (!session.labels?.length) return false
            if (filter.labelId === '__all__') return true
            return matchesLabelFilter(session, filter, labelConfigs)
          }
          case 'view':
            if (session.isArchived === true) return false
            return true
          default: {
            // D1.311 — `SessionFilter` (`apps/electron/src/shared/types.ts`) is a
            // CLOSED union of six `kind` members and all six are above, so this
            // arm is reachable only by a filter that arrived through a cast. The
            // binding is what makes a SEVENTH member a BUILD failure on this
            // line (TS2322 — it is not assignable to `never`) instead of a
            // filter that silently hides every session: the `return false`
            // below is the right answer for a cast, and the wrong one for a
            // member somebody forgot to handle, and without the binding the two
            // are indistinguishable.
            //
            // D1.252's shape, and its reason for keeping the return BESIDE the
            // binding rather than returning it applies here too: a filter this
            // switch does not know must still drop the session rather than
            // show every one of them.
            const unhandledFilter: never = filter
            void unhandledFilter
            return false
          }
        }
      })
    },
    [sessionMetas, workspaceId, labelConfigs]
  )

  const getFirstSessionId = useCallback(
    (filter: SessionFilter): string | null => {
      const filtered = filterSessionsByFilter(filter)
      return filtered[0]?.id ?? null
    },
    [filterSessionsByFilter]
  )

  const getLastSelectedSessionId = useCallback(
    (filter: SessionFilter): string | null => {
      if (!workspaceId) return null
      const storedId = storage.get<string | null>(
        storage.KEYS.lastSelectedSessionId,
        null,
        workspaceId
      )
      if (!storedId) return null
      const filtered = filterSessionsByFilter(filter)
      return filtered.some(session => session.id === storedId) ? storedId : null
    },
    [workspaceId, filterSessionsByFilter]
  )

  const getFirstSourceSlug = useCallback(
    (filter?: SourceFilter | null): string | null => {
      return firstSelectableRowId(buildRuntimeResourceRows({
        capabilities: [...sources, ...skills],
        filter,
      }))
    },
    [skills, sources]
  )

  // Skills home displays the complete role catalog; no first-item fallback.

  // =========================================================================
  // AUTO-SELECTION (pure computation, no side effects)
  // =========================================================================

  /**
   * Resolve auto-selection for a NavigationState.
   * When navigating to a filter without explicit details, auto-select the
   * first available item. Returns the final state (no side effects).
   */
  const resolveAutoSelection = useCallback(
    (newState: NavigationState, options?: { skipAutoSelect?: boolean }): NavigationState => {
      let nextState = newState

      // Validate session exists in current workspace (local or remote ID)
      if (isSessionsNavigation(nextState) && nextState.details) {
        const freshMetaMap = store.get(sessionMetaMapAtom)
        const meta = freshMetaMap.get(nextState.details.sessionId)
        const matchesWorkspace = !workspaceId
          || meta?.workspaceId === workspaceId
          || (remoteWorkspaceId && meta?.workspaceId === remoteWorkspaceId)
        if (!meta || !matchesWorkspace) {
          nextState = { ...nextState, details: null }
        }
      }

      // Sessions: auto-select last/first session — never in board view (UA2.2, v0.13.4): it has no per-session detail
      if (isSessionsNavigation(nextState) && nextState.viewMode !== 'board' && !nextState.details && !options?.skipAutoSelect) {
        const lastSelectedSessionId = getLastSelectedSessionId(nextState.filter)
        const fallbackSessionId = lastSelectedSessionId ?? getFirstSessionId(nextState.filter)
        if (fallbackSessionId) {
          return { ...nextState, details: { type: 'session', sessionId: fallbackSessionId } }
        }
        return nextState
      }

      // Sources: auto-select first source
      if (isSourcesNavigation(nextState) && !nextState.details && !options?.skipAutoSelect) {
        const firstSourceSlug = getFirstSourceSlug(nextState.filter)
        if (firstSourceSlug) {
          return { ...nextState, details: { type: 'source', sourceSlug: firstSourceSlug } }
        }
        return nextState
      }

      // An empty skills route is the catalog home, including after URL restoration.

      return nextState
    },
    [store, workspaceId, remoteWorkspaceId, getLastSelectedSessionId, getFirstSessionId, getFirstSourceSlug]
  )

  // Ref keeps resolveAutoSelection fresh for reconcileFromUrlParams (defined earlier in the file)
  const resolveAutoSelectionRef = useRef(resolveAutoSelection)
  useEffect(() => { resolveAutoSelectionRef.current = resolveAutoSelection }, [resolveAutoSelection])

  // =========================================================================
  // ACTION NAVIGATION
  // =========================================================================

  const handleActionNavigation = useCallback(
    async (parsed: ParsedRoute, options?: { newPanel?: boolean; targetLaneId?: 'main'; origin?: DeepLinkOrigin }) => {
      if (!workspaceId) return

      // A link from outside the app is inert: it may choose a directory and fill
      // the prompt box, and nothing reaches the model until the user reads the
      // prefill and presses Enter. Origin is absent on every in-app navigation;
      // only the deep-link listener marks a route external (reading a missing
      // DeepLinkNavigation.origin as external).
      const link = resolveDeepLinkAction(parsed.name, parsed.params, options?.origin)

      if (link.blocked) {
        console.warn('[Navigation] Refused state-mutating action from an external link:', parsed.name)
        toast.error(t('toast.invalidLink'), {
          description: t('toast.invalidLinkDesc'),
        })
        return
      }

      switch (parsed.name) {
        case 'new-session': {
          const createOptions: import('../../shared/types').CreateSessionOptions = link.trusted && parsed.params.project ? { projectId: parsed.params.project } : {} // UA5.8 (v0.13.4) `?project=`; in-app links only, as `mode` (one line: cited file)
          // mode/model/systemPrompt are ignored for an external link.
          // parsePermissionMode accepts bypassPermissions (also spelled
          // `allowall` / `execute`) and the value is persisted onto the new
          // session's header, so honouring it here is a privilege-escalation
          // path a single click on an untrusted page could take.
          if (link.trusted && parsed.params.mode) {
            const parsedMode = parsePermissionMode(parsed.params.mode)
            if (parsedMode) {
              createOptions.permissionMode = parsedMode
            }
          }
          if (parsed.params.workdir) {
            if (parsed.params.workdir !== 'user_default' && parsed.params.workdir !== 'none') {
              throw new Error('Project folders must be selected through a validated project handle')
            }
            createOptions.workingDirectory = parsed.params.workdir
          }
          if (link.trusted && parsed.params.model) {
            createOptions.model = parsed.params.model
          }
          if (link.trusted && parsed.params.systemPrompt) {
            createOptions.systemPromptPreset = parsed.params.systemPrompt as 'default' | 'mini' | string
          }
          // P6.133 — the host worktree port's first user-reachable caller.
          // `link.trusted` gates it for the same reason it gates `mode`:
          // creating a worktree runs git and takes a host lease, which is a
          // filesystem side effect a single click on an untrusted page must not
          // be able to cause. In-app navigation carries no origin and is
          // trusted; the deep-link listener marks an external route and is not.
          if (link.trusted && parsed.params.worktree === 'true') {
            createOptions.worktree = true
          }
          // A rejection here used to travel up through `navigate`, and not one
          // of its 69 renderer call sites awaits it — so it became an unhandled
          // rejection every time, which is why the button looked dead. Report
          // and stop: there is no session id to navigate to, and every
          // statement below needs one.
          let session: Session
          try {
            session = await onCreateSession(workspaceId, createOptions)
          } catch (error) {
            reportSessionCreateFailure(error, t)
            break
          }

          if (parsed.params.name) {
            await window.electronAPI.sessionCommand(session.id, { type: 'rename', name: parsed.params.name })
          }

          if (parsed.params.status) {
            updateSessionMeta(session.id, { sessionStatus: parsed.params.status })
          }
          if (parsed.params.label) {
            updateSessionMeta(session.id, { labels: [parsed.params.label] })
          }

          if (parsed.params.status) {
            await window.electronAPI.sessionCommand(session.id, { type: 'setSessionStatus', state: parsed.params.status })
          }
          if (parsed.params.label) {
            await window.electronAPI.sessionCommand(session.id, { type: 'setLabels', labels: [parsed.params.label] })
          }

          // Determine navigation filter
          const filter: import('../../shared/types').SessionFilter =
            parsed.params.status ? { kind: 'state', stateId: parsed.params.status } :
            parsed.params.label ? { kind: 'label', labelId: parsed.params.label } :
            { kind: 'allSessions' }

          if (options?.newPanel) {
            // Open the new session in a new panel using lane-aware routing (pushPanel auto-focuses it)
            pushPanel({
              route: routes.view.allSessions(session.id) as ViewRoute,
              targetLaneId: options.targetLaneId,
              intent: 'explicit',
            })
          } else {
            // Navigate the focused panel to the new session
            const newState: NavigationState = {
              navigator: 'sessions',
              filter,
              details: { type: 'session', sessionId: session.id },
            }
            const route = buildRouteFromNavigationState(newState) as ViewRoute
            store.set(updateFocusedPanelRouteAtom, route)
            // Session selection sync handled by effect
          }

          // Parse badges from params
          let badges: ContentBadge[] | undefined
          if (parsed.params.badges) {
            try {
              badges = JSON.parse(parsed.params.badges) as ContentBadge[]
            } catch (e) {
              console.warn('[Navigation] Failed to parse badges param:', e)
            }
          }

          // Handle input: either auto-send or pre-fill. An external link never
          // sends — `send=true` is ignored and the text is only prefilled, capped
          // at the documented 5,000 characters (see deep-link-policy). The
          // prefill is marked so the composer can disclose where it came from;
          // an inert prompt the user cannot tell apart from one they typed is
          // half a safeguard.
          if (link.input) {
            if (link.send) {
              setTimeout(() => {
                window.electronAPI.sendMessage(
                  session.id,
                  link.input!,
                  undefined,
                  undefined,
                  badges ? { badges } : undefined
                )
              }, 100)
            } else if (onInputChange) {
              setTimeout(() => {
                onInputChange(session.id, link.input!, link.trusted ? undefined : 'external-link')
              }, 100)
            }
          }
          break
        }

        case 'rename-session':
          if (parsed.id && parsed.params.name) {
            await window.electronAPI.sessionCommand(parsed.id, { type: 'rename', name: parsed.params.name })
          }
          break

        case 'delete-session': { // UA1.26 — no dialog as upstream, except a SHARED chat is asked about its link first
          const meta = parsed.id ? store.get(sessionMetaMapAtom).get(parsed.id) : undefined
          const go = !!parsed.id && (!deleteNeedsConfirmation(meta, true) || await window.electronAPI.showDeleteSessionConfirmation(meta?.name || 'Untitled', parsed.id))
          if (go && parsed.id) await window.electronAPI.deleteSession(parsed.id)
          break
        }
        case 'flag-session':
          if (parsed.id) {
            await window.electronAPI.sessionCommand(parsed.id, { type: 'flag' })
          }
          break

        case 'unflag-session':
          if (parsed.id) {
            await window.electronAPI.sessionCommand(parsed.id, { type: 'unflag' })
          }
          break

        case 'oauth':
          if (parsed.id) {
            await window.electronAPI.performOAuth({ workspaceId, sourceSlug: parsed.id })
          }
          break

        case 'delete-source':
          if (parsed.id) {
            await window.electronAPI.deleteSource(workspaceId, parsed.id)
          }
          break

        case 'set-mode':
          if (parsed.id && parsed.params.mode) {
            const parsedMode = parsePermissionMode(parsed.params.mode)
            if (!parsedMode) {
              console.warn('[Navigation] Invalid permission mode:', parsed.params.mode)
              break
            }
            await window.electronAPI.sessionCommand(
              parsed.id,
              { type: 'setPermissionMode', mode: parsedMode }
            )
          }
          break

        case 'copy':
          if (parsed.params.text) {
            await navigator.clipboard.writeText(parsed.params.text)
          }
          break

        // P6.512 — an install link PRE-FILLS the marketplace browse and installs
        // nothing. The verdict is not taken here: `resolveInstallPluginLink`
        // decides against the marketplaces this machine has already registered,
        // and that list lives in the Plugins page's own query, so the link's own
        // two fields are parked and the page is the single gate. A link naming a
        // marketplace nobody has is refused there and never added.
        case INSTALL_PLUGIN_ACTION: {
          const id = (parsed.id ?? parsed.params.plugin ?? '').trim()
          if (!id) {
            console.warn('[Navigation] Install link named no plugin')
            toast.error(t('toast.invalidLink'), { description: t('toast.invalidLinkDesc') })
            break
          }
          setPendingPluginInstall({
            id,
            ...(parsed.params.marketplace ? { marketplace: parsed.params.marketplace } : {}),
          })
          store.set(updateFocusedPanelRouteAtom, routes.view.plugins() as ViewRoute)
          break
        }

        default:
          console.warn('[Navigation] Unknown action:', parsed.name)
      }
    },
    [workspaceId, onCreateSession, onInputChange, pushPanel, setPendingPluginInstall, store, updateSessionMeta, t]
  )

  // =========================================================================
  // NAVIGATE
  // =========================================================================

  const navigate = useCallback(
    async (route: Route, options?: NavigateOptions) => {
      // Reset auto-select suppression on any normal navigation
      if (!options?.skipAutoSelect) {
        suppressAutoSelectRef.current = false
      }

      const parsed = parseRoute(route)
      if (!parsed) {
        console.warn('[Navigation] Invalid route:', route)
        return
      }

      if (!isReady) {
        pendingNavigationRef.current = { parsed, options, route }
        return
      }

      // Handle actions (side effects)
      if (parsed.type === 'action') {
        await handleActionNavigation(parsed, options)
        return
      }

      // For view routes with newPanel: push a panel using lane-aware routing.
      //
      // Important distinction:
      // - explicit opens (intent='explicit') can target a specific lane
      // - implicit navigation (updateFocusedPanelRouteAtom path) applies lock/fallback
      // This mirrors VS Code-style "locked group" behavior.
      if (options?.newPanel) {
        pushPanel({
          route: route as ViewRoute,
          targetLaneId: options.targetLaneId,
          intent: 'explicit',
        })
        return
      }

      // Parse route to NavigationState. Bare `settings` produces `subpage: null` —
      // navigator-only view in compact mode, App-page fallback on desktop. We
      // intentionally do NOT auto-redirect to the last-visited subpage; doing so
      // would defeat the compact-mode drill-in UX.
      const newNavState = parseRouteToNavigationState(route)

      // Suppress auto-select effect
      if (options?.skipAutoSelect) {
        suppressAutoSelectRef.current = true
      }

      if (newNavState) {
        // Resolve auto-selection (pure — no side effects)
        const resolvedState = resolveAutoSelection(newNavState, options)
        const finalRoute = buildRouteFromNavigationState(resolvedState) as ViewRoute

        // Persist last selected session for auto-select on next visit
        if (isSessionsNavigation(resolvedState) && resolvedState.details && workspaceId) {
          storage.set(storage.KEYS.lastSelectedSessionId, resolvedState.details.sessionId, workspaceId)
        }

        // Update the focused panel's route (atom update is synchronous)
        // The panelStack atom subscription detects the route change and calls syncUrl(true)
        store.set(updateFocusedPanelRouteAtom, finalRoute)
      }
    },
    [isReady, handleActionNavigation, resolveAutoSelection, store, pushPanel, workspaceId]
  )

  // =========================================================================
  // BACK / FORWARD (browser history)
  // =========================================================================

  const goBack = useCallback(() => {
    history.back()
  }, [])

  const goForward = useCallback(() => {
    history.forward()
  }, [])

  // =========================================================================
  // POPSTATE HANDLER (browser back/forward)
  // =========================================================================

  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      // Update sequence tracking
      const eventSeq = event.state?.seq ?? 0
      historySeqRef.current = eventSeq
      updateCanGoBackForward()

      // Read state from URL (the browser already navigated to it)
      const params = new URLSearchParams(window.location.search)
      const nextWorkspaceId = params.get('ws')

      // Check if workspace changed
      if (nextWorkspaceId && nextWorkspaceId !== workspaceId && onSwitchWorkspaceById) {
        // Workspace boundary crossed — trigger workspace switch
        // The workspace switch effect will handle reconciliation
        isPopstateSwitchRef.current = true
        onSwitchWorkspaceById(nextWorkspaceId)
        return
      }

      if (!isSessionsReady) {
        // Session metadata is not initialized yet; initial restore will reconcile
        // current URL state once metadata is available.
        return
      }

      // Same workspace — reconcile panels from the URL
      suppressPushRef.current = true
      reconcileFromUrlParamsRef.current(params)
      lastSemanticHistoryKeyRef.current = getSemanticHistoryKey()
      requestAnimationFrame(() => {
        suppressPushRef.current = false
      })
    }

    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [workspaceId, onSwitchWorkspaceById, updateCanGoBackForward, getSemanticHistoryKey, isSessionsReady])

  // =========================================================================
  // WORKSPACE SWITCH
  // =========================================================================

  const previousWorkspaceIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (!workspaceId || !isSessionsReady) return

    if (previousWorkspaceIdRef.current === null) {
      // First mount — initial route restoration handles it
      previousWorkspaceIdRef.current = workspaceId
      return
    }

    if (previousWorkspaceIdRef.current === workspaceId) return
    previousWorkspaceIdRef.current = workspaceId

    // Suppress pushState during reconciliation
    suppressPushRef.current = true

    if (isPopstateSwitchRef.current) {
      // Popstate-triggered: URL is already correct, just reconcile from it
      isPopstateSwitchRef.current = false
      reconcileFromUrlParamsRef.current(new URLSearchParams(window.location.search))
      lastSemanticHistoryKeyRef.current = getSemanticHistoryKey()
    } else {
      // UI-triggered: load stored URL for the new workspace, push history entry
      const savedSearch = storage.get<string>(storage.KEYS.workspaceUrl, '', workspaceId)

      const url = new URL(window.location.href)
      if (savedSearch) {
        // Replace all params with the saved workspace's URL
        url.search = savedSearch
      } else {
        // No saved state — default to allSessions
        for (const key of [...url.searchParams.keys()]) {
          url.searchParams.delete(key)
        }
        url.searchParams.set('ws', workspaceId)
        url.searchParams.set('route', 'allSessions')
      }

      // Push a new history entry for the workspace switch
      const seq = nextHistorySeqRef.current++
      history.pushState({ seq }, '', url.toString())
      historySeqRef.current = seq
      historyMaxSeqRef.current = seq
      updateCanGoBackForward()

      // Reconcile panels from the new URL
      reconcileFromUrlParamsRef.current(new URLSearchParams(url.search))
      lastSemanticHistoryKeyRef.current = getSemanticHistoryKey()
    }

    initialRouteRestoredRef.current = true

    requestAnimationFrame(() => {
      suppressPushRef.current = false
      lastSemanticHistoryKeyRef.current = getSemanticHistoryKey()
    })
  }, [workspaceId, store, updateCanGoBackForward, getSemanticHistoryKey, isSessionsReady])

  // =========================================================================
  // INITIAL ROUTE RESTORATION (CMD+R reload)
  // =========================================================================

  useEffect(() => {
    if (!canRunInitialRestore({
      isReady,
      isSessionsReady,
      workspaceId,
      initialRouteRestored: initialRouteRestoredRef.current,
    })) return
    initialRouteRestoredRef.current = true

    // Suppress pushState during initial restoration
    suppressPushRef.current = true

    const params = new URLSearchParams(window.location.search)

    // Reconcile panels + sidebar from current URL
    reconcileFromUrlParamsRef.current(params)
    lastSemanticHistoryKeyRef.current = getSemanticHistoryKey()

    // If nothing was in the URL, navigate to default
    if (!params.get('route') && !params.get('panels')) {
      navigate(routes.view.allSessions())
    }

    // Initialize history with seq=0 (replaceState so we don't create an extra entry)
    history.replaceState({ seq: 0 }, '', window.location.href)
    historySeqRef.current = 0
    historyMaxSeqRef.current = 0

    requestAnimationFrame(() => {
      suppressPushRef.current = false
      lastSemanticHistoryKeyRef.current = getSemanticHistoryKey()
    })
  }, [isReady, isSessionsReady, workspaceId, navigate, store, getSemanticHistoryKey])

  // =========================================================================
  // PENDING NAVIGATION
  // =========================================================================

  useEffect(() => {
    if (isReady && pendingNavigationRef.current) {
      const { parsed: pending, options, route } = pendingNavigationRef.current
      pendingNavigationRef.current = null

      if (pending.type === 'action') {
        handleActionNavigation(pending, options)
        return
      }

      // UA12.79 — flush the ORIGINAL route string, exactly as the ready path
      // does (parseRouteToNavigationState(route) at the queue site): the
      // parsed name/id pair is a lossy re-serialization — `pages/page/x`
      // parses to { name: 'page-info', id: 'x' }, and the rebuilt
      // `page-info/x` is no compound prefix and parses to null, so a
      // cold-start deep link to a detail view landed nowhere. Same for
      // `automations/automation/a`.
      const navState = parseRouteToNavigationState(route)
      if (navState) {
        const resolved = resolveAutoSelection(navState)
        const finalRoute = buildRouteFromNavigationState(resolved) as ViewRoute
        store.set(updateFocusedPanelRouteAtom, finalRoute)
      }
    }
  }, [isReady, handleActionNavigation, resolveAutoSelection, store])

  // =========================================================================
  // DEEP LINK LISTENER
  // =========================================================================

  useEffect(() => {
    if (!workspaceId) return

    const cleanup = window.electronAPI.onDeepLinkNavigate((nav: DeepLinkNavigation) => {
      let route: string | null = null

      if (nav.view) {
        route = nav.view
      } else if (nav.action) {
        route = `action/${nav.action}`
        if (nav.actionParams?.id) {
          route += `/${nav.actionParams.id}`
        }
        const otherParams = { ...nav.actionParams }
        delete otherParams.id
        if (Object.keys(otherParams).length > 0) {
          const params = new URLSearchParams(otherParams)
          route += `?${params.toString()}`
        }
      }

      if (route) {
        const navState = parseRouteToNavigationState(route)
        if (!navState && !route.startsWith('action/')) {
          toast.error(t('toast.invalidLink'), {
            description: t('toast.invalidLinkDesc'),
          })
          return
        }
        // Origin travels as an option, never in the route string: the params
        // above are re-serialised into `action/...`, so an origin in the query
        // would be indistinguishable from one an attacker put in the link.
        // A payload without an origin (an older main process) is external.
        navigate(route as Route, { origin: nav.origin === 'internal' ? 'internal' : 'external' })
      }
    })

    return cleanup
  }, [workspaceId, navigate])

  // =========================================================================
  // INTERNAL NAVIGATION EVENT LISTENER
  // =========================================================================

  useEffect(() => {
    const handleNavigateEvent = (event: Event) => {
      const customEvent = event as CustomEvent<{ route: Route; newPanel?: boolean; targetLaneId?: 'main' }>
      if (customEvent.detail?.route) {
        const { route: r, newPanel, targetLaneId } = customEvent.detail
        navigate(r, newPanel ? { newPanel, targetLaneId } : undefined)
      }
    }

    window.addEventListener(NAVIGATE_EVENT, handleNavigateEvent)
    return () => {
      window.removeEventListener(NAVIGATE_EVENT, handleNavigateEvent)
    }
  }, [navigate])

  // =========================================================================
  // SIDEBAR HELPERS
  // =========================================================================

  const updateRightSidebar = useCallback((panel: RightSidebarPanel | undefined) => {
    setRightSidebar(panel)
    // pushState handled by the rightSidebar change effect
  }, [])

  const toggleRightSidebar = useCallback((panel?: RightSidebarPanel) => {
    const currentSidebar = rightSidebarRef.current
    const newPanel = panel || (currentSidebar && currentSidebar.type !== 'none'
      ? { type: 'none' as const }
      : { type: 'none' as const })
    updateRightSidebar(newPanel)
  }, [updateRightSidebar])

  // =========================================================================
  // PRESERVE-FILTER NAVIGATION HELPERS
  // =========================================================================

  const navigateToSource = useCallback((sourceSlug?: string) => {
    if (isSourcesNavigation(navigationState) && navigationState.filter?.kind === 'type') {
      switch (navigationState.filter.sourceType) {
        case 'api':
          navigate(routes.view.sourcesApi(sourceSlug))
          return
        case 'mcp':
          navigate(routes.view.sourcesMcp(sourceSlug))
          return
        case 'local':
          navigate(routes.view.sourcesLocal(sourceSlug))
          return
      }
    }
    navigate(routes.view.sources(sourceSlug ? { sourceSlug } : undefined))
  }, [navigationState, navigate])

  const navigateToSession = useCallback((sessionId: string) => {
    if (!isSessionsNavigation(navigationState)) {
      navigate(routes.view.allSessions(sessionId))
      return
    }

    const filter = navigationState.filter
    switch (filter.kind) {
      case 'allSessions':
        navigate(routes.view.allSessions(sessionId))
        break
      case 'flagged':
        navigate(routes.view.flagged(sessionId))
        break
      case 'archived':
        navigate(routes.view.archived(sessionId))
        break
      case 'state':
        navigate(routes.view.state(filter.stateId, sessionId))
        break
      case 'label':
        navigate(routes.view.label(filter.labelId, sessionId))
        break
      case 'view':
        navigate(routes.view.view(filter.viewId, sessionId))
        break
      default:
        navigate(routes.view.allSessions(sessionId))
    }
  }, [navigationState, navigate])

  // =========================================================================
  // AUTO-SELECT ON SESSION LOAD
  // =========================================================================

  useEffect(() => {
    if (suppressAutoSelectRef.current) return
    if (!isReady || !workspaceId) return
    // UA12.179 follow-up — never inside an in-window switch's load window: initializeSessions fills the
    // meta map BEFORE `sessionsLoaded` turns true, while the OLD workspace's panels are still mounted,
    // and selecting on that old focused list would be saved (syncUrl) as the new workspace's URL — over
    // its `?panels=` layout, which the switch effect then restores. Once the switch is consumed, act
    // only on the store's CURRENT focused route: in the commit where the sessions arrive the switch
    // effect above has just reconciled the new workspace's panels while this render's navigationState
    // still names the old one; the re-render that follows re-runs this effect with the fresh route.
    if (!isSessionsReady || isWorkspaceSwitchPending(previousWorkspaceIdRef.current, workspaceId)) return
    if (store.get(focusedPanelRouteAtom) !== focusedRoute) return
    // Don't auto-select when panel stack is empty (user closed all panels)
    if (store.get(panelStackAtom).length === 0) return
    // UA2.2 (v0.13.4) — scoped to sessions with no explicit detail. resolveAutoSelection owns the
    // selection decision (board skip, last/first fallback) so it lives in one place; this effect
    // just applies it when the session list loads after navigation (workspace switch, lazy load).
    if (!isSessionsNavigation(navigationState) || navigationState.details) return

    const resolved = resolveAutoSelection(navigationState)
    if (isSessionsNavigation(resolved) && resolved.details) {
      navigateToSession(resolved.details.sessionId)
    }
  }, [
    isReady,
    isSessionsReady,
    workspaceId,
    focusedRoute,
    navigationState,
    resolveAutoSelection,
    navigateToSession,
    store,
  ])

  // =========================================================================
  // CONTEXT VALUE
  // =========================================================================

  return (
    <NavigationContext.Provider
      value={{
        navigate,
        isReady,
        navigationState,
        canGoBack,
        canGoForward,
        goBack,
        goForward,
        updateRightSidebar,
        toggleRightSidebar,
        navigateToSource,
        navigateToSession,
      }}
    >
      {children}
    </NavigationContext.Provider>
  )
}

/**
 * Hook to access navigation functions
 */
export function useNavigation() {
  const context = useContext(NavigationContext)
  if (!context) {
    throw new Error('useNavigation must be used within NavigationProvider')
  }
  return context
}

/**
 * Hook to access just the navigation state
 */
export function useNavigationState(): NavigationState {
  const { navigationState } = useNavigation()
  return navigationState
}

// UA1.26 — imported at the end so every line above keeps its number (the docs cite this file to line 1096).
import { deleteNeedsConfirmation } from '@/lib/delete-session-confirmation'
