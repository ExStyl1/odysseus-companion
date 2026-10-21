/**
 * @license
 * Copyright 2025 Nessy CLI Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Stage 1 HTTP→ACP bridge — backward-compat re-export shim.
 *
 * #4175 PR F1 lifted the bridge core (`BridgeClient`,
 * `defaultSpawnChannelFactory`, `createAcpSessionBridge` factory closure,
 * plus the supporting types/errors/options/status) to
 * `@nestor/nessy-cli-acp-bridge`. This shim preserves the CLI-local bridge import
 * surface so `server.ts`, `run-nessy-serve.ts`, `workspace-agents.ts`,
 * `workspace-memory.ts`, `index.ts`, plus the bridge test suite, keep resolving
 * through one module.
 *
 * The implementation now lives at:
 *   - `@nestor/nessy-cli-acp-bridge/bridge` — `createAcpSessionBridge` factory
 *   - `@nestor/nessy-cli-acp-bridge/bridgeClient` — `BridgeClient` class +
 *     permission record types
 *   - `@nestor/nessy-cli-acp-bridge/spawnChannel` — `defaultSpawnChannelFactory`
 *   - `@nestor/nessy-cli-acp-bridge/bridgeOptions` — `BridgeOptions` +
 *     `DaemonStatusProvider` interfaces
 *   - `@nestor/nessy-cli-acp-bridge/bridgeTypes` — bridge session + heartbeat
 *     types + `AcpSessionBridge` interface
 *   - `@nestor/nessy-cli-acp-bridge/bridgeErrors` — typed bridge error classes
 *   - `@nestor/nessy-cli-acp-bridge/workspacePaths` — `canonicalizeWorkspace`
 *     + `MAX_WORKSPACE_PATH_LENGTH`
 *   - `@nestor/nessy-cli-acp-bridge/status` — protocol-versioned status types
 *     + idle envelope helpers
 *   - `@nestor/nessy-cli-acp-bridge/channel` — `AcpChannel` + `ChannelFactory`
 *
 * The bridge is bound to a single canonical workspace
 * (`BridgeOptions.boundWorkspace`); multi-workspace deployments use
 * multiple daemon processes. See the module docstring on `bridge.ts`
 * in the lifted package for the full Stage 1/Stage 2 contract.
 */

export {
  createAcpSessionBridge,
  createHttpAcpBridge,
} from '@nestor/nessy-cli-acp-bridge/bridge';
export { defaultSpawnChannelFactory } from '@nestor/nessy-cli-acp-bridge/spawnChannel';
// `MAX_RESOLVED_PERMISSION_RECORDS`, `PendingPermission`,
// `PermissionResolutionRecord` re-exports were removed alongside the
// source definitions — the mediator now owns pending+resolved state.
export { BridgeClient } from '@nestor/nessy-cli-acp-bridge/bridgeClient';
export type { BridgeClientSessionEntry } from '@nestor/nessy-cli-acp-bridge/bridgeClient';

export type {
  AcpChannel,
  AcpChannelExitInfo,
  ChannelFactory,
} from '@nestor/nessy-cli-acp-bridge';

export type {
  BridgeOptions,
  DaemonStatusProvider,
} from '@nestor/nessy-cli-acp-bridge/bridgeOptions';

export type { BridgeFileSystem } from '@nestor/nessy-cli-acp-bridge/bridgeFileSystem';

export type {
  BridgeSpawnRequest,
  BridgeSession,
  BridgeRestoreSessionRequest,
  BridgeSessionState,
  BridgeRestoredSession,
  BridgeSessionSummary,
  SessionMetadataUpdate,
  BridgeClientRequestContext,
  BridgeHeartbeatResult,
  BridgeHeartbeatState,
  BridgeDaemonStatusLimits,
  BridgeDaemonSessionDiagnostic,
  BridgeDaemonStatusSnapshot,
  AcpSessionBridge,
  HttpAcpBridge,
} from '@nestor/nessy-cli-acp-bridge/bridgeTypes';

export {
  BranchWhilePromptActiveError,
  SessionNotFoundError,
  RestoreInProgressError,
  InvalidSessionScopeError,
  SessionLimitExceededError,
  PromptQueueFullError,
  WorkspaceMismatchError,
  InvalidClientIdError,
  InvalidPermissionOptionError,
  InvalidSessionMetadataError,
  WorkspaceInitConflictError,
  WorkspaceInitPathEscapeError,
  WorkspaceInitSymlinkError,
  WorkspaceInitRaceError,
  McpServerNotFoundError,
  McpServerRestartFailedError,
  SessionBusyError,
  InvalidRewindTargetError,
  NOT_CURRENTLY_GENERATING_CANCEL_MESSAGE,
  // Multi-client permission coordination errors.
  CancelSentinelCollisionError,
  PermissionForbiddenError,
  PermissionPolicyNotImplementedError,
  SessionShellClientRequiredError,
  SessionShellDisabledError,
} from '@nestor/nessy-cli-acp-bridge/bridgeErrors';

export {
  MAX_WORKSPACE_PATH_LENGTH,
  canonicalizeWorkspace,
} from '@nestor/nessy-cli-acp-bridge/workspacePaths';
