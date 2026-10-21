import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { TooltipProvider } from '@nessy-agent/ui'
import { useTheme } from '@/hooks/useTheme'
import { useSetAtom, useStore, useAtomValue, useAtom } from 'jotai'
import type { Session, WorkspaceInfo, SessionEvent, Message, FileAttachment, SessionAttachmentDto, PermissionRequest, CredentialRequest, CredentialResponse, SetupNeeds, SessionStatus, NewChatActionParams, ContentBadge, LlmConnectionWithStatus, PermissionModeState } from '../shared/types'
import type { SessionDraft, DraftAttachmentRef } from '@nessy-agent/shared/config'
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationSettings,
} from '@nessy-agent/shared/config/notification-timing'
import type { SessionOptions, SessionOptionUpdates } from './hooks/useSessionOptions'
import { defaultSessionOptions, mergeSessionOptions } from './hooks/useSessionOptions'
import { generateMessageId } from '../shared/types'
import { parseSessionCommand } from '@nessy-agent/shared/slash-commands/session-command'
import { useEventProcessor } from './event-processor'
import type { AgentEvent, Effect } from './event-processor'
import { AppShell } from '@/components/app-shell/AppShell'
import type { AppShellContextType } from '@/context/AppShellContext'
import { OnboardingWizard, ReauthScreen } from '@/components/onboarding'
import { WorkspacePicker } from '@/components/workspace'
import { ResetConfirmationDialog } from '@/components/ResetConfirmationDialog'
import { BypassPermissionsDialog } from '@/components/BypassPermissionsDialog'
import { createBypassGateArbiter, needsBypassPermissionsAcknowledgment, recordBypassPermissionsAcknowledgment } from '@/lib/bypass-permissions-gate'
import { SplashScreen } from '@/components/SplashScreen'
import {
  isSplashExiting,
  isSplashMounted,
  nextSplashPhase,
  splashExitDeadlineMs,
  type SplashPhase,
} from '@/lib/splash-lifecycle'
import { FocusProvider } from '@/context/FocusContext'
import { ModalProvider } from '@/context/ModalContext'
import { DismissibleLayerProvider } from '@/context/DismissibleLayerContext'
import { useWindowCloseHandler } from '@/hooks/useWindowCloseHandler'
import { useOnboarding } from '@/hooks/useOnboarding'
import { useNotifications } from '@/hooks/useNotifications'
import { useSession } from '@/hooks/useSession'
import { useUpdateChecker } from '@/hooks/useUpdateChecker'
import { NavigationProvider, reportSessionCreateFailure } from '@/contexts/NavigationContext'
import { navigate, routes } from './lib/navigate'
import { attachmentFromContentRef, toDraftRef } from './lib/drafts'
import { stripMarkdown } from './utils/text'
import { coerceInputText } from './lib/input-text'
import { getSessionsToRefreshAfterStaleReconnect } from './lib/reconnect-recovery'
import { isScheduledWorkChangedEvent } from './lib/scheduled-work-refresh'
import { formatSessionLoadFailure, shouldTreatSessionLoadFailureAsTransportFallback } from './lib/session-load'
import { extractWorkspaceSlugFromPath } from '@nessy-agent/shared/utils/workspace-slug'
import { DEFAULT_THINKING_LEVEL } from '@nessy-agent/shared/agent/thinking-levels'
import { initRendererPerf } from './lib/perf'
import {
  initializeSessionsAtom,
  addSessionAtom,
  removeSessionAtom,
  updateSessionAtom,
  replaceLoadedSessionAtom,
  refreshSessionsMetadataAtom,
  sessionAtomFamily,
  sessionMetaMapAtom,
  sessionIdsAtom,
  loadedSessionsAtom,
  forceSessionMessagesReloadAtom,
  backgroundTasksAtomFamily,
  scheduledWorkNudgeAtomFamily,
  extractSessionMeta,
  windowWorkspaceIdAtom,
  type SessionMeta,
} from '@/atoms/sessions'
import { sourcesAtom } from '@/atoms/sources'
import { skillsAtom } from '@/atoms/skills'
import { extractBadges } from '@/lib/mentions'
import { getDefaultStore } from 'jotai'
import {
  ShikiThemeProvider,
  PlatformProvider,
  ImagePreviewOverlay,
  PDFPreviewOverlay,
  CodePreviewOverlay,
  DocumentFormattedMarkdownOverlay,
  JSONPreviewOverlay,
} from '@nessy-agent/ui'
import { useLinkInterceptor, type FilePreviewState } from '@/hooks/useLinkInterceptor'
import { useTransportConnectionState } from '@/hooks/useTransportConnectionState'
import { useStaleSessionRecovery } from '@/hooks/useStaleSessionRecovery'
import { TransportConnectionBanner, shouldShowTransportConnectionBanner } from '@/components/app-shell/TransportConnectionBanner'
import { getFileManagerName } from '@/lib/platform'
import { rendererLog } from '@/lib/logger'
import { addPendingPermission, pendingPermissionsAtTurnEnd, permissionSurfaceSessionId, rehydratePendingHostCards, removePendingPermission } from '@/lib/pending-permissions'
import { ActionRegistryProvider } from '@/actions'
import { ReplyAnnouncer } from '@/components/ReplyAnnouncer'
import { toast } from 'sonner'
import { reconcileArchivedAwaitingNotices } from './lib/archived-awaiting-answer'
import { applyBackgroundTaskEvent } from '@/lib/background-task-rows'
import { queueBackgroundFinished } from '@/atoms/background-finished'
type AppState = 'loading' | 'onboarding' | 'reauth' | 'workspace-picker' | 'ready'

/** Type for the Jotai store returned by useStore() */
type JotaiStore = ReturnType<typeof getDefaultStore>

type SessionListRefreshOptions = {
  removeMissing?: boolean
  reason?: string
  selectedSessionId?: string | null
}

const SESSION_REFRESH_LOG_ID_LIMIT = 25

function summarizeIds(ids: Iterable<string>, limit = SESSION_REFRESH_LOG_ID_LIMIT) {
  const all = Array.from(ids)
  return {
    count: all.length,
    ids: all.slice(0, limit),
    truncated: all.length > limit,
  }
}

function workspaceDistribution(sessions: Iterable<{ workspaceId?: string }>): Record<string, number> {
  const distribution: Record<string, number> = {}
  for (const session of sessions) {
    const key = session.workspaceId || '(missing)'
    distribution[key] = (distribution[key] ?? 0) + 1
  }
  return distribution
}

/**
 * Helper to handle background task events from the agent.
 * Updates the backgroundTasksAtomFamily based on event type.
 * Extracted to avoid code duplication between streaming and non-streaming paths.
 *
 * UA12.18 — THE RULES MOVED to `applyBackgroundTaskEvent` (`lib/background-task-rows.ts`), a pure reducer, so the
 * chip lifecycle ported from upstream v0.13.4 can be tested without a DOM. This wrapper only reads the session's
 * atom and writes the reducer's answer back, and only when the reducer changed it (an unchanged list is returned
 * as the same array, so a progress event for a task with no row costs no render). Both delivery paths (the
 * streaming handler and the non-streaming one) call it with the same arguments, which is what makes the reducer
 * the single place a background-task row changes.
 *
 * WHY THIS BLOCK KEEPS ITS LINE COUNT: `App.tsx` is cited by line in the plans and ledgers, and every cited line
 * sits BELOW this function, so a net insertion or deletion here would move each of those anchors. The body
 * shrank, and this comment takes exactly the lines it gave up. Nothing else in the file moved.
 *
 * THE LIFECYCLE, event by event (the reasons are written on the reducer and on `background-task-chip-state.ts`):
 *  - `task_backgrounded` / `shell_backgrounded` append one `running` row per call, with `lastSignalAt` set. A row
 *    the Claude feed already shows under the same TASK id adopts the receipt's call id instead of being drawn a
 *    second time (the feed can name a task before its launch receipt arrives). `kind: 'workflow'` (Pi) makes a
 *    `workflow` row; Claude's `local_workflow` does the same through the feed.
 *  - `background_tasks_replaced` runs `reconcileReplacedBackgroundTasks` (P6.109), now lifecycle-aware. The feed
 *    names each task's starting call (core `BackgroundTaskSummary.toolUseId`, from `task_started`, which re-states
 *    the feed), so the `task_progress` addressed to that call reaches a rebuilt row. A row the set names counts as
 *    a signal and is marked `listed`; a LIVE row the set stops naming is HELD (`unlistedAt`, no Stop) for the
 *    `task_completed` that follows the shrink, and retired at `UNREPORTED_END_GRACE_MS` without one (never guessed
 *    terminal); a row already terminal stays until its linger ends.
 *  - `task_progress` sets the elapsed seconds and records a liveness signal: a `stale` row recovers to `running`,
 *    a terminal row is never resurrected.
 *  - `task_completed` turns the row TERMINAL with the reported status (`completed` / `failed` / `stopped`) and a
 *    `completedAt`, instead of removing it; `shell_killed` turns it `stopped`. `ActiveTasksBar`'s one-second
 *    ticker (`advanceBackgroundTaskChips`) prunes a terminal row 8 s later and turns a `running` row with no
 *    signal for 20 min into `stale` — a chip that says "unknown" rather than spinning forever or claiming an end.
 *  - `tool_result` retires the row of a FOREGROUND call. A backgrounding receipt keeps it (upstream v0.14.0's
 *    wordings plus CLI 2.1.274's Workflow receipt), and a `listed` row is never retired by its launch call's result:
 *    the SDK calls a backgrounded task's tool_result "the placeholder text", so the set and `task_completed` end it
 *    (an MCP, cloud-agent or teammate placeholder matches no wording and used to delete the chip it had just keyed).
 *
 * NOT DONE ON A TURN'S END: we do NOT clear or orphan background tasks on complete/error/interrupted. Background
 * tasks persist and keep running after the turn ends. Upstream's turn-end "orphaned" backstop is deliberately not
 * ported: Claude here declares `perTaskStopAffordance: true` (an interrupt spares background tasks natively) and
 * Pi's background work is supervisor-owned, so a turn's end is not evidence that a task died.
 *
 * THE TWO USER ACTIONS are not events and do not pass through here. Stop is `useBackgroundTasks.killTask`: the
 * row reads Stopping… until its end event (UB14.7). Dismiss (renderer-only, for a chip whose end was never reported)
 * writes the same atom through `dismissBackgroundTask` and stops nothing.
 *
 * Claude stays OFF `task_backgrounded` / `shell_backgrounded` from `task_started` (UA12.18's decision, pinned in
 * `claude-background-chip-feed.test.ts`): its rows come from the replace feed alone, apart from the Agent launch
 * receipt that `tool-matching.ts` reads — and that one now only for the session's own agent, never a subagent's.
 *
 * WHERE EACH RULE IS PINNED, so a change to one of them knows which arm must move with it:
 *  - `lib/__tests__/background-task-rows.test.ts`, describe "applyBackgroundTaskEvent":
 *      a receipt appends one running row and a second receipt for the same call adds nothing;
 *      a receipt for a task the feed already shows adopts the call id (one row, not two);
 *      a rebuilt row takes the progress addressed to its starting call, and its elapsed time advances;
 *      progress for a terminal row leaves its status alone;
 *      task_completed keeps the row as `completed` / `failed` / `stopped` with `completedAt`;
 *      shell_killed keeps a shell row as `stopped`;
 *      a foreground result removes its row, each backgrounding wording keeps it;
 *      Dismiss removes one chip, leaves the others, and is a no-op for an unknown id.
 *  - the same file, describes "reconcileReplacedBackgroundTasks", "the Claude end order" and "the launch placeholder":
 *      the feed's toolUseId wins; `local_workflow` is a workflow row; a stale row the set names recovers; a live row
 *      it stops naming is held, a terminal one lingers; a shell id is not drawn twice; a placeholder keeps a row.
 *  - `components/app-shell/__tests__/background-task-chip-state.test.ts`: the 20-minute stale rule, the 8-second
 *      linger, the no-resurrection rule and the wall-clock elapsed (upstream v0.13.4's test, ported).
 *  - `packages/shared/src/agent/__tests__/claude-background-chip-feed.test.ts`: the feed's toolUseId, the
 *      main-line filter (`== null`, with the absent-parent case) and the decision above.
 *  - `components/app-shell/__tests__/background-task-chip.test.tsx`: what the chip renders for each status.
 *
 * WHAT IS LEFT, stated rather than hidden:
 *  - the end order of Claude's `background_tasks_changed` and `task_notification` is DOCUMENTED, not measured:
 *    sdk.d.ts says "in practice the level precedes them", so the held row above waits for the notification. A
 *    held row shows the running spinner without Stop until it comes, or for up to 8 s when none does (a CLI
 *    restart). The packaged sitting reads the order live.
 *    and its Stop goes through `stopAgentTask` — which reaches the same `Query.stopTask(taskId)` a shell row would.
 *  - a long-running shell (a dev server) sends no progress, so after 20 minutes its chip turns `stale` and reads
 *    "unknown" with the hint that it may still be running. That is upstream's behaviour, kept for parity; Stop and
 *    Dismiss stay available on a stale chip.
 *  - the per-workflow "N agents done" counter upstream draws is not ported: it reads an undocumented transcript
 *    path, and the native feed carries no such count (UA4.11 item 1).
 */
function handleBackgroundTaskEvent(
  store: JotaiStore,
  sessionId: string,
  event: { type: string },
  agentEvent: unknown
): void {
  const backgroundTasksAtom = backgroundTasksAtomFamily(sessionId)
  const currentTasks = store.get(backgroundTasksAtom)
  const nextTasks = applyBackgroundTaskEvent(currentTasks, event.type, agentEvent as Record<string, unknown>)
  if (nextTasks !== currentTasks) store.set(backgroundTasksAtom, nextTasks)
}

function SessionLoadErrorScreen({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}) {
  const { t } = useTranslation()

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-lg rounded-xl border border-border/50 bg-background shadow-minimal p-6 text-center">
        <h2 className="text-lg font-semibold text-foreground">{t("errors.failedToLoadSessions")}</h2>
        <p className="mt-2 text-sm text-foreground/60">
          {t("errors.failedToLoadSessionsDesc")}
        </p>
        <p className="mt-3 rounded-lg bg-foreground/5 px-3 py-2 text-left text-xs text-foreground/70 break-words">
          {message}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 inline-flex h-8 items-center justify-center rounded-[8px] bg-foreground text-background px-3 text-sm font-medium hover:opacity-90 transition-opacity"
        >
          {t("errors.retryLoadingSessions")}
        </button>
      </div>
    </div>
  )
}

export default function App() {
  const { t } = useTranslation()

  // Initialize renderer perf tracking early (debug mode = running from source)
  // Uses useEffect with empty deps to run once on mount before any session switches
  useEffect(() => {
    window.electronAPI.isDebugMode().then((isDebug) => {
      initRendererPerf(isDebug)
    })
  }, [])

  // App state: loading -> check auth -> onboarding or ready
  const [appState, setAppState] = useState<AppState>('loading')
  const [setupNeeds, setSetupNeeds] = useState<SetupNeeds | null>(null)

  // Per-session Jotai atom setters for isolated updates
  // NOTE: No sessionsAtom - we don't store a Session[] array anywhere to prevent memory leaks
  // Instead we use:
  // - sessionMetaMapAtom for lightweight listing
  // - sessionAtomFamily(id) for individual session data
  const initializeSessions = useSetAtom(initializeSessionsAtom)
  const addSession = useSetAtom(addSessionAtom)
  const removeSession = useSetAtom(removeSessionAtom)
  const updateSessionDirect = useSetAtom(updateSessionAtom)
  const replaceLoadedSession = useSetAtom(replaceLoadedSessionAtom)
  const store = useStore()

  // Helper to update a session by ID with partial fields
  // Uses per-session atom directly instead of updating an array
  const updateSessionById = useCallback((
    sessionId: string,
    updates: Partial<Session> | ((session: Session) => Partial<Session>)
  ) => {
    updateSessionDirect(sessionId, (prev) => {
      if (!prev) return prev
      const partialUpdates = typeof updates === 'function' ? updates(prev) : updates
      return { ...prev, ...partialUpdates }
    })
  }, [updateSessionDirect])

  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([])
  // Window's workspace ID — shared atom so Root/ThemeProvider stays in sync on switch
  const [windowWorkspaceId, setWindowWorkspaceId] = useAtom(windowWorkspaceIdAtom)

  // Get initial sessionId and focused mode from URL params (for "Open in New Window" feature)
  const { initialSessionId, isFocusedMode } = useMemo(() => {
    const params = new URLSearchParams(window.location.search)
    return {
      initialSessionId: params.get('sessionId'),
      isFocusedMode: params.get('focused') === 'true',
    }
  }, [])

  // Derive remote workspace ID for session matching in NavigationContext
  const windowRemoteWorkspaceId = useMemo(() => {
    if (!windowWorkspaceId) return null
    const workspace = workspaces.find(w => w.id === windowWorkspaceId)
    return workspace?.remoteServer?.remoteWorkspaceId ?? null
  }, [windowWorkspaceId, workspaces])

  // LLM connections with authentication status (for provider selection)
  const [llmConnections, setLlmConnections] = useState<LlmConnectionWithStatus[]>([])
  // Workspace default LLM connection (for new sessions)
  const [workspaceDefaultLlmConnection, setWorkspaceDefaultLlmConnection] = useState<string | undefined>()
  // Global default LLM connection slug (from app config)
  const [defaultLlmConnectionSlug, setDefaultLlmConnectionSlug] = useState<string | undefined>()

  // Derive connection default model override from the default LLM connection
  const defaultConnection = useMemo(() => {
    return llmConnections.find(c => c.slug === defaultLlmConnectionSlug) ?? null
  }, [llmConnections, defaultLlmConnectionSlug])

  const [menuNewChatTrigger, setMenuNewChatTrigger] = useState(0)
  // Permission requests per session (queue to handle multiple concurrent requests)
  const [pendingPermissions, setPendingPermissions] = useState<Map<string, PermissionRequest[]>>(new Map())
  // Credential requests per session (queue to handle multiple concurrent requests)
  const [pendingCredentials, setPendingCredentials] = useState<Map<string, CredentialRequest[]>>(new Map())
  // Draft composer state per session (text + attachment refs), preserved across mode
  // switches, conversation changes, and app restarts. Using a ref avoids re-renders
  // during typing; attachments are stored as lightweight refs (path + name) and
  // hydrated via readFileAttachment() on session switch.
  const sessionDraftsRef = useRef<Map<string, SessionDraft>>(new Map())
  // Unified session options for all session-scoped settings
  const [sessionOptions, setSessionOptions] = useState<Map<string, SessionOptions>>(new Map())

  // Reset confirmation dialog
  const [showResetDialog, setShowResetDialog] = useState(false)
  // The pending first-activation switch into bypassPermissions awaiting the
  // responsibility acknowledgment (permission-modes.md: bypass is an explicit
  // opt-in). Null when no switch is waiting.
  const [pendingBypassSwitch, setPendingBypassSwitch] = useState<{ sessionId: string; updates: SessionOptionUpdates } | null>(null)
  /**
   * Generation counter for the bypass gate's async check.
   *
   * Before T5 the gate was synchronous, so the whole "check then act" ran in one
   * JS tick and got mutual exclusion for free. The durable check is an IPC round
   * trip, so a SECOND option change can now run to completion while the first is
   * still awaiting — and the first would then resume and raise the dialog for a
   * request the user has already moved past. Confirming that dialog would switch
   * a session into bypassPermissions nobody asked for, and the dialog's text
   * names neither session nor mode, so it looks like the latest action.
   * Each call takes a ticket; a stale ticket drops its result.
   */
  const bypassGateArbiter = useRef(createBypassGateArbiter())
  /** Guards the dialog's async confirm against a double-click (state clears a tick too late). */
  const bypassConfirmInFlight = useRef(false)

  // Auto-update state
  const updateChecker = useUpdateChecker()

  // Splash screen state - tracks when app is fully ready (all data loaded)
  const [sessionsLoaded, setSessionsLoaded] = useState(false)
  const [sessionLoadError, setSessionLoadError] = useState<string | null>(null)
  // One phase, not two booleans: every rule about when the splash leaves lives
  // in lib/splash-lifecycle.ts, including the deadline that unmounts it when the
  // exit animation cannot run (a non-rendered window has rAF suspended).
  const [splashPhase, setSplashPhase] = useState<SplashPhase>('visible')

  // Notification policy from app settings: the three-position turn-completion
  // timing plus the separate permission/question controls
  // (`learn.chatgpt.com/docs/notifications.md#configure-desktop-notifications`). One object rather
  // than the boolean it replaced — the boolean could not say "always".
  const [notificationSettings, setNotificationSettings] = useState<NotificationSettings>(DEFAULT_NOTIFICATION_SETTINGS)

  // Sources and skills for badge extraction
  const sources = useAtomValue(sourcesAtom)
  const skills = useAtomValue(skillsAtom)

  // Compute if app is fully ready (all data loaded)
  const isFullyReady = appState === 'ready' && sessionsLoaded

  // Trigger splash exit animation when fully ready
  useEffect(() => {
    if (!isFullyReady) return
    setSplashPhase(phase => nextSplashPhase(phase, 'app-ready'))
  }, [isFullyReady])

  // The exit's second route. motion reports completion through
  // requestAnimationFrame, which a window that is not being rendered has
  // suspended — hidden, minimized, or still `show: false` before ready-to-show.
  // Without this the splash (a full-screen click-blocking overlay) never
  // unmounts on such a window. setTimeout is throttled there but still fires.
  useEffect(() => {
    const deadlineMs = splashExitDeadlineMs(splashPhase)
    if (deadlineMs === null) return
    const timer = window.setTimeout(() => {
      setSplashPhase(phase => nextSplashPhase(phase, 'exit-deadline'))
    }, deadlineMs)
    return () => { window.clearTimeout(timer) }
  }, [splashPhase])

  // Handler for when splash exit animation completes
  const handleSplashExitComplete = useCallback(() => {
    setSplashPhase(phase => nextSplashPhase(phase, 'exit-animation-complete'))
  }, [])

  // Apply theme via hook (the provider loads presets and the ~/.nessy-agent/theme.json overrides
  // and injects the CSS variables — UB13.4 moved that here from the per-call merge)
  // shikiTheme is passed to ShikiThemeProvider to ensure correct syntax highlighting
  // theme for dark-only themes in light system mode
  const { shikiTheme, isDark } = useTheme()

  // Ref for sessionOptions to access current value in event handlers without re-registering
  const sessionOptionsRef = useRef(sessionOptions)
  // Keep ref in sync with state
  useEffect(() => {
    sessionOptionsRef.current = sessionOptions
  }, [sessionOptions])

  const applyPermissionModeState = useCallback((sessionId: string, state: PermissionModeState, source: 'event' | 'reconcile') => {
    setSessionOptions(prev => {
      const next = new Map(prev)
      const current = next.get(sessionId) ?? defaultSessionOptions
      const currentVersion = current.permissionModeVersion ?? -1

      if (state.modeVersion < currentVersion) {
        window.electronAPI.debugLog(
          '[ModeSync] Ignoring stale permission mode update',
          { sessionId, source, incoming: state.modeVersion, current: currentVersion }
        )
        return prev
      }

      if (
        state.modeVersion === currentVersion &&
        current.permissionMode !== state.permissionMode
      ) {
        window.electronAPI.debugLog(
          '[ModeSync] Equal modeVersion with differing mode detected, applying and requesting reconciliation',
          {
            sessionId,
            source,
            modeVersion: state.modeVersion,
            currentMode: current.permissionMode,
            incomingMode: state.permissionMode,
          }
        )
      }

      next.set(sessionId, {
        ...current,
        permissionMode: state.permissionMode,
        permissionModeVersion: state.modeVersion,
      })
      return next
    })
  }, [])

  const reconcilePermissionModeState = useCallback(async (sessionId: string) => {
    try {
      const state = await window.electronAPI.getSessionPermissionModeState(sessionId)
      if (!state) return
      applyPermissionModeState(sessionId, state, 'reconcile')
    } catch (error) {
      window.electronAPI.debugLog('[ModeSync] Failed to reconcile permission mode', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }, [applyPermissionModeState])

  // Event processor hook - handles all agent events through pure functions
  const { processAgentEvent, clearStreamingState } = useEventProcessor()

  // R36 `/clear` — sessions whose LAST composer submission was classified as
  // `/clear` by parseSessionCommand (the same classifier the server seam uses).
  // The server empties the managed transcript inside its complete handler
  // WITHOUT a dedicated event (dispatch A design), so after that session's next
  // `complete` event the renderer refetches the transcript, accepting the empty
  // result as truth. This is the keying: our own submission + the same
  // `complete` boundary the server keyed its reset on — NOT the info string.
  const pendingClearRefetchSessionsRef = useRef<Set<string>>(new Set())

  const syncSessionOptionsFromSession = useCallback((session: Session) => {
    setSessionOptions(prev => {
      const next = new Map(prev)
      const current = next.get(session.id)
      const merged = {
        ...defaultSessionOptions,
        ...current,
        permissionMode: session.permissionMode ?? defaultSessionOptions.permissionMode,
        thinkingLevel: session.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
        // QK5 — `true` or ABSENT on the wire, so an older server (and every
        // session that never touched the toggle) reads as off.
        ultracode: session.ultracode === true,
      }

      const hasNonDefaultMode = merged.permissionMode !== defaultSessionOptions.permissionMode
      const hasNonDefaultThinking = merged.thinkingLevel !== DEFAULT_THINKING_LEVEL

      if (!hasNonDefaultMode && !hasNonDefaultThinking && !merged.ultracode && merged.permissionModeVersion == null) {
        next.delete(session.id)
      } else {
        next.set(session.id, merged)
      }

      return next
    })
  }, [])

  const refreshSessionFromServer = useCallback(async (
    sessionId: string,
    options?: {
      /**
       * R36 `/clear` — accept a legitimately EMPTY server transcript as truth.
       * The default stale-guard below treats "server returned zero messages
       * while we hold some" as a failed load and preserves the local copy;
       * after a completed `/clear` the empty transcript IS the result
       * (agent-sdk/slash-commands.md:212 — "resets the conversation to an
       * empty context"), so the /clear refetch sets this flag.
       */
      acceptEmptyTranscript?: boolean
    },
  ): Promise<'refreshed' | 'preserved_stale_messages' | 'failed'> => {
    try {
      const fresh = await window.electronAPI.getSessionMessages(sessionId)
      if (!fresh) return 'failed'

      const prevSession = store.get(sessionAtomFamily(sessionId))
      const preservedStaleMessages = !options?.acceptEmptyTranscript
        && !!prevSession && prevSession.messages.length > 0 && (!fresh.messages || fresh.messages.length === 0)
      const nextSession = preservedStaleMessages
        ? { ...fresh, messages: prevSession.messages }
        : fresh

      clearStreamingState(sessionId)
      replaceLoadedSession(nextSession)
      syncSessionOptionsFromSession(nextSession)
      void reconcilePermissionModeState(sessionId)
      return preservedStaleMessages ? 'preserved_stale_messages' : 'refreshed'
    } catch (err) {
      console.error(`[App] Failed to refresh session ${sessionId}:`, err)
      return 'failed'
    }
  }, [clearStreamingState, replaceLoadedSession, syncSessionOptionsFromSession, reconcilePermissionModeState, store])

  const loadSessionsFromServer = useCallback(async () => {
    setSessionLoadError(null)

    try {
      const loadedSessions = await window.electronAPI.getSessions()

      // Initialize per-session atoms and metadata map
      // NOTE: No sessionsAtom used - sessions are only in per-session atoms; UA12.25 re-files the list's still-pending host cards (a reload never saw their events; dedup by requestId inside the helper)
      setPendingPermissions(prev => rehydratePendingHostCards(prev, loadedSessions) as Map<string, PermissionRequest[]>); initializeSessions(loadedSessions)

      // Initialize unified sessionOptions from session data
      const optionsMap = new Map<string, SessionOptions>()
      for (const s of loadedSessions) {
        const hasNonDefaultMode = s.permissionMode && s.permissionMode !== 'default'
        const hasNonDefaultThinking = s.thinkingLevel && s.thinkingLevel !== DEFAULT_THINKING_LEVEL
        // QK5 — a session the server still has ultracode ON for. Listed beside
        // the other two rather than left out: this map is what a cold start
        // draws the composer from, and a missing entry here is exactly the
        // "control shows OFF while the session is ON" divergence.
        if (hasNonDefaultMode || hasNonDefaultThinking || s.ultracode === true) {
          optionsMap.set(s.id, {
            permissionMode: s.permissionMode ?? 'default',
            thinkingLevel: s.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
            ultracode: s.ultracode === true,
          })
        }
      }
      setSessionOptions(optionsMap)

      await Promise.allSettled(
        loadedSessions.map((s) => reconcilePermissionModeState(s.id))
      )

      setSessionsLoaded(true)

      if (initialSessionId && windowWorkspaceId) {
        const session = loadedSessions.find(s => s.id === initialSessionId)
        if (session) {
          navigate(routes.view.allSessions(session.id))
        }
      }
    } catch (err) {
      console.error('[App] Failed to load sessions:', err)
      const transportState = await window.electronAPI.getTransportConnectionState().catch(() => null)

      if (shouldTreatSessionLoadFailureAsTransportFallback(transportState)) {
        console.error('[App] Treating session load failure as transport fallback:', transportState)
        setSessionsLoaded(true)
        setSessionLoadError(null)
        return
      }

      setSessionLoadError(formatSessionLoadFailure(err))
      setSessionsLoaded(true)
    }
  }, [initializeSessions, initialSessionId, reconcilePermissionModeState, windowWorkspaceId])

  const refreshSessionListMetadataFromServer = useCallback(async (options: SessionListRefreshOptions = {}): Promise<Map<string, SessionMeta> | null> => {
    const {
      removeMissing = true,
      reason = 'manual-or-authoritative',
      selectedSessionId = null,
    } = options
    const beforeMetaMap = store.get(sessionMetaMapAtom)
    const beforeIds = new Set(beforeMetaMap.keys())
    const transportState = await window.electronAPI.getTransportConnectionState().catch(() => null)

    try {
      const sessions = await window.electronAPI.getSessions()
      const returnedIds = new Set(sessions.map(s => s.id))
      const missingIds = Array.from(beforeIds).filter(id => !returnedIds.has(id))
      const addedIds = sessions.map(s => s.id).filter(id => !beforeIds.has(id))
      const logPayload = {
        reason,
        removeMissing,
        windowWorkspaceId,
        windowRemoteWorkspaceId,
        selectedSessionId,
        beforeCount: beforeIds.size,
        returnedCount: sessions.length,
        beforeIds: summarizeIds(beforeIds),
        returnedIds: summarizeIds(returnedIds),
        missingIds: summarizeIds(missingIds),
        addedIds: summarizeIds(addedIds),
        beforeWorkspaceIds: workspaceDistribution(beforeMetaMap.values()),
        returnedWorkspaceIds: workspaceDistribution(sessions),
        transportState,
      }

      rendererLog.info('[App] Session list metadata refresh result', logPayload)
      if (!removeMissing && missingIds.length > 0) {
        rendererLog.warn('[App] Non-destructive refresh preserved sessions omitted by getSessions(); this indicates a partial backend response or workspace-context mismatch', logPayload)
      }

      const loadedSessionIds = store.get(loadedSessionsAtom)

      // Single transactional atom write — all cross-atom mutations happen
      // inside one Jotai write function so React subscribers see one
      // consistent update instead of intermediate states.
      const nextMetaMap = store.set(refreshSessionsMetadataAtom, { sessions, loadedSessionIds, removeMissing })

      // Sync app-level state (React hooks / non-atom concerns) after the atom transaction
      for (const session of sessions) {
        syncSessionOptionsFromSession(session)
      }
      await Promise.allSettled(sessions.map(s => reconcilePermissionModeState(s.id)))

      return nextMetaMap
    } catch (err) {
      rendererLog.error('[App] Failed to refresh session list metadata after reconnect:', {
        reason,
        removeMissing,
        windowWorkspaceId,
        windowRemoteWorkspaceId,
        selectedSessionId,
        beforeCount: beforeIds.size,
        beforeIds: summarizeIds(beforeIds),
        beforeWorkspaceIds: workspaceDistribution(beforeMetaMap.values()),
        transportState,
        error: err,
      })
      return null
    }
  }, [store, syncSessionOptionsFromSession, reconcilePermissionModeState, windowWorkspaceId, windowRemoteWorkspaceId])

  // Stale session watchdog — catches stuck sessions that the reconnect protocol misses
  const { trackSessionActivity } = useStaleSessionRecovery({
    store,
    refreshSessionFromServer,
  })

  const DRAFT_SAVE_DEBOUNCE_MS = 500

  const resolveDefaultConnectionSlug = useCallback((connections: LlmConnectionWithStatus[]) => {
    return connections.find(c => c.isDefault)?.slug ?? connections[0]?.slug
  }, [])

  // Refresh LLM connections from config (called on workspace change and after connection updates)
  const refreshLlmConnections = useCallback(async () => {
    const connections = await window.electronAPI.listLlmConnectionsWithStatus()
    setLlmConnections(connections)
    setDefaultLlmConnectionSlug(resolveDefaultConnectionSlug(connections))
    // Also refresh workspace default
    if (windowWorkspaceId) {
      const settings = await window.electronAPI.getWorkspaceSettings(windowWorkspaceId)
      setWorkspaceDefaultLlmConnection(settings?.defaultLlmConnection)
    }
  }, [resolveDefaultConnectionSlug, windowWorkspaceId])

  // Handle onboarding completion
  const handleOnboardingComplete = useCallback(async () => {
    try {
      // Reload workspaces after onboarding
      const ws = await window.electronAPI.getWorkspaces()
      if (ws.length > 0) {
        // Switch to workspace in-place (no window close/reopen)
        await window.electronAPI.switchWorkspace(ws[0].id)
        setWindowWorkspaceId(ws[0].id)
        setWorkspaces(ws)
      } else {
        setWorkspaces(ws)
      }
    } catch (error) {
      console.error('[App] Failed to load workspaces after onboarding:', error)
      // Still transition to ready — the app can recover via reconnect
    }
    setAppState('ready')
  }, [])

  // Onboarding hook — onConfigSaved fires immediately when billing is saved,
  // ensuring connection state updates before the wizard closes.
  const onboarding = useOnboarding({
    onComplete: handleOnboardingComplete,
    onConfigSaved: refreshLlmConnections,
    initialSetupNeeds: setupNeeds || undefined,
  })

  // Reauth login handler - placeholder (reauth is not currently used)
  const handleReauthLogin = useCallback(async () => {
    // Re-check setup needs
    const needs = await window.electronAPI.getSetupNeeds()
    if (needs.isFullyConfigured) {
      setAppState('ready')
    } else {
      setSetupNeeds(needs)
      setAppState('onboarding')
    }
  }, [])

  // Reauth reset handler - open reset confirmation dialog
  const handleReauthReset = useCallback(() => {
    setShowResetDialog(true)
  }, [])

  // Check auth state and get window's workspace ID on mount
  useEffect(() => {
    const initialize = async () => {
      try {
        // Get this window's workspace ID (passed via URL query param from main process)
        const wsId = await window.electronAPI.getWindowWorkspace()
        setWindowWorkspaceId(wsId)

        const needs = await window.electronAPI.getSetupNeeds()
        setSetupNeeds(needs)

        if (needs.isFullyConfigured) {
          // If no workspace is selected (thin client without NESSY_WORKSPACE_ID),
          // show workspace picker before entering the main app
          if (!wsId) {
            setAppState('workspace-picker')
          } else {
            setAppState('ready')
          }
        } else {
          // New user or needs setup - show onboarding
          setAppState('onboarding')
        }
      } catch (error) {
        console.error('Failed to check auth state:', error)
        // If check fails, show onboarding to be safe
        setAppState('onboarding')
      }
    }

    initialize()
  }, [])

  // Session selection state
  const [sessionSelection, setSession] = useSession()

  // Notification system - shows native OS notifications and badge count
  const handleNavigateToSession = useCallback((sessionId: string) => {
    // Navigate to the session via central routing (uses allSessions filter)
    navigate(routes.view.allSessions(sessionId))
  }, [])

  const { isWindowFocused, showSessionNotification } = useNotifications({
    workspaceId: windowWorkspaceId,
    // NOTE: sessions removed - hook now uses sessionMetaMapAtom internally
    // to prevent closures from retaining full message arrays
    onNavigateToSession: handleNavigateToSession,
    settings: notificationSettings,
  })

  // Load workspaces, sessions, model, notifications setting, and drafts when app is ready
  useEffect(() => {
    if (appState !== 'ready') return

    window.electronAPI.getWorkspaces().then(setWorkspaces)
    window.electronAPI.getNotificationSettings().then(setNotificationSettings).catch(() => {})

    // Show actionable toast for missing system dependencies (Windows only)
    window.electronAPI.getSystemWarnings().then((warnings) => {
      if (warnings.vcredistMissing) {
        toast.warning(t('toast.vcRedistNotFound'), {
          description: t('toast.vcRedistNotFoundDesc'),
          duration: Infinity,
          action: {
            label: t('common.install'),
            onClick: () => window.electronAPI.openUrl(warnings.downloadUrl ?? 'https://aka.ms/vs/17/release/vc_redist.x64.exe'),
          },
        })
      }
    }).catch(() => { /* non-fatal startup check */ })
    void loadSessionsFromServer()
    // Load LLM connections with authentication status
    window.electronAPI.listLlmConnectionsWithStatus().then((connections) => {
      setLlmConnections(connections)
      setDefaultLlmConnectionSlug(resolveDefaultConnectionSlug(connections))
    })
    // Load persisted input drafts into ref (no re-render needed).
    // Attachment files are not read here — hydration happens lazily when the session
    // is opened so app startup isn't delayed by reading potentially large files.
    // drafts.json is keyed by composite {workspaceId, sessionId}; load only this
    // window's workspace drafts (the in-memory ref stays sessionId-keyed).
    window.electronAPI.getAllDrafts(windowWorkspaceId ?? '').then((drafts) => {
      if (Object.keys(drafts).length > 0) {
        sessionDraftsRef.current = new Map(Object.entries(drafts))
      }
    })
  }, [appState, loadSessionsFromServer, resolveDefaultConnectionSlug])

  // Subscribe to LLM connections change events (live updates when models are fetched)
  useEffect(() => {
    const cleanup = window.electronAPI.onLlmConnectionsChanged(() => {
      refreshLlmConnections()
    })
    return () => { cleanup() }
  }, [refreshLlmConnections])

  // Refresh LLM connections and workspace default when workspace changes
  useEffect(() => {
    if (windowWorkspaceId) {
      refreshLlmConnections()
    }
  }, [windowWorkspaceId, refreshLlmConnections])

  // Listen for session events - uses centralized event processor for consistent state transitions
  //
  // SOURCE OF TRUTH LOGIC:
  // - During streaming (atom.isProcessing = true): Atom is source of truth
  //   All events read from and write to atom. This preserves streaming data.
  // - When not streaming: React state is source of truth
  //   Events read/write React state, which syncs to atoms via useEffect.
  // - Handoff events (complete, error, etc.): End streaming, sync atom → React state
  //
  // This is simpler and more robust than checking event types - we just ask
  // "is this session currently streaming?" and route accordingly.
  useEffect(() => {
    // Handoff events signal end of streaming - need to sync back to React state
    // Also includes todo_state_changed so status updates immediately reflect in sidebar
    // async_operation included so shimmer effect on session titles updates in real-time
    const handoffEventTypes = new Set(['complete', 'error', 'interrupted', 'typed_error', 'session_status_changed', 'session_metadata_changed', 'session_flagged', 'session_unflagged', 'name_changed', 'labels_changed', 'project_id_changed', 'title_generated', 'async_operation'])

    // Helper to handle side effects (same logic for both paths)
    const handleEffects = (effects: Effect[], sessionId: string, eventType: string, event?: SessionEvent) => {
      for (const effect of effects) {
        switch (effect.type) {
          case 'permission_request': {
            // sub-agents.md:1043 — a subagent's prompt has to reach the human
            // watching the MAIN session. A child session is hidden, so filing
            // the prompt under its own id put it somewhere nothing renders and
            // the child stalled until its deadline. The server names the
            // visible ancestor; `effect.request.sessionId` stays the child's, so
            // the answer still routes to the session that asked.
            const surfaceSessionId = permissionSurfaceSessionId(effect.request, sessionId)
            setPendingPermissions(prevPerms => addPendingPermission(prevPerms, effect.request, sessionId))

            // Native notification for approval-required pauses (same gating as completion notifications)
            const notifySession = store.get(sessionAtomFamily(surfaceSessionId))
            if (notifySession && !notifySession.hidden) {
              const isAdminPrompt = effect.request.type === 'admin_approval'
              const isAskUserPrompt = effect.request.type === 'ask_user'
              const promptBody = isAskUserPrompt
                ? t('chat.askUser.notification')
                : isAdminPrompt
                ? `Admin approval required: ${effect.request.appName || effect.request.toolName}`
                : `Permission required: ${effect.request.toolName}`
              // The page gives permission and question notifications separate
              // controls, so they are raised as their own classes rather than
              // riding the turn-completion timing the way one boolean forced.
              showSessionNotification(notifySession, promptBody, isAskUserPrompt ? 'question' : 'permission')
            }
            break
          }
          case 'permission_request_cancelled': {
            // The cancellation carries the CHILD's session id, but a child's
            // prompt was filed under its visible ancestor, so drop by request
            // id wherever it landed. Request ids are unique per prompt.
            setPendingPermissions(prevPerms => removePendingPermission(prevPerms, effect.requestId) as Map<string, PermissionRequest[]>)
            break
          }
          case 'permission_mode_changed': {
            if (typeof effect.modeVersion === 'number' && effect.changedAt && effect.changedBy) {
              applyPermissionModeState(effect.sessionId, {
                permissionMode: effect.permissionMode,
                modeVersion: effect.modeVersion,
                changedAt: effect.changedAt,
                changedBy: effect.changedBy,
              }, 'event')
            } else {
              // Backward compatibility: apply mode optimistically then reconcile authoritative state.
              setSessionOptions(prevOpts => {
                const next = new Map(prevOpts)
                const current = next.get(effect.sessionId) ?? defaultSessionOptions
                next.set(effect.sessionId, { ...current, permissionMode: effect.permissionMode })
                return next
              })
              void reconcilePermissionModeState(effect.sessionId)
            }
            break
          }
          case 'credential_request': {
            setPendingCredentials(prevCreds => {
              const next = new Map(prevCreds)
              const existingQueue = next.get(sessionId) || []
              next.set(sessionId, [...existingQueue, effect.request])
              return next
            })
            break
          }
          case 'toast_error': {
            toast.error(effect.message, { duration: 5000 })
            break
          }
        }
      }

      // F1.900 — a turn's end takes no permission card that is still pending:
      // a card leaves when it is answered or when the host withdraws it, so a
      // background subagent's card outlives the parent turn and every later one.
      // F1.911 — a Stop drops only what the host dropped with the turn: the
      // interrupted names the ids it still holds, and the rule keeps those.
      if (eventType === 'complete' || eventType === 'interrupted') {
        setPendingPermissions(prevPerms => pendingPermissionsAtTurnEnd(prevPerms, sessionId, eventType, event?.type === 'interrupted' ? event.retainedPermissionRequestIds : undefined) as Map<string, PermissionRequest[]>)
      }
      // A sign-in prompt is still the turn's: credentials clear on complete, as before.
      if (eventType === 'complete') {
        setPendingCredentials(prevCreds => {
          if (prevCreds.has(sessionId)) {
            const next = new Map(prevCreds)
            next.delete(sessionId)
            return next
          }
          return prevCreds
        })
      }
    }

    const cleanup = window.electronAPI.onSessionEvent((event: SessionEvent) => {
      if (!('sessionId' in event)) return

      const sessionId = event.sessionId
      const workspaceId = windowWorkspaceId ?? ''

      // Session lifecycle events are handled explicitly (not by the agent event processor).
      if (event.type === 'session_created') {
        window.electronAPI.getSessionMessages(sessionId)
          .then((createdSession: Session | null) => {
            if (createdSession) {
              const existingMeta = store.get(sessionMetaMapAtom).has(sessionId)
              if (existingMeta) {
                replaceLoadedSession(createdSession)
              } else {
                addSession(createdSession)
              }
              syncSessionOptionsFromSession(createdSession)
              return
            }
            return window.electronAPI.getSessions().then(initializeSessions)
          })
          .catch((error: unknown) => console.error('Failed to handle session_created event:', error))
        return
      }

      if (event.type === 'session_deleted') {
        removeSession(sessionId)
        return
      }

      if (event.type === 'queue_changed') {
        return
      }

      // D1.269 — the scheduled half of the background-work list moved. A SIGNAL,
      // not a transcript event: it has no content and nothing to reconstruct on
      // a reload, so it is answered here beside `queue_changed` and never
      // reaches `processAgentEvent`. The whole derivation, and the fact that the
      // producer is the host's half, are on `lib/scheduled-work-refresh.ts`.
      if (isScheduledWorkChangedEvent(event)) {
        const nudgeAtom = scheduledWorkNudgeAtomFamily(sessionId)
        store.set(nudgeAtom, store.get(nudgeAtom) + 1)
        return
      }

      // UB9.8 — craft-agents-oss v0.15.1 `App.tsx` (Apache-2.0): a background task's activity is not turn traffic (no
      // watchdog reset, no session re-render per progress tick); UB14.7: it only updates a chip (`applyBackgroundTaskEvent`).
      if (event.type === 'task_activity') {
        handleBackgroundTaskEvent(store, sessionId, event, event)
        return
      }

      const agentEvent = event as unknown as AgentEvent

      // Track activity for stale session watchdog
      trackSessionActivity(sessionId)

      // Dispatch window event when compaction completes
      // This allows FreeFormInput to sequence the plan execution message after compaction
      // Note: markCompactionComplete is called on the backend (sessions.ts) to ensure
      // it happens even if CMD+R occurs during compaction
      if (event.type === 'info' && event.statusType === 'compaction_complete') {
        window.dispatchEvent(new CustomEvent('nessy:compaction-complete', {
          detail: { sessionId }
        }))
      }

      // R36 `/clear` — the server emptied the managed transcript before this
      // `complete` fired (its reset runs inside the chat-complete handler, and
      // `complete` is only emitted once the queue drained), so refetch now.
      // `acceptEmptyTranscript` because the empty transcript IS the result.
      // Fire-and-forget: the IPC round-trip lands after this handler finishes
      // processing the complete event.
      if (event.type === 'complete' && pendingClearRefetchSessionsRef.current.delete(sessionId)) {
        void refreshSessionFromServer(sessionId, { acceptEmptyTranscript: true })
      }

      const atomSession = store.get(sessionAtomFamily(sessionId)) // is it streaming? (the atom is the source of truth)
      if (!atomSession) void refreshSessionFromServer(sessionId) // F1.855 — never told about it (a host-created child: `createEmptySession` mints it hidden); the host's copy settles its flags
      const isStreaming = atomSession?.isProcessing === true
      const isHandoff = handoffEventTypes.has(event.type)

      // During streaming OR for handoff events: use atom as source of truth
      // This ensures all events during streaming see the complete state
      if (isStreaming || isHandoff) {
        const currentSession = atomSession ?? null

        // Process the event
        const { session: updatedSession, effects } = processAgentEvent(
          agentEvent,
          currentSession,
          workspaceId
        )

        // Update atom directly (UI sees update immediately)
        updateSessionDirect(sessionId, () => updatedSession)

        // Handle side effects
        handleEffects(effects, sessionId, event.type, event)

        // Handle background task events
        handleBackgroundTaskEvent(store, sessionId, event, agentEvent)

        // For handoff events, update metadata map for list display
        // NOTE: No sessionsAtom to sync - atom and metadata are the source of truth
        if (isHandoff) {
          // Update metadata map
          const metaMap = store.get(sessionMetaMapAtom)
          const newMetaMap = new Map(metaMap)
          newMetaMap.set(sessionId, extractSessionMeta(updatedSession))
          store.set(sessionMetaMapAtom, newMetaMap)

          // Show notification on complete (when window is not focused)
          // Skip hidden sessions (mini-agent sessions) - they shouldn't trigger notifications
          if (event.type === 'complete' && !updatedSession.hidden) {
            // Get the last assistant/plan/ERROR message as preview. Including
            // errors keeps the notification honest: after a failed retry the
            // last assistant message is a STALE earlier reply — notifying with
            // it looked like a fresh successful answer (tester finding
            // 2026-07-20).
            const lastMessage = updatedSession.messages.findLast(
              m => (m.role === 'assistant' || m.role === 'plan' || m.role === 'error') && !m.isIntermediate
            )
            // Strip markdown so OS notifications display clean plain text
            const rawPreview = lastMessage?.content?.substring(0, 200) || undefined
            const preview = rawPreview ? stripMarkdown(rawPreview).substring(0, 100) || undefined : undefined
            showSessionNotification(updatedSession, preview, 'turn-completion'); queueBackgroundFinished(store, sessionId, updatedSession) // UA1.15 — the in-app chip (Appearance preference, default off)
          }
        }

        return
      }

      // Not streaming: use per-session atoms directly (no sessionsAtom)
      const currentSession = store.get(sessionAtomFamily(sessionId))

      const { session: updatedSession, effects } = processAgentEvent(
        agentEvent,
        currentSession,
        workspaceId
      )

      // Handle side effects
      handleEffects(effects, sessionId, event.type, event)

      // Handle background task events
      handleBackgroundTaskEvent(store, sessionId, event, agentEvent)

      // Update per-session atom
      updateSessionDirect(sessionId, () => updatedSession)

      // Update metadata map
      const metaMap = store.get(sessionMetaMapAtom)
      const newMetaMap = new Map(metaMap)
      newMetaMap.set(sessionId, extractSessionMeta(updatedSession))
      store.set(sessionMetaMapAtom, newMetaMap)
    })

    return cleanup
  }, [
    processAgentEvent,
    trackSessionActivity,
    windowWorkspaceId,
    store,
    updateSessionDirect,
    replaceLoadedSession,
    showSessionNotification,
    initializeSessions,
    addSession,
    removeSession,
    syncSessionOptionsFromSession,
    applyPermissionModeState,
    reconcilePermissionModeState,
    refreshSessionFromServer,
    t,
  ])

  // Transport reconnect recovery — refresh session metadata plus active/processing
  // session content after stale reconnects.
  useEffect(() => {
    const cleanup = window.electronAPI.onReconnected(async (isStale: boolean) => {
      if (!isStale) {
        // Server replayed buffered events — we're caught up, nothing to do
        console.info('[App] Reconnected with event replay — no refresh needed')
        return
      }

      console.warn('[App] Stale reconnect — refreshing session metadata and active/processing sessions')

      const refreshedMetaMap = await refreshSessionListMetadataFromServer({
        removeMissing: false,
        reason: 'stale-reconnect',
        selectedSessionId: sessionSelection.selected,
      })
      const metaMap = refreshedMetaMap ?? store.get(sessionMetaMapAtom)
      const refreshIds = getSessionsToRefreshAfterStaleReconnect(metaMap, sessionSelection.selected)

      console.info(`[App] Stale reconnect — refreshing ${refreshIds.length} session(s):`, refreshIds)

      // Refresh full message content only for the active session plus any
      // session still marked processing after the metadata refresh.
      for (const sessionId of refreshIds) {
        let refreshResult = await refreshSessionFromServer(sessionId)
        if (refreshResult !== 'refreshed') {
          // Server may need time to restart session subprocess after reconnect,
          // or it may still be lazily loading session messages.
          for (const delay of [2000, 4000]) {
            console.warn(`[App] Retrying session refresh for ${sessionId} after ${delay}ms (${refreshResult})`)
            await new Promise(r => setTimeout(r, delay))
            refreshResult = await refreshSessionFromServer(sessionId)
            if (refreshResult === 'refreshed') break
          }
        }
      }

      // Final fallback: if the active session is still empty, force a reload
      // even when the session is already marked loaded.
      if (sessionSelection.selected) {
        const session = store.get(sessionAtomFamily(sessionSelection.selected))
        if (session && (!session.messages || session.messages.length === 0)) {
          console.warn('[App] Active session still has no messages after stale reconnect refresh — forcing message reload')
          await store.set(forceSessionMessagesReloadAtom, sessionSelection.selected)
        } else if (session) {
          console.info(`[App] Stale reconnect recovery complete — active session has ${session.messages?.length ?? 0} messages`)
        }
      }

    })

    return cleanup
  }, [store, sessionSelection.selected, refreshSessionFromServer, refreshSessionListMetadataFromServer])

  // Listen for menu bar events
  useEffect(() => {
    const unsubNewChat = window.electronAPI.onMenuNewChat(() => {
      setMenuNewChatTrigger(n => n + 1)
    })
    const unsubSettings = window.electronAPI.onMenuOpenSettings(() => {
      handleOpenSettings()
    })
    const unsubShortcuts = window.electronAPI.onMenuKeyboardShortcuts(() => {
      navigate(routes.view.settings('shortcuts'))
    })
    return () => {
      unsubNewChat()
      unsubSettings()
      unsubShortcuts()
    }
  }, [])

  const handleCreateSession = useCallback(async (workspaceId: string, options?: import('../shared/types').CreateSessionOptions): Promise<Session> => {
    const session = await window.electronAPI.createSession(workspaceId, options)
    // Add to per-session atom and metadata map (no sessionsAtom)
    addSession(session)
    syncSessionOptionsFromSession(session)

    return session
  }, [addSession, syncSessionOptionsFromSession])

  // Deep link navigation is initialized later after handleInputChange is defined

  const handleDeleteSession = useCallback(async (sessionId: string, skipConfirmation = false): Promise<boolean> => {
    // Show confirmation dialog before deleting (unless skipped or session is empty). UA1.26 — a SHARED chat is asked
    // even when skipped (a batch's 2nd..n chats): its link outlives the delete (lib/delete-session-confirmation.ts).
    // Check if session has any messages using session metadata from Jotai store
    // We use store.get() instead of closing over sessions to prevent memory leaks
    // (closures would retain the full sessions array with all messages)
    const metaMap = store.get(sessionMetaMapAtom)
    const meta = metaMap.get(sessionId)
    // Session is empty if it has no lastFinalMessageId (no assistant responses) and no name (set on first user message)
    const needsConfirmation = deleteNeedsConfirmation(meta, skipConfirmation)

    if (needsConfirmation) {
      const confirmed = await window.electronAPI.showDeleteSessionConfirmation(meta?.name || 'Untitled', sessionId) // UA3.8 — the host names a task folder the delete removes
      if (!confirmed) return false
    }


    await window.electronAPI.deleteSession(sessionId)
    // Remove from per-session atom and metadata map (no sessionsAtom)
    removeSession(sessionId)
    return true
  }, [store, removeSession])

  // Auto-delete handler for empty sessions (fire-and-forget, no confirmation)
  const handleAutoDeleteEmptySession = useCallback((sessionId: string) => {
    window.electronAPI.deleteSession(sessionId)
    removeSession(sessionId)
  }, [removeSession])

  const handleFlagSession = useCallback((sessionId: string) => {
    updateSessionById(sessionId, { isFlagged: true })
    window.electronAPI.sessionCommand(sessionId, { type: 'flag' })
  }, [updateSessionById])

  const handleUnflagSession = useCallback((sessionId: string) => {
    updateSessionById(sessionId, { isFlagged: false })
    window.electronAPI.sessionCommand(sessionId, { type: 'unflag' })
  }, [updateSessionById])

  const handleArchiveSession = useCallback((sessionId: string) => {
    updateSessionById(sessionId, { isArchived: true, archivedAt: Date.now() })
    window.electronAPI.sessionCommand(sessionId, { type: 'archive' })
  }, [updateSessionById])

  const handleUnarchiveSession = useCallback((sessionId: string) => {
    updateSessionById(sessionId, { isArchived: false, archivedAt: undefined })
    window.electronAPI.sessionCommand(sessionId, { type: 'unarchive' })
  }, [updateSessionById])

  /**
   * P6.546 — an archived chat still waiting for an answer says so, once.
   *
   * `offerWorktreeCleanupOnClose` posts the keep-or-remove card into the session
   * being archived and does not await it, so a user who archives from the
   * sidebar and navigates away never sees it and the worktree is kept silently.
   * `41000700a` brought the card back when that chat is REOPENED; this is for the
   * user who never reopens it.
   *
   * THREE deps and each is load-bearing. `pendingPermissions` fires the ordinary
   * case (archive, then the card arrives). `sessionSelection.selected` fires the
   * other one: a card raised while the chat was on screen becomes invisible the
   * moment the user leaves, and leaving is a selection change and nothing else.
   * `sessionsLoaded` is P6.763's: a card raised BEFORE this app started is in no
   * window's `pendingPermissions` map, so the union the reconciler now reads
   * (the server's `awaitingApprovalCount`, per session) only becomes visible
   * once the session metas have arrived — and this flag turns true once per load (UA12.179), when
   * they have. Subscribing to the meta map instead would re-run this on every
   * message of every session for a decision that changes on neither.
   *
   * The meta map is read imperatively rather than subscribed, deliberately: this
   * component is the root, the map changes on every message of every session,
   * and the archived flag only has to be current at the moment a prompt appears,
   * the user walks away, or the list first loads.
   */
  const archivedAwaitingAnnouncedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const sessions = [...store.get(sessionMetaMapAtom).values()]
    const { announce, retained } = reconcileArchivedAwaitingNotices(
      sessions,
      pendingPermissions,
      archivedAwaitingAnnouncedRef.current,
      { viewingSessionId: sessionSelection.selected ?? undefined },
    )
    archivedAwaitingAnnouncedRef.current = retained
    for (const session of announce) {
      toast.info(t('toast.archivedChatAwaitingAnswer', { name: session.name || t('session.defaultTitle') }), {
        description: t('toast.archivedChatAwaitingAnswerDesc'),
        duration: 10000,
        action: {
          label: t('toast.archivedChatAwaitingAnswerAction'),
          onClick: () => handleNavigateToSession(session.id),
        },
      })
    }
  }, [store, pendingPermissions, sessionSelection.selected, sessionsLoaded, handleNavigateToSession, t])

  /**
   * Set which session user is actively viewing (for unread state machine).
   * Called when user navigates to a session. Main process uses this to determine
   * whether to mark new assistant messages as unread.
   */
  const handleSetActiveViewingSession = useCallback((sessionId: string) => {
    // Optimistic UI update: clear hasUnread immediately
    updateSessionById(sessionId, { hasUnread: false })
    // Tell main process user is viewing this session
    window.electronAPI.sessionCommand(sessionId, { type: 'setActiveViewing', workspaceId: windowWorkspaceId ?? '' })
  }, [updateSessionById, windowWorkspaceId])

  const handleMarkSessionRead = useCallback((sessionId: string) => {
    // Update hasUnread flag (primary source of truth for NEW badge)
    // Also update lastReadMessageId for backwards compatibility
    updateSessionById(sessionId, (s) => {
      const lastFinalId = s.messages.findLast(
        m => (m.role === 'assistant' || m.role === 'plan') && !m.isIntermediate
      )?.id
      return {
        hasUnread: false,
        ...(lastFinalId ? { lastReadMessageId: lastFinalId } : {}),
      }
    })
    window.electronAPI.sessionCommand(sessionId, { type: 'markRead' })
  }, [updateSessionById])

  const handleMarkSessionUnread = useCallback((sessionId: string) => {
    // Set hasUnread flag (primary source of truth for NEW badge)
    updateSessionById(sessionId, { hasUnread: true, lastReadMessageId: undefined })
    window.electronAPI.sessionCommand(sessionId, { type: 'markUnread' })
  }, [updateSessionById])

  const handleSessionStatusChange = useCallback((sessionId: string, state: SessionStatus) => {
    updateSessionById(sessionId, { sessionStatus: state })
    window.electronAPI.sessionCommand(sessionId, { type: 'setSessionStatus', state })
  }, [updateSessionById])

  const handleRenameSession = useCallback((sessionId: string, name: string) => {
    updateSessionById(sessionId, { name })
    window.electronAPI.sessionCommand(sessionId, { type: 'rename', name })
  }, [updateSessionById])

  const handleSendMessage = useCallback(async (sessionId: string, message: string, attachments?: FileAttachment[], skillSlugs?: string[], externalBadges?: ContentBadge[], customSlashCommandId?: import('@nessy-agent/shared/slash-commands/common').CustomSlashCommandId, midStreamOverride?: 'steer' | 'queue') => {
    try {
      // Capture pre-send processing state so we can flag mid-stream sends
      // for the queued badge (#616 follow-up — covers Pi steer path which
      // returns status 'accepted', not 'queued').
      const sendingMidStream = store.get(sessionAtomFamily(sessionId))?.isProcessing === true

      // Step 1: Store attachments and get persistent metadata
      let attachmentRefs: SessionAttachmentDto[] | undefined
      let processedAttachments: FileAttachment[] | undefined

      if (attachments?.length) {
        // Store each attachment to disk (generates thumbnails, converts Office→markdown)
        // Use allSettled so one failure doesn't kill all attachments
        const storeResults = await Promise.allSettled(
          attachments.map(a => window.electronAPI.storeAttachment(sessionId, a))
        )

        // Filter successful stores, warn about failures
        attachmentRefs = []
        const successfulAttachments: FileAttachment[] = []
        storeResults.forEach((result, i) => {
          if (result.status === 'fulfilled') {
            attachmentRefs!.push(result.value)
            successfulAttachments.push(attachments[i])
          } else {
            console.warn(`Failed to store attachment "${attachments[i].name}":`, result.reason)
          }
        })

        // Notify user about failed attachments
        const failedCount = storeResults.filter(r => r.status === 'rejected').length
        if (failedCount > 0) {
          console.warn(`${failedCount} attachment(s) failed to store`)
          // Add warning message to session so user knows some attachments weren't included
          const failedNames = attachments
            .filter((_, i) => storeResults[i].status === 'rejected')
            .map(a => a.name)
            .join(', ')
          updateSessionById(sessionId, (s) => ({
            messages: [...s.messages, {
              id: generateMessageId(),
              role: 'warning' as const,
              // C3.331 — the one sentence that mints the renderer's warning
              // bubble, and it is app copy addressed to the person in the chat
              // rather than an operator diagnostic, so it follows the UI
              // language like the bubble's own heading beside it.
              // `failed` rather than `count`: i18next reads `count` as a PLURAL
              // selector and would look for `…_one`/`…_other` forms this key
              // deliberately does not have (the English it replaces says
              // "attachment(s)", so neither locale needs a plural family).
              content: t('chat.warningBubble.attachmentsNotStored', {
                failed: failedCount,
                names: failedNames,
              }),
              timestamp: Date.now()
            }]
          }))
        }

        // Backend combines these user-selected inputs with its staged managed files.
        processedAttachments = successfulAttachments
      }

      // Step 3: Extract badges from mentions (sources/skills) with embedded icons
      // Badges are self-contained for display in UserMessageBubble and viewer
      // Merge with any externally provided badges (e.g., from EditPopover context badges)
      // Skill/source badges are qualified by immutable Workspace ID.
      const mentionBadges: ContentBadge[] = windowWorkspaceId
        ? extractBadges(message, skills, sources, windowWorkspaceId)
        : []
      const badges: ContentBadge[] = [...(externalBadges || []), ...mentionBadges]

      // Step 4.1: Detect SDK slash commands (e.g., /compact) and create command badges
      // This makes /compact render as an inline badge rather than raw text
      const commandMatch = message.match(/^\/([a-z]+)(\s|$)/i)
      if (commandMatch && commandMatch[1].toLowerCase() === 'compact') {
        const commandText = commandMatch[0].trimEnd() // "/compact" without trailing space
        badges.unshift({
          type: 'command',
          label: t('chat.compactCommandBadge'),
          rawText: commandText,
          start: 0,
          end: commandText.length,
        })
      }

      // Step 5: Create user message with safe attachment references.
      // Mark as isPending for optimistic UI — will be confirmed by user_message
      // event. Flag mid-stream sends as queued so the bubble renders with the
      // dashed-draft treatment immediately. Applies to both backends:
      // Pi steers (server emits status: 'accepted' but the renderer preserves
      // isQueued through that update) and Claude queues (server emits 'queued'
      // which confirms it). Cleared by 'processing' status or when the current
      // turn ends.
      const userMessage: Message = {
        id: generateMessageId(),
        role: 'user',
        content: message,
        timestamp: Date.now(),
        attachments: attachmentRefs,
        badges: badges.length > 0 ? badges : undefined,
        isPending: true,  // Optimistic - will be confirmed by backend
        isQueued: sendingMidStream,
      }

      // Optimistic UI update - add user message and set processing state
      updateSessionById(sessionId, (s) => ({
        messages: [...s.messages, userMessage],
        isProcessing: true,
        lastMessageAt: Date.now()
      }))

      // R36 `/clear` — remember that this session's in-flight submission is a
      // clear, so the transcript is refetched after its `complete` event (the
      // server empties the managed transcript without a dedicated event).
      // Same classifier as the server seam — never a second regex.
      if (parseSessionCommand(message)?.kind === 'clear') {
        pendingClearRefetchSessionsRef.current.add(sessionId)
      }

      // Step 6: Send to Claude with processed attachments + stored attachments for persistence
      await window.electronAPI.sendMessage(sessionId, message, processedAttachments, attachmentRefs, {
        skillSlugs,
        badges: badges.length > 0 ? badges : undefined,
        optimisticMessageId: userMessage.id,
        // The composer is the only human-typed prompt route. Deep links and
        // every other relay deliberately leave this unset so the workflow
        // keyword cannot be triggered on the user's behalf.
        origin: 'human',
        // P6.480 — present ONLY when the one-message chord was pressed, so an
        // ordinary send is byte-identical on the wire to one from before the row.
        ...(midStreamOverride ? { midStreamOverride } : {}),
      }, customSlashCommandId)
    } catch (error) {
      console.error('Failed to send message:', error)
      // A send that never reached the server cannot have cleared anything.
      pendingClearRefetchSessionsRef.current.delete(sessionId)
      updateSessionById(sessionId, (s) => ({
        isProcessing: false,
        messages: [
          ...s.messages,
          {
            id: generateMessageId(),
            role: 'error' as const,
            content: t('chat.sendFailed', { error: error instanceof Error ? error.message : t('toast.unknownError') }),
            timestamp: Date.now()
          }
        ]
      }))
    }
  }, [sessionOptions, updateSessionById, skills, sources, windowWorkspaceId, t])

  /**
   * Unified handler for all session option changes.
   * Handles persistence and backend sync for each option type.
   */
  const handleSessionOptionsChange = useCallback(async (sessionId: string, updates: SessionOptionUpdates) => {
    // First activation of bypassPermissions on this install: hold the switch
    // behind the responsibility dialog. Accepting records the acknowledgment
    // and re-dispatches; declining drops the switch (mode unchanged). Async:
    // the gate reads the durable config key over IPC (T5) — see
    // bypass-permissions-gate.ts for why this call shape is async rather
    // than a synchronous snapshot read.
    if (updates.permissionMode === 'bypassPermissions') {
      const ticket = bypassGateArbiter.current.begin()
      if (await needsBypassPermissionsAcknowledgment()) {
        // Someone else changed an option while this check was in flight: that
        // request owns the gate now, and raising a dialog for THIS one would ask
        // the user about an action they have already moved past.
        if (!bypassGateArbiter.current.isCurrent(ticket)) return
        setPendingBypassSwitch({ sessionId, updates })
        return
      }
    }
    setSessionOptions(prev => {
      const next = new Map(prev)
      const current = next.get(sessionId) ?? defaultSessionOptions
      next.set(sessionId, mergeSessionOptions(current, updates))
      return next
    })

    // Handle persistence/backend for specific options
    if (updates.permissionMode !== undefined) {
      // Sync permission mode change with backend
      window.electronAPI.sessionCommand(sessionId, { type: 'setPermissionMode', mode: updates.permissionMode })
    }
    if (updates.thinkingLevel !== undefined) {
      // Sync thinking level change with backend (session-level, persisted)
      window.electronAPI.sessionCommand(sessionId, { type: 'setThinkingLevel', level: updates.thinkingLevel })
    }
    if (updates.ultracode !== undefined) {
      // QK5 — the ultracode toggle. Session-level and NOT persisted: the server
      // keeps it in memory only, because `sdk.d.ts` calls the setting
      // "Session-scoped … interactive toggles never persist it". The server is
      // also where the third availability condition is answered — a toggle
      // switched on while workflows are off comes back as a one-line notice.
      window.electronAPI.sessionCommand(sessionId, { type: 'setUltracode', enabled: updates.ultracode })
    }
  }, [sessionOptions])

  // Handle input draft changes per session with debounced persistence
  const draftSaveTimeoutRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  // Cleanup draft save timers on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      draftSaveTimeoutRef.current.forEach(clearTimeout)
      draftSaveTimeoutRef.current.clear()
    }
  }, [])

  // Getter for draft text - reads from ref without triggering re-renders
  const getDraft = useCallback((sessionId: string): string => {
    const draft = sessionDraftsRef.current.get(sessionId) as unknown
    const text = draft && typeof draft === 'object'
      ? (draft as { text?: unknown }).text
      : draft
    return coerceInputText(text)
  }, [])

  // Getter for the draft's prompt origin — the composer discloses a prefill that
  // arrived from a link Nessy did not produce (see deep-link-policy).
  const getDraftPromptOrigin = useCallback((sessionId: string): SessionDraft['promptOrigin'] => {
    return sessionDraftsRef.current.get(sessionId)?.promptOrigin
  }, [])

  // Getter for persisted attachment refs (path + name only — not hydrated files).
  // Consumers that need FileAttachment objects should call hydrateDraftAttachments.
  const getDraftAttachmentRefs = useCallback((sessionId: string): DraftAttachmentRef[] => {
    const attachments = sessionDraftsRef.current.get(sessionId)?.attachments
    return Array.isArray(attachments) ? attachments : []
  }, [])

  // Hydrate persisted attachment refs into full FileAttachment objects.
  //  - Track C (ref.content set): reconstruct directly from the inlined bytes.
  //  - Track P (path-only): re-read from disk via the readUserAttachment RPC.
  // Missing/moved files on Track P are silently dropped with a console warn — same
  // UX as any other editor draft restore when the backing file is gone.
  const hydrateDraftAttachments = useCallback(async (sessionId: string): Promise<FileAttachment[]> => {
    const attachments = sessionDraftsRef.current.get(sessionId)?.attachments
    const refs = Array.isArray(attachments) ? attachments : []
    if (refs.length === 0) return []
    const results = await Promise.all(
      refs.map(async (ref) => {
        if (ref.content) {
          return attachmentFromContentRef(ref)
        }
        try {
          const attachment = await window.electronAPI.readUserAttachment(ref.path)
          if (!attachment) {
            console.warn('[drafts] Attachment missing on restore, dropping:', ref.path)
            return null
          }
          return attachment
        } catch (err) {
          console.warn('[drafts] Failed to restore attachment, dropping:', ref.path, err)
          return null
        }
      })
    )
    return results.filter((a): a is FileAttachment => a !== null)
  }, [])

  // Write a debounced snapshot of the current ref entry to disk.
  const schedulePersistDraft = useCallback((sessionId: string) => {
    const existingTimeout = draftSaveTimeoutRef.current.get(sessionId)
    if (existingTimeout) {
      clearTimeout(existingTimeout)
    }
    const timeout = setTimeout(() => {
      const draft = sessionDraftsRef.current.get(sessionId) ?? { text: '' }
      window.electronAPI.setDraft(sessionId, windowWorkspaceId ?? '', draft)
      draftSaveTimeoutRef.current.delete(sessionId)
    }, DRAFT_SAVE_DEBOUNCE_MS)
    draftSaveTimeoutRef.current.set(sessionId, timeout)
  }, [windowWorkspaceId])

  const handleInputChange = useCallback((sessionId: string, value: string, promptOrigin?: SessionDraft['promptOrigin']) => {
    const text = coerceInputText(value)
    const existing = sessionDraftsRef.current.get(sessionId)
    const existingAttachments = Array.isArray(existing?.attachments) ? existing.attachments : []
    // An external-link prefill keeps its mark while the user edits it: the
    // notice is documented to stay until the prompt is sent or cleared, and
    // both of those empty the draft, which drops the mark with it below.
    const nextPromptOrigin = promptOrigin ?? existing?.promptOrigin
    const nextDraft: SessionDraft = {
      text,
      ...(existingAttachments.length > 0
        ? { attachments: existingAttachments }
        : {}),
      ...(nextPromptOrigin ? { promptOrigin: nextPromptOrigin } : {}),
    }
    const isEmpty = !nextDraft.text && (!nextDraft.attachments || nextDraft.attachments.length === 0)
    if (isEmpty) {
      sessionDraftsRef.current.delete(sessionId)
    } else {
      sessionDraftsRef.current.set(sessionId, nextDraft)
    }
    schedulePersistDraft(sessionId)
  }, [schedulePersistDraft])

  const handleAttachmentsChange = useCallback((sessionId: string, attachments: FileAttachment[]) => {
    const existing = sessionDraftsRef.current.get(sessionId)
    const refs: DraftAttachmentRef[] = []
    for (const a of attachments) {
      const ref = toDraftRef(a)
      if (ref) {
        refs.push(ref)
      } else {
        console.warn('[drafts] attachment exceeds per-draft size cap, not persisted:', a.name, a.size)
      }
    }
    const nextDraft: SessionDraft = {
      text: coerceInputText(existing?.text),
      ...(refs.length > 0 ? { attachments: refs } : {}),
      // Attaching a file is not sending or clearing, so it must not silently
      // retire the external-link notice on the text already in the box.
      ...(existing?.promptOrigin ? { promptOrigin: existing.promptOrigin } : {}),
    }
    const isEmpty = !nextDraft.text && (!nextDraft.attachments || nextDraft.attachments.length === 0)
    if (isEmpty) {
      sessionDraftsRef.current.delete(sessionId)
    } else {
      sessionDraftsRef.current.set(sessionId, nextDraft)
    }
    schedulePersistDraft(sessionId)
  }, [schedulePersistDraft])

  // Open new chat - creates session and selects it
  // Used by components via AppShellContext and for programmatic navigation
  const openNewChat = useCallback(async (params: NewChatActionParams = {}) => {
    if (!windowWorkspaceId) {
      console.warn('[App] Cannot open new chat: no workspace ID')
      return
    }

    // The menu bar's New Chat, the shell's New Session button and every
    // programmatic open land here, and none of them had anywhere to put a
    // rejection — so a workspace that could not create a session answered all
    // of them with silence. `handleCreateSession` deliberately stays a
    // pass-through: ChatDisplay's branch flow already catches and toasts on its
    // own, and reporting one layer down would show that failure twice.
    let session: Session
    try {
      session = await handleCreateSession(windowWorkspaceId)
    } catch (error) {
      reportSessionCreateFailure(error, t)
      return
    }

    if (params.name) {
      await window.electronAPI.sessionCommand(session.id, { type: 'rename', name: params.name })
    }

    // Navigate to the chat view - this sets both selectedSession and activeView
    navigate(routes.view.allSessions(session.id))

    // Pre-fill input if provided (after a small delay to ensure component is mounted)
    if (params.input) {
      setTimeout(() => handleInputChange(session.id, params.input!), 100)
    }
  }, [windowWorkspaceId, handleCreateSession, handleInputChange, t])

  const handleRespondToPermission = useCallback(async (
    sessionId: string,
    requestId: string,
    allowed: boolean,
    alwaysAllow: boolean,
    options?: import('../shared/types').PermissionResponseOptions,
  ) => {
    const success = await window.electronAPI.respondToPermission(sessionId, requestId, allowed, alwaysAllow, options)

    // Drop the answered prompt by REQUEST ID, not by position under
    // `sessionId`. A subagent's prompt is filed under the visible ancestor
    // (sub-agents.md:1043) while its answer is addressed to the child that
    // asked, so the two ids differ and a positional removal would leave the
    // answered prompt on screen forever. On failure the prompt is cleared the
    // same way, so the UI is never stuck with a stale one.
    void success
    setPendingPermissions(prev => removePendingPermission(prev, requestId) as Map<string, PermissionRequest[]>)
  }, [])

  const handleRespondToCredential = useCallback(async (sessionId: string, requestId: string, response: CredentialResponse) => {
    const success = await window.electronAPI.respondToCredential(sessionId, requestId, response)

    if (success) {
      // Remove only the first credential from the queue (the one we just responded to)
      setPendingCredentials(prev => {
        const next = new Map(prev)
        const queue = next.get(sessionId) || []
        const remainingQueue = queue.slice(1) // Remove first item
        if (remainingQueue.length === 0) {
          next.delete(sessionId)
        } else {
          next.set(sessionId, remainingQueue)
        }
        return next
      })
      // Note: No need to force session refresh - per-session atoms update automatically
    } else {
      // Response failed (agent/session gone) - clear the credential anyway
      // to avoid UI being stuck with stale credential request
      setPendingCredentials(prev => {
        const next = new Map(prev)
        const queue = next.get(sessionId) || []
        const remainingQueue = queue.slice(1)
        if (remainingQueue.length === 0) {
          next.delete(sessionId)
        } else {
          next.set(sessionId, remainingQueue)
        }
        return next
      })
    }
  }, [])

  // Centralized link interceptor: classifies file types and decides whether to
  // show an in-app preview overlay or open externally. Replaces the old
  // handleOpenFile/handleOpenUrl that always opened in external apps.
  const linkInterceptor = useLinkInterceptor({
    openFileExternal: async (path) => {
      try {
        await window.electronAPI.openFile(path)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        console.error('Failed to open file:', error)
        toast.error(t('toast.failedToOpenFile'), {
          description: message,
        })
      }
    },
    openUrl: async (url) => {
      try {
        await window.electronAPI.openUrl(url)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        console.error('Failed to open URL:', error)
        // The blocked-URL classifier already explains WHY and (for file:)
        // points the user at preview blocks. Don't append the generic
        // "use Open File instead" hint when the message already carries
        // that guidance.
        const hasRichGuidance = /URL blocked/.test(message)
        const tail = hasRichGuidance ? '' : '. If this is a local path, use Open File instead.'
        toast.error(t('toast.failedToOpenLink'), {
          description: `${message}${tail}`,
        })
      }
    },
    showInFolder: async (path) => {
      try {
        await window.electronAPI.showInFolder(path)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        console.error('Failed to show in folder:', error)
        toast.error(t("toast.failedToReveal", { fileManager: getFileManagerName() }), {
          description: message,
        })
      }
    },
    readFile: (path) => window.electronAPI.readFile(path),
    readFileDataUrl: (path) => window.electronAPI.readFileDataUrl(path),
    readFileBinary: (path) => window.electronAPI.readFileBinary(path),
  })

  const connectionState = useTransportConnectionState()
  const showTransportConnectionBanner = shouldShowTransportConnectionBanner(connectionState)

  const handleReconnectTransport = useCallback(() => {
    void window.electronAPI.reconnectTransport().catch((error) => {
      const message = error instanceof Error ? error.message : 'Unknown error'
      toast.error(t('toast.reconnectFailed'), { description: message })
    })
  }, [])

  const handleOpenFile = linkInterceptor.handleOpenFile
  const handleOpenUrl = linkInterceptor.handleOpenUrl

  const handleOpenSettings = useCallback(() => {
    navigate(routes.view.settings())
  }, [])

  const handleOpenKeyboardShortcuts = useCallback(() => {
    navigate(routes.view.settings('shortcuts'))
  }, [])

  const handleOpenStoredUserPreferences = useCallback(() => {
    navigate(routes.view.settings('preferences'))
  }, [])

  // Show reset confirmation dialog
  const handleReset = useCallback(() => {
    setShowResetDialog(true)
  }, [])

  // Execute reset after user confirms in dialog
  const executeReset = useCallback(async () => {
    try {
      await window.electronAPI.logout()
      // Reset all state
      // Clear session atoms - initialize with empty array clears all per-session atoms
      initializeSessions([])
      setWorkspaces([])
      setWindowWorkspaceId(null)
      // Reset setupNeeds to force fresh onboarding start
      setSetupNeeds({
        needsBillingConfig: true,
        needsCredentials: true,
        isFullyConfigured: false,
      })
      // Reset onboarding hook state
      onboarding.reset()
      setAppState('onboarding')
    } catch (error) {
      console.error('Reset failed:', error)
    } finally {
      setShowResetDialog(false)
    }
  }, [onboarding, initializeSessions])

  // Handle workspace selection
  // - Default: switch workspace in same window (in-window switching)
  // - With openInNewWindow=true: open in new window (or focus existing)
  const handleSelectWorkspace = useCallback(async (workspaceId: string, openInNewWindow = false) => {
    // If selecting current workspace, do nothing
    if (workspaceId === windowWorkspaceId) return

    if (openInNewWindow) {
      // Open (or focus) the window for the selected workspace
      window.electronAPI.openWorkspace(workspaceId)
    } else {
      // Switch workspace in current window
      // 1. Update the main process's window-workspace mapping
      await window.electronAPI.switchWorkspace(workspaceId)

      // 2. Update React state to trigger re-renders
      setWindowWorkspaceId(workspaceId); setSessionsLoaded(false) // UA12.179: ?panels= reconciles only after the reload, never against the emptied meta map

      // 3. Clear selected session - the old session belongs to the previous workspace
      // and should not remain selected when switching to a new workspace.
      // This prevents showing stale session data from the wrong workspace.
      setSession({ selected: null })

      // 4. Clear pending permissions/credentials (not relevant to new workspace)
      setPendingPermissions(new Map())
      setPendingCredentials(new Map())

      // 5. Clear session options from previous workspace
      // (session IDs are unique UUIDs, but clearing prevents unbounded memory growth
      // and ensures no stale state from old workspace persists)
      setSessionOptions(new Map())

      // 6. Clear message drafts from previous workspace
      // (prevents memory growth on repeated workspace switches)
      sessionDraftsRef.current.clear()

      // 7. Reset sources and skills atoms to empty
      // (prevents stale data flash during workspace switch - AppShell will reload)
      store.set(sourcesAtom, [])
      store.set(skillsAtom, [])

      // 8. Clear session atoms BEFORE workspace switch
      // This prevents stale session data from the previous workspace being visible.
      store.set(sessionMetaMapAtom, new Map())
      store.set(sessionIdsAtom, [])

      // Note: NavigationContext detects the workspaceId change and handles
      // panel restoration from the stored workspace URL (or defaults to allSessions).
      // Sessions and theme will reload automatically due to windowWorkspaceId dependency
      // in useEffect hooks.
    }
  }, [windowWorkspaceId, setSession, store])

  // The historical `ws` query key now carries the immutable Workspace ID.
  const handleSwitchWorkspaceById = useCallback((workspaceId: string) => {
    const target = workspaces.find(w => w.id === workspaceId)
    if (target) {
      handleSelectWorkspace(target.id)
    }
  }, [workspaces, handleSelectWorkspace])

  // Handle workspace refresh (e.g., after icon upload)
  const handleRefreshWorkspaces = useCallback(() => {
    window.electronAPI.getWorkspaces().then(setWorkspaces)
  }, [])

  // Handle cancel during onboarding
  const handleOnboardingCancel = useCallback(() => {
    onboarding.handleCancel()
  }, [onboarding])

  // Build context value for AppShell component
  // This is memoized to prevent unnecessary re-renders
  // IMPORTANT: Must be before early returns to maintain consistent hook order
  const appShellContextValue = useMemo<AppShellContextType>(() => ({
    // Data
    // NOTE: sessions is NOT included - use sessionMetaMapAtom for listing
    // and useSession(id) hook for individual sessions. This prevents memory leaks.
    workspaces,
    activeWorkspaceId: windowWorkspaceId,
    llmConnections,
    workspaceDefaultLlmConnection,
    refreshLlmConnections,
    pendingPermissions,
    pendingCredentials,
    getDraft,
    getDraftAttachmentRefs,
    getDraftPromptOrigin,
    hydrateDraftAttachments,
    sessionOptions,
    // Session callbacks
    onCreateSession: handleCreateSession,
    onSendMessage: handleSendMessage,
    onRenameSession: handleRenameSession,
    onFlagSession: handleFlagSession,
    onUnflagSession: handleUnflagSession,
    onArchiveSession: handleArchiveSession,
    onUnarchiveSession: handleUnarchiveSession,
    onMarkSessionRead: handleMarkSessionRead,
    onMarkSessionUnread: handleMarkSessionUnread,
    onSetActiveViewingSession: handleSetActiveViewingSession,
    onSessionStatusChange: handleSessionStatusChange,
    onDeleteSession: handleDeleteSession,
    onRespondToPermission: handleRespondToPermission,
    onRespondToCredential: handleRespondToCredential,
    // File/URL handlers
    onOpenFile: handleOpenFile,
    onOpenUrl: handleOpenUrl,
    // Workspace
    onSelectWorkspace: handleSelectWorkspace,
    onRefreshWorkspaces: handleRefreshWorkspaces,
    // App actions
    onOpenSettings: handleOpenSettings,
    onOpenKeyboardShortcuts: handleOpenKeyboardShortcuts,
    onOpenStoredUserPreferences: handleOpenStoredUserPreferences,
    onReset: handleReset,
    // Session options
    onSessionOptionsChange: handleSessionOptionsChange,
    onInputChange: handleInputChange,
    onAttachmentsChange: handleAttachmentsChange,
    // New chat (via deep link navigation)
    openNewChat,
  }), [
    // NOTE: sessions removed to prevent memory leaks - components use atoms instead
    workspaces,
    windowWorkspaceId,
    llmConnections,
    workspaceDefaultLlmConnection,
    refreshLlmConnections,
    pendingPermissions,
    pendingCredentials,
    getDraft,
    getDraftAttachmentRefs,
    getDraftPromptOrigin,
    hydrateDraftAttachments,
    sessionOptions,
    handleCreateSession,
    handleSendMessage,
    handleRenameSession,
    handleFlagSession,
    handleUnflagSession,
    handleArchiveSession,
    handleUnarchiveSession,
    handleMarkSessionRead,
    handleMarkSessionUnread,
    handleSetActiveViewingSession,
    handleSessionStatusChange,
    handleDeleteSession,
    handleRespondToPermission,
    handleRespondToCredential,
    handleOpenFile,
    handleOpenUrl,
    handleSelectWorkspace,
    handleRefreshWorkspaces,
    handleOpenSettings,
    handleOpenKeyboardShortcuts,
    handleOpenStoredUserPreferences,
    handleReset,
    handleSessionOptionsChange,
    handleInputChange,
    handleAttachmentsChange,
    openNewChat,
  ])

  // Platform actions for @nessy-agent/ui components (overlays, etc.)
  // Memoized to prevent re-renders when these callbacks don't change
  // NOTE: Must be defined before early returns to maintain consistent hook order
  const platformActions = useMemo(() => ({
    onOpenFile: handleOpenFile,
    onOpenUrl: handleOpenUrl,
    // Bypass link interceptor — opens file directly in system editor.
    // Used by overlay header badges (when already viewing a file, "Open" should launch editor).
    onOpenFileExternal: linkInterceptor.openFileExternal,
    // Read file contents as UTF-8 string (used by datatable/spreadsheet/html-preview src fields)
    onReadFile: (path: string) => window.electronAPI.readFile(path),
    // Read file as data URL (used by image-preview blocks)
    onReadFileDataUrl: (path: string) => window.electronAPI.readFileDataUrl(path),
    // Read file as binary Uint8Array (used by PDF preview blocks)
    onReadFileBinary: (path: string) => window.electronAPI.readFileBinary(path),
    // Reveal a file in the system file manager (Finder on macOS, Explorer on Windows, etc.)
    onRevealInFinder: (path: string) => {
      window.electronAPI.showInFolder(path).catch(() => {})
    },
    // Platform-specific file manager name for UI labels
    fileManagerName: getFileManagerName(),
    // Hide/show macOS traffic lights when fullscreen overlays are open
    onSetTrafficLightsVisible: (visible: boolean) => {
      window.electronAPI.setTrafficLightsVisible(visible)
    },
  }), [handleOpenFile, handleOpenUrl, linkInterceptor.openFileExternal])

  // Loading state - show splash screen
  if (appState === 'loading') {
    return <SplashScreen isExiting={false} />
  }

  // Reauth state - session expired, need to re-login
  // ModalProvider + WindowCloseHandler ensures X button works on Windows
  if (appState === 'reauth') {
    return (
      <DismissibleLayerProvider>
        <ModalProvider>
          <WindowCloseHandler />
          <ReauthScreen
            onLogin={handleReauthLogin}
            onReset={handleReauthReset}
          />
          <ResetConfirmationDialog
            open={showResetDialog}
            onConfirm={executeReset}
            onCancel={() => setShowResetDialog(false)}
          />
        </ModalProvider>
      </DismissibleLayerProvider>
    )
  }

  // Onboarding state
  // ModalProvider + WindowCloseHandler ensures X button works on Windows
  // (without this, the close IPC message has no listener and window stays open)
  if (appState === 'onboarding') {
    return (
      <DismissibleLayerProvider>
        <ModalProvider>
          <WindowCloseHandler />
          <OnboardingWizard
            state={onboarding.state}
            onContinue={onboarding.handleContinue}
            onBack={onboarding.handleBack}
            onSelectProvider={onboarding.handleSelectProvider}
            onSkipSetup={onboarding.handleSkipSetup}
            onSelectApiSetupMethod={onboarding.handleSelectApiSetupMethod}
            onSubmitCredential={onboarding.handleSubmitCredential}
            onSubmitLocalModel={onboarding.handleSubmitLocalModel}
            onSubmitByoRuntime={onboarding.handleSubmitByoRuntime}
            onStartOAuth={onboarding.handleStartOAuth}
            onFinish={onboarding.handleFinish}
            isWaitingForCode={onboarding.isWaitingForCode}
            onSubmitAuthCode={onboarding.handleSubmitAuthCode}
            onCancelOAuth={onboarding.handleCancelOAuth}
            onBrowseGitBash={onboarding.handleBrowseGitBash}
            onUseGitBashPath={onboarding.handleUseGitBashPath}
            onRecheckGitBash={onboarding.handleRecheckGitBash}
            onClearError={onboarding.handleClearError}
          />
        </ModalProvider>
      </DismissibleLayerProvider>
    )
  }

  // Workspace picker — thin client with no workspace selected
  if (appState === 'workspace-picker') {
    return (
      <DismissibleLayerProvider>
        <ModalProvider>
          <WindowCloseHandler />
          <WorkspacePicker
            onSelectWorkspace={async (id) => {
              await window.electronAPI.switchWorkspace(id)
              setWindowWorkspaceId(id)
              setAppState('ready')
            }}
          />
        </ModalProvider>
      </DismissibleLayerProvider>
    )
  }

  // Show splash until the exit completes — by animation, or by its deadline.
  const showSplash = isSplashMounted(splashPhase)

  // Ready state - main app with splash overlay during data loading
  return (
    <PlatformProvider actions={platformActions}>
    <ShikiThemeProvider shikiTheme={shikiTheme}>
      <ActionRegistryProvider>
      <FocusProvider>
        <DismissibleLayerProvider>
        <ModalProvider>
        {/* upstream mounts the provider bare: the 500/300 defaults in tooltip.tsx hold only without an override (UB13.9) */}
        <TooltipProvider>
        <NavigationProvider
          workspaceId={windowWorkspaceId}
          onSwitchWorkspaceById={handleSwitchWorkspaceById}
          onCreateSession={handleCreateSession}
          onInputChange={handleInputChange}
          getDraft={getDraft}
          onAutoDeleteEmptySession={handleAutoDeleteEmptySession}
          isReady={appState === 'ready'}
          isSessionsReady={sessionsLoaded}
          remoteWorkspaceId={windowRemoteWorkspaceId}
        >
          {/* Handle window close requests (X button, Cmd+W) - close modal first if open */}
          <WindowCloseHandler />

          {/* Speaks the assistant's reply once, on completion, to a screen
              reader. Renders no visible output; must stay mounted for the
              whole session so its live region pre-exists its own updates. */}
          <ReplyAnnouncer />

          {/* Splash screen overlay - fades out when fully ready */}
          {showSplash && (
            <SplashScreen
              isExiting={isSplashExiting(splashPhase)}
              onExitComplete={handleSplashExitComplete}
            />
          )}

          {/* Main UI - always rendered, splash fades away to reveal it */}
          <div
            className="h-full flex flex-col text-foreground"
            style={{ paddingTop: 'var(--topbar-height)' }}
          >
            {showTransportConnectionBanner && connectionState && (
              <TransportConnectionBanner
                state={connectionState}
                onRetry={handleReconnectTransport}
              />
            )}
            <div className="flex-1 min-h-0">
              {sessionLoadError ? (
                <SessionLoadErrorScreen
                  message={sessionLoadError}
                  onRetry={() => { void loadSessionsFromServer() }}
                />
              ) : (
                <AppShell
                  contextValue={appShellContextValue}
                  defaultLayout={[20, 32, 48]}
                  menuNewChatTrigger={menuNewChatTrigger}
                  isFocusedMode={isFocusedMode}
                />
              )}
            </div>
            <ResetConfirmationDialog
              open={showResetDialog}
              onConfirm={executeReset}
              onCancel={() => setShowResetDialog(false)}
            />
            <BypassPermissionsDialog
              open={pendingBypassSwitch !== null}
              onConfirm={async () => {
                // The ref, not `pendingBypassSwitch`, is the double-click guard:
                // `setPendingBypassSwitch(null)` below does not change this
                // closure's value, so a second click before the re-render would
                // otherwise pass the null check and re-dispatch the switch.
                if (!pendingBypassSwitch || bypassConfirmInFlight.current) return
                bypassConfirmInFlight.current = true
                try {
                  await recordBypassPermissionsAcknowledgment()
                } finally {
                  bypassConfirmInFlight.current = false
                }
                const { sessionId, updates } = pendingBypassSwitch
                setPendingBypassSwitch(null)
                void handleSessionOptionsChange(sessionId, updates)
              }}
              onCancel={() => setPendingBypassSwitch(null)}
            />
          </div>

          {/* File preview overlay — rendered by the link interceptor when a previewable file is clicked */}
          {linkInterceptor.previewState && (
            <FilePreviewRenderer
              state={linkInterceptor.previewState}
              onClose={linkInterceptor.closePreview}
              loadDataUrl={linkInterceptor.readFileDataUrl}
              loadPdfData={linkInterceptor.readFileBinary}
              isDark={isDark}
            />
          )}
        </NavigationProvider>
        </TooltipProvider>
        </ModalProvider>
        </DismissibleLayerProvider>
      </FocusProvider>
      </ActionRegistryProvider>
    </ShikiThemeProvider>
    </PlatformProvider>
  )
}

/**
 * Component that handles window close requests.
 * Must be inside ModalProvider to access the modal registry.
 */
function WindowCloseHandler() {
  useWindowCloseHandler()
  return null
}

/**
 * FilePreviewRenderer - Routes file preview state to the correct overlay component.
 *
 * Handles all preview types from the link interceptor:
 * - image → ImagePreviewOverlay (binary, loaded via data URL)
 * - pdf → PDFPreviewOverlay (binary, embedded via Chromium viewer)
 * - code/text → CodePreviewOverlay (syntax highlighted)
 * - markdown → DocumentFormattedMarkdownOverlay
 * - json → JSONPreviewOverlay
 *
 * File path badges with "Open" / "Reveal in {file manager}" menus are provided
 * automatically by PlatformContext — no per-overlay callback props needed.
 */
function FilePreviewRenderer({
  state,
  onClose,
  loadDataUrl,
  loadPdfData,
  isDark,
}: {
  state: FilePreviewState
  onClose: () => void
  loadDataUrl: (path: string) => Promise<string>
  loadPdfData: (path: string) => Promise<Uint8Array>
  isDark: boolean
}) {
  const theme = isDark ? 'dark' : 'light' as const

  switch (state.type) {
    case 'image':
      return (
        <ImagePreviewOverlay
          isOpen
          onClose={onClose}
          filePath={state.filePath}
          loadDataUrl={loadDataUrl}
          theme={theme}
        />
      )

    case 'pdf':
      return (
        <PDFPreviewOverlay
          isOpen
          onClose={onClose}
          filePath={state.filePath}
          loadPdfData={loadPdfData}
          theme={theme}
        />
      )

    case 'code':
    case 'text':
      return (
        <CodePreviewOverlay
          isOpen
          onClose={onClose}
          filePath={state.filePath}
          content={state.content ?? ''}
          language={state.type === 'code' ? state.language : 'plaintext'}
          mode="read"
          theme={theme}
          error={state.error}
        />
      )

    case 'markdown': {
      // Show PLAN header for .md files in plans folder (handles both absolute and relative paths)
      const isPlanFile =
        (state.filePath.includes('/plans/') || state.filePath.startsWith('plans/')) &&
        state.filePath.endsWith('.md')
      return (
        <DocumentFormattedMarkdownOverlay
          isOpen
          onClose={onClose}
          content={state.content ?? ''}
          filePath={state.filePath}
          variant={isPlanFile ? 'plan' : 'response'}
        />
      )
    }

    case 'json': {
      // JSONPreviewOverlay expects parsed data, not a raw string.
      // @uiw/react-json-view crashes on null value, so guard against it.
      let parsedData: unknown = null
      try {
        if (state.content) parsedData = JSON.parse(state.content)
      } catch {
        // If parsing fails, fall back to showing as code
        return (
          <CodePreviewOverlay
            isOpen
            onClose={onClose}
            filePath={state.filePath}
            content={state.content ?? ''}
            language="json"
            mode="read"
            theme={theme}
            error={state.error}
          />
        )
      }
      // If read failed and content is empty, show raw code overlay with the read error.
      if ((!state.content || !state.content.trim()) && state.error) {
        return (
          <CodePreviewOverlay
            isOpen
            onClose={onClose}
            filePath={state.filePath}
            content={state.content ?? ''}
            language="json"
            mode="read"
            theme={theme}
            error={state.error}
          />
        )
      }
      return (
        <JSONPreviewOverlay
          isOpen
          onClose={onClose}
          filePath={state.filePath}
          title={state.filePath.split('/').pop() ?? 'JSON'}
          data={parsedData}
          theme={theme}
          error={state.error}
        />
      )
    }

    default:
      return null
  }
}

// UA1.26 — imported at the end so every line above keeps its number (the docs cite this file to line 2473).
import { deleteNeedsConfirmation } from '@/lib/delete-session-confirmation'
