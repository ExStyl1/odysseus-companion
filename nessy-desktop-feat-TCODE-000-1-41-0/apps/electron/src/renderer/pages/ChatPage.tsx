/**
 * ChatPage
 *
 * Displays a single session's chat under its ChatHeader (status, title, labels, info, share, ⋯).
 * Extracted from MainContentPanel for consistency with other pages.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAtomValue, useSetAtom } from 'jotai'
import { AlertCircle } from 'lucide-react'
import { ChatDisplay, type ChatDisplayHandle } from '@/components/app-shell/ChatDisplay'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ChatHeader } from '@/components/app-shell/chat-header/ChatHeader'
import { ProjectTrustDialog } from '@/components/workspace/ProjectTrustDialog'
import { toast } from 'sonner'
import { useAppShellContext, usePendingPermission, usePendingCredential, useSessionOptionsFor, useSession as useSessionData } from '@/context/AppShellContext'
import { rendererPerf } from '@/lib/perf'
// UB14.6 (v0.15.1 `pages/ChatPage.tsx`) — the session header left this page for `chat-header/ChatHeader.tsx`:
// status glyph, title (click to rename, with its dialog), folder, label chips (+N), Session info, Share (our
// t-artifacts flow through `useSessionMenuActions`, UA1.26), saved actions (P6.361), Edit task (UA3.6) and the
// ⋯ session menu (a drawer in the compact shell); it reads the session callbacks from AppShellContext itself.
// These comment lines stand where the header's imports stood, and the context destructure below keeps its
// count the same way: the plans cite this file by line (the runtime-switch summary at about L386–410), so
// everything above the header code keeps its number (AGENTS.md: a comment edit in a heavily cited file keeps
// its line count). Only the missing-session state still draws a bare `PanelHeader`.
import { coerceInputText } from '@/lib/input-text'
// UB4.5 — the cross-platform absolute-path check (POSIX `/…`, Windows `C:\…`), the same
// helper drafts.ts previews use; upstream v0.15.1's ChatPage imports it for exactly this
// resolution (craft-agents-oss#922/#875).
import { isAbsolutePath } from '@/lib/drafts'
import { deriveSessionMessagesLoadState, formatSessionLoadFailure } from '@/lib/session-load'
import { ensureSessionMessagesLoadedAtom, forceSessionMessagesReloadAtom, loadedSessionsAtom, sessionMetaMapAtom, updateSessionAtom } from '@/atoms/sessions'
import { getSessionTitle } from '@/utils/session'
import type { IssuedProjectHandle } from '@nessy-agent/shared/projects/project-handle-service'
import { claimProjectTrustCheck, offerProjectTrustPrompt, projectTrustPromptFor, resolveProjectTrustPrompt, type PendingProjectTrust, type ProjectTrustSession } from '@/lib/project-trust-gate'
// Model resolution: connection.defaultModel (no hardcoded defaults)
import { resolveEffectiveConnectionSlug, isSessionConnectionUnavailable } from '@config/llm-connections'

export interface ChatPageProps {
  sessionId: string
}

const RENDERER_CONFIG = {
  sharingEnabled: true, // UA1.26 — sharing goes to t-artifacts behind the host card (UA1.25)
} as const

const ChatPage = React.memo(function ChatPage({ sessionId }: ChatPageProps) {
  const { t } = useTranslation()
  // Diagnostic: mark when component runs
  React.useLayoutEffect(() => {
    rendererPerf.markSessionSwitch(sessionId, 'panel.mounted')
  }, [sessionId])

  const {
    activeWorkspaceId,
    llmConnections,
    workspaceDefaultLlmConnection,
    onSendMessage,
    onOpenFile,
    onOpenUrl,
    onRespondToPermission,
    onRespondToCredential,
    onMarkSessionRead,
    onSetActiveViewingSession,
    getDraft,
    getDraftPromptOrigin,
    hydrateDraftAttachments,
    onInputChange,
    onAttachmentsChange,
    enabledSources,
    skills,
    labels,
    onSessionLabelsChange,
    enabledModes,
    onSessionSourcesChange,
    // UB14.6 — the header's session callbacks left with it: `ChatHeader` reads rename, flag/unflag,
    // archive/unarchive, mark unread, status and delete from this same context (v0.15.1). The statuses
    // are no longer handed to ChatDisplay either (upstream's hunk): the status lives on the header's
    // glyph now, so the composer's badge row stopped drawing it, and UB14.55 then dropped that row's
    // label chips too (the header owns labels); the `#` menu keeps its status picker (FreeFormInput).
    // These lines keep the destructure's line count for the citations the note at the imports names;
    // `onMarkSessionRead` above was already unread here and is left as it was.
    // (Nothing else moved: drafts, attachments, the model/connection pickers, the runtime switch and
    // its toasts, the project trust gate and the open-file resolution all stay on this page.)
    rightSidebarButton,
    leadingAction,
    isCompactMode,
    sessionListSearchQuery,
    isSearchModeActive,
    chatDisplayRef,
    onChatMatchInfoChange,
    isFocusedPanel,
  } = useAppShellContext()

  // Use the unified session options hook for clean access
  const {
    options: sessionOpts,
    setOption,
    setPermissionMode,
  } = useSessionOptionsFor(sessionId)

  // Use per-session atom for isolated updates
  const session = useSessionData(sessionId)

  // Track if messages are loaded for this session (for lazy loading)
  const loadedSessions = useAtomValue(loadedSessionsAtom)
  const messagesLoaded = loadedSessions.has(sessionId)

  // Check if session exists in metadata (for loading state detection)
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)
  const sessionMeta = sessionMetaMap.get(sessionId)

  // Fallback: ensure messages are loaded when session is viewed
  const ensureMessagesLoaded = useSetAtom(ensureSessionMessagesLoadedAtom)
  const forceMessagesReload = useSetAtom(forceSessionMessagesReloadAtom)
  const updateSession = useSetAtom(updateSessionAtom)
  const [messagesLoadError, setMessagesLoadError] = React.useState<string | null>(null)
  const [messagesRetrying, setMessagesRetrying] = React.useState(false)
  const autoForcedReloadSessionRef = React.useRef<string | null>(null)
  const shouldForceInitialMessagesReload = React.useMemo(() => {
    const expectedMessageCount = session?.messageCount ?? sessionMeta?.messageCount ?? 0
    return messagesLoaded
      && !!session
      && (session.messages?.length ?? 0) === 0
      && (expectedMessageCount > 0 || !!session.lastFinalMessageId || !!sessionMeta?.lastFinalMessageId)
  }, [messagesLoaded, session, sessionMeta])

  React.useEffect(() => {
    let cancelled = false
    setMessagesLoadError(null)
    setMessagesRetrying(false)

    if (shouldForceInitialMessagesReload && autoForcedReloadSessionRef.current === sessionId) {
      setMessagesLoadError('Session messages are not available')
      return () => {
        cancelled = true
      }
    }

    const useForceReload = shouldForceInitialMessagesReload
    if (useForceReload) {
      autoForcedReloadSessionRef.current = sessionId
    }

    const loadPromise = useForceReload
      ? forceMessagesReload(sessionId)
      : ensureMessagesLoaded(sessionId)

    loadPromise
      .then((loadedSession) => {
        if (!cancelled && !loadedSession) {
          setMessagesLoadError('Session messages are not available')
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setMessagesLoadError(formatSessionLoadFailure(error))
        }
      })

    return () => {
      cancelled = true
    }
  }, [sessionId, ensureMessagesLoaded, forceMessagesReload, shouldForceInitialMessagesReload])

  const handleRetryMessagesLoad = React.useCallback(async () => {
    setMessagesLoadError(null)
    setMessagesRetrying(true)

    try {
      const loadedSession = await forceMessagesReload(sessionId)
      if (!loadedSession) {
        setMessagesLoadError('Session messages are not available')
      }
    } catch (error) {
      setMessagesLoadError(formatSessionLoadFailure(error))
    } finally {
      setMessagesRetrying(false)
    }
  }, [forceMessagesReload, sessionId])

  const messageLoadState = React.useMemo(() => deriveSessionMessagesLoadState({
    session,
    sessionMeta,
    messagesLoaded,
    loadError: messagesLoadError,
  }), [session, sessionMeta, messagesLoaded, messagesLoadError])

  // Perf: Mark when session data is available
  const sessionLoadedMarkedRef = React.useRef<string | null>(null)
  React.useLayoutEffect(() => {
    if (session && sessionLoadedMarkedRef.current !== sessionId) {
      sessionLoadedMarkedRef.current = sessionId
      rendererPerf.markSessionSwitch(sessionId, 'session.loaded')
    }
  }, [sessionId, session])

  // Track window focus state for marking session as read when app regains focus
  const [isWindowFocused, setIsWindowFocused] = React.useState(true)
  React.useEffect(() => {
    window.electronAPI.getWindowFocusState().then(setIsWindowFocused)
    const cleanup = window.electronAPI.onWindowFocusChange(setIsWindowFocused)
    return cleanup
  }, [])

  // Track which session user is viewing (for unread state machine).
  // This tells main process user is looking at this session, so:
  // 1. If not processing → clear hasUnread immediately
  // 2. If processing → when it completes, main process will clear hasUnread
  // The main process handles all the logic; we just report viewing state.
  React.useEffect(() => {
    if (session && isWindowFocused && isFocusedPanel !== false) {
      onSetActiveViewingSession(session.id)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, isWindowFocused, isFocusedPanel, onSetActiveViewingSession])

  // Get pending permission and credential for this session
  const pendingPermission = usePendingPermission(sessionId)
  const pendingCredential = usePendingCredential(sessionId)

  // Track draft value for this session
  const [inputValue, setInputValue] = React.useState(() => coerceInputText(getDraft(sessionId)))
  const inputValueRef = React.useRef(inputValue)
  inputValueRef.current = inputValue

  // Travels with the draft text, never separately from it: a prefill from a link
  // Nessy did not produce is disclosed under the composer until it is sent or
  // cleared (deep-links.md), and a stale flag would accuse the user's own typing.
  const [promptFromExternalLink, setPromptFromExternalLink] = React.useState(
    () => getDraftPromptOrigin(sessionId) === 'external-link'
  )

  // Re-sync from parent when session changes
  React.useEffect(() => {
    setInputValue(coerceInputText(getDraft(sessionId)))
    setPromptFromExternalLink(getDraftPromptOrigin(sessionId) === 'external-link')
  }, [getDraft, getDraftPromptOrigin, sessionId])

  // Sync when draft is set externally (e.g., from notifications or shortcuts)
  // PERFORMANCE NOTE: This bounded polling (max 10 attempts × 50ms = 500ms)
  // handles external draft injection. Drafts use a ref for typing performance,
  // so they're not directly reactive. This polling only runs on session switch,
  // not continuously. Alternative: Add a Jotai atom for draft changes.
  React.useEffect(() => {
    let attempts = 0
    const maxAttempts = 10
    const interval = setInterval(() => {
      const currentDraft = coerceInputText(getDraft(sessionId))
      if (currentDraft !== inputValueRef.current && currentDraft !== '') {
        setInputValue(currentDraft)
        setPromptFromExternalLink(getDraftPromptOrigin(sessionId) === 'external-link')
        clearInterval(interval)
      }
      attempts++
      if (attempts >= maxAttempts) {
        clearInterval(interval)
      }
    }, 50)

    return () => clearInterval(interval)
  }, [sessionId, getDraft, getDraftPromptOrigin])

  const handleInputChange = React.useCallback((value: string) => {
    const nextText = coerceInputText(value)
    setInputValue(nextText)
    inputValueRef.current = nextText
    // Sending and clearing both empty the composer, and both retire the notice.
    // Editing does not: the warning outlives a keystroke, as documented.
    if (!nextText) setPromptFromExternalLink(false)
    onInputChange(sessionId, nextText)
  }, [sessionId, onInputChange])

  // Attachments draft state — hydrated async from persisted refs on session switch.
  // `[]` is the safe default while hydration is in flight; FreeFormInput seeds its
  // local state from this prop and swaps in the restored list when ready.
  const [attachmentsValue, setAttachmentsValue] = React.useState<import('../../shared/types').FileAttachment[]>([])

  React.useEffect(() => {
    let cancelled = false
    setAttachmentsValue([])
    hydrateDraftAttachments(sessionId).then((atts) => {
      if (!cancelled) setAttachmentsValue(atts)
    })
    return () => { cancelled = true }
  }, [sessionId, hydrateDraftAttachments])

  const handleAttachmentsChange = React.useCallback((attachments: import('../../shared/types').FileAttachment[]) => {
    setAttachmentsValue(attachments)
    onAttachmentsChange(sessionId, attachments)
  }, [sessionId, onAttachmentsChange])

  // Session model change handler - persists per-session model and connection
  const handleModelChange = React.useCallback((model: string, connection?: string) => {
    if (!activeWorkspaceId) return
    window.electronAPI.setSessionModel(sessionId, activeWorkspaceId, model, connection).catch((error: unknown) => {
      // A refusal the user cannot explain becomes "the app broke". The picker is
      // the surface `model-config.md:165` rejects at, so it is the surface that
      // has to say why. Branch on the wire CODE, never the class — the transport
      // rebuilds a plain Error on this side.
      const code = (error as { code?: unknown } | null)?.code
      if (code === 'MODEL_RESTRICTED_BY_POLICY') {
        toast.warning(t('chat.modelPicker.restrictedByPolicy'), {
          description: t('chat.modelPicker.restrictedByPolicyDesc', { model }),
        })
        return
      }
      console.error('Failed to change model:', error)
    })
  }, [sessionId, activeWorkspaceId, t])

  // P3 · what a switch to this connection WOULD carry, asked before the
  // confirmation dialog opens.
  //
  // Read-only and refusal-free by construction (`previewRuntimeSwitch`), so a
  // failure here is not worth a toast: the dialog just opens without its "what
  // will cross" line, which is the modal as it stood before this existed. The
  // real switch below reports its own refusals with their own codes.
  const handlePreviewConnectionChange = React.useCallback(async (connectionSlug: string) => {
    try {
      const result = await window.electronAPI.sessionCommand(sessionId, {
        type: 'previewRuntimeSwitch',
        connectionSlug,
      })
      // P3.266 · the PLAN and its REASON, together. The reason has always been
      // decided beside the plan (`planHistoryCarry`) and read by nothing, so a
      // switch that fell back to the text tail shortened the conversation and
      // said why to no one. Both fields are read leniently: a server that
      // predates either omits it and the dialog renders the line it can.
      if (!result || !('historyCarry' in result)) return null
      return {
        historyCarry: result.historyCarry ?? null,
        historyCarryReason: 'historyCarryReason' in result ? result.historyCarryReason ?? null : null,
      }
    } catch {
      return null
    }
  }, [sessionId])

  // Session connection change handler. A session can now move at any idle
  // moment, so the two refusals that remain are worth telling the user about:
  // a turn in flight, and a connection that cannot host this session. A
  // `console.error` was serviceable while the only failure was "you already
  // started" — the picker itself made that unreachable — and is not now.
  const handleConnectionChange = React.useCallback(async (connectionSlug: string) => {
    try {
      const result = await window.electronAPI.sessionCommand(sessionId, { type: 'switchRuntime', connectionSlug })
      // The post-switch summary. The confirmation dialog runs BEFORE the switch
      // and is computed entirely in the renderer from the two connection
      // records, so it structurally cannot show anything the server only learns
      // while switching — this is where those facts land instead.
      const dropped = result && 'droppedAttachments' in result ? result.droppedAttachments : undefined
      if (dropped?.length) {
        const target = llmConnections.find(c => c.slug === connectionSlug)
        toast.warning(t('chat.runtimeSwitch.droppedAttachments', {
          connection: target?.name ?? connectionSlug,
          names: dropped.join(', '),
        }))
      }
      // T3 · a switch now KEEPS the model whenever the target can serve it, and
      // the three gateway cards share one catalogue, so most switches keep it
      // silently. This is the other half of that: when the target cannot serve
      // it, the session lands on a different model and nothing else on screen
      // would say so. Named both ends, because "your model changed" without the
      // two names is not actionable.
      const previousModel = result && 'previousModel' in result ? result.previousModel : undefined
      const landedModel = result && 'model' in result ? result.model : undefined
      // Both ends required: the copy names them, and a target that ends up on
      // no model at all has no second end to name.
      if (previousModel && landedModel && previousModel !== landedModel) {
        const target = llmConnections.find(c => c.slug === connectionSlug)
        toast.warning(t('chat.runtimeSwitch.modelReset', {
          connection: target?.name ?? connectionSlug,
          from: previousModel,
          to: landedModel,
        }))
      }
      const stopped = result && 'stoppedChildren' in result ? result.stoppedChildren : undefined
      if (stopped?.length) {
        toast.warning(t('chat.runtimeSwitch.stoppedChildren', {
          count: stopped.length,
          names: stopped.join(', '),
        }))
      }
      // P6.113 — the background COMMANDS the same drain killed, beside the
      // children it stopped. Its own toast rather than a line appended to the
      // one above: they are two different losses, and a session can hold either
      // without the other.
      const stoppedShells = result && 'stoppedBackgroundShells' in result
        ? result.stoppedBackgroundShells
        : undefined
      if (stoppedShells?.length) {
        toast.warning(t('chat.runtimeSwitch.stoppedBackgroundShells', {
          count: stoppedShells.length,
          names: stoppedShells.join(', '),
        }))
      }
      // The capability layer's inventory survives a switch unchanged, so a
      // plugin's card keeps saying "enabled" while its peripherals are gone.
      // This is the only place that says otherwise.
      const delta = result && 'capabilityDelta' in result ? result.capabilityDelta : undefined
      if (delta) {
        const lines = [
          delta.stoppedMonitors.length
            ? t('chat.runtimeSwitch.capabilityMonitors', { names: delta.stoppedMonitors.join(', ') })
            : null,
          delta.lostLsp.length
            ? t('chat.runtimeSwitch.capabilityLsp', { names: delta.lostLsp.join(', ') })
            : null,
          delta.inertHookKinds.length
            ? t('chat.runtimeSwitch.capabilityHooks', { kinds: delta.inertHookKinds.join(', ') })
            : null,
          // P3.350 — the EVENT, not the action kind. A `command` hook keeps its
          // runner everywhere, so a control registered on a moment the target
          // never reaches simply stops, and the line above cannot say it.
          delta.inertHookEvents.length
            ? t('chat.runtimeSwitch.capabilityHookEvents', { events: delta.inertHookEvents.join(', ') })
            : null,
          // P6.14's honesty half, carried through: where the target hooks the
          // moment itself, what stopped is our projection into its config.
          // Never rendered without the line above — it qualifies that list.
          delta.inertHookEvents.length && delta.nativeHookEventRoutes.length
            ? t('chat.runtimeSwitch.capabilityHookEventsNative', { events: delta.nativeHookEventRoutes.join(', ') })
            : null,
          // P3.340 — the one host-side pair with no catalogue row of its own.
          delta.hostEditToolingLost
            ? t('chat.runtimeSwitch.capabilityEditTooling')
            : null,
        ].filter((line): line is string => line !== null)
        if (lines.length) {
          toast.warning(t('chat.runtimeSwitch.capabilityDelta'), { description: lines.join('\n') })
        }
      }
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      const key = code === 'SESSION_BUSY' ? 'chat.runtimeSwitch.busy'
        : code === 'WORKTREE_DIRTY' ? 'chat.runtimeSwitch.worktreeDirty'
        : code === 'WORKTREE_EXIT_UNAVAILABLE' ? 'chat.runtimeSwitch.worktreeExitUnavailable'
        : 'chat.runtimeSwitch.failed'
      // A failed disposal crosses the RPC as HANDLER_ERROR, but its message
      // names the runtime that did not shut down (sessionDisposalFailureMessage
      // on the server). Nothing is lost in that case — the switch is refused
      // and the session stays whole — so say that instead of a bare failure.
      const message = (error as { message?: unknown } | null)?.message
      const disposal = key === 'chat.runtimeSwitch.failed' && typeof message === 'string'
        ? /^([a-z][a-z-]*)-session-disposal-failed$/.exec(message)
        : null
      if (disposal) {
        toast.warning(t('chat.runtimeSwitch.failed'), {
          description: t('chat.runtimeSwitch.failedDisposal', { runtime: disposal[1] }),
        })
      } else {
        toast.warning(t(key))
      }
    }
  }, [sessionId, llmConnections, t])

  // Check if session's locked connection has been removed
  const connectionUnavailable = React.useMemo(() =>
    isSessionConnectionUnavailable(session?.llmConnection, llmConnections),
    [session?.llmConnection, llmConnections]
  )

  // Effective model for this session (session-specific or global fallback)
  const effectiveModel = React.useMemo(() => {
    if (session?.model) return session.model

    // When connection is unavailable, don't resolve through a different connection
    if (connectionUnavailable) return session?.model ?? ''

    const connectionSlug = resolveEffectiveConnectionSlug(
      session?.llmConnection, workspaceDefaultLlmConnection, llmConnections
    )
    const connection = connectionSlug ? llmConnections.find(c => c.slug === connectionSlug) : null

    return connection?.defaultModel ?? ''
  }, [session?.id, session?.model, session?.llmConnection, workspaceDefaultLlmConnection, llmConnections, connectionUnavailable])

  // Working directory for this session
  const workingDirectory = session?.workingDirectory
  const [pendingProjectTrust, setPendingProjectTrust] = React.useState<PendingProjectTrust | null>(null)
  const projectTrustPrompt = projectTrustPromptFor(pendingProjectTrust, sessionId) // F1.974: this chat's only
  const applySessionProject = React.useCallback(async (project: IssuedProjectHandle | null, target: ProjectTrustSession | null = session) => {
    if (!target) return
    const updated = await window.electronAPI.setSessionProject({
      session: { sessionId: target.id, workspaceId: target.workspaceId },
      projectHandleId: project?.id ?? null,
    })
    updateSession(target.id, () => updated)
  }, [session, updateSession])

  const handleWorkingDirectoryChange = React.useCallback((project: IssuedProjectHandle) => {
    if (project.trustState === 'unknown') {
      if (session) setPendingProjectTrust({ session, project })
      return
    }
    void applySessionProject(project)
  }, [applySessionProject, session])

  const handleResetToSession = React.useCallback(() => {
    void applySessionProject(null)
  }, [applySessionProject])

  const handleProjectTrustDecision = React.useCallback((project: IssuedProjectHandle) => {
    void applySessionProject(project, pendingProjectTrust?.session ?? null) // the chat that RAISED it (F1.974)
  }, [applySessionProject, pendingProjectTrust])

  // "The prompt reappears on each launch" (glossary.md:231): a restored
  // session whose project resolves trustState 'unknown' re-prompts through the
  // same ProjectTrustDialog the directory-pick callback opens. The home
  // directory's trust is process-only, so after a relaunch it resolves
  // 'unknown' again and this is the leg that brings the prompt back. Fail-soft,
  // and D1.223's "ask only where there is something to trust" both live in
  // `lib/project-trust-gate.ts` now, where a test can drive them (`bun test` has
  // no DOM in this repo, so an effect body in this file is unreachable).
  // D1.363 — the check is claimed per (session, DIRECTORY) pair rather than per
  // session. Keyed on the session alone, the FIRST directory a view saw consumed
  // the one check — including one that resolved to "nothing to ask about", or
  // that failed into the fail-soft catch — and no later project bound to that
  // same session ever raised the prompt again. Measure sitting 5e read that from
  // outside as a profile going quiet after a cancelled modal; Cancel persists
  // nothing, and this guard was the silence. The pair keeps the invariant the
  // session key was written for: a re-render of the same pair asks nothing.
  const checkedProjectTrustRef = React.useRef<string | null>(null)
  const sessionWorkspaceId = session?.workspaceId
  React.useEffect(() => {
    if (!workingDirectory || !sessionWorkspaceId) return
    if (!claimProjectTrustCheck(checkedProjectTrustRef, sessionId, workingDirectory)) return
    let cancelled = false
    const raisedFor = { id: sessionId, workspaceId: sessionWorkspaceId } // F1.974: the prompt's own chat
    void resolveProjectTrustPrompt(
      {
        validateProjectDirectory: (input) => window.electronAPI.validateProjectDirectory(input),
        detectProjectContributions: (input) =>
          window.electronAPI.capabilities.detectProjectContributions(input, { runtimeSessionId: sessionId }), // F1.1133: this chat's runtime decides the Pi language-server question
      },
      { workspaceId: sessionWorkspaceId, workingDirectory },
    ).then((project) => {
      if (!cancelled && project) setPendingProjectTrust((prev) => offerProjectTrustPrompt(prev, { session: raisedFor, project }))
    })
    return () => { cancelled = true }
  }, [sessionId, sessionWorkspaceId, workingDirectory])

  const handleOpenFile = React.useCallback(
    async (path: string) => {
      // Resolve bare relative paths only against the explicit external project.
      const resolved = (() => {
        // Absolute paths (POSIX `/…`, Windows `C:\…`) and `~/…` are used as-is.
        // The cross-platform check fixes Windows preview failures where a
        // `C:\…` path was wrongly treated as relative and re-prefixed with the
        // workspace root, producing a doubled, non-existent path (#922/#875).
        if (isAbsolutePath(path) || path.startsWith('~/')) return path

        const baseDir = workingDirectory
        if (!baseDir) return path

        const cleanedBase = baseDir.replace(/\/+$/, '')
        const cleanedPath = path.replace(/^\.\//, '')
        return `${cleanedBase}/${cleanedPath}`
      })()

      // Smart fallback for missing files in AI output:
      // if the exact path doesn't exist, search nearby for same basename
      // (e.g. markdown/linkify.test.ts -> markdown/__tests__/linkify.test.ts).
      if (isAbsolutePath(resolved)) {
        // Backslash-aware so the fallback also runs for `C:\…` paths (#922)
        const lastSlash = Math.max(resolved.lastIndexOf('/'), resolved.lastIndexOf('\\'))
        if (lastSlash > 0 && lastSlash < resolved.length - 1) {
          const parentDir = resolved.slice(0, lastSlash)
          const fileName = resolved.slice(lastSlash + 1)
          try {
            const matches = await window.electronAPI.searchFiles(parentDir, fileName)
            const files = matches.filter((m) => m.type === 'file' && m.name === fileName)
            const exact = files.find((m) => m.path === resolved)
            if (exact) {
              onOpenFile(exact.path)
              return
            }

            if (files.length === 1) {
              onOpenFile(files[0].path)
              toast.info(t('chat.openedClosestMatch', { path: files[0].relativePath }))
              return
            }
          } catch {
            // Search fallback is best-effort; proceed with original resolved path.
          }
        }
      }

      onOpenFile(resolved)
    },
    [onOpenFile, workingDirectory]
  )

  const handleOpenUrl = React.useCallback(
    (url: string) => {
      onOpenUrl(url)
    },
    [onOpenUrl]
  )

  // Perf: Mark when data is ready
  const dataReadyMarkedRef = React.useRef<string | null>(null)
  React.useLayoutEffect(() => {
    if (messageLoadState.messagesReady && session && dataReadyMarkedRef.current !== sessionId) {
      dataReadyMarkedRef.current = sessionId
      rendererPerf.markSessionSwitch(sessionId, 'data.ready')
    }
  }, [sessionId, messageLoadState.messagesReady, session])

  // Perf: Mark render complete after paint
  React.useEffect(() => {
    if (session) {
      const rafId = requestAnimationFrame(() => {
        rendererPerf.endSessionSwitch(sessionId)
      })
      return () => cancelAnimationFrame(rafId)
    }
  }, [sessionId, session])

  // Get display title for header - use getSessionTitle for consistent fallback logic with SessionList
  // Priority: name > first user message > preview > "New chat"
  const displayTitle = session ? getSessionTitle(session) : (sessionMeta ? getSessionTitle(sessionMeta) : t('chat.session'))
  const sharedUrl = RENDERER_CONFIG.sharingEnabled
    ? session?.sharedUrl || sessionMeta?.sharedUrl || null
    : null
  // Use isAsyncOperationOngoing for shimmer effect (sharing, updating share, revoking, title regeneration)
  const isAsyncOperationOngoing = session?.isAsyncOperationOngoing || sessionMeta?.isAsyncOperationOngoing || false

  // Handle missing session - loading or deleted
  if (!session) {
    if (sessionMeta) {
      // Session exists in metadata but not loaded yet - show loading state
      const skeletonSession = {
        id: sessionMeta.id,
        workspaceId: sessionMeta.workspaceId,
        workspaceName: '',
        name: sessionMeta.name,
        preview: sessionMeta.preview,
        lastMessageAt: sessionMeta.lastMessageAt || 0,
        messages: [],
        isProcessing: sessionMeta.isProcessing || false,
        isFlagged: sessionMeta.isFlagged,
        workingDirectory: sessionMeta.workingDirectory,
        enabledSourceSlugs: sessionMeta.enabledSourceSlugs,
      }

      return (
        <div className="h-full flex flex-col">
          <ChatHeader
            sessionId={sessionId}
            item={sessionMeta}
            title={displayTitle}
            isRegeneratingTitle={isAsyncOperationOngoing}
            sharedUrl={sharedUrl}
            workingDirectory={sessionMeta.workingDirectory}
            sharingEnabled={RENDERER_CONFIG.sharingEnabled}
          />
          <div className="flex-1 flex flex-col min-h-0">
            <ChatDisplay
              ref={chatDisplayRef}
              session={skeletonSession}
              onSendMessage={() => {}}
              onOpenFile={handleOpenFile}
              onOpenUrl={handleOpenUrl}
              currentModel={effectiveModel}
              onModelChange={handleModelChange}
              onConnectionChange={handleConnectionChange}
              onPreviewConnectionChange={handlePreviewConnectionChange}
              pendingPermission={undefined}
              onRespondToPermission={onRespondToPermission}
              pendingCredential={undefined}
              onRespondToCredential={onRespondToCredential}
              thinkingLevel={sessionOpts.thinkingLevel}
              onThinkingLevelChange={(level) => setOption('thinkingLevel', level)}
              permissionMode={sessionOpts.permissionMode}
              onPermissionModeChange={setPermissionMode}
              enabledModes={enabledModes}
              inputValue={inputValue}
              onInputChange={handleInputChange}
              promptFromExternalLink={promptFromExternalLink}
              attachmentsValue={attachmentsValue}
              onAttachmentsChange={handleAttachmentsChange}
              sources={enabledSources}
              skills={skills}
              workspaceId={activeWorkspaceId || undefined}
              onSourcesChange={(slugs) => onSessionSourcesChange?.(sessionId, slugs)}
              workingDirectory={sessionMeta.workingDirectory}
              onWorkingDirectoryChange={handleWorkingDirectoryChange}
              onResetToSession={handleResetToSession}
              messagesLoading={messageLoadState.messagesLoading || (messagesRetrying && !messageLoadState.messagesReady)}
              messagesLoadError={messageLoadState.error}
              messagesRetrying={messagesRetrying}
              onRetryMessagesLoad={handleRetryMessagesLoad}
              searchQuery={sessionListSearchQuery}
              isSearchModeActive={isSearchModeActive}
              onMatchInfoChange={onChatMatchInfoChange}
              connectionUnavailable={connectionUnavailable}
              compactMode={!!isCompactMode}
              enableCompactModelPicker={!!isCompactMode}
            />
          </div>
        </div>
      )
    }

    // Session truly doesn't exist
    return (
      <div className="h-full flex flex-col">
        <PanelHeader  title={t('chat.session')} leadingAction={leadingAction} rightSidebarButton={rightSidebarButton} />
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground">
          <AlertCircle className="h-10 w-10" />
          <p className="text-sm">{t('chat.sessionNoLongerExists')}</p>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="h-full flex flex-col">
        <ChatHeader
          sessionId={sessionId}
          item={sessionMeta}
          title={displayTitle}
          isRegeneratingTitle={isAsyncOperationOngoing}
          sharedUrl={sharedUrl}
          workingDirectory={workingDirectory}
          sharingEnabled={RENDERER_CONFIG.sharingEnabled}
        />
        <div className="flex-1 flex flex-col min-h-0">
          {/* UA1.23 — the inline previews' Publish, bound to THIS session (the block's session). */}
          <SessionPublishPlatform sessionId={session.id} workspaceId={session.workspaceId ?? activeWorkspaceId}>
          <ChatDisplay
            ref={chatDisplayRef}
            session={session}
            // P6.424 — the tip below the spinner. Undefined on every install
            // without a managed suggestion allowlist, which is the shipped
            // default, so the indicator is byte-identical there.
            pluginSuggestionTip={session.pluginSuggestionTip}
            onSendMessage={(message, attachments, skillSlugs, customSlashCommandId, midStreamOverride) => {
              if (session) {
                onSendMessage(session.id, message, attachments, skillSlugs, undefined, customSlashCommandId, midStreamOverride)
              }
            }}
            onOpenFile={handleOpenFile}
            onOpenUrl={handleOpenUrl}
            currentModel={effectiveModel}
            onModelChange={handleModelChange}
            onConnectionChange={handleConnectionChange}
            onPreviewConnectionChange={handlePreviewConnectionChange}
            pendingPermission={pendingPermission}
            onRespondToPermission={onRespondToPermission}
            pendingCredential={pendingCredential}
            onRespondToCredential={onRespondToCredential}
            thinkingLevel={sessionOpts.thinkingLevel}
            onThinkingLevelChange={(level) => setOption('thinkingLevel', level)}
            permissionMode={sessionOpts.permissionMode}
            onPermissionModeChange={setPermissionMode}
            enabledModes={enabledModes}
            inputValue={inputValue}
            onInputChange={handleInputChange}
            promptFromExternalLink={promptFromExternalLink}
            attachmentsValue={attachmentsValue}
            onAttachmentsChange={handleAttachmentsChange}
            sources={enabledSources}
            skills={skills}
            labels={labels}
            onLabelsChange={(newLabels) => onSessionLabelsChange?.(sessionId, newLabels)}
            workspaceId={activeWorkspaceId || undefined}
            onSourcesChange={(slugs) => onSessionSourcesChange?.(sessionId, slugs)}
            workingDirectory={workingDirectory}
            onWorkingDirectoryChange={handleWorkingDirectoryChange}
            onResetToSession={handleResetToSession}
            messagesLoading={messageLoadState.messagesLoading || (messagesRetrying && !messageLoadState.messagesReady)}
            messagesLoadError={messageLoadState.error}
            messagesRetrying={messagesRetrying}
            onRetryMessagesLoad={handleRetryMessagesLoad}
            searchQuery={sessionListSearchQuery}
            isSearchModeActive={isSearchModeActive}
            onMatchInfoChange={onChatMatchInfoChange}
            connectionUnavailable={connectionUnavailable}
            compactMode={!!isCompactMode}
            enableCompactModelPicker={!!isCompactMode}
          />
          </SessionPublishPlatform>
        </div>
      </div>
      <ProjectTrustDialog
        open={projectTrustPrompt !== null}
        project={projectTrustPrompt?.project ?? null}
        onClose={() => setPendingProjectTrust((prev) => (prev === projectTrustPrompt ? null : prev))}
        onDecision={handleProjectTrustDecision}
      />
    </>
  )
})

export default ChatPage

// UA1.23 — imported at the end so the docs-cited lines above keep their numbers.
import { SessionPublishPlatform } from '@/components/artifacts/SessionPublishPlatform'
