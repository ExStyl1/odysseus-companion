/**
 * Agent Backend Abstraction Layer
 *
 * This module provides a unified interface for AI agents (Claude, Pi)
 * allowing seamless provider switching.
 *
 * Naming convention:
 * - ClaudeAgent: Claude SDK implementation (implements AgentBackend directly)
 * - PiAgent: Pi unified API implementation
 * - AgentBackend: Interface that all agents implement
 * - createAgent: Factory function to create agents
 *
 * Usage:
 * ```typescript
 * import { createAgent, type AgentBackend } from '@nessy-agent/shared/agent/backend';
 *
 * const agent = createAgent({
 *   provider: 'anthropic',
 *   workspace: myWorkspace,
 *   model: 'claude-sonnet-4-6',
 * });
 *
 * for await (const event of agent.chat('Hello')) {
 *   console.log(event);
 * }
 * ```
 */

// Core types
export type {
  AgentBackend,
  AgentProvider,
  CoreBackendConfig,
  BackendConfig,
  BackendHostRuntimeContext,
  PluginNodeRuntimeBinding,
  WindowsSandboxRuntimeBinding,
  PermissionCallback,
  PlanCallback,
  AuthCallback,
  SourceChangeCallback,
  SourceActivationCallback,
  ChatOptions,
  RecoveryMessage,
  RuntimeHandoffDelivery,
  RuntimeHandoffHistoryItem,
  RuntimeHandoffPayload,
  SdkMcpServerConfig,
  LlmAuthType,
  LlmProviderType,
  PostInitResult,
  CloudComposerModeOption,
  CapabilityTurnRuntime,
} from './types.ts';

// Enums need to be exported as values, not just types
export { AbortReason } from './types.ts';

// Factory
export {
  createBackend,
  createAgent,
  getAvailableProviders,
  isProviderAvailable,
  // LLM Connection support
  resolveSessionConnection,
  resolveBackendContext,
  resolveSetupTestConnectionHint,
  createConfigFromConnection,
  createBackendFromConnection,
  createBackendFromResolvedContext,
  initializeBackendHostRuntime,
  resolveBackendHostTooling,
  fetchBackendModels,
  validateStoredBackendConnection,
  providerTypeToAgentProvider,
  // Capabilities and utilities
  BACKEND_CAPABILITIES,
  resolveModelForProvider,
  getDefaultAuthType,
  cleanupSourceRuntimeArtifacts,
  testBackendConnection,
  // Connection validation
  validateConnection,
} from './factory.ts';
export { resolveComposerCapabilities } from './composer-capabilities.ts';
export { resolvePluginNodeRuntime, resolveWindowsSandboxRuntime } from './internal/runtime-resolver.ts';

/**
 * The binary-on-disk halves of "can this runtime start here", re-exported for
 * `server-core`'s pre-switch hostability check (`canHostSession`): a runtime
 * switch's teardown is irreversible, so the target's binary must be checked
 * BEFORE it, not discovered missing at the first turn. `resolveCodexBinaryPath`
 * answers Codex directly; Claude's resolver is module-private, so the check
 * reads `resolveBackendRuntimePaths(...).claudeCliPath` (and Pi's
 * `.piServerPath`) instead.
 */
export { resolveBackendRuntimePaths, resolveCodexBinaryPath } from './internal/runtime-resolver.ts';

/**
 * The gateway-vs-BYO classification, re-exported from the driver-internal module
 * that owns it. Public because `server-core`'s model-refresh fetchers must reach
 * exactly the same verdict as the drivers do: "which URL may be served with
 * `Nestor-Token`" is one governance boundary, and a second copy of it in the
 * refresh path is precisely how that boundary drifts (it already had — the
 * fetchers were gating on a `…/api/v1/cli/` PREFIX match).
 */
export { isNessyGatewayBaseUrl } from './internal/drivers/upstream-target.ts';

/**
 * DA1.13 — the same boundary asked as a question about a CONNECTION rather than
 * a URL: is this one of the one-click gateway cards, whose credential of record
 * is the shared dp JWT and which therefore keeps none of its own? Public for the
 * same reason as its neighbour above: `server-core`'s setup RPC and its
 * connection-status listing must reach the verdict the drivers reach.
 */
export { isGatewayBackedConnection } from './internal/drivers/upstream-target.ts';

// Shared infrastructure
export { BaseEventAdapter } from './base-event-adapter.ts';
export { EventQueue } from './event-queue.ts';

// Provider-specific event adapters
export { ClaudeEventAdapter } from './claude/event-adapter.ts';
export { PiEventAdapter } from './pi/event-adapter.ts';

// Agent implementations are imported directly by factory.ts
// Consumers should use createAgent() / createBackend() instead of concrete classes
