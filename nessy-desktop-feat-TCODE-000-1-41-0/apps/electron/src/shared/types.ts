// =============================================================================
// Protocol re-exports (channels, DTOs, events, wire types)
// =============================================================================
export * from '@nessy-agent/shared/protocol'

// =============================================================================
// Package re-exports (convenience for renderer imports)
// =============================================================================

// Core types
import type {
  Message as CoreMessage,
  MessageRole as CoreMessageRole,
  TypedError,
  TokenUsage as CoreTokenUsage,
  WorkspaceInfo as CoreWorkspaceInfo,
  Workspace as CoreWorkspace,
  SessionMetadata as CoreSessionMetadata,
  SessionAttachmentDto as CoreSessionAttachmentDto,
  ContentBadge,
  ToolDisplayMeta,
  AnnotationV1,
} from '@nessy-agent/core/types';

// Mode types from dedicated subpath export (avoids pulling in SDK)
import type { PermissionMode } from '@nessy-agent/shared/agent/modes';
export type { PermissionMode };
export { PERMISSION_MODE_CONFIG } from '@nessy-agent/shared/agent/modes';

// Thinking level types
import type { ThinkingLevel } from '@nessy-agent/shared/agent/thinking-levels';
export type { ThinkingLevel };
export { THINKING_LEVELS, DEFAULT_THINKING_LEVEL } from '@nessy-agent/shared/agent/thinking-levels';

// Output style types
import type { OutputStyleOption } from '@nessy-agent/shared/prompts';
export type { OutputStyleOption };

// Desktop-notification policy (three-position timing + the two alert controls)
import type {
  NotificationAlertKind,
  NotificationSettings,
  NotificationTiming,
} from '@nessy-agent/shared/config/notification-timing';
export type { NotificationAlertKind, NotificationSettings, NotificationTiming };

// Custom slash command types
import type { CustomSlashCommand, CustomSlashCommandId } from '@nessy-agent/shared/slash-commands';
export type { CustomSlashCommand, CustomSlashCommandId };

export type {
  CoreMessage as Message,
  CoreMessageRole as MessageRole,
  TypedError,
  CoreTokenUsage as TokenUsage,
  CoreWorkspaceInfo as WorkspaceInfo,
  CoreWorkspace as Workspace,
  CoreSessionMetadata as SessionMetadata,
  CoreSessionAttachmentDto as SessionAttachmentDto,
  ContentBadge,
  ToolDisplayMeta,
  AnnotationV1,
};

// Auth types for onboarding
import type { AuthState, SetupNeeds } from '@nessy-agent/shared/auth/types';
import type { AuthType } from '@nessy-agent/shared/config/types';
import type { ConfigDoctorReportV1, SettingsProvenanceReportV1 } from '@nessy-agent/shared/config/config-doctor';
import type { ProviderFlagId } from '@nessy-agent/shared/feature-flags';
export type { AuthState, SetupNeeds, AuthType };

import type {
  CapabilityCatalogChangedEvent,
  ManagedResourceRef,
  ComposerCatalogView,
  ManagedResourceEditRequest,
  ManagedResourceEditResult,
  ManagedResourcePreview,
  MutableManagedResourceRef,
  PreviewableManagedResourceRef,
  ProjectContributionReport,
  SafeCapabilityContextRef,
  SafeCapabilityDetail,
  SafeGrantTrustRequest,
  SafeManagedResourceSummary,
  SafeMarketplaceListRequest,
  SafeMarketplaceListResult,
  SafeMarketplacePluginInstallProposal,
  SafeMarketplacePluginInstallRequest,
  SafeMarketplacePluginInstallResult,
  SafeMarketplacePluginProposalRequest,
  SafeMarketplaceRegistryListResult,
  SafeMarketplaceRegistryRef,
  SafeMarketplaceRemoveRegistryResult,
  SafeMarketplaceSetRegistryAutoUpdateRequest,
  SafeMarketplaceSetRegistryAutoUpdateResult,
  SafeMarketplaceUpgradeRegistryResult,
  SafeMarketplaceAddRegistryRequest,
  SafeMarketplaceAddRegistryResult,
  SafeMarketplaceEnableOfferRequest,
  SafeWorkflowSettingsView,
  SafeWorkflowSizeGuideline,
  SafeMarketplaceSkillContentRequest,
  SafeMarketplaceDeclaredComponents,
  SafeMarketplaceDeclaredComponentsRequest,
  SafeMcpToolsResult,
  SafeNativeSourceCreateResult,
  SafePluginManagementActionRequest,
  SafePluginManagementActionResult,
  SafeRevokeTrustRequest,
  SafeTrustMutationResult,
  SafeTrustReviewsResult,
  UserCapabilityCatalog,
} from '@nessy-agent/shared/protocol/capabilities';
export type {
  CapabilityCatalogChangedEvent,
  ManagedResourceRef,
  ComposerCatalogView,
  ManagedResourceEditRequest,
  ManagedResourceEditResult,
  ManagedResourcePreview,
  MutableManagedResourceRef,
  PreviewableManagedResourceRef,
  ProjectContributionReport,
  SafeCapabilityContextRef,
  SafeCapabilityDetail,
  SafeGrantTrustRequest,
  SafeManagedResourceSummary,
  SafeMarketplaceListRequest,
  SafeMarketplaceListResult,
  SafeMarketplacePluginInstallProposal,
  SafeMarketplacePluginInstallRequest,
  SafeMarketplacePluginInstallResult,
  SafeMarketplacePluginProposalRequest,
  SafeMarketplaceRegistryListResult,
  SafeMarketplaceRegistryRef,
  SafeMarketplaceRemoveRegistryResult,
  SafeMarketplaceSetRegistryAutoUpdateRequest,
  SafeMarketplaceSetRegistryAutoUpdateResult,
  SafeMarketplaceUpgradeRegistryResult,
  SafeMarketplaceAddRegistryRequest,
  SafeMarketplaceAddRegistryResult,
  SafeMarketplaceEnableOfferRequest,
  SafeWorkflowSettingsView,
  SafeWorkflowSizeGuideline,
  SafeMarketplaceSkillContentRequest,
  SafeMarketplaceDeclaredComponents,
  SafeMarketplaceDeclaredComponentsRequest,
  SafeMcpToolsResult,
  SafeNativeSourceCreateResult,
  SafePluginManagementActionRequest,
  SafePluginManagementActionResult,
  SafeRevokeTrustRequest,
  SafeTrustMutationResult,
  SafeTrustReviewsResult,
  UserCapabilityCatalog,
};

// Credential health types
import type { CredentialHealthStatus, CredentialHealthIssue, CredentialHealthIssueType } from '@nessy-agent/shared/credentials/types';
export type { CredentialHealthStatus, CredentialHealthIssue, CredentialHealthIssueType };

// Resource bundle types (cross-workspace export/import)
import type { ExportResourcesOptions, ExportResult, ResourceImportMode, ResourceBundle, ResourceImportResult } from '@nessy-agent/shared/resources';
export type { ExportResourcesOptions, ExportResult, ResourceImportMode, ResourceBundle, ResourceImportResult };

// LLM connection types
import type { LlmConnection, LlmConnectionWithStatus, LlmAuthType, LlmProviderType, NetworkProxySettings } from '@nessy-agent/shared/config';
export type { LlmConnection, LlmConnectionWithStatus, LlmAuthType, LlmProviderType, NetworkProxySettings };

// Retention policy DTO (the age-based cleanup window, its off switch, and the
// paused/disabled warning the settings card reports).
import type { RetentionSettingsV1 } from '@nessy-agent/shared/config';
export type { RetentionSettingsV1 };

// P6.868 — the four states of `crossSessionInbound` in one read: the user value,
// the documented `unset` fourth state, an unreadable stored value, and whether
// the operator control outranks all of them.
import type { CrossSessionInboundSettingsV1, CrossSessionInboundSetting } from '@nessy-agent/shared/config';
export type { CrossSessionInboundSettingsV1, CrossSessionInboundSetting };

// P6.564 — the browser pane's download destination as the settings surface
// renders it: what config.json stores, what is actually in force, and which of
// the two layers decided.
import type { BrowserDownloadSettingsView } from '@nessy-agent/shared/config/browser-download';
export type { BrowserDownloadSettingsView };

// The built-in dp-backed MCP set (A7) as a settings surface renders it: every
// server with its effective switch, plus whether `dp` is installed at all.
import type { BuiltinDpMcpServerViewV1, BuiltinDpMcpSettingsViewV1 } from '@nessy-agent/shared/config';
export type { BuiltinDpMcpServerViewV1, BuiltinDpMcpSettingsViewV1 };

// =============================================================================
// GUI-only types (not used by server/handler code)
// =============================================================================

/**
 * Browser toolbar window IPC channels (preload <-> BrowserPaneManager).
 * Kept separate from RPC_CHANNELS because these are scoped to toolbar windows.
 */
export const BROWSER_TOOLBAR_CHANNELS = {
  NAVIGATE: 'browser-toolbar:navigate',
  GO_BACK: 'browser-toolbar:go-back',
  GO_FORWARD: 'browser-toolbar:go-forward',
  RELOAD: 'browser-toolbar:reload',
  STOP: 'browser-toolbar:stop',
  OPEN_MENU: 'browser-toolbar:open-menu',
  HIDE: 'browser-toolbar:hide',
  DESTROY: 'browser-toolbar:destroy',
  STATE_UPDATE: 'browser-toolbar:state-update',
  THEME_COLOR: 'browser-toolbar:theme-color',
} as const

/** Tool icon mapping entry from tool-icons.json (with icon resolved to data URL) */
export interface ToolIconMapping {
  id: string
  displayName: string
  /** Data URL of the icon (e.g., data:image/png;base64,...) */
  iconDataUrl: string
  commands: string[]
}

/**
 * Browser pane creation options
 */
export interface BrowserPaneCreateOptions {
  id?: string
  show?: boolean
  bindToSessionId?: string
}

/**
 * Empty-state launch request from the browser empty-state renderer.
 */
export interface BrowserEmptyStateLaunchPayload {
  route: string
  token?: string
}

/**
 * Result of browser empty-state launch handling.
 */
export interface BrowserEmptyStateLaunchResult {
  ok: boolean
  handled: boolean
  reason?: string
}

/**
 * P6.536 — what Settings shows about the built-in browser's trust store.
 *
 * `seenThisSession` is deliberately NOT persisted anywhere: it answers the
 * row's *"which origins did this session touch"* from a process-lifetime set,
 * so closing the app forgets it. A durable version of that list would be a
 * browsing history on disk, which is not what this row was asked to build.
 */
export interface BrowserOriginTrustListing {
  origins: Array<{
    origin: string
    navigation?: 'always-allow' | 'deny'
    cdp?: 'always-allow' | 'deny'
    decidedAt?: number
    lastSeenAt?: number
  }>
  seenThisSession: string[]
}

export interface SaveTextFileOptions {
  title?: string
  defaultPath?: string
  content: string
  filters?: Array<{ name: string; extensions: string[] }>
}

export interface SaveTextFileResult {
  canceled: boolean
  filePath?: string
  error?: string
}

export interface ConnectRemoteWorkspaceInput {
  name: string
  url: string
  token: string
  remoteWorkspaceId: string
}

export interface UpdateRemoteWorkspaceInput {
  workspaceId: string
  url: string
  remoteWorkspaceId: string
  token?: string
}

export interface CreateWorkspaceOnRemoteInput {
  url: string
  token: string
  name: string
}

export type TransportMode = 'local' | 'remote'

export type TransportConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'failed'

export type TransportConnectionErrorKind =
  | 'auth'
  | 'protocol'
  | 'timeout'
  | 'network'
  | 'server'
  | 'unknown'

export interface TransportConnectionError {
  kind: TransportConnectionErrorKind
  message: string
  code?: string
}

export interface TransportCloseInfo {
  code?: number
  reason?: string
  wasClean?: boolean
}

export interface TransportConnectionState {
  mode: TransportMode
  status: TransportConnectionStatus
  url: string
  attempt: number
  nextRetryInMs?: number
  lastError?: TransportConnectionError
  lastClose?: TransportCloseInfo
  /** Largest message the connected server accepts (from handshake_ack); absent for older servers */
  maxMessageBytes?: number
  updatedAt: number
}

// =============================================================================
// ElectronAPI — type-safe IPC API exposed to renderer
// =============================================================================

// Re-import types for ElectronAPI
import type { SessionAttachmentDto, WorkspaceInfo, SessionMetadata } from '@nessy-agent/core/types';
import type {
  AutomationCreateInput,
  AutomationUpdateInput,
} from '@nessy-agent/shared/automations'
import type { SessionKey } from '@nessy-agent/shared/sessions'
// P6.501 — the removal's full result, so a partial purge cannot present as a
// complete one. Type-only, so nothing new is loaded at runtime.
import type { WorkspaceDeleteResult } from '@nessy-agent/shared/workspaces'
import type { ResolvedWorkspaceAction } from '@nessy-agent/shared/config'
import type {
  SessionMemoryScope,
  SessionMemoryScopeOverride,
} from '@nessy-agent/shared/agent/memory/session-memory-scope'
// D1.215 — the runtime notices the same two verbs carry. Type-only.
import type { SessionRuntimeNoticeV1 } from '@nessy-agent/shared/protocol/session-runtime-notices'
import type { IssuedProjectHandle } from '@nessy-agent/shared/projects/project-handle-service'
import type {
  PiAgentViewControlRequestV1,
  PiAgentViewControlResultV1,
  PiAgentViewPageRequestV1,
  PiAgentViewPageV1,
  PiHarnessRuntimeControlRequestV1,
  PiHarnessRuntimeControlResultV1,
  PiHarnessRuntimeEventV1,
  PiHarnessRuntimeSnapshotResultV1,
} from '@nessy-agent/core/types'

export interface PiHarnessRuntimeElectronApi {
  getPiHarnessRuntime(session: SessionKey): Promise<PiHarnessRuntimeSnapshotResultV1>
  controlPiHarnessRuntime(request: PiHarnessRuntimeControlRequestV1): Promise<PiHarnessRuntimeControlResultV1>
  listPiAgentView(request: PiAgentViewPageRequestV1): Promise<PiAgentViewPageV1>
  controlPiAgentView(request: PiAgentViewControlRequestV1): Promise<PiAgentViewControlResultV1>
  onPiHarnessRuntimeInvalidated(callback: (value: { seq: number; event: PiHarnessRuntimeEventV1 }) => void): () => void
}

// Import protocol types used by ElectronAPI (they come through the `export *` above,
// but we need them in scope for the interface definition)
import type {
  Session,
  SessionFileHandle,
  UnreadSummary,
  CreateSessionOptions,
  FileAttachment,
  SendMessageOptions,
  QueuedMessageDto,
  FuzzyFileSearchResponse,
  GitBranchesResult,
  GitCheckoutResult,
  SessionEvent,
  PermissionResponseOptions,
  CredentialResponse,
  SessionCommand,
  ShareResult,
  RefreshTitleResult,
  FileCheckpointRevertResult,
  MemoryAppendResult,
  ShellCommandResult,
  StopAgentTaskResult,
  BackgroundInFlightTasksResult,
  BackgroundTaskOutputResult,
  ConversationRewindResult,
  RewindTrackedChangesResult,
  SideQuestionResult,
  SessionRecapResult,
  SessionHeapdumpResult,
  RuntimeSwitchResult,
  RuntimeSwitchPreview,
  FileSearchResult,
  SessionSearchResult,
  LlmConnectionSetup,
  TestLlmConnectionParams,
  TestLlmConnectionResult,
  SessionFile,
  OAuthResult,
  GitBashStatus,
  ClaudeOAuthResult,
  UpdateInfo,
  WorkspaceSettings,
  PermissionModeState,
  BrowserInstanceInfo,
  DeepLinkNavigation,
  TestAutomationPayload,
  TestAutomationResult,
  SafeAutomationsConfig,
  SafeAutomationHistoryEntry,
  SafeAutomationMutationResult,
  WindowCloseRequest,
  DirectoryListingResult,
  RemoteSessionTransferPayload,
  ImportRemoteSessionTransferResult,
  SessionTranscriptExportResult,
  RefreshContextUsageResult,
  DpAuthRequestArgs,
  DpAuthResult,
  DpAuthStatusEvent,
  OAuthFailureCode,
  SafePluginRuntimeRefreshResult,
  ConnectionProvenanceV1,
  SessionScheduledWorkPageV1,
} from '@nessy-agent/shared/protocol'
// P6.411 — a TYPE-only import, so `views.ts`'s two runtime imports never reach
// the preload bundle. The record is already path-free: keys, a logical name and
// a reason VALUE.
import type { RuntimeWithheldCapability } from '@nessy-agent/shared/capabilities/views'
export type { RuntimeWithheldCapability }
// P6.318 — the two save locations, from the module that implements both.
import type { WorkflowSaveScope } from '@nessy-agent/shared/workflows/workflow-loader'
export type { WorkflowSaveScope }
// P6.711 — the reconnect verdict, from the pool that mints it. A union of
// four named refusals plus `ok`, so the renderer states what happened rather
// than inventing a sentence for a rejected promise.
import type { McpReconnectResult, McpServerStatusLine } from '@nessy-agent/shared/mcp'
export type { McpReconnectResult, McpServerStatusLine }

/** Native window material the renderer may paint translucently over (see ThemeContext data-vibrancy). */
export type WindowVibrancy = 'under-window' | 'mica'

export interface ElectronAPI {
  // Session management
  getSessions(): Promise<Session[]>
  getUnreadSummary(): Promise<UnreadSummary>
  markAllSessionsRead(workspaceId: string): Promise<void>
  getSessionMessages(sessionId: string): Promise<Session | null>
  createSession(workspaceId: string, options?: CreateSessionOptions): Promise<Session>
  deleteSession(sessionId: string): Promise<void>
  sendMessage(sessionId: string, message: string, attachments?: FileAttachment[], attachmentRefs?: SessionAttachmentDto[], options?: SendMessageOptions, customSlashCommandId?: CustomSlashCommandId): Promise<void>
  cancelProcessing(sessionId: string, silent?: boolean): Promise<void>
  fuzzyFileSearch(sessionId: string, query: string): Promise<FuzzyFileSearchResponse | null>
  queueGet(sessionId: string): Promise<{ queue: QueuedMessageDto[]; paused: boolean }>
  queueDelete(sessionId: string, messageId: string): Promise<void>
  /** P6.51 — move a queued message to `toIndex`. The server queue's order is the send order. */
  queueReorder(sessionId: string, messageId: string, toIndex: number): Promise<void>
  queueSendNow(sessionId: string, messageId: string): Promise<void>
  queueResume(sessionId: string): Promise<void>
  gitBranches(sessionId: string): Promise<GitBranchesResult>
  gitCheckout(sessionId: string, branch: string, autoStash?: boolean): Promise<GitCheckoutResult>
  killShell(sessionId: string, shellId: string): Promise<{ success: boolean; error?: string }>
  /**
   * Stop a background agent task. `success: false` carries a stable `reason` code
   * the renderer translates — never a backend sentence to show verbatim.
   */
  stopAgentTask(sessionId: string, taskId: string): Promise<StopAgentTaskResult>
  /**
   * L9 — read a running background task's output, by session and id, from an
   * optional byte `cursor`. `success: false` carries a stable `reason` code the
   * renderer translates; `success: true` with an empty `output` means the task has
   * printed nothing yet, which is a different fact and must read differently.
   *
   * NOT `getTaskOutput` below: that one is filled only by `task_completed`, the
   * same event that retires the row, so it returns `null` for every task a user
   * can still see.
   */
  readBackgroundTaskOutput(sessionId: string, taskId: string, cursor?: number): Promise<BackgroundTaskOutputResult>
  getTaskOutput(taskId: string): Promise<string | null>
  respondToPermission(sessionId: string, requestId: string, allowed: boolean, alwaysAllow: boolean, options?: PermissionResponseOptions): Promise<boolean>
  revokeFilesystemRoot(sessionId: string, receiptId: string): Promise<boolean>
  respondToCredential(sessionId: string, requestId: string, response: CredentialResponse): Promise<boolean>

  // Consolidated session command handler. NOTE: this union is hand-written and is NOT covered
  // by the `export *` on line 4 — a new command's result type must be added here explicitly.
  sessionCommand(sessionId: string, command: { type: 'markPendingPlanExecutionDispatched' }): Promise<boolean> // F1.241 — the plan-dispatch claim
  sessionCommand(sessionId: string, command: SessionCommand): Promise<void | ShareResult | RefreshTitleResult | FileCheckpointRevertResult | MemoryAppendResult | ShellCommandResult | ConversationRewindResult | RewindTrackedChangesResult | SessionTranscriptExportResult | RefreshContextUsageResult | SideQuestionResult | SessionRecapResult | SessionHeapdumpResult | RuntimeSwitchResult | RuntimeSwitchPreview | BackgroundInFlightTasksResult | { count: number }>

  // Server info (REMOTE_ELIGIBLE — returns data from whichever server owns the workspace)
  getServerHomeDir(): Promise<string>

  // Server mode configuration
  getServerConfig(): Promise<import('@nessy-agent/shared/config/server-config').ServerConfig>
  setServerConfig(config: import('@nessy-agent/shared/config/server-config').ServerConfig): Promise<void>
  getServerStatus(): Promise<import('@nessy-agent/shared/config/server-config').ServerStatus>

  // App lifecycle
  /**
   * Restart the app.
   *
   * P6.451 — `safeMode` carries the posture across the restart: `true` enters
   * safe mode, `false` leaves it (clearing both accepted spellings, so a
   * session started by a wrapper that exported the Claude alias can get back
   * out), and OMITTING it leaves the posture exactly as it is — which is what
   * every caller predating this row means. The banner reads the result through
   * `isSafeModeSession`.
   */
  relaunchApp(options?: { safeMode?: boolean }): Promise<void>
  /**
   * P6.501 — the full delete result. `deleted` says the registry entry is gone;
   * `cleanupFailures` names the records that survived it, so a partial purge
   * cannot present as a complete one.
   */
  removeWorkspace(workspaceId: string): Promise<WorkspaceDeleteResult>

  // Remote session transfer (main-process orchestrated, supports chunked upload)
  transferSessionToWorkspace(sessionId: string, targetWorkspaceId: string, sessionIndex?: number, sessionCount?: number): Promise<{ sessionId: string }>
  onTransferProgress(callback: (progress: { sessionIndex: number; sessionCount: number; chunkSent: number; chunkTotal: number }) => void): () => void

  // Session export/import (cross-workspace transfer)
  exportSession(sessionId: string): Promise<unknown>
  importSession(targetWorkspaceId: string, bundle: unknown, mode: 'move' | 'fork'): Promise<{ sessionId: string; warnings?: string[] }>
  exportRemoteSessionTransfer(sessionId: string): Promise<RemoteSessionTransferPayload>
  importRemoteSessionTransfer(targetWorkspaceId: string, payload: RemoteSessionTransferPayload): Promise<ImportRemoteSessionTransferResult>
  importResourcesIntoRemoteWorkspace(targetWorkspaceId: string, bundle: unknown, mode: ResourceImportMode): Promise<ResourceImportResult>

  // Pending plan execution (for reload recovery)
  getPendingPlanExecution(sessionId: string): Promise<{ draftInputSnapshot?: string; awaitingCompaction: boolean; executionDispatched: boolean } | null>
  // Permission mode reconciliation
  getSessionPermissionModeState(sessionId: string): Promise<PermissionModeState | null>
  /**
   * P6.411 — every capability this session's resolution deliberately withheld,
   * with the reason. Empty until the session has resolved a turn at least once,
   * and empty for an unknown session: before any resolution nothing has been
   * withheld, because nothing has been decided.
   *
   * The LOADED half is deliberately absent — the renderer already reads the
   * capability catalog, and a second copy would be a second thing to keep in
   * step with it.
   */
  getSessionCapabilityInventory(sessionId: string): Promise<readonly RuntimeWithheldCapability[]>
  /**
   * D1.97 + D1.98 — ONE flat list of everything this session has queued: the
   * cron records it will run later and the background work (watches included)
   * it is running now.
   *
   * The page distinguishes THREE answers a caller must not merge — an empty
   * list, `unavailable: 'not-supported'` from a host whose session manager does
   * not implement the accessor, and `unavailable: 'session-not-found'` — so a
   * surface can never say "nothing is running" about a session it never asked
   * about. A watch is `type: 'monitor'`, the spelling `hooks.md`'s
   * `background_tasks[]` contract uses; there is no `watch` type and there must
   * not be one.
   */
  listSessionScheduledWork(sessionId: string): Promise<SessionScheduledWorkPageV1>
  /**
   * P6.711 — restart ONE of this session's MCP servers, addressed by its WIRE
   * name (the pool's slug), not its display name.
   *
   * Resolves with a verdict rather than rejecting: `unknown-server` (this
   * session's pool does not hold that slug — the honest answer when the panel,
   * which carries no live pool state, offers the action on a row no session is
   * using), `no-config` (nothing desires it any more), `in-process` (an API
   * source with no transport to drop) and `failed` (the redial was attempted
   * and did not come up, `detail` carrying the redacted reason). A caller that
   * collapses the four into "it did not work" throws away the only part the
   * user can act on.
   */
  reconnectSessionMcpServer(sessionId: string, slug: string): Promise<McpReconnectResult>
  /**
   * P6.750 — the LIVE state of this session's MCP servers, one line per server,
   * for a panel whose rows are otherwise built from stored config alone.
   *
   * The same shape and the same producer `/mcp` prints from: on claude it is the
   * CHILD's own belief (with the child's own failure reason), and
   * everywhere else it is the session's pool. A failed server, one waiting on a
   * sign-in and a connected server with zero tools are the three states the
   * panel could not tell from a healthy one.
   *
   * `null` — never a rejection — when the session has no inventory source at
   * all: no backend built yet and no pool. `[]` means asked, and there are none.
   * A caller that merges the two reports "this session has no MCP servers" for a
   * session nobody has looked at yet.
   */
  getSessionMcpServerStatuses(sessionId: string): Promise<readonly McpServerStatusLine[] | null>
  /**
   * P6.318 — keep this run: write the workflow the session just executed into
   * the project or the personal location (`CONFIG_DIR/workflows`), so `/<name>`
   * dispatches it in a later session.
   *
   * REJECTS rather than returning a failure shape, and the message is the
   * point: a runtime that cannot dispatch a recipe, a host with workflows off
   * and a project scope with no trusted directory each say so by name. Callers
   * must not offer the action to a runtime `runtimeDispatchesWorkflows` refuses
   * — the refusal here is the backstop, not the affordance.
   */
  saveSessionWorkflowRecipe(
    sessionId: string,
    source: string,
    scope: WorkflowSaveScope,
  ): Promise<{ path: string }>

  // Workspace management
  getWorkspaces(): Promise<WorkspaceInfo[]>
  createWorkspace(name: string): Promise<WorkspaceInfo>
  connectRemoteWorkspace(input: ConnectRemoteWorkspaceInput): Promise<WorkspaceInfo>
  updateRemoteWorkspace(input: UpdateRemoteWorkspaceInput): Promise<WorkspaceInfo>
  createWorkspaceOnRemote(input: CreateWorkspaceOnRemoteInput): Promise<WorkspaceInfo>
  pickLocalProjectDirectory(workspaceId: string): Promise<IssuedProjectHandle | null>
  validateProjectDirectory(input: { workspaceId: string; candidatePath: string }): Promise<IssuedProjectHandle>
  listRecentProjects(workspaceId: string): Promise<import('@nessy-agent/shared/protocol').RecentProjectSummary[]>
  issueRecentProjectHandle(input: { workspaceId: string; recentProjectId: string }): Promise<IssuedProjectHandle>
  setProjectTrust(input: import('@nessy-agent/shared/protocol').SetProjectTrustInput): Promise<IssuedProjectHandle>
  setSessionProject(input: import('@nessy-agent/shared/protocol').SetSessionProjectInput): Promise<Session>
  setWorkspaceDefaultProject(input: import('@nessy-agent/shared/protocol').SetWorkspaceDefaultProjectInput): Promise<WorkspaceInfo>

  // Server-level workspace operations (for thin client / remote workspace discovery)
  getServerWorkspaces(): Promise<WorkspaceInfo[]>
  createServerWorkspace(name: string): Promise<WorkspaceInfo>

  testRemoteConnection(url: string, token: string): Promise<{
    ok: boolean
    error?: string
    needsWorkspace?: boolean
    remoteWorkspaces?: Array<{ id: string; name: string }>
    remoteWorkspaceId?: string   // auto-set when exactly one workspace
    remoteWorkspaceName?: string // auto-set when exactly one workspace
    serverVersion?: string       // server app version from handshake
  }>

  // Window management
  getWindowWorkspace(): Promise<string | null>
  getWindowMode(): Promise<string | null>
  openWorkspace(workspaceId: string): Promise<void>
  openSessionInNewWindow(workspaceId: string, sessionId: string): Promise<void>
  switchWorkspace(workspaceId: string): Promise<void>
  closeWindow(): Promise<void>
  confirmCloseWindow(): Promise<void>
  /** Cancel a pending close request (renderer handled it by closing a modal/panel). */
  cancelCloseWindow(): Promise<void>
  /** Listen for close requests and receive source metadata. Returns cleanup function. */
  onCloseRequested(callback: (request: WindowCloseRequest) => void): () => void
  /** Show/hide macOS traffic light buttons (for fullscreen overlays) */
  setTrafficLightsVisible(visible: boolean): Promise<void>

  // Event listeners
  onSessionEvent(callback: (event: SessionEvent) => void): () => void
  onUnreadSummaryChanged(callback: (summary: UnreadSummary) => void): () => void

  // File operations
  readFile(path: string): Promise<string>
  /** Read a file as binary data (Uint8Array) */
  readFileBinary(path: string): Promise<Uint8Array>
  /** Read a file as a data URL (data:{mime};base64,...) for binary preview (images, PDFs) */
  readFileDataUrl(path: string): Promise<string>
  /** Read an image file as a size-bounded preview data URL for lightweight thumbnail rendering. */
  readFilePreviewDataUrl(path: string, maxSize?: number): Promise<string>
  openFileDialog(): Promise<string[]>
  saveTextFile(options: SaveTextFileOptions): Promise<SaveTextFileResult>
  readFileAttachment(path: string): Promise<FileAttachment | null>
  /** Re-read a user-attached file by absolute path (bypasses workspace-dir validation).
   *  Used only by draft hydration for paths the user explicitly picked via OS dialog / drag. */
  readUserAttachment(path: string): Promise<FileAttachment | null>
  storeAttachment(sessionId: string, attachment: FileAttachment): Promise<SessionAttachmentDto>
  generateThumbnail(base64: string, mimeType: string): Promise<string | null>
  /** Returns the absolute filesystem path for a File (only works for file-picker / OS-drag Files). */
  getFilePath(file: File): string | null

  // Filesystem search (for @ mention file selection)
  searchFiles(basePath: string, query: string): Promise<FileSearchResult[]>

  // Server filesystem browsing (remote mode)
  listServerDirectory(dirPath: string): Promise<DirectoryListingResult>
  // Debug: send renderer logs to main process log file
  debugLog(...args: unknown[]): void

  // Theme
  getSystemTheme(): Promise<boolean>
  onSystemThemeChange(callback: (isDark: boolean) => void): () => void

  // System
  getVersions(): { node: string; chrome: string; electron: string }
  /** Returns the renderer host environment without going through RPC. */
  getRuntimeEnvironment(): 'electron' | 'web'
  getHomeDir(): Promise<string>
  isDebugMode(): Promise<boolean>

  // Transport connection status (preload-local, not RPC channels)
  getTransportConnectionState(): Promise<TransportConnectionState>
  onTransportConnectionStateChanged(callback: (state: TransportConnectionState) => void): () => void
  reconnectTransport(): Promise<void>

  /** Fired after a WebSocket reconnect. isStale=true means buffer was evicted — full refresh needed. */
  onReconnected(callback: (isStale: boolean) => void): () => void

  /** Check whether the server registered a handler for a given RPC channel. */
  isChannelAvailable(channel: string): boolean

  // Auto-update
  checkForUpdates(): Promise<UpdateInfo>
  getUpdateInfo(): Promise<UpdateInfo>
  installUpdate(): Promise<void>
  dismissUpdate(version: string): Promise<void>
  getDismissedUpdateVersion(): Promise<string | null>
  onUpdateAvailable(callback: (info: UpdateInfo) => void): () => void
  onUpdateDownloadProgress(callback: (progress: number) => void): () => void

  // Release notes
  getReleaseNotes(): Promise<string>
  getLatestReleaseVersion(): Promise<string | undefined>

  // System warnings (startup checks)
  getSystemWarnings(): Promise<{ vcredistMissing: boolean; downloadUrl?: string }>

  /**
   * Safe mode (`env-vars.md:318`) — this session loaded no third-party code.
   * Synchronous and env-derived like `getRuntimeEnvironment`: the posture is
   * fixed for the life of the process, so there is nothing to subscribe to.
   * Optional so a pre-existing preload/thin-client build stays type-valid.
   */
  isSafeModeSession?(): boolean

  // Shell operations
  openUrl(url: string): Promise<void>
  openFile(path: string): Promise<void>
  showInFolder(path: string): Promise<void>

  // Menu event listeners
  onMenuNewChat(callback: () => void): () => void
  onMenuOpenSettings(callback: () => void): () => void
  onMenuKeyboardShortcuts(callback: () => void): () => void
  onMenuToggleFocusMode(callback: () => void): () => void
  onMenuToggleSidebar(callback: () => void): () => void

  // Deep link navigation listener (for external nessy:// URLs)
  onDeepLinkNavigate(callback: (nav: DeepLinkNavigation) => void): () => void

  // Auth
  showLogoutConfirmation(): Promise<boolean>
  showDeleteSessionConfirmation(name: string, sessionId?: string): Promise<boolean> // UA3.8 — sessionId lets the host name a task folder the delete removes
  logout(): Promise<void>

  // Credential health check (startup validation)
  getCredentialHealth(): Promise<CredentialHealthStatus>

  // Onboarding
  getAuthState(): Promise<AuthState>
  getSetupNeeds(): Promise<SetupNeeds>
  startWorkspaceMcpOAuth(mcpUrl: string): Promise<OAuthResult & { clientId?: string }>
  // Claude OAuth (two-step flow)
  startClaudeOAuth(): Promise<{ success: boolean; authUrl?: string; error?: string }>
  exchangeClaudeCode(code: string, connectionSlug: string): Promise<ClaudeOAuthResult>
  hasClaudeOAuthState(): Promise<boolean>
  clearClaudeOAuthState(): Promise<{ success: boolean }>
  /** Defer onboarding setup — user chose "Setup later" */
  deferSetup(): Promise<{ success: boolean }>
  getNessyGatewayJwt?(): Promise<{ jwt: string } | null>
  /** One-click Nessy Gateway auth (dp → exchange → creds). Never returns the JWT. */
  ensureGatewayAuth?(): Promise<{ ok: true; username: string } | { ok: false; code: string }>
  /** Abort a pending gateway auth run (kills a waiting `dp auth login`). */
  cancelGatewayAuth?(): Promise<void>
  /** Subscribe to gateway auth status codes; returns an unsubscribe. */
  onGatewayAuthStatus?(callback: (status: string) => void): () => void
  /** Whether the Codex runtime feature flag is enabled (gates the Codex gateway card). */
  isCodexRuntimeEnabled?(): Promise<boolean>
  /** Build-time provider gating: which onboarding/settings provider cards are offered. */
  getProviderFlags?(): Promise<Record<ProviderFlagId, boolean>>

  // ChatGPT OAuth (for Codex chatgptAuthTokens mode)
  startChatGptOAuth(connectionSlug: string): Promise<{ success: boolean; error?: string }>
  cancelChatGptOAuth(): Promise<{ success: boolean }>
  getChatGptAuthStatus(connectionSlug: string): Promise<{ authenticated: boolean; expiresAt?: number; hasRefreshToken?: boolean }>
  chatGptLogout(connectionSlug: string): Promise<{ success: boolean }>

  /** Unified LLM connection setup */
  setupLlmConnection(setup: LlmConnectionSetup): Promise<{ success: boolean; error?: string }>
  /** Unified connection test — spawns a lightweight agent subprocess to validate credentials */
  testLlmConnectionSetup(params: TestLlmConnectionParams): Promise<TestLlmConnectionResult>
  // Pi provider discovery (main process only — Pi SDK can't run in renderer)
  getPiApiKeyProviders(): Promise<Array<{ key: string; label: string; placeholder: string }>>
  getPiProviderBaseUrl(provider: string): Promise<string | undefined>
  getPiProviderModels(provider: string): Promise<{ models: Array<{ id: string; name: string; costInput: number; costOutput: number; contextWindow: number; reasoning: boolean }>; totalCount: number }>

  // Session-specific model (overrides global)
  getSessionModel(sessionId: string, workspaceId: string): Promise<string | null>
  /** Read-only: the session agent's recent subprocess stderr (~8KB). */
  getSessionRecentStderr(sessionId: string, workspaceId: string): Promise<string>
  /**
   * P6.510 — arm one or more connected MCP servers to interject in THIS session
   * only. Additive and idempotent; resolves with the session's whole armed set,
   * sorted. The grant dies with the session, and an administrator's
   * `allowedChannelServers` / `channelsEnabled` still bound it on every read.
   */
  armSessionChannelSources(sessionId: string, workspaceId: string, sources: readonly string[]): Promise<readonly string[]>
  /** P6.510 — drop this session's own arming; the app-wide preference is untouched. */
  disarmSessionChannelSources(sessionId: string, workspaceId: string): Promise<void>
  /**
   * P6.361 — the saved actions this install declares, already resolved for this
   * host's interpreter and already EMPTY when the operator kill switch
   * (`disableSkillShellExecution`) is on.
   */
  listWorkspaceActions(): Promise<readonly ResolvedWorkspaceAction[]>
  /**
   * P6.361 — run one saved action by id, on the same approval path the agent's
   * own Bash takes. Rejects when the id is unknown or actions are turned off;
   * the result is `runShellCommand`'s, so a refusal arrives as
   * `blocked: true` with a reason rather than as a throw.
   */
  runWorkspaceAction(sessionId: string, workspaceId: string, actionId: string): Promise<ShellCommandResult>
  /**
   * P6.703 — this chat's memory scope: the stored override AND the effective
   * scope. Both, because "off" and "following the app-wide setting" must not
   * render the same.
   */
  getSessionMemoryScope(sessionId: string, workspaceId: string): Promise<{
    scope: SessionMemoryScope
    override: SessionMemoryScopeOverride
    notices?: readonly SessionRuntimeNoticeV1[]
  }>
  /** P6.703 — set this chat's override. An absent axis means "follow the app-wide setting". */
  setSessionMemoryScope(sessionId: string, workspaceId: string, override: SessionMemoryScopeOverride): Promise<{
    scope: SessionMemoryScope
    override: SessionMemoryScopeOverride
    notices?: readonly SessionRuntimeNoticeV1[]
  }>
  setSessionModel(sessionId: string, workspaceId: string, model: string | null, connection?: string): Promise<void>

  // Workspace Settings (per-workspace configuration)
  getWorkspaceSettings(workspaceId: string): Promise<WorkspaceSettings | null>
  updateWorkspaceSetting<K extends keyof WorkspaceSettings>(workspaceId: string, key: K, value: WorkspaceSettings[K]): Promise<void>
  listCustomSlashCommands(session: SessionKey): Promise<CustomSlashCommand[]>

  // Folder dialog. `options.title` (P6.623) is the dialog's own title; omitted,
  // it keeps the working-directory picker's wording. The renderer supplies a
  // translated string, because the handler has no `t()`.
  openFolderDialog(options?: { title?: string }): Promise<string | null>

  // User Preferences
  readPreferences(): Promise<{ content: string; exists: boolean }>
  writePreferences(content: string): Promise<{ success: boolean; error?: string }>

  // Plugins
  plugin: {
    manage(request: SafePluginManagementActionRequest): Promise<SafePluginManagementActionResult>
  }

  marketplace: {
    list(params: SafeMarketplaceListRequest): Promise<SafeMarketplaceListResult>
    /** Raw SKILL.md body for one market skill; null when unavailable (fail-soft). */
    content(params: SafeMarketplaceSkillContentRequest): Promise<string | null>
    /**
     * Component KINDS one not-yet-installed listing declares (D3). Fail-soft:
     * `{ known: false }` means the listing does not say — never "ships nothing".
     */
    components(params: SafeMarketplaceDeclaredComponentsRequest): Promise<SafeMarketplaceDeclaredComponents>
    proposeInstall(params: SafeMarketplacePluginProposalRequest): Promise<SafeMarketplacePluginInstallProposal>
    /** Opens the native MCPB picker and returns only an opaque install proposal. */
    proposeMcpb(): Promise<SafeMarketplacePluginInstallProposal | null>
    install(params: SafeMarketplacePluginInstallRequest): Promise<SafeMarketplacePluginInstallResult>
    addRegistry(params: SafeMarketplaceAddRegistryRequest): Promise<SafeMarketplaceAddRegistryResult>
    upgradeRegistry(params: SafeMarketplaceRegistryRef): Promise<SafeMarketplaceUpgradeRegistryResult>
    removeRegistry(params: SafeMarketplaceRegistryRef): Promise<SafeMarketplaceRemoveRegistryResult>
    listRegistries(): Promise<SafeMarketplaceRegistryListResult>
    /** `plugins/install.md#turn-auto-update-on-or-off-for-a-marketplace` — per-marketplace Enable/Disable auto-update. */
    setRegistryAutoUpdate(
      params: SafeMarketplaceSetRegistryAutoUpdateRequest,
    ): Promise<SafeMarketplaceSetRegistryAutoUpdateResult>
    /**
     * P6.517 / P6.518 — turn on a built-in catalog that ships present but off.
     * Name only: the source is pinned server-side and cannot be supplied here.
     */
    enableOffer(params: SafeMarketplaceEnableOfferRequest): Promise<SafeMarketplaceAddRegistryResult>
    /**
     * P6.563 — the Plugins page's Refresh-runtime action, which before this had
     * no server side at all. Answers what the refresh DID (`applied` /
     * `deferred` / `untouched`) so the toast reports the server's verdict
     * instead of asserting a refresh happened.
     */
    refreshRuntime(params?: { workspaceId?: string }): Promise<SafePluginRuntimeRefreshResult>
  }

  capabilities: {
    getCatalog(context: SafeCapabilityContextRef): Promise<UserCapabilityCatalog>
    getComposerCatalog(context: SafeCapabilityContextRef): Promise<ComposerCatalogView>
    getDetail(context: SafeCapabilityContextRef, capabilityKey: string): Promise<SafeCapabilityDetail>
    listMcpTools(context: SafeCapabilityContextRef, capabilityKey: string, peek?: boolean): Promise<SafeMcpToolsResult>
    preview(context: SafeCapabilityContextRef, resource: PreviewableManagedResourceRef): Promise<ManagedResourcePreview>
    summary(context: SafeCapabilityContextRef, resource: ManagedResourceRef): Promise<SafeManagedResourceSummary>
    open(context: SafeCapabilityContextRef, resource: MutableManagedResourceRef): Promise<void>
    reveal(context: SafeCapabilityContextRef, capabilityKey: string): Promise<void>
    submitManagedEdit(request: ManagedResourceEditRequest): Promise<ManagedResourceEditResult>
    onChanged(callback: (event: CapabilityCatalogChangedEvent) => void): () => void
    listTrustReviews(context: SafeCapabilityContextRef): Promise<SafeTrustReviewsResult>
    grantTrust(request: SafeGrantTrustRequest): Promise<SafeTrustMutationResult>
    revokeTrust(request: SafeRevokeTrustRequest): Promise<SafeTrustMutationResult>
    /** Read-only, path-free report of what the ref's project would contribute if trusted. */
    detectProjectContributions(context: SafeCapabilityContextRef, options?: { runtimeSessionId?: string }): Promise<ProjectContributionReport>
  }

  // Session Drafts (persisted composer state — text + attachment refs).
  // drafts.json is a single global file keyed by composite {workspaceId, sessionId},
  // so every call carries the window's workspaceId alongside the bare sessionId.
  getDraft(sessionId: string, workspaceId: string): Promise<import('@nessy-agent/shared/config').SessionDraft | null>
  setDraft(sessionId: string, workspaceId: string, draft: import('@nessy-agent/shared/config').SessionDraft): Promise<void>
  deleteDraft(sessionId: string, workspaceId: string): Promise<void>
  getAllDrafts(workspaceId: string): Promise<Record<string, import('@nessy-agent/shared/config').SessionDraft>>

  // Session Info Panel
  getSessionFiles(session: SessionKey): Promise<SessionFileHandle[]>
  openSessionFile(input: { session: SessionKey; handleId: string }): Promise<void>
  previewSessionFile(input: { session: SessionKey; handleId: string }): Promise<string | null>
  openSessionAttachment(input: { session: SessionKey; handleId: string }): Promise<void>
  revealSessionStorage(session: SessionKey): Promise<void>
  copySessionStoragePath(session: SessionKey): Promise<void>
  openSessionArtifact(input: { session: SessionKey; kind: 'memory' | 'plans' | 'attachments' | 'data' | 'downloads' }): Promise<void>
  getSessionNotes(sessionId: string): Promise<string>
  setSessionNotes(sessionId: string, content: string): Promise<void>
  watchSessionFiles(sessionId: string): Promise<void>
  unwatchSessionFiles(): Promise<void>
  onSessionFilesChanged(callback: (sessionId: string) => void): () => void

  // Native Source/Skill destructive mutations resolve IDs through safe detail first.
  createSource(
    workspaceId: string,
    config: Partial<import('@nessy-agent/shared/sources/types').CreateSourceInput>,
  ): Promise<SafeNativeSourceCreateResult>
  deleteSource(workspaceId: string, sourceSlug: string): Promise<void>
  getWorkspacePermissionsConfig(workspaceId: string): Promise<import('@nessy-agent/shared/agent').PermissionsConfigFile | null>
  /** P2.9 — dry-run preview of importing a Claude Code setup into the workspace (no writes). */
  previewClaudeSetupImport(workspaceId: string): Promise<import('@nessy-agent/shared/capabilities/claude-setup-import').ClaudeSetupImportPlan>
  /**
   * P2.9 — apply the Claude Code setup import into the workspace (confirmed
   * write). `plan` is the previewed plan the user confirmed; the write is pinned
   * to it so a `~/.claude` edit after the preview cannot import an unconfirmed set.
   */
  applyClaudeSetupImport(workspaceId: string, plan?: import('@nessy-agent/shared/capabilities/claude-setup-import').ClaudeSetupImportPlan): Promise<import('@nessy-agent/shared/capabilities/claude-setup-import').ClaudeSetupImportResult>
  getDefaultPermissionsConfig(): Promise<{ config: import('@nessy-agent/shared/agent').PermissionsConfigFile | null }>
  /** Whether a connected MCP server may push text into a live turn (`claude/channel`). */
  getMcpChannelPushEnabled(): Promise<boolean>
  setMcpChannelPushEnabled(enabled: boolean): Promise<void>
  /** P6.327 — the two sandbox switches behind the Process Isolation panel, as they RESOLVE. */
  getSandboxSwitches(): Promise<{
    enabled: boolean
    allowUnsandboxedCommands: boolean
    enabledManaged: boolean
    allowUnsandboxedCommandsManaged: boolean
  }>
  /** P6.327 — the two user-layer sandbox switches behind the Process Isolation panel. */
  setSandboxSwitches(next: { enabled?: boolean; allowUnsandboxedCommands?: boolean }): Promise<void>
  /**
   * T5: whether the user has accepted responsibility for `bypassPermissions`
   * on this install (`permission-modes.md`'s one-time warning dialog).
   * config.json tier — NOT reachable from `update_user_preferences` or any
   * other model-invocable tool. Only the responsibility dialog's accept path
   * (bypass-permissions-gate.ts) calls the setter.
   */
  getBypassPermissionsAcknowledged(): Promise<boolean>
  setBypassPermissionsAcknowledged(acknowledged: boolean): Promise<void>
  /** Per-profile process-isolation availability, probed at startup. Read-only. */
  getIsolationCapabilities(): Promise<import('@nessy-agent/core/types').IsolationCapabilityReportV1>
  /**
   * P6.209 (A44, A45) — the rules this installation hands the Claude Code
   * runtime's own auto-mode judge, composed exactly as they are sent.
   *
   * Read-only, and the absent setter is a decision: whether an operator may
   * edit these lists is an open owner question, and the viewer is correct
   * under either answer.
   */
  getAutoModePolicy(): Promise<import('@nessy-agent/shared/protocol/capabilities').SafeClaudeAutoModePolicyView>
  /**
   * P6.209 (A42) — what that judge REFUSED in one session, oldest first.
   *
   * Read-only and safe: the refused arguments never leave the host.
   *
   * P6.721 — the ANSWER carries the capability: `supported: false` names the
   * runtime that keeps no denial history, so an empty list can never be read as
   * "nothing was refused" by a client that forgot to check which runtime it is
   * on. Same channel, same arity — only the payload widened.
   */
  getAutoModeDenials(sessionId: string, workspaceId: string): Promise<
    import('@nessy-agent/shared/protocol/capabilities').AutoModeDenialsView
  >
  /** The built-in dp-backed MCP set with its per-server switches (A7). */
  getBuiltinDpMcpServers(): Promise<BuiltinDpMcpSettingsViewV1>
  /** Persist one built-in dp MCP server's switch. Rejects an unknown wire name. */
  setBuiltinDpMcpServerEnabled(name: string, enabled: boolean): Promise<void>

  // OAuth (server-owned credentials, client-orchestrated flow)
  performDpAuth(args: DpAuthRequestArgs, onStatus?: (status: DpAuthStatusEvent['status']) => void): Promise<DpAuthResult>
  cancelDpAuth(args: DpAuthRequestArgs): Promise<DpAuthResult>
  /** Value-only, non-interactive dp session probe (T3, plugin-install plan). */
  probeDpSession?(): Promise<import('@nessy-agent/shared/protocol').DpSessionProbeResult>
  /** T4: everything in the workspace still awaiting auth (session-start notice). */
  getWorkspacePendingAuth?(workspaceId: string): Promise<import('@nessy-agent/shared/protocol').SafeWorkspacePendingAuth>
  performOAuth(args: { workspaceId?: string; sourceSlug: string; pluginServer?: { pluginKey: string; serverName: string }; sessionId?: string; authRequestId?: string; /** UB3.10: replace the live sign-in for this source (its browser window was lost). */ restart?: boolean }): Promise<{
    success: boolean
    error?: OAuthFailureCode | 'cancelled' | 'cancel-failed' | 'settlement-failed' | (string & {})
    email?: string
  }>
  cancelOAuth(args: {
    workspaceId?: string
    sourceSlug: string
    sessionId: string
    authRequestId: string
  }): Promise<{ ok: true } | { ok: false; code: 'cancel-failed' }>
  oauthRevoke(sourceSlug: string): Promise<{ success: boolean }>
  /** UB3.10: how a joined sign-in is doing — still live, or how it ended. */
  oauthStatus(args: { flowId: string }): Promise<
    | { live: true; expiresInMs: number }
    | { live: false; outcome?: { success: boolean; error?: string; email?: string } }
  >

  // Session content search (full-text search via ripgrep)
  searchSessionContent(workspaceId: string, query: string, searchId?: string): Promise<SessionSearchResult[]>

  // Default permissions change listener (live updates when default.json changes)
  onDefaultPermissionsChanged(callback: () => void): () => void

  deleteSkill(workspaceId: string, skillSlug: string): Promise<void>

  // Statuses (workspace-scoped)
  listStatuses(workspaceId: string): Promise<import('@nessy-agent/shared/statuses').StatusConfig[]>
  reorderStatuses(workspaceId: string, orderedIds: string[]): Promise<void>
  onStatusesChanged(callback: (workspaceId: string) => void): () => void

  // Labels (workspace-scoped)
  listLabels(workspaceId: string): Promise<import('@nessy-agent/shared/labels').LabelConfig[]>
  createLabel(workspaceId: string, input: import('@nessy-agent/shared/labels').CreateLabelInput): Promise<import('@nessy-agent/shared/labels').LabelConfig>
  deleteLabel(workspaceId: string, labelId: string): Promise<{ stripped: number }>
  onLabelsChanged(callback: (workspaceId: string) => void): () => void

  // LLM connections change listener
  onLlmConnectionsChanged(callback: () => void): () => void

  // Views (workspace-scoped, stored in views.json)
  listViews(workspaceId: string): Promise<import('@nessy-agent/shared/views').ViewConfig[]>
  saveViews(workspaceId: string, views: import('@nessy-agent/shared/views').ViewConfig[]): Promise<void>

  // Generic workspace image loading/saving
  readWorkspaceImage(workspaceId: string, relativePath: string): Promise<string>
  writeWorkspaceImage(workspaceId: string, relativePath: string, base64: string, mimeType: string): Promise<void>

  // Tool icon mappings
  getToolIconMappings(): Promise<ToolIconMapping[]>

  // Theme (app-level default)
  getAppTheme(): Promise<import('@config/theme').ThemeOverrides | null>
  loadPresetThemes(): Promise<import('@config/theme').PresetTheme[]>
  loadPresetTheme(themeId: string): Promise<import('@config/theme').PresetTheme | null>
  getColorTheme(): Promise<string>
  setColorTheme(themeId: string): Promise<void>
  getWorkspaceColorTheme(workspaceId: string): Promise<string | null>
  setWorkspaceColorTheme(workspaceId: string, themeId: string | null): Promise<void>
  getAllWorkspaceThemes(): Promise<Record<string, string | undefined>>

  /**
   * Native material behind this window (macOS vibrancy, Windows 11 22H2+ Mica); null when the
   * window is opaque (upstream v0.15.1). Preload-only: UB14.47's `preload/window-vibrancy.ts` reads
   * the launch argument `main/window-material.ts` sets; the webui adapter answers null. UB13.4
   * declared it first so ThemeContext's 1:1 vibrancy gate compiled.
   */
  getWindowVibrancy(): WindowVibrancy | null

  // Theme change listeners
  onAppThemeChange(callback: (theme: import('@config/theme').ThemeOverrides | null) => void): () => void

  // Logo URL resolution
  getLogoUrl(serviceUrl: string, provider?: string): Promise<string | null>

  // Notifications
  showNotification(title: string, body: string, workspaceId: string, sessionId: string): Promise<void>
  getNotificationsEnabled(): Promise<boolean>
  setNotificationsEnabled(enabled: boolean): Promise<void>
  getNotificationSettings(): Promise<NotificationSettings>
  setNotificationSettings(settings: NotificationSettings): Promise<void>

  // Input settings
  getAutoCapitalisation(): Promise<boolean>
  setAutoCapitalisation(enabled: boolean): Promise<void>
  getSendMessageKey(): Promise<'enter' | 'cmd-enter'>
  setSendMessageKey(key: 'enter' | 'cmd-enter'): Promise<void>
  getSpellCheck(): Promise<boolean>
  setSpellCheck(enabled: boolean): Promise<void>

  // Power settings
  getKeepAwakeWhileRunning(): Promise<boolean>
  setKeepAwakeWhileRunning(enabled: boolean): Promise<void>

  // Tools settings
  getBrowserToolEnabled(): Promise<boolean>
  setBrowserToolEnabled(enabled: boolean): Promise<void>
  // P6.564 — the browser pane's download destination. Both calls answer with
  // the resolved view, so the form always learns when the environment is the
  // layer in force and which values were refused.
  getBrowserDownloadSettings(): Promise<BrowserDownloadSettingsView>
  setBrowserDownloadSettings(
    next: { root?: string; ask?: boolean },
  ): Promise<BrowserDownloadSettingsView>

  // Retention — the age-based cleanup of session data. `setRetentionDays`
  // rejects anything below the documented minimum of 1; disabling is the
  // separate off switch, never a very large window.
  getRetentionSettings(): Promise<RetentionSettingsV1>
  setRetentionDays(days: number): Promise<void>
  setRetentionSweepEnabled(enabled: boolean): Promise<void>

  // P6.868 — inbound messages from the user's own other sessions. One read for
  // all four states, because a surface that composed the layers itself would be
  // a second resolver. `null` is the documented fourth state — unset, so the two
  // sessions' permission modes decide per message — and it CLEARS the key rather
  // than storing a sentinel, so the app's "unset" and a hand-edited file's
  // "unset" stay one state.
  getCrossSessionInboundSettings(): Promise<CrossSessionInboundSettingsV1>
  setCrossSessionInbound(mode: CrossSessionInboundSetting | null): Promise<boolean>

  // Appearance settings
  getRichToolDescriptions(): Promise<boolean>
  setRichToolDescriptions(enabled: boolean): Promise<void>

  // Prompt caching & context
  getExtendedPromptCache(): Promise<boolean>
  setExtendedPromptCache(enabled: boolean): Promise<void>

  // RTK token optimization
  getRtkEnabled(): Promise<boolean>
  setRtkEnabled(enabled: boolean): Promise<void>
  // UB7.4 — the detector's shape: `outdated` marks a binary older than the safe
  // minimum (reported, never used for rewrites); `minSafeVersion` names it.
  getRtkStatus(opts?: { forceRecheck?: boolean }): Promise<{ installed: boolean; path: string | null; version: string | null; outdated: boolean; minSafeVersion: string; foundPath: string | null }>
  getRtkGain(): Promise<{ totalCommands: number; totalInput: number; totalOutput: number; totalSaved: number; avgSavingsPct: number; totalTimeMs: number; avgTimeMs: number } | null>

  // UB6.3 — Decision model (Jev): the Settings > AI card (the wire types ride
  // @nessy-agent/shared/decisions; these mirror the channel-map invokers).
  getDecisionLayerSettings(): Promise<import('@nessy-agent/shared/decisions/settings').DecisionLayerSettings>
  setDecisionLayerSettings(patch: import('@nessy-agent/shared/decisions/settings').DecisionLayerSettingsPatch): Promise<import('@nessy-agent/shared/decisions/settings').DecisionLayerSettings>
  getDecisionLayerStatus(): Promise<import('@nessy-agent/shared/decisions').DecisionLayerStatus>
  setDecisionApiKey(provider: string, apiKey: string): Promise<void>
  deleteDecisionApiKey(provider: string): Promise<boolean>
  testDecisionConnection(options?: { settings?: import('@nessy-agent/shared/decisions/settings').DecisionLayerSettingsPatch; apiKey?: string }): Promise<import('@nessy-agent/shared/decisions').DecisionTestResult>
  probeDecisionServer(options?: { baseUrl?: string }): Promise<import('@nessy-agent/shared/decisions').DecisionServerProbe>
  getDecisionUsage(): Promise<Partial<Record<import('@nessy-agent/shared/decisions/settings').DecisionLayerFeature, import('@nessy-agent/shared/decisions').DecisionToggleUsage>>>

  // Guardian safety judge
  getGuardianEnabled(): Promise<boolean>
  setGuardianEnabled(enabled: boolean): Promise<void>
  getGuardianModel(): Promise<string>
  setGuardianModel(modelId: string): Promise<void>
  /** Per-integration judge models, `connection slug → model id` (H1). */
  getGuardianModelsByConnection(): Promise<Record<string, string>>
  setGuardianModelForConnection(slug: string, modelId: string): Promise<void>

  // Advisor (P2.528). `''` on the model is "the session's own model advises",
  // the documented default; `setAdvisorModel` rejects a managed-forbidden id
  // with MODEL_RESTRICTED_BY_POLICY, exactly as the guardian write does.
  /**
   * P6.168 — the read-only settings-provenance checkup, per workspace.
   *
   * Read-only by construction (owner decision D12): there is no setter, and the
   * handler stats and parses without writing.
   */
  /**
   * P6.168's provenance report, plus P6.447's `connection` pane on the same
   * channel — the same question one layer out, and the row's own rule is that
   * it must not open a competing page. `connection` is absent when the
   * connection store could not be read, which is a different statement from a
   * connection that is not configured (`connectionSlug: null`).
   */
  getSettingsProvenance(
    workspaceId?: string,
  ): Promise<SettingsProvenanceReportV1 & { connection?: ConnectionProvenanceV1 }>
  /**
   * P6.576 — the settings-file tiers diagnosis, read-only (owner decision D12).
   *
   * The same builder `nessy-general-agent doctor` calls, so the app and the
   * terminal cannot report different things about one machine.
   *
   * **The "NARROWER input" this docblock used to describe is gone, in two
   * steps.** P6.775 corrected the first half: five collectors were said to be
   * unexported inside the CLI, which stopped being true when P6.684 and P6.760
   * moved all seven to `@nessy-agent/shared/config/doctor-collectors` — the
   * handler calls them now.
   *
   * `workspaceId` is the second half (P6.787), and it is OPTIONAL. The project
   * instruction files are measured in a DIRECTORY, so passing the workspace the
   * window has open is what adds that last section; the renderer names the
   * workspace it asked about, because a project-scoped section on an app-level
   * page that does not say which project is worse than no section. Omit the
   * argument and the report is exactly what it was — that is what the CLI's own
   * route and the playground get.
   *
   * Nothing else on the wire changes: `CHANNEL_MAP`'s `invoke()` forwards its
   * arguments verbatim, so this signature IS the contract (`listOutputStyles`
   * has taken an optional `workspaceId` the same way all along).
   */
  getConfigDoctorReport(workspaceId?: string): Promise<ConfigDoctorReportV1>
  getAdvisorEnabled(): Promise<boolean>
  setAdvisorEnabled(enabled: boolean): Promise<void>
  getAdvisorModel(): Promise<string>
  setAdvisorModel(modelId: string): Promise<void>

  // Codex's own approval reviewer (P6.225). `''` on the policy is "use codex's
  // own policy unchanged", the documented default. Unlike the advisor and
  // guardian writes there is no managed-model refusal here — there is no model
  // id, only free text appended to codex's own reviewer prompt — and neither
  // write reaches a RUNNING session: both are read when codex's config file is
  // written for the next one.
  getCodexAutoReviewEnabled(): Promise<boolean>
  setCodexAutoReviewEnabled(enabled: boolean): Promise<void>
  /** C3.286 — codex's own delegation off-switch; `false` writes `[agents] enabled = false`. */
  getCodexSubagentsEnabled(): Promise<boolean>
  setCodexSubagentsEnabled(enabled: boolean): Promise<void>
  getCodexAutoReviewPolicy(): Promise<string>
  setCodexAutoReviewPolicy(policy: string): Promise<void>

  /**
   * C3.178 — which attached folder is primary, with the set the choice is made
   * from. `choice: null` is "use the derivation", which is what an install that
   * never opened the control reports. `candidates` are the resolved
   * `additionalDirectories`; the derived root is the implicit first option.
   */
  getPrimaryDirectory(): Promise<{ choice: string | null; candidates: string[] }>
  setPrimaryDirectory(value: string | null): Promise<void>

  // Network proxy settings
  getNetworkProxySettings(): Promise<NetworkProxySettings | undefined>
  setNetworkProxySettings(settings: NetworkProxySettings): Promise<void>

  refreshBadge(): Promise<void>
  setDockIconWithBadge(dataUrl: string): Promise<void>
  onBadgeDraw(callback: (data: { count: number; iconDataUrl: string }) => void): () => void
  onBadgeDrawWindows(callback: (data: { count: number }) => void): () => void
  getWindowFocusState(): Promise<boolean>
  onWindowFocusChange(callback: (isFocused: boolean) => void): () => void
  onNotificationNavigate(callback: (data: { workspaceId: string; sessionId: string }) => void): () => void

  // Theme preferences sync across windows
  broadcastThemePreferences(preferences: { mode: string; colorTheme: string; font: string; motion?: string }): Promise<void>
  onThemePreferencesChange(callback: (preferences: { mode: string; colorTheme: string; font: string; motion?: string }) => void): () => void

  // Workspace theme sync across windows
  broadcastWorkspaceThemeChange(workspaceId: string, themeId: string | null): Promise<void>
  onWorkspaceThemeChange(callback: (data: { workspaceId: string; themeId: string | null }) => void): () => void

  // Git operations
  getGitBranch(dirPath: string): Promise<string | null>

  // Git Bash (Windows)
  checkGitBash(): Promise<GitBashStatus>
  browseForGitBash(): Promise<string | null>
  setGitBashPath(path: string): Promise<{ success: boolean; error?: string }>

  // Menu actions (from renderer to main)
  menuQuit(): Promise<void>
  menuNewWindow(): Promise<void>
  menuMinimize(): Promise<void>
  menuMaximize(): Promise<void>
  menuZoomIn(): Promise<void>
  menuZoomOut(): Promise<void>
  menuZoomReset(): Promise<void>
  menuToggleDevTools(): Promise<void>
  menuUndo(): Promise<void>
  menuRedo(): Promise<void>
  menuCut(): Promise<void>
  menuCopy(): Promise<void>
  menuPaste(): Promise<void>
  menuSelectAll(): Promise<void>

  // Browser pane management
  browserPane: {
    create(input?: string | BrowserPaneCreateOptions): Promise<string>
    destroy(id: string): Promise<void>
    list(): Promise<BrowserInstanceInfo[]>
    navigate(id: string, url: string): Promise<{ url: string; title: string }>
    goBack(id: string): Promise<void>
    goForward(id: string): Promise<void>
    reload(id: string): Promise<void>
    stop(id: string): Promise<void>
    focus(id: string): Promise<void>
    emptyStateLaunch(payload: BrowserEmptyStateLaunchPayload): Promise<BrowserEmptyStateLaunchResult>
    /**
     * P6.536 — the per-origin trust store, for Settings.
     *
     * `trustList` returns every origin with a stored verdict plus the origins
     * this run actually touched, so the settings page can answer both "what did
     * I approve" and "where has this session been".
     */
    trustList(): Promise<BrowserOriginTrustListing>
    trustRevoke(origin: string): Promise<void>
    onStateChanged(callback: (info: BrowserInstanceInfo) => void): () => void
    onRemoved(callback: (id: string) => void): () => void
    onInteracted(callback: (id: string) => void): () => void
  }

  // LLM Connections (provider configurations)
  listLlmConnections(): Promise<LlmConnection[]>
  listLlmConnectionsWithStatus(): Promise<LlmConnectionWithStatus[]>
  getLlmConnection(slug: string): Promise<LlmConnection | null>
  getLlmConnectionApiKey(slug: string): Promise<string | null>
  saveLlmConnection(connection: LlmConnection): Promise<{ success: boolean; error?: string }>
  deleteLlmConnection(slug: string): Promise<{ success: boolean; error?: string }>
  testLlmConnection(slug: string): Promise<{ success: boolean; error?: string }>
  setDefaultLlmConnection(slug: string): Promise<{ success: boolean; error?: string }>
  getDefaultThinkingLevel(): Promise<ThinkingLevel>
  setDefaultThinkingLevel(level: ThinkingLevel): Promise<{ success: boolean; error?: string }>
  getOutputStyle(): Promise<string>
  setOutputStyle(styleId: string): Promise<{ success: boolean; error?: string }>
  listOutputStyles(workspaceId?: string): Promise<OutputStyleOption[]>
  /**
   * P6.319 — the workflow governance settings, already resolved across the user,
   * managed and env layers host-side. The renderer never composes them itself.
   */
  getWorkflowSettings(): Promise<SafeWorkflowSettingsView>
  /** The one workflow key a user may set; the two off switches are read-only. */
  setWorkflowSizeGuideline(
    guideline: SafeWorkflowSizeGuideline,
  ): Promise<{ success: boolean; error?: string }>
  setWorkspaceDefaultLlmConnection(workspaceId: string, slug: string | null): Promise<{ success: boolean; error?: string }>

  // Automations
  getAutomations(workspaceId: string): Promise<SafeAutomationsConfig | null>

  // Automation testing (manual trigger)
  testAutomation(payload: TestAutomationPayload): Promise<TestAutomationResult>

  // Automation state management
  createAutomation(workspaceId: string, input: AutomationCreateInput): Promise<SafeAutomationMutationResult>
  updateAutomation(workspaceId: string, input: AutomationUpdateInput): Promise<SafeAutomationMutationResult>
  setAutomationEnabled(workspaceId: string, automationId: string, enabled: boolean): Promise<SafeAutomationMutationResult>
  duplicateAutomation(workspaceId: string, automationId: string): Promise<SafeAutomationMutationResult>
  deleteAutomation(workspaceId: string, automationId: string): Promise<void>
  getAutomationHistory(workspaceId: string, automationId: string, limit?: number): Promise<SafeAutomationHistoryEntry[]>
  getAutomationLastExecuted(workspaceId: string): Promise<Record<string, number>>
  replayAutomation(workspaceId: string, automationId: string, eventName: string): Promise<{ results: Array<{ type: string; url: string; statusCode: number; success: boolean; error?: string; duration: number }> }>
  /** UA8.3 — approve a SAVED script action's current bytes (`sha256`: the digest the row showed; a swap is refused). */
  approveAutomationScript(workspaceId: string, automationId: string, actionIndex: number, sha256?: string): Promise<import('@nessy-agent/shared/protocol').ScriptApprovalStatusDto>

  // Automations change listener
  onAutomationsChanged(callback: (workspaceId: string) => void): () => void

  // Language
  changeLanguage(lang: string): Promise<void>

  // Resources (cross-workspace export/import)
  exportResources(workspaceId: string, options: ExportResourcesOptions): Promise<ExportResult>
  importResources(workspaceId: string, bundle: ResourceBundle, mode: ResourceImportMode): Promise<ResourceImportResult>

}

// =============================================================================
// Navigation types (renderer-only)
// =============================================================================

/**
 * Right sidebar panel types
 */
export type RightSidebarPanel =
  | { type: 'files'; path?: string }
  | { type: 'history' }
  | { type: 'none' }

/**
 * Session filter options
 */
export type SessionFilter =
  | { kind: 'allSessions' }
  | { kind: 'flagged' }
  | { kind: 'state'; stateId: string }
  | { kind: 'label'; labelId: string }
  | { kind: 'view'; viewId: string }
  | { kind: 'archived' }

/**
 * Settings subpage options - re-exported from settings-registry (single source of truth)
 */
export type { SettingsSubpage } from './settings-registry'
import { isValidSettingsSubpage, type SettingsSubpage } from './settings-registry'

/**
 * Sessions navigation state
 */
export interface SessionsNavigationState {
  navigator: 'sessions'
  filter: SessionFilter
  details: { type: 'session'; sessionId: string } | null
  rightSidebar?: RightSidebarPanel
  /**
   * UA2.2 (v0.13.4) — presentation mode for the sessions navigator. `'board'` renders the Kanban
   * board (all sessions, grouped into To Do / In Progress / Done columns) in the content area
   * instead of the list + chat. Absent/`'list'` is the default.
   */
  viewMode?: 'list' | 'board'
}

/**
 * Source type filter for sources navigation.
 * `type` selects a source transport subcategory (api/mcp/local); `plugins`
 * selects installed-plugin management; `hooks` selects native project hooks.
 */
export type SourceFilter =
  | { kind: 'type'; sourceType: 'api' | 'mcp' | 'local' }
  | { kind: 'plugins' }
  | { kind: 'hooks' }

/**
 * Automation type filter for automations navigation
 */
export interface AutomationFilter {
  kind: 'type'
  automationType: 'scheduled' | 'event' | 'agentic'
}

/**
 * Sources navigation state
 */
export interface SourcesNavigationState {
  navigator: 'sources'
  filter?: SourceFilter
  details:
    | { type: 'source'; sourceSlug: string }
    | { type: 'plugin'; pluginKey: string }
    | { type: 'hooks' }
    | null
  rightSidebar?: RightSidebarPanel
}

/**
 * Settings navigation state
 *
 * `subpage: null` means the bare `settings` route — navigator-only view in compact
 * mode. On desktop, the content panel falls back to the App page so it isn't empty.
 * Sources/Skills/Automations use `details: null` for the same purpose.
 */
export interface SettingsNavigationState {
  navigator: 'settings'
  subpage: SettingsSubpage | null
  /**
   * D1.254 — the connection whose setup this route opens, for the `ai` subpage.
   *
   * It is NOT part of `getNavigationStateKey`, deliberately: the key is the
   * panel's IDENTITY, and `settings:ai` showing one connection's setup is the
   * same panel as `settings:ai` showing none. Putting the slug in the key would
   * open a second settings panel for the same page, and would make the page's
   * own act of dropping the segment look like a navigation to somewhere else.
   */
  connectionSlug?: string
  rightSidebar?: RightSidebarPanel
}

/**
 * Skills navigation state
 */
export interface SkillsNavigationState {
  navigator: 'skills'
  details: { type: 'skill'; skillSlug: string } | null
  rightSidebar?: RightSidebarPanel
}

/**
 * Automations navigation state
 */
export interface AutomationsNavigationState {
  navigator: 'automations'
  filter?: AutomationFilter
  details: { type: 'automation'; automationId: string } | null
  rightSidebar?: RightSidebarPanel
}

/**
 * Plugins navigation state
 */
export type KnowledgeNavigationState =
  | {navigator:'knowledge';rightSidebar?:RightSidebarPanel}
  | {navigator:'knowledge-chat';rightSidebar?:RightSidebarPanel}

export interface PluginsNavigationState {
  navigator: 'plugins'
  rightSidebar?: RightSidebarPanel
}

/**
 * UA7.3 (v0.13.4) — Pages navigation state
 *
 * Bare `pages` (details: null) shows the full-width library grid — it never
 * auto-selects a page. Like the Plugins view, there is no navigator list: the
 * session-list navigator collapses while a pages route is active.
 */
export interface PagesNavigationState {
  navigator: 'pages'
  details: { type: 'page'; pageSlug: string } | null
  rightSidebar?: RightSidebarPanel
}

/**
 * UA5.8 (v0.13.4) — Projects navigation state
 *
 * Bare `projects` (details: null) shows the project list in the navigator and an
 * empty content panel; `projects/project/{slug}` opens one project's page.
 */
export interface ProjectsNavigationState {
  navigator: 'projects'
  details: { type: 'project'; projectSlug: string } | null
  rightSidebar?: RightSidebarPanel
}

/**
 * Unified navigation state
 */
export type NavigationState =
  | SessionsNavigationState
  | SourcesNavigationState
  | SettingsNavigationState
  | SkillsNavigationState
  | AutomationsNavigationState
  | PluginsNavigationState
  | KnowledgeNavigationState
  | PagesNavigationState
  | ProjectsNavigationState

export const isSessionsNavigation = (
  state: NavigationState
): state is SessionsNavigationState => state.navigator === 'sessions'

export const isSourcesNavigation = (
  state: NavigationState
): state is SourcesNavigationState => state.navigator === 'sources'

export const isSettingsNavigation = (
  state: NavigationState
): state is SettingsNavigationState => state.navigator === 'settings'

export const isSkillsNavigation = (
  state: NavigationState
): state is SkillsNavigationState => state.navigator === 'skills'

export const isAutomationsNavigation = (
  state: NavigationState
): state is AutomationsNavigationState => state.navigator === 'automations'

export const isPluginsNavigation = (
  state: NavigationState
): state is PluginsNavigationState => state.navigator === 'plugins'

export const isPagesNavigation = (
  state: NavigationState
): state is PagesNavigationState => state.navigator === 'pages'

export const isProjectsNavigation = (
  state: NavigationState
): state is ProjectsNavigationState => state.navigator === 'projects'

export const DEFAULT_NAVIGATION_STATE: NavigationState = {
  navigator: 'sessions',
  filter: { kind: 'allSessions' },
  details: null,
}

export const getNavigationStateKey = (state: NavigationState): string => {
  if (state.navigator === 'sources') {
    if (state.details) {
      if (state.details.type === 'plugin') return `sources/plugins/plugin/${state.details.pluginKey}`
      if (state.details.type === 'hooks') return 'sources/hooks'
      return `sources/source/${state.details.sourceSlug}`
    }
    if (state.filter?.kind === 'plugins') return 'sources/plugins'
    if (state.filter?.kind === 'hooks') return 'sources/hooks'
    return 'sources'
  }
  if (state.navigator === 'skills') {
    if (state.details?.type === 'skill') {
      return `skills/skill/${state.details.skillSlug}`
    }
    return 'skills'
  }
  if (state.navigator === 'automations') {
    if (state.details?.type === 'automation') {
      return `automations/automation/${state.details.automationId}`
    }
    return 'automations'
  }
  if (state.navigator === 'settings') {
    if (state.subpage === null) return 'settings'
    return `settings:${state.subpage}`
  }
  if (state.navigator === 'knowledge' || state.navigator === 'knowledge-chat') return state.navigator
  if (state.navigator === 'plugins') {
    return 'plugins'
  }
  // UA7.3 (v0.13.4)
  if (state.navigator === 'pages') {
    if (state.details?.type === 'page') {
      return `pages/page/${state.details.pageSlug}`
    }
    return 'pages'
  }
  // UA5.8 (v0.13.4)
  if (state.navigator === 'projects') {
    if (state.details?.type === 'project') {
      return `projects/project/${state.details.projectSlug}`
    }
    return 'projects'
  }
  // Chats
  const f = state.filter
  let base: string
  if (f.kind === 'state') base = `state:${f.stateId}`
  else if (f.kind === 'label') base = `label:${f.labelId}`
  else if (f.kind === 'view') base = `view:${f.viewId}`
  else base = f.kind
  if (state.details) {
    return `${base}/chat/${state.details.sessionId}`
  }
  return base
}

export const parseNavigationStateKey = (key: string): NavigationState | null => {
  // Handle sources
  if (key === 'sources') return { navigator: 'sources', details: null }
  if (key === 'sources/plugins') return { navigator: 'sources', filter: { kind: 'plugins' }, details: null }
  if (key === 'sources/hooks') {
    return { navigator: 'sources', filter: { kind: 'hooks' }, details: { type: 'hooks' } }
  }
  if (key.startsWith('sources/plugins/plugin/')) {
    const pluginKey = key.slice(23)
    if (pluginKey) {
      return { navigator: 'sources', filter: { kind: 'plugins' }, details: { type: 'plugin', pluginKey } }
    }
    return { navigator: 'sources', filter: { kind: 'plugins' }, details: null }
  }
  if (key.startsWith('sources/source/')) {
    const sourceSlug = key.slice(15)
    if (sourceSlug) {
      return { navigator: 'sources', details: { type: 'source', sourceSlug } }
    }
    return { navigator: 'sources', details: null }
  }

  // Handle skills
  if (key === 'skills') return { navigator: 'skills', details: null }
  if (key.startsWith('skills/skill/')) {
    const skillSlug = key.slice(13)
    if (skillSlug) {
      return { navigator: 'skills', details: { type: 'skill', skillSlug } }
    }
    return { navigator: 'skills', details: null }
  }

  // Handle automations
  if (key === 'automations') return { navigator: 'automations', details: null }
  if (key.startsWith('automations/automation/')) {
    const automationId = key.slice(23) // F1.254 — the prefix is 23 characters; 22 kept a leading '/'
    if (automationId) {
      return { navigator: 'automations', details: { type: 'automation', automationId } }
    }
    return { navigator: 'automations', details: null }
  }

  // Handle settings
  if (key === 'settings') return { navigator: 'settings', subpage: null }
  if (key.startsWith('settings:')) {
    const subpage = key.slice(9)
    if (isValidSettingsSubpage(subpage)) {
      return { navigator: 'settings', subpage }
    }
  }

  // Handle plugins
  if (key === 'knowledge' || key === 'knowledge-chat') return { navigator: key }
  if (key === 'plugins') return { navigator: 'plugins' }

  // UA7.3 (v0.13.4) — handle pages
  if (key === 'pages') return { navigator: 'pages', details: null }
  if (key.startsWith('pages/page/')) {
    const pageSlug = key.slice(11)
    if (pageSlug) {
      return { navigator: 'pages', details: { type: 'page', pageSlug } }
    }
    return { navigator: 'pages', details: null }
  }

  // UA5.8 (v0.13.4) — handle projects
  if (key === 'projects') return { navigator: 'projects', details: null }
  if (key.startsWith('projects/project/')) {
    const projectSlug = key.slice(17)
    if (projectSlug) {
      return { navigator: 'projects', details: { type: 'project', projectSlug } }
    }
    return { navigator: 'projects', details: null }
  }

  // Handle sessions
  const parseSessionsKey = (filterKey: string, sessionId?: string): NavigationState | null => {
    let filter: SessionFilter
    if (filterKey === 'allSessions') filter = { kind: 'allSessions' }
    else if (filterKey === 'flagged') filter = { kind: 'flagged' }
    else if (filterKey === 'archived') filter = { kind: 'archived' }
    else if (filterKey.startsWith('state:')) {
      const stateId = filterKey.slice(6)
      if (!stateId) return null
      filter = { kind: 'state', stateId }
    } else if (filterKey.startsWith('label:')) {
      const labelId = filterKey.slice(6)
      if (!labelId) return null
      filter = { kind: 'label', labelId }
    } else if (filterKey.startsWith('view:')) {
      const viewId = filterKey.slice(5)
      if (!viewId) return null
      filter = { kind: 'view', viewId }
    } else {
      return null
    }
    return {
      navigator: 'sessions',
      filter,
      details: sessionId ? { type: 'session', sessionId } : null,
    }
  }

  // Check for session details
  if (key.includes('/session/')) {
    const [filterPart, , sessionId] = key.split('/')
    return parseSessionsKey(filterPart, sessionId)
  }

  // Simple filter key
  return parseSessionsKey(key)
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

// UA3.3 — the durable Tasks API (ported from craft-agents-oss v0.13.4 `apps/electron/src/shared/types.ts`,
// Apache-2.0), declared by interface merging so no docs-cited line above moves.
import type {
  TaskValidationResultDto,
  TaskCreateRequest,
  TaskCreateResult,
  TaskGenerateRequest,
  TaskGenerateAck,
  TaskGenerateResult,
  TaskRunRequest,
  TaskRunSnapshotDto,
  TaskGetResult,
  TaskResultsDto,
  TaskDeleteResult,
} from '@nessy-agent/shared/protocol'

export interface ElectronAPI {
  // Tasks (Conductor) — NOT `getTaskOutput`, which reads a background agent's output.
  validateTask(workspaceId: string, yaml: string): Promise<TaskValidationResultDto>
  createTask(workspaceId: string, req: TaskCreateRequest): Promise<TaskCreateResult>
  generateTask(workspaceId: string, req: TaskGenerateRequest): Promise<TaskGenerateAck>
  /** Async generate result (or error), keyed by orchestratorSessionId. */
  onTaskGenerated(callback: (workspaceId: string, result: TaskGenerateResult) => void): () => void
  runTask(workspaceId: string, req: TaskRunRequest): Promise<TaskRunSnapshotDto>
  pauseTask(workspaceId: string, slug: string, runId: string): Promise<void>
  resumeTask(workspaceId: string, slug: string, runId: string): Promise<void>
  stopTask(workspaceId: string, slug: string, runId: string): Promise<void>
  getTask(workspaceId: string, slug: string, runId?: string): Promise<TaskGetResult>
  listTasks(workspaceId: string): Promise<string[]>
  getTaskResults(workspaceId: string, slug: string, runId?: string): Promise<TaskResultsDto>
  /** NESSY — delete a task spec (`tasks/<slug>/`) that no live session carries. */
  deleteTask(workspaceId: string, slug: string): Promise<TaskDeleteResult>
}

// UA1.19 — the Published pages list (t-artifacts), declared by interface merging so no docs-cited line above moves.
import type {
  ArtifactsListResult,
  ArtifactActionResult,
  ArtifactDeleteResult,
  ArtifactDeleteTarget,
} from '@nessy-agent/shared/protocol'

export interface ElectronAPI {
  /** `/mine` joined to this workspace's registry; owed deletions are retried once the list call succeeds. */
  listPublishedArtifacts(workspaceId: string): Promise<ArtifactsListResult>
  /** One PATCH of `retention_days`: 0 = unlimited. The renderer confirms first. */
  setPublishedArtifactRetention(workspaceId: string, id: string, retentionDays: number): Promise<ArtifactActionResult>
  /** One DELETE; a retryable failure is kept as a pending deletion. The renderer confirms first. */
  deletePublishedArtifact(workspaceId: string, target: ArtifactDeleteTarget): Promise<ArtifactDeleteResult>
}

// UA6.4 — the pages API (v0.13.4), declared by interface merging so no docs-cited line above moves.
import type {
  CreatePageInput,
  LoadedPage,
  PageConfig,
  PageDataSnapshot,
  PageRenderLease,
} from '@nessy-agent/shared/pages/types'
import type { PageRefreshApproval, PageRefreshInput, UpdatePagePatch } from '@nessy-agent/shared/pages'

export interface ElectronAPI {
  // UA6.4 — the core invokes (v0.13.4 ElectronAPI; UA8.2: `refresh` on create/update is script CONTENT the host writes)
  getPages(workspaceId: string): Promise<LoadedPage[]>
  getPage(workspaceId: string, pageIdOrSlug: string): Promise<LoadedPage | null>
  createPage(workspaceId: string, input: Omit<CreatePageInput, 'refresh'> & { refresh?: PageRefreshInput }): Promise<PageConfig>
  updatePage(workspaceId: string, pageSlug: string, patch: Omit<UpdatePagePatch, 'refresh'> & { refresh?: PageRefreshInput | null }): Promise<PageConfig>
  deletePage(workspaceId: string, pageSlug: string): Promise<{ publicCopyMayRemain: boolean }>
  getPageContent(workspaceId: string, pageSlug: string): Promise<{ content: string | null; contentDigest?: string }>
  setPageContent(workspaceId: string, pageSlug: string, content: string): Promise<PageConfig>
  getPageData(workspaceId: string, pageSlug: string): Promise<PageDataSnapshot | null>
  /** The lease AND the exact content it is bound to — render THIS string, not a separately fetched copy. */
  createPageLease(workspaceId: string, pageSlug: string): Promise<{ lease: PageRenderLease; content: string }>
  releasePageLease(workspaceId: string, leaseId: string): Promise<void>
  // UA7.4 — the cached poster (v0.13.4 ElectronAPI)
  /** Read a page's cached poster as a data URL — only returns when fresh (digest matches current content). */
  getPageThumbnail(workspaceId: string, pageSlug: string): Promise<{ dataUrl: string; digest: string } | null>
  /** Request a (re)capture of a page's poster (no-op on hosts without a capturer). */
  regeneratePageThumbnail(workspaceId: string, pageSlug: string): Promise<boolean>
  // UA8.3 — scheduled refresh (ours): review, approve the reviewed digest, run an approved refresh now
  getPageRefreshStatus(workspaceId: string, pageSlug: string): Promise<PageRefreshApproval & { content?: string; truncated?: boolean }>
  approvePageRefresh(workspaceId: string, pageSlug: string, sha256?: string, binding?: { args?: string[]; runtime?: string }): Promise<PageRefreshApproval>
  runPageRefreshNow(workspaceId: string, pageSlug: string): Promise<{ started: boolean; error?: string }>
  // UA9.3 — grants (the host-approvals ledger; never page.json) and actions (the per-workspace broker)
  listPageGrants(workspaceId: string, pageSlug: string): Promise<import('@nessy-agent/shared/pages').PageActionGrant[]>
  /** Ours: the host-validated descriptor a grant dialog shows (a script's sha256 now); throws on a refused one. */
  describePageGrantRequest(workspaceId: string, pageSlug: string, action: import('@nessy-agent/shared/pages').PageActionDescriptor): Promise<{ action: import('@nessy-agent/shared/pages').PageActionDescriptor; scriptSha256?: string }>
  /** `contentDigest`: the digest on screen; `scriptSha256`: the one the dialog showed — the host refuses either if it moved. */
  issuePageGrant(workspaceId: string, pageSlug: string, input: { action: import('@nessy-agent/shared/pages').PageActionDescriptor; description?: string; contentDigest: string; scriptSha256?: string }): Promise<import('@nessy-agent/shared/pages').PageActionGrant>
  revokePageGrant(workspaceId: string, pageSlug: string, grantId: string): Promise<boolean>
  executePageAction(workspaceId: string, request: import('@nessy-agent/shared/pages').PageActionRequest): Promise<import('@nessy-agent/shared/pages').PageActionResult>
  cancelPageAction(workspaceId: string, requestId: string): Promise<boolean>
  /** UA12.112 — a refusal the RENDERER's gate decided (before the broker), reported for the audit trail. */
  auditPageGateRefusal(workspaceId: string, report: import('@nessy-agent/shared/pages').PageGateRefusalReport): Promise<boolean>
  onPagesChanged(callback: (workspaceId: string, pages: LoadedPage[]) => void): () => void
}

// UA1.23 — Publish on inline previews, declared by interface merging so no docs-cited line above moves.
import type { ArtifactPublishFileRequest, ArtifactPublishFileResult } from '@nessy-agent/shared/protocol'

export interface ElectronAPI {
  /** The block's file through the SAME host path as `publish_artifact`: the card first, in every mode. */
  publishArtifactFile(workspaceId: string, req: ArtifactPublishFileRequest): Promise<ArtifactPublishFileResult>
}

// UA5.3 — the project ENTITY API (v0.13.4 ElectronAPI, Apache-2.0), declared by interface merging so no docs-cited
// line above moves. A folder crosses only as a handle: `createProject`'s `projectHandleId`, `setProjectFolder`'s
// handle id, and the `{ handleId, displayPath, trusted }` view every read returns (spec §12).
import type {
  CreateProjectRequest,
  LoadedProjectView,
  ProjectConfigView,
  UpdateProjectPatch,
} from '@nessy-agent/shared/protocol'

export interface ElectronAPI {
  getProjects(workspaceId: string): Promise<LoadedProjectView[]>
  /** By id or by slug, as upstream; `null` when neither names a project of this workspace. */
  getProject(workspaceId: string, projectIdOrSlug: string): Promise<LoadedProjectView | null>
  createProject(workspaceId: string, input: CreateProjectRequest): Promise<ProjectConfigView>
  updateProject(workspaceId: string, projectSlug: string, patch: UpdateProjectPatch): Promise<ProjectConfigView>
  /** Unbinds the project's sessions and pages, then removes `projects/<slug>/`; the bound folder is never touched. */
  deleteProject(workspaceId: string, projectSlug: string): Promise<void>
  /** Ours: bind (an issued handle id of this workspace) or unbind (`null`) the project's folder. */
  setProjectFolder(workspaceId: string, projectSlug: string, projectHandleId: string | null): Promise<ProjectConfigView>
  onProjectsChanged(callback: (workspaceId: string, projects: LoadedProjectView[]) => void): () => void
}

// UA5.6 — the project ASSET API (v0.13.4 ElectronAPI, Apache-2.0), by interface merging at the end. Upstream's
// `sourcePath` upload arm is not offered: the server refuses a path from the wire (`project-asset-source-path-refused`).
import type { ProjectAsset } from '@nessy-agent/shared/projects/types'

export interface ElectronAPI {
  /** A project's assets, newest first. */
  listProjectAssets(workspaceId: string, projectSlug: string): Promise<ProjectAsset[]>
  /** Write one asset (base64 or text); the name is sanitised and a taken one gets `-2`, `-3`, …; pushes `projects:changed`. */
  uploadProjectAsset(workspaceId: string, projectSlug: string, input: { filename: string; base64?: string; text?: string }): Promise<ProjectAsset>
  deleteProjectAsset(workspaceId: string, projectSlug: string, filename: string): Promise<void>
}

// UA6.7 — publishing a page on t-artifacts, declared by interface merging at the end so no docs-cited line above moves.
import type {
  PagePublishOptions,
  PagePublishResult,
  PageShareReview,
  PageUnpublishResult,
} from '@nessy-agent/shared/pages/types'

export interface ElectronAPI {
  /** The data scan and the review: the host card for exactly the bytes a publish with these options would send. */
  getPageShareDataScan(workspaceId: string, pageSlug: string, options: PagePublishOptions): Promise<PageShareReview>
  /** Publish the reviewed bytes (`reviewedSha256` = the card's sha256); refused when they moved since the review. */
  publishPage(workspaceId: string, pageSlug: string, options: PagePublishOptions & { reviewedSha256: string }): Promise<PagePublishResult>
  /** One DELETE of the page's copy; a retryable failure is kept as a pending deletion. */
  unpublishPage(workspaceId: string, pageSlug: string): Promise<PageUnpublishResult>
}

// UA12.52 — the artifact-registry push, declared by interface merging at the end so no docs-cited line above moves.
export interface ElectronAPI {
  /** A publish or share landed a registry row: the open Published pages section refetches (`artifacts:list`). */
  onArtifactsChanged(callback: (workspaceId: string) => void): () => void
}

export interface OdysseusSyncStatus {
  enabled: boolean
  running: boolean
  updatedAt?: number
  changedFiles?: number
  conflicts?: string[]
  deferred?: string[]
  unsupported?: string[]
  error?: string
  language?: string
  colorScheme?: 'light' | 'dark' | 'system'
}
export interface ElectronAPI {
  getOdysseusSkillPrompt(name: string): Promise<string>
  getOdysseusStatus(): Promise<OdysseusSyncStatus>
  syncOdysseus(): Promise<OdysseusSyncStatus>
  launchOdysseusCli(sessionId?: string): Promise<{opened: boolean}>
  setOdysseusAppearance(mode: 'light' | 'dark' | 'system'): Promise<void>
}

export interface ElectronAPI {
  getKnowledgeView(options: {focus?:string;query?:string;offset?:number;view?:string;project?:string;version?:string;collection?:string}): Promise<import('./odysseus-knowledge-types').KnowledgeView>
  editKnowledge(operation: import('./odysseus-knowledge-types').KnowledgeEdit): Promise<{revision:number}>
  getKnowledgeAgent(options?:{collection?:string}): Promise<{sessionId:string;prompt:string}>
  manageKnowledgeCatalog(options:{type:'create';name:string}|{type:'move-project';projectId:string;collectionId:string}):Promise<{createdId?:string}>
  syncKnowledgeObsidian(): Promise<{catalogs:number;imported:number;exported:number;conflicts:string[];vault:string}>
  getKnowledgeDocument(options:{nodeId:string;path:string;collection?:string}):Promise<import('./odysseus-knowledge-types').KnowledgeDocument>
}
