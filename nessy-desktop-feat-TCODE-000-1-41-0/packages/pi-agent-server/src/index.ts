#!/usr/bin/env node
/**
 * Pi Agent Server
 *
 * Out-of-process Pi agent server communicating via JSONL over stdio.
 * Wraps @earendil-works/pi-coding-agent SDK and communicates with the main
 * Electron process using a line-delimited JSON protocol.
 *
 * The main process spawns this as a child process. All Pi SDK interactions
 * (session creation, prompting, tool execution, permissions) happen here,
 * with events forwarded back to the main process for UI rendering.
 *
 * This design isolates the Pi SDK's ESM + heavy dependencies into a
 * separate process, avoiding bundling issues in the Electron main process.
 */
import type { SessionFilesystemScope, SessionFilesystemScopeRoot } from '@nessy-agent/shared/agent/session-filesystem-scope';
import { applyRotatedAwsEnv } from './bedrock-env-rotation.ts';
import { providerEndpointEnv } from './provider-endpoint-env.ts'; // UB3.12 (B2-10)
import { waitForCompaction, MANUAL_COMPACT_WAIT_MS, PROMPT_COMPACT_WAIT_MS } from './compaction-wait.ts'; // UB2.3 (COR-3, #1060)
import { adaptCredentialForPiSdk } from './adapt-credential.ts';
import { mayStampProviderVerdict, terminalReasonFromPiErrorMessage } from './provider-refusal.ts';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';

// Pi SDK
import type {
  AgentSession,
  AgentSessionEvent,
  AgentToolResult,
  ModelRegistry as PiModelRegistry,
  ModelRuntime as PiModelRuntime,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { compact as compactPiSession, type ExtensionFactory } from '@earendil-works/pi-coding-agent';
import {
  isContextOverflow,
  type AssistantMessage,
  // Pi 0.84 removed `AuthStorage` and every credential type from
  // pi-coding-agent's public export path. The canonical home is pi-ai:
  // `CredentialStore` (whose only write path is the async `modify`) and the
  // `ApiKeyCredential | OAuthCredential` union, formerly re-exported as
  // `AuthCredential`. Aliased `PiStoredCredential` because `PiCredential` below
  // is our own wire union, which additionally carries `iam`.
  type Credential as PiStoredCredential,
  type CredentialStore as PiCredentialStore,
} from '@earendil-works/pi-ai';
import { bedrockProviderModule } from '@earendil-works/pi-ai/bedrock-provider';
import { setBedrockProviderModule, streamSimple } from '@earendil-works/pi-ai/compat';
import type { AgentTerminalReason, AskUserAnswer } from '@nessy-agent/core/types';

// Model resolution (extracted for testability + custom-endpoint precedence)
import { resolvePiModel, isDeniedMiniModelId } from './model-resolution.ts';
import { isUtilityModelRouteAllowed, pickCustomEndpointUtilityModel, queryMiniModel, resolveRoutedSessionModel } from './mini-model-query.ts';
import { pickProviderAppropriateMiniModel } from './pick-mini-model.ts';
import { SESSION_ONLY_MODEL_MUTATION } from './model-mutation-persistence.ts';
import {
  proxyExecutionResultToAgentToolResult,
  type ProxyExecutionResult,
} from './proxy-tool-result.ts';
import {
  buildCustomEndpointModelDef,
  customEndpointModelOverrides,
  normalizeCustomEndpointModelEntry,
  stripPiPrefix,
  type CustomEndpointModelEntry,
  type CustomEndpointModelOverrides,
} from './custom-endpoint-models.ts';
import { buildContextUsageSnapshot, type LastCompactionSnapshot } from './context-usage.ts';
import type {
  ContextCategoryAgentDefinition,
  ContextCategoryContextResource,
  ContextCategoryInputs,
  ContextCategoryToolDefinition,
} from './context-categories.ts';
import {
  AUTO_COMPACTION_THRASHING_REFILL_LIMIT,
  resolvePiAutoCompactionSettings,
  type PiAutoCompactionPolicy,
} from './auto-compaction-settings.ts';
import { applyRetryPolicy, providerRetrySettingsFor, resolveSpawnRetryBaseDelayMs } from './gateway-retry-settings.ts';

// Direct source imports from shared (bundled by bun build)
import type {
  AgentEvent as AutomationAgentEvent,
  SdkAutomationInput,
} from '../../shared/src/automations/types.ts';
import type { ContextUsageSnapshot } from '../../shared/src/protocol/dto.ts';
import type { ProcessIsolationProfile, SupervisedProcessResult } from '../../shared/src/agent/pi-harness/process-supervisor-port.ts';
import type { PiChildResult, PiChildSessionPort, PiChildSessionRequest, PiChildSessionResponse } from '../../shared/src/agent/pi-harness/child-session-port.ts';
import type { PiContextResourceDescriptor } from '../../shared/src/agent/pi-harness/context-resource.ts';
import {
  parsePiRuntimeAgentDefinitions,
  type PiRuntimeAgentDefinitionDescriptor,
} from '../../shared/src/agent/pi-harness/runtime-agent-definition.ts';
import { normalizeThinkingLevel } from '../../shared/src/agent/thinking-levels.ts';
import { withProjectCompactSteering } from '../../shared/src/prompts/compaction.ts';
import { writeHeapdump, type HeapdumpMemoryBreakdown } from '../../shared/src/diagnostics/heapdump.ts';
import { isSilentAutoCompactionSkip, describeAutoCompactionSkip } from './auto-compaction-skip-notice.ts';
import { isSessionProxyToolName } from '../../shared/src/agent/backend/pi/session-tool-defs.ts';
import type { WorkflowSizeGuideline } from '../../shared/src/config/workflow-settings.ts';
import { mcpAutoBackgroundDelayMs, resolveBashTimeoutBehavior } from '../../shared/src/config/background-task-settings.ts';
import { DEFAULT_MAX_SUBAGENT_SPAWN_DEPTH } from '../../shared/src/config/subagent-spawn-depth.ts';
import {
  createWebSearchBudget,
  resolveMaxWebSearchesPerSession,
  type WebSearchBudget,
} from '../../shared/src/config/web-search-budget.ts';
import {
  formatPrintBackgroundWaitOutcome,
  formatUnboundedPrintBackgroundWaitNotice,
  isNonInteractivePrintMode,
  resolvePrintBackgroundWaitCeilingMs,
} from '../../shared/src/config/print-background-wait.ts';
import {
  parseAndFreezePiPermissionReceipt,
  type PiContextProfile,
} from '../../shared/src/agent/pi-harness/permission-receipt.ts';
import type { LLMQueryRequest, LLMQueryResult } from '../../shared/src/agent/llm-tool.ts';
import {
  buildSchemaRetryNote,
  compileStructuredOutputSchema,
  resolveMaxStructuredOutputRetries,
  validateStructuredOutputText,
  type CompiledStructuredOutputSchema,
} from '../../shared/src/structured-output/index.ts';
import { renderStructuredOutputSchemaBlock, withSchemaBlock } from './structured-output-prompt.ts';
import { THINKING_TO_PI } from '../../shared/src/agent/backend/pi/constants.ts';
import { getDefaultSummarizationModel } from '../../shared/src/config/models.ts';
import { buildWebFetchExtractionPrompt, createWebFetchTool } from './tools/web-fetch.ts';
import {
  createBackgroundBashTool,
  type ShellBackgroundedEvent,
} from './tools/background-bash.ts';
import { ElicitationDialogGate, detachAfter } from './tools/elicitation-dialog-gate.ts';
import { resolveSearchProvider } from './tools/search/resolve-provider.ts';
import { createSearchTool } from './tools/search/create-search-tool.ts';
import { applySystemPromptOverride } from './system-prompt-override.ts';
import {
  createStopTaskTool,
  createSubagentTool,
  createGetSubagentResultTool,
  createSteerSubagentTool,
  type SubagentBackgroundEvent,
} from './orchestrator/subagent-tool.ts';
import { startSubtaskFork } from './orchestrator/subtask.ts';
import { startSkillFork } from './orchestrator/skill-fork.ts';
import {
  createWorkflowTool,
  type WorkflowBackgroundEvent,
} from './orchestrator/workflow-tool.ts';
import { loadWorkflowRecipes } from './orchestrator/workflow-loader.ts';
import { BackgroundTaskRegistry } from './orchestrator/background-task-registry.ts';
import { buildPiRuntimeAgentDefinitions } from './orchestrator/runtime-agent-definitions.ts';
import type { AgentDefinition } from '../../shared/src/agents/index.ts';
import { createReviewTool } from './orchestrator/review-tool.ts';
import { createAskUserTool, type AskUserRequest } from './orchestrator/ask-user-tool.ts';
import { configureSpawner } from './orchestrator/spawner.ts';
import { buildDeferredMcpToolSurface } from './deferred-mcp-tools.ts';
import {
  shouldUseNestorReasoningProxy,
  startNestorReasoningProxy,
  type NestorReasoningProxyHandle,
} from './gateway-proxy/nestor-reasoning-proxy.ts';
import { isNestorGatewayQwenModel } from './gateway-proxy/tool-schema-dialect.ts';
import {
  createPiToolExecutionPorts,
  createPiToolProgressBridge,
  createPiToolResultTransformer,
  createPiSdkToolAdapter,
} from './local-tools/tool-wrapper.ts';
import {
  buildRuntimeBackedBuiltinToolDefinitions,
  buildRuntimeBackedToolExecutionPorts,
} from './local-tools/runtime-backed-tools.ts';
import { LocalToolRuntime } from '../../shared/src/agent/local-tools/runtime.ts';
import type { LocalToolRuntimeOptions } from '../../shared/src/agent/local-tools/types.ts'; import { bindOutsideRootRequestToCall, type OutsideRootCancelMessage } from './local-tools/outside-root-call-end.ts'; // F1.957
import { createToolExecutor } from '../../shared/src/agent/pi-harness/tool-executor.ts';
import { summarizeExecutionReceipt, type SafeExecutionReceiptInputV1 } from '../../shared/src/agent/pi-harness/execution-observability.ts';
import { createPiLifecycleSinkGate } from './extensions/lifecycle-bridge.ts'; import { setWholeToolDenyRefusals } from './extensions/whole-tool-deny-context.ts'; // F1.1100
import { createDeferredMcpRegistrationController } from './extensions/deferred-mcp-extension.ts';
import { findPiToolBinding } from '../../shared/src/agent/pi-harness/harness-tool-descriptor.ts';
import { createFileCheckpoint, finalizeFileCheckpoint } from '../../shared/src/sessions/file-checkpoints.ts';
import {
  SUPPORTED_PI_RUNTIME_VERSION,
  createPiRuntimeAdapter,
  type CreatePiRuntimeSessionOptions,
  type PiRuntimeAdapter,
  type PiRuntimeSessionHandle,
  type PiRuntimeSessionStrategy,
} from './compat/pi-runtime-adapter.ts';
import {
  assertPiExecutionManifestIdentity,
  normalizePiOrchestratorConfig,
  sealPiExecutionManifest,
  PI_DEFERRABLE_BUILTIN_BINDINGS,
  type PiExecutionManifestV2,
} from '../../shared/src/agent/pi-harness/harness-manifest.ts';
import type { CapabilityActivationLeaseV1, CapabilityCatalogEntryInputV1 } from '../../shared/src/agent/pi-harness/capability-catalog.ts';
import {
  findPiManifestToolByPresentedName,
  preparePiManifestRegistration,
  projectPiManifestTools,
  resolvePiAllowedBindingNames,
  resolvePiSessionToolPool,
  validatePiExecutionManifest,
} from './harness/tool-manifest.ts';

setBedrockProviderModule(bedrockProviderModule);

// ============================================================
// Types — JSONL Protocol
// ============================================================

/** Credential union used in init and token_update messages */
type PiCredential =
  | { type: 'api_key'; key: string }
  | { type: 'oauth'; access: string; refresh: string; expires: number }
  | { type: 'iam'; accessKeyId: string; secretAccessKey: string; region?: string; sessionToken?: string };

/** Custom endpoint protocol — determines which streaming adapter Pi SDK uses */
type CustomEndpointApi = 'openai-completions' | 'anthropic-messages';

/** Init message from main process — configures the Pi agent server */
interface InitMessage {
  type: 'init';
  apiKey: string;
  model: string;
  cwd: string;
  thinkingLevel: string;
  workspaceRootPath: string;
  /** Host-authoritative project executable eligibility. Omitted means false. */
  projectTrusted?: boolean;
  /**
   * Host-resolved workflow size guideline. ADVICE: it only moves the advisory
   * large-run warning threshold. It never bounds a run, and the hard off
   * switch is expressed by the manifest omitting the `workflow` tool entirely,
   * not by a flag here.
   */
  workflowSizeGuideline?: WorkflowSizeGuideline;
  /** P4 captured session filesystem authority (primary root, cwd, approved roots). */
  filesystemScope?: SessionFilesystemScope;
  sessionId: string;
  sessionPath: string;
  workingDirectory: string;
  plansFolderPath: string;
  /** Host-authoritative headless flag (R10: gates MCP auto-backgrounding). */
  isHeadless?: boolean;
  /**
   * R48: seeds this process's session WebSearch budget with the tree count
   * already consumed (tools-reference.md:449 — the cap is "counted across the
   * main conversation and every subagent it spawns"). A subagent starts with
   * its parent's used count; a respawned subprocess starts with its own last
   * reported total, so /clear (which kills the subprocess AND zeroes the
   * host's remembered count) is the only reset. JSONL-only shape — this must
   * never move onto `orchestrator`, which is normalized into the signed
   * manifest identity.
   */
  webSearchesUsed?: number;
  miniModel?: string;
  providerType?: string;
  authType?: string;
  contextProfile?: PiContextProfile;
  workspaceId?: string;
  baseUrl?: string;
  branchFromSdkSessionId?: string;
  branchFromSessionPath?: string;
  branchFromSdkTurnId?: string;
  startFresh?: boolean; // UA12.217 — one-shot posture from PiAgent.clearHistory: build a NEW session in the session dir (post-/clear) instead of resuming by directory; a plain respawn carries neither field
  resumeSessionFile?: string; // UA12.217 — one-shot posture from PiAgent's /resume adopt: open the NAMED sidecar the host resolved from the id, never the newest in the directory
  /**
   * T7 · a synthesized Pi session file written by the host for a FIRST cross-runtime switch INTO Pi.
   * When present and this session has no Pi session of its own yet, `ensureSession` forks from it, so
   * the model arrives holding the conversation instead of a text quotation of it.
   *
   * Advisory, not a branch: unlike `branchFromSessionPath` — where a silent degradation to a fresh
   * session would lose the user's chosen branch point — a carry that cannot be taken has a complete
   * fallback waiting on the host (the armed text handoff), so this arm declines rather than throws
   * and says so in `session_id_update`.
   */
  carryHistorySessionFile?: string;
  customEndpoint?: { api: CustomEndpointApi; supportsImages?: boolean; dialect?: 'qwen' };
  // P6.367 — `supportsThinking`: the operator's declaration that this id
  // reasons, carried to `buildCustomEndpointModelDef`, which hard-coded
  // `reasoning: false` until that row.
  customModels?: Array<string | {
    id: string;
    contextWindow?: number;
    supportsImages?: boolean;
    supportsThinking?: boolean;
    // DA1.22 — the catalogue's published sampling parameters, carried to Pi's own
    // `Model.samplingParams`. Same whitelist warning as the line above: a field
    // this element type does not name is dropped between the connection and this
    // subprocess with nothing failing.
    samplingParams?: Record<string, unknown>;
  }>;
  piAuth?: { provider: string; credential: PiCredential };
  orchestrator?: {
    concurrency?: number;
    depth?: number;
    maxParallelTasks?: number;
    maxAgents?: number;
    tokenBudget?: number | null;
    tierModelMap?: Partial<Record<'small' | 'medium' | 'big', string>> | null;
    contextSeed?: string;
    sessionDepth?: number;
    sessionIsFork?: true;
    forkSubagent?: true;
    availableModels?: readonly string[];
  };
  executionManifest?: PiExecutionManifestV2;
  deferredMcpToolLoading?: boolean;
  allowedToolNames?: readonly string[];
  piContextResources?: readonly PiContextResourceDescriptor[];
  piRuntimeAgentDefinitions?: readonly PiRuntimeAgentDefinitionDescriptor[];
  continuationActivatedTools?: readonly CapabilityActivationLeaseV1[];
  capabilityCatalogKinds?: Readonly<Record<string, 'plugin' | 'mcp' | 'app'>>;
}

interface RuntimeConfigUpdateMessage {
  type: 'update_runtime_config';
  id: string;
  model: string;
  /** UB12.11 — the host's re-resolved mini model (a rotated gateway `fast` id); absent keeps the current one. */
  miniModel?: string;
  providerType?: string;
  authType?: string;
  baseUrl?: string;
  customEndpoint?: { api: CustomEndpointApi; supportsImages?: boolean; dialect?: 'qwen' };
  // P6.367 — `supportsThinking`: the operator's declaration that this id
  // reasons, carried to `buildCustomEndpointModelDef`, which hard-coded
  // `reasoning: false` until that row.
  customModels?: Array<string | {
    id: string;
    contextWindow?: number;
    supportsImages?: boolean;
    supportsThinking?: boolean;
    // DA1.22 — the catalogue's published sampling parameters, carried to Pi's own
    // `Model.samplingParams`. Same whitelist warning as the line above: a field
    // this element type does not name is dropped between the connection and this
    // subprocess with nothing failing.
    samplingParams?: Record<string, unknown>;
  }>;
}

interface WorkflowExecuteMessage {
  type: 'workflow_execute';
  id: string;
  invocation: {
    script?: string;
    name?: string;
    scriptPath?: string;
    args?: unknown;
  };
  message: string;
  manifestGeneration: string;
  manifestHash: string;
}

/**
 * `sub-agents.md:1013` — the user's own `/subtask`. Deliberately NOT a `prompt`:
 * the fork must start "with or without the variable set", and it must not
 * consume a model turn.
 */
interface SubtaskStartMessage {
  type: 'subtask_start';
  id: string;
  task: string;
}

/**
 * `skills.md:569` — a `context: fork` skill. Deliberately NOT a `prompt` either,
 * and for the opposite reason to `/subtask`'s: the skill body drives a SEPARATE
 * subagent that "won't have access to your conversation history", so it must
 * never enter this session's turn on its way there.
 */
interface SkillForkStartMessage {
  type: 'skill_fork_start';
  id: string;
  skillName: string;
  agent?: string;
  /** `skills.md:265` — the CHILD's model under `context: fork`. */
  model?: string;
  prompt: string;
  background: boolean;
}

type WorkingDirectoryTransactionPhase = 'prepare' | 'commit' | 'rollback' | 'finalize';

interface WorkingDirectoryTransactionMessage {
  type: 'working_directory_transaction';
  id: string;
  phase: WorkingDirectoryTransactionPhase;
  expectedGeneration: number;
  generation: number;
  cwd: string;
  projectTrusted: boolean;
}

/** Messages from main process (stdin) */
type InboundMessage =
  | InitMessage
  | { type: 'prompt'; id: string; message: string; systemPrompt: string; autoCompactionInstructions?: string; manifestGeneration: string; manifestHash: string; images?: Array<{ type: 'image'; data: string; mimeType: string }>; outputSchema?: Record<string, unknown> }
  | { type: 'register_tools'; id: string; tools: ProxyToolDef[]; manifest: PiExecutionManifestV2; previous: { generation: string; manifestHash: string }; capabilityCatalogKinds?: Readonly<Record<string, 'plugin' | 'mcp' | 'app'>>; piRuntimeAgentDefinitions?: InitMessage['piRuntimeAgentDefinitions']; wholeToolDenyRefusals?: unknown /* F1.1100 */ }
  | { type: 'tool_execute_response'; requestId: string; result: ProxyExecutionResult }
  | { type: 'process_start_response'; requestId: string; result?: SupervisedProcessResult; error?: string }
  | { type: 'child_session_response'; requestId: string; result?: PiChildSessionResponse; error?: string }
  | { type: 'pre_tool_use_response'; requestId: string; action: 'allow' | 'block' | 'modify'; receipt?: unknown; input?: Record<string, unknown>; reason?: string; additionalContext?: string }
  | { type: 'post_tool_use_response'; requestId: string; updatedToolOutput?: string }
  /** R73 · the host's `PreCompact` verdict (hooks.md: exit 2 or `decision: "block"` blocks compaction). */
  | { type: 'pre_compact_response'; requestId: string; block?: boolean; reason?: string }
  | { type: 'ask_user_response'; requestId: string; answer?: AskUserAnswer; error?: string }
  /** R24 (`mcp.md:261`): the host reports each elicitation dialog opening and closing. */
  | { type: 'mcp_elicitation_state'; dialogId: string; open: boolean }
  | { type: 'outside_root_response'; requestId: string; root: SessionFilesystemScopeRoot | null; reason?: string } // F1.959 — `reason`: the host's refusal, told to the model in place of the scope error's sentence
  /** P3.272 · the denied SUBSET of a `denied_paths_request` batch, never the allowed one. */
  | { type: 'denied_paths_response'; requestId: string; denied: string[] }
  | { type: 'abort' }
  | { type: 'mini_completion'; id: string; prompt: string }
  | { type: 'llm_query'; id: string; request: LLMQueryRequest } | { type: 'cancel_ephemeral_query'; id: string }
  | { type: 'ensure_session_ready'; id: string }
  | { type: 'set_model'; model: string }
  | { type: 'set_thinking_level'; level: string }
  | { type: 'get_context_usage'; id: string }
  /**
   * L9 — the HOST's route to {@link BackgroundTaskRegistry}, which until now had
   * none: every member of this union was checked and no other one reaches it.
   *
   * The model has reached the registry since it got `stopTask`
   * (`createStopTaskTool`), and that tool's order — registry FIRST, the durable
   * child-session port only as a fallback — is the correct one for three reasons
   * the host could not previously honour:
   *
   * - an auto-backgrounded MCP call (`kind: 'mcp'`) registers HERE and creates no
   *   child-session record at all, so `ChildSessionService.stopTask` throws
   *   `unknown-task-id:` for every such id — and those rows do reach the
   *   Background Tasks list;
   * - a background WORKFLOW's registry entry owns the DAG script's own
   *   `AbortController`; stopping only the current node's child leaves the script
   *   free to schedule the next node;
   * - between admissions there is no child to stop, which is exactly why
   *   `background-child-task.ts` swallows `unknown-task-id` inside
   *   `stopDescendants` — the registry abort was always the real stop.
   *
   * Correlated by `id` like every other request in this union; the host bounds it
   * with its own deadline, so a subprocess that never answers cannot hang the
   * button the user pressed.
   */
  | { type: 'stop_background_task'; id: string; taskId: string }
  | { type: 'heapdump'; id: string }
  | { type: 'compact'; id: string; customInstructions?: string }
  | {
      type: 'set_auto_compaction';
      id: string;
      enabled: boolean;
      thresholdPercent?: number;
      contextWindow?: number;
    }
  | RuntimeConfigUpdateMessage
  | WorkflowExecuteMessage
  | SubtaskStartMessage
  | SkillForkStartMessage
  | WorkingDirectoryTransactionMessage
  | { type: 'steer'; message: string }
  | { type: 'token_update'; piAuth: { provider: string; credential: PiCredential } }
  | { type: 'shutdown' };

/** Proxy tool definition from main process */
interface ProxyToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  promptSnippet?: string;
  promptGuidelines?: readonly string[];
}

/** Canonical tool metadata propagated on Pi tool start events */
interface ToolExecutionMetadata {
  intent?: string;
  displayName?: string;
  source: 'interceptor';
}

type EnrichedToolExecutionStartEvent = Extract<AgentSessionEvent, { type: 'tool_execution_start' }> & {
  toolMetadata?: ToolExecutionMetadata;
};

type EnrichedAgentEndEvent = Extract<AgentSessionEvent, { type: 'agent_end' }> & {
  terminalReason: AgentTerminalReason;
};

type ContextUsageUpdateEvent = {
  type: 'context_usage_update';
  usage: ContextUsageSnapshot;
};

/** R10: a detached MCP call joins the background-task listing. */
interface McpTaskBackgroundedEvent { type: 'task_backgrounded'; toolUseId: string; taskId: string; kind: 'mcp' }
/** R10: the settled result of a detached MCP call, delivered as a task notification. */
interface McpTaskNotificationEvent { type: 'task_notification'; taskId: string; text: string }

type OutboundAgentEvent =
  | AgentSessionEvent
  | EnrichedToolExecutionStartEvent
  | EnrichedAgentEndEvent
  | ShellBackgroundedEvent
  | SubagentBackgroundEvent
  | WorkflowBackgroundEvent
  | McpTaskBackgroundedEvent
  | McpTaskNotificationEvent
  | ContextUsageUpdateEvent;

/** Messages to main process (stdout) */
interface OutboundReady { type: 'ready'; sessionId: string | null; runtimeVersion: string }
interface OutboundRegisterToolsResult {
  type: 'register_tools_result';
  id: string;
  ok: boolean;
  generation?: string;
  manifestHash?: string;
  error?: string;
}
interface OutboundEvent { type: 'event'; event: OutboundAgentEvent }
interface OutboundPreToolUseReq {
  type: 'pre_tool_use_request';
  requestId: string;
  toolName: string;
  toolCallId?: string;
  input: Record<string, unknown>;
  semanticId?: string;
  piName?: string;
  surfaceVersion?: number;
  originalName?: string;
  manifestResponseEpoch?: number;
  manifestGeneration?: string;
  manifestHash?: string;
  manifestProvenance?: string[];
}
interface OutboundPostToolUseReq {
  type: 'post_tool_use_request';
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  toolResponse: string;
  isError: boolean;
}
/**
 * R73 · the request half of the awaited `PreCompact` round trip, modelled on
 * `OutboundPostToolUseReq` above. Compaction now WAITS on the host's answer,
 * which is what makes a documented block reachable at all.
 */
interface OutboundPreCompactReq {
  type: 'pre_compact_request';
  requestId: string;
  trigger: 'manual' | 'auto';
  source: string;
  /** D1.115 — `null` on `auto`, and on a `manual` the user passed nothing to. */
  customInstructions: string | null;
}
interface OutboundAskUserReq extends AskUserRequest {
  type: 'ask_user_request';
}
interface OutboundAskUserCancel {
  type: 'ask_user_cancel';
  requestId: string;
  reason: 'timed_out' | 'aborted';
}
interface OutboundOutsideRootReq {
  type: 'outside_root_request';
  requestId: string;
  canonicalTarget: string;
  access: 'read' | 'write';
}
/**
 * P3.272 — one batch per result set: which of these absolute paths does the
 * host's `deniedPaths` floor withhold from file discovery and search results?
 *
 * Its sibling above is the shape this deliberately copies. The difference is
 * that nothing here reaches a user: the host answers from
 * `shouldAllowToolInMode`'s deny branch, synchronously, so the round trip exists
 * only because the one matcher lives host-side by recorded design (weight, and a
 * `permissionManager` here that THROWS — see `denied-result-filter.ts`).
 */
interface OutboundDeniedPathsReq {
  type: 'denied_paths_request';
  requestId: string;
  paths: string[];
}
interface OutboundToolExecReq {
  type: 'tool_execute_request';
  requestId: string;
  toolName: string;
  piName?: string;
  manifestGeneration?: string;
  manifestHash?: string;
  /**
   * The Pi tool call this request serves (UB3.9, upstream v0.15.1): the host
   * keys its PreToolUse metadata bridge on it, so the agent's stated purpose
   * captured at the hook rides to the pool with the execution. Absent, the
   * request routes exactly as before — the field is carried, never required.
   */
  toolCallId?: string;
  args: Record<string, unknown>;
}
interface OutboundToolExecCancel { type: 'tool_execute_cancel'; requestId: string }
/**
 * UB2.10 (B2-12; "Stop ends only the reply") — the subprocess tells the host that a proxy
 * tool call DETACHED past the R10 threshold: the call is a background task now, so the host
 * must move its `pendingToolExecutions` entry out of the Stop sweep's reach (a Stop ends the
 * REPLY, not a detached MCP write) while `stop_background_task` keeps stopping it. The host
 * receiver is pi-agent.ts `dispatchSubprocessMessage` (58d2b8640: the entry moves into
 * `detachedToolExecutions`); it is a member of `OutboundMessage` so `send` accepts it.
 */
interface OutboundToolExecDetached { type: 'tool_execute_detached'; requestId: string; taskId: string }
interface OutboundExecutionReceipt { type: 'execution_receipt'; receipt: SafeExecutionReceiptInputV1 }
interface OutboundContinuationState {
  type: 'continuation_state';
  capabilityGeneration: string;
  activatedTools: readonly CapabilityActivationLeaseV1[];
}
interface OutboundProcessStartReq {
  type: 'process_start_request';
  requestId: string;
  request: import('../../shared/src/agent/pi-harness/process-supervisor-port.ts').SupervisedProcessChildStartRequest;
}
interface OutboundProcessCancelReq { type: 'process_cancel_request'; requestId: string }
interface OutboundChildSessionReq { type: 'child_session_request'; requestId: string; request: PiChildSessionRequest }
interface OutboundSessionToolCompleted { type: 'session_tool_completed'; toolName: string; args: Record<string, unknown>; isError: boolean }
interface OutboundMiniResult { type: 'mini_completion_result'; id: string; text: string | null }
interface OutboundLlmQueryResult {
  type: 'llm_query_result';
  id: string;
  result: LLMQueryResult | null;
  errorMessage?: string;
  /**
   * When set, signals the main process that a generic `error` with the same code
   * was also emitted on the error channel (for centralized auth-refresh detection).
   */
  errorCode?: string;
}
interface OutboundEnsureSessionReadyResult { type: 'ensure_session_ready_result'; id: string; sessionId: string | null }
interface OutboundCompactResult {
  type: 'compact_result';
  id: string;
  success: boolean;
  result?: { summary: string; firstKeptEntryId: string; tokensBefore: number; estimatedTokensAfter?: number; contextUsage?: ContextUsageSnapshot };
  errorMessage?: string;
}
interface OutboundContextUsageResult {
  type: 'context_usage_result';
  id: string;
  success: boolean;
  usage?: ContextUsageSnapshot;
  errorMessage?: string;
}
/**
 * L9 — what the registry said about one stop request.
 *
 * `stopped: false` is NOT an error: {@link BackgroundTaskRegistry.stop} returns
 * `false` for an id it does not hold, and the host's whole reason for asking
 * first is to learn that and fall through to the child-session port. A registry
 * that THREW (a descendant stop that failed, a settlement timeout) reports
 * `stopped: false` with `errorMessage`, so the host can tell "not mine" from
 * "mine and it went wrong" and never turn the second into a silent success.
 */
interface OutboundStopBackgroundTaskResult {
  type: 'stop_background_task_result';
  id: string;
  stopped: boolean;
  errorMessage?: string;
}
/** R49/f210 — the subprocess's own `/heapdump` row (shared writer's result). */
interface OutboundHeapdumpResult {
  type: 'heapdump_result';
  id: string;
  success: boolean;
  wroteTo?: 'desktop' | 'home';
  snapshotPath?: string;
  diagnosticsPath?: string;
  memory?: HeapdumpMemoryBreakdown;
  activeResources?: number;
  errorMessage?: string;
}
interface OutboundSetAutoCompactionResult {
  type: 'set_auto_compaction_result';
  id: string;
  success: boolean;
  enabled: boolean;
  errorMessage?: string;
}
interface OutboundRuntimeConfigUpdateResult {
  type: 'update_runtime_config_result';
  id: string;
  success: boolean;
  updated: boolean;
  contextUsage?: ContextUsageSnapshot;
  errorMessage?: string;
}
interface OutboundAutomationEvent { type: 'automation_event'; event: AutomationAgentEvent; input: SdkAutomationInput }
interface OutboundSessionIdUpdate {
  type: 'session_id_update';
  sessionId: string;
  /**
   * T7 · true only when this session was created by forking the host's carry
   * file. The host keeps its text handoff armed until it sees this, so that a
   * declined or failed carry still reaches the model — as text, on the next
   * turn. Absent on every other session creation, which is what keeps the flag
   * a report rather than an echo of the request.
   */
  carriedHistory?: boolean;
}
/**
 * R48: absolute session WebSearch tree count after a consume or a child fold.
 * Host-bound only (never an AgentEvent): the host mirrors it so a respawned
 * subprocess can be re-seeded and a parent can be credited a child's usage.
 */
interface OutboundWebSearchUsage { type: 'web_search_usage'; used: number }
interface OutboundError { type: 'error'; message: string; code?: string; /** F1.239 — the utility request (mini_completion / llm_query) this error belongs to. */ id?: string }
interface OutboundStartupError { type: 'startup_error'; code: 'pi_runtime_incompatible'; message: string }
interface OutboundWorkingDirectoryTransactionResult {
  type: 'working_directory_transaction_result';
  id: string;
  phase: WorkingDirectoryTransactionPhase;
  generation: number;
  success: boolean;
  errorMessage?: string;
}

interface OutboundWorkflowExecuteResult {
  type: 'workflow_execute_result';
  id: string;
  ok: boolean;
  content?: string;
  details?: unknown;
  error?: string;
}

interface OutboundSubtaskStartResult {
  type: 'subtask_start_result';
  id: string;
  ok: boolean;
  agentId?: string;
  name?: string;
  error?: string;
}

interface OutboundSkillForkStartResult {
  type: 'skill_fork_start_result';
  id: string;
  ok: boolean;
  agent?: string;
  /** What the dispatch DID — `NESSY_DISABLE_BACKGROUND_TASKS` can override the ask. */
  background?: boolean;
  agentId?: string;
  taskId?: string;
  status?: 'done' | 'error' | 'aborted';
  result?: string;
  error?: string;
}

type OutboundMessage =
  | OutboundReady
  | OutboundRegisterToolsResult
  | OutboundStartupError
  | OutboundEvent
  | OutboundPreToolUseReq
  | OutboundPostToolUseReq
  | OutboundPreCompactReq
  | OutboundAskUserReq
  | OutboundAskUserCancel
  | OutboundOutsideRootReq | OutsideRootCancelMessage // F1.957 — the asking call ended first; the host withdraws the card
  | OutboundDeniedPathsReq
  | OutboundToolExecReq
  | OutboundToolExecCancel | OutboundToolExecDetached // UB2.10 — the detach point's send (one line: no anchor below shifts)
  | OutboundExecutionReceipt
  | OutboundContinuationState
  | OutboundProcessStartReq
  | OutboundProcessCancelReq
  | OutboundChildSessionReq
  | OutboundSessionToolCompleted
  | OutboundMiniResult
  | OutboundLlmQueryResult
  | OutboundEnsureSessionReadyResult
  | OutboundCompactResult
  | OutboundContextUsageResult
  | OutboundStopBackgroundTaskResult
  | OutboundHeapdumpResult
  | OutboundSetAutoCompactionResult
  | OutboundRuntimeConfigUpdateResult
  | OutboundAutomationEvent
  | OutboundWorkingDirectoryTransactionResult
  | OutboundWorkflowExecuteResult
  | OutboundSubtaskStartResult
  | OutboundSkillForkStartResult
  | OutboundSessionIdUpdate
  | OutboundWebSearchUsage
  | OutboundError;

// ============================================================
// State
// ============================================================

let piSession: AgentSession | null = null;
let runtimeHandle: PiRuntimeSessionHandle | null = null;
let runtimeAdapter: PiRuntimeAdapter;
let piModelRegistry: PiModelRegistry | null = null;
let moduleCredentials: PiCredentialStore | null = null;
let unsubscribeEvents: (() => void) | null = null;
let lastCompaction: LastCompactionSnapshot | undefined;
let autoCompactionPolicy: PiAutoCompactionPolicy = Object.freeze({ enabled: true });
let activeSystemPrompt: string | undefined;
let activeSpawnerActivation: (() => void) | null = null;
let activeSpawnerDeactivation: (() => Promise<void>) | null = null;
let activeConfigUpdate: ((config: Extract<InboundMessage, { type: 'init' }>) => void) | null = null;
let activeModelHint: { api?: string; provider?: string; baseUrl?: string } | undefined;
let activeWorkflowCommandTool: ToolDefinition<any, any> | null = null;
let activeWorkflowCommandController: AbortController | null = null;
/**
 * The published generation's background-task registry. The tools receive it
 * through their options; `/subtask` is not a tool, so it needs the same
 * generation-scoped instance by another route — and a background fork must live
 * in the SAME registry as a background subagent, or `stop_task`, generation
 * teardown and shutdown would each reach only half the session's detached work.
 */
let activeBackgroundTasks: BackgroundTaskRegistry | null = null;
/**
 * This generation's runtime agent definitions, published beside
 * {@link activeBackgroundTasks} and for the same reason.
 *
 * A `context: fork` skill names its subagent by TYPE (`skills.md:268`), and that
 * name has to resolve against the same definition set the `subagent` tool and
 * the workflow tool resolve against — otherwise a workspace-defined agent would
 * be reachable from a tool call and unknown to a forked skill in the same
 * session. Reset with the spawner, so a stale generation's definitions can never
 * outlive the capability view they came from.
 */
let activeRuntimeAgentDefinitions: readonly AgentDefinition[] = [];
/**
 * The production-composed parts the `/context` category accounting measures:
 * the session's adapted tool definitions, its runtime agent definitions, and
 * the materialized instruction/memory resources. Captured per generation
 * alongside `activeWorkflowCommandTool`; the system prompt and message history
 * are read live (`activeSystemPrompt`, `session.messages`).
 */
interface ActiveContextAccounting {
  toolDefinitions: readonly ContextCategoryToolDefinition[];
  agentDefinitions: readonly ContextCategoryAgentDefinition[];
  contextResources: readonly ContextCategoryContextResource[];
}
let activeContextAccounting: ActiveContextAccounting | null = null;
let workingDirectoryGeneration = 0;

/**
 * R48 — ONE session WebSearch budget per PROCESS, at module scope on purpose:
 * `buildSessionDefinition` runs a second time for the cwd-prepare candidate
 * (working-directory transactions), and a closure counter would silently reset
 * the count on a working-directory switch. The /clear reset is structural —
 * `PiAgent.clearHistory()` KILLS this subprocess (there is no clear message in
 * `InboundMessage`), and the replacement process starts a fresh budget seeded
 * by `InitMessage.webSearchesUsed` (which the host also zeroes on /clear).
 */
const webSearchBudget = createWebSearchBudget(resolveMaxWebSearchesPerSession());

/** Report the absolute tree count host-ward after every change. */
function reportWebSearchUsage(): void {
  send({ type: 'web_search_usage', used: webSearchBudget.used() });
}

/**
 * The budget the `web_search` tool consumes from: every successful charge is
 * reported to the host so a subprocess respawn can be re-seeded and a parent
 * session can be credited this session's consumption on the child result.
 */
const reportingWebSearchBudget: WebSearchBudget = {
  get limit() { return webSearchBudget.limit; },
  tryConsume() {
    const consumed = webSearchBudget.tryConsume();
    if (consumed) reportWebSearchUsage();
    return consumed;
  },
  used: () => webSearchBudget.used(),
  remaining: () => webSearchBudget.remaining(),
  reset: () => webSearchBudget.reset(),
  seed: used => webSearchBudget.seed(used),
};

/**
 * Cumulative WebSearch consumption already folded into this budget, per child
 * agent id. `PiChildResult`s are re-readable (get_result/monitor return the
 * same terminal record repeatedly), so the fold takes the cumulative MAXIMUM
 * per child rather than adding every report.
 */
const foldedChildWebSearches = new Map<string, number>();

function foldChildWebSearchConsumption(agentId: string, consumed: number): void {
  if (!Number.isFinite(consumed)) return;
  const total = Math.max(0, Math.floor(consumed));
  const previous = foldedChildWebSearches.get(agentId) ?? 0;
  if (total <= previous) return;
  foldedChildWebSearches.set(agentId, total);
  webSearchBudget.seed(webSearchBudget.used() + (total - previous));
  reportWebSearchUsage();
}

function currentContextCategoryInputs(session: AgentSession): ContextCategoryInputs {
  return {
    ...(activeSystemPrompt ? { systemPrompt: withDeferredToolSummary(activeSystemPrompt) } : {}),
    toolDefinitions: activeContextAccounting?.toolDefinitions ?? [],
    agentDefinitions: activeContextAccounting?.agentDefinitions ?? [],
    contextResources: activeContextAccounting?.contextResources ?? [],
    messages: (session as AgentSession & { messages?: readonly unknown[] }).messages ?? [],
  };
}

interface PendingAutoCompactionInstructions {
  instructions?: string;
}

const pendingAutoCompactionInstructions = new WeakMap<AgentSession, PendingAutoCompactionInstructions[]>();
const activePromptRuns = new WeakMap<AgentSession, Promise<void>>();
const promptRunsAfterAgentEnd = new WeakSet<AgentSession>();

/**
 * R18 turn-level structured output: while a schema-bearing turn's
 * validate-and-reprompt loop is active, intermediate `agent_end` events are
 * held here instead of forwarded (agent_end completes the host's per-turn
 * event queue, and the turn is not over until the loop settles). The loop
 * emits the single final — possibly enriched — agent_end itself.
 */
interface StructuredOutputTurnState {
  lastAgentEnd: Record<string, unknown> | null;
  aborted: boolean;
  /** A terminal agent_end enriched elsewhere (e.g. thrashing guard) flowed through; the loop must stand down. */
  sawTerminalAgentEnd: boolean;
  /** R18: the rendered schema block; every reprompt must SHOW the schema, not only the ajv errors. */
  schemaBlock: string;
}
let structuredOutputTurn: StructuredOutputTurnState | null = null;
const AUTO_COMPACTION_THRASHING_REASON = 'auto_compaction_thrashing' satisfies AgentTerminalReason;

interface AutoCompactionThrashingState {
  armed: boolean;
  consecutiveRefills: number;
  disabledByGuard: boolean;
  terminalPending: boolean;
}

const autoCompactionThrashingStates = new WeakMap<AgentSession, AutoCompactionThrashingState>();

function parseAutoCompactionPolicy(
  msg: Extract<InboundMessage, { type: 'set_auto_compaction' }>,
): PiAutoCompactionPolicy {
  if (typeof msg.enabled !== 'boolean') throw new Error('Invalid auto-compaction enabled setting');
  if (msg.thresholdPercent !== undefined && (
    !Number.isInteger(msg.thresholdPercent)
    || msg.thresholdPercent < 1
    || msg.thresholdPercent > 100
  )) {
    throw new Error('Invalid auto-compaction percentage');
  }
  if (msg.contextWindow !== undefined && (
    !Number.isSafeInteger(msg.contextWindow)
    || msg.contextWindow < 1
  )) {
    throw new Error('Invalid auto-compaction window');
  }
  return Object.freeze({
    enabled: msg.enabled,
    ...(msg.thresholdPercent === undefined ? {} : { thresholdPercent: msg.thresholdPercent }),
    ...(msg.contextWindow === undefined ? {} : { contextWindow: msg.contextWindow }),
  });
}

function runtimeCompactionSettings(model: unknown): {
  enabled: boolean;
  reserveTokens?: number;
} {
  const modelWindow = (model as { contextWindow?: number } | undefined)?.contextWindow;
  const resolved = resolvePiAutoCompactionSettings(modelWindow, autoCompactionPolicy);
  return {
    enabled: resolved.enabled,
    ...(resolved.reserveTokens === undefined ? {} : { reserveTokens: resolved.reserveTokens }),
  };
}

function applyAutoCompactionPolicy(session: AgentSession, model: unknown): void {
  const settings = runtimeCompactionSettings(model);
  // Keep Pi's real toggle call, then overlay the derived reserveTokens value.
  // Calling in the opposite order would let setCompactionEnabled() rebuild the
  // merged settings and discard a model-change override.
  session.setAutoCompactionEnabled(settings.enabled);
  session.settingsManager.applyOverrides({ compaction: settings });
}

/**
 * `initConfig.baseUrl` is REWRITTEN to the loopback proxy URL by
 * `applyNestorReasoningProxy`, so a URL check on the active config can never
 * answer "are we on the gateway". The live proxy handle is the answer.
 */
function gatewayRuntimeActive(): boolean {
  // The proxy now also fronts BYO endpoints, so its existence is no longer the
  // question — whether its upstream is the gateway is.
  return nestorReasoningProxy?.isGatewayUpstream === true;
}

/**
 * Compaction + retry are the two per-session runtime policies; apply together
 * whenever the model or the endpoint changes.
 *
 * Order is load-bearing: `applyAutoCompactionPolicy` ends in
 * `setAutoCompactionEnabled` -> `SettingsManager.save()`, which rebuilds the
 * merged settings from global+project and discards every in-memory
 * `applyOverrides`. Retry therefore goes second — see the "is wiped by a later
 * compaction toggle" case in `gateway-retry-settings.test.ts`.
 *
 * Session CONSTRUCTION does not use this composite: the runtime adapter seeds
 * compaction through `createSession({ compaction })`, so those sites call
 * `applyRetryPolicy` alone rather than re-toggling compaction.
 */
function applySessionRuntimePolicies(session: AgentSession, model: unknown): void {
  applyAutoCompactionPolicy(session, model);
  applyRetryPolicy(session, gatewayRuntimeActive());
}

function autoCompactionThrashingState(session: AgentSession): AutoCompactionThrashingState {
  const existing = autoCompactionThrashingStates.get(session);
  if (existing) return existing;
  const created = {
    armed: false,
    consecutiveRefills: 0,
    disabledByGuard: false,
    terminalPending: false,
  };
  autoCompactionThrashingStates.set(session, created);
  return created;
}

function resetAutoCompactionThrashingGuard(session: AgentSession): void {
  const state = autoCompactionThrashingState(session);
  state.armed = false;
  state.consecutiveRefills = 0;
  state.terminalPending = false;
  if (state.disabledByGuard) {
    state.disabledByGuard = false;
    applySessionRuntimePolicies(session, session.agent.state.model);
  }
}

function applyAutoCompactionThrashingGuard(
  session: AgentSession,
  event: AgentSessionEvent,
): AgentSessionEvent | EnrichedAgentEndEvent {
  const state = autoCompactionThrashingState(session);

  if (event.type === 'message_start' && event.message.role === 'user') {
    resetAutoCompactionThrashingGuard(session);
    return event;
  }

  if (event.type === 'compaction_end') {
    const successfulOverflowRecovery = event.reason === 'overflow'
      && event.willRetry === true
      && Boolean(event.result)
      && !event.aborted;
    state.armed = successfulOverflowRecovery;
    if (!successfulOverflowRecovery) state.consecutiveRefills = 0;
    return event;
  }

  if (event.type === 'message_end' && event.message.role === 'assistant') {
    const message = event.message as AssistantMessage;
    const immediateRefill = state.armed
      && message.stopReason === 'error'
      && isContextOverflow(message, session.agent.state.model?.contextWindow);

    if (immediateRefill) {
      state.armed = false;
      state.consecutiveRefills += 1;
      if (state.consecutiveRefills >= AUTO_COMPACTION_THRASHING_REFILL_LIMIT) {
        session.setAutoCompactionEnabled(false);
        state.disabledByGuard = true;
        state.terminalPending = true;
        debugLog(
          `Stopped overflow recovery after ${state.consecutiveRefills} immediate post-compaction refills`,
        );
      }
    } else if (message.stopReason !== 'toolUse') {
      state.armed = false;
      state.consecutiveRefills = 0;
    }
    return event;
  }

  if (event.type === 'agent_end' && state.terminalPending) {
    state.armed = false;
    state.consecutiveRefills = 0;
    state.terminalPending = false;
    return { ...event, terminalReason: AUTO_COMPACTION_THRASHING_REASON };
  }

  return event;
}

/**
 * P4: the captured host scope is authoritative; the live runtime cwd replaces
 * scope.cwd on working-directory changes. Fallback (legacy hosts/tests without
 * a shipped scope): the session cwd itself is the primary root.
 *
 * **C3.178 DELIBERATELY DOES NOT REACH HERE, and the reason is the row's own
 * narrowing.** That row made the primary attached folder a user choice
 * (`primaryDirectory` in `config.json`, resolved by
 * `packages/shared/src/config/primary-directory.ts`), and P6.929 closed by record
 * on 2026-09-10 with option (b): *the primary folder is a DISPLAY and ORDERING
 * choice; discovery stays on the project root.* The `primaryRoot` computed HERE
 * is not a display value — it is the session's filesystem AUTHORITY, the root
 * `resolveScopedPath` and `assertScopeCwdAuthorized` check containment against —
 * so letting a settings key choose it would turn a presentational preference
 * into a way to move where the agent may write. The choice is applied where it
 * is read by a human instead: `SessionManager.getPiHarnessRuntimeSnapshot` and
 * the Permissions settings control.
 */
function sessionScopeFor(runtimeCwd: string): SessionFilesystemScope {
  const scope = initConfig?.filesystemScope;
  if (scope) return { ...scope, cwd: runtimeCwd || scope.cwd };
  const primaryRoot = runtimeCwd || initConfig?.workingDirectory || initConfig?.cwd || process.cwd();
  return {
    session: { workspaceId: initConfig?.workspaceId ?? '', sessionId: initConfig?.sessionId ?? '' },
    primaryRoot,
    cwd: runtimeCwd || primaryRoot,
    additionalRoots: [],
    managedExclusions: [],
    generation: '',
  };
}

interface ChildWorkingDirectoryTransaction {
  id: string;
  expectedGeneration: number;
  generation: number;
  state: 'preparing' | 'prepared' | 'committed';
  activeRuntime: 'previous' | 'candidate';
  terminalPhase?: 'rollback' | 'finalize';
  previous: {
    config: Extract<InboundMessage, { type: 'init' }>;
    handle: PiRuntimeSessionHandle;
    session: AgentSession;
    unsubscribe: (() => void) | null;
    // Pi 0.84 · the ModelRuntime behind `modelRegistry` is reachable through
    // that facade, so the transaction carries only what the module-scope
    // restore actually assigns back.
    credentials: PiCredentialStore;
    modelRegistry: PiModelRegistry;
    customState: CustomEndpointRegistryState;
    activateSpawner: () => void;
    deactivateSpawner: () => Promise<void>;
    updateConfig: (config: Extract<InboundMessage, { type: 'init' }>) => void;
    modelHint: { api?: string; provider?: string; baseUrl?: string } | undefined;
    workflowCommandTool: ToolDefinition<any, any> | null;
    contextAccounting: ActiveContextAccounting | null;
    toolsChanged: boolean;
  };
  candidate: {
    config: Extract<InboundMessage, { type: 'init' }>;
    handle: PiRuntimeSessionHandle | null;
    session: AgentSession | null;
    subscribe: (() => (() => void)) | null;
    credentials: PiCredentialStore;
    modelRegistry: PiModelRegistry;
    customState: CustomEndpointRegistryState;
    activateSpawner: () => void;
    deactivateSpawner: () => Promise<void>;
    updateConfig: (config: Extract<InboundMessage, { type: 'init' }>) => void;
    modelHint: { api?: string; provider?: string; baseUrl?: string } | undefined;
    workflowCommandTool: ToolDefinition<any, any> | null;
    contextAccounting: ActiveContextAccounting | null;
    lifecycleGate: ReturnType<typeof createPiLifecycleSinkGate>;
  };
}

let workingDirectoryTransaction: ChildWorkingDirectoryTransaction | null = null;
let workingDirectoryControlBarrierActive = false;
let workingDirectoryControlQuiescingOwner: ChildWorkingDirectoryTransaction | null = null;
let inFlightWorkingDirectoryControl: {
  owner: ChildWorkingDirectoryTransaction;
  promise: Promise<void>;
} | null = null;

const MAX_DEFERRED_CWD_CONTROL_UPDATES = 32;
const deferredWorkingDirectoryControls: Array<{
  run: () => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}> = [];

async function runOrDeferWorkingDirectoryControl(run: () => Promise<void>): Promise<void> {
  if (!workingDirectoryControlBarrierActive) {
    await run();
    return;
  }
  if (deferredWorkingDirectoryControls.length >= MAX_DEFERRED_CWD_CONTROL_UPDATES) {
    throw new Error('Too many control updates are pending behind the cwd transaction');
  }
  await new Promise<void>((resolve, reject) => {
    deferredWorkingDirectoryControls.push({ run, resolve, reject });
  });
}

async function drainWorkingDirectoryControls(owner: ChildWorkingDirectoryTransaction): Promise<void> {
  while (workingDirectoryTransaction === owner
    && workingDirectoryControlQuiescingOwner !== owner
    && deferredWorkingDirectoryControls.length > 0) {
    const pending = deferredWorkingDirectoryControls.shift()!;
    const promise = Promise.resolve().then(pending.run);
    const inFlight = { owner, promise };
    inFlightWorkingDirectoryControl = inFlight;
    try {
      await promise;
      pending.resolve();
    } catch (error) {
      pending.reject(error);
    } finally {
      if (inFlightWorkingDirectoryControl === inFlight) {
        inFlightWorkingDirectoryControl = null;
      }
    }
  }
}

function rejectWorkingDirectoryControls(error: Error): void {
  for (const pending of deferredWorkingDirectoryControls.splice(0)) {
    pending.reject(error);
  }
}

// Init config (set on 'init' message)
let initConfig: Extract<InboundMessage, { type: 'init' }> | null = null;

function publishActiveConfig(nextConfig: Extract<InboundMessage, { type: 'init' }>): void {
  initConfig = nextConfig;
  activeConfigUpdate?.(nextConfig);
}

// Mutable state
let currentUserMessage = '';

// Pending promises for async handshakes
const pendingPreToolUse = new Map<string, { resolve: (response: { receipt?: unknown; reason?: string }) => void }>();
const pendingPostToolUse = new Map<string, { resolve: (response: { updatedToolOutput?: string } | undefined) => void }>();
const pendingPreCompact = new Map<string, { resolve: (response: { block?: boolean; reason?: string } | undefined) => void }>();
/**
 * R73 · the reason the last blocking `PreCompact` verdict carried.
 *
 * Pi's manual-compaction path throws a FIXED string (`Compaction cancelled`)
 * when a handler returns `{ cancel: true }`, so the hook's own reason cannot
 * ride the throw. hooks.md#precompact requires it to reach the user — "For a
 * manual `/compact`, the stderr message is shown to the user" — so it is
 * stashed here and substituted in `handleCompact`'s catch.
 */
let lastPreCompactBlockReason: string | undefined;
const consumedPermissionDecisionIds = new Set<string>();
const pendingToolExecutions = new Map<string, {
  resolve: (result: ProxyExecutionResult) => void
  reject: (error: Error) => void
  removeAbort?: () => void
}>();
const pendingProcessStarts = new Map<string, {
  resolve: (result: SupervisedProcessResult) => void;
  reject: (error: Error) => void;
}>();
const pendingChildSessionRequests = new Map<string, {
  resolve: (result: PiChildSessionResponse) => void;
  reject: (error: Error) => void;
}>();
const pendingAskUser = new Map<string, {
  resolve: (answer: AskUserAnswer) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}>();

/**
 * R24 (`mcp.md:261`): which MCP elicitation dialogs the host currently has on
 * screen. Read only by the auto-background detach clock, which defers the move
 * while one is open.
 */
const elicitationDialogGate = new ElicitationDialogGate();

// Pending session MCP tool calls for completion detection
const pendingSessionToolCalls = new Map<string, { toolName: string; arguments: Record<string, unknown> }>();

// Proxy tool definitions from main process
let proxyToolDefs: ProxyToolDef[] = [];
let activeExecutionManifest: PiExecutionManifestV2 | null = null;
const deferredMcpLoadedToolNames = new Set<string>();
const deferredMcpActivationLeases = new Map<string, CapabilityActivationLeaseV1>();

function publishContinuationState(): void {
  if (!activeExecutionManifest) return;
  send({
    type: 'continuation_state',
    capabilityGeneration: activeExecutionManifest.snapshotGeneration,
    activatedTools: [...deferredMcpActivationLeases.values()].slice(0, 64),
  });
}

let responseEpoch = 0;
// Background work is session-owned and normally ends by exit, explicit kill, or
// session deletion. This finite one-day backstop prevents permanent orphans.
const BACKGROUND_PROCESS_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

// Flag: proxy tools changed since last session creation — session needs recreation
let toolsChanged = false;

let nestorReasoningProxy: NestorReasoningProxyHandle | null = null;

// ============================================================
// JSONL I/O
// ============================================================

function send(msg: OutboundMessage): void {
  const line = JSON.stringify(msg);
  process.stdout.write(line + '\n');
}

function debugLog(message: string): void {
  // Write debug messages to stderr so they don't interfere with JSONL protocol
  process.stderr.write(`[pi-server] ${message}\n`);
}

/**
 * D1.188 · what our REPLACING compaction says while it retries.
 *
 * `compact()`'s eleventh argument. Pi's own caller passes
 * `this._summarizationRetryCallbacks({ source: 'compaction', reason })`, which
 * `_emit`s `summarization_retry_scheduled` and its two bookends; that method is
 * private to the session, so the handler that REPLACES Pi's compaction (it
 * returns `{ compaction }` from `session_before_compact`) cannot reach it and
 * passed nothing — I2.32 recorded the null after supplying the tenth argument,
 * the retry policy, which is what made retries happen at all.
 *
 * **A diagnostic and deliberately NOT a user-visible line**, because the host
 * has already decided what those three events mean and this reproduces that
 * decision rather than inventing a second one: `summarization_retry_scheduled`
 * reaches `this.log.warn` in `packages/shared/src/agent/backend/pi/event-adapter.ts`
 * and its two bookends are handled as internal, *"because `compaction_start`
 * has already put 'Compacting context...' on screen and `compaction_end`
 * reports the outcome"*. That reason holds verbatim here: `_runAutoCompaction`
 * emits `compaction_start` BEFORE it dispatches the `session_before_compact`
 * hook this handler answers. A status line from here would make the replacing
 * path noisier than Pi's own for the identical event.
 *
 * stderr is the parity channel: the host copies it into the session's ring
 * buffer, its debug log and — in debug mode — the runtime diagnostic file.
 */
type CompactionRetryCallbacks = NonNullable<Parameters<typeof compactPiSession>[10]>;

function compactionRetryDiagnostics(): CompactionRetryCallbacks {
  return {
    onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
      debugLog(
        `Compaction summarization retry ${attempt}/${maxAttempts} scheduled in ${delayMs}ms: ${errorMessage}`,
      );
    },
    onRetryAttemptStart: () => {
      debugLog('Compaction summarization retry starting');
    },
    onRetryFinished: (success, attempt, finalError) => {
      debugLog(
        `Compaction summarization retry finished after ${attempt} attempt(s): `
        + (success ? 'succeeded' : `failed (${finalError ?? 'no error reported'})`),
      );
    },
  };
}

/** Find the most recent .jsonl session file in a directory. */
function findMostRecentSessionFile(sessionDir: string): string | null {
  if (!existsSync(sessionDir)) return null;
  let best: { path: string; mtime: number } | null = null;
  for (const entry of readdirSync(sessionDir)) {
    if (!entry.endsWith('.jsonl')) continue;
    const fullPath = join(sessionDir, entry);
    const mtime = statSync(fullPath).mtimeMs;
    if (!best || mtime > best.mtime) {
      best = { path: fullPath, mtime };
    }
  }
  return best?.path ?? null;
}

// ============================================================
// No callback server (F1.710)
// ============================================================

/**
 * F1.710 · this process serves NO loopback listener of its own.
 *
 * A `startCallbackServer()` used to stand here: an HTTP server on
 * `127.0.0.1:<ephemeral>` that answered `POST /call-llm` by running a model
 * query on this session's model and credentials, with no token and no session
 * check, its port published in `ready`. Nothing used it: the host stored the
 * port and never read it, and no spawn passed it to the only client
 * (`session-mcp-server`'s `--callback-port`). Pi's own `call_llm` never went
 * this way: it is a proxy tool the HOST runs (`PiAgent.executeSessionTool` →
 * `BaseAgent.preExecuteCallLlm`).
 *
 * A future out-of-process caller that needs an HTTP route gets one the way
 * codex's does (`session-tools-core/src/host-callback-bridge.ts`): in the HOST,
 * per session, with a per-spawn token — not here.
 */

async function stopNestorReasoningProxy(): Promise<void> {
  if (!nestorReasoningProxy) return;
  const proxy = nestorReasoningProxy;
  nestorReasoningProxy = null;
  await proxy.close();
  debugLog(`[nestor-reasoning-proxy] stopped ${proxy.localBaseUrl}`);
}

type ProxyModelConfig = {
  baseUrl?: string;
  customEndpoint?: { api: CustomEndpointApi; dialect?: 'qwen' };
  model?: string;
  customModels?: Array<string | { id: string }>;
};

/** Every model id this connection can run, for the Qwen intersection below. */
function proxyConfigModelIds(config: ProxyModelConfig): string[] {
  const ids = (config.customModels ?? []).map(entry => typeof entry === 'string' ? entry : entry?.id);
  if (config.model) ids.push(config.model);
  return ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

async function applyNestorReasoningProxy<T extends ProxyModelConfig>(config: T): Promise<T> {
  const baseUrl = config.baseUrl?.trim();
  // A UNION, deliberately: the gateway keeps its proxy for every model it
  // serves, and a BYO openai-completions connection gets one too when it can
  // run a Qwen id — those leak `<think>` into the answer wherever they run.
  // The connection's own hint is a THIRD way in, beside the gateway URL and the
  // id allowlist: a user who set it has a Qwen endpoint whose model names this
  // process cannot recognise, so nothing else here would ever start the proxy.
  const forceQwenDialect = config.customEndpoint?.dialect === 'qwen';
  const shouldProxy = config.customEndpoint?.api === 'openai-completions'
    && (shouldUseNestorReasoningProxy(baseUrl)
      || forceQwenDialect
      || proxyConfigModelIds(config).some(isNestorGatewayQwenModel));

  if (!shouldProxy || !baseUrl) {
    await stopNestorReasoningProxy();
    return config;
  }

  if (!nestorReasoningProxy || nestorReasoningProxy.upstreamBaseUrl !== baseUrl) {
    await stopNestorReasoningProxy();
    nestorReasoningProxy = await startNestorReasoningProxy(baseUrl, fetch, forceQwenDialect);
    debugLog(`[nestor-reasoning-proxy] ${baseUrl} -> ${nestorReasoningProxy.localBaseUrl}`);
  }

  return {
    ...config,
    baseUrl: nestorReasoningProxy.localBaseUrl,
  };
}

// ============================================================
// Pi Session Management
// ============================================================

function resolvedCwd(config = initConfig): string {
  const wd = config?.cwd || config?.workingDirectory || process.cwd();
  if (wd.startsWith('~/')) return join(homedir(), wd.slice(2));
  if (wd === '~') return homedir();
  return wd;
}

// Helper: derive preferCustomEndpoint flag from init config
function shouldPreferCustomEndpoint(config = initConfig): boolean {
  return Boolean(config?.customEndpoint && config?.baseUrl?.trim());
}

/**
 * Expose the active Pi model API/provider/base URL to the interceptor process.
 * This gives the interceptor a robust routing hint (instead of brittle URL-only matching).
 */
function setInterceptorApiHints(model: { api?: string; provider?: string; baseUrl?: string } | undefined): void {
  if (!model) {
    delete process.env.NESSY_PI_MODEL_API;
    delete process.env.NESSY_PI_MODEL_PROVIDER;
    delete process.env.NESSY_PI_MODEL_BASE_URL;
    return;
  }

  process.env.NESSY_PI_MODEL_API = model.api || '';
  process.env.NESSY_PI_MODEL_PROVIDER = model.provider || '';
  process.env.NESSY_PI_MODEL_BASE_URL = model.baseUrl || '';

  debugLog(
    `[interceptor-hint] api=${process.env.NESSY_PI_MODEL_API || '-'} provider=${process.env.NESSY_PI_MODEL_PROVIDER || '-'} baseUrl=${process.env.NESSY_PI_MODEL_BASE_URL || '-'}`,
  );
}

/**
 * Resolve the API key for custom endpoint auth.
 * Returns empty string for local endpoints (Ollama etc.) that don't need auth.
 */
function resolveCustomEndpointApiKey(config = initConfig): string {
  if (config?.piAuth?.credential?.type === 'api_key') {
    return config.piAuth.credential.key;
  }
  const key = config?.apiKey || '';
  if (!key && config?.baseUrl) {
    if (isLocalhostUrl(config.baseUrl)) {
      // Local endpoints (Ollama, LM Studio) don't need auth.
      // Pi SDK requires a truthy apiKey to register models, so use a placeholder.
      return 'not-needed';
    }
    debugLog('[custom-endpoint] Warning: no API key found for non-localhost endpoint — requests will likely fail');
  }
  return key;
}

function isLocalhostUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    const normalizedHostname = hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;
    return normalizedHostname === 'localhost' || normalizedHostname === '127.0.0.1' || normalizedHostname === '::1';
  } catch {
    return false;
  }
}

/** Model IDs currently registered under the custom-endpoint provider */
let customEndpointModelIds: Set<string> = new Set();
let customModelOverrides = new Map<string, CustomEndpointModelOverrides>();
/**
 * Models registered with the FABRICATED context window rather than a known one.
 * Read by the usage snapshot so the figure is labelled `fallback` instead of
 * `runtime` — see `FALLBACK_CONTEXT_WINDOW`.
 */
let customEndpointFallbackWindowIds: Set<string> = new Set();

interface CustomEndpointRegistryState {
  modelIds: Set<string>;
  modelOverrides: Map<string, CustomEndpointModelOverrides>;
  fallbackWindowModelIds: Set<string>;
}

/**
 * Register (or re-register) the custom-endpoint provider with the given models.
 * Note: registerProvider replaces the entire provider, so we maintain a Set of all
 * known model IDs and always pass the full set.
 */
function registerCustomEndpointModels(
  registry: PiModelRegistry,
  api: CustomEndpointApi,
  baseUrl: string,
  models: CustomEndpointModelEntry[],
  config = initConfig,
  state: CustomEndpointRegistryState = {
    modelIds: customEndpointModelIds,
    modelOverrides: customModelOverrides,
    fallbackWindowModelIds: customEndpointFallbackWindowIds,
  },
): void {
  for (const m of models) {
    state.modelIds.add(m.id);
    // DA1.22 — this line used to build the overrides object INLINE from a list
    // of field names, which made it a third whitelist after the two host-side
    // mappers and the one nobody widened: P6.367's `supportsThinking` died here
    // after being threaded through four type copies. The projection is now
    // structural (`customEndpointModelOverrides` = the entry minus its id) and
    // lives beside the type it projects, so a field added there is carried by
    // construction. See that function's own note for the measurement.
    const overrides = customEndpointModelOverrides(m);
    if (overrides) state.modelOverrides.set(m.id, overrides);
  }
  const allIds = [...state.modelIds];
  // `baseUrl` is the gateway gate (P2.392): the measured-window table applies
  // only when the endpoint being registered IS the verified gateway, the same
  // whole-URL match the claude path uses. Passing the provider's own base URL —
  // the one being handed to `registerProvider` on the next lines — is what makes
  // the two paths incapable of disagreeing about what a gateway model is.
  const built = allIds.map(id => buildCustomEndpointModelDef(
    id,
    baseUrl,
    { supportsImages: config?.customEndpoint?.supportsImages === true },
    state.modelOverrides.get(id), api, // F1.243 — openai-completions defs declare compat supportsStore false
  ));
  // Recomputed, not accumulated: a model that GAINS a real window on a
  // re-registration must leave the set, or the honest label would be stuck at
  // `fallback` for the rest of the process.
  state.fallbackWindowModelIds.clear();
  for (let i = 0; i < built.length; i++) {
    if (built[i]!.windowIsFallback) state.fallbackWindowModelIds.add(allIds[i]!);
  }
  registry.registerProvider('custom-endpoint', {
    baseUrl,
    apiKey: resolveCustomEndpointApiKey(config),
    api,
    authHeader: true,
    models: built.map(b => b.def),
  });
  debugLog(`Registered custom endpoint: ${baseUrl} with ${allIds.length} model(s) [${allIds.join(', ')}], api: ${api}`);
}

/**
 * Pi 0.84's resolved request headers are `Record<string, string | null>`, where
 * a null value means "do not send this header". Callers that still take a
 * `Record<string, string>` get the null entries dropped, which is the same wire
 * outcome.
 */
function stripNullHeaders(
  headers: Record<string, string | null> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const stripped: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') stripped[key] = value;
  }
  return stripped;
}

/**
 * Store one credential under `provider` — Pi 0.84's `CredentialStore.modify()` is
 * the only write path and it is async, so every caller must await this. F1.242:
 * the wire shape goes through `adaptCredentialForPiSdk` first and what was stored
 * comes back (`null`: nothing). This note used to say the store "accepts" an `iam`
 * credential: it does, then resolves NOTHING for it and stops reading the AWS env,
 * as a stored `api_key` does for oauth-only `openai-codex`. See `adapt-credential.ts`.
 */
async function storePiCredential(
  credentials: PiCredentialStore,
  provider: string,
  credential: PiCredential,
): Promise<PiStoredCredential | null> {
  const adapted = adaptCredentialForPiSdk(provider, credential);
  if (adapted) await credentials.modify(provider, async () => adapted);
  return adapted;
}

/**
 * Create a process-local credential store pre-loaded with the user's
 * credentials and a model runtime/registry backed by it. Used by both the main
 * session and ephemeral queryLlm sessions.
 *
 * Async since Pi 0.84: `ModelRuntime.create()` is async and `CredentialStore`
 * writes are async. Callers that must not yield inside a critical window take
 * this await before entering it (see the cwd-prepare branch).
 */
async function createAuthenticatedRegistry(
  config = initConfig,
  options: { publish?: boolean } = {},
): Promise<{
  credentials: PiCredentialStore;
  modelRuntime: PiModelRuntime;
  modelRegistry: PiModelRegistry;
  customState: CustomEndpointRegistryState;
}> {
  const publish = options.publish !== false;
  // Reuse the module-level credential store if already created (allows
  // token_update to rotate into it). Only create a new one on first call or
  // after re-init.
  const registry = await runtimeAdapter.createRegistry(publish ? moduleCredentials ?? undefined : undefined);
  if (publish) moduleCredentials = registry.credentials;
  const { credentials, modelRuntime, modelRegistry } = registry;
  const customState: CustomEndpointRegistryState = publish
    ? {
        modelIds: customEndpointModelIds,
        modelOverrides: customModelOverrides,
        fallbackWindowModelIds: customEndpointFallbackWindowIds,
      }
    : { modelIds: new Set(), modelOverrides: new Map(), fallbackWindowModelIds: new Set() };
  if (config?.piAuth) {
    const { provider, credential } = config.piAuth;
    const stored = await storePiCredential(credentials, provider, credential);
    debugLog(`Injected ${credential.type} credential for provider: ${provider} (stored: ${stored?.type ?? 'nothing, resolves from env'})`);
  } else if (config?.apiKey) {
    await storePiCredential(credentials, 'anthropic', { type: 'api_key', key: config.apiKey });
    debugLog('Injected API key into auth storage (legacy fallback)');
  }

  // Register custom endpoint models dynamically via Pi SDK's registerProvider API.
  // This makes arbitrary OpenAI/Anthropic-compatible endpoints work through the Pi SDK
  // by creating synthetic Model<Api> objects that the SDK requires.
  const hasCustomEndpoint = !!config?.baseUrl?.trim();
  if (hasCustomEndpoint && config?.customEndpoint) {
    const { api } = config.customEndpoint;
    const modelEntries: CustomEndpointModelEntry[] = (config.customModels?.length
      ? config.customModels
      : [config.model || 'default']
    ).map(normalizeCustomEndpointModelEntry);
    customState.modelIds = new Set();
    customState.fallbackWindowModelIds = new Set();
    if (publish) {
      customEndpointModelIds = customState.modelIds;
      customEndpointFallbackWindowIds = customState.fallbackWindowModelIds;
    }
    registerCustomEndpointModels(
      modelRegistry,
      api,
      config.baseUrl!.trim(),
      modelEntries,
      config,
      customState,
    );
  } else if (hasCustomEndpoint && !config?.customEndpoint) {
    debugLog('Custom endpoint without protocol config — models may not resolve. Set customEndpoint.api for proper routing.');
  }

  return { credentials, modelRuntime, modelRegistry, customState };
}

interface SessionDefinition {
  sessionOptions: CreatePiRuntimeSessionOptions['sessionOptions'];
  toolExecutor: ReturnType<typeof createToolExecutor>;
  responseEpoch: number;
  deferredMcpExtension?: CreatePiRuntimeSessionOptions['deferredMcpExtension'];
  autoCompactionExtension: ExtensionFactory;
  attachSession(session: AgentSession): void;
  modelHint: { api?: string; provider?: string; baseUrl?: string } | undefined;
  workflowCommandTool: ToolDefinition<any, any> | null;
  contextAccounting: ActiveContextAccounting;
  toolCount: number;
  activateSpawner(): void;
  deactivateSpawner(): Promise<void>;
  updateConfig(config: Extract<InboundMessage, { type: 'init' }>): void;
}

function configureSpawnerForGeneration(
  config: Extract<InboundMessage, { type: 'init' }>,
  manifest: PiExecutionManifestV2,
): void {
  configureSpawner({
    childSessionPort,
    modelId: config.model,
    tierModelMap: config.orchestrator?.tierModelMap ?? undefined,
    concurrency: config.orchestrator?.concurrency,
    maxDepth: config.orchestrator?.depth,
    maxFanout: config.orchestrator?.maxAgents,
    tokenBudget: config.orchestrator?.tokenBudget ?? undefined,
    // READ AT SPAWN TIME, not captured here. `handleSetThinkingLevel` republishes
    // the active config the moment `/effort` changes, but the spawner is only
    // reconfigured when a capability generation commits (`activateSpawner`), so a
    // value snapshotted here stayed stale for every child spawned in between —
    // a session that raised its effort mid-conversation kept delegating at the
    // old level. `initConfig` is the published active config and is exactly what
    // `set_thinking_level` updates.
    thinkingLevel: () => normalizeThinkingLevel(initConfig?.thinkingLevel),
    contextSeed: config.orchestrator?.contextSeed,
    // sub-agents.md:324 — a fork receives "the main conversation's exact tool
    // pool". This session IS that main conversation from a fork's point of view.
    sessionToolNames: resolvePiSessionToolPool(manifest, config.allowedToolNames),
    // :1052 — "A fork can't spawn further forks."
    isForkSession: config.orchestrator?.sessionIsFork === true,
    // `settings-reference.md#availablemodels` — the allowlist covers "the main
    // session, subagents, skills, and the advisor", so subagents too — and
    // `model-config.md:154` names the two inputs the spawner owns (subagent
    // frontmatter `model`, the Agent tool's `model` parameter). Passed through
    // verbatim, `[]` included: an empty allowlist is a policy, not an absence.
    availableModels: config.orchestrator?.availableModels,
    // Gateway children share one per-user limiter with the parent; a 250ms
    // base re-hits a hot window before it can reset. Seconds, not ms.
    //
    // READ AT SPAWN TIME for the same reason `thinkingLevel` above is:
    // `update_runtime_config` starts and stops the reasoning proxy without
    // committing a capability generation, so a value snapshotted here would
    // keep the old endpoint's backoff for every child spawned in between.
    retryBaseDelayMs: () => resolveSpawnRetryBaseDelayMs(gatewayRuntimeActive()),
  });
}

function buildSessionDefinition(
  config: Extract<InboundMessage, { type: 'init' }>,
  cwd: string,
  registry: { credentials: PiCredentialStore; modelRuntime: PiModelRuntime; modelRegistry: PiModelRegistry; customState?: CustomEndpointRegistryState },
  configureActiveSpawner: boolean,
): SessionDefinition {
  if (!activeExecutionManifest) throw new Error('Pi execution manifest is not initialized');
  const manifest = activeExecutionManifest;
  const backgroundTasks = new BackgroundTaskRegistry();
  const runtimeAgentDefinitions = buildPiRuntimeAgentDefinitions(
    config.piRuntimeAgentDefinitions,
    [
      ...manifest.tools.map(tool => tool.binding.piName),
      ...manifest.deferredMcp.candidatePiNames,
    ],
    manifest.snapshotGeneration,
    // The same two numbers the spawner's gate reads
    // (`configureSpawnerForGeneration` above), so the `subagent` withhold in
    // the built definitions exactly mirrors the spawner's depth refusal.
    {
      sessionDepth: config.orchestrator?.sessionDepth ?? 0,
      maxDepth: config.orchestrator?.depth ?? DEFAULT_MAX_SUBAGENT_SPAWN_DEPTH,
    },
    // Names the entries an imported agent's `tools` list lost. Silent for a
    // session whose every declared entry resolved.
    { debugLog },
  );
  const sessionResponseEpoch = responseEpoch + 1;
  const manifestIdentity = {
    generation: manifest.snapshotGeneration,
    manifestHash: manifest.manifestHash,
    responseEpoch: sessionResponseEpoch,
  };
  let generationConfig = config;
  let generationSession: AgentSession | null = null;
  let generationPublished = configureActiveSpawner;
  let generationToolsChanged = false;
  const autoCompactionExtension: ExtensionFactory = pi => {
    let turnAutoCompactionInstructions: string | undefined;
    let completedTurnAutoCompactionInstructions: string | undefined;
    const instructionsByUserMessage = new WeakMap<object, string | undefined>();
    pi.on('message_start', event => {
      if (event.message.role !== 'user' || !generationSession) return;
      const queue = pendingAutoCompactionInstructions.get(generationSession);
      turnAutoCompactionInstructions = queue?.shift()?.instructions;
      instructionsByUserMessage.set(event.message, turnAutoCompactionInstructions);
      if (queue?.length === 0) pendingAutoCompactionInstructions.delete(generationSession);
    });
    pi.on('agent_end', () => {
      completedTurnAutoCompactionInstructions = turnAutoCompactionInstructions;
      if (generationSession) promptRunsAfterAgentEnd.add(generationSession);
    });
    pi.on('session_before_compact', async (event, context) => {
      let instructions = completedTurnAutoCompactionInstructions;
      for (let index = event.branchEntries.length - 1; index >= 0; index -= 1) {
        const entry = event.branchEntries[index];
        if (entry?.type !== 'message' || entry.message.role !== 'user') continue;
        if (instructionsByUserMessage.has(entry.message)) {
          instructions = instructionsByUserMessage.get(entry.message);
        }
        break;
      }
      // P6.489 — the guard stays exactly as it was (owner decision Q25, option 1);
      // what changes is that the skip is no longer silent.
      if (isSilentAutoCompactionSkip(event.reason, instructions)) {
        debugLog(describeAutoCompactionSkip(event.reason));
        return;
      }
      if (event.reason === 'manual' || !instructions) return;
      const session = generationSession;
      const model = context.model;
      if (!session || !model) return { cancel: true };
      try {
        const auth = await context.modelRegistry.getApiKeyAndHeaders(model);
        // Pi 0.84 renamed `Agent.streamFn` to `Agent.streamFunction`.
        if (session.agent.streamFunction === streamSimple && (!auth.ok || !auth.apiKey)) {
          debugLog(`Auto-compaction instruction replacement cancelled: ${auth.ok ? 'missing API key' : auth.error}`);
          return { cancel: true };
        }
        return {
          compaction: await compactPiSession(
            event.preparation,
            model,
            auth.ok ? auth.apiKey : undefined,
            // Pi 0.84 widened resolved auth headers to
            // `Record<string, string | null>` (a null means "omit this header"),
            // while `compact()` still takes `Record<string, string>`. Dropping
            // the null entries preserves the same wire effect.
            auth.ok ? stripNullHeaders(auth.headers) : undefined,
            instructions,
            event.signal,
            session.thinkingLevel,
            session.agent.streamFunction,
            auth.ok ? auth.env : undefined,
            // I2.32 · the retry POLICY, which this call declined for as long as
            // it has existed — measured 2026-09-17 at Pi 0.84.4.
            //
            // This handler REPLACES Pi's own compaction (it returns
            // `{ compaction }` from `session_before_compact`), so the arguments
            // Pi's own caller supplies are ours to supply. `AgentSession`'s
            // `compact()` passes `this.settingsManager.getRetrySettings()`
            // here; we passed nothing, and `retryAssistantCall`
            // (`@earendil-works/pi-ai` `utils/retry`) says what that means:
            // "When `policy` is undefined or disabled, the first response is
            // returned unchanged" — `maxAttempts` is 0.
            //
            // So one transient failure ended the summarization outright, on the
            // very call the gateway ladder was sized for: every ordinary turn on
            // this session already runs under `applyRetryPolicy`'s answer
            // (the 15/30/60/60/60s ladder on the gateway, the SDK's 3 x 2 s
            // elsewhere, with the operator's `NESSY_MAX_API_RETRIES` on top), and
            // the compaction request shares that per-user limiter. Reading the SAME
            // settings configures the runtime's own mechanism, not a second ladder.
            //
            // The consequence, stated rather than buried: on the gateway a
            // compaction can now take the ladder's 225 s of backoff, plus the
            // provider block's `retry-after` sleeps under each attempt (~16 min
            // at worst, `PI_PROVIDER_RETRY_SETTINGS`), instead of failing fast.
            // So can every ordinary turn, and a failed compaction costs more,
            // but it is a posture — reverse it by passing `undefined` here.
            //
            session.settingsManager.getRetrySettings(),
            // D1.188 · the retry CALLBACKS, which I2.32 recorded as a null
            // because `_summarizationRetryCallbacks` is private to the session.
            // Supplied as a local set that narrates on the subprocess's own
            // stderr, at the posture the host already chose for Pi's identical
            // events — see `compactionRetryDiagnostics`.
            compactionRetryDiagnostics(),
          ),
        };
      } catch (error) {
        debugLog(`Auto-compaction instruction replacement failed: ${error instanceof Error ? error.message : String(error)}`);
        return { cancel: true };
      }
    });
  };
  // UB4.3 — search follows the active model (craft-agents-oss#1023): the ChatGPT backend
  // provider tries the session's model first, then the shared openai-codex catalog, instead
  // of a hardcoded constant that goes 400 the day the account retires it.
  const activeSearchModel = () => (generationConfig.model ? stripPiPrefix(generationConfig.model) : undefined);
  const searchProvider = {
    get name() {
      return resolveSearchProvider(generationConfig.piAuth, { baseUrl: generationConfig.baseUrl }, activeSearchModel()).name;
    },
    async search(query: string, count: number) {
      return resolveSearchProvider(generationConfig.piAuth, { baseUrl: generationConfig.baseUrl }, activeSearchModel()).search(query, count);
    },
  };
  const webTools = [
    // The session budget rides the module-scope counter (NOT this closure):
    // both buildSessionDefinition runs of one process share one count.
    createSearchTool(searchProvider, undefined, { budget: reportingWebSearchBudget }),
    // P6.606 — the extraction step the page specifies: "runs the prompt against
    // the content using a small, fast model". `runMiniCompletion` IS that model
    // (the gateway `fast` alias), already the summarizer for two other seams
    // here, so nothing new is built beside it. It fires only when the caller
    // passes `web_fetch`'s optional `prompt`, which is the opt-in the cost
    // sentence sits on.
    createWebFetchTool(
      () => generationConfig.sessionPath || null,
      async ({ url, request, content }) => runMiniCompletion(
        buildWebFetchExtractionPrompt(url, request, content),
        generationConfig,
      ),
    ),
  ];
  const runtimeBackedDefs = buildRuntimeBackedBuiltinToolDefinitions(cwd);
  const builtinDefs = [
    ...runtimeBackedDefs,
    createBackgroundBashTool({
      emitEvent: event => send({ type: 'event', event }),
      start: (command, executionId, signal) => requestSupervisedProcess({
        executionId,
        semanticId: 'bash_background',
        command,
        cwd,
        // Same owner decision as the foreground shell path: `networked` keeps
        // the workspace writable root and only opens the network dimension.
        profile: 'networked',
        background: true,
        timeoutMs: BACKGROUND_PROCESS_MAX_LIFETIME_MS,
      }, signal),
    }),
  ];
  const proxyTools = buildProxyTools(backgroundTasks);
  const catalogEntries: CapabilityCatalogEntryInputV1[] = manifest.tools
    .flatMap(tool => {
      if (tool.source.kind !== 'piBuiltin') return [];
      const properties = (tool.modelSchema as { properties?: Record<string, { type?: string } | undefined> } | undefined)?.properties ?? {};
      const inputSummary = Object.entries(properties).slice(0, 24)
        .map(([name, value]) => `${name}: ${value?.type ?? 'value'}`).join(', ') || 'No arguments.';
      const name = tool.binding.piName;
      return [{
        semanticId: name,
        displayName: name,
        modelName: name,
        kind: isSessionProxyToolName(name) ? 'session' : 'builtin',
        description: tool.description ?? tool.promptSnippet ?? name,
        inputSummary,
        effect: tool.descriptor.effect,
        risk: tool.descriptor.risk,
        source: `pi:${tool.source.bindingId}`,
      }];
    });
  const workflowLoad = loadWorkflowRecipes({
    cwd,
    includeProject: generationConfig.projectTrusted === true,
  });
  for (const diagnostic of workflowLoad.diagnostics) {
    debugLog(`[workflow-loader] ${diagnostic.path}: ${diagnostic.message}`);
  }
  const orchestratorTools = buildOrchestratorTools();
  // C7: the deferrable built-ins ride the SAME deferral surface as the MCP proxy
  // tools rather than a parallel one — one catalogue, one search tool, one load
  // tool, one lease set. Two consequences worth stating because both are load
  // bearing. (1) The list is read from `candidatePiNames`, which the manifest
  // already emptied when deferral is off and already excluded anything an off
  // switch removed — so with deferral disabled this partition is empty and the
  // assembly below is byte-identical to the pre-C7 one. (2) A definition is
  // named by its bindingName while the manifest's candidates are piNames, so
  // the membership test translates rather than comparing across the two spaces.
  const deferredCandidateIds = new Set(activeExecutionManifest.deferredMcp.candidatePiNames);
  const piNameByDefinitionName = new Map(
    manifest.tools.map(tool => [tool.binding.bindingName, tool.binding.piName]),
  );
  const semanticIdForDefinition = (definitionName: string) =>
    piNameByDefinitionName.get(definitionName) ?? definitionName;
  const isDeferrableBuiltinDef = (definition: { name: string }) =>
    deferredCandidateIds.has(semanticIdForDefinition(definition.name))
    && PI_DEFERRABLE_BUILTIN_BINDINGS.has(definition.name);
  const deferrableBuiltinDefs = [...builtinDefs, ...webTools, ...orchestratorTools]
    .filter(isDeferrableBuiltinDef);
  let deferredMcpRegistration: ReturnType<typeof createDeferredMcpRegistrationController> | undefined;
  const deferralSurfaceInput = [...proxyTools, ...deferrableBuiltinDefs];
  const proxyToolSurface = buildDeferredMcpToolSurface({
    enabled: activeExecutionManifest.deferredMcp.enabled,
    generation: activeExecutionManifest.snapshotGeneration,
    // The manifest's own candidate list: an MCP proxy tool absent from it is
    // pinned (`alwaysLoad`) and must stay registered.
    candidatePiNames: activeExecutionManifest.deferredMcp.candidatePiNames,
    semanticIdForDefinition,
    proxyTools: deferralSurfaceInput,
    loadedToolNames: deferredMcpLoadedToolNames,
    activationLeases: deferredMcpActivationLeases,
    catalogEntries,
    kindForSemanticId: semanticId => {
      const wireName = semanticId.split('__')[1];
      const capabilityKey = manifest.mcpSources.find(source => source.wireName === wireName)?.capabilityKey;
      return (capabilityKey && generationConfig.capabilityCatalogKinds?.[capabilityKey]) || 'mcp';
    },
    onLoadLeases: publishContinuationState,
    onLoadToolNames: names => {
      if (names.length === 0) return;
      for (const name of names) deferredMcpRegistration?.register(name);
      if (generationSession) generationToolsChanged = true;
      if (generationSession && generationPublished) toolsChanged = true;
      // F1.838: the summary stops listing them from the next model call too — see deferred-tool-summary.ts.
      if (dropDeferredToolSummaryNames(names) && generationPublished && runtimeHandle && activeSystemPrompt) applySystemPromptOverride(runtimeHandle, withDeferredToolSummary(activeSystemPrompt));
      debugLog(`Deferred tools registered into the live session (F1.803: callable from the next model call): ${names.join(', ')}`);
    },
  });
  publishContinuationState(); setDeferredToolSummaryNames(proxyToolSurface.hiddenToolNames.map(semanticIdForDefinition)); setSubagentCatalogue(manifest.tools.some(tool => tool.binding.piName === 'subagent') ? runtimeAgentDefinitions : []); // F1.1262 — subagent-catalogue.ts
  // Declared as a function so the deferral surface above can be built AFTER
  // these tools exist — four of C7's eight deferrable built-ins are orchestrator
  // tools, and the surface has to be handed the definitions it may hide.
  // `function` rather than `const` for the hoisting; nothing here reads the
  // surface, so the order is a free choice.
  function buildOrchestratorTools() {
   return [
    createSubagentTool({
      getCwd: () => cwd,
      getRuntimeAgentDefinitions: () => runtimeAgentDefinitions,
      getDepth: () => generationConfig.orchestrator?.sessionDepth ?? 0,
      // Read from the MANIFEST, not the environment: fork mode changes this
      // tool's model-visible schema, and the host pinned the resulting contract
      // hash from the same field.
      isForkModeEnabled: () => manifest.orchestrator.forkSubagent === true,
      getMaxParallelTasks: () => generationConfig.orchestrator?.maxParallelTasks,
      // Where an over-cap subagent report spills its full text — the same
      // expression `createWorkflowTool` receives below.
      getSessionPath: () => generationConfig.sessionPath,
      emitEvent: event => send({ type: 'event', event }),
      childSessionPort,
      backgroundTasks,
    }),
    createReviewTool({
      getCwd: () => cwd,
      getDepth: () => generationConfig.orchestrator?.sessionDepth ?? 0,
      childSessionPort,
      // P6.308 (Pi arm) — the same pair `createSubagentTool` above takes, and
      // the reason `review` can offer `background: true` at all. Without them
      // the tool REFUSES the flag by name rather than running in the foreground
      // and calling it backgrounded.
      emitEvent: event => send({ type: 'event', event }),
      backgroundTasks,
    }),
    createGetSubagentResultTool(childSessionPort),
    createSteerSubagentTool(childSessionPort),
    createStopTaskTool(childSessionPort, backgroundTasks),
    createWorkflowTool({
      getCwd: () => cwd,
      getRuntimeAgentDefinitions: () => runtimeAgentDefinitions,
      getSessionPath: () => generationConfig.sessionPath,
      getDepth: () => generationConfig.orchestrator?.sessionDepth ?? 0,
      getMaxAgents: () => generationConfig.orchestrator?.maxAgents,
      getTokenBudget: () => generationConfig.orchestrator?.tokenBudget ?? undefined,
      recipes: workflowLoad.recipes,
      getAllowedScriptRoots: () => workflowLoad.scriptRoots,
      getSizeGuideline: () => generationConfig.workflowSizeGuideline ?? 'unrestricted',
      // `workflows.md`: the warning is suppressed for sessions that already
      // opted in to large runs. Our max-effort level is that opt-in.
      isMaxEffort: () => normalizeThinkingLevel(generationConfig.thinkingLevel) === 'max',
      emitEvent: event => send({ type: 'event', event }),
      childSessionPort,
      backgroundTasks,
    }),
    createAskUserTool({
      askUser: requestAskUser,
      timeoutMs: getAskUserTimeoutMs(),
    }),
   ];
  }
  const allowedBindingNames = resolvePiAllowedBindingNames(manifest, config.allowedToolNames);
  // The deferrable built-ins are subtracted from their own arrays because
  // `proxyToolSurface.tools` already carries the ones that stay visible; leaving
  // them in both places would make `projectPiManifestTools` throw on a duplicate
  // binding. When deferral is off the subtracted set is empty.
  const definitions = [
    ...builtinDefs.filter(definition => !isDeferrableBuiltinDef(definition)),
    ...webTools.filter(definition => !isDeferrableBuiltinDef(definition)),
    ...proxyToolSurface.tools,
    ...orchestratorTools.filter(definition => !isDeferrableBuiltinDef(definition)),
  ].filter(definition => allowedBindingNames === null || allowedBindingNames.has(definition.name));
  if (!activeExecutionManifest) throw new Error('Pi execution manifest is not initialized');
  // The EXECUTION side, not the model surface, and the distinction is the whole
  // point: a deferred tool must keep its port or `mcp__tool_load` hands the
  // model a tool it can see and cannot run — `tool-executor.ts` answers
  // `missing_execution_port` with the bare semantic id as the reason, which is
  // what that failure looks like from the outside.
  //
  // The MCP half gets this for free because `proxySemanticPorts` is built from
  // the RAW `proxyTools` array. The built-ins need it said out loud, because
  // their ports come from `definitions`, which is exactly the list deferral
  // subtracts from. Caught by `pi-runtime-cwd-transaction.test.ts` driving a
  // deferred `workflow` end to end on a real server; no unit test saw it.
  const definitionNames = new Set(definitions.map(definition => definition.name));
  const definitionsForPorts = [
    ...definitions,
    ...deferrableBuiltinDefs.filter(definition => !definitionNames.has(definition.name)),
  ];
  const projectedForPorts = projectPiManifestTools({
        manifest: activeExecutionManifest,
        definitions: definitionsForPorts,
        expectedGeneration: activeExecutionManifest.snapshotGeneration,
        expectedManifestHash: activeExecutionManifest.manifestHash,
        expectedSessionKey: {
          workspaceId: generationConfig.workspaceId ?? '',
          sessionId: generationConfig.sessionId,
        },
        expectedOrchestrator: normalizePiOrchestratorConfig(generationConfig.orchestrator),
      });
  const runtimePorts = buildRuntimeBackedToolExecutionPorts(cwd);
  const progressBridge = createPiToolProgressBridge();
  const runtimeSemanticIds = new Set(runtimePorts.map(port => port.semanticId));
  const resolveManifestSemanticId = (presentedName: string) => {
    const tool = findManifestToolByPresentedName(manifest, presentedName);
    if (!tool) throw new Error(`Missing manifest tool for ${presentedName}`);
    return tool.descriptor.id;
  };
  const proxySemanticPorts = createPiToolExecutionPorts(proxyTools, resolveManifestSemanticId)
  const proxySemanticIds = new Set(proxySemanticPorts.map(port => port.semanticId))
  const semanticPorts = createPiToolExecutionPorts(projectedForPorts.filter(tool => {
    return !runtimeSemanticIds.has(resolveManifestSemanticId(tool.name))
      && !proxySemanticIds.has(resolveManifestSemanticId(tool.name))
  }), resolveManifestSemanticId);
  const hiddenProxyNames = new Set(proxyToolSurface.hiddenToolNames)
  const createRuntime = (
    runtimeCwd: string,
    onFileMutationAuthorized?: LocalToolRuntimeOptions['onFileMutationAuthorized'],
  ) => new LocalToolRuntime({
      filesystemScope: sessionScopeFor(runtimeCwd),
      onFileMutationAuthorized,
      requestOutsideRootApproval,
      // P3.272 — the results half of the sensitive-files contract. Absent, every
      // search and listing here withheld nothing; see `filterDeniedResultPaths`.
      filterDeniedResultPaths,
      sessionPath: generationConfig.sessionPath,
      guardLargeResults: false,
      permissionManager: {
        evaluateToolCall: () => {
          throw new Error('Session ToolExecutor must use LocalToolRuntime.executeAuthorized');
        },
      },
      summarizeLargeResult: prompt => runMiniCompletion(prompt, generationConfig),
      contextWindow: generationSession?.agent.state.model?.contextWindow,
      onDebug: debugLog,
      runCommand: async (command, commandCwd, options) => {
        const executionId = options?.executionId
          ?? `process-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const background = options?.background === true
        const timeoutMs = options?.timeout ?? 120_000
        // R10: the shell tool's timeout expiry transitions to a background task
        // instead of the kill path — never for sleep-prefixed commands, never
        // when background tasks are disabled, and only for `bash` itself.
        const onTimeout = resolveBashTimeoutBehavior({
          semanticId: options?.semanticId,
          command,
        })
        const supervised = await requestSupervisedProcess({
          executionId,
          semanticId: options?.semanticId ?? 'bash',
          command,
          cwd: commandCwd,
          // Shell commands run NETWORKED by owner decision (2026-07-28): the
          // `networked` profile keeps the identical writable root as
          // `workspace` (isolation/darwin.ts, isolation/linux.ts) and differs
          // ONLY in the network dimension, so filesystem containment is
          // unchanged while outbound access is allowed. The per-domain egress
          // layer that would narrow this again is R19, deliberately parked.
          profile: options?.isolationProfile ?? 'networked',
          background,
          timeoutMs: background ? BACKGROUND_PROCESS_MAX_LIFETIME_MS : timeoutMs,
          ...(onTimeout === 'background' ? { onTimeout } : {}),
          // No sandbox-bypass request here on purpose: this runs INSIDE the Pi
          // subprocess, and `handleProcessStartRequest` rebuilds the host
          // request field-by-field from an allowlist. A bypass flag sent from
          // here could never be honoured, so offering one would be a control
          // that does nothing.
        }, options?.signal)
        const backgrounded = background || supervised.movedToBackground === true
        if (backgrounded) {
          // The transitioned/backgrounded shell joins the existing listing the
          // same way bash_background shells do.
          send({
            type: 'event',
            event: { type: 'shell_backgrounded', toolUseId: executionId, shellId: supervised.handle, command },
          })
        }
        return {
          stdout: supervised.output,
          stderr: '',
          exitCode: supervised.exitCode ?? (supervised.signal ? 1 : 0),
          ...(backgrounded ? {
            backgrounded: {
              taskId: supervised.handle,
              outputFile: supervised.outputFile ?? '',
              timedOut: supervised.movedToBackground === true,
              timeoutMs,
            },
          } : {}),
          isolationProfile: supervised.isolationProfile,
          ...(supervised.isolationDowngrade ? { isolationDowngrade: supervised.isolationDowngrade } : {}),
          environmentProfile: supervised.environmentProfile,
          environmentDigest: supervised.environmentDigest,
        }
      },
    });
  const createExecutor = (
    runtimeCwd: string,
    ports: Parameters<typeof createToolExecutor>[0]['ports'],
  ) => {
    const checkpointIntents = new Map<string, {
      adapter: 'file';
      sessionPath: string;
      toolName: string;
    }>();
    const pendingCheckpoints = new Map<string, { checkpointId: string; sessionPath: string }>();
    const persistAuthorizedCheckpoint = async (
      executionId: string,
      authorizedTarget: string,
    ): Promise<string | undefined> => {
      const existing = pendingCheckpoints.get(executionId);
      if (existing) return existing.checkpointId;
      const intent = checkpointIntents.get(executionId);
      if (!intent) return;
      const [checkpoint] = await createFileCheckpoint({
        sessionPath: intent.sessionPath,
        adapter: intent.adapter,
        toolName: intent.toolName,
        toolCallId: executionId,
        input: {},
        authorizedTarget,
      });
      if (!checkpoint) return;
      pendingCheckpoints.set(executionId, {
        checkpointId: checkpoint.id,
        sessionPath: intent.sessionPath,
      });
      return checkpoint.id;
    };
    const runtime = createRuntime(runtimeCwd, async ({ call, canonicalPath }) => {
      await persistAuthorizedCheckpoint(call.id, canonicalPath);
    });
    const portBySemanticId = new Map(ports.map(port => [port.semanticId, port]));
    return createToolExecutor({
    runtime,
    authority: {
      sessionKey: manifest.sessionKey,
      manifestIdentity,
      getCurrentResponseEpoch: () => responseEpoch,
    },
    ports,
    onProgress: progressBridge.emit,
    onReceipt: receipt => send({ type: 'execution_receipt', receipt: summarizeExecutionReceipt(receipt) }),
    transformResult: createPiToolResultTransformer({
      getSessionPath: () => generationConfig.sessionPath || null,
      getModelContextWindow: () => generationSession?.agent.state.model?.contextWindow,
      getCurrentUserMessage: () => currentUserMessage,
      runMiniCompletion: prompt => runMiniCompletion(prompt, generationConfig),
      debugLog,
    }),
    async permissionBridge(request, canonicalInput) {
      if (request.semanticId === 'ask_user') {
        return { allowed: true, decisionId: 'not-requested', canonicalInput };
      }
      try {
        const rawReceipt = await requestPiPermissionReceipt(
          request.presentedName,
          canonicalInput,
          request.manifestIdentity.responseEpoch,
          request.executionId,
        );
        const manifest = activeExecutionManifest;
        if (!manifest) throw new Error('Pi execution manifest is not registered');
        const tool = findManifestToolByPresentedName(manifest, request.presentedName);
        if (!tool) throw new Error(`Non-advertised Pi tool spelling: ${request.presentedName}`);
        const receipt = parseAndFreezePiPermissionReceipt(rawReceipt, {
          sessionKey: request.sessionKey,
          provider: 'pi',
          surfaceVersion: manifest.surfaceVersion,
          piName: tool.binding.piName,
          bindingName: tool.binding.bindingName,
          semanticId: request.semanticId,
          descriptorId: tool.binding.descriptorId,
          manifestGeneration: request.manifestIdentity.generation,
          manifestHash: request.manifestIdentity.manifestHash,
          manifestProvenance: manifest.provenance.map(value => `${value.capabilityKey}@${value.generation}`),
          responseEpoch: request.manifestIdentity.responseEpoch,
          contextProfile: generationConfig.contextProfile ?? 'bare',
          sandboxRequirement: tool.descriptor.sandboxProfile,
        });
        if (consumedPermissionDecisionIds.has(receipt.decisionId)) {
          throw new Error(`Pi permission receipt replay: ${receipt.decisionId}`);
        }
        consumedPermissionDecisionIds.add(receipt.decisionId);
        return {
          allowed: receipt.outcome === 'allow',
          decisionId: receipt.decisionId,
          canonicalInput: receipt.canonicalInput,
          reason: receipt.reason,
          additionalContext: receipt.additionalContext,
        };
      } catch (error) {
        return {
          allowed: false,
          decisionId: 'pretool-use',
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async beforeDispatch(request, descriptor, canonicalInput) {
      if (!generationConfig.sessionPath || !descriptor.checkpointAdapter) return;
      const policyName = findPiToolBinding(request.presentedName)?.permissionName ?? request.presentedName;
      checkpointIntents.set(request.executionId, {
        sessionPath: generationConfig.sessionPath,
        adapter: descriptor.checkpointAdapter,
        toolName: policyName,
      });
      const port = portBySemanticId.get(request.semanticId);
      if (!port) throw new Error(`Missing checkpoint execution port: ${request.semanticId}`);
      const dispatch = port.dispatch;
      const runtimeWillAuthorize = dispatch.kind === 'local'
        || (dispatch.kind === 'select' && !dispatch.useSemantic(canonicalInput));
      if (runtimeWillAuthorize) return;

      const target = canonicalInput.file_path ?? canonicalInput.notebook_path ?? canonicalInput.path;
      if (typeof target !== 'string' || target.trim().length === 0) return;
      const authorizedTarget = await runtime.authorizePath(target, 'write');
      const checkpointId = await persistAuthorizedCheckpoint(request.executionId, authorizedTarget);
      return checkpointId ? { checkpointId } : undefined;
    },
    async afterDispatch(request, _descriptor, _canonicalInput, outcome) {
      checkpointIntents.delete(request.executionId);
      const pending = pendingCheckpoints.get(request.executionId);
      if (!pending) return;
      pendingCheckpoints.delete(request.executionId);
      await finalizeFileCheckpoint({
        sessionPath: pending.sessionPath,
        checkpointId: pending.checkpointId,
        succeeded: Boolean(outcome.result && !outcome.result.isError),
      });
      return { checkpointId: pending.checkpointId };
    },
  });
  };
  const executorPorts = [...runtimePorts, ...semanticPorts, ...proxySemanticPorts]
  if (new Set(executorPorts.map(port => port.semanticId)).size !== executorPorts.length) {
    throw new Error('Duplicate Pi ToolExecutor semantic port')
  }
  const toolExecutor = createExecutor(cwd, executorPorts);
  if (proxyToolSurface.enabled) {
    deferredMcpRegistration = createDeferredMcpRegistrationController({
      // The same widened input the surface was built from: a hidden built-in
      // that is not in this list would be searchable, loadable, and then fail to
      // register — visible in the catalogue and impossible to call.
      candidates: deferralSurfaceInput.filter(tool => hiddenProxyNames.has(tool.name)),
      manifest, allowedBindingNames,
      toolExecutor, progressBridge, // F1.925: the eager adapter's bridge, so a loaded tool's progress reaches Pi
      responseEpoch: sessionResponseEpoch,
    })
  }
  const projected = projectPiManifestTools({
    manifest,
    definitions: [
      ...buildRuntimeBackedBuiltinToolDefinitions(cwd, {
        toolExecutor,
        sessionKey: manifest.sessionKey,
        manifestIdentity,
      }),
      ...builtinDefs.slice(runtimeBackedDefs.length).filter(definition => !isDeferrableBuiltinDef(definition)),
      ...webTools.filter(definition => !isDeferrableBuiltinDef(definition)),
      ...proxyToolSurface.tools,
      ...orchestratorTools.filter(definition => !isDeferrableBuiltinDef(definition)),
    ],
    expectedGeneration: manifest.snapshotGeneration,
    expectedManifestHash: manifest.manifestHash,
    expectedSessionKey: manifest.sessionKey,
    expectedOrchestrator: normalizePiOrchestratorConfig(generationConfig.orchestrator),
  });
  const { adaptTools } = createPiSdkToolAdapter({
    toolExecutor,
    sessionKey: manifest.sessionKey,
    manifestIdentity,
    resolveSemanticId: resolveManifestSemanticId,
    progressBridge,
  });
  if (configureActiveSpawner) {
    configureSpawnerForGeneration(config, manifest);
  }
  const wrappedAll = adaptTools(projected);
  // Absent only when the host's `disableWorkflows` removed it from the signed
  // manifest. Any other absence is still a defect, but it is indistinguishable
  // here, so the slash dispatch path reports it instead of aborting startup.
  const workflowCommandTool = wrappedAll.find(tool => tool.name === 'workflow');
  const deferredNote = proxyToolSurface.enabled
    ? ` (${proxyToolSurface.hiddenToolNames.length} deferred MCP tools hidden)`
    : '';
  debugLog(`Session tools: ${builtinDefs.length} builtin + ${webTools.length} web + ${proxyToolSurface.tools.length} proxy + ${orchestratorTools.length} orchestrator = ${wrappedAll.length} total${deferredNote}`);

  const sessionOptions: CreatePiRuntimeSessionOptions['sessionOptions'] = {
    customTools: wrappedAll,
    tools: wrappedAll.map(tool => tool.name).concat(deferredMcpRegistration?.allowlistNames ?? []), // F1.803: see allowlistNames
  };
  let modelHint: { api?: string; provider?: string; baseUrl?: string } | undefined;
  if (config.model) {
    const authProvider = config.piAuth?.provider;
    const preferCustomEndpoint = shouldPreferCustomEndpoint(config);
    let piModel: ReturnType<typeof resolvePiModel> = undefined;
    try {
      // UB12.10 — upstream's provider check let a custom endpoint's session run on the wire
      // protocol's PUBLIC model with the endpoint's credential (`resolveRoutedSessionModel`).
      // Every session build passes here: an init (a child session's too) and a cwd candidate.
      piModel = resolveRoutedSessionModel(registry.modelRegistry, config.model, authProvider, preferCustomEndpoint,
        bareId => registerCustomEndpointModels(registry.modelRegistry, config.customEndpoint!.api, config.baseUrl!.trim(), [{ id: bareId }], config, registry.customState));
    } catch {
      debugLog(`Could not resolve Pi model: ${config.model}`);
    }
    if (piModel) {
      sessionOptions.model = piModel;
      modelHint = piModel as { api?: string; provider?: string; baseUrl?: string };
    } else if (preferCustomEndpoint) {
      // Fail closed: a session built with no model lets the SDK pick one itself (the session
      // file's recorded model, or `findInitialModel`), and on a custom endpoint that pick may be
      // the public model this row keeps the endpoint's credential away from.
      throw new Error(`Pi model ${config.model} does not resolve on the custom endpoint; the session is not started on another route`);
    } else {
      debugLog(`Model ${config.model} did not resolve for provider ${authProvider ?? '(none)'}, skipping`);
    }
  }

  const piThinkingLevel = THINKING_TO_PI[config.thinkingLevel as keyof typeof THINKING_TO_PI];
  if (piThinkingLevel) sessionOptions.thinkingLevel = piThinkingLevel;

  return {
    sessionOptions,
    toolExecutor,
    responseEpoch: sessionResponseEpoch,
    deferredMcpExtension: deferredMcpRegistration?.factory,
    autoCompactionExtension,
    attachSession(session) {
      generationSession = session;
      if (configureActiveSpawner) responseEpoch = sessionResponseEpoch;
    },
    modelHint,
    workflowCommandTool: workflowCommandTool ?? null,
    // The `/context` accounting inputs, captured from the SAME objects this
    // generation advertises: the adapted tool surface, the runtime agent
    // definitions (provenance included), and the materialized context
    // resources. No re-composition happens at measurement time.
    contextAccounting: {
      toolDefinitions: wrappedAll.map(tool => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        parameters: tool.parameters,
      })),
      agentDefinitions: runtimeAgentDefinitions.map(definition => ({
        name: definition.name,
        description: definition.description,
        systemPrompt: definition.systemPrompt,
        ...(definition.provenance ? { provenance: definition.provenance } : {}),
      })),
      contextResources: config.piContextResources ?? [],
    },
    toolCount: wrappedAll.length,
    activateSpawner() {
      const config = generationConfig;
      responseEpoch = sessionResponseEpoch;
      configureSpawnerForGeneration(config, manifest);
      // Published together with the spawner: a `/subtask` fork uses the spawner
      // this generation configured, so it must register in this generation's
      // registry — the same one the `subagent` tool was handed.
      activeBackgroundTasks = backgroundTasks;
      activeRuntimeAgentDefinitions = runtimeAgentDefinitions;
      generationPublished = true;
      if (generationToolsChanged) toolsChanged = true;
    },
    async deactivateSpawner() {
      generationPublished = false;
      if (activeRuntimeAgentDefinitions === runtimeAgentDefinitions) activeRuntimeAgentDefinitions = [];
      if (activeBackgroundTasks === backgroundTasks) activeBackgroundTasks = null;
      await backgroundTasks.drain();
    },
    updateConfig(nextConfig) {
      generationConfig = nextConfig;
    },
  };
}

/**
 * D1.145 · the in-flight build, held so a second caller joins it.
 *
 * The stdin reader dispatches WITHOUT awaiting — `rl.on('line', … )` calls
 * `processMessage(msg).catch(…)` — so two inbound messages arriving close
 * together run concurrently. Both used to reach the body below with `piSession`
 * still null and BUILD TWO Pi sessions: the second overwrote `piSession`,
 * `runtimeHandle` and the `activeSpawner*` / `activeConfigUpdate` handles, and
 * the first session's spawner activation and config updates were left dangling
 * on a session nothing could reach, dispose or abort.
 *
 * Cleared on SETTLE rather than on success, so a build that throws (init not
 * received yet, a branch fork whose parent file is gone) does not poison the
 * slot for the retry that follows it.
 */
let sessionCreation: Promise<AgentSession> | null = null;

async function ensureSession(): Promise<AgentSession> {
  if (piSession) return piSession;
  sessionCreation ??= buildSession().finally(() => { sessionCreation = null });
  return sessionCreation;
}

async function buildSession(): Promise<AgentSession> {
  if (!initConfig) throw new Error('Cannot create session: init not received');

  const config = initConfig;
  const cwd = resolvedCwd(config);

  const { credentials, modelRuntime, modelRegistry } = await createAuthenticatedRegistry();
  // Store at module scope for set_model handler
  piModelRegistry = modelRegistry;
  const definition = buildSessionDefinition(
    config,
    cwd,
    { credentials, modelRuntime, modelRegistry },
    true,
  );
  const { sessionOptions } = definition;
  let agentDir: string | undefined;
  let strategy: PiRuntimeSessionStrategy = { kind: 'memory' };
  // T7 · whether this session ended up forking the host's carry file. Reported
  // on `session_id_update`; the host keeps the text handoff armed until it is
  // true, so a decline and a failure both degrade to the same safe outcome.
  let carriedHistory = false;

  // Extension isolation: set agentDir to a temp directory under session path
  // to prevent loading global Pi extensions from ~/.pi/agent
  if (config.sessionPath) {
    agentDir = join(config.sessionPath, '.pi-agent');
    mkdirSync(agentDir, { recursive: true });

    // Session resume: use a per-Nessy-session directory so the Pi SDK can
    // persist and resume its own session across subprocess restarts.
    // continueRecent() loads the existing session if one exists, otherwise
    // creates a new one — so this handles both first-run and resume.
    const sessionDir = join(config.sessionPath, '.pi-sessions');
    mkdirSync(sessionDir, { recursive: true });

    if (config.resumeSessionFile) { strategy = { kind: 'reopen', sessionFile: config.resumeSessionFile }; } // UA12.217 — /resume named its file: open THAT, never whatever else is newest in the directory
    else if (config.startFresh) { strategy = { kind: 'fresh', sessionDir }; } // UA12.217 — the post-/clear one-shot: a NEW session; the pre-clear sidecar stays on disk for /resume
    else if (config.branchFromSessionPath && !findMostRecentSessionFile(sessionDir)) { // F1.1291 — fork ONCE: every spawn of a branched chat carries the lineage, so a respawn resumes the branch's own session (below) instead of forking the parent again
      // Branching: fork from the parent session's Pi session file.
      // Branches must not silently degrade to fresh sessions.
      const parentPiSessionDir = join(config.branchFromSessionPath, '.pi-sessions');
      const parentPiSessionFile = findMostRecentSessionFile(parentPiSessionDir);
      if (!parentPiSessionFile) {
        throw new Error(`Pi branch preflight failed: no parent Pi session file found in ${parentPiSessionDir}`);
      }

      debugLog(`Forking Pi session from parent: ${parentPiSessionFile}`);
      strategy = {
        kind: 'fork',
        parentSessionFile: parentPiSessionFile,
        sessionDir,
        anchorEntryId: config.branchFromSdkTurnId,
      };
    } else if (config.carryHistorySessionFile && !findMostRecentSessionFile(sessionDir)) {
      // T7 · a FIRST cross-runtime switch INTO Pi. The host synthesized a v3
      // session file holding the conversation; forking it is what makes the
      // history Pi's OWN rather than a quotation of it in the next prompt.
      //
      // **The `findMostRecentSessionFile` guard is the anchor rule, enforced
      // where it cannot be argued with.** `'pi'` is in `ANCHORED_PROVIDERS`,
      // so a return leg is planned as `anchor` upstream and never writes a
      // carry file — but the anchor map and this directory can come apart (a
      // session written before the map existed carries no `pi` entry while its
      // sidecar sits right here). Forking then would create a NEWER session
      // file in this directory and orphan everything Pi actually did. So the
      // presence of Pi's own record wins, always, and the host is told the
      // carry was declined so it delivers the span as text instead.
      //
      // No `anchorEntryId`: the whole carry file is the history, so the fork's
      // leaf is its last entry, which is where `forkFrom` already leaves it.
      debugLog(`Forking Pi session from the runtime-handoff carry file: ${config.carryHistorySessionFile}`);
      strategy = {
        kind: 'fork',
        parentSessionFile: config.carryHistorySessionFile,
        sessionDir,
      };
      carriedHistory = true;
    } else { strategy = { kind: 'continue', sessionDir }; } // UA12.217 — resumed here (compacted to one line to keep the file's doc-cited lines still)

  }
  // Create the session — tools flow through customTools + allowlist (see comment above).
  const createWithStrategy = (chosen: PiRuntimeSessionStrategy) => runtimeAdapter.createSession({
    cwd,
    agentDir,
    registry: { credentials, modelRuntime, modelRegistry },
    strategy: chosen,
    executionManifest: activeExecutionManifest ?? undefined,
    toolExecutor: definition.toolExecutor,
    responseEpoch: definition.responseEpoch,
    compaction: runtimeCompactionSettings(sessionOptions.model),
    deferredMcpExtension: definition.deferredMcpExtension,
    autoCompactionExtension: definition.autoCompactionExtension,
    contextResources: config.piContextResources,
    lifecycleEventSink: (event, input) => { send({ type: 'automation_event', event, input }) },
    transformToolResult: requestPostToolUseTransform,
    // R73 · both createSession sites must pass this. Missing the second one
    // leaves the regenerated (cwd-change) session's compaction unblockable.
    requestCompactionDecision: requestPreCompactDecision,
    getOriginalUserPrompt: () => currentUserMessage,
    sessionOptions,
  });
  try {
    runtimeHandle = await createWithStrategy(strategy);
  } catch (error) {
    // T7 · a carry fork that throws must not take the session down with it.
    // `forkFrom` refuses a source whose header Pi will not accept ("empty or
    // invalid"), and the adapter has already removed any partial artefact —
    // so the recovery is simply the session this arm replaced. The host still
    // holds the armed text handoff, and `carriedHistory: false` is what tells
    // it to deliver it. A BRANCH fork keeps failing loudly: there the fallback
    // would silently discard the branch point the user chose.
    if (!carriedHistory || strategy.kind !== 'fork') throw error;
    carriedHistory = false;
    debugLog(`Pi carry fork failed (${error instanceof Error ? error.message : String(error)}); starting a fresh session and leaving the text handoff to the host`);
    runtimeHandle = await createWithStrategy({ kind: 'continue', sessionDir: strategy.sessionDir });
  }
  piSession = runtimeHandle.session;
  // Compaction was already seeded through `createSession({ compaction })`;
  // retry has no such option, so the profile is overlaid here.
  applyRetryPolicy(piSession, gatewayRuntimeActive());
  definition.attachSession(piSession);
  setInterceptorApiHints(definition.modelHint);
  activeModelHint = definition.modelHint;
  activeSpawnerActivation = definition.activateSpawner;
  activeSpawnerDeactivation = definition.deactivateSpawner;
  activeConfigUpdate = definition.updateConfig;
  activeWorkflowCommandTool = definition.workflowCommandTool;
  activeContextAccounting = definition.contextAccounting;

  toolsChanged = false;
  debugLog(`Created Pi session: ${piSession.sessionId} (${definition.toolCount} tools)`);

  // Notify main process of session ID — and, when this session came from the
  // host's carry file, that the runtime handoff has been delivered natively.
  send({
    type: 'session_id_update',
    sessionId: piSession.sessionId,
    ...(carriedHistory ? { carriedHistory: true } : {}),
  });

  return piSession;
}


// ============================================================
// Tool Wrapping (Permission Enforcement + Large Response Summarization)
// ============================================================

/**
 * Shared permission enforcement for both coding tools and proxy tools.
 * Checks mode-manager rules and, in Ask mode, prompts the user via the
 * pending-permissions handshake. Throws on deny or block.
 */
/**
 * Send pre_tool_use_request to main process and wait for response.
 * Returns the (potentially modified) input if approved, throws if blocked.
 * All permission checking, transforms, and source activation happen in the main process.
 */
/**
 * Projected definitions present the canonical model-visible piName while raw
 * proxy definitions keep the host bindingName (e.g. notebook_edit vs
 * NotebookEdit). The union rule lives in the harness module so there is exactly
 * one of it; this file only routes through it.
 */
function findManifestToolByPresentedName(
  manifest: PiExecutionManifestV2,
  presentedName: string,
): PiExecutionManifestV2['tools'][number] | undefined {
  return findPiManifestToolByPresentedName(manifest, presentedName);
}

async function requestPiPermissionReceipt(
  presentedName: string,
  input: Record<string, unknown>,
  manifestResponseEpoch: number,
  toolCallId?: string,
): Promise<unknown> {
  const manifest = activeExecutionManifest;
  if (!manifest) throw new Error('Pi execution manifest is not registered');
  const tool = findManifestToolByPresentedName(manifest, presentedName);
  if (!tool) throw new Error(`Non-advertised Pi tool spelling: ${presentedName}`);
  const policyName = tool.binding.permissionName;
  const requestId = `pi-ptu-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  send({
    type: 'pre_tool_use_request',
    requestId,
    toolName: policyName,
    semanticId: tool.descriptor.id,
    piName: tool.binding.piName,
    surfaceVersion: manifest.surfaceVersion,
    manifestResponseEpoch,
    manifestGeneration: manifest.snapshotGeneration,
    manifestHash: manifest.manifestHash,
    manifestProvenance: tool.source.kind === 'resolvedCapability' ? [tool.source.capabilityKey] : [],
    ...(toolCallId ? { toolCallId } : {}),
    input,
  });

  const response = await new Promise<{ receipt?: unknown; reason?: string }>((resolve) => {
    pendingPreToolUse.set(requestId, { resolve });
  });
  if (!response.receipt) throw new Error(response.reason || `Tool "${presentedName}" permission receipt is missing`);
  return response.receipt;
}

function requestPostToolUseTransform(input: {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResponse: string;
  isError: boolean;
}): Promise<{ updatedToolOutput?: string } | undefined> {
  const manifestTool = activeExecutionManifest
    ? findManifestToolByPresentedName(activeExecutionManifest, input.toolName)
    : undefined;
  const requestId = `pi-post-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise(resolve => {
    pendingPostToolUse.set(requestId, { resolve });
    send({
      type: 'post_tool_use_request',
      requestId,
      toolName: manifestTool?.binding.permissionName ?? input.toolName,
      input: input.toolInput,
      toolResponse: input.toolResponse,
      isError: input.isError,
    });
  });
}

/**
 * R73 · ask the host for a `PreCompact` verdict and WAIT for it.
 *
 * A copy of `requestPostToolUseTransform`'s shape on purpose: same pending map,
 * same request id form, same drain in `clearPendingPreToolUse`, so a subprocess
 * teardown resolves `undefined` (fail open) instead of hanging the compaction.
 */
function requestPreCompactDecision(input: {
  trigger: 'manual' | 'auto';
  source: string;
  /** D1.115 — carried as `null` rather than `''`; see `hooks.md#precompact-input`. */
  customInstructions: string | null;
}): Promise<{ block?: boolean; reason?: string } | undefined> {
  const requestId = `pi-precompact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise<{ block?: boolean; reason?: string } | undefined>(resolve => {
    pendingPreCompact.set(requestId, { resolve });
    send({
      type: 'pre_compact_request',
      requestId,
      trigger: input.trigger,
      source: input.source,
      customInstructions: input.customInstructions,
    });
  }).then(response => {
    lastPreCompactBlockReason = response?.block ? response.reason : undefined;
    return response;
  });
}

const pendingOutsideRoot = new Map<string, { resolve: (root: SessionFilesystemScopeRoot | null) => void; refuse: (reason: string) => void }>();

/**
 * P4 structured outside-root approval: one request per outside-scope path,
 * resolved by the host permission authority. Denial resolves null (no side
 * effect) or, when the host names a `reason` (F1.959), rejects with it; the suspended tool call resumes on grant. F1.957: it lives only as long as the asking call (`bindOutsideRootRequestToCall`).
 */
function requestOutsideRootApproval(
  canonicalTarget: string,
  access: 'read' | 'write', signal?: AbortSignal, // F1.957 — the asking call's own signal (`LocalToolRuntime.scopedPath`)
): Promise<SessionFilesystemScopeRoot | null> {
  const requestId = `pi-oroot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  send({ type: 'outside_root_request', requestId, canonicalTarget, access });
  const answer = new Promise<SessionFilesystemScopeRoot | null>((resolve, reject) => { pendingOutsideRoot.set(requestId, { resolve, refuse: reason => reject(new Error(reason)) }); });
  bindOutsideRootRequestToCall(pendingOutsideRoot, requestId, signal, send);
  return answer;
}

function clearPendingOutsideRoot(): void {
  // Denial semantics: the suspended call fails with its outside-root error.
  for (const [, pending] of pendingOutsideRoot) pending.resolve(null);
  pendingOutsideRoot.clear();
}

const pendingDeniedPaths = new Map<string, { resolve: (denied: readonly string[]) => void }>();

/**
 * P3.272 — the results half of `settings-reference.md#exclude-sensitive-files`,
 * the one clause the request gate structurally cannot deliver: *"Claude Code
 * excludes matching files from file discovery and search results"*. A `grep`
 * rooted one directory ABOVE a denied file passes the request gate with a
 * perfectly legal `path` argument and returns the denied file's lines.
 *
 * `LocalToolRuntime` already calls this at all five result seams
 * (`search_files`, `grep`, `find`, `ls`, `list_files`); the option was never
 * supplied, so `ea0085113`'s filter had no production caller. This is that
 * caller. The decision is the HOST's — `denied-result-filter.ts` records the two
 * measurements that put it there (8.81 MB over 828 modules to import the matcher,
 * and a `permissionManager` in this process that throws by design) and the reason
 * a second matcher was refused outright.
 *
 * TEARDOWN RESOLVES EMPTY, not never: an unanswered batch suspends the search
 * that asked for it. Empty means "withhold nothing", which is the pre-row
 * behaviour and the safe direction — the inverse contract answered wrongly would
 * withhold every result of every search.
 */
function filterDeniedResultPaths(paths: readonly string[]): Promise<readonly string[]> {
  const requestId = `pi-deny-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  send({ type: 'denied_paths_request', requestId, paths: [...paths] });
  return new Promise(resolve => {
    pendingDeniedPaths.set(requestId, { resolve });
  });
}

function clearPendingDeniedPaths(): void {
  for (const [, pending] of pendingDeniedPaths) pending.resolve([]);
  pendingDeniedPaths.clear();
}

function clearPendingPreToolUse(reason: string): void {
  clearPendingOutsideRoot();
  clearPendingDeniedPaths();
  for (const [, pending] of pendingPostToolUse) pending.resolve(undefined);
  pendingPostToolUse.clear();
  // R73. Fail OPEN on teardown: an unanswered PreCompact must let the
  // compaction proceed, never leave `session_before_compact` awaiting forever.
  for (const [, pending] of pendingPreCompact) pending.resolve(undefined);
  pendingPreCompact.clear();
  for (const [, pending] of pendingPreToolUse) {
    pending.resolve({ reason });
  }
  pendingPreToolUse.clear();
}

async function requestAskUser(request: AskUserRequest, signal: AbortSignal): Promise<AskUserAnswer> {
  send({
    type: 'ask_user_request',
    ...request,
  });

  return new Promise<AskUserAnswer>((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      pendingAskUser.delete(request.requestId);
      cleanup();
      send({
        type: 'ask_user_cancel',
        requestId: request.requestId,
        reason: signal.reason === 'timed_out' ? 'timed_out' : 'aborted',
      });
      reject(new Error('ask_user was aborted.'));
    };

    pendingAskUser.set(request.requestId, {
      resolve: (answer) => {
        cleanup();
        resolve(answer);
      },
      reject: (error) => {
        cleanup();
        reject(error);
      },
      cleanup,
    });

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function getAskUserTimeoutMs(): number | undefined {
  const raw = process.env.NESSY_ASK_USER_TIMEOUT_MS;
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

// ============================================================
// Proxy Tools (tools executed in main process)
// ============================================================

/** Bound one settled MCP payload for the task-notification body. */
const MCP_NOTIFICATION_TEXT_LIMIT = 16_384;

function formatMcpTaskNotificationText(taskId: string, toolName: string, outcome: {
  failed: boolean;
  body: string;
}): string {
  const body = outcome.body.length > MCP_NOTIFICATION_TEXT_LIMIT
    ? `${outcome.body.slice(0, MCP_NOTIFICATION_TEXT_LIMIT)}\n… [truncated]`
    : outcome.body;
  return `MCP background task ${taskId} (${toolName}) ${outcome.failed ? 'failed' : 'completed'}:\n${body}`;
}

function buildProxyTools(backgroundTasks?: BackgroundTaskRegistry): ToolDefinition<any, any>[] {
  debugLog(`Building proxy tools from ${proxyToolDefs.length} definitions: ${proxyToolDefs.map(t => t.name).join(', ')}`);

  if (!activeExecutionManifest) throw new Error('Pi execution manifest is not initialized');
  return proxyToolDefs.map<ToolDefinition<any, any>>(def => {
    const route = activeExecutionManifest!.tools.find(tool => tool.binding.bindingName === def.name);
    if (!route) throw new Error(`Pi proxy binding is not advertised: ${def.name}`);
    return ({
    name: def.name,
    label: def.name
      .replace(/^mcp__.*?__/, '')
      .replace(/_/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2'),
    description: route.description ?? def.description,
    promptSnippet: route.promptSnippet,
    promptGuidelines: route.promptGuidelines ? [...route.promptGuidelines] : undefined,
    parameters: route.modelSchema ?? def.inputSchema,
    execute: async (
      toolCallId: string,
      params: any,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<any>> => {
      // Execute via main process
      const requestId = `proxy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      if (signal?.aborted) throw new Error('proxy-tool-aborted')
      type PendingToolExecution = typeof pendingToolExecutions extends Map<string, infer V> ? V : never
      let pendingRef: PendingToolExecution | undefined
      const resultPromise = new Promise<ProxyExecutionResult>((resolve, reject) => {
        const pending: PendingToolExecution = { resolve, reject }
        pendingRef = pending
        if (signal) {
          const abort = () => {
            if (!pendingToolExecutions.delete(requestId)) return
            reject(new Error('proxy-tool-aborted'))
            send({ type: 'tool_execute_cancel', requestId } satisfies OutboundToolExecCancel)
          }
          signal.addEventListener('abort', abort, { once: true })
          pending.removeAbort = () => signal.removeEventListener('abort', abort)
        }
        pendingToolExecutions.set(requestId, pending);
      });

      send({
        type: 'tool_execute_request',
        requestId,
        toolName: def.name,
        piName: route.binding.piName,
        manifestGeneration: activeExecutionManifest!.snapshotGeneration,
        manifestHash: activeExecutionManifest!.manifestHash,
        ...(toolCallId ? { toolCallId } : {}),
        args: params as Record<string, unknown>,
      });

      // R10 (`mcp.md` §Automatic backgrounding of long tool calls): a
      // main-conversation call still running past the threshold moves to a
      // background task instead of blocking the session. Subagent sessions and
      // headless runs (without the opt-in) never detach — decided inside
      // mcpAutoBackgroundDelayMs from host-authoritative init facts.
      //
      // R24 (`mcp.md:261`): the move is deferred while an elicitation dialog is
      // open — "the server is blocked on your input, not slow". The gate below
      // holds the host's dialog state; see `elicitation-dialog-gate.ts`.
      const detachDelayMs = backgroundTasks
        ? mcpAutoBackgroundDelayMs({
            sessionDepth: initConfig?.orchestrator?.sessionDepth ?? 0,
            isHeadless: initConfig?.isHeadless === true,
          })
        : null
      if (detachDelayMs === null || !backgroundTasks) {
        return proxyExecutionResultToAgentToolResult(await resultPromise);
      }

      const detachTimer = detachAfter(detachDelayMs, elicitationDialogGate)
      const raced = await Promise.race([
        resultPromise.then(
          result => ({ kind: 'settled' as const, result }),
          error => ({ kind: 'failed' as const, error }),
        ),
        detachTimer.promise,
      ])
      if (raced.kind !== 'detach') {
        detachTimer.cancel()
        if (raced.kind === 'failed') throw raced.error
        return proxyExecutionResultToAgentToolResult(raced.result)
      }

      // DETACH: the model gets the task id immediately; the call keeps running
      // on the host under its wall-clock/idle limits, and the settled result
      // arrives as a task notification.
      const taskId = `task-mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      // The turn's abort signal no longer owns this call — it is a background
      // task now, stopped by stopTask or the session's own lifecycle.
      pendingRef?.removeAbort?.()
      // UB2.10 — tell the HOST the same fact: its `pendingToolExecutions` entry for this
      // request must leave the Stop sweep's reach (a Stop ends the REPLY, not a detached MCP
      // write), while `stop_background_task` keeps stopping it by taskId.
      send({ type: 'tool_execute_detached', requestId, taskId } satisfies OutboundToolExecDetached)
      if (pendingRef) pendingRef.removeAbort = undefined
      const controller = new AbortController()
      controller.signal.addEventListener('abort', () => {
        if (!pendingToolExecutions.delete(requestId)) return
        pendingRef?.reject(new Error('mcp-background-task-stopped'))
        send({ type: 'tool_execute_cancel', requestId } satisfies OutboundToolExecCancel)
      }, { once: true })
      const settled = resultPromise.then(
        result => {
          send({
            type: 'event',
            event: {
              type: 'task_notification',
              taskId,
              text: formatMcpTaskNotificationText(taskId, def.name, {
                failed: result.isError === true,
                body: result.content,
              }),
            },
          })
        },
        error => {
          send({
            type: 'event',
            event: {
              type: 'task_notification',
              taskId,
              text: formatMcpTaskNotificationText(taskId, def.name, {
                failed: true,
                body: error instanceof Error ? error.message : String(error),
              }),
            },
          })
        },
      )
      backgroundTasks.register({ taskId, controller, settled })
      send({
        type: 'event',
        event: { type: 'task_backgrounded', toolUseId: toolCallId, taskId, kind: 'mcp' },
      })
      return {
        content: [{
          type: 'text',
          text: `MCP tool call ${def.name} was still running after ${detachDelayMs}ms and moved to a background task.\n`
            + `task_id: ${taskId}\n`
            + 'The result will arrive as a task notification when the call settles. '
            + 'Per-call wall-clock and idle limits still apply; stop it with stopTask.',
        }],
        details: { taskId, backgrounded: true },
      }
    },
  });
  });
}

// ============================================================
// LLM Query (ephemeral session for call_llm + mini completions)
// ============================================================

async function queryLlm(
  request: LLMQueryRequest,
  config = initConfig, lifecycle?: EphemeralQueryContext,
): Promise<LLMQueryResult> {
  if (!config) throw new Error('Cannot run queryLlm: init not received');

  debugLog('[queryLlm] Starting');

  // Pick mini model. If the configured miniModel uses a different provider than
  // what the user authenticated with (e.g. gemini-2.5-pro when only anthropic
  // credentials exist), fall back to the default summarization model which uses
  // the same provider family.
  let model = request.model ?? config.miniModel ?? getDefaultSummarizationModel();

  // Create authenticated registry upfront — used by both the provider guard and the ephemeral session.
  const { credentials, modelRuntime, modelRegistry } = await createAuthenticatedRegistry(config);

  const piAuthProvider = config.piAuth?.provider;

  // If piAuth is set, ensure the mini model uses the same provider.
  // Pi SDK will fail with "No API key found" if the model requires a different provider.
  // Exception: 'custom-endpoint' provider is always compatible because it has its own
  // API key configured via resolveCustomEndpointApiKey() and doesn't use authStorage.
  // UB4.9 — on a CUSTOM-ENDPOINT connection (the Nessy Gateway Pi card, every BYO
  // endpoint, keyless local ones too) ONLY the endpoint's own models qualify; the
  // reason is `isUtilityModelRouteAllowed`'s docblock (mini-model-query.ts).
  const preferCustomEndpoint = shouldPreferCustomEndpoint(config);
  if (config.piAuth || preferCustomEndpoint) {
    const authProvider = config.piAuth?.provider;
    const bareModel = model.startsWith('pi/') ? model.slice(3) : model;
    const resolved = resolvePiModel(modelRegistry, bareModel, authProvider, preferCustomEndpoint);
    const resolvedProvider = (resolved as any)?.provider;
    const isCompatible = isUtilityModelRouteAllowed(resolvedProvider, authProvider, preferCustomEndpoint);
    if (!resolved || !isCompatible || isDeniedMiniModelId(model, piAuthProvider)) {
      // Anthropic: keep Haiku (the cheap/fast mini). For every other provider
      // Haiku is unresolvable, so walk PI_PREFERRED_DEFAULTS for a model that
      // actually works under the user's auth. A custom endpoint walks its OWN
      // models (UB4.9): both of those are public-API ids there.
      const providerDefault = preferCustomEndpoint
        ? pickCustomEndpointUtilityModel([config.miniModel, config.model], modelRegistry, authProvider)
        : authProvider === 'anthropic' || !authProvider
          ? undefined
          : pickProviderAppropriateMiniModel(authProvider, modelRegistry, preferCustomEndpoint);
      const fallback = providerDefault ?? (preferCustomEndpoint ? model : getDefaultSummarizationModel());
      debugLog(`[queryLlm] Model ${bareModel} incompatible with ${authProvider} (resolved: ${resolvedProvider}), falling back to ${fallback}`);
      model = fallback;
    }
  }

  const runQueryWithModel = async (modelId: string): Promise<string> => {
    debugLog(`[queryLlm] Using model: ${modelId}`);

    // Resolve model — fail fast if unresolvable so we don't let the Pi SDK
    // fall back to its own internal default (which may require a provider
    // the user hasn't authenticated with, surfacing as a misleading
    // "No API key found for <provider>" error).
    const piModel = resolvePiModel(modelRegistry, modelId, config.piAuth?.provider, shouldPreferCustomEndpoint(config));
    if (!piModel) {
      throw new Error(
        `Could not resolve mini model "${modelId}" for provider "${config.piAuth?.provider ?? '(unknown)'}"`,
      );
    }
    // UB4.9 — the route rule again where EVERY utility model passes: no path sends
    // a custom endpoint's credential and prompt to a provider's public API.
    if (!isUtilityModelRouteAllowed(piModel.provider, config.piAuth?.provider, preferCustomEndpoint)) {
      throw new Error(`Mini model "${modelId}" resolves to provider "${piModel.provider}", not to this connection's endpoint; refusing to route the request there`);
    }

    // Create minimal ephemeral session
    const ephemeralOptions: CreatePiRuntimeSessionOptions['sessionOptions'] = {
      tools: [],
      model: piModel,
    };

    const promptForSession =
      request.systemPrompt ?? 'Reply with ONLY the requested text. No explanation.';
    let ephemeralRuntime: PiRuntimeSessionHandle;
    ephemeralRuntime = await runtimeAdapter.createSession({
      cwd: resolvedCwd(config),
      agentDir: config.sessionPath
        ? join(config.sessionPath, '.pi-agent')
        : undefined,
      registry: { credentials, modelRuntime, modelRegistry },
      strategy: { kind: 'memory' }, providerRetry: providerRetrySettingsFor('utility'), // UB2.15 — pi-ai's provider block; its 10 s cap binds only at creation (gateway-retry-settings.ts)
      systemPrompt: promptForSession,
      sessionOptions: ephemeralOptions, cacheWarming: cacheWarmingForSession('ephemeral'), // UB7.16 — one-shot: no warm request to pay for (pi-session-settings.ts)
    });
    // F1.306 — the request's cancel target from creation to disposal, as upstream (craft-agents-oss 0.13.4):
    // a cancel or the deadline aborts AND disposes it wherever it is. F1.239 registered it around prompt()
    // only, with a no-op dispose, so a cancel that landed after an early prompt() return left it neither
    // aborted nor disposed until the old post-prompt wait gave up (120 s).
    const resource: EphemeralQueryResource = { abort: () => ephemeralRuntime.session.abort(), dispose: () => ephemeralRuntime.dispose() };
    lifecycle?.setResource(resource);
    // Title/summary mini-completions share the gateway's per-user limiter, but run
    // under F1.239's one 115 s deadline: F1.307 gives them the ladder that fits it.
    applyRetryPolicy(ephemeralRuntime.session, gatewayRuntimeActive(), process.env, undefined, 'utility');
    let unsubscribe: (() => void) | undefined;
    try {
      const ephemeralSession = ephemeralRuntime.session;
      // Pi SDK ignores options.model for ephemeral sessions (same issue as options.tools).
      // Explicitly set the model after creation to ensure the mini model is used.
      //
      // I2.29 · session-only, and on THIS site the reason is not merely
      // symmetry: persisting here would make the title/summary mini model the
      // value the user's next session opens with. See
      // `model-mutation-persistence.ts` for the whole verdict.
      try {
        await ephemeralSession.setModel(piModel, SESSION_ONLY_MODEL_MUTATION);
      } catch {
        debugLog(`[queryLlm] Failed to set model on ephemeral session, proceeding with default`);
      }

      debugLog(`[queryLlm] Created ephemeral session: ${ephemeralSession.sessionId}`);

      // Collect response text and errors from events
      let result = '';
      let lastError = '';

      unsubscribe = ephemeralSession.subscribe((event: AgentSessionEvent) => {
        if (event.type === 'message_end') {
          // Only capture assistant messages — Pi SDK emits message_end for user messages too
          const msg = event.message as {
            role?: string;
            content?: string | Array<{ type: string; text?: string }>;
            stopReason?: string;
            errorMessage?: string;
          };
          if (msg.role !== 'assistant') return;

          // Capture API errors from message_end (e.g. auth failures, model errors)
          if (msg.stopReason === 'error' && msg.errorMessage) {
            lastError = msg.errorMessage;
            debugLog(`[queryLlm] API error in message_end: ${msg.errorMessage}`);
          }

          if (typeof msg.content === 'string') {
            result = msg.content;
          } else if (Array.isArray(msg.content)) {
            result = msg.content
              .filter((c) => c.type === 'text' && c.text)
              .map((c) => c.text!)
              .join('');
          }
        }
      });

      // F1.306 — no post-prompt wait. `prompt()` settles only after the SDK's retries and continuations, and
      // after every listener has seen `agent_end` (pi-agent-core awaits its listeners), so the event this used
      // to wait for has already arrived. A prompt that returned WITHOUT one (an input handler or an extension
      // command took it) answers what it has now instead of waiting 120 s for an event that never comes.
      await promptEphemeralSession(ephemeralSession, request.prompt, lifecycle); // F1.239 — under the request deadline
      debugLog(`[queryLlm] Result length: ${result.trim().length}`);

      // If we got no text but captured an error, throw so callers see the real issue
      if (!result.trim() && lastError) {
        throw new Error(lastError);
      }

      return result.trim();
    } finally {
      unsubscribe?.();
      // F1.306 — unregistered first, so a late cancel finds nothing rather than a disposed session.
      lifecycle?.clearResource(resource);
      await ephemeralRuntime.dispose();
    }
  };

  // UB4.9 — the retry loop is upstream's `queryMiniModel` (mini-model-query.ts):
  // retried only on `isModelRejectionError`, candidates widened by the session's
  // model and the provider's defaults, each held to the route rule above. Gateway
  // ids arrive host-resolved (`getMiniModel`, by alias; re-resolved on every
  // `update_runtime_config`, UB12.11); nothing here pins one.
  return queryMiniModel({
    model,
    miniModel: config.miniModel,
    sessionModel: config.model,
    authProvider: config.piAuth?.provider,
    modelRegistry,
    preferCustomEndpoint,
    onFallback: (rejectedModel, retryModel) => {
      debugLog(`[queryLlm] Model ${rejectedModel} unavailable, retrying with ${retryModel}`);
    },
  }, runQueryWithModel);
}

async function runMiniCompletion(
  prompt: string,
  config = initConfig,
): Promise<string | null> {
  try {
    const result = await runEphemeralLlmQuery(nextLocalEphemeralQueryId('summary'), { prompt }, config);
    const text = result.text || null;
    debugLog(`[runMiniCompletion] Result: ${text ? `"${text.slice(0, 200)}"` : 'null'}`);
    return text;
  } catch (error) {
    debugLog(`[runMiniCompletion] Failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

// ============================================================
// Event Handling
// ============================================================

function extractToolExecutionMetadata(args: Record<string, unknown> | undefined): ToolExecutionMetadata | undefined {
  if (!args) return undefined;

  const intent = typeof args._intent === 'string' ? args._intent : undefined;
  const displayName = typeof args._displayName === 'string' ? args._displayName : undefined;

  if (!intent && !displayName) return undefined;

  return {
    intent,
    displayName,
    source: 'interceptor',
  };
}

/**
 * P6.443 — the verdict read off the current turn's provider error, waiting for
 * the `agent_end` that will carry it. Module-level rather than per-session
 * because it is spent by the very next turn boundary; see `handleSessionEvent`.
 */
let pendingProviderTerminalReason: AgentTerminalReason | undefined;

function handleSessionEvent(event: AgentSessionEvent): void {
  let forwardedEvent: OutboundAgentEvent = piSession
    ? applyAutoCompactionThrashingGuard(piSession, event)
    : event;

  // P6.443 — a turn ended by the provider's own `finish_reason` gets a verdict
  // instead of ending silently. Armed on the assistant message that carries
  // Pi's finish-reason error and spent on the `agent_end` that closes the same
  // turn, the shape the thrashing guard above already uses. `agent_end` is the
  // turn boundary, so the flag cannot outlive one turn even if nothing spends
  // it; an enrichment by another authority (the thrashing guard, the
  // structured-output loop) is left alone rather than overwritten, because that
  // one knows something more specific than "the provider stopped us".
  if (forwardedEvent.type === 'agent_end') {
    const pending = pendingProviderTerminalReason;
    pendingProviderTerminalReason = undefined;
    if (pending && mayStampProviderVerdict(forwardedEvent as { terminalReason?: unknown; willRetry?: unknown })) {
      forwardedEvent = { ...forwardedEvent, terminalReason: pending } as OutboundAgentEvent;
    }
  }

  // Log API errors for debugging and attach provider-native turn anchor for branch cutoffs.
  if (event.type === 'message_end') {
    const msg = event.message as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
    if (msg?.stopReason === 'error') {
      debugLog(`API error in message_end: ${msg.errorMessage || 'unknown'}`);
      const verdict = terminalReasonFromPiErrorMessage(msg.errorMessage);
      if (verdict) {
        pendingProviderTerminalReason = verdict;
        debugLog(`[terminal_reason] Provider finish reason maps to ${verdict}`);
      }
    }

    if (msg?.role === 'assistant' && piSession) {
      // CRITICAL: do NOT read `getLeafId()` here.
      //
      // The Pi SDK fires `message_end` synchronously BEFORE calling
      // `appendMessage(event.message)` (see `agent-session.js:_processAgentEvent`).
      // At this moment the assistant entry does not yet exist in the
      // SessionManager — `leafId` still points at the *previous* leaf, which for
      // a plain text turn is the user message that triggered the response.
      // Recording that wrong anchor and using it for `branch()` makes the next
      // turn a sibling of the assistant message, dropping the assistant reply
      // from the LLM's view of history.
      //
      // Instead, attach the SDK's message id to the forwarded event so the main
      // process can correlate this turn, then queue a microtask to read the
      // correct leaf AFTER `appendMessage` has run. The microtask drains before
      // any subsequent SDK event is dispatched, so the follow-up
      // `pi_turn_anchor` event is delivered to the main process in the right
      // order (after this `message_end`, before the next event).
      const sdkMessageId = (msg as { id?: string }).id;
      if (sdkMessageId) {
        forwardedEvent = {
          ...(event as Record<string, unknown>),
          sdkMessageId,
        } as unknown as OutboundAgentEvent;

        const sessionManagerSnapshot = piSession.sessionManager;
        queueMicrotask(() => {
          // Defensive: session may have been disposed between the message_end
          // emit and the microtask drain.
          if (!piSession || piSession.sessionManager !== sessionManagerSnapshot) {
            return;
          }
          const sdkTurnAnchor = sessionManagerSnapshot.getLeafId();
          if (!sdkTurnAnchor) return;
          send({
            type: 'event',
            event: {
              type: 'pi_turn_anchor',
              sdkMessageId,
              sdkTurnAnchor,
            } as unknown as OutboundAgentEvent,
          });
        });
      }

    }
  }

  // Detect session MCP tool completions + enrich tool starts with canonical metadata
  if (event.type === 'tool_execution_start') {
    const toolName = event.toolName;
    if (toolName.startsWith('session__') || toolName.startsWith('mcp__session__')) {
      const mcpToolName = toolName.replace(/^(mcp__session__|session__)/, '');
      pendingSessionToolCalls.set(event.toolCallId, {
        toolName: mcpToolName,
        arguments: (event.args ?? {}) as Record<string, unknown>,
      });
    }

    const toolMetadata = extractToolExecutionMetadata((event.args ?? {}) as Record<string, unknown>);
    if (toolMetadata) {
      forwardedEvent = {
        ...event,
        toolMetadata,
      };
    }
  }

  if (event.type === 'tool_execution_end') {
    const pending = pendingSessionToolCalls.get(event.toolCallId);
    if (pending) {
      pendingSessionToolCalls.delete(event.toolCallId);
      send({
        type: 'session_tool_completed',
        toolName: pending.toolName,
        args: pending.arguments,
        isError: !!event.isError,
      });
    }
  }

  // Turn completion carries the context snapshot (with the category breakdown)
  // on the SAME event stream the host consumes. Emitted BEFORE agent_end is
  // forwarded: agent_end completes the host's per-turn event queue, so a
  // snapshot sent after it would be dropped. Without this, the snapshot only
  // flowed on the compact/update_runtime_config/set_model RPCs and a live
  // session's /context overlay stayed at "Current context 0" forever.
  if (event.type === 'agent_end' && piSession) {
    try {
      send({
        type: 'event',
        event: {
          type: 'context_usage_update',
          usage: buildContextUsageSnapshot(piSession, lastCompaction, currentContextCategoryInputs(piSession), customEndpointFallbackWindowIds),
        },
      });
    } catch (error) {
      debugLog(`Turn-completion context usage snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // R18: hold agent_end while the structured-output validate-and-reprompt loop
  // is active — the loop forwards the final one (enriched) itself. A terminal
  // agent_end enriched by another authority (e.g. the thrashing guard) still
  // flows, and the loop stands down.
  if (structuredOutputTurn && forwardedEvent.type === 'agent_end') {
    const terminal = (forwardedEvent as { terminalReason?: unknown }).terminalReason;
    if (!terminal) {
      structuredOutputTurn.lastAgentEnd = forwardedEvent as unknown as Record<string, unknown>;
      return;
    }
    structuredOutputTurn.sawTerminalAgentEnd = true;
  }

  // Forward all events to main process
  send({ type: 'event', event: forwardedEvent });
}

// ============================================================
// Command Handlers
// ============================================================

async function handleInit(msg: Extract<InboundMessage, { type: 'init' }>): Promise<void> {
  await quiesceWorkingDirectoryControlsForReinit();
  try {
    clearPendingPreToolUse('Server re-initialized');
    ephemeralQueries.cancelAll(new EphemeralQueryCancelledError('Pi server reinitialized')); // F1.303 — see `ephemeralQueries`
    // R24: elicitation dialog ids belong to the host agent being replaced.
    // The gate is a module singleton that outlives session re-init, and a new
    // host agent restarts its dialog-id sequence — so a stale open id from the
    // previous agent would defer auto-background detaches forever and could
    // collide with a fresh id. A re-inited session starts with no dialog open.
    elicitationDialogGate.reset();

    // Clean up any existing session from a previous init
    if (piSession) {
      await activeSpawnerDeactivation?.();
      if (unsubscribeEvents) {
        unsubscribeEvents();
        unsubscribeEvents = null;
      }
      runtimeHandle?.dispose();
      runtimeHandle = null;
      piSession = null;
      moduleCredentials = null; // Reset so createAuthenticatedRegistry() creates a fresh store
      debugLog('Cleaned up existing session for re-init');
    }

    workingDirectoryGeneration = 0;
    activeSystemPrompt = undefined;
    activeSpawnerActivation = null;
    activeSpawnerDeactivation = null;
    activeConfigUpdate = null;
    activeWorkflowCommandTool = null;
    activeContextAccounting = null;
    activeWorkflowCommandController?.abort();
    activeWorkflowCommandController = null;
    activeModelHint = undefined;
    activeExecutionManifest = null;
    autoCompactionPolicy = Object.freeze({ enabled: true });

    if (msg.contextProfile !== undefined && msg.contextProfile !== 'normal' && msg.contextProfile !== 'bare') {
      throw new Error('Invalid Pi context profile');
    }
    const preparedConfig = {
      ...await applyNestorReasoningProxy(msg),
      contextProfile: msg.contextProfile ?? 'bare',
      // Per-entry ingress revalidation (A1): an entry the host let through
      // that fails here is dropped fail-closed and logged, never turn-fatal.
      piRuntimeAgentDefinitions: parsePiRuntimeAgentDefinitions(msg.piRuntimeAgentDefinitions, {
        onInvalid: failure => debugLog(
          `Agent definition dropped at ingress: ${failure.key ?? `piRuntimeAgentDefinitions[${failure.index}]`} — ${failure.reason}`,
        ),
      }),
    };
    if (!msg.executionManifest || !msg.workspaceId) {
      throw new Error('Current Pi execution manifest V2 is required');
    }
    const expectedOrchestrator = normalizePiOrchestratorConfig(msg.orchestrator);
    validatePiExecutionManifest(msg.executionManifest, {
      generation: msg.executionManifest.snapshotGeneration,
      manifestHash: msg.executionManifest.manifestHash,
      sessionKey: { workspaceId: msg.workspaceId, sessionId: msg.sessionId },
      orchestrator: expectedOrchestrator,
    });
    activeExecutionManifest = sealPiExecutionManifest(msg.executionManifest);
    initConfig = { ...preparedConfig, orchestrator: msg.executionManifest.orchestrator };
    // R48: adopt the host's tree count. Forward-only — this process's own
    // count is authoritative for what IT consumed, so a stale host value on a
    // same-process re-init must never regress the counter.
    if (typeof msg.webSearchesUsed === 'number' && Number.isFinite(msg.webSearchesUsed)) {
      webSearchBudget.seed(Math.max(webSearchBudget.used(), Math.floor(msg.webSearchesUsed)));
    }
    deferredMcpLoadedToolNames.clear();
    deferredMcpActivationLeases.clear();
    for (const lease of (msg.continuationActivatedTools ?? []).slice(0, 64)) {
      if (lease?.schemaVersion !== 1
        || typeof lease.semanticId !== 'string'
        || typeof lease.capabilityGeneration !== 'string' // F1.835: an older generation is kept; the surface build carries it only on an unchanged entry digest (F1.803) and revokes the rest
        || !/^[a-f0-9]{64}$/.test(lease.digest)) continue;
      deferredMcpLoadedToolNames.add(lease.semanticId);
      deferredMcpActivationLeases.set(lease.semanticId, Object.freeze({ ...lease }));
    }

    // Azure OpenAI requires a tenant-specific endpoint URL.
    // The Pi SDK (via Vercel AI SDK) reads AZURE_OPENAI_BASE_URL from env.
    // UB3.12: the same helper now serves update_runtime_config, so an edited
    // endpoint takes effect without a respawn.
    const initEndpointEnv = providerEndpointEnv(msg.piAuth?.provider, msg.baseUrl);
    if (initEndpointEnv.AZURE_OPENAI_BASE_URL) {
      process.env.AZURE_OPENAI_BASE_URL = initEndpointEnv.AZURE_OPENAI_BASE_URL;
      debugLog(`Set AZURE_OPENAI_BASE_URL=${initEndpointEnv.AZURE_OPENAI_BASE_URL}`);
    }
  } finally {
    rejectWorkingDirectoryControls(new Error('Cwd control rejected during re-init'));
    workingDirectoryControlQuiescingOwner = null;
    workingDirectoryControlBarrierActive = false;
  }

  send({
    type: 'ready',
    sessionId: null,
    runtimeVersion: SUPPORTED_PI_RUNTIME_VERSION,
  });
}

function deepFreezeConfig<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreezeConfig(child);
  }
  return Object.freeze(value);
}

function createWorkingDirectoryGenerationConfig(
  current: Extract<InboundMessage, { type: 'init' }>,
  cwd: string,
  projectTrusted: boolean,
): Extract<InboundMessage, { type: 'init' }> {
  const config = structuredClone({
    ...current,
    cwd,
    workingDirectory: cwd,
    projectTrusted,
    branchFromSdkSessionId: undefined,
    branchFromSessionPath: undefined,
    branchFromSdkTurnId: undefined,
  }) as Extract<InboundMessage, { type: 'init' }>;
  let auth = config.piAuth ? deepFreezeConfig(config.piAuth) : undefined;
  Object.defineProperty(config, 'piAuth', {
    enumerable: true,
    configurable: false,
    get: () => auth,
    set: (next: InitMessage['piAuth']) => {
      auth = next ? deepFreezeConfig(structuredClone(next)) : undefined;
    },
  });
  return deepFreezeConfig(config);
}

function disposeRuntimeHandleNoThrow(handle: PiRuntimeSessionHandle, context: string): void {
  try {
    handle.dispose();
  } catch (error) {
    debugLog(`${context}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function discardWorkingDirectoryTransaction(context: string, keepBarrier = false): Promise<void> {
  const transaction = workingDirectoryTransaction;
  if (transaction) {
    await transaction.candidate.deactivateSpawner();
    if (transaction.activeRuntime === 'previous') {
      if (transaction.candidate.handle) {
        disposeRuntimeHandleNoThrow(transaction.candidate.handle, `Discarding cwd candidate during ${context}`);
      }
    } else {
      disposeRuntimeHandleNoThrow(transaction.previous.handle, `Discarding previous cwd runtime during ${context}`);
    }
  }
  workingDirectoryTransaction = null;
  if (!keepBarrier) {
    workingDirectoryControlQuiescingOwner = null;
    workingDirectoryControlBarrierActive = false;
  }
  rejectWorkingDirectoryControls(new Error(`Cwd transaction discarded during ${context}`));
}

async function quiesceWorkingDirectoryControlsForReinit(): Promise<void> {
  workingDirectoryControlBarrierActive = true;
  const owner = workingDirectoryTransaction ?? inFlightWorkingDirectoryControl?.owner ?? null;
  workingDirectoryControlQuiescingOwner = owner;
  rejectWorkingDirectoryControls(new Error('Cwd control rejected during re-init'));
  const inFlight = inFlightWorkingDirectoryControl;
  if (inFlight && (!owner || inFlight.owner === owner)) {
    await inFlight.promise.catch(() => undefined);
  }
  rejectWorkingDirectoryControls(new Error('Cwd control rejected during re-init'));
  await discardWorkingDirectoryTransaction('re-init', true);
}

function requireBuiltWorkingDirectoryCandidate(transaction: ChildWorkingDirectoryTransaction): {
  handle: PiRuntimeSessionHandle;
  session: AgentSession;
  subscribe: () => (() => void);
} {
  const { handle, session, subscribe } = transaction.candidate;
  if (!handle || !session || !subscribe) {
    throw new Error('Cwd transaction candidate is not ready');
  }
  return { handle, session, subscribe };
}

function assertWorkingDirectoryTransaction(
  msg: WorkingDirectoryTransactionMessage,
  expectedState: ChildWorkingDirectoryTransaction['state'],
): ChildWorkingDirectoryTransaction {
  const transaction = workingDirectoryTransaction;
  if (!transaction
    || transaction.id !== msg.id
    || transaction.expectedGeneration !== msg.expectedGeneration
    || transaction.generation !== msg.generation
    || transaction.state !== expectedState) {
    throw new Error(`Cwd ${msg.phase} is stale, replayed, or out of order`);
  }
  return transaction;
}

function reserveWorkingDirectoryTerminalPhase(
  transaction: ChildWorkingDirectoryTransaction,
  phase: 'rollback' | 'finalize',
): void {
  if (transaction.terminalPhase) {
    throw new Error(`Cwd ${phase} is stale, replayed, or out of order`);
  }
  transaction.terminalPhase = phase;
}

function releaseWorkingDirectoryTerminalPhase(
  transaction: ChildWorkingDirectoryTransaction,
  phase: 'rollback' | 'finalize',
): void {
  if (workingDirectoryTransaction === transaction && transaction.terminalPhase === phase) {
    transaction.terminalPhase = undefined;
  }
}

async function handleWorkingDirectoryTransaction(
  msg: WorkingDirectoryTransactionMessage,
): Promise<void> {
  try {
    if (msg.phase === 'prepare') {
      // Pi 0.84 · `createAuthenticatedRegistry` became async (`ModelRuntime.create`
      // and every credential write are), and the window from these guards to the
      // barrier reservation must NOT yield — see the comment at that
      // reservation. The guards are pure reads of module state, so they run
      // BOTH sides of the await: once up front, so a prepare that is going to be
      // rejected never builds a candidate registry, and again immediately
      // before the reservation, with nothing between. Two concurrent prepares
      // therefore both suspend on the await, whichever resumes first runs
      // guards→barrier without yielding, and the other fails closed on the
      // second guard run exactly as it did when there was no await at all.
      const assertPrepareAdmissible = (): void => {
        if (workingDirectoryControlBarrierActive && !workingDirectoryTransaction) {
          throw new Error('Cwd prepare rejected while control state is quiescing');
        }
        if (workingDirectoryTransaction) {
          throw new Error('A working-directory transaction is already active');
        }
        if (msg.expectedGeneration !== workingDirectoryGeneration
          || msg.generation !== workingDirectoryGeneration + 1) {
          throw new Error('Cwd prepare generation mismatch');
        }
        if (!initConfig || !piSession || !runtimeHandle || !moduleCredentials || !piModelRegistry
          || !activeExecutionManifest) {
          throw new Error('Cwd prepare requires an active Pi runtime');
        }
      };

      assertPrepareAdmissible();
      const preparingConfig = initConfig!;
      const preparingCwd = resolvedCwd({ ...preparingConfig, cwd: msg.cwd, workingDirectory: msg.cwd });
      const preparingCandidateConfig = createWorkingDirectoryGenerationConfig(
        preparingConfig,
        preparingCwd,
        msg.projectTrusted === true,
      );
      const preparedRegistry = await createAuthenticatedRegistry(preparingCandidateConfig, { publish: false });

      assertPrepareAdmissible();
      // A re-init that landed while the candidate registry was being built must
      // never be adopted silently: the candidate was derived from the config
      // that was active before the await.
      if (initConfig !== preparingConfig) {
        throw new Error('Cwd prepare was invalidated by a concurrent re-init');
      }

      // Bound here rather than read inline: `assertPrepareAdmissible` threw on
      // any of these being null a line above, but the compiler cannot see
      // through the closure, and re-reading the module fields later would also
      // re-open the window it just closed.
      const previousConfig = initConfig;
      const previousHandle = runtimeHandle!;
      const previousSession = piSession!;
      const previousCredentials = moduleCredentials!;
      const previousModelRegistry = piModelRegistry!;
      const executionManifest = activeExecutionManifest!;
      const cwd = preparingCwd;
      const candidateConfig = preparingCandidateConfig;
      const candidateRegistry = preparedRegistry;
      const definition = buildSessionDefinition(
        candidateConfig,
        cwd,
        candidateRegistry,
        false,
      );
      const candidateLifecycleGate = createPiLifecycleSinkGate(
        (event, input) => { send({ type: 'automation_event', event, input }) },
      );
      if (!candidateConfig.sessionPath) {
        throw new Error('Cwd prepare requires a persisted Nessy session path');
      }
      const activeSessionFile = previousHandle.sessionFile;
      if (!activeSessionFile) {
        throw new Error('Cwd prepare requires the active persisted Pi session file');
      }
      const agentDir = join(candidateConfig.sessionPath, '.pi-agent');
      mkdirSync(agentDir, { recursive: true });
      const transaction: ChildWorkingDirectoryTransaction = {
        id: msg.id,
        expectedGeneration: msg.expectedGeneration,
        generation: msg.generation,
        state: 'preparing',
        activeRuntime: 'previous',
        previous: {
          config: previousConfig,
          handle: previousHandle,
          session: previousSession,
          unsubscribe: unsubscribeEvents,
          credentials: previousCredentials,
          modelRegistry: previousModelRegistry,
          customState: {
            modelIds: customEndpointModelIds,
            modelOverrides: customModelOverrides,
            fallbackWindowModelIds: customEndpointFallbackWindowIds,
          },
          activateSpawner: activeSpawnerActivation ?? (() => {}),
          deactivateSpawner: activeSpawnerDeactivation ?? (async () => {}),
          updateConfig: activeConfigUpdate ?? (() => {}),
          modelHint: activeModelHint,
          workflowCommandTool: activeWorkflowCommandTool,
          contextAccounting: activeContextAccounting,
          toolsChanged,
        },
        candidate: {
          config: candidateConfig,
          handle: null,
          session: null,
          subscribe: null,
          credentials: candidateRegistry.credentials,
          modelRegistry: candidateRegistry.modelRegistry,
          customState: candidateRegistry.customState,
          activateSpawner: definition.activateSpawner,
          deactivateSpawner: definition.deactivateSpawner,
          updateConfig: definition.updateConfig,
          modelHint: definition.modelHint,
          workflowCommandTool: definition.workflowCommandTool,
          contextAccounting: definition.contextAccounting,
          lifecycleGate: candidateLifecycleGate,
        },
      };
      // Reserve the generation synchronously before session construction yields.
      // Concurrent JSONL messages must see the in-flight candidate so duplicate
      // phases fail closed and ordered controls remain behind one barrier.
      workingDirectoryControlBarrierActive = true;
      workingDirectoryTransaction = transaction;
      let candidateHandle: PiRuntimeSessionHandle | null = null;
      try {
        candidateHandle = await runtimeAdapter.createSession({
          cwd,
          agentDir,
          registry: candidateRegistry,
          strategy: { kind: 'reopen', sessionFile: activeSessionFile },
          systemPrompt: activeSystemPrompt,
          executionManifest,
          toolExecutor: definition.toolExecutor,
          responseEpoch: definition.responseEpoch,
          compaction: runtimeCompactionSettings(definition.sessionOptions.model),
          deferredMcpExtension: definition.deferredMcpExtension,
          autoCompactionExtension: definition.autoCompactionExtension,
          contextResources: candidateConfig.piContextResources,
          lifecycleEventSink: candidateLifecycleGate.emit,
          transformToolResult: requestPostToolUseTransform,
          requestCompactionDecision: requestPreCompactDecision,
          getOriginalUserPrompt: () => currentUserMessage,
          sessionOptions: definition.sessionOptions,
        });
        if (workingDirectoryTransaction !== transaction || transaction.state !== 'preparing') {
          throw new Error('Cwd prepare was cancelled during session construction');
        }
        // Same reason as the main construction site: `compaction` has a
        // createSession option, `retry` does not.
        applyRetryPolicy(candidateHandle.session, gatewayRuntimeActive());
        definition.attachSession(candidateHandle.session);
        transaction.candidate.handle = candidateHandle;
        transaction.candidate.session = candidateHandle.session;
        const builtHandle = candidateHandle;
        transaction.candidate.subscribe = () => builtHandle.session.subscribe(handleSessionEvent);
        transaction.state = 'prepared';
      } catch (error) {
        await definition.deactivateSpawner();
        if (candidateHandle) {
          disposeRuntimeHandleNoThrow(candidateHandle, 'Discarding failed cwd candidate');
        }
        if (workingDirectoryTransaction === transaction
          && workingDirectoryControlQuiescingOwner !== transaction) {
          await drainWorkingDirectoryControls(transaction);
          if (workingDirectoryTransaction === transaction
            && workingDirectoryControlQuiescingOwner !== transaction) {
            workingDirectoryTransaction = null;
            workingDirectoryControlBarrierActive = false;
          }
        }
        throw error;
      }
    } else if (msg.phase === 'commit') {
      const transaction = assertWorkingDirectoryTransaction(msg, 'prepared');
      const candidate = requireBuiltWorkingDirectoryCandidate(transaction);
      let candidateUnsubscribe: (() => void) | null = null;
      let previousUnsubscribed = false;
      try {
        if (transaction.previous.unsubscribe) {
          candidateUnsubscribe = candidate.subscribe();
        }
        // Candidate activation may publish its local deferred-tool dirty bit.
        // Clear the previous generation first so a successful activation is not
        // erased, while the catch below still restores the exact old value.
        toolsChanged = false;
        await transaction.previous.deactivateSpawner();
        transaction.candidate.activateSpawner();
        if (transaction.previous.unsubscribe) {
          previousUnsubscribed = true;
          transaction.previous.unsubscribe();
        }
        initConfig = transaction.candidate.config;
        runtimeHandle = candidate.handle;
        piSession = candidate.session;
        unsubscribeEvents = candidateUnsubscribe;
        moduleCredentials = transaction.candidate.credentials;
        piModelRegistry = transaction.candidate.modelRegistry;
        customEndpointModelIds = transaction.candidate.customState.modelIds;
        customModelOverrides = transaction.candidate.customState.modelOverrides;
        activeSpawnerActivation = transaction.candidate.activateSpawner;
        activeSpawnerDeactivation = transaction.candidate.deactivateSpawner;
        activeConfigUpdate = transaction.candidate.updateConfig;
        activeModelHint = transaction.candidate.modelHint;
        activeWorkflowCommandTool = transaction.candidate.workflowCommandTool;
        activeContextAccounting = transaction.candidate.contextAccounting;
        setInterceptorApiHints(transaction.candidate.modelHint);
        transaction.activeRuntime = 'candidate';
        transaction.state = 'committed';
      } catch (error) {
        const restoreErrors: unknown[] = [];
        try {
          await transaction.candidate.deactivateSpawner();
        } catch (restoreError) {
          restoreErrors.push(restoreError);
        }
        try {
          candidateUnsubscribe?.();
        } catch (restoreError) {
          restoreErrors.push(restoreError);
        }
        try {
          transaction.previous.activateSpawner();
        } catch (restoreError) {
          restoreErrors.push(restoreError);
        }
        initConfig = transaction.previous.config;
        runtimeHandle = transaction.previous.handle;
        piSession = transaction.previous.session;
        moduleCredentials = transaction.previous.credentials;
        piModelRegistry = transaction.previous.modelRegistry;
        customEndpointModelIds = transaction.previous.customState.modelIds;
        customModelOverrides = transaction.previous.customState.modelOverrides;
        activeSpawnerActivation = transaction.previous.activateSpawner;
        activeSpawnerDeactivation = transaction.previous.deactivateSpawner;
        activeConfigUpdate = transaction.previous.updateConfig;
        activeModelHint = transaction.previous.modelHint;
        activeWorkflowCommandTool = transaction.previous.workflowCommandTool;
        activeContextAccounting = transaction.previous.contextAccounting;
        toolsChanged = transaction.previous.toolsChanged;
        try {
          setInterceptorApiHints(transaction.previous.modelHint);
        } catch (restoreError) {
          restoreErrors.push(restoreError);
        }
        if (previousUnsubscribed && transaction.previous.unsubscribe) {
          try {
            unsubscribeEvents = transaction.previous.session.subscribe(handleSessionEvent);
          } catch (restoreError) {
            unsubscribeEvents = null;
            restoreErrors.push(restoreError);
          }
        } else {
          unsubscribeEvents = transaction.previous.unsubscribe;
        }
        transaction.state = 'prepared';
        if (restoreErrors.length > 0) {
          throw new AggregateError(
            [error, ...restoreErrors],
            'Cwd commit failed and active runtime restoration was incomplete',
          );
        }
        throw error;
      }
    } else if (msg.phase === 'rollback') {
      const transaction = workingDirectoryTransaction;
      if (!transaction
        || transaction.id !== msg.id
        || transaction.expectedGeneration !== msg.expectedGeneration
        || transaction.generation !== msg.generation) {
        throw new Error('Cwd rollback is stale or replayed');
      }
      if (transaction.state !== 'prepared' && transaction.state !== 'committed') {
        throw new Error('Cwd rollback is stale or replayed');
      }
      reserveWorkingDirectoryTerminalPhase(transaction, 'rollback');
      try {
        const candidate = requireBuiltWorkingDirectoryCandidate(transaction);
        if (transaction.state === 'committed') {
          unsubscribeEvents?.();
          await transaction.candidate.deactivateSpawner();
          transaction.previous.activateSpawner();
          initConfig = transaction.previous.config;
          runtimeHandle = transaction.previous.handle;
          piSession = transaction.previous.session;
          unsubscribeEvents = transaction.previous.unsubscribe
            ? transaction.previous.session.subscribe(handleSessionEvent)
            : null;
          moduleCredentials = transaction.previous.credentials;
          piModelRegistry = transaction.previous.modelRegistry;
          customEndpointModelIds = transaction.previous.customState.modelIds;
          customModelOverrides = transaction.previous.customState.modelOverrides;
          activeSpawnerActivation = transaction.previous.activateSpawner;
          activeSpawnerDeactivation = transaction.previous.deactivateSpawner;
          activeConfigUpdate = transaction.previous.updateConfig;
          activeModelHint = transaction.previous.modelHint;
          activeWorkflowCommandTool = transaction.previous.workflowCommandTool;
          activeContextAccounting = transaction.previous.contextAccounting;
          toolsChanged = transaction.previous.toolsChanged;
          setInterceptorApiHints(transaction.previous.modelHint);
          transaction.activeRuntime = 'previous';
        }
        await drainWorkingDirectoryControls(transaction);
        if (workingDirectoryControlQuiescingOwner === transaction) {
          throw new Error('Cwd rollback interrupted by re-init');
        }
        if (workingDirectoryTransaction !== transaction) {
          throw new Error('Cwd rollback transaction was replaced during control drain');
        }
        await transaction.candidate.deactivateSpawner();
        candidate.handle.dispose();
        workingDirectoryTransaction = null;
        workingDirectoryControlBarrierActive = false;
      } catch (error) {
        releaseWorkingDirectoryTerminalPhase(transaction, 'rollback');
        throw error;
      }
    } else {
      const transaction = assertWorkingDirectoryTransaction(msg, 'committed');
      reserveWorkingDirectoryTerminalPhase(transaction, 'finalize');
      try {
        await drainWorkingDirectoryControls(transaction);
        if (workingDirectoryControlQuiescingOwner === transaction) {
          throw new Error('Cwd finalize interrupted by re-init');
        }
        if (workingDirectoryTransaction !== transaction) {
          throw new Error('Cwd finalize transaction was replaced during control drain');
        }
        transaction.previous.handle.dispose();
        workingDirectoryGeneration = transaction.generation;
        transaction.candidate.lifecycleGate.open();
        workingDirectoryTransaction = null;
        workingDirectoryControlBarrierActive = false;
      } catch (error) {
        releaseWorkingDirectoryTerminalPhase(transaction, 'finalize');
        throw error;
      }
    }

    send({
      type: 'working_directory_transaction_result',
      id: msg.id,
      phase: msg.phase,
      generation: msg.generation,
      success: true,
    });
  } catch (error) {
    send({
      type: 'working_directory_transaction_result',
      id: msg.id,
      phase: msg.phase,
      generation: msg.generation,
      success: false,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handlePrompt(msg: Extract<InboundMessage, { type: 'prompt' }>): Promise<void> {
  let queuedInstructions:
    | { session: AgentSession; pending: PendingAutoCompactionInstructions }
    | undefined;
  try {
    if (!activeExecutionManifest) throw new Error('Pi execution manifest is not registered'); await turnTransitions.waitForAbort() // F1.1288 — a prompt that arrives while a Stop is still aborting joins it: `session.prompt` on a session the abort has not yet made idle is the Stop-then-immediate-send race (the abort's waitForIdle can take the new turn with it while the host believes the send was accepted). One direction only — nothing here holds an abort.
    assertPiExecutionManifestIdentity(activeExecutionManifest, {
      generation: msg.manifestGeneration ?? '',
      manifestHash: msg.manifestHash ?? '',
    });
    // R18 draft-07 gate: the caller's schema is validated BEFORE the turn
    // starts — a bad schema fails here with the named error and never spawns
    // a model call (the catch below reports it and unblocks the host).
    let compiledOutputSchema: CompiledStructuredOutputSchema | null = null;
    let outputSchemaBlock = '';
    if (msg.outputSchema !== undefined) {
      compiledOutputSchema = compileStructuredOutputSchema(msg.outputSchema);
      // R18: the model must SEE the schema it is judged against. The compile
      // gate above proved the schema valid, so render it into the turn text
      // (prompt injection — the safe channel for the fragile-tool-shape
      // gateway; see structured-output-prompt.ts).
      outputSchemaBlock = await renderStructuredOutputSchemaBlock(msg.outputSchema);
    }
    currentUserMessage = msg.message;
    activeSystemPrompt = msg.systemPrompt || activeSystemPrompt;
    // If proxy tools changed since last session creation, dispose and recreate.
    // This avoids calling _buildRuntime() for dynamic tool updates — instead
    // we create a fresh session via continueRecent() with all tools known upfront.
    if (toolsChanged && piSession) {
      debugLog('Recreating session due to tool changes');
      await activeSpawnerDeactivation?.();
      if (unsubscribeEvents) {
        unsubscribeEvents();
        unsubscribeEvents = null;
      }
      runtimeHandle?.dispose();
      runtimeHandle = null;
      piSession = null;
      activeSpawnerActivation = null;
      activeSpawnerDeactivation = null;
      activeConfigUpdate = null;
      activeWorkflowCommandTool = null;
      activeContextAccounting = null;
    }

    const session = await ensureSession();

    // Apply the Nessy-built prompt through the adapter's public
    // before_agent_start lifecycle so it survives Pi prompt rebuilds.
    if (msg.systemPrompt && runtimeHandle) {
      applySystemPromptOverride(runtimeHandle, withDeferredToolSummary(msg.systemPrompt));
    }

    // Wire up event handler
    if (unsubscribeEvents) {
      unsubscribeEvents();
    }
    unsubscribeEvents = session.subscribe(handleSessionEvent);

    const activePromptRun = activePromptRuns.get(session);
    if (activePromptRun && (promptRunsAfterAgentEnd.has(session) || !session.isStreaming)) {
      await activePromptRun;
    }

    // Wait for any in-flight auto-compaction to avoid race (UB2.3: budgeted — a stuck
    // compaction gives up the wait at the host-deadline budget instead of polling forever).
    const promptCompactionWait = await waitForCompaction(session, { timeoutMs: PROMPT_COMPACT_WAIT_MS, log: debugLog });
    if (promptCompactionWait.timedOut) debugLog('Proceeding with prompt while the compaction flag is still set');

    // P6.54 · a project's standing `Compact Instructions` section reaches the
    // AUTO path here, at the one place a turn's compaction instructions are
    // pinned. The bodies come from `initConfig.piContextResources` — the same
    // instruction files the host already composed and delivered — so nothing is
    // re-read off disk and the `@path`/HTML-comment/index rules keep their one
    // owner. An absent `autoCompactionInstructions` stays absent: see
    // `withProjectCompactSteering`.
    const pendingInstructions = {
      instructions: withProjectCompactSteering(
        msg.autoCompactionInstructions,
        initConfig?.piContextResources,
      ),
    };
    const instructionQueue = pendingAutoCompactionInstructions.get(session) ?? [];
    instructionQueue.push(pendingInstructions);
    pendingAutoCompactionInstructions.set(session, instructionQueue);
    queuedInstructions = { session, pending: pendingInstructions };
    // Fire prompt — use followUp when session is already streaming so the
    // message is queued instead of throwing "Agent is already processing".
    const startsPromptRun = !session.isStreaming;
    // Fresh prompts run Pi's compaction preflight before `message_start`, so
    // restore the configured policy here. Streamed follow-ups reset only when
    // their eventual user `message_start` proves actual delivery.
    if (startsPromptRun) resetAutoCompactionThrashingGuard(session);
    // Arm the structured-output turn BEFORE the prompt fires: agent_end events
    // dispatch synchronously during the run and must be held from the first.
    if (compiledOutputSchema) {
      structuredOutputTurn = {
        lastAgentEnd: null,
        aborted: false,
        sawTerminalAgentEnd: false,
        schemaBlock: outputSchemaBlock,
      };
    }
    try {
      const promptRun = session.prompt(withSchemaBlock(msg.message, outputSchemaBlock), {
        images: msg.images && msg.images.length > 0 ? msg.images : undefined,
        streamingBehavior: 'followUp',
      });
      if (startsPromptRun) {
        promptRunsAfterAgentEnd.delete(session);
        activePromptRuns.set(session, promptRun);
      }
      try {
        await promptRun;
      } finally {
        if (activePromptRuns.get(session) === promptRun) activePromptRuns.delete(session);
      }
      if (compiledOutputSchema) {
        await runTurnStructuredOutputValidation(session, compiledOutputSchema);
      }
    } finally {
      structuredOutputTurn = null;
    }
  } catch (error) {
    if (queuedInstructions) {
      const instructionQueue = pendingAutoCompactionInstructions.get(queuedInstructions.session);
      const pendingIndex = instructionQueue?.indexOf(queuedInstructions.pending) ?? -1;
      if (pendingIndex !== -1) instructionQueue?.splice(pendingIndex, 1);
      if (instructionQueue?.length === 0) {
        pendingAutoCompactionInstructions.delete(queuedInstructions.session);
      }
    }
    const errorMsg = error instanceof Error ? error.message : String(error);
    clearPendingPreToolUse(`Prompt failed: ${errorMsg}`);

    // No wrapper-side overflow recovery here. The Pi SDK's _checkCompaction
    // already runs `_runAutoCompaction("overflow", true)` on overflow and
    // calls agent.continue() to retry once. Running our own session.compact()
    // in parallel raced against the SDK and is the documented cause of the
    // AbortController crash in `_runAutoCompaction` (see
    // plans/fix-pi-gpt-compaction.md). PiEventAdapter holds the Nessy event
    // queue open across the SDK's recovery flow so the recovered turn
    // reaches the UI.

    debugLog(`Prompt failed: ${errorMsg}`);
    send({ type: 'error', message: errorMsg, code: 'prompt_error' });
    // Send synthetic agent_end so the main process event queue unblocks.
    // willRetry: false — this is the terminal error path, no retry follows.
    send({ type: 'event', event: { type: 'agent_end', messages: [], willRetry: false } });
  }
}

function lastAssistantMessage(session: AgentSession): AssistantMessage | null {
  const messages = (session as AgentSession & { messages?: readonly unknown[] }).messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: string } | undefined;
    if (message?.role === 'assistant') return message as AssistantMessage;
  }
  return null;
}

function assistantMessageText(message: AssistantMessage): string {
  if (typeof (message as { content?: unknown }).content === 'string') {
    return (message as unknown as { content: string }).content;
  }
  return (message.content ?? [])
    .filter((block): block is { type: 'text'; text: string } =>
      (block as { type?: string }).type === 'text' && typeof (block as { text?: unknown }).text === 'string')
    .map(block => block.text)
    .join('');
}

/**
 * R18: the turn-level validate-and-reprompt loop. Runs AFTER the prompt run
 * settles, while `structuredOutputTurn` still holds agent_end forwarding.
 * Ends the turn with exactly one forwarded agent_end carrying the documented
 * result identifiers:
 * - valid output      -> structuredOutputSubtype 'success' + structuredOutput
 * - retry exhaustion  -> subtype 'error_max_structured_output_retries' +
 *                        terminalReason 'structured_output_retry_exhausted' +
 *                        the validation errors
 * - broken attempt    -> the same error subtype + terminal reason with the
 *                        NON-validation cause in errors (the model-fallback
 *                        retraction analog; told apart via the errors list)
 * - no output at all  -> subtype 'success' with NO structuredOutput and an
 *                        errors entry (the documented success-without-output
 *                        failure case)
 * - user abort        -> the held agent_end is forwarded unenriched (today's
 *                        abort shape)
 */
async function runTurnStructuredOutputValidation(
  session: AgentSession,
  compiled: CompiledStructuredOutputSchema,
): Promise<void> {
  const state = structuredOutputTurn;
  if (!state) return;
  const maxAttempts = resolveMaxStructuredOutputRetries();

  let subtype: 'success' | 'error_max_structured_output_retries' = 'success';
  let structuredOutput: unknown;
  let errors: string[] = [];
  let exhausted = false;

  const forwardHeldUnenriched = (): void => {
    if (!state.lastAgentEnd) return;
    send({ type: 'event', event: state.lastAgentEnd as unknown as OutboundAgentEvent });
  };

  for (let attempt = 1; ; attempt += 1) {
    // Another authority (e.g. the thrashing guard) already ended the turn with
    // a terminal agent_end that was forwarded — nothing left to report.
    if (state.sawTerminalAgentEnd) return;
    const message = lastAssistantMessage(session);
    if (state.aborted || message?.stopReason === 'aborted') {
      forwardHeldUnenriched();
      return;
    }
    if (!message || message.stopReason === 'error') {
      subtype = 'error_max_structured_output_retries';
      const cause = message?.errorMessage ? `: ${message.errorMessage}` : '';
      errors = [`structured output attempt ${attempt} ended without a validatable result${cause}`];
      exhausted = true;
      break;
    }
    const text = assistantMessageText(message).trim();
    if (!text) {
      errors = ['run completed without a structured output'];
      break;
    }
    const validated = validateStructuredOutputText(compiled, text);
    if (validated.ok) {
      structuredOutput = validated.value;
      break;
    }
    if (attempt >= maxAttempts) {
      subtype = 'error_max_structured_output_retries';
      errors = validated.errors;
      exhausted = true;
      break;
    }
    // Re-prompt with the validation errors on the SAME session — the held
    // agent_end keeps the host's turn open, so this is one user-visible turn.
    await waitForCompaction(session, { timeoutMs: PROMPT_COMPACT_WAIT_MS, log: debugLog });
    if (state.aborted) {
      forwardHeldUnenriched();
      return;
    }
    try {
      // R18: the reprompt carries the schema itself, not only the ajv errors —
      // "Return only valid JSON matching the schema" is unanswerable for a
      // schema the model has never been shown.
      await session.prompt(withSchemaBlock(buildSchemaRetryNote(validated.errors), state.schemaBlock));
    } catch (error) {
      subtype = 'error_max_structured_output_retries';
      errors = [`structured output retry failed: ${error instanceof Error ? error.message : String(error)}`];
      exhausted = true;
      break;
    }
  }

  const base = state.lastAgentEnd ?? { type: 'agent_end', messages: [] };
  send({
    type: 'event',
    event: {
      ...base,
      structuredOutputSubtype: subtype,
      ...(structuredOutput !== undefined ? { structuredOutput } : {}),
      ...(errors.length > 0 ? { structuredOutputErrors: errors } : {}),
      ...(exhausted ? { terminalReason: 'structured_output_retry_exhausted' } : {}),
    } as unknown as OutboundAgentEvent,
  });
}

function handleRegisterTools(msg: Extract<InboundMessage, { type: 'register_tools' }>): void {
  try {
    if (!initConfig || !activeExecutionManifest) {
      throw new Error('Pi execution manifest registration requires initialized identity');
    }
    const prepared = preparePiManifestRegistration({
      current: {
        generation: activeExecutionManifest.snapshotGeneration,
        manifestHash: activeExecutionManifest.manifestHash,
      },
      previous: msg.previous,
      manifest: msg.manifest,
      definitions: msg.tools,
      sessionKey: {
        workspaceId: initConfig.workspaceId ?? '',
        sessionId: initConfig.sessionId,
      },
      orchestrator: normalizePiOrchestratorConfig(initConfig.orchestrator),
    });
    const priorHash = activeExecutionManifest.manifestHash;
    proxyToolDefs = prepared.definitions;
    activeExecutionManifest = prepared.manifest; setWholeToolDenyRefusals(msg.wholeToolDenyRefusals); // F1.1100 — the model reads a deny-removed tool's rule, see whole-tool-deny-context.ts
    // Adopt the descriptors the host re-materialized for THIS generation.
    //
    // Without this, session recreation below rebuilds agents from the
    // INIT-time descriptors while the manifest has moved on, and every one of
    // them is stale — which used to be session-fatal and is now a silent
    // drop, i.e. the user's agents quietly disappearing mid-session. The host
    // sends freshly materialized descriptors (never re-stamped copies, or the
    // definition digest and the generation would disagree), so adopting them
    // here is what keeps the agents alive across the bump.
    if (msg.piRuntimeAgentDefinitions) {
      initConfig = {
        ...initConfig,
        // Through the SAME per-entry ingress revalidation the init path applies
        // (A1), because this is the same trust boundary reached a second time.
        // Adopting the wire payload raw would have made `register_tools` a way
        // to put descriptors into `initConfig` that `init` would have refused —
        // a validation bypass, not a shortcut.
        piRuntimeAgentDefinitions: parsePiRuntimeAgentDefinitions(msg.piRuntimeAgentDefinitions, {
          onInvalid: failure => debugLog(
            `Agent definition dropped at re-registration ingress: `
            + `${failure.key ?? `piRuntimeAgentDefinitions[${failure.index}]`} — ${failure.reason}`,
          ),
        }),
      };
    }
    if (msg.capabilityCatalogKinds) {
      publishActiveConfig({ ...initConfig, capabilityCatalogKinds: { ...msg.capabilityCatalogKinds } });
    }
    const knownToolNames = new Set([...proxyToolDefs.map(tool => tool.name), ...prepared.manifest.tools.map(tool => tool.binding.piName)]); // F1.803: built-ins and session tools too
    for (const loadedName of Array.from(deferredMcpLoadedToolNames)) {
      if (!knownToolNames.has(loadedName)) {
        deferredMcpLoadedToolNames.delete(loadedName);
        deferredMcpActivationLeases.delete(loadedName);
      }
    }
    // The GENERATION is in this line on purpose: it is the value every
    // staleness check compares against, and its absence is why a dead session
    // had to be diagnosed from source rather than read off the log.
    debugLog(
      `Registered ${msg.tools.length} proxy tools (total: ${proxyToolDefs.length}) `
      + `at generation ${prepared.manifest.snapshotGeneration} `
      + `(was ${msg.previous.generation}), `
      + `agent definitions ${msg.piRuntimeAgentDefinitions ? `refreshed: ${msg.piRuntimeAgentDefinitions.length}` : 'not resent'}`
      + `: ${msg.tools.map(t => t.name).join(', ')}`,
    );

    // If session exists, mark for recreation on next prompt.
    // Don't dispose mid-generation — the flag is checked in handlePrompt().
    if (piSession && priorHash !== prepared.manifest.manifestHash) {
      toolsChanged = true;
      debugLog('Proxy tools changed — session will be recreated on next prompt');
    }
    send({
      type: 'register_tools_result',
      id: msg.id,
      ok: true,
      generation: prepared.manifest.snapshotGeneration,
      manifestHash: prepared.manifest.manifestHash,
    });
  } catch (error) {
    send({
      type: 'register_tools_result',
      id: msg.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function handleToolExecuteResponse(msg: Extract<InboundMessage, { type: 'tool_execute_response' }>): void {
  const pending = pendingToolExecutions.get(msg.requestId);
  if (pending) {
    pendingToolExecutions.delete(msg.requestId);
    pending.removeAbort?.()
    pending.resolve(msg.result);
  } else {
    debugLog(`No pending tool execution for requestId: ${msg.requestId}`);
  }
}

function handleProcessStartResponse(msg: Extract<InboundMessage, { type: 'process_start_response' }>): void {
  const pending = pendingProcessStarts.get(msg.requestId)
  if (!pending) return
  pendingProcessStarts.delete(msg.requestId)
  if (msg.result) pending.resolve(msg.result)
  else pending.reject(new Error(msg.error ?? 'supervised-process-failed'))
}

function handleChildSessionResponse(msg: Extract<InboundMessage, { type: 'child_session_response' }>): void {
  const pending = pendingChildSessionRequests.get(msg.requestId)
  if (!pending) return
  pendingChildSessionRequests.delete(msg.requestId)
  if (msg.error) pending.reject(new Error(msg.error))
  else {
    // R48: every PiChildResult-shaped response (start/resume/get_result/
    // monitor) may carry the child's WebSearch consumption; fold it into this
    // session's budget so a research fan-out spends ONE tree-wide cap
    // (tools-reference.md:449). The fold is cumulative-max per child, so
    // re-reading a settled result never double-charges.
    const result = msg.result
    if (result && typeof result === 'object' && 'agentId' in result
      && typeof (result as PiChildResult).webSearchesConsumed === 'number') {
      foldChildWebSearchConsumption((result as PiChildResult).agentId, (result as PiChildResult).webSearchesConsumed!)
    }
    pending.resolve(result)
  }
}

function requestChildSession(request: PiChildSessionRequest): Promise<PiChildSessionResponse> {
  const requestId = `child-${Date.now()}-${Math.random().toString(36).slice(2)}`
  return new Promise((resolve, reject) => {
    pendingChildSessionRequests.set(requestId, { resolve, reject })
    send({ type: 'child_session_request', requestId, request })
  })
}

const childSessionPort: PiChildSessionPort = {
  // R48: stamp the spawn-time tree count onto every child start so the child's
  // budget begins where this session's stands (tools-reference.md:449 — one
  // cap "across the main conversation and every subagent it spawns").
  start: input => requestChildSession({
    operation: 'start',
    input: { ...input, webSearchesUsed: webSearchBudget.used() },
  }) as ReturnType<PiChildSessionPort['start']>,
  resume: (agentId, input) => requestChildSession({ operation: 'resume', agentId, input }) as ReturnType<PiChildSessionPort['resume']>,
  steer: (agentId, message) => requestChildSession({ operation: 'steer', agentId, message }) as ReturnType<PiChildSessionPort['steer']>,
  getResult: (agentId, options) => requestChildSession({ operation: 'get_result', agentId, ...options }) as ReturnType<PiChildSessionPort['getResult']>,
  stop: agentId => requestChildSession({ operation: 'stop', agentId }) as ReturnType<PiChildSessionPort['stop']>,
  stopTask: taskId => requestChildSession({ operation: 'stop_task', taskId }) as ReturnType<PiChildSessionPort['stopTask']>,
  sealOwnerTask: ownerTaskId => requestChildSession({ operation: 'seal_owner_task', ownerTaskId }) as ReturnType<PiChildSessionPort['sealOwnerTask']>,
  searchOutput: (agentId, query) => requestChildSession({ operation: 'search_output', agentId, query }) as ReturnType<PiChildSessionPort['searchOutput']>,
  attach: (agentId, cursor) => requestChildSession({ operation: 'attach', agentId, cursor }) as ReturnType<PiChildSessionPort['attach']>,
  monitor: agentId => requestChildSession({ operation: 'monitor', agentId }) as ReturnType<PiChildSessionPort['monitor']>,
}

function requestSupervisedProcess(
  input: {
    executionId: string
    semanticId: string
    command: string
    cwd: string
    profile: ProcessIsolationProfile
    background: boolean
    timeoutMs: number
    onTimeout?: 'kill' | 'background'
  },
  signal?: AbortSignal,
): Promise<SupervisedProcessResult> {
  if (!initConfig) return Promise.reject(new Error('supervised-process-before-init'))
  const requestId = `process-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const shell = process.platform === 'win32'
    ? { command: 'cmd.exe', args: ['/d', '/s', '/c', input.command] }
    : { command: '/bin/sh', args: ['-lc', input.command] }
  return new Promise((resolve, reject) => {
    const abort = () => send({ type: 'process_cancel_request', requestId })
    if (signal?.aborted) {
      reject(new Error('supervised-process-aborted-before-start'))
      return
    }
    signal?.addEventListener('abort', abort, { once: true })
    pendingProcessStarts.set(requestId, {
      resolve: result => { signal?.removeEventListener('abort', abort); resolve(result) },
      reject: error => { signal?.removeEventListener('abort', abort); reject(error) },
    })
    send({
      type: 'process_start_request', requestId,
      request: { ...input, ...shell },
    })
  })
}

function handlePreToolUseResponse(msg: Extract<InboundMessage, { type: 'pre_tool_use_response' }>): void {
  const pending = pendingPreToolUse.get(msg.requestId);
  if (pending) {
    pendingPreToolUse.delete(msg.requestId);
    pending.resolve({ receipt: msg.receipt, reason: msg.reason });
  } else {
    debugLog(`No pending pre_tool_use for requestId: ${msg.requestId}`);
  }
}

function handlePostToolUseResponse(msg: Extract<InboundMessage, { type: 'post_tool_use_response' }>): void {
  const pending = pendingPostToolUse.get(msg.requestId);
  if (!pending) {
    debugLog(`No pending post_tool_use for requestId: ${msg.requestId}`);
    return;
  }
  pendingPostToolUse.delete(msg.requestId);
  pending.resolve(msg.updatedToolOutput === undefined
    ? undefined
    : { updatedToolOutput: msg.updatedToolOutput });
}

function handlePreCompactResponse(msg: Extract<InboundMessage, { type: 'pre_compact_response' }>): void {
  const pending = pendingPreCompact.get(msg.requestId);
  if (!pending) {
    debugLog(`No pending pre_compact for requestId: ${msg.requestId}`);
    return;
  }
  pendingPreCompact.delete(msg.requestId);
  pending.resolve(msg.block ? { block: true, ...(msg.reason ? { reason: msg.reason } : {}) } : undefined);
}

function handleAskUserResponse(msg: Extract<InboundMessage, { type: 'ask_user_response' }>): void {
  const pending = pendingAskUser.get(msg.requestId);
  if (!pending) {
    debugLog(`No pending ask_user for requestId: ${msg.requestId}`);
    return;
  }

  pendingAskUser.delete(msg.requestId);
  if (msg.error) {
    pending.reject(new Error(msg.error));
    return;
  }
  if (!msg.answer) {
    pending.reject(new Error('ask_user response did not include an answer.'));
    return;
  }
  pending.resolve(msg.answer);
}

async function handleWorkflowExecute(
  msg: Extract<InboundMessage, { type: 'workflow_execute' }>,
): Promise<void> {
  try {
    if (!activeExecutionManifest) throw new Error('Pi execution manifest is not registered');
    assertPiExecutionManifestIdentity(activeExecutionManifest, {
      generation: msg.manifestGeneration,
      manifestHash: msg.manifestHash,
    });
    await ensureSession();
    if (!activeWorkflowCommandTool) {
      throw new Error('Workflow command tool is not available');
    }
    if (activeWorkflowCommandController) {
      throw new Error('A workflow command is already running');
    }

    currentUserMessage = msg.message;
    const controller = new AbortController();
    activeWorkflowCommandController = controller;
    try {
      // This is the SAME adapted production definition the Pi SDK receives:
      // descriptor lookup, canonicalization, permission bridge, scheduler and
      // the workflow handler all remain in the execution path.
      const output = await activeWorkflowCommandTool.execute(
        `slash-${msg.id}`,
        msg.invocation,
        controller.signal,
        undefined,
        undefined as never,
      );
      const content = output.content
        .filter(item => item.type === 'text')
        .map(item => item.text)
        .join('\n');
      send({
        type: 'workflow_execute_result',
        id: msg.id,
        ok: true,
        content,
        details: output.details,
      });
    } finally {
      if (activeWorkflowCommandController === controller) {
        activeWorkflowCommandController = null;
      }
    }
  } catch (error) {
    send({
      type: 'workflow_execute_result',
      id: msg.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * `sub-agents.md:1013` — the user's own `/subtask`. It runs through
 * `startSubtaskFork`, which calls the shared spawner directly rather than the
 * `subagent` tool, because the tool refuses `agent: "fork"` outside fork mode
 * and `:1013` starts a user fork "with or without the variable set".
 *
 * `ensureSession()` is deliberately NOT called: a fork branches the parent's
 * persisted conversation host-side, and creating this subprocess's own Pi
 * session first would neither help nor be inherited. The spawner is configured
 * as part of the capability generation, so a `/subtask` before the first turn
 * fails with the spawner's own error instead of forking from nothing.
 *
 * Not routing through the tool is about the tool's fork-mode REFUSAL, and
 * nothing else. The background-task registration is passed in here explicitly so
 * the fork lands in the same registry, and therefore in the same child registry
 * the agents panel reads.
 */
async function handleSubtaskStart(
  msg: Extract<InboundMessage, { type: 'subtask_start' }>,
): Promise<void> {
  try {
    const started = await startSubtaskFork({
      task: msg.task,
      cwd: process.cwd(),
      requestId: msg.id,
      // The registration half. Without it the host refuses the fork outright
      // (`pi-background-child-task-id-required`), so the panel never sees one.
      emitEvent: event => send({ type: 'event', event }),
      ...(activeBackgroundTasks ? { backgroundTasks: activeBackgroundTasks } : {}),
      childSessionPort,
    });
    send({ type: 'subtask_start_result', id: msg.id, ok: true, agentId: started.agentId, name: started.name });
  } catch (error) {
    send({
      type: 'subtask_start_result',
      id: msg.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * `skills.md:569` — a `context: fork` skill's dispatch.
 *
 * Routed here rather than started host-side for the reasons `skill-fork.ts`
 * records: the background half only exists inside this process
 * (`BackgroundTaskRegistry`), and a fork that skipped it would be unreachable by
 * `stop_task` and invisible in the agents panel.
 *
 * `ensureSession()` is deliberately NOT called, for the same reason `/subtask`
 * skips it: the child is its own session and this subprocess's Pi session would
 * neither help it nor be inherited by it.
 */
async function handleSkillForkStart(
  msg: Extract<InboundMessage, { type: 'skill_fork_start' }>,
): Promise<void> {
  try {
    const started = await startSkillFork({
      skillName: msg.skillName,
      ...(msg.agent ? { agent: msg.agent } : {}),
      ...(msg.model ? { model: msg.model } : {}),
      prompt: msg.prompt,
      background: msg.background,
      cwd: process.cwd(),
      requestId: msg.id,
      getRuntimeAgentDefinitions: () => activeRuntimeAgentDefinitions,
      // The registration half — without it the host refuses a background child
      // outright (`pi-background-child-task-id-required`).
      emitEvent: event => send({ type: 'event', event }),
      ...(activeBackgroundTasks ? { backgroundTasks: activeBackgroundTasks } : {}),
      childSessionPort,
    });
    send({
      type: 'skill_fork_start_result',
      id: msg.id,
      ok: true,
      agent: started.agent,
      background: started.background,
      ...(started.agentId === undefined ? {} : { agentId: started.agentId }),
      ...(started.taskId === undefined ? {} : { taskId: started.taskId }),
      ...(started.status === undefined ? {} : { status: started.status }),
      ...(started.result === undefined ? {} : { result: started.result }),
      ...(started.error === undefined ? {} : { error: started.error }),
    });
  } catch (error) {
    send({
      type: 'skill_fork_start_result',
      id: msg.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * F1.352 — bumped by every Stop, so a manual `/compact` still waiting behind an
 * auto-compaction when the Stop lands never starts (`handleCompact` re-reads it
 * after its awaits). Adopted from craft-agents-oss v0.13.4's `compactionEpoch`
 * (`packages/pi-agent-server/src/index.ts`, Apache-2.0).
 */
let compactionEpoch = 0;

async function handleAbort(): Promise<void> {
  // F1.1288 — the body runs under the turn-transition gate: a SECOND Stop
  // arriving while this one aborts joins it instead of racing it through
  // `abortCompaction`/`abort()` (idempotent per F1.591, but concurrent calls
  // were never the intent), and `handlePrompt`'s join above can see an abort
  // in flight at all. The gate is one-directional — this body never waits for
  // a prompt handler — so Stop stays immediate.
  await turnTransitions.runAbort(async () => {
    compactionEpoch++;
    // R18: a user abort must stop the structured-output reprompt loop — it may
    // be BETWEEN attempts when this arrives, where session.abort() is a no-op.
    if (structuredOutputTurn) structuredOutputTurn.aborted = true;
    activeWorkflowCommandController?.abort();
    if (piSession) {
      // F1.352 — at pi-coding-agent 0.84.4 `AgentSession.abort()` was `abortRetry()`
      // + `agent.abort()` + `waitForIdle()` and never touched a compaction, so a
      // running manual `/compact` committed after Stop. The SDK's own cancel aborts its
      // controller and `compact()` throws `Compaction cancelled` BEFORE it appends; it
      // covers an in-flight AUTO-compaction too. F1.591: since 0.85 `abort()` calls it
      // itself and then WAITS for the compaction to end — kept explicit (idempotent),
      // and the lifecycle bridge's PreCompact wait yields to the same signal — else the
      // `await` below would wait on the host's hook, the drain after it running too late.
      try {
        piSession.abortCompaction();
      } catch (error) {
        debugLog(`abortCompaction failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        await piSession.abort();
      } catch (error) {
        debugLog(`Abort failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    clearPendingPreToolUse('Aborted');

    for (const [, pending] of pendingAskUser) {
      pending.reject(new Error('ask_user was aborted.'));
    }
    pendingAskUser.clear();
  })
}

// ============================================================
// Ephemeral query lifecycle (F1.239)
// ============================================================
//
// Every ephemeral `queryLlm` — the host's `mini_completion` / `llm_query` RPCs,
// Pi's own `call_llm` pre-execution and the summarize callback — runs under
// `ephemeralQueries`, which owns ONE deadline per request (inside the host's RPC
// timeout) and cancels exactly the matching ephemeral session on a host
// `cancel_ephemeral_query`. The main chat session is never registered: cancelling
// a utility query must not touch the user's turn. Adopted from craft-agents-oss
// 0.13.4 (`ephemeral-query-lifecycle.ts`, Apache-2.0); see that file's header.
//
// F1.303 — and, as upstream, a re-init and a shutdown cancel EVERY in-flight
// utility query (`cancelAll` in `handleInit` and `handleShutdown`): a re-init
// replaces the credentials they were created under, and a shutdown must not
// leave their sessions to the process exit. Each cancelled request still
// answers its host through its own handler (a mini completion `null`, an llm
// query its targeted cancelled result), the same path a host cancel takes.
const ephemeralQueries = new EphemeralQueryCoordinator();
let localEphemeralQuerySeq = 0;

/** An id for a query no host request names (Pi's own `call_llm`, the summarize callback). */
function nextLocalEphemeralQueryId(prefix: string): string {
  localEphemeralQuerySeq += 1;
  return `local-${prefix}-${localEphemeralQuerySeq}`;
}

function runEphemeralLlmQuery(id: string, request: LLMQueryRequest, config = initConfig): Promise<LLMQueryResult> {
  return ephemeralQueries.run(id, EPHEMERAL_QUERY_DEADLINE_MS, lifecycle => queryLlm(request, config, lifecycle));
}

/**
 * `prompt()` resolves only after the SDK's own retries settle, so this is the
 * call the request deadline has to cover. F1.306: the session is the request's
 * resource from creation to disposal (`queryLlm` registers it with a real
 * dispose), so a cancel aborts and disposes it wherever it is — here, before
 * `prompt()`, or after it returned; this only refuses to answer for a request
 * that was cancelled while the prompt ran.
 */
async function promptEphemeralSession(
  session: { prompt(text: string): Promise<unknown> },
  prompt: string,
  lifecycle?: EphemeralQueryContext,
): Promise<void> {
  lifecycle?.throwIfCancelled();
  await session.prompt(prompt);
  lifecycle?.throwIfCancelled();
}

function handleCancelEphemeralQuery(msg: Extract<InboundMessage, { type: 'cancel_ephemeral_query' }>): void {
  const cancelled = ephemeralQueries.cancel(
    msg.id,
    new EphemeralQueryCancelledError(`Ephemeral query cancelled by host: ${msg.id}`),
  );
  debugLog(`${cancelled ? 'Cancelled' : 'No active'} ephemeral query: ${msg.id}`);
}

async function handleMiniCompletion(msg: Extract<InboundMessage, { type: 'mini_completion' }>): Promise<void> {
  // Call queryLlm directly (not runMiniCompletion) so auth errors propagate
  // as 'error' messages instead of being swallowed and returned as null.
  // runMiniCompletion is kept for the summarize callback where null is acceptable.
  try {
    const result = await runEphemeralLlmQuery(msg.id, { prompt: msg.prompt });
    send({ type: 'mini_completion_result', id: msg.id, text: result.text || null });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    debugLog(`[handleMiniCompletion] Error: ${errorMsg}`);
    if (isEphemeralQueryCancellation(error)) {
      // F1.239 — a cancelled or timed-out title is best-effort: the host's own null-on-timeout contract.
      send({ type: 'mini_completion_result', id: msg.id, text: null });
    } else {
      // F1.239 — the id routes the failure to THIS request on the host, never to its siblings.
      send({ type: 'error', id: msg.id, message: errorMsg, code: 'mini_completion_error' });
    }
  }
}

// INVARIANT: the full LLMQueryRequest shape must pass through this RPC unchanged.
// Adding a field to LLMQueryRequest? Nothing to do here — we pass `msg.request`
// to queryLlm() verbatim. But verify queryLlm() actually honors the new field;
// request-propagation + request-honoring are independent (see #596).
async function handleLlmQuery(msg: Extract<InboundMessage, { type: 'llm_query' }>): Promise<void> {
  try {
    const result = await runEphemeralLlmQuery(msg.id, msg.request);
    send({ type: 'llm_query_result', id: msg.id, result });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    debugLog(`[handleLlmQuery] Error: ${errorMsg}`);
    // Dual-emit: the generic `error` channel drives main-process OAuth
    // auth-refresh detection (centralized in PiAgent), while the targeted
    // `llm_query_result` rejects the pending promise for this specific call.
    // F1.239 — the generic half carries the id too, so the host settles only this
    // request; a cancellation (host cancel or the deadline) is not an auth signal
    // and gets the targeted result alone.
    if (!isEphemeralQueryCancellation(error)) send({ type: 'error', id: msg.id, message: errorMsg, code: 'llm_query_error' });
    send({ type: 'llm_query_result', id: msg.id, result: null, errorMessage: errorMsg, errorCode: 'llm_query_error' });
  }
}

async function handleEnsureSessionReady(msg: Extract<InboundMessage, { type: 'ensure_session_ready' }>): Promise<void> {
  const session = await ensureSession();
  send({
    type: 'ensure_session_ready_result',
    id: msg.id,
    sessionId: session.sessionId || null,
  });
}

async function handleGetContextUsage(msg: Extract<InboundMessage, { type: 'get_context_usage' }>): Promise<void> {
  try {
    const session = await ensureSession();
    send({
      type: 'context_usage_result',
      id: msg.id,
      success: true,
      usage: buildContextUsageSnapshot(session, lastCompaction, currentContextCategoryInputs(session), customEndpointFallbackWindowIds),
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    debugLog(`[context_usage] Failed: ${errorMsg}`);
    send({
      type: 'context_usage_result',
      id: msg.id,
      success: false,
      errorMessage: errorMsg,
    });
  }
}

/**
 * L9 — STOP ONE DETACHED RUN THE PUBLISHED GENERATION IS HOLDING.
 *
 * The same call the model's own `stopTask` tool makes first, reached from the
 * host instead of from the model. `activeBackgroundTasks` and not a captured
 * registry: a generation swap replaces the instance, and a stop must reach the
 * registry the RUNNING work is registered in — the same reason `/subtask` reads
 * it from here.
 *
 * Deliberately NO `ensureSession()`. A stop must work on a session too wedged to
 * answer anything else, and a registry that does not exist holds no task, so
 * spinning up a session to discover that would be the opposite of what the caller
 * asked for. No registry → `stopped: false`, which is the host's cue to try the
 * durable child-session port.
 *
 * The registry itself is idempotent and de-duplicating (`stopped` set, `stopping`
 * map), so a second press while the first is in flight joins the first operation
 * instead of starting a second one.
 */
async function handleStopBackgroundTask(
  msg: Extract<InboundMessage, { type: 'stop_background_task' }>,
): Promise<void> {
  const registry = activeBackgroundTasks;
  if (!registry) {
    debugLog(`[stop_background_task] No published registry for ${msg.taskId}`);
    send({ type: 'stop_background_task_result', id: msg.id, stopped: false });
    return;
  }
  try {
    const stopped = await registry.stop(msg.taskId);
    debugLog(`[stop_background_task] ${msg.taskId} -> ${stopped ? 'stopped' : 'not registered here'}`);
    send({ type: 'stop_background_task_result', id: msg.id, stopped });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    debugLog(`[stop_background_task] ${msg.taskId} failed: ${errorMessage}`);
    send({ type: 'stop_background_task_result', id: msg.id, stopped: false, errorMessage });
  }
}

/**
 * R49/f210 — write THIS subprocess's own heapdump pair via the shared writer.
 * Deliberately NO `ensureSession()`: a dump must work on a wedged session,
 * and it measures the process, not the Pi session. Base name is
 * `<sessionId>-pi` (the host's dump owns the bare `<sessionId>` pair).
 */
async function handleHeapdump(msg: Extract<InboundMessage, { type: 'heapdump' }>): Promise<void> {
  try {
    const baseName = initConfig?.sessionId ? `${initConfig.sessionId}-pi` : `pi-${process.pid}`;
    const row = writeHeapdump({ baseName });
    send({ type: 'heapdump_result', id: msg.id, ...row });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    debugLog(`[heapdump] Failed: ${errorMsg}`);
    send({ type: 'heapdump_result', id: msg.id, success: false, errorMessage: errorMsg });
  }
}

async function handleCompact(msg: Extract<InboundMessage, { type: 'compact' }>): Promise<void> {
  const epoch = compactionEpoch; // F1.352 — a Stop after this moment cancels this compaction
  try {
    const session = await ensureSession();
    const handle = runtimeHandle;
    if (!handle || handle.session !== session) {
      throw new Error('Active Pi session is not owned by the runtime handle');
    }
    // Serialize manual /compact behind any in-flight auto-compaction. Public
    // session.compact() calls agent.abort() and uses its own controller; if
    // it runs while _runAutoCompaction is suspended, agent state churns and
    // the SDK's race surface widens. The wait is capped well under the host's
    // 300 s RPC deadline (UB2.3, #1060): a stuck compaction used to eat the whole
    // budget before compact() even started. Proceeding after the cap is deliberate,
    // since compact() begins with abort() and thereby cancels the stale compaction.
    const compactWait = await waitForCompaction(session, { timeoutMs: MANUAL_COMPACT_WAIT_MS, log: debugLog });
    debugLog(
      `[compact] starting after ${compactWait.waitedMs}ms wait` +
        (compactWait.timedOut ? ' (prior compaction still flagged; compact() aborts it)' : ''),
    );
    // F1.352 — a Stop taken while this waited (behind an auto-compaction, or on
    // `ensureSession`) means the user no longer wants it: never start it. No check
    // AFTER `handle.compact` — by then the SDK has appended, and a failure answer
    // would misreport a compaction that happened; the in-flight half is
    // `abortCompaction()` in `handleAbort`, which stops it before the append.
    if (epoch !== compactionEpoch) throw new Error('Compaction cancelled');
    // P6.54 · the same standing section on the MANUAL path. The page treats the
    // section and a `/compact <focus>` as alternatives ("add a section … or run
    // `/compact` with a focus"), so a project that has both gets both: the focus
    // is already composed into `customInstructions` and the standing policy
    // follows it.
    const result = await handle.compact(
      withProjectCompactSteering(msg.customInstructions, initConfig?.piContextResources),
    );
    lastCompaction = {
      firstKeptEntryId: result.firstKeptEntryId,
      tokensBefore: result.tokensBefore,
      ...(typeof result.estimatedTokensAfter === 'number' ? { estimatedTokensAfter: result.estimatedTokensAfter } : {}),
    };
    const contextUsage = buildContextUsageSnapshot(session, lastCompaction, currentContextCategoryInputs(session), customEndpointFallbackWindowIds);
    send({
      type: 'compact_result',
      id: msg.id,
      success: true,
      result: {
        summary: result.summary,
        firstKeptEntryId: result.firstKeptEntryId,
        tokensBefore: result.tokensBefore,
        ...(typeof result.estimatedTokensAfter === 'number' ? { estimatedTokensAfter: result.estimatedTokensAfter } : {}),
        contextUsage,
      },
    });
    send({ type: 'event', event: { type: 'context_usage_update', usage: contextUsage } });
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    // R73 · hooks.md#precompact: "For a manual `/compact`, the stderr message is
    // shown to the user." Pi's manual path throws a fixed `Compaction cancelled`
    // for ANY handler that returned `{ cancel: true }`, so the hook's own reason
    // is only recoverable from what the last verdict carried. Substituted only
    // for that exact string, and only when a block really did answer — an
    // ordinary cancellation keeps Pi's wording.
    // F1.352 — a Stop's `Compaction cancelled` is the Stop's, never a hook's: an
    // earlier PreCompact block's reason must not be substituted for it.
    // F1.1298 — and a Stop's answer is `Compaction cancelled` on every summary path (a split turn's
    // prefix summary throws its own abort text): `compactFailureText`.
    const stopped = epoch !== compactionEpoch;
    const errorMsg = compactFailureText(rawMessage, { stopped, preCompactBlockReason: lastPreCompactBlockReason });
    debugLog(`[compact] Failed: ${errorMsg}`);
    send({
      type: 'compact_result',
      id: msg.id,
      success: false,
      errorMessage: errorMsg,
    });
  }
}

async function handleSetAutoCompaction(msg: Extract<InboundMessage, { type: 'set_auto_compaction' }>): Promise<void> {
  try {
    autoCompactionPolicy = parseAutoCompactionPolicy(msg);
    const session = await ensureSession();
    applySessionRuntimePolicies(session, session.agent.state.model);
    send({
      type: 'set_auto_compaction_result',
      id: msg.id,
      success: true,
      enabled: session.autoCompactionEnabled,
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    debugLog(`[set_auto_compaction] Failed: ${errorMsg}`);
    send({
      type: 'set_auto_compaction_result',
      id: msg.id,
      success: false,
      enabled: msg.enabled,
      errorMessage: errorMsg,
    });
  }
}

async function handleUpdateRuntimeConfig(msg: RuntimeConfigUpdateMessage): Promise<void> {
  try {
    if (!initConfig) {
      throw new Error('Runtime config update received before init');
    }

    const nextConfig = await applyNestorReasoningProxy({
      ...initConfig,
      model: msg.model,
      miniModel: msg.miniModel ?? initConfig.miniModel,
      providerType: msg.providerType ?? initConfig.providerType,
      authType: msg.authType ?? initConfig.authType,
      baseUrl: msg.baseUrl,
      customEndpoint: msg.customEndpoint,
      customModels: msg.customModels,
    });

    // UB3.12 (B2-10, owner rule F1.966): an Azure endpoint edit re-points the
    // session in place — `baseUrl` is not in the respawn signature — so the
    // env the Pi SDK reads must follow it here, not only at init. A non-Azure
    // provider or an empty URL touches nothing.
    const updatedEndpointEnv = providerEndpointEnv(nextConfig.piAuth?.provider, msg.baseUrl);
    if (updatedEndpointEnv.AZURE_OPENAI_BASE_URL) {
      process.env.AZURE_OPENAI_BASE_URL = updatedEndpointEnv.AZURE_OPENAI_BASE_URL;
      debugLog(`[runtime_config] Re-applied AZURE_OPENAI_BASE_URL=${updatedEndpointEnv.AZURE_OPENAI_BASE_URL}`);
    }

    if (piModelRegistry && nextConfig.baseUrl?.trim() && nextConfig.customEndpoint) {
      const modelEntries: CustomEndpointModelEntry[] = (nextConfig.customModels?.length
        ? nextConfig.customModels
        : [nextConfig.model || 'default']
      ).map(normalizeCustomEndpointModelEntry);

      customEndpointModelIds = new Set();
      customModelOverrides.clear();
      registerCustomEndpointModels(
        piModelRegistry,
        nextConfig.customEndpoint.api,
        nextConfig.baseUrl.trim(),
        modelEntries,
        nextConfig,
      );
    }

    if (piSession && piModelRegistry) {
      const registry = piModelRegistry;
      // UB12.10 — on a custom endpoint, only the endpoint's own models (`resolveRoutedSessionModel`).
      const piModel = resolveRoutedSessionModel(
        registry,
        msg.model,
        nextConfig.piAuth?.provider,
        shouldPreferCustomEndpoint(nextConfig),
        bareId => {
          registerCustomEndpointModels(
            registry,
            nextConfig.customEndpoint!.api,
            nextConfig.baseUrl!.trim(),
            [{ id: bareId }],
            nextConfig,
          );
          debugLog(`[runtime_config] Dynamically registered custom endpoint model: ${bareId}`);
        },
      );

      if (!piModel) {
        throw new Error(`Could not resolve model after runtime update: ${msg.model}`);
      }

      // I2.29 · session-only (`model-mutation-persistence.ts`): the desktop's
      // own config is where this choice lives, and Pi's global defaults would
      // be a second store that can only disagree with it.
      await piSession.setModel(piModel, SESSION_ONLY_MODEL_MUTATION);
      // Runs AFTER `applyNestorReasoningProxy` above, so a switch onto or off
      // the gateway re-resolves the retry ladder in the same handler.
      applySessionRuntimePolicies(piSession, piModel);
      const modelHint = piModel as { api?: string; provider?: string; baseUrl?: string };
      setInterceptorApiHints(modelHint);
      activeModelHint = modelHint;
      debugLog(`[runtime_config] Updated runtime config and active model: ${piModel.provider}/${piModel.id}`);
    } else {
      debugLog('[runtime_config] Stored update; no active session/model registry yet');
    }

    publishActiveConfig(nextConfig);

    const contextUsage = piSession ? buildContextUsageSnapshot(piSession, lastCompaction, currentContextCategoryInputs(piSession), customEndpointFallbackWindowIds) : undefined;
    send({ type: 'update_runtime_config_result', id: msg.id, success: true, updated: true, contextUsage });
    if (contextUsage) {
      send({ type: 'event', event: { type: 'context_usage_update', usage: contextUsage } });
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    debugLog(`[runtime_config] Failed: ${errorMsg}`);
    send({ type: 'update_runtime_config_result', id: msg.id, success: false, updated: false, errorMessage: errorMsg });
  }
}

async function handleTokenUpdate(msg: Extract<InboundMessage, { type: 'token_update' }>): Promise<void> {
  if (!moduleCredentials) {
    debugLog('token_update received but no credential store initialized');
    return;
  }
  const { provider, credential } = msg.piAuth;
  const transaction = workingDirectoryTransaction;
  const credentialStores = new Set<PiCredentialStore>([moduleCredentials]);
  const configs = new Set<Extract<InboundMessage, { type: 'init' }>>();
  if (initConfig) configs.add(initConfig);
  if (transaction) {
    credentialStores.add(transaction.previous.credentials);
    credentialStores.add(transaction.candidate.credentials);
    configs.add(transaction.previous.config);
    configs.add(transaction.candidate.config);
  }
  // Pi 0.84 · `AuthStorage.set()` is gone and `CredentialStore.modify()` — the
  // only write path — is async. This function was ALREADY `async` and its sole
  // caller already awaits it (`runOrDeferWorkingDirectoryControl`), so the
  // rotation is awaited here rather than floated: a dropped promise would leave
  // a live gateway session running on a stale/expired JWT while the handler
  // reported success. `Promise.all` because the stores are independent and
  // `modify` serializes per provider within each store.
  // See `storePiCredential`: the wire shape is adapted before it is stored (F1.242).
  await Promise.all(
    [...credentialStores].map(store => storePiCredential(store, provider, credential)),
  );
  for (const config of configs) {
    config.piAuth = msg.piAuth;
  }
  // P6.257 — the Pi credential store above is not where the AWS SDK looks, so a
  // rotated Bedrock credential only reaches a live session through this process's
  // own environment. See `bedrock-env-rotation.ts` for why that is enough.
  if (credential.type === 'iam') applyRotatedAwsEnv(credential);
  debugLog(`Updated ${credential.type} credential for provider: ${provider}`);
}

async function handleSetModel(msg: Extract<InboundMessage, { type: 'set_model' }>): Promise<void> {
  debugLog(`[set_model] Received: ${msg.model}`);
  if (!piSession || !piModelRegistry) {
    debugLog(`[set_model] No active session or model registry, ignoring`);
    return;
  }
  const registry = piModelRegistry;
  // For custom endpoints, dynamically register unknown models so mid-session switching works.
  // Uses registerCustomEndpointModels which accumulates into the existing model set
  // (registerProvider replaces, so we track all IDs and re-register the full set).
  // UB12.10 — "unknown" means unknown TO THE ENDPOINT: an id the wire protocol's public
  // catalogue knows is registered too, never sent to the public URL (`resolveRoutedSessionModel`).
  const authProvider = initConfig?.piAuth?.provider;
  const piModel = resolveRoutedSessionModel(registry, msg.model, authProvider, shouldPreferCustomEndpoint(), bareId => {
    registerCustomEndpointModels(registry, initConfig!.customEndpoint!.api, initConfig!.baseUrl!.trim(), [{ id: bareId }]);
    debugLog(`[set_model] Dynamically registered custom endpoint model: ${bareId}`);
  });

  if (!piModel) {
    debugLog(`[set_model] Could not resolve model: ${msg.model}`);
    setInterceptorApiHints(undefined);
    activeModelHint = undefined;
    return;
  }
  try {
    // I2.29 · session-only (`model-mutation-persistence.ts`). The user's choice
    // is persisted by `publishActiveConfig` below, in the host's own store.
    await piSession.setModel(piModel, SESSION_ONLY_MODEL_MUTATION);
    applySessionRuntimePolicies(piSession, piModel);
    const modelHint = piModel as { api?: string; provider?: string; baseUrl?: string };
    setInterceptorApiHints(modelHint);
    activeModelHint = modelHint;
    if (initConfig) publishActiveConfig({ ...initConfig, model: msg.model });
    send({ type: 'event', event: { type: 'context_usage_update', usage: buildContextUsageSnapshot(piSession, lastCompaction, currentContextCategoryInputs(piSession), customEndpointFallbackWindowIds) } });
    debugLog(`[set_model] Model changed to: ${msg.model} (resolved: ${piModel.provider}/${piModel.id})`);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    debugLog(`[set_model] Failed to set model: ${errorMsg}`);
  }
}

async function handleSetThinkingLevel(msg: Extract<InboundMessage, { type: 'set_thinking_level' }>): Promise<void> {
  debugLog(`[set_thinking_level] Received: ${msg.level}`);

  if (!piSession) {
    debugLog('[set_thinking_level] No active session, ignoring');
    return;
  }

  const piLevel = THINKING_TO_PI[msg.level as keyof typeof THINKING_TO_PI];
  if (!piLevel) {
    debugLog(`[set_thinking_level] No Pi mapping for level: ${msg.level}`);
    return;
  }

  try {
    const previousLevel = piSession.thinkingLevel;
    // I2.29 · session-only (`model-mutation-persistence.ts`). Note the
    // asymmetry upstream, which is why this argument is not redundant with the
    // one on `setModel`: `setModel` calls `setThinkingLevel` internally with NO
    // options, so a persisted model never rewrites the global thinking default,
    // and the two decisions are genuinely separate.
    piSession.setThinkingLevel(piLevel, SESSION_ONLY_MODEL_MUTATION);
    // C3.385 · publish what Pi ACTUALLY HOLDS, never what was asked for.
    //
    // R7 measured (packaged `70d269e46`, 2026-09-12) that a mid-session effort
    // change is accepted by the host — `getSessions()` reports
    // `thinkingLevel: "high"` — while the session's `.pi-sessions/*.jsonl`
    // records no `thinking_level_change` at all, and read that as the sidecar
    // failing to record it. The SDK refutes that: `setThinkingLevel`
    // (`@earendil-works/pi-coding-agent` `dist/core/agent-session.js`) calls
    // `sessionManager.appendThinkingLevelChange(effectiveLevel)` and emits
    // `thinking_level_changed` — but only `if (isChanging)`, where
    // `effectiveLevel` has already been CLAMPED by
    // `getSupportedThinkingLevels(model)`, which in `@earendil-works/pi-ai`
    // returns `["off"]` AND NOTHING ELSE for a model carrying no `reasoning`
    // flag. So there was no entry because there was no change: the level was
    // clamped straight back to the one already in force.
    //
    // The defect is therefore not the thread, it is this line: publishing
    // `msg.level` told every reader the session runs at a level it does not.
    // That is the silent-divergence class rather than a missing record, and the
    // honest value is the one Pi holds after its own clamp.
    const effectivePiLevel = piSession.thinkingLevel;
    const effectiveLevel = (Object.keys(THINKING_TO_PI) as Array<keyof typeof THINKING_TO_PI>)
      .find(level => THINKING_TO_PI[level] === effectivePiLevel);
    if (initConfig) {
      // `?? initConfig.thinkingLevel` covers the one unrepresentable case: Pi's
      // ladder carries `minimal`, which this product's `ThinkingLevel` does not,
      // so a clamp landing there has no name to publish. Keeping the previous
      // published value is the lesser wrong — inventing `msg.level` is exactly
      // the claim this row exists to stop — and the clamp is named in the log
      // below either way.
      publishActiveConfig({ ...initConfig, thinkingLevel: effectiveLevel ?? initConfig.thinkingLevel });
    }
    if (effectivePiLevel !== previousLevel) {
      applySessionRuntimePolicies(piSession, piSession.agent.state.model);
    }
    if (effectivePiLevel !== piLevel) {
      debugLog(
        `[set_thinking_level] Pi CLAMPED ${msg.level} (mapped: ${piLevel}) to ${effectivePiLevel}: `
        + `this model supports ${JSON.stringify(piSession.getAvailableThinkingLevels?.() ?? [effectivePiLevel])}. `
        + 'The published level is the effective one, not the requested one.',
      );
    } else {
      debugLog(`[set_thinking_level] Thinking level changed to: ${msg.level} (mapped: ${piLevel})`);
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    debugLog(`[set_thinking_level] Failed to set thinking level: ${errorMsg}`);
  }
}

/**
 * `env-vars.md:307` — the non-interactive run's bounded wait for background
 * subagents and workflows, taken BEFORE the disposal that aborts them.
 *
 * Interactive teardown is untouched: `deactivateSpawner` still drains (aborts)
 * on every generation swap, which is the deliberate behaviour there. This runs
 * once, on the shutdown that ends a `-p`-style run, and only when the CLI
 * marked the process as one.
 *
 * It cannot end in silence. Whichever way the wait goes, one line naming the
 * outcome — and, on a timeout, naming exactly what was still running — is
 * written to stderr before the process exits. stderr and not stdout: stdout is
 * the JSONL protocol channel.
 */
async function awaitNonInteractiveBackgroundWork(): Promise<void> {
  if (!isNonInteractivePrintMode()) return;
  const registry = activeBackgroundTasks;
  if (!registry || registry.activeCount === 0) return;
  const ceilingMs = resolvePrintBackgroundWaitCeilingMs();
  if (ceilingMs <= 0) {
    // "Set to `0` to wait indefinitely." Announced first, so an unbounded wait
    // is a stated choice rather than a process that stopped saying anything.
    process.stderr.write(`${formatUnboundedPrintBackgroundWaitNotice(registry.taskIds)}\n`);
  }
  const outcome = await registry.waitForIdle(ceilingMs);
  const line = formatPrintBackgroundWaitOutcome(outcome, ceilingMs);
  process.stderr.write(`${line}\n`);
  debugLog(line);
}

async function handleShutdown(): Promise<void> {
  debugLog('Shutdown requested');
  await awaitNonInteractiveBackgroundWork();
  // F1.303 — utility sessions are aborted independently of the main chat session, as upstream does. AFTER the
  // non-interactive wait above (upstream has none): a background subagent's utility query is work that wait
  // exists to let finish, so cancelling it first would cut exactly what the wait protects.
  ephemeralQueries.cancelAll(new EphemeralQueryCancelledError('Pi server shutting down'));
  await discardWorkingDirectoryTransaction('shutdown');

  // Unsubscribe events
  if (unsubscribeEvents) {
    unsubscribeEvents();
    unsubscribeEvents = null;
  }

  // Dispose session
  if (piSession) {
    await activeSpawnerDeactivation?.();
    runtimeHandle?.dispose();
    runtimeHandle = null;
    piSession = null;
  }
  activeSpawnerActivation = null;
  activeSpawnerDeactivation = null;
  activeConfigUpdate = null;
  activeWorkflowCommandTool = null;
  activeContextAccounting = null;
  activeWorkflowCommandController?.abort();
  activeWorkflowCommandController = null;

  void stopNestorReasoningProxy();

  // Reject pending promises
  clearPendingPreToolUse('Server shutting down');

  for (const [, pending] of pendingToolExecutions) {
    pending.removeAbort?.()
    pending.reject(new Error('Server shutting down'));
  }
  pendingToolExecutions.clear();

  for (const [, pending] of pendingProcessStarts) pending.reject(new Error('Server shutting down'))
  pendingProcessStarts.clear()
  for (const [, pending] of pendingChildSessionRequests) pending.reject(new Error('Server shutting down'))
  pendingChildSessionRequests.clear()

  for (const [, pending] of pendingAskUser) {
    pending.reject(new Error('Server shutting down'));
  }
  pendingAskUser.clear();

  process.exit(0);
}

// ============================================================
// Main JSONL Reader Loop
// ============================================================

async function processMessage(msg: InboundMessage): Promise<void> {
  switch (msg.type) {
    case 'init':
      await handleInit(msg);
      break;

    case 'prompt':
      await handlePrompt(msg);
      break;

    case 'register_tools':
      handleRegisterTools(msg);
      break;

    case 'tool_execute_response':
      handleToolExecuteResponse(msg);
      break;

    case 'process_start_response':
      handleProcessStartResponse(msg);
      break;

    case 'child_session_response':
      handleChildSessionResponse(msg);
      break;

    case 'pre_tool_use_response':
      handlePreToolUseResponse(msg);
      break;

    case 'post_tool_use_response':
      handlePostToolUseResponse(msg);
      break;

    case 'pre_compact_response':
      handlePreCompactResponse(msg);
      break;

    case 'ask_user_response':
      handleAskUserResponse(msg);
      break;

    case 'mcp_elicitation_state':
      elicitationDialogGate.set(msg.dialogId, msg.open === true);
      break;

    case 'outside_root_response': {
      const pending = pendingOutsideRoot.get(msg.requestId);
      if (pending) {
        pendingOutsideRoot.delete(msg.requestId);
        // F1.959 — a refusal that names the host's reason (the Guardian judge's
        // door) fails the suspended call with that sentence; a bare `root: null`
        // keeps the scope error's own ("Path is outside the session filesystem scope").
        if (!msg.root && typeof msg.reason === 'string' && msg.reason.length > 0) pending.refuse(msg.reason);
        else pending.resolve(msg.root ?? null);
      }
      break;
    }

    case 'denied_paths_response': {
      const pending = pendingDeniedPaths.get(msg.requestId);
      if (pending) {
        pendingDeniedPaths.delete(msg.requestId);
        // A malformed answer is the empty set, never a crash and never a guess:
        // the promise it resolves is holding a tool result open.
        pending.resolve(Array.isArray(msg.denied) ? msg.denied.filter(entry => typeof entry === 'string') : []);
      }
      break;
    }

    case 'abort':
      await handleAbort();
      break;

    case 'mini_completion':
      await handleMiniCompletion(msg);
      break;

    case 'llm_query':
      await handleLlmQuery(msg);
      break;

    case 'cancel_ephemeral_query':
      handleCancelEphemeralQuery(msg);
      break;

    case 'ensure_session_ready':
      await handleEnsureSessionReady(msg);
      break;

    case 'set_model':
      await runOrDeferWorkingDirectoryControl(() => handleSetModel(msg));
      break;

    case 'set_thinking_level':
      await runOrDeferWorkingDirectoryControl(() => handleSetThinkingLevel(msg));
      break;

    case 'get_context_usage':
      await handleGetContextUsage(msg);
      break;

    // L9 — NOT wrapped in `runOrDeferWorkingDirectoryControl`: a stop must not
    // wait on a working-directory transaction, and it mutates no session state.
    case 'stop_background_task':
      await handleStopBackgroundTask(msg);
      break;

    case 'heapdump':
      await handleHeapdump(msg);
      break;

    case 'compact':
      await handleCompact(msg);
      break;

    case 'set_auto_compaction':
      await handleSetAutoCompaction(msg);
      break;


    case 'update_runtime_config':
      await runOrDeferWorkingDirectoryControl(() => handleUpdateRuntimeConfig(msg));
      break;

    case 'workflow_execute':
      await handleWorkflowExecute(msg);
      break;

    case 'subtask_start':
      await handleSubtaskStart(msg);
      break;

    case 'skill_fork_start':
      await handleSkillForkStart(msg);
      break;

    case 'working_directory_transaction':
      await handleWorkingDirectoryTransaction(msg);
      break;

    case 'steer':
      if (piSession) {
        debugLog(`Steering with: "${msg.message.slice(0, 100)}"`);
        await piSession.steer(msg.message);
      } else {
        debugLog('Steer ignored — no active session');
      }
      break;

    case 'token_update':
      await runOrDeferWorkingDirectoryControl(() => handleTokenUpdate(msg));
      break;

    case 'shutdown':
      await handleShutdown();
      break;

    default:
      debugLog(`Unknown message type: ${(msg as any).type}`);
  }
}

function main(): void {
  debugLog('Pi agent server starting');

  try {
    runtimeAdapter = createPiRuntimeAdapter();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send({ type: 'startup_error', code: 'pi_runtime_incompatible', message });
    process.exitCode = 78;
    return;
  }

  const rl = createInterface({ input: process.stdin });

  rl.on('line', (line: string) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line) as InboundMessage;
      processMessage(msg).catch((error) => {
        const errorMsg = error instanceof Error ? error.message : String(error);
        clearPendingPreToolUse(`Message processing failed: ${errorMsg}`);
        debugLog(`Error processing message: ${errorMsg}`);
        send({ type: 'error', message: errorMsg });
      });
    } catch (parseError) {
      debugLog(`Failed to parse JSONL: ${parseError}`);
    }
  });

  rl.on('close', () => {
    debugLog('stdin closed, shutting down');
    void handleShutdown().catch(error => {
      debugLog(`Shutdown drain failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
  });

  // Handle unexpected errors — process state is unreliable after these,
  // so we attempt to report and then exit immediately.
  // send() is wrapped in try/catch because stdout itself may be broken
  // (e.g. EFAULT from a closed pipe), and we must not let the error
  // report trigger another uncaughtException (which would loop).
  process.on('uncaughtException', (error) => {
    clearPendingPreToolUse(`Uncaught exception: ${error.message}`);
    debugLog(`Uncaught exception: ${error.message}`);
    try {
      send({ type: 'error', message: `Uncaught exception: ${error.message}`, code: 'uncaught' });
    } catch {
      // stdout may be broken — swallow to avoid re-triggering
    }
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    clearPendingPreToolUse(`Unhandled rejection: ${msg}`);
    debugLog(`Unhandled rejection: ${msg}`);
    try {
      send({ type: 'error', message: `Unhandled rejection: ${msg}`, code: 'unhandled_rejection' });
    } catch {
      // stdout may be broken — swallow to avoid re-triggering
    }
    process.exit(1);
  });
}

// F1.318 — pi-ai loads its OAuth flows through a variable-specifier dynamic
// import of a SIBLING module (`dist/auth/oauth/load.js`), which a single-file
// bundle does not have: every stored `oauth` credential (F1.242's rewrapped
// ChatGPT bearer, GitHub Copilot) failed in the packaged subprocess with
// `Cannot find module './<provider>.js'` while working from source. pi-ai's own
// answer for a standalone Bun binary, called at startup exactly as
// pi-coding-agent's `dist/bun/cli.js` does and craft-agents-oss v0.13.4's entry
// does (Apache-2.0). Module scope, ABOVE the guard below, so it has run before
// `main()` can resolve any credential; the import is at the bottom with the
// F1.197 / F1.239 ones, for the same line-citation reason.
registerBunOAuthFlows();

// P3.291 (2026-09-03): `main()` ran at module scope, so importing this file
// started the server — which is why no test could reach the subprocess option
// wiring (P3.272's denied-paths filter) and why mutating that wiring away left
// every suite green. Guarded so the module can be imported.
//
// `import.meta.main` is true only for the process entrypoint. Measured through
// this package's own build (`bun build --target=bun --format=esm`): the bundler
// emits the expression verbatim, it reads true when the bundle is run as the
// entrypoint — including under the `--require` interceptor preload the host
// spawns it with — and false when another module imports it. Proven on the
// packaged Pi subprocess (`resources/pi-agent-server/index.js`) before landing.
if (import.meta.main) {
  main();
}

// F1.197 — the deferred-tool summary the two lines above feed and apply, imported
// HERE rather than with the others at the top: `docs/**` cites this file by line
// (highest 4630), and an import added up there would move every citation below
// it. Import declarations are hoisted, so the module is initialised before
// `main()` runs.
import { dropDeferredToolSummaryNames, setDeferredToolSummaryNames, withDeferredToolSummary } from './deferred-tool-summary.ts'; import { setSubagentCatalogue } from './subagent-catalogue.ts'; // F1.1262
import { compactFailureText } from './compact-failure-text.ts'; // F1.1298 — below every cited line, as F1.1262's

// F1.318 — see the registration call above the `import.meta.main` guard.
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth';

// F1.239 — the ephemeral query coordinator, imported here for the same reason as
// the line above: `docs/**` cites this file by line (highest 4630).
import {
  EphemeralQueryCancelledError,
  EphemeralQueryCoordinator,
  EPHEMERAL_QUERY_DEADLINE_MS,
  isEphemeralQueryCancellation,
  type EphemeralQueryContext,
  type EphemeralQueryResource,
} from './ephemeral-query-lifecycle.ts';

// F1.1288 — the abort/prompt serialization point, imported here for the same
// reason as the two imports above: `docs/**` cites this file by line (highest
// 4630), so the import lives below every cited line.
import { TurnTransitionGate } from './turn-transition.ts';
import { cacheWarmingForSession } from './pi-session-settings.ts'; // UB7.16 — below every cited line, as the imports above

/**
 * F1.1288 — the one gate for the subprocess's turn transitions: `handleAbort`
 * runs through {@link TurnTransitionGate.runAbort} (Stops coalesce) and
 * `handlePrompt` joins an in-flight abort through
 * {@link TurnTransitionGate.waitForAbort} before it touches the session. See
 * the gate module for the direction argument (a prompt joins an abort; an
 * abort never waits for a prompt).
 */
const turnTransitions = new TurnTransitionGate();