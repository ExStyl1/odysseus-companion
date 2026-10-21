/**
 * Session Tools Core
 *
 * Shared utilities for session-scoped tools used by both
 * Claude (in-process) and Codex (subprocess) implementations.
 *
 * @packageDocumentation
 */

// Types
export type {
  // Credential types
  CredentialInputMode,

  // Service types
  GoogleService,

  // Auth request types
  AuthRequestType,
  BaseAuthRequest,
  CredentialAuthRequest,
  McpOAuthAuthRequest,
  GoogleOAuthAuthRequest,
  DpAuthRequest,
  AuthRequest,
  AuthResult,

  // IPC types
  CallbackMessage,

  // Tool result types
  TextContent,
  // P6.345 declared the non-text channel and P6.617 is its fourth consumer —
  // `pi-agent.ts`'s wire result. The type was reachable only inside this
  // package until then, which is one reason the Pi direct route was the adapter
  // that never merged it.
  NonTextContent,
  ToolResult,

  // Developer feedback
  DeveloperFeedback,

  // Validation types
  ValidationIssue,
  ValidationResult,

  // Source config types
  SourceType,
  McpTransport,
  McpAuthType,
  ApiAuthType,
  McpSourceConfig,
  ApiSourceConfig,
  LocalSourceConfig,
  SourceConfig,
  ConnectionStatus,
} from './types.ts';

// Response helpers
export {
  successResponse,
  errorResponse,
  textContent,
  multiBlockResponse,
  withoutEmptyStructuredContent,
} from './response.ts';

// Source helpers
export {
  getSourcePath,
  getSourceConfigPath,
  getSourceGuidePath,
  sourceExists,
  sourceConfigExists,
  loadSourceConfig,
  listSourceSlugs,
  getSkillPath,
  getSkillMdPath,
  skillExists,
  skillMdExists,
  listSkillSlugs,
  generateRequestId,
  // Multi-header credential helpers
  detectCredentialMode,
  getEffectiveHeaderNames,
} from './source-helpers.ts';

// Validation
export {
  // Result helpers
  validResult,
  invalidResult,
  mergeResults,

  // Formatting
  formatValidationResult,

  // JSON utilities
  readJsonFile,
  validateJsonFileHasFields,
  zodErrorToIssues,

  // Slug validation
  SLUG_REGEX,
  validateSlug,

  // Skill validation
  SkillMetadataSchema,
  validateSkillContent,

  // Source validation
  SOURCE_CONFIG_REQUIRED_FIELDS,
  SOURCE_TYPES,
  validateSourceConfigBasic,
} from './validation.ts';

// Context interface
export type {
  SessionToolContext,
  SessionToolCallbacks,
  FileSystemInterface,
  CredentialManagerInterface,
  ValidatorInterface,
  AutomationManagerInterface,
  PluginManagementToolsInterface,
  LoadedSource,
  // MCP validation types
  StdioMcpConfig,
  HttpMcpConfig,
  StdioValidationResult,
  McpValidationResult,
  ApiTestResult,
  // Session self-management types
  AgentMessageDeliveryVerdict,
  SendAgentMessageOptions,
  ArchiveSessionVerdict,
  SessionInfo,
  SessionListItem,
  ListSessionsOptions,
  ListSessionsResult,
  ResolvedLabelsResult,
  ResolvedStatusResult,
  BackgroundShellOutput,
  MonitorStartInput,
  MonitorStartResult,
  SessionMonitorPort,
  SessionCronPort,
  SessionGoalPort,
  // P3.276 — exported so the HOST can type the port it binds. The three names
  // were reachable only from inside this package, which is fine for a tool
  // handler and not for the one implementation of `compute`.
  SessionReviewDiffPort,
  SessionReviewDiffRequest,
  SessionReviewDiffAnswer,
  WorktreeEnterInput,
  WorktreeExitInput,
  WorktreeExitResult,
  WorktreeLocation,
  WorktreeCarryOutcome,
  WorktreeBatchTaskInput,
  WorktreeBatchOutcome,
  WorktreeLeaseSummary,
  SessionWorktreePort,
  SessionMcpResourcesPort,
  McpResourceListEntry,
  McpResourceTemplateEntry,
  McpResourceListing,
  McpSourcePromptArgument,
  McpSourcePrompt,
  McpSourcePromptList,
  McpSourceToolCallbacks,
  DecisionToolCallbacks,
  DecisionToolRequest,
  DecisionToolResult,
  DecisionToolQuestion,
  DecisionToolAnswer,
  DecisionToolState,
  DecisionToolUsage,
  DecisionToolError, // UB6.11
  SessionSkillResourcesPort,
  SkillResourceContents,
  SessionNotificationPort,
  DesktopNotificationResult,
  DesktopNotificationSuppression,
} from './context.ts';

export { createNodeFileSystem } from './context.ts';

// Native isolation primitives. The host supervisor composes these; this
// package remains their single implementation owner.
export { credentialDenyRoots, credentialDenyWriteRoots } from './runtime/credential-deny-roots.ts';
// DA2.22 — `shared`'s MCP stdio path reads the SAME list; see the constant's own
// docblock for why it lives on this side of the dependency edge.
export { BLOCKED_ENV_VARS } from './runtime/sandbox-env.ts';
export {
  applyFilesystemIsolation,
  type FilesystemIsolationOptions,
  type FilesystemIsolationPlan,
} from './runtime/filesystem-isolation.ts';
export {
  machLookupRule,
  NETWORK_SANDBOX_MACH_SERVICES,
  SANDBOX_MACH_SERVICES,
} from './runtime/mach-services.ts';
export {
  applyNetworkIsolation,
  type NetworkIsolationPlan,
} from './runtime/network-isolation.ts';

// Handlers
export {
  // SubmitPlan
  handleSubmitPlan,
  // Config Validate
  handleConfigValidate,
  // Skill Validate
  handleSkillValidate,
  // Mermaid Validate
  handleMermaidValidate,
  // Source Test
  handleSourceTest,
  // OAuth Triggers
  handleSourceOAuthTrigger,
  handleGoogleOAuthTrigger,
  // Credential Prompt
  handleCredentialPrompt,
  // Update Preferences
  handleUpdatePreferences,
  // Memory
  handleRemember, MEMORY_FILE_NAME,
  // Todo
  handleTodoWrite,
  handleTask,
  handleTaskCreate,
  handleTaskUpdate,
  handleTaskGet,
  handleTaskList,
  handleGoal,
  handleGoalGet,
  // Review findings
  handleReportFindings,
  // Desktop notifications
  handlePushNotification,
  // Artifact delivery
  handleSendUserFile,
  // Transform Data
  handleTransformData,
  // Script Sandbox
  handleScriptSandbox,
  // Render Template
  handleRenderTemplate,
  // Send Developer Feedback
  handleSendDeveloperFeedback,
  // Slash Commands
  handleSlashCommand,
  // Background Bash Output
  handleBashOutput,
  handleProcessStop,
  handleMonitor,
  MONITOR_DEFAULT_TIMEOUT_MS,
  MONITOR_MAX_TIMEOUT_MS,
  // Automation Management
  handleAutomationList,
  handleAutomationCreate,
  handleAutomationUpdate,
  handleAutomationValidate, findUnattendedAutomationEdit,
  handleDecide, // UB6.11
} from './handlers/index.ts';

export type {
  SubmitPlanArgs,
  ConfigValidateArgs,
  SkillValidateArgs,
  MermaidValidateArgs,
  SourceTestArgs,
  SourceOAuthTriggerArgs,
  GoogleOAuthTriggerArgs,
  CredentialPromptArgs,
  UpdatePreferencesArgs,
  RememberArgs,
  TodoWriteArgs,
  TaskArgs,
  TransformDataArgs,
  ScriptSandboxArgs,
  RenderTemplateArgs,
  SendDeveloperFeedbackArgs,
  SlashCommandArgs,
  BashOutputArgs,
  ProcessStopArgs,
  MonitorArgs,
  AutomationListArgs,
  AutomationCreateArgs,
  AutomationUpdateArgs, UnattendedAutomationEdit,
  AutomationValidateArgs,
} from './handlers/index.ts';

// Tool definitions — single source of truth
export {
  // Individual Zod schemas
  SubmitPlanSchema,
  ConfigValidateSchema,
  SkillValidateSchema,
  MermaidValidateSchema,
  SourceTestSchema,
  SourceOAuthTriggerSchema,
  CredentialPromptSchema,
  CallLlmSchema,
  AdvisorConsultSchema,
  UpdatePreferencesSchema,
  RememberSchema,
  TodoItemSchema,
  TodoWriteSchema,
  TaskSchema,
  TaskCreateSchema,
  TaskUpdateSchema,
  TaskGetSchema,
  TaskListSchema,
  GoalSchema,
  GoalGetSchema,
  ReportFindingsSchema,
  PushNotificationSchema,
  SendUserFileSchema,
  TransformDataSchema,
  ScriptSandboxSchema,
  RenderTemplateSchema,
  SlashCommandSchema,
  BashOutputSchema,
  ProcessStopSchema,
  MonitorSchema,
  AutomationKindSchema,
  AutomationActionInputSchema,
  AutomationListSchema,
  AutomationCreateSchema,
  AutomationUpdateSchema,
  AutomationValidateSchema,
  // Plugin management schemas
  PluginPlanInstallSchema,
  PluginInstallSchema,
  PluginStatusSchema,
  PluginManageSchema,
  // Browser tool schema
  BrowserToolSchema,
  // Developer feedback schema
  SendDeveloperFeedbackSchema,
  // Descriptions
  TOOL_DESCRIPTIONS,
  // Registry
  SESSION_TOOL_DEFS,
  SESSION_TOOL_NAMES,
  SESSION_BACKEND_TOOL_NAMES,
  SESSION_REGISTRY_TOOL_NAMES,
  SESSION_SAFE_ALLOWED_TOOL_NAMES,
  SESSION_SAFE_BLOCKED_TOOL_NAMES,
  SESSION_TOOL_REGISTRY,
  SESSION_TOOLS_REQUIRING_HOST_CALLBACK,
  SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK,
  SESSION_TOOLS_WITHHELD_FOR_NATIVE_EQUIVALENT,
  SESSION_BACKEND_TOOLS_BRIDGED_BY_HOST_CALLBACK,
  // Filtered helper views
  getSessionToolDefs,
  getSessionToolNames,
  getSessionBackendToolNames,
  getSessionRegistryToolNames,
  flattenDiscriminatedUnionForSdkTool,
  getSessionToolRegistry,
  getSessionSafeAllowedToolNames,
  getSessionSafeBlockedToolNames,
  // P6.895 — the host-port OFFER gate, exported so a third advertised surface
  // (claude's SDK tool builder) applies it instead of re-deriving the rule.
  isOfferedByHostPorts,
  // JSON Schema converter
  getToolDefsAsJsonSchema,
} from './tool-defs.ts';

// T5 — the codex host-callback bridge's wire contract, imported by BOTH ends
// (the `session-mcp-server` client and the host server in `shared`).
export {
  HOST_CALLBACK_BRIDGE_GOAL_ACTIONS,
  HOST_CALLBACK_BRIDGE_ROUTES,
  HOST_CALLBACK_BRIDGE_SESSION_MISMATCH, hostCallbackBridgeCallOriginOf, // F1.493 (2)
} from './host-callback-bridge.ts';
export type {
  HostCallbackBridgeRequest, HostCallbackBridgeCallOrigin, // F1.493 (2)
  HostCallbackBridgeResponse,
  HostCallbackBridgeRoute,
} from './host-callback-bridge.ts';

// R56 — the auto-memory INDEX contract: what loads, the write-time measurement
// and its two model-facing messages, and the `modified` frontmatter stamp. One
// owner, in the leaf package, because `@nessy-agent/shared`'s writer and load
// path must count the same bytes this package's `remember` handler counts.
export {
  capMemoryIndexLoad,
  fenceRun,
  measureMemoryIndex,
  memoryIndexLoadedContent,
  memoryIndexWriteNotice,
  stampMemoryModified,
  stripBlockHtmlComments,
  stripMemoryFrontmatter,
  MEMORY_INDEX_NEAR_LIMIT_RATIO,
  MEMORY_INDEX_REWRITE_TARGET_BYTES,
  MEMORY_INDEX_REWRITE_TARGET_LINES,
  MEMORY_LOAD_BYTE_LIMIT,
  MEMORY_LOAD_LINE_LIMIT,
} from './memory-index.ts';

export type {
  FenceState,
  MemoryIndexMeasurement,
  MemoryIndexNoticeLevel,
  MemoryIndexWriteNotice,
} from './memory-index.ts';

export {
  TODO_STATE_FILE_NAME,
  TODO_STATE_VERSION,
  TODO_STATUSES,
  getTodoStateFilePath,
  normalizeTodoItems,
  readTodoStateFile,
  writeTodoStateFile,
  getTodoStateFileMode,
} from './todo-state.ts';

export type {
  TodoStatus,
  TodoItemInput,
  TodoItem,
  TodoState,
} from './todo-state.ts';

export type {
  SessionToolExecutionMode,
  SessionToolSafeMode,
  SessionToolDef,
  RegistrySessionToolDef,
  BackendSessionToolDef,
  SessionToolHandler,
  JsonSchemaToolDef,
  SessionToolFilterOptions,
  SessionToolNameOptions,
} from './tool-defs.ts';

// R20 — the documented task list reducer. One owner for every task semantic;
// the host store persists its state verbatim.
export {
  createDocumentedTaskState,
  runDocumentedTaskCommand,
  getDocumentedTask,
  listDocumentedTasks,
  formatTaskId,
} from './tasks/documented-tasks.ts';

export type {
  DocumentedTaskStatus,
  DocumentedTaskStatusInput,
  DocumentedTaskRecord,
  DocumentedTaskListState,
  DocumentedTaskCommand,
  DocumentedTaskOutcome,
  DocumentedTaskResult,
  DocumentedTaskCreateOutput,
  DocumentedTaskUpdateOutput,
  DocumentedTaskGetOutput,
  DocumentedTaskListOutput,
} from './tasks/documented-tasks.ts';

// R27b — the documented cron dialect. Parsed here rather than delegated to
// croner because croner accepts every extended token `scheduled-tasks.md:202`
// requires us to refuse; see the module header for the measurement.
export {
  CRON_FIELD_NAMES,
  CronDialectError,
  cronIntervalMs,
  isRecurrenceRule,
  isValidCronExpression,
  matchesCronExpression,
  matchesDayFields,
  nextCronRun,
  parseCronExpression,
  recurrenceRuleToCron,
} from './scheduling/cron-dialect.ts';

export type { CronFieldName, ParsedCronExpression } from './scheduling/cron-dialect.ts';

export { CRON_TOOL_NAMES, isCronDisabled } from './tool-defs.ts';
export { handleCronCreate, handleCronDelete, handleCronList } from './handlers/cron-tools.ts';

export {
  DOCUMENTED_TASK_TOOL_NAMES,
  LEGACY_TASK_TOOL_NAMES,
  areTaskToolsEnabled,
} from './tool-defs.ts';

// UA1.3 — the agent status rule, for the host closure that is its authority on every runtime (`SessionManager`).
export { checkAgentSessionStatus, closedStatusRefusal } from './handlers/set-session-status.ts';

// UA6.1 — script runtime resolution + path containment from the package root, as craft-agents-oss v0.13.4 exports
// them (its shared `pages/data-write.ts` and automations script action import them from here). Runtime-only, no zod.
export {
  resolveScriptRuntime,
} from './runtime/resolve-script-runtime.ts';
export type {
  ScriptRuntimeLanguage,
  ResolvedScriptRuntime,
  ResolveScriptRuntimeContext,
} from './runtime/resolve-script-runtime.ts';
export {
  isPathWithinDirectory,
  isPathWithinDirectoryForCreation,
} from './runtime/path-security.ts';

// UA1.18 — the t-artifacts pair: the context types the host closure answers with, the retention range the host
// enforces (the model's 1..30, default 7), and the handlers/schemas for the session servers.
export type {
  ListArtifactsResult,
  PublishArtifactInput,
  PublishArtifactVerdict,
  SessionArtifactSummary,
} from './context.ts';
export {
  PUBLISH_ARTIFACT_DEFAULT_RETENTION_DAYS,
  PUBLISH_ARTIFACT_DESCRIPTION,
  PUBLISH_ARTIFACT_MAX_RETENTION_DAYS,
  PUBLISH_ARTIFACT_MIN_RETENTION_DAYS,
  PublishArtifactSchema,
  handlePublishArtifact,
} from './handlers/publish-artifact.ts';
export { LIST_ARTIFACTS_DESCRIPTION, ListArtifactsSchema, handleListArtifacts } from './handlers/list-artifacts.ts';

// UA3.5 — create_board_task: the context types the host closure takes and answers with, and the handler/schema for
// the session servers.
export type { CreateBoardTaskInput, CreateBoardTaskResult } from './context.ts';
export { CREATE_BOARD_TASK_DESCRIPTION, CreateBoardTaskSchema, handleCreateBoardTask } from './handlers/create-board-task.ts';
export type { CreateBoardTaskArgs } from './handlers/create-board-task.ts';

// UB1.12 — project_memory_append (v0.15.1): the context types the host closure takes and answers with, and the
// handler/schema for the session servers.
export type { ProjectMemoryAppendInput, ProjectMemoryAppendResult } from './context.ts';
export { PROJECT_MEMORY_APPEND_DESCRIPTION, handleProjectMemoryAppend } from './handlers/project-memory.ts';
export type { ProjectMemoryAppendArgs } from './handlers/project-memory.ts';

// UA6.3 — the six page tools: the context types the host closures take and answer with (`server-core`'s
// `pages/tool-callbacks.ts` imports them from here, as upstream does), and the handlers/schemas for the session servers.
export type {
  PagesToolCallbacks,
  PageToolSummary,
  PageToolDataSummary,
  PageToolDetails,
  CreatePageToolInput,
  UpdatePageToolPatch,
  PageToolRefreshInput, // UA8.2
  PageToolRefreshSpec, // UA8.2
  PageDataToolPatch,
  PageDataWriteSummary,
  DeletePageToolResult,
} from './context.ts';
export {
  handleListPages,
  handleGetPage,
  handleCreatePage,
  handleUpdatePage,
  handleWritePageData,
  handleDeletePage,
  ListPagesSchema,
  GetPageSchema,
  CreatePageSchema,
  UpdatePageSchema,
  WritePageDataSchema,
  DeletePageSchema,
} from './handlers/pages.ts';
export type {
  ListPagesArgs,
  GetPageArgs,
  CreatePageArgs,
  UpdatePageArgs,
  WritePageDataArgs,
  DeletePageArgs,
} from './handlers/pages.ts';
