/**
 * Core Agent Module
 *
 * Provides shared functionality for all agent backends (ClaudeAgent, PiAgent).
 * These modules are provider-agnostic and can be composed into any agent implementation.
 *
 * Modules:
 * - PermissionManager: Tool permission evaluation and mode management
 * - SourceManager: External data source state tracking
 * - PromptBuilder: System prompt and context building
 * - PathProcessor: Path expansion and normalization
 * - ConfigValidator: Pre-write configuration validation
 * - ConfigWatcherManager: Hot-reload config file watching
 * - SessionLifecycleManager: Session state and abort handling
 * - UsageTracker: Token usage and context window tracking
 * - PrerequisiteManager: Prerequisite reading enforcement (guide.md before source tools)
 */

// Types
export type {
  // Core types
  RecoveryMessage,
  PermissionManagerConfig,
  ToolPermissionResult,
  SourceManagerConfig,
  PromptBuilderConfig,
  ContextBlockOptions,
  PathProcessorConfig,
  ConfigValidatorConfig,
  ConfigValidationResult,
  ConfigFileType,
  // Re-exported from mode-types
  PermissionMode,
  ModeConfig,
  CompiledApiEndpointRule,
  CompiledBashPattern,
  MismatchAnalysis,
  PermissionPaths,
  // Re-exported from mode-manager
  ToolCheckResult,
} from './types.ts';

// Config Watcher Manager types
export type {
  ConfigWatcherManagerCallbacks,
  ConfigWatcherManagerConfig,
} from './config-watcher-manager.ts';

// Session Lifecycle types
export type {
  SessionState,
  SessionLifecycleConfig,
} from './session-lifecycle.ts';
export { AbortReason } from './session-lifecycle.ts';

// Usage Tracker types
export type {
  MessageUsage,
  SessionUsage,
  UsageUpdate,
  UsageTrackerConfig,
} from './usage-tracker.ts';

// Constants
export {
  PERMISSION_MODE_ORDER,
  PERMISSION_MODE_CONFIG,
  SAFE_MODE_CONFIG,
} from './types.ts';

// Permission Manager
export { PermissionManager } from './permission-manager.ts';

// Source Manager
export { SourceManager } from './source-manager.ts';

// Prompt Builder
export { PromptBuilder } from './prompt-builder.ts';

// Path Processor
export {
  PathProcessor,
  // Re-exported utilities
  expandPath,
  normalizePath,
  pathStartsWith,
  toPortablePath,
} from './path-processor.ts';

// Config Validator
export { ConfigValidator } from './config-validator.ts';

// Config Watcher Manager
export {
  ConfigWatcherManager,
  createConfigWatcherManager,
} from './config-watcher-manager.ts';

// Session Lifecycle
export {
  SessionLifecycleManager,
  createSessionLifecycleManager,
} from './session-lifecycle.ts';

// Usage Tracker
export {
  UsageTracker,
  createUsageTracker,
  // P6.616 — the one cache-breakdown rule, shared with the session layer.
  describeCacheUsage,
  type CachePerformance,
} from './usage-tracker.ts';

// PreToolUse Utilities
export {
  // Types
  type PreToolUseContext,
  type PathExpansionResult,
  type SkillQualificationResult,
  type MetadataStrippingResult,
  type ConfigValidationResult as PreToolUseConfigValidationResult,
  // Centralized pipeline types
  type PreToolUseCheckResult,
  type PreToolUseInput,
  type PermissionManagerLike,
  type PrerequisiteManagerLike,
  // Constants
  BUILT_IN_TOOLS,
  FILE_PATH_TOOLS,
  CONFIG_WRITE_TOOLS,
  // Functions
  expandToolPaths,
  qualifySkillName,
  stripToolMetadata,
  stripMcpMetadata, // deprecated alias for backwards compatibility
  validateConfigWrite,
  // Centralized pipeline
  runPreToolUseChecks,
  shouldPromptInAskMode,
  shouldPromptInAutoMode,
  // The floors, shared with the seams that cannot run the pipeline (P2.140)
  findNonNegotiableFloors,
  firstNonNegotiableFloor,
  // P6.137 — the `EnterWorktree` floor, for the ONE seam that cannot run the
  // pipeline at all: `runPreToolUseChecks` has zero call sites in
  // `codex-agent.ts`, so the host consults these three directly for a bridged
  // codex enter. Exported rather than re-implemented for P2.140's reason.
  buildWorktreeApprovalScope,
  describeWorktreeEnterApproval,
  evaluateWorktreeApproval,
} from './pre-tool-use.ts';
export type {
  NonNegotiableFloorMatches,
  NonNegotiableFloorVerdict,
} from './pre-tool-use.ts';

// Guardian consult (auto-mode borderline safety judge)
export {
  GuardianConsultState,
  guardianVerdictAllows,
  GUARDIAN_CONSECUTIVE_DENY_LIMIT,
  GUARDIAN_WINDOW_DENY_LIMIT,
  GUARDIAN_WINDOW_SIZE,
  GUARDIAN_DENY_LOOP_LIMIT,
} from './guardian-consult.ts';
export type {
  GuardianJudgePort,
  GuardianConsultOutcome,
  GuardianAskReason,
  GuardianConsultParams,
  ActionHasher,
} from './guardian-consult.ts';

// Guardian judge core (spawn-injected read-only judge; its two live callers are named in guardian-judge-core.ts's header)
export {
  runGuardianJudgeCore,
  GUARDIAN_DEFAULT_TIMEOUT_MS,
} from './guardian-judge-core.ts';
export type {
  GuardianSpawn,
  GuardianSpawnArgs,
  GuardianSpawnResult,
  GuardianRunResult,
  RunGuardianJudgeCoreOptions,
} from './guardian-judge-core.ts';

// Prerequisite Manager
export { PrerequisiteManager } from './prerequisite-manager.ts';
export type {
  PrerequisiteRule,
  PrerequisiteCheckResult,
  PrerequisiteManagerConfig,
} from './prerequisite-manager.ts';

// Re-export skill plugin constant (used by renderer for mention qualification)
export { AGENTS_PLUGIN_NAME } from '../../skills/types.ts';

// RTK detector
export { getRtkPath, getRtkStatus, getRtkGain, resetRtkPathCache } from './rtk-detector.ts';
export type { RtkStatus, RtkGainStats } from './rtk-detector.ts';

// The ONE dangerous-command list and the grant vocabulary that reads it. Both
// stores of an Always-Allow answer key on `bashSessionWhitelistKey` (D1.404), so
// the host needs it by name; `PermissionRequest.tsx` reads the same leaf module
// through its own subpath export, which is why nothing here may grow an import.
export {
  DANGEROUS_COMMANDS,
  COMMAND_INTERPRETER_HEADS,
  bashAlwaysAllowRuleContent,
  bashSessionWhitelistKey,
  commandHeadName,
  headNamesCommandInterpreter,
  headsDangerousCommandPair,
  isDangerousCommandLine,
  whitelistedBashPrefix,
} from './dangerous-commands.ts';

// D1.436 — and the SCOPE half of the same answer: which runtimes read a durable
// Bash rule back, so a card that says "session" cannot write one. Same leaf
// discipline as above — one type-only import, nothing of the permission engine.
export { bashAlwaysAllowRememberScope } from './bash-remember-scope.ts';
export type { BashRememberScope } from './bash-remember-scope.ts';
