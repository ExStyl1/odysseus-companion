// Export ClaudeAgent (renamed from NessyAgent) and backward-compatible aliases
export * from './claude-agent.ts';
export * from './conversation-summary.ts';
// P2.1 · the advisor — the moment vocabulary, the transcript shape the host
// binds, the model gate, and the prompt builders.
export * from './advisor.ts';

// Export PiAgent for direct use
export { PiAgent, PiBackend } from './pi-agent.ts';
export type { EditFeedbackRunner } from './pi-agent.ts';
export type { FormatRunner } from './pi-agent.ts';
export * from './errors.ts';
export * from './options.ts';
// C3.311 · the SDK's own `deleteSession`, behind the host's session delete, so a
// deleted conversation's VENDOR transcript goes with it rather than waiting for
// the retention cutoff. The decision this implements is C3.282's, on the same
// module.
// C3.313 · and the SDK's own `getSessionMessages`, as the runtime-switch
// rebuild's confirmation that the transcript it wrote is one the runtime will
// load. `getSessionInfo` stays declined — the reason is measured on the same
// module.
export {
  confirmClaudeTranscriptThroughSdk,
  deleteClaudeVendorSession,
  retireSupersededClaudeVendorSession,
} from './claude-session-persistence.ts';
export type { ClaudeTranscriptSdkConfirmation, ClaudeVendorSessionDeleteOutcome } from './claude-session-persistence.ts';
// T2 · the Claude transcript rebuild — the converter, the SDK's own path
// derivation, and the one cwd resolver the spawn path also uses.
export * from './claude-transcript-rebuild.ts';
// T7 · the Pi carry-session rebuild — the translator, the fixed path, and the
// loadability predicate `PiAgent.shouldSuppressTextHandoff` reads.
export * from './pi-session-rebuild.ts';

// Export session-scoped-tools - tools scoped to a specific session
export {
  // Session-scoped tools provider
  getSessionScopedTools,
  cleanupSessionScopedTools,
  // Plan file management
  getSessionPlansDir,
  getLastPlanFilePath,
  clearPlanFileState,
  isPathInPlansDir,
  // Callback registry for session-scoped tool notifications
  registerSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
  mergeSessionScopedToolCallbacks,
  // Types
  type SessionScopedToolCallbacks,
  type BrowserPaneFns,
  // Auth request types (unified auth flow)
  type AuthRequest,
  type AuthRequestType,
  type AuthResult,
  type CredentialAuthRequest,
  type McpOAuthAuthRequest,
  type GoogleOAuthAuthRequest,
  type CredentialInputMode,
} from './session-scoped-tools.ts';

// Export plugin-management-tools — agent-driven plugin_plan_install/plugin_install/
// plugin_status/plugin_manage host-callback implementation (A8).
export {
  createPluginManagementTools,
  type PluginManagementToolsDeps,
  type PluginManagementMarketplaceApi,
  type PluginManagementSessionScope,
  type PluginManagementToolScopeKind,
} from './plugin-management-tools.ts';

// Export mode-manager - Centralized mode management
export {
  // Permission Mode API (primary)
  getPermissionMode,
  setPermissionMode,
  cyclePermissionMode,
  subscribeModeChanges,
  PERMISSION_MODE_ORDER,
  PERMISSION_MODE_CONFIG,
  clampPermissionModeToParent,
  parsePermissionMode,
  type PermissionMode,
  getModeState,
  hydratePreviousPermissionMode,
  getPermissionModeDiagnostics,
  initializeModeState,
  cleanupModeState,
  // Tool blocking (centralized)
  shouldAllowToolInMode,
  blockWithReason,
  denyToolWithReason,
  // Session state (lightweight per-message injection)
  getSessionState,
  formatSessionState,
  // Mode manager singleton (for advanced use cases)
  modeManager,
  // P6.202 clause (3) — the first-read-outside card's answer table, exported so
  // the session layer applies it rather than restating it.
  applyOutsideWorkingDirectoryReadAnswer,
  type OutsideWorkingDirectoryReadEffect,
  // Default read-only allowlist (Plan, Don't ask) patterns (for UI display)
  SAFE_MODE_CONFIG,
  // Types
  type ModeState,
  type ModeCallbacks,
  type ModeConfig,
  type PermissionModeChangedBy,
} from './mode-manager.ts';

// Export the configured additional filesystem roots the permission gate consumes
export {
  getConfiguredAdditionalDirectories,
  resolveAdditionalDirectories,
  type AdditionalDirectoriesResolution,
} from './additional-directories.ts';

// Export plan types and permission mode messages
export type { Plan, PlanStep, PlanState, PlanReviewRequest, PlanReviewResult } from './plan-types.ts';
export { PERMISSION_MODE_MESSAGES, PERMISSION_MODE_PROMPTS } from './plan-types.ts';

// Export thinking-levels - extended reasoning configuration
export {
  type ThinkingLevel,
  type ThinkingLevelDefinition,
  THINKING_LEVELS,
  DEFAULT_THINKING_LEVEL,
  activeEffortLevelForModel,
  getThinkingTokens,
  getThinkingLevelNameKey,
  isValidThinkingLevel,
} from './thinking-levels.ts';

// Export permissions-config - customizable permissions per workspace/source (permissions.json)
export {
  // Parser and validation
  parsePermissionsJson,
  validatePermissionsConfig,
  PermissionsConfigSchema,
  // API endpoint checking
  isApiEndpointAllowed,
  // Storage functions
  loadWorkspacePermissionsConfig,
  loadSourcePermissionsConfig,
  getWorkspacePermissionsPath,
  getSourcePermissionsPath,
  // Raw load/save (for CLI CRUD)
  loadRawWorkspacePermissions,
  loadRawSourcePermissions,
  saveWorkspacePermissions,
  saveSourcePermissions,
  // Codex execpolicy projection (P3.1)
  collectExecpolicyAllowPrefixes,
  mergeExecpolicyAllowGrant,
  // App-level default permissions (at ~/.nessy-agent/permissions/)
  getAppPermissionsDir,
  ensureDefaultPermissions,
  loadDefaultPermissions,
  // Cache singleton
  permissionsConfigCache, permissionPolicyNoticeParts, // F1.1002 — the session notice's sentences
  // Types
  type ApiEndpointRule,
  type CompiledApiEndpointRule,
  type PermissionsCustomConfig,
  type PermissionsConfigFile,
  type MergedPermissionsConfig,
  type PermissionPolicyDiagnosticV1,
  type PermissionsContext,
} from './permissions-config.ts';

export {
  addClaudePermissionRules,
  claudeSettingsPath,
  resolveClaudeSettingsRoot,
  type ClaudeSettingsBehavior,
  type ClaudeSettingsDestination,
  type ClaudeSettingsWriteResult,
} from './claude-settings-store.ts';

export {
  evaluatePermissionDslV1,
  evaluateCdPermissionDslV1,
  rawDslInputPath,
  // P2.459 — the three renderers P2.445 wrote so a refusal names the rule that
  // decided and the scope it came from. They were composed in
  // `permission-dsl.ts` precisely so every host that renders this decision
  // renders the SAME sentence; `SessionManager.ts` is the second such host and
  // reaches them only through this barrel, so an unexported renderer is the
  // whole reason its own gates still said nothing.
  describePermissionDslMatch,
  permissionDslAskReason,
  permissionDslDenyReason,
  // P2.514 — the `cd` twins of two of the three above (there is no `cd` ask
  // reason; that gate only ever allows or denies). P2.459's argument covers
  // them word for word and nothing distinguished them, so their absence from
  // this block is the whole reason `SessionManager.ts` carried a SECOND, deep
  // import of `pi-harness/permission-dsl` for exactly these two names.
  describeCdPermissionDslMatch,
  cdPermissionDslDenyReason,
  type PermissionDslEvaluationV1,
  type CdPermissionRequestV1,
  type CdPermissionEvaluationV1,
} from './pi-harness/permission-dsl.ts';

// Export BaseAgent - shared abstract class for all agent backends
export {
  BaseAgent,
  // Mini agent configuration (centralized for all backends)
  type MiniAgentConfig,
  MINI_AGENT_TOOLS,
  MINI_AGENT_MCP_KEYS,
} from './base-agent.ts';

// Export backend abstraction - unified interface for AI agents
// This module enables switching between Claude (Anthropic) and Pi agents
export {
  // Factory (createAgent is the preferred name, createBackend is kept for backward compat)
  createBackend,
  createAgent,
  getAvailableProviders,
  // Types
  type AgentBackend,
  type AgentProvider,
  type BackendConfig,
  type PermissionCallback,
  type PlanCallback,
  type AuthCallback,
  type SourceChangeCallback,
  type SourceActivationCallback,
  type ChatOptions,
  type RecoveryMessage,
  type RuntimeHandoffDelivery,
  type RuntimeHandoffHistoryItem,
  type RuntimeHandoffPayload,
  type SdkMcpServerConfig as BackendMcpServerConfig,
  // Enums
  AbortReason as BackendAbortReason,
} from './backend/index.ts';

// Export core utilities for shared agent logic
export * from './core/index.ts';

// Export browser tool name normalization helpers and the read-only classifier
export {
  LEGACY_BROWSER_TOOL_ALIASES,
  normalizeCanonicalBrowserToolName,
  normalizeBrowserToolName,
  isCanonicalBrowserToolName,
  isBrowserToolNameOrAlias,
  BROWSER_READ_ONLY_COMMANDS,
  isReadOnlyBrowserToolInput,
} from './browser-tool-names.ts';

// UB1.16 — browser passwords stay out of stored transcripts: the session layer
// (SessionManager) redacts the stored input once a result names a password
// field; the guard door (claude-agent) keeps the marker lines on guarded
// results. Upstream v0.15.1's agent/index.ts exports the same surface.
export {
  keepPasswordEntryLines,
  passwordFillRefs,
  redactBrowserPasswordFills,
  redactBrowserToolInput,
} from './browser-tool-redaction.ts';

// Export PowerShell validator root setter (for Electron startup on Windows)
export { setPowerShellValidatorRoot } from './powershell-validator.ts';
export { buildRuntimeTurnTelemetry, recordRuntimeTurnTelemetry } from './runtime-telemetry.ts';
export type { RuntimeTurnTelemetry, RuntimeTurnTelemetryInput } from './runtime-telemetry.ts';

// P6.209 (A42) — the denial receipt's type, so the host read path
// (`SessionManager.getRecentAutoModeDenials`) and whatever renders it name the
// same shape the agent mints rather than each re-declaring a structural copy.
export type {
  ClaudePermissionDenialReceiptV1,
  ClaudePermissionDenialTypeSource,
} from './claude-permission-denial-receipt.ts';
