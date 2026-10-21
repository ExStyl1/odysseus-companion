/**
 * Re-export all types from @nessy-agent/core
 */

// Workspace and config types
export type {
  WorkspaceInfo,
  Workspace,
  WorkspaceDefaultsInfo,
  RemoteServerInfo,
  McpAuthType,
  AuthType,
  OAuthCredentials,
  StoredConfig,
} from './workspace.ts';

// Session types
export type {
  Session,
  StoredSession,
  SessionMetadata,
  SessionStatus,
} from './session.ts';

// Message types
export type {
  MessageRole,
  ToolStatus,
  ToolDisplayMeta,
  AttachmentType,
  MessageAttachment,
  StoredAttachment,
  SessionAttachmentDto,
  ContentBadge,
  AnnotationAuthor,
  AnnotationBody,
  AnnotationIntent,
  AnnotationStatus,
  AnnotationBlockType,
  AnnotationSelector,
  AnnotationTarget,
  AnnotationV1,
  Message,
  PersistedMessage,
  StoredMessage,
  MessageRuntimeProvider,
  TokenUsage,
  CacheUsageSnapshot,
  CostReporting,
  TurnCostReporting,
  PersistedModelUsage,
  ContextUsageCategory,
  ContextUsageCategoryId,
  ContextUsageCategoryItem,
  ContextUsageLoadedFile,
  ContextUsageSnapshot,
  ContextUsageSuggestion,
  ContextUsageSuggestionId,
  AgentEventUsage,
  AgentEventUsageUpdate,
  AgentTerminalReason,
  AgentTerminalReasonWithNotice,
  RecoveryAction,
  ErrorCode,
  TypedError,
  PermissionRequestType,
  PermissionRequestOrigin,
  AskUserAnswer,
  AskUserPermissionRequest,
  AskUserQuestionItem,
  AskUserQuestionOption,
  AskUserUrlConsent,
  AskUserUrlConsentWarning,
  FirstOutsideReadPermissionRequest,
  ReopenCompactPermissionRequest,
  PermissionRequest,
  PermissionRisk,
  AgentEvent,
  AgentRetryFacts,
  RetryStatusKind,
  BackgroundTaskSummary,
  // Auth-related types
  CredentialInputMode,
  AuthRequestType,
  AuthStatus,
} from './message.ts';
export { describeCacheUsage } from './message.ts';
export { generateMessageId, PERMISSION_REQUEST_ORIGIN_VALUES, TERMINAL_REASON_VALUES, TERMINAL_REASON_MARKER, TERMINAL_REASON_NOTICE_VALUES, terminalReasonMarker, parseTerminalReasonMarker, hasTerminalReasonNotice, RETRY_STATUS_PREFIXES, retryStatusMessage, retryStatusEvent } from './message.ts';

// Message persistence mappers
export { messageToStored, storedToMessage, storedToPersistedMessage } from './message-mapper.ts';

// Server types (headless operations)
export type {
  ServerStatus,
  ServerHealth,
  SessionProcessingStatus,
  ActiveSessionInfo,
} from './server.ts';

export type {
  PiHarnessSessionRefV1,
  PiHarnessProviderV1,
  PiHarnessPermissionModeV1,
  PiHarnessRuntimeDomainV1,
  PiHarnessManifestDiagnosticsV1,
  PiHarnessProcessSnapshotV1,
  IsolationProfileCapabilityV1,
  IsolationNetworkPostureV1,
  IsolationCapabilityReportV1,
  PiHarnessTaskSummaryV1,
  PiHarnessTaskStateSummaryV1,
  PiHarnessGoalStatusV1,
  PiHarnessGoalSummaryV1,
  PiHarnessPendingAskSummaryV1,
  PiHarnessPlanSummaryV1,
  PiHarnessChildEffortV1,
  PiHarnessChildSummaryV1,
  PiHarnessChildStateSummaryV1,
  PiHarnessMailboxSummaryV1,
  PiHarnessWorktreeSummaryV1,
  PiHarnessLspHealthV1,
  PiHarnessMcpHealthV1,
  PiHarnessContextSummaryV1,
  PiHarnessCompactionSummaryV1,
  PiHarnessCheckpointSummaryV1,
  PiHarnessPendingPermissionSummaryV1,
  PiHarnessSecuritySummaryV1,
  PiHarnessExecutionOutcomeV1,
  PiHarnessToolEffectV1,
  PiHarnessExecutionReceiptSummaryV1,
  PiHarnessSettlementPendingDomainV1,
  PiHarnessSessionSettlementV1,
  PiHarnessRuntimeSnapshotV1,
  PiHarnessRuntimeEventV1,
  PiHarnessRuntimeSnapshotResultV1,
  PiHarnessRuntimeControlRequestV1,
  PiHarnessRuntimeControlResultV1,
} from './pi-harness-runtime.ts';
export type {
  PiAgentViewStateV1,
  PiAgentViewResidencyV1,
  PiAgentViewReasonCodeV1,
  PiAgentViewTaskSummaryV1,
  PiAgentViewGoalSummaryV1,
  PiAgentViewEntryV1,
  PiAgentViewPageRequestV1,
  PiAgentViewPageV1,
  PiAgentViewControlRequestV1,
  PiAgentViewControlResultV1,
} from './pi-agent-view.ts';

// UA6.1 — page types (workspace-scoped mini dashboards), from craft-agents-oss v0.13.4 (Apache-2.0). The grant
// type is dropped (reason (b): grants live in the host ledger) and the publication type is ours (UA6.7,
// `PagePublication`, t-artifacts) — see page.ts's header.
export type {
  PageKind,
  PageScriptRuntime,
  PageRefreshSpec,
  PageRefreshStatus,
  PageSeriesPoint,
  PageDataSnapshot,
  PageActionHttpMethod,
  PageActionDescriptor,
  PageRenderLease,
  PageActionInvocation,
  PageActionRequest,
  PageActionResult,
  PageThumbnailInfo,
  PageConfig,
  PagePublication,
} from './page.ts';
