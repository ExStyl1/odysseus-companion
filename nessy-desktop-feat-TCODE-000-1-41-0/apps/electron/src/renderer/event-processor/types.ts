/**
 * Event Processor Types
 *
 * Defines the state and event types for the centralized event processor.
 * All agent events flow through a single pure function for consistent state transitions.
 */

import type { Session, Message, PermissionRequest, CredentialRequest, TypedError, PermissionMode, SessionStatus, AuthRequest, ToolDisplayMeta, ComposerCapabilities, ContextUsageSnapshot } from '../../shared/types'
import type { OrchestrationProgress } from '@nessy-agent/core'
import type { AgentRetryFacts, AgentTerminalReason } from '@nessy-agent/core/types'
import type { FileCheckpointSkippedPath, SessionEvent } from '@nessy-agent/shared/protocol'

/**
 * Streaming state for a session - replaces streamingTextRef
 */
export interface StreamingState {
  content: string
  turnId?: string
  parentToolUseId?: string
}

/**
 * Complete state for a session - combines session + streaming
 */
export interface SessionState {
  session: Session
  streaming: StreamingState | null
}

/**
 * Text delta event - streaming text content
 */
export interface TextDeltaEvent {
  type: 'text_delta'
  sessionId: string
  delta: string
  turnId?: string
  /** R32 · display-only replacement for `delta`; absent means show `delta`. */
  displayDelta?: string
}

/**
 * Text complete event - finalizes streaming text
 */
export interface TextCompleteEvent {
  type: 'text_complete'
  sessionId: string
  text: string
  turnId?: string
  isIntermediate?: boolean
  /** P4.4 · reasoning rather than commentary; always paired with `isIntermediate`. */
  isThinking?: boolean
  parentToolUseId?: string
  /** Timestamp from main process for consistent ordering with session.jsonl */
  timestamp?: number
  /** Authoritative message ID from main process for persistence/branching parity */
  messageId?: string
  /** R32 · display-only replacement for `text`; absent means show `text`. */
  displayText?: string
}

/**
 * F1.298 — a failed attempt's streamed text is void (the Pi adapter, when the
 * provider's stream failed and the SDK is about to re-run the call). Removes the
 * still-streaming assistant message of that `turnId` and nothing else: completed
 * history, other turns and the user's own rows stay. Ported from craft-agents-oss
 * v0.13.4 (Apache-2.0).
 */
export interface TextDiscardEvent {
  type: 'text_discard'
  sessionId: string
  turnId: string
}

/**
 * Tool start event - begins tool execution
 * Field names match SessionEvent from shared/types.ts
 */
export interface ToolStartEvent {
  type: 'tool_start'
  sessionId: string
  toolUseId: string
  toolName: string
  toolInput?: Record<string, unknown>
  /** Timestamp from main process for consistent ordering */
  timestamp?: number
  turnId?: string
  parentToolUseId?: string
  toolIntent?: string
  toolDisplayName?: string
  /** Tool display metadata with base64-encoded icon for viewer compatibility */
  toolDisplayMeta?: ToolDisplayMeta
}

/**
 * Tool result event - completes tool execution
 */
export interface ToolResultEvent {
  type: 'tool_result'
  sessionId: string
  toolUseId: string
  toolName?: string
  result: string
  isError?: boolean
  turnId?: string
  parentToolUseId?: string
  /** Timestamp from main process for consistent ordering */
  timestamp?: number
  /** Replaces the input from tool_start (a browser_tool password fill, redacted once its result is known) — UB1.16 */
  toolInput?: Record<string, unknown>
}

/**
 * Complete event - agent loop finished
 */
export interface CompleteEvent {
  type: 'complete'
  sessionId: string
  tokenUsage?: Session['tokenUsage']
  contextUsage?: ContextUsageSnapshot
  /** Explicit unread flag - set by main process based on viewing state */
  hasUnread?: boolean
  /**
   * P2.37 · why the turn ended, when it ended for a reason worth saying out
   * loud. `SessionManager.sendTurnEndEvent` has put this on the wire since the
   * cap work landed; until now the renderer's own event type omitted it, so a
   * session that stopped at the spending limit was indistinguishable from one
   * that just stopped.
   */
  terminalReason?: AgentTerminalReason
  /** Tone only: the ending was an error, not a cap. */
  terminalIsError?: boolean
}

/**
 * Error event - agent error occurred
 */
export interface ErrorEvent {
  type: 'error'
  sessionId: string
  error: string
  code?: string
  title?: string
  details?: string
  original?: string
  /** Timestamp from main process for consistent ordering */
  timestamp?: number
}

/**
 * Permission request event
 * Matches SessionEvent shape from shared/types.ts
 */
export interface PermissionRequestEvent {
  type: 'permission_request'
  sessionId: string
  request: PermissionRequest
}

export interface PermissionRequestCancelledEvent {
  type: 'permission_request_cancelled'
  sessionId: string
  requestId: string
}

/**
 * Sources changed event
 */
export interface SourcesChangedEvent {
  type: 'sources_changed'
  sessionId: string
  enabledSourceSlugs: string[]
}

/**
 * Labels changed event
 */
export interface LabelsChangedEvent {
  type: 'labels_changed'
  sessionId: string
  labels: string[]
}

/**
 * Todo state changed event (external metadata change or agent tool)
 */
export interface SessionStatusChangedEvent {
  type: 'session_status_changed'
  sessionId: string
  sessionStatus?: string
}

/**
 * Session flagged/unflagged events (external metadata change)
 */
export interface SessionFlaggedEvent {
  type: 'session_flagged'
  sessionId: string
}

export interface SessionUnflaggedEvent {
  type: 'session_unflagged'
  sessionId: string
}

/**
 * Session archived/unarchived events (external metadata change)
 */
export interface SessionArchivedEvent {
  type: 'session_archived'
  sessionId: string
}

export interface SessionUnarchivedEvent {
  type: 'session_unarchived'
  sessionId: string
}

/**
 * Session name changed event (external metadata change)
 */
export interface NameChangedEvent {
  type: 'name_changed'
  sessionId: string
  name?: string
}

/**
 * Plan submitted event
 */
export interface PlanSubmittedEvent {
  type: 'plan_submitted'
  sessionId: string
  message: Message
}

/**
 * Typed error event
 */
export interface TypedErrorEvent {
  type: 'typed_error'
  sessionId: string
  error: TypedError
  /** Timestamp from main process for consistent ordering */
  timestamp?: number
}

/**
 * Status event
 */
export interface StatusEvent {
  type: 'status'
  sessionId: string
  message: string
  /**
   * Must stay the wire union (`protocol/dto.ts`'s `SessionEvent`, `status`
   * member). `'retrying'` is the gateway 429 backoff status and has always
   * crossed IPC and rendered; this type simply understated it, which would have
   * mis-narrowed the first exhaustive switch a renderer wrote over it.
   *
   * F1.524 (2) — `'runtime_turn'`: the claude child is running a turn it opened itself (the host's
   * `runtime-own-turn-indicator.ts`). Handled like `'hook'` — a label, never a transcript row — but NOT excluded
   * from D1.379's raise, which is the point: it is what shows the spinner and the Stop for that turn.
   *
   * F1.1150 — `'phase'`: a runtime phase inside a turn (codex's re-fork, its auto-review), the same label-only handling;
   * the empty message the runtime sends at the phase's end clears it.
   */
  statusType?: 'compacting' | 'hook' | 'retrying' | 'runtime_turn' | 'phase'
  /**
   * P6.916 — the retry's own facts, when this status is one. Sent whenever
   * `statusType === 'retrying'`; `event-processor/retry-status.ts` falls back to
   * parsing `message` for a replayed or field-less line.
   */
  retry?: AgentRetryFacts
  /** Timestamp from main process for consistent ordering */
  timestamp?: number
}

/**
 * Info event
 */
export interface InfoEvent {
  type: 'info'
  sessionId: string
  message: string
  statusType?: 'compaction_complete'
  level?: 'info' | 'warning' | 'error' | 'success'
  /** Timestamp from main process for consistent ordering */
  timestamp?: number
}

/**
 * Interrupted event
 */
export interface InterruptedEvent {
  type: 'interrupted'
  sessionId: string
  message?: Message
  /** Legacy server field. Queue UI is driven by queue_changed instead. */
  queuedMessages?: string[]
  /** F1.911 — the permission-request ids the host still holds that surface on this session; the turn-end clear keeps exactly these. */
  retainedPermissionRequestIds?: string[]
}

/**
 * Title generated event
 */
export interface TitleGeneratedEvent {
  type: 'title_generated'
  sessionId: string
  title: string
  preview?: string  // First user message preview for sidebar fallback
}

/**
 * Title regenerating event - indicates title regeneration has started/finished
 * Used to show shimmer effect on title during regeneration
 * @deprecated Use AsyncOperationEvent instead
 */
export interface TitleRegeneratingEvent {
  type: 'title_regenerating'
  sessionId: string
  isRegenerating: boolean
}

/**
 * Generic async operation state event
 * Used to show shimmer effect during any async operation (sharing, updating, revoking, title regeneration)
 */
export interface AsyncOperationEvent {
  type: 'async_operation'
  sessionId: string
  isOngoing: boolean
}

/**
 * Working directory changed event (user-initiated via UI)
 */
export interface WorkingDirectoryChangedEvent {
  type: 'working_directory_changed'
  sessionId: string
  workingDirectory: string
}

/**
 * Working directory error event - server rejected the path (cross-platform, not found, etc.)
 */
export interface WorkingDirectoryErrorEvent {
  type: 'working_directory_error'
  sessionId: string
  error: string
}

/**
 * Permission mode changed event
 */
export interface PermissionModeChangedEvent {
  type: 'permission_mode_changed'
  sessionId: string
  permissionMode: PermissionMode
  previousPermissionMode?: PermissionMode
  transitionDisplay?: string
  modeVersion?: number
  changedAt?: string
  changedBy?: 'user' | 'system' | 'restore' | 'automation' | 'unknown'
}

/**
 * Session model changed event
 */
export interface SessionModelChangedEvent {
  type: 'session_model_changed'
  sessionId: string
  model: string | null
}

/**
 * LLM connection changed event - syncs session.llmConnection to renderer
 */
export interface LLMConnectionChangedEvent {
  type: 'connection_changed'
  sessionId: string
  connectionSlug: string
  supportsBranching?: boolean
}

/**
 * Composer capabilities changed event - syncs server-resolved composer config.
 */
export interface CapabilitiesChangedEvent {
  type: 'capabilities_changed'
  sessionId: string
  capabilities: ComposerCapabilities
}

/**
 * Credential request event - prompts user for credentials
 */
export interface CredentialRequestEvent {
  type: 'credential_request'
  sessionId: string
  request: CredentialRequest
}

/**
 * Task backgrounded event - background agent started
 */
export interface TaskBackgroundedEvent {
  type: 'task_backgrounded'
  sessionId: string
  toolUseId: string
  taskId: string
  intent?: string
  turnId?: string
}

/**
 * Shell backgrounded event - background bash shell started
 */
export interface ShellBackgroundedEvent {
  type: 'shell_backgrounded'
  sessionId: string
  toolUseId: string
  shellId: string
  intent?: string
  turnId?: string
}

/**
 * Task progress event - live progress updates for background tasks
 */
export interface TaskProgressEvent {
  type: 'task_progress'
  sessionId: string
  toolUseId: string
  elapsedSeconds?: number
  orchestrationProgress?: OrchestrationProgress
  turnId?: string
}

/**
 * Task completed event - background task finished execution
 * Updates the tool message status and result when a background task completes.
 */
export interface TaskCompletedEvent {
  type: 'task_completed'
  sessionId: string
  taskId: string
  status: 'completed' | 'failed' | 'stopped'
  outputFile?: string
  summary?: string
  turnId?: string
}

/**
 * User message event - backend confirmation of optimistic user message
 * Used for optimistic UI: frontend shows message immediately,
 * backend confirms/updates status via this event
 */
export interface UserMessageEvent {
  type: 'user_message'
  sessionId: string
  message: Message
  status: 'accepted' | 'queued' | 'processing'
  /** Frontend's optimistic message ID for reliable matching */
  optimisticMessageId?: string
  /** F1.333 — the host handed a steer back to the queue: this 'queued' flips a delivered row back and raises nothing */
  requeued?: true
}

/**
 * Message annotation update event
 */
export interface MessageAnnotationsUpdatedEvent {
  type: 'message_annotations_updated'
  sessionId: string
  messageId: string
  annotations: NonNullable<Message['annotations']>
}

/**
 * Conversation rewind event.
 *
 * P3.49 — the two-lists shape, sixth instance: the wire type carries
 * `skippedLinks` BESIDE `skippedPaths`, and this mirror copied neither. The
 * three fields below exist so the mirror is a faithful copy of its wire member,
 * which is what {@link AssertMirrorCoversWire} below now enforces mechanically;
 * the reducer does not read them today, and that is deliberate — `ChatDisplay`
 * and `useSessionMenuActions` read the same two lists off the RPC RESULT, which
 * is where the toast is composed. A mirror kept narrow "because nothing reads
 * it" is exactly how six of these drifted.
 */
export interface ConversationRewoundEvent {
  type: 'conversation_rewound'
  sessionId: string
  messageId: string
  messages: Message[]
  removedMessages: number
  restoredCheckpoints?: number
  fileCheckpointsTracked?: boolean
  failedCheckpoints?: Array<{ success: boolean; checkpointId?: string; filePath?: string; error?: string }>
  skippedLinks?: number
  skippedPaths?: readonly FileCheckpointSkippedPath[]
  lastMessageAt?: number
  lastMessageRole?: Session['lastMessageRole']
  lastFinalMessageId?: string
}

/**
 * Session shared event - session was shared to viewer
 */
export interface SessionSharedEvent {
  type: 'session_shared'
  sessionId: string
  sharedUrl: string
}

/**
 * Session unshared event - session share was revoked
 */
export interface SessionUnsharedEvent {
  type: 'session_unshared'
  sessionId: string
}

/**
 * Auth request event - unified auth flow (credential or OAuth)
 * Adds auth-request message to session and displays inline auth UI
 */
export interface AuthRequestEvent {
  type: 'auth_request'
  sessionId: string
  message: Message
  request: AuthRequest
}

/**
 * Auth completed event - auth request was completed (success, failure, or cancelled)
 * Updates the auth-request message status
 */
export interface AuthCompletedEvent {
  type: 'auth_completed'
  sessionId: string
  requestId: string
  success: boolean
  cancelled?: boolean
  error?: string
}

/**
 * Source activated event - a source was auto-activated mid-turn.
 * The server owns the auto-retry; renderers should treat this as UI feedback only.
 */
export interface SourceActivatedEvent {
  type: 'source_activated'
  sessionId: string
  sourceSlug: string
  originalMessage: string
}

/**
 * Usage update event - real-time context usage during processing
 * Allows UI to show growing context as agent processes, not just on complete
 */
export interface UsageUpdateEvent {
  type: 'usage_update'
  sessionId: string
  tokenUsage: {
    inputTokens?: number | null
    contextWindow?: number | null
    contextUsage?: ContextUsageSnapshot
  }
  contextUsage?: ContextUsageSnapshot
}

/**
 * P6.424 — the spinner tip's payload.
 *
 * Mirrors the `plugin_suggestion_tip` member of the wire union. Structural, not
 * a rendered sentence: `PluginSuggestionTip` owns the wording so the string is
 * translated on the surface that shows it.
 */
export interface PluginSuggestionTipEvent {
  type: 'plugin_suggestion_tip'
  sessionId: string
  topic: string
  reference: string
}

/**
 * Message added event - a transcript row the server composed outside any turn.
 *
 * Mirrors the `message_added` member of the wire union (`protocol/dto.ts`'s
 * `SessionEvent`). The renderer keeps its own copy of that union and checks
 * exhaustiveness against it, so a wire member with no mirror here silently
 * lands in the processor's `default:` arm.
 */
export interface MessageAddedEvent {
  type: 'message_added'
  sessionId: string
  message: Message
}

/**
 * UA2.1 — session metadata changed (ported from craft-agents-oss v0.13.4, Apache-2.0): the live push for
 * programmatic metadata writes that do not ride the header-signature file watch (the board column; UA3.1
 * adds the task fields). The transport shape is authoritative, so it is the wire type itself; a cleared
 * field arrives as `null` (see `SessionMetadataChanges` in `protocol/dto.ts`).
 */
export type SessionMetadataChangedEvent = Extract<SessionEvent, { type: 'session_metadata_changed' }>

/**
 * UA5.3 — a session's project binding changed (ported from craft-agents-oss v0.13.4 `ProjectIdChangedEvent`,
 * Apache-2.0); the wire type itself, `projectId: null` = unbound.
 */
export type ProjectIdChangedEvent = Extract<SessionEvent, { type: 'project_id_changed' }>

/**
 * Union of all agent events
 */
export type AgentEvent =
  | TextDeltaEvent
  | TextCompleteEvent
  | TextDiscardEvent
  | ToolStartEvent
  | ToolResultEvent
  | CompleteEvent
  | ErrorEvent
  | TypedErrorEvent
  | PermissionRequestEvent
  | PermissionRequestCancelledEvent
  | CredentialRequestEvent
  | SourcesChangedEvent
  | LabelsChangedEvent
  | SessionStatusChangedEvent
  | SessionMetadataChangedEvent
  | ProjectIdChangedEvent
  | SessionFlaggedEvent
  | SessionUnflaggedEvent
  | SessionArchivedEvent
  | SessionUnarchivedEvent
  | NameChangedEvent
  | PlanSubmittedEvent
  | StatusEvent
  | InfoEvent
  | InterruptedEvent
  | TitleGeneratedEvent
  | TitleRegeneratingEvent
  | AsyncOperationEvent
  | WorkingDirectoryChangedEvent
  | WorkingDirectoryErrorEvent
  | PermissionModeChangedEvent
  | SessionModelChangedEvent
  | LLMConnectionChangedEvent
  | CapabilitiesChangedEvent
  | TaskBackgroundedEvent
  | ShellBackgroundedEvent
  | TaskProgressEvent
  | TaskCompletedEvent
  | UserMessageEvent
  | MessageAddedEvent
  | MessageAnnotationsUpdatedEvent
  | ConversationRewoundEvent
  | SessionSharedEvent
  | SessionUnsharedEvent
  | AuthRequestEvent
  | AuthCompletedEvent
  | SourceActivatedEvent
  | UsageUpdateEvent
  | PluginSuggestionTipEvent

// ---------------------------------------------------------------------------
// P3.49 — the mirror may not drop a field of the wire event it mirrors
// ---------------------------------------------------------------------------

/**
 * The renderer keeps its OWN copy of the wire union (`protocol/dto.ts`'s
 * {@link SessionEvent}) rather than importing it, so every member above is a
 * hand-written mirror. Six times on the parity plan a wire type carried two
 * parallel lists and a mirror copied one of them; the sixth was
 * {@link ConversationRewoundEvent}, which omitted `skippedLinks`,
 * `skippedPaths` and `fileCheckpointsTracked` with nothing to notice.
 *
 * This is the guard instead of a seventh point fix. `tsc` cannot see the
 * omission on its own: a wire value is ASSIGNABLE to a narrower mirror, because
 * excess properties are only checked on a fresh object literal. So the check has
 * to be on the KEY SETS, and that is what {@link DroppedWireFields} computes.
 *
 * MEASURED 2026-09-03 over the whole union, which is why the exception map below
 * is an artifact rather than a hedge. Exactly three members dropped anything;
 * every other mirrored member already carried every wire field:
 *
 * | Member | Wire fields the mirror dropped |
 * | --- | --- |
 * | `conversation_rewound` | `skippedLinks`, `skippedPaths`, `fileCheckpointsTracked` — CLOSED here |
 * | `complete` | `deferredToolUse`, `structuredOutput`, `structuredOutputSubtype`, `structuredOutputErrors` |
 * | `shell_backgrounded` | `command` |
 *
 * The five that remain are listed by member and by field in
 * {@link KnownMirrorDrops}, each still unread by this processor. They are named
 * so a later lane can delete an entry and watch the guard hold, and so that a
 * NEW drop — a field added to a wire member and forgotten here — is a compile
 * error on the day it is written rather than an incident later.
 */
type MirroredEventTypes = AgentEvent['type'] & SessionEvent['type']

/** Wire field names the renderer's mirror of `T` does not declare. */
type DroppedWireFields<T extends MirroredEventTypes> =
  Exclude<keyof Extract<SessionEvent, { type: T }>, keyof Extract<AgentEvent, { type: T }>>

/**
 * The drops that already existed when the guard was installed, per member.
 *
 * Not a licence: each entry is a measured omission that this processor does not
 * read today. Adding a member here is a decision to be recorded with a reason,
 * never a way to make the compiler quiet.
 */
type KnownMirrorDrops = {
  complete:
    | 'deferredToolUse'
    | 'structuredOutput'
    | 'structuredOutputSubtype'
    | 'structuredOutputErrors'
  shell_backgrounded: 'command'
  // UB6.15's owed renderer half (found by this file's own guard during the
  // UB6.11 affected-package typecheck): the event's `statusSetByDecision` copy
  // is unread here — the visible reason the row ships is read off the session
  // DTO (`renderer/atoms/sessions.ts`), which the same status change already
  // refreshes, so the event field would be a second, divergent source of the
  // same sentence.
  session_status_changed: 'statusSetByDecision'
}

type UnexplainedDrop<T extends MirroredEventTypes> =
  Exclude<DroppedWireFields<T>, T extends keyof KnownMirrorDrops ? KnownMirrorDrops[T] : never>

/** Compile error unless `T` is `never`; the message names the offending fields. */
type AssertMirrorCoversWire<T extends never> = T

/**
 * The guard itself. If this line goes red, a wire member gained a field and the
 * mirror above did not: add the field to the mirror, or — with a reason — to
 * {@link KnownMirrorDrops}. The error text names the field and the compiler
 * points at this line.
 */
export type MirrorCoversWire = AssertMirrorCoversWire<
  { [T in MirroredEventTypes]: UnexplainedDrop<T> }[MirroredEventTypes]
>

/**
 * Side effects that need to be handled outside the pure processor
 */
export type Effect =
  | { type: 'permission_request'; request: PermissionRequest }
  | { type: 'permission_request_cancelled'; requestId: string }
  | { type: 'credential_request'; request: CredentialRequest }
  | { type: 'generate_title'; sessionId: string; userMessage: string }
  | { type: 'permission_mode_changed'; sessionId: string; permissionMode: PermissionMode; previousPermissionMode?: PermissionMode; transitionDisplay?: string; modeVersion?: number; changedAt?: string; changedBy?: 'user' | 'system' | 'restore' | 'automation' | 'unknown' }
  | { type: 'toast_error'; message: string }

/**
 * Result of processing an event
 */
export interface ProcessResult {
  state: SessionState
  /** Side effects to execute (permissions, etc.) */
  effects: Effect[]
}
