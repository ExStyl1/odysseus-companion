/**
 * ISessionManager — abstract interface for the session lifecycle engine.
 *
 * Handler code in server-core programs against this interface;
 * concrete implementations (Electron SessionManager, headless, etc.)
 * satisfy it at runtime.
 *
 * Composite session identity (W5): session-addressed methods accept an optional
 * `workspaceId`. RPC handlers pass the caller's envelope workspace so equal
 * session IDs in different live Workspaces never collide; bare-sessionId
 * resolution stays available for unambiguous IDs and fails closed on duplicates.
 */

import type { Workspace, WorkspaceInfo, ActiveSessionInfo } from '@nessy-agent/core/types'
import type { SessionAttachmentDto, StoredAttachment, AnnotationV1 } from '@nessy-agent/core/types'
import type { PermissionMode } from '@nessy-agent/shared/agent/mode-types'
import type { ProjectKey } from '@nessy-agent/shared/projects/project-identity'
import type { PluginRuntimeRefreshSummary } from '../sessions/plugin-runtime-refresh-outcome'
import type { ThinkingLevel } from '@nessy-agent/shared/agent/thinking-levels'
import type { AgentProvider, WorkflowInvocation } from '@nessy-agent/shared/agent/backend/types'
import type { AuthResult, ClaudePermissionDenialReceiptV1 } from '@nessy-agent/shared/agent'
import type {
  SessionMemoryScope,
  SessionMemoryScopeOverride,
} from '@nessy-agent/shared/agent/memory/session-memory-scope'
import type { RuntimeWithheldCapability } from '@nessy-agent/shared/capabilities/views'
import type { WorkflowSaveScope } from '@nessy-agent/shared/workflows/workflow-loader'
import type {
  Session,
  SessionStatus,
  CreateSessionOptions,
  FileAttachment,
  SendMessageOptions,
  ShellCommandResult,
  StopAgentTaskResult,
  BackgroundInFlightTasksResult,
  BackgroundTaskOutputResult,
  ConversationRewindResult,
  RewindTrackedChangesResult,
  PermissionResponseOptions,
  CredentialResponse,
  PermissionModeState,
  UnreadSummary,
  ShareResult,
  FileCheckpointRevertResult,
  QueuedMessageDto,
  FuzzyFileSearchResponse,
  SessionTranscriptExportFormat,
  SessionTranscriptExportResult,
  RefreshContextUsageResult,
  SideQuestionResult,
  SessionRecapResult,
  SessionHeapdumpResult,
  DpAuthResult,
  DpAuthStatusEvent,
  ProjectTrustSelection,
  SafeCapabilityContextRef,
  SafeMcpToolsResult,
  SetSessionProjectInput,
  SetWorkspaceDefaultProjectInput,
  RuntimeSwitchResult,
  RuntimeSwitchPreview,
} from '@nessy-agent/shared/protocol'
import type { BackgroundTaskEntryV1, SessionCronEntryV1 } from '@nessy-agent/shared/automations'
import type { SessionBundle, DispatchMode } from '@nessy-agent/shared/sessions'
import type { EventSink } from '../transport'
import type { CapabilityResolver } from '@nessy-agent/shared/capabilities/resolver'
import type { IssuedProjectHandle, ProjectHandleService } from '@nessy-agent/shared/projects/project-handle-service'
import type { RecentProjectStore } from '@nessy-agent/shared/projects/recent-store'
import type { CustomSlashCommand, ResolvedCustomSlashCommand } from '@nessy-agent/shared/slash-commands'
import type { SdkAutomationInput } from '@nessy-agent/shared/automations'
import type { SessionKey } from '@nessy-agent/shared/sessions'
import type {
  PiAgentViewControlRequestV1,
  PiAgentViewControlResultV1,
  PiAgentViewPageRequestV1,
  PiAgentViewPageV1,
  PiHarnessRuntimeControlRequestV1,
  PiHarnessRuntimeControlResultV1,
  PiHarnessRuntimeSnapshotV1,
} from '@nessy-agent/core/types'

export interface AuthRequestClaim {
  readonly claimId: string
  readonly sessionId: string
  readonly workspaceId: string
  readonly requestId: string
  readonly sourceSlug: string
}

export interface ISessionManager {
  getCapabilityResolver?(): CapabilityResolver | undefined
  /**
   * UB2.9 (B4-14) — subscribe to a session's activity: called for every event its agent emits
   * (text, thinking, tool calls, status), so a caller can time out only a turn that has STALLED,
   * not one that is slow but working. In-process only; returns an unsubscribe function.
   */
  onSessionActivity?(sessionId: string, listener: () => void): () => void
  getProjectHandleService?(): ProjectHandleService | undefined
  getRecentProjectStore?(): RecentProjectStore | undefined
  /**
   * The live session's ACTIVE backend, or `undefined` when the session is not
   * managed in this process.
   *
   * Read by the capability-context ingress so the catalog's runtime gate has a
   * provider to gate on (Q8-D4). Non-throwing on an unknown session — a
   * capability read for a session this process has not materialized resolves
   * provider-blind, which is the same honest fallback as a workspace-scoped
   * read, rather than failing a catalog fetch.
   */
  getSessionProvider?(sessionId: string, workspaceId?: string): AgentProvider | undefined
  /**
   * List an MCP source's tools from the live session pool (U3). Fails soft.
   * `peek` (U3b browse path only): read the pool cache WITHOUT connecting — a
   * cold pool yields a 'disconnected' refusal instead of a lazy connect.
   */
  listMcpToolsForCapability?(
    context: SafeCapabilityContextRef,
    capabilityKey: string,
    peek?: boolean,
  ): Promise<SafeMcpToolsResult>
  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  waitForInit(): Promise<void>
  initialize(): Promise<void>
  cleanup(): Promise<void>
  setEventSink(sink: EventSink): void
  flushAllSessions(): Promise<void>

  // ---------------------------------------------------------------------------
  // Session CRUD
  // ---------------------------------------------------------------------------

  getSessions(workspaceId?: string): Session[]
  getSession(sessionId: string, workspaceId?: string): Promise<Session | null>
  getPiHarnessRuntimeSnapshot(session: SessionKey): Promise<PiHarnessRuntimeSnapshotV1>
  /** P6.263 — the protocol capabilities this session's runtime advertises; `[]` for pi/codex and for a cold session. */
  getSessionProtocolCapabilities?(session: SessionKey): readonly string[]
  controlPiHarnessRuntime(request: PiHarnessRuntimeControlRequestV1): Promise<PiHarnessRuntimeControlResultV1>
  listPiAgentView(workspaceId: string, request: PiAgentViewPageRequestV1): Promise<PiAgentViewPageV1>
  controlPiAgentView(request: PiAgentViewControlRequestV1): Promise<PiAgentViewControlResultV1>
  createSession(workspaceId: string, options?: CreateSessionOptions): Promise<Session>
  deleteSession(sessionId: string, workspaceId?: string): Promise<void>
  setSessionProject(input: SetSessionProjectInput): Promise<Session>
  setWorkspaceDefaultProject(input: SetWorkspaceDefaultProjectInput): Promise<WorkspaceInfo>
  setProjectTrust(input:
    | { workspaceId: string; projectHandleId: string; state: ProjectTrustSelection }
    | { session: import('@nessy-agent/shared/sessions').SessionKey; state: ProjectTrustSelection }
  ): Promise<IssuedProjectHandle>

  // ---------------------------------------------------------------------------
  // Session state
  // ---------------------------------------------------------------------------

  flagSession(sessionId: string, workspaceId?: string): Promise<void>
  unflagSession(sessionId: string, workspaceId?: string): Promise<void>
  archiveSession(sessionId: string, workspaceId?: string): Promise<void>
  unarchiveSession(sessionId: string, workspaceId?: string): Promise<void>
  renameSession(sessionId: string, name: string, workspaceId?: string): Promise<void>
  setSessionStatus(sessionId: string, status: SessionStatus, workspaceId?: string): Promise<void>
  markSessionRead(sessionId: string, workspaceId?: string): Promise<void>
  markSessionUnread(sessionId: string, workspaceId?: string): Promise<void>
  markAllSessionsRead(workspaceId: string): Promise<void>
  setActiveViewingSession(sessionId: string | null, workspaceId: string): void
  clearActiveViewingSession(workspaceId: string): void

  // ---------------------------------------------------------------------------
  // Session configuration
  // ---------------------------------------------------------------------------

  setSessionPermissionMode(sessionId: string, mode: PermissionMode, workspaceId?: string): void
  setSessionThinkingLevel(sessionId: string, level: ThinkingLevel, workspaceId?: string): Promise<void>
  /** QK5 — the session's ultracode toggle. Per session, never persisted. */
  setSessionUltracode(sessionId: string, enabled: boolean, workspaceId?: string): void
  updateWorkingDirectory(sessionId: string, path: string, workspaceId?: string): Promise<void>
  setSessionSources(sessionId: string, sourceSlugs: string[], workspaceId?: string): Promise<void>
  setSessionLabels(sessionId: string, labels: string[], workspaceId?: string): void
  setSessionConnection(sessionId: string, connectionSlug: string, workspaceId?: string): Promise<void>
  /**
   * The one implementation of "this session changes connection".
   * `setSessionConnection` delegates to it and drops the result; this is the
   * entrance that reports the tier and whether context crossed.
   */
  switchSessionRuntime(sessionId: string, connectionSlug: string, workspaceId?: string): Promise<RuntimeSwitchResult>
  /**
   * READ-ONLY sibling of the above: what that switch WOULD carry, asked before
   * the confirmation modal opens so the modal can name it. Loads the
   * transcript and runs the same planner; mutates nothing, refuses nothing.
   */
  previewRuntimeSwitch(sessionId: string, connectionSlug: string, workspaceId?: string): Promise<RuntimeSwitchPreview>
  /**
   * P2.489 — the managed tier of the default-permission-mode chain, read by
   * `SETTINGS_GET` so the workspace control can say when a local write is inert.
   *
   * OPTIONAL for the same reason `emitUserPromptExpansion` is: an embedder that
   * stands this interface up partially must not have to answer for a managed
   * policy it does not compose. The call site is `?.`-guarded, and an absent
   * answer is `undefined` — which the wire and the renderer both read as
   * UNMANAGED, the fail-open direction chosen on purpose (absence is the state
   * of every unmanaged install and of any host older than the field, so reading
   * it as "managed" would disable a working control for everyone).
   */
  managedDefaultPermissionMode?(): PermissionMode | undefined
  updateSessionModel(sessionId: string, workspaceId: string, model: string | null, connection?: string): Promise<void>
  listCustomSlashCommandSummaries(session: SessionKey): Promise<CustomSlashCommand[]>
  resolveCustomSlashCommand(session: SessionKey, commandId: string, args?: string): Promise<ResolvedCustomSlashCommand | null>
  /**
   * R73 · `UserPromptExpansion` (hooks.md#userpromptexpansion), fired by the
   * SEND_MESSAGE handler before a typed command is resolved so a
   * `decision: "block"` can prevent the expansion.
   *
   * OPTIONAL on purpose: an embedder that does not implement it simply gets no
   * expansion hook, and the handler call site is `?.`-guarded to match. Making
   * it required would break every partial harness that stands this interface up.
   */
  emitUserPromptExpansion?(
    session: SessionKey,
    input: SdkAutomationInput,
  ): Promise<{ blocked?: string; additionalContext?: string }>

  sendMessage(
    sessionId: string,
    message: string,
    attachments?: FileAttachment[],
    storedAttachments?: StoredAttachment[],
    options?: SendMessageOptions,
    existingMessageId?: string,
    _isAuthRetry?: boolean,
    onAck?: (messageId: string) => void,
    rpcContext?: { callerClientId?: string; workspaceId?: string },
    modelMessage?: string,
    workflowInvocation?: WorkflowInvocation,
  ): Promise<void>
  /**
   * P3.19 · the flush half of the turn-end door, for the ONE renderer-facing
   * terminal event emitted outside `SessionManager`: `SEND_MESSAGE`'s
   * post-persist error arm, which pushes `error` + `complete` to the calling
   * client and so cannot use the workspace-broadcasting door itself. Await this
   * before putting a terminal event on the wire from outside, or the 50 ms delta
   * batcher delivers the turn's last text AFTER the turn ended.
   */
  flushBeforeTurnEndEvent(sessionId: string, workspaceId: string): Promise<void>
  cancelProcessing(sessionId: string, silent?: boolean, workspaceId?: string): Promise<void>
  getQueuedMessages(sessionId: string, workspaceId?: string): { queue: QueuedMessageDto[]; paused: boolean }
  deleteQueuedMessage(sessionId: string, messageId: string, workspaceId?: string): void
  /** P6.51 — move a queued message to `toIndex` (clamped). The queue's order IS the send order. */
  reorderQueuedMessage(sessionId: string, messageId: string, toIndex: number, workspaceId?: string): void
  sendQueuedNow(sessionId: string, messageId: string, workspaceId?: string): Promise<void>
  resumeQueue(sessionId: string, workspaceId?: string): Promise<void>
  refreshContextUsage(sessionId: string, workspaceId?: string): Promise<RefreshContextUsageResult>
  /**
   * `/btw` (interactive-mode.md:359-372): answer a side question from the live
   * transcript, out-of-band. Non-persisting by contract — no transcript push,
   * no persist/flush, no user_message event, no title/label, no turn boundary
   * — and MUST succeed while the session is processing.
   */
  askSideQuestion(sessionId: string, question: string, workspaceId?: string): Promise<SideQuestionResult>
  /** `/recap` (interactive-mode.md:398-404): one-line on-demand summary; same non-persisting contract. */
  generateSessionRecap(sessionId: string, workspaceId?: string): Promise<SessionRecapResult>
  /**
   * `/heapdump` (troubleshooting.md:39-49): write a heap snapshot + memory
   * breakdown to ~/Desktop (home fallback) for the host — and the Pi
   * subprocess when alive — and persist ONE badged summary message. NO
   * isProcessing gate: a dump must work on a wedged session.
   */
  heapdump(sessionId: string, workspaceId?: string): Promise<SessionHeapdumpResult>

  /**
   * Read-only view of the session agent's recent subprocess stderr (~8KB ring
   * buffer, always on). Empty string when there is nothing to read.
   */
  getRecentAgentStderr(sessionId: string, workspaceId?: string): string
  /**
   * P6.510 — arm connected channel sources for THIS session only, additively
   * and idempotently; answers with the session's whole armed set, sorted. The
   * managed bound is NOT applied here: `resolveChannelPolicy` applies it on
   * every read, so a mandate that tightens later still takes effect.
   */
  armSessionChannelSources(
    sessionId: string,
    sources: readonly string[],
    workspaceId?: string,
  ): readonly string[]
  /** P6.510 — drop this session's own arming; the app-wide preference is untouched. */
  disarmSessionChannelSources(sessionId: string, workspaceId?: string): void
  /**
   * P6.703 — the per-chat memory scope: the stored override, and the effective
   * scope the resolver produces from it plus the global switch.
   *
   * Declared OPTIONAL while the record side was another lane's file, so that the
   * channel, the renderer and this contract could not drift on a name; the
   * implementation has since landed (`SessionManager.getSessionMemoryScope` /
   * `setSessionMemoryScope`, backed by the persisted `memoryScopeOverride`), and
   * the `?` is gone with it. The handler's typeof-refusal is kept on purpose: it
   * costs two lines and it refuses BY NAME on any host that does not implement
   * the pair, rather than answering a default that reads as "no override" and
   * lets a user believe a chat was excluded when nothing recorded it.
   */
  /**
   * P6.318 — save this session's workflow recipe so `/<name>` dispatches it in a
   * later session, into the project (a trusted directory) or the personal
   * location (`CONFIG_DIR/workflows`, which the loader has always read).
   *
   * Throws rather than returning a failure shape, and the message is the whole
   * point in two of the three refusals: workflows off for this host, and a
   * runtime that cannot dispatch a recipe at all — the row's own requirement
   * that the two runtimes which cannot execute one say so rather than offering
   * the save.
   */
  saveSessionWorkflowRecipe(
    sessionId: string,
    source: string,
    scope: WorkflowSaveScope,
    workspaceId?: string,
  ): Promise<{ path: string }>
  getSessionMemoryScope(
    sessionId: string,
    workspaceId?: string,
  ): { scope: SessionMemoryScope; override: SessionMemoryScopeOverride }
  setSessionMemoryScope(
    sessionId: string,
    override: SessionMemoryScopeOverride,
    workspaceId?: string,
  ): Promise<{ scope: SessionMemoryScope; override: SessionMemoryScopeOverride }>
  /**
   * P6.209 (A42) — read-only: the denial receipts the session's agent has
   * retained, oldest first. Observational: listing a refusal is not offering to
   * re-issue it.
   *
   * P6.721 — `receipts` being empty is disambiguated by `supported`: `false`
   * means this session's runtime keeps no denial history at all (every runtime
   * but claude today), `true` with an empty list means the judge refused nothing
   * yet. `runtime` names the answering runtime so a caller can say which without
   * a runtime check of its own.
   */
  getRecentAutoModeDenials(
    sessionId: string,
    workspaceId?: string,
  ): { supported: boolean; runtime: string; receipts: readonly ClaudePermissionDenialReceiptV1[] }
  /**
   * P6.411 — read-only: what this session's capability resolution withheld and
   * why, identical on all three runtimes because `toAgentRuntime` is the one
   * point they converge on. Empty before the session has resolved a turn's
   * capabilities once. The LOADED half is deliberately not here — the renderer
   * already reads the capability catalog.
   */
  getSessionCapabilityInventory(
    sessionId: string,
    workspaceId?: string,
  ): readonly RuntimeWithheldCapability[]
  /**
   * P6.720 — `relativeCwd` is a path RELATIVE to the session's own working
   * directory, or `undefined` for "run where the session runs". The
   * implementation contains it against that directory itself rather than
   * trusting a caller-resolved absolute path: this method is reachable from the
   * session `command` verb as well as from the saved-actions one, so a
   * pre-resolved path here would make the direct-shell seam widenable by
   * whoever calls it.
   */
  runShellCommand(
    sessionId: string,
    command: string,
    workspaceId?: string,
    relativeCwd?: string,
  ): Promise<ShellCommandResult>
  rewindToMessage(sessionId: string, messageId: string, options?: { restoreFiles?: boolean }, workspaceId?: string): Promise<ConversationRewindResult>
  /**
   * P6.103 — read-only: which rewind anchors a file-restoring rewind would
   * revert something for. The caller FAILS OPEN on `success: false`.
   */
  listRewindTrackedChanges(sessionId: string, workspaceId?: string): Promise<RewindTrackedChangesResult>
  killShell(sessionId: string, shellId: string, workspaceId?: string): Promise<{ success: boolean; error?: string }>
  /**
   * Stop a background AGENT task — the other half of `killShell`. `success` is
   * the caller's ONLY licence to drop the row from the UI; a `false` carries a
   * stable `reason` code the renderer turns into a translated sentence, and the
   * row must stay.
   */
  stopAgentTask(sessionId: string, taskId: string, workspaceId?: string): Promise<StopAgentTaskResult>
  /**
   * P6.793 — the opposite direction of the line above: background the tool call
   * this turn is BLOCKED on, so the turn continues. Native on claude
   * (`Query.backgroundTasks`); codex refuses by name; Pi omits the lever.
   */
  backgroundInFlightTasks(sessionId: string, toolUseId?: string, workspaceId?: string): Promise<BackgroundInFlightTasksResult>
  /**
   * L9 — read a RUNNING background task's output, session-scoped and honest about
   * an id nothing owns. `getTaskOutput` below only ever answers for a task that
   * has COMPLETED, and the row is retired by the same event that fills its record,
   * so it can never serve a row on screen.
   */
  readBackgroundTaskOutput(
    sessionId: string,
    taskId: string,
    cursor?: number,
    workspaceId?: string,
  ): Promise<BackgroundTaskOutputResult>
  getTaskOutput(taskId: string): Promise<string | null>
  /**
   * D1.97 + D1.98 — the two inventories this session already keeps, handed over
   * unprojected: the cron records it will run later and the background work
   * (watches included) it is running now.
   *
   * OPTIONAL, in `getSessionProvider?`'s shape, and the `?` is load-bearing
   * rather than defensive. A host whose session manager does not implement it
   * must be able to say SO — the RPC answers `unavailable: 'not-supported'` and
   * the panel prints a different sentence from the one it prints for an empty
   * session. An implementation returning `[]` for both would assert "nothing is
   * queued" about a session it never asked, which is the merge of two facts this
   * whole pair of rows exists to prevent.
   *
   * `undefined` means the SESSION was not found, which is the third fact and is
   * not the same as either of the other two.
   *
   * Deliberately NOT projected here: {@link projectSessionScheduledWork} owns
   * the flattening, so the hook payload, the typed `/tasks` command and the
   * panel read ONE inventory and cannot word it three ways.
   */
  listSessionScheduledWork?(
    sessionId: string,
    workspaceId?: string,
  ): { crons: readonly SessionCronEntryV1[]; tasks: readonly BackgroundTaskEntryV1[] } | undefined
  addMessageAnnotation(sessionId: string, messageId: string, annotation: AnnotationV1, workspaceId?: string): void
  removeMessageAnnotation(sessionId: string, messageId: string, annotationId: string, workspaceId?: string): void
  updateMessageAnnotation(
    sessionId: string,
    messageId: string,
    annotationId: string,
    patch: Partial<AnnotationV1>,
    workspaceId?: string,
  ): void

  // ---------------------------------------------------------------------------
  // Permissions & credentials
  // ---------------------------------------------------------------------------

  respondToPermission(
    sessionId: string,
    requestId: string,
    allowed: boolean,
    alwaysAllow: boolean,
    options?: PermissionResponseOptions,
    workspaceId?: string,
  ): boolean
  revokeFilesystemRoot(sessionId: string, receiptId: string, workspaceId?: string): Promise<boolean>
  respondToCredential(sessionId: string, requestId: string, response: CredentialResponse, workspaceId?: string): Promise<boolean>
  getSessionPermissionModeState(sessionId: string, workspaceId?: string): PermissionModeState | null

  // ---------------------------------------------------------------------------
  // Plans
  // ---------------------------------------------------------------------------

  setPendingPlanExecution(sessionId: string, planHandleId: string, draftInputSnapshot?: string, workspaceId?: string): Promise<void>
  markPendingPlanExecutionDispatched(sessionId: string, workspaceId?: string): Promise<boolean>
  clearPendingPlanExecution(sessionId: string, workspaceId?: string): Promise<void>
  getPendingPlanExecution(sessionId: string, workspaceId?: string): { draftInputSnapshot?: string; awaitingCompaction: boolean; executionDispatched: boolean } | null
  markCompactionComplete(sessionId: string, workspaceId?: string): Promise<void>
  getSessionAttachmentPath(sessionId: string, handleId: string, workspaceId?: string): Promise<string>
  stageAttachment(clientId: string, sessionId: string, workspaceId: string, attachment: StoredAttachment): SessionAttachmentDto
  resolveStagedAttachments(clientId: string, sessionId: string, workspaceId: string, handles: readonly string[]): StoredAttachment[]
  clearStagedAttachmentsForClient(clientId: string): void

  // F1.259 (2026-09-23) — `acceptPlan` was DELETED from this interface and from
  // `SessionManager`. Nothing outside two tests called it, and its non-Pi branch
  // still switched a session in Explore to `bypassPermissions`: the pre-F1.106
  // approval that F1.106/F1.201 removed from the composer. A plan is approved
  // where the person approves it — the plan card's Accept, renderer-only, which
  // lands the mode through `planApprovalLandingMode` (`plan-approval-message.ts`),
  // or Pi's `approve_plan` through `controlPiHarnessRuntime` above (F1.412), which
  // refuses any other runtime. So NO server-side plan approval exists for claude or
  // codex (F1.415): a future one lands explore/plan in `default` through
  // `setSessionPermissionMode`. (Ten lines for the ten the member held.)

  // ---------------------------------------------------------------------------
  // Sharing
  // ---------------------------------------------------------------------------

  shareToViewer(sessionId: string, workspaceId?: string): Promise<ShareResult>
  updateShare(sessionId: string, workspaceId?: string): Promise<ShareResult>
  revokeShare(sessionId: string, workspaceId?: string): Promise<ShareResult>
  revertFileCheckpoint(sessionId: string, checkpointId?: string, workspaceId?: string): Promise<FileCheckpointRevertResult>
  exportSessionTranscript(sessionId: string, format?: SessionTranscriptExportFormat, workspaceId?: string): Promise<SessionTranscriptExportResult>

  // ---------------------------------------------------------------------------
  // Export / Import
  // ---------------------------------------------------------------------------

  /**
   * Export a session as a portable bundle.
   * Flushes pending writes, serializes session data + files.
   * Session must be stopped before export.
   */
  exportSession(sessionId: string, workspaceId: string): Promise<SessionBundle | null>

  /**
   * Export a session as a summary-based payload for cross-server transfer.
   * Generates a mini-model summary instead of shipping the full transcript.
   */
  exportRemoteSessionTransfer(
    sessionId: string,
    workspaceId: string,
  ): Promise<import('@nessy-agent/shared/protocol').RemoteSessionTransferPayload | null>

  /**
   * Import a session bundle into a target workspace.
   * Creates session directory, writes JSONL + files, registers in memory.
   * Returns the new session ID and any compatibility warnings.
   */
  importSession(
    workspaceId: string,
    bundle: SessionBundle,
    mode: DispatchMode,
  ): Promise<{ sessionId: string; warnings?: string[] }>

  /**
   * Import a summary-based remote transfer payload into a target workspace.
   */
  importRemoteSessionTransfer(
    workspaceId: string,
    payload: import('@nessy-agent/shared/protocol').RemoteSessionTransferPayload,
  ): Promise<import('@nessy-agent/shared/protocol').ImportRemoteSessionTransferResult>

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  getSessionPath(sessionId: string, workspaceId?: string): string | null
  getWorkingDirectory(sessionId: string, workspaceId?: string): string | null
  fuzzyFileSearch(sessionId: string, query: string, workspaceId?: string): Promise<FuzzyFileSearchResponse | null>
  refreshTitle(sessionId: string, workspaceId?: string): Promise<{ success: boolean; title?: string; error?: string }>
  refreshBadge(): void
  getUnreadSummary(): UnreadSummary

  // ---------------------------------------------------------------------------
  // Workspace
  // ---------------------------------------------------------------------------

  getWorkspaces(): Workspace[]
  /** Return client-safe workspace list (no rootPath) for remote clients. */
  getWorkspacesInfo(): WorkspaceInfo[]
  setupConfigWatcher(workspaceRootPath: string, workspaceId: string): void
  /**
   * Manually notify the ConfigWatcher of a file change.
   * Workaround for Bun's fs.watch on Linux not detecting atomic renames.
   */
  notifyConfigFileChange(workspaceId: string, relativePath: string): void

  // ---------------------------------------------------------------------------
  // Server-level observability
  // ---------------------------------------------------------------------------

  /** Count of sessions with active backend processes. Pass workspaceId to scope. */
  getActiveSessionCount(workspaceId?: string): number
  /** Automation summary for a workspace (count of configured automations + scheduler state). */
  getWorkspaceAutomationSummary(workspaceId: string): { automationCount: number; schedulerRunning: boolean }
  /** Active sessions across all workspaces (sessions with running backend processes). */
  getActiveSessionsInfo(): ActiveSessionInfo[]

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------
  /** Resolves the connection's auth and logs the names; never writes it to `process.env` — each session applies its own (F1.963). */
  reinitializeAuth(connectionSlug?: string): Promise<void>
  /**
   * Push runtime updates (e.g. capability toggles) to every active session
   * that uses the given connection. Backstopped by the lazy refresh path in
   * `getOrCreateAgent`.
   */
  refreshConnectionRuntime(connectionSlug: string): Promise<void>
  /**
   * The `llmConnections.DELETE` pre-flight: everything still bound to a
   * connection slug. Deleting one out from under a live session or a scheduled
   * task fails nowhere — the slug stops resolving and both fall through to the
   * default, on a different runtime, in silence.
   *
   * C3.368 · the `name` rides along so the refusal can SAY which chat holds the
   * connection. It is optional because a session can genuinely have none yet;
   * the refusal decides how to spell that case, not the producer.
   */
  sessionsUsingConnection(slug: string): (SessionKey & { name?: string })[]
  /**
   * Names of the automations configured for this connection, across EVERY
   * loaded workspace. Not workspace-scoped: `llmConnections.DELETE` takes a
   * slug and no workspace, and connections are global config.
   */
  listAutomationsUsingConnection(slug: string): string[]
  /**
   * Refresh plugin-projected runtime capabilities for live agents after plugin
   * install/enable/disable/uninstall or explicit marketplace refresh. Scoped by
   * the immutable workspace id and resolved ProjectKey (W8c), never a raw path.
   *
   * P2.107 — and it REPORTS which sessions took the refresh, which deferred it
   * to their turn boundary, and which had no runtime to refresh, so a caller
   * that must tell the user whether the plugin is live reads the server's own
   * verdict instead of re-deriving one from session state.
  */
  refreshPluginRuntime(workspaceId?: string, projectKey?: ProjectKey, reason?: string, answerForWorkspaceId?: string): Promise<PluginRuntimeRefreshSummary> // F1.407 / F1.484 — the verdict's workspace
  /** Synchronously claims an exact pending non-DP request before terminal work can yield. */
  claimAuthRequest(
    sessionId: string,
    requestId: string,
    sourceSlug: string,
    workspaceId?: string,
    /** UB3.10 fan-out only: also accept a pending CARD when the in-memory request was lost. */
    opts?: { messageBoundFallback?: boolean },
  ): AuthRequestClaim
  /** Settles a previously claimed non-DP request exactly once. */
  completeClaimedAuthRequest(claim: AuthRequestClaim, result: AuthResult): Promise<void>
  /** Terminal settlement boundary; callers must validate the pending request binding first. */
  completeAuthRequest(sessionId: string, result: AuthResult, workspaceId?: string): Promise<void>
  /**
   * UB3.10 — one sign-in serves every session paused on the source: complete
   * each session's pending non-DP OAuth request for `sourceSlug` in this
   * workspace and resume it. `boundRequests` (the cards that started or joined
   * the sign-in) also count when their session no longer holds the request in
   * memory — `pendingAuthRequest` is not persisted, so a restart forgets it.
   * Returns the resumed session ids; resumed turns run in the background.
   */
  completeAuthRequestsForSource(
    workspaceId: string,
    sourceSlug: string,
    result: { email?: string; workspace?: string },
    boundRequests?: Array<{ sessionId: string; authRequestId: string }>,
  ): string[]
  hasPendingDpAuthRequest(sessionId: string, requestId: string, workspaceId?: string): boolean
  ensureDpAuth(
    sessionId: string,
    requestId: string,
    workspaceId?: string,
    onStatus?: (status: DpAuthStatusEvent['status']) => void,
  ): Promise<DpAuthResult>
  cancelDpAuth(sessionId: string, requestId: string, workspaceId?: string): Promise<DpAuthResult>
  /**
   * Value-only, non-interactive dp session probe (T3, plugin-install plan).
   * The broker publish it triggers is what restores dp-backed servers after a
   * completed system sign-in — no chat message, no login start.
   */
  probeDpSessionState(): Promise<'ready' | 'needs-login' | 'unavailable'>
  /** T4 (plugin-install plan § 5): the session-start notice's value-free data. */
  getWorkspacePendingAuth(workspaceId: string): Promise<import('@nessy-agent/shared/protocol').SafeWorkspacePendingAuth>
  /** Built-in dp MCP toggles change the desired set of every warm pool. */
  invalidateWorkspaceMcpPools(): void
  /**
   * F1.851 — moves on every MCP inventory change the manager hears; the tools-list
   * cache (`rpc/capabilities.ts:createMcpToolsLister`) serves a hit only while it holds.
   */
  getMcpToolsListingEpoch?(): number
  /**
   * P6.711 - reconnect ONE of this session's MCP servers, on the user's word.
   *
   * The verdict is the pool's own (`unknown-server` / `no-config` /
   * `in-process` / `failed`) rather than an exception, because each of the four
   * is something a panel RENDERS: "that server is not in this session", "it has
   * no launchable config", "it runs in-process and has no connection to
   * restart", "the restart was attempted and failed". Throwing would collapse
   * four different answers into one.
   *
   * The pool is per managed session, which is the whole reason this method has
   * to exist: `HandlerDeps` exposes no accessor for it, so the renderer half of
   * P6.711 could not land without one.
   */
  reconnectMcpServer(
    sessionId: string,
    slug: string,
    workspaceId?: string,
  ): Promise<import('@nessy-agent/shared/mcp/mcp-pool').McpReconnectResult>
  /**
   * P6.750 - the LIVE state of this session's MCP servers, one line per server.
   *
   * The panel's rows come from stored CONFIG, so a failed server, one waiting on
   * a sign-in and a connected one providing zero tools all look like a healthy
   * server. This is the read that separates them, and it is the same shape and
   * the same producer `/mcp` prints from rather than a second inventory.
   *
   * `null` means no source of inventory at all - no backend built yet and no
   * pool - and is deliberately not `[]`, which means asked and there are none.
   * The session accessor exists for the same reason `reconnectMcpServer`'s does:
   * `HandlerDeps` exposes no accessor for a per-session pool.
   */
  mcpServerStatuses(
    sessionId: string,
    workspaceId?: string,
  ): Promise<readonly import('@nessy-agent/shared/mcp').McpServerStatusLine[] | null>
  executePromptAutomation(input: ExecutePromptAutomationInput): Promise<{ sessionId: string }>
}

/**
 * Input for executePromptAutomation. Options-object form replaces the
 * previous positional-args signature once the param list grew past
 * readability — new optional fields (thinkingLevel, future cwd/permissions
 * overrides) can be added without churn at every call site.
 */
export interface ExecutePromptAutomationInput {
  workspaceId: string
  workspaceRootPath: string
  prompt: string
  labels?: string[]
  permissionMode?: PermissionMode
  mentions?: string[]
  llmConnection?: string
  model?: string
  /** Override the workspace default thinking level for the spawned session. */
  thinkingLevel?: ThinkingLevel
  /** When true, the automation-created session is in-memory only. */
  ephemeral?: boolean
  /**
   * Give this run its own isolated Git worktree instead of the live checkout.
   *
   * desktop-scheduled-tasks.md:34. Requested isolation is a REFUSAL point, not a
   * best effort: when the worktree cannot be created the run does not start, so
   * a task the user isolated never silently edits the main checkout.
   */
  worktree?: boolean
  automationName?: string
  /**
   * When false, resolve with `{ sessionId }` as soon as the session is created
   * and run the prompt fire-and-forget. The `automations.TEST` RPC uses this so
   * the request returns before the transport's 30s timeout instead of blocking
   * on the whole agent run (#736/#943). Defaults to true — the internal
   * scheduler awaits completion to write enriched per-session history.
   */
  awaitCompletion?: boolean
  /**
   * Epoch ms of the scheduled occurrence this run is catching up for
   * (desktop-scheduled-tasks.md:74). Recorded on the session's `triggeredBy` so
   * the sidebar and the run history can tell a catch-up from an on-time run.
   */
  catchUpForOccurrenceAt?: number
  /**
   * Matcher id used to write an `ok:false` automation-history entry if the
   * fire-and-forget run (`awaitCompletion === false`) fails. Ignored when
   * `awaitCompletion` is not false. On the scheduler path it is ALSO recorded on
   * the created session's `triggeredBy` (UB4.8): the loop guard matches it, so a
   * session never re-triggers its own automation.
   */
  matcherId?: string
  /**
   * UB4.8 — the event that fired this prompt and the guard's chain depth,
   * recorded on the created session's `triggeredBy` so the guard can bound
   * chains through other automations at MAX_AUTOMATION_CHAIN_DEPTH.
   */
  triggerEvent?: string
  chainDepth?: number
}

// F1.508 — declared by interface merging so no docs-cited line above moves.
export interface ISessionManager {
  /**
   * F1.508 — the scheduled plugin monitors the session's latest turn armed, for `sessions:listScheduledWork`'s
   * optional `pluginMonitors` (the panel). OPTIONAL like {@link ISessionManager.listSessionScheduledWork}; never part
   * of the hook payload. `undefined` means no session owns the id.
   */
  listArmedScheduledPluginMonitors?(
    sessionId: string,
    workspaceId?: string,
  ): ReadonlyArray<{ monitorId: string; cron: string; timezone?: string }> | undefined
}

// UA1.4 — declared by interface merging for F1.508's reason: no docs-cited line above moves.
export interface ISessionManager {
  /**
   * UA1.4 — subscribe to in-process session completion (the Tasks Conductor seam; v0.13.4
   * `session-manager-interface.ts` L131–135). Returns the unsubscribe function. Not a renderer event.
   */
  onSessionComplete(listener: (evt: SessionCompletionEvent) => void): () => void
  /** UA1.4 — the newest final assistant message text (NOT turn-scoped; see `SessionManager.getSessionFinalText`). */
  getSessionFinalText(sessionId: string, workspaceId?: string): string | undefined
}
// UA1.4 — imported at the end for the same reason; type-only, so no runtime cycle with SessionManager.
import type { SessionCompletionEvent } from '../sessions/SessionManager'

// UA2.1 — declared by interface merging for F1.508's reason: no docs-cited line above moves.
export interface ISessionManager {
  /**
   * UA2.1 — set the session's board column (v0.13.4 `setKanbanColumn`, Apache-2.0); `null` clears it. Independent
   * of the status. Persists, broadcasts `session_metadata_changed`, notifies the session partition.
   */
  setKanbanColumn(sessionId: string, column: string | null, workspaceId?: string): Promise<void>
}

// UA3.4 — declared by interface merging for F1.508's reason: no docs-cited line above moves.
export interface ISessionManager {
  /** UA1.6 — the reserved Task labeling (see `SessionManager.applyTaskLabel`); returns the item label id it applied. */
  applyTaskLabel(sessionId: string, opts?: { parentSessionId?: string; workspaceId?: string }): Promise<{ labelId: string } | undefined>
  /**
   * UA3.4 — promote a generate-time draft orchestrator to the orchestrator of `taskSlug` (v0.13.4). `false` when
   * the session is missing, not a draft, or bound to another slug. Throws `task-attach-connection-locked` (see
   * `SessionManager.bindManagedSessionToTask`).
   */
  adoptGeneratedTaskOrchestrator(sessionId: string, taskSlug: string, reconcile?: TaskBindReconcile, workspaceId?: string): Promise<boolean>
  /** UA3.4 — bind an existing, visible session to `taskSlug` (v0.13.4). `false` is a hard error for the caller. */
  bindExistingSessionToTask(sessionId: string, taskSlug: string, reconcile?: TaskBindReconcile, workspaceId?: string): Promise<boolean>
}
// UA3.4 — imported at the end for the same reason; type-only.
import type { TaskBindReconcile } from '../sessions/SessionManager'

// UA1.19 — declared by interface merging for F1.508's reason: no docs-cited line above moves.
export interface ISessionManager {
  /** UA1.19 — the fixed-origin t-artifacts client with the host's managed network policy (`SessionManager.createArtifactsClient`). */
  createArtifactsClient?(): TArtifactsClient
  /** UA1.23 — a preview block's Publish: the `publish_artifact` path for `sessionId`'s file (`SessionManager.publishArtifactFromUser`). */
  publishArtifactFromUser?(sessionId: string, filePath: string, workspaceId: string): Promise<ArtifactPublishFileResult>
  /** UA1.19 follow-up — the dp session state as the broker publishes it (`SessionManager.subscribeDpSessionState`); returns the unsubscribe. */
  subscribeDpSessionState?(listener: (state: 'ready' | 'needs-login' | 'unavailable') => void): () => void
}
// UA1.19 — imported at the end for the same reason; type-only.
import type { TArtifactsClient } from '@nessy-agent/shared/artifacts/t-artifacts-client'
import type { ArtifactPublishFileResult } from '@nessy-agent/shared/protocol'

// UA4.3 — declared by interface merging for F1.508's reason: no docs-cited line above moves. The Tasks Conductor's
// host (`tasks/conductor-host.ts` `ConductorSessionManager`) reads both through `HandlerDeps.sessionManager`.
export interface ISessionManager {
  /** UA3.1 — the orchestrator's total DAG node count (`SessionManager.setTaskNodeCount`); `null` clears it. */
  setTaskNodeCount(sessionId: string, count: number | null, workspaceId?: string): Promise<void>
  /** UA4.1 — `session_created` for a session created in the background (`SessionManager.announceSessionCreated`). */
  announceSessionCreated(sessionId: string, workspaceId: string): void
}

// UA7.4 — declared by interface merging for F1.508's reason: no docs-cited line above moves.
export interface ISessionManager {
  /**
   * UA7.4 — request a (re)capture of a page's poster (v0.13.4 `enqueuePageThumbnail`, Apache-2.0). Fire-and-forget;
   * a no-op on a host with no injected capturer (headless). See `SessionManager.setPageThumbnailer`.
   */
  enqueuePageThumbnail(workspaceId: string, workspaceRootPath: string, slug: string): void
}

// UA4.8 — declared by interface merging for F1.508's reason: no docs-cited line above moves.
export interface ISessionManager {
  /**
   * UA4.8 — background work the session's BACKEND holds between turns and no host map records
   * (`SessionManager.getBackendBackgroundActivity`); the Tasks Conductor's settlement gate reads it. `undefined` when
   * the session is not here. Optional: a host without it reads zero.
   */
  getBackendBackgroundActivity?(sessionId: string, workspaceId?: string): number | undefined
}

// UA4.8 follow-up — declared by interface merging for F1.508's reason: no docs-cited line above moves.
export interface ISessionManager {
  /**
   * UA4.8 follow-up — a turn runs, or a host delivery turn is due and has not started
   * (`SessionManager.hasHostTurnDueOrRunning`: a Pi background task's R86 delivery); the Tasks Conductor's settlement
   * gate reads it. `true` when the session is not here. Optional: a host without it reads `false`.
   */
  hasHostTurnDueOrRunning?(sessionId: string, workspaceId?: string): boolean
}

// UA9.3 — declared by interface merging for F1.508's reason: no docs-cited line above moves.
export interface ISessionManager {
  /**
   * UA9.3 — the host seams a workspace's page action broker runs through (`rpc/pages.ts`,
   * `SessionManager.pageActionHostPorts`). Optional: a host without them builds a broker with NO executors, so every
   * page action answers `executor-unavailable` (fail closed); render leases still work.
   */
  pageActionHostPorts?(): PageActionHostPorts
}

/** UA9.3 — what the page action broker borrows from the session host (no second MCP pool, one audit sink). */
export interface PageActionHostPorts {
  /** The workspace MCP pool registry; a page's MCP calls lease it as `page:<slug>`. */
  registry: Pick<import('../mcp/workspace-mcp-pool-registry').WorkspaceMcpPoolRegistry, 'lease'>
  /** The capability resolver and credential resolver a workspace-scope runtime is materialized with. */
  resolver: CapabilityResolver
  resolveCredential: (
    binding: import('@nessy-agent/shared/credentials').RuntimeCredentialBinding,
  ) => import('@nessy-agent/shared/credentials').ResolvedRuntimeCredential
  /** The privileged audit sink (`logs/privileged-actions.jsonl`) `runApprovedScript` reports a page script's run to. */
  audit: (event: string, payload: Record<string, unknown>) => void
}

// UA5.3 — declared by interface merging for F1.508's reason: no docs-cited line above moves.
export interface ISessionManager {
  /**
   * UA5.3 — bind a session to a project entity of its workspace, or unbind it with `null` (v0.13.4
   * `setSessionProjectId`, Apache-2.0). Never moves the session's folder (spec §12 "Rebind"). An id that names no
   * project of the workspace is refused with `project-not-found`. Persists, broadcasts `project_id_changed`, notifies
   * the session partition.
   */
  setSessionProjectId(sessionId: string, projectId: string | null, workspaceId?: string): Promise<void>
  /**
   * UA5.3 — a deleted project's sessions are unlinked (v0.13.4 `unbindProjectFromSessions`): the live ones through
   * {@link setSessionProjectId}'s path, then the ones only on disk. Returns how many were touched.
   */
  unbindProjectFromSessions(workspaceId: string, projectId: string): Promise<number>
}
