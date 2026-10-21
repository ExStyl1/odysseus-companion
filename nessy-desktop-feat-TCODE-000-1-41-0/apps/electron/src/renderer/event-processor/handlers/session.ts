/**
 * Session Event Handlers
 *
 * Handles complete, error, sources_changed, etc.
 * Pure functions that return new state - no side effects.
 */

import type {
  SessionState,
  ProcessResult,
  CompleteEvent,
  ErrorEvent,
  TypedErrorEvent,
  SourcesChangedEvent,
  LabelsChangedEvent,
  SessionStatusChangedEvent, SessionMetadataChangedEvent, ProjectIdChangedEvent,
  SessionFlaggedEvent,
  SessionUnflaggedEvent,
  SessionArchivedEvent,
  SessionUnarchivedEvent,
  NameChangedEvent,
  PermissionRequestEvent,
  PermissionRequestCancelledEvent,
  CredentialRequestEvent,
  PlanSubmittedEvent,
  StatusEvent,
  InfoEvent,
  InterruptedEvent,
  TitleGeneratedEvent,
  TitleRegeneratingEvent,
  AsyncOperationEvent,
  WorkingDirectoryChangedEvent,
  PermissionModeChangedEvent,
  SessionModelChangedEvent,
  LLMConnectionChangedEvent,
  CapabilitiesChangedEvent,
  UserMessageEvent,
  MessageAddedEvent,
  MessageAnnotationsUpdatedEvent,
  ConversationRewoundEvent,
  SessionSharedEvent,
  SessionUnsharedEvent,
  AuthRequestEvent, AuthCompletedEvent,
  UsageUpdateEvent,
  PluginSuggestionTipEvent,
  Effect,
} from '../types'
import type { Message } from '../../../shared/types'
import { generateMessageId, appendMessage } from '../helpers'
import { terminalReasonMarker, terminalReasonNoticeKey } from '../../lib/terminal-reason-copy'
import { parseRuntimeSwitchMarker } from '../../components/app-shell/input/runtime-switch-copy'

/**
 * Handle complete - agent loop finished
 *
 * Sets isProcessing: false, clears streaming state (session-level AND the
 * per-message `isStreaming`/`isPending` flags).
 * Also marks any running tools as complete (fail-safe).
 */
export function handleComplete(
  state: SessionState,
  event: CompleteEvent
): ProcessResult {
  const session = clearUnconvertedCompactionStatus(clearRetryStatus(state.session)) // F1.356 — a turn that ends retires its retry rows; UB12.7 — and an unconverted compacting row

  // Fail-safe: mark any non-terminal tools as complete.
  // Catches 'executing' (normal) and 'backgrounded' (spurious — e.g. foreground Agent
  // whose result contained agentId:). Genuinely backgrounded tasks have isBackground=true
  // AND a taskId, so they're excluded — task_completed will finalize them.
  const TERMINAL_TOOL_STATUSES = new Set(['completed', 'error'])
  let updatedMessages = session.messages
  const hasRunningTools = session.messages.some(
    m => m.role === 'tool'
      && !TERMINAL_TOOL_STATUSES.has(m.toolStatus ?? '')
      && !(m.isBackground && m.taskId)  // Don't force-complete genuine background tasks
  )

  if (hasRunningTools) {
    updatedMessages = session.messages.map(m => {
      if (
        m.role === 'tool'
        && !TERMINAL_TOOL_STATUSES.has(m.toolStatus ?? '')
        && !(m.isBackground && m.taskId)
      ) {
        return { ...m, toolStatus: 'completed' as const, toolResult: m.toolResult ?? '' }
      }
      return m
    })
  }

  // Clear isQueued from any user messages once the turn completes. Pi's steer
  // path never emits a 'processing' status update to clear it (the message is
  // injected mid-stream and absorbed into the current response), so this is
  // the natural place to drop the indicator. Claude's queued path has already
  // cleared via the 'processing' status update before this fires; this is
  // a safe no-op for that case.
  const hasQueuedUserBubbles = updatedMessages.some(m => m.role === 'user' && m.isQueued)
  if (hasQueuedUserBubbles) {
    updatedMessages = updatedMessages.map(m =>
      m.role === 'user' && m.isQueued ? { ...m, isQueued: false } : m
    )
  }

  // Fail-safe: clear the transient streaming flags on assistant bubbles, the
  // same pair `handleInterrupted` clears. `text_complete` normally lowers both,
  // so this pass is a no-op on a turn that finished properly; it exists for the
  // bubble that streamed and never got a completion of its own — a refusal, an
  // error, or a turn whose final message arrived under a different per-message
  // identity. Until now only the interrupt path cleared them, so a NORMALLY
  // completed turn could leave a bubble marked live forever, and the state is
  // user-visible: `ChatDisplay` hides the pop-out affordance and keeps the
  // streaming renderer while `isStreaming`, `turn-utils` reads an assistant
  // message carrying `isPending` as a still-RUNNING turn activity and refuses to
  // lower the turn card's own `isStreaming` until both flags are down, and
  // annotations are declined on a streaming message. Both flags therefore have
  // to go, exactly as on the interrupt path — clearing `isStreaming` alone
  // leaves the turn card spinning on `isPending`.
  //
  // Safe for a reason that does NOT depend on the turn being over: this handler
  // ALREADY returns `streaming: null` unconditionally, so the session-level
  // buffer is discarded on every `complete` no matter which site sent it. All
  // this pass does is make the per-message flags agree with a decision the
  // handler had already taken. `text_complete` having flushed the delta batch is
  // the normal case, not a precondition.
  //
  // The argument this comment used to make — "SessionManager emits it only once
  // nothing is queued" — is true of exactly ONE of the seven production emit
  // sites (eight when measured 2026-08-25), and it is load-bearing enough that
  // a future reader would lean on it, so here is the measurement.
  // `onProcessingStopped`'s no-queue branch is the one that fits. Six do not:
  //   - three end the turn while the chat GENERATOR still drains (plan
  //     submission, its adjacent path, the auth request — after
  //     `interruptForHandoff`); the host lowers its flag at each (F1.164). The
  //     fourth, the dp-auth preflight gate, went with C3.381's `bcc1e79c3`;
  //   - two settle a durable approval whose turn died with the PREVIOUS host
  //     process, where nothing is queued only vacuously;
  //   - one is `handlers/rpc/sessions.ts`'s error path, pushed straight to the
  //     client after `sendMessage` threw.
  // So a `complete` can and does arrive mid-turn, and lowering the flags is not
  // free when it does: `handleTextDelta` finds its bubble via
  // `findStreamingMessage`, which matches on `isStreaming`, so a delta that
  // arrives after this pass appends a SECOND bubble instead of extending the
  // first. On the three handoff sites there is no `text_complete` behind it to
  // retire that bubble either, so it claims to be live until a later turn's
  // `complete` heals it. That trade is measured and pinned in
  // `__tests__/late-delta-after-turn-end.test.ts`, and the reason it is
  // acceptable is that P3.16 closed it AT THE EMITTER — `SessionManager` flushes
  // its 50 ms delta batch before every renderer-facing `complete`/`interrupted`.
  // Which is the honest shape of the justification: not "nothing is queued", but
  // "the buffer is dropped here regardless, and the queue is drained upstream".
  const hasLiveAssistantBubbles = updatedMessages.some(
    m => m.role === 'assistant' && (m.isStreaming || m.isPending)
  )
  if (hasLiveAssistantBubbles) {
    updatedMessages = updatedMessages.map(m =>
      m.role === 'assistant' && (m.isStreaming || m.isPending)
        ? { ...m, isStreaming: false, isPending: false }
        : m
    )
  }

  // P2.37 · the turn's terminal VERDICT reaches the transcript.
  //
  // `terminalReason` has ridden the `complete` event since the cap work
  // landed and had no UI consumer anywhere, so a session that stopped because
  // it hit the spending limit looked exactly like a session that just
  // stopped. The row is the `role: 'info'` notice this transcript already uses
  // for host-composed events, and its content is the MACHINE-READABLE marker
  // rather than a sentence — the same split `runtime_switched:` uses, so the
  // line follows the UI language instead of freezing in the one that happened
  // to be active when the turn ended (`lib/terminal-reason-copy.ts`).
  //
  // Only the five reasons that HAVE copy produce a row; every other ending
  // already owns a louder surface (see the map's comment). `terminalIsError`
  // picks the tone and nothing else: a cap is a `warning`, a provider blow-up
  // an `error`.
  //
  // Appended AFTER the two fail-safe passes above so it sorts after the turn's
  // own messages. A verdict is NOT an interruption: `groupMessagesByTurn`
  // recognises a `terminal_reason:` info row and flushes the open turn
  // non-interrupted, so the turn's last intermediate text still promotes to a
  // response bubble (P2.37 fix in `turn-utils.ts`). Every OTHER info row still
  // flushes the turn as interrupted, which is why the distinction had to be
  // taught to the grouper rather than assumed here.
  const terminalReason = event.terminalReason
  if (terminalReason && terminalReasonNoticeKey(terminalReason)) {
    const verdict: Message = {
      id: generateMessageId(),
      role: 'info',
      infoLevel: event.terminalIsError ? 'error' : 'warning',
      content: terminalReasonMarker(terminalReason),
      timestamp: Date.now(),
    }
    updatedMessages = [...updatedMessages, verdict]
  }

  return {
    state: {
      session: {
        ...session,
        messages: updatedMessages,
        isProcessing: false,
        currentStatus: undefined,  // Clear any lingering status
        // Update tokenUsage from complete event (for real-time context counter updates)
        tokenUsage: event.tokenUsage ?? session.tokenUsage,
        contextUsage: event.contextUsage ?? event.tokenUsage?.contextUsage ?? session.contextUsage,
        // Update hasUnread flag from main process (state machine for NEW badge)
        // Only update if explicitly provided - undefined means "don't change"
        ...(event.hasUnread !== undefined && { hasUnread: event.hasUnread }),
      },
      streaming: null,
    },
    effects: [],
  }
}

/**
 * Handle error - simple error event
 */
export function handleError(
  state: SessionState,
  event: ErrorEvent
): ProcessResult {
  const session = clearUnconvertedCompactionStatus(clearRetryStatus(state.session)) // F1.356; UB12.7

  // Fail-safe: Mark any running tools as failed
  const messagesWithFailedTools = session.messages.map(m =>
    m.role === 'tool' && m.toolResult === undefined && m.toolStatus !== 'completed' && m.toolStatus !== 'error'
      ? { ...m, toolStatus: 'error' as const, toolResult: 'Error occurred', isError: true }
      : m
  )

  const errorMessage: Message = {
    id: generateMessageId(),
    role: 'error',
    content: event.error,
    timestamp: event.timestamp ?? Date.now(),
  }

  return {
    state: {
      session: {
        ...session,
        messages: [...messagesWithFailedTools, errorMessage],
        isProcessing: false,
        currentStatus: undefined,  // Clear any lingering status
      },
      streaming: null,
    },
    effects: [],
  }
}

/**
 * Handle typed_error - error with structured details
 */
export function handleTypedError(
  state: SessionState,
  event: TypedErrorEvent
): ProcessResult {
  const session = clearUnconvertedCompactionStatus(clearRetryStatus(state.session)) // F1.356; UB12.7

  // Fail-safe: Mark any running tools as failed
  const messagesWithFailedTools = session.messages.map(m =>
    m.role === 'tool' && m.toolResult === undefined && m.toolStatus !== 'completed' && m.toolStatus !== 'error'
      ? { ...m, toolStatus: 'error' as const, toolResult: 'Error occurred', isError: true }
      : m
  )

  const errorMessage: Message = {
    id: generateMessageId(),
    role: 'error',
    content: event.error.title
      ? `${event.error.title}: ${event.error.message}`
      : event.error.message,
    timestamp: event.timestamp ?? Date.now(),
    errorCode: event.error.code,
    errorTitle: event.error.title,
    errorDetails: event.error.details,
    errorOriginal: event.error.originalError,
    errorCanRetry: event.error.canRetry,
    // D1.283 — `command` is mapped too. It used to be dropped here while the
    // wire type declared it one interface away, so an action carrying only a
    // command (`token_expired`'s *Open workspace menu*) arrived as a label and
    // nothing else, and no diagnostic anywhere could name what was missing.
    errorActions: event.error.actions?.map(a => ({
      key: a.key,
      label: a.label,
      command: a.command,
      action: a.action,
      url: a.url,
    })),
  }

  return {
    state: {
      session: {
        ...session,
        messages: [...messagesWithFailedTools, errorMessage],
        isProcessing: false,
        currentStatus: undefined,  // Clear any lingering status
      },
      streaming: null,
    },
    effects: [],
  }
}

/**
 * Handle status - status message (e.g., compacting)
 * Stores on session for ProcessingIndicator AND appends as message for TurnCard activity
 */
export function handleStatus(
  state: SessionState,
  event: StatusEvent
): ProcessResult {
  const { session, streaming } = state

  // A plugin hook's `statusMessage` (hooks.md § Common fields) is "displayed
  // while the hook runs" — a spinner label, not an activity entry. A PreToolUse
  // hook fires on every tool call, so appending one status message per call
  // would bury the transcript. An empty message is the end-of-event clear.
  if (event.statusType === 'hook' || event.statusType === 'runtime_turn' || event.statusType === 'phase') { // F1.524 (2): a label, never a row; F1.1150: a runtime phase too
    return {
      state: {
        session: {
          ...session,
          currentStatus: event.message ? { message: event.message, statusType: 'hook' } : undefined,
        },
        streaming,
      },
      effects: [],
    }
  }

  const statusMessage: Message = {
    id: generateMessageId(),
    role: 'status',
    content: event.message,
    timestamp: event.timestamp ?? Date.now(),
    statusType: event.statusType, ...(event.retry?.kind === 'succeeded' ? { infoLevel: 'success' as const } : {}), // F1.477 (P5): the run's success line is finished, not running
  }

  const updatedSession = appendMessage(withoutSupersededRetryRows(session, event), statusMessage)

  return {
    state: {
      session: {
        ...updatedSession,
        // Also store on session for ProcessingIndicator
        currentStatus: {
          message: event.message,
          statusType: event.statusType,
          // P6.916 — the retry's facts ride to the chip as fields; the message
          // stays the transcript entry appended above.
          ...(event.retry ? { retry: event.retry } : {}),
        },
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle info - info message (may update existing compacting message)
 */
export function handleInfo(
  state: SessionState,
  event: InfoEvent
): ProcessResult {
  const { session, streaming } = state

  // If this is a compaction complete, update the existing compacting message and clear currentStatus
  if (event.statusType === 'compaction_complete') {
    const updatedMessages = session.messages.map(m =>
      m.role === 'status' && m.statusType === 'compacting'
        ? { ...m, role: 'info' as const, content: event.message, statusType: 'compaction_complete' as const, infoLevel: event.level }
        : m
    )
    return {
      state: {
        session: {
          ...session,
          messages: withCompactionBoundary(session, updatedMessages, event), // F1.931 — kept even with no compacting row to convert
          currentStatus: undefined,  // Clear status from ProcessingIndicator
        },
        streaming,
      },
      effects: [],
    }
  }

  // Otherwise, add as new info message
  const infoMessage: Message = {
    id: generateMessageId(),
    role: 'info',
    content: event.message,
    timestamp: event.timestamp ?? Date.now(),
    infoLevel: event.level,
  }

  return {
    state: {
      session: appendMessage(session, infoMessage),
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle interrupted - agent was interrupted.
 *
 * Two distinct shapes:
 * - **User-initiated stop** (`event.message` present): user clicked the Stop
 *   button. We render the "Response interrupted" notice, drop queued user
 *   bubbles, and restore their text to the input field so the user can edit
 *   and re-send.
 * - **Silent redirect** (`event.message` absent): the agent aborted internally
 *   so a new message could be processed. The backend's `processNextQueuedMessage`
 *   will auto-replay queued messages — we must NOT remove the queued bubbles
 *   nor restore them to the input, otherwise the user perceives a silent drop
 *   (#616).
 */
export function handleInterrupted(
  state: SessionState,
  event: InterruptedEvent
): ProcessResult {
  const { session } = state

  // Clear transient streaming state (isPending, isStreaming) and mark running tools as interrupted
  // These fields are not persisted, so this matches the state after a reload
  // Also filter out status messages - they are transient UI state that shouldn't persist after interruption
  const updatedMessages = session.messages
    .filter(m => m.role !== 'status')  // Remove transient status messages
    // Queued bubbles stay visible. The queue surface now owns edit/delete/resume,
    // so interruption must not silently move them back into the draft (#616).
    .map(m => {
      // Mark running tools as interrupted
      if (m.role === 'tool' && m.toolResult === undefined && m.toolStatus !== 'completed' && m.toolStatus !== 'error') {
        // D1.149 — and the SUBAGENT rows inside it, which this map used to walk
        // past. `orchestrationProgress.agents[].status` is what the subagent
        // card and the workflow panel draw, and `aborted` is a member of that
        // union that NOTHING produced: measured 2026-09-18, `'aborted'` over
        // `apps/electron/src/renderer`, `packages/shared/src/agent` and
        // `packages/server-core/src` answers only RENDERERS of it — the card,
        // the panel, `orchestration-activity.ts`, the playground — and not one
        // producer, against `'running'` and `'done'`, which have several in the
        // same corpus. So a card kept the last `running` it was sent, forever:
        // RS-14's "Running Write…" (C3.370's second half) is that, exactly.
        //
        // Renderer-side for the same reason the line above is renderer-side,
        // and this function's own header gives it: these fields are not
        // persisted, so the map's job is to make the view match the state after
        // a reload. A host that emitted a final progress event on every
        // interrupt path of all three runtimes would be the larger shape, and it
        // is not needed for the view to stop lying.
        //
        // D1.253 DECIDED it, and this is the only producer by design: because
        // the field is not persisted, a runtime-emitted final event would reach
        // the live client and still leave this reconstruction owed for every
        // reload — two producers of one fact. The posture and what would reverse
        // it are on the union itself (`packages/core/src/orchestration.ts`,
        // `OrchestrationAgentStatus`), which is where the next reader meets
        // `aborted` and asks who sends it.
        const progress = m.orchestrationProgress
        const stale = progress?.agents.some(agent => agent.status === 'queued' || agent.status === 'running')
        return {
          ...m,
          toolStatus: 'error' as const,
          toolResult: 'Interrupted',
          isError: true,
          ...(progress && stale
            ? {
                orchestrationProgress: {
                  ...progress,
                  agents: progress.agents.map(agent =>
                    agent.status === 'queued' || agent.status === 'running'
                      // `aborted` and not `error`: the run was stopped, it did
                      // not fail, and the card draws the two differently.
                      ? { ...agent, status: 'aborted' as const }
                      : agent),
                },
              }
            : {}),
        }
      }
      // Clear pending state on assistant messages (transient streaming state)
      if (m.role === 'assistant' && m.isPending) {
        return { ...m, isPending: false, isStreaming: false }
      }
      return m
    })

  // Only add the "Response interrupted" message if provided (not a silent redirect)
  const messages = event.message
    ? [...updatedMessages, event.message]
    : updatedMessages

  return {
    state: {
      session: {
        ...session,
        isProcessing: false,
        messages,
        currentStatus: undefined,  // Clear any lingering status
      },
      streaming: null,
    },
    effects: [],
  }
}

/**
 * Handle title_generated - update session title and clear regenerating state
 */
export function handleTitleGenerated(
  state: SessionState,
  event: TitleGeneratedEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: {
        ...session,
        name: event.title,
        // Clear regenerating state - title generation completed
        isRegeneratingTitle: false,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle title_regenerating - set regenerating state for shimmer effect
 * @deprecated Use handleAsyncOperation instead
 */
export function handleTitleRegenerating(
  state: SessionState,
  event: TitleRegeneratingEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: {
        ...session,
        isRegeneratingTitle: event.isRegenerating,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle async_operation - set async operation state for shimmer effect
 * Generic handler for any async operation (sharing, updating share, revoking, title regeneration)
 */
export function handleAsyncOperation(
  state: SessionState,
  event: AsyncOperationEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: {
        ...session,
        isAsyncOperationOngoing: event.isOngoing,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle working_directory_changed - update session working directory (user-initiated via UI)
 */
export function handleWorkingDirectoryChanged(
  state: SessionState,
  event: WorkingDirectoryChangedEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: { ...session, workingDirectory: event.workingDirectory },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle permission_mode_changed - return effect for parent to handle session options
 */
export function handlePermissionModeChanged(
  state: SessionState,
  event: PermissionModeChangedEvent
): ProcessResult {
  return {
    state,
    effects: [{
      type: 'permission_mode_changed',
      sessionId: event.sessionId,
      permissionMode: event.permissionMode,
      previousPermissionMode: event.previousPermissionMode,
      transitionDisplay: event.transitionDisplay,
      modeVersion: event.modeVersion,
      changedAt: event.changedAt,
      changedBy: event.changedBy,
    }],
  }
}

/**
 * Handle session_model_changed - update session model
 */
export function handleSessionModelChanged(
  state: SessionState,
  event: SessionModelChangedEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: { ...session, model: event.model ?? undefined },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle connection_changed - sync session.llmConnection to renderer state
 */
export function handleConnectionChanged(
  state: SessionState,
  event: LLMConnectionChangedEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: {
        ...session,
        llmConnection: event.connectionSlug,
        ...(event.supportsBranching !== undefined && { supportsBranching: event.supportsBranching }),
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle capabilities_changed - sync composer capabilities to renderer state
 */
export function handleCapabilitiesChanged(
  state: SessionState,
  event: CapabilitiesChangedEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: { ...session, composerCapabilities: event.capabilities },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle user_message - confirms optimistic user message from backend
 *
 * Three statuses:
 * - 'accepted': Message is being processed (confirms optimistic message)
 * - 'queued': Message was queued during ongoing response (adds if not present, marks as queued)
 * - 'processing': Queued message is now being processed (updates status)
 */
export function handleUserMessage(
  state: SessionState,
  event: UserMessageEvent
): ProcessResult {
  const { session, streaming } = state
  const { message, status } = event

  // Find existing message by ID match (backend ID, optimistic ID, or content+timestamp fallback)
  const existingIndex = session.messages.findIndex(m =>
    m.role === 'user' && (
      m.id === message.id ||
      (event.optimisticMessageId && m.id === event.optimisticMessageId) ||
      (m.content === message.content && Math.abs(m.timestamp - message.timestamp) < 5000)
    )
  )

  let updatedMessages: Message[]

  if (existingIndex >= 0) {
    const existingMessage = session.messages[existingIndex]

    // Event sequence protection: don't regress from 'processing' back to 'queued'
    // This handles out-of-order events (e.g., 'processing' arrives before 'queued')
    if (status === 'queued' && existingMessage.isQueued === false && event.requeued !== true) { // F1.333 — a host re-queue is no late echo
      // Already progressed past queued state, ignore this late 'queued' event
      return { state, effects: [] }
    }

    // Update existing message — clear isPending, set isQueued based on status.
    //
    // - 'queued'     → isQueued = true  (Claude path: backend queued for re-send)
    // - 'processing' → isQueued = false (queued message is now actually running)
    // - 'accepted'   → isQueued = false (Pi steer path: agent has the message)
    //
    // We deliberately do NOT swap `m.id` to the backend's canonical id here.
    // ChatDisplay's `getTurnKey` keys user-message bubbles by id, and a swap
    // would unmount/remount the UserMessageBubble — wiping its local timer
    // state and dropping the queued chip mid-flight.
    //
    // C3.384 — that decision stands and the sentence that used to follow it did
    // not. It said the canonical backend id is irrelevant to subsequent events
    // because they all route on `event.optimisticMessageId`. True of EVENTS,
    // false of every server call that ADDRESSES a message by id:
    // `SessionManager.rewindToMessage` looks the anchor up in
    // `managed.messages`, where only the canonical id exists, and answers
    // `Message not found` for the optimistic one. R7 measured exactly that
    // string on the packaged 1.36.0 (C5.2 / RS-05), plus the missing
    // "Rewind and restore files" action — one cause, because the menu also
    // compares the anchor against server-minted ids from `rewindTrackedChanges`.
    //
    // So the canonical id is KEPT BESIDE the optimistic one rather than swapped
    // onto it: render by `id`, address the server by `serverId ?? id`. Recorded
    // only when the two differ, so a row that needs no translation carries no field and the fallback stays exact.
    const steered = status === 'accepted' && existingMessage.isQueued === true // F1.732 — `accepted` for the optimistic MID-STREAM send is a steer
    updatedMessages = session.messages.map((m, i) => {
      if (i === existingIndex) { const { steered: _wasSteered, ...unmarked } = m // F1.732 — the mark is re-decided on every status
        return {
          ...unmarked,
          isPending: false, ...(status === 'processing' ? { timestamp: message.timestamp } : {}), // F1.349 — the host's replay re-stamp
          isQueued: status === 'queued', ...(steered ? { steered: true as const } : {}),
          ...(message.id && message.id !== m.id ? { serverId: message.id } : {}),
        }
      }
      return m
    })
  } else {
    // Message not found (e.g., queued message from backend) - add it; F1.732 — `accepted` into a running turn is a steer too
    const newMessage: Message = {
      ...message,
      isPending: false,
      isQueued: status === 'queued', ...(status === 'accepted' && session.isProcessing === true ? { steered: true as const } : {}),
    }
    updatedMessages = [...session.messages, newMessage]
  }

  return {
    state: {
      session: {
        ...session,
        messages: updatedMessages,
        lastMessageAt: Date.now(),
        lastMessageRole: 'user',  // Clear plan badge when user responds
        // D1.376 — accepted|queued|processing ALL mean a turn is in flight; `queued` lowered this and killed both Stop routes. F1.333 — a REQUEUED 'queued' can follow the turn's end (codex's late refusal), so it never raises it.
        isProcessing: event.requeued === true ? session.isProcessing : true,  // Why, and what it cost: `__tests__/queued-message-keeps-processing.test.ts`.
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle message_annotations_updated - update annotations on a specific message.
 */
export function handleMessageAnnotationsUpdated(
  state: SessionState,
  event: MessageAnnotationsUpdatedEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: {
        ...session,
        messages: session.messages.map(m =>
          m.id === event.messageId
            ? { ...m, annotations: event.annotations }
            : m
        ),
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle conversation_rewound - replace local transcript with server-truncated history.
 */
export function handleConversationRewound(
  state: SessionState,
  event: ConversationRewoundEvent
): ProcessResult {
  const { session } = state

  return {
    state: {
      session: {
        ...session,
        messages: event.messages,
        isProcessing: false,
        lastMessageAt: event.lastMessageAt ?? session.lastMessageAt,
        lastMessageRole: event.lastMessageRole ?? session.lastMessageRole,
        lastFinalMessageId: event.lastFinalMessageId,
      },
      streaming: null,
    },
    effects: [],
  }
}

/**
 * Handle sources_changed - update session's enabled sources
 */
export function handleSourcesChanged(
  state: SessionState,
  event: SourcesChangedEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: {
        ...session,
        enabledSourceSlugs: event.enabledSourceSlugs,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle labels_changed - update session's labels
 */
export function handleLabelsChanged(
  state: SessionState,
  event: LabelsChangedEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: {
        ...session,
        labels: event.labels,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle session_status_changed - update session's sessionStatus (external metadata change or agent tool)
 */
export function handleSessionStatusChanged(
  state: SessionState,
  event: SessionStatusChangedEvent
): ProcessResult {
  const { session, streaming } = state
  return {
    state: {
      session: { ...session, sessionStatus: event.sessionStatus },
      streaming,
    },
    effects: [],
  }
}

/**
 * UA2.1 — Handle session_metadata_changed: merge programmatic metadata changes (the board column; UA3.1 adds
 * the task fields) that do not propagate via the header-signature file watch. Ported from craft-agents-oss
 * v0.13.4 `handleSessionMetadataChanged` (Apache-2.0).
 *
 * NESSY DEVIATION: upstream spreads the changes; here a `null` (the host's clear, which survives the JSON wire
 * where `undefined` does not) or a present `undefined` removes the field, and every other value — `false`
 * included — is a value and is kept (spec §7).
 */
export function handleSessionMetadataChanged(
  state: SessionState,
  event: SessionMetadataChangedEvent
): ProcessResult {
  const { session, streaming } = state
  const next: Record<string, unknown> = { ...session }
  for (const [key, value] of Object.entries(event.changes)) {
    if (value === null || value === undefined) delete next[key]
    else next[key] = value
  }
  return {
    state: {
      session: next as unknown as typeof session,
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle session_flagged - mark session as flagged
 */
export function handleSessionFlagged(
  state: SessionState,
  _event: SessionFlaggedEvent
): ProcessResult {
  const { session, streaming } = state
  return {
    state: {
      session: { ...session, isFlagged: true },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle session_unflagged - mark session as unflagged
 */
export function handleSessionUnflagged(
  state: SessionState,
  _event: SessionUnflaggedEvent
): ProcessResult {
  const { session, streaming } = state
  return {
    state: {
      session: { ...session, isFlagged: false },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle session_archived - mark session as archived
 */
export function handleSessionArchived(
  state: SessionState,
  _event: SessionArchivedEvent
): ProcessResult {
  const { session, streaming } = state
  return {
    state: {
      session: { ...session, isArchived: true, archivedAt: Date.now() },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle session_unarchived - mark session as unarchived
 */
export function handleSessionUnarchived(
  state: SessionState,
  _event: SessionUnarchivedEvent
): ProcessResult {
  const { session, streaming } = state
  return {
    state: {
      session: { ...session, isArchived: false, archivedAt: undefined },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle name_changed - update session name (external metadata change)
 */
export function handleNameChanged(
  state: SessionState,
  event: NameChangedEvent
): ProcessResult {
  const { session, streaming } = state
  return {
    state: {
      session: { ...session, name: event.name },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle permission_request - return effect for parent to handle
 */
export function handlePermissionRequest(
  state: SessionState,
  event: PermissionRequestEvent
): ProcessResult {
  return {
    state,
    effects: [{
      type: 'permission_request',
      request: event.request,
    }]
  }
}

/**
 * Handle permission_request_cancelled - return effect for parent cleanup
 */
export function handlePermissionRequestCancelled(
  state: SessionState,
  event: PermissionRequestCancelledEvent
): ProcessResult {
  return {
    state,
    effects: [{
      type: 'permission_request_cancelled',
      requestId: event.requestId,
    }]
  }
}

/**
 * Handle credential_request - return effect for parent to handle
 */
export function handleCredentialRequest(
  state: SessionState,
  event: CredentialRequestEvent
): ProcessResult {
  return {
    state,
    effects: [{
      type: 'credential_request',
      request: event.request,
    }]
  }
}

/**
 * Handle plan_submitted - add plan message to session
 */
export function handlePlanSubmitted(
  state: SessionState,
  event: PlanSubmittedEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: appendMessage(session, event.message),
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle message_added - append a server-composed transcript row.
 *
 * The `sessionId` guard is deliberate even though `App.tsx` already dispatches
 * per session: this event carries a whole `Message`, so a misrouted one would
 * write a foreign row into the transcript rather than flip a boolean, and the
 * damage would persist through the next reload.
 */
export function handleMessageAdded(
  state: SessionState,
  event: MessageAddedEvent
): ProcessResult {
  const { session, streaming } = state

  if (event.sessionId !== session.id) {
    return { state: { ...state, session: { ...session } }, effects: [] }
  }

  // F1.439 — the `runtime_switched:<from>:<to>` marker row is the host's own
  // record that `clearRuntimeScopedSessionState` just ran (appendRuntimeSwitchNotice
  // follows it). That call clears the snapshot and the window on the HOST; the
  // renderer never mirrored it, so F1.248's window fallback and handleComplete's
  // `?? session.contextUsage` kept the OLD runtime's reading alive. The same
  // three fields are reset here, on the same row; a same-runtime connection
  // change sends no marker and keeps them.
  const switched = event.message.role === 'info'
    && typeof event.message.content === 'string'
    && parseRuntimeSwitchMarker(event.message.content) !== null
  const base = switched ? withoutRuntimeScopedUsage(session) : session

  return {
    state: {
      session: appendMessage(base, event.message),
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle session_shared - session was shared to viewer
 */
export function handleSessionShared(
  state: SessionState,
  event: SessionSharedEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: {
        ...session,
        sharedUrl: event.sharedUrl,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle session_unshared - session share was revoked
 */
export function handleSessionUnshared(
  state: SessionState,
  _event: SessionUnsharedEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: {
        ...session,
        sharedUrl: undefined,
        sharedId: undefined,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle auth_request - add auth-request message to session
 * This is the unified auth flow - execution is paused until auth completes
 */
export function handleAuthRequest(
  state: SessionState,
  event: AuthRequestEvent
): ProcessResult {
  const { session, streaming } = state

  // The event carries the WHOLE request; the message carries only the display
  // identity. A plugin-owned MCP server has no workspace source behind its
  // slug, so a card built from the message alone sent a bare `sourceSlug` and
  // the sign-in died on `Source not found: <server>`. Carry the target across
  // here — the producer already resolved it, and re-deriving it in the card is
  // a second source of truth that can drift.
  const pluginServer = 'pluginServer' in event.request
    ? (event.request as { pluginServer?: { pluginKey: string; serverName: string } }).pluginServer
    : undefined
  const message = pluginServer
    ? { ...event.message, authPluginServer: pluginServer }
    : event.message

  // Add auth-request message to session
  return {
    state: {
      session: {
        ...appendMessage(session, message),
        isProcessing: false,  // Agent execution is paused
      },
      streaming: null,  // Clear any streaming state
    },
    effects: [],
  }
}

/**
 * Handle auth_completed - update auth-request message status
 * The agent will resume via a new user message (sent by session manager)
 */
export function handleAuthCompleted(
  state: SessionState,
  event: AuthCompletedEvent
): ProcessResult {
  const { session, streaming } = state

  // Update the auth-request message status
  const updatedMessages = session.messages.map(m => {
    if (
      m.role === 'auth-request' &&
      m.authRequestId === event.requestId &&
      m.authStatus === 'pending'
    ) {
      return {
        ...m,
        authStatus: event.success
          ? ('completed' as const)
          : event.cancelled
            ? ('cancelled' as const)
            : ('failed' as const),
        authError: event.error,
      }
    }
    return m
  })

  return {
    state: {
      session: {
        ...session,
        messages: updatedMessages,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * P6.424 — remember the spinner tip this session was offered.
 *
 * Stored rather than rendered here: `ChatDisplay` shows it beneath the
 * processing indicator on every turn that follows, and the session sends it
 * once. Nothing else about the session changes, so a client that ignores the
 * event simply never shows the tip.
 */
export function handlePluginSuggestionTip(
  state: SessionState,
  event: PluginSuggestionTipEvent
): ProcessResult {
  return {
    state: {
      ...state,
      session: {
        ...state.session,
        pluginSuggestionTip: { topic: event.topic, reference: event.reference },
      },
    },
    effects: [],
  }
}

/**
 * Handle usage_update - real-time context usage during processing
 * Merges usage update into existing tokenUsage (preserves outputTokens, costUsd, etc.)
 */
export function handleUsageUpdate(
  state: SessionState,
  event: UsageUpdateEvent
): ProcessResult {
  const { session, streaming } = state

  // Merge usage update into existing tokenUsage, providing defaults for required fields
  const contextUsage = event.contextUsage ?? event.tokenUsage.contextUsage
  // F1.248 — a window-less update keeps the known window (upstream v0.13.4's
  // `?? session.tokenUsage?.contextWindow`). The claude adapter sends
  // `cachedContextWindow`, undefined until the first result, and the host
  // forwards the event's window raw, so without this fallback a mid-turn update
  // cleared the denominator the context meter falls back to.
  const contextWindow = event.tokenUsage.contextWindow || session.tokenUsage?.contextWindow
  const inputTokens = typeof event.tokenUsage.inputTokens === 'number'
    ? event.tokenUsage.inputTokens
    : session.tokenUsage?.inputTokens ?? 0

  const updatedTokenUsage = {
    inputTokens,
    outputTokens: session.tokenUsage?.outputTokens ?? 0,
    totalTokens: session.tokenUsage?.totalTokens ?? 0,
    contextTokens: session.tokenUsage?.contextTokens ?? 0,
    costUsd: session.tokenUsage?.costUsd ?? 0,
    ...(session.tokenUsage?.cacheReadTokens !== undefined && { cacheReadTokens: session.tokenUsage.cacheReadTokens }),
    ...(session.tokenUsage?.cacheCreationTokens !== undefined && { cacheCreationTokens: session.tokenUsage.cacheCreationTokens }),
    // F1.1294 — accumulated history like costUsd: /usage's per-model lines read modelUsage, its cost basis costReporting.
    ...(session.tokenUsage?.modelUsage !== undefined && { modelUsage: session.tokenUsage.modelUsage }),
    ...(session.tokenUsage?.costReporting !== undefined && { costReporting: session.tokenUsage.costReporting }),
    ...(contextWindow && { contextWindow }),
    ...(contextUsage && { contextUsage }),
  }

  return {
    state: {
      session: {
        ...session,
        tokenUsage: updatedTokenUsage,
        contextUsage: contextUsage ?? session.contextUsage,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * F1.248 — a retry run is ONE transcript row, not one spinning row per attempt.
 *
 * `retryStatusEvent` (core/types) mints a status per attempt plus a `Retry
 * succeeded` line, all stamped `statusType: 'retrying'` by the host, and
 * `appendMessage` de-duplicates by id only — so every attempt used to stay as
 * its own `running` activity with a spinner that no later attempt or completion
 * replaced (only `handleInterrupted`'s filter or a reload removed them). A
 * `retrying` status now REPLACES a `retrying` row that is the transcript's last
 * message; anything else between two ATTEMPTS — an assistant message, a
 * compacting row — ends the run, and its row stays. The surviving row is the
 * latest line, which is what the chip (`currentStatus`) already shows.
 *
 * F1.437 — the RESOLUTION is not an attempt. Adjacency was only true of
 * claude, which publishes `succeeded` before the first delta. Pi (0.84.4 sends
 * `auto_retry_end{success}` after `message_end`) and codex with reasoning (its
 * reasoning `text_complete` lands before the delta that triggers the success)
 * append the retried answer FIRST, so two spinning attempt rows survived and
 * the last kept announcing a countdown that no longer applied. A `succeeded`
 * status therefore retires every `retrying` row of the CURRENT turn — back to
 * the last user message — and becomes the one row itself.
 */
function withoutSupersededRetryRows(
  session: SessionState['session'],
  event: Pick<StatusEvent, 'statusType' | 'retry'>,
): SessionState['session'] {
  if (event.statusType !== 'retrying') return session
  if (event.retry?.kind === 'succeeded') {
    let turnStart = session.messages.length - 1
    while (turnStart >= 0 && session.messages[turnStart]?.role !== 'user') turnStart--
    const messages = session.messages.filter(
      (m, index) => index <= turnStart || !(m.role === 'status' && m.statusType === 'retrying'),
    )
    return messages.length === session.messages.length ? session : { ...session, messages }
  }
  const last = session.messages[session.messages.length - 1]
  if (last?.role !== 'status' || last.statusType !== 'retrying') return session
  return { ...session, messages: session.messages.slice(0, -1) }
}

/**
 * F1.356 — a turn that ENDS retires its retry rows.
 *
 * `turn-utils` draws every status message as a `running` activity, status rows
 * are not persisted, and `handleComplete` / `handleError` / `handleTypedError`
 * used to clear only `currentStatus` — so the one row a retry run leaves behind
 * (F1.248) kept its TurnCard spinner until an interrupt or a reload. Ported
 * from upstream craft-agents-oss v0.13.4 `clearRetryStatus`
 * (`event-processor/helpers.ts`, Apache-2.0): every `retrying` status row goes,
 * and `currentStatus` too when it is a retry; a compacting row and all history
 * stay here (the turn-end handlers retire an UNCONVERTED compacting row beside
 * it, UB12.7's {@link clearUnconvertedCompactionStatus}).
 */
function clearRetryStatus(session: SessionState['session']): SessionState['session'] {
  const messages = session.messages.filter(m => !(m.role === 'status' && m.statusType === 'retrying'))
  const isRetrying = session.currentStatus?.statusType === 'retrying'
  if (messages.length === session.messages.length && !isRetrying) return session
  return {
    ...session,
    messages,
    ...(isRetrying ? { currentStatus: undefined } : {}),
  }
}

/**
 * UB12.7 — a turn that ENDS retires the `compacting` status row its compaction never converted.
 *
 * A compaction that completes converts its row in `handleInfo` (`compaction_complete`) before its turn's terminal
 * event, so a row still `compacting` at `complete` / `error` / `typed_error` belongs to one that did not: Pi's
 * nothing-to-compact refusal (F1.856, an info) and a failed compaction (an error) after F1.729 announced the manual
 * wait, claude's `compact_result: 'failed'` info, Pi's failed auto-compaction. The row is not persisted, so a reload
 * already dropped it; left live it read as a finished compaction (TurnCard's check), or spun after the error, and the
 * next `compaction_complete` converted it into a second, false "Conversation Compacted" divider (F1.931). Same shape
 * as {@link clearRetryStatus}, which upstream keeps narrow ("without disturbing compaction"): this is ours. A
 * `compaction_complete` that still arrives after the turn end finds no row and is appended (F1.931), so nothing is
 * lost.
 */
function clearUnconvertedCompactionStatus(session: SessionState['session']): SessionState['session'] {
  const messages = session.messages.filter(m => !(m.role === 'status' && m.statusType === 'compacting'))
  return messages.length === session.messages.length ? session : { ...session, messages }
}

/**
 * F1.439 — what the host's `clearRuntimeScopedSessionState` clears, cleared
 * the same way here: the snapshot, and the snapshot and window inside
 * `tokenUsage`. Counters (tokens, cost) are accumulated history and stay.
 */
function withoutRuntimeScopedUsage(session: SessionState['session']): SessionState['session'] {
  if (!session.contextUsage && !session.tokenUsage?.contextUsage && !session.tokenUsage?.contextWindow) return session
  const { contextUsage: _snapshot, ...rest } = session
  if (!session.tokenUsage) return rest
  const { contextUsage: _tokenSnapshot, contextWindow: _window, ...tokenUsage } = session.tokenUsage
  return { ...rest, tokenUsage }
}

/**
 * UA5.3 — handle project_id_changed: update the session's project binding (ported from craft-agents-oss v0.13.4
 * `handleProjectIdChanged`, Apache-2.0). `null` removes the field.
 */
export function handleProjectIdChanged(
  state: SessionState,
  event: ProjectIdChangedEvent
): ProcessResult {
  const { session, streaming } = state
  const next: Record<string, unknown> = { ...session }
  if (event.projectId === null || event.projectId === undefined) delete next.projectId
  else next.projectId = event.projectId
  return {
    state: {
      session: next as unknown as typeof session,
      streaming,
    },
    effects: [],
  }
}

/**
 * F1.931 — the `compaction_complete` info is the BOUNDARY row ChatDisplay draws as the 'Conversation Compacted'
 * divider (and the one the host persists). `handleInfo` converts the session's `compacting` status row into it; with
 * no such row — a runtime that announced nothing (Pi's manual /compact before F1.729), or a row an interrupt already
 * removed — the info used to be dropped, so the live transcript had no boundary at all. It is appended instead.
 */
function withCompactionBoundary(session: SessionState['session'], converted: Message[], event: InfoEvent): Message[] {
  if (session.messages.some(m => m.role === 'status' && m.statusType === 'compacting')) return converted
  return appendMessage(session, {
    id: generateMessageId(),
    role: 'info',
    content: event.message,
    timestamp: event.timestamp ?? Date.now(),
    statusType: 'compaction_complete',
    infoLevel: event.level,
  }).messages
}
