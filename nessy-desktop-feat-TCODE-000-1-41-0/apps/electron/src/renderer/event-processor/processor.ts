/**
 * Event Processor
 *
 * Central pure function that processes all agent events.
 * Guarantees consistent state transitions and always returns new references.
 *
 * Benefits:
 * - Single source of truth for event handling
 * - Pure functions - easy to test
 * - No race conditions - single update path
 * - Always new references - atom sync always works
 * - Message lookup by ID - never position-based
 */

import type { SessionState, AgentEvent, ProcessResult } from './types'
import { handleTextDelta, handleTextComplete, handleTextDiscard } from './handlers/text'
import { handleToolStart, handleToolResult, handleTaskBackgrounded, handleShellBackgrounded, handleTaskProgress, handleTaskCompleted } from './handlers/tool'
import {
  handleComplete,
  handleError,
  handleTypedError,
  handleSourcesChanged,
  handleLabelsChanged,
  handleSessionStatusChanged,
  handleSessionMetadataChanged,
  handleProjectIdChanged,
  handleSessionFlagged,
  handleSessionUnflagged,
  handleSessionArchived,
  handleSessionUnarchived,
  handleNameChanged,
  handlePermissionRequest,
  handlePermissionRequestCancelled,
  handleCredentialRequest,
  handlePlanSubmitted,
  handleStatus,
  handleInfo,
  handleInterrupted,
  handleTitleGenerated,
  handleTitleRegenerating,
  handleAsyncOperation,
  handleWorkingDirectoryChanged,
  handlePermissionModeChanged,
  handleSessionModelChanged,
  handleConnectionChanged,
  handleCapabilitiesChanged,
  handleUserMessage,
  handleMessageAdded,
  handleMessageAnnotationsUpdated,
  handleConversationRewound,
  handleSessionShared,
  handleSessionUnshared,
  handleAuthRequest,
  handleAuthCompleted,
  handleUsageUpdate,
  handlePluginSuggestionTip,
} from './handlers/session'

/**
 * D1.379 — does this event prove a model turn is IN FLIGHT right now?
 *
 * The renderer used to learn that a turn had started from one event only
 * (`user_message`, via `handleUserMessage`), so a client that never saw that
 * event — a window opened mid-turn, a dropped push, a reconnecting client —
 * believed the session idle for the whole turn, and every Stop affordance is
 * gated on that belief. D1.376 was one wrong VALUE on that single writer and it
 * was release-blocking; a missing EVENT has the same reach.
 *
 * The set is deliberately the smallest honest one, read at the EMITTER rather
 * than guessed (`handlers/__tests__/mid-turn-event-raises-processing.test.ts`
 * carries the full argument and pins every boundary):
 *
 *  * `text_delta` and `tool_start` can only be produced by a turn in flight;
 *  * a `status` comes off a running agent's own event stream — EXCEPT
 *    `statusType: 'hook'`, whose single emitter (`hookStatusReporter`, handed to
 *    the plugin hooks automation) also fires for SessionStart/SessionEnd hooks
 *    outside any turn. Raising on that one would put a Stop on an idle session.
 *
 * Nothing else is admitted. Events that legitimately reach an idle session —
 * `usage_update`, `name_changed`, `session_flagged` — are pinned as negative
 * controls in that file, so a later widening to "any event at all" fails.
 */
function impliesTurnInFlight(event: AgentEvent): boolean {
  switch (event.type) {
    case 'text_delta':
    case 'tool_start':
      return true
    case 'status':
      return event.statusType !== 'hook'
    default:
      return false
  }
}

/**
 * F1.164 — is the newest turn boundary in this transcript a HANDOFF to the user?
 *
 * A plan submission and an auth request end the turn by handing control to the
 * user (`SessionManager`'s three `interruptForHandoff` sites). The host lowers
 * its own `managed.isProcessing` there and then lets the aborted chat generator
 * DRAIN: every event it still yields goes through `SessionManager.processEvent`
 * — which does not look at the flag — and reaches this renderer AFTER the turn
 * ended, while the generator's trailing `complete` is skipped because the
 * handoff already sent one. So a drained `text_delta`/`tool_start`/`status`
 * would raise the flag below with nothing left to lower it: a spinner and a
 * Stop on a session the host holds idle. Measured end-to-end, real host → real
 * `processEvent`, in `__tests__/handoff-turn-end-agrees-with-host.test.ts`.
 *
 * The boundary is read from the transcript, newest first, because both handoffs
 * leave a row there before any drained event can arrive: `plan_submitted`
 * appends a `plan` row, `auth_request` appends an `auth-request` row. A `user`
 * row newer than either — the renderer's own optimistic send, or any
 * `user_message` — is the next turn, and the raise applies again. An
 * `auth-request` row stops being a boundary once it is answered
 * (`auth_completed` moves it off `pending`), because the host resumes from there.
 *
 * RESIDUE, stated: a window that misses the `user_message` of the turn right
 * after a plan (D1.379's dropped push, at exactly that point) no longer learns
 * of that turn from its activity. A window OPENED mid-turn is unaffected — its
 * transcript already carries the new user row.
 */
function turnHandedOff(messages: SessionState['session']['messages']): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role === 'user') return false
    if (message.role === 'plan') return true
    if (message.role === 'auth-request' && message.authStatus === 'pending') return true
  }
  return false
}

/**
 * Process an agent event, returning new state and any side effects
 *
 * This is a PURE FUNCTION - no side effects, always returns new state.
 * Guaranteed to return a new session reference (no referential equality issues).
 *
 * D1.379 · after the event is handled, an event that can only occur mid-turn
 * raises `isProcessing`. It is a FLOOR, never an override: a handler that
 * LOWERS the flag on a terminal event still wins, because such an event is not
 * in `impliesTurnInFlight`'s set — so the raise cannot outlive its turn, and the
 * one residue it does inherit (a late delta after `complete`, which the next
 * terminal event heals) is pinned as a stated control rather than hidden.
 *
 * F1.164 · and it never puts back a turn the host HANDED to the user: after a
 * plan submission or a pending auth request, an event the aborted generator
 * still drains leaves the flag where the handoff put it (`turnHandedOff`).
 *
 * @param state - Current session state (session + streaming)
 * @param event - Agent event to process
 * @returns New state and any side effects to execute
 */
export function processEvent(
  state: SessionState,
  event: AgentEvent
): ProcessResult {
  const result = processEventInner(state, event)

  if (
    !impliesTurnInFlight(event)
    || result.state.session.isProcessing === true
    || turnHandedOff(result.state.session.messages)
  ) {
    return result
  }

  return {
    ...result,
    state: {
      ...result.state,
      session: { ...result.state.session, isProcessing: true },
    },
  }
}

/**
 * The event switch itself. Private: every caller goes through `processEvent`,
 * which is where D1.379's mid-turn rule is applied once rather than at each of
 * the ~8 handler return sites that would otherwise have to remember it.
 */
function processEventInner(
  state: SessionState,
  event: AgentEvent
): ProcessResult {
  switch (event.type) {
    case 'text_delta': {
      const newState = handleTextDelta(state, event)
      return { state: newState, effects: [] }
    }

    case 'text_complete': {
      const newState = handleTextComplete(state, event)
      return { state: newState, effects: [] }
    }

    // F1.298 — not in `impliesTurnInFlight`: a discard only ever REMOVES text.
    case 'text_discard':
      return { state: handleTextDiscard(state, event), effects: [] }

    case 'tool_start': {
      const newState = handleToolStart(state, event)
      return { state: newState, effects: [] }
    }

    case 'tool_result': {
      const newState = handleToolResult(state, event)
      return { state: newState, effects: [] }
    }

    case 'task_backgrounded': {
      const newState = handleTaskBackgrounded(state, event)
      return { state: newState, effects: [] }
    }

    case 'shell_backgrounded': {
      const newState = handleShellBackgrounded(state, event)
      return { state: newState, effects: [] }
    }

    case 'task_progress': {
      const newState = handleTaskProgress(state, event)
      return { state: newState, effects: [] }
    }

    case 'task_completed': {
      const newState = handleTaskCompleted(state, event)
      return { state: newState, effects: [] }
    }

    case 'complete':
      return handleComplete(state, event)

    case 'error':
      return handleError(state, event)

    case 'typed_error':
      return handleTypedError(state, event)

    case 'status':
      return handleStatus(state, event)

    case 'info':
      return handleInfo(state, event)

    case 'interrupted':
      return handleInterrupted(state, event)

    case 'title_generated':
      return handleTitleGenerated(state, event)

    case 'title_regenerating':
      return handleTitleRegenerating(state, event)

    case 'async_operation':
      return handleAsyncOperation(state, event)

    case 'working_directory_changed':
      return handleWorkingDirectoryChanged(state, event)

    case 'working_directory_error':
      // No state change — just emit a toast effect
      return {
        state: { ...state, session: { ...state.session } },
        effects: [{ type: 'toast_error', message: event.error }],
      }

    case 'permission_mode_changed':
      return handlePermissionModeChanged(state, event)

    case 'session_model_changed':
      return handleSessionModelChanged(state, event)

    case 'connection_changed':
      return handleConnectionChanged(state, event)

    case 'capabilities_changed':
      return handleCapabilitiesChanged(state, event)

    case 'sources_changed':
      return handleSourcesChanged(state, event)

    case 'labels_changed':
      return handleLabelsChanged(state, event)

    case 'session_status_changed':
      return handleSessionStatusChanged(state, event)

    case 'session_metadata_changed':
      return handleSessionMetadataChanged(state, event)

    case 'project_id_changed':
      return handleProjectIdChanged(state, event)

    case 'session_flagged':
      return handleSessionFlagged(state, event)

    case 'session_unflagged':
      return handleSessionUnflagged(state, event)

    case 'session_archived':
      return handleSessionArchived(state, event)

    case 'session_unarchived':
      return handleSessionUnarchived(state, event)

    case 'name_changed':
      return handleNameChanged(state, event)

    case 'permission_request':
      return handlePermissionRequest(state, event)

    case 'permission_request_cancelled':
      return handlePermissionRequestCancelled(state, event)

    case 'credential_request':
      return handleCredentialRequest(state, event)

    case 'plan_submitted':
      return handlePlanSubmitted(state, event)

    case 'user_message':
      return handleUserMessage(state, event)

    case 'message_added':
      return handleMessageAdded(state, event)

    case 'message_annotations_updated':
      return handleMessageAnnotationsUpdated(state, event)

    case 'conversation_rewound':
      return handleConversationRewound(state, event)

    case 'session_shared':
      return handleSessionShared(state, event)

    case 'session_unshared':
      return handleSessionUnshared(state, event)

    case 'auth_request':
      return handleAuthRequest(state, event)

    case 'auth_completed':
      return handleAuthCompleted(state, event)

    case 'source_activated':
      // Server-side handles the auto-retry now; the renderer
      // just receives the event for UI feedback. See SessionManager.processEvent.
      return { state, effects: [] }

    case 'usage_update':
      return handleUsageUpdate(state, event)

    case 'plugin_suggestion_tip':
      return handlePluginSuggestionTip(state, event)

    default: {
      // Unknown event type - return state unchanged but as new reference
      // to ensure atom sync detects the "change"
      const _exhaustiveCheck: never = event
      return {
        state: { ...state, session: { ...state.session } },
        effects: [],
      }
    }
  }
}
