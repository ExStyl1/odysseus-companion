/**
 * Nessy Desktop Automations - Public API
 *
 * Slim barrel file that re-exports from decomposed modules:
 * - types.ts: All type definitions
 * - validation.ts: Config validation functions
 * - sdk-bridge.ts: SDK environment variable building
 * - utils.ts: Shared utilities (toSnakeCase, expandEnvVars, etc.)
 * - automation-system.ts: AutomationSystem facade (main entry point)
 * - event-bus.ts: WorkspaceEventBus
 * - handlers/: PromptHandler, WebhookHandler, EventLogHandler
 */

// ============================================================================
// Types
// ============================================================================

export type {
  AppEvent,
  AgentEvent,
  AutomationEvent,
  PromptAction,
  WebhookAction,
  HookCommandAction,
  HookErrorNotice,
  HookUniversalOutput,
  PreToolUseDecision,
  PreToolUseDecisionAction,
  PreToolUseDecisionValue,
  AgentEventExecutionResult,
  WebhookHttpMethod,
  WebhookBodyFormat,
  WebhookAuth,
  AutomationAction,
  AutomationMatcher,
  AutomationsConfig,
  PromptReferences,
  PromptActionResult,
  WebhookActionResult,
  HookCommandActionResult,
  PreToolUseDecisionActionResult,
  ActionExecutionResult,
  PendingPrompt,
  AutomationResult,
  AutomationsValidationResult,
  SdkAutomationInput,
  SessionEndReason,
  HookNotificationType,
  SdkAutomationCallback,
  SdkAutomationCallbackMatcher,
  AgentAutomationSystem,
  ComponentHookLayer,
  SessionMetadataSnapshot,
  TimeCondition,
  StateCondition,
  LogicalCondition,
  AutomationCondition,
  SemanticCondition,
} from './types.ts';

export { APP_EVENTS, AGENT_EVENTS, formatAutomationListText, UNEMITTED_HOOK_EVENT_REASONS, SESSION_END_REASONS, HOOK_NOTIFICATION_TYPES, HOOK_CONFIG_CHANGE_SOURCES, HOOK_EFFORT_LEVELS, hookTypesSupportedForEvent, hookTypeSupportedForEvent } from './types.ts';
export type { HookHandlerType, HookEffortLevel, HookConfigChangeSource } from './types.ts';
/** P6.294 — the read-only hook view's row shape and its tier vocabulary. */
export type { HookBindingTier, HookBindingView } from './types.ts';

// The `background_tasks` / `session_crons` wire shape shared by the host
// registry, the cron store and both emitting backends (hooks.md `:2194`).
export type {
  BackgroundTaskType,
  BackgroundTaskTypeLabel,
  BackgroundTaskStatus,
  BackgroundTaskEntryV1,
  SessionCronEntryV1,
  HookTaskRegistryPort,
  HookTaskRegistryInput,
} from './hook-task-registry.ts';

export {
  HOOK_REGISTRY_TEXT_CAP,
  capHookRegistryText,
  friendlyBackgroundTaskType,
  hookTaskRegistryInput,
} from './hook-task-registry.ts';

// ============================================================================
// Validation
// ============================================================================

export {
  validateAutomationsConfig,
  validateAutomationsContent,
  validateAutomations,
} from './validation.ts';

export {
  listAutomationEntries,
  createAutomationEntry,
  updateAutomationEntry,
  setAutomationEntryEnabled,
  duplicateAutomationEntry,
  deleteAutomationEntry,
  validateAutomationConfigFile,
} from './management.ts';

export type {
  AutomationKind,
  AutomationMutationAction,
  AutomationMutationFields,
  AutomationCreateInput,
  AutomationUpdateInput,
  AutomationManagementResult,
  AutomationListEntry,
} from './management.ts';

// ============================================================================
// SDK Bridge
// ============================================================================

export { buildEnvFromSdkInput } from './sdk-bridge.ts';
export {
  HOOKS_CONFIG_FILE,
  USER_GLOBAL_HOOKS_CONFIG_FILE,
  getUserGlobalHooksConfigPath,
  loadHooksConfigFile,
  parseHooksConfigContent,
  loadLifecycleHooksConfig,
  loadUserGlobalLifecycleHooksConfig,
  mergeAutomationsConfigs,
  type HooksLoadResult,
} from './hooks-config.ts';
export {
  automationHookName,
  buildHookCommandEnv,
  buildHookErrorNotice,
  getHookCommandPreToolDecision,
  hookApprovalTimeoutNotice,
  hookCommandBudgetMs,
  hookCommandStdinPayload,
  mergeHookUniversalOutputs,
  parseHookOutputForEvent,
  raceHookApprovalDeadline,
  redactHookOutput,
  resolveExecFormHookInvocation,
  resolveImportedHookTimeoutMs,
  runHookCommand,
  MAX_HOOK_TIMEOUT_MS,
  type ParsedHookOutput,
} from './hook-command.ts';
// UB12.69 — the host's send path fences a `PostModelSwitch` hook's context with
// the same composer every runtime's hook band uses.
export { fenceHookBand } from './hook-context-fence.ts';
export {
  ensureHookEnvFile,
  hookEnvFileDirPath,
  hookEnvFilePath,
  hookEnvFileSupported,
  resetHookEnvFile,
  resolveHookEnvFileForRead,
  resolveHookEnvFileShellStart,
  withHookEnvFileShellSource,
  HOOK_ENV_FILE_CHILD_ENV_KEY,
  HOOK_ENV_FILE_EVENTS,
  HOOK_ENV_FILE_MAX_BYTES,
  HOOK_ENV_FILE_SHELL_SEMANTIC_IDS,
  HOOK_ENV_FILE_SOURCE_PREAMBLE,
  type HookEnvFileShellStart,
} from './hook-env-file.ts';
export {
  describeWorktreeIdentityRefusal,
  parseCommandHookWorktreePath,
  resolveHookWorktreePath,
  screenWorktreeIdentity,
  stripAnsi,
  type HookWorktreePathResult,
  type WorktreeIdentityRefusal,
  type WorktreeIdentityScreenInput,
} from './hook-worktree-path.ts';
export {
  hookBlockEndsTurn,
  promptHookBlockEndsTurn,
  hookDecisionPattern,
  hookEventCanDecide,
  isBlockingHookDecision,
  resolveHookToolOutputRewrite,
  type HookToolOutputRewrite,
  hookEventDecisionSurface,
  projectHookDecisionForEvent,
  type HookDecisionField,
  type HookDecisionPattern,
  type HookEventDecisionSurface,
} from './hook-decision-contract.ts';

export type {
  AutomationAgentEventTarget,
  DispatchAutomationAgentEventOptions,
} from './lifecycle-hook-dispatcher.ts';
export { dispatchAutomationAgentEvent } from './lifecycle-hook-dispatcher.ts';

// ============================================================================
// Utilities
// ============================================================================

export { parsePromptReferences, toDocumentedStopFailureError } from './utils.ts';

// ============================================================================
// Re-exports from sub-modules
// ============================================================================

// Event logger
export { AutomationEventLogger, type LoggedAutomationEvent, type LoggedAutomationEventInput } from './event-logger.ts';

// Schemas
export { AutomationsConfigSchema, AutomationConditionSchema, TimeConditionSchema, StateConditionSchema, HookCommandActionSchema, zodErrorToIssues, VALID_EVENTS } from './schemas.ts';

// Condition evaluator
export { evaluateConditions, type ConditionContext } from './conditions.ts';

// Security utilities
export { sanitizeForShell } from './security.ts';

// Webhook execution utilities
export { executeWebhookRequest, executeWithRetry, createWebhookHistoryEntry, createPromptHistoryEntry, type ExecuteWebhookOptions, type RetryConfig } from './webhook-utils.ts';

// Retry scheduler
export { RetryScheduler, type RetryQueueEntry, type RetrySchedulerOptions } from './retry-scheduler.ts';

// Config constants
export { AUTOMATIONS_CONFIG_FILE, AUTOMATIONS_HISTORY_FILE, AUTOMATIONS_RETRY_QUEUE_FILE, AUTOMATIONS_SCHEDULE_STATE_FILE, HISTORY_FIELD_MAX_LENGTH, AUTOMATION_HISTORY_MAX_RUNS_PER_MATCHER, AUTOMATION_HISTORY_MAX_ENTRIES, AUTOMATION_CATCHUP_WINDOW_MS } from './constants.ts';

// Missed-run catch-up (desktop-scheduled-tasks.md:74)
export { planCatchupFires, type CatchupFire, type CatchupPlan, type CatchupPlanInput } from './catchup-planner.ts';
export { readScheduleState, writeScheduleState, mergeScheduleState, resolveScheduleStatePath, type ScheduleState } from './schedule-state.ts';

// History store
export { appendAutomationHistoryEntry, compactAutomationHistory, compactAutomationHistorySync } from './history-store.ts';

// Config path resolution
export { resolveAutomationsConfigPath, generateShortId } from './resolve-config-path.ts';

// Cron matching
export { matchesCron, previousOccurrence } from './cron-matcher.ts';

// Event Bus
export {
  WorkspaceEventBus,
  type EventBus,
  type EventPayloadMap,
  type BaseEventPayload,
  type LabelEventPayload,
  type PermissionModeChangePayload,
  type FlagChangePayload,
  type SessionStatusChangePayload,
  type SchedulerTickPayload,
  type LabelConfigChangePayload,
  type GenericEventPayload,
  type EventHandler,
  type AnyEventHandler,
} from './event-bus.ts';

// AutomationSystem facade
export {
  AutomationSystem,
  createUserDisabledAutomationSystem,
  type AutomationSystemOptions,
  type SessionMetadataSnapshot as AutomationSystemMetadataSnapshot,
} from './automation-system.ts';

// Handlers
export {
  PromptHandler,
  EventLogHandler,
  WebhookHandler,
  type AutomationHandler,
  type PromptHandlerOptions,
  type EventLogHandlerOptions,
  type WebhookHandlerOptions,
  type AutomationsConfigProvider,
} from './handlers/index.ts';

// Per-runtime hook-event emission (P6.13/P6.14). Re-exported here rather than
// given a `package.json` subpath of its own: `describeCapabilityDelta` in
// `server-core` is the second reader — the first outside this package — and the
// switch notice it builds must be derived from the SAME measured table the
// build-time `onHookEventNeverFires` warning reads, or the log and the notice
// become two claims that can disagree.
export {
  hookEventColumnMeasured,
  hookEventEmission,
  hookEventNativeRoute,
  hookEventNeverFires,
  hookEventsThatNeverFire,
  CODEX_NATIVE_HOOK_EVENTS,
  type CodexNativeHookEvent,
  type HookEventEmission,
  type HookEventEmissionKind,
} from './runtime-hook-events.ts';

// UA8.1 — the script action (craft-agents-oss v0.13.4's exports, adapted): the types, the schema, the allowlisted
// env builders, the handler, and from the executor ONLY `runApprovedScript` plus its non-executing helpers — the
// raw executor is not exported (spec §15 item 1).
export type { ScriptAction, ScriptActionRuntime, ScriptActionResult } from './types.ts';
export { ScriptActionSchema } from './schemas.ts';
export { buildScriptEnv, buildBaseScriptEnv, SCRIPT_ENV_PLATFORM_ESSENTIALS, type ScriptEnvOptions } from './utils.ts';
export {
  runApprovedScript,
  createScriptHistoryEntry,
  clampScriptTimeout,
  scriptApprovalBinding,
  scriptApprovalRecord,
  scriptApprovalSubject,
  scriptSha256,
  DEFAULT_SCRIPT_TIMEOUT_MS,
  MIN_SCRIPT_TIMEOUT_MS,
  MAX_SCRIPT_TIMEOUT_MS,
  SCRIPT_APPROVAL_KIND,
  type ApprovedScriptRequest,
  type ScriptApprovalBinding,
  type ScriptAuditPort,
  type ScriptRunTrigger,
} from './script-executor.ts';
export { ScriptHandler, type ScriptHandlerOptions } from './handlers/index.ts';
// UA8.3 — the human half of the approval: read a saved script action's state, record the person's approval.
export {
  readScriptActionApproval,
  approveScriptAction,
  type ScriptApprovalState,
  type ScriptApprovalStatus,
} from './script-approval.ts';
