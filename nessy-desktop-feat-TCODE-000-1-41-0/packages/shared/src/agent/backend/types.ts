/**
 * Backend Abstraction Types
 *
 * Defines the core interface that all AI backends (Claude, OpenAI, etc.) must implement.
 * The NessyAgent facade delegates to these backends, enabling provider switching while
 * maintaining a consistent API surface.
 *
 * Key design decisions:
 * - Provider-agnostic events: All backends emit the same AgentEvent types
 * - Capabilities-driven UI: Model/thinking selectors read from capabilities()
 * - Callback pattern: Facade sets callbacks after creating backend
 * - AsyncGenerator for streaming: Consistent with existing NessyAgent API
 */

import type { SessionFilesystemScope, SessionFilesystemScopeRoot } from '../session-filesystem-scope.ts';
import type { HeapdumpWriteResult } from '../../diagnostics/heapdump.ts';
import type { AgentEvent, AskUserAnswer, AskUserPermissionRequest, ContextUsageSnapshot, FirstOutsideReadPermissionRequest, PermissionRequestOrigin, PiHarnessManifestDiagnosticsV1 } from '@nessy-agent/core/types';
import type { FileAttachment } from '../../utils/files.ts';
import type { ThinkingLevel } from '../thinking-levels.ts';
import type {
  DocumentedTaskCommand,
  DocumentedTaskResult,
  SessionCronPort,
  SessionGoalPort,
  SessionNotificationPort,
} from '@nessy-agent/session-tools-core';
import type { PermissionMode } from '../mode-manager.ts';
import type { HookTaskRegistryPort } from '../../automations/hook-task-registry.ts';
import type { LoadedSource } from '../../sources/types.ts';
import type { AuthRequest } from '../session-scoped-tools.ts';
import type { McpClientPool } from '../../mcp/mcp-pool.ts';
import type { ModelTargetVerdict } from './internal/drivers/upstream-target.ts';
import type { ResolvedWorkspace as Workspace } from '../../workspaces/types.ts';
import type { SessionConfig as Session } from '../../sessions/storage.ts';
import type { SourceManager } from '../core/source-manager.ts';
import type { AgentRuntimeView } from '../../capabilities/views.ts';
import type { CapabilitySnapshotMaterializer } from '../../capabilities/materializer.ts';
import type { PiExecutionManifestSeedV2 } from '../pi-harness/harness-manifest.ts';
import type { ProcessSupervisorPort } from '../pi-harness/process-supervisor-port.ts';
import type { PiContextProfile, PiPermissionServicePort } from '../pi-harness/permission-receipt.ts';
import type { SessionKey } from '../../sessions/session-key.ts';
import type { ResolvedAutoModePolicyV1 } from '../pi-harness/managed-policy.ts';
import type { PermissionDslV1 } from '../pi-harness/permission-dsl.ts';
import type { ResolvedWorkflowSettings } from '../../config/workflow-settings.ts';
import type { PiChildSessionPort } from '../pi-harness/child-session-port.ts';
import type { GuardianJudgePort } from '../core/guardian-consult.ts';
import type { PiLspPort } from '../pi-harness/lsp-port.ts';
import type { PiCompactionReferences } from '../pi-harness/prompt-composer.ts';
import type { PiContextResourceDescriptor } from '../pi-harness/context-resource.ts';
import type { PiRuntimeAgentDefinitionDescriptor } from '../pi-harness/runtime-agent-definition.ts';
import type { SessionAgentDefinitionV1 } from '../../agents/definitions.ts';
import type { ProjectTrustState } from '../../capabilities/types.ts';
import type { SafeExecutionReceiptInputV1 } from '../pi-harness/execution-observability.ts';
import type { ContinuationEnvelopeV1, PiContinuationRuntimeStateV1 } from '../pi-harness/continuation-envelope.ts';
import type { RuntimeSkillContextExecutor } from '../../capabilities/runtime-skill-context.ts';
import type { ResolvedAutoCompactionSettings } from '../../config/auto-compaction-settings.ts';

// Import AbortReason and RecoveryMessage from core module (single source of truth)
import { AbortReason, type RecoveryMessage } from '../core/index.ts';
export { AbortReason, type RecoveryMessage };

import type { AdvisorTranscriptEntry } from '../advisor.ts';

import type { ModelProvider } from '../../config/models.ts';
import type { HistoryCarryPlan } from '../../protocol/runtime-switch.ts';

/**
 * The one-shot obligation a cross-runtime switch leaves behind, and the plan
 * the switch already decided for it.
 *
 * `plan` is P3's `planHistoryCarry` answer, carried here because it is the ONLY
 * thing that tells a backend whether its native path is licensed for this turn.
 * The decision is not the backend's to make: the modal has already promised the
 * user one of three things, and a runtime that re-derived its own bounds could
 * deliver something the user was not shown. `undefined` on a payload armed
 * before this field existed (or by a caller that has no planner) — read as
 * `'text'`, which is the shipped behaviour.
 */
export interface RuntimeHandoffPayload {
  /** The provider the session was moved OFF. */
  from: string;
  messages: RecoveryMessage[];
  plan?: HistoryCarryPlan;
  /**
   * T1b · the ROW-level projection, present only on a `native` plan.
   *
   * `messages` above is the projection the TEXT handoff has always used, and it
   * keeps that meaning exactly: user/assistant rows, `isIntermediate` dropped,
   * ready for `buildRuntimeHandoffContext`. It is still built on a `native` plan
   * because it is the in-turn fallback when the native delivery is refused.
   *
   * `history` is the other projection, and it is deliberately a different one
   * (plan §P.2(b)): it keeps `isIntermediate` assistant rows — 61.8% of all
   * assistant rows, the model's own commentary between tool calls — and it
   * carries tool traffic as paired call/result entries. A backend that receives
   * it may hand it to its runtime as native model-visible history; a backend
   * that does not understand it ignores the field and the text tier is
   * unchanged.
   */
  history?: RuntimeHandoffHistoryItem[];
}

/**
 * One entry of the row-level handoff history.
 *
 * A `tool` entry is ONE pair, never a lone call: `callId` links the two halves
 * and the backend must emit them adjacent and in order. An unpaired tool call
 * in model-visible history is a hard provider error, which is why the pairing
 * is expressed in the type rather than left to the mapper.
 *
 * A `reasoning` entry is SAME-RUNTIME ONLY, and the projection is what enforces
 * it: an entry of this kind exists only when the row's origin is the runtime
 * taking over. Cross-runtime reasoning is dropped upstream rather than emitted
 * and filtered here, so a mapper never has to re-derive provenance.
 *
 * **P6.604 — the "deliberately absent" note this docblock carried is RETIRED,
 * and its stated reason was refuted rather than outgrown.** It read: *"reasoning
 * / thinking items (the corpus holds zero, and the app-server writes
 * `encrypted_content: null` for them)"*. Both halves were wrong as an argument.
 * The corpus holds plenty — P4.4 persists `isThinking` on stored rows, and
 * 149 of the first 200 of 5 324 `~/.claude/projects/**` transcripts carry
 * `"type":"thinking"` beside a `"signature"`. And `encrypted_content: null` is
 * not an obstacle: `ReasoningResponseItem` at `rust-v0.148.0` is
 * `"required": ["summary","type"]` with `"encrypted_content": {"type":
 * ["string","null"]}`, so the ATTESTATION is optional and the reasoning TEXT is
 * required plaintext. Codex's own replay format takes the item as-is.
 *
 * What was actually true — and is the reason the kind had to exist before
 * either replay arm could — is that no producer emitted such a row, so a
 * mapper arm would have been a branch nothing could reach.
 *
 * Still deliberately absent: the volatile per-turn context blocks, which stay
 * on the user message where G5 put them.
 */
export type RuntimeHandoffHistoryItem =
  | ({ kind: 'message'; role: 'user' | 'assistant'; content: string } & RuntimeHandoffHistoryProvenance)
  | ({
      kind: 'reasoning';
      /** The reasoning text as the producing runtime wrote it. Never a summary of ours. */
      content: string;
      /**
       * Anthropic's `signature` for this block, when the row carries one.
       *
       * It is an ATTESTATION, not decoration: a `thinking` block replayed to
       * the Messages API without a valid signature is a 400. So a claude replay
       * emits the block only WITH it and strips the row otherwise — half a
       * signed block is not a degraded read, it is a refused request.
       *
       * Absent on codex-origin rows by construction: codex's
       * `ReasoningResponseItem` carries `encrypted_content`, which our Responses
       * leg sets to `null` because we hold no attestation of codex's either.
       */
      signature?: string;
    } & RuntimeHandoffHistoryProvenance)
  | ({
      kind: 'tool';
      /** Deterministic, minted from the stored row id — stable across rebuilds. */
      callId: string;
      name: string;
      input: Record<string, unknown>;
      output: string;
    } & RuntimeHandoffHistoryProvenance);

/**
 * T2 · what a REBUILT transcript needs beyond the content itself, carried on
 * every entry and emitted only when the stored row has it.
 *
 * Codex ignores both (`buildCodexInjectItems` maps on `kind` and reads nothing
 * else), which is why they are additive rather than a second projection: the
 * `text` and `anchor` tiers are untouched, and a row carrying neither produces
 * byte-identical output to what T1b shipped.
 */
export interface RuntimeHandoffHistoryProvenance {
  /**
   * The stored row's own time, epoch milliseconds.
   *
   * Claude's transcript records carry an ISO `timestamp`, and the SDK's loader
   * falls back to timestamp ORDER when a chain is incomplete — so the honest
   * per-row time is worth carrying rather than stamping the whole rebuild with
   * one clock read.
   */
  timestamp?: number;
  /**
   * D10 · which of our runtimes produced this row.
   *
   * Absent means "the session's current runtime" per `core/types/message.ts`,
   * never a distinct value — 4 533 of 5 332 stored rows have none, so a reader
   * must not treat absence as a fourth provider.
   */
  runtime?: string;
}

/**
 * How a runtime handoff actually reached the model. Mirrors the native members
 * of `RuntimeSwitchResult['contextCarried']`, reported from the turn that
 * delivered it rather than from the switch that armed it.
 */
export type RuntimeHandoffDelivery = 'text' | 'native-inject' | 'native-transcript';

// Import LLM connection types for auth
import type { LlmAuthType, LlmProviderType } from '../../config/llm-connections.ts';
export type { LlmAuthType, LlmProviderType } from '../../config/llm-connections.ts';

export interface BackendRuntimeUpdate {
  model: string;
  /**
   * UB12.11 — the background tier's model as the live refresh re-resolves it (the build-time
   * `getMiniModel(connection) ?? defaultModel`), so a rotated gateway `fast` id reaches a live Pi
   * subprocess. Absent = unchanged. Pi reads it; claude respawns instead (no in-place update);
   * codex adopts it in its model-only update (UB12.37; `default_subagent_model` stays spawn-time).
   */
  miniModel?: string;
  providerType?: LlmProviderType;
  authType?: LlmAuthType;
  runtime?: {
    baseUrl?: string;
    piAuthProvider?: string;
    customEndpoint?: { api: string; supportsImages?: boolean };
    // P6.367 — `supportsThinking`: see `driver-types.ts`'s copy of this type.
    customModels?: Array<string | {
      id: string;
      contextWindow?: number;
      supportsImages?: boolean;
      supportsThinking?: boolean;
      /** DA1.22 — the catalogue's sampling params: see `driver-types.ts`'s copy. */
      samplingParams?: Record<string, unknown>;
    }>;
    [key: string]: unknown;
  };
}

export type WorkingDirectoryBindingIntent = 'keep' | 'bind' | 'unbind';

export interface WorkingDirectoryUpdateInput {
  previousPath: string;
  path: string;
  intent: WorkingDirectoryBindingIntent;
  /** Host-resolved executable eligibility for the destination project. */
  projectTrusted: boolean;
}

export interface WorkingDirectoryUpdateTransaction {
  readonly generation: number;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  finalize(): Promise<void>;
}
import type {
  AgentAutomationSystem,
  AgentEvent as AutomationAgentEvent,
  AgentEventExecutionResult,
  ComponentHookLayer,
  SessionEndReason,
} from '../../automations/index.ts';

/**
 * Provider identifier for AI backends.
 * @deprecated Use ModelProvider from config/models.ts instead
 */
export type AgentProvider = ModelProvider;


// ============================================================
// Callback Types
// ============================================================

/**
 * Permission prompt types for different tool categories.
 */
export type PermissionRequestType = 'bash' | 'file_write' | 'mcp_mutation' | 'api_mutation' | 'admin_approval' | 'workflow_launch' | 'worktree_approval' | 'worktree_setup' | 'worktree_cleanup' | 'ask_user' | 'outside_root' | 'permission_dsl';

/**
 * Permission request callback signature.
 * Called when a tool requires user permission before execution.
 */
export type PermissionCallback = (request: {
  requestId: string;
  toolName: string;
  command?: string;
  description: string;
  type?: PermissionRequestType;
  appName?: string;
  reason?: string;
  impact?: string;
  requiresSystemPrompt?: boolean;
  rememberForMinutes?: number;
  /**
   * Hide the client's Always Allow button. For prompts nothing can remember — no `commandHash` on
   * this side, no persistence on the backend's — the button would promise what neither side implements.
   */
  noAlwaysAllow?: boolean;
  defaultToNo?: boolean; alwaysAllowScope?: 'workspace'; // F1.1219 — the card opens on Deny, never on Allow; core `PermissionRequest.defaultToNo`. F1.1236 — core `PermissionRequest.alwaysAllowScope`
  commandHash?: string;
  approvalTtlSeconds?: number;
  askUser?: AskUserPermissionRequest;
  /**
   * Which surface raised this prompt (P6.709). A backend relaying its runtime's
   * OWN approval request names it here (`claude_native`, `codex_approval`);
   * everything else leaves it unset and the session layer names the host gate.
   * Absent on the wire means UNKNOWN, never host — see
   * `PERMISSION_REQUEST_ORIGIN_VALUES`.
   */
  origin?: PermissionRequestOrigin;
  /**
   * P6.202 clause (3) — present ONLY on auto mode's first read outside the
   * working directories. Its PRESENCE selects the three-answer card; the type
   * stays `outside_root` and the tool really is a `Read`/`Grep`/`Glob`.
   */
  outsideWorkingDirectoryRead?: FirstOutsideReadPermissionRequest;
  /**
   * P6.863 — the permission MODE alone raised this prompt (no ask rule, no
   * hook, no floor), so a mode change can remove it. Absent means UNKNOWN.
   */
  modePrompt?: true;
}) => void;

/**
 * The backend-side twin of `protocol/dto.ts`'s interface of the same name. The
 * two are separate declarations of ONE wire shape and every field must exist in
 * both — the host forwards the object it received straight through
 * (`SessionManager.respondToPermission`), so a field added to one side only is
 * simply dropped, with nothing to report it.
 */
export interface PermissionResponseOptions {
  rememberForMinutes?: number;
  askUserAnswer?: AskUserAnswer;
  updatedInput?: Record<string, unknown>;
  /**
   * P6.951 — the note attached to a DENIAL, which the agent is told as the
   * reason. See the dto twin for the page's sentence and the three carve-outs.
   */
  comment?: string;
}

/**
 * Plan submission callback signature.
 * Called when agent submits a plan for user review.
 */
export type PlanCallback = (planPath: string) => void;

/**
 * Auth request callback signature.
 * Called when a source requires authentication.
 */
export type AuthCallback = (request: AuthRequest) => void;

/**
 * Source change callback signature.
 * Called when a source is activated, deactivated, or modified.
 */
export type SourceChangeCallback = (slug: string, source: LoadedSource | null) => void;

/**
 * Source activation request callback.
 * Returns true if source was successfully activated.
 */
export type SourceActivationCallback = (sourceSlug: string) => Promise<boolean>;

// ============================================================
// Lifecycle Types
// ============================================================

/**
 * D1.328 — the four rosters a runtime advertises about itself at session start.
 *
 * The Claude SDK's `system`/`init` message carries `tools`, `slash_commands`,
 * `skills` and `agents`; the claude event adapter has captured all four since
 * P6.1006 and, until this row, NOTHING read them. SIT-5b measured that three
 * ways on the packaged 1.40.0: `getSdkTools` occurs once in the whole tree (its
 * own declaration) against the sibling accessor `getModel()` at 41; the SDK's
 * persisted session file carries no `init` entry at all; and the adapter's own
 * `SDK init: captured <n> tools` debug line occurs 0 times in the packaged app's
 * captured output while other claude debug lines from the same runs are there.
 * So "what did the SDK advertise" had no answer anywhere outside the adapter's
 * private fields, and D1.18 and D1.29's advertisement half were both re-scoped
 * to need one.
 *
 * DIAGNOSTICS, not a user surface (the controller's decision, and the TRANSPARENT
 * and SIMPLE rule): plain names, no locale key, no copy. Every array is present
 * and possibly EMPTY rather than optional — the distinction between "the runtime
 * advertised no skills" and "nobody asked" is carried by the whole object being
 * absent, which is the same shape `ephemeral` and `ultracode` use on the DTO.
 */
export interface RuntimeAdvertisedRostersV1 {
  tools: string[];
  slashCommands: string[];
  skills: string[];
  agents: string[];
}

/**
 * Result of backend post-initialization (auth injection, config setup).
 * Returned by postInit() so the session layer can surface warnings.
 */
export interface PostInitResult {
  /** Whether auth credentials were successfully injected */
  authInjected: boolean;
  /** Optional warning message to surface in UI */
  authWarning?: string;
  /** Severity level for the warning */
  authWarningLevel?: 'error' | 'warning' | 'info';
  /** Runtime cloud composer modes discovered after backend initialization. */
  cloudModes?: CloudComposerModeOption[] | undefined;
}

export interface CloudComposerModeOption {
  mode: PermissionMode;
  label?: string;
  shortLabel?: string;
  description?: string;
  iconMode?: PermissionMode;
  remoteModeId: string;
}

/**
 * Context for applying bridge/config updates mid-session.
 * Used when sources change, tokens refresh, or auth completes.
 */
export interface BridgeUpdateContext {
  /** Path to the session folder */
  sessionPath: string;
  /** Currently enabled sources */
  enabledSources: LoadedSource[];
  /** Pre-built MCP server configs */
  mcpServers: Record<string, SdkMcpServerConfig>;
  /** Session ID */
  sessionId: string;
  /** Workspace root path */
  workspaceRootPath: string;
  /** Descriptive context for logging (e.g., 'token refresh', 'source enable') */
  context: string;
  /** URL of the McpPoolServer HTTP endpoint */
  poolServerUrl?: string;
}

/**
 * Host runtime context passed from the application shell (Electron/CLI/etc.).
 * This is intentionally provider-agnostic metadata; backend drivers resolve
 * provider-specific paths from this context internally.
 */
export interface BackendHostRuntimeContext {
  /** App root path (packaged app path or repository root in development) */
  appRootPath: string;
  /** Optional resources path (needed for packaged Windows runtime resolution) */
  resourcesPath?: string;
  /** Whether the host app is running as a packaged build */
  isPackaged: boolean;
  /** Optional runtime override for Node/Bun executable */
  nodeRuntimePath?: string;
  /** Optional interceptor bundle override (CJS bundle loaded via --require) */
  interceptorBundlePath?: string;
}

/** Trusted host-owned executable binding for qualified plugin runtimes. */
export interface PluginHostExecutableBinding {
  command: string;
  /** Fixed host-owned argv prefix (for example `uv tool run`). */
  args?: readonly string[];
  environment?: Record<string, string>;
  /** Exact host-owned state roots this executable must be able to update. */
  writableRoots?: readonly string[];
  externalAuthProvider?: 'dp';
}

/** Host-owned executable binding for plugin MCPs/hooks that declare bare `node`. */
export interface PluginNodeRuntimeBinding {
  command: string;
  environment?: Record<string, string>;
  /** Host-owned directory containing the packaged `node`/`node.cmd` Bun shim. */
  nodeShimDirectory?: string;
  /** Explicit host-approved non-package-manager executables for legacy manifests. */
  executables?: Readonly<Record<string, PluginHostExecutableBinding>>;
}

/**
 * Host-owned OpenAI Windows restricted-token sandbox toolchain. All three
 * executables come from the same pinned release archive and are treated as one
 * atomic runtime: a partial installation is unavailable, never downgraded.
 */
export interface WindowsSandboxRuntimeBinding {
  command: string;
  commandRunner: string;
  setupCommand: string;
}

/**
 * Provider-agnostic backend configuration used by the session layer.
 * Provider-specific runtime details are resolved by backend drivers internally.
 */
export interface CoreBackendConfig {
  /** Workspace configuration */
  workspace: Workspace;

  /** Host-owned runtime for plugin MCPs/hooks; absent fails closed for bare `node`. */
  pluginNodeRuntime?: PluginNodeRuntimeBinding;

  /**
   * P4: captured session filesystem authority. When present, local tools scope
   * every path decision to it (project primary root, approved extra roots).
   * Absent only in legacy/test construction; backends then build a no-project
   * fallback scope over the managed Workspace root.
   */
  filesystemScope?: SessionFilesystemScope;

  /** P4: server-owned receipt sink for session-lifetime outside-root grants. */
  onOutsideRootGranted?: (root: SessionFilesystemScopeRoot) => void;

  /** P10: safe receipt sink; never receives tool input, output, errors or paths. */
  onExecutionReceipt?: (receipt: SafeExecutionReceiptInputV1) => void;

  /**
   * P3.98 + P3.122: sink for MODEL SPEND THE HOST CAUSED — a call the runtime
   * made because of how we configured it, billed to our gateway and absent
   * from `modelUsage`. Reported as its own line rather than folded into the
   * turn's usage (owner-delegated decision 2026-09-02 §E1), which is why it
   * has a port of its own instead of riding `AgentEventUsage`.
   *
   * The backend hands over a finished `UsageMetricsTurn` (see
   * `telemetry/host-overhead-usage.ts`'s `hostOverheadTurn`) because only the
   * backend knows what the call WAS; the host only knows where to put it.
   * Every backend may leave it unset — today only the claude runtime has a
   * measured source.
   */
  onHostOverheadUsage?: (turn: import('../../telemetry/usage-metrics.ts').UsageMetricsTurn) => void;

  /**
   * DA2.15 — the ONE host sink for the model-target tool-egress disclosure.
   *
   * ## Why the disclosure needed a port of its own
   *
   * `noteModelTargetToolEgress`
   * (`agent/backend/internal/drivers/upstream-target.ts`) has always taken an
   * optional `emit` and, until this row, NONE of its three call sites passed one
   * — `backend/factory.ts`, `claude-agent.ts` and `codex-agent.ts`. So the only
   * channel was its `console.warn` default, and a packaged Electron build
   * disables the electron-log transports: the disclosure a user is entitled to
   * was being written where nobody could read it. DA2.6 shipped the copy and the
   * classifier for that disclosure and recorded, correctly, that there was
   * nothing to subscribe to.
   *
   * ## Shaped after {@link onHostOverheadUsage}, deliberately
   *
   * Same doctrine, one field up: the BACKEND knows what happened, the HOST knows
   * where to put it, and the three runtimes reach the user through three
   * different channels — so a notice written on any one runtime's path would
   * cover one and read as if it covered all three. One optional port, supplied
   * once by the host, threaded to all three sites. A backend whose host leaves it
   * unset behaves exactly as before, because `noteModelTargetToolEgress` falls
   * back to its own `console.warn` on an `undefined` `emit`.
   *
   * ## What arrives, and what a host must do with it
   *
   * ONE ready-made English sentence, already de-duplicated per
   * `(class, host, model-namespace, has-tool-names)` per PROCESS, so a host may
   * render it without a latch of its own. It carries tool NAMES at most, never a
   * schema — the schemas are the payload under discussion.
   *
   * A host that takes this port takes over the logging too: `emit` REPLACES the
   * `console.warn`, so a sink that only forwards to a renderer silently drops the
   * operator line. Log it on a channel a packaged build keeps, then forward.
   *
   * Best-effort by contract, like its neighbour: a disclosure that can fail a
   * session is worse than a disclosure nobody reads.
   */
  onModelTargetDisclosure?: (line: string) => void;

  /**
   * R7 Task 5: durable sink for a headless PreToolUse `defer` decision. The
   * host persists the record with the session so a later resume can re-fire
   * PreToolUse for the same call and apply the mode-restore rules. Called
   * with `undefined` when the record is consumed on resume.
   */
  onToolCallDeferred?: (record: import('../pi-harness/deferred-tool-call.ts').PiDeferredToolCallV1 | undefined) => void;

  /** R7 Task 5: reader for the persisted deferred call, consumed at resume. */
  getDeferredToolCall?: () => import('../pi-harness/deferred-tool-call.ts').PiDeferredToolCallV1 | undefined;

  /** Pi-only host process authority. Other backends ignore this optional seam. */
  processSupervisorPort?: ProcessSupervisorPort;

  /** Pi-only optional host LSP authority. The tool is absent until ready. */
  lspPort?: PiLspPort;
  /**
   * The host's ONE process-lifetime automatic-compaction policy — user setting
   * ∧ managed floor ∧ `DISABLE_AUTO_COMPACT`. Delivered to EVERY backend (it
   * was Pi-only until P6.53, which is how switching a session to Claude
   * silently re-enabled compaction the user had turned off); each backend
   * projects it onto its own runtime's native knob, and a backend with no such
   * knob ignores the field.
   */
  autoCompaction?: ResolvedAutoCompactionSettings;
  /** Pi-only one-shot context command runner for selected plugin skills. */
  runtimeSkillContextExecutor?: RuntimeSkillContextExecutor;
  getPiCompactionReferences?: () => PiCompactionReferences;
  /** Server-owned durable state restored on process/session recreation. */
  getPiContinuationEnvelope?: () => ContinuationEnvelopeV1 | undefined;
  /** One coherent Pi compaction boundary; never owns transcript or summarization. */
  onPiContinuationBoundary?: (
    phase: 'pre' | 'post' | 'failed' | 'cancelled',
    state: PiContinuationRuntimeStateV1,
  ) => void;
  /**
   * T30 — WHERE A DETACHED RUN'S EVENTS GO ONCE THE TURN THAT SPAWNED IT IS
   * OVER.
   *
   * Every other subprocess event reaches the host through the turn's own
   * generator, and `PiAgent` latches that generator shut at the turn's terminal
   * boundary (`rawEventAttemptTerminal`). A background subagent or workflow
   * OUTLIVES that boundary by design — the whole point of detaching it — so its
   * `task_completed` arrived after the latch and was dropped before it was ever
   * adapted. Measured three times on the operator profile 2026-08-21 (T26
   * sittings E/H/I): the child reached `status: completed` in the runtime's own
   * snapshot and the host recorded no completion for its task id, while
   * recording one for every run whose parent kept the turn alive.
   *
   * So detached lifecycle events get a sink that is not the turn. The host
   * routes them into the SAME `processEvent` the turn loop uses — never a second
   * delivery path — so R86's gate, the renderer forward and
   * `deliverMonitorEvent`'s idle/busy/first-turn discipline are all the
   * production ones.
   *
   * F1.492/F1.511/UA12.101 — `ClaudeAgent` (a between-turns task end, the CLI's own turn) and `CodexAgent` (an out-of-turn
   * terminal refresh) use it too, hence F1.510's name. Absent: Pi and Claude drop the events, codex parks them for its next turn.
   */
  onBetweenTurnsEvent?: (event: AgentEvent) => void;

  piContextResources?: readonly PiContextResourceDescriptor[];
  piRuntimeAgentDefinitions?: readonly PiRuntimeAgentDefinitionDescriptor[];

  /**
   * P6.317 (2) — the `--agents` JSON this session was created with, keyed by
   * agent name, unmaterialized.
   *
   * The descriptors above are the materialized form and are what every backend
   * READS. This field exists for the one backend that re-materializes: Pi
   * refreshes `piRuntimeAgentDefinitions` per turn against the live capability
   * view (see `pi-agent.ts`), and the definition digest is computed over the
   * content AND the generation together, so a refresh that omitted the session
   * definitions would drop them mid-session — silently, because the host's
   * pinned copy would still list them.
   */
  sessionAgents?: Readonly<Record<string, SessionAgentDefinitionV1>>;

  /** Pi-only host permission authority. Other backends ignore this optional seam. */
  permissionServicePort?: PiPermissionServicePort;

  /**
   * Pi-only semantic task authority; implementations remain host-owned.
   * `execute` is the legacy `Task` tool's channel; `executeDocumented` is the
   * R20 channel for `TaskCreate`/`TaskUpdate`/`TaskGet`/`TaskList`. Both reach
   * the same host store.
   */
  taskPort?: {
    execute(args: Record<string, unknown>): Promise<unknown>;
    executeDocumented?(command: DocumentedTaskCommand): Promise<DocumentedTaskResult>;
    /**
     * hooks.md:2117 — `TaskCompleted` also fires with no tool call "when an
     * agent team teammate finishes its turn with in-progress tasks".
     */
    notifyTurnEnd?(): Promise<void>;
  };

  /**
   * Session-scoped scheduling authority (R27b). The host owns the store, the
   * once-a-second check (`scheduled-tasks.md:172`) and the between-turns
   * delivery gate; the tools only describe the request. Absent when
   * `NESSY_DISABLE_CRON` is set (`:208`) or the session's runtime is outside
   * `SCHEDULED_DELIVERY_RUNTIMES`.
   *
   * Consumed by `pi-agent.ts`, which assigns it straight onto its tool context.
   * The Claude path reaches the SAME object through the per-session callback
   * registry instead, because it builds its context in-process.
   *
   * Was a hand-copied structural mirror of `session-tools-core`'s shape, with a
   * comment saying so; T3 replaced it with the named type, which is what makes
   * a rename on either side a compile error rather than a silent divergence.
   */
  cronPort?: SessionCronPort;

  /**
   * Synchronous reader for the `background_tasks` and `session_crons` arrays
   * `Stop` carries (hooks.md `:2190`, `:2194`). One port for both because the
   * docs give them ONE presence rule — "both arrays are present when the task
   * registry is reachable" — so a wiring that could supply one and not the other
   * would be able to contradict it.
   *
   * BOUND for every runtime in `SCHEDULED_DELIVERY_RUNTIMES` since T3: the
   * records exist wherever the session cron service does, and `provider === 'pi'`
   * was never the condition that makes `session_crons` exist. READ on all three
   * since T9, by two different shapes of consumer, and the difference is worth
   * keeping in view:
   *
   * - `pi-agent.ts` and `codex-agent.ts` (T5) EMIT `Stop` themselves and spread
   *   `hookTaskRegistryInput(config.hookTaskRegistryPort)` into the payload.
   * - `claude-agent.ts` emits no host-side `Stop` at all — a claude session's
   *   Stop hooks are driven by the SDK child — so T9 reads this port from the
   *   other end: `withClaudeHostTaskRegistry` ENRICHES the child's Stop and
   *   SubagentStop payload in the hook callback before the user's matcher runs.
   *   A second host-side emission was the alternative and was rejected by
   *   measurement: it would run every Stop matcher twice per turn, with two
   *   payloads that disagree. That merge is not symmetric with the other two:
   *   the port's SHELL entries are withheld there, because on claude the host
   *   mints them from the child's own Bash results and never retires them —
   *   see `withClaudeHostTaskRegistry`.
   *
   * So an absent port means the same thing everywhere; a present one is spread
   * by two backends and merged by the third.
   *
   * Absent means exactly "the task registry is not reachable", which is the
   * documented condition for the keys to be missing rather than empty.
   */
  hookTaskRegistryPort?: HookTaskRegistryPort;

  /**
   * Server-owned goal authority; never grants permissions or capabilities.
   *
   * Consumed by `pi-agent.ts`, which assigns it straight onto its tool context.
   * The Claude path reaches the SAME object through the per-session callback
   * registry, and codex reaches it over the host-callback bridge — P2.2's
   * three-runtime shape, identical to `cronPort` above. Named type for the same
   * reason: a hand-copied structural mirror is what a rename breaks silently.
   */
  goalPort?: SessionGoalPort;

  /**
   * Pi-only desktop notification authority for `PushNotification`. The host
   * fills in which session a notification navigates to, so the model supplies
   * text only. Absent outside a desktop shell.
   */
  notificationPort?: SessionNotificationPort;

  /** Pi-only durable child-session authority. */
  childSessionPort?: PiChildSessionPort;

  /**
   * Pi-only guardian safety-judge authority (plan: guardian-command-judge G2).
   * When present, `auto`-mode BORDERLINE tool actions (the set that asks the
   * user today) are consulted before asking: `no_objection` → allow, `deny` →
   * block, `unsure`/failure → ask (today's behavior). Absent => guardian never
   * consults and the band asks exactly as before. The judge runs as a
   * read-only child session through the host-owned {@link childSessionPort},
   * so no new host↔subprocess RPC class is introduced.
   */
  guardianJudgePort?: GuardianJudgePort;

  /** Pi child-session allowlist; omitted for normal top-level sessions. */
  piAllowedTools?: readonly string[];

  /**
   * P2.385 — the DENIAL list a Pi child was preloaded with, the subtraction
   * {@link piAllowedTools} cannot express.
   *
   * The pair is not symmetric and must not be read as if it were.
   * `piAllowedTools` is a positive NAME list, so it says "everything except X"
   * only by enumerating everything else; for a child with no ceiling it is
   * absent and there is nothing to subtract from. This field is the removal
   * itself, so it means "everything except X" without naming a universe — which
   * is why a ceiling-less child is expressible here and was not there.
   *
   * The names come from the invoked skills' `disallowed-tools`
   * (`skills.md#frontmatter-reference`: "Tools removed from Claude's available
   * pool while this skill is active"), collected in the PARENT at spawn time —
   * the only place they exist. `RuntimeSkillHandle` pins `allowed-tools` and
   * NOT `disallowed-tools`, so nothing downstream of that moment can re-derive
   * them from the persisted capability view; they have to travel.
   *
   * NOT a call-site input and not a ceiling: it can only ever remove, so a
   * transport caller cannot widen anything with it.
   *
   * THE PRODUCER EXISTS — P2.402 (`592596b76`) built it, and P2.406 corrected
   * this docblock, which said "PRODUCER STILL ABSENT" for as long as the hole
   * was closed. `SessionManager` fills
   * `PiChildRestrictionsV1.skillDisallowedTools` from the `skillDeniedTools` it
   * computes at the child-session chokepoint and projects it onto this field
   * for Pi children ONLY: Claude's route already merges the same names into
   * `AgentDefinition.disallowedTools`, an agent-lifetime field the SDK
   * enforces, so projecting there as well would double-apply a removal it never
   * dropped. See `BaseAgent`'s constructor install for the whole chain.
   *
   * WHAT THE COMPILER DOES NOT CHECK, said here because a transport field is
   * where a reader goes looking for the guarantee: the producer writes this
   * through a CONDITIONAL SPREAD — `...(names === undefined ? {} : {
   * skillDisallowedTools: [...names] })` — and excess-property checking does
   * not reach into a spread. Delete the field from `PiChildRestrictionsV1` and
   * that producer line still compiles, in silence; the single error that
   * appears is on the PROJECTION reading it back, which is not the line that is
   * wrong. Measured on tsc 5.9.3 with both controls: the same field as a direct
   * property literal errors (TS2353) and the read-back errors (TS2339), while
   * the spread is accepted.
   * `server-core/src/sessions/__tests__/preloaded-skill-denied-tools-producer.test.ts`
   * is the only guard on this field's NAME.
   */
  piSkillDisallowedTools?: readonly string[];

  /**
   * R48 (tools-reference.md:449-451, env-vars.md:284) — the session WebSearch
   * budget's host anchor. `getPiWebSearchesUsed` supplies the tree count a
   * (re)spawned Pi subprocess is seeded with on `InitMessage.webSearchesUsed`:
   * the session's last reported total, else the child seed inherited from the
   * spawning parent, else undefined (fresh budget). `onPiWebSearchUsage`
   * receives the subprocess's absolute count after every consume/fold — and a
   * literal 0 from `clearHistory()`, because after /clear the count IS zero
   * and the next subprocess must not be re-seeded with the pre-clear total.
   */
  getPiWebSearchesUsed?: () => number | undefined;
  onPiWebSearchUsage?: (used: number) => void;

  /**
   * P2.44 — THE SPEND CEILING'S SESSION-SCOPED ANCHOR, AND WHY IT IS A GETTER
   * RATHER THAN A FIELD.
   *
   * `BaseAgent.sessionCostUsd` is per AGENT INSTANCE, and a session outlives its
   * agent: a runtime-config change disposes and recreates one
   * (`SessionManager.tryRefreshAgentRuntime` → `managed.agent = await
   * createAgent()`), reopening a session builds a new one, and an app restart
   * builds one with no memory at all. So the ceiling restarted at \$0 every time,
   * and a user's cap was silently multiplied by however many times they had
   * switched connection or reopened the tab — the same walk-past the host-side
   * ceiling exists to prevent one scope down, where the SDK's own per-child cap
   * restarts at every respawn.
   *
   * This supplies the spend the session has ALREADY recorded, so a new instance
   * resumes the count instead of starting it. The host wires it to
   * `managed.tokenUsage.costUsd`, which is the same number the cost surface
   * renders and is built from the same per-turn increments the agent's counter
   * adds — one accumulator, hydrated from the session header, measured as the
   * only writer.
   *
   * A GETTER, not a constructor argument, because it is read lazily at the first
   * cap check of an instance: the cap can be turned on mid-session, and a value
   * latched at construction would be the spend as of construction.
   *
   * There is deliberately no matching setter. The agent does not write the
   * session total — `SessionManager` already accumulates it from the same events
   * — and a second writer is exactly how the two counters would drift.
   * Provider-neutral on purpose: every runtime has a ceiling, including the ones
   * whose figure is always 0.
   */
  getSessionSpendUsd?: () => number | undefined;

  /**
   * P6.645 / P6.794 - the session's accumulated OUTPUT tokens, the twin of
   * {@link BackendConfig.getSessionSpendUsd}, read once per instance for the
   * token ceiling.
   *
   * **The OUTPUT half and not the total, and that is a correction to the
   * hand-off this closes, measured rather than assumed.** The two counters
   * accumulate by different rules (`BaseAgent.exceedsMaxBudgetTokens` and
   * `SessionManager.applyContextUsageSnapshot` agree on them): `inputTokens` is
   * a SNAPSHOT of the whole conversation that every API call resends, so it
   * self-heals on the first event of a new instance; `outputTokens` is an
   * INCREMENT, so it is the only half that restarts when the agent instance is
   * replaced. Hydrating from `tokenUsage.totalTokens` would restore the input
   * half too, and the first event's snapshot assignment would then leave it
   * counted twice - the same walk-past P2.44 records for USD, arriving from the
   * other direction.
   *
   * A GETTER for `getSessionSpendUsd`'s reason: the cap can be turned on
   * mid-session, so a value latched at construction would be the total as of
   * construction. No setter, for its other reason: `SessionManager` already
   * accumulates this from the same events, and a second writer is how the two
   * would drift.
   */
  getSessionOutputTokens?: () => number | undefined;

  /** Pi-only durable interactive-question authority. */
  askUserPort?: PiAskUserPort;

  /** Pi-only durable plan transition authority. */
  planModePort?: PiPlanModePort;

  /** Explicit Pi prompt/context profile. Defaults fail-closed to bare. */
  contextProfile?: PiContextProfile;

  /** Session configuration (for resume) */
  session?: Session;

  /**
   * C3.280 — this session's already-resolved `ephemeral`, runtime-only.
   *
   * `SessionManager` computes it once at create
   * (`options?.ephemeral === true || isSkipPromptHistoryEnabled() || getNeverPersistSessions()`)
   * and every host-side `!managed.ephemeral` gate reads that one answer. It rides
   * HERE rather than on `session` because `SessionConfig` deliberately has no
   * such field: an ephemeral session writes no session record, so a persisted
   * field could not carry the fact for the case it exists for. Same shape
   * `managedToSession` uses to put `ephemeral` on the renderer's DTO.
   *
   * Read by `ClaudeAgent`, whose runtime writes a transcript of its OWN that the
   * host's gates cannot reach (`agent/claude-session-persistence.ts`). Absent and
   * `false` mean the same thing, and the flag can only ever turn persistence
   * off — a caller cannot use it to overrule the operator's setting or
   * environment in the other direction.
   */
  sessionEphemeral?: boolean;

  /** Initial model ID */
  model?: string;

  /** Mini/utility model for summarization/title generation/mini-completions */
  miniModel?: string;

  /** Initial thinking level */
  thinkingLevel?: ThinkingLevel;

  /** Headless mode flag (disables interactive tools) */
  isHeadless?: boolean;

  /** Skip agent-level config file watching (server already owns a workspace-level watcher) */
  skipConfigWatcher?: boolean;

  /** Debug mode configuration */
  debugMode?: {
    enabled: boolean;
    logFilePath?: string;
  };

  /** System prompt preset ('default' | 'mini' | custom string) */
  systemPromptPreset?: 'default' | 'mini' | string;

  /**
   * Composed subagent prompt for a spawned child session — the subagent safety
   * core, the host's stable context seed, and the agent definition's own
   * instructions (`orchestrator/spawner.ts:composeChildPrompt`).
   *
   * APPENDED to the base system prompt, never a preset: `getSystemPrompt`'s
   * `preset` argument is only ever tested for `=== 'mini'`, so routing a child's
   * prompt there composed it and then dropped it silently. Absent on a
   * non-child session.
   */
  childSystemPrompt?: string;

  /**
   * P6.940 (2) — the PINNED SESSION AGENT's own instructions, on Pi.
   *
   * The host-composed half of what claude gets natively from `Options.agent`
   * (*"the agent's system prompt, tool restrictions, and model will be applied
   * to the main conversation"*). Pi has no such option — every `spawner.ts`
   * entry point composes a CHILD — so the host projects the descriptor it
   * already materializes: this field is the prompt, `piAllowedTools` is the
   * tool restriction, and {@link getSessionAgentInitialPrompt} is the
   * auto-submitted first turn. The model is deliberately NOT projected.
   *
   * A SEPARATE field from {@link childSystemPrompt} rather than a reuse of it:
   * that one means "this session IS a spawned child", a fact several other
   * inputs branch on, and a main session running AS an agent is not one.
   * Appended in the same place and to the same effect.
   */
  piSessionAgentPrompt?: string;

  /**
   * Which KIND of spawned child this session is, when it is one. Absent on a
   * top-level session.
   *
   * The distinction is not cosmetic: `sub-agents.md:1036` — "A fork inherits
   * everything the main session has at the moment it spawns. A named subagent
   * starts from its own definition." Several session-scoped inputs must follow
   * that split, and `childSystemPrompt` is a bad proxy for it (a fork's is the
   * empty string, which is easy to read as absent).
   */
  piChildKind?: 'fork' | 'named';

  /**
   * The spawning parent's session id, for a child that shares the parent's
   * session scope. Only session-scoped inputs a FORK must inherit read this;
   * it is never a permission or identity input.
   */
  piParentSessionId?: string;

  /** Workspace-level automation system for user-defined automations (automations.json) */
  automationSystem?: AgentAutomationSystem;

  /**
   * Per-session environment variable overrides for the SDK subprocess.
   * Spread after process.env in backend-specific option builders.
   */
  envOverrides?: Record<string, string>;

  /**
   * Centralized MCP client pool for source tool execution.
   * Owns all MCP source connections in the main process.
   */
  mcpPool?: McpClientPool;

  /**
   * Leaser identity for this session's view of a SHARED workspace pool
   * (`session:<sessionId>`). When set, the backend contributes its desired MCP
   * set under this leaser and scopes every tool list / call / read to the
   * slugs it leased. Absent (tests / a per-session private pool), all pool
   * calls degrade to the pool-wide behavior — byte-equivalent to before pool
   * sharing.
   */
  mcpLeaserId?: string;

  /**
   * URL of the McpPoolServer HTTP endpoint for this session.
   * External SDK subprocesses connect here to access pool-managed MCP tools.
   */
  poolServerUrl?: string;
  /** Per-session bearer token for the HTTP pool endpoint. */
  poolServerBearerToken?: string;

  /** Callback when SDK session ID is captured/updated */
  onSdkSessionIdUpdate?: (sdkSessionId: string) => void;

  /** Callback when SDK session ID is cleared (e.g., after failed resume) */
  onSdkSessionIdCleared?: () => void;

  /**
   * Called when the agent decides the persisted branch-fork metadata
   * (branchFromSdkSessionId / branchFromSdkCwd / branchFromSdkTurnId) is
   * unrecoverable on this machine — typically because the parent's sdk cwd
   * doesn't exist locally (cross-machine session import) or the SDK fork
   * spawn failed before establishing a child session.
   *
   * Implementations MUST clear all four fields (including sdkSessionId)
   * atomically and persist. `onSdkSessionIdCleared` is insufficient because
   * it only clears sdkSessionId — branch fields would reload from disk
   * on next launch and re-trigger the failure.
   */
  onBranchForkInvalidated?: () => void;

  /** Callback to get recent messages for recovery context */
  getRecoveryMessages?: () => RecoveryMessage[];

  /**
   * P2.1 — the conversation the ADVISOR is shown, including tool calls and what
   * they returned.
   *
   * A separate seam from `getRecoveryMessages` because the two answer different
   * questions. Recovery context is what the MODEL needs to resume a lost
   * session: user/assistant prose, last six turns. The advisor is consulted
   * precisely about the work — "the same error keeps coming back" is a claim
   * about tool RESULTS, which the recovery shape drops entirely, and a six-turn
   * slice would hide the error's first occurrence.
   *
   * Optional: when a host does not bind it, `BaseAgent` degrades to the
   * recovery messages rather than refusing to consult — advice from a prose-only
   * transcript is worse than advice from a full one, and better than none.
   */
  getAdvisorTranscript?: () => readonly AdvisorTranscriptEntry[];

  /**
   * Get ALL parent messages for branch fork fallback (not limited to 6).
   * Called when SDK-level branch fork fails and we need to summarize
   * the parent conversation for context injection via mini completion.
   * Returns empty array for non-branched sessions.
   */
  getBranchFallbackMessages?: () => RecoveryMessage[];

  /**
   * Callback to get branch seed messages (up to branch cutoff) for first turn in seeded branch mode.
   * When provided and non-empty, BaseAgent injects a hidden context block before the first user turn.
   */
  getBranchSeedMessages?: () => RecoveryMessage[];

  /** Callback invoked after branch seed context has been injected. */
  markBranchSeedApplied?: () => void;

  /**
   * Transcript to hand a runtime that has just taken over this session
   * (one-shot). Non-null only between a cross-runtime switch and the first turn
   * on the new runtime; `from` is the provider the session was moved OFF.
   */
  getRuntimeHandoffMessages?: () => RuntimeHandoffPayload | null;

  /**
   * Callback invoked after the runtime-handoff context has been injected.
   *
   * `delivery` records HOW it crossed, because that is the only place the
   * answer exists: `RuntimeSwitchResult.contextCarried` is returned by
   * `switchSessionRuntime` before a single turn has run, and Codex's native
   * carry needs a live thread, so the switch cannot know. Defaults to `'text'`
   * — every pre-T1a caller marks the text build applied and nothing else.
   */
  markRuntimeHandoffApplied?: (delivery?: RuntimeHandoffDelivery) => void;

  /** One-shot hidden summary to inject on the first turn of a transferred session. */
  getTransferredSessionSummary?: () => string | null;

  /** Callback invoked after transferred session summary has been injected. */
  markTransferredSessionSummaryApplied?: () => void;

  /**
   * P6.940 (2) — the pinned session agent's `initialPrompt`, or `null`.
   *
   * `sub-agents.md:297`: *"Auto-submitted as the first user turn when this agent
   * runs as the main session agent … Prepended to any user-provided prompt."*
   * The host answers `null` once the session has an assistant message, so the
   * "first user turn" test is a property of the transcript rather than a flag
   * that can be lost across a restart — a session whose first turn never
   * produced an answer is still on its first turn.
   *
   * Read like {@link getTransferredSessionSummary} and placed immediately ahead
   * of the user's own text, which is what "prepended" means here.
   */
  getSessionAgentInitialPrompt?: () => string | null;

  /**
   * Optional callback to resize an oversized image for API compatibility.
   * Called from PreToolUse when Read targets an image exceeding the base64 size limit.
   * Returns path to the resized temp file, or null if resize not possible.
   * Provided by the host app (Electron uses nativeImage, server could use sharp, etc.).
   */
  onImageResize?: (filePath: string, maxSizeBytes: number) => Promise<string | null>;

  // F1.1241 — no `enable1MContext` field any more: the Extended context switch is gone and each
  // Claude model's own window decides (`resolveClaudeKnownModelWindow` in claude-agent.ts).

  /**
   * Pre-computed source configurations for initial setup.
   * Passed at construction so backends can set up sources in postInit().
   */
  initialSources?: {
    enabledSources: LoadedSource[];
    mcpServers: Record<string, SdkMcpServerConfig>;
    apiServers: Record<string, unknown>;
    enabledSlugs: string[];
  };

  /**
   * Whether the session's project `workingDirectory` has an explicit, path-free
   * trust grant (W6). Repository-owned project resources (`.mcp.json`,
   * `.nessy-agent/*`, `AGENTS.md`, `.agents/skills`, project memory) are read ONLY
   * when this is true. Defaults to untrusted (fail-closed).
   */
  projectTrusted?: boolean;

  /**
   * P6.459 arm (2) — the W3C `traceparent` of the host span open for THIS
   * session's turn, or `undefined` when the host has no tracer or no turn.
   *
   * A RESOLVER, not a value: the answer changes per turn while the backend
   * lives for the whole session, so a captured string would parent every
   * request of a session to its first turn.
   *
   * The absence is the control. Nothing on this path may MINT a traceparent —
   * with tracing off the resolver is absent, the backend sends no `trace` key
   * at all, and no orphan trace is created. It is the FIRST field of its kind
   * on this config: `git grep -an 'usageMetrics' packages/shared/src/agent`
   * scored 0 production hits when it was added (W9-az), so no telemetry object
   * had ever reached a backend before.
   */
  resolveTraceparent?: () => string | undefined;

  /**
   * F1.83 (origin D1.389) — a named Pi child's `maxTurns`, already clamped by
   * the host against its parent (`piChildRestrictions.maxTurns`), for the
   * child's OWN agentic loop: `sub-agents.md#supported-frontmatter-fields`,
   * "Maximum number of agentic turns before the subagent stops". The spawner
   * forwarded it and the host spent it only on starts and resumes, so a
   * `maxTurns: "1"` agent ran its whole body (RS-98). PiAgent's own turn cap is
   * the mechanism (`capAgentTurnsByChildDefinition`); this is the input it was
   * never fed. Absent on every session that is not a named Pi child.
   */
  piChildMaxTurns?: number;
}

export interface PiAskUserPort {
  /**
   * `minOptions` is the caller's option floor at the HOST, which validates
   * independently of the agent. Absent means the `ask_user` tool's documented 2;
   * the MCP elicitation acknowledgement — one `OK`, the whole of the "decline
   * visibly" rule — passes 1, matching {@link ElicitationAskUserBridge.ask} on
   * the other two runtimes. Omitting it here is what made Pi's refusal invisible.
   */
  request(input: { sessionKey: SessionKey; requestId: string; askUser: AskUserPermissionRequest; signal?: AbortSignal; headless: boolean; minOptions?: number; publish: (requestId: string, askUser: AskUserPermissionRequest) => void }): Promise<AskUserAnswer>;
  answer(input: { sessionKey: SessionKey; requestId: string; answer: AskUserAnswer }): Promise<void>;
  cancel(input: { sessionKey: SessionKey; requestId: string }): Promise<void>;
  reproject(input: { sessionKey: SessionKey; publish: (requestId: string, askUser: AskUserPermissionRequest) => void }): void;
}

export interface PiPlanModePort {
  enter(input: { sessionKey: SessionKey }): Promise<void>;
  refine(input: { sessionKey: SessionKey; revision: number }): Promise<void>;
  submit(input: { sessionKey: SessionKey; planPath: string }): Promise<void>;
  approve(input: { sessionKey: SessionKey }): Promise<void>;
  exit(input: { sessionKey: SessionKey }): Promise<void>;
}

/** One turn's immutable runtime view and guarded lazy materializer. */
export interface CapabilityTurnRuntime {
  /** Provider pinned with this snapshot; absent legacy/test turns never run Pi-only peripherals. */
  provider?: AgentProvider;
  view: AgentRuntimeView;
  materializer: CapabilitySnapshotMaterializer;
  /** Captured trust for host capabilities that must fail closed when absent. */
  projectTrustState?: ProjectTrustState;
  /** Pi-only immutable host policy copied into each generation-pinned context. */
  managedPermissionDsl?: PermissionDslV1;
  /**
   * `settings-reference.md#allowmanagedpermissionrulesonly`, from the same
   * host-owned managed policy. Separate from `managedPermissionDsl` because it
   * applies whether or not the administrator wrote any managed rule: the key
   * "[makes] managed settings the only settings source of permission rules", so
   * with no managed rule written, none apply.
   */
  managedPermissionRulesOnly?: boolean;
  /**
   * Pi-only org-declared auto-mode sets, from the same host-owned managed
   * policy file as `managedPermissionDsl`. Handed to the guardian judge as
   * trusted policy prose. Absent when the admin declared none, which keeps the
   * judge's task byte-identical to the pre-R21 shape.
   */
  managedAutoMode?: ResolvedAutoModePolicyV1;
  /**
   * Pi-only. The administrator disabled auto mode for this organization
   * (`disabledPermissionModes` naming `auto`; "Administrators can turn it off
   * for the organization by setting `permissions.disableAutoMode` to
   * `"disable"` in managed settings" — `permission-modes.md:297` on the
   * 2026-08-23 fetch, where the `:210` cited here before is an unrelated
   * `/remote-control` note).
   *
   * Carried because the plan-mode shell band ("When auto mode is available and
   * the `useAutoModeDuringPlan` setting is on … the classifier reviews shell
   * commands during planning instead of prompting you", `:240` on that same
   * fetch — NOT the `:156` cited here before, which is a VS Code UI-label table
   * row) gates plan mode's classifier route
   * on auto mode being AVAILABLE, and availability is an org decision the
   * agent process cannot see any other way. Omitted when auto mode is
   * available, which is the default.
   */
  autoModeUnavailable?: boolean;
  /**
   * Pi-only. The resolved `excludedCommands` patterns — commands an admin
   * permitted to run OUTSIDE isolation. A matching command leaves the sandbox,
   * so the auto classifier treats it as risky instead of auto-allowing it for
   * being low-risk. Same value the `ProcessSupervisor` enforces with, so the
   * band and the boundary can never disagree.
   */
  unsandboxedCommandPatterns?: readonly string[];
  /**
   * Pi-only. `autoMode.classifyAllShell` from the same host-owned managed
   * policy file as `managedAutoMode`.
   *
   * `auto-mode-config.md:226` — "Set `autoMode.classifyAllShell` to `true` to
   * suspend every Bash and PowerShell allow rule while auto mode is active, so
   * the classifier evaluates every shell command regardless of your allow
   * list." Carried separately from `managedAutoMode` because that value is the
   * judge's org-policy PROSE and this is a band control: it decides which
   * actions reach the judge, not what the judge is told. Omitted when the
   * administrator did not set it, which is the documented default (`false`).
   */
  classifyAllShell?: boolean;
  /**
   * Pi-only. Strict sandbox mode: the host's resolved
   * `sandbox.allowUnsandboxedCommands` is `false`.
   *
   * `sandboxing.md:137` — when it is off, "the `dangerouslyDisableSandbox`
   * parameter is completely ignored and all commands must run sandboxed or be
   * explicitly listed in `excludedCommands`." So the flag is dropped by the
   * PRODUCER, and the command runs sandboxed as if it had never been set. The
   * supervisor's own hard refusal stays untouched underneath as the floor for
   * any other caller. Absent means the default, `true`.
   */
  strictSandboxMode?: boolean;
  /**
   * Pi-only host workflow governance, resolved once by the host from the user
   * layer, the managed layer and the env off switch.
   *
   * The two halves behave differently on purpose: `disableWorkflows` removes
   * the `workflow` tool from the signed manifest (a hard boundary), while
   * `sizeGuideline` only reaches the model as prompt advice and moves an
   * advisory warning threshold. Nothing in the runtime may read the guideline
   * to bound or refuse a run.
   */
  workflowSettings?: ResolvedWorkflowSettings;
  /** Required for Pi subprocess startup; optional only for non-Pi capability turns and tests. */
  piExecutionManifestSeed?: PiExecutionManifestSeedV2;
}

// ============================================================
// Backend Interface
// ============================================================

/**
 * Options for the chat method.
 */
export interface ChatOptions {
  /** Retry flag (internal use for session recovery) */
  isRetry?: boolean;
  /** Override thinking level for this message only */
  thinkingOverride?: ThinkingLevel;
  /** Host-resolved workflow invocation that Pi dispatches without a model hop. */
  workflowInvocation?: WorkflowInvocation;
  /**
   * QK5 — the session's ultracode toggle, for the turns it is ON.
   *
   * `true` OR ABSENT, never `false`, so a session that never touched the toggle
   * builds a byte-identical `chatOptions` (today's shape) and the OFF case
   * cannot be confused with an explicit refusal.
   *
   * It rides the per-turn options rather than agent state for the reason
   * `workflowInvocation` above does: the host resolves it, exactly one backend
   * acts on it (`ClaudeAgent.chatImpl` → the `ultracode` settings key), and the
   * Pi arm is answered before the call is made — `SessionManager.sendMessage`
   * appends the same workflow directive the typed keyword appends. codex reads
   * nothing here, which is the honest answer rather than a silent one: the
   * composer does not offer the control on a codex session at all
   * (`agent/ultracode-mode.ts` `resolveUltracodeAvailability`).
   */
  ultracode?: true;
  /**
   * R18 turn-level structured output: JSON Schema (draft-07) the turn's final
   * assistant text must validate against. Absent = today's behavior.
   */
  outputSchema?: Record<string, unknown>;
}

export interface WorkflowInvocation {
  script?: string;
  name?: string;
  scriptPath?: string;
  args?: unknown;
}

/**
 * SDK-compatible MCP server configuration.
 * Supports HTTP/SSE/WebSocket (remote) and stdio (local subprocess) transports.
 *
 * `mcp.md:147`: "The `type: \"ws\"` entry accepts the same `url`, `headers`,
 * `headersHelper`, `timeout`, and `alwaysLoad` fields as `http`." It is a
 * separate arm rather than a third member of the `'http' | 'sse'` arm because
 * `ws` carries no `oauth` — `mcp.md:138` says WebSocket "supports neither" OAuth
 * nor `claude mcp add --transport`, so an `oauth` object on a `ws` entry would
 * be a field that silently does nothing.
 */
/**
 * The `oauth` object of a `.mcp.json` server entry (`mcp.md:715`, `:735`).
 *
 * Both fields are admin levers rather than convenience: the metadata URL routes
 * discovery through an internal proxy or around a broken well-known endpoint,
 * and the scope string is the documented way to hold an MCP server to a
 * security-team-approved subset. Neither is ever a secret, so both are safe on
 * a config object that gets logged and hashed.
 */
export interface McpOAuthConfig {
  /**
   * `mcp.md:713`: "Point Claude Code at a specific OAuth authorization server
   * metadata URL to bypass the default discovery chain." An OVERRIDE — when it
   * is set the well-known chain is not tried at all. Must be `https://`.
   */
  authServerMetadataUrl?: string;
  /**
   * `mcp.md:735`: "a single space-separated string, matching the `scope`
   * parameter format in RFC 6749 §3.3". Narrows the authorization request; it
   * never widens one (see `resolveMcpOAuthScopes`).
   */
  scopes?: string;
}

/**
 * `mcp.md:768`: dynamic connection headers — "Claude Code runs the command and
 * merges its output into the connection headers." The value is a SHELL COMMAND,
 * never a secret itself: `mcp.md:818` forbids `${user_config.*}` inside it
 * ("because the command runs through a shell") and the safe place for a
 * configured value is the server's `headers` field. Resolved per connect
 * attempt by the pool (`mcp.md:801` — "There is no caching") and executed by
 * `mcp/headers-helper.ts`.
 *
 * A RESOLVED spec rather than the raw string, because the documented cwd rule
 * differs by origin: session cwd for a `.mcp.json` entry (`mcp.md:797`), plugin
 * root for a plugin-provided server (`mcp.md:816`) — and only the materializer
 * has the plugin root in scope. `pluginRoot` also drives the helper's
 * `CLAUDE_PLUGIN_ROOT` variable ("Set only when a plugin provides the server",
 * `mcp.md:813`).
 */
export interface McpHeadersHelperSpec {
  command: string;
  cwd?: string;
  pluginRoot?: string;
}

export type SdkMcpServerConfig =
  | {
      type: 'http' | 'sse';
      url: string;
      headers?: Record<string, string>;
      /** Dynamic connection headers; see {@link McpHeadersHelperSpec}. */
      headersHelper?: McpHeadersHelperSpec;
      /** Documented `.mcp.json` `oauth` object; HTTP/SSE only (`mcp.md:707`). */
      oauth?: McpOAuthConfig;
      /** Environment variable name containing bearer token (Codex-specific) */
      bearerTokenEnvVar?: string;
      /** Origin metadata for plugin-projected MCP servers. */
      pluginOrigin?: PluginRuntimeOrigin;
      /** Per-tool call timeout; absent retains the caller/SDK default. */
      toolTimeoutMs?: number;
      /** Imported upstream criticality metadata; connection failure remains capability-local. */
      required?: boolean;
      /**
       * Pin every tool of this server into context at session start, regardless
       * of deferred MCP tool loading. Use for the small set a session cannot
       * work without — tool search can otherwise hide the one server the session
       * exists to use.
       */
      alwaysLoad?: boolean;
    }
  | {
      type: 'ws';
      url: string;
      /**
       * `mcp.md:147`: "Authentication is header-only, so pass a static token in
       * `headers`". CARRIED BUT NOT SENT: the vendored SDK's
       * `WebSocketClientTransport` takes a URL and nothing else, so the pool
       * warns when a `ws` entry declares headers rather than pretending.
       */
      headers?: Record<string, string>;
      /**
       * Dynamic connection headers; see {@link McpHeadersHelperSpec}.
       * `mcp.md:147` gives `ws` the same `headersHelper` field as `http` —
       * carried, resolved, and then subject to the same "the WebSocket
       * transport cannot send headers" warning the static set gets.
       */
      headersHelper?: McpHeadersHelperSpec;
      /** Origin metadata for plugin-projected MCP servers. */
      pluginOrigin?: PluginRuntimeOrigin;
      /** Per-tool call timeout; absent retains the caller/SDK default. */
      toolTimeoutMs?: number;
      /** Imported upstream criticality metadata; connection failure remains capability-local. */
      required?: boolean;
      /** Pin every tool of this server into context at session start. */
      alwaysLoad?: boolean;
    }
  | {
      type: 'stdio';
      command: string;
      args?: string[];
      /** Environment variables to set (literal values) */
      env?: Record<string, string>;
      /** Environment variable names to forward from parent process (Codex-specific) */
      envVars?: string[];
      /** Working directory for the server process (Codex-specific) */
      cwd?: string;
      /** Plugin subprocesses receive only their materialized allowlisted environment. */
      inheritProcessEnv?: boolean;
      /** Origin metadata for plugin-projected MCP servers. */
      pluginOrigin?: PluginRuntimeOrigin;
      /** Per-tool call timeout; absent retains the caller/SDK default. */
      toolTimeoutMs?: number;
      /** Imported upstream criticality metadata; connection failure remains capability-local. */
      required?: boolean;
      /**
       * Pin every tool of this server into context at session start, regardless
       * of deferred MCP tool loading. Use for the small set a session cannot
       * work without — tool search can otherwise hide the one server the session
       * exists to use.
       */
      alwaysLoad?: boolean;
      /** Server-owned immutable/read-only bundle and exact writable-data authority. */
      pluginRuntime?: PluginMcpRuntimeAuthority;
    };

export interface PluginMcpRuntimeAuthority {
  bundleRootPath: string;
  expectedBundleHash: string;
  dataPath: string;
  projectPath?: string;
  /** Host-owned state roots attached by a trusted executable binding, never by a plugin manifest. */
  hostWritableRoots?: readonly string[];
}

export interface PluginRuntimeOrigin {
  kind: 'plugin';
  pluginInstanceId: string;
  pluginId: string;
  marketplaceId: string;
  version: string;
  capabilityId: string;
  scope: 'user/global' | 'workspace' | 'project';
}

/**
 * Core backend interface - all AI providers must implement this.
 *
 * The interface is designed to:
 * 1. Abstract provider differences (Claude SDK vs OpenAI Responses API)
 * 2. Enable the facade pattern in NessyAgent
 * 3. Support streaming via AsyncGenerator
 * 4. Allow capability-based UI adaptation
 */
export interface AgentLifecycleState {
  sessionStartEmitted: boolean;
  sessionEndEmitted: boolean;
  sessionStartHooksApplied: boolean;
  sessionHookContext?: string;
  /**
   * Post-compaction `SessionStart` context that has not reached a turn yet. It
   * travels with the rest of the lifecycle state because a dispose+recreate
   * between the compaction and the next turn would otherwise silently drop the
   * re-injection — the same loss the in-turn await exists to prevent, through a
   * different door.
   */
  pendingCompactHookContext?: readonly string[];
  /**
   * A `SessionStart`/`UserPromptSubmit` hook's `sessionTitle` that has not
   * reached the host yet — the callback was not wired at the moment the hook
   * answered. It rides the lifecycle state for the same reason
   * `pendingCompactHookContext` does: `sessionStartHooksApplied` also travels,
   * so a recreated agent never re-runs the hook, and a title dropped here is
   * dropped for the rest of the session.
   */
  pendingHookSessionTitle?: string;
  /** Same, for a `SessionStart` hook's `reloadSkills: true`. */
  pendingHookReloadSkills?: boolean;
  /**
   * A `SessionStart` hook's `initialUserMessage`, carried and never consumed.
   * hooks.md:1059 scopes it to non-interactive mode: it "Applies in
   * non-interactive mode with the `-p` flag, where it becomes the first turn
   * even if no prompt is provided" — it CREATES a turn. Every Nessy surface
   * runs SessionStart from inside the first `chat()`, i.e. after a typed prompt
   * has already been accepted and persisted, so there is no turn left to
   * create; `apps/cli`'s `run` exits on an empty prompt before a session (and
   * therefore before any hook) exists. Carried so the field survives a
   * dispose+recreate for whoever builds that surface.
   */
  pendingHookInitialUserMessage?: string;
}

export interface AgentBackend {
  // ============================================================
  // Chat & Lifecycle
  // ============================================================

  /**
   * Send a message and stream back events.
   * This is the core agentic loop - handles tool execution, permission checks, etc.
   *
   * @param message - User message text
   * @param attachments - Optional file attachments
   * @param options - Optional chat configuration
   * @yields AgentEvent stream
   */
  chat(
    message: string,
    attachments?: FileAttachment[],
    options?: ChatOptions
  ): AsyncGenerator<AgentEvent>;

  /** SessionManager pins exactly one capability generation for a whole turn. */
  setCapabilityTurnRuntime(runtime: CapabilityTurnRuntime | null): void;

  /** SessionManager rebinds hook execution to the same pinned turn snapshot. */
  setAutomationSystem(automationSystem: AgentAutomationSystem | undefined): void;

  /**
   * P3.298 — the command ids this session withholds, as the host resolved them
   * from `ComposerCapabilities.slash.excludedCommandIds`, so the `/help`
   * listing reads the same value the composer's menu and the dispatcher do.
   *
   * OPTIONAL on the interface: a backend that does not implement it keeps the
   * listing's honest caveat rather than acquiring a wrong answer. `undefined`
   * and `[]` are different answers there — see `BaseAgent`'s field.
   */
  setExcludedSessionCommandIds?(ids: readonly string[] | undefined): void;

  /**
   * R87 — the backend's live component-scoped (skill frontmatter) hook layer,
   * consulted by the automation system at DISPATCH time so a skill invoked
   * mid-turn is visible and one that finished is gone. Optional: a backend with
   * no notion of active skills does not expose it, and the host reads that as
   * "no component hooks".
   */
  getComponentHookLayer?(): ComponentHookLayer | undefined;

  /** Wait for fire-and-forget lifecycle hooks before their pinned snapshot is released. */
  drainAutomationEvents(): Promise<void>;

  /**
   * Queue a top-level hook block's `reason` for delivery to the model (R9).
   * Used by hosts that own an emission site the agent cannot see, e.g.
   * `SubagentStop` for a child session.
   */
  recordHookBlockFeedback(event: AutomationAgentEvent, result: AgentEventExecutionResult | undefined): void;

  /**
   * hooks.md's `stop_hook_active` for one top-level event: `true` "when Claude
   * Code is already continuing as a result of a stop hook" (`:2194`).
   *
   * Exposed on the backend because `SubagentStop` is emitted by the HOST, from
   * the same site that already calls `recordHookBlockFeedback` — and the field
   * must read the SAME consecutive-block streak that call maintains. `:2194`
   * pairs the field with the 8-block override in one sentence, so a flag
   * sourced anywhere else could report `false` while the cap was already
   * counting, which is exactly the "condition that will never resolve" the
   * sentence exists to prevent.
   */
  stopHookActive?(event: AutomationAgentEvent): boolean;

  /**
   * Finish the real logical session exactly once and drain its lifecycle hooks.
   *
   * `reason` is `SessionEnd`'s documented exit reason and matcher value
   * (hooks.md#sessionend). Omitting it means `other`, the documented catch-all,
   * so a host that has no more specific reason stays correct.
   */
  endLifecycle(reason?: SessionEndReason): Promise<void>;

  /** Preserve logical lifecycle state across an implementation-only runtime restart. */
  captureLifecycleState?(): AgentLifecycleState;
  restoreLifecycleState?(state: AgentLifecycleState): void;

  /**
   * Abort current query (user stop or internal abort).
   *
   * @param reason - Optional reason for abort (for logging/debugging)
   */
  abort(reason?: string): Promise<void>;

  /**
   * Force abort with specific reason.
   * Used for true hard-stop semantics (user stop, redirect fallback, teardown).
   *
   * @param reason - AbortReason enum value
   */
  forceAbort(reason: AbortReason): void;

  /**
   * Interrupt the current turn because control is being handed to the UI.
   *
   * Used for pause points like plan submission and auth requests, where the
   * session should stop cleanly without necessarily using the backend's
   * hardest abort primitive.
   *
   * @param reason - AbortReason enum value for the handoff boundary
   */
  interruptForHandoff(reason: AbortReason): void;

  /**
   * Redirect the agent mid-stream with a new user message.
   * Called when the user sends a message while the agent is still processing.
   *
   * Each backend decides its own strategy:
   * - Backends with native steering (e.g., Pi) inject the message into the
   *   current stream and return true — events continue through the existing
   *   generator, no abort needed.
   * - Backends without steering call forceAbort(Redirect) internally and
   *   return false — the session layer queues the message for re-send.
   *
   * @param message - The new user message; `metadata.messageId` is its transcript row (F1.238)
   * @returns true if steered (events flow through existing stream),
   *          false if aborted (session layer must queue + re-send)
   */
  redirect(message: string, metadata?: RedirectMetadata): boolean;

  /**
   * Whether a manual context compaction owns the current turn.
   *
   * While true there is no agent loop consuming steers, so a mid-stream text
   * message must be queued for replay after `complete` instead of handed to
   * `redirect()` (UB2.3, COR-3; craft-agents-oss #1058). Optional: backends
   * without the concept report false via `BaseAgent`'s default.
   */
  isCompactionInFlight?(): boolean;

  /**
   * UB6.13 — whether `redirect()` would deliver into a live turn right now, WITHOUT its
   * abort fallback (craft-agents-oss v0.15.1 `AgentBackend.canSteerNow`, Apache-2.0).
   *
   * Read by `SessionManager.steerQueuedIfDecided` before it moves a queued mid-turn message
   * into the running turn on the decision model's word, so a decided steer never kills or
   * interrupts a turn. Optional: a backend without it is treated as "no" (upstream puts a
   * `false` default on `BaseAgent`; ours leaves the member absent, which reads the same).
   * Pi and Claude answer for their own steer door (Claude: the open slot and its unpaused
   * steer FIFO, F1.335); codex answers whether `turn/steer` can be SENT — codex itself then
   * accepts or refuses the input natively, and a refusal comes back as `steer_undelivered`.
   */
  canSteerNow?(): boolean;

  /**
   * Run a simple text completion using the backend's auth infrastructure.
   * Used for connection testing, title generation, and summarization.
   */
  runMiniCompletion(prompt: string): Promise<string | null>;

  /**
   * Answer a `/btw` side question over the tool-less `queryLlm` route
   * (`interactive-mode.md:359-372`): one response, no tools, full visibility
   * into the supplied transcript. Never a turn — implemented once in
   * `BaseAgent`; must be callable while a turn is live and must not touch any
   * processing state. `NestorCloudAgent` inherits the base implementation but
   * its `queryLlm` throws, which is why the composer excludes `btw`/`recap`
   * for that provider (`composer-capabilities.ts`).
   */
  askSideQuestion(input: { question: string; transcript: readonly RecoveryMessage[] }): Promise<{ text: string }>;

  /**
   * Clean up resources (MCP connections, watchers, etc.)
   */
  destroy(): void;

  /**
   * Alias for destroy() for consistency.
   */
  dispose(): void;

  /**
   * Post-construction initialization.
   * Handles auth injection, initial config generation, etc.
   * Called after construction and callback wiring, before first chat().
   */
  postInit(): Promise<PostInitResult>;

  /**
   * Apply bridge/config updates mid-session.
   * Called when sources change, tokens refresh, or auth completes.
   * Each backend implements its own strategy:
   * - Codex: regenerates config.toml and queues reconnect
   * - Copilot: writes bridge-config.json and credential cache
   * - Claude/Pi: no-op (they don't use bridge-mcp-server)
   */
  applyBridgeUpdates(context: BridgeUpdateContext): Promise<void>;

  /**
   * Ensure branch sessions are backend-ready before first user message.
   * Called at branch creation time to avoid creating "fake branches" that have
   * copied transcript history but no actual backend branch context.
   *
   * Default behavior can be a no-op for providers that don't need preflight.
   */
  ensureBranchReady(): Promise<void>;

  /**
   * Check if currently processing a query.
   */
  isProcessing(): boolean;

  /**
   * How many background tasks this backend is holding right now — work that
   * OUTLIVES a turn and that disposing the runtime would destroy.
   *
   * Optional because most backends report their background work to
   * `SessionManager` through events it already tracks (Pi writes
   * `piBackgroundTaskKinds` from `task_backgrounded`). Claude cannot: its
   * adapter deliberately does not emit that event, so the count has to be asked
   * for. A backend that omits this is read as zero, which is correct only when
   * something else in the busy predicate can see its background work.
   *
   * P6.109 · still true after the claude adapter gained a ROW feed. That event
   * (`background_tasks_replaced`) is forwarded to the renderer and has no
   * server-side effect at all — it is the affordance, not the liveness. This
   * method remains the only way a claude session's background work reaches the
   * busy predicate, and reading the row feed there instead would put a UI
   * concern on the path that decides whether a session is safe to reap.
   */
  backgroundWorkCount?(): number;

  /**
   * When this backend's `redirect()` returns `false`, did it interrupt the
   * in-flight turn on its way out?
   *
   * ABSENT MEANS YES, and the default is that way round because
   * `BaseAgent.redirect`'s own implementation IS `forceAbort(AbortReason.Redirect)`
   * — Pi and Claude override it and do the same. A backend that says nothing has
   * inherited an abort.
   *
   * Only a backend whose `false` is INERT has to declare itself, and there are two:
   * `CodexAgent`, whose `false` means "there is no turn to steer" and which
   * deliberately sends no `turn/interrupt`; and `NestorCloudAgent`, whose
   * `redirect` is a bare `return false`.
   *
   * WHY THIS IS ON THE CONTRACT AND NOT A STRUCTURAL CHECK AT THE CALL SITE:
   * `SessionManager` uses the answer to decide whether to stamp
   * `wasInterrupted`, which makes the NEXT turn open by telling the model its
   * previous reply was cut off. Getting it wrong is a lie to the model about its
   * own history, and it has now been introduced twice by inference — once by
   * keying on the configured `midStreamBehavior`, and once by a default that
   * guessed for a backend that never declared itself. A new backend whose
   * fallback does not abort must say so HERE.
   */
  redirectFallbackInterruptsTurn?(): boolean;

  /**
   * L9 — STOP ONE OF THOSE BACKGROUND TASKS, by the id the renderer's Background
   * Tasks row carries.
   *
   * The counterpart to {@link backgroundWorkCount} and the FIRST arm of
   * `SessionManager.stopAgentTask`. Two backends implement it and they implement
   * DIFFERENT mechanisms under this one name, deliberately, because the caller
   * must not have to know which runtime it is talking to:
   *   - `PiAgent` asks the subprocess's own `BackgroundTaskRegistry`, which is the
   *     only place a `kind: 'mcp'` task exists at all and the only place a
   *     background workflow's DAG script can be aborted;
   *   - `ClaudeAgent` sends `Query.stopTask`, a control request that is reachable
   *     only because the live session outlives the turn.
   *
   * THE THREE RETURN STATES ARE NOT INTERCHANGEABLE, and the caller's next move
   * differs for each:
   *   - `{ stopped: true }` — the mechanism accepted the stop. The caller may drop
   *     the row.
   *   - `{ stopped: false }` with NO `error` — "not mine". The caller must FALL
   *     THROUGH to its next arm; this is not a failure and must not be reported as
   *     one.
   *   - `{ stopped: false, error }` — this mechanism owned the id and the stop went
   *     wrong. The caller must NOT try another mechanism on a half-stopped tree,
   *     and must not round the outcome up to success.
   *
   * Optional, and an omitting backend is simply one with no lever of its own.
   */
  stopBackgroundTask?(taskId: string): Promise<{ stopped: boolean; error?: string }>;

  /**
   * P6.793 — the OTHER direction of the same lever: move the tool call this turn
   * is blocked on into the background and let the turn continue.
   *
   * Native on claude and nowhere else. `Query.backgroundTasks(toolUseId?)` —
   * *"Background in-flight foreground tasks (Bash commands and subagents). …
   * Each blocking tool call returns immediately with a 'running in the
   * background' tool_result and the turn continues"* — has shipped in the
   * vendored SDK since 0.3.233 with no host reader at all (P6.308's measurement,
   * a fifth unread SDK surface). This declaration is the seam that reads it.
   *
   * `toolUseId` targets ONE blocking call; omitted, it backgrounds them all —
   * the SDK's own two modes.
   *
   * THE THREE RETURN STATES, as above and for the same reason:
   *   - `{ backgrounded: true }` — the runtime accepted it. The turn continues
   *     on its own and a task notification will settle the row.
   *   - `{ backgrounded: false }` with NO `error` — nothing was blocking, or the
   *     `toolUseId` matched no foreground task. Not a failure.
   *   - `{ backgrounded: false, error }` — the lever ran and went wrong.
   *
   * Optional, and an omitting backend is one with NO lever: the caller must say
   * so by name rather than let the press look accepted. That is the whole of the
   * codex arm — `codex-agent.ts` implements this method solely to state the
   * refusal, because an absent method and a refusing one are indistinguishable
   * from the outside and only one of them can carry the reason.
   */
  backgroundInFlightTasks?(toolUseId?: string): Promise<{ backgrounded: boolean; error?: string; unsupported?: true }>;

  /**
   * P6.864 (the YES arm) — queue the note a user attached to an APPROVAL so the
   * model reads it on the next turn.
   *
   * `permissions.md#add-a-comment-when-you-answer-a-permission-prompt`:
   * *"**Yes**: Claude Code runs the action, then sends your comment to Claude
   * after the result."* No runtime's ALLOW branch has a field for it — claude's
   * `PermissionResult` allow shape carries none, codex's approval response has
   * nowhere to put one, and a Pi allow receipt's `reason` is absent by contract
   * — so the host supplies the channel once, in `BaseAgent`, and every backend
   * that extends it inherits this method. The DENY half needs nothing here: it
   * is native on all three (P6.951, P6.963).
   *
   * Optional on the interface only because the interface admits a backend that
   * is not a `BaseAgent`; there is no refusing implementation and none is
   * wanted, because a runtime that cannot take the note is one whose card must
   * not offer it (`ComposerCapabilities`).
   */
  recordPermissionAnswerNote?(note: string): void;

  // ============================================================
  // Model & Thinking Configuration
  // ============================================================

  /** Get current model ID */
  getModel(): string;

  /** Set model (should validate against capabilities) */
  setModel(model: string): void;

  /**
   * Update runtime-affecting provider config without recreating the backend.
   * Backends return false when the update cannot be applied in-place and the
   * session manager should fall back to an idle restart.
   */
  updateRuntimeConfig?(update: BackendRuntimeUpdate): Promise<boolean>;

  /**
   * Return a fresh provider-specific context usage snapshot when supported.
   * Unsupported backends leave this method undefined.
   */
  requestContextUsage?(): Promise<ContextUsageSnapshot>;

  /**
   * `/heapdump` (R49/f210): ask a subprocess-backed runtime to write its OWN
   * heap snapshot + memory breakdown. `null` = no live subprocess (no row in
   * the summary); an error row, never a rejection, on timeout/failure.
   * Backends without a subprocess leave this undefined.
   */
  requestHeapdump?(): Promise<HeapdumpWriteResult | null>;

  /** Safe, read-only Pi runtime identity projection for host diagnostics. */
  getHarnessDiagnostics?(): PiHarnessManifestDiagnosticsV1 | undefined;

  /**
   * D1.328 — what this backend's runtime ADVERTISED about itself when the
   * session started, for host diagnostics. `undefined` when it advertises no
   * such thing, which is every backend but claude today.
   *
   * Declared here rather than only on `ClaudeAgent` for `getHarnessDiagnostics`'s
   * reason one line up: the host reads it off `ManagedSession.agent`, which is
   * typed as this interface, so a claude-only method would be unreachable
   * without a cast — and a cast is how a diagnostics field quietly stops being
   * filled when a second runtime starts publishing one.
   */
  getRuntimeAdvertisedRosters?(): RuntimeAdvertisedRostersV1 | undefined;

  /**
   * Dispose resources before an idle backend restart. Backends with subprocesses
   * can wait for child process exit here to avoid transient process leaks.
   */
  disposeForRestart?(): Promise<void>;

  /** Get current thinking level */
  getThinkingLevel(): ThinkingLevel;

  /** Set thinking level */
  setThinkingLevel(level: ThinkingLevel): void;

  // ============================================================
  // Permission Mode
  // ============================================================

  /** Get current permission mode */
  getPermissionMode(): PermissionMode;

  /** Set permission mode */
  setPermissionMode(mode: PermissionMode): void;

  /** Cycle to next permission mode */
  cyclePermissionMode(): PermissionMode;

  // ============================================================
  // State
  // ============================================================

  /** Get SDK session ID (for resume, null if no session) */
  getSessionId(): string | null;

  /** Whether this backend supports session branching */
  readonly supportsBranching: boolean;

  // ============================================================
  // Source Management
  // ============================================================

  /**
   * Set the MCP server configurations for sources.
   * Called by facade when sources are activated/deactivated.
   *
   * @param mcpServers Pre-built MCP server configs with auth headers
   * @param apiServers In-process MCP servers for REST APIs
   * @param intendedSlugs Source slugs that should be considered active
   * @param options `awaitConnect: false` registers the desired set without
   *   waiting for the pool reconcile. Defaults to awaiting. `dpSessionState`
   *   carries the caller's already-observed DP readiness; absent, the
   *   materialization falls back to `'unavailable'` and drops every DP-bound
   *   server. Any override MUST forward both through — a narrower override
   *   silently discards them.
   */
  setSourceServers(
    mcpServers: Record<string, SdkMcpServerConfig>,
    apiServers: Record<string, unknown>,
    intendedSlugs?: string[],
    options?: { awaitConnect?: boolean; dpSessionState?: 'ready' | 'needs-login' | 'unavailable' }
  ): void | Promise<void>;

  /**
   * Get currently active source slugs.
   */
  getActiveSourceSlugs(): string[];

  /**
   * Get the raw user message for the current turn (cleared between turns).
   * Used by SessionManager.activateSourceInSessionFn to capture the message
   * that should be re-sent after a source_test-triggered auto-restart.
   */
  getCurrentTurnUserMessage(): string | null;

  /**
   * Schedule a source-activation auto-restart. Consumed by the backend's
   * event loop after the next tool_result, which yields `source_activated`
   * and `forceAbort`s the turn. SessionManager's `source_activated` handler
   * then schedules the server-side resend with a "[{slug} activated]" suffix
   * Set by SessionManager after a successful mid-turn
   * activation (source_test auto-enable).
   */
  setPendingSourceActivationRestart(pending: { sourceSlug: string; userMessage: string }): void;

  /**
   * Get all sources (for context injection).
   */
  getAllSources(): LoadedSource[];

  /**
   * Set all sources (for context injection).
   */
  setAllSources(sources: LoadedSource[]): void;

  /**
   * Mark a source as unseen (will show introduction text again).
   */
  markSourceUnseen(sourceSlug: string): void;

  /**
   * Get a bound summarize callback for passing to API tool builders.
   */
  getSummarizeCallback(): (prompt: string) => Promise<string | null>;

  // ============================================================
  // Session & Workspace State
  // ============================================================

  /** Update the working directory */
  updateWorkingDirectory(path: string): void;

  /** Optional acknowledged runtime transaction used by Pi. */
  prepareWorkingDirectoryUpdate?(
    input: WorkingDirectoryUpdateInput,
  ): Promise<WorkingDirectoryUpdateTransaction>;

  /** Update the SDK cwd (transcript storage location) */
  updateSdkCwd(path: string): void;

  /** Set workspace configuration */
  setWorkspace(workspace: Workspace): void;

  /** Set session ID */
  setSessionId(sessionId: string | null): void;

  /** Get SourceManager for advanced queries */
  getSourceManager(): SourceManager;

  /** Generate a session title from user message */
  generateTitle(message: string, options?: { language?: string }): Promise<string | null>;

  /** Regenerate a session title from recent conversation */
  regenerateTitle(recentUserMessages: string[], lastAssistantResponse: string, options?: { language?: string }): Promise<string | null>;

  // ============================================================
  // Permission Resolution
  // ============================================================

  /**
   * Respond to a pending permission request.
   *
   * @param requestId - Permission request ID
   * @param allowed - Whether permission was granted
   * @param alwaysAllow - Whether to remember this permission for session
   */
  respondToPermission(requestId: string, allowed: boolean, alwaysAllow?: boolean, options?: PermissionResponseOptions): void;

  // ============================================================
  // Callbacks (set by facade after construction)
  // ============================================================

  /** Called when a tool requires permission */
  onPermissionRequest: PermissionCallback | null;

  /**
   * F1.369 (F1.275's fix) — called when a question dialog this backend put on
   * the host through the shared ask-user bridge (an MCP elicitation, or the
   * model's own question) is withdrawn with NO turn in flight to carry
   * `permission_request_cancelled` — an MCP server withdrawing between turns, or
   * a teardown after the turn ended. The host wires it to the same removal the
   * in-turn event takes. Optional: a backend with no such dialog never calls it.
   */
  onPermissionRequestWithdrawn?: ((requestId: string) => void) | null;

  /** Called when agent submits a plan */
  onPlanSubmitted: PlanCallback | null;

  /** Called when a source requires authentication */
  onAuthRequest: AuthCallback | null;

  /**
   * Called with a hook's `sessionTitle` (hooks.md:1060 SessionStart, :1266
   * UserPromptSubmit) — "the same effect as `/rename`". The host owns the
   * rename; the agent layer has no other route to it.
   */
  onSessionTitle: ((title: string) => void | Promise<void>) | null;

  /**
   * Called when a `SessionStart` hook returns `reloadSkills: true`
   * (hooks.md:1062): the host re-scans the skill and command directories "after
   * the SessionStart hooks complete, so skills the hook installed are available
   * in the same session, starting with the first prompt". Awaited by the
   * emitter so the rescan lands before the turn's capability manifest is built.
   */
  onReloadSkills: (() => void | Promise<void>) | null;

  /** Called when a source config changes */
  onSourceChange: SourceChangeCallback | null;

  /** Called when permission mode changes */
  onPermissionModeChange: ((mode: PermissionMode) => void) | null;

  /** Called with debug messages */
  onDebug: ((message: string) => void) | null;

  /** Called when a source tool is used but source isn't active */
  onSourceActivationRequest: SourceActivationCallback | null;

  /**
   * Called when backend-specific authentication is required.
   * Replaces per-backend callbacks (onChatGptAuthRequired, onGithubAuthRequired).
   * The session layer wires this to surface auth warnings in the UI.
   */
  onBackendAuthRequired: ((reason: string) => void) | null;

  /** Called when agent requests spawning a new session */
  onSpawnSession: ((request: import('../base-agent.ts').SpawnSessionRequest) => Promise<import('../base-agent.ts').SpawnSessionResult>) | null;

  /**
   * F1.80 — record the hook runs one automation result reports, into the store
   * `/hooks` reads. Used by a host that dispatches hook events the agent cannot
   * see (`SessionManager`'s automation wrapper: `MessageDisplay`,
   * `SubagentStart`, `UserPromptExpansion`, the model-switch pair), the same
   * shape {@link recordHookBlockFeedback} serves for a block's feedback.
   * Idempotent per result object, so the host and the agent may both call it
   * with one result. Optional only because the interface admits a backend that
   * is not a `BaseAgent`; `BaseAgent` implements it for every runtime.
   */
  recordAutomationHookRuns?(result: AgentEventExecutionResult | undefined): void;

  /**
   * F1.238 — hand the host every steer this backend ACCEPTED from `redirect()`
   * and has not delivered, oldest first, and forget them. The host calls it
   * where a turn is taken away without a tool boundary to carry them — a
   * Stop, a handoff, the turn's `complete` — and re-queues each under its own
   * `messageId`. Optional: only a backend that holds steers itself (Claude's
   * PreToolUse emulation) implements it; Pi steers natively and codex's
   * refusal arrives late as `steer_undelivered`, so neither has anything to
   * hand back here.
   */
  takePendingSteers?(): PendingSteer[];

  /**
   * F1.509 — is the RUNTIME running a turn it opened itself, which no host turn is waiting on?
   *
   * `null` when it is not; otherwise a promise that settles when that turn ends (or the runtime dies under it).
   * `isProcessing()` cannot answer this — it is the HOST's turn. `SessionManager.sendMessage` queues a send while
   * the promise is pending, never steers into it, and replays the queue when it settles. Optional: only a runtime
   * that opens turns of its own implements it — `ClaudeAgent`, whose CLI opens one to hand the model a
   * `<task-notification>`. Absent reads as `null`.
   */
  runtimeOwnTurnSettled?(): Promise<void> | null;
}

/**
 * Configuration for creating a backend.
 */
export interface BackendConfig extends CoreBackendConfig {
  /**
   * Provider/SDK to use for this backend.
   * Determines which agent class is instantiated:
   * - 'anthropic' → ClaudeAgent (Anthropic SDK)
   * - 'pi' → PiAgent (Pi via @earendil-works/pi-coding-agent)
   */
  provider: AgentProvider;

  /**
   * Full provider type from LLM connection.
   * Includes compat variants and cloud providers.
   * Used for routing validation, credential lookup, etc.
   */
  providerType?: LlmProviderType;

  /**
   * Authentication mechanism from LLM connection.
   * Determines how credentials are retrieved and passed to the backend.
   */
  authType?: LlmAuthType;

  /**
   * @deprecated Use authType instead. Kept for backwards compatibility.
   */
  legacyAuthType?: 'api_key' | 'oauth_token';

  /** MCP token override (for testing) */
  mcpToken?: string;

  /**
   * Connection slug for credential routing.
   * Set by factory when creating from a connection.
   * Used to read/write credentials under the correct key.
   */
  connectionSlug?: string;

  /**
   * DA2.2 half A — where this session's tool schemas are going, classified once
   * at construction.
   *
   * Set by `createBackendFromResolvedContext`, which is the only place in the
   * host where the endpoint and the resolved model are both in scope for EVERY
   * provider (the same reason the DA2.6 disclosure is minted there). It is not
   * a second classification: the factory passes this verdict's own inputs to
   * `noteModelTargetToolEgress` in the same statement.
   *
   * ABSENT withholds nothing, and that is the shape rather than an oversight:
   * a backend built outside that factory (tests, the `codex-agent-server` eval
   * runner) has classified nothing, and withholding on "I do not know" would
   * empty such a session's tool set with no user-visible reason. See
   * `internal/drivers/external-model-mcp-whitelist.ts` for the policy this
   * feeds and for the owner decision behind it.
   */
  modelTarget?: ModelTargetVerdict;

  /** Workspace-level automation system for user-defined SDK hooks (automations.json) */
  automationSystem?: AgentAutomationSystem;

  /**
   * Opaque runtime payload resolved by backend drivers.
   * This keeps provider-specific runtime details out of the public config surface.
   */
  runtime?: Record<string, unknown>;
}

/**
 * F1.238 — what the host tells a backend about a steer: the transcript id of
 * the message, so a steer the backend later cannot deliver comes back as
 * `steer_undelivered` naming THAT message rather than the oldest one on a list.
 * Optional — a caller that has no transcript row (a relayed child-session
 * message) passes nothing. Same shape as craft-agents-oss v0.13.4
 * `RedirectMetadata` (Apache-2.0).
 */
export interface RedirectMetadata {
  messageId?: string;
  /**
   * F1.343 — who the steer is from. Absent: the user's own message. `'monitor'`:
   * a plugin monitor's text (`armPluginPeripherals`), which a backend hands
   * back like any steer but the host must not re-queue as a user message — it
   * goes to the monitor-event queue instead (`requeueUndeliveredSteer`).
   */
  origin?: 'monitor';
}

/** F1.238 — one accepted, undelivered steer, as a backend holds it and hands it back. */
export interface PendingSteer extends RedirectMetadata {
  message: string;
}

// UA4.8 — declared by interface merging so no docs-cited line above moves.
export interface AgentBackend {
  /**
   * UA4.8 — {@link AgentBackend.backgroundWorkCount} without the work the backend itself says is not ACTIVITY.
   *
   * The Tasks Conductor's settlement gate asks "is this node still working?", which is the activity question, while
   * `backgroundWorkCount` answers the liveness one ("would a dispose destroy something?") for the idle reaper and the
   * ceiling. Claude answers it from the SDK's `ambient` flag ("hosts should exclude them from activity indicators",
   * `SDKBackgroundTasksChangedMessage`), plus the turn the CLI opens itself to deliver a task's end while it is
   * expected or running (follow-up 3). Optional: a backend that omits it is read through `backgroundWorkCount`
   * (every backend but Claude and codex). UA12.99: codex declares it — its terminals plus each running `spawn_agent` child.
   */
  backgroundActivityCount?(): number;
}
