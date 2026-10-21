/**
 * Core Agent Types
 *
 * Shared types used by both ClaudeAgent and PiAgent.
 * These types define the interfaces for core functionality that is
 * provider-agnostic and shared across all agent implementations.
 */

import type { LoadedSource } from '../../sources/types.ts';
import type { ResolvedWorkspace as Workspace } from '../../workspaces/types.ts';
import type { SessionConfig } from '../../sessions/storage.ts';

// Re-export common types from mode-types for convenience
// These are the types needed by permission evaluation
export type {
  PermissionMode,
  ModeConfig,
  CompiledApiEndpointRule,
  CompiledBashPattern,
  MismatchAnalysis,
  PermissionPaths,
} from '../mode-types.ts';

export {
  PERMISSION_MODE_ORDER,
  PERMISSION_MODE_CONFIG,
  SAFE_MODE_CONFIG,
} from '../mode-types.ts';

// Re-export ToolCheckResult from mode-manager
export type { ToolCheckResult } from '../mode-manager.ts';

/**
 * Message type for recovery context building.
 * Used when SDK session resume fails and we need to inject previous conversation context.
 */
export interface RecoveryMessage {
  type: 'user' | 'assistant';
  content: string;
}

/**
 * Configuration for PermissionManager
 */
export interface PermissionManagerConfig {
  /** Workspace ID for permission context */
  workspaceId: string;
  /** Session ID for mode state */
  sessionId: string;
  /**
   * Managed Workspace root path — the source of the workspace `permissions.json`.
   * Invariant for the session; MUST come from managed storage
   * (`getWorkspaceRootPath(workspaceId)`), never the project `workingDirectory`.
   */
  workspaceRootPath?: string;
  /** Working directory (project cwd) — used for command/file cwd, not permission files. */
  workingDirectory?: string;
  /** Plans folder path (Plan mode may write its own plan file here) */
  plansFolderPath?: string;
  /** Data folder path (Plan mode may write here, e.g. transform_data output — F1.1050 moved it from the retired Explore) */
  dataFolderPath?: string;
}

/**
 * Result of a tool permission check with detailed information
 */
export interface ToolPermissionResult {
  /** Whether the tool is allowed */
  allowed: boolean;
  /** If not allowed, the reason why */
  reason?: string;
  /** If allowed but requires user confirmation */
  requiresPermission?: boolean;
  /** Description for permission prompt */
  description?: string;
}

/**
 * Configuration for SourceManager
 */
export interface SourceManagerConfig {
  /** Debug callback for logging */
  onDebug?: (message: string) => void;
  /**
   * P6.343 — the slugs whose MCP connection is CURRENTLY broken, read live from
   * the pool rather than from the stored source config.
   *
   * `SourceConnectionStatus` has declared `'failed'` since it was written and no
   * production code has ever assigned it, so the model-facing `<source_issue>`
   * surface — which already exists and is already reached on all three runtimes
   * — never fired for a broken server. A session behaved as though a configured
   * source had never been configured.
   *
   * A LIVE READ rather than a write into the stored config, deliberately: a
   * transient connect failure is not a property of the user's source, and
   * persisting it would leave a source marked broken long after it recovered.
   * Optional so a caller with no pool (and every existing test) is unchanged.
   */
  failedSourceSlugs?: () => readonly string[];
  /**
   * P6.715 — WHY each of those slugs failed, where the pool caught a reason.
   *
   * A separate reader rather than a richer `failedSourceSlugs` return: a slug
   * can be failed with no reason behind it (a capability failure is a verdict,
   * not a transport error), so the list of what failed and the lookup of why
   * are different questions and answering them in one shape would force every
   * caller to carry an empty reason for the common case.
   *
   * Read live for the same reason the slugs are: the last error of a source
   * that has since recovered is not a fact about that source.
   */
  failedSourceErrors?: () => Readonly<Record<string, string>>;
  /**
   * UB12.114 — the slugs this session's pool holds a LIVE connection to, read
   * from the same `health(leaserId)` as {@link failedSourceSlugs} (its
   * `connected` list).
   *
   * The live arm that RETIRES a stored failed verdict, symmetric to the live
   * arm that raises one (F1.542): `source_test` persists `'error'` /
   * `'disconnected'` and nothing rewrites it until the next test, an auth
   * success or a token refresh, so without this reader a source whose tools
   * work this session was still reported unreachable on every turn. Consulted
   * for MCP sources only — an API source connects in process with no transport
   * (`McpClientPool.connectInProcess`), so reading `connected` says nothing
   * about the endpoint the stored test probed. Optional so a caller with no
   * pool (and every existing test) keeps the stored verdict as it stands.
   */
  connectedSourceSlugs?: () => readonly string[];
}

/**
 * Configuration for PromptBuilder
 */
export interface PromptBuilderConfig {
  /** Workspace configuration */
  workspace: Workspace;
  /** Session configuration */
  session?: SessionConfig;
  /** Whether debug mode is enabled */
  debugMode?: {
    enabled: boolean;
    logFilePath?: string;
  };
  /** System prompt preset ('default' | 'mini' | custom string) */
  systemPromptPreset?: 'default' | 'mini' | string;
  /** Whether running in headless mode */
  isHeadless?: boolean;
  /**
   * Whether the project `workingDirectory` is explicitly trusted (W6). Project
   * context files (`AGENTS.md`, `CLAUDE*`) are read only when true; defaults to
   * untrusted (fail-closed).
   */
  projectTrusted?: boolean;
}

/**
 * Context block options for building system prompt context
 */
export interface ContextBlockOptions {
  /** Current permission mode (optional - included in session state via formatSessionState) */
  permissionMode?: string;
  /** Plans folder path */
  plansFolderPath?: string;
  /** Data folder path (transform_data tool output) */
  dataFolderPath?: string;
  /** Active source slugs */
  activeSources?: string[];
  /** Inactive source slugs */
  inactiveSources?: LoadedSource[];
  /** Whether local MCP is enabled */
  localMcpEnabled?: boolean;
  /** F1.743 — compose no `<session_state>` block (a Guardian judge: its task states the REVIEWED session's mode, and its own explore mode was read as that mode). The one-shot mode signal is then not consumed. */
  omitSessionState?: boolean;
}

/**
 * Configuration for PathProcessor
 */
export interface PathProcessorConfig {
  /** Home directory (defaults to os.homedir()) */
  homeDir?: string;
}

/**
 * Configuration for ConfigValidator
 */
export interface ConfigValidatorConfig {
  /** Workspace path for config files */
  workspacePath?: string;
}

/**
 * Result of config validation
 */
export interface ConfigValidationResult {
  /** Whether the config is valid */
  valid: boolean;
  /** Validation errors if invalid */
  errors?: string[];
  /** Validation warnings (valid but potentially problematic) */
  warnings?: string[];
}

/**
 * Detected config file type
 */
export type ConfigFileType = 'json' | 'toml' | 'yaml' | null;
