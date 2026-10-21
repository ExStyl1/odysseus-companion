interface PiSubprocessStartupAttempt {
  id: number;
  cancelled: boolean;
  readySettled: boolean;
  startupSettled: boolean;
  ready: Promise<void>;
  startup: Promise<void>;
  resolveReady(): void;
  rejectReady(error: Error): void;
  resolveStartup(): void;
  rejectStartup(error: Error): void;
}

type WorkingDirectoryTransactionPhase = 'prepare' | 'commit' | 'rollback' | 'finalize';

interface PiWorkingDirectoryTransactionState {
  id: string;
  expectedGeneration: number;
  generation: number;
  previousPath: string;
  path: string;
  projectTrusted: boolean;
  phase: 'preparing' | 'prepared' | 'committing' | 'committed' | 'rolling_back' | 'rolled_back' | 'finalizing' | 'finalized';
  pending?: {
    phase: WorkingDirectoryTransactionPhase;
    resolve(): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  };
}

/**
 * Pi Backend (Subprocess RPC Client)
 *
 * Thin subprocess client for the Pi coding agent. Spawns a pi-agent-server
 * subprocess and communicates via JSONL over stdin/stdout.
 *
 * The subprocess runs the Pi SDK (@earendil-works/pi-coding-agent) in-process,
 * handles tool wrapping, permission enforcement, and LLM queries.
 * This file manages subprocess lifecycle, JSONL protocol, event forwarding,
 * and proxy tool routing for MCP/API sources.
 *
 * Auth is API key based. Keys are retrieved from the credential manager
 * and passed to the subprocess during initialization.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { reportToolSearchDisposition } from './options.ts';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import type { AgentEvent, AskUserAnswer, AskUserPermissionRequest, AskUserQuestionItem, ContextUsageSnapshot, PermissionRequest } from '@nessy-agent/core/types';
import { validateAskUserQuestions, validateBatchedAskUserAnswer } from '@nessy-agent/core/utils';
import type { FileAttachment } from '../utils/files.ts';
import {
  applyLoopbackProxyExemption,
  applyNodeEnvProxy,
  buildShellChildNetworkEnv,
  getProxyEnvVars,
} from '../config/proxy-env.ts';
import { parseSessionCommand, type ParsedSessionCommand } from '../slash-commands/session-command.ts';
import type { HeapdumpWriteResult } from '../diagnostics/heapdump.ts';
import { resolveChildOutputStyleId, resolveMemorySessionId } from './child-session-scope.ts';
import { bunProjectIsolationArgs } from './bun-project-isolation.ts'; // F1.1063 · the Pi spawn's Bun switches
import type {
  AgentLifecycleState,
  BackendConfig,
  BackendRuntimeUpdate,
  CapabilityTurnRuntime,
  ChatOptions,
  RuntimeHandoffPayload,
  SdkMcpServerConfig,
  WorkingDirectoryUpdateInput,
  WorkingDirectoryUpdateTransaction,
} from './backend/types.ts';
// T7 · the carry-session seam. Only two symbols cross into this file: where the
// synthesized parent lives, and whether Pi would actually fork from it.
import { piCarrySessionIsLoadable, piCarrySessionPath } from './pi-session-rebuild.ts';
import {
  assertPiExecutionManifestIdentity,
  derivePiPromptMetadata,
  finalizePiExecutionManifest,
  tryParsePiDynamicMcpBindingName,
  type PiDynamicToolDefinition,
  type PiExecutionManifestV2,
  type PiOrchestratorConfig,
} from './pi-harness/harness-manifest.ts';
import {
  getHarnessToolDescriptor,
  getPiToolBindingByBindingName,
  PERMISSION_RULE_TOOL_NAMES,
} from './pi-harness/harness-tool-descriptor.ts';
import { AbortReason } from './backend/types.ts';
import { getBackendRuntime, type BackendRuntimePayload } from './backend/internal/driver-types.ts';
import { SourceActivationDrainController } from './source-activation-drain.ts';

import type { PermissionMode } from './mode-manager.ts';
import { canonicalizeForDecision } from './session-filesystem-scope.ts';
import { resolveAdditionalDirectories } from './additional-directories.ts';
import { activeEffortLevelForModel, normalizeThinkingLevel, type ThinkingLevel } from './thinking-levels.ts';
import type { PiChildSessionRequest, PiChildSessionResponse } from './pi-harness/child-session-port.ts';
import { projectReadyPiLspTool, type PiLspRequest } from './pi-harness/lsp-port.ts';
import { composePiCompactionInstructions, composePiHarnessPrompt } from './pi-harness/prompt-composer.ts';
import type { CapabilityActivationLeaseV1 } from './pi-harness/capability-catalog.ts';
import { materializePiRuntimeAgentDefinitions } from './pi-harness/runtime-agent-definition.ts';
import type { PiContinuationRuntimeStateV1 } from './pi-harness/continuation-envelope.ts';

// Import models from centralized registry
import { getModelById } from '../config/models.ts';
import {
  contextWindowDriftDiagnostic,
  resolveContextWindow,
  type ResolvedContextWindow,
} from '../config/context-window-resolver.ts';
import { nestorGatewayModelWindow } from '../auth/nestor.ts';
import { isNessyGatewayBaseUrl, modelTargetForEndpoint } from './backend/internal/drivers/upstream-target.ts';
import { resolveFallbackModelChain } from '../config/fallback-model-chain.ts';

// BaseAgent provides common functionality
import { BaseAgent, isHostConsultChildConfig, type SkillForkOutcome, type SkillForkRequest } from './base-agent.ts';
import type { ResolvedWorkspace as Workspace } from '../workspaces/types.ts';

// Event adapter
import { PiEventAdapter } from './backend/pi/event-adapter.ts';
import { EventQueue } from './backend/event-queue.ts';

// System prompt for Nessy Desktop context
import { getSystemPrompt } from '../prompts/system.ts';
import { fenceHookBand } from '../automations/hook-context-fence.ts';
import { outputStyleProjectRootFor, resolveOutputStyleComposition } from '../prompts/output-styles.ts';
import { formatPreferencesForPrompt, getCoAuthorPreference } from '../config/preferences.ts';
import {
  evaluatePreferencesDrift,
  resetPreferencesDriftState,
  type PreferencesDriftState,
} from './preferences-drift.ts';
import type {
  AgentEvent as AutomationAgentEvent,
  AgentEventExecutionResult,
  HookNotificationType,
  PreToolUseDecision,
  SdkAutomationInput,
  SessionEndReason,
} from '../automations/types.ts';
import {
  hookBlockEndsTurn,
  isBlockingHookDecision,
  resolveHookToolOutputRewrite,
} from '../automations/hook-decision-contract.ts';
import { MAX_HOOK_TIMEOUT_MS } from '../automations/hook-command.ts';
import { resetHookEnvFile, resolveHookEnvFileShellStart } from '../automations/hook-env-file.ts';
import { toDocumentedStopFailureError } from '../automations/utils.ts';
import { hookTaskRegistryInput } from '../automations/hook-task-registry.ts';

// Credential manager for token storage
import { getCredentialManager } from '../credentials/manager.ts';
import { getValidCreds } from '../auth/dp/creds-store.ts';
import { isNestorCliBaseUrl } from '../auth/nestor.ts';
import { describeNestorQuota } from './backend/internal/nestor-quota.ts';

// ChatGPT OAuth token refresh (used when Pi routes ChatGPT auth)
import { refreshChatGptTokens } from '../auth/chatgpt-oauth.ts';

// Session-scoped tool callbacks (for SubmitPlan, source auth, etc.)
import {
  registerSessionScopedToolCallbacks,
  mergeSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
  setLastPlanFilePath,
  getSessionScopedToolCallbacks,
} from './session-scoped-tools.ts';
import { attachSessionSelfManagementBindings } from './session-self-management-bindings.ts';

// Session tool proxy definitions (for registering with subprocess)
import { getSessionToolProxyDefs, SESSION_TOOL_NAMES } from './backend/pi/session-tool-defs.ts';

// Session tool registry (for executing proxy tool calls)
import {
  SESSION_BACKEND_TOOL_NAMES,
  SESSION_TOOL_REGISTRY,
  type NonTextContent,
  type ToolResult as SessionToolResult,
} from '@nessy-agent/session-tools-core';
import { createClaudeContext, type SessionToolContext } from './claude-context.ts';
import { getPermissionModeDiagnostics, shouldAllowToolInMode } from './mode-manager.ts';
import { PERMISSION_MODE_AGENT_LABELS, parsePermissionMode } from './mode-types.ts';

type PiCompactResult = {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  estimatedTokensAfter?: number;
  contextUsage?: ContextUsageSnapshot;
};

type PiToolIdentity = Pick<PermissionRequest,
  'semanticId' | 'piName' | 'surfaceVersion' | 'originalName'
  | 'manifestGeneration' | 'manifestHash' | 'manifestProvenance'>;

type ManifestProxyToolDef = ProxyToolDef & {
  promptSnippet?: string;
  promptGuidelines?: readonly string[];
};

/**
 * The environment handed to the Pi subprocess, assembled from every source that
 * can carry a proxy, with the loopback exemption applied to the MERGED result.
 *
 * P2.259. The Pi subprocess is the THIRD runtime with this shape (P2.213 codex,
 * P2.251 claude) and the only one whose failing state ships as a product
 * DEFAULT: the local-model card's endpoint placeholder is
 * `http://localhost:11434`, so a corporate-proxy user's Ollama session is in the
 * broken arm by construction. Measured 2026-08-27, six arms on one rig against
 * the real bundled `pi-agent-server` with the real interceptor preloaded, three
 * independent detectors (stub-upstream hits / sink-proxy hits / the turn's own
 * `agent_end` text). The four that define the contract — the other two are the
 * spelling pair, below:
 *
 * | proxy       | NO_PROXY / no_proxy      | base URL             | outcome                        |
 * | ----------- | ------------------------ | -------------------- | ------------------------------ |
 * | absent      | —                        | localhost:<stub>     | turn ok, 0 sink hits           |
 * | sink proxy  | absent                   | localhost:<stub>     | turn FAILED, stub got 0 hits,  |
 * |             |                          |                      | sink got the POST              |
 * | sink proxy  | loopback, BOTH spellings | localhost:<stub>     | turn ok, 0 sink hits           |
 * | sink proxy  | loopback, both           | api.…invalid         | sink got the POST (still on)   |
 *
 * WHY THE MERGED ENV AND NOT `buildNetworkEnvVars`: that projection sees the
 * in-app Settings proxy alone, and the failing arm's proxy is AMBIENT — a
 * `HTTPS_PROXY` from the user's login shell, which `loadShellEnv` copies in
 * wholesale on macOS packaged builds. A projection-time rule would miss it.
 *
 * WHY NOT THE INTERCEPTOR, whose own `shouldBypassProxy`
 * (`unified-network-interceptor.ts`) also exempts loopback nowhere: because an
 * interceptor bypass is NOT authoritative. Bun's native `fetch` reads the
 * proxy variables at launch, so when the interceptor decides to go direct it
 * simply omits `init.proxy` and Bun proxies the request anyway — measured with
 * a bare Bun child and no interceptor at all, and measured again end to end in
 * the arm where the interceptor's rule said BYPASS and the sink still got the
 * POST. The env is the only lever that works.
 *
 * WHY BOTH SPELLINGS, and why lowercase is the load-bearing one here: Bun reads
 * `no_proxy` BEFORE `NO_PROXY` (measured: lower=loopback + upper=example.invalid
 * → direct; upper=loopback + lower=example.invalid → PROXIED), which is the
 * opposite precedence from the interceptor's own `NO_PROXY || no_proxy`. Writing
 * one spelling is silently overridden by a shell that exports the other.
 * `applyLoopbackProxyExemption` writes both, and EXTENDS rather than replaces —
 * hence the call below sits after every spread, including `envOverrides`.
 *
 * Note for the next editor: the `...processEnv` spread cannot be trusted to
 * carry a proxy that was ASSIGNED at runtime — in Bun 1.3.14 such a value is
 * readable by property access but absent from `Object.keys(process.env)` and
 * from a spread (P2.261). The Settings proxy survives that because `proxyEnv`
 * is a separate spread; the exemption survives it because it reads the merged
 * object, not `process.env`.
 */
export function buildPiSubprocessEnv(parts: {
  processEnv: NodeJS.ProcessEnv;
  proxyEnv: Record<string, string>;
  envOverrides?: Record<string, string>;
  awsEnv: Record<string, string>;
  sessionDir?: string;
  /**
   * P6.535 (Pi arm) — needed to name the session's scratch directory, which is
   * addressed by (workspaceId, sessionId) and NOT derivable from `sessionDir`:
   * that value is `join(workspace.sessionRootPath, sessionId)` while the
   * approval-card exemption honours `getSessionJobDir`, which resolves through
   * `getSessionStoragePath` + `sanitizeSessionId`. Deriving it from the string
   * would name a directory the gate does not exempt.
   */
  workspaceId?: string;
  sessionId: string;
  debug: boolean;
  /**
   * P6.691 — the BYO connection's chosen credential header, or undefined for the
   * default. Read by the interceptor preloaded into this child
   * (`unified-network-interceptor.ts`'s `rewriteCredentialHeader`), which is the
   * only host seam that sees the child's outbound request: Pi's request headers
   * are built inside the vendored `@earendil-works/pi-ai`, which publishes no
   * header knob on the openai-compatible path.
   */
  credentialHeader?: string;
  /**
   * P7.3/P7.10 — the directory holding the bundle's Pi package identity, i.e.
   * `dirname(piServerPath)`: `packages/pi-agent-server/dist` in dev, the staged
   * `resources/pi-agent-server` when packaged. Both are written by
   * `write-dist-package.ts` / `copyPiAgentServer`.
   *
   * WHY IT IS SENT AT ALL. The bundled runtime reads its own VERSION and
   * `piConfig` from `getPackageDir()` (`@earendil-works/pi-coding-agent`'s
   * `dist/config.js`), whose FIRST branch is `process.env.PI_PACKAGE_DIR` and
   * whose fallback walks up from the module to the nearest `package.json`.
   * `write-dist-package.ts` exists to make that walk stop at the bundle. At
   * 0.84.3 the walk gained a rule — `if (basename(dir) === "dist" && parent has
   * package.json) return parent` — that steps PAST the planted identity for the
   * dev layout, so `pi-runtime-adapter.ts` would reject every dev session with
   * `Unsupported Pi runtime 1.0.2; expected 0.84.3` (the wrapper's own version;
   * the trap AGENTS.md records). Native-first: the runtime already publishes the
   * override, so the host names the directory instead of forking the resolver or
   * renaming the output directory.
   */
  piBundleDir?: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...withoutSkippedAuthBearer(withoutInheritedIamCompanions(parts.processEnv, parts.awsEnv), parts), // F1.320 · F1.545
    ...parts.proxyEnv,
    ...parts.envOverrides,
    ...parts.awsEnv,
    ...(parts.sessionDir ? { NESSY_SESSION_DIR: parts.sessionDir } : {}), // cross-process toolMetadataStore
    // The gateway correlation header's only producer: the interceptor runs
    // in THIS subprocess and reads it per request (telemetry/gateway-headers.ts).
    // Same spelling the skill runtime already resolves a session id under.
    NESSY_SESSION_ID: parts.sessionId,
    NESSY_DEBUG: parts.debug ? '1' : '0', // propagate debug mode
    // F1.531 · the interceptor's Pi marker (`runsInPiSubprocess`): after every spread, never cleared — unlike the model hint.
    NESSY_PI_SUBPROCESS: '1',
  };
  // P6.691 · set or DELETED, never left to the `...processEnv` spread above. An
  // inherited value must not decide a connection's credential header — the host
  // may itself have been launched with this name set, and a connection that
  // chose the default would then silently move its token onto another header.
  if (parts.credentialHeader) env.NESSY_UPSTREAM_CREDENTIAL_HEADER = parts.credentialHeader;
  else delete env.NESSY_UPSTREAM_CREDENTIAL_HEADER;
  // P7.3/P7.10 · set or DELETED, for the same reason as the header above: an
  // ambient `PI_PACKAGE_DIR` in the host's own shell must not decide which
  // manifest the child calls its Pi identity. The spawn site always has a
  // `piServerPath` (it throws otherwise), so the production path always sets it.
  if (parts.piBundleDir) env.PI_PACKAGE_DIR = parts.piBundleDir;
  else delete env.PI_PACKAGE_DIR;
  // P6.535 (Pi arm) · the per-session scratch root, CREATED before it is named
  // (`ensureSessionJobDir` does both, and the row's controller decision is that
  // the env line never lands without the mkdir). Pi reads no name of its own —
  // claude's `CLAUDE_JOB_DIR` is native, this is host-supplied, and the switch
  // report carries that difference. Assigned after the overrides spread above
  // for the reason `CLAUDE_JOB_DIR` is: an ambient value in the host's shell
  // must not put two sessions in one scratch directory, which is the collision
  // this row exists to remove.
  const jobDir = ensureSessionJobDir(parts.workspaceId, parts.sessionId);
  if (jobDir) env[SESSION_JOB_DIR_ENV_VAR] = jobDir;
  else delete env[SESSION_JOB_DIR_ENV_VAR];
  applyLoopbackProxyExemption(env);
  // P6.255 (children arm) · AFTER the loopback exemption, never before — a Node
  // child that starts honouring the proxy must not route a loopback address
  // through it. The flag is inert for the Pi child ITSELF, which is Bun and
  // honours the proxy natively; it is for the Node processes that inherit this
  // env from it. See `applyNodeEnvProxy`'s docblock for the whole measurement.
  applyNodeEnvProxy(env);
  return env;
}

// call_llm pre-execution pipeline

// McpClientPool for source tool proxying (centralized pool from main process)
import type { McpClientPool, ProxyToolDef } from '../mcp/mcp-pool.ts';
// The one posture for MCP-authored prose across all three runtimes (P3.292,
// P3.293) — read that module before changing either call site below.
import { capMcpText } from '../mcp/third-party-text.ts';

// Path utilities
import { delimiter, dirname, join, resolve } from 'path';
import { homedir } from 'os';

// Session storage (plans folder path)
import {
  ensureSessionJobDir,
  getSessionDataPath,
  getSessionDirPath,
  getSessionPlansDir,
  SESSION_JOB_DIR_ENV_VAR,
} from '../sessions/storage.ts';
import type { SessionKey } from '../sessions/session-key.ts';
// C3.274 — the Pi arm of the host-owned per-session diagnostic file.
import { openSessionRuntimeDebugLog, sessionRuntimeDebugLogHeader } from './session-debug-log.ts';
import type {
  ProcessIsolationProfile,
  SupervisedProcessChildStartRequest,
} from './pi-harness/process-supervisor-port.ts';
import { clampSupervisedChildTimeoutMs, pickSupervisedChildStartFields } from './pi-harness/process-supervisor-port.ts';
import { backgroundTasksDisabled } from '../config/background-task-settings.ts';
import { toolSearchMode } from '../config/tool-search-settings.ts';
import {
  appendPluginBinPath,
  enabledPluginBundleRoots,
  pluginRuntimeEnvForProfile,
} from '../plugins/data-paths.ts';
import type { PiPermissionPolicyDecision } from './pi-harness/permission-receipt.ts';
import {
  describePermissionDslMatch,
  permissionDslAskReason,
  permissionDslDenyReason,
  rawDslInputPath,
} from './pi-harness/permission-dsl.ts';
// F1.478 — a claude-visible session tool's rule request is read under both of its names; see the module.
import { evaluatePermissionDslUnderSessionToolAlias, filterCapabilityIdentitiesByWholeToolDenyUnderSessionToolAlias, piManifestCapabilityIdentities, piSessionToolRuleAlias, piWholeToolDenyRefusals } from './pi-harness/session-tool-rule-alias.ts';
import { parseSafeExecutionReceiptInput } from './pi-harness/execution-observability.ts';
import { deferredToolUsePayload, resolveDeferredModeRestore, type PiDeferredToolCallV1 } from './pi-harness/deferred-tool-call.ts';

// Error typing
import { isQuotaExhaustedText, parseError, type AgentError } from './errors.ts';

// Centralized PreToolUse pipeline
import { bashSessionGrantCoversLine, mergedAdditionalDirectories, promptIsClassifierAdjudicated, promptIsNonNegotiable, runPreToolUseChecks, shouldPromptInBypassDenyNet, type PreToolUseCheckResult } from './core/pre-tool-use.ts';
import { GUARDIAN_JUDGE_MAX_TURNS } from './core/guardian-judge-core.ts'; // F1.828: a judge's own turn ceiling
import { i18n, setupI18n } from '../i18n/index.ts';
import { permissionsConfigCache, type PermissionsContext, type SessionPermissionRule } from './permissions-config.ts';
import { parseClaudeRuleString } from './pi-harness/claude-permission-rules.ts';
import { addClaudePermissionRules, resolveClaudeSettingsRoot } from './claude-settings-store.ts';
import { GuardianConsultState, type GuardianAskReason, type GuardianRunResult } from './core/guardian-consult.ts';
import { resolveBedrockRegion, describeBedrockRegion, bedrockIamCredentialFingerprint } from './bedrock-region.ts';
import { buildBuiltinAgentTierNotice, type BuiltinAgentTierModelMap } from '../agents/builtin-tier-notice.ts';
import { GUARDIAN_JUDGE_HOST_REFUSAL, PLUGIN_HOOK_AGENT_HOST_REFUSAL, type GuardianJudgeInput, type GuardianOrgPolicy, type GuardianPlannedAction } from '../prompts/guardian.ts';
import { hasAutoModePolicy } from './pi-harness/managed-policy.ts';
import { buildGuardianFacts, type GuardianGitRunner } from './pi-harness/guardian-facts.ts';
import { resolveMaxAgentTurns } from '../config/max-agent-turns.ts';
import {
  sliceProjectInstructions,
  type GuardianProjectInstructions,
} from './pi-harness/project-instruction-facts.ts';
import { isManagedModelSelectable } from '../config/managed-model-allowlist.ts';
import { bashAlwaysAllowRuleContent, bashSessionKeyForRuleContent, bashSessionWhitelistKey } from './core/dangerous-commands.ts'; // UA12.70/UA12.71 — the key, its rule text and the rule-content key
import { getRtkPath } from './core/rtk-detector.ts';
import {
  getAdvisorEnabled,
  getAskUserQuestionTimeoutMs,
  getBrowserToolEnabled,
  getBypassPermissionsAcknowledged,
  getGuardianEnabled,
  getGuardianJudgeModelId,
  getGuardianJudgeModels,
  getLastReviewEffortLevel,
  getLlmConnection,
  getMacosSeatbeltBashSandboxEnabled,
  getOutputStyleId,
  getRtkEnabled,
  getRtkExcludeCommands,
  getUseAutoModeDuringPlan,
  loadConfigDefaults,
  setLastReviewEffortLevel,
  resolvePlansDirectory,
} from '../config/storage.ts';
import { resolveGuardianJudgeModel } from '../config/guardian-judge-model.ts';
import type { RtkContext } from './core/rtk-rewrite.ts';

// Workspace slug extraction for skill qualification
import { extractWorkspaceSlug } from '../utils/workspace.ts';

// LLM tool types
import { LLM_QUERY_TIMEOUT_MS, type LLMQueryRequest, type LLMQueryResult } from './llm-tool.ts';
import { executeBrowserToolCommand } from './browser-tool-runtime.ts';
import { saveBinaryResponse } from '../utils/binary-detection.ts';

// ============================================================
// PiAgent Implementation
// ============================================================

/** The connection shape both gateway-credential decisions below classify on. */
type PiGatewayConnectionShape =
  Pick<BackendConfig, 'providerType'> & { runtime?: { baseUrl?: string } };

/**
 * Is this Pi connection the built-in Nessy Gateway card, rather than a BYO
 * `pi_compat` endpoint the user typed themselves?
 *
 * ONE predicate, read by both gateway-credential decisions in this file: the
 * JWT attach ({@link resolveNestorGatewayJwtForPi}) and the stored-credential
 * fallback's shape gate ({@link isUsablePiStoredCredential}). They must never
 * disagree — a connection the first calls "the gateway" while the second calls
 * it "BYO" is precisely the hole DA1.2 closes, so the classification is written
 * once and both read it.
 *
 * ## DA1.40 — the two questions one predicate used to answer
 *
 * `isNestorGatewayCredentialUrl` answers *"may the dp JWT ride on THIS REQUEST
 * URL"*, and its third arm accepts anything UNDER the chat base
 * (`startsWith(<chat base>/)`) because a chat request really is a path under it.
 * That arm is right for a request and wrong for a CONNECTION: a BYO `pi_compat`
 * card whose endpoint sits under the chat base — `…/openai-like/v1/pi_compat`
 * is the shape the wave-A review measured — passed it, so the shared dp JWT
 * OVERRODE the user's own key on a connection that is not the gateway.
 *
 * So the two questions are split. A CONNECTION is the gateway only on
 * normalised whole-URL equality with the chat base ({@link isNessyGatewayBaseUrl},
 * the same rule `isGatewayBackedConnection` and the model-fetcher router read —
 * and a rule THIS FILE WAS ALREADY IMPORTING, for the context-window read, so
 * the split costs no new dependency at all),
 * while `isNestorGatewayCredentialUrl` keeps the named-endpoint form for REQUEST
 * urls in `unified-network-interceptor.ts` symbol `rewriteNestorAuthHeaders` —
 * untouched, because narrowing it there would stop rewriting the very chat
 * requests the gateway card makes.
 *
 * `isNestorCliBaseUrl` is unchanged too, and stays the predicate for this file's
 * non-credential reader ({@link describeQuota}) and the other prefix sites.
 */
function isNestorGatewayPiConnection(config: PiGatewayConnectionShape): boolean {
  return config.providerType === 'pi_compat'
    && isNessyGatewayBaseUrl(config.runtime?.baseUrl);
}

export function resolveNestorGatewayJwtForPi(
  config: PiGatewayConnectionShape,
  readCreds: () => { jwt: string } | null = getValidCreds,
): string | null {
  if (!isNestorGatewayPiConnection(config)) return null;
  return readCreds()?.jwt ?? null;
}

/**
 * DA1.2 — may the per-connection STORED credential be sent on this connection?
 *
 * `getPiAuth` resolves the gateway JWT first and, when there is none, falls back
 * to `credentialManager.getLlmApiKey(slug)`. On a gateway-classified connection
 * that fallback used to be unconditional, and what carries its value out is
 * `unified-network-interceptor.ts` symbol `rewriteNestorAuthHeaders`, which
 * turns ANY Bearer on the verified gateway prefix into `Nestor-Token`. So an
 * arbitrary stored string — a hand-edit, a key pasted into the wrong card, a
 * snapshot left behind by an earlier BYO life of the same slug — left the
 * machine as the corporate credential and came back as the gateway's own
 * token-parse 401, which reads to the user as "my login is broken".
 *
 * Fail CLOSED instead: a non-JWT value on a gateway connection reads as "no
 * credential", the same outcome as an empty store, and the turn takes the
 * honest no-credential path rather than sending something that cannot work.
 *
 * **BYO `pi_compat` connections are untouched** — an arbitrary key is exactly
 * what belongs there, and narrowing them would break every custom endpoint.
 *
 * **DA1.13 CLOSED THE RESIDUE THIS DOCBLOCK USED TO STATE, by removing the
 * fallback rather than tightening it.** The residue was that `isJwtShaped` is a
 * three-non-empty-dot-segment structural test with no decode and no claim check,
 * so `a.b.c` passed it and a stale — or merely well-formed — snapshot still went
 * out. There is now nothing to shape-test: a gateway card keeps NO stored
 * credential at all. The one-click cards stopped sending one
 * (`apps/electron/src/renderer/components/apisetup/gateway-one-click.ts` symbol
 * `buildGatewaySetup`), the setup RPC refuses the write and deletes any snapshot
 * an older install left behind
 * (`packages/server-core/src/handlers/rpc/llm-connections.ts`), and this
 * predicate now refuses to READ one — which is what makes an install that never
 * re-runs its card safe without a migration sweep, and is why the deleted entry
 * can never be missed.
 *
 * The outcome on a signed-out user is deliberate and is Target scheme clause 1:
 * `getPiAuth` returns null, the turn takes the honest no-credential path, and
 * the 401 raises the dp card with its reason (DA1.4) instead of replaying a
 * credential that cannot work. `auth/dp/creds-store.ts` symbol `getValidCreds`
 * — which checks `expiresAt` AND the shape — stays the only door.
 *
 * **BYO `pi_compat` connections are untouched**, exactly as before: an arbitrary
 * key is what belongs there.
 *
 * **Native mechanism: none**, and the honest note is that we now match the CLI
 * this flow was forked from rather than merely being stricter than it: it keeps
 * ONE credential store and has no per-connection stored key to fall back to,
 * which is the shape this row arrives at.
 */
export function isUsablePiStoredCredential(
  config: PiGatewayConnectionShape,
  apiKey: string,
): boolean {
  if (!isNestorGatewayPiConnection(config)) return true;
  // DA1.13 — `apiKey` is read by no arm any more. It stays in the signature
  // because the call site has one in hand and the refusal it logs is about that
  // value; removing the parameter would make the site read as unconditional.
  void apiKey;
  return false;
}

/** Backend-executed session tools currently supported by PiAgent. */
export const PI_BACKEND_SESSION_TOOL_NAMES = new Set<string>([
  'call_llm',
  // P2.1 — routed in `executeSessionTool` to `BaseAgent.executeAdvisorConsult`.
  // `assertBackendSessionToolParity` THROWS while this set and
  // `SESSION_BACKEND_TOOL_NAMES` disagree, which is why a backend tool added to
  // the registry without a Pi route fails every manifest build rather than
  // reaching a turn as an unimplemented tool.
  'advisor_consult',
  'spawn_session',
  'browser_tool',
]);

export const PI_INIT_FIELD_CLASSIFICATION = {
  hostForwarded: [
    'apiKey',
    'authType',
    'baseUrl',
    'capabilityCatalogKinds',
    'branchFromSdkSessionId',
    'branchFromSdkTurnId',
    'branchFromSessionPath',
    // T7 · the synthesized parent a FIRST switch into Pi forks from. Sent only
    // when the switch wrote one AND it is still loadable at spawn time; the
    // subprocess declines it if Pi already has a session of its own here.
    'carryHistorySessionFile',
    'customEndpoint',
    'customModels',
    'continuationActivatedTools',
    'contextProfile',
    'cwd',
    'deferredMcpToolLoading',
    'executionManifest',
    'filesystemScope',
    'isHeadless',
    'miniModel',
    'model',
    'orchestrator',
    'allowedToolNames',
    'piAuth',
    'piContextResources',
    'piRuntimeAgentDefinitions',
    'plansFolderPath',
    'projectTrusted',
    'providerType', 'resumeSessionFile',
    'sessionId',
    'sessionPath', 'startFresh',
    'thinkingLevel',
    'webSearchesUsed',
    'workflowSizeGuideline',
    'workingDirectory',
    'workspaceId',
    'workspaceRootPath',
  ] as const,
  serverDerived: {
    agentDir: 'server-derived' as const,
  },
  orchestratorFields: [
    'concurrency',
    'depth',
    'maxParallelTasks',
    'maxAgents',
    'tokenBudget',
    'tierModelMap',
    'contextSeed',
    'sessionDepth',
    'sessionIsFork',
    'forkSubagent',
    'availableModels',
  ] as const,
} as const;

export function buildPiInitMessage(input: Record<string, unknown>): Record<string, unknown> {
  const contextProfile = input.contextProfile ?? 'bare';
  if (contextProfile !== 'normal' && contextProfile !== 'bare') {
    throw new Error('Invalid Pi context profile');
  }
  const message: Record<string, unknown> = { type: 'init', contextProfile };
  for (const field of PI_INIT_FIELD_CLASSIFICATION.hostForwarded) {
    if (input[field] !== undefined) message[field] = input[field];
  }
  return message;
}

/**
 * P6.734 — the trigger set is the PAGE's, and the exclusions are the longer
 * half. `model-config.md#fallback-model-chains`, verbatim:
 *
 *   "When the primary model is overloaded, unavailable, or returns another
 *   non-retryable server error, Claude Code can switch to a fallback model
 *   instead of failing the request. Authentication, billing, rate-limit,
 *   request-size, and transport errors, and a denial by your organization's
 *   policy check, never trigger a switch; those follow their normal retry and
 *   error handling."
 *
 * `network_error` WAS in this set and is the one the sentence excludes by name:
 * a transport failure is not a statement about the model, so switching on it
 * spent a chain entry on a problem the next id has too. Codex's ladder
 * (`16b691036`) already reads the same sentence and lands on two members of its
 * own vocabulary, `serverOverloaded` and `internalServerError`; the codes below
 * are those two classes spelled in `ErrorCode`, which happens to need three
 * names for them. Per-code, so the next reader can re-derive the list rather
 * than re-count a sentence:
 *
 * - `service_error`        — "another non-retryable server error"; the only one
 *                            `parsePiError` itself mints (500/502/503/service/
 *                            overloaded), so it is the live arm on this runtime.
 * - `service_unavailable`  — "unavailable", by name.
 * - `provider_error`       — "overloaded", by name (its own `ErrorCode` comment
 *                            reads "AI provider experiencing issues (overloaded,
 *                            unavailable)").
 * - `invalid_model`        — the WALK's own sentence, same page: "An entry that
 *                            can't be reached either, such as a retired model
 *                            pinned in settings, fails over to the next one the
 *                            same way." This walk resumes at the cursor, so the
 *                            code has to be admitted here to reach it.
 * - `model_no_tool_support` — the one the page does NOT settle. Searched
 *                            `model-config.md` and `errors.md`: no sentence
 *                            names a tool-support refusal either way. Kept,
 *                            deliberately and narrowly: it is absent from the
 *                            exclusion list above, and a model that will not
 *                            accept tools cannot run this turn at all, which is
 *                            the "can't be reached" the walk sentence covers.
 *                            Recorded rather than invented in either direction.
 *                            P6.743 measured that it FIRES (the Pi SDK's
 *                            `stopReason: 'error'` → `parseError` → `typed_error`
 *                            → this set) and surfaced the resulting divergence
 *                            from codex at the switch, as `toolSupportFallback`.
 */
const FALLBACK_MODEL_RETRY_ERROR_CODES = new Set<AgentError['code']>([
  'invalid_model',
  'model_no_tool_support',
  'service_error',
  'service_unavailable',
  'provider_error',
]);

/**
 * Hook loop-guard thresholds. Hook deny reasons may be DYNAMIC (timestamps,
 * rate-limit counters, command echoes), and one generic reason may deny many
 * DIFFERENT inputs while the model legitimately explores alternatives — so no
 * single counter can both catch loops and avoid false stops. Two levels:
 * - PRE_TOOL_HOOK_DENY_LOOP_THRESHOLD caps a true retry loop, keyed by
 *   (tool, input hash, reason): the SAME call re-denied for the SAME reason.
 * - PRE_TOOL_HOOK_DENY_TOTAL_THRESHOLD caps the per-tool TOTAL of hook denies
 *   regardless of input/reason — the backstop for dynamic-reason loops the
 *   primary key never sees twice, and for pathological input churn.
 * At a threshold the deny reason gains one final-notice reminder; the next
 * deny past it stops the turn with a visible diagnostic (the block/deny
 * re-feed loop lives in the SDK subprocess, so the host reply is the only
 * controllable escape hatch).
 */
const PRE_TOOL_HOOK_DENY_LOOP_THRESHOLD = 3;
const PRE_TOOL_HOOK_DENY_TOTAL_THRESHOLD = 10;

/**
 * hooks.md#permissiondenied: `{retry: true}` re-runs the permission decision.
 * ONE retry per tool call — the retry re-dispatches through the same authorize
 * path, so this bound is the only thing that terminates a hook which keeps
 * asking, and an unbounded retry is a prompt loop.
 */
const MAX_PERMISSION_DENIED_RETRIES = 1;

/**
 * UB2.10 (B2-12; v0.15.1 "Stop ends only the reply") — the abort reasons a DETACHED proxy call (R10's background MCP task) survives in
 * {@link PiAgent.forceAbort}: every reason Claude answers with the SDK's `interrupt()`, query and background tasks kept — the turn-scoped
 * two `ClaudeAgent.forceAbort` interrupts and (UB12.13) the two handoffs `ClaudeAgent.interruptForHandoff` interrupts the same way, which
 * Pi routes through `forceAbort` (F1.1242). Any other reason is session death on Claude and stops the detached calls here too.
 */
const PI_DETACHED_CALL_SURVIVING_ABORT_REASONS: ReadonlySet<AbortReason> = new Set([AbortReason.UserStop, AbortReason.MaxBudgetUsd, AbortReason.PlanSubmitted, AbortReason.AuthRequest]);

/**
 * Stable, key-order-insensitive digest of a tool input for the loop-guard
 * primary key, so a retried call hashes identically even if the argument
 * object is re-serialized with a different key order.
 */
/**
 * Maps a `setMode` value from a PermissionRequest hook's `updatedPermissions`
 * onto our mode vocabulary (R15 Task 3). Accepts Claude's documented names
 * (`default`, `manual`, `acceptEdits`, `auto`, `dontAsk`, `plan`,
 * `bypassPermissions`) and our native spellings; anything else is refused by
 * the caller with a diagnostic.
 */
function mapClaudeModeToPermissionMode(value: unknown): PermissionMode | undefined {
  if (typeof value !== 'string') return undefined;
  // Resolves through the ONE shared alias table in mode-types.ts (via
  // `parsePermissionMode`) — this function used to own a private list that
  // was disjoint from the parser's, and two lists over the same vocabulary
  // WILL drift.
  return parsePermissionMode(value) ?? undefined;
}

/**
 * The prompt-gating events, in the order the turn reaches them.
 *
 * hooks.md § UserPromptSubmit: the event "Runs when the user submits a prompt,
 * before Claude processes it", once per turn.
 *
 * R73 REMOVED `UserPromptExpansion` FROM THIS GATE. The two events share a
 * decision row in hooks.md § Decision control, which is what put them on one
 * gate — but they do not share an OCCURRENCE. `UserPromptExpansion` "Runs when
 * a user-typed command expands into a prompt", so a plain typed message must
 * produce none, and a turn-scoped gate has no command name, args or source to
 * report. It now fires from the expansion site itself
 * (`SessionManager.emitUserPromptExpansion`, from the SEND_MESSAGE handler),
 * where a block can still prevent the expansion. `hookBlockEndsTurn` continues
 * to report it always-terminal; that is about what a block cancels, not about
 * where the event fires.
 */
const PI_PROMPT_GATE_EVENTS: readonly AutomationAgentEvent[] = ['UserPromptSubmit'];

/**
 * Subprocess `automation_event` echoes the host must never re-run.
 *
 * Deliberately a SUPERSET of `PI_PROMPT_GATE_EVENTS` rather than the same
 * constant. `UserPromptExpansion` is here even though the current bridge no
 * longer emits it: the packaged Pi bundle is a prebuilt artifact
 * (`apps/electron/resources/pi-agent-server/index.js`), so a host running
 * against an older bundle would otherwise start firing the very per-turn,
 * content-free copy R73 removed. Dropping a name nothing sends costs nothing;
 * running it costs the user a hook on every turn.
 */
const PI_ECHO_DROPPED_AGENT_EVENTS: readonly AutomationAgentEvent[] = [
  'UserPromptSubmit', 'UserPromptExpansion',
];

/**
 * Outer bound on the prompt gate, above every documented per-hook budget.
 *
 * hooks.md § Common fields, `timeout`: "Seconds before canceling. Defaults: 600
 * for `command`, `http`, and `mcp_tool`; 30 for `prompt`; 60 for `agent`.
 * `UserPromptSubmit` lowers the `command`, `http`, and `mcp_tool` default to
 * 30". Each runner enforces its own budget, so an imported hook answers this
 * gate within 30s; this bound only catches a dispatch that never settles at
 * all. It sits above the 600s ceiling so a correctly-budgeted hook is never cut
 * short — a gate still silent past it is stuck, not slow.
 *
 * Reaching it fails CLOSED. hooks.md § UserPromptSubmit documents the opposite
 * for a command/http/mcp_tool timeout — the output "is discarded. The prompt
 * still reaches Claude without that context" — but the same section documents
 * the fail-closed rule for the callback form and says why: "a callback there
 * can be acting as a policy gate that must not fail open". A managed prompt
 * hook here is that policy gate, so it takes the fail-closed half.
 */
const PI_PROMPT_GATE_TIMEOUT_MS = MAX_HOOK_TIMEOUT_MS + 5_000;

/**
 * THE ONE PLACE a hook's `additionalContext` becomes prompt text on this
 * runtime (P2.225). NOT the one place hook-authored text does — see the two
 * uncovered neighbours at the end.
 *
 * `additionalContext` is a hook's STDOUT — a shell script's bytes, and often not
 * even the script's own words (a `git log`, a linter's report, a file it
 * cat-ed). Pi composed it RAW: the `SessionStart` body into `fullSystemPrompt`
 * via `.filter(Boolean).join('\n\n')` — the SYSTEM block, the most trusted band
 * any of the three runtimes put it in — and the `UserPromptSubmit` body into
 * `buildTurnUserMessage`'s tail. No element, no fence, no defang. Measured on
 * this exact path before the fence, with a benign-control differential on the
 * same tree: 16 of 16 forgeries landed byte-for-byte in BOTH bands.
 *
 * Same mitigation as the two siblings and REUSED rather than reinvented —
 * `nestor-cloud-agent.ts:applyPromptHooks` (P2.31) and `codex-agent.ts` (P2.59)
 * compose the byte-identical expression: the outer `<hook_context>` element plus
 * `untrusted-text.ts:wrapUntrusted`'s `<untrusted source="...">` fence with the
 * body through `neutralizeHarnessMarkers`. Not
 * `base-agent.ts:fenceUntrustedTranscript` — that seam FORMATS
 * `RecoveryMessage[]` into `[User]:`/`[Assistant]:` turns, and hook stdout is not
 * a transcript; only the fence itself is shared.
 *
 * A FUNCTION rather than the siblings' inline expression, because Pi has FOUR
 * readers of hook stdout where they have one: the session body reaches the
 * system prefix, the prompt body reaches both the user tail AND the workflow
 * dispatch, and the post-compaction `SessionStart` body reaches the tail through
 * its own one-shot queue. Four hand-copied fences is three chances to paste it
 * with the defang left off, which is the defect this row exists to close.
 *
 * ## What this buys, stated at exactly its measured size
 *
 * CONTAINMENT, not content prevention. RE-MEASURED HERE rather than imported
 * from the sibling, and the numbers are NOT the sibling's: 16 probes, 6 blocked
 * and 10 still reaching the model byte-for-byte, in BOTH bands. P2.59 read 4 of
 * 16 on codex; the difference is probe accounting, not a different guarantee —
 * the six blocked here are the defanger's three `HARNESS_TAG` names in BOTH
 * directions (`<untrusted`, `<system-reminder`, `<nessy_agent_environment` and
 * each closing form). THE RULE IS THE INVARIANT, NOT THE COUNT: exactly the
 * three names are neutralized, and nothing else is. A body can still fabricate a
 * whole tool call and its result, a `<sources>` naming a production database, a
 * `<session_state>` claiming `bypassPermissions`, a `[User]:` transcript entry
 * and a `<hook_feedback>` element.
 *
 * `<\u0001system-reminder>` USED to pass here, and this paragraph said so until
 * P2.266 corrected it. It does not any more: P2.226 closed that shared-helper
 * gap one layer BELOW `wrapUntrusted`, in
 * `untrusted-text.ts:neutralizeHarnessMarkers`, so every fence in the repo
 * gained the strip in one commit rather than this call site being unable to
 * close it. Re-driven through `fenceHookBand` on this band rather than inferred
 * from the row (2026-09-03): a `<\u0001system-reminder>` body, a
 * `<\u000bsystem-reminder>` body and a `</\u0001untrusted>` body all come out
 * neutralized, and the fence still carries exactly ONE closer — with the plain
 * `<system-reminder>` control neutralized on the same rig, so the probe is
 * reading the real defang and not an absence. The 6-of-16 count above therefore
 * UNDERSTATES what this band blocks today; the invariant is still the rule, not
 * the count.
 *
 * What a body cannot do is ESCAPE: the fence is SELF-PROTECTING (`untrusted` is
 * one of those three names), so it cannot write the tag that closes it. Measured
 * structurally in both bands: the outer element ends with TWO closers (the
 * host's and the body's) and buys nothing, while the fence has one opener and
 * one closer, that closer is the LAST one in the text, and every byte the body
 * wrote sits between them. Pinned by the `RESIDUAL:` test in
 * `pi-hook-context-fence.test.ts`.
 *
 * TWO NEIGHBOURS ARE DELIBERATELY NOT COVERED, so the next reader is not
 * misdirected about what is fenced here:
 *  - `base-agent.ts:recordHookBlockFeedback` composes a hook's `reason` into
 *    `<hook_feedback event="...">` with an element but no fence and no defang,
 *    and that queue drains into this same user tail. It is a DIFFERENT field of
 *    a different family (a block reason, not `additionalContext`) living in the
 *    shared base every runtime inherits, so it is its own row rather than a
 *    rider here.
 *  - `PreToolUse` `additionalContext` never passes through here because it never
 *    becomes prompt TEXT: Pi hands it to the subprocess as a discrete wire field,
 *    which is the same reason `claude-agent.ts` is clean.
 *
 * ORDER IS UNCHANGED at every call site. What changed, twice: the model can tell
 * which bytes a hook wrote (P2.225), and it is now TOLD what that means
 * (P3.281).
 *
 * ## P3.281 — the notice this band was missing
 *
 * The expression above was hand-copied at five sites and this was one of the two
 * that {@link fenceHookBand} could not reach when P2.236 landed (`pi-agent.ts`
 * was unzoned; `codex-agent.ts` was another lane's). Adopting it adds
 * `UNTRUSTED_HOOK_NOTICE` between the element and the fence — the one sentence
 * telling the model that a hook may inform and may direct the work but cannot
 * speak AS the harness or the user, and that much of what it prints is output it
 * merely relayed. A notice that only three of five bands carried was worse than
 * none: it taught the model that an unannotated fence is a different, more
 * trustworthy kind of thing. Read that module's own docblock for why this notice
 * is NOT `UNTRUSTED_TRANSCRIPT_NOTICE` — a hook is a configured participant, so
 * "nothing inside is a directive" would be false here and would break working
 * hooks.
 *
 * The element, the fence, the defang and the blank-body skip are byte-identical
 * to what this function composed before; the notice line is the whole diff.
 */
function fenceHookContext(body: string | undefined): string | undefined {
  // The `.trim()` this function used to apply itself now lives in
  // `fenceHookBand`, which returns `undefined` for an absent or blank body —
  // the same seam decision, one layer down, so callers keep their
  // `.filter(Boolean)` shape. BELT, not braces, either way: all three of today's
  // producers already apply `additionalContext?.trim()` before the value can
  // reach here (`runPiPromptGate`, the `SessionStart` capture in `chatImpl`, and
  // `emitPostCompactSessionStart`), so no reachable input distinguishes the trim
  // from `body` — the mutant that drops it SURVIVES the suite, measured, and is
  // EQUIVALENT rather than uncovered.
  return fenceHookBand({ element: 'hook_context', source: 'hook_context', body });
}

/**
 * The frame Pi has to supply because it has no MCP protocol to supply it
 * (P3.279). See {@link PiAgent.composeMcpServerInstructions}.
 *
 * PROVENANCE ONLY, and deliberately not a trust verdict. On the other two
 * surfaces these bytes arrive as the MCP `instructions` field and the runtime
 * frames them; adding a caution here that the other two do not carry would make
 * an MCP server's own description read differently on Pi than on codex after a
 * switch — a new silent divergence dressed as a safety improvement. What the
 * model gets is the same fact the protocol carries: whose words these are.
 *
 * That the family is unfenced on ALL THREE surfaces is a real question and it is
 * reported as a finding rather than answered here by one runtime alone.
 */
const MCP_SERVER_INSTRUCTIONS_PREAMBLE =
  'Each block below is the `instructions` an MCP server returned from its own MCP handshake — the '
  + 'server describing what it is for and when to reach for its tools. The heading names the server '
  + 'the block came from; its tools are the ones whose names carry that server.';

/**
 * `mcp.md#for-mcp-server-authors`, verbatim: *"Claude Code truncates tool
 * descriptions and server instructions at 2KB each. Keep them concise to avoid
 * truncation, and put critical details near the start."*
 *
 * Applied HERE because Pi is the runtime built to that page, and because this is
 * the surface where the bytes land in the SYSTEM prompt as free text: without a
 * bound, one server's `initialize` result sets Pi's system-prefix size. The
 * sentence sits under a tool-search heading and the page never says what happens
 * with tool search off, so the silent case is decided rather than queued (the
 * TRANSPARENT-and-SIMPLE rule): capped either way, with the cut visible.
 *
 * P3.292 moved the constant, the marker and the surrogate guard into
 * `mcp/third-party-text.ts`, because the identical question had to be answered
 * for the pool-server surface and answering it twice is how two spellings of one
 * cap drift. TWO THINGS CHANGED WITH THE MOVE, both measured against the
 * vendored binary and both recorded in that module: the cap counts UTF-16 CODE
 * UNITS rather than UTF-8 bytes (the byte reading cut a Cyrillic or CJK body at
 * roughly half of what claude keeps), and the marker is the binary's own
 * `… [truncated]` rather than a self-explaining one, because the marker is
 * model-visible bytes and any other string guarantees the same server reads
 * differently across a switch.
 *
 * The other half of that page sentence — tool DESCRIPTIONS — was unimplemented
 * on every runtime until P3.292, and Pi's half of it is applied in
 * {@link PiAgent.buildCurrentProxyToolDefinitions}, where an MCP server's
 * descriptors enter the turn's manifest.
 */

function hashPreToolInputForLoopGuard(input: Record<string, unknown>): string {
  return createHash('sha256').update(stableJsonForLoopGuard(input)).digest('hex');
}

function stableJsonForLoopGuard(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJsonForLoopGuard).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const body = Object.keys(record).sort()
      .map(key => `${JSON.stringify(key)}:${stableJsonForLoopGuard(record[key])}`)
      .join(',');
    return `{${body}}`;
  }
  // `undefined` (and other non-JSON primitives) normalize to null so the
  // digest is total.
  return JSON.stringify(value ?? null);
}

type PiChatOptions = ChatOptions & {
  /**
   * Cursor into the fallback chain: the index of the entry this re-entry is
   * already running on. Absent = this is the PRIMARY turn, which owns the
   * model-turn budget and restores the primary model when it ends.
   *
   * A cursor and not the boolean it replaced, because `model-config.md:364`
   * makes the chain ordered — "tries them in order" needs to know which entry
   * was already tried, and a boolean caps the walk at one hop.
   */
  fallbackChainIndex?: number;
};

interface PiWorkflowExecutionResult {
  content: string;
  details?: unknown;
}

/** The admitted fork behind a `/subtask` (sub-agents.md:1013). */
interface PiSubtaskForkStart {
  agentId: string;
  name: string;
}

interface PiProxyToolResult {
  content: string;
  isError: boolean;
  structuredContent?: Record<string, unknown>;
  /**
   * P6.617 — the non-text blocks a registry tool returned alongside its text
   * (P6.345's `ToolResult.extraContent`).
   *
   * The wire half of the merge: the child's
   * `proxy-tool-result.ts:proxyExecutionResultToAgentToolResult` appends an
   * image to Pi's own `(TextContent | ImageContent)[]` content and sidecars a
   * resource block, and it can only do that for a field this producer sets.
   * Without it Pi's DIRECT route silently dropped what the same tool delivers
   * fine over MCP.
   */
  extraContent?: NonTextContent[];
}

interface PiBashOutputResult {
  shellId: string;
  output: string;
  nextOffset: number;
  isRunning: boolean;
}

function hasStructuredContent(value: unknown): value is Record<string, unknown> {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length > 0;
}

type FallbackRetryError = Pick<AgentError, 'code' | 'title'>;

type PendingPermission =
  | {
      kind: 'permission';
      resolve: (response: { allowed: boolean; updatedInput?: Record<string, unknown> }) => void;
      toolName: string;
    }
  | {
      kind: 'ask_user';
      resolve: (response: { answer?: AskUserAnswer; error?: string }) => void;
      toolName: 'ask_user';
      askUser: AskUserPermissionRequest;
      subprocessRequestId: string;
    }
  | {
      kind: 'outside_root';
      toolName: string;
      canonicalTarget: string;
      access: 'read' | 'write';
    };

/**
 * Map a transport `err.code` to an agent-facing string for `browser_tool` failures.
 * Returns null for unknown codes so callers can fall back to the raw `err.message`.
 *
 * Receiver-side check: keyed on `err.code === 'X'`, never `instanceof CodedError` —
 * the transport reconstructs a plain `Error` with `.code` attached.
 *
 * `message` is the sender's own sentence. Every case here REPLACES it, because
 * the codes above carry everything the model needs; the one exception is
 * `BROWSER_MANAGED_DISABLED`, whose sentence names WHICH administrator's
 * document decided — a fact no code can carry and the only actionable thing in
 * the refusal (P2.464).
 */
function mapBrowserToolErrorCode(code: string, message: string): string | null {
  switch (code) {
    case 'BROWSER_NO_CAPABLE_CLIENT':
    case 'CAPABILITY_UNAVAILABLE':
      return 'No connected desktop client supports browser tools, or no client is currently connected. ' +
        'Ask the user to open this workspace from the Nessy Desktop app.';
    case 'CLIENT_DISCONNECTED':
      return 'The desktop client that owned this browser session disconnected. ' +
        'Ask the user to reconnect and retry.';
    case 'CLIENT_REQUEST_TIMEOUT':
      return 'Browser operation timed out (>30s). The desktop client may be unresponsive.';
    case 'BROWSER_INSTANCE_NOT_OWNED':
      return 'That browser instance ID doesn\'t belong to this session. ' +
        'Use `windows` to list owned instances, or `open` to create a new one.';
    case 'BROWSER_REMOTE_UPLOAD_NOT_SUPPORTED':
      return 'File upload from a remote agent is not supported. ' +
        'Ask the user to attach the file to the session.';
    case 'BROWSER_REMOTE_EVALUATE_BLOCKED':
      return 'JavaScript evaluation is disabled on this desktop client. ' +
        'Ask the user to enable it in settings.';
    // P2.464. Deliberately NOT 'ask the user to enable it': this one cannot be
    // enabled from the app, and telling the model otherwise sends it into a
    // retry loop against a policy. The sender's sentence is KEPT rather than
    // replaced — it names the administrator's document, which is the only
    // actionable half — and the do-not-retry instruction is added to it.
    case 'BROWSER_MANAGED_DISABLED':
      return `${message} Do not retry: say so and continue without the browser.`;
    default:
      return null;
  }
}

/**
 * CI2 — Edit-feedback runner. On a PostToolUse for an edit/write tool the
 * PiAgent invokes this (when trust-gated + enabled by the server) to run the
 * project's own linter/typechecker on the changed file and return BOUNDED
 * OBSERVATIONAL text. The server owns detection + the ProcessSupervisor
 * `workspace` spawn; the agent only decides when to invoke and where to fold
 * the result. Fail-soft: any error resolves to `undefined` and never blocks a
 * tool. Returns `undefined` when there is nothing to report.
 */
export type EditFeedbackRunner = (event: {
  toolName: string;
  toolInput: Record<string, unknown>;
  signal?: AbortSignal;
}) => Promise<string | undefined>;

/**
 * CI1 — Format runner. When the agent calls the `format` op, the PiAgent invokes
 * this (present only when the server trust-gated + enabled it) to detect the
 * project's configured formatter and run it on the target file. The server owns
 * detection + the ProcessSupervisor `workspace` spawn (the SAME seam CI2 uses);
 * the agent only routes the call. Returns a BOUNDED human-readable result string
 * (formatted / no formatter configured / binary absent — never installs, never
 * throws). Present only when the project is trusted AND the feature is enabled,
 * so an untrusted project can never trigger a host-tool spawn.
 */
export type FormatRunner = (event: {
  path: string;
  signal?: AbortSignal;
}) => Promise<string>;

/**
 * CI1 — the agent-facing `format` proxy tool. Additive: it does NOT touch the
 * LSP tool or its schema union. Projected only when a `formatRunner` is present.
 */
const FORMAT_PROXY_TOOL_DEF: ProxyToolDef = {
  name: 'format',
  description: 'Format a file with the project\'s own configured formatter (e.g. Biome, Prettier, Ruff, rustfmt, clang-format), detected from its config markers. Works without a language server. Does nothing if no formatter is configured or its binary is not installed — it never installs one.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: {
      path: { type: 'string', minLength: 1, description: 'Workspace-relative or absolute path of the file to format.' },
    },
  },
};

/**
 * Backend implementation using the Pi coding agent SDK via subprocess.
 *
 * Spawns a pi-agent-server subprocess and communicates via JSONL protocol.
 * Extends BaseAgent for common functionality (permission mode, source management,
 * planning heuristics, config watching, usage tracking).
 */
export class PiAgent extends BaseAgent {
  private spawnProcess = spawn;
  protected backendName = 'Nessy Backend';

  /**
   * CI2 edit-feedback runner (server-injected). Null unless the project is
   * trusted AND the feature is enabled — the server gates injection identically
   * to LSP, so an untrusted project can never trigger a host-tool spawn here.
   */
  editFeedbackRunner: EditFeedbackRunner | null = null;

  /**
   * CI1 format runner (server-injected). Null unless the project is trusted AND
   * the feature is enabled — the server gates injection identically to LSP, so
   * an untrusted project never exposes the `format` op and can never trigger a
   * host-tool formatter spawn. When non-null, the `format` proxy tool projects.
   */
  formatRunner: FormatRunner | null = null;

  /** P10: bounded insertion-ordered queue; values retain no file paths. */
  private pendingEditFeedback = new Map<string, { ready: boolean; diagnostics?: string }>();
  private static readonly MAX_PENDING_EDIT_FEEDBACK = 32;
  private static readonly MAX_EDIT_FEEDBACK_CHARS = 16 * 1024;

  // ============================================================
  // Subprocess State
  // ============================================================

  // Subprocess process handle
  private subprocess: ChildProcess | null = null;
  private activeExecutionManifest: PiExecutionManifestV2 | null = null;
  private lastExecutionManifestIdentity: { generation: string; manifestHash: string } | null = null;
  private readline: ReadlineInterface | null = null;
  private subprocessAttempt: PiSubprocessStartupAttempt | null = null;
  private subprocessAttemptId = 0;
  private subprocessResponseEpoch = 0;
  private subprocessTermination: Promise<void> | null = null;
  private subprocessTerminationState: 'running' | 'failed' | null = null;
  private pendingSubprocessTerminations: Array<{
    child: ChildProcess | null;
    readline: ReadlineInterface | null;
  }> = [];
  private workingDirectoryGeneration = 0;
  private workingDirectoryTransaction: PiWorkingDirectoryTransactionState | null = null;
  // Orchestrator config pinned to the value the live subprocess was initialized
  // with. The subprocess pins its own orchestrator (and child-spawner config) at
  // init and cannot adopt a new one without a respawn, so every manifest we
  // register for that subprocess must carry the SAME orchestrator — otherwise a
  // mid-session capability refresh that shifts the seed orchestrator (a
  // working-directory rebind rewriting the contextSeed, a tierModelMap/sessionDepth
  // change) fails register_tools with "orchestrator mismatch" and kills the turn.
  // Captured on the first manifest build after a (re)spawn; reset in
  // beginSubprocessAttempt so a fresh subprocess re-pins from the current runtime.
  private subprocessOrchestrator: PiOrchestratorConfig | null = null;

  // Pi session ID (managed by subprocess, reported back)
  private piSessionId: string | null = null;

  // F1.710 — no callback port: the subprocess runs no `/call-llm` listener any
  // more, so `ready` carries none (see pi-agent-server's "No callback server").
  private piModelTurnsThisChat = 0;
  private maxPiModelTurnsThisChat = 0;
  /**
   * The model to return to when the current turn ends — `model-config.md:364`'s
   * "the switch lasts for the current turn only". Set at the first fallback hop
   * and cleared by the owning `chatImpl`; `undefined` means no walk happened,
   * which is every ordinary turn.
   */
  private fallbackChainPrimaryModel: string | undefined = undefined;
  /** The chain entry the walk last switched TO, so the restore can tell its own switch from anyone else's. */
  private fallbackChainActiveModel: string | undefined = undefined;
  private rawEventAttemptTerminal = false;

  // State
  private _isProcessing: boolean = false;
  private abortReason?: AbortReason;

  /**
   * Tool-call count of the most recent assistant message (R7 Task 5). The
   * subprocess completes the assistant message (message_end) before executing
   * its tool calls, so by the time a pre_tool_use_request arrives this holds
   * the size of the batch the call belongs to. `defer` is honored only when
   * it is <= 1 — "resume can only re-run one tool" (hooks.md).
   */
  private lastAssistantToolCallCount = 0;
  /**
   * Text of the last completed assistant message, for Stop's
   * `last_assistant_message` (hooks.md `:2192`). Reset per turn so a Stop can
   * never report the previous turn's response as this turn's.
   */
  private lastAssistantMessageText: string | undefined;
  private stopHookEmittedForTurn = false;
  private stopFailureHookEmittedForTurn = false;
  // Lifecycle hook bookkeeping: SessionStart fires once per session (not per
  // turn), SessionEnd fires once on real teardown (destroy) or a session
  // boundary (clearHistory) — never in the per-turn chatImpl finally.
  private _sessionStartEmitted = false;
  private _sessionEndEmitted = false;
  private _sessionStartHooksApplied = false;
  private _sessionHookContext: string | undefined;
  /**
   * hooks.md#sessionstart `source`: "How the session started: `startup` for new
   * sessions, `resume` for resumed sessions, `clear` after `/clear`, `compact`
   * after compaction, or `fork`". `startup`/`resume` are derivable from the Pi
   * session id at emission time; `clear` is a fact only the transition that
   * caused it knows, so it is latched here and consumed by the next emission.
   */
  private _nextSessionStartSource: 'clear' | undefined;
  /**
   * The in-flight post-compaction `SessionStart` emission. Compaction completes
   * on the subprocess event stream, which is synchronous, so the hook run is
   * held here and awaited by the next turn before it composes — otherwise a hook
   * that is still running when the user types loses its turn silently.
   */
  private _postCompactHookEmission: Promise<void> | undefined;
  /** Post-compaction hook context queued for exactly one following turn. */
  private _pendingCompactHookContext: string[] = [];
  /** Outer bound on the prompt gate; a field so a test can shorten the wait. */
  private promptGateTimeoutMs = PI_PROMPT_GATE_TIMEOUT_MS;

  getHarnessDiagnostics(): import('@nessy-agent/core/types').PiHarnessManifestDiagnosticsV1 | undefined {
    const manifest = this.activeExecutionManifest;
    if (!manifest) return undefined;
    return Object.freeze({
      surfaceVersion: 2,
      generation: manifest.snapshotGeneration.slice(0, 256),
      manifestHash: manifest.manifestHash.slice(0, 256),
      provenance: Object.freeze(manifest.provenance.slice(0, 50).map(value => `${value.capabilityKey}@${value.generation}`.slice(0, 256))),
      contextProfile: this.config.contextProfile ?? 'bare',
      responseEpoch: this.subprocessResponseEpoch,
    });
  }

  // Event adapter
  private adapter: PiEventAdapter;

  // Event queue for streaming (AsyncGenerator pattern over subprocess JSONL)
  private eventQueue = new EventQueue();

  // P2.66 — the broken-debug-sink floor, declared HERE rather than beside
  // `debug()` 8,700 lines down: field initializers run in declaration order, and
  // a latch that only works because it happens to be declared after
  // `eventQueue` is a correctness argument nobody can see. See
  // `reportBrokenDebugSink` for what these two mean.
  private debugSinkFaultSurfaced = false;
  private pendingDebugSinkFaultRow: AgentEvent | null = null;

  /**
   * P2.66 — the per-turn queue reset, and the one thing it must not throw away.
   *
   * `EventQueue.reset()` drops every queued event (`backend/event-queue.ts:42`).
   * A floor row enqueued with NO TURN IN FLIGHT is therefore destroyed unread by
   * the next turn's reset — and the latch had already been spent, so nothing was
   * ever reported again. MEASURED on this rig, in both directions: reset → swallow
   * delivers the row; swallow → reset → two more swallows delivers NOTHING with
   * the latch `true`. That is not a corner: the subprocess is spawned lazily, and
   * four of `ensureSubprocess`'s callers run outside a turn
   * (`requestEnsureSessionReady`, `requestContextUsage`, `queryLlm`,
   * `prepareWorkingDirectoryUpdate`) — the same paths behind the three message
   * types the floor exists for.
   *
   * So the row is re-posted after every reset until it has actually been
   * DELIVERED to the turn's consumer (`noteDebugSinkFaultRowDelivered`), not
   * merely enqueued. Every `eventQueue.reset()` in this class must go through
   * here for that to hold.
   */
  private resetEventQueueForTurn(): void {
    this.eventQueue.reset();
    if (this.pendingDebugSinkFaultRow) this.eventQueue.enqueue(this.pendingDebugSinkFaultRow);
  }

  /**
   * P2.66 — the floor row is spent only when the turn actually hands it to its
   * consumer. Called from `chatImpl`'s drain loop at the point where both
   * remaining branches yield, so "cleared" means "yielded on the next
   * statement": everything that can abandon an event (the source-activation
   * pre-fire, the budget abort, the typed-error fallback) has already been
   * checked above it.
   */
  private noteDebugSinkFaultRowDelivered(event: AgentEvent): void {
    if (event === this.pendingDebugSinkFaultRow) this.pendingDebugSinkFaultRow = null;
  }

  // Error deduplication — suppress identical consecutive errors after a threshold
  // to prevent a broken subprocess from flooding the user's session.
  private lastSubprocessError: string | null = null;
  private subprocessErrorRepeatCount = 0;
  private static readonly MAX_IDENTICAL_SUBPROCESS_ERRORS = 3;

  private resetSubprocessErrorDedup(): void {
    this.lastSubprocessError = null;
    this.subprocessErrorRepeatCount = 0;
  }

  // P2.41 — the same suppression for a THROWING event handler, on its own
  // fields and deliberately NOT reset by `resetSubprocessErrorDedup`: that pair
  // is reset by every non-`error` line in `handleLine`, which is every event, so
  // sharing it would mean no suppression at all on the busiest wire.
  //
  // What the bound IS, measured — and it is not a lifetime tally. This comment
  // used to say "one visible row per distinct fault per agent"; that is false.
  // A LAST-SIGNATURE dedup surfaces at most 3 CONSECUTIVE identical faults, and
  // a different fault in between RESETS the count: 6 identical faults give 3
  // rows, but 12 alternating X,Y,X,Y… faults give 12, and 5xX then one Y then
  // 5xX gives 3 + 1 + 3. So it bounds the case that would actually flood a
  // session — one fault repeating per event — and deliberately does not bound
  // how many DISTINCT faults a session may surface. The debug channel still
  // keeps every occurrence either way.
  //
  // P2.54 widened this pair from the `event` belt to EVERY swallowed dispatch
  // fault (the caller now supplies the signature), so the bound was SHARED: an
  // alternating host-callback fault and event fault reset each other's count,
  // exactly as two alternating event faults already did.
  //
  // P2.66 — and that is the case the widening made likely rather than exotic.
  // MEASURED on the belt rig: a broken `onPiContinuationBoundary` and a broken
  // `onPiWebSearchUsage` alternating over 10 cycles produced **20 error rows** —
  // the bound never engaged once, because each fault was always "different from
  // the last one". One broken host sink plus one broken adapter in the same
  // session is enough to defeat the suppression entirely, and both are ordinary
  // programming errors, not adversarial input.
  //
  // So the count is PER SIGNATURE now. Each distinct fault gets its own
  // allowance of `MAX_IDENTICAL_DISPATCH_FAULTS`, and no other fault can refill
  // it. That is strictly TIGHTER than the last-signature slot in every case (a
  // signature's allowance is spent once instead of being reset by any neighbour)
  // and identical for the single-fault case the old comment described.
  //
  // The map is bounded because its key is a string the SUBPROCESS can vary: the
  // signature carries the thrown value's own message, and a handler that
  // interpolates a per-message id into its error mints a new key every line. The
  // bound is `MAX_TRACKED_DISPATCH_FAULT_SIGNATURES` entries, evicted
  // least-recently-seen (each occurrence re-inserts its key, so the map's
  // iteration order IS the recency order). Why that is safe: eviction only
  // forgets a COUNT, so the worst an evicted signature can do is surface up to
  // three more rows — the same thing a genuinely new fault does. It cannot
  // suppress anything that was going to be reported. What the bound does NOT do
  // is cap how many DISTINCT faults a session may surface: that was never
  // bounded (a fault whose text changes every line is one row per line, before
  // this change and after it), and bounding it would mean deciding that a stream
  // of different faults is less interesting than a repeated one.
  private readonly subprocessDispatchFaultCounts = new Map<string, number>();
  private static readonly MAX_IDENTICAL_DISPATCH_FAULTS = 3;
  private static readonly MAX_TRACKED_DISPATCH_FAULT_SIGNATURES = 32;
  private static readonly MAX_DISPATCH_FAULT_SIGNATURE_CHARS = 200;

  /**
   * Put a swallowed dispatch fault where a user (and a bug report) can see it,
   * without letting a per-event fault flood the session.
   *
   * An `error` AgentEvent becomes an error ROW in the transcript and does not
   * complete the turn, so the remaining events of the turn still arrive — the
   * whole point of the belts that call this.
   *
   * The caller passes the dedup `signature` and the user-facing `message`
   * separately because the three call sites describe three different things —
   * an event that was dropped, an update the app never received, a message whose
   * whole dispatch was abandoned — and a single sentence for all three would be
   * wrong for at least two of them.
   *
   * P2.66 — the bound is per signature; see the field comment for what that
   * changes and what it deliberately does not. Nothing in here may throw: two of
   * the three call sites are a belt's own catch, where a throw is not caught by
   * the try it belongs to and takes the stdout chunk tail with it. `Map` reads
   * and writes on a string key, an integer compare and `EventQueue.enqueue`
   * (push + resolve) are the only operations, and the caller has already
   * rendered both strings through `describeThrown`.
   */
  private surfaceSubprocessFault(signature: string, message: string): void {
    // The key is bounded in LENGTH as well as in count: the signature carries a
    // thrown value's own message, which a handler may build out of subprocess
    // input of any size.
    //
    // P2.76 (M-4 of P2.66's re-review) — a bare prefix slice made that bound
    // cost information, and the trade it was justified with was a false
    // dichotomy. `describeThrown` does NOT truncate — it returns `error.message`
    // whole — so "unbounded key, bounded entry count" is strictly worse, and
    // "prefix only" hid a GENUINELY DISTINCT fault whose text diverges after 200
    // characters once three prefix-siblings had spent the allowance: not
    // deduplicated, absent. Reachable narrowly but really, by a handler that
    // throws a long serialized payload ahead of its distinguishing id.
    //
    // The third option gives up neither: the prefix plus the full length plus a
    // cheap hash OF THE WHOLE signature. Same constant bound on the key, same
    // 32-entry ceiling, same memory a subprocess cannot grow — and a false merge
    // now needs a hash COLLISION rather than a shared 200-character prefix. The
    // `\u001f` separators keep the three parts from forging one another (a
    // signature may contain any character a thrown message can, but the pieces
    // are joined by a control character a thrown message effectively never
    // carries. Written as an ESCAPE and never as a literal control byte: this
    // repo has measured source files that plain `grep` skips silently for
    // carrying one, and this file was not among them until it nearly was.
    const key = signature.length > PiAgent.MAX_DISPATCH_FAULT_SIGNATURE_CHARS
      ? `${signature.slice(0, PiAgent.MAX_DISPATCH_FAULT_SIGNATURE_CHARS)}\u001f${signature.length}\u001f${PiAgent.cheapHash(signature)}`
      : signature;
    const seen = (this.subprocessDispatchFaultCounts.get(key) ?? 0) + 1;
    // Re-insert so that map order is recency order, which is what the eviction
    // below reads.
    this.subprocessDispatchFaultCounts.delete(key);
    this.subprocessDispatchFaultCounts.set(key, seen);
    if (this.subprocessDispatchFaultCounts.size > PiAgent.MAX_TRACKED_DISPATCH_FAULT_SIGNATURES) {
      const oldest = this.subprocessDispatchFaultCounts.keys().next();
      if (!oldest.done) this.subprocessDispatchFaultCounts.delete(oldest.value);
    }
    if (seen > PiAgent.MAX_IDENTICAL_DISPATCH_FAULTS) return;
    this.eventQueue.enqueue({ type: 'error', message });
  }

  /**
   * P2.65 — render a thrown value where a throw must not happen. P2.76/P2.96 —
   * and that is EVERY catch in this class, not only the two belts.
   *
   * `String(x)` is not total: `String(Object.create(null))` raises (bun 1.3.14:
   * "TypeError: No default value"), and so does any value whose `toString` and
   * `Symbol.toPrimitive` are missing or not callable. Both belts rendered the
   * caught value that way, so a case that threw such a value escaped from
   * inside the catch that existed to absorb it — measured, with the chunk tail
   * lost at the outer belt and `case 'ready'`'s `resolveReady()` stranded at
   * `safeHostCall`.
   *
   * P2.65 scoped the fix to those two shapes. The rest of the class kept
   * `error instanceof Error ? error.message : String(error)` at 36 more sites,
   * and the sweep that replaced them is not cosmetic — the census sorted them
   * into four families, each with a cost the belts do NOT cover:
   *
   * - A BLOCKING WIRE'S CATCH renders the detail BEFORE it sends the answer, so
   *   an unrenderable value means no answer at all: `pre_tool_use_response`,
   *   `ask_user_response`, `outside_root_response`, `post_tool_use_response`,
   *   `pre_compact_response`, `process_start_response`,
   *   `child_session_response`. The subprocess suspends the model's call on
   *   that requestId; nothing times it out. The stdout chunk survives (P2.66's
   *   sweep re-proved that) and the tool call still hangs for the rest of the
   *   turn — the P2.40 strand, at seven more sites.
   * - A SETTLER'S CATCH renders inside the `reject(...)`/`resolve(...)`
   *   argument, after the pending entry has already been deleted and its timer
   *   cleared, so the host promise it exists to settle is stranded with nothing
   *   left to settle it: the two `pending.reject` sites, the three fork/workflow
   *   `reject`s, `cancelStrandedAskUserPermission`'s last-resort `resolve`.
   * - A RECOVERY PATH'S CATCH renders ahead of the recovery: the spawn's
   *   `failSubprocessAttempt` (the attempt never fails, so `attempt.startup`
   *   never settles) and `chatImpl`'s subprocess-spawn catch (the fresh-resume
   *   retry below it never runs).
   * - A DEBUG-ONLY CATCH is the cheapest, and still not free: the fault is
   *   re-attributed to whatever frame above catches the render instead.
   *
   * So the rule this method encodes is now file-wide and worth stating as one:
   * NOTHING IN A CATCH IN THIS CLASS RENDERS A THROWN VALUE ANY OTHER WAY. The
   * only raw `String()` on a thrown value left in the file is the one inside
   * this method's own `try`.
   *
   * `preferStack` picks the debug rendering (the stack when there is one, which
   * is what both call sites logged before); the default is the short detail
   * that goes into the dedup signature and the user-visible sentence. A value
   * that renders as neither becomes a fixed literal rather than an exception:
   * a fault nobody can describe is still a fault that must be reported.
   */
  private static describeThrown(error: unknown, preferStack = false): string {
    try {
      if (!(error instanceof Error)) return String(error);
      if (preferStack && typeof error.stack === 'string') return error.stack;
      return String(error.message);
    } catch {
      return '(unrenderable thrown value)';
    }
  }

  /**
   * P2.73 — name a JSON-SUPPLIED identifier for a report, without assuming it is
   * a string and without throwing when it is not.
   *
   * `msg.event` on the `automation_event` wire is typed `AutomationAgentEvent`
   * by a cast, which is a compile-time claim about a value that arrived as JSON.
   * It reaches {@link reportAutomationEventFault} unchecked, and that method runs
   * as a rejection handler — the one place a throw is one more unhandled
   * rejection rather than a caught fault. Unlike `handleLine`'s `type`, this name
   * is on a path a renderable non-string genuinely reaches (see the refutation
   * beside `typeLabel`), so rendering it is worth something.
   *
   * `null` is the "nobody can render this" answer — deliberately not a literal,
   * so the caller picks its own sentence. An EMPTY STRING is a legitimate return,
   * which is why this is `string | null` rather than `string` with `''` standing
   * in for failure.
   */
  private static describeUntrustedName(value: unknown): string | null {
    if (typeof value === 'string') return value;
    try {
      return String(value as never);
    } catch {
      return null;
    }
  }

  /**
   * P2.76 — a 32-bit FNV-1a over a dedup signature, so that a key bounded in
   * LENGTH is still a key to the WHOLE signature.
   *
   * Deliberately not a cryptographic hash: this is not a security boundary, it
   * is a dedup bucket. What it has to survive is a subprocess-supplied
   * signature (`event ${eventType}` and every thrown message reach it), so it
   * has to be total, allocation-free and linear. FNV-1a is all three, and
   * `Math.imul` keeps the multiply in 32 bits without `BigInt`.
   *
   * A collision merges two faults' allowances, which is exactly the state a
   * bare prefix slice produced for every shared 200-character prefix. So the
   * worst case here is the OLD behaviour, on 2^-32 of pairs instead of on a
   * whole prefix class.
   */
  private static cheapHash(value: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
  }

  /**
   * P2.54 — call a HOST-supplied callback so that a throw from it cannot abandon
   * the caller's own bookkeeping.
   *
   * Every one of these is a synchronous `void` notification invoked from
   * `handleLine`, and before this helper a throwing host cost two things: the
   * rest of the stdout chunk (the readline `'line'` listener unwinds — see the
   * file header of `__tests__/pi-agent-sync-dispatch-belt.test.ts`), and the
   * REST OF THE CASE. The second is the one a belt around the dispatch cannot
   * repair: `handleEnsureSessionReadyResult` and `handleCompactResult` both
   * delete their correlation entry BEFORE the notification, so an outer catch
   * would find nothing left to settle — the same shape as P2.41's
   * `cancelPendingPermission` residual. Belting the callback where it is called
   * keeps the case body running instead, which is why this is the primary
   * mechanism and `handleLine`'s own belt is the backstop.
   *
   * Fail-closed here is: the host does not learn this one thing, and everything
   * else proceeds. The fault is logged and SURFACED (bounded) rather than
   * swallowed, for P2.41's reason — a silent drop is how a real programming
   * error hides behind a slightly-wrong session forever.
   */
  private safeHostCall(what: string, call: () => void): void {
    try {
      call();
    } catch (error) {
      // P2.65 — same shape as `handleLine`'s catch and the same rule: nothing
      // in here may throw, or the case body this helper exists to protect is
      // abandoned anyway. `what` is a literal at every call site; the caught
      // value is not, so it goes through `describeThrown`.
      const detail = PiAgent.describeThrown(error);
      this.debug(`Host callback ${what} threw: ${PiAgent.describeThrown(error, true)}`);
      this.surfaceSubprocessFault(
        `host ${what}: ${detail}`,
        `A Pi subprocess update could not be delivered to the app (${what}): ${detail}`,
      );
    }
  }

  /**
   * P2.73 — fire an automation event nothing awaits, WITH a failure channel.
   *
   * `void this.emitAutomationEvent(...)` was the only dispatch in `handleLine`
   * with no failure channel at all, and it is the one shape neither belt can
   * cover: both are SYNCHRONOUS, and an async rejection is not a throw they can
   * catch. It costs no stdout chunk (P2.65's 36-type sweep confirmed
   * `automation_event` keeps its tail either way) — what it cost was the report.
   * A hook the user configured did not run, and the only trace was an unhandled
   * rejection, which Electron logs without exiting and a packaged build does not
   * log at all outside debug mode.
   *
   * DELIBERATELY THE SAME CHANNEL as every other swallowed dispatch fault in
   * this class rather than a new one, and the alternatives were checked rather
   * than assumed. A durable capability-loss record is not reachable from here
   * (the `deferred` list is a function-local array in
   * `applyPermissionRequestUpdates`, scoped to one hook's permission entries,
   * and this failure loses no component); an install-success payload has no
   * bearing on a per-turn event. So this is a LABEL ON THE EXISTING RECORD: the
   * `surfaceSubprocessFault` row, named by the event, which means it inherits
   * P2.66's per-signature bound, P2.66's broken-sink floor, and P3.22's now-open
   * host-side gates for free — including the one that surfaces a fault arriving
   * with no turn in flight, which is where most of these land.
   *
   * `emitAutomationEvent` is `async`, so there is no synchronous throw to belt:
   * every failure inside it, prologue included, arrives as a rejection here.
   */
  private emitAutomationEventDetached(event: AutomationAgentEvent, input: SdkAutomationInput): void {
    void this.emitAutomationEvent(event, input)
      .catch((error: unknown) => this.reportAutomationEventFault(event, error));
  }

  /**
   * The report half of {@link emitAutomationEventDetached}, separate because the
   * two emissions that need a `.then` cannot use the helper and still need the
   * same channel.
   *
   * Nothing in here may throw: it runs as a rejection handler, so a throw from
   * it is one more unhandled rejection — the exact state being closed. `event`
   * arrives as subprocess JSON on the `automation_event` path, so it is named
   * through `describeUntrustedName` rather than interpolated raw.
   */
  private reportAutomationEventFault(event: unknown, error: unknown): void {
    const label = PiAgent.describeUntrustedName(event) ?? '(non-string event)';
    const detail = PiAgent.describeThrown(error);
    this.debug(`Pi automation event ${label} could not be delivered: ${PiAgent.describeThrown(error, true)}`);
    this.surfaceSubprocessFault(
      `automation_event ${label}: ${detail}`,
      `A Pi automation event (${label}) could not be delivered: ${detail}`,
    );
  }

  // Ring buffer of recent subprocess stderr. Always on (independent of NESSY_DEBUG)
  // so that connection-test and other failures can surface what the subprocess
  // actually said, instead of a bare "timed out" with no context.
  private stderrBuffer: string[] = [];
  private stderrBufferBytes = 0;
  private static readonly STDERR_BUFFER_MAX_BYTES = 8 * 1024;

  private recordStderr(chunk: string): void {
    if (!chunk) return;
    // If a single chunk is larger than the cap, keep only its tail so the
    // buffer always holds the most-recent output even in pathological cases.
    const effective = chunk.length > PiAgent.STDERR_BUFFER_MAX_BYTES
      ? chunk.slice(chunk.length - PiAgent.STDERR_BUFFER_MAX_BYTES)
      : chunk;
    this.stderrBuffer.push(effective);
    this.stderrBufferBytes += effective.length;
    // Drop oldest chunks until we're back under the cap, but always keep at
    // least one entry so a single-chunk tail survives.
    while (this.stderrBufferBytes > PiAgent.STDERR_BUFFER_MAX_BYTES && this.stderrBuffer.length > 1) {
      const dropped = this.stderrBuffer.shift()!;
      this.stderrBufferBytes -= dropped.length;
    }
  }

  /** Returns the most recent subprocess stderr output (up to ~8KB). Empty string if nothing captured. */
  getRecentStderr(): string {
    return this.stderrBuffer.join('');
  }

  // Pending permission requests (used by handlePreToolUseRequest for ask-mode prompting)
  private pendingPermissions: Map<string, PendingPermission> = new Map();
  private hostAskUserRequestIds = new Set<string>();
  /** Per-dialog id for the R24 `mcp_elicitation_state` open/close edges. */
  private elicitationDialogSeq = 0;

  /** Live only while {@link describeQuota} has a request in flight (T19). */
  private quotaAbortController: AbortController | null = null;

  // Pending tool executions (correlation map for subprocess tool_execute_request -> main process -> tool_execute_response)
  private pendingToolExecutions = new Map<string, AbortController>();

  /**
   * UB2.10 (B2-12; "Stop ends only the reply") — proxy tool calls the SUBPROCESS detached
   * past the R10 threshold (`tool_execute_detached {requestId, taskId}`): a background task
   * now. MOVED here out of {@link pendingToolExecutions}, whose wholesale abort in
   * `forceAbort` used to kill a running detached MCP write on every Stop. `stopBackgroundTask`
   * stops one by taskId (the subprocess answers with `tool_execute_cancel`, aborted here too);
   * `forceAbort` sweeps them for every reason but {@link PI_DETACHED_CALL_SURVIVING_ABORT_REASONS};
   * `rejectPendingSubprocessRequests` (session death) settles them; a settled call leaves.
   */
  private detachedToolExecutions = new Map<string, AbortController>();
  /** UB12.36 — the background task id each detached call's controller runs under (`tool_execute_detached {taskId}`). */
  private detachedToolTaskIds = new WeakMap<AbortController, string>();

  private pendingProcessStarts = new Map<string, AbortController>();

  /**
   * The HOST-side producer of `dangerouslyDisableSandbox` (sandboxing.md:135).
   *
   * Keyed by the tool call's `executionId` — the same id the child sends as
   * `toolCallId` on the permission request and as `executionId` on the process
   * start request, which is what makes this a correlation and not a channel.
   * The value is the decision id the permission service minted for THAT
   * approval, so the recorded downgrade names the decision that authorized it.
   *
   * An entry is written only when the model asked for the bypass on a Bash call
   * AND that exact call was allowed, and it is consumed by the first matching
   * process start. The child never sends the flag and could not:
   * `pickSupervisedChildStartFields` omits it. Bounded, and cleared with every
   * other per-subprocess correlation state on teardown.
   */
  private authorizedSandboxDowngrades = new Map<string, string>();

  private pendingManifestRegistrations: Map<string, {
    resolve: (identity: { generation: string; manifestHash: string }) => void;
    reject: (error: Error) => void;
  }> = new Map();

  private pendingWorkflowExecutions: Map<string, {
    resolve: (result: PiWorkflowExecutionResult) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = new Map();

  /** `/subtask` fork starts awaiting `subtask_start_result` (sub-agents.md:1013). */
  private pendingSubtaskForks: Map<string, {
    resolve: (result: PiSubtaskForkStart) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = new Map();

  /** `context: fork` skill dispatches awaiting `skill_fork_start_result` (skills.md:569). */
  private pendingSkillForks: Map<string, {
    resolve: (result: SkillForkOutcome) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = new Map();

  // Pending mini completions (correlation map for subprocess mini_completion_result)
  private pendingMiniCompletions: Map<string, {
    resolve: (text: string | null) => void;
    reject: (error: Error) => void;
  }> = new Map();

  // Pending llm_query calls (correlation map for subprocess llm_query_result).
  // Separate from pendingMiniCompletions because the payload shape differs:
  // queryLlm returns a full LLMQueryResult, not just text.
  private pendingLlmQueries: Map<string, {
    resolve: (result: LLMQueryResult) => void;
    reject: (error: Error) => void;
  }> = new Map();

  // Pending ensure_session_ready requests (branch preflight handshake)
  private pendingEnsureSessionReady: Map<string, {
    resolve: (sessionId: string | null) => void;
    reject: (error: Error) => void;
  }> = new Map();

  // Pending compact requests (manual compaction RPC)
  private pendingCompactions: Map<string, {
    resolve: (result: PiCompactResult | null) => void;
    reject: (error: Error) => void;
  }> = new Map();
  private continuationActivatedTools = new Map<string, CapabilityActivationLeaseV1>(); private continuationActivatedToolsReported = false; // F1.1119: true once the subprocess reported its loaded set
  private continuationBoundaryOpen = false;

  // Pending context usage requests (fresh usage RPC)
  private pendingContextUsageRequests: Map<string, {
    resolve: (usage: ContextUsageSnapshot) => void;
    reject: (error: Error) => void;
  }> = new Map();

  // L9 — pending `stop_background_task` requests. Resolve-only ON PURPOSE, for
  // the same reason as the heapdump map: the caller is a button press, and every
  // outcome — a registry that does not hold the id, a dead subprocess, a
  // subprocess bundle too old to know the message — is an ANSWER the host must
  // act on (fall through to the child-session port) rather than an exception.
  //
  // Resolving is NOT sufficient for that, and for two of those three cases this
  // comment described something the code did not do. `SessionManager.stopAgentTask`
  // falls through only on `{ stopped: false }` with NO `error`; an `error` means
  // "owned the id, stop went wrong" and ends the sequence. The dead-subprocess and
  // timed-out paths both resolved WITH one. They now answer "not mine" and log the
  // reason instead — see `stopBackgroundTask` for why that is the safe direction
  // and what fences it.
  private pendingStopBackgroundTasks: Map<string, {
    resolve: (outcome: { stopped: boolean; error?: string }) => void;
  }> = new Map();

  // Pending heapdump requests (R49/f210). Resolve-only ON PURPOSE: a failed
  // or timed-out subprocess dump becomes an error ROW in the /heapdump
  // summary, never a rejected command.
  private pendingHeapdumps: Map<string, {
    resolve: (row: HeapdumpWriteResult) => void;
  }> = new Map();

  // Pending auto-compaction toggle requests
  private pendingAutoCompactionToggles: Map<string, {
    resolve: (enabled: boolean) => void;
    reject: (error: Error) => void;
  }> = new Map();

  // Pending runtime config updates (custom endpoint model capability refresh)
  private pendingRuntimeConfigUpdates: Map<string, {
    resolve: (updated: boolean) => void;
    reject: (error: Error) => void;
  }> = new Map();

  // Metadata captured before PreToolUse stripping, keyed by toolCallId.
  // This provides a deterministic bridge when side-channel metadata store misses.
  private preToolMetadataByCallId: Map<string, {
    intent?: string;
    displayName?: string;
    capturedAt: number;
  }> = new Map();

  // CI2 edit-feedback bridge: the model-facing tool_start input, keyed by
  // toolCallId. The tool_result AgentEvent carries no input (`createToolResult`
  // emits none), so the changed-file path is captured here from the normalized
  // tool_start input (`path` already mapped to `file_path`) and looked up when
  // the matching tool_result completes. Entries are one-shot — deleted the
  // moment the result is handled — and cleared on abort/teardown so the map is
  // never unbounded.
  private editFeedbackInputByCallId: Map<string, Record<string, unknown>> = new Map();

  // Hook loop-guard (HOST-side): per-turn counts of hook-caused pre-tool
  // denies. Primary map keyed by (tool, input hash, deny reason); secondary
  // map totals every hook deny per tool regardless of input/reason. The retry
  // loop runs inside the SDK subprocess, so these counters must live on the
  // host reply path — never on ManagedSession. Cleared at the turn boundary
  // in chatImpl.
  private preToolHookDenyCounts: Map<string, number> = new Map();
  private preToolHookDenyTotals: Map<string, number> = new Map();

  // Session-scoped extra filesystem roots granted through a PermissionRequest
  // hook's `addDirectories` (R15 Task 3). Canonical absolute paths only
  // (validated by resolveAdditionalDirectories at the granting site); merged
  // with the configured additionalDirectories by runPreToolUseChecks. Never
  // persisted — the durable list stays the explicit config.json setting.
  private sessionAdditionalDirectories: string[] = [];

  /**
   * The session-scoped `addDirectories` grant, for the HOST gates.
   *
   * `hooks.md`'s `updatedPermissions` `addDirectories` entry widens the session,
   * not one tool call, so every gate that consults the configured
   * `additionalDirectories` has to consult this too. Without an accessor the
   * grant reached `runPreToolUseChecks` and nothing else, and the same file
   * under the same session was admitted by the Pi tool gate and refused by the
   * command-hook, skill-context, plugin-hook and composer-shell gates.
   * Read-only by construction: the array is copied, and the only writer stays
   * `applyPermissionRequestUpdates`.
   */
  getSessionAdditionalDirectories(): readonly string[] {
    return [...this.sessionAdditionalDirectories];
  }

  // Guardian safety-judge consult state (plan: guardian-command-judge G2/G3).
  // Auto-mode borderline actions consult the guardian before asking the user;
  // allow-all high-risk actions consult it as a deny-only net (G3). Lazily built
  // so a port set after construction is still picked up. Per-turn
  // circuit-breaker/loop-guard state is reset at the turn boundary alongside the
  // hook loop-guard; the verdict cache is session-scoped, invalidated on mode
  // switch. The product setting (`getGuardianEnabled()`, default ON) gates BOTH
  // bands and is read LIVE per call at the consult sites so a Settings toggle
  // takes effect without a restart — the state itself is only port-gated. When
  // the setting is off, the consult sites never call this, so all paths stay
  // byte-identical to pre-guardian.
  private _guardianConsult: GuardianConsultState | undefined;
  /** Once-a-session latch for {@link noteBuiltinAgentTiersOnce} (P6.156). */
  private builtinTierNoticeEmitted = false;
  /**
   * Auto-mode classifier block counters for the documented self-downgrade
   * (permission-modes.md: "If the classifier blocks an action 3 times in a
   * row or 20 times total, auto mode pauses and Claude Code resumes
   * prompting."). Session-scoped: both reset when the pause fires, and the
   * consecutive run resets on any consult the classifier lets through.
   */
  private autoClassifierBlocks = { consecutive: 0, total: 0 };
  private guardianConsultState(): GuardianConsultState | undefined {
    if (!this.config.guardianJudgePort) return undefined;
    if (!getGuardianEnabled()) return undefined;
    if (!this._guardianConsult) {
      this._guardianConsult = new GuardianConsultState(
        action => hashPreToolInputForLoopGuard(action as Record<string, unknown>),
        this.config.guardianJudgePort,
        true,
      );
    }
    return this._guardianConsult;
  }

  /**
   * Whether this session is one of `permission-modes.md`'s "sessions with
   * bypass permissions available" — the precondition the `:577` critical-path
   * row (and `:499`, and the protected-path table) states negatively: plan mode
   * routes a removal to the classifier only when bypass is NOT available.
   *
   * The page defines the term itself, at `:28`: "sessions started in a way that
   * puts `bypassPermissions` in the mode cycle". This fork has no launch flag,
   * so TWO facts put the mode within reach, and OQ-3 (owner, 2026-08-23)
   * resolved STRICTER: BOTH count as availability.
   *
   *  1. The workspace's own `cyclablePermissionModes`. `mode-types.ts` names it
   *     on `DEFAULT_CYCLABLE_PERMISSION_MODES` as the analog of Claude's
   *     launch-time enable. (D1.369 retired that docblock's exact words; what
   *     survives is the ROLE of the array, not a quote.) Read per call off
   *     the session's workspace config: no IO, no cache to go stale. A workspace
   *     that never configured a cycle reads `undefined` here and fails route 1 —
   *     unchanged by D1.369, which put bypass in the DEFAULT cycle, not in this.
   *  2. The install-wide `bypassPermissionsAcknowledged` — the one-time
   *     responsibility dialog, whose own module says what it costs. From
   *     `renderer/lib/bypass-permissions-gate.ts`: "the FIRST activation of
   *     `bypassPermissions` on this install raises a confirmation dialog;
   *     accepting records the acknowledgment durably in the user config tier …
   *     and every later activation switches directly". The acknowledgment IS the
   *     gate, and it is per-INSTALL, so after it bypass is one click away in
   *     every session: nothing downstream narrows the choice either —
   *     `composer-capabilities.ts` hands the composer `[...ALL_PERMISSION_MODES]`
   *     for every non-cloud provider, and `FreeFormInput`'s `enabledModes` is
   *     declared and defaulted but never read (two occurrences in the file, both
   *     of them the declaration). A session that can cycle straight into bypass
   *     is a session with bypass available, whatever its own cycle array says.
   *
   * This paragraph used to assert the opposite — that the acknowledgment was
   * "DELIBERATELY NOT" availability, because it records that a human once
   * accepted a dialog rather than a property of THIS session, and that counting
   * it "would silently switch the `:577` row back off for every user who ever
   * entered bypass once". The owner overruled that on 2026-08-23, so the cost is
   * recorded here rather than deleted: it is REAL and ACCEPTED. For any user who
   * has ever entered bypass once, plan mode loses P2.21's classifier route
   * permanently and a critical-path removal prompts them every time. That is the
   * page-faithful reading of `:577` — it offers the classifier only to sessions
   * where bypass is UNavailable — and the direction it errs in is asking a human
   * about `rm -rf ~`, which is the safe side of the trade.
   */
  private bypassPermissionsAvailable(): boolean {
    // Route 1, the workspace cycle. Tried first because it is a plain in-memory
    // field read, where route 2 goes to config storage.
    const cyclable = this.config.workspace?.config?.defaults?.cyclablePermissionModes;
    // Compared THROUGH `parsePermissionMode`, never by raw string: the cycle is
    // persisted on disk and `mode-types.ts` keeps the legacy spellings
    // (`allow-all`, `execute`, `ALLOW_ALL`, …) as PERMANENT read-path aliases
    // for `bypassPermissions`. Storage normalizes on read today, so a raw
    // `includes('bypassPermissions')` happens to be right in production — which
    // is exactly the "enforcement one layer up" shape that fails silently the
    // moment a second writer or an un-normalized read appears. Failing here
    // means the `:577` row routes a home wipe to the classifier in a session
    // that CAN reach bypass, i.e. it fails OPEN.
    if (Array.isArray(cyclable)
      && cyclable.some(mode => typeof mode === 'string' && parsePermissionMode(mode) === 'bypassPermissions')) {
      return true;
    }
    // Route 2, the install-wide acknowledgment. Note this is deliberately NOT
    // guarded by the array check above: a workspace with no configured cycle at
    // all is the commonest shape, and it is exactly the one an acknowledged user
    // is in.
    return getBypassPermissionsAcknowledged();
  }

  // Current user message (for context in summarization)
  private currentUserMessage: string = '';
  // Pinned system prompt components (captured on first prompt, used for consistency after compaction)
  private preferencesDriftState: PreferencesDriftState = {
    pinnedPreferencesPrompt: null,
    pinnedIncludeCoAuthoredBy: null,
    preferencesDriftNotified: false,
  };

  // Pool reference for convenience (from this.config.mcpPool)
  private get mcpPool(): McpClientPool | undefined { return this.config.mcpPool; }

  // Cached session tool context (lazy-created on first session tool call)
  private _sessionToolContext: SessionToolContext | null = null;

  /**
   * Pi checks the ceiling inside its own drain loop, *before* yielding, so it can
   * force-abort the subprocess before the breaching event escapes. That tells the
   * shared check in BaseAgent.chat() to stand down rather than count the same
   * cost a second time. The accounting members themselves are inherited.
   */
  protected override enforcesMaxBudgetUsdInChatImpl = true;
  private catalogContextWindow?: number;
  /**
   * Where {@link catalogContextWindow} came from — never assumed.
   *
   * It used to be reported as `'static_registry'` whenever the number existed,
   * which was true only because the number could ONLY come from there. Now that
   * the connection's own catalogue and the gateway table can answer, the label
   * has to be carried rather than inferred, or the drift diagnostic names the
   * wrong source in the one message anybody reads about it.
   */
  private catalogContextWindowSource: ResolvedContextWindow['source'] = 'unavailable';

  // RPC request counter for unique IDs
  private rpcIdCounter: number = 0;

  // OAuth token refresh (ChatGPT Plus)
  /**
   * @deprecated Use onBackendAuthRequired (inherited from BaseAgent) instead.
   * Kept as a getter/setter alias for backward compatibility.
   */
  get onChatGptAuthRequired(): ((reason: string) => void) | null {
    return this.onBackendAuthRequired;
  }
  set onChatGptAuthRequired(cb: ((reason: string) => void) | null) {
    this.onBackendAuthRequired = cb;
  }
  private tokenRefreshInProgress: Promise<void> | null = null;

  // Global mutex: keyed by connectionSlug so multiple PiAgent instances
  // sharing the same connection don't race concurrent token refreshes.
  private static globalRefreshMutex: Map<string, Promise<void>> = new Map();

  // P6.257 — the IAM credential this subprocess was last GIVEN, as a
  // non-secret fingerprint. Set at spawn (`buildAwsEnv`) and on every push, so
  // an auth failure can tell "the store now holds a fresher credential" from
  // "the store still holds the one that just failed" — those need different
  // answers, and without the marker every failure would push the same dead
  // credential back into the subprocess forever.
  private lastPushedIamFingerprint: string | null = null;

  // ============================================================
  // Constructor
  // ============================================================

  constructor(config: BackendConfig) {
    const resolvedModel = config.model || '';
    const modelDef = getModelById(resolvedModel);
    super(config, resolvedModel, modelDef?.contextWindow);

    this._supportsBranching = true;
    this.refreshCatalogContextWindow(resolvedModel);

    this.piSessionId = config.session?.sdkSessionId || null;
    this.adapter = new PiEventAdapter();
    if (modelDef?.contextWindow) {
      this.adapter.setContextWindow(modelDef.contextWindow);
    }
    if (config.miniModel) {
      this.adapter.setMiniModel(config.miniModel);
    }
    // Per-leaser on a shared workspace pool, single-owner on a private one —
    // the choice is BaseAgent's, and it is what stops one session's prompt from
    // being shown to another session's user.
    this.registerMcpElicitationHandler();

    // Set session dir on adapter for concurrent-safe toolMetadataStore lookups
    if (config.session?.id) {
      this.adapter.setSessionDir(join(config.workspace.sessionRootPath, config.session.id));
    }

    // Wire the adapter's async overflow fallback into the event queue. The
    // fallback fires when the SDK doesn't emit a compaction_start after a
    // held overflow agent_end (e.g. _overflowRecoveryAttempted was already
    // true). It runs outside adaptEvent() so it can't yield through the
    // generator — instead, it calls these callbacks to enqueue the buffered
    // error and terminate the iterator.
    this.adapter.setOverflowFallbackHandlers(
      (event) => {
        if (!this.rawEventAttemptTerminal) this.eventQueue.enqueue(event);
      },
      () => {
        this.rawEventAttemptTerminal = true;
        this.eventQueue.complete();
      },
    );

    if (!config.isHeadless) {
      this.startConfigWatcher();
    }
  }

  override setCapabilityTurnRuntime(runtime: CapabilityTurnRuntime | null): void {
    super.setCapabilityTurnRuntime(runtime);
    // ADVICE ONLY. The guideline rides the stable prompt block because the
    // workflow tool's model contract is hash-pinned and cannot carry a
    // per-session value; nothing downstream reads it as a limit.
    this.promptBuilder.setWorkflowSizeGuideline(
      runtime?.workflowSettings?.sizeGuideline ?? 'unrestricted',
    );
    this.clearExecutionManifestAuthority();
    this.publishPluginMcpServerAuthAuthority();
  }

  /**
   * Publish the model-facing plugin sign-in authority (`source_oauth_trigger`
   * with a `pluginKey`+`serverName` target).
   *
   * Published here rather than once at construction because this is the only
   * moment the enabled server set can change, and re-publishing an equivalent
   * closure is idempotent. The closure reads `capabilityTurnRuntime` at CALL
   * time, so a server that has left the enabled set — or a turn that has ended
   * — resolves to `null` instead of opening a browser for a server that is no
   * longer there.
   */
  private publishPluginMcpServerAuthAuthority(): void {
    const sessionId = this.config.session?.id;
    if (!sessionId) return;
    mergeSessionScopedToolCallbacks({ workspaceId: this.config.workspace.id, sessionId }, {
      resolvePluginMcpServerFn: (pluginKey, serverName) =>
        this.resolvePluginMcpServerForAuth(pluginKey, serverName),
    });
  }

  /**
   * `endpointAuth` is carried only by a non-stdio plugin server that DECLARED an
   * `authType` (`capabilities/resolver.ts`), which is exactly the set owning a
   * global plugin credential slot; and `view.mcpServers` holds only runnable
   * capabilities (`capabilities/views.ts:isRunnable` — enabled, trusted,
   * supported), so presence there IS the "is it enabled" test the tool contract
   * asks for. Everything else is `null`.
   */
  private resolvePluginMcpServerForAuth(
    pluginKey: string,
    serverName: string,
  ): { displayName: string; authType: 'oauth' | 'bearer' | 'none' } | null {
    const server = this.capabilityTurnRuntime?.view?.mcpServers?.find(candidate =>
      candidate.endpointAuth?.pluginKey === pluginKey
      && candidate.endpointAuth.serverName === serverName);
    if (!server?.endpointAuth) return null;
    return {
      displayName: server.sourceName ?? server.wireName,
      authType: server.endpointAuth.authType,
    };
  }

  private clearExecutionManifestAuthority(): void {
    this.activeExecutionManifest = null;
    this.adapter.setExecutionManifest(null);
  }

  /**
   * Guardrail: ensure every backend-mode session tool from core is implemented here.
   * This fails fast in development/CI instead of surfacing as runtime "Unknown session tool".
   */
  private assertBackendSessionToolParity(): void {
    const missing = [...SESSION_BACKEND_TOOL_NAMES].filter(
      (name) => !PI_BACKEND_SESSION_TOOL_NAMES.has(name),
    );

    if (missing.length > 0) {
      throw new Error(
        `PiAgent missing backend session tool implementations: ${missing.join(', ')}`,
      );
    }
  }

  // ============================================================
  // T7 · the runtime-handoff carry, on the Pi side
  // ============================================================

  /**
   * Where the switch would have written this session's carry file, or
   * `undefined` when this agent has no session to key it on.
   *
   * Derived rather than carried: the path is fixed
   * (`<session dir>/.pi-carry/handoff.jsonl`), which is what lets the arm
   * survive a quit between the switch and the first turn without a persisted
   * field. `SessionManager` derives the same path from the same two ids.
   */
  private carryHistorySessionFile(): string | undefined {
    const sessionId = this.config.session?.id;
    if (!sessionId) return undefined;
    return piCarrySessionPath({ workspaceId: this.config.workspace.id, sessionId });
  }

  /**
   * T7 · claim this turn's handoff, because a forked carry session is about to
   * deliver it.
   *
   * Three conditions, and all three have to hold:
   *
   * 1. The switch decided `native` (`planHistoryCarry`). Not this agent's
   *    decision to make — the modal has already promised the user one of three
   *    things.
   * 2. **No subprocess has been started yet.** This is the condition the Claude
   *    arm has no analogue of, and it is load-bearing: the carry file only ever
   *    reaches Pi through the `init` message, which is composed once, at spawn.
   *    If something else already spawned the child — an `llm_query`, a
   *    capability refresh, a working-directory transaction — the Pi session
   *    either exists or will be created without a carry file, and suppressing
   *    the text block would deliver nothing at all. Answering `false` here puts
   *    the whole history into this very turn as text instead.
   * 3. The carry file is on disk and is one Pi would actually fork from —
   *    {@link piCarrySessionIsLoadable}, which restates upstream's own gate
   *    (`loadEntriesFromFile` returns `[]` unless the first parsed entry is a
   *    `session` header with a string `id`, and `forkFrom` refuses an empty
   *    result). This is what catches R1's crash-mid-switch shape: an armed
   *    handoff with no file left behind delivers as text on this turn rather
   *    than being lost.
   *
   * Answering `true` does NOT mark the handoff applied. That happens only when
   * the subprocess reports back that it really forked — see the
   * `session_id_update` arm's `carriedHistory` flag.
   */
  protected override shouldSuppressTextHandoff(handoff: RuntimeHandoffPayload): boolean {
    if (handoff.plan !== 'native') return false;
    if (this.subprocessAttempt) {
      this.debug('[runtime-handoff] the Pi subprocess is already started; delivering the text handoff instead');
      return false;
    }
    const carryFile = this.carryHistorySessionFile();
    if (!carryFile || !piCarrySessionIsLoadable(carryFile)) {
      this.debug(`[runtime-handoff] no loadable carry session at ${carryFile ?? '(no session)'}; delivering the text handoff instead`);
      return false;
    }
    this.debug(`[runtime-handoff] carry session in force at ${carryFile}; suppressing the text handoff for this turn`);
    return true;
  }

  // ============================================================
  // Subprocess Management
  // ============================================================

  /**
   * Ensure the subprocess is spawned and ready.
   * Lazy initialization -- spawns on first use.
   */
  private ensureSubprocess(): Promise<void> {
    if (this.subprocessAttempt) return this.subprocessAttempt.startup;

    const attempt = this.beginSubprocessAttempt();
    const start = async () => {
      if (this.subprocessTermination || this.pendingSubprocessTerminations.length > 0) {
        await this.awaitSubprocessTerminationBarrier();
      }
      this.assertCurrentSubprocessAttempt(attempt);
      await this.spawnSubprocess(attempt);
    };
    void start().then(
      () => this.finishSubprocessAttempt(attempt),
      (error: unknown) => this.failSubprocessAttempt(
        attempt,
        error instanceof Error ? error : new Error(PiAgent.describeThrown(error)),
      ),
    );
    return attempt.startup;
  }

  private beginSubprocessAttempt(): PiSubprocessStartupAttempt {
    // Every child starts its generation protocol at zero. Reset at attempt
    // allocation (before any credential await or spawn) so a retired N>0 child
    // cannot make its replacement send an impossible expectedGeneration=N.
    this.workingDirectoryGeneration = 0;
    this.workingDirectoryTransaction = null;
    // A fresh subprocess re-pins its orchestrator from the current runtime on its
    // first manifest build (init reflects the runtime live at spawn time).
    this.subprocessOrchestrator = null;
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    let resolveStartup!: () => void;
    let rejectStartup!: (error: Error) => void;
    const attempt: PiSubprocessStartupAttempt = {
      id: ++this.subprocessAttemptId,
      cancelled: false,
      readySettled: false,
      startupSettled: false,
      ready: new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      }),
      startup: new Promise<void>((resolve, reject) => {
        resolveStartup = resolve;
        rejectStartup = reject;
      }),
      resolveReady,
      rejectReady,
      resolveStartup,
      rejectStartup,
    };
    // P2.334 measured these two and they are NOT the unlabelled-swallow shape
    // they match: both promises have real awaiters that surface the failure
    // (`spawnSubprocess` awaits `ready`; every `ensureSubprocess()` caller awaits
    // the `startup` this returns), and `cancelSubprocessAttempt` rejects the two
    // with the SAME error under `readySettled`/`startupSettled` latches, so a
    // handler here could only ever log the awaiter's failure a second time.
    // These exist so the copy nobody awaited is not ALSO an unhandled rejection.
    // Do not "fix" them into a debug line; that is a duplicate, not a label.
    void attempt.ready.catch(() => {});
    void attempt.startup.catch(() => {});
    this.subprocessAttempt = attempt;
    return attempt;
  }

  private isCurrentSubprocessAttempt(attempt: PiSubprocessStartupAttempt): boolean {
    return this.subprocessAttempt === attempt && !attempt.cancelled;
  }

  private assertCurrentSubprocessAttempt(attempt: PiSubprocessStartupAttempt): void {
    if (!this.isCurrentSubprocessAttempt(attempt)) {
      throw new Error(`Pi subprocess startup attempt ${attempt.id} was cancelled`);
    }
  }

  private finishSubprocessAttempt(attempt: PiSubprocessStartupAttempt): void {
    if (!this.isCurrentSubprocessAttempt(attempt) || attempt.startupSettled) return;
    attempt.startupSettled = true;
    attempt.resolveStartup();
  }

  private cancelSubprocessAttempt(attempt: PiSubprocessStartupAttempt, error: Error): boolean {
    if (!this.isCurrentSubprocessAttempt(attempt)) return false;
    attempt.cancelled = true;
    this.subprocessAttempt = null;
    if (!attempt.readySettled) {
      attempt.readySettled = true;
      attempt.rejectReady(error);
    }
    if (!attempt.startupSettled) {
      attempt.startupSettled = true;
      attempt.rejectStartup(error);
    }
    return true;
  }

  private failSubprocessAttempt(
    attempt: PiSubprocessStartupAttempt,
    error: Error,
    child: ChildProcess | null = this.subprocess,
    readline: ReadlineInterface | null = this.readline,
  ): boolean {
    if (!this.cancelSubprocessAttempt(attempt, error)) return false;
    this.rejectPendingSubprocessRequests(error);
    if (this.readline === readline) this.readline = null;
    if (this.subprocess === child) this.subprocess = null;
    this.queueCapturedSubprocessTermination(child, readline);
    return true;
  }

  private waitForCapturedSubprocessExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode) return Promise.resolve(true);
    return new Promise(resolve => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (exited: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeListener('exit', onExit);
        resolve(exited);
      };
      const onExit = () => finish(true);
      child.once('exit', onExit);
      timer = setTimeout(() => finish(false), timeoutMs);
    });
  }

  private async terminateCapturedSubprocess(
    child: ChildProcess | null,
    readline: ReadlineInterface | null,
    gracefulTimeoutMs = 2_000,
    forcedTimeoutMs = 1_000,
  ): Promise<void> {
    readline?.removeAllListeners();
    readline?.close();
    if (!child) return;

    const gracefulExit = this.waitForCapturedSubprocessExit(child, gracefulTimeoutMs);
    try {
      child.kill('SIGTERM');
    } catch {
      // Already gone; the bounded wait below still observes the captured child.
    }
    if (await gracefulExit) return;

    const forcedExit = this.waitForCapturedSubprocessExit(child, forcedTimeoutMs);
    try {
      child.kill('SIGKILL');
    } catch {
      // The captured child may already be gone, but keep the bounded exit
      // observation as the termination barrier for the next generation.
    }
    if (!await forcedExit) {
      throw new Error(`pi-subprocess-termination-unconfirmed:${child.pid ?? 'unknown'}`);
    }
  }

  private clearCapturedSubprocessReferences(
    child: ChildProcess | null,
    readline: ReadlineInterface | null,
  ): void {
    if (this.readline === readline) this.readline = null;
    if (this.subprocess !== child) return;

    this.subprocess = null;
    // (F1.710: no callback port to clear.)
    this.preToolMetadataByCallId.clear();
    this.editFeedbackInputByCallId.clear();
    this.pendingEditFeedback.clear();
    this.adapter.resetOverflowState();
  }

  private logSubprocessCleanupFailure(error: unknown): void {
    try {
      this.debug(
        `Pi subprocess cleanup failed: ${PiAgent.describeThrown(error)}`,
      );
    } catch {
      // Cleanup observation must never replace the original termination failure.
    }
  }

  private async drainCapturedSubprocessTerminations(): Promise<void> {
    while (this.pendingSubprocessTerminations.length > 0) {
      const target = this.pendingSubprocessTerminations[0]!;
      await this.terminateCapturedSubprocess(target.child, target.readline);
      this.clearCapturedSubprocessReferences(target.child, target.readline);
      if (this.pendingSubprocessTerminations[0] === target) {
        this.pendingSubprocessTerminations.shift();
      }
    }
  }

  private startCapturedSubprocessTermination(): Promise<void> {
    const running = this.subprocessTerminationState === 'running'
      ? this.subprocessTermination
      : null;
    if (running) return running;

    let termination!: Promise<void>;
    this.subprocessTerminationState = 'running';
    termination = this.drainCapturedSubprocessTerminations().catch(error => {
      if (this.subprocessTermination === termination) {
        this.subprocessTerminationState = 'failed';
      }
      this.logSubprocessCleanupFailure(error);
      throw error;
    });
    this.subprocessTermination = termination;
    // Detached error/exit cleanup has no direct awaiter. Observe its rejection
    // while retaining the rejected barrier and captured child for an explicit
    // retry by disposal or the next subprocess admission attempt.
    //
    // P2.334: already AT the family's full standard, and the label is four lines
    // up — the `.catch` that built `termination` calls
    // `logSubprocessCleanupFailure(error)` and then RE-THROWS to keep the barrier
    // rejected. This line closes the escape on the retained copy; a handler with
    // a debug of its own would print the same failure twice.
    void termination.catch(() => {});
    void termination.then(
      () => {
        if (this.subprocessTermination !== termination) return;
        this.subprocessTermination = null;
        this.subprocessTerminationState = null;
        if (this.pendingSubprocessTerminations.length > 0) {
          this.startCapturedSubprocessTermination();
        }
      },
      () => {},
    );
    return termination;
  }

  private async awaitSubprocessTerminationBarrier(): Promise<void> {
    if (this.pendingSubprocessTerminations.length === 0) {
      if (this.subprocessTermination) await this.subprocessTermination;
      return;
    }

    await this.startCapturedSubprocessTermination();
  }

  private retainCapturedSubprocessTerminationFailure(
    child: ChildProcess,
    readline: ReadlineInterface | null,
    error: unknown,
  ): void {
    if (!this.pendingSubprocessTerminations.some(
      target => target.child === child && target.readline === readline,
    )) {
      this.pendingSubprocessTerminations.push({ child, readline });
    }

    const retained = Promise.reject<void>(error);
    // P2.334: same verdict as the observer in `startCapturedSubprocessTermination`
    // — escape closed here, name emitted by the `logSubprocessCleanupFailure`
    // three lines down, which is this method's own last statement.
    void retained.catch(() => {});
    this.subprocessTermination = retained;
    this.subprocessTerminationState = 'failed';
    this.logSubprocessCleanupFailure(error);
  }

  private queueCapturedSubprocessTermination(
    child: ChildProcess | null,
    readline: ReadlineInterface | null,
  ): void {
    if (!child && !readline) return;
    if (!this.pendingSubprocessTerminations.some(
      target => target.child === child && target.readline === readline,
    )) {
      this.pendingSubprocessTerminations.push({ child, readline });
    }
    if (this.subprocessTerminationState !== 'running') {
      this.startCapturedSubprocessTermination();
    }
  }

  private handleSubprocessError(
    error: Error,
    attempt: PiSubprocessStartupAttempt | null = this.subprocessAttempt,
    child: ChildProcess | null = this.subprocess,
    readline: ReadlineInterface | null = this.readline,
  ): void {
    if (attempt && !this.isCurrentSubprocessAttempt(attempt)) return;
    if (attempt) {
      const startupSettled = attempt.startupSettled;
      if (!this.failSubprocessAttempt(attempt, error, child, readline)) return;
      if (!startupSettled) return;
    } else {
      this.rejectPendingSubprocessRequests(error);
      if (this.readline === readline) this.readline = null;
      if (this.subprocess === child) this.subprocess = null;
      this.queueCapturedSubprocessTermination(child, readline);
    }
    this.debug(`Subprocess error: ${error.message}`);
    this.resetSubprocessErrorDedup();
    this.eventQueue.enqueue({ type: 'error', message: `Pi subprocess error: ${error.message}` });
    this.eventQueue.complete();
  }

  /**
   * Spawn the pi-agent-server subprocess and set up JSONL communication.
   */
  private async spawnSubprocess(attempt: PiSubprocessStartupAttempt): Promise<void> {
    if (!this.capabilityTurnRuntime?.piExecutionManifestSeed) {
      throw new Error('Pi capability runtime manifest is required before subprocess spawn');
    }
    const execution = this.buildExecutionManifestForCurrentTurn();
    this.assertCurrentSubprocessAttempt(attempt);
    const runtime = getBackendRuntime(this.config);
    const piServerPath = runtime.paths?.piServer;
    if (!piServerPath) {
      throw new Error('piServerPath not configured. Cannot spawn Pi subprocess.');
    }

    const nodePath = runtime.paths?.node || process.execPath;
    const cwd = this.resolvedCwd();

    this.debug(`Spawning Pi subprocess: ${nodePath} ${piServerPath}`);
    // P6.145 · the three-runtime tool-search disposition report. Pi is the arm
    // the knob actually governs and it was the arm with no report: the only
    // caller was `buildClaudeSubprocessEnv`, so the runtime whose client-side
    // catalog does the deferring said nothing about it while claude did.
    reportToolSearchDisposition();
    this.resetSubprocessErrorDedup();

    // Build session ID and session dir path upfront (used for spawn env + init command)
    const sessionId = this.config.session?.id || `agent-${Date.now()}`;
    const sessionDir = this.config.session
      ? join(this.config.workspace.sessionRootPath, sessionId)
      : undefined;

    // Build spawn args — optionally preload the network interceptor
    // for tool metadata injection/capture across all API formats. F1.1063 · Bun's own switches come first, so the
    // PROJECT folder (this spawn's cwd) cannot hand the Pi server its `.env` files or a `bunfig.toml` preload; the
    // measurement, and why a Node or Electron runtime gets none, are in `bun-project-isolation.ts`.
    const args = [...bunProjectIsolationArgs(nodePath), piServerPath];
    const interceptorPath = runtime.paths?.interceptor;
    if (interceptorPath) args.unshift('--require', interceptorPath);

    // Resolve credentials before spawning so we can derive AWS env vars
    // from the same fetch that produces piAuth (single source of truth).

    // For Copilot OAuth: preemptively refresh the short-lived Copilot token
    // before fetching credentials, so getPiAuth() picks up a fresh token.
    // refreshAndPushTokens guards this.subprocess internally — safe to call pre-spawn.
    if (this.config.authType === 'oauth' && runtime.piAuthProvider === 'github-copilot') {
      const slug = this.config.connectionSlug || 'pi';
      const stored = await getCredentialManager().getLlmOAuth(slug);
      this.assertCurrentSubprocessAttempt(attempt);
      if (stored?.refreshToken && (!stored.expiresAt || stored.expiresAt < Date.now() + 5 * 60_000)) {
        this.debug('Copilot token expired or expiring soon — refreshing before session start');
        await this.refreshAndPushTokens();
        this.assertCurrentSubprocessAttempt(attempt);
      }
    }

    // Retrieve auth credentials for the subprocess.
    // Custom endpoint mode must NOT fall back to global API keys — keyless local endpoints
    // are valid, and non-local endpoints should fail explicitly instead of using unrelated creds.
    const piAuth = await this.getPiAuth();
    this.assertCurrentSubprocessAttempt(attempt);
    const isCustomEndpointMode = !!runtime.customEndpoint;
    const legacyApiKey = (!piAuth && !isCustomEndpointMode) ? await this.getApiKey() : undefined;
    this.assertCurrentSubprocessAttempt(attempt);
    if (isCustomEndpointMode && !piAuth) {
      this.debug('Custom endpoint mode: no provider credential configured, sending empty API key');
    }

    // Derive AWS env vars from the piAuth credential (single fetch, no race).
    const awsEnv = this.buildAwsEnv(piAuth, runtime);

    // P6.691 · the connection's chosen credential header, for the interceptor
    // preloaded into the child. `getLlmConnection` rather than `runtime`: the
    // field lives on `LlmConnection.customEndpoint`, which is where the two other
    // runtimes read it from too (`drivers/anthropic.ts`, `drivers/codex.ts`), and
    // `BackendRuntime.customEndpoint` is `{ api, supportsImages? }` with nowhere
    // to put it.
    const credentialHeader = this.config.connectionSlug
      ? getLlmConnection(this.config.connectionSlug)?.customEndpoint?.credentialHeader
      : undefined;

    // C3.274 — the host's own debug switch, resolved ONCE. It decides two things
    // that must never disagree: what the child is told (`NESSY_DEBUG` below) and
    // whether this run writes a per-session diagnostic file at all.
    const hostDebug = process.argv.includes('--debug') || process.env.NESSY_DEBUG === '1';

    // Spawn the subprocess
    this.assertCurrentSubprocessAttempt(attempt);
    const child = this.spawnProcess(nodePath, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildPiSubprocessEnv({
        processEnv: process.env,
        proxyEnv: getProxyEnvVars(),
        envOverrides: this.config.envOverrides,
        awsEnv,
        sessionDir,
        workspaceId: this.config.workspace.id,
        sessionId,
        debug: hostDebug,
        // P6.691 · read from the CONNECTION rather than from `BackendRuntime`,
        // because `BackendRuntime.customEndpoint` is `{ api, supportsImages? }`
        // and carries no credential field — widening that type would change a
        // contract three backends share to serve one of them.
        ...(credentialHeader ? { credentialHeader } : {}),
        // P7.3/P7.10 · the bundle's own directory, which is where
        // `write-dist-package.ts` (dev) and `copyPiAgentServer` (packaged) plant
        // the Pi package identity. Derived from the path we are about to spawn,
        // so the two layouts need no branch here and cannot drift apart.
        piBundleDir: dirname(piServerPath),
      }),
    });

    if (!this.isCurrentSubprocessAttempt(attempt)) {
      child.kill('SIGTERM');
      throw new Error(`Pi subprocess startup attempt ${attempt.id} was cancelled`);
    }
    this.subprocess = child;
    if (!this.isCurrentSubprocessAttempt(attempt)) {
      this.subprocess = null;
      child.kill('SIGTERM');
      throw new Error(`Pi subprocess startup attempt ${attempt.id} was cancelled`);
    }

    // Set up readline for JSONL parsing from stdout
    const readline = createInterface({
      input: child.stdout!,
      crlfDelay: Infinity,
    });
    this.readline = readline;

    readline.on('line', (line: string) => {
      this.handleLine(line, attempt, child);
    });

    // C3.274 — the Pi arm of the host-owned per-session diagnostic, opened here
    // and held as a LOCAL rather than on `this`: Pi respawns its subprocess
    // within one session, and a field would let a stale child close the live
    // run's file. Bound to this child, closed by this child's own end events.
    //
    // `sessionRuntimeDebugLogPath('pi', …)` accepted this runtime name from the
    // day C3.215 wrote it and no caller ever passed it, so a Pi session had no
    // diagnostic file while a claude session had one in a directory the product
    // names. Pi publishes nothing of its own to point at (the reading is in
    // `openSessionRuntimeDebugLog`'s docblock), so the host writes the file from
    // the stderr pipe it already owns — the same bytes the ring buffer and the
    // host debug log below already receive, at no cost to either.
    const diagnosticLog = openSessionRuntimeDebugLog('pi', sessionId, hostDebug);
    if (diagnosticLog) {
      diagnosticLog.write(sessionRuntimeDebugLogHeader('pi', sessionId));
      // Said once per run, in the host log, because a file nobody can find is
      // the same as no file — this is the claude arm's disclosure line for Pi.
      this.debug(
        `[pi] C3.274 — this Pi session writes its runtime diagnostic to ${diagnosticLog.path}. `
        + 'Written only because the host is in debug mode; the claude arm takes the same directory '
        + 'and codex has no per-session debug file of its own.',
      );
      // C3.302 — and said once per SESSION where the user reads it, which the
      // line above is not: the host log is the channel a developer tails, and
      // the person who turned debug mode on did so to produce a report.
      //
      // `noteSessionNoticeOnce` and not a `yield`: this is a spawn path, and Pi
      // RESPAWNS inside one session — the dedupe set is what turns three
      // respawns into one sentence about a file whose path never changed.
      //
      // The copy names the file AND says it can carry prompt text. That is the
      // posture C3.274 took (debug-mode only, because a plaintext per-session
      // runtime log is not a free win) stated to the person who has to decide
      // whether to attach it to a ticket, rather than only in a docblock.
      //
      // C3.336 — the claude arm says the same thing now, and the two arms differ
      // only in how the path is obtained: its own is chosen inside
      // `buildClaudeSubprocessEnv`, a module function with no agent in scope, so
      // it is read back off that environment (`options.ts` symbol
      // `claudeSessionDiagnosticPath`) and YIELDED from the option builder
      // rather than queued — that builder runs past the drain at the top of
      // `chat()`. The key is runtime-neutral and takes the path as a value,
      // which is why each arm is one call.
      this.noteSessionNoticeOnce('chat.runtimeDiagnostic.path', { path: diagnosticLog.path });
    }

    // Always capture stderr into a bounded ring buffer so callers (e.g. the
    // connection-test timeout path in factory.ts) can surface it on failure.
    // Keep the NESSY_DEBUG-gated log for interactive dev work.
    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      this.recordStderr(text);
      // The FULL chunk, never the trimmed line below: the ring buffer holds
      // ~8 KB and the host log drops empty chunks, so the file is the only place
      // a long startup trace survives whole.
      diagnosticLog?.write(text);
      const trimmed = text.trim();
      if (trimmed) {
        this.debug(`[subprocess stderr] ${trimmed}`);
      }
    });

    // Handle subprocess exit
    child.on('exit', (code, signal) => {
      diagnosticLog?.close();
      this.handleSubprocessExit(code, signal, attempt, child, readline);
    });

    child.on('error', (error) => {
      diagnosticLog?.close();
      this.handleSubprocessError(error, attempt, child, readline);
    });

    const sessionPath = this.config.session
      ? getSessionDirPath(this.config.workspace.id, sessionId)
      : '';
    // P6.704 - ROW CORRECTION: the row's `plansFolderPath:` grep missed Pi,
    // which builds the value into a local first, so three Pi sites carry the
    // same decision as the five the row names. Unset is byte-identical.
    const plansFolderPath = resolvePlansDirectory(this.workingDirectory)
      ?? getSessionPlansDir(this.config.workspace.id, sessionId);
    const workingDirectory = this.config.session?.workingDirectory || cwd;
    // Send init command (flat structure matching subprocess InboundMessage type)
    this.send(buildPiInitMessage({
      apiKey: legacyApiKey || '',
      model: this._model,
      cwd,
      thinkingLevel: this._thinkingLevel,
      workspaceRootPath: this.config.workspace.workspaceRootPath,
      filesystemScope: this.config.filesystemScope,
      sessionId,
      sessionPath,
      workingDirectory,
      plansFolderPath,
      // R10: headless runs never auto-background MCP calls unless the
      // NESSY_AUTO_BACKGROUND_TASKS opt-in is set (decided in the subprocess).
      isHeadless: this.config.isHeadless === true,
      // R48: seed the subprocess's session WebSearch budget with the tree
      // count already consumed (last reported total, or the child seed for a
      // subagent session). Read at SPAWN time so a respawned subprocess
      // continues the count instead of restarting it; /clear zeroes the
      // source via `onPiWebSearchUsage(0)` in `clearHistory()`.
      webSearchesUsed: this.config.getPiWebSearchesUsed?.(),
      projectTrusted: this.config.projectTrusted === true,
      // ADVICE ONLY. The subprocess uses it for the advisory large-run warning
      // threshold; the run itself is never bounded by it.
      workflowSizeGuideline: this.capabilityTurnRuntime?.workflowSettings?.sizeGuideline,
      miniModel: this.config.miniModel,
      providerType: this.config.providerType,
      authType: this.config.authType,
      workspaceId: this.config.workspace.id,
      piAuth,
      baseUrl: runtime.baseUrl,
      customEndpoint: runtime.customEndpoint,
      customModels: runtime.customModels,
      contextProfile: this.config.contextProfile ?? 'bare',
      deferredMcpToolLoading: loadConfigDefaults().workspaceDefaults.deferredMcpToolLoading,
      executionManifest: execution.manifest,
      orchestrator: execution.manifest.orchestrator,
      // Finding 3 (2026-08-10 final-branch review): this used to forward the
      // RAW, un-expanded list. `resolvePiAllowedBindingNames`
      // (pi-agent-server/src/harness/tool-manifest.ts) matches it against the
      // manifest by EXACT presented-name equality, so a restricted
      // child/subagent session whose ceiling still named a plugin server's
      // pre-T2 bare name lost that tool on the subprocess side even though
      // the host-side manifest gate below already admitted it — the alias was
      // computed but never reached the model. Expand here too, so the ceiling
      // sent over the wire matches the one the manifest was built against.
      allowedToolNames: this.config.piAllowedTools
        ? this.expandMcpPatternAliases(this.config.piAllowedTools)
        : this.config.piAllowedTools,
      piContextResources: this.config.piContextResources,
      piRuntimeAgentDefinitions: this.config.piRuntimeAgentDefinitions,
      continuationActivatedTools: this.initContinuationActivatedTools(), // F1.1119 — see the method
      capabilityCatalogKinds: this.buildCapabilityCatalogKinds(),
      // Branch params for Pi SDK session fork. The parent session path is derived
      // TRANSIENTLY from the composite branchFrom.parent SessionKey immediately before
      // init and is never persisted back to JSONL. It resolves to the parent's global v2
      // session directory — the same `sessionPath` the parent subprocess wrote its
      // `.pi-sessions` sidecars under — so the child's fork preflight locates them.
      branchFromSdkSessionId: this.config.session?.branchFrom?.sdkSessionId,
      branchFromSessionPath: this.config.session?.branchFrom?.parent
        ? getSessionDirPath(this.config.workspace.id, this.config.session.branchFrom.parent.sessionId)
        : undefined,
      branchFromSdkTurnId: this.config.session?.branchFrom?.sdkTurnId,
      // T7 · the carry file, sent only when THIS turn's handoff is a native one
      // this agent already claimed. `pendingRuntimeHandoff` is set by
      // `BaseAgent.chat` from `shouldSuppressTextHandoff` — which is the method
      // that checked the file is loadable — so the two answers cannot disagree,
      // and a spawn that happens for any other reason (an `llm_query`, a
      // capability refresh) carries no carry file and forks nothing.
      carryHistorySessionFile: this.pendingRuntimeHandoff ? this.carryHistorySessionFile() : undefined, ...this.takePiResumeInitFields(), // UA12.217 — the one-shot spawn posture, consumed here
    }));

    // Wait for subprocess to report ready
    await attempt.ready;
    this.assertCurrentSubprocessAttempt(attempt);
    this.debug('Pi subprocess is ready');

    await this.publishExecutionManifest(execution, execution.manifest);

    // Seed the subprocess before it constructs the Pi session. The setting and
    // env/managed layers only govern automatic compaction; manual /compact is
    // handled by requestCompact and remains independent.
    //
    // C3.383 — "before it constructs" describes the SEED, not this await. The
    // subprocess stores the policy synchronously on receipt and then answers
    // this message by constructing the session, so what is awaited here is the
    // bring-up itself; `requestSetAutoCompaction`'s docblock carries the
    // measurement and the budget that follows from it. The returned boolean is
    // read by the debug line below and by nothing else — it is the session's
    // own `autoCompactionEnabled` after Pi's per-model resolution, kept because
    // it is the only place that value is ever observable from the host.
    const autoCompaction = this.config.autoCompaction ?? { enabled: true };
    const enabled = await this.requestSetAutoCompaction(autoCompaction, true);
    this.debug(`PI auto-compaction enabled: ${enabled}`);
    this.assertCurrentSubprocessAttempt(attempt);

  }

  /**
   * True when a desired MCP source still contributes no tool descriptors.
   *
   * Connect is no longer awaited before the chat starts, so a server can be
   * desired while neither connected nor present in the durable descriptor cache.
   * Its tools cannot be advertised, so the manifest must ship the discovery
   * surface instead — otherwise the turn would silently have no way to reach it.
   * Asks the pool rather than duplicating its state.
   */
  private hasDesiredMcpSourceWithoutDescriptors(): boolean {
    const pool = this.mcpPool;
    const leaserId = this.config.mcpLeaserId;
    if (!pool || !leaserId) return false;
    return [...pool.slugsForLeaser(leaserId)].some(slug => pool.getTools(slug, leaserId).length === 0);
  }

  /**
   * P3.279 — the OTHER half of what the model learns about an MCP server, on
   * the one runtime that never received it.
   *
   * `mcp.md#scale-with-mcp-tool-search`, verbatim: *"Only tool names and server
   * instructions load at session start, so adding more MCP servers has minimal
   * impact on your context window."* P3.228 delivered that second half on two
   * surfaces — `claude-agent.ts` passes it per source into the SDK's
   * `CreateSdkMcpServerOptions.instructions`, and `McpPoolServer` composes it
   * into the one `instructions` slot its flattened server has — and `McpPoolServer`
   * is **codex-only**, so Pi got neither. Not stale: absent. Pi advertises an MCP
   * server's tool NAMES and nothing the server said about itself.
   *
   * ## Why the system prompt and not a protocol field
   *
   * Pi has no MCP server to hand this to. Its sources reach the model as PROXY
   * TOOLS injected into the manifest (`buildCurrentProxyToolDefinitions`), so the
   * only place instructions can land is prompt text — which means this path,
   * alone of the three, has to supply the frame the MCP protocol supplies for the
   * other two. Hence an element naming what the block is, and the same `## <slug>`
   * heading `McpPoolServer.aggregateSourceInstructions` uses: the heading is the
   * only thing telling the model which server a paragraph is about, and keeping
   * the two spellings identical is what stops an MCP server's instructions from
   * changing shape across a Pi↔codex switch.
   *
   * The pool is asked, never duplicated: `getInstructions` answers only for a
   * LIVE connection (deliberately not served from the durable descriptor cache —
   * stale prose is worse than none), so a source that has not connected yet
   * contributes nothing this turn and contributes on the next one. That is
   * strictly better than the two subprocess-protocol surfaces, where
   * `instructions` travel in `initialize` and the protocol has no list-changed
   * equivalent, so a late source waits for the next handshake. Recorded rather
   * than hidden: this composition runs per turn because Pi's system prompt does.
   */
  private composeMcpServerInstructions(): string | undefined {
    const pool = this.mcpPool;
    if (!pool || isHostConsultChildConfig(this.config)) return undefined; // F1.893: a Guardian judge (the F1.892 predicate) composes no server's words, whatever the pool holds — with no leaser id the read below is unscoped, EVERY connected server
    const leaserId = this.config.mcpLeaserId;
    const slugs = leaserId !== undefined ? [...pool.slugsForLeaser(leaserId)] : pool.getConnectedSlugs();
    const blocks: string[] = [];
    for (const slug of slugs) {
      const instructions = pool.getInstructions(slug, leaserId);
      if (instructions) blocks.push(`## ${slug}\n\n${capMcpText(instructions)}`);
    }
    if (blocks.length === 0) return undefined;
    return `<mcp_server_instructions>\n${MCP_SERVER_INSTRUCTIONS_PREAMBLE}\n\n${blocks.join('\n\n')}\n</mcp_server_instructions>`;
  }

  private buildCurrentProxyToolDefinitions(): ProxyToolDef[] {
    this.assertBackendSessionToolParity();
    // UB6.11 — the decide tool rides the per-turn projection gated by the bound
    // port, exactly as the advisor gate below rides its setting: a decision
    // provider configured mid-session offers the tool on the NEXT turn (the
    // manifest re-registers per turn), and one de-configured likewise withdraws
    // it. Read from the same registry every host seam uses (the D3 live-find
    // note on `getSessionToolContext`).
    const decidePortBound = Boolean(
      getSessionScopedToolCallbacks({
        workspaceId: this.config.workspace.id,
        sessionId: this.config.session?.id || this._sessionId,
      })?.decide,
    );
    let sessionToolDefs = getSessionToolProxyDefs({ decidePort: decidePortBound }).map(definition => ({ ...definition }));
    if (!getBrowserToolEnabled()) {
      sessionToolDefs = sessionToolDefs.filter(definition => definition.name !== 'mcp__session__browser_tool');
    }
    // P2.1 — the advisor is OPT-IN and ships OFF, so a disabled advisor must not
    // put its schema in front of a model that would only be told "turned off".
    // Same shape as the browser gate above, and it belongs HERE rather than at
    // registry level: `getAdvisorEnabled` is a host config read and
    // `session-tools-core` has no dependency on `shared`. This whole builder
    // runs per turn (`buildExecutionManifestForCurrentTurn`), so `/advisor on`
    // takes effect on the next turn — no session is stranded on the setting it
    // started with, and the consult-time gate in `BaseAgent` stays as the
    // second belt for a tool call that raced the toggle.
    if (!getAdvisorEnabled()) {
      sessionToolDefs = sessionToolDefs.filter(definition => definition.name !== 'mcp__session__advisor_consult');
    }
    // The MCP resource tools are auto-provided only when a connected source
    // advertises the resources capability, matching Claude ("Claude Code
    // automatically provides tools to list and read MCP resources when servers
    // support them"). hasResourceCapability reads the capability captured at
    // connect, so this is correct even before the first (lazy) resource discovery.
    if (!(this.mcpPool?.hasResourceCapability(this.config.mcpLeaserId) ?? false)) {
      sessionToolDefs = sessionToolDefs.filter(definition =>
        definition.name !== 'mcp__session__list_mcp_resources'
        && definition.name !== 'mcp__session__read_mcp_resource');
    }
    if (this.config.miniModel) {
      const callLlmDef = sessionToolDefs.find(definition => definition.name === 'mcp__session__call_llm');
      if (callLlmDef) {
        callLlmDef.description += `\n\nDefault fast model for this session: ${this.config.miniModel}. Omit the model parameter to use it automatically.`;
      }
    }
    const lsp = projectReadyPiLspTool(this.config.lspPort);
    const lspTools: ProxyToolDef[] = lsp
      ? [{ ...lsp, inputSchema: lsp.inputSchema as unknown as Record<string, unknown> }]
      : [];
    // CI1 formatter dispatch: project the `format` op ONLY when the server
    // injected a runner (trusted project + feature enabled). Unlike the LSP
    // `formatting` op, this needs NO ready LSP server — it detects and runs the
    // project's own host formatter. Additive tool; the LSP schema is untouched.
    const formatTools: ProxyToolDef[] = this.formatRunner ? [FORMAT_PROXY_TOOL_DEF] : [];
    // P3.292 — the tool-DESCRIPTION half of `mcp.md#for-mcp-server-authors`'s
    // 2KB sentence, which no runtime in this tree implemented. Applied to the
    // MCP defs ALONE and not to `sessionToolDefs`, `lspTools` or `formatTools`:
    // those descriptions are ours, the page's sentence is about what an MCP
    // server author writes, and capping our own prose would cut a host tool's
    // schema guidance for a rule that was never about it.
    const mcpToolDefs = (this.mcpPool?.getProxyToolDefs(
      this.config.mcpLeaserId ? [...this.mcpPool.slugsForLeaser(this.config.mcpLeaserId)] : undefined,
      this.config.mcpLeaserId,
    ) ?? []).map(definition => ({ ...definition, description: capMcpText(definition.description) }));
    const tools = [
      ...sessionToolDefs,
      ...mcpToolDefs,
      ...lspTools,
      ...formatTools,
    ];
    if (!this.config.piAllowedTools) return tools;
    // T5: this filter narrows the proxy tool list itself, using the SAME
    // `piAllowedTools` source `buildExecutionManifestForCurrentTurn`'s
    // permission gate expands below — a restricted child/subagent session
    // (`piAllowedTools` from `managed.piChildRestrictions?.tools`) must not
    // lose a plugin MCP tool here just because this sibling filter forgot the
    // legacy-bare-name alias the other one already applies.
    const allowed = new Set(this.expandMcpPatternAliases(this.config.piAllowedTools));
    return tools.filter(definition => {
      const binding = getPiToolBindingByBindingName(definition.name);
      return allowed.has(definition.name) || (binding !== undefined && allowed.has(binding.piName));
    });
  }

  private buildCapabilityCatalogKinds(): Readonly<Record<string, 'plugin' | 'mcp' | 'app'>> {
    const view = this.capabilityTurnRuntime?.view;
    if (!view) return Object.freeze({});
    const appServerKeys = new Set(view.apps.flatMap(app => app.mcpServerKeys));
    const kinds: Record<string, 'plugin' | 'mcp' | 'app'> = {};
    for (const server of view.mcpServers) {
      kinds[server.key] = appServerKeys.has(server.key) ? 'app' : server.pluginInstanceId ? 'plugin' : 'mcp';
    }
    for (const source of view.sources) {
      if (source.mcpWireName) kinds[source.key] = 'mcp';
    }
    return Object.freeze(kinds);
  }

  /**
   * T5, one-release compatibility alias: T2 gave every plugin MCP server a
   * stable `plugin_<pluginId>_<serverName>` wire name, so it never contends
   * with a builtin/scoped server for a bare name again. `piAllowedTools` is
   * NOT user-authored — the only production setter is `SessionManager.ts`'s
   * `managed.piChildRestrictions.tools` (fed from `managed.piChildRestrictions`,
   * itself re-derived from the live manifest at spawn time) — but that
   * restriction can be a persisted child/fork session carried across the T2
   * rename, still holding a pattern written against the OLD bare name
   * (wildcard `mcp__<name>__*`, or an exact `mcp__<name>__<tool>`), which
   * would otherwise silently stop matching anything the moment the plugin
   * server it named gets qualified. For each such pattern, when EXACTLY ONE
   * active PLUGIN server still carries that bare name as its `logicalName`,
   * this also admits the equivalent pattern spelled against the server's
   * current wire name — an ambiguous bare name (two plugin servers sharing
   * one logical name) is left unexpanded, so a stale pattern can never
   * silently widen onto a plugin server the pattern never named. Finding 3
   * (2026-08-10 review): nor may it widen onto a bare name a builtin/scoped
   * server or a user MCP source already owns outright — that name already
   * resolves correctly on its own, so aliasing it besides would ADMIT a
   * plugin's tool the pattern never named, which is the dangerous direction
   * for anything read as a permission ceiling. Remove this alias once every
   * restriction captured before T2 has aged out (one release).
   */
  private expandMcpPatternAliases(patterns: readonly string[]): string[] {
    const view = this.capabilityTurnRuntime?.view;
    if (!view) return [...patterns];
    const byLogical = new Map<string, string[]>();
    for (const server of view.mcpServers) {
      if (!server.pluginInstanceId) continue;
      byLogical.set(server.logicalName, [...(byLogical.get(server.logicalName) ?? []), server.wireName]);
    }
    // Finding 3: a bare name already owned by a non-plugin mcpServers entry or
    // a user MCP source resolves correctly without any alias — this is exactly
    // the set of bare names a plugin can never legally shadow.
    //
    // Keyed by `logicalName`, deliberately, and NOT by `wireName`: a
    // non-plugin server's wire name equals its logical name only below the
    // 40-char mint cap, so a >40-char owner would be registered here under its
    // capped name while a pattern persisted before the cap still carries the
    // bare one — the guard would miss, and the alias would widen. Matching on
    // the uncapped name is the same key `runtime-agent-definition.ts`'s
    // contender count uses, so the two ownership checks cannot disagree.
    const ownedByNonPlugin = new Set<string>();
    for (const server of view.mcpServers) {
      if (server.pluginInstanceId) continue;
      ownedByNonPlugin.add(server.logicalName);
      ownedByNonPlugin.add(server.wireName);
    }
    for (const source of view.sources) {
      if (!source.mcpWireName) continue;
      ownedByNonPlugin.add(source.logicalName);
      ownedByNonPlugin.add(source.mcpWireName);
    }
    const out = [...patterns];
    for (const pattern of patterns) {
      // Two accepted shapes. A single greedy regex mis-captures an exact
      // name (`mcp__t-tracker__list` would capture `t-tracker__list`), so
      // the exact form reuses the manifest parser instead of a second regex.
      const wildcard = /^mcp__([A-Za-z0-9_-]+)__\*$/.exec(pattern);
      const exact = wildcard ? null : tryParsePiDynamicMcpBindingName(pattern);
      const name = wildcard?.[1] ?? exact?.wireName;
      if (!name) continue;
      // Measured fact, not a TODO: every consumer of this expanded set does
      // EXACT membership testing, never a glob match — the `allowed.has(...)`
      // check in `buildCurrentProxyToolDefinitions` and the
      // `configured.has(identity.bindingName) || configured.has(identity.piName)`
      // check in `buildExecutionManifestForCurrentTurn` (both this file), the
      // two `allowed.has(...)` checks in `pi-harness/harness-manifest.ts`, and
      // `parseSkillToolEntry(tool).name` in `base-agent.ts` all compare whole
      // strings. So an aliased `mcp__<wire>__*` entry admits nothing today,
      // before or after this expansion — the wildcard branch is inert. It
      // stays (rather than being dropped, or replaced with a real glob
      // matcher) so the alias is already correct for the wildcard SHAPE the
      // day something starts consuming `piAllowedTools` with one; deleting it
      // now would silently regress that day instead of doing nothing until it.
      const suffix = wildcard ? '__*' : `__${exact!.toolName}`;
      const wires = byLogical.get(name);
      if (wires?.length === 1 && wires[0] !== name && !ownedByNonPlugin.has(name)) {
        const aliased = `mcp__${wires[0]}${suffix}`;
        // The list may already hold both the stale bare pattern and its
        // already-migrated wire-qualified twin (a user who re-saved only
        // some of their patterns) — don't push a second copy. Harmless
        // downstream (every consumer reads this into a Set), but a clean
        // return is worth the one-line guard.
        if (!out.includes(aliased)) out.push(aliased);
      }
    }
    return out;
  }

  private buildExecutionManifestForCurrentTurn(): {
    manifest: PiExecutionManifestV2;
    tools: ManifestProxyToolDef[]; wholeToolDenyRefusals?: ReturnType<typeof piWholeToolDenyRefusals>;
  } {
    const runtime = this.capabilityTurnRuntime;
    if (!runtime) throw new Error('Pi execution manifest requires an active capability turn');
    if (!runtime.piExecutionManifestSeed) {
      throw new Error('Pi capability turn is missing its execution manifest seed');
    }
    const manifestSeed = runtime.piExecutionManifestSeed;
    runtime.materializer.assertActive();
    // Pin the orchestrator to the value the live subprocess was initialized with
    // (captured on the first build after a respawn). Threading the SAME
    // orchestrator into every manifest keeps it aligned with the subprocess's
    // init-pinned config across capability-runtime refreshes, so register_tools
    // never trips the orchestrator-mismatch integrity check mid-session.
    const orchestrator = this.subprocessOrchestrator ?? manifestSeed.orchestrator;
    this.subprocessOrchestrator = orchestrator;
    const orchestratorSeed = orchestrator === manifestSeed.orchestrator
      ? manifestSeed
      : { ...manifestSeed, orchestrator };
    const tools = this.buildCurrentProxyToolDefinitions();
    // Pinned tools stay in context regardless of deferral. Computed once here
    // rather than per tool: `alwaysLoadProxyToolNames` is a pure pool read.
    const alwaysLoadNames = this.mcpPool?.alwaysLoadProxyToolNames(
      this.config.mcpLeaserId ? [...this.mcpPool.slugsForLeaser(this.config.mcpLeaserId)] : undefined,
      this.config.mcpLeaserId,
    ) ?? new Set<string>();
    // N2: a proxy tool whose wireName doesn't resolve exactly once against
    // the seed's mcpSources (e.g. a plugin MCP server colliding by name with
    // a built-in dp server — the field incident this guards against) is
    // dropped with a debug line instead of failing the whole manifest, which
    // used to take every chat turn of the session down with it.
    // `finalizePiExecutionManifest` -> `resolveDynamicTool` applies the same
    // degrade rule again below, so this is a pre-filter, not the only guard.
    const dynamicTools: PiDynamicToolDefinition[] = [];
    for (const definition of tools) {
      const known = getPiToolBindingByBindingName(definition.name);
      const parsed = known ? undefined : tryParsePiDynamicMcpBindingName(definition.name);
      const sources = parsed
        ? manifestSeed.mcpSources.filter(value => value.wireName === parsed.wireName)
        : [];
      if (!known && (!parsed || sources.length !== 1)) {
        this.debug(`pi-manifest: proxy tool ${definition.name} skipped — wireName resolves ${sources.length} time(s) in the seed`);
        continue;
      }
      const source = sources[0];
      const binding = known ?? { descriptorId: 'mcp_dynamic' };
      const prompt = derivePiPromptMetadata({
        bindingName: definition.name,
        description: definition.description,
        descriptor: getHarnessToolDescriptor(binding.descriptorId),
      });
      dynamicTools.push({
        bindingName: definition.name,
        description: definition.description,
        inputSchema: definition.inputSchema,
        ...prompt,
        modelSchemaVersion: 1,
        bindingSchemaVersion: 1,
        ...(alwaysLoadNames.has(definition.name) ? { alwaysLoad: true } : {}),
        provenance: {
          capabilityKey: source?.capabilityKey ?? 'runtime:pi-session',
          generation: runtime.view.generation,
        },
      });
    }
    const permissionContext = this.permissionManager.getCapabilityPermissionsContext?.();
    const readablePolicy = permissionContext
      ? permissionsConfigCache.getMergedConfig(permissionContext).permissionDsl
      : undefined;
    // T5: expand once, reused at both use sites below — the plain fallback
    // assignment and `configured`'s narrowing set inside the readablePolicy
    // branch — so a stale bare-name pattern keeps matching its plugin
    // server's current wire name either way.
    const expandedAllowedTools = this.config.piAllowedTools
      ? this.expandMcpPatternAliases(this.config.piAllowedTools)
      : this.config.piAllowedTools;
    let allowedBindingNames = expandedAllowedTools;
    if (readablePolicy) {
      const configured = expandedAllowedTools ? new Set(expandedAllowedTools) : undefined;
      // F1.489 (3) (origin WJ-zz P-WJ-zz-3) — the capability identities come
      // from ONE function beside the filter they feed
      // (`pi-harness/session-tool-rule-alias.ts`, `piManifestCapabilityIdentities`),
      // and `whole-tool-deny-manifest.test.ts` calls that same function, so the
      // suite drives this derivation rather than a copy of it that could drift.
      //
      // What it builds is unchanged, one identity per tool, each
      // `{ bindingName, piName, semanticId, permissionName }`:
      //  - a static tool reads its binding and its descriptor;
      //  - a dynamic tool reads its known binding, else the synthesized binding
      //    `resolveDynamicTool` builds for an unknown name, which uses the
      //    binding name as its permissionName — so an MCP proxy tool is judged
      //    under the same wire spelling here as at the gate.
      //
      // The identities then go through the whole-tool deny filter below, under
      // both of a session tool's names (F1.478), and what survives becomes the
      // manifest's `allowedBindingNames`.
      //
      // This block spelled the build inline until F1.489 (3); it keeps that
      // block's line count because the docs cite this file by line.
      const capabilityIdentities = piManifestCapabilityIdentities(orchestratorSeed.staticTools, dynamicTools);
      // Whole-tool deny removal with the EndConversation exception
      // (permissions.md, R1 follow-up): a deny rule cannot remove it while
      // any other tool remains. No Pi binding carries that name today, so
      // the guard is name-based and self-activating.
      allowedBindingNames = filterCapabilityIdentitiesByWholeToolDenyUnderSessionToolAlias( // F1.478 — either name removes it
        capabilityIdentities.filter(identity => !configured
          || configured.has(identity.bindingName)
          || configured.has(identity.piName)),
        readablePolicy,
      ).map(identity => identity.bindingName);
    }
    const deferredMcpEnabled = loadConfigDefaults().workspaceDefaults.deferredMcpToolLoading === true;
    const manifest = finalizePiExecutionManifest(orchestratorSeed, dynamicTools, {
      deferredMcpEnabled,
      hasUncachedMcpSource: this.hasDesiredMcpSourceWithoutDescriptors(),
      // S14: `NESSY_ENABLE_TOOL_SEARCH` outranks the workspace preference above
      // (`tool-search.md:34` — "You can override either default with the
      // `ENABLE_TOOL_SEARCH` environment variable"). Resolved here, on the host,
      // so the signed manifest carries the decision and the subprocess cannot
      // reach a different one.
      toolSearchMode: toolSearchMode(),
      // Only `auto`/`auto:N` reads it, and only the catalog knows it. Absent for
      // a model outside the catalog, which `resolveDeferredMcpToolLoading`
      // handles with a stated fallback rather than silence.
      ...(this.catalogContextWindow === undefined ? {} : { modelContextWindow: this.catalogContextWindow }),
      ...(allowedBindingNames ? { allowedBindingNames } : {}),
      // The hard off switch. Applied to the SIGNED manifest so a disabled host
      // never advertises the tool and the subprocess never registers a handler
      // for it.
      ...(this.capabilityTurnRuntime?.workflowSettings?.disableWorkflows
        ? { disableWorkflows: true }
        : {}),
      // R10 off switch: NESSY_DISABLE_BACKGROUND_TASKS removes bash_background
      // from the signed manifest the same way (auto-background and
      // run_in_background consult the same predicate at their own seams).
      ...(backgroundTasksDisabled() ? { disableBackgroundTasks: true } : {}),
      debug: message => this.debug(message), // F1.706: a repeated name the manifest drops is reported, not silent
    });
    // F1.706: Pi takes exactly one wire definition per manifest tool with a `modelSchema` (its register_tools check), and it must be
    // the FIRST of its name, the one the manifest kept; a host tool has none. Pinned by pi-agent-server duplicate-proxy-wire-definition.test.ts.
    const unsentBindingNames = new Set(manifest.tools.filter(tool => tool.modelSchema).map(tool => tool.binding.bindingName));
    const promptByBindingName = new Map([...dynamicTools].reverse().map(tool => [tool.bindingName, tool])); // first-wins, as the manifest
    runtime.materializer.assertActive();
    return {
      manifest, wholeToolDenyRefusals: piWholeToolDenyRefusals(manifest, piManifestCapabilityIdentities(orchestratorSeed.staticTools, dynamicTools), readablePolicy), // F1.756
      // Keyed by binding name, NOT by index: the loop above `continue`s past a proxy tool it cannot resolve, so the lists are not parallel
      // (an index map was a TypeError that took every turn down, D3 wave). `delete` sends each kept name once, a repeat or host name never.
      tools: tools.filter(definition => unsentBindingNames.delete(definition.name)).map((definition) => {
        const prompt = promptByBindingName.get(definition.name);
        return {
          ...definition,
          ...(prompt?.promptSnippet ? { promptSnippet: prompt.promptSnippet } : {}),
          ...(prompt?.promptGuidelines ? { promptGuidelines: prompt.promptGuidelines } : {}),
        };
      }),
    };
  }

  private async publishExecutionManifest(
    execution: { manifest: PiExecutionManifestV2; tools: ManifestProxyToolDef[]; wholeToolDenyRefusals?: ReturnType<typeof piWholeToolDenyRefusals> },
    previousManifest?: PiExecutionManifestV2,
  ): Promise<void> {
    const sourceAttempt = this.subprocessAttempt;
    const responseEpoch = this.subprocessResponseEpoch;
    const runtime = this.capabilityTurnRuntime;
    if (!runtime?.piExecutionManifestSeed) {
      throw new Error('Pi execution manifest registration requires an active capability runtime');
    }
    const materializer = runtime.materializer;
    materializer.assertActive();
    if (runtime.view.generation !== execution.manifest.snapshotGeneration
      || runtime.piExecutionManifestSeed.snapshotGeneration !== execution.manifest.snapshotGeneration) {
      throw new Error('Pi execution manifest registration generation mismatch');
    }
    const previous = previousManifest
      ? { generation: previousManifest.snapshotGeneration, manifestHash: previousManifest.manifestHash }
      : this.activeExecutionManifest
        ? {
            generation: this.activeExecutionManifest.snapshotGeneration,
            manifestHash: this.activeExecutionManifest.manifestHash,
          }
        : this.lastExecutionManifestIdentity
          ?? { generation: execution.manifest.snapshotGeneration, manifestHash: execution.manifest.manifestHash };
    const id = `manifest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (!this.subprocess?.stdin?.writable) {
      throw new Error('Pi execution manifest registration failed: subprocess stdin not writable');
    }
    const registered = new Promise<{ generation: string; manifestHash: string }>((resolve, reject) => {
      this.pendingManifestRegistrations.set(id, { resolve, reject });
    });
    // Re-materialize the agent definitions for THIS generation and send them
    // with the manifest.
    //
    // `this.config.piRuntimeAgentDefinitions` is captured at construction and
    // never refreshed (the only `this.config` mutation in this file is
    // `updateRuntimeConfig`, which touches model/provider/auth/runtime). So
    // after a re-registration the subprocess held descriptors stamped for the
    // OLD generation while the manifest carried the new one, and rebuilding the
    // session from them threw — killing every subsequent turn. Measured live
    // 2026-08-14; `claude-security` alone ships seven agent capabilities, so
    // the precondition is an ordinary installed plugin.
    //
    // MATERIALIZED, never re-stamped: the descriptor's digest is computed from
    // its content and its generation together, so stamping a new generation
    // onto an existing descriptor makes the pair disagree and every spawn dies
    // on `runtime-agent-definition-identity-mismatch` instead. This is the same
    // call, with the same arguments, that the init path makes.
    //
    // Only when init sent them at all — a runtime that does not dispatch agent
    // definitions must not start receiving them here.
    const refreshedAgentDefinitions = this.config.piRuntimeAgentDefinitions
      ? await materializePiRuntimeAgentDefinitions({
          view: runtime.view,
          materializer,
          projectTrusted: this.config.projectTrusted === true,
          // P6.317 (2) — the session's `--agents` definitions, for the same
          // reason `projectTrusted` is here: both enter the definition DIGEST,
          // so a refresh that omitted them would rebuild a set that no longer
          // contains them, and the session would lose its headless agents
          // mid-run with nothing to read about it.
          ...(this.config.sessionAgents ? { sessionAgents: this.config.sessionAgents } : {}),
          onInvalidDefinition: diagnostic => this.debug(
            `[capability-diagnostics] agent definition skipped: ${diagnostic.file} — ${diagnostic.reason}`,
          ),
          onUntrustedComponentSkipped: diagnostic => this.debug(
            `[capability-diagnostics] ${diagnostic.file} — ${diagnostic.reason}`,
          ),
          // P6.315 · `onDescriptionsOverBudget` is DELIBERATELY NOT passed here,
          // and the omission is written down because W7-u's routing note names
          // this as one of the four sites that must wire it.
          //
          // The other three are `SessionManager`'s, and they are LOADS: each
          // materializes the definitions once, for a session or a child spawn.
          // This one is the per-turn REFRESH — the comment above says so — and
          // the budget is a property of the definition SET, not of the turn. A
          // workspace over budget would repeat one identical line on every turn
          // for the life of the session, which is how a real report becomes
          // something people filter out. Reported once at load, where it is
          // actionable.
        })
      : undefined;
    try {
      this.send({
        type: 'register_tools', id, tools: execution.tools, manifest: execution.manifest, previous,
        capabilityCatalogKinds: this.buildCapabilityCatalogKinds(), wholeToolDenyRefusals: [...(execution.wholeToolDenyRefusals ?? [])].map(([name, denied]) => ({ name, refusal: denied.refusal })), // F1.1100 — the subprocess tells the MODEL the rule (whole-tool-deny-context.ts)
        ...(refreshedAgentDefinitions ? { piRuntimeAgentDefinitions: refreshedAgentDefinitions } : {}),
      });
    } catch (error) {
      this.pendingManifestRegistrations.delete(id);
      throw error;
    }
    const accepted = await registered;
    this.lastExecutionManifestIdentity = accepted;
    if (accepted.generation !== execution.manifest.snapshotGeneration
      || accepted.manifestHash !== execution.manifest.manifestHash) {
      throw new Error('Pi execution manifest registration acknowledgement mismatch');
    }
    if (responseEpoch !== this.subprocessResponseEpoch) {
      this.clearExecutionManifestAuthority();
      throw new Error('Pi execution manifest registration acknowledged by a replaced subprocess');
    }
    try {
      if (sourceAttempt) this.assertCurrentSubprocessAttempt(sourceAttempt);
      materializer.assertActive();
    } catch (error) {
      this.clearExecutionManifestAuthority();
      throw error;
    }
    if (this.capabilityTurnRuntime !== runtime
      || runtime.view.generation !== execution.manifest.snapshotGeneration
      || runtime.piExecutionManifestSeed.snapshotGeneration !== execution.manifest.snapshotGeneration) {
      this.clearExecutionManifestAuthority();
      throw new Error('Pi execution manifest registration capability owner was replaced');
    }
    for (const [semanticId, lease] of this.continuationActivatedTools) {
      if (lease.capabilityGeneration !== execution.manifest.snapshotGeneration) {
        this.continuationActivatedTools.delete(semanticId);
      }
    }
    this.activeExecutionManifest = execution.manifest;
    this.adapter.setExecutionManifest(execution.manifest, execution.wholeToolDenyRefusals); // F1.756 — the adapter names the rule
    this.debug(`Registered Pi execution manifest ${execution.manifest.manifestHash} with ${execution.manifest.tools.length} tools`);

    // Deferred-call resume (R7 Task 5): the first manifest registration after
    // a resume is the earliest point the tool surface is known. Consume the
    // persisted record exactly once — apply the mode-restore rules, then
    // either exit tool_deferred_unavailable (tool gone) or let the resumed
    // turn re-drive the pending call, re-firing PreToolUse naturally.
    const deferredRecord = this.config.getDeferredToolCall?.();
    if (deferredRecord) {
      this.config.onToolCallDeferred?.(undefined);
      const restoredMode = resolveDeferredModeRestore({
        deferredMode: deferredRecord.permissionMode,
        // `auto` qualification is owned by the session layer: the
        // onPermissionModeChange handler runs the managed clamp
        // (normalizeManagedPermissionMode), which demotes an auto that the
        // host policy no longer allows on this very call.
        autoStillQualified: true,
      });
      if (restoredMode && restoredMode !== this.permissionManager.getPermissionMode()) {
        this.debug(`Restoring permission mode from deferred call: ${restoredMode}`);
        this.setPermissionMode(restoredMode);
      }
      this.resolveDeferredResume(deferredRecord);
    }
  }

  private assertActiveManifestRuntime(manifest: PiExecutionManifestV2): CapabilityTurnRuntime {
    const runtime = this.capabilityTurnRuntime;
    if (!runtime?.piExecutionManifestSeed) {
      throw new Error('Pi execution manifest requires an active capability turn');
    }
    runtime.materializer.assertActive();
    if (runtime.view.generation !== manifest.snapshotGeneration
      || runtime.piExecutionManifestSeed.snapshotGeneration !== manifest.snapshotGeneration) {
      throw new Error('Pi execution manifest does not match the active capability generation');
    }
    return runtime;
  }

  /**
   * P6.156's Pi arm — say once per session which bundled agents' declared model
   * tier resolves to nothing on this connection.
   *
   * Host-side by construction (case 2 of native-first): the builder, the
   * definitions and the tier map are all ours, and no runtime publishes a tier
   * mechanism to enable. Same builder as claude's arm
   * (`claudeBuiltinAgentTierDiagnostics`), so the two sentences cannot drift —
   * which is the whole reason P6.156 put the text in one place.
   *
   * Grade is deliberately W6-b's MEASURED one, not a stronger channel: the log,
   * latched once a session, never the transcript banner. Routed to the banner it
   * fires on most connections and contradicts an existing named control.
   */
  private noteBuiltinAgentTiersOnce(tierModelMap: BuiltinAgentTierModelMap | null | undefined): void {
    if (this.builtinTierNoticeEmitted) return;
    this.builtinTierNoticeEmitted = true;
    for (const line of buildBuiltinAgentTierNotice(tierModelMap ?? undefined)) {
      this.debug(line);
    }
  }

  private async syncExecutionManifestForCurrentTurn(): Promise<PiExecutionManifestV2> {
    const execution = this.buildExecutionManifestForCurrentTurn();
    this.noteBuiltinAgentTiersOnce(execution.manifest.orchestrator.tierModelMap);
    if (this.activeExecutionManifest?.manifestHash !== execution.manifest.manifestHash
      || this.activeExecutionManifest.snapshotGeneration !== execution.manifest.snapshotGeneration) {
      await this.publishExecutionManifest(execution);
    }
    return execution.manifest;
  }

  /**
   * Build structured Pi auth from connection config.
   * Returns a provider-aware credential object for the subprocess,
   * or null if no piAuthProvider is configured (falls back to legacy getApiKey).
   *
   * OAuth tokens from Nessy (Claude Max, ChatGPT Plus) leave here as api_key: the OAuth exchange
   * happens on the Nessy side, so what reaches Pi is a bearer access token (Copilot ships its real
   * oauth shape, below). Pi does not store that verbatim: `adaptCredentialForPiSdk` (pi-agent-server's
   * adapt-credential.ts, F1.242) rewraps it as oauth for an oauth-only provider and stores no iam.
   */
  private async getPiAuth(): Promise<{
    provider: string;
    credential:
      | { type: 'api_key'; key: string }
      | { type: 'oauth'; access: string; refresh: string; expires: number }
      | { type: 'iam'; accessKeyId: string; secretAccessKey: string; region?: string; sessionToken?: string }
  } | null> {
    const piAuthProvider = getBackendRuntime(this.config).piAuthProvider;
    if (!piAuthProvider) return null;

    try {
      const credentialManager = getCredentialManager();
      const slug = this.config.connectionSlug || 'pi';

      if (this.config.authType === 'oauth') {
        const oauth = await credentialManager.getLlmOAuth(slug);
        if (oauth?.accessToken) {
          // Copilot: pass full OAuth credential so the Pi SDK can derive the
          // correct API endpoint from the Copilot token's proxy-ep field.
          // The refresh token is the GitHub access token used to obtain fresh
          // Copilot tokens when they expire (~1 hour).
          if (piAuthProvider === 'github-copilot' && oauth.refreshToken) {
            this.debug(`Retrieved Copilot OAuth credential for Pi provider: ${piAuthProvider}`);
            return {
              provider: piAuthProvider,
              credential: {
                type: 'oauth',
                access: oauth.accessToken,
                refresh: oauth.refreshToken,
                expires: oauth.expiresAt ?? 0,
              },
            };
          }
          // Other OAuth providers: pass as api_key (bearer token)
          this.debug(`Retrieved OAuth access token for Pi provider: ${piAuthProvider}`);
          return {
            provider: piAuthProvider,
            credential: { type: 'api_key', key: oauth.accessToken },
          };
        }
      } else if (this.config.authType === 'iam_credentials') {
        // AWS IAM credentials — pass structured fields so the subprocess can
        // identify the credential type. Actual AWS env var injection happens
        // at spawn time (see spawnSubprocess) for proper process isolation.
        const iam = await credentialManager.getLlmIamCredentials(slug);
        if (iam) {
          this.debug(`Retrieved IAM credentials for Pi provider: ${piAuthProvider}`);
          return {
            provider: piAuthProvider,
            credential: {
              type: 'iam',
              accessKeyId: iam.accessKeyId,
              secretAccessKey: iam.secretAccessKey,
              region: iam.region,
              sessionToken: iam.sessionToken,
            },
          };
        }
      } else {
        // API key-based connections.
        // NOTE: authType === 'environment' (e.g. Bedrock with ~/.aws/credentials)
        // intentionally falls through here, finds no API key, and returns null.
        // The subprocess inherits process.env which contains the AWS credential chain.
        const gatewayJwt = this.getNestorGatewayJwt();
        if (gatewayJwt) {
          this.debug(`Retrieved Nessy Gateway JWT for Pi provider: ${piAuthProvider}`);
          return {
            provider: piAuthProvider,
            credential: { type: 'api_key', key: gatewayJwt },
          };
        }

        const apiKey = await credentialManager.getLlmApiKey(slug);
        if (apiKey && !isUsablePiStoredCredential(this.config, apiKey)) {
          // DA1.2, then DA1.13 — fail CLOSED. See `isUsablePiStoredCredential`:
          // a Nessy Gateway connection keeps no credential of its own, so a
          // value found here is a snapshot from before that rule and must not
          // leave as `Nestor-Token`. The live sign-in was already tried above.
          this.debug(
            'This Nessy Gateway connection keeps no stored credential; refusing the one found '
            + '(no credential sent) rather than letting it leave as Nestor-Token',
          );
          return null;
        }
        if (apiKey) {
          this.debug(`Retrieved API key credential for Pi provider: ${piAuthProvider}`);
          return {
            provider: piAuthProvider,
            credential: { type: 'api_key', key: apiKey },
          };
        }
      }

      this.debug(`No credentials found for Pi provider: ${piAuthProvider}`);
      return null;
    } catch (error) {
      // P2.332 sweep — `${error}` is not total (`String(Object.create(null))`
      // raises, P2.65) and it is evaluated BEFORE `debug`, so this file's belted
      // `debug` override cannot save a catch that throws while building its own
      // message. `describeThrown` is the total renderer this file already uses.
      this.debug(`Failed to retrieve Pi auth: ${PiAgent.describeThrown(error)}`);
      return null;
    }
  }

  /**
   * How the guardian's git facts are read (P6.203 working tree, P6.64 branch).
   *
   * Native mechanism: none on any runtime — our consult context is ours,
   * claude's classifier is inside the closed binary and silenced by A1, and
   * codex's `[auto_review].policy` is an operator config blob with no session
   * state in it. Host-side, once, for the one runtime that has a judge.
   *
   * `git` is spawned through a lazily imported `node:child_process`, which is
   * this file's existing idiom for a node dependency it needs in one place.
   * The subprocess is bounded three ways because it sits in front of every
   * borderline tool call: a 2-second memo per cwd (in each facts module), a
   * 3-second timeout, and a 1 MiB output cap — a repository large enough to
   * exceed that yields no line rather than a truncated one that could read as a
   * smaller tree than it is.
   *
   * Every failure is a REJECTION, which each reader turns into `undefined`, and
   * `undefined` renders no line at all: not a git repository, git not
   * installed, a timeout, a huge tree, a detached HEAD, no cached
   * `origin/HEAD`. The judge is never told a tree is clean, or a branch
   * unprotected, because the read failed — that is the one error this could
   * make that would matter, and it is closed by shape rather than by a catch.
   */
  private readonly runGuardianGit: GuardianGitRunner = async (argv, dir) => {
    const { execFile } = await import('node:child_process');
    return await new Promise<string>((resolve, reject) => {
      execFile(
        'git',
        [...argv],
        { cwd: dir, timeout: 3_000, maxBuffer: 1024 * 1024, windowsHide: true },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    });
  };

  /**
   * The one production `facts` builder, shared by both consult sites — the
   * borderline auto/plan consult and the bypass deny-net. Before P6.64 each
   * site assembled its own literal, which is how `gitBranch`/`protectedBranch`
   * came to be declared, rendered and set by nobody.
   */
  private buildGuardianConsultFacts(mode: string, cwd: string, workspaceRoot?: string) {
    return buildGuardianFacts({
      mode,
      cwd,
      ...(workspaceRoot ? { workspaceRoot } : {}),
      run: this.runGuardianGit,
    });
  }

  /**
   * The project's own instructions, bounded, for the judge (P6.203, A30).
   *
   * Read from the capability runtime the agent already holds — the SAME
   * `promptLayers` list `BaseAgent.composePinnedCapabilityContext` delivers to
   * the model — so the judge is weighing the instructions the agent is actually
   * following, rather than a second discovery of files by name that would drift
   * from it. `sliceProjectInstructions` owns the scope filter, the budget and
   * the two reasons for it.
   *
   * Memoised per capability GENERATION: one turn can raise many borderline
   * consults, the layer set is fixed for a generation, and re-reading the files
   * per consult would spend I/O on an answer that cannot have changed. The
   * generation is the same key `pinnedCapabilityContextCache` uses, so an
   * inventory change invalidates this with it.
   *
   * Absent — no runtime, no project layers, every read failing — renders no
   * section at all, which is today's behaviour. The judge is never told a
   * project said nothing because a file could not be read.
   */
  private guardianProjectInstructionsCache: {
    generation: string;
    value: GuardianProjectInstructions | undefined;
  } | null = null;

  private async buildGuardianProjectInstructions(): Promise<GuardianProjectInstructions | undefined> {
    const runtime = this.capabilityTurnRuntime;
    if (!runtime) return undefined;
    const generation = String(runtime.view.generation);
    if (this.guardianProjectInstructionsCache?.generation === generation) {
      return this.guardianProjectInstructionsCache.value;
    }
    let value: GuardianProjectInstructions | undefined;
    try {
      value = await sliceProjectInstructions({
        layers: runtime.view.promptLayers,
        readText: layer => runtime.materializer.readText(layer.resource),
      });
    } catch (error) {
      // A materializer that has been retired mid-turn throws rather than
      // returning; the judge losing this section is strictly better than the
      // consult failing, and the loss is visible as an absent section.
      this.debug(`Guardian project instructions unavailable: ${PiAgent.describeThrown(error)}`);
      value = undefined;
    }
    this.guardianProjectInstructionsCache = { generation, value };
    return value;
  }

  private getNestorGatewayJwt(): string | null {
    return resolveNestorGatewayJwtForPi(this.config);
  }

  /**
   * Build AWS environment variables from piAuth credentials for the subprocess.
   *
   * The Pi SDK's Bedrock provider reads from the AWS default credential chain
   * (env vars), not from Pi AuthStorage. We inject at spawn time so credentials
   * are scoped to the subprocess and don't leak to the main process.
   *
   * P6.257 CORRECTED what this note used to claim ("IAM credentials … cannot be
   * refreshed in a running subprocess. Long sessions with temporary credentials
   * (~1h STS tokens) will fail on expiry"). The env block below is still fixed
   * at spawn — a process's environment cannot be rewritten from outside — but
   * the SUBPROCESS can rewrite its own, and the Pi Bedrock provider reads it per
   * request: `getConfiguredBedrockCredentials(options.env)` runs inside `stream`,
   * and `getProviderEnvValue` falls through to `process.env` whenever the stored
   * credential carries no scoped `env` (ours carries none). Measured in the
   * installed `@earendil-works/pi-ai`, not assumed.
   *
   * So a rotation now reaches a live session: {@link refreshAndPushIamCredentials}
   * re-reads the store and pushes a `token_update`, and the subprocess's
   * `handleTokenUpdate` applies the AWS names to its own `process.env`.
   * What remains true is the residue named at
   * {@link bedrockIamCredentialFingerprint}: nothing records WHEN an STS token
   * expires, so the trigger is the failure rather than a countdown.
   */
  private buildAwsEnv(
    piAuth: Awaited<ReturnType<PiAgent['getPiAuth']>>,
    runtime: { piAuthProvider?: string },
  ): Record<string, string> {
    if (runtime.piAuthProvider !== 'amazon-bedrock') return {};

    const env: Record<string, string> = {};

    // P6.457 — report the region and WHERE it came from. Until now the only
    // writer was the connection's own credential, and an empty field left
    // `AWS_REGION` unset while `deriveBedrockRegionPrefix` had already silently
    // defaulted the model-id prefix to `us`: the promise the setup UI makes
    // ("uses your existing AWS credential chain") was unowned rather than
    // implemented or contradicted, and no surface reported the answer.
    const resolvedRegion = resolveBedrockRegion(
      piAuth?.credential.type === 'iam' ? piAuth.credential.region : undefined,
    );

    if (piAuth?.credential.type === 'iam') {
      env.AWS_ACCESS_KEY_ID = piAuth.credential.accessKeyId;
      env.AWS_SECRET_ACCESS_KEY = piAuth.credential.secretAccessKey;
      if (resolvedRegion) env.AWS_REGION = resolvedRegion.region;
      if (piAuth.credential.sessionToken) env.AWS_SESSION_TOKEN = piAuth.credential.sessionToken;
      this.lastPushedIamFingerprint = bedrockIamCredentialFingerprint(piAuth.credential);
      this.debug('Injecting IAM credentials into subprocess env for AWS SDK');
    }

    this.debug(describeBedrockRegion(resolvedRegion));

    // Defensive: force HTTP/1.1 for Bedrock. AWS SDK v3 defaults to HTTP/2
    // (NodeHttp2Handler) which can be incompatible with Bun/Electron runtimes.
    if (!process.env.AWS_BEDROCK_FORCE_HTTP1) {
      env.AWS_BEDROCK_FORCE_HTTP1 = '1';
    }

    return env;
  }

  /**
   * Re-read the stored Bedrock IAM credential and push it into the RUNNING
   * subprocess (P6.257) — the `iam_credentials` sibling of
   * {@link refreshAndPushTokens}, which is gated on `oauth` and so never fired
   * for Bedrock.
   *
   * There is no refresh CALL to make here, and that is the honest difference
   * from the OAuth path: an STS token is minted outside this app (`aws sso
   * login`, an admin tool, the connection form) and we hold no refresh token
   * for it. So this re-RESOLVES rather than refreshes — it re-reads the store
   * the user's re-entry writes — and the trigger is the subprocess's own auth
   * failure rather than a countdown, because nothing in the store records when
   * an STS token expires (see {@link bedrockIamCredentialFingerprint}).
   *
   * When the store has NOT moved, we say so instead of pushing the same dead
   * credential back: that is the case where the only remedy is the user's.
   */
  private async refreshAndPushIamCredentials(): Promise<void> {
    if (this.config.authType !== 'iam_credentials') return;
    if (!this.subprocess) return;

    const piAuth = await this.getPiAuth();
    if (!piAuth || piAuth.credential.type !== 'iam') {
      this.onBackendAuthRequired?.(
        'AWS credentials are no longer available for this connection — please re-enter them.',
      );
      return;
    }

    const fingerprint = bedrockIamCredentialFingerprint(piAuth.credential);
    if (fingerprint === this.lastPushedIamFingerprint) {
      this.debug('Bedrock auth error but the stored IAM credential is unchanged — re-auth required');
      this.onBackendAuthRequired?.(
        'The stored AWS credentials were rejected and no newer ones have been saved — '
        + 'if they are temporary (STS) credentials they have most likely expired; '
        + 'please re-enter them for this connection.',
      );
      return;
    }

    this.lastPushedIamFingerprint = fingerprint;
    this.send({ type: 'token_update', piAuth });
    this.debug('Pushed re-resolved IAM credentials to subprocess');
  }

  /**
   * Refresh OAuth tokens and push updated credentials to the running subprocess.
   * Handles both Copilot (Pi SDK) and ChatGPT Plus token refresh.
   */
  private async refreshAndPushTokens(): Promise<void> {
    if (this.config.authType !== 'oauth') return;

    const slug = this.config.connectionSlug || 'pi';

    // Global mutex — if another PiAgent instance on the same connection slug
    // is already refreshing, just wait for that to finish and push the
    // (now-fresh) credentials to our subprocess.
    const existing = PiAgent.globalRefreshMutex.get(slug);
    if (existing) {
      this.debug(`Waiting on existing refresh for slug "${slug}"`);
      await existing;
      // The other instance refreshed the credential store — push to our subprocess
      if (this.subprocess) {
        const piAuth = await this.getPiAuth();
        if (piAuth) {
          this.send({ type: 'token_update', piAuth });
          this.debug('Pushed credentials refreshed by sibling instance');
        }
      }
      return;
    }

    const refreshPromise = (async () => {
      const piAuthProvider = getBackendRuntime(this.config).piAuthProvider;
      const credentialManager = getCredentialManager();
      const stored = await credentialManager.getLlmOAuth(slug);

      if (!stored?.refreshToken) {
        this.debug('No refresh token available — re-auth required');
        this.onBackendAuthRequired?.('No refresh token — please sign in again');
        return;
      }

      try {
        if (piAuthProvider === 'github-copilot') {
          // Copilot: refresh the short-lived Copilot token using the GitHub access token
          const { refreshGitHubCopilotCredential } = await import('./backend/pi/copilot-oauth.ts');
          const newCreds = await refreshGitHubCopilotCredential(stored.refreshToken);
          await credentialManager.setLlmOAuth(slug, {
            accessToken: newCreds.access,
            refreshToken: newCreds.refresh,
            expiresAt: newCreds.expires,
          });
        } else {
          // ChatGPT Plus: use existing refresh utility
          const newTokens = await refreshChatGptTokens(stored.refreshToken);
          await credentialManager.setLlmOAuth(slug, {
            accessToken: newTokens.accessToken,
            idToken: newTokens.idToken,
            refreshToken: newTokens.refreshToken,
            expiresAt: newTokens.expiresAt,
          });
        }
        this.debug('Token refresh successful');

        // Push refreshed credentials to running subprocess
        if (this.subprocess) {
          const piAuth = await this.getPiAuth();
          if (piAuth) {
            this.send({ type: 'token_update', piAuth });
            this.debug('Pushed refreshed credentials to subprocess');
          }
        }
      } catch (error) {
        const msg = PiAgent.describeThrown(error);
        this.debug(`Token refresh failed: ${msg}`);
        this.onBackendAuthRequired?.(`Token refresh failed: ${msg}`);
      }
    })();

    // Store in both instance and global mutex
    this.tokenRefreshInProgress = refreshPromise;
    PiAgent.globalRefreshMutex.set(slug, refreshPromise);

    try {
      await refreshPromise;
    } finally {
      this.tokenRefreshInProgress = null;
      // Only clear global if it's still our promise (no newer refresh started)
      if (PiAgent.globalRefreshMutex.get(slug) === refreshPromise) {
        PiAgent.globalRefreshMutex.delete(slug);
      }
    }
  }

  /**
   * Retrieve API key from the credential manager for subprocess injection.
   * Legacy fallback when piAuthProvider is not set.
   * The subprocess expects a single API key string (passed via init.apiKey).
   */
  private async getApiKey(): Promise<string | null> {
    try {
      const credentialManager = getCredentialManager();
      const slug = this.config.connectionSlug || 'pi';

      // Try LLM OAuth first (for OAuth-based connections)
      const oauth = await credentialManager.getLlmOAuth(slug);
      if (oauth?.accessToken) {
        this.debug('Retrieved API key from LLM OAuth');
        return oauth.accessToken;
      }

      // Try Anthropic API key
      const apiKey = await credentialManager.getApiKey();
      if (apiKey) {
        this.debug('Retrieved Anthropic API key');
        return apiKey;
      }

      this.debug('No API keys found for Pi agent');
      return null;
    } catch (error) {
      // Same class as `getPiAuth`'s catch above — see there.
      this.debug(`Failed to retrieve API key: ${PiAgent.describeThrown(error)}`);
      return null;
    }
  }

  /**
   * Send a JSONL command to the subprocess stdin.
   */
  private send(cmd: Record<string, unknown>): void {
    if (!this.subprocess?.stdin?.writable) {
      this.debug('Cannot send to subprocess: stdin not writable');
      return;
    }
    const line = JSON.stringify(cmd);
    this.subprocess.stdin.write(line + '\n');
  }

  /**
   * Parse a JSONL line from subprocess stdout and dispatch by type.
   */
  private handleLine(
    line: string,
    sourceAttempt?: PiSubprocessStartupAttempt,
    sourceChild?: ChildProcess,
  ): void {
    if (sourceAttempt && (
      !this.isCurrentSubprocessAttempt(sourceAttempt)
      || (sourceChild && this.subprocess !== sourceChild)
    )) return;
    if (!line.trim()) return;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      this.debug(`Invalid JSONL from subprocess: ${line.slice(0, 200)}`);
      return;
    }

    // P2.54 — the one throw left in this prologue, and it escapes exactly the
    // way a dispatch used to. A bare `null` line PARSES, and `msg.type` is then
    // `TypeError: null is not an object` — outside the parse belt above and
    // outside the dispatch belt below, so it took the chunk tail with it
    // (measured on bun 1.3.14). `"text"`, `123` and `[…]` do not: each reads
    // `.type` as `undefined` and lands in `default`, which is where they still
    // land — this guard only renames their debug line.
    if (msg === null || typeof msg !== 'object') {
      this.debug(`Non-object JSONL from subprocess: ${line.slice(0, 200)}`);
      return;
    }

    const type = msg.type as string;
    // P2.65 — the name the belt's catch reports with, derived HERE, outside the
    // try and outside every catch. `as string` is a compile-time claim about a
    // value that arrived as JSON: `{"type":{"toString":1}}` parses, and
    // interpolating that object raises (bun 1.3.14: "TypeError: No default
    // value"). Inside the belt that is just another caught dispatch fault — but
    // the catch below used to interpolate `type` a second time, where a throw
    // has nothing left to catch it and took the chunk tail with it (measured).
    // P2.76 — P2.65's collapsed label STAYS, and the plan's optional minor for
    // widening it is REFUTED rather than skipped. The idea was that a renderable
    // non-string (`{"type":123}`) should report `123` instead of hiding behind
    // the label. Measured: it cannot. The only reader of `typeLabel` is the belt
    // catch below, reached only when the dispatch THROWS, and a non-string `type`
    // always lands in `default:`, whose only act is interpolating `${type}`. The
    // six shapes split with no overlap: `123`, `['ready']` and
    // `{toString:()=>'ready'}` render in `default:` and never throw, while
    // `{toString:1}`, `Object.create(null)` and a throwing `toString` are exactly
    // the values a widened label could not name either. Every value the widening
    // could name is unreachable here; every value that reaches here is
    // unnameable. It would have been a change no test could kill.
    const typeLabel = typeof type === 'string' ? type : '(non-string type)';
    // P2.66 — the user-facing sentence puts the name in parentheses, and the
    // non-string label already carries its own: `A Pi subprocess message
    // ((non-string type)) could not be processed`. Derived here, beside the
    // label, for the same reason the label is.
    const typeDisplay = typeof type === 'string' ? `(${type})` : typeLabel;

    if (type !== 'error') {
      this.resetSubprocessErrorDedup();
    }

    // P2.54 — THE belt, and the reason there is no seventh hand-written `try`
    // below. Every dispatch in `dispatchSubprocessMessage` runs inside a readline
    // `'line'` listener: a throw that reaches this frame unwinds the listener and
    // the REMAINING LINES OF THE SAME STDOUT CHUNK are dropped, silently (proven
    // on bun 1.3.14 and node v24.4.1 — see the belt test's file header). P2.20,
    // P2.33 and P2.41 each closed the cases they had measured, one `try` at a
    // time, and P2.41's own review found six more still open; a case added
    // tomorrow would have been the seventh round.
    //
    // So the guarantee is structural: whatever a case does, and whatever a case
    // added after this one does, it cannot cost the chunk. What this belt CANNOT
    // do is finish the case it interrupted — a dispatch that deletes its
    // correlation entry before the throwing line leaves nothing to settle from
    // out here. That is `safeHostCall`'s job, at the call sites, and the reason
    // both mechanisms exist.
    //
    // P2.65 — and the catch below cannot throw, which is what makes the
    // structural claim above a guarantee rather than a claim: a throw from a
    // catch is not caught by its own try, so it escapes exactly like the
    // un-belted dispatches used to. The two values it renders are the two that
    // could throw, and neither is rendered raw any more — the message name is
    // the `typeLabel` derived in the prologue, and the caught value goes
    // through `describeThrown`, which cannot throw. Everything else in here is
    // a string literal, `surfaceSubprocessFault` (an integer compare and an
    // `EventQueue.enqueue` — push + signal), and `debug`, belted at its own
    // site since P2.54. Keep it that way when editing: a value that arrived as
    // JSON, or came out of a `throw`, is renderable only by assumption.
    try {
      this.dispatchSubprocessMessage(type, msg, sourceAttempt, sourceChild);
    } catch (error) {
      const detail = PiAgent.describeThrown(error);
      this.debug(`Subprocess message ${typeLabel} could not be dispatched: ${PiAgent.describeThrown(error, true)}`);
      // Surfaced rather than swallowed, bounded like every other dispatch fault:
      // reaching this catch means a case threw where nobody had decided what a
      // failure there means, which is exactly the fault that must not hide.
      this.surfaceSubprocessFault(
        `message ${typeLabel}: ${detail}`,
        `A Pi subprocess message ${typeDisplay} could not be processed: ${detail}`,
      );
    }
  }

  /**
   * Dispatch one parsed subprocess message. Called only from {@link handleLine},
   * which owns the belt around it — see the comment there before adding a case.
   */
  private dispatchSubprocessMessage(
    type: string,
    msg: Record<string, unknown>,
    sourceAttempt?: PiSubprocessStartupAttempt,
    sourceChild?: ChildProcess,
  ): void {
    switch (type) {
      case 'ready': {
        const attempt = sourceAttempt ?? this.subprocessAttempt;
        if (!attempt || !this.isCurrentSubprocessAttempt(attempt)) return;
        // Subprocess initialized. F1.710: `ready` names no callback port, so
        // there is none to read here.
        if (msg.sessionId) {
          this.piSessionId = msg.sessionId as string;
          // P2.54 — belted because the STARTUP HANDSHAKE is three lines below.
          // A throwing host sink used to skip `resolveReady()`, so the spawn sat
          // out its whole startup timeout waiting for a subprocess that had
          // already reported itself ready. Fail-closed is: the host misses this
          // session id, the handshake completes anyway — the subprocess IS ready
          // and a failing host callback does not unmake what it reported.
          this.safeHostCall('onSdkSessionIdUpdate', () => this.config.onSdkSessionIdUpdate?.(this.piSessionId!));
        }
        if (!attempt.readySettled) {
          attempt.readySettled = true;
          attempt.resolveReady();
        }
        break;
      }

      case 'register_tools_result': {
        const id = String(msg.id ?? '');
        const pending = this.pendingManifestRegistrations.get(id);
        if (!pending) break;
        this.pendingManifestRegistrations.delete(id);
        if (msg.ok === true && typeof msg.generation === 'string' && typeof msg.manifestHash === 'string') {
          pending.resolve({ generation: msg.generation, manifestHash: msg.manifestHash });
        } else {
          pending.reject(new Error(String(msg.error ?? 'Pi execution manifest registration rejected')));
        }
        break;
      }

      case 'workflow_execute_result': {
        const id = String(msg.id ?? '');
        const pending = this.pendingWorkflowExecutions.get(id);
        if (!pending) break;
        this.pendingWorkflowExecutions.delete(id);
        clearTimeout(pending.timer);
        if (msg.ok === true) {
          pending.resolve({
            content: typeof msg.content === 'string' ? msg.content : '',
            ...(msg.details === undefined ? {} : { details: msg.details }),
          });
        } else {
          pending.reject(new Error(String(msg.error ?? 'Workflow command execution failed')));
        }
        break;
      }

      case 'subtask_start_result': {
        const id = String(msg.id ?? '');
        const pending = this.pendingSubtaskForks.get(id);
        if (!pending) break;
        this.pendingSubtaskForks.delete(id);
        clearTimeout(pending.timer);
        if (msg.ok === true && typeof msg.agentId === 'string') {
          pending.resolve({ agentId: msg.agentId, name: typeof msg.name === 'string' ? msg.name : '' });
        } else {
          pending.reject(new Error(String(msg.error ?? 'The fork could not be started')));
        }
        break;
      }

      case 'skill_fork_start_result': {
        const id = String(msg.id ?? '');
        const pending = this.pendingSkillForks.get(id);
        if (!pending) break;
        this.pendingSkillForks.delete(id);
        clearTimeout(pending.timer);
        if (msg.ok === true) {
          const status = msg.status === 'done' || msg.status === 'error' || msg.status === 'aborted'
            ? msg.status
            : undefined;
          pending.resolve({
            // What the subprocess DID: `skills.md:576`'s off switch can turn a
            // background request into a foreground run, and the block the model
            // reads must describe the run that happened.
            background: msg.background === true,
            ...(typeof msg.agentId === 'string' ? { agentId: msg.agentId } : {}),
            ...(typeof msg.taskId === 'string' ? { taskId: msg.taskId } : {}),
            ...(status ? { status } : {}),
            ...(typeof msg.result === 'string' ? { result: msg.result } : {}),
            ...(typeof msg.error === 'string' ? { error: msg.error } : {}),
          });
        } else {
          pending.reject(new Error(String(msg.error ?? 'The forked skill could not be started')));
        }
        break;
      }

      case 'startup_error': {
        const attempt = sourceAttempt ?? this.subprocessAttempt;
        if (!attempt) return;
        this.failSubprocessAttempt(attempt, new Error(String(
          msg.message || 'Pi runtime failed compatibility validation',
        )), sourceChild ?? this.subprocess, this.readline);
        break;
      }

      case 'event': {
        // Pi SDK event -- forward through PiEventAdapter.
        //
        // P2.41 — the NOTIFICATION half of P2.33's escape surface, and the
        // highest-volume message on this wire by a wide margin. `handleSubprocessEvent`
        // is sync `void` and calls HOST-supplied callbacks synchronously
        // (`onPiContinuationBoundary` on every compaction boundary, among
        // others), so a throw here travelled out of the readline `'line'`
        // listener and took THE REST OF THE STDOUT CHUNK with it — see the
        // `ask_user_request` block above for the measurement. P2.54 moved that
        // named example one layer down (`onPiContinuationBoundary` is belted at
        // its own call site now, so the event body survives it); this belt still
        // owns every OTHER throw the adapter and the event bookkeeping can raise.
        //
        // A notification has no answer to fail closed with: the fail-closed
        // action is to drop THIS event and keep the stream. But a silent drop on
        // the busiest wire is how a real programming error would hide behind a
        // slightly-wrong transcript forever, so the fault is also SURFACED as an
        // `error` event on the turn's own queue — a visible error row
        // (`SessionManager`'s `case 'error'` appends one and does NOT complete
        // the turn), which packaged builds show even though they log nothing
        // outside debug mode. `surfaceSubprocessEventFault` bounds the volume so
        // a fault that repeats per event cannot flood the session (CONSECUTIVE
        // repeats only — see that method's own note for what the bound is not).
        //
        // P3.22 CLOSED THE THREE ESCAPE HATCHES THIS PARAGRAPH USED TO NAME AS
        // OPEN, and the correction matters more than the original warning: the
        // sentence here said a fault caught in this belt "produces no row at
        // all" if its text happened to contain `aborted`, which is no longer
        // true and would talk the next reader out of trusting the channel.
        // `SessionManager`'s `case 'error'` had three: an early return when
        // `!managed.isProcessing`; a skip for any message CONTAINING `aborted`
        // or `AbortError`; and a route of auth-shaped text into
        // `attemptAuthRetry`, which RE-SENDS the user's message. As of
        // `8878f8887` a surfaced subprocess fault surfaces with no turn in
        // flight, the abort filter tests the session's own abort state instead
        // of a substring, and a fault can no longer reach `attemptAuthRetry`.
        //
        // What is still worth knowing: the recogniser that grants a fault that
        // treatment matches this file's fault SENTENCES by their constant
        // prefixes. The prefix below (`A Pi subprocess event (`) is one of the
        // five, so REWORDING IT SILENTLY DEMOTES THE ROW back through the gates
        // this paragraph used to describe. P3.22 pins all five with a
        // reword-failing test; keep them in sync or give the pair a shared
        // marker.
        //
        // One benign behaviour change rides along: a malformed `{"type":"event"}`
        // with no `event` field used to throw a `TypeError` out of `handleLine`
        // (eating the chunk); it now surfaces one row with `eventType='unknown'`.
        const rawEvent = msg.event as Record<string, unknown> | undefined;
        try {
          this.handleSubprocessEvent(rawEvent as Record<string, unknown>);
        } catch (error) {
          // P2.76 — the one BELT catch P2.65 did not convert, and the cost was
          // not the chunk (P2.66's 36/36 sweep proved the outer belt keeps it).
          // It was ATTRIBUTION and the bound: an unrenderable thrown value made
          // this catch throw, the outer belt reported `message event could not
          // be dispatched`, and the `event ${eventType}` signature this site
          // owns never reached the per-signature dedup at all — so the site
          // whose whole job is to name the failing event named nothing, and
          // P2.66's bound could not see it.
          const detail = PiAgent.describeThrown(error, true);
          const eventType = typeof rawEvent?.type === 'string' ? rawEvent.type : 'unknown';
          this.debug(`Subprocess event ${eventType} could not be processed: ${detail}`);
          const reason = PiAgent.describeThrown(error);
          this.surfaceSubprocessFault(
            `event ${eventType}: ${reason}`,
            `A Pi subprocess event (${eventType}) could not be processed: ${reason}`,
          );
        }
        break;
      }

      case 'execution_receipt':
        try {
          this.config.onExecutionReceipt?.(parseSafeExecutionReceiptInput(msg.receipt));
        } catch (error) {
          this.debug(`Dropped invalid execution receipt: ${PiAgent.describeThrown(error)}`);
        }
        break;

      case 'continuation_state': {
        const generation = typeof msg.capabilityGeneration === 'string' ? msg.capabilityGeneration : '';
        const currentGeneration = this.activeExecutionManifest?.snapshotGeneration;
        if (!generation || (currentGeneration && generation !== currentGeneration) || !Array.isArray(msg.activatedTools)) break;
        const leases = new Map<string, CapabilityActivationLeaseV1>();
        for (const value of msg.activatedTools.slice(0, 64)) {
          if (!value || typeof value !== 'object') continue;
          const lease = value as Partial<CapabilityActivationLeaseV1>;
          if (lease.schemaVersion !== 1 || typeof lease.semanticId !== 'string'
            || lease.capabilityGeneration !== generation || typeof lease.digest !== 'string'
            || !/^[a-f0-9]{64}$/.test(lease.digest)) continue;
          leases.set(lease.semanticId, Object.freeze(lease as CapabilityActivationLeaseV1));
        }
        this.continuationActivatedTools = leases; this.continuationActivatedToolsReported = true;
        break;
      }

      case 'automation_event':
        if (msg.event === 'SessionStart') {
          this._sessionStartEmitted = true;
          this._sessionEndEmitted = false;
          break;
        }
        // The runtime bridge emits `UserPromptSubmit` from `before_agent_start`,
        // which is reached only after `send({type:'prompt'})`. Running it here
        // would run the hook a second time for the same turn AND could not act
        // on the answer, so the host gate in `chatImpl` owns it and this drops
        // the echo. hooks.md: `UserPromptSubmit` fires "once per turn".
        //
        // R73: the drop list is `PI_ECHO_DROPPED_AGENT_EVENTS`, not the gate's
        // own list — it still covers `UserPromptExpansion`, which the current
        // bridge no longer emits but an older packaged bundle would.
        if (PI_ECHO_DROPPED_AGENT_EVENTS.includes(msg.event as AutomationAgentEvent)) {
          this.debug(`Prompt-gate event ${String(msg.event)} was already decided before the prompt was sent; subprocess echo dropped.`);
          break;
        }
        // P2.73 — the failure channel this dispatch had none of. See
        // `emitAutomationEventDetached`: a rejection here is invisible to both
        // belts, because both are synchronous.
        this.emitAutomationEventDetached(
          msg.event as AutomationAgentEvent,
          msg.input as SdkAutomationInput,
        );
        break;

      case 'pre_tool_use_request': {
        // Subprocess needs permission check + transforms before tool execution.
        //
        // P2.20: the subprocess BLOCKS on this answer, so an escaping rejection
        // is not a logged error — it is a tool call that hangs for the rest of
        // the turn. That is what a judge port resolving `null` produced before
        // this row (`guardian-consult.ts`, the nullish paragraph in the header):
        // the dispatch was un-awaited AND un-caught, so nothing answered. Every
        // return path inside the handler sends a response of its own; this belt
        // covers the ones that cannot — anything thrown outside the handler's
        // own try blocks. `block` is the fail-closed answer because the wire
        // carries only allow/block/modify (`pi-agent-server` `InboundMessage`):
        // an ask is resolved host-side and arrives as one of those two. A late
        // duplicate is harmless — the subprocess resolves the first response for
        // a requestId and drops the rest.
        const request = msg as {
          requestId: string;
          toolName: string;
          toolCallId?: string;
          manifestResponseEpoch?: number;
          input: Record<string, unknown>;
        };
        this.handlePreToolUseRequest(request).catch((error: unknown) => {
          const detail = PiAgent.describeThrown(error);
          this.debug(`PreToolUse request failed closed for ${request.toolName} (${request.requestId}): ${detail}`);
          this.send({
            type: 'pre_tool_use_response',
            requestId: request.requestId,
            action: 'block',
            reason: `The permission check for this tool call failed: ${detail}`,
          });
        });
        break;
      }

      case 'post_tool_use_request':
        void this.handlePostToolUseRequest(msg as {
          requestId: string;
          toolName: string;
          input: Record<string, unknown>;
          toolResponse: string;
          isError: boolean;
        });
        break;

      case 'pre_compact_request':
        // R73. The subprocess is WAITING on this answer, so it must always be
        // sent — `handlePreCompactRequest` fails open on every error path.
        void this.handlePreCompactRequest(msg as {
          requestId: string;
          trigger: 'manual' | 'auto';
          source: string;
          customInstructions: string | null;
        });
        break;

      case 'ask_user_request': {
        // Subprocess ask_user tool needs a renderer-mediated user answer.
        //
        // P2.33 — the SYNC sibling of P2.20's belt above, and a wider failure
        // than that one. `handlePreToolUseRequest` is async, so a throw inside
        // it became a rejection: one request went unanswered and nothing else
        // was harmed. This dispatch and `outside_root_request` below are sync
        // `void`, and nothing wraps the switch — `handleLine`'s own `try`
        // covers only the `JSON.parse`, and every belt below it is per-case. So
        // a throw here travels out of the readline `'line'` listener, and that
        // DROPS THE REMAINING LINES OF THE SAME STDOUT CHUNK. Measured on both
        // runtimes (bun 1.3.14, node v24.4.1): a
        // listener throwing on `B` of `A\nB\nC\nD` delivers `["A","B"]`.
        // Electron's `process.on('uncaughtException')` logs without exiting and
        // a packaged build logs nothing outside debug mode, so the loss is
        // silent — and the messages lost have nothing to do with the request
        // that threw.
        //
        // The fail-closed answer on THIS wire is an `error` string, not an
        // answer: `pi-agent-server`'s `handleAskUserResponse` rejects the
        // subprocess's pending `ask_user` promise with it, so the tool call
        // fails visibly. Sending an `answer` would fabricate a reply the user
        // never gave.
        //
        // With these two the set of blocking PERMISSION request dispatches is
        // complete. That sentence used to claim the set of blocking subprocess
        // request dispatches, and P2.41 narrowed it because it was false:
        // `tool_execute_request` below is a blocking request too, and it used
        // to be dispatched with neither `void` nor a `.catch` over a handler
        // whose prologue sat outside its own try. P2.40 closed it from the
        // INSIDE — the handler's whole body now runs in a try that answers
        // through the epoch-guarded `sendResponse` — so the `void` on that
        // dispatch marks a promise nothing needs to await, not a rejection
        // nobody catches.
        // Of the permission set, `post_tool_use_request` and
        // `pre_compact_request` are already belted INSIDE their handlers — each
        // wraps its whole body in a try and then answers, so the only path that
        // stays silent is the deliberate one where the subprocess it would
        // answer is already gone.
        // Their fallback is fail-OPEN rather than fail-closed, also
        // deliberately: a broken hook must not break the tool result or the
        // compaction it only decorates.
        const request = msg as {
          requestId: string;
          question: string;
          options: string[];
          allowFreeText: boolean;
          timeoutMs?: number;
        };
        try {
          this.handleAskUserRequest(request);
        } catch (error) {
          const detail = PiAgent.describeThrown(error);
          this.debug(`AskUser request failed closed for ${request.requestId}: ${detail}`);
          this.send({
            type: 'ask_user_response',
            requestId: request.requestId,
            error: `The question could not be put to the user: ${detail}`,
          });
        }
        break;
      }
      case 'outside_root_cancel': this.handleOutsideRootCancel(msg as { requestId: string; reason?: string }); break; // F1.957 — a notification, belted inside
      case 'outside_root_request': {
        // P2.33 belt, the second sync dispatch — see the `ask_user_request`
        // block above for what an escape costs. This one throws for real rather
        // than hypothetically: `handleOutsideRootRequest` calls the
        // HOST-SUPPLIED `this.onPermissionRequest` synchronously.
        //
        // `root: null` is the refusal on this wire (`pi-agent-server`
        // `InboundMessage`: `root: SessionFilesystemScopeRoot | null`, resolved
        // as `msg.root ?? null`) — the same answer the handler already sends
        // when there is no permission handler at all, leaving the suspended
        // tool call with no scope outside the session root.
        const request = msg as { requestId: string; canonicalTarget: string; access: 'read' | 'write' };
        try {
          this.handleOutsideRootRequest(request);
        } catch (error) {
          const detail = PiAgent.describeThrown(error);
          this.debug(`Outside-root request failed closed for ${request.canonicalTarget} (${request.requestId}): ${detail}`);
          // The handler registers the pending entry BEFORE it publishes, so a
          // throwing publish can strand one the user could still approve —
          // `respondToPermission` would then call `onOutsideRootGranted` and add
          // a session-lifetime root host-side for a request the subprocess has
          // already been told was denied.
          this.pendingPermissions.delete(request.requestId);
          this.send({ type: 'outside_root_response', requestId: request.requestId, root: null });
        }
        break;
      }

      case 'denied_paths_request': {
        // P3.272. Same sync-dispatch belt as `outside_root_request` above, and
        // for the same reason: a throw travelling out of the readline listener
        // DROPS THE REMAINING LINES OF THE SAME STDOUT CHUNK. The refusal on this
        // wire is the EMPTY set — withhold nothing, the pre-row behaviour — never
        // silence, because the search that asked is suspended on the answer.
        const request = msg as { requestId: string; paths: unknown };
        try {
          this.handleDeniedResultPathsRequest(request);
        } catch (error) {
          const detail = PiAgent.describeThrown(error);
          this.debug(`Denied-path result filter failed for ${request.requestId}: ${detail}`);
          this.send({ type: 'denied_paths_response', requestId: request.requestId, denied: [] });
        }
        break;
      }

      case 'ask_user_cancel': {
        // P2.41 belt. A cancel is a NOTIFICATION — the subprocess has already
        // given up on the answer — so there is nothing to send back, and
        // answering would only invent traffic. What the message does own is
        // host-side teardown, and a throw skips it.
        //
        // The throw source is real and has a name: `askUserPort.cancel` is
        // host-supplied and called SYNCHRONOUSLY, so the handler's `.catch`
        // (which covers only a returned rejection) never sees it. In the running
        // app that port is `createPiInteractionPorts`' `cancel`, whose first act
        // is `assertPiInteractionSessionKey` — a synchronous
        // `Error('pi-interaction-session-mismatch')` whenever the session id has
        // drifted from the key the port was bound to.
        //
        // What this belt guarantees is therefore ONLY: the rest of the stdout
        // chunk survives, the fault is logged, and the LOCAL-fallback pending
        // (when there is one) is torn down. It does not rescue the host card —
        // `cancelStrandedAskUserPermission` documents which branch owns what,
        // and why that distinction is the whole of the recovery's reach.
        const cancel = msg as { requestId: string; reason?: string };
        try {
          this.handleAskUserCancel(cancel);
        } catch (error) {
          const detail = PiAgent.describeThrown(error);
          this.debug(`Ask-user cancel for ${cancel.requestId} failed: ${detail}`);
          this.cancelStrandedAskUserPermission(cancel);
        }
        break;
      }

      case 'tool_execute_request':
        // Subprocess wants main process to execute a proxy tool (MCP/API/session)
        //
        // P2.40 — `void`, and nothing more, because the handler owns its own
        // answer: every path through it, prologue included, ends in a
        // `tool_execute_response` sent through the closure that carries this
        // request's child/attempt/epoch guards. A `.catch` out here could not
        // reuse those guards, so it would have to answer unguarded or not at
        // all; the `void` says only that this promise is deliberately not
        // awaited.
        void this.handleToolExecuteRequest(msg as {
          requestId: string;
          toolName: string;
          piName?: string;
          manifestGeneration?: string;
          manifestHash?: string;
          args: Record<string, unknown>;
        });
        break;

      case 'tool_execute_cancel': {
        // UB2.10 — the subprocess also sends this when `stop_background_task` (stopTask,
        // `/workflows stop`) stops a DETACHED call, whose entry the receiver below moved out of
        // `pendingToolExecutions`: abort it where it lives, or the stop leaves the MCP write running.
        const cancelledId = String(msg.requestId);
        (this.pendingToolExecutions.get(cancelledId) ?? this.detachedToolExecutions.get(cancelledId))?.abort();
        this.pendingToolExecutions.delete(cancelledId);
        this.detachedToolExecutions.delete(cancelledId);
        break;
      }

      case 'tool_execute_detached': {
        // UB2.10 (B2-12) — the subprocess detached this proxy call past the R10 threshold:
        // it is a background task now. MOVE it out of `pendingToolExecutions` so the Stop
        // sweep (`forceAbort`'s pending-tool-executions step) cannot kill a detached MCP
        // write — a Stop ends the REPLY — while `stopBackgroundTask` keeps stopping it by
        // taskId through the `stop_background_task` RPC.
        const detachedId = String(msg.requestId ?? '');
        const detachedController = this.pendingToolExecutions.get(detachedId);
        if (detachedController) {
          this.pendingToolExecutions.delete(detachedId);
          this.detachedToolExecutions.set(detachedId, detachedController);
          this.detachedToolTaskIds.set(detachedController, String(msg.taskId ?? ''));
          this.debug(`Tool call ${detachedId} detached to background task ${String(msg.taskId ?? '')}`);
        }
        break;
      }

      case 'process_start_request':
        void this.handleProcessStartRequest(msg as {
          requestId: string;
          request: SupervisedProcessChildStartRequest;
        });
        break;

      case 'process_cancel_request': {
        const controller = this.pendingProcessStarts.get(String(msg.requestId));
        controller?.abort();
        break;
      }

      case 'child_session_request':
        void this.handleChildSessionRequest(msg as { requestId: string; request: PiChildSessionRequest });
        break;

      case 'session_tool_completed':
        // Session MCP tool completed -- fire callbacks (SubmitPlan, auth, etc.)
        //
        // P2.41 belt. The plainest of the four: a notification with nothing to
        // answer and nothing registered to strand — the callbacks it reports
        // were already fired by `executeSessionTool`, which is why the handler
        // is a deliberate no-op. Log and continue is the whole fail-closed
        // action. It is belted while still inert because this is the message the
        // reviewer used to DEMONSTRATE the chunk-tail loss live, and because an
        // inert handler is exactly the kind a later edit grows without
        // remembering what a throw here costs.
        try {
          this.handleSessionToolCompleted(msg);
        } catch (error) {
          this.debug(`Session tool completion notice could not be processed: ${PiAgent.describeThrown(error)}`);
        }
        break;

      case 'mini_completion_result': {
        // Response to a mini_completion request.
        //
        // P2.41 belt. Nothing on the wire to answer — the subprocess has already
        // said its piece — but this dispatch settles a HOST-side promise, and a
        // throw before `pending.resolve` leaves `runMiniCompletion` waiting out
        // the full `LLM_QUERY_TIMEOUT_MS` for a result that already arrived.
        // `null` is the fail-closed value because it is the one the timeout path
        // and the no-subprocess path already resolve with, so every caller
        // handles it; rejecting would turn a lost title into a turn failure.
        const miniId = String(msg.id ?? '');
        try {
          this.handleMiniCompletionResult(msg);
        } catch (error) {
          this.debug(`Mini completion result ${miniId} could not be processed: ${PiAgent.describeThrown(error)}`);
          const pending = this.pendingMiniCompletions.get(miniId);
          if (pending) {
            this.pendingMiniCompletions.delete(miniId);
            pending.resolve(null);
          }
        }
        break;
      }

      case 'llm_query_result': {
        // Response to an llm_query request
        const id = msg.id as string;
        const pending = this.pendingLlmQueries.get(id);
        if (pending) {
          this.pendingLlmQueries.delete(id);
          const result = msg.result as LLMQueryResult | null;
          if (result) {
            pending.resolve(result);
          } else {
            const errorMessage = typeof msg.errorMessage === 'string' ? msg.errorMessage : 'llm_query failed';
            pending.reject(new Error(errorMessage));
          }
        }
        break;
      }

      case 'ensure_session_ready_result':
        // Response to an ensure_session_ready request
        this.handleEnsureSessionReadyResult(msg);
        break;

      case 'compact_result':
        // Response to a compact request
        this.handleCompactResult(msg);
        break;

      case 'context_usage_result':
        // Response to a fresh context usage request
        this.handleContextUsageResult(msg);
        break;

      case 'stop_background_task_result':
        // L9 — response to a registry stop request
        this.handleStopBackgroundTaskResult(msg);
        break;

      case 'heapdump_result':
        // Response to a heapdump request (R49/f210)
        this.handleHeapdumpResult(msg);
        break;

      case 'set_auto_compaction_result':
        // Response to an auto-compaction toggle request
        this.handleSetAutoCompactionResult(msg);
        break;

      case 'update_runtime_config_result':
        // Response to a runtime config refresh request
        this.handleRuntimeConfigUpdateResult(msg);
        break;

      case 'working_directory_transaction_result':
        this.handleWorkingDirectoryTransactionResult(msg);
        break;


      case 'session_id_update':
        // Pi session ID changed
        if (msg.sessionId) {
          this.piSessionId = msg.sessionId as string;
          // P2.54 — belted because the read-back arm below is what a throw used
          // to skip: the handoff would stay armed after the subprocess had
          // ALREADY forked the carry session, so the next turn re-delivered the
          // same span as text on top of a history Pi was already carrying.
          this.safeHostCall('onSdkSessionIdUpdate', () => this.config.onSdkSessionIdUpdate?.(this.piSessionId!));
        }
        // T7 · the read-back arm's second half — did the fork actually take?
        //
        // The subprocess sets this only after `forkFrom` returned a session
        // manager for the carry file it was handed, so it is a report of what
        // happened rather than of what was asked for. Until it arrives the
        // handoff stays ARMED, which is the fail-safe: a decline (Pi already
        // had a session of its own here) or a fork that threw leaves the next
        // turn to deliver the same span as text.
        if (msg.carriedHistory === true) {
          this.pendingRuntimeHandoff = null;
          // Belted with nothing to repair after it, deliberately: the local arm
          // is disarmed on the line ABOVE, so all a throw here loses is the
          // host's own note of the delivery — and, before P2.54, the chunk.
          this.safeHostCall('markRuntimeHandoffApplied', () => this.config.markRuntimeHandoffApplied?.('native-transcript'));
          this.debug('[runtime-handoff] the Pi subprocess forked the carry session');
        }
        break;

      case 'web_search_usage': {
        // R48: the subprocess's absolute session WebSearch count after a
        // consume or a child fold. Mirrored host-side so a respawn re-seeds
        // the budget and a parent gets credited this session's consumption.
        //
        // P2.54 — the plainest of the six: nothing local to unwind, so the whole
        // fail-closed action is that the host keeps its previous count. Belted
        // because a throw here cost the REST OF THE CHUNK, which is arbitrary
        // unrelated traffic and has nothing to do with a search budget.
        const used = Number(msg.used);
        if (Number.isSafeInteger(used) && used >= 0) {
          this.safeHostCall('onPiWebSearchUsage', () => this.config.onPiWebSearchUsage?.(used));
        }
        break;
      }

      case 'error': {
        const errorCode = typeof msg.code === 'string' ? msg.code : undefined;
        const rawMessage = String(msg.message || 'Unknown subprocess error');

        this.debug(`Subprocess error${errorCode ? ` (${errorCode})` : ''}: ${rawMessage}`);
        const errorMsg = rawMessage.toLowerCase();

        // Detect auth errors and re-supply credentials to the live subprocess.
        // P6.257 added the two AWS STS spellings: Bedrock reports an expired
        // session token as `ExpiredToken` / `ExpiredTokenException` and a
        // rotated-away key as `UnrecognizedClientException`, neither of which
        // any OAuth provider emits — so widening the shared predicate cannot
        // make the OAuth arm fire where it did not before.
        const isAuthError = errorMsg.includes('401')
          || errorMsg.includes('421')
          || errorMsg.includes('unauthorized')
          || errorMsg.includes('misdirected')
          || (errorMsg.includes('token') && errorMsg.includes('expired'))
          || errorMsg.includes('expiredtoken')
          || errorMsg.includes('unrecognizedclient')
          || errorMsg.includes('authentication');

        if (this.config.authType === 'oauth' && isAuthError) {
          this.debug('Auth error detected from subprocess, attempting token refresh');
          this.refreshAndPushTokens().catch(err => {
            // P2.332 sweep, and this one IS an escape rather than a contract
            // break: the `.catch` result is floated, so a throw from inside this
            // handler rejects a promise nobody holds — a rejection handler that
            // becomes an unhandled rejection, the exact state the family closes.
            this.debug(`Token refresh after auth error failed: ${PiAgent.describeThrown(err)}`);
          });
        } else if (this.config.authType === 'iam_credentials' && isAuthError) {
          // P6.257 — the Bedrock arm. Same seam, different remedy: re-resolve
          // from the store rather than refresh, because we hold no AWS refresh
          // token. Floated with the same total renderer for the same reason.
          this.debug('Auth error detected from subprocess, re-resolving IAM credentials');
          this.refreshAndPushIamCredentials().catch(err => {
            this.debug(`IAM re-resolve after auth error failed: ${PiAgent.describeThrown(err)}`);
          });
        }

        // F1.239 — a utility error settles only ITS request. mini_completion_error
        // (title/summary) and llm_query_error (call_llm) are internal utility-path
        // failures and never a user-visible chat error. The subprocess names the
        // request (`id`); `settleUtilityRequestError` rejects that one entry, and
        // only a build that sends no id gets the old sweep — over its OWN kind.
        // Until F1.239 this arm rejected EVERY pending mini completion and llm
        // query for ANY subprocess error, so one failed title rejected a sibling
        // `call_llm`, and a chat-turn error rejected both. Any other error now
        // leaves them alone: each has its own deadline (which also cancels the
        // subprocess query), and a crash still reaches them through
        // `rejectPendingSubprocessRequests` on subprocess exit. For llm_query the
        // targeted `llm_query_result` that follows finds nothing left to settle.
        // Each case is driven through `handleLine` in `pi-utility-error-routing.test.ts`.
        if (errorCode === 'mini_completion_error' || errorCode === 'llm_query_error') {
          this.settleUtilityRequestError(
            errorCode,
            typeof msg.id === 'string' && msg.id ? msg.id : undefined,
            rawMessage,
          );
          this.debug(`Ignoring ${errorCode} subprocess error in chat stream`);
          break;
        }

        // Reject pending ensure_session_ready requests (used by branch preflight)
        for (const [id, pending] of this.pendingEnsureSessionReady) {
          pending.reject(new Error(rawMessage));
          this.pendingEnsureSessionReady.delete(id);
        }

        // Reject pending compact/toggle requests
        for (const [id, pending] of this.pendingCompactions) {
          pending.reject(new Error(rawMessage));
          this.pendingCompactions.delete(id);
        }
        this.finishContinuationBoundary('failed');
        for (const [id, pending] of this.pendingContextUsageRequests) {
          pending.reject(new Error(rawMessage));
          this.pendingContextUsageRequests.delete(id);
        }
        // Heapdump pendings settle as error ROWS, never rejections.
        for (const [id, pending] of this.pendingHeapdumps) {
          pending.resolve({ success: false, errorMessage: rawMessage });
          this.pendingHeapdumps.delete(id);
        }
        // L9 — same shape: a stop request answers with the failure so the caller
        // can fall through, and never with a rejection nobody catches.
        for (const [id, pending] of this.pendingStopBackgroundTasks) {
          pending.resolve({ stopped: false, error: rawMessage });
          this.pendingStopBackgroundTasks.delete(id);
        }
        for (const [id, pending] of this.pendingAutoCompactionToggles) {
          pending.reject(new Error(rawMessage));
          this.pendingAutoCompactionToggles.delete(id);
        }
        for (const [id, pending] of this.pendingRuntimeConfigUpdates) {
          pending.reject(new Error(rawMessage));
          this.pendingRuntimeConfigUpdates.delete(id);
        }

        // Suppress repeated identical errors to prevent a broken subprocess
        // from flooding the user's session (e.g. EFAULT loop).
        if (rawMessage === this.lastSubprocessError) {
          this.subprocessErrorRepeatCount++;
          if (this.subprocessErrorRepeatCount > PiAgent.MAX_IDENTICAL_SUBPROCESS_ERRORS) {
            this.debug(`Suppressing repeated subprocess error (${this.subprocessErrorRepeatCount}x): ${rawMessage}`);
            break;
          }
        } else {
          this.lastSubprocessError = rawMessage;
          this.subprocessErrorRepeatCount = 1;
        }

        const parsed = parseError(new Error(rawMessage));
        if (parsed.code !== 'unknown_error') {
          this.eventQueue.enqueue({ type: 'typed_error', error: parsed });
        } else {
          this.eventQueue.enqueue({
            type: 'error',
            message: `Pi subprocess error: ${rawMessage}`,
          });
        }

        // Note: The subprocess should follow this with a synthetic agent_end event
        // which will call eventQueue.complete(). If it doesn't, handleSubprocessExit()
        // will complete the queue when the process exits.
        break;
      }

      default:
        this.debug(`Unknown subprocess message type: ${type}`);
    }
  }

  /**
   * Forward a Pi SDK event from the subprocess through the event adapter.
   */
  private continuationRuntimeState(): PiContinuationRuntimeStateV1 {
    return Object.freeze({
      capabilityGeneration: this.activeExecutionManifest?.snapshotGeneration
        ?? this.capabilityTurnRuntime?.view.generation
        ?? 'unavailable',
      activatedTools: Object.freeze([...this.continuationActivatedTools.values()].slice(0, 64)),
      invokedSkills: this.getActiveSkillContinuationReferences(),
    });
  }

  // P2.54 — both halves of the boundary notification are belted, and this is the
  // pair with the widest blast radius: `finishContinuationBoundary` is called
  // from the MIDDLE of `handleLine`'s `case 'error'` (five pending maps are
  // settled after it, then the visible error row is enqueued) and from the
  // middle of `handleCompactResult` (after its correlation entry is already
  // deleted). A throwing host stranded all of that, on the exact path a session
  // takes when something has already gone wrong. `continuationRuntimeState()` is
  // inside the belt too — it walks our own state and is no more entitled to
  // abandon the caller than the host is.
  private beginContinuationBoundary(): void {
    if (this.continuationBoundaryOpen) return;
    this.continuationBoundaryOpen = true;
    this.safeHostCall('onPiContinuationBoundary', () => this.config.onPiContinuationBoundary?.('pre', this.continuationRuntimeState()));
  }

  private finishContinuationBoundary(phase: 'post' | 'failed' | 'cancelled'): void {
    if (!this.continuationBoundaryOpen) return;
    this.safeHostCall('onPiContinuationBoundary', () => this.config.onPiContinuationBoundary?.(phase, this.continuationRuntimeState()));
    // Reached unconditionally now. Left open, the flag would make every later
    // `beginContinuationBoundary` a no-op — one throwing host call would cost
    // the boundary signal for the rest of the session, not just for this turn.
    this.continuationBoundaryOpen = false;
  }

  private handleSubprocessEvent(event: Record<string, unknown>): void {
    // The subprocess sends Pi SDK AgentSessionEvent objects serialized as JSON.
    // Feed them through PiEventAdapter to convert to Nessy Desktop AgentEvents.

    // T30. The latch means "this turn's generator is closed", and for every
    // event belonging to the turn that is exactly right. A DETACHED run is the
    // one thing here that is NOT the turn's: it was started to outlive it, and
    // its settlement therefore arrives on the far side of this line by design.
    // Dropping it silently is how a background child could finish and never be
    // reported to the parent — see {@link forwardDetachedTaskEvent}.
    if (this.rawEventAttemptTerminal) {
      this.forwardDetachedTaskEvent(event);
      return;
    }

    // Detect session MCP tool completions (same pattern as in-process version)
    const eventType = event.type as string;
    if (eventType === 'compaction_start') this.beginContinuationBoundary();
    if (eventType === 'message_end') {
      // Track the assistant batch size for the defer single-call constraint
      // (R7 Task 5). Pi SDK assistant content blocks use type "toolCall".
      const message = event.message as { role?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
      if (message?.role === 'assistant' && Array.isArray(message.content)) {
        this.lastAssistantToolCallCount = message.content
          .filter(block => block?.type === 'toolCall').length;
        // hooks.md `:2192` — Stop's `last_assistant_message`. Captured HERE, off
        // the completed assistant message, rather than read back from the
        // transcript: "the transcript file isn't guaranteed to include the final
        // message at Stop time on all versions", and `:628` says the same of
        // `transcript_path` generally. Overwritten on each assistant message, so
        // at Stop it holds the final one.
        const text = message.content
          .filter(block => block?.type === 'text' && typeof block.text === 'string')
          .map(block => block.text!)
          .join('');
        if (text.length > 0) this.lastAssistantMessageText = text;
      }
    }
    if (eventType === 'turn_start' && !this.adapter.consumeRetriedRunTurnStart()) { // F1.300 — an SDK retry is not a turn
      this.piModelTurnsThisChat += 1;
      if (
        this.maxPiModelTurnsThisChat > 0
        && this.piModelTurnsThisChat > this.maxPiModelTurnsThisChat
      ) {
        const maxAgentTurns = this.maxPiModelTurnsThisChat;
        this.maxPiModelTurnsThisChat = 0;
        // P6.443 (M4) — THE CAP NAMES ITSELF, and before this it did not.
        //
        // `forceAbort` closes the queue (`eventQueue.complete()`) and enqueues
        // no terminal event, so a Pi turn stopped by the operator's turn cap
        // ended with a bare completion carrying no verdict — while the SAME
        // ending on claude names itself, `error_max_turns` -> `max_agent_turns`
        // through `CLAUDE_RESULT_SUBTYPE_REASON`
        // (`backend/claude/event-adapter.ts`). No new vocabulary and no locale
        // key: `max_agent_turns` is already in both `TERMINAL_REASON_VALUES` and
        // `TERMINAL_REASON_NOTICE_VALUES` and already has renderer copy in
        // `terminal-reason-copy.ts` — what was missing here was the PRODUCER.
        //
        // Enqueued BEFORE `forceAbort`, which is the only order that works:
        // `forceAbort` completes the queue, so anything enqueued after it is
        // dropped. Same shape as the two deferral endings below and as
        // `max_budget_usd` in `chatImpl`.
        //
        // No `terminalIsError`: a cap is a stop, not a crash. `max_budget_usd`
        // beside it stamps none either, and `BaseAgent.isFailedTurnComplete`
        // deliberately excludes this reason from the failed-turn set.
        this.eventQueue.enqueue({ type: 'complete', terminalReason: 'max_agent_turns' });
        this.rawEventAttemptTerminal = true;
        this.debug(`maxAgentTurns exceeded (${this.piModelTurnsThisChat}/${maxAgentTurns}); aborting Pi turn`);
        this.forceAbort(AbortReason.MaxAgentTurns);
        return;
      }
    }
    let adaptedEvent = event;

    if (eventType === 'context_usage_update' && event.usage && typeof event.usage === 'object') {
      this.logContextWindowDrift(event.usage as ContextUsageSnapshot);
    }

    if (eventType === 'tool_execution_start') {
      const toolName = event.toolName as string;
      if (toolName?.startsWith('session__') || toolName?.startsWith('mcp__session__')) {
        // Session tool tracking is handled by the subprocess; it sends
        // session_tool_completed events when appropriate.
      }

      // Deterministic metadata bridge: if subprocess event lacks toolMetadata,
      // inject metadata captured from pre_tool_use_request before stripping.
      const toolCallId = event.toolCallId as string | undefined;
      const existingMeta = event.toolMetadata as { intent?: string; displayName?: string } | undefined;
      if (toolCallId && !existingMeta) {
        const cached = this.preToolMetadataByCallId.get(toolCallId);
        if (cached && (cached.intent || cached.displayName)) {
          adaptedEvent = {
            ...event,
            toolMetadata: {
              intent: cached.intent,
              displayName: cached.displayName,
              source: 'interceptor',
            },
          };
          this.debug(`Injected pre-tool metadata for ${toolName} (${toolCallId}) from bridge cache`);
        }
      }
    }

    if (eventType === 'tool_execution_end') {
      const toolCallId = event.toolCallId as string | undefined;
      if (toolCallId) {
        this.preToolMetadataByCallId.delete(toolCallId);
      }
    }

    // Adapt event to NessyAgentEvents
    // The event adapter expects typed PiAgentEvent/AgentSessionEvent objects,
    // but since we're receiving plain JSON, we cast through unknown.
    for (const agentEvent of this.adapter.adaptEvent(adaptedEvent as any)) {
      // Track Read tool calls for prerequisite checking
      if (agentEvent.type === 'tool_start' && agentEvent.toolName === 'Read') {
        this.prerequisiteManager.trackReadTool(agentEvent.input as Record<string, unknown>);
      }

      // CI2 edit-feedback bridge: capture the edit/write tool's normalized input
      // at tool_start (`path` already mapped to `file_path`) so it can be handed
      // to the runner at tool_result — which carries no input of its own. Only
      // cached when a runner is injected and the tool is an edit/write, so a
      // non-feature turn never touches the map.
      if (
        agentEvent.type === 'tool_start'
        && this.editFeedbackRunner
        && this.isEditFeedbackTool(agentEvent.toolName)
      ) {
        this.editFeedbackInputByCallId.set(agentEvent.toolUseId, agentEvent.input);
      }
      // Reset prerequisite state on compaction (LLM loses guide content)
      if (agentEvent.type === 'info' && typeof agentEvent.message === 'string' && agentEvent.message.startsWith('Compacted')) {
        this.resetPrerequisiteState();
      }

      if (agentEvent.type === 'tool_result') {
        const postToolName = agentEvent.toolName ?? (event.toolName as string) ?? 'unknown';
        // CI2 edit-feedback loop: on a SUCCESSFUL edit/write, run the project's
        // own linter/typechecker on the changed file and stash bounded
        // diagnostics for delivery on the NEXT PreToolUse. Observational only —
        // never blocks the completed edit; a runner error is swallowed. The
        // runner is null unless the server trust-gated + enabled it.
        //
        // The tool_result event carries no input, so the changed-file path is
        // read from the tool_start input cached under this toolUseId — the seam
        // the runner needs to resolve the file. The entry is consumed here
        // (deleted whether or not the runner fires) so the map stays bounded.
        const cachedEditInput = this.editFeedbackInputByCallId.get(agentEvent.toolUseId);
        this.editFeedbackInputByCallId.delete(agentEvent.toolUseId);
        if (!agentEvent.isError && this.editFeedbackRunner && this.isEditFeedbackTool(postToolName)) {
          void this.runEditFeedback(agentEvent.toolUseId, postToolName, cachedEditInput);
        }
      }

      this.eventQueue.enqueue(agentEvent);
    }

    if (eventType === 'compaction_end') {
      const succeeded = !!event.result && event.aborted !== true && !event.errorMessage;
      this.finishContinuationBoundary(succeeded ? 'post' : event.aborted === true ? 'cancelled' : 'failed');
      // The real compaction seam, and the only one that covers both kinds: a
      // manual `/compact` and an automatic threshold/overflow compaction both
      // arrive here. An aborted or failed compaction changed no context, so it
      // gets no re-injection.
      // Chained, not overwritten: overflow recovery can compact repeatedly
      // before the next user turn, and the next turn awaits ONE handle. Chaining
      // makes "every queued emission has settled" true without depending on the
      // FIFO ordering of the automation queue underneath.
      if (succeeded && this._sessionStartHooksApplied) {
        const previous = this._postCompactHookEmission ?? Promise.resolve();
        // P2.332 — THE FIFTEENTH SITE OF THE FLOATING-EMISSION FAMILY, and the
        // handler is here rather than at the two places that drop the handle.
        //
        // `emitPostCompactSessionStart` awaits `emitAutomationEvent` and
        // `applyHookSessionDirectives`; either can reject. Exactly one consumer
        // awaits this handle (the next turn's prompt composition). The other two
        // readers — the workspace-change boundary and `clearHistory` — assign
        // `undefined` over it without awaiting or catching, which is a rejected
        // promise dropped with no observer, i.e. an unhandled rejection in
        // production (the `bun test` runner cannot see it; see
        // `__tests__/floating-emission-escape.test.ts` for why).
        //
        // Closing it AT CREATION rather than at the two drop sites is deliberate
        // and does three things one `.catch` per drop site could not:
        //   1. it covers the awaiting consumer too, so a failed post-compaction
        //      hook can no longer abort the user's very next turn — automations
        //      must never break the agent flow, which is `emitAutomationEvent`'s
        //      own stated contract;
        //   2. it un-poisons the CHAIN. Overflow recovery compacts repeatedly and
        //      each compaction chains onto `previous`; a single rejection left
        //      standing would propagate through every later `.then` and silently
        //      stop emitting `SessionStart`/`compact` for the rest of the session;
        //   3. it means a future third dropper cannot reintroduce the escape.
        // The stored promise therefore NEVER rejects, by construction.
        //
        // `reportAutomationEventFault` is Pi's labelled channel (debug line plus
        // a user-visible transcript row) and is belted against a throwing host
        // sink, so the handler cannot become the failure it reports.
        this._postCompactHookEmission = previous
          .then(() => this.emitPostCompactSessionStart())
          .catch((error: unknown) => this.reportAutomationEventFault('SessionStart', error));
      }
    }

    // Turn-completion is now adapter-driven so overflow recovery can hold the
    // queue open across the SDK's compaction → agent.continue() sequence
    // (see PiEventAdapter overflow state machine). The adapter returns true
    // when the queue should terminate — either on a normal agent_end with no
    // recovery in flight, or on a compaction_end failure that drains a held
    // overflow.
    if (this.adapter.shouldCompleteQueue(eventType === 'agent_end')) {
      this.rawEventAttemptTerminal = true;
      this.eventQueue.complete();
    }
  }

  /**
   * T30 — the settlement of a run that OUTLIVES the turn that started it.
   *
   * `task_completed` is the seam `registerBackgroundChildTask` publishes when a
   * detached `subagent`/`workflow` run settles, and `task_notification` is R10's
   * equivalent for a detached MCP call. Both are emitted by the subprocess from
   * the run's own promise — not from the turn loop — so both can land after the
   * parent's turn ended, and until this existed both were dropped at the
   * terminal latch above.
   *
   * The set is exactly these two, and the omissions are deliberate:
   * `task_backgrounded` is emitted BEFORE the run starts, inside the tool call
   * that made it, so it is always the turn's; and `task_progress` is not a raw
   * subprocess event at all — the adapter derives it from orchestration details
   * on a `tool_execution_*` event. Anything else reaching the adapter out of
   * turn would be an unknown-event contract failure raised with no turn to
   * report it to.
   *
   * Adapting here is safe for the same reason the set is small: both branches
   * sit at the top of `adaptEvent` as pure early returns and touch none of the
   * per-turn state `startTurn()` owns.
   */
  private static readonly DETACHED_TASK_EVENT_TYPES: ReadonlySet<string> = new Set([
    'task_completed',
    'task_notification',
  ]);

  private forwardDetachedTaskEvent(event: Record<string, unknown>): void {
    const sink = this.config.onBetweenTurnsEvent;
    if (!sink) return;
    if (!PiAgent.DETACHED_TASK_EVENT_TYPES.has(String(event.type))) return;
    try {
      for (const agentEvent of this.adapter.adaptEvent(event as never)) sink(agentEvent);
    } catch (error) {
      // Fail-soft on purpose: there is no turn to surface an error into, and a
      // throw here would escape into the subprocess readline loop.
      this.debug(`Dropped detached task event ${String(event.type)}: ${PiAgent.describeThrown(error)}`);
    }
  }

  /** Model-facing edit/write tool names the CI2 feedback loop lints. */
  private isEditFeedbackTool(toolName: string): boolean {
    return toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit';
  }

  /**
   * CI2: invoke the server-injected edit-feedback runner and stash its bounded
   * observational output for the next PreToolUse. Fail-soft: any error is logged
   * and dropped so an edit is never blocked and the turn never breaks.
   */
  private async runEditFeedback(toolCallId: string, toolName: string, toolInput: unknown): Promise<void> {
    const runner = this.editFeedbackRunner;
    if (!runner) return;
    const input = (toolInput && typeof toolInput === 'object')
      ? toolInput as Record<string, unknown>
      : {};
    const file = input.file_path ?? input.notebook_path ?? input.path;
    const fileDigest = createHash('sha256').update(typeof file === 'string' ? file : '').digest('hex').slice(0, 16);
    const key = `${toolCallId}:${fileDigest}`;
    if (this.pendingEditFeedback.has(key)) return;
    while (this.pendingEditFeedback.size >= PiAgent.MAX_PENDING_EDIT_FEEDBACK) {
      const oldest = this.pendingEditFeedback.keys().next().value as string | undefined;
      if (!oldest) break;
      this.pendingEditFeedback.delete(oldest);
    }
    const entry: { ready: boolean; diagnostics?: string } = { ready: false };
    this.pendingEditFeedback.set(key, entry);
    try {
      const diagnostics = await runner({ toolName, toolInput: input });
      if (this.pendingEditFeedback.get(key) !== entry) return;
      const bounded = diagnostics?.trim().slice(0, PiAgent.MAX_EDIT_FEEDBACK_CHARS);
      if (bounded) entry.diagnostics = bounded;
    } catch (error) {
      // P2.332 sweep. `runEditFeedback` is `void`-floated by its only caller, so
      // a throw while rendering `error` here rejects an unheld promise. The
      // runner is a HOST callback, which is exactly where an unrenderable
      // rejection value can come from.
      this.debug(`Edit-feedback runner failed for ${toolName}: ${PiAgent.describeThrown(error)}`);
    } finally {
      if (this.pendingEditFeedback.get(key) === entry) entry.ready = true;
    }
  }

  /**
   * CI2: consume any pending edit-feedback diagnostics, to be merged into the
   * next PreToolUse `additionalContext` (the only channel that reaches the Pi
   * model with hidden context). One-shot — reads clear the buffer.
   */
  private consumePendingEditFeedback(): string | undefined {
    const diagnostics: string[] = [];
    for (const [key, entry] of this.pendingEditFeedback) {
      if (!entry.ready) break;
      this.pendingEditFeedback.delete(key);
      if (entry.diagnostics) diagnostics.push(entry.diagnostics);
    }
    return diagnostics.join('\n\n') || undefined;
  }

  /**
   * Turn boundary for the hook loop-guard: repeated-deny counts never carry
   * across turns (a fresh prompt legitimately retries previously denied tools).
   */
  private resetPreToolHookLoopGuard(): void {
    this.preToolHookDenyCounts.clear();
    this.preToolHookDenyTotals.clear();
    // Guardian per-turn circuit-breaker + deny loop-guard reset at the same
    // boundary (the session-scoped verdict cache and override set persist).
    this._guardianConsult?.resetTurn();
  }

  private applyPreToolUseHookDecision(
    checkResult: PreToolUseCheckResult,
    hookDecision: PreToolUseDecision | undefined,
    toolName: string,
  ): { result: PreToolUseCheckResult; additionalContext?: string; hookUpdatedInput?: Record<string, unknown> } {
    if (!hookDecision) return { result: checkResult };
    const additionalContext = hookDecision.additionalContext;
    const updatedInput = hookDecision.updatedInput;
    const decision = hookDecision.decision;

    if (checkResult.type === 'block') {
      return {
        result: checkResult,
        additionalContext,
        ...(updatedInput ? { hookUpdatedInput: updatedInput } : {}),
      };
    }

    if (decision === 'block' || decision === 'deny') {
      return {
        result: {
          type: 'block',
          reason: hookDecision.reason ?? 'Blocked by PreToolUse automation.',
        },
        additionalContext,
      };
    }

    if (checkResult.type === 'source_activation_needed'
      || checkResult.type === 'call_llm_intercept') {
      // F1.548: a third arm (`spawn_session_intercept`) went with its variant.
      return {
        result: checkResult,
        additionalContext,
        ...(updatedInput ? { hookUpdatedInput: updatedInput } : {}),
      };
    }

    if (decision === 'ask') {
      if (checkResult.type === 'prompt') {
        return {
          result: { ...checkResult, modifiedInput: updatedInput ?? checkResult.modifiedInput },
          additionalContext,
          ...(updatedInput ? { hookUpdatedInput: updatedInput } : {}),
        };
      }
      return {
        result: {
          type: 'prompt',
          promptType: 'mcp_mutation',
          description: hookDecision.reason ?? `PreToolUse automation requested approval for ${toolName}.`,
          modifiedInput: updatedInput,
          reason: hookDecision.reason,
        },
        additionalContext,
        ...(updatedInput ? { hookUpdatedInput: updatedInput } : {}),
      };
    }

    // A hook `allow` deliberately does NOT clear a prompt here. Whether it may
    // (hooks.md#pretooluse: not for tools that require user interaction, not
    // across an org `ask`, and never past a deny/ask rule) is decided by
    // `promptIsNonNegotiable` plus the readable-DSL evaluation, and neither is
    // computed yet at this point. The prompt is carried forward intact — with
    // any `updatedInput` folded in so the re-gate sees it — and the allow closes
    // at the R15 band, the same site a `PermissionRequest` allow closes at.
    if (checkResult.type === 'prompt') {
      return {
        result: { ...checkResult, modifiedInput: updatedInput ?? checkResult.modifiedInput },
        additionalContext,
        ...(updatedInput ? { hookUpdatedInput: updatedInput } : {}),
      };
    }

    if (updatedInput) {
      return { result: { type: 'modify', input: updatedInput }, additionalContext, hookUpdatedInput: updatedInput };
    }

    // `allow` on an already-allowing gate result changes nothing; the only case
    // where it has an effect is the prompt above.
    return { result: checkResult, additionalContext };
  }

  /**
   * The `permission_suggestions` input for a `PermissionRequest` firing
   * (hooks.md#permissionrequest): the "always allow" option the dialog offers, as a
   * documented `addRules` entry. UA12.71 `[security]` — a Bash entry is UA12.70's key
   * spelled as the rule the dialog's Always writes on Pi (`bashAlwaysAllowRuleContent`),
   * at the destination it writes it to, `localSettings` (QUESTIONS.md U43-SEC.2 (a));
   * no key, no entry. Until UA12.71 it offered `Bash(<base>:*)` at `session` — wider
   * than any click — and said that was what Always Allow persists. An MCP mutation
   * offers its bare tool at `session`. Built only when the prompt offers a remember
   * option (`commandHash` present); curl/wget offer a DOMAIN whitelist with no rule
   * spelling, and file writes remember a tool+path key — neither is invented here.
   */
  private buildPermissionRequestSuggestions(
    checkResult: PreToolUseCheckResult,
    toolName: string,
  ): Array<Record<string, unknown>> | undefined {
    if (checkResult.type !== 'prompt' || checkResult.commandHash === undefined) return undefined;
    if (checkResult.promptType === 'bash' && typeof checkResult.command === 'string') {
      const baseCommand = this.permissionManager.getBaseCommand(checkResult.command);
      const key = baseCommand && !this.permissionManager.isDangerousCommand(checkResult.command) ? bashSessionWhitelistKey(checkResult.command, baseCommand) : null;
      const ruleContent = key ? bashAlwaysAllowRuleContent(checkResult.command, key) : null; if (!ruleContent || ['curl', 'wget'].includes(baseCommand) || checkResult.noAlwaysAllow) return undefined; // UA12.71 — no key (or, UA12.70 follow-up, no rule text for it), no suggestion
      return [{
        type: 'addRules',
        behavior: 'allow',
        destination: 'localSettings', // UA12.71 — where Pi's Always writes it (bash-remember-scope.ts: pi → repository)
        rules: [{ toolName: 'Bash', ruleContent }],
      }];
    }
    if (checkResult.promptType === 'mcp_mutation' && toolName.startsWith('mcp__')) {
      return [{
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [{ toolName }],
      }];
    }
    return undefined;
  }

  /**
   * Apply a `PermissionRequest` hook's `updatedPermissions` (allow-only per
   * hooks.md). Six documented entry types and four destinations.
   *
   * THE PRIVILEGE BOUNDARY, because this is the one path where something other
   * than a human answer can change a permission rule. A hook's stdout is
   * attacker-influenceable: a plugin ships the hook, and the model's own output
   * can reach the hook's input. So:
   *
   * - RESTRICTIONS may be written anywhere. `deny` and `ask` rules can only
   *   narrow, so they are applied at session scope and written to a settings
   *   file when asked.
   * - A PERSISTENT GRANT is accepted only when it echoes a
   *   `permission_suggestion` this host offered for THIS prompt — which is
   *   exactly what hooks.md says the mechanism is for: "A hook can echo one of
   *   the `permission_suggestions` it received as its own `updatedPermissions`
   *   output, which is equivalent to the user selecting that 'always allow'
   *   option in the dialog." Any other allow rule aimed at a settings file is
   *   refused. A session-scope allow still goes to the session whitelist, which
   *   carries the dangerous-base-command floor.
   * - NOTHING MAY REMOVE A RULE IT DID NOT ADD. `replaceRules` and
   *   `removeRules` operate on the session store only; at a settings
   *   destination they are refused outright, because "replaces all rules of the
   *   given behavior at the destination" would let a hook delete an
   *   administrator's `deny` list. The settings writer itself is additive-only,
   *   so even a bug here cannot express a removal.
   * - `userSettings`, and the non-rule entry types at any settings
   *   destination, are refused: we have no reader for `~/.claude/settings.json`,
   *   for `permissions.defaultMode` or for `permissions.additionalDirectories`,
   *   and a write to a key nothing reads is a grant that silently does nothing.
   *
   * The rest is unchanged: `addDirectories`/`removeDirectories` widen the
   * session `additionalDirectories` (validated + canonicalized; only
   * session-granted roots are removable), and `setMode` uses the existing mode
   * path with `bypassPermissions`/`allow-all` refused unless the session is
   * already there. Every applied change and every refusal writes a structured
   * receipt line naming the event and tool.
   */
  private applyPermissionRequestUpdates(
    entriesValue: unknown,
    toolName: string,
    offeredSuggestions?: Array<Record<string, unknown>>, promptingInput?: Record<string, unknown>,
  ): void {
    if (!Array.isArray(entriesValue) || entriesValue.length === 0) return;
    const applied: Array<Record<string, unknown>> = [];
    const deferred: Array<{ code: string; message: string }> = [];
    const record = (value: unknown): Record<string, unknown> | null =>
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
    const ruleStrings = (rulesValue: unknown): string[] => {
      const raws: string[] = [];
      for (const ruleValue of Array.isArray(rulesValue) ? rulesValue : []) {
        const rule = record(ruleValue);
        const ruleToolName = typeof rule?.toolName === 'string' ? rule.toolName : '';
        const ruleContent = typeof rule?.ruleContent === 'string' ? rule.ruleContent : undefined;
        if (!ruleToolName) {
          deferred.push({ code: 'updated_permissions_invalid', message: 'Ignoring a rule without a toolName.' });
          continue;
        }
        raws.push(ruleContent ? `${ruleToolName}(${ruleContent})` : ruleToolName);
      }
      return raws;
    };
    const compileSessionRule = (raw: string, action: 'deny' | 'ask'): SessionPermissionRule | null => {
      const parsed = parseClaudeRuleString(raw, action, { knownToolNames: PERMISSION_RULE_TOOL_NAMES });
      if (!parsed.rule) {
        deferred.push({
          code: 'updated_permissions_refused',
          message: `Rule "${raw}" is not an enforceable permission rule (${parsed.warning?.code ?? 'unparseable'}); applied nothing.`,
        });
        return null;
      }
      // permissions.md's typo warning arrives ALONGSIDE a rule: the rule
      // installs and matches no tool. Reading it only under `!parsed.rule` —
      // the shape above — is what made it unreachable, so a hook could add a
      // `deny StopTask` and be told it was applied.
      if (parsed.warning) {
        deferred.push({
          code: 'updated_permissions_warning',
          message: `Rule "${raw}" was applied with a warning (${parsed.warning.code}): ${parsed.warning.message}`,
        });
      }
      return { raw, action, match: parsed.rule.match };
    };
    /** Whether an allow entry echoes an option this host offered — rule AND destination (UA12.71). */
    const wasOffered = (rulesValue: unknown, destination: unknown): boolean => {
      const wanted = JSON.stringify(ruleStrings(rulesValue).slice().sort());
      return (offeredSuggestions ?? []).some(suggestion =>
        suggestion.type === 'addRules' && suggestion.destination === destination
        && suggestion.behavior === 'allow'
        && JSON.stringify(ruleStrings(suggestion.rules).slice().sort()) === wanted);
    };
    const writeSettings = (
      destination: 'localSettings' | 'projectSettings',
      behavior: 'allow' | 'deny' | 'ask',
      raws: readonly string[],
    ): void => {
      if (raws.length === 0) return;
      const root = resolveClaudeSettingsRoot(this.workingDirectory);
      const result = addClaudePermissionRules(destination, root, behavior, raws);
      if (result.refused) {
        deferred.push({
          code: 'updated_permissions_refused',
          message: `Could not write ${behavior} rules to ${result.path} (${result.refused}); applied nothing.`,
        });
        return;
      }
      if (result.added.length > 0) {
        applied.push({ type: 'addRules', destination, behavior, rules: result.added, path: result.path });
      }
    };
    for (const entryValue of entriesValue) {
      const entry = record(entryValue);
      if (!entry) {
        deferred.push({ code: 'updated_permissions_invalid', message: 'Ignoring a non-object updatedPermissions entry.' });
        continue;
      }
      const destination = entry.destination ?? 'session';
      if (destination !== 'session' && destination !== 'localSettings' && destination !== 'projectSettings') {
        deferred.push({
          code: 'updated_permissions_refused',
          message: `Destination "${String(destination)}" is refused: no reader exists for it, so the write would be a rule that silently does nothing.`,
        });
        continue;
      }
      const behavior = entry.behavior;
      switch (entry.type) {
        case 'addRules': {
          if (behavior !== 'allow' && behavior !== 'deny' && behavior !== 'ask') {
            deferred.push({
              code: 'updated_permissions_invalid',
              message: `addRules with behavior "${String(behavior)}" is not a documented behavior; applied nothing.`,
            });
            break;
          }
          if (destination !== 'session') {
            if (behavior === 'allow' && !wasOffered(entry.rules, destination)) {
              deferred.push({
                code: 'updated_permissions_refused',
                message: 'A persistent allow rule is accepted only when it echoes a permission_suggestion this prompt offered; applied nothing.',
              });
              break;
            }
            writeSettings(destination, behavior, ruleStrings(entry.rules));
            break;
          }
          if (behavior !== 'allow') {
            for (const raw of ruleStrings(entry.rules)) {
              const rule = compileSessionRule(raw, behavior);
              if (!rule) continue;
              if (this.permissionManager.addSessionPermissionRule(rule)) {
                applied.push({ type: 'addRules', destination, behavior, rule: raw });
              }
            }
            break;
          }
          for (const ruleValue of Array.isArray(entry.rules) ? entry.rules : []) {
            const rule = record(ruleValue);
            const ruleToolName = typeof rule?.toolName === 'string' ? rule.toolName : '';
            const ruleContent = typeof rule?.ruleContent === 'string' ? rule.ruleContent : undefined;
            if (!ruleToolName) {
              deferred.push({ code: 'updated_permissions_invalid', message: 'Ignoring an addRules rule without a toolName.' });
              continue;
            }
            if (ruleToolName === 'Bash' && ruleContent) {
              const prefix = ruleContent.endsWith(':*') ? ruleContent.slice(0, -2) : ruleContent;
              const baseCommand = this.permissionManager.getBaseCommand(prefix);
              // D1.305 — the WHOLE prefix against the list, and the key derived
              // the way a human's Always Allow derives it. This arm tested only
              // `baseCommand`, so `Bash(git push:*)` — a rule naming a command
              // the list means to always refuse — resolved to `git` and was
              // stored under a key that does not say what the model asked for.
              // The floor is `persistBashAlwaysAllowRule`'s: both spellings,
              // because `getBaseCommand` strips a leading `sudo`.
              const sessionKey = bashSessionKeyForRuleContent(ruleContent);
                // UA12.70 `[security]` — the key the rule's OWN TEXT names, by the
                // classification a human click uses (upstream v0.14.0): a wildcard
                // stores only a leading-words key equal to its prefix, a rule with
                // no wildcard the key that one command's click would mint. D1.412's
                // one-token fallback is gone: it stored `git` for `Bash(git:*)`, and
                // with key equality a broad key covers nothing anyway — it stores none.
                // (D1.403 — an interpreter head still mints nothing, inside the call.)
              if (!baseCommand
                || this.permissionManager.isDangerousCommand(prefix)
                || this.permissionManager.isDangerousCommand(baseCommand)
                || !sessionKey) {
                deferred.push({
                  code: 'updated_permissions_refused',
                  message: `Bash rule "${ruleContent}" resolves to a dangerous or empty command, or to a key that would be wider than the rule; never session-whitelisted.`,
                });
                continue;
              }
              this.permissionManager.whitelistCommand(sessionKey);
              recordBashSessionRuleReceipt({ applied, deferred }, { ruleContent, sessionKey, toolName, promptingInput, isDangerous: line => this.permissionManager.isDangerousCommand(line) });
            } else if (!ruleContent) {
              // Bare tool rule: the same whitelist key the MCP-mutation,
              // file-write and API prompts consult (isCommandWhitelisted(toolName)).
              //
              // D1.315 — this comment named three surfaces and was true of two:
              // the API arm of `shouldPromptInAskMode` consulted only
              // `${method} ${path}`, so a bare `api_*` rule was applied,
              // receipted as applied, and read by nobody. The arm now reads this
              // key too, by parity with the other two; the decision and what was
              // weighed against it are written there.
              this.permissionManager.whitelistCommand(ruleToolName);
              applied.push({ type: 'addRules', rule: ruleToolName, sessionWhitelist: ruleToolName });
            } else {
              deferred.push({
                code: 'updated_permissions_deferred',
                message: `Rule "${ruleToolName}(${ruleContent})" has no session-whitelist mapping; deferred, applied nothing.`,
              });
            }
          }
          break;
        }
        case 'replaceRules':
        case 'removeRules': {
          if (behavior !== 'deny' && behavior !== 'ask') {
            deferred.push({
              code: 'updated_permissions_refused',
              message: `${String(entry.type)} for behavior "${String(behavior)}" is refused: session allow grants live in the whitelist, which has no rule identity to remove.`,
            });
            break;
          }
          if (destination !== 'session') {
            deferred.push({
              code: 'updated_permissions_refused',
              message: `${String(entry.type)} at "${destination}" is refused: it would delete rules this session did not author, including an administrator's. Only session rules are removable.`,
            });
            break;
          }
          const raws = ruleStrings(entry.rules);
          if (entry.type === 'removeRules') {
            const removed = this.permissionManager.removeSessionPermissionRules(behavior, raws);
            if (removed.length > 0) applied.push({ type: 'removeRules', destination, behavior, rules: removed });
            break;
          }
          const replacement = raws
            .map(raw => compileSessionRule(raw, behavior))
            .filter((rule): rule is SessionPermissionRule => rule !== null);
          const dropped = this.permissionManager.replaceSessionPermissionRules(behavior, replacement);
          applied.push({
            type: 'replaceRules',
            destination,
            behavior,
            rules: replacement.map(rule => rule.raw),
            replaced: dropped,
          });
          break;
        }
        case 'addDirectories': {
          if (destination !== 'session') {
            deferred.push({
              code: 'updated_permissions_refused',
              message: `addDirectories at "${destination}" is refused: permissions.additionalDirectories has no reader, so the write would grant nothing.`,
            });
            break;
          }
          const { roots, diagnostics } = resolveAdditionalDirectories(
            Array.isArray(entry.directories) ? entry.directories : [],
          );
          for (const diagnostic of diagnostics) {
            deferred.push({ code: 'updated_permissions_refused', message: diagnostic });
          }
          for (const root of roots) {
            const isNew = !this.sessionAdditionalDirectories.includes(root);
            if (isNew) {
              this.sessionAdditionalDirectories.push(root);
            }
            applied.push({ type: 'addDirectories', root });
            // R32 · hooks.md#directoryadded. Fires only for a root that was
            // actually appended: "DirectoryAdded fires after Claude Code has
            // refreshed sandbox and permission state, so sandboxed tools already
            // see the new directory when your hook runs" — so the push happens
            // first, and a re-grant of a root the session already holds adds no
            // directory and fires nothing.
            //
            // `source` is `register_repo_root`, the honest half of a CLOSED
            // two-value vocabulary ("`slash_command`" for `/add-dir`,
            // "`register_repo_root`" for the SDK control request): this path is
            // programmatic — a hook's `updatedPermissions.addDirectories` grant —
            // never a user-typed command. Nessy has no `/add-dir`, so
            // `slash_command` is unproducible today, and inventing a third value
            // would break every documented matcher.
            //
            // Fire-and-forget, like the other observational emissions in this
            // class: the event "can't block the add, which has already
            // completed", so no decision output is read.
            if (isNew) {
              // P2.73 — the SECOND floating automation emission in this file,
              // found by sweeping for the class rather than fixing the one the
              // row named. Same shape, same invisibility: fire-and-forget means
              // nothing awaits it, so a rejection had no channel here either.
              this.emitAutomationEventDetached('DirectoryAdded', {
                hook_event_name: 'DirectoryAdded',
                directory: root,
                source: 'register_repo_root',
              });
            }
          }
          break;
        }
        case 'removeDirectories': {
          if (destination !== 'session') {
            deferred.push({
              code: 'updated_permissions_refused',
              message: `removeDirectories at "${destination}" is refused: it would edit a settings file this session did not author.`,
            });
            break;
          }
          for (const value of Array.isArray(entry.directories) ? entry.directories : []) {
            if (typeof value !== 'string' || !value.trim()) continue;
            const canonical = canonicalizeForDecision(value.trim());
            const index = this.sessionAdditionalDirectories.indexOf(canonical);
            if (index >= 0) {
              this.sessionAdditionalDirectories.splice(index, 1);
              applied.push({ type: 'removeDirectories', root: canonical });
            } else {
              deferred.push({
                code: 'updated_permissions_refused',
                message: `removeDirectories "${value}" is not a session-granted root (configured roots are not hook-removable); applied nothing.`,
              });
            }
          }
          break;
        }
        case 'setMode': {
          if (destination !== 'session') {
            // hooks.md already forbids persisting `bypassPermissions` as
            // `defaultMode`; we go further because `permissions.defaultMode` has
            // no reader at all, so any persisted mode would be inert.
            deferred.push({
              code: 'updated_permissions_refused',
              message: `setMode at "${destination}" is refused: permissions.defaultMode has no reader, so the write would change nothing.`,
            });
            break;
          }
          const mapped = mapClaudeModeToPermissionMode(entry.mode);
          if (!mapped) {
            deferred.push({ code: 'updated_permissions_refused', message: `setMode "${String(entry.mode)}" is not a recognised permission mode.` });
            break;
          }
          const current = this.permissionManager.getPermissionMode();
          if (mapped === 'bypassPermissions' && current !== 'bypassPermissions') {
            deferred.push({
              code: 'updated_permissions_refused',
              message: 'setMode to bypassPermissions is refused unless the session is already there — never hook-widened, never persisted.',
            });
            break;
          }
          this.setPermissionMode(mapped);
          applied.push({ type: 'setMode', mode: mapped });
          break;
        }
        default:
          deferred.push({
            code: 'updated_permissions_deferred',
            message: `updatedPermissions type "${String(entry.type)}" is deferred; applied nothing.`,
          });
      }
    }
    if (applied.length > 0) {
      this.debug(`__PERMISSION_UPDATE__${JSON.stringify({ event: 'PermissionRequest', toolName, applied })}`);
    }
    for (const entry of deferred) {
      this.debug(`__PERMISSION_UPDATE__${JSON.stringify({ event: 'PermissionRequest', toolName, code: entry.code, message: entry.message })}`);
    }
  }

  /**
   * Build the guardian's planned-action description from the tool name and its
   * ORIGINAL input (the same input the permission gate decided on — never the
   * sandboxed/rewritten form). Bash -> command; an MCP call -> tool + params,
   * passed as untrusted data (the policy fences them) — a session tool's bare
   * name included (F1.933, {@link piGuardianMcpWireName}); anything else -> name.
   */
  private buildGuardianAction(
    toolName: string,
    input: Record<string, unknown>,
    cwd: string,
  ): GuardianPlannedAction {
    if (toolName === 'Bash' && typeof input.command === 'string') {
      return { command: input.command, cwd };
    }
    const mcpWireName = piGuardianMcpWireName(toolName);
    if (mcpWireName) {
      const { _intent: _i, _displayName: _d, ...params } = input;
      return { mcpTool: mcpWireName.replace(/^mcp__/, '').replace(/__/g, '.'), mcpParams: params, cwd };
    }
    const { _intent: _i2, _displayName: _d2, ...rest } = input; // any other prompted tool: name + input
    return { command: toolName, mcpParams: rest, cwd };
  }

  /**
   * Receipt-provenance marker for a guardian-approved (`no_objection`) allow.
   * Threaded into the decision's `additionalContext` so the minted receipt is
   * distinguishable from a plain rule-allow in the audit trail. The verdict is
   * already core-sanitized (single-line, bounded `reason`; taxonomy `category`),
   * so this is safe to inline. Prefix is `guardian-approved:` so downstream
   * readers can detect the marker without a schema change.
   */
  private buildGuardianProvenance(verdict: GuardianRunResult): string {
    const category = verdict.category ? ` [${verdict.category}]` : '';
    return `guardian-approved${category}: ${verdict.reason}`;
  }

  /**
   * The guardian judge model id from the product setting, read live so a
   * Settings change applies without a restart. Empty means "use the default" —
   * the runner then resolves the Nessy Gateway `fast` alias (falling back to the
   * session model), so we return `undefined` to keep the runner's default path.
   */
  private resolveGuardianModelId(): string | undefined {
    // PER INTEGRATION, not global (H1). One id could not serve every
    // connection: entitlement varies per key, so a judge model that works on
    // one 403s on another and silently degrades every risky action to a plain
    // ask. `resolveGuardianJudgeModel` owns the chain — this connection's
    // entry, then the legacy global if it is valid HERE, then the gateway
    // `fast` alias — and falls through a stale entry rather than erroring.
    // The connection's own catalog, from the same resolver the subprocess
    // config is built from — not a second source that could drift.
    const runtime = getBackendRuntime(this.config);
    const catalog = (runtime.customModels ?? []).map(
      (entry: string | { id: string }) => (typeof entry === 'string' ? entry : entry.id),
    );
    const resolved = resolveGuardianJudgeModel({
      connectionSlug: this.config.connectionSlug,
      catalog,
      perConnection: getGuardianJudgeModels(),
      legacyGlobalId: getGuardianJudgeModelId(),
      isModelAllowed: isManagedModelSelectable,
    });
    if (resolved.modelId) {
      this.debug(`[guardian] judge model ${resolved.modelId} (via ${resolved.via})`);
      return resolved.modelId;
    }

    // No catalog to resolve against — a connection whose models this agent
    // cannot see. Fall back to the pre-H1 behaviour rather than dropping a
    // configured judge model on the floor.
    const modelId = getGuardianJudgeModelId().trim();
    if (modelId === '') return undefined;
    // `settings-reference.md#availablemodels` names "the advisor" alongside
    // subagents and skills: "Restrict which models people can select for the
    // main session, subagents, skills, and the advisor."
    // This setting USED to be described here as "our advisor-model equivalent".
    // Since P2.1 it is not: the advisor is its own thing
    // (`agent/advisor.ts`, settings key `advisorModel`), and the two follow
    // DIFFERENT rules on a forbidden model. Both rules and both reasons, so the
    // next reader does not have to reconstruct which applies where:
    //
    //   JUDGE (here) — a forbidden judge model falls back to the DEFAULT path,
    //   not to a disabled judge. `model-config.md:168` disables Claude's
    //   advisor on an excluded `advisorModel`, but the closer rule is `:178`'s
    //   auto-mode classifier — which this is: "When it's excluded, the
    //   classifier runs on the session's model, which the allowlist already
    //   governs." Disabling ours would turn a model restriction into a SAFETY
    //   reduction, since the judge is the deny-net over auto mode; the fallback
    //   keeps the net and drops only the model.
    //
    //   ADVISOR (`resolveAdvisorModel`) — a forbidden `advisorModel` DISABLES
    //   the consult, following `:168` literally. Nothing is lost by refusing:
    //   advice is an aid, not a guard, so withholding it removes help rather
    //   than a deny-net, and answering on a different model would let a model
    //   restriction be routed around by a tool the user believes is running the
    //   model they configured.
    //
    // The rules diverge because the CONSEQUENCE of refusing diverges, not
    // because one of the two documents was read differently.
    return isManagedModelSelectable(modelId) ? modelId : undefined;
  }

  /**
   * The org-declared auto-mode sets for the judge's policy section (R21).
   *
   * Read off the generation-pinned capability runtime, which the session layer
   * populates from the HOST-OWNED managed policy file only — repo-scoped
   * settings never reach it, by design.
   *
   * The `undefined` return no longer means "the admin declared nothing" — since
   * R31 wired `auto-mode-config.md`'s `"$defaults"` operand, `resolveAutoMode`
   * carries the built-in rule lists, so a resolved policy always has non-empty
   * sections. `undefined` now means only that no capability runtime is pinned
   * yet. Either way the judge sees the same rules: `buildGuardianJudgeTask`
   * falls back to `GUARDIAN_BUILT_IN_AUTO_MODE_DEFAULTS` on `undefined`, which
   * is the list a resolved policy would have carried.
   */
  private resolveGuardianOrgPolicy(): GuardianOrgPolicy | undefined {
    const policy = this.capabilityTurnRuntime?.managedAutoMode;
    return hasAutoModePolicy(policy) ? policy : undefined;
  }

  /**
   * Execute-mode (`allow-all`) deny-only net (plan: guardian-command-judge G3).
   *
   * In `allow-all` the deterministic gate auto-allows everything — there is no
   * `prompt` band. So the deny-net reuses the EXISTING risk classifier
   * (`shouldPromptInAutoMode`, via `shouldPromptInBypassDenyNet`) as its band: the risky tier the
   * `auto` mode would ask about (dangerous/destructive/network Bash, MCP/API
   * mutations). Recorded choice (per plan): that classifier does NOT split the
   * four high-risk categories, so its risky tier IS the band and the judge's
   * policy prompt does the category filtering — a low/medium-risk action inside
   * the band gets `no_objection` and runs. F1.951: the band gets `auto`'s session roots, so an edit
   * inside them never reaches it, and one outside them or onto a protected path still does.
   *
   * Outcome mapping (this is a NET, it can only narrow, never widen):
   *  - `no_objection` -> RUN (return the original allow/modify unchanged);
   *  - `deny` -> block with the guardian category+reason diagnostic;
   *  - ask (disabled/override/circuit-open/unsure/failure) -> DOWNGRADE-TO-ASK:
   *    convert the auto-allow into a permission prompt so a human decides.
   *
   * Returns the original `checkResult` when the action is NOT in the high-risk
   * band (the vast majority of allow-all actions — zero judge calls, no latency)
   * or when the guardian is unwired/off. On a downgrade it returns a synthetic
   * `prompt` result so the existing ask path runs.
   */
  private async consultGuardianDenyNet(
    checkResult: Extract<PreToolUseCheckResult, { type: 'allow' | 'modify' }>,
    ctx: {
      toolName: string;
      input: Record<string, unknown>;
      cwd: string;
      workspaceRoot?: string;
      permissionsContext: PermissionsContext;
      plansFolderPath?: string; dataFolderPath?: string; // F1.951 — two of the net's write roots
      guardian: GuardianConsultState;
      modeVersion: number;
      /** Reads the session's LIVE mode version after the judge answers (P6.204). */
      readModeVersion?: () => number;
      guardianProvenance?: string;
    },
  ): Promise<PreToolUseCheckResult> {
    // The exact input that will be authorized/executed on run.
    const executedInput = checkResult.type === 'modify' ? checkResult.input : ctx.input;
    // High-risk band = the risky tier `auto` would ask about, in `auto`'s session roots (F1.951).
    // The judge's policy filters categories; a non-null result marks the band.
    const band = shouldPromptInBypassDenyNet(
      ctx.toolName,
      executedInput,
      this.permissionManager,
      ctx.permissionsContext,
      { workingDirectory: ctx.cwd, workspaceRootPath: ctx.workspaceRoot, plansFolderPath: ctx.plansFolderPath, dataFolderPath: ctx.dataFolderPath, additionalDirectories: mergedAdditionalDirectories(this.sessionAdditionalDirectories) },
      msg => this.debug(`Guardian deny-net band: ${msg}`),
      // Same band inputs `auto` uses, so a command bound to leave the sandbox is
      // high-risk in `allow-all` too rather than only under `auto`.
      ...(this.capabilityTurnRuntime?.unsandboxedCommandPatterns?.length
        ? [{ unsandboxedCommandPatterns: this.capabilityTurnRuntime.unsandboxedCommandPatterns }] as const
        : []),
    );
    if (!band) return checkResult; // not high-risk in allow-all — runs as today.

    const orgPolicy = this.resolveGuardianOrgPolicy();
    const projectInstructions = await this.buildGuardianProjectInstructions();
    const action = this.buildGuardianAction(ctx.toolName, executedInput, ctx.cwd);
    const judgeInput: GuardianJudgeInput = {
      action,
      trustedIntent: this.getCurrentTurnUserMessage() ?? '',
      // P6.203 (A31) working tree + P6.64 (A1) branch — see `buildGuardianFacts`.
      facts: await this.buildGuardianConsultFacts('bypassPermissions', ctx.cwd, ctx.workspaceRoot),
      ...(orgPolicy ? { orgPolicy } : {}),
      // P6.203 (A30) — the project's own instructions, bounded and untrusted.
      ...(projectInstructions ? { projectInstructions } : {}),
    };

    const modelId = this.resolveGuardianModelId();
    const outcome = await ctx.guardian.consult({
      input: judgeInput,
      cwd: ctx.cwd,
      modeVersion: ctx.modeVersion,
      ...(ctx.readModeVersion ? { readModeVersion: ctx.readModeVersion } : {}),
      ...(modelId ? { modelId } : {}),
    });

    if (outcome.kind === 'allow') {
      this.debug(`Guardian deny-net no_objection for ${ctx.toolName}: ${outcome.verdict.reason}`);
      // Runs as today. Mark provenance so the receipt records the guardian pass.
      ctx.guardianProvenance = this.buildGuardianProvenance(outcome.verdict);
      return checkResult;
    }
    if (outcome.kind === 'deny') {
      this.debug(`__GUARDIAN_DENY__${JSON.stringify({
        toolName: ctx.toolName,
        category: outcome.verdict.category,
        reason: outcome.verdict.reason,
      })}`);
      return { type: 'block', reason: outcome.diagnostic };
    }
    // ask: DOWNGRADE the auto-allow to a human prompt. Build a prompt result off
    // the classifier's band info so the existing ask path renders it normally.
    if (outcome.reason === 'circuit-open') {
      this.debug(`Guardian deny-net circuit open — downgrading ${ctx.toolName} to ask`);
    } else {
      this.debug(`Guardian deny-net ${outcome.reason} — downgrading ${ctx.toolName} to ask`);
    }
    // Same marker as the auto band: a downgrade caused by a BROKEN judge must
    // not look like a downgrade caused by a working one.
    return this.markJudgeFailure({
      type: 'prompt',
      promptType: band.promptType,
      description: band.description,
      command: band.command,
      appName: band.appName,
      reason: band.reason,
      impact: band.impact,
      requiresSystemPrompt: band.requiresSystemPrompt,
      rememberForMinutes: band.rememberForMinutes,
      commandHash: band.commandHash,
      approvalTtlSeconds: band.approvalTtlSeconds,
      ...(checkResult.type === 'modify' ? { modifiedInput: checkResult.input } : {}),
    }, outcome.reason, outcome.verdict);
  }

  /**
   * Consult the guardian for one borderline (`prompt`) auto-mode decision and
   * return the (possibly transformed) check result. `no_objection` -> allow
   * (preserving any input modification), `deny` -> block with the guardian
   * diagnostic, everything else -> the original prompt (ask the user, exactly
   * as today). The permission-service still mints every receipt downstream, so
   * the audit record + PermissionRequest/PermissionDenied events are unchanged.
   *
   * TOCTOU: on `no_objection` the executed input is `prompt.modifiedInput` when
   * a hook rewrote it, NOT the original `ctx.input`. The verdict — and every
   * key derived from it (cache, override, deny loop-guard, all hashed from the
   * action) — MUST bind to that EXACT executed input, so a PreToolUse hook can
   * never rewrite the command after the judge has cleared the original. Build
   * the action from `prompt.modifiedInput ?? ctx.input` and judge THAT.
   */
  private async consultGuardianForBorderline(
    prompt: Extract<PreToolUseCheckResult, { type: 'prompt' }>,
    ctx: {
      toolName: string;
      input: Record<string, unknown>;
      cwd: string;
      workspaceRoot?: string;
      guardian: GuardianConsultState;
      modeVersion: number;
      /** Reads the session's LIVE mode version after the judge answers (P6.204). */
      readModeVersion?: () => number;
      /**
       * The permission mode the judge is told about. `auto` for the auto-mode
       * borderline band; `plan` when plan mode routes a shell command here (the
       * band's own sentence, "the classifier reviews shell commands during
       * planning instead of prompting you" — `permission-modes.md:240` on the
       * 2026-08-23 fetch; quote the sentence, the number decays). The judge's
       * verdict vocabulary is the same either way — only the stated mode
       * differs, and it must be the truth.
       */
      mode?: 'auto' | 'plan';
      /**
       * Out-param: set to a receipt-provenance marker when the guardian converts
       * this borderline action into an allow, so the audit receipt is
       * distinguishable from a plain rule-allow (finding G2-2). Left unset on
       * deny/ask so those paths are byte-identical to today.
       */
      guardianProvenance?: string;
      /**
       * Out-param: true when the consult produced a FRESH judge deny (not a
       * cache replay). The auto-mode self-downgrade counts only fresh blocks.
       */
      guardianFreshDeny?: boolean;
    },
  ): Promise<PreToolUseCheckResult> {
    // The exact input that will be authorized/executed on allow.
    const executedInput = prompt.modifiedInput ?? ctx.input;
    const orgPolicy = this.resolveGuardianOrgPolicy();
    const projectInstructions = await this.buildGuardianProjectInstructions();
    const action = this.buildGuardianAction(ctx.toolName, executedInput, ctx.cwd);
    const judgeInput: GuardianJudgeInput = {
      action,
      // Trusted intent = the user's own current-turn message only. Tool outputs
      // and file contents are NEVER placed here (they would be untrusted).
      trustedIntent: this.getCurrentTurnUserMessage() ?? '',
      // P6.203 (A31) working tree + P6.64 (A1) branch — see `buildGuardianFacts`.
      facts: await this.buildGuardianConsultFacts(ctx.mode ?? 'auto', ctx.cwd, ctx.workspaceRoot),
      ...(orgPolicy ? { orgPolicy } : {}),
      // P6.203 (A30) — the project's own instructions, bounded and untrusted.
      ...(projectInstructions ? { projectInstructions } : {}),
    };

    const modelId = this.resolveGuardianModelId();
    const outcome = await ctx.guardian.consult({
      input: judgeInput,
      cwd: ctx.cwd,
      modeVersion: ctx.modeVersion,
      ...(ctx.readModeVersion ? { readModeVersion: ctx.readModeVersion } : {}),
      ...(modelId ? { modelId } : {}),
    });

    if (outcome.kind === 'allow') {
      this.debug(`Guardian no_objection for ${ctx.toolName}: ${outcome.verdict.reason}`);
      // Receipt provenance: mark this allow as guardian-approved so the audit
      // receipt (minted downstream by permissionService.authorize) is
      // distinguishable from a plain rule-allow. Threaded through the existing
      // `additionalContext` string on the decision — no wire-contract change.
      ctx.guardianProvenance = this.buildGuardianProvenance(outcome.verdict);
      // Preserve any input transform the gate produced (prompt.modifiedInput) —
      // this is the same object the judge cleared above.
      return prompt.modifiedInput
        ? { type: 'modify', input: prompt.modifiedInput }
        : { type: 'allow' };
    }
    if (outcome.kind === 'deny') {
      this.debug(`__GUARDIAN_DENY__${JSON.stringify({
        toolName: ctx.toolName,
        category: outcome.verdict.category,
        reason: outcome.verdict.reason,
      })}`);
      // Block with the guardian diagnostic (category + reason, visible to the
      // model). The H1 hook loop-cap does not see this deny (it is not a hook
      // deny); the guardian's own per-turn loop-guard bounds retries.
      ctx.guardianFreshDeny = outcome.fresh === true;
      return { type: 'block', reason: outcome.diagnostic };
    }
    // ask (disabled/override/circuit-open/unsure/failure): today's behavior —
    // the original prompt asks the user. On circuit-open, surface a one-line
    // diagnostic so the fallback is visible.
    if (outcome.reason === 'circuit-open') {
      this.debug(`Guardian circuit breaker open — asking the user for ${ctx.toolName}`);
    }
    return this.markJudgeFailure(prompt, outcome.reason, outcome.verdict);
  }

  /**
   * Say so when the judge FAILED, rather than asking as if nothing happened.
   *
   * A `failure` ask — spawn error, timeout, malformed verdict — produces a
   * prompt byte-identical to a healthy one, so a judge that has been broken all
   * session looks exactly like a judge doing its job carefully. The user is
   * still asked either way (fail-closed to a human is the contract, and this
   * does not change it) — they simply get to know WHY they are being asked.
   *
   * Only `failure`. `unsure` is the judge working and declining to decide;
   * `disabled`, `override` and `circuit-open` are all states the user either
   * chose or can already see.
   *
   * AND IT CARRIES THE JUDGE'S OWN REASON, because a bare marker made the
   * failure visible without making it DIAGNOSABLE: "the safety judge could not
   * answer" reads the same for a judge timeout (`GUARDIAN_DEFAULT_TIMEOUT_MS`),
   * a broken port, a judge whose setup threw, and a model that would not produce the schema — four
   * different things to do about it, and the debug channel (silent in a
   * packaged build) was the only place they differed. The deny path has always
   * embedded `verdict.reason` in its diagnostic (`denyDiagnostic`); the failure
   * path was the odd one out. The text is safe to place here for the same
   * reason it is safe there: it left the judge through `sanitizeReason`, so it
   * is one bounded single line with control characters and harness markers
   * already defanged.
   */
  private markJudgeFailure(
    prompt: Extract<PreToolUseCheckResult, { type: 'prompt' }>,
    reason: GuardianAskReason,
    verdict?: GuardianRunResult,
  ): PreToolUseCheckResult {
    if (reason !== 'failure') return prompt;
    const why = verdict?.reason?.trim();
    this.debug(`Guardian judge FAILED — asking the user, marked${why ? `: ${why}` : ''}`);
    // D1.271 — the guard {@link PiAgent.authorizeAndSend}'s D1.256 twin carries
    // and this site did not, for the reason `base-agent.ts:tokenCapReachedNotice`
    // states: an i18next singleton nobody initialised answers `undefined` from
    // `t()` — not the key — and the headless `nessy-server` entry never calls
    // `setupI18n()` (only the four renderer entries and `electron/src/main/index.ts`
    // do). MEASURED in a plain `bun` child on 2026-09-18 (95.89 s real, user 1.00 /
    // sys 0.43, load 9.05): importing this module and reading
    // `i18n.t('settings.ai.guardian.judgeFailedMarker')` answers `undefined`, and
    // `i18n.isInitialized` answers `undefined` too. Unguarded, the card the human
    // answers therefore read the literal `undefined`, or `<reason> — undefined
    // (<judge reason>)` — strictly worse than no marker at all, because the marker
    // exists to tell the user the judge could not answer. Idempotent (`setupI18n`
    // has its own `initialized` flag) and synchronous (`initImmediate: false`), so
    // it cannot override a language an app entry already chose; `fallbackLng: "en"`
    // is what makes the result a SENTENCE rather than the key on a locale that has
    // not been selected.
    if (!i18n.isInitialized) setupI18n();
    const base = i18n.t('settings.ai.guardian.judgeFailedMarker');
    const marker = why ? `${base} (${why})` : base;
    return {
      ...prompt,
      reason: prompt.reason ? `${prompt.reason} — ${marker}` : marker,
    };
  }

  /**
   * Run observational post-tool hooks before Pi commits the tool result to
   * model context. The response can replace output only; it carries no
   * permission action or executable input.
   */
  private async handlePostToolUseRequest(req: {
    requestId: string;
    toolName: string;
    input: Record<string, unknown>;
    toolResponse: string;
    isError: boolean;
  }): Promise<void> {
    const sourceChild = this.subprocess;
    const responseEpoch = this.subprocessResponseEpoch;
    let updatedToolOutput: string | undefined;
    try {
      const event = req.isError ? 'PostToolUseFailure' : 'PostToolUse';
      const result = await this.emitAutomationEvent(event, {
        hook_event_name: event,
        tool_name: req.toolName,
        tool_input: req.input,
        ...(req.isError
          ? { error: req.toolResponse }
          : { tool_response: req.toolResponse }),
      });
      const rewrite = result?.decision?.updatedToolOutput === undefined
        ? undefined
        : resolveHookToolOutputRewrite({
            toolName: req.toolName,
            originalOutput: req.toolResponse,
            updatedToolOutput: result.decision.updatedToolOutput,
          });
      if (rewrite && 'ignoredReason' in rewrite) {
        // Documented: a built-in whose replacement does not match its output
        // shape is ignored and the ORIGINAL output is used. Silent to the model,
        // one info line for the author.
        this.debug(`__HOOK_OUTPUT_IGNORED__${JSON.stringify({
          event, toolName: req.toolName, reason: rewrite.ignoredReason,
        })}`);
      } else if (rewrite) {
        updatedToolOutput = rewrite.output;
      }
      // hooks.md: a top-level `decision: "block"` on PostToolUse/PostToolUseFailure
      // does not cancel anything (the tool already ran) — it feeds `reason` back
      // to the model. The tool result IS that channel here, so the reason is
      // appended to whatever the model was going to see.
      const blockDecision = result?.decision?.decision;
      const blockReason = result?.decision?.reason?.trim();
      if ((blockDecision === 'block' || blockDecision === 'deny') && blockReason) {
        // D1.237 · composed by the SHARED `fenceHookBand` now — element, notice, fence, defang — which is byte-for-byte `base-agent.ts:recordHookBlockFeedback`'s call. Until this row it was an ELEMENT AND NOTHING ELSE, the pre-P2.31 shape P2.250 closed on that base-class twin and P3.281 closed on `fenceHookContext` above; it was the LAST raw hook band in `packages/shared/src` (the D1.237 census found it, not a reader) and it rides the TOOL RESULT the model reads, so a forged `<system-reminder>` in a hook's stdout reached the model live. `fenceHookBand` returns `undefined` only for a blank body, which a trimmed non-empty `blockReason` cannot be — the `if` narrows the type and is not a reachable branch.
        const band = fenceHookBand({ element: 'hook_feedback', source: 'hook_feedback', body: blockReason, attributes: { event } });
        if (band) { updatedToolOutput = `${updatedToolOutput ?? req.toolResponse}\n\n${band}`; this.debug(`__HOOK_BLOCK__${JSON.stringify({ event, toolName: req.toolName, applied: true })}`); }
      }
    } catch (error) {
      this.debug(`Post-tool hook failed open for ${req.toolName}: ${PiAgent.describeThrown(error)}`);
    }
    if (this.subprocess !== sourceChild || this.subprocessResponseEpoch !== responseEpoch) return;
    this.send({
      type: 'post_tool_use_response',
      requestId: req.requestId,
      ...(updatedToolOutput === undefined ? {} : { updatedToolOutput }),
    });
  }

  /**
   * R73 · run `PreCompact` and answer the compaction the subprocess is holding.
   *
   * hooks.md#precompact: "Exit with code 2 to block compaction […] You can also
   * block by returning JSON with `\"decision\": \"block\"`", and hooks.md's
   * exit-code table row is "`PreCompact` | Yes | Blocks compaction". Both
   * channels arrive here as the same projected `decision`, because
   * `getHookCommandPreToolDecision` already turns exit 2 into `{decision:'block'}`
   * and `PreCompact` is one of the top-level-`decision` events.
   *
   * Bounded by the prompt-gate timeout for the reason the bound exists there: a
   * hook that never settles must not hold a compaction open forever, and the
   * documented failure direction is to proceed.
   *
   * A blocked compaction is NOT a terminated turn — `hookBlockEndsTurn('PreCompact')`
   * stays `false`. hooks.md: a proactive auto-compaction is skipped and "the
   * conversation continues uncompacted".
   */
  private async handlePreCompactRequest(req: {
    requestId: string;
    trigger: 'manual' | 'auto';
    source: string;
    /**
     * D1.115 — `null`, not `''`, when there is nothing to carry.
     * `hooks.md#precompact-input`: "For `manual`, `custom_instructions`
     * contains what the user passes into `/compact` and is `null` when they
     * pass nothing. For `auto`, `custom_instructions` is `null`."
     */
    customInstructions: string | null;
  }): Promise<void> {
    const sourceChild = this.subprocess;
    const responseEpoch = this.subprocessResponseEpoch;
    let block: { reason?: string } | undefined;
    try {
      const outcome = await this.awaitPromptGateDecision('PreCompact', {
        hook_event_name: 'PreCompact',
        trigger: req.trigger,
        custom_instructions: req.customInstructions,
        source: req.source,
      });
      if (outcome !== 'timed-out' && isBlockingHookDecision(outcome?.decision)) {
        const reason = outcome?.decision?.reason?.trim();
        block = reason ? { reason } : {};
        this.debug(`__HOOK_BLOCK__${JSON.stringify({ event: 'PreCompact', applied: true })}`);
      } else if (outcome === 'timed-out') {
        this.debug(`__HOOK_BLOCK__${JSON.stringify({ event: 'PreCompact', reason: 'timeout', applied: false })}`);
      }
    } catch (error) {
      this.debug(`PreCompact hook failed open: ${PiAgent.describeThrown(error)}`);
    }
    if (this.subprocess !== sourceChild || this.subprocessResponseEpoch !== responseEpoch) return;
    this.send({
      type: 'pre_compact_response',
      requestId: req.requestId,
      ...(block ? { block: true, ...(block.reason ? { reason: block.reason } : {}) } : {}),
    });
  }

  /**
   * Handle a pre_tool_use_request from the subprocess.
   * Runs the centralized permission pipeline and sends the decision back.
   */
  private async handlePreToolUseRequest(req: {
    requestId: string;
    toolName: string;
    toolCallId?: string;
    manifestResponseEpoch?: number;
    input: Record<string, unknown>; sourceActivationRerun?: { automationResult: AgentEventExecutionResult | undefined }; // UA12.74
  } & PiToolIdentity): Promise<void> {
    const sourceChild = this.subprocess;
    const sourceAttempt = this.subprocessAttempt;
    const responseEpoch = this.subprocessResponseEpoch;
    const { requestId, toolCallId, input } = req;
    let toolName = req.toolName;
    let toolIdentity: PiToolIdentity = {};
    let manifestTool: PiExecutionManifestV2['tools'][number] | null = null;
    let manifestOwner: {
      manifest: PiExecutionManifestV2;
      runtime: CapabilityTurnRuntime;
      materializer: CapabilityTurnRuntime['materializer'];
      generation: string;
      manifestHash: string;
      requestId: string;
    } | null = null;
    if (this.activeExecutionManifest || req.piName || req.manifestHash || req.manifestGeneration) {
      try {
        const manifest = this.activeExecutionManifest;
        if (!manifest || !req.piName || !req.manifestHash || !req.manifestGeneration) {
          throw new Error('Pi pre-tool request is missing active manifest identity');
        }
        assertPiExecutionManifestIdentity(manifest, {
          generation: req.manifestGeneration,
          manifestHash: req.manifestHash,
        });
        const runtime = this.assertActiveManifestRuntime(manifest);
        manifestOwner = {
          manifest,
          runtime,
          materializer: runtime.materializer,
          generation: manifest.snapshotGeneration,
          manifestHash: manifest.manifestHash,
          requestId,
        };
        manifestTool = manifest.tools.find(value => value.binding.piName === req.piName) ?? null;
        if (!manifestTool) throw new Error(`Pi tool is not advertised: ${req.piName}`);
        const expectedPolicyName = manifestTool.binding.permissionName;
        if (req.toolName !== expectedPolicyName
          || req.semanticId !== manifestTool.descriptor.id
          || req.surfaceVersion !== manifestTool.binding.surfaceVersion) {
          throw new Error(`Pi pre-tool identity mismatch for ${req.piName}`);
        }
        toolName = expectedPolicyName;
        toolIdentity = {
          semanticId: manifestTool.descriptor.id,
          piName: manifestTool.binding.piName,
          surfaceVersion: manifestTool.binding.surfaceVersion,
          ...(req.originalName ? { originalName: req.originalName } : {}),
          manifestGeneration: manifest.snapshotGeneration,
          manifestHash: manifest.manifestHash,
          manifestProvenance: manifest.provenance.map(value => `${value.capabilityKey}@${value.generation}`),
        };
      } catch (error) {
        this.send({
          type: 'pre_tool_use_response',
          requestId,
          action: 'block',
          reason: PiAgent.describeThrown(error),
        });
        return;
      }
    }
    try {
      if (this.activeExecutionManifest) {
        this.assertActiveManifestRuntime(this.activeExecutionManifest);
      } else {
        this.assertCapabilityTurnActive();
      }
    } catch {
      this.send({
        type: 'pre_tool_use_response',
        requestId,
        action: 'block',
        reason: 'The captured capability snapshot was revoked. Start a new turn.',
      });
      return;
    }
    let responded = false;
    const continuationState = (): 'current' | 'channel-replaced' | 'owner-revoked' => {
      if (responseEpoch !== this.subprocessResponseEpoch
        || this.subprocess !== sourceChild
        || this.subprocessAttempt !== sourceAttempt) {
        return 'channel-replaced';
      }
      if (!manifestOwner) return 'current';
      try {
        manifestOwner.materializer.assertActive();
      } catch {
        return 'owner-revoked';
      }
      if (manifestOwner.requestId !== requestId
        || this.capabilityTurnRuntime !== manifestOwner.runtime
        || this.activeExecutionManifest !== manifestOwner.manifest
        || this.activeExecutionManifest.snapshotGeneration !== manifestOwner.generation
        || this.activeExecutionManifest.manifestHash !== manifestOwner.manifestHash) {
        return 'owner-revoked';
      }
      return 'current';
    };
    const ensureContinuation = (): boolean => {
      const state = continuationState();
      if (state === 'current') return true;
      if (state === 'owner-revoked' && !responded) {
        responded = true;
        this.send({
          type: 'pre_tool_use_response',
          requestId,
          action: 'block',
          reason: 'The captured capability snapshot was revoked. Start a new turn.',
        });
      }
      return false;
    };
    const sendDecision = (message: Record<string, unknown>): boolean => {
      if (!ensureContinuation() || responded) return false;
      responded = true;
      this.send(message);
      return true;
    };
    if (!ensureContinuation()) return;
    const debugSessionId = this.config.session?.id || this._sessionId;
    this.debug(`PreToolUse request from subprocess: ${toolName} (${requestId}, sessionId=${debugSessionId})`);

    // Capture metadata BEFORE centralized checks strip it out.
    // This bridge is deterministic and avoids relying solely on side-channel store lookups.
    const preIntent = typeof input._intent === 'string' ? input._intent : undefined;
    const preDisplayName = typeof input._displayName === 'string' ? input._displayName : undefined;
    if (toolCallId && (preIntent || preDisplayName)) {
      this.preToolMetadataByCallId.set(toolCallId, {
        intent: preIntent,
        displayName: preDisplayName,
        capturedAt: Date.now(),
      });
      this.debug(`Captured pre-tool metadata for ${toolName} (${toolCallId}, sessionId=${debugSessionId}): intent=${!!preIntent}, displayName=${!!preDisplayName}`);
    }

    const rootPath = this.config.workspace.workspaceRootPath;
    const workspaceSlug = extractWorkspaceSlug(rootPath, this.config.workspace.id);
    const sessionId = this.config.session?.id || this._sessionId;
    // Composite identity (immutable workspace UUID + sessionId) for mode-state lookups.
    const sessionKey: SessionKey = { workspaceId: this.config.workspace.id, sessionId };
    // P6.704 - see the init-message site above.
    const plansFolderPath = sessionId
      ? (resolvePlansDirectory(this.workingDirectory)
        ?? getSessionPlansDir(this.config.workspace.id, sessionId))
      : undefined;
    const dataFolderPath = sessionId
      ? getSessionDataPath(this.config.workspace.id, sessionId)
      : undefined;

    // Build RTK context fresh per call so toggling the preference takes
    // effect without restart. `getRtkPath()` is cached per process.
    const rtkContext: RtkContext | undefined = getRtkEnabled()
      ? { enabled: true, path: getRtkPath(), exclude: getRtkExcludeCommands() }
      : undefined;
    const bashSeatbeltSandboxContext = {
      enabled: getMacosSeatbeltBashSandboxEnabled(),
      cwd: this.config.session?.workingDirectory ?? rootPath,
      writablePaths: [plansFolderPath, dataFolderPath].filter((path): path is string => Boolean(path)),
    };
    const mcpPreToolUseContext = this.getMcpPreToolUseContext();

    const checkArgs = {
      toolName,
      input,
      sessionId,
      sessionKey,
      permissionMode: this.permissionManager.getPermissionMode(),
      workspaceRootPath: rootPath,
      workspaceId: workspaceSlug,
      plansFolderPath,
      dataFolderPath,
      workingDirectory: this.config.session?.workingDirectory,
      // P6.202 clause (3) — "The prompt doesn't appear in non-interactive `-p`
      // runs or background sessions". `isHeadless` is the observable this fork
      // already keeps for that distinction ("disables interactive tools"), and
      // it is the same one Pi's `ask_user` service reads two thousand lines
      // below, so the card and the question agree about what a session is.
      interactive: this.config.isHeadless !== true,
      activeSourceSlugs: Array.from(this.sourceManager.getActiveSlugs()),
      allSourceSlugs: this.sourceManager.getAllSources().map(s => s.config.slug),
      ...mcpPreToolUseContext,
      // R28: the gate is the one seam every file-touching call passes through,
      // so path-scoped rules arm here rather than in each tool.
      ...this.getPathScopedRulePreToolUseContext(),
      hasSourceActivation: !!this.onSourceActivationRequest,
      permissionManager: this.permissionManager,
      prerequisiteManager: this.prerequisiteManager,
      rtkContext,
      bashSeatbeltSandboxContext,
      ...(this.capabilityTurnRuntime?.unsandboxedCommandPatterns?.length
        ? { unsandboxedCommandPatterns: this.capabilityTurnRuntime.unsandboxedCommandPatterns }
        : {}),
      // The managed band control. The gate reads it on the `auto` branch only —
      // `auto-mode-config.md:226` scopes the key to "while auto mode is active"
      // — so it is safe to hand over unconditionally here.
      ...(this.capabilityTurnRuntime?.classifyAllShell
        ? { classifyAllShell: true }
        : {}),
      ...(this.sessionAdditionalDirectories.length
        ? { sessionAdditionalDirectories: [...this.sessionAdditionalDirectories] }
        : {}),
      ...(this.worktreeGateContext() ?? {}),
      ...(this.workflowLaunchGateContext(toolName, input) ?? {}),
      onDebug: (msg: string) => this.debug(`PreToolUse(sessionId=${sessionId}): ${msg}`),
    };
    let checkResult = runPreToolUseChecks(checkArgs);

    /**
     * P6.307 — the review's effort level, remembered ACROSS sessions.
     *
     * `code-review.md:327`, the half this fork did not have: the review
     * *"reuses the last level from `low` through `max` you typed, **even in an
     * earlier session**"*. The bundled skill already reuses it inside one
     * conversation; only the crossing needed a store, and the store is a
     * `StoredConfig` key the HOST owns — `review-tool.ts` runs in the Pi
     * subprocess and a second process must not write the user's `config.json`.
     *
     * BOTH HALVES SIT ON ONE SEAM, and that is why they are here rather than in
     * the tool. Every Pi tool call — orchestrator tools included, since
     * `adaptTools` wraps the whole projected set — arrives at this gate with its
     * input, and the gate can answer `modify` with a rewritten one. So the level
     * the model chose is READ off the call input (no `review-tool.ts` change at
     * all), and the level it omitted is FILLED here.
     *
     * Deliberately AFTER `runPreToolUseChecks` and only over an `allow`: a fill
     * must never resurrect a call the gate blocked, and the value it adds is not
     * a path, so it needs no re-gate.
     *
     * Never fills when the model named a level, never remembers `off`, and never
     * invents one when nothing was ever typed — `:327`'s own never-typed case is
     * *"the review uses the session's current effort"*, which is what an absent
     * `effort` already means to the tool.
     */
    let reviewEffortContext: string | undefined;
    if (toolName === 'review') {
      const typed = normalizeThinkingLevel(input.effort);
      if (typed && typed !== 'off') {
        // The WRITE half. Fire-and-forget: remembering is not worth failing a
        // tool call over, and the setter already refuses anything unrecognised.
        try {
          if (setLastReviewEffortLevel(typed)) {
            this.debug(`PreToolUse(sessionId=${sessionId}): remembered review effort "${typed}" for later sessions`);
          }
        } catch (error) {
          this.debug(`PreToolUse(sessionId=${sessionId}): could not remember the review effort: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else if (input.effort === undefined && (checkResult.type === 'allow' || checkResult.type === 'modify')) {
        // The READ half.
        const remembered = getLastReviewEffortLevel();
        if (remembered) {
          const base = checkResult.type === 'modify' ? checkResult.input : input;
          checkResult = { type: 'modify', input: { ...base, effort: remembered } };
          // done_means (2)'s "and SAYS so in its first line", satisfied through
          // the model rather than a second UI. `additionalContext` is the one
          // channel that reaches the Pi model with hidden context, the skill is
          // already told to "say which level you reused when you reuse one",
          // and a host-drawn badge would be a second voice for a sentence the
          // review is about to write anyway.
          reviewEffortContext = `This review is running at effort "${remembered}" — the last level you typed for a review, carried over from an earlier session. Say so in your first line.`;
          this.debug(`PreToolUse(sessionId=${sessionId}): review inherited the remembered effort "${remembered}"`);
        }
      }
    }

    // Run automations after the centralized gate so hook allow/update cannot
    // re-open the non-overridable deniedPaths floor.
    // hooks.md: neither PreToolUse nor PermissionRequest fires for
    // EndConversation (R15/R1 follow-up). No Pi binding carries that name
    // today, so this is the name-based guard that self-activates if one ever
    // does; the band site repeats it for PermissionRequest.
    const automationResult = req.sourceActivationRerun ? req.sourceActivationRerun.automationResult : toolName === 'EndConversation' // UA12.74: once per call
      ? undefined
      : await this.emitAutomationEvent('PreToolUse', {
          hook_event_name: 'PreToolUse',
          tool_name: toolName,
          tool_input: input,
        });
    if (!ensureContinuation()) return;

    // `defer` (hooks.md "Defer a tool call for later", R7 Task 5). Honored
    // only on the headless surface and only when the turn contains a single
    // tool call — everywhere else it logs a warning and the call falls
    // through the normal permission flow as if the hook returned nothing
    // (`reason`/`updatedInput`/`additionalContext` are all ignored for
    // defer). Ranked below deny by the parser/merger, so a defer here means
    // no hook denied. On defer the tool never executes: the pending call is
    // preserved (no pre_tool_use_response) and the run terminates success
    // with stop reason `tool_deferred` + the `deferred_tool_use` payload.
    let hookDecision = automationResult?.decision;
    if (hookDecision?.decision === 'defer') {
      if (!this.config.isHeadless) {
        this.debug(`PreToolUse defer ignored for ${toolName}: only honored in headless runs (interactive sessions fall through the normal flow).`);
        hookDecision = undefined;
      } else if (this.lastAssistantToolCallCount > 1) {
        this.debug(`PreToolUse defer ignored for ${toolName}: the turn contains ${this.lastAssistantToolCallCount} tool calls and resume can only re-run one.`);
        hookDecision = undefined;
      } else {
        const deferred = {
          id: toolCallId ?? requestId,
          name: toolName,
          input,
        };
        this.config.onToolCallDeferred?.({
          schemaVersion: 1,
          toolUseId: deferred.id,
          toolName,
          input,
          permissionMode: this.permissionManager.getPermissionMode(),
          deferredAt: Date.now(),
        });
        this.debug(`PreToolUse defer: suspending ${toolName} (${deferred.id}) and terminating the run with tool_deferred.`);
        this.eventQueue.enqueue({
          type: 'complete',
          terminalReason: 'tool_deferred',
          deferredToolUse: deferred,
        });
        this.forceAbort(AbortReason.ToolDeferred);
        return;
      }
    }

    const hookDecisionValue = hookDecision?.decision;
    const blockedBeforeHook = checkResult.type === 'block';
    const hookOverlay = this.applyPreToolUseHookDecision(
      checkResult,
      hookDecision,
      toolName,
    );
    checkResult = hookOverlay.result;
    // CI2: fold any pending edit-feedback diagnostics (from a prior successful
    // edit this turn) into the PreToolUse additionalContext — the only channel
    // that reaches the Pi model with hidden context. Observational; it rides the
    // existing allow/modify/prompt delivery and never changes the decision.
    const editFeedbackContext = this.consumePendingEditFeedback();
    // R28: a rule the gate just activated rides the same additional-context
    // channel — it is what makes a path-scoped rule reach the model at all.
    const pathScopedRuleContext = this.consumePendingPathScopedRuleContext();
    const hookAdditionalContext = [hookOverlay.additionalContext, editFeedbackContext, pathScopedRuleContext, reviewEffortContext]
      .filter((value): value is string => Boolean(value))
      .join('\n\n') || undefined;

    // Defense-in-depth: if the hook injected a rewritten input, re-run the gate
    // on that input so a hook-supplied updatedInput can never smuggle a path
    // through the non-overridable deniedPaths floor.
    if (hookOverlay.hookUpdatedInput) {
      const recheck = runPreToolUseChecks({ ...checkArgs, input: hookOverlay.hookUpdatedInput });
      if (checkResult.type === 'block') {
        // A stronger centralized block remains authoritative after revalidation.
      } else if (recheck.type === 'block') {
        checkResult = recheck;
      } else if (checkResult.type === 'source_activation_needed'
        || checkResult.type === 'call_llm_intercept') {
        // F1.548: a third arm (`spawn_session_intercept`) went with its variant.
        if (recheck.type === checkResult.type) checkResult = recheck;
      } else if (checkResult.type === 'prompt') {
        checkResult = {
          ...checkResult,
          modifiedInput: recheck.type === 'modify'
            ? recheck.input
            : recheck.type === 'prompt'
              ? recheck.modifiedInput ?? hookOverlay.hookUpdatedInput
              : hookOverlay.hookUpdatedInput,
        };
      } else if (recheck.type === 'prompt' || recheck.type === 'modify') {
        checkResult = recheck;
      }
    }

    // Hook loop-guard: the SDK subprocess feeds hook denies back to the model,
    // which can retry indefinitely. Count denies AUTHORED by a hook (not the
    // centralized gate) per turn on two levels, because hook deny reasons can
    // be dynamic (timestamps, rate-limit counters) and one generic reason may
    // deny different inputs while the model legitimately explores
    // alternatives:
    //  - primary (tool, input hash, reason), threshold 3: a true retry loop
    //    re-issuing the SAME call against the SAME verdict. Different inputs
    //    under one generic reason never accumulate here.
    //  - secondary per-tool total of every hook deny (any input/reason),
    //    threshold 10: the backstop for dynamic-reason loops the primary key
    //    never sees twice, and for pathological input churn.
    // Both levels escalate identically: one bounded final-notice reminder at
    // the threshold, then the next deny past it stops the turn through the
    // existing stop path with a visible diagnostic — never a silent hang.
    if (!blockedBeforeHook
      && (hookDecisionValue === 'block' || hookDecisionValue === 'deny')
      && checkResult.type === 'block') {
      const loopKey = [
        toolName,
        hashPreToolInputForLoopGuard(input),
        automationResult?.decision?.reason ?? '',
      ].join('\u0000');
      const denyCount = (this.preToolHookDenyCounts.get(loopKey) ?? 0) + 1;
      this.preToolHookDenyCounts.set(loopKey, denyCount);
      const totalDenyCount = (this.preToolHookDenyTotals.get(toolName) ?? 0) + 1;
      this.preToolHookDenyTotals.set(toolName, totalDenyCount);
      const diagnostic = denyCount > PRE_TOOL_HOOK_DENY_LOOP_THRESHOLD
        ? `A PreToolUse hook denied "${toolName}" ${denyCount} times this turn`
          + ` (reason: ${checkResult.reason}). Stopping the turn to break the hook retry loop.`
        : totalDenyCount > PRE_TOOL_HOOK_DENY_TOTAL_THRESHOLD
          ? `PreToolUse hooks denied "${toolName}" ${totalDenyCount} times this turn across varying inputs or reasons`
            + ` (latest reason: ${checkResult.reason}). Stopping the turn to break the hook deny loop.`
          : undefined;
      if (diagnostic) {
        this.debug(`Hook deny loop cap exceeded for ${toolName} `
          + `(${denyCount}x same call, ${totalDenyCount}x total); stopping turn`);
        // Resolve the subprocess's pending request first so it never waits on
        // a reply that will not come, then surface the diagnostic and stop.
        if (!sendDecision({
          type: 'pre_tool_use_response',
          requestId,
          action: 'block',
          reason: diagnostic,
        })) return;
        this.eventQueue.enqueue({ type: 'error', message: diagnostic });
        this.forceAbort(AbortReason.HookLoopCap);
        return;
      }
      if (denyCount === PRE_TOOL_HOOK_DENY_LOOP_THRESHOLD) {
        checkResult = {
          ...checkResult,
          reason: `${checkResult.reason}\nFinal notice: a PreToolUse hook has denied this tool call `
            + `${denyCount} times this turn. Do not retry it — the next identical attempt will stop the turn.`,
        };
      } else if (totalDenyCount === PRE_TOOL_HOOK_DENY_TOTAL_THRESHOLD) {
        checkResult = {
          ...checkResult,
          reason: `${checkResult.reason}\nFinal notice: PreToolUse hooks have denied "${toolName}" `
            + `${totalDenyCount} times this turn. Stop calling this tool — the next denial will stop the turn.`,
        };
      }
    }

    // Guardian consult. Two disjoint bands, gated by the product setting
    // (`getGuardianEnabled()` via `guardianConsultState()`, default ON) and the
    // port being wired. Both write a provenance marker into `guardianProvenance`
    // on an approved run; it is merged into the receipt's additionalContext at
    // the allow/modify sites below. Never widens a decision.
    //
    //  - AUTO mode, `prompt` result: the deterministic gate already classified
    //    this action; a `prompt` in `auto` is EXACTLY the borderline band that
    //    asks the user today. Consult before asking: no_objection -> allow,
    //    deny -> block, unsure/failure/circuit/override -> ask (unchanged).
    //    Never runs on allow/modify/block, never on the low-risk fast path
    //    (those never reach `prompt` in auto).
    //  - ALLOW-ALL mode, `allow`/`modify` result: the gate auto-allows
    //    everything, so the deny-net reuses the risk classifier as its
    //    high-risk band and consults as a DENY-ONLY net: no_objection -> run,
    //    deny -> block, ask -> downgrade the auto-allow to a human prompt.
    //    Non-high-risk actions never consult (zero latency on the fast path).
    //
    // FAST PATH (G3-review finding 2): evaluate mode + result-type eligibility
    // FIRST — both are in-memory reads (mode-state lookup + the already-computed
    // `checkResult.type`), NO config IO. Only an eligible request resolves the
    // consult state, so `guardianConsultState()` (→ `getGuardianEnabled()` → a
    // sync `loadStoredConfig` read) is NEVER touched for safe/plan/ask/acceptEdits
    // or for ineligible result types (the low-risk fast path stays IO-free).
    const guardianProvenance: { value?: string } = {};
    // Set when a guardian consult converted a non-block result into a block —
    // an auto-mode denial the observational PermissionDenied side event
    // reports (R15 Task 5).
    let guardianDenied = false;
    const guardianMode = getPermissionModeDiagnostics(sessionKey);
    // A non-negotiable prompt is NEVER consulted: the floors (worktree
    // approval, requiresUserInteraction, an explicit ask rule, the
    // protected-path floor) exist so a human answers, and a judge
    // `no_objection` here would convert one of them into an allow. One
    // condition, at the gate — the DSL ask-rule class is protected downstream
    // by the readable-policy merge, which upgrades a guardian allow back to ask.
    //
    // ONE floor is exempt, in `auto` and in `plan` and in no other mode: the
    // removal circuit breaker, which the gate marks `autoClassifierAdjudicated`
    // in exactly those two (P2.3, owner decision 2026-08-22 — `2026-w30.md:84`,
    // the auto-mode classifier adjudicates dangerous `rm`; P2.21, owner
    // decision 2026-08-23 — the `permission-modes.md:577` row, below). The
    // marker moves NOTHING but the consult: a `no_objection` allows, a `deny`
    // blocks, and every other outcome — no port, setting off, open circuit,
    // transport error, `unsure`, a standing human override — falls back to the
    // breaker's own unconditional prompt. The `promptIsNonNegotiable` sites
    // further down (the readable-DSL merge, the PreToolUse hook allow, the
    // PermissionRequest band) are deliberately NOT given the exemption: a rule
    // or a hook still cannot clear a floor in any mode.
    const autoBorderlineEligible =
      checkResult.type === 'prompt'
      && guardianMode.permissionMode === 'auto'
      && (!promptIsNonNegotiable(checkResult) || promptIsClassifierAdjudicated(checkResult));
    // PLAN mode's shell band. The SENTENCE is the anchor and the number is only
    // a convenience: the 2026-08-23 fetch of `permission-modes.md` puts it at
    // `:240`, where this comment used to say `:156` — which on that same fetch
    // is a UI-label table row, and which is the third decayed number this plan
    // has paid for. "When auto mode is available and the `useAutoModeDuringPlan`
    // setting is on, which it is by default, the classifier reviews shell
    // commands during planning instead of prompting you. Approved commands run,
    // and rejected ones are blocked. Otherwise, commands outside the built-in
    // read-only set prompt for approval, including when the sandbox's auto-allow
    // mode is enabled." Two prompts qualify, and NOTHING else:
    //
    //  - the band the gate marked `planShellReview` — never a floor, which
    //    `promptIsNonNegotiable` also refuses, so 8c2990ad's rule holds in plan
    //    mode exactly as it does in auto: a floor still reaches the human;
    //  - since P2.21 (OQ-1, owner said ALIGN on 2026-08-23) the ONE floor the
    //    page itself routes here, marked `autoClassifierAdjudicated` by the
    //    gate. `permission-modes.md:577`, the `plan` row of the `:574-580`
    //    critical-path table, re-fetched 2026-08-23 and quoted whole: "| `plan`
    //    | Asks you to approve it. With [auto mode available during
    //    planning](#analyze-before-you-edit-with-plan-mode) and no bypass
    //    permissions available, sends it to the classifier instead |".
    //
    // DELIBERATE DEVIATION on the FIRST bullet, and it runs the other way: on
    // the shell band we are STRICTER than the page. `:240` does not end with the
    // sentence quoted above — two sentences later, on the SAME line: "In
    // sessions with bypass permissions available, neither the classifier nor a
    // prompt applies to planning commands; [Skip all checks with
    // bypassPermissions mode](#skip-all-checks-with-bypasspermissions-mode)
    // covers the few things that still prompt there." So the bypass-availability
    // precondition is NOT the `:577` row's private clause: the 2026-08-23 fetch
    // carries it on `:28`, `:238`, `:240`, `:494`, `:499` AND `:577` — it is
    // page-wide. On the page, a bypass-available planning session would simply
    // RUN a non-read-only command; here it is consulted with a classifier that
    // can DENY it. Teaching this band `bypassPermissionsAvailable()` would
    // therefore LOOSEN plan mode toward the page, the opposite direction from
    // OQ-3 (owner, 2026-08-23), so the predicate stays read on the SECOND
    // bullet's floor branch and nowhere else — one row wide, deliberately.
    //
    // "Auto mode is available" is BOTH halves: the org has not disabled it, and
    // the classifier itself resolves (`guardianConsultState`). When it does not,
    // the documented "Otherwise" branch prompts. The mapping the removal gets
    // here is auto's, unchanged and shared with it — `consultGuardianForBorderline`
    // is the same call — so a `deny` blocks and every failure mode lands back on
    // the breaker's own prompt.
    const planClassifierEligible =
      checkResult.type === 'prompt'
      && guardianMode.permissionMode === 'plan'
      && (checkResult.planShellReview === true
        ? !promptIsNonNegotiable(checkResult)
        // The floor branch. `promptIsClassifierAdjudicated` is TRUE only on the
        // removal breaker (the gate stamps it nowhere else), so every other
        // non-negotiable — worktreeApproval, protectedPath, requiresUserInteraction,
        // an explicit ask rule, the DSL ask class — is still refused in plan.
        // Evaluated lazily, after the mode check, so neither of the predicate's
        // two reads — the workspace cycle and, since P2.50, the install-wide
        // acknowledgment in config storage — happens on the ordinary fast path.
        : promptIsClassifierAdjudicated(checkResult) && !this.bypassPermissionsAvailable())
      && this.capabilityTurnRuntime?.autoModeUnavailable !== true
      // P6.68 — the session's own directory, so a `false` in its
      // `.claude/settings.local.json` can TIGHTEN this (and a `false` in the
      // repository-owned `.claude/settings.json` is ignored, per the page's own
      // asymmetry). Same expression `guardianCtx.cwd` is built from below.
      && getUseAutoModeDuringPlan(this.config.session?.workingDirectory ?? rootPath);
    const denyNetEligible =
      (checkResult.type === 'allow' || checkResult.type === 'modify')
      && guardianMode.permissionMode === 'bypassPermissions';
    const guardian = (autoBorderlineEligible || planClassifierEligible || denyNetEligible)
      ? this.guardianConsultState()
      : undefined;
    if (guardian && planClassifierEligible && checkResult.type === 'prompt') {
      const guardianCtx = {
        toolName,
        input,
        cwd: this.config.session?.workingDirectory ?? rootPath,
        workspaceRoot: rootPath,
        guardian,
        mode: 'plan' as const,
        modeVersion: guardianMode.modeVersion,
        // P6.204 — read the mode again when the judge ANSWERS, not only when it
        // is asked: a verdict awaited across a mode switch is discarded.
        readModeVersion: () => getPermissionModeDiagnostics(sessionKey).modeVersion,
        guardianProvenance: undefined as string | undefined,
      };
      checkResult = await this.consultGuardianForBorderline(checkResult, guardianCtx);
      guardianDenied = checkResult.type === 'block';
      guardianProvenance.value = guardianCtx.guardianProvenance;
      if (!ensureContinuation()) return;
    } else if (guardian && autoBorderlineEligible && checkResult.type === 'prompt') {
      const guardianCtx = {
        toolName,
        input,
        cwd: this.config.session?.workingDirectory ?? rootPath,
        workspaceRoot: rootPath,
        guardian,
        modeVersion: guardianMode.modeVersion,
        // P6.204 — read the mode again when the judge ANSWERS, not only when it
        // is asked: a verdict awaited across a mode switch is discarded.
        readModeVersion: () => getPermissionModeDiagnostics(sessionKey).modeVersion,
        guardianProvenance: undefined as string | undefined,
        guardianFreshDeny: undefined as boolean | undefined,
      };
      checkResult = await this.consultGuardianForBorderline(checkResult, guardianCtx);
      guardianDenied = checkResult.type === 'block';
      guardianProvenance.value = guardianCtx.guardianProvenance;
      // permission-modes.md: "If the classifier blocks an action 3 times in a
      // row or 20 times total, auto mode pauses and Claude Code resumes
      // prompting." The pause is a drop to the manual mode; the block reason
      // the model reads carries the announcement, and the ordinary
      // mode-change signal tells the host/UI.
      //
      // READ THE `guardianFreshDeny` GATE BEFORE CITING THIS PAUSE AS A
      // SAFETY NET, because it is NOT the one that fires on a repeat. A model
      // re-issuing the SAME (action, cwd) replays the session verdict cache,
      // so `fresh` is false and neither counter below advances — deliberate
      // (`guardian-consult.ts`, the `fresh: !fromCache` comment). What returns
      // the human on a repeated command is the PER-TURN CIRCUIT BREAKER: a
      // cached deny still calls `registerConsult(true)`, so three denies of the
      // same action open the circuit and the fourth consult in that turn falls
      // back to the prompt (pinned by "auto + circuit OPEN: falls back to the
      // human prompt" in `pi-agent-guardian-consult.test.ts`). This pause is
      // the net for a model working its way through DISTINCT denied actions.
      if (guardianDenied && guardianCtx.guardianFreshDeny) {
        this.autoClassifierBlocks.consecutive += 1;
        this.autoClassifierBlocks.total += 1;
        if (this.autoClassifierBlocks.consecutive >= 3 || this.autoClassifierBlocks.total >= 20) {
          this.autoClassifierBlocks.consecutive = 0;
          this.autoClassifierBlocks.total = 0;
          this.setPermissionMode('default');
          if (checkResult.type === 'block') {
            checkResult = {
              ...checkResult,
              reason: `${checkResult.reason}\nAuto mode paused: the classifier blocked repeated actions (3 in a row or 20 total), so the session dropped to ${PERMISSION_MODE_AGENT_LABELS.default} mode and will prompt for approvals again.`,
            };
          }
        }
      } else if (!guardianDenied) {
        this.autoClassifierBlocks.consecutive = 0;
      }
      if (!ensureContinuation()) return;
    } else if (
      guardian
      && denyNetEligible
      && (checkResult.type === 'allow' || checkResult.type === 'modify')
    ) {
      const permissionsContext: PermissionsContext =
        this.permissionManager.getCapabilityPermissionsContext?.() ?? {
          workspaceRootPath: rootPath,
          activeSourceSlugs: Array.from(this.sourceManager.getActiveSlugs()),
        };
      const guardianCtx = {
        toolName,
        input,
        cwd: this.config.session?.workingDirectory ?? rootPath,
        workspaceRoot: rootPath,
        permissionsContext,
        plansFolderPath, dataFolderPath, // F1.951 — the net bounds in-root edits by these too
        guardian,
        modeVersion: guardianMode.modeVersion,
        // P6.204 — read the mode again when the judge ANSWERS, not only when it
        // is asked: a verdict awaited across a mode switch is discarded.
        readModeVersion: () => getPermissionModeDiagnostics(sessionKey).modeVersion,
        guardianProvenance: undefined as string | undefined,
      };
      checkResult = await this.consultGuardianDenyNet(checkResult, guardianCtx);
      guardianDenied = checkResult.type === 'block';
      guardianProvenance.value = guardianCtx.guardianProvenance;
      if (!ensureContinuation()) return;
    }

    // ONE PermissionDenied retry per tool call. Scoped to this request, so the
    // budget cannot leak across tool calls or be reset by a re-entrant retry.
    let permissionDeniedRetries = 0;
    /**
     * R15's eligibility for the event: auto-mode denials only — a guardian deny
     * or a dontAsk denial of an action that would have prompted. Floors and
     * ordinary gate blocks never fire it, and it never fires for EndConversation.
     */
    const permissionDeniedEligible = (): boolean => (
      (guardianDenied || (checkResult.type === 'block' && checkResult.source === 'dont_ask_would_prompt'))
      && toolName !== 'EndConversation'
    );

    const authorizeAndSend = async (
      decision: PiPermissionPolicyDecision,
      canonicalInput: Record<string, unknown>,
      // Optional hook fired once the receipt is minted for THIS live channel
      // (after the continuation guard passes). Used by the `prompt` path to
      // observe the user's allow/deny so a human-approved action that the
      // guardian denied earlier can arm the post-denial override.
      onReceipt?: (outcome: 'allow' | 'deny') => void,
    ): Promise<void> => {
      const permissionService = this.config.permissionServicePort;
      if (!permissionService || !manifestOwner || !manifestTool) {
        sendDecision({
          type: 'pre_tool_use_response',
          requestId,
          action: 'block',
          reason: 'Pi permission authority is unavailable.',
        });
        return;
      }
      // The receipt must be bound to the session-build epoch the requesting
      // executor validates against; the subprocess states it in the request.
      // The host-side replaced-subprocess guard remains the separate
      // `responseEpoch` capture above.
      const manifestResponseEpoch = req.manifestResponseEpoch;
      if (!Number.isInteger(manifestResponseEpoch)) {
        sendDecision({
          type: 'pre_tool_use_response',
          requestId,
          action: 'block',
          reason: 'Pi permission request is missing its manifest response epoch.',
        });
        return;
      }
      try {
        const permissionContext: PermissionsContext =
          this.permissionManager.getCapabilityPermissionsContext?.() ?? {
            workspaceRootPath: rootPath,
            activeSourceSlugs: Array.from(this.sourceManager.getActiveSlugs()),
            projectTrusted: this.config.projectTrusted === true,
          };
        const readablePolicy = permissionsConfigCache.getMergedConfig(permissionContext).permissionDsl;
        // `rawSourceInput` carries the pre-transform input whose path parameter
        // is the model's raw (pre-canonicalization) form, so pathGlob rules test
        // the documented symlink pair (R1 follow-up). Candidates derived from
        // the wire input default to it; a user-approved input is its own raw.
        const evaluateReadablePolicy = (candidateInput: Record<string, unknown>, rawSourceInput: Record<string, unknown> = input) => {
          if (!readablePolicy) return {};
          const rawInputPath = rawDslInputPath(rawSourceInput);
          return evaluatePermissionDslUnderSessionToolAlias(readablePolicy, piSessionToolRuleAlias(manifestTool.binding), { // F1.478
            generation: manifestOwner.generation,
            semanticId: manifestTool.descriptor.id,
            toolName,
            input: candidateInput,
            cwd: this.config.session?.workingDirectory ?? rootPath,
            canonicalizePath: (value, cwd) => canonicalizeForDecision(resolve(cwd, value)),
            ...(rawInputPath === undefined ? {} : { rawInputPath }),
            // P6.191 — auto mode's DEFAULT-ON suspension of broad shell grants,
            // at the LAST site where an allow RULE could still clear an
            // auto-mode prompt on Pi (the readable DSL is where `Bash(*)`
            // actually lives; the Monitor gate in `SessionManager.ts` and the
            // compile-time marking in `permission-dsl.ts` are the other two).
            // `auto-mode-config.md#route-all-shell-commands-through-the-classifier`,
            // verbatim: "Claude Code suspends only the broad rules that grant
            // arbitrary code execution, such as `Bash(*)` or wildcarded
            // interpreters, together with every rule that names `Monitor`,
            // because Monitor commands run through the shell."
            //
            // Only the EVALUATION is skipped — the rule's text is untouched, so
            // leaving auto mode restores it verbatim by construction. Narrow
            // grants such as the page's own `Bash(npm test)` are not marked and
            // stay in effect, which is the default the same sentence names.
            ...(guardianMode.permissionMode === 'auto' ? { suspendBroadShellGrants: true } : {}),
          });
        };
        const readableDecision = evaluateReadablePolicy(canonicalInput);
        let effectiveDecision = decision;
        // P2.445 — a Pi refusal names the rule that decided and the scope it
        // came from. Both were already on `readableDecision.match` at this very
        // site; the sentences that dropped them lived here, not in the
        // evaluator. The composition is `permission-dsl.ts`'s so the same
        // wording is available to every other host that renders this decision.
        // D1.156 — THE SESSION MUST RECORD THAT THE JUDGE HAD ALREADY CLEARED
        // THIS, on the one path where a card is raised after `no_objection`.
        //
        // The row reads "in auto mode a permission card can be raised AFTER the
        // guardian judge answered `no_objection`, and nothing on the session
        // says which floor asked". Measured at HEAD by reading the ordering:
        // after a `no_objection` the consult returns `{ type: 'allow' }`, and
        // the ONLY producer that can still card that action is the branch
        // immediately below — the readable permission DSL's `ask` match, which
        // is deliberate (the consult gate's own comment: the DSL ask-rule class
        // "is protected downstream by the readable-policy merge, which upgrades
        // a guardian allow back to ask"). So the row is HALF refuted: that floor
        // already names itself on the card, through `permissionDslAskReason` and
        // `describePermissionDslMatch`.
        //
        // What was missing is the other half. On a consulted action
        // `decision.additionalContext` carries the guardian provenance
        // ({@link PiAgent.buildGuardianProvenance} — `guardian-approved
        // [category]: reason`), and both branches here REBUILT the decision
        // without it, where the two `allow` branches below deliberately keep it.
        // The receipt for a carded-or-refused-but-cleared action therefore said
        // nothing about the judge at all. `additionalContext` is already on all
        // three `PiPermissionPolicyDecision` variants and on the receipt, so
        // this is the neighbours' own spread and no contract moves.
        //
        // Whether the USER should also be told in the card — "the safety judge
        // had no objection; this rule asked anyway" — is a product posture and a
        // new locale key, so it is a recommendation to the owner rather than a
        // lane's decision, and the default card text is unchanged here.
        if (readableDecision.action === 'deny' || piReadableAskDontAskRefusal(readableDecision, decision, guardianMode.permissionMode, toolName) !== undefined) { // F1.841 — Unattended refuses an ask rule (helper at the file end)
          effectiveDecision = {
            outcome: 'deny',
            reason: piReadableAskDontAskRefusal(readableDecision, decision, guardianMode.permissionMode, toolName) ?? permissionDslDenyReason(readableDecision),
            ...(decision.additionalContext ? { additionalContext: decision.additionalContext } : {}),
          };
        } else if (readableDecision.action === 'ask' && (decision.outcome === 'allow' || decision.outcome === 'ask')) { // F1.902: over a gate allow AND over a mode prompt
          const namedRule = describePermissionDslMatch(readableDecision.match);
          // D1.256 — SAY ON THE CARD that the judge already cleared this. D1.156
          // put the provenance on the RECEIPT and left the user's half as a
          // product posture; the row decides it. This arm is the ONE site where
          // a card is raised after a `no_objection`, so without the marker a
          // judge that was never consulted and a judge that looked and had no
          // objection read identically. Shape and channel are
          // {@link PiAgent.markJudgeFailure}'s twin — one `i18n.t` marker
          // appended with ` — `, and the PAIR is the point: a marker on one
          // outcome and silence on the other teaches that an unmarked card
          // means the judge passed. Guarded on `guardianProvenance.value`,
          // written at exactly one site ({@link PiAgent.buildGuardianProvenance},
          // on `outcome.kind === 'allow'`), rather than on the SHAPE of
          // `decision.additionalContext`, which is the newline-join of a hook's
          // note and the provenance. `setupI18n` is guarded here for the reason
          // `base-agent.ts:tokenCapReachedNotice` guards it — `i18n.t` answers
          // `undefined` in a process nothing initialised, and this string is
          // read by a human.
          const judgeCleared = guardianProvenance.value !== undefined;
          if (judgeCleared && !i18n.isInitialized) setupI18n();
          const cardedRule = namedRule.length === 0
            ? `${toolName} requires approval by readable permission policy.`
            : `${toolName} requires approval by readable permission policy ${namedRule}.`;
          effectiveDecision = decision.outcome === 'ask' ? piReadableAskOverModePrompt(decision, checkResult, cardedRule) : {
            outcome: 'ask',
            reason: permissionDslAskReason(readableDecision),
            ...(decision.additionalContext ? { additionalContext: decision.additionalContext } : {}),
            request: { ...piReadableAskCardCommand(toolName, input), // F1.902 — the command the card asks about (helpers at the file end)
              toolName,
              type: 'permission_dsl', noAlwaysAllow: true, // F1.913 — an ask-rule card offers no Always Allow (see piReadableAskOverModePrompt)
              description: judgeCleared
                ? `${cardedRule} — ${i18n.t('settings.ai.guardian.judgeClearedMarker')}`
                : cardedRule,
            },
          };
        } else if (readableDecision.action === 'allow' && decision.outcome === 'ask'
          && !promptIsNonNegotiable(checkResult)
          // `autoMode.classifyAllShell` suspends "every Bash and PowerShell
          // allow rule while auto mode is active" (`auto-mode-config.md:226`),
          // and the readable DSL is where `Bash(npm test)` — the doc's own
          // example — actually lives. This is the ONE site left where an allow
          // RULE can still clear a prompt, so without this clause the key would
          // suspend the `permissions.json` allow paths and leave the documented
          // one standing whenever the judge could not answer.
          && !(checkResult.type === 'prompt' && checkResult.shellAllowRulesSuspended)) {
          // An allow RULE cannot clear a non-negotiable prompt. This is already
          // the documented contract for the two older classes — mcp.md on
          // `requiresUserInteraction`: "an allow rule does not skip it" — and it
          // is the whole point of the third: worktrees.md, "An `EnterWorktree`
          // permission rule or choosing 'don't ask again' doesn't suppress this
          // prompt; only `bypassPermissions` mode skips it." Which floors
          // `bypassPermissions` skips is decided upstream by the gate — it
          // drops the worktree floor in `allow-all` and keeps the other three
          // (ask rules, `requiresUserInteraction`, and the removal circuit
          // breaker) — so by the time a rule is evaluated the prompt stands.
          effectiveDecision = {
            outcome: 'allow',
            canonicalInput,
            ...(decision.additionalContext ? { additionalContext: decision.additionalContext } : {}),
          };
        }
        // P6.863 — mark the prompts the MODE alone raised, which is the one
        // question `permission-modes.md#switch-permission-modes`' carve-out
        // turns on: it excludes prompts "forced by one of your `ask` rules or by
        // a hook", "because auto mode still shows you those prompts, so
        // switching wouldn't remove them".
        //
        // Set HERE, after the readable-DSL merge, rather than at the `ask` site
        // below, because BOTH arms of `promptIsNonNegotiable` are needed and
        // only this scope has the second: an ask match from the readable
        // permission DSL is carried separately as `dslEvaluation`, and an ask
        // decision that meets one arrives looking exactly like an ordinary mode
        // prompt. The DSL's own substituted prompt is excluded twice over — by
        // this predicate and by its `permission_dsl` type.
        if (effectiveDecision.outcome === 'ask'
          && !promptIsNonNegotiable(checkResult, readableDecision)) {
          effectiveDecision = {
            ...effectiveDecision,
            request: { ...effectiveDecision.request, modePrompt: true },
          };
        }
        // R15 band: the gate — including the guardian consult and the
        // readable-DSL merge above — decided to show a permission dialog.
        // `PermissionRequest` fires exactly here ("when a permission dialog
        // is about to be shown", hooks.md#permissionrequest). A hook `allow`
        // replaces the human's click unless the prompt is non-negotiable
        // (ask rule, requiresUserInteraction, org-ask); a hook `deny` blocks
        // with its message; `interrupt: true` additionally aborts the turn.
        // hooks.md: the event never fires for EndConversation.
        let receiptObserver = onReceipt;
        let bandInterruptReason: string | undefined;
        // dontAsk hook-approve branch (R15 Task 4): Claude's dontAsk runs
        // "calls approved by a PreToolUse hook". A dontAsk denial of an
        // action that would have prompted interactively (marked by the gate;
        // never a deniedPaths/ask-rule/interaction-required denial) consults
        // the band once: a hook allow approves, anything else keeps today's
        // deny untouched. A readable-DSL deny stays terminal (floor).
        const dontAskConsult = effectiveDecision.outcome === 'deny'
          && checkResult.type === 'block'
          && checkResult.source === 'dont_ask_would_prompt'
          && readableDecision.action !== 'deny';
        const bandEligible = (effectiveDecision.outcome === 'ask' || dontAskConsult)
          && toolName !== 'EndConversation';
        // P3/R15: a PreToolUse hook's `permissionDecision: "allow"` "skips the
        // permission prompt, except for tools that require user interaction and
        // connector tools your organization set to `ask`", and "Deny and ask
        // rules are still evaluated regardless of what the hook returns"
        // (hooks.md#pretooluse). `promptIsNonNegotiable` IS that exception list,
        // and a deny rule never reaches here at all — so the allow closes at
        // this same site, replacing the human's click without touching the
        // floor. It runs BEFORE the band because no dialog is about to be shown
        // once the hook approved, and `PermissionRequest` fires only when one
        // is. In `dontAsk` this is the documented "calls approved by a
        // PreToolUse hook" carve-out the band below already implements for a
        // PermissionRequest allow.
        const preToolHookApproved = bandEligible
          && hookDecisionValue === 'allow'
          && !promptIsNonNegotiable(checkResult, readableDecision);
        if (preToolHookApproved) {
          effectiveDecision = {
            outcome: 'allow',
            canonicalInput,
            ...(decision.additionalContext ? { additionalContext: decision.additionalContext } : {}),
          };
          // A hook-approved allow never arms the guardian post-denial override —
          // that override is the HUMAN's approval record.
          receiptObserver = undefined;
        } else if (bandEligible) {
          const permissionSuggestions = this.buildPermissionRequestSuggestions(checkResult, toolName);
          const bandResult = await this.emitAutomationEvent('PermissionRequest', {
            hook_event_name: 'PermissionRequest',
            tool_name: toolName,
            tool_input: canonicalInput,
            permission_mode: this.permissionManager.getPermissionMode(),
            ...(permissionSuggestions ? { permission_suggestions: permissionSuggestions } : {}),
          });
          if (!ensureContinuation()) return;
          const bandDecision = bandResult?.decision;
          const bandValue = bandDecision?.decision;
          if (bandValue === 'deny' || bandValue === 'block') {
            // In dontAsk the mode already denies; "anything else denies with
            // today's message" — a hook deny neither changes nor decorates it.
            if (!dontAskConsult) {
              const reason = bandDecision?.reason ?? 'Denied by a PermissionRequest hook.';
              effectiveDecision = { outcome: 'deny', reason };
              if (bandDecision?.interrupt) bandInterruptReason = reason;
            }
          } else if (bandValue === 'allow'
            && !promptIsNonNegotiable(checkResult, readableDecision)) {
            if (bandDecision?.updatedInput) {
              // Documented: updatedInput replaces the WHOLE input and is
              // re-evaluated against deny and ask rules — the same re-gate the
              // human-approved path runs. A deny match blocks; an ask match
              // keeps the prompt; anything else approves the new input.
              const regate = runPreToolUseChecks({ ...checkArgs, input: bandDecision.updatedInput });
              const regatedInput = regate.type === 'modify'
                ? regate.input
                : regate.type === 'prompt' && regate.modifiedInput
                  ? regate.modifiedInput
                  : bandDecision.updatedInput;
              const readableRegate = evaluateReadablePolicy(regatedInput, bandDecision.updatedInput);
              // A dontAsk would-prompt denial of the NEW input is the very
              // thing the hook is approving (Task 4) — it does not demote the
              // allow; every other block (floors, deny rules) stays terminal.
              if (regate.type === 'block' && regate.source !== 'dont_ask_would_prompt') {
                effectiveDecision = { outcome: 'deny', reason: regate.reason };
              } else if (regate.type === 'source_activation_needed') {
                effectiveDecision = { outcome: 'deny', reason: `Source ${regate.sourceSlug} is not active` };
              } else if (readableRegate.action === 'deny') {
                effectiveDecision = {
                  outcome: 'deny',
                  reason: permissionDslDenyReason(readableRegate),
                };
              } else if (regate.type === 'prompt' || readableRegate.action === 'ask') {
                // Ask on the new input wins: the prompt stays as the gate
                // decided it (band allow does not cross an ask match).
              } else {
                effectiveDecision = {
                  outcome: 'allow',
                  canonicalInput: regatedInput,
                  ...(decision.additionalContext ? { additionalContext: decision.additionalContext } : {}),
                };
                // A hook-approved allow never arms the guardian post-denial
                // override — that override is the HUMAN's approval record,
                // and the guardian only ever narrows.
                receiptObserver = undefined;
                // updatedPermissions applies only when the hook's allow
                // actually took effect (allow-only per hooks.md; a re-gate
                // demotion means the allow did not stand).
                this.applyPermissionRequestUpdates(
                  bandDecision?.updatedPermissions,
                  toolName,
                  this.buildPermissionRequestSuggestions(checkResult, toolName), input,
                );
              }
            } else {
              effectiveDecision = {
                outcome: 'allow',
                canonicalInput,
                ...(decision.additionalContext ? { additionalContext: decision.additionalContext } : {}),
              };
              receiptObserver = undefined;
              this.applyPermissionRequestUpdates(
                bandDecision?.updatedPermissions,
                toolName,
                this.buildPermissionRequestSuggestions(checkResult, toolName), input,
              );
            }
          }
        }
        const receipt = await permissionService.authorize({
          subject: {
            sessionKey,
            provider: 'pi',
            surfaceVersion: manifestOwner.manifest.surfaceVersion,
            piName: manifestTool.binding.piName,
            bindingName: manifestTool.binding.bindingName,
            semanticId: manifestTool.descriptor.id,
            descriptorId: manifestTool.binding.descriptorId,
            manifestGeneration: manifestOwner.generation,
            manifestHash: manifestOwner.manifestHash,
            manifestProvenance: toolIdentity.manifestProvenance ?? [],
            responseEpoch: manifestResponseEpoch!,
            contextProfile: this.config.contextProfile ?? 'bare',
            sandboxRequirement: manifestTool.descriptor.sandboxProfile,
          },
          canonicalInput,
          decision: effectiveDecision,
          canonicalizeApprovedInput: approvedInput => {
            const recheck = runPreToolUseChecks({ ...checkArgs, input: approvedInput });
            if (recheck.type === 'block') throw new Error(recheck.reason);
            if (recheck.type === 'source_activation_needed') {
              throw new Error(`Source ${recheck.sourceSlug} is not active`);
            }
            const canonicalApprovedInput = recheck.type === 'modify'
              ? recheck.input
              : recheck.type === 'prompt' && recheck.modifiedInput
                ? recheck.modifiedInput
                : approvedInput;
            const readableRecheck = evaluateReadablePolicy(canonicalApprovedInput, approvedInput);
            if (readableRecheck.action === 'deny' || readableRecheck.action === 'ask') {
              // P2.445, the fourth site. This one covers deny AND ask together,
              // so it keeps its own sentence rather than borrowing either
              // builder's, and names the rule the same way they do.
              const namedRecheck = describePermissionDslMatch(readableRecheck.match);
              throw new Error(readableRecheck.diagnostic?.message
                ?? (namedRecheck.length === 0
                  ? 'Approved input does not satisfy readable permission policy.'
                  : `Approved input does not satisfy readable permission policy ${namedRecheck}.`));
            }
            return canonicalApprovedInput;
          },
        });
        if (!ensureContinuation()) return;
        // PermissionDenied `{retry: true}` (hooks.md#permissiondenied) re-runs the
        // permission decision. It fires BEFORE the reply — otherwise the deny is
        // already on the wire and no retry is possible — and at most
        // MAX_PERMISSION_DENIED_RETRIES times per tool call: an unbounded retry is
        // a prompt loop, and every retry re-dispatches through this same function,
        // so this counter is the ONLY thing that terminates it. The re-run goes
        // through the full gate, so a floor or deny rule that blocked the first
        // attempt blocks the retry too; only state a hook changed out of band (an
        // activated source, a session rule it added) can flip the outcome.
        if (receipt.outcome === 'deny'
          && permissionDeniedRetries < MAX_PERMISSION_DENIED_RETRIES
          && permissionDeniedEligible()) {
          const deniedResult = await this.emitAutomationEvent('PermissionDenied', {
            hook_event_name: 'PermissionDenied',
            tool_name: toolName,
            tool_input: canonicalInput,
            permission_mode: this.permissionManager.getPermissionMode(),
            ...(receipt.reason ? { error: receipt.reason } : {}),
          });
          if (!ensureContinuation()) return;
          if (deniedResult?.decision?.decision) {
            this.debug('PermissionDenied hook output carried a decision; ignored — the event cannot un-deny, only retry.');
          }
          if (deniedResult?.decision?.retry === true) {
            permissionDeniedRetries += 1;
            this.debug(`__HOOK_RETRY__${JSON.stringify({
              event: 'PermissionDenied', toolName, attempt: permissionDeniedRetries,
            })}`);
            const retryCheck = runPreToolUseChecks({ ...checkArgs, input: canonicalInput });
            if (retryCheck.type === 'allow') {
              await authorizeAndSend({ outcome: 'allow' }, canonicalInput);
              return;
            }
            if (retryCheck.type === 'modify') {
              await authorizeAndSend({ outcome: 'allow', canonicalInput: retryCheck.input }, retryCheck.input);
              return;
            }
            if (retryCheck.type === 'block') {
              // Re-dispatch the fresh deny rather than replaying the stale one, so
              // the retry's own reason is what the model is told. The retry counter
              // is what stops this from recursing.
              await authorizeAndSend({ outcome: 'deny', reason: retryCheck.reason }, canonicalInput);
              return;
            }
            // A prompt (or any other outcome) is not something the retry can
            // resolve here — deliver the original deny.
          }
        }
        receiptObserver?.(receipt.outcome);
        this.recordAuthorizedSandboxDowngrade(toolName, toolCallId, receipt);
        const modified = receipt.outcome === 'allow'
          && JSON.stringify(receipt.canonicalInput) !== JSON.stringify(input);
        const responded = sendDecision({
          type: 'pre_tool_use_response',
          requestId,
          action: receipt.outcome === 'deny' ? 'block' : modified ? 'modify' : 'allow',
          receipt,
          ...(modified ? { input: receipt.canonicalInput } : {}),
          ...(receipt.reason ? { reason: receipt.reason } : {}),
          ...(receipt.additionalContext ? { additionalContext: receipt.additionalContext } : {}),
        });
        // PermissionRequest deny with `interrupt: true` additionally aborts
        // the turn — the subprocess gets its pending reply first, then the
        // turn stops through the existing hard-abort path (same order as the
        // hook deny loop-guard above).
        if (responded && bandInterruptReason !== undefined && receipt.outcome === 'deny') {
          const message = `A PermissionRequest hook interrupted the turn: ${bandInterruptReason}`;
          this.eventQueue.enqueue({ type: 'error', message });
          this.forceAbort(AbortReason.PermissionHookInterrupt);
        }
        // PermissionDenied side event (R15 Task 5): fired for auto-mode denials
        // — a guardian deny or a dontAsk denial of a would-prompt action — never
        // for floors or ordinary gate blocks. Its output can never un-deny; the
        // ONE documented lever is `{retry: true}`, handled before the reply.
        if (responded && receipt.outcome === 'deny' && permissionDeniedEligible()
          && permissionDeniedRetries > 0) {
          // The retry already ran and still denied: report the event's outcome
          // without offering a second retry (that is the prompt loop).
          this.debug(`__HOOK_RETRY__${JSON.stringify({ event: 'PermissionDenied', toolName, retried: true, allowed: false })}`);
        }
      } catch (error) {
        if (!ensureContinuation()) return;
        sendDecision({
          type: 'pre_tool_use_response',
          requestId,
          action: 'block',
          reason: PiAgent.describeThrown(error),
        });
      }
    };

    // Merge any hook-supplied context with the guardian provenance marker on an
    // allow. Both are optional strings; keep both when present (newline-joined)
    // so the guardian marker never clobbers a hook's model-facing note.
    const allowAdditionalContext = [hookAdditionalContext, guardianProvenance.value]
      .filter((value): value is string => Boolean(value))
      .join('\n') || undefined;

    switch (checkResult.type) {
      case 'allow':
        await authorizeAndSend({ outcome: 'allow', additionalContext: allowAdditionalContext }, input);
        return;

      case 'modify':
        await authorizeAndSend({
          outcome: 'allow',
          canonicalInput: checkResult.input,
          additionalContext: allowAdditionalContext,
        }, checkResult.input);
        return;

      case 'block': {
        const diagnostics = getPermissionModeDiagnostics(sessionKey);
        this.debug(`__PERMISSION_BLOCK__${JSON.stringify({
          sessionId,
          toolName,
          effectiveMode: diagnostics.permissionMode,
          modeVersion: diagnostics.modeVersion,
          changedBy: diagnostics.lastChangedBy,
          changedAt: diagnostics.lastChangedAt,
          reason: checkResult.reason,
        })}`);
        await authorizeAndSend({
          outcome: 'deny',
          reason: checkResult.reason,
          additionalContext: hookAdditionalContext,
        }, input);
        return;
      }

      case 'source_activation_needed': {
        const { sourceSlug, sourceExists } = checkResult;
        if (req.sourceActivationRerun || !this.onSourceActivationRequest) {
          // UA12.74 — a source still inactive after this call's ONE activation
          // attempt, or one nothing can activate, blocks (upstream v0.14.0
          // pi-agent.ts, Apache-2.0: "a still-inactive source blocks"). Both used
          // to fall through the re-run below to an allow.
          const reason = req.sourceActivationRerun
            ? `Source "${sourceSlug}" is still not active.`
            : sourceExists
              ? `Source "${sourceSlug}" is not active. Activate it by @mentioning it in your message or via the source icon at the bottom of the input field.`
              : `Source "${sourceSlug}" is not available yet. It needs to be created and configured first.`;
          await authorizeAndSend({ outcome: 'deny', reason }, input);
          return;
        }
        this.debug(`PreToolUse(sessionId=${sessionId}): Source "${sourceSlug}" not active, attempting activation...`);

        if (this.onSourceActivationRequest) {
          try {
            const activated = await this.onSourceActivationRequest(sourceSlug);
            if (!ensureContinuation()) return;
            if (!activated) {
              const reason = sourceExists
                ? `Source "${sourceSlug}" is not active. Activate it by @mentioning it in your message or via the source icon at the bottom of the input field.`
                : `Source "${sourceSlug}" is not available yet. It needs to be created and configured first.`;
              await authorizeAndSend({ outcome: 'deny', reason }, input);
              return;
            }
            this.debug(`PreToolUse(sessionId=${sessionId}): Source "${sourceSlug}" activated successfully`);
            this.eventQueue.enqueue({
              type: 'source_activated' as const,
              sourceSlug,
              originalMessage: this.getCurrentTurnUserMessage() ?? '',
            });
          } catch (err) {
            if (!ensureContinuation()) return;
            const reason = sourceExists
              // P2.332 sweep — this one builds a user-visible deny reason inside a
              // catch; an unrenderable `err` would throw out of the catch instead.
              ? `Source "${sourceSlug}" could not be activated: ${PiAgent.describeThrown(err)}`
              : `Source "${sourceSlug}" is not available yet. It needs to be created and configured first.`;
            await authorizeAndSend({ outcome: 'deny', reason }, input);
            return;
          }
        }

        // UA12.74 — re-run the WHOLE pipeline after activation, so its result is
        // handled like any other (upstream v0.14.0 pi-agent.ts, Apache-2.0: "run
        // the whole pipeline again so the result (including an Ask-mode prompt) is
        // handled like any other"). The re-run used to be a bare gate call mapped
        // modify→allow, block→deny and EVERYTHING ELSE→allow: a default-mode
        // `prompt` (an MCP mutation's card), a second `source_activation_needed`
        // and every guardian band became a silent allow (only the readable DSL,
        // inside authorizeAndSend, still read it; the guardian and the band never
        // saw the re-run). Re-entering this handler re-runs all of them with the fresh
        // active slugs (the gate arguments are rebuilt per call), re-applies the
        // hook decision of THIS call without firing PreToolUse a second time
        // (`sourceActivationRerun.automationResult`), and the flag bounds it to
        // one activation attempt per call (the guard above). Residue, stated:
        // one-shot model context consumed above (edit feedback, path-scoped
        // rules) does not ride the re-run — as before, this path never sent it.
        // Claude denies and resumes next turn (claude-agent.ts, its own arm);
        // codex sources arrive through the bridge, not this path. A re-entry,
        // never a loop: only this line sets the flag, and the guard refuses a
        // second attempt.
        await this.handlePreToolUseRequest({ ...req, sourceActivationRerun: { automationResult } });
        return;
      }

      // F1.548: `spawn_session_intercept` shared this arm until its variant went.
      case 'call_llm_intercept':
        await authorizeAndSend({ outcome: 'allow' }, input);
        return;

      case 'prompt': {
        const promptedInput = checkResult.modifiedInput ?? input;
        // Post-denial human override (plan G2/G3, Codex "human wins" precedence):
        // if the guardian is active and previously DENIED this exact executed
        // (action, cwd) this session, and the user now APPROVES the prompt, mark
        // it so the guardian never re-consults that action for the rest of the
        // session — a later identical action skips the judge and follows the
        // pre-guardian flow. Bind to the EXECUTED input (post-hook) via the same
        // action builder + cwd the consult used, so the override key matches the
        // judged key exactly. Ineligible whenever the guardian is off/unwired.
        const overrideCwd = this.config.session?.workingDirectory ?? rootPath;
        let armOverride: ((outcome: 'allow' | 'deny') => void) | undefined;
        if (guardian) {
          const deniedAction = this.buildGuardianAction(toolName, promptedInput, overrideCwd);
          if (guardian.wasDenied(deniedAction, overrideCwd)) {
            armOverride = (outcome) => {
              if (outcome === 'allow') guardian.recordPostDenialOverride(deniedAction, overrideCwd);
            };
          }
        }
        await authorizeAndSend({
          outcome: 'ask',
          reason: checkResult.reason,
          additionalContext: hookAdditionalContext,
          request: {
            toolName,
            type: checkResult.promptType,
            description: checkResult.description,
            command: checkResult.command,
            appName: checkResult.appName,
            impact: checkResult.impact,
            requiresSystemPrompt: checkResult.requiresSystemPrompt,
            rememberForMinutes: checkResult.rememberForMinutes,
            commandHash: checkResult.commandHash,
            approvalTtlSeconds: checkResult.approvalTtlSeconds, ...(checkResult.noAlwaysAllow ? { noAlwaysAllow: true as const } : {}), // F1.737 — a floor the gate marks unrememberable offers no Always Allow
            // P6.202 clause (3) — the card payload, forwarded verbatim and only
            // when the gate produced one, so every other prompt class stays
            // byte-identical on the wire.
            ...(checkResult.outsideWorkingDirectoryRead
              ? { outsideWorkingDirectoryRead: checkResult.outsideWorkingDirectoryRead }
              : {}),
          },
        }, promptedInput, armOverride);
        return;
      }
    }
  }

  /**
   * Deferred-call resume gate (R7 Task 5). Called with the persisted record
   * when a session resumes: if the deferred tool no longer exists in the
   * active manifest, the run exits `tool_deferred_unavailable` with
   * `is_error: true` and the `deferred_tool_use` payload; otherwise the
   * resumed turn re-drives the pending call and PreToolUse re-fires
   * naturally, with an allow's answer delivered as `updatedInput`.
   */
  private resolveDeferredResume(record: PiDeferredToolCallV1): 'available' | 'unavailable' {
    const manifest = this.activeExecutionManifest;
    const available = !!manifest?.tools.some(tool => tool.binding.permissionName === record.toolName
      || tool.binding.piName === record.toolName);
    if (available) return 'available';
    this.debug(`Deferred tool ${record.toolName} (${record.toolUseId}) is no longer available; exiting tool_deferred_unavailable.`);
    this.eventQueue.enqueue({
      type: 'complete',
      terminalReason: 'tool_deferred_unavailable',
      terminalIsError: true,
      deferredToolUse: deferredToolUsePayload(record),
    });
    this.forceAbort(AbortReason.ToolDeferredUnavailable);
    return 'unavailable';
  }

  private handleAskUserRequest(req: {
    requestId: string;
    question: string;
    options: string[];
    allowFreeText: boolean;
    timeoutMs?: number;
    questions?: AskUserQuestionItem[];
  }): void {
    const sourceChild = this.subprocess;
    const sourceAttempt = this.subprocessAttempt;
    const responseEpoch = this.subprocessResponseEpoch;
    const sendResponse = (response: Record<string, unknown>) => {
      if (!sourceChild || this.subprocess !== sourceChild) return;
      if (responseEpoch !== this.subprocessResponseEpoch) return;
      if (sourceAttempt && !this.isCurrentSubprocessAttempt(sourceAttempt)) return;
      this.send(response);
    };
    const askUser: AskUserPermissionRequest = {
      question: String(req.question || '').trim(),
      options: Array.isArray(req.options) ? req.options.map(option => String(option)) : [],
      allowFreeText: Boolean(req.allowFreeText),
      timeoutMs: typeof req.timeoutMs === 'number' ? req.timeoutMs : undefined,
      ...(Array.isArray(req.questions) ? { questions: structuredClone(req.questions) } : {}),
    };

    this.requestAskUserPermission(askUser, req.requestId).then((answer) => {
      sendResponse({
        type: 'ask_user_response',
        requestId: req.requestId,
        answer,
      });
    }).catch((error) => {
      sendResponse({
        type: 'ask_user_response',
        requestId: req.requestId,
        error: PiAgent.describeThrown(error),
      });
    });
  }

  private async requestAskUserPermission(
    askUser: AskUserPermissionRequest,
    sourceRequestId: string,
    signal?: AbortSignal,
    options?: { minOptions?: number },
  ): Promise<AskUserAnswer> {
    const sessionId = this.config.session?.id || this._sessionId;

    // 2 is the `ask_user` TOOL's documented floor; the elicitation path lowers
    // it to 1 for the one dialog that is an acknowledgement rather than a
    // question. See the caller in {@link askUserForElicitation}.
    const minOptions = options?.minOptions ?? 2;
    if (askUser.questions) {
      // Batched superset (R7): the documented 1-4 x 2-4 bounds + 12-char header.
      validateAskUserQuestions(askUser.questions);
    } else if (!askUser.question || askUser.options.length < minOptions || askUser.options.length > 4) {
      throw new Error(`ask_user requires a question and ${minOptions} to 4 options.`);
    }

    // askUserQuestionTimeout (settings.md): USER settings only — the host is
    // the single authority for the auto-continue clock, overriding anything a
    // subprocess supplied. Default "never" leaves timeoutMs unset and nothing
    // ever expires. Expiry itself is an auto-continue in AskUserService and
    // the renderer countdown, never a tool error.
    askUser.timeoutMs = getAskUserQuestionTimeoutMs();

    // `ask_user` reaches the user through the permission-request channel, not
    // through runPreToolUseChecks, so the gate's interaction rule cannot see it.
    // `dontAsk` never prompts, so the request is refused here instead of hanging
    // on a human who is not there.
    if (this.permissionManager.getPermissionMode() === 'dontAsk') {
      throw new Error(`ask_user is unavailable in ${PERMISSION_MODE_AGENT_LABELS.dontAsk} mode, which never prompts.`);
    }

    if (!this.onPermissionRequest) {
      throw new Error('ask_user is unavailable without an interactive permission handler.');
    }

    const hostPort = this.config.askUserPort;
    if (hostPort) {
      const sessionKey = { workspaceId: this.config.workspace.id, sessionId };
      this.hostAskUserRequestIds.add(sourceRequestId);
      this.emitNotificationHook('permission_prompt', 'Response requested', askUser.question);
      try {
        return await hostPort.request({
          sessionKey,
          requestId: sourceRequestId,
          askUser,
          signal,
          headless: this.config.isHeadless === true,
          // The host validates independently, so the floor above bounds only the
          // local fallback below. A session ALWAYS has this port in the running
          // app, which makes this the live path: the caller's allowance has to
          // travel or the one-option acknowledgement throws at `validateAskUser`
          // before any card is published. Only an EXPLICIT allowance is
          // forwarded — the `ask_user` tool sends nothing and the host's own 2
          // governs it.
          ...(options?.minOptions === undefined ? {} : { minOptions: options.minOptions }),
          publish: (requestId, request) => this.onPermissionRequest?.({ requestId, toolName: 'ask_user', command: request.question, description: request.question, type: 'ask_user', askUser: request }),
        });
      } finally {
        this.hostAskUserRequestIds.delete(sourceRequestId);
      }
    }

    const permRequestId = `pi-ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.debug(`ask_user request: ${sourceRequestId} -> ${permRequestId} (sessionId=${sessionId})`);

    const responsePromise = new Promise<{ answer?: AskUserAnswer; error?: string }>((resolve) => {
      this.pendingPermissions.set(permRequestId, {
        kind: 'ask_user',
        resolve,
        toolName: 'ask_user',
        askUser,
        subprocessRequestId: sourceRequestId,
      });
    });

    const abortPending = () => {
      const pending = this.pendingPermissions.get(permRequestId);
      if (!pending) return;
      this.pendingPermissions.delete(permRequestId);
      this.cancelPendingPermission(permRequestId, pending, 'aborted');
    };

    if (signal?.aborted) {
      abortPending();
      throw new Error('ask_user was aborted.');
    }

    signal?.addEventListener('abort', abortPending, { once: true });

    this.emitNotificationHook('permission_prompt', 'Response requested', askUser.question);

    this.onPermissionRequest({
      requestId: permRequestId,
      toolName: 'ask_user',
      command: askUser.question,
      description: askUser.question,
      type: 'ask_user',
      askUser,
    });

    try {
      const response = await responsePromise;
      this.pendingPermissions.delete(permRequestId);
      if (response.error) {
        throw new Error(response.error);
      }
      if (!response.answer) {
        throw new Error('No answer was provided.');
      }
      return response.answer;
    } finally {
      signal?.removeEventListener('abort', abortPending);
    }
  }

  /**
   * Run one elicitation dialog with the subprocess told it is on screen.
   *
   * `mcp.md:261`: "A call waiting on an open elicitation dialog isn't
   * backgrounded while the dialog is open; the server is blocked on your input,
   * not slow." The auto-background clock lives in the subprocess and the dialog
   * lives here, so the open/close edges have to cross the wire. The id makes a
   * lost close harmless to the *next* dialog: each one clears only its own key.
   */
  protected override async withElicitationDialogOpen<T>(run: () => Promise<T>): Promise<T> {
    const dialogId = `elicit-dialog-${++this.elicitationDialogSeq}`;
    this.send({ type: 'mcp_elicitation_state', dialogId, open: true });
    try {
      return await run();
    } finally {
      this.send({ type: 'mcp_elicitation_state', dialogId, open: false });
    }
  }

  /** Pi's ask surface: the same permission channel `ask_user` rides. */
  /**
   * `minOptions: 1` mirrors {@link ElicitationAskUserBridge.ask}, which the two
   * other runtimes use, and it is load-bearing rather than a loosening.
   *
   * `declineVisibly` (`mcp/elicitation.ts:224`) is the whole of the "tell the
   * user why, then decline it, never silently" rule, and it is a single `OK`
   * acknowledgement — one option. Held to the `ask_user` TOOL's 2-4 bound it
   * THREW, the throw degraded to a `cancel`, and the refusal the rule exists to
   * make visible was the one thing the user never saw. Pi was the only runtime
   * where elicitation worked at all, so this was the live path.
   */
  protected override async askUserForElicitation(
    askUser: AskUserPermissionRequest,
    signal?: AbortSignal,
  ): Promise<AskUserAnswer> {
    return this.requestAskUserPermission(askUser, 'mcp-elicitation', signal, { minOptions: 1 });
  }

  /**
   * P2.61 — the entry `handleAskUserCancel` has already removed from
   * `pendingPermissions` and is in the middle of settling.
   *
   * Set immediately before the settle call and cleared immediately after it
   * returns, so it is populated ONLY while a throw from that call could strand
   * the entry. {@link cancelStrandedAskUserPermission} consumes it, which is
   * what makes it one-shot in both directions: the belt takes it, and a
   * successful cancel never leaves it set.
   */
  private askUserCancelInFlight?: {
    requestId: string;
    pending: Extract<PendingPermission, { kind: 'ask_user' }>;
    reason: string;
  };

  private cancelPendingPermission(requestId: string, pending: PendingPermission, error = 'aborted'): void {
    if (pending.kind === 'ask_user') {
      this.eventQueue.enqueue({ type: 'permission_request_cancelled', requestId });
      pending.resolve({ error });
      return;
    }
    if (pending.kind === 'outside_root') {
      // Denial path: the suspended tool call fails with its outside-root error.
      this.send({ type: 'outside_root_response', requestId, root: null });
      return;
    }
    pending.resolve({ allowed: false });
  }

  private handleAskUserCancel(req: {
    requestId: string;
    reason?: string;
  }): void {
    if (this.hostAskUserRequestIds.has(req.requestId) && this.config.askUserPort) {
      const sessionKey = { workspaceId: this.config.workspace.id, sessionId: this.config.session?.id || this._sessionId };
      void this.config.askUserPort.cancel({ sessionKey, requestId: req.requestId }).catch(error => {
        this.debug(`Failed to cancel host ask_user ${req.requestId}: ${PiAgent.describeThrown(error)}`);
      });
      return;
    }
    for (const [requestId, pending] of this.pendingPermissions) {
      if (pending.kind === 'ask_user' && pending.subprocessRequestId === req.requestId) {
        const reason = typeof req.reason === 'string' ? req.reason : 'cancelled';
        this.pendingPermissions.delete(requestId);
        // P2.61 — the delete stays FIRST: a re-entrant cancel arriving while
        // this one settles must not find the entry and double-settle it. The
        // cost of that ordering is that a throw from `cancelPendingPermission`
        // itself lands after the delete, where the belt's map scan has nothing
        // left to find, so hand the belt the entry rather than make it re-scan
        // a map this handler has already emptied.
        //
        // Cleared on the way out, and only there: the field is a ONE-SHOT
        // handoff for the throw that just happened, never a record of the last
        // cancel — a successful pass must leave nothing behind for an unrelated
        // later fault to settle by mistake.
        this.askUserCancelInFlight = { requestId, pending, reason };
        this.cancelPendingPermission(requestId, pending, reason);
        this.askUserCancelInFlight = undefined;
        return;
      }
    }
    this.debug(`No pending ask_user permission for subprocess requestId: ${req.requestId}`);
  }

  /**
   * P2.41 — the LOCAL half of the teardown `handleAskUserCancel` owes when it
   * throws part-way. Read the branch table before trusting it with anything.
   *
   * `requestAskUserPermission` branches EXCLUSIVELY: with an `askUserPort` it
   * `return await hostPort.request(…)` and never touches `pendingPermissions`;
   * only the no-port fallback below that registers a `{kind:'ask_user'}` entry.
   * `handleAskUserCancel` branches the same way, and the one synchronous throw
   * source — `askUserPort.cancel` — lives on the HOST branch, where this sweep
   * has by construction nothing to find. The note on the host branch above says
   * a session ALWAYS has that port in the running app, which makes the no-op the
   * live case. This method was documented as leaving no "permission card on
   * screen holding a promise nobody will ever resolve"; that claim was void
   * exactly where it was needed, and it is withdrawn rather than repaired.
   *
   * KNOWN RESIDUAL, deliberately not fixed here: when `askUserPort.cancel`
   * throws (`createPiInteractionPorts` → `assertPiInteractionSessionKey` →
   * `pi-interaction-session-mismatch`), the card and the promise that strand
   * belong to the host `AskUserService`, outside `PiAgent` entirely. Nothing
   * reachable from this class settles them; that fix is host-side.
   *
   * What this DOES cover: the no-port fallback's own entry, if a future edit
   * grows a throw before `handleAskUserCancel`'s delete. Idempotent by
   * construction — the handler deletes before it cancels, so a successful pass
   * leaves nothing to find.
   *
   * P2.61 CLOSES what the paragraph above used to end with as a second
   * residual: a throw from `cancelPendingPermission` ITSELF lands after the
   * delete, and this sweep could not settle it because the map was already
   * empty (measured: chunk survived, entry gone, promise `unsettled` forever).
   * The handler now hands over the entry it removed, and that hand-off is read
   * FIRST — a map scan cannot answer a question about something no longer in
   * the map.
   *
   * Settled DIRECTLY rather than by re-running `cancelPendingPermission`: that
   * call already ran part-way and may have enqueued the
   * `permission_request_cancelled` event before it threw, so re-entering it
   * risks a duplicate cancellation on the wire. `resolve` is the tail it did
   * not reach, and a second `resolve` on an already-settled promise is a no-op.
   */
  private cancelStrandedAskUserPermission(req: { requestId: string; reason?: string }): void {
    const inFlight = this.askUserCancelInFlight;
    this.askUserCancelInFlight = undefined;
    if (inFlight && inFlight.pending.subprocessRequestId === req.requestId) {
      this.debug(
        `Stranded ask_user ${inFlight.requestId} was already removed from the pending map when its cancel threw; `
        + 'settling its answer promise directly',
      );
      inFlight.pending.resolve({ error: inFlight.reason });
      return;
    }
    for (const [requestId, pending] of this.pendingPermissions) {
      if (pending.kind !== 'ask_user' || pending.subprocessRequestId !== req.requestId) continue;
      this.pendingPermissions.delete(requestId);
      const reason = typeof req.reason === 'string' ? req.reason : 'cancelled';
      try {
        this.cancelPendingPermission(requestId, pending, reason);
      } catch (error) {
        // Last resort: the entry is already out of the map, so settle the answer
        // promise directly rather than let the awaiting `ask_user` hang. This
        // catch is also what keeps the belt itself from escaping `handleLine`.
        this.debug(`Stranded ask_user ${requestId} could not be cancelled cleanly: ${PiAgent.describeThrown(error)}`);
        pending.resolve({ error: reason });
      }
      return;
    }
  }

  /**
   * Handle a tool_execute_request from the subprocess.
   * Routes proxy tool calls (MCP, API, session) to the appropriate handler.
   *
   * The subprocess expects responses in the PiProxyToolResult format.
   *
   * P2.40 — and that response is not optional. This is a BLOCKING request:
   * `pi-agent-server` suspends the model's tool call on a promise keyed by
   * `requestId` and settles it only on a `tool_execute_response`. The stdout
   * chunk is safe here without help — an `async` handler turns even a
   * SYNCHRONOUS throw into a rejection instead of unwinding the readline
   * listener — so an escape does not cost what the belts above cost. It costs
   * the whole tool call. Nothing times that promise out: `pendingToolExecutions`
   * carries no timer.
   *
   * P2.96 corrects the settler list this paragraph used to give as three. There
   * are FOUR, plus one path that unblocks the model without settling anything,
   * and the difference is the difference between "hangs forever" and "hangs for
   * the rest of the turn":
   *   1. the turn's own abort signal (which sends `tool_execute_cancel`);
   *   2. the shutdown sweep;
   *   3. a `tool_execute_response` — the answer this handler owes;
   *   4. `pi-agent-server`'s background-task stop: the abort listener installed
   *      on a DETACHED MCP call rejects the pending with
   *      `mcp-background-task-stopped` (`pi-agent-server/src/index.ts`, the
   *      `controller.signal.addEventListener('abort', …)` beside that literal).
   * And the MCP AUTO-BACKGROUND DETACH (`mcpAutoBackgroundDelayMs`, a few lines
   * above it) hands the model a task id once a main-conversation call outruns
   * the threshold, so the model stops waiting long before any of the four fires.
   * Neither applies to a subagent session or a headless run without the opt-in,
   * and neither applies while an elicitation dialog is open.
   *
   * So an unanswered request hangs the tool call for the rest of the turn in the
   * WORST case, behind an unhandled rejection Electron logs without exiting and
   * a packaged build does not log at all.
   *
   * The prologue used to sit outside the only `try`, and it is not inert.
   * `checkPrerequisites` walks the invoked skill's deny list through
   * `matchesToolPattern`, resolves and `existsSync`-es a guide path for every
   * matching rule, and calls the HOST-supplied `onDebug` — real throw sources,
   * all of them ahead of the first `sendResponse`.
   *
   * Hence the outer `try`, and hence it lives in the HANDLER rather than as a
   * `.catch` on the dispatch: `sendResponse` closes over the child, the startup
   * attempt and the response epoch this request arrived on, and a late answer
   * still has to pass those three guards or it lands on a subprocess that has
   * already been replaced. A dispatch-site `.catch` cannot see any of them.
   *
   * The inner `try` keeps the meaning it already had — a failure of the ROUTED
   * call is the tool result, so only the outer catch surfaces a transcript row:
   * reaching it means a throw nobody had decided on, an error row per legit failure.
   */
  private async handleToolExecuteRequest(request: {
    requestId: string;
    toolName: string;
    piName?: string;
    manifestGeneration?: string;
    manifestHash?: string;
    toolCallId?: string;
    args: Record<string, unknown>;
  }): Promise<void> {
    const sourceChild = this.subprocess;
    const sourceAttempt = this.subprocessAttempt;
    const responseEpoch = this.subprocessResponseEpoch;
    const sendResponse = (response: Record<string, unknown>) => {
      if (!sourceChild || this.subprocess !== sourceChild) return;
      if (responseEpoch !== this.subprocessResponseEpoch) return;
      if (sourceAttempt && !this.isCurrentSubprocessAttempt(sourceAttempt)) return;
      this.send(response);
    };

    // The four lines above are the whole of what stays outside the belt: three
    // plain field reads (`subprocess`, `subprocessAttempt` and
    // `subprocessResponseEpoch` are fields, not getters) and a closure
    // DEFINITION, none of which can throw. They have to stay out, because the
    // catch below needs `sendResponse` in scope to answer with.
    try {
      // Prerequisite check: block source tools until guide.md is read
      const prereqResult = this.prerequisiteManager.checkPrerequisites(request.toolName, request.args);
      if (!prereqResult.allowed) {
        sendResponse({
          type: 'tool_execute_response',
          requestId: request.requestId,
          result: { content: prereqResult.blockReason!, isError: true },
        });
        return;
      }

      try {
        const manifest = this.activeExecutionManifest;
        if (!manifest || !request.piName || !request.manifestGeneration || !request.manifestHash) {
          throw new Error('Pi proxy route is missing active manifest identity');
        }
        assertPiExecutionManifestIdentity(manifest, {
          generation: request.manifestGeneration,
          manifestHash: request.manifestHash,
        });
        const manifestTool = manifest.tools.find(tool => tool.binding.piName === request.piName);
        if (!manifestTool || manifestTool.binding.bindingName !== request.toolName) {
          throw new Error(`Pi proxy route identity mismatch for ${request.piName}`);
        }
        const runtime = this.assertActiveManifestRuntime(manifest);
        const controller = new AbortController();
        this.pendingToolExecutions.set(request.requestId, controller);
        // UB3.9 (upstream v0.15.1 `routeToolCall(…, intent)`): the intent the
        // PreToolUse bridge captured for THIS call id rides to the pool, so a
        // large MCP-source result is summarised against the agent's stated
        // purpose. Read, never take: `tool_execution_end` owns the map entry's
        // deletion, and a request without a toolCallId — or one whose metadata
        // the bridge never saw — routes exactly as before.
        const bridgeMeta = request.toolCallId ? this.preToolMetadataByCallId.get(request.toolCallId) : undefined;
        const bridgeIntent = typeof bridgeMeta?.intent === 'string' && bridgeMeta.intent ? bridgeMeta.intent : undefined;
        const result = await this.routeToolCall(request.toolName, request.args, controller.signal, bridgeIntent);
        // UB2.10 — a call the subprocess DETACHED (R10) and nothing took back is no longer the turn's: its result rides a
        // task notification, so the turn's manifest and runtime ending under it (a Stop, the turn's end) is not staleness —
        // "stale" told the model a write that ran had failed (F1.930's false belief). A call taken back keeps both checks.
        // UB12.12 — the LEASE check holds for a detached call too: the host's task authority retains the turn's lease from
        // `task_backgrounded` to this call's `task_notification` (SessionManager `retainPiBackgroundChildAuthority`), so it
        // is held unless REVOKED and a revoke while no turn runs refuses the late result. Residue: no retain, no lease.
        const detachedLive = this.detachedToolExecutions.get(request.requestId) === controller;
        runtime.materializer.assertActive();
        // F1.930 (SIT-ag 1, measured 2/2): a handoff THIS call raised (SubmitPlan's onPlanSubmitted, the
        // auth tools' onAuthRequest — both interruptForHandoff) is its own manifest swap, not staleness.
        if (!detachedLive && !this.isOwnHandoffAbort()
          && (this.activeExecutionManifest?.manifestHash !== manifest.manifestHash
            || this.capabilityTurnRuntime !== runtime)) {
          throw new Error('Pi proxy route became stale during execution');
        }
        sendResponse({
          type: 'tool_execute_response',
          requestId: request.requestId,
          result,
        });
      } catch (error) {
        sendResponse({
          type: 'tool_execute_response',
          requestId: request.requestId,
          result: {
            // P2.65's renderer, for P2.65's reason: `String(x)` is not total,
            // and a thrown value it cannot render used to make THIS catch throw
            // — which, before the outer try existed, was one more way the
            // request went unanswered.
            content: PiAgent.describeThrown(error),
            isError: true,
          },
        });
      } finally {
        this.pendingToolExecutions.delete(request.requestId);
        this.detachedToolExecutions.delete(request.requestId); // UB2.10 — a settled detached call leaves its set too
      }
    } catch (error) {
      // The last chance the suspended tool call has, so the order here is
      // deliberate: the calls that CANNOT throw run first — `describeThrown` is
      // total, `surfaceSubprocessFault` is documented total, `debug` is belted
      // at its own site — and `sendResponse` goes last, because it reaches
      // `this.send` and a stdin write is renderable only by assumption. If that
      // one throws, the channel the answer would ride is the thing that broke,
      // and the fault has already been logged and surfaced.
      const detail = PiAgent.describeThrown(error);
      // Both labels arrive as subprocess JSON, so neither is interpolated raw:
      // `${value}` on a value with no callable `toString` throws, and this is
      // the catch that must not.
      const toolLabel = typeof request.toolName === 'string' ? request.toolName : '(non-string tool name)';
      const idLabel = typeof request.requestId === 'string' ? request.requestId : '(non-string request id)';
      this.debug(`Pi proxy tool ${toolLabel} (${idLabel}) could not be dispatched: ${PiAgent.describeThrown(error, true)}`);
      this.surfaceSubprocessFault(
        `tool_execute ${toolLabel}: ${detail}`,
        `A Pi proxy tool call (${toolLabel}) could not be dispatched: ${detail}`,
      );
      sendResponse({
        type: 'tool_execute_response',
        requestId: request.requestId,
        result: { content: `Pi proxy tool call failed: ${detail}`, isError: true },
      });
    }
  }

  /**
   * Mint a sandbox downgrade for one approved Bash call (sandboxing.md:135).
   *
   * "when a command fails because of sandbox restrictions, Claude analyzes the
   * failure and may retry the command with the `dangerouslyDisableSandbox`
   * parameter. The retried command runs outside the sandbox, so it goes through
   * the regular permission flow". This IS that flow's terminal step: the
   * decision has already been made by the gate above — including the documented
   * ask rule `Bash(dangerouslyDisableSandbox:true)`, which compiles to a
   * parameter matcher and forces a prompt — and the only thing left is to
   * record that it was authorized.
   *
   * Three conditions, all necessary:
   * - the tool is Bash and the APPROVED canonical input carries the flag, so a
   *   hook that rewrote the input away from the bypass cannot leave one behind;
   * - the outcome is `allow`, so a denied or prompted-and-refused call mints
   *   nothing;
   * - strict sandbox mode is off. `sandboxing.md:137`: with
   *   `allowUnsandboxedCommands: false` the parameter is "completely ignored
   *   and all commands must run sandboxed", so the producer drops it and the
   *   command runs sandboxed rather than failing.
   */
  private recordAuthorizedSandboxDowngrade(
    toolName: string,
    toolCallId: string | undefined,
    receipt: { outcome: string; decisionId: string; canonicalInput?: Record<string, unknown> },
  ): void {
    if (toolName !== 'Bash' || !toolCallId) return;
    if (receipt.outcome !== 'allow') return;
    if (receipt.canonicalInput?.dangerouslyDisableSandbox !== true) return;
    if (this.capabilityTurnRuntime?.strictSandboxMode) {
      // Deliberately does NOT promise the command runs sandboxed: strict mode
      // only refuses the per-command escape hatch. Whether isolation is applied
      // at all is the `sandbox.enabled` master switch's answer, and since
      // 2026-08-12 it ships off — so the old wording was false on a default
      // install, in a line an operator reads when diagnosing exactly this.
      this.debug(`dangerouslyDisableSandbox ignored for ${toolCallId}: strict sandbox mode refuses the per-command escape hatch (whether isolation applies at all is sandbox.enabled).`);
      return;
    }
    this.authorizedSandboxDowngrades.set(toolCallId, receipt.decisionId);
  }

  private async handleProcessStartRequest(message: {
    requestId: string;
    request: SupervisedProcessChildStartRequest;
  }): Promise<void> {
    const sourceChild = this.subprocess;
    const sourceAttempt = this.subprocessAttempt;
    const sourceEpoch = this.subprocessResponseEpoch;
    const reply = (result: Record<string, unknown>) => {
      if (!sourceChild || this.subprocess !== sourceChild) return;
      if (sourceEpoch !== this.subprocessResponseEpoch) return;
      if (sourceAttempt && !this.isCurrentSubprocessAttempt(sourceAttempt)) return;
      this.send({ type: 'process_start_response', requestId: message.requestId, ...result });
    };
    const port = this.config.processSupervisorPort;
    const sessionId = this.config.session?.id || this._sessionId;
    if (!port || !sessionId) {
      reply({ error: 'pi-process-supervisor-unavailable' });
      return;
    }
    const controller = new AbortController();
    this.pendingProcessStarts.set(message.requestId, controller);
    try {
      const request = message.request;
      if (!['read-only', 'workspace', 'networked', 'isolated-code'].includes(request.profile as ProcessIsolationProfile)) {
        throw new Error('invalid-process-isolation-profile');
      }
      const pluginBinding = this.resolveActivePluginSkillRuntimeForProcess(request.command, request.args);
      if (pluginBinding) {
        const capabilityRuntime = this.capabilityTurnRuntime;
        if (!capabilityRuntime) throw new Error('plugin-skill-process-runtime-not-active');
        await capabilityRuntime.materializer.verifyPlugin(pluginBinding.pluginInstanceId);
        capabilityRuntime.materializer.assertActive();
      }
      // The host's own answer to "may this ONE command leave isolation", keyed
      // by the execution id the child already carries. Consumed here so a
      // second start under the same id cannot reuse the approval.
      const downgradeDecision = this.authorizedSandboxDowngrades.get(request.executionId);
      if (downgradeDecision !== undefined) this.authorizedSandboxDowngrades.delete(request.executionId);
      // `plugins-reference.md` § File locations, `bin/`: "Executables added to
      // the Bash tool PATH. Files here are invokable as bare commands in any
      // Bash tool call while the plugin is enabled." Composed here rather than
      // in `pluginRuntimeEnv*` because that contract is per-BUNDLE and a PATH is
      // one value shared by every enabled bundle; two bundles returning their
      // own `PATH` key would collide. Composed for every child start, not only a
      // plugin-owned one, because "any Bash tool call" is the documented scope.
      //
      // The supervisor merges `env` OVER the selected host environment, so the
      // whole value is rebuilt from the host PATH with the bin/ directories
      // APPENDED — a plugin must never shadow a system binary of the same name.
      const childStartPath = piChildStartPath( // F1.727 · + the vendored rg directory before the bin/ ones — see its docblock
        process.env.PATH, getBackendRuntime(this.config).paths?.ripgrep,
        enabledPluginBundleRoots(this.capabilityTurnRuntime?.view),
      );
      // hooks.md `:707` — "The level is also available to hook commands and the
      // Bash tool as the `$CLAUDE_EFFORT` environment variable." This is the
      // host's allowlist rebuild for every child-requested start, so it is the
      // one seam that reaches the Bash tool and its siblings.
      //
      // Read PER START, never cached: `setThinkingLevel` can change the level
      // mid-session while the subprocess lives on, and an invoked skill
      // overrides it for exactly one turn (`applySkillInvocationEffort`). The
      // init-message `thinkingLevel` is therefore not a usable source here.
      // `undefined` means there is no level to report and BOTH keys stay unset.
      const effortLevel = activeEffortLevelForModel(this._thinkingLevel, this._model);
      const workspaceRoot = this.config.filesystemScope?.primaryRoot ?? this.config.workspace.workspaceRootPath;
      // `env-vars.md#variables` — "`BASH_MAX_TIMEOUT_MS` | Maximum timeout the
      // model can set for long-running bash commands (default: 600000, or 10
      // minutes). The effective ceiling is the larger of this and
      // `BASH_DEFAULT_TIMEOUT_MS`". The supervisor's deadline is
      // `Date.now() + request.timeoutMs` with no `Math.min` anywhere in it, so
      // until this line the model's own number was the ONLY input and an
      // operator who set a maximum had bounded nothing.
      //
      // Applied on the HOST side of the allowlist rebuild, which is the seam a
      // subprocess cannot reach past — the same reason `env`, the writable roots
      // and the sandbox-bypass decision are composed here. `background` starts
      // are exempt and `persistent` ones are unreachable from a child request;
      // both are argued at `clampSupervisedChildTimeoutMs`.
      //
      // For `semanticId: 'bash'` this is not a kill: `resolveBashTimeoutBehavior`
      // gives that start `onTimeout: 'background'`, so a command over the ceiling
      // is MOVED TO A BACKGROUND TASK with its task id and output file and keeps
      // running — `tools-reference.md#background-commands`, "When a command
      // reaches its timeout without finishing, Claude Code moves it to the
      // background instead of stopping it."
      const childStartFields = clampSupervisedChildTimeoutMs(pickSupervisedChildStartFields(request));
      // R85 · hooks.md § SessionStart, "Persist environment variables": the
      // variables a hook wrote "will be available in all subsequent Bash
      // commands that Claude Code executes during the session". This is the
      // read-back, and it is a COMMAND rewrite rather than an `env` merge on
      // purpose — the page's own recipes (`export PATH="$PATH:./node_modules/.bin"`,
      // an `export -p` diff) need the shell to evaluate the line.
      //
      // Composed on the HOST side of `pickSupervisedChildStartFields`, which is
      // the allowlist that stops a child smuggling `env`: the file path comes
      // from the session key the host holds, never from the request, and rides
      // the same host-owned `env` rebuild the effort pair does. The helper
      // refuses everything that is not exactly the `/bin/sh -lc <cmd>` pair the
      // subprocess mints for `bash`/`bash_background`, so a plugin-MCP or LSP
      // start is left byte-identical.
      //
      // Recorded consequence: the durable execution record stores `[command, ...args].join(' ')`, so a rewritten
      // start's record carries the constant preamble. Left as-is deliberately — it is what actually ran, the preamble
      // is host-authored and grants no authority, and keeping the model's line instead would need a new field on the
      // persisted supervisor request.
      const hookEnvStart = resolveHookEnvFileShellStart(childStartFields, {
        workspaceId: this.config.workspace.id,
        sessionId,
        // The workspace root is what the model's own Bash commands may write.
        // A session whose workspace happened to contain the config directory
        // would otherwise get an env file the model itself could author.
        modelWritableRoots: [workspaceRoot],
      });
      // F1.916 · P6.535's `SESSION_JOB_DIR_ENV_VAR` for the SHELL: `buildPiSubprocessEnv` names it on the Pi subprocess,
      // whose env a supervised start never inherits, so a Pi `bash` call had none. Created before named, omitted when it
      // cannot be made (the `restricted` allowlist drops any inherited value). Not claude's name: `claudeJobDirInShell`.
      const sessionJobDir = ensureSessionJobDir(this.config.workspace.id, sessionId);
      const childEnvironment = {
        // C3.382 · the app's own proxy reaches this child, which is the ONE place it can: the supervisor merges this
        // `env` over a `restricted` host environment whose allowlist answers false for every proxy and CA name
        // (`process-supervisor.ts` `isRestrictedHostEnvironmentKey`), so a Pi `bash` call was reaching the internet
        // while the app was pointed at a proxy refusing everything. Spread FIRST, so nothing below can be silently
        // displaced by it; the two sets are disjoint today and the ordering says which way a future collision
        // resolves. `{}` when no proxy is configured — see `buildShellChildNetworkEnv`.
        ...buildShellChildNetworkEnv(),
        ...(pluginBinding
          ? pluginRuntimeEnvForProfile(pluginBinding.runtime.profile, {
            bundleRoot: pluginBinding.runtime.rootPath,
            dataPath: pluginBinding.runtime.dataPath,
            ...(pluginBinding.runtime.projectPath ? { projectPath: pluginBinding.runtime.projectPath } : {}),
          })
          : {}),
        ...(childStartPath === undefined ? {} : { PATH: childStartPath }),
        ...(effortLevel === undefined ? {} : { NESSY_EFFORT: effortLevel, CLAUDE_EFFORT: effortLevel }),
        ...(sessionJobDir === undefined ? {} : { [SESSION_JOB_DIR_ENV_VAR]: sessionJobDir }),
        ...(hookEnvStart?.env ?? {}),
      };
      const result = await port.start({
        // The shared allowlist rebuild: child-controllable fields only.
        ...childStartFields,
        ...(hookEnvStart ? { args: hookEnvStart.args } : {}),
        ...(downgradeDecision === undefined
          ? {}
          : { dangerouslyDisableSandbox: true, isolationDowngradeDecision: downgradeDecision }),
        sessionKey: { workspaceId: this.config.workspace.id, sessionId },
        // Host-owned root, never the subprocess value: a project session's
        // processes run inside the captured scope primary root (Q1.2).
        workspaceRoot,
        signal: controller.signal,
        ...(Object.keys(childEnvironment).length > 0 ? { env: childEnvironment } : {}),
        ...(pluginBinding ? { additionalWritableRoots: [pluginBinding.runtime.dataPath] } : {}),
      });
      reply({ result });
    } catch (error) {
      // P2.96 — `describeThrown`, not `String(error)`, for P2.40's reason one
      // frame later. `process_start_response` is the ONLY thing that settles the
      // subprocess's suspended request, and the detail is rendered as the
      // ARGUMENT to the send: a thrown value `String()` cannot render made this
      // catch throw before `reply` ran, so nothing was sent and the child's
      // process-start call waited out the turn. Measured on the belt rig: the
      // pre-fix rig recorded `sent === []`.
      reply({ error: PiAgent.describeThrown(error) });
    } finally {
      if (this.pendingProcessStarts.get(message.requestId) === controller) {
        this.pendingProcessStarts.delete(message.requestId);
      }
    }
  }

  private async handleChildSessionRequest(message: {
    requestId: string;
    request: PiChildSessionRequest;
  }): Promise<void> {
    const sourceChild = this.subprocess;
    const sourceAttempt = this.subprocessAttempt;
    const sourceEpoch = this.subprocessResponseEpoch;
    const reply = (result: { result?: PiChildSessionResponse; error?: string }) => {
      if (!sourceChild || this.subprocess !== sourceChild) return;
      if (sourceEpoch !== this.subprocessResponseEpoch) return;
      if (sourceAttempt && !this.isCurrentSubprocessAttempt(sourceAttempt)) return;
      this.send({ type: 'child_session_response', requestId: message.requestId, ...result });
    };
    const port = this.config.childSessionPort;
    if (!port) {
      reply({ error: 'pi-child-session-port-unavailable' });
      return;
    }
    try {
      const request = message.request;
      let result: PiChildSessionResponse;
      switch (request.operation) {
        case 'start': result = await port.start(request.input); break;
        case 'resume': result = await port.resume(request.agentId, request.input); break;
        case 'steer': result = await port.steer(request.agentId, request.message); break;
        case 'get_result': result = await port.getResult(request.agentId, { wait: request.wait, verbose: request.verbose }); break;
        case 'stop': result = await port.stop(request.agentId); break;
        case 'stop_task': result = await port.stopTask(request.taskId); break;
        case 'seal_owner_task': result = await port.sealOwnerTask(request.ownerTaskId); break;
        case 'search_output': result = await port.searchOutput(request.agentId, request.query); break;
        case 'attach': result = await port.attach(request.agentId, request.cursor); break;
        case 'monitor': result = await port.monitor(request.agentId); break;
      }
      reply({ result });
    } catch (error) {
      // P2.96 — the sibling of the catch above, same wire shape, same strand:
      // `child_session_response` is the only settler for this requestId.
      reply({ error: PiAgent.describeThrown(error) });
    }
  }

  /**
   * Route a proxy tool call to the appropriate handler based on tool name.
   *
   * - Session tools (SubmitPlan, config_validate, etc.) -> session-tools-core handlers
   * - call_llm -> preExecuteCallLlm (BaseAgent)
   * - mcp__* tools -> MCP server proxy (TODO)
   * - api_* tools -> API source proxy (TODO)
   *
   * Returns PiProxyToolResult matching subprocess protocol.
   */
  private async routeToolCall(
    toolName: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    intent?: string,
  ): Promise<PiProxyToolResult> {
    this.assertCapabilityTurnActive();
    // Session-scoped tools — strip mcp__session__ prefix added by the Pi SDK
    // registration (tools are registered as mcp__session__SubmitPlan, etc.)
    const strippedName = toolName.startsWith('mcp__session__')
      ? toolName.slice('mcp__session__'.length)
      : toolName;

    if (SESSION_TOOL_NAMES.has(strippedName)) {
      return this.executeSessionTool(strippedName, args);
    }

    if (toolName === 'lsp') {
      const port = this.config.lspPort;
      if (!port || port.health().status !== 'ready') {
        return { content: 'LSP is unavailable.', isError: true };
      }
      const result = await port.request(args as PiLspRequest, signal);
      return { content: JSON.stringify(result), isError: false };
    }

    // CI1 formatter dispatch: run the project's own configured formatter on the
    // target file via the server-injected runner (ProcessSupervisor `workspace`
    // spawn). The runner is present only for a trusted + enabled project; it is
    // fail-soft and NEVER installs a binary, so a missing formatter is a benign
    // note, not an error.
    if (toolName === 'format') {
      const runner = this.formatRunner;
      if (!runner) {
        return { content: 'Formatting is unavailable.', isError: true };
      }
      const path = typeof args.path === 'string' ? args.path : '';
      if (!path) {
        return { content: 'format requires a `path`.', isError: true };
      }
      try {
        const result = await runner({ path, signal });
        return { content: result, isError: false };
      } catch (error) {
        return {
          content: `format failed: ${PiAgent.describeThrown(error)}`,
          isError: true,
        };
      }
    }

    // MCP source tools — route through centralized pool. The leaserId scopes
    // both the ownership guard (isProxyTool) and the call-authz guard to THIS
    // session's leased slugs; sessionPath + summarize keep large/binary
    // responses saving into this session's dir on a shared pool. Absent a
    // leaserId this is byte-equivalent to the pre-sharing call. UB3.9: the
    // PreToolUse bridge's intent (when this call id captured one) rides along,
    // so a large result is summarised against the agent's stated purpose.
    if (this.mcpPool?.isProxyTool(toolName, this.config.mcpLeaserId)) {
      return this.mcpPool.callTool(toolName, args, signal, {
        sessionPath: getSessionDirPath(this.config.workspace.id, this._sessionId),
        summarize: this.getSummarizeCallback(),
        ...(this.config.mcpLeaserId ? { leaserId: this.config.mcpLeaserId } : {}),
        ...(intent ? { intent } : {}),
      });
    }

    // Unknown tool
    return {
      content: `Unknown proxy tool: ${toolName}`,
      isError: true,
    };
  }

  /**
   * Get or create a SessionToolContext for executing session-scoped tools.
   * Cached per agent instance since the workspace/session don't change.
   */
  private getSessionToolContext(): SessionToolContext {
    if (this._sessionToolContext) return this._sessionToolContext;

    const sessionId = this.config.session?.id || '';
    const workspacePath = this.config.workspace.workspaceRootPath;
    const workspaceId = this.config.workspace.id;
    const sessionKey: SessionKey = { workspaceId, sessionId };
    // ID-first session-path derivation (global SESSIONS_DIR).
    const sessionPath = getSessionDirPath(workspaceId, sessionId);

    this._sessionToolContext = createClaudeContext({
      sessionId,
      workspacePath,
      workspaceId,
      sessionPath,
      workingDirectory: this.config.session?.workingDirectory,
      // P6.795 — Pi's arm of the memory WRITE axis, and it must stay an
      // ACCESSOR. `createClaudeContext` is called once, here, and the context it
      // returns is held for the life of this agent; a captured VALUE would
      // freeze the session's memory scope as of construction and re-create the
      // very bug the row closes — a `remember` writing for a chat whose write
      // axis was closed afterwards — one layer up from where it was fixed.
      getMemoryScopeOverride: () => this.config.session?.memoryScopeOverride,
      onPlanSubmitted: (planPath: string) => {
        setLastPlanFilePath(sessionKey, planPath);
        this.onPlanSubmitted?.(planPath);
      },
      onAuthRequest: (request: unknown) => {
        this.onAuthRequest?.(request as any);
      },
      // D3 live find (2026-08-14): Pi builds its OWN session-tool context, so a
      // binding threaded only through `session-scoped-tools.ts` never reaches a
      // Pi session — `source_manage: disable` worked while `remove` answered
      // "not available in this context" forever. Read the SessionManager-bound
      // callback from the same registry every other host seam uses.
      onRemoveSource: async (sourceSlug: string) => {
        const remove = getSessionScopedToolCallbacks(sessionKey)?.removeSourceFn;
        if (!remove) throw new Error('Removing a source is not available in this context.');
        await remove(sourceSlug);
      },
    });
    this._sessionToolContext.taskPort = this.config.taskPort;
    // R27b — session-scoped scheduling. Absent when the host has the scheduler
    // disabled (`scheduled-tasks.md:208`), in which case the three tools are
    // already off the surface too.
    this._sessionToolContext.cronPort = this.config.cronPort;
    this._sessionToolContext.goalPort = this.config.goalPort;
    this._sessionToolContext.notificationPort = this.config.notificationPort;
    this._sessionToolContext.planModePort = this.config.planModePort ? {
      submit: ({ planPath }) => this.config.planModePort!.submit({
        sessionKey: { workspaceId: this.config.workspace.id, sessionId: this.config.session?.id || this._sessionId },
        planPath,
      }),
    } : undefined;

    // Attach session self-management bindings (lazy getters from callback registry)
    attachSessionSelfManagementBindings(this._sessionToolContext, sessionKey);
    this._sessionToolContext.dispatchSlashCommand = (command: string) => this.dispatchSlashCommand(command);
    this._sessionToolContext.readBackgroundShellOutput = (shellId: string, offset?: number) => this.requestBashOutput(shellId, offset);
    this._sessionToolContext.stopBackgroundShell = (shellId: string) => this.requestProcessStop(shellId);

    return this._sessionToolContext;
  }

  /**
   * The model's `SlashCommand` tool. It arrives with a BARE command string
   * (`/compact …`, never wrapped in turn context), and it goes through the same
   * `parseSessionCommand` classifier as the user's typed form so the two can
   * never diverge. `/subtask` stays unavailable to the model here — starting a
   * fork is the user's call — so it falls through to the block below.
   */
  private async dispatchSlashCommand(command: string): Promise<string> {
    const trimmedCommand = command.trim();
    const parsed = parseSessionCommand(trimmedCommand);
    if (parsed?.kind === 'compact') {
      const compactResult = await this.requestCompact(parsed.customInstructions).catch((error: unknown) => {
        if (isPiNothingToCompactRefusal(error)) return error; // F1.880 — Pi's nothing-to-compact refusal is the tool's ordinary answer, as on the typed path (F1.856)
        throw error; // every other rejection still fails the tool call (`handleSlashCommand`'s errorResponse)
      });
      if (compactResult instanceof Error) return compactResult.message;
      if (!compactResult) return 'Compacted context to fit within limits';
      const after = typeof compactResult.estimatedTokensAfter === 'number' ? ` to ~${compactResult.estimatedTokensAfter.toLocaleString()}` : '';
      return `Compacted context to fit within limits (from ~${compactResult.tokensBefore.toLocaleString()}${after} tokens)`;
    }

    if (/^\/help\s*$/i.test(trimmedCommand)) {
      return [
        'Available agent-callable slash commands:',
        '- /compact [instructions]: compact the active session context.',
        '- /help: show this list.',
      ].join('\n');
    }

    // The model-callable allowlist is DELIBERATELY /compact + /help and nothing
    // else. Do not "complete the switch" for the classifier's other kinds:
    // `/subtask` is the user's call to start, `/clear` would let the model
    // erase the user's context, and `/btw`/`/recap` are answered in an overlay
    // the model cannot see — routing them here would hand the model a hidden
    // out-of-history channel. The throw below is the contract.
    throw new Error(`Unknown or blocked slash command: ${trimmedCommand || '(empty)'}`);
  }

  /**
   * Execute a session-scoped tool by name.
   * Uses the canonical registry from @nessy-agent/session-tools-core.
   */
  private async executeSessionTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<PiProxyToolResult> {
    try {
      // call_llm uses the shared pre-execution pipeline from BaseAgent
      if (toolName === 'call_llm') {
        try {
          const result = await this.preExecuteCallLlm(args);
          return { content: result.text || '(Model returned empty response)', isError: false };
        } catch (error) {
          const msg = PiAgent.describeThrown(error);
          return { content: `call_llm failed: ${msg}`, isError: true };
        }
      }

      // P2.1 — advisor_consult rides the same shared pipeline. `isError` is
      // never set: an unavailable advisor is a documented answer ("it says so
      // and you continue on your own"), and marking it an error invites the
      // model to retry a consult that will refuse again.
      if (toolName === 'advisor_consult') {
        return { content: await this.executeAdvisorConsult(args), isError: false };
      }

      // spawn_session uses the shared pre-execution pipeline from BaseAgent
      if (toolName === 'spawn_session') {
        try {
          const result = await this.preExecuteSpawnSession(args);
          return { content: JSON.stringify(result, null, 2), isError: false };
        } catch (error) {
          const msg = PiAgent.describeThrown(error);
          return { content: `spawn_session failed: ${msg}`, isError: true };
        }
      }

      // browser_tool — single CLI-like tool for all browser actions
      if (toolName === 'browser_tool') {
        const callbacks = getSessionScopedToolCallbacks({ workspaceId: this.config.workspace.id, sessionId: this._sessionId });
        const browserFns = callbacks?.browserPaneFns;
        if (!browserFns) {
          return { content: 'Browser window controls are not available. This tool requires the desktop app.', isError: true };
        }

        try {
          const result = await executeBrowserToolCommand({
            command: (args.command as string | string[]) ?? '',
            fns: browserFns,
            sessionId: this._sessionId,
          });

          let content = result.output;
          if (result.image) {
            const sessionPath = getSessionDirPath(this.config.workspace.id, this._sessionId);
            const imageBuffer = Buffer.from(result.image.data, 'base64');
            const ext = result.image.mimeType === 'image/jpeg' ? 'jpg' : 'png';
            const saved = saveBinaryResponse(sessionPath, `browser-screenshot.${ext}`, imageBuffer, result.image.mimeType);

            if (saved.type === 'file_download') {
              content += [
                '',
                `Saved screenshot: ${saved.path}`,
                '',
                '```image-preview',
                JSON.stringify({
                  src: saved.path,
                  title: 'Browser Screenshot',
                }, null, 2),
                '```',
              ].join('\n');
            } else {
              content += `\n\n[Screenshot captured (${Math.round(result.image.sizeBytes / 1024)}KB ${result.image.mimeType}) but failed to save: ${saved.error}]`;
            }
          }

          return { content, isError: false };
        } catch (error) {
          // Branch on `err.code` (string), not `instanceof CodedError` — the
          // transport reconstructs a plain Error on the receiving side, so
          // class identity is lost across the wire.
          const rawCode = (error as { code?: unknown } | null)?.code;
          const code = typeof rawCode === 'string' ? rawCode : '';
          const msg = PiAgent.describeThrown(error);
          const friendly = mapBrowserToolErrorCode(code, msg) ?? msg;
          return { content: friendly, isError: true };
        }
      }

      const def = SESSION_TOOL_REGISTRY.get(toolName);
      if (!def) {
        return { content: `Unknown session tool: ${toolName}`, isError: true };
      }
      if (!def.handler) {
        return {
          content: `Session tool '${toolName}' is backend-executed (${def.executionMode}) but has no PiAgent adapter implementation.`,
          isError: true,
        };
      }

      const ctx = this.getSessionToolContext();
      const result: SessionToolResult = await def.handler(ctx, args);

      // Convert ToolResult to subprocess response format
      const text = result.content.map(c => c.text).join('\n');
      return {
        content: text,
        isError: !!result.isError,
        ...(hasStructuredContent(result.structuredContent) ? { structuredContent: result.structuredContent } : {}),
        // P6.617 — the non-text blocks ride the wire so the child can merge
        // them. Omitted when empty, so a text-only tool's response is
        // byte-identical to what it was before this field existed.
        ...(result.extraContent?.length ? { extraContent: result.extraContent } : {}),
      };
    } catch (error) {
      const msg = PiAgent.describeThrown(error);
      this.debug(`Session tool ${toolName} failed: ${msg}`);
      return { content: `Session tool error: ${msg}`, isError: true };
    }
  }



  /**
   * Handle session_tool_completed from subprocess.
   *
   * NOTE: For proxy-executed session tools, callbacks (onPlanSubmitted, etc.)
   * are already fired by executeSessionTool() via the SessionToolContext.
   * The subprocess sends this event because handleSessionEvent() detects the
   * mcp__session__ prefix, but we intentionally skip handleSessionMcpToolCompletion()
   * here to avoid double-firing callbacks.
   */
  private handleSessionToolCompleted(msg: Record<string, unknown>): void {
    const toolName = msg.toolName as string;
    const isError = msg.isError as boolean;
    this.debug(`Session tool completed: ${toolName} (isError=${isError})`);
    // Callbacks already handled by executeSessionTool() — no-op.
  }

  /**
   * Handle mini_completion_result from subprocess.
   */
  private handleMiniCompletionResult(msg: Record<string, unknown>): void {
    const id = msg.id as string;
    const text = msg.text as string | null;
    const pending = this.pendingMiniCompletions.get(id);
    if (pending) {
      this.pendingMiniCompletions.delete(id);
      pending.resolve(text);
    }
  }

  /**
   * Handle ensure_session_ready_result from subprocess.
   */
  private handleEnsureSessionReadyResult(msg: Record<string, unknown>): void {
    const id = msg.id as string;
    const sessionId = (msg.sessionId as string | null) ?? null;
    const pending = this.pendingEnsureSessionReady.get(id);
    if (!pending) return;

    this.pendingEnsureSessionReady.delete(id);
    if (sessionId && this.piSessionId !== sessionId) {
      this.piSessionId = sessionId;
      // P2.54 — belted, and this site is why the belt lives at the CALL rather
      // than around the dispatch: the correlation entry is deleted on the line
      // above, so a throw here left `requestEnsureSessionReady` awaiting a
      // promise nothing could still settle (branch preflight has no timeout of
      // its own to fall back on), and no outer catch could have found it.
      this.safeHostCall('onSdkSessionIdUpdate', () => this.config.onSdkSessionIdUpdate?.(sessionId));
    }
    pending.resolve(sessionId);
  }

  /**
   * Handle compact_result from subprocess.
   *
   * NOT DONE, deliberately (R52): `model-config.md:387` extends the fallback
   * chain to compaction, with a rule of its own — "Claude Code won't fall back
   * to a model with a smaller context window than the primary's … If every
   * fallback is smaller, compaction shows the original error and you can
   * retry." A failed compaction below still just rejects with the original
   * error, which is the right OUTCOME for the every-fallback-is-smaller case
   * and the wrong one for every other case. Deferred by the R52 plan because it
   * needs per-entry context windows the chain walk does not consult today.
   */
  private handleCompactResult(msg: Record<string, unknown>): void {
    const id = msg.id as string;
    const success = Boolean(msg.success);
    const pending = this.pendingCompactions.get(id);
    if (!pending) return;

    this.pendingCompactions.delete(id);
    if (!success) {
      this.finishContinuationBoundary('failed');
      pending.reject(new Error(String(msg.errorMessage || 'Compaction failed')));
      return;
    }

    // An RPC-driven compaction — a typed `/compact` and the model's own
    // `SlashCommand` form both land on `requestCompact` — summarises away the
    // message the pinned block was sent in. It does NOT pass through the raw
    // event handler that calls `resetPrerequisiteState()`, so the delivery latch
    // is cleared here as well; `context-window.md:1591` requires the block to be
    // re-injected from disk afterwards.
    this.forgetDeliveredPinnedCapabilityContext();

    const raw = msg.result as Record<string, unknown> | undefined;
    if (!raw) {
      this.finishContinuationBoundary('post');
      pending.resolve(null);
      return;
    }

    const contextUsage = raw.contextUsage && typeof raw.contextUsage === 'object'
      ? raw.contextUsage as ContextUsageSnapshot
      : undefined;
    if (contextUsage) {
      this.adapter.setContextUsageSnapshot(contextUsage);
    }

    this.finishContinuationBoundary('post');
    pending.resolve({
      summary: String(raw.summary || ''),
      firstKeptEntryId: String(raw.firstKeptEntryId || ''),
      tokensBefore: Number(raw.tokensBefore || 0),
      ...(typeof raw.estimatedTokensAfter === 'number' ? { estimatedTokensAfter: raw.estimatedTokensAfter } : {}),
      ...(contextUsage ? { contextUsage } : {}),
    });
  }

  /**
   * Handle context_usage_result from subprocess.
   */
  private handleContextUsageResult(msg: Record<string, unknown>): void {
    const id = msg.id as string;
    const success = Boolean(msg.success);
    const pending = this.pendingContextUsageRequests.get(id);
    if (!pending) return;

    this.pendingContextUsageRequests.delete(id);
    if (!success) {
      pending.reject(new Error(String(msg.errorMessage || 'Context usage refresh failed')));
      return;
    }

    const usage = msg.usage;
    if (!usage || typeof usage !== 'object') {
      pending.reject(new Error('Context usage response was empty'));
      return;
    }

    const snapshot = usage as ContextUsageSnapshot;
    this.adapter.setContextUsageSnapshot(snapshot);
    this.logContextWindowDrift(snapshot);
    pending.resolve(snapshot);
  }

  /**
   * Handle set_auto_compaction_result from subprocess.
   */
  private handleSetAutoCompactionResult(msg: Record<string, unknown>): void {
    const id = msg.id as string;
    const success = Boolean(msg.success);
    const pending = this.pendingAutoCompactionToggles.get(id);
    if (!pending) return;

    this.pendingAutoCompactionToggles.delete(id);
    if (!success) {
      pending.reject(new Error(String(msg.errorMessage || 'Failed to set auto-compaction')));
      return;
    }

    pending.resolve(Boolean(msg.enabled));
  }

  /**
   * Handle update_runtime_config_result from subprocess.
   */
  private handleRuntimeConfigUpdateResult(msg: Record<string, unknown>): void {
    const id = msg.id as string;
    const success = Boolean(msg.success);
    const pending = this.pendingRuntimeConfigUpdates.get(id);
    if (!pending) return;

    this.pendingRuntimeConfigUpdates.delete(id);
    if (!success) {
      pending.reject(new Error(String(msg.errorMessage || 'Runtime config update failed')));
      return;
    }

    if (msg.contextUsage && typeof msg.contextUsage === 'object') {
      const snapshot = msg.contextUsage as ContextUsageSnapshot;
      this.adapter.setContextUsageSnapshot(snapshot);
      this.logContextWindowDrift(snapshot);
    }

    pending.resolve(Boolean(msg.updated ?? true));
  }

  /**
   * Handle subprocess exit.
   */
  private handleSubprocessExit(
    code: number | null,
    signal: string | null,
    sourceAttempt: PiSubprocessStartupAttempt | null = this.subprocessAttempt,
    sourceChild: ChildProcess | null = this.subprocess,
    sourceReadline: ReadlineInterface | null = this.readline,
  ): void {
    if (sourceAttempt && (
      !this.isCurrentSubprocessAttempt(sourceAttempt)
      || (sourceChild && this.subprocess !== sourceChild)
    )) return;
    this.debug(`Pi subprocess exited: code=${code}, signal=${signal}`);

    const exitReason = signal ? `signal ${signal}` : `code ${code}`;
    if (sourceAttempt && !sourceAttempt.startupSettled && this.failSubprocessAttempt(
      sourceAttempt,
      new Error(`Pi subprocess exited unexpectedly (${exitReason}) before ready`),
      sourceChild,
      sourceReadline,
    )) return;

    if (this.subprocess === sourceChild) this.subprocess = null;
    if (this.readline === sourceReadline) this.readline = null;
    this.resetSubprocessErrorDedup();
    if (sourceAttempt && this.subprocessAttempt === sourceAttempt) {
      this.subprocessAttempt = null;
    }

    // If we were processing, emit error + complete
    if (this._isProcessing) {
      this.eventQueue.enqueue({
        type: 'error',
        message: `Pi subprocess exited unexpectedly (${exitReason})`,
      });
      this.eventQueue.complete();
    }

    this.finishContinuationBoundary('failed'); withdrawCrashedOutsideRootCards(this); // F1.1287 — a crash counts as stopped
    this.rejectPendingSubprocessRequests(
      new Error(`Pi subprocess exited unexpectedly (${exitReason})`),
    );
  }

  private rejectPendingSubprocessRequests(error: Error): void {
    this.clearExecutionManifestAuthority();
    this.subprocessResponseEpoch += 1;
    for (const pending of this.pendingMiniCompletions.values()) pending.reject(error);
    this.pendingMiniCompletions.clear();
    for (const pending of this.pendingLlmQueries.values()) pending.reject(error);
    this.pendingLlmQueries.clear();
    for (const pending of this.pendingEnsureSessionReady.values()) pending.reject(error);
    this.pendingEnsureSessionReady.clear();
    for (const pending of this.pendingCompactions.values()) pending.reject(error);
    this.pendingCompactions.clear();
    for (const pending of this.pendingContextUsageRequests.values()) pending.reject(error);
    this.pendingContextUsageRequests.clear();
    // UB2.10 — a detached call survives a STOP, not session death: the subprocess is gone, so
    // its abort listener (which rejects `pendingRef` with `mcp-background-task-stopped`) fires
    // here too. This is `rejectPendingSubprocessRequests`, not the Stop sweep.
    for (const pending of this.detachedToolExecutions.values()) pending.abort();
    this.detachedToolExecutions.clear();
    // Resolve-only map: a dead subprocess is an error ROW in the summary.
    for (const pending of this.pendingHeapdumps.values()) pending.resolve({ success: false, errorMessage: error.message });
    this.pendingHeapdumps.clear();
    // L9 — a dead subprocess holds no background task; answer, do not reject.
    // AND ANSWER "NOT MINE", not "failed": this line used to pass `error.message`,
    // which is the one shape `SessionManager.stopAgentTask` refuses to fall
    // through on — so the host never reached the durable child-session port for a
    // stop that was in flight when the subprocess died, which is precisely the
    // case `pendingStopBackgroundTasks`' own comment says it must. The registry
    // died with the subprocess, so there is no half-stopped tree here to protect.
    if (this.pendingStopBackgroundTasks.size > 0) {
      this.debug(
        `${this.pendingStopBackgroundTasks.size} background-task stop(s) were in flight when the subprocess ` +
        `went away (${error.message}) — answering "not mine" so the host falls through`,
      );
    }
    for (const pending of this.pendingStopBackgroundTasks.values()) pending.resolve({ stopped: false });
    this.pendingStopBackgroundTasks.clear();
    for (const pending of this.pendingAutoCompactionToggles.values()) pending.reject(error);
    this.pendingAutoCompactionToggles.clear();
    for (const pending of this.pendingRuntimeConfigUpdates.values()) pending.reject(error);
    this.pendingRuntimeConfigUpdates.clear();
    for (const pending of this.pendingToolExecutions.values()) pending.abort();
    this.pendingToolExecutions.clear();
    for (const controller of this.pendingProcessStarts.values()) controller.abort();
    this.pendingProcessStarts.clear();
    // A downgrade authorized for a tool call on a channel that no longer exists
    // must never be honoured on the next one.
    this.authorizedSandboxDowngrades.clear();
    for (const pending of this.pendingManifestRegistrations.values()) pending.reject(error);
    this.pendingManifestRegistrations.clear();
    for (const pending of this.pendingWorkflowExecutions.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingWorkflowExecutions.clear();
    for (const pending of this.pendingSubtaskForks.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingSubtaskForks.clear();
    for (const pending of this.pendingSkillForks.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingSkillForks.clear();
    const cwdTransaction = this.workingDirectoryTransaction;
    if (cwdTransaction?.pending) {
      clearTimeout(cwdTransaction.pending.timer);
      cwdTransaction.pending.reject(error);
      cwdTransaction.pending = undefined;
    }
    this.workingDirectoryTransaction = null;
    for (const [requestId, pending] of this.pendingPermissions) {
      this.pendingPermissions.delete(requestId);
      this.cancelPendingPermission(requestId, pending, error.message);
    }
    this.preToolMetadataByCallId.clear();
    this.editFeedbackInputByCallId.clear();
    this.pendingEditFeedback.clear();
  }

  private handleWorkingDirectoryTransactionResult(msg: Record<string, unknown>): void {
    const transaction = this.workingDirectoryTransaction;
    const phase = msg.phase as WorkingDirectoryTransactionPhase;
    if (!transaction?.pending) {
      this.debug('Ignoring stale or mismatched working-directory transaction result');
      return;
    }

    if (transaction.id !== msg.id
      || transaction.generation !== msg.generation
      || transaction.pending.phase !== phase) {
      const pending = transaction.pending;
      transaction.pending = undefined;
      clearTimeout(pending.timer);
      this.workingDirectoryTransaction = null;
      pending.reject(new Error('Pi working-directory transaction result was stale or mismatched'));
      // The child may still own an unpublished candidate. Retire this entire
      // subprocess generation so cleanup is guaranteed and the next request
      // starts from a fresh, matching generation 0.
      this.killSubprocess({ completeEventQueue: false });
      return;
    }

    const pending = transaction.pending;
    transaction.pending = undefined;
    clearTimeout(pending.timer);
    if (msg.success !== true) {
      this.workingDirectoryTransaction = null;
      pending.reject(new Error(String(msg.errorMessage || `Pi cwd ${phase} failed`)));
      // A negative result can represent incomplete child restoration (for
      // example a COMMIT AggregateError or a ROLLBACK dispose failure). Retire
      // the child rather than assuming it still owns a clean prior runtime.
      this.killSubprocess({ completeEventQueue: false });
      return;
    }
    pending.resolve();
  }

  private requestWorkingDirectoryTransactionPhase(
    transaction: PiWorkingDirectoryTransactionState,
    phase: WorkingDirectoryTransactionPhase,
  ): Promise<void> {
    if (this.workingDirectoryTransaction !== transaction || transaction.pending) {
      return Promise.reject(new Error('Pi working-directory transaction is stale or busy'));
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (transaction.pending?.phase !== phase) return;
        transaction.pending = undefined;
        if (this.workingDirectoryTransaction === transaction) {
          this.workingDirectoryTransaction = null;
        }
        reject(new Error(`Pi cwd ${phase} timed out after 15s`));
        // The child may have applied the phase even though its acknowledgement
        // never arrived. Retire that subprocess so no candidate/old runtime can
        // survive an uncertain outcome; the next fresh init starts at generation 0.
        this.killSubprocess({ completeEventQueue: false });
      }, 15_000);
      transaction.pending = { phase, resolve, reject, timer };
      this.send({
        type: 'working_directory_transaction',
        id: transaction.id,
        phase,
        expectedGeneration: transaction.expectedGeneration,
        generation: transaction.generation,
        cwd: transaction.path,
        projectTrusted: transaction.projectTrusted,
      });
    });
  }

  async prepareWorkingDirectoryUpdate(
    input: WorkingDirectoryUpdateInput,
  ): Promise<WorkingDirectoryUpdateTransaction> {
    await this.ensureSubprocess();
    if (this.workingDirectoryTransaction) {
      throw new Error('Pi working-directory transaction already active');
    }

    const transaction: PiWorkingDirectoryTransactionState = {
      id: `cwd-${++this.rpcIdCounter}`,
      expectedGeneration: this.workingDirectoryGeneration,
      generation: this.workingDirectoryGeneration + 1,
      previousPath: input.previousPath,
      path: input.path,
      projectTrusted: input.projectTrusted,
      phase: 'preparing',
    };
    this.workingDirectoryTransaction = transaction;
    try {
      await this.requestWorkingDirectoryTransactionPhase(transaction, 'prepare');
      transaction.phase = 'prepared';
    } catch (error) {
      if (this.workingDirectoryTransaction === transaction) {
        this.workingDirectoryTransaction = null;
      }
      throw error;
    }

    const assertCurrent = (...phases: PiWorkingDirectoryTransactionState['phase'][]) => {
      if (this.workingDirectoryTransaction !== transaction || !phases.includes(transaction.phase)) {
        throw new Error('Pi working-directory transaction is stale or out of order');
      }
    };

    return {
      generation: transaction.generation,
      commit: async () => {
        assertCurrent('prepared');
        transaction.phase = 'committing';
        try {
          await this.requestWorkingDirectoryTransactionPhase(transaction, 'commit');
        } catch (error) {
          transaction.phase = 'prepared';
          throw error;
        }
        // The child owns N+1 once COMMIT is acknowledged. Record that before
        // the fallible parent update so SessionManager can still roll both
        // participants back if BaseAgent mutation throws after partial state.
        transaction.phase = 'committed';
        super.updateWorkingDirectory(transaction.path);
      },
      rollback: async () => {
        if (transaction.phase === 'rolled_back') return;
        assertCurrent('prepared', 'committed');
        const restoreParent = transaction.phase === 'committed';
        transaction.phase = 'rolling_back';
        let childError: unknown;
        let parentError: unknown;
        try {
          await this.requestWorkingDirectoryTransactionPhase(transaction, 'rollback');
        } catch (error) {
          childError = error;
        }
        if (restoreParent) {
          try {
            super.updateWorkingDirectory(transaction.previousPath);
          } catch (error) {
            parentError = error;
          }
        }
        transaction.phase = 'rolled_back';
        if (this.workingDirectoryTransaction === transaction) {
          this.workingDirectoryTransaction = null;
        }
        if (childError && parentError) {
          throw new AggregateError(
            [childError, parentError],
            'Pi cwd child rollback and parent restoration both failed',
          );
        }
        if (childError) throw childError;
        if (parentError) throw parentError;
      },
      finalize: async () => {
        if (transaction.phase === 'finalized') return;
        assertCurrent('committed');
        transaction.phase = 'finalizing';
        try {
          await this.requestWorkingDirectoryTransactionPhase(transaction, 'finalize');
          this.workingDirectoryGeneration = transaction.generation;
          transaction.phase = 'finalized';
          if (this.workingDirectoryTransaction === transaction) {
            this.workingDirectoryTransaction = null;
          }
        } catch (error) {
          let parentError: unknown;
          try {
            super.updateWorkingDirectory(transaction.previousPath);
          } catch (restoreError) {
            parentError = restoreError;
          }
          transaction.phase = 'rolled_back';
          if (this.workingDirectoryTransaction === transaction) {
            this.workingDirectoryTransaction = null;
          }
          if (parentError) {
            throw new AggregateError(
              [error, parentError],
              'Pi cwd finalize failed and parent cwd restoration was incomplete',
            );
          }
          throw error;
        }
      },
    };
  }

  /**
   * Ask subprocess to create/verify the primary session (without sending a prompt)
   * and return the active Pi session ID.
   */
  private async requestEnsureSessionReady(): Promise<string | null> {
    await this.ensureSubprocess();

    const id = `ensure-ready-${++this.rpcIdCounter}`;
    const timeoutMs = 15_000;

    return new Promise<string | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingEnsureSessionReady.delete(id);
        reject(new Error(`ensure_session_ready timed out after ${Math.floor(timeoutMs / 1000)}s`));
      }, timeoutMs);

      this.pendingEnsureSessionReady.set(id, {
        resolve: (sessionId) => {
          clearTimeout(timer);
          resolve(sessionId);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      this.send({ type: 'ensure_session_ready', id });
    });
  }

  /**
   * L9 — ASK THE LIVE SUBPROCESS'S `BackgroundTaskRegistry` TO STOP ONE TASK.
   *
   * The host half of the route the `InboundMessage` union had no member for. It
   * carries the SAME name as `ClaudeAgent.stopBackgroundTask` on purpose:
   * `SessionManager.stopAgentTask` reads the method structurally, so one call
   * site serves both runtimes and the ordering rule — registry first, the durable
   * child-session port as the fallback — is expressed once.
   *
   * WHY THIS AND NOT `ChildSessionService.stopTask` ALONE. The registry is where
   * the run's own `AbortController` lives, and for two of the three background
   * kinds it is the ONLY place the work can be reached: an auto-backgrounded MCP
   * call has no child-session record at all, and a background workflow's registry
   * entry owns the DAG script — kill only the current node's child and the script
   * schedules the next one. This is exactly the order the model's own `stopTask`
   * tool has always used.
   *
   * `stopped: false` WITH NO `error` MEANS "NOT MINE", and the caller must fall
   * through rather than report a failure — a chain-mode subagent between steps is
   * registered here, a durable child that a previous generation admitted is not.
   *
   * NO `ensureSubprocess()`. Every other request here spawns one if needed; a
   * stop must not, because a subprocess that does not exist is holding no
   * background task and starting one to ask would be absurd. Bounded like every
   * other control request, so an old bundle that does not know the message
   * degrades to "not mine" after the deadline instead of hanging the button.
   *
   * AN UNANSWERED REQUEST IS "NOT MINE", NOT A FAILURE — and until this change
   * the code said the opposite of the paragraph above it. The deadline resolved
   * with an `error`, and `error` is the one word in this contract that means "this
   * mechanism owned the id and the stop went wrong", on which
   * `SessionManager.stopAgentTask` ENDS the sequence. So the promised degradation
   * to "not mine" never happened: an old bundle that does not know
   * `stop_background_task` could never reach the durable child-session port, and
   * the user was told the stop had failed. The same was true of a subprocess that
   * DIED mid-request (`rejectPendingSubprocessRequests`), which this method's own
   * pending-map comment lists as a case the host must fall through on.
   *
   * WHY FALLING THROUGH IS THE SAFE DIRECTION HERE, given that the reverse risks a
   * second mechanism acting on a half-stopped tree: nothing this timeout can
   * describe is a half-stopped tree we know about. An old bundle never received
   * the message; a dead subprocess took its registry with it. And the fall-through
   * is already FENCED for the two kinds where a second mechanism would be wrong —
   * `SessionManager` refuses it outright for `kind: 'mcp'` and `kind: 'workflow'`
   * before ever reaching the child service, and the child service itself throws
   * `unknown-task-id:<id>` unless a starting/running background child matches, so
   * it cannot invent a stop. What the old shape cost was certain: a whole class of
   * sessions with no way to stop an agent task at all.
   *
   * The diagnostic is not lost, it is moved: an unanswered stop is logged here,
   * and what the user is told comes from whatever the next arm reports.
   */
  async stopBackgroundTask(taskId: string): Promise<{ stopped: boolean; error?: string }> {
    if (!this.subprocess) return { stopped: false };

    const id = `stop-background-task-${++this.rpcIdCounter}`;
    const timeoutMs = 15_000;

    return new Promise<{ stopped: boolean; error?: string }>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingStopBackgroundTasks.delete(id);
        this.debug(
          `stop_background_task for ${taskId} unanswered after ${Math.floor(timeoutMs / 1000)}s — ` +
          `treating as "not mine" so the host falls through to the child-session port`,
        );
        resolve({ stopped: false });
      }, timeoutMs);

      this.pendingStopBackgroundTasks.set(id, {
        resolve: (outcome) => {
          clearTimeout(timer);
          resolve(outcome);
        },
      });

      this.send({ type: 'stop_background_task', id, taskId });
    });
  }

  /**
   * UB12.36 — abort the DETACHED proxy calls running under one background task, host side, with `reason` as the route
   * signal's reason (the MCP pool rejects with it, so the subprocess's task notification names it). The caller is
   * `SessionManager`'s capability-revoke arm for a task whose retained authority holds a REVOKED lease while no turn of
   * that lease runs: a revoke DURING the turn already takes every detached call (`forceAbort(InternalError)`'s sweep),
   * and this is the same abort, scoped to the revoked task. Host side rather than `stopBackgroundTask`, as that sweep is:
   * it does not wait on the subprocess. Returns how many calls it aborted; 0 for a task that has none (a background child).
   */
  abortDetachedToolCallsForTask(taskId: string, reason: Error): number {
    let aborted = 0;
    for (const [requestId, controller] of this.detachedToolExecutions) {
      if (this.detachedToolTaskIds.get(controller) !== taskId) continue;
      this.detachedToolExecutions.delete(requestId);
      controller.abort(reason);
      aborted += 1;
    }
    return aborted;
  }

  /**
   * P6.962 — Pi has no lever to background an IN-FLIGHT foreground tool call,
   * and the refusal is stated here rather than left to an absent method.
   *
   * MEASURED AT HEAD BEFORE DECIDING, because the row's own premise pointed at
   * the wrong seam. Pi DOES detach running work, in three places, and not one of
   * them is reachable from a user press:
   *
   *  - MCP calls. `pi-agent-server`'s tool proxy races the call's result against
   *    `detachAfter(delayMs, elicitationDialogGate)` (R10, `mcp.md` §Automatic
   *    backgrounding of long tool calls). On detach the model receives a
   *    "moved to a background task" result, the run is registered in the
   *    `BackgroundTaskRegistry`, and its settlement arrives as a task
   *    notification — which is what claude's `Query.backgroundTasks` produces.
   *    The TRIGGER is a clock and the timer object is local to that one call.
   *  - Bash. The call's own `timeout` transitions the command to a background
   *    shell, and that timeout is the model's own argument.
   *  - Agent-tool spawns. `subagent-tool.ts` detaches the whole run through
   *    `registerBackgroundChildTask`, racing the ADMISSION — at the START of the
   *    run, never mid-flight.
   *
   * THE ROW'S PROPOSED MEASUREMENT IS ANSWERED AND ITS REMEDY IS REFUTED.
   * `spawner.ts`'s awaited `monitor` must not be the seam: P6.308 landed the Pi
   * detach at the TOOL, and its own comment in `review-tool.ts` says why —
   * teaching the spawner to return early "would have been a second, weaker copy
   * of that", and that await is exactly what makes a detached run deliver a
   * COMPLETED result to the notification path. Returning early there would leak
   * no child (one is durable at the child-session port from `onAdmitted`
   * onward), and it would still not answer this chord: it reaches one of the
   * three families and the two a person is most likely to be waiting on are the
   * other two.
   *
   * SO WHAT IS MISSING IS A TRIGGER, NOT A MECHANISM: a host-to-subprocess
   * request that fires an ARMED detach for a named `toolUseId`, plus the
   * per-call registry that can find it. That is a wire member, a handler and a
   * map — the shape `stopBackgroundTask` above already has — and it is a row of
   * its own rather than a line of this one.
   *
   * IMPLEMENTED RATHER THAN OMITTED, for the reason
   * `CodexAgent.backgroundInFlightTasks` states: the host maps an absent method
   * and a refusing one to the same `unsupported`, so from the caller's side they
   * are indistinguishable — but only the refusing one carries a diagnostic, and
   * only it gives this measurement somewhere to live where the next reader of
   * the chord will meet it.
   */
  async backgroundInFlightTasks(_toolUseId?: string): Promise<{ backgrounded: false; unsupported: true }> {
    this.debug(
      'Pi detaches a running tool call on a clock (MCP), on the call\'s own timeout (bash) or at admission '
      + '(agent tool); it has no host-triggered lever for one already in flight. Refusing by name.',
    );
    return { backgrounded: false, unsupported: true };
  }

  /**
   * Handle stop_background_task_result from subprocess.
   */
  private handleStopBackgroundTaskResult(msg: Record<string, unknown>): void {
    const id = msg.id as string;
    const pending = this.pendingStopBackgroundTasks.get(id);
    if (!pending) return;
    this.pendingStopBackgroundTasks.delete(id);
    const errorMessage = typeof msg.errorMessage === 'string' && msg.errorMessage.length > 0
      ? msg.errorMessage
      : undefined;
    pending.resolve({
      stopped: Boolean(msg.stopped),
      ...(errorMessage ? { error: errorMessage } : {}),
    });
  }

  /**
   * Ask subprocess for the active session's current context usage snapshot.
   */
  async requestContextUsage(): Promise<ContextUsageSnapshot> {
    await this.ensureSubprocess();

    const id = `context-usage-${++this.rpcIdCounter}`;
    const timeoutMs = 15_000;

    return new Promise<ContextUsageSnapshot>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingContextUsageRequests.delete(id);
        reject(new Error(`get_context_usage timed out after ${Math.floor(timeoutMs / 1000)}s`));
      }, timeoutMs);

      this.pendingContextUsageRequests.set(id, {
        resolve: (usage) => {
          clearTimeout(timer);
          resolve(usage);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      this.send({ type: 'get_context_usage', id });
    });
  }

  /**
   * Ask the LIVE subprocess to write its own heapdump pair
   * (`<sessionId>-pi.heapsnapshot` + `-diagnostics.json` — the subprocess
   * derives the base name from its init sessionId). Returns `null` when no
   * subprocess is running — a dump must never spawn one just to measure it —
   * and an error ROW (never a rejection) on timeout, so an old subprocess
   * bundle that does not know the message degrades to a host-only summary.
   */
  async requestHeapdump(): Promise<HeapdumpWriteResult | null> {
    if (!this.subprocess) return null;

    const id = `heapdump-${++this.rpcIdCounter}`;
    const timeoutMs = 15_000;

    return new Promise<HeapdumpWriteResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingHeapdumps.delete(id);
        resolve({
          success: false,
          errorMessage: `heapdump timed out after ${Math.floor(timeoutMs / 1000)}s (the subprocess may predate the heapdump message)`,
        });
      }, timeoutMs);

      this.pendingHeapdumps.set(id, {
        resolve: (row) => {
          clearTimeout(timer);
          resolve(row);
        },
      });

      this.send({ type: 'heapdump', id });
    });
  }

  /** Handle heapdump_result from subprocess (R49/f210). */
  private handleHeapdumpResult(msg: Record<string, unknown>): void {
    const id = msg.id as string;
    const pending = this.pendingHeapdumps.get(id);
    if (!pending) return;
    this.pendingHeapdumps.delete(id);
    pending.resolve({
      success: Boolean(msg.success),
      ...(msg.wroteTo === 'desktop' || msg.wroteTo === 'home' ? { wroteTo: msg.wroteTo } : {}),
      ...(typeof msg.snapshotPath === 'string' ? { snapshotPath: msg.snapshotPath } : {}),
      ...(typeof msg.diagnosticsPath === 'string' ? { diagnosticsPath: msg.diagnosticsPath } : {}),
      ...(msg.memory && typeof msg.memory === 'object' ? { memory: msg.memory as HeapdumpWriteResult['memory'] } : {}),
      ...(typeof msg.activeResources === 'number' ? { activeResources: msg.activeResources } : {}),
      ...(typeof msg.errorMessage === 'string' ? { errorMessage: msg.errorMessage } : {}),
    });
  }

  /**
   * P3.43 — the catalogue side of the drift comparison, from the catalogue the
   * session actually has.
   *
   * This read `getModelById(model)?.contextWindow` and nothing else, and
   * `getModelById` is the STATIC Anthropic/Pi registry. Measured 2026-08-29,
   * that registry answers `undefined` for `tgpt/qwen35-397b-a17b-fp8` (the
   * shipped default card's model) and for `pi/fable`, while answering 200 000
   * for `nestor-cloud-code-agent`. So `catalogContextWindow` was undefined for
   * every gateway and BYO model, `contextWindowDriftDiagnostic` returns `null`
   * the moment either side is unknown, and the detector could not fire on the
   * models it exists to watch. An instrument that cannot fire is worse than
   * none: it reads as coverage.
   *
   * The connection's own catalogue is where the real number lives —
   * `fetchNestorModels` stamps `context_window_size` onto it hourly — and it
   * arrives here as `BackendRuntimePayload.customModels`. The gateway table is
   * tier two for the same reason `claude-agent.ts` consults it: a refresh that
   * predates the table, or a hand-edited connection, leaves an entry with no
   * window at all. The static registry stays last, unchanged, for the ids it
   * really does know.
   *
   * The gateway tier is gated on `isNessyGatewayBaseUrl` — the WHOLE-URL match,
   * never `isNestorCliBaseUrl`'s prefix — because a BYO endpoint on the same
   * host under another path may serve a same-named id with a different real
   * window, and this is the same boundary that decides whether `Nestor-Token`
   * may be attached.
   *
   * Deliberately NOT extended to `super()`'s `UsageTracker` seed or
   * `adapter.setContextWindow`: those are the numbers the user's context donut
   * shows, and changing what a session displays is a separate decision from
   * making a silent detector audible. They keep the static-registry seed and
   * are corrected by the runtime snapshot as before.
   */
  private refreshCatalogContextWindow(modelId: string): void {
    const runtime = getBackendRuntime(this.config);
    const resolved = resolveContextWindow({
      modelId,
      providerCatalog: runtime.customModels,
      ...(isNessyGatewayBaseUrl(runtime.baseUrl)
        ? { gatewayPresetWindow: nestorGatewayModelWindow(modelId) }
        : {}),
    });
    this.catalogContextWindow = resolved.contextWindow ?? undefined;
    this.catalogContextWindowSource = resolved.source;
  }

  private logContextWindowDrift(snapshot: ContextUsageSnapshot): void {
    const message = contextWindowDriftDiagnostic({
      provider: 'pi',
      connectionSlug: this.config.connectionSlug,
      modelId: snapshot.modelId ?? this.getModel(),
      catalogContextWindow: this.catalogContextWindow,
      runtimeContextWindow: snapshot.contextWindow,
      catalogSource: this.catalogContextWindowSource,
    });
    if (message) {
      this.debug(message);
    }
  }

  /**
   * P2.299 — Pi compacts on demand, and this is the override that says so at the
   * `BaseAgent.chat` seam. It sits directly above the mechanism that makes it
   * true, as `canDispatchWorkflowCommands` does: the claim and `requestCompact`
   * move together or the biconditional test fails.
   *
   * A `true` here does not answer `/compact`; it lets it through to `chatImpl`,
   * where `runSessionCommand` calls `requestCompact` with the subprocess up.
   */
  protected override canCompactContext(): boolean {
    return true;
  }

  /**
   * Ask subprocess to compact the active session context.
   */
  private async requestCompact(customInstructions?: string): Promise<PiCompactResult | null> {
    await this.ensureSubprocess();
    if (this.capabilityTurnRuntime) await this.syncExecutionManifestForCurrentTurn();
    this.beginContinuationBoundary();

    const id = `compact-${++this.rpcIdCounter}`;
    // GPT-backed Pi compactions on large conversations can legitimately take 60-120s
    // (single blocking OpenAI summary call, no progress stream). 5 min covers realistic
    // cases; truly hung subprocesses are caught by the stdio death watchdog.
    const timeoutMs = this.compactTimeoutMs;

    return new Promise<PiCompactResult | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCompactions.delete(id);
        // UB2.3 (#1060, upstream parity): the deadline both rejects locally AND tells the
        // subprocess to abort — a compaction the host gave up on must not keep running (and
        // its late success then has no pending request to land on).
        this.runTeardownStep('pi compact timeout abort', () => this.send({ type: 'abort' }));
        this.finishContinuationBoundary('failed');
        reject(new Error(`compact timed out after ${Math.floor(timeoutMs / 1000)}s`));
      }, timeoutMs);

      this.pendingCompactions.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      this.send({
        type: 'compact',
        id,
        customInstructions: composePiCompactionInstructions(customInstructions, this.config.getPiCompactionReferences?.()),
      });
    });
  }

  /**
   * Ask subprocess to enable/disable auto-compaction.
   *
   * ## C3.383 — this is not a toggle RPC, and the 15 s it used to get was a
   * budget measured against the wrong work
   *
   * There is exactly ONE caller, the last step of {@link spawnSubprocess}, and
   * the subprocess answers it by CONSTRUCTING THE WHOLE PI SESSION.
   * `pi-agent-server`'s `handleInit` sends `ready` with `sessionId: null` and
   * never calls `ensureSession()`, so `handleSetAutoCompaction`'s own
   * `await ensureSession()` is the first construction there is: the
   * authenticated model registry, the session definition, extension isolation,
   * the `.pi-sessions` sidecar and, on a branch, the fork preflight. None of
   * that is bounded by 15 seconds on a cold start under load, and the rejection
   * propagated out of `spawnSubprocess` and killed the child — measured three
   * times on the packaged build (R7 2026-09-12, then W19-r twice, once on a
   * fresh session's FIRST turn), each time surfacing to the user as
   * *"The background subagent task failed with an error (`set_auto_compaction
   * timed out after 15s`)"*, which reads like an auto-compaction bug and is a
   * bring-up one.
   *
   * **The policy is already durable before this promise settles**, so what is
   * being awaited is the acknowledgement of construction and not the delivery
   * of the setting: `handleSetAutoCompaction` assigns the module-scope
   * `autoCompactionPolicy` synchronously, on the line above its `await`, and
   * the session is created with `compaction: runtimeCompactionSettings(...)`
   * reading that same variable.
   *
   * **Why 300 s and not a bigger idea.** The nearest existing answer in this
   * file is taken rather than a new mechanism invented: the bring-up's OTHER
   * half, `await attempt.ready` in `spawnSubprocess`, carries no timer at all
   * and leans on the stdio death watchdog, and `requestCompact` three methods
   * above pairs the same watchdog with exactly this number for exactly this
   * shape — one blocking subprocess call with no progress stream. A wedged
   * construction is still caught, by the watchdog that catches the other half.
   */
  private async requestSetAutoCompaction(
    policy: NonNullable<BackendConfig['autoCompaction']>,
    protocolAlreadyReady = false,
  ): Promise<boolean> {
    if (!protocolAlreadyReady) await this.ensureSubprocess();

    const id = `set-auto-compaction-${++this.rpcIdCounter}`;
    const timeoutMs = 300_000;

    return new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAutoCompactionToggles.delete(id);
        // Names the work, not the message type: the three sightings above were
        // each read as an auto-compaction defect because the old sentence said
        // `set_auto_compaction` and nothing else.
        reject(new Error(
          `Pi subprocess did not finish building its session within ${Math.floor(timeoutMs / 1000)}s `
          + '(the auto-compaction seed is the call it answers under, and the policy itself was already delivered)',
        ));
      }, timeoutMs);

      this.pendingAutoCompactionToggles.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      this.send({ type: 'set_auto_compaction', id, ...policy });
    });
  }

  /**
   * Ask subprocess to read buffered output from a background shell.
   */
  private async requestBashOutput(shellId: string, offset?: number): Promise<PiBashOutputResult | null> {
    const port = this.config.processSupervisorPort;
    const sessionId = this.config.session?.id || this._sessionId;
    if (!port || !sessionId) throw new Error('pi-process-supervisor-unavailable');
    const result = await port.read({
      sessionKey: { workspaceId: this.config.workspace.id, sessionId },
      handle: shellId,
      cursor: offset,
    });
    return {
      shellId: result.handle,
      output: result.output,
      nextOffset: result.nextCursor,
      isRunning: result.isRunning,
    };
  }

  /** Stop an owner-bound background shell through the existing supervisor. */
  private async requestProcessStop(shellId: string): Promise<void> {
    const port = this.config.processSupervisorPort;
    const sessionId = this.config.session?.id || this._sessionId;
    if (!port || !sessionId) throw new Error('pi-process-supervisor-unavailable');
    await port.stop({
      sessionKey: { workspaceId: this.config.workspace.id, sessionId },
      handle: shellId,
    });
  }

  /**
   * Ask subprocess to refresh runtime-affecting custom endpoint config in-place.
   */
  private async requestRuntimeConfigUpdate(update: BackendRuntimeUpdate): Promise<boolean> {
    if (!this.subprocess) return true;

    const id = `runtime-config-${++this.rpcIdCounter}`;
    const timeoutMs = 15_000;
    const runtime = update.runtime ?? {};

    return new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRuntimeConfigUpdates.delete(id);
        reject(new Error(`update_runtime_config timed out after ${Math.floor(timeoutMs / 1000)}s`));
      }, timeoutMs);

      this.pendingRuntimeConfigUpdates.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      this.send({
        type: 'update_runtime_config',
        id,
        model: update.model,
        miniModel: update.miniModel, // UB12.11 — absent keeps the subprocess's own
        providerType: update.providerType,
        authType: update.authType,
        baseUrl: runtime.baseUrl,
        customEndpoint: runtime.customEndpoint,
        customModels: runtime.customModels,
      });
    });
  }

  /**
   * Ensure branched Pi sessions are backend-ready before first user message.
   * Called by SessionManager during branch creation to avoid creating
   * transcript-only branches without real Pi session context.
   */
  override async ensureBranchReady(): Promise<void> {
    const isBranchedSession = !!this.config.session?.branchFrom?.messageId;
    if (!isBranchedSession) return;

    // Branched sessions must include the composite parent identity for Pi forking.
    if (!this.config.session?.branchFrom?.parent) {
      throw new Error('Pi branch preflight failed: missing branchFrom.parent metadata');
    }

    const sessionId = await this.requestEnsureSessionReady();
    if (!sessionId) {
      throw new Error('Pi branch preflight failed: subprocess did not provide a session ID');
    }

    if (this.piSessionId !== sessionId) {
      this.piSessionId = sessionId;
      this.config.onSdkSessionIdUpdate?.(sessionId);
    }
  }

  private evaluatePreferencesDrift(): AgentEvent | null {
    const wasPinned = this.preferencesDriftState.pinnedPreferencesPrompt !== null;
    const event = evaluatePreferencesDrift(
      this.preferencesDriftState,
      formatPreferencesForPrompt(),
      getCoAuthorPreference()
    );

    if (!wasPinned && this.preferencesDriftState.pinnedPreferencesPrompt) {
      this.debug('[chat] Pinned system prompt components for session consistency');
    } else if (event) {
      this.debug('[chat] Detected drift in: preferences');
    }

    return event;
  }

  /**
   * P6.490 (tier 1, the turn-budget consequence) — the operator's documented
   * agentic-turn ceiling reaches Pi.
   *
   * `env-vars.md#variables`: "`CLAUDE_CODE_MAX_TURNS` | Cap the number of
   * agentic turns when no explicit limit is passed." It bound the claude child
   * (the vendored binary reads it out of the spread environment) and bound
   * nothing here: an absent or zero `maxAgentTurns` meant no cap, so one
   * environment produced a bounded claude session and an unbounded Pi one.
   * The precedence, the parse, the one place we deliberately differ from the page
   * and the Guardian judge's exemption (F1.828) are all in `config/max-agent-turns.ts`.
   */
  private getMaxAgentTurns(): number {
    return capAgentTurnsByChildDefinition(resolveMaxAgentTurns(
      loadConfigDefaults().workspaceDefaults.maxAgentTurns,
      process.env,
      message => this.debug(message),
    ), this.config.piChildMaxTurns, isHostConsultChildConfig(this.config));
  }

  /**
   * The configured fallback CHAIN, in order. `[]` disables fallback.
   *
   * `model-config.md:381` — "The `--fallback-model` flag takes precedence over
   * the `fallbackModel` setting"; the flag reaches this host process through
   * `NESSY_FALLBACK_MODEL` (see `config/fallback-model-chain.ts`), so the two
   * are composed here rather than at the persistence layer, which must keep
   * reporting what is actually on disk.
   */
  private getFallbackModel(): string[] {
    return resolveFallbackModelChain(
      loadConfigDefaults().workspaceDefaults.fallbackModel,
      process.env,
    );
  }

  /**
   * P2.212 — Pi is the runtime that can execute a workflow command, and this is
   * the override that says so at the `BaseAgent.chat` seam.
   *
   * It sits directly above the mechanism that makes it true:
   * `requestWorkflowExecution` sends `workflow_execute` to the subprocess, where
   * the orchestrator's `workflow` tool runs the recipe. Every other backend
   * inherits `false` and is refused before `chatImpl`, so the
   * `[workflow:<name>]` marker cannot reach a model that has no tool for it.
   */
  protected override canDispatchWorkflowCommands(): boolean {
    return true;
  }

  private requestWorkflowExecution(
    invocation: NonNullable<ChatOptions['workflowInvocation']>,
    message: string,
    manifest: PiExecutionManifestV2,
  ): Promise<PiWorkflowExecutionResult> {
    const id = `workflow-${++this.rpcIdCounter}`;
    return new Promise<PiWorkflowExecutionResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingWorkflowExecutions.delete(id);
        reject(new Error('Workflow command execution timed out'));
      }, 30 * 60_000);
      this.pendingWorkflowExecutions.set(id, { resolve, reject, timer });
      try {
        this.send({
          type: 'workflow_execute',
          id,
          invocation,
          message,
          manifestGeneration: manifest.snapshotGeneration,
          manifestHash: manifest.manifestHash,
        });
      } catch (error) {
        this.pendingWorkflowExecutions.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(PiAgent.describeThrown(error)));
      }
    });
  }

  /**
   * P2.298 — Pi is the only runtime that can fork a conversation, and this is
   * the override that says so at the `BaseAgent.chat` seam. Directly above the
   * mechanism, for `canCompactContext`'s reason.
   *
   * `sub-agents.md#fork-the-current-conversation` — "You can start a fork
   * yourself with `/subtask` followed by a task, whether or not fork mode is
   * on." The command is therefore offered on every runtime and must not be
   * withdrawn; the three that inherit `false` answer it honestly at the seam
   * instead of sending the bare `/subtask` to their model as prose.
   *
   * A `true` here does not answer `/subtask`: the fork is an RPC to the
   * subprocess, so it must run in `chatImpl`, after `ensureSubprocess()`.
   */
  protected override canForkConversation(): boolean {
    return true;
  }

  /**
   * `sub-agents.md:1013` — start a conversation fork on the user's behalf. The
   * request resolves as soon as the fork has been admitted, because `:1019`
   * says it "runs in the background while you keep working"; the timeout only
   * bounds the ADMISSION, never the fork's own run.
   */
  private requestSubtaskFork(task: string): Promise<PiSubtaskForkStart> {
    const id = `subtask-${++this.rpcIdCounter}`;
    return new Promise<PiSubtaskForkStart>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingSubtaskForks.delete(id);
        reject(new Error('Starting the fork timed out'));
      }, 60_000);
      this.pendingSubtaskForks.set(id, { resolve, reject, timer });
      try {
        this.send({ type: 'subtask_start', id, task });
      } catch (error) {
        this.pendingSubtaskForks.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(PiAgent.describeThrown(error)));
      }
    });
  }

  /**
   * `skills.md:569` — run a `context: fork` skill in its own named subagent.
   *
   * The request goes to the SUBPROCESS rather than to the host's child-session
   * port directly (which would work, and is what the guardian judge does):
   * background registration lives in the subprocess, so a host-started
   * background child would be unreachable by `stopTask`, invisible in the agents
   * panel, and outside the spawner's concurrency accounting. Same reasoning, and
   * the same plumbing, as `/subtask` — and nothing else in common with it.
   *
   * The timeout bounds the ADMISSION for a background fork, exactly as
   * `/subtask`'s does. A `background: false` fork owes its result to this turn
   * (`:571`), so its bound is the whole run, sized like the workflow command's.
   */
  protected override async startSkillFork(request: SkillForkRequest): Promise<SkillForkOutcome> {
    const id = `skill-fork-${++this.rpcIdCounter}`;
    const timeoutMs = request.background ? 60_000 : 30 * 60_000;
    return new Promise<SkillForkOutcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingSkillForks.delete(id);
        reject(new Error(request.background
          ? 'Starting the forked skill timed out'
          : 'The forked skill did not finish in time'));
      }, timeoutMs);
      this.pendingSkillForks.set(id, { resolve, reject, timer });
      try {
        this.send({
          type: 'skill_fork_start',
          id,
          skillName: request.name,
          ...(request.agent ? { agent: request.agent } : {}),
          ...(request.model ? { model: request.model } : {}),
          prompt: request.prompt,
          background: request.background,
        });
      } catch (error) {
        this.pendingSkillForks.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(PiAgent.describeThrown(error)));
      }
    });
  }

  /**
   * The next entry to try, or null once the chain is exhausted.
   *
   * `model-config.md:385` — "Claude Code tries each entry in order until one
   * accepts it. An entry that can't be reached either … fails over to the next
   * one the same way." The walk therefore resumes at the cursor rather than
   * stopping after one hop, and an entry equal to the model we are already on
   * is skipped per-entry (a chain may name the primary in the middle).
   */
  private getRetryFallbackModel(
    error: FallbackRetryError,
    options?: PiChatOptions,
  ): { modelId: string; index: number } | null {
    if (!FALLBACK_MODEL_RETRY_ERROR_CODES.has(error.code)) {
      return null;
    }

    const chain = this.getFallbackModel();
    const currentModel = this.getModel();
    for (let index = (options?.fallbackChainIndex ?? -1) + 1; index < chain.length; index += 1) {
      const modelId = chain[index]!;
      if (modelId === currentModel) continue;
      return { modelId, index };
    }
    return null;
  }

  private async *retryWithFallbackModel(
    error: FallbackRetryError,
    fallback: { modelId: string; index: number },
    message: string,
    attachments: FileAttachment[] | undefined,
    options: PiChatOptions | undefined,
  ): AsyncGenerator<AgentEvent> {
    const previousModel = this.getModel();
    this.debug(`Retrying Pi turn with fallbackModel=${fallback.modelId} (chain #${fallback.index}) after ${error.code} on ${previousModel}`);
    // Recorded at the FIRST hop, not at turn start: the model in force when the
    // walk began is the one `:364` calls "the primary", and capturing it here
    // means a model the user changed earlier in the same turn is what we return
    // to. Later hops must not overwrite it — that would restore hop one.
    this.fallbackChainPrimaryModel ??= previousModel;
    this.setModel(fallback.modelId);
    this.fallbackChainActiveModel = fallback.modelId;
    // `:364` — "showing a notice when it switches". One notice per HOP, so a
    // three-entry walk is visible as three switches and not as one.
    yield {
      type: 'info',
      message: `Retrying with fallback model ${fallback.modelId} after ${error.title}. Effective model: ${fallback.modelId}`,
    };
    yield* this.chatImpl(message, attachments, {
      ...(options ?? {}),
      fallbackChainIndex: fallback.index,
    } as PiChatOptions);
  }

  /**
   * Run one session command. Both arms end the turn without a model call — the
   * command was an instruction to the session, so there is nothing to prompt.
   *
   * `/compact` lands on the same `requestCompact` the model's own `SlashCommand`
   * path uses (`dispatchSlashCommand`), and both arrive through the same
   * `parseSessionCommand` classifier: the user's typed form and the model's bare
   * form cannot drift apart again.
   */
  private async *runSessionCommand(command: ParsedSessionCommand): AsyncGenerator<AgentEvent> {
    if (command.kind === 'compact') {
      // F1.856 — Pi's nothing-to-compact refusal is an answer, not a failure; every other rejection still throws.
      yield { type: 'status', message: 'Compacting context...' }; // F1.729 — label + Stop: the SDK's compaction_start is not drained here
      const compactResult = await this.requestCompact(command.customInstructions).catch((error: unknown) => {
        if (isPiNothingToCompactRefusal(error)) return error;
        throw error;
      });
      // "Compacted" is load-bearing: SessionManager keys `compaction_complete` off this prefix,
      // and `compactionTrigger: 'manual'` (F1.241) is what lets it mark an Accept & Compact plan ready.
      // The refusal is stamped manual too and is NOT "Compacted…": ready, with no boundary drawn.
      if (compactResult instanceof Error) {
        yield { type: 'info', message: compactResult.message, compactionTrigger: 'manual' };
      } else if (compactResult) {
        yield {
          type: 'info', compactionTrigger: 'manual',
          message: `Compacted context to fit within limits (from ~${compactResult.tokensBefore.toLocaleString()} tokens)`,
        };
      } else {
        yield { type: 'info', message: 'Compacted context to fit within limits', compactionTrigger: 'manual' };
      }
      yield { type: 'complete' };
      return;
    }

    // Defensive arms for the widened union. `/btw` and `/recap` are answered
    // OUT-OF-BAND (the non-persisting `sideQuestion`/`recap` session commands);
    // SessionManager.sendMessage rejects them before a turn exists, so this arm
    // is a backstop for direct callers — the hazard it exists to remove is the
    // fall-through below, which would silently turn a side question into a
    // conversation fork.
    if (command.kind === 'btw' || command.kind === 'recap') {
      yield {
        type: 'info',
        message: command.kind === 'btw'
          ? 'Side questions are answered in the overlay, not in the turn. Use the composer\'s /btw.'
          : 'The session recap is generated out-of-band, not in the turn. Use the composer\'s /recap.',
      };
      yield { type: 'complete' };
      return;
    }
    // `/clear` is executed at the `BaseAgent.chat` seam (clearHistory +
    // onSdkSessionIdCleared) and never reaches this dispatcher; guard anyway so
    // it can never fall into the fork arm if a future refactor moves the seam.
    if (command.kind === 'clear') {
      yield { type: 'info', message: '/clear is handled by the session, not by a turn.' };
      yield { type: 'complete' };
      return;
    }
    // `/heapdump` is executed host-side (`SessionManager.heapdump`, the
    // `heapdump` session command); the renderer intercepts the typed form and
    // `SessionManager.sendMessage` refuses it, so this arm is the same
    // defensive backstop as `/clear` above.
    if (command.kind === 'heapdump') {
      yield { type: 'info', message: '/heapdump is handled by the session, not by a turn. Use the composer\'s /heapdump.' };
      yield { type: 'complete' };
      return;
    }
    // `/quota` is answered at the `BaseAgent.chat` seam by `describeQuota()`
    // and never reaches this dispatcher; the same defensive backstop as
    // `/clear` and `/heapdump` above. NOT optional: the arms below narrow the
    // union BY ELIMINATION down to `subtask`, so a new kind that is not
    // claimed here does not "fall through harmlessly" — it fails the compiler
    // (`command.task` on the widened union), and a cast to silence that would
    // fork a `/quota` into a subtask.
    if (command.kind === 'quota') {
      yield { type: 'info', message: '/quota is answered by the session, not by a turn.' };
      yield { type: 'complete' };
      return;
    }
    // `/help` (P3.158) is answered at the `BaseAgent.chat` seam from the shared
    // command table — the same defensive backstop, and NOT optional for the
    // reason the `/quota` comment above spells out: the arms here narrow the
    // union BY ELIMINATION down to `subtask`, so adding the kind without
    // claiming it fails the compiler on `command.task`, and a cast to silence
    // that would fork a `/help` into a subtask.
    if (command.kind === 'help') {
      yield { type: 'info', message: '/help is answered by the session, not by a turn.' };
      yield { type: 'complete' };
      return;
    }
    // `/advisor` (P2.1) is answered at the `BaseAgent.chat` seam by
    // `describeAdvisor()` — the same defensive backstop, and the same reason it
    // is not optional: the elimination below narrows to `subtask`.
    if (command.kind === 'advisor') {
      yield { type: 'info', message: '/advisor is answered by the session, not by a turn.' };
      yield { type: 'complete' };
      return;
    }
    // `/approve` (P3.25) is answered at the `BaseAgent.chat` seam by
    // `approveGuardianDenial()` — the same defensive backstop, and the
    // elimination below is what MADE this arm mandatory: adding the kind to the
    // union without claiming it here failed the compiler on `command.task`,
    // exactly as the note above promised it would.
    if (command.kind === 'approve') {
      yield { type: 'info', message: '/approve is answered by the session, not by a turn.' };
      yield { type: 'complete' };
      return;
    }

    // P6.410 — `/config` is answered at the `BaseAgent.chat` seam, from ONE host
    // arm over the settings store we already own, so all three runtimes give the
    // same answer. Claimed here for the same reason `/approve` is: the
    // elimination below narrows to `ParsedSubtaskSessionCommand`, and a kind
    // added to the union without an arm here fails the compiler on
    // `command.task` — which is the guard doing its job, not an obstacle.
    if (command.kind === 'config') {
      yield { type: 'info', message: '/config is answered by the session, not by a turn.' };
      yield { type: 'complete' };
      return;
    }
    // P6.106 · same backstop, same reason: `/resume` is answered at the
    // `BaseAgent.chat` seam, and the elimination below needs every non-subtask
    // kind named. The compiler is what made this arm appear.
    if (command.kind === 'resume') {
      yield { type: 'info', message: '/resume is answered by the session, not by a turn.' };
      yield { type: 'complete' };
      return;
    }

    // P6.509 · same backstop, and the same compiler pressure: `/cd` is executed
    // by `SessionManager.sendMessage` before the turn boundary is claimed, and
    // the elimination below narrows to `ParsedSubtaskSessionCommand`, so a kind
    // added to the union without an arm here fails on `command.task`.
    if (command.kind === 'cd') {
      yield { type: 'info', message: '/cd is answered by the session, not by a turn.' };
      yield { type: 'complete' };
      return;
    }

    // P6.881 · the same backstop and the same compiler pressure as `/cd`: the
    // elimination below narrows to `ParsedSubtaskSessionCommand`, so this kind
    // without an arm here would fail on `command.task`.
    if (command.kind === 'branch') {
      yield { type: 'info', message: '/branch is answered by the session, not by a turn.' };
      yield { type: 'complete' };
      return;
    }

    // D1.14 · `/tasks` and `/workflows` are executed by
    // `SessionManager.sendMessage` before the turn boundary is claimed — `/cd`'s
    // and `/branch`'s placement, because both read or mutate host state that no
    // runtime has a turn-level mechanism for. This arm is the defensive backstop
    // a direct caller meets, and it is NOT optional: the elimination below
    // narrows the union to `ParsedSubtaskSessionCommand`, so either of these
    // kinds without an arm here fails the compiler on `command.task`, and a cast
    // to silence that would fork a `/workflows` into a subtask.
    if (command.kind === 'tasks' || command.kind === 'workflows') {
      yield { type: 'info', message: `/${command.kind} is answered by the session, not by a turn.` };
      yield { type: 'complete' };
      return;
    }

    // P6.830 · the four SEAM READS, claimed for exactly the reason the arms
    // above are: `/mcp`, `/diff`, `/hooks` and `/status` are answered at the
    // `BaseAgent.chat` seam and never reach this dispatcher, and the elimination
    // below narrows to `ParsedSubtaskSessionCommand` — so a kind in the union
    // with no arm here fails the compiler on `command.task`, which is what
    // made these four arms appear the moment they joined it. Each is the same
    // defensive backstop for a direct caller.
    if (
      command.kind === 'mcp'
      || command.kind === 'diff'
      || command.kind === 'hooks'
      || command.kind === 'status'
    ) {
      yield { type: 'info', message: `/${command.kind} is answered by the session, not by a turn.` };
      yield { type: 'complete' };
      return;
    }

    // sub-agents.md:1013 — `/subtask <task>` starts a conversation fork. `:1019`
    // — "The fork appears in a panel below your prompt and runs in the
    // background while you keep working" — is why this returns as soon as the
    // fork has started instead of awaiting its result.
    if (!command.task) {
      yield { type: 'info', message: 'Usage: /subtask <task>. The fork inherits this conversation, so a short instruction is enough.' };
      yield { type: 'complete' };
      return;
    }
    try {
      const started = await this.requestSubtaskFork(command.task);
      yield {
        type: 'info',
        message: `Forked this conversation into "${started.name}". It runs in the background; its transcript and controls are in the agents panel below the prompt.`,
      };
    } catch (error) {
      yield {
        type: 'info',
        message: `The fork was not started: ${PiAgent.describeThrown(error)}`,
      };
    }
    yield { type: 'complete' };
  }

  /**
   * `/quota` on the built-in Pi Nessy Gateway connection (T19).
   *
   * The daily budget `GET /api/v1/quota` reports is the per-user `qwen35`-pool
   * limit, and the SAME limiter meters the CLI-proxy routes this card talks
   * through (`cli_proxy_handler.go:109,:205,:286-298`) — so the command that
   * shipped for the remote agent answers here too, off the shared module, with
   * no second renderer.
   *
   * It extends to THAT connection and no other. A Pi connection pointed at a BYO
   * endpoint has no Nestor budget to report, and the `Nestor-Token` this read
   * carries must never travel to a host that was never asked for — so anything
   * whose `baseUrl` is not the gateway CLI prefix falls back to the
   * provider-neutral base answer without making a request at all. The
   * discriminator is `auth/nestor.ts`'s, the same one that gates the header.
   *
   * Deliberately WIDER than the menu that offers the row: the menu predicate
   * `agent/backend/composer-capabilities.ts` symbol `offersNestorQuota` reads
   * the whole-URL rule `isNessyGatewayBaseUrl` (review R1, 2026-09-17) while
   * this override stays on the CLI prefix by DA1.10's written decision — a
   * connection under the prefix but off the chat base is not OFFERED the row
   * and would still be ANSWERED here. One-directional, so the menu can never
   * advertise what this refuses; the inverse is what would be a defect.
   */
  protected override async *describeQuota(): AsyncGenerator<AgentEvent> {
    const baseUrl = getBackendRuntime(this.config).baseUrl;
    if (!isNestorCliBaseUrl(typeof baseUrl === 'string' ? baseUrl : undefined)) {
      yield* super.describeQuota();
      return;
    }
    const { fetchImpl, credsPath } = this.quotaTransport();
    // Stop must cancel the read, exactly as on the remote agent: `/quota`
    // answers at the `BaseAgent.chat` seam and never enters `chatImpl`, so
    // there is no turn `AbortController` to hang off, and
    // `BaseAgent.preModelAbortController` is private. Hence a controller of its
    // own, aborted by every hard-stop path this agent has (`abort`,
    // `forceAbort`, `destroy`, `disposeForRestart`).
    const quotaAbort = new AbortController();
    this.quotaAbortController = quotaAbort;
    try {
      yield* describeNestorQuota({
        fetchImpl,
        ...(credsPath ? { credsPath } : {}),
        baseUrl,
        cancelSignal: quotaAbort.signal,
      });
    } finally {
      if (this.quotaAbortController === quotaAbort) this.quotaAbortController = null;
    }
  }

  /**
   * The quota read's transport and credential source — the seam that keeps the
   * quota tests off the live gateway and out of `~/.nessy/dp_auth_creds.json`.
   */
  protected quotaTransport(): { fetchImpl: typeof fetch; credsPath?: string } {
    return { fetchImpl: fetch };
  }

  // ============================================================
  // Prompt gate (UserPromptSubmit / UserPromptExpansion)
  // ============================================================

  /**
   * Run the prompt-gating hooks and honor their decision BEFORE the prompt is
   * sent to the Pi subprocess.
   *
   * hooks.md § UserPromptSubmit: the event "Runs when the user submits a
   * prompt, before Claude processes it", and a block "prevents the prompt from
   * being processed and erases it from context"; `reason` is "Shown to the user
   * when `decision` is `"block"`". Pi's runtime bridge emits both prompt events
   * from `before_agent_start` — after `send({type:'prompt'})` has already left —
   * so the only place a verdict can still decide anything is here. The
   * subprocess emissions are dropped in `handleLine` so the hook still runs
   * exactly once per turn ("once per turn: `UserPromptSubmit`, `Stop`, and
   * `StopFailure`").
   */
  private async runPiPromptGate(
    prompt: string,
  ): Promise<{ blocked: string } | { additionalContext?: string }> {
    const contexts: string[] = [];
    for (const event of PI_PROMPT_GATE_EVENTS) {
      const outcome = await this.awaitPromptGateDecision(event, { hook_event_name: event, prompt });
      if (outcome === 'timed-out') {
        this.debug(`__HOOK_BLOCK__${JSON.stringify({ event, reason: 'timeout', applied: true })}`);
        return {
          blocked: `A ${event} hook did not answer within ${Math.round(this.promptGateTimeoutMs / 1000)}s, so this prompt was not sent.`,
        };
      }
      if (hookBlockEndsTurn(event) && isBlockingHookDecision(outcome?.decision)) {
        this.debug(`__HOOK_BLOCK__${JSON.stringify({ event, applied: true })}`);
        return { blocked: outcome?.decision?.reason?.trim() || `A ${event} hook blocked this prompt.` };
      }
      // After the block check on purpose: a blocked prompt is "erased from
      // context", so there is no prompt left to name a session after. The loop
      // also runs `UserPromptExpansion`, whose surface carries no `sessionTitle`
      // — the projection already dropped it there.
      await this.applyHookSessionDirectives(outcome?.decision);
      const context = outcome?.decision?.additionalContext?.trim();
      if (context) contexts.push(context);
    }
    return contexts.length > 0 ? { additionalContext: contexts.join('\n\n') } : {};
  }

  /**
   * One prompt-gate emission, bounded by `promptGateTimeoutMs`. A hook that
   * ERRORS resolves `undefined` in the dispatcher and is the documented
   * non-blocking error; only silence past the bound reports `timed-out`.
   */
  private async awaitPromptGateDecision(
    event: AutomationAgentEvent,
    input: SdkAutomationInput,
  ): Promise<AgentEventExecutionResult | undefined | 'timed-out'> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.emitAutomationEvent(event, input),
        new Promise<'timed-out'>(resolve => {
          timer = setTimeout(() => resolve('timed-out'), this.promptGateTimeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  // ============================================================
  // Chat (AsyncGenerator backed by the subprocess event queue)
  // ============================================================

  protected async *chatImpl(
    messageParam: string,
    attachments?: FileAttachment[],
    options?: ChatOptions
  ): AsyncGenerator<AgentEvent> {
    const piOptions = options as PiChatOptions | undefined;
    const ownsModelTurnBudget = piOptions?.fallbackChainIndex === undefined;
    let message = messageParam;
    // Classified from the ORIGINAL message, because the resume-recovery path
    // below prepends context to `message` on a respawn. Dispatched further down,
    // after the subprocess is up and the session-start hooks have run.
    const sessionCommand = parseSessionCommand(messageParam);
    // Reset state for new turn
    this._isProcessing = true;
    this.abortReason = undefined;
    this.stopHookEmittedForTurn = false;
    this.stopFailureHookEmittedForTurn = false;
    this.lastAssistantMessageText = undefined;
    this.resetEventQueueForTurn();
    this.rawEventAttemptTerminal = false;
    if (ownsModelTurnBudget) {
      this.maxPiModelTurnsThisChat = this.getMaxAgentTurns();
      this.piModelTurnsThisChat = 0;
    }
    this.currentUserMessage = message;
    this.resetPreToolHookLoopGuard();
    this.adapter.startTurn();
    const sessionStartSource = this._nextSessionStartSource ?? (this.piSessionId ? 'resume' : 'startup');

    const preferencesDriftEvent = this.evaluatePreferencesDrift();
    if (preferencesDriftEvent) {
      yield preferencesDriftEvent;
    }

    // Refresh session-scoped tool callbacks (for SubmitPlan, source auth, etc.)
    // IMPORTANT: merge (don't replace) so SessionManager-provided browserPaneFns
    // survives across turns.
    const sessionId = this.config.session?.id;
    if (sessionId) {
      mergeSessionScopedToolCallbacks({ workspaceId: this.config.workspace.id, sessionId }, {
        onPlanSubmitted: (planPath) => this.onPlanSubmitted?.(planPath),
        onAuthRequest: (request) => this.onAuthRequest?.(request),
        queryFn: (request) => this.queryLlm(request),
        dispatchSlashCommandFn: (command) => this.dispatchSlashCommand(command),
      });
    }

    try {
      // Ensure subprocess is spawned and ready
      try {
        await this.ensureSubprocess();
      } catch (subprocessError) {
        const errorMsg = PiAgent.describeThrown(subprocessError);
        this.debug(`Failed to spawn Pi subprocess: ${errorMsg}`);

        // If resume failed, clear and try fresh
        if (this.piSessionId && !options?.isRetry) {
          this.piSessionId = null;
          this.killSubprocess({ completeEventQueue: false });
          this.clearSessionForRecovery();

          const recoveryContext = this.buildRecoveryContext();
          if (recoveryContext) {
            message = recoveryContext + message;
            this.debug('Injected recovery context into message');
          }

          await this.ensureSubprocess();
        } else {
          throw subprocessError;
        }
      }

      if (!this._sessionStartHooksApplied) {
        // R85 · the hook env file starts empty once per Pi runtime, here rather
        // than per event: a resumed session re-runs SessionStart with
        // `source: 'resume'`, and hooks.md's documented `>>` would otherwise
        // append a duplicate `export` block on every launch. The post-compaction
        // SessionStart below deliberately does NOT reset — the environment a
        // hook established has to survive a compaction.
        // The same `session?.id || _sessionId` fallback `handleProcessStartRequest`
        // resolves, so the file this truncates is provably the file that is
        // sourced back.
        const hookEnvSessionId = this.config.session?.id || this._sessionId;
        if (hookEnvSessionId) resetHookEnvFile(this.config.workspace.id, hookEnvSessionId);
        const result = await this.emitAutomationEvent('SessionStart', {
          hook_event_name: 'SessionStart',
          source: sessionStartSource,
        });
        this._nextSessionStartSource = undefined;
        this._sessionStartHooksApplied = true;
        this._sessionStartEmitted = true;
        this._sessionEndEmitted = false;
        this._sessionHookContext = result?.decision?.additionalContext?.trim() || undefined;
        this.surfaceSessionStartHookMessage(result);
        // Awaited here, before `syncExecutionManifestForCurrentTurn()` below, so
        // a `reloadSkills` rescan lands in THIS turn's capability manifest —
        // hooks.md:1062's "available in the same session, starting with the
        // first prompt".
        await this.applyHookSessionDirectives(result?.decision);
      }

      // A session command is an instruction to the SESSION, not a prompt, so it
      // must not reach the model. `sessionCommand` was classified from the
      // ORIGINAL message at the top of this method, before the resume-recovery
      // path above may prepend context to `message` — that prefix would hide the
      // command exactly the way the composed turn context did.
      if (sessionCommand) {
        yield* this.runSessionCommand(sessionCommand);
        return;
      }

      // The prompt gate runs here — after the session-command arm (an
      // instruction to the session is not a submitted prompt) and before
      // anything is sent. A block ends the turn with the hook's own reason,
      // which is what hooks.md means by "`reason` … Shown to the user".
      const promptGate = await this.runPiPromptGate(message);
      if ('blocked' in promptGate) {
        yield { type: 'error', message: promptGate.blocked };
        yield { type: 'complete' };
        return;
      }
      // Fenced HERE rather than at the two places it is read, so the workflow
      // dispatch below and `buildTurnUserMessage` cannot drift apart.
      const promptHookContext = fenceHookContext(promptGate.additionalContext);

      const executionManifest = await this.syncExecutionManifestForCurrentTurn();
      if (piOptions?.workflowInvocation) {
        const result = await this.requestWorkflowExecution(
          piOptions.workflowInvocation,
          promptHookContext ? `${promptHookContext}\n\n${message}` : message,
          executionManifest,
        );
        if (result.content) yield { type: 'text_complete', text: result.content };
        yield { type: 'complete' };
        return;
      }

      // Build system prompt
      // :933 — "a subagent runs its own system prompt, so your output style
      // doesn't shape its responses, EXCEPT in a fork". This read used to be
      // unconditional, so every named subagent inherited the style too.
      const turnOutputStyleId = resolveChildOutputStyleId(this.config.piChildKind, getOutputStyleId());
      // `output-styles.md:55` — the nested project walk's stop boundary,
      // derived from the live cwd (the server's canonical project path IS the
      // re-bound cwd, so there is nothing to thread from config).
      const outputStyleProjectRoot = outputStyleProjectRootFor(this.config.session?.workingDirectory);
      const turnPluginOutputStyles = this.pluginOutputStyleSources();
      const baseSystemPrompt = getSystemPrompt(
        this.preferencesDriftState.pinnedPreferencesPrompt ?? undefined,
        this.config.debugMode,
        this.config.workspace.workspaceRootPath,
        this.config.session?.workingDirectory,
        this.config.systemPromptPreset,
        'Nessy Backend', // backendName
        this.preferencesDriftState.pinnedIncludeCoAuthoredBy ?? undefined,
        // sub-agents.md:1041 — a fork's system prompt is "Same as main session".
        // Session-scoped memory is keyed by session id, and a fork's child
        // session is a fresh id with an empty MEMORY.md, so reading its own id
        // here left the fork's prompt as the parent's minus the session-memory
        // block. A NAMED subagent keeps its own id: it "starts from its own
        // definition" (:1036) and is outside the parent's scope.
        resolveMemorySessionId(this.config, this._sessionId),
        turnOutputStyleId,
        this.config.workspace.id,
        this.config.projectTrusted,
        this.capabilityTurnRuntime !== null,
        turnPluginOutputStyles,
        outputStyleProjectRoot
      );
      // `output-styles.md:101` — the per-turn adherence reminder is fed from
      // the SAME child-kind-guarded id the system prompt was composed with, so
      // a named subagent stays reminder-free (:104) while a fork keeps it. A
      // composition with no prose (Default, an unresolvable id, the mini
      // preset which skips styles entirely) clears the label and emits nothing.
      const turnOutputStyle = turnOutputStyleId && this.config.systemPromptPreset !== 'mini'
        ? resolveOutputStyleComposition(turnOutputStyleId, {
            workspaceRootPath: this.config.workspace.workspaceRootPath,
            workingDirectory: this.config.session?.workingDirectory,
            projectTrusted: this.config.projectTrusted,
            ...(turnPluginOutputStyles.length ? { pluginStyles: turnPluginOutputStyles } : {}),
            ...(outputStyleProjectRoot ? { projectRoot: outputStyleProjectRoot } : {}),
          })
        : undefined;
      this.promptBuilder.setActiveOutputStyle(turnOutputStyle?.prompt ? turnOutputStyle.label : null);
      // A spawned child's composed prompt (safety core + context seed + the
      // agent definition's own instructions) is an APPEND to the base prompt —
      // `getSystemPrompt` only reads its `preset` argument as `=== 'mini'`, so
      // passing a child prompt there dropped it. Stable for the session's
      // lifetime, so it stays inside the cacheable system prefix.
      const childSystemPrompt = this.config.childSystemPrompt?.trim();
      // P6.940 (2) — a pinned SESSION agent's instructions land in the same
      // slot, and for the same reason: they are stable for the session's
      // lifetime, so they belong inside the cacheable system prefix. A session
      // is never both a spawned child and a main-thread pin, but the join below
      // is written to survive it rather than to assume it.
      const sessionAgentPrompt = this.config.piSessionAgentPrompt?.trim();
      const composedPrefix = [baseSystemPrompt, childSystemPrompt, sessionAgentPrompt]
        .filter((part): part is string => Boolean(part))
        .join('\n\n');
      const systemPrompt = composePiHarnessPrompt(
        composedPrefix,
        executionManifest,
        this.config.getPiCompactionReferences?.(),
      );

      // A compaction that finished since the last turn ran its
      // `SessionStart`/`compact` hooks on the event stream. Settle that run
      // before composing, so a hook still executing when the user typed still
      // reaches THIS turn instead of silently missing it.
      if (this._postCompactHookEmission) {
        const pending = this._postCompactHookEmission;
        this._postCompactHookEmission = undefined;
        await pending;
      }

      // Build context from sources
      const sourceContext = isHostConsultChildConfig(this.config) ? '' : this.sourceManager.formatSourceState(); // F1.894: a Guardian judge (the F1.892 predicate) composes NO <sources> block — no source's tagline, guide path, MUST-read line or <source_issue> text; its read-only ceiling already blocks every source tool

      const promptModeDiagnostics = getPermissionModeDiagnostics({ workspaceId: this.config.workspace.id, sessionId: this._sessionId })
      this.debug(
        `[ModeSnapshot] sessionId=${this._sessionId} chatPrompt mode=${promptModeDiagnostics.permissionMode} ` +
        `modeVersion=${promptModeDiagnostics.modeVersion} changedBy=${promptModeDiagnostics.lastChangedBy} changedAt=${promptModeDiagnostics.lastChangedAt}`
      )

      // Build context parts using centralized PromptBuilder, split into stable
      // vs volatile (issue #862). Stable blocks (workspace capabilities, working
      // directory) stay in the cached system prefix; volatile blocks (date/time,
      // session_state, source state) ride the user-message tail so a per-turn
      // re-stamp doesn't invalidate the prompt cache. buildVolatileContextParts
      // consumes the one-shot mode-change signal, so it is called exactly once.
      // P6.704 - see the init-message site above.
      const plansFolderPath = resolvePlansDirectory(this.workingDirectory)
        ?? getSessionPlansDir(this.config.workspace.id, this._sessionId);
      const stableParts = this.promptBuilder.buildStableContextParts({ runtimeStatesWorkingDirectory: true }); // F1.907: Pi's own cwd line names the folder
      const volatileParts = this.promptBuilder.buildVolatileContextParts(
        { plansFolderPath, ...(isHostConsultChildConfig(this.config) ? { omitSessionState: true } : {}) }, // F1.743: a Guardian judge (the F1.892 predicate) composes no <session_state>: its own explore mode and explore's guidance were read as the reviewed session's mode, which its task states ("Permission mode: …")
        sourceContext
      );

      // Process attachments
      const attachmentParts: string[] = [];
      const images: Array<{ type: string; data: string; mimeType: string }> = [];
      // P3.364 · attachments whose BYTES never reach the model on this runtime.
      // The pointer alone was the defect: it names a file and invites a `Read`
      // of something undecodable, and no channel said the contents were dropped.
      // Native-first is CLOSED here — pi-ai declares (0.84.2, and re-read
      // unchanged at 0.84.3 by W11-pi 2026-09-11)
      // `input: ("text"|"image")[]`, with the `image` literal as the control that
      // the probe read the union — so this is honest loss, matching the codex
      // half word for word (`codex-agent.ts`, same row) rather than inventing a
      // second sentence for the same fact.
      const uncarriedDocumentNames: string[] = [];
      for (const att of attachments || []) {
        if (att.mimeType?.startsWith('image/') && att.base64) {
          images.push({
            type: 'image',
            data: att.base64,
            mimeType: att.mimeType,
          });
        } else if (att.mimeType?.startsWith('image/') && (att.storedPath || att.path)) {
          attachmentParts.push(`[Attached image: ${att.name}]\n[Stored at: ${att.storedPath || att.path}]`);
        } else if (att.mimeType === 'application/pdf' && att.storedPath) {
          attachmentParts.push(
            `[Attached PDF: ${att.name}]\n[Stored at: ${att.storedPath}]`
            + '\n[Contents NOT available: this runtime carries the path only,'
            + ' and this file is not readable as text.]'
          );
          uncarriedDocumentNames.push(att.name);
        } else if (att.storedPath) {
          let pathInfo = `[Attached file: ${att.name}]\n[Stored at: ${att.storedPath}]`;
          if (att.markdownPath) {
            // A markdown twin IS the contents, so nothing was lost.
            pathInfo += `\n[Markdown version: ${att.markdownPath}]`;
          } else if (att.type === 'office' || att.type === 'audio') {
            pathInfo += '\n[Contents NOT available: this runtime carries the path only,'
              + ' and this file is not readable as text.]';
            uncarriedDocumentNames.push(att.name);
          }
          attachmentParts.push(pathInfo);
        }
      }

      // System prompt carries only stable context (issue #862): the system block
      // is pi-ai's cache prefix before all history, so anything volatile here
      // re-stamps the prefix every turn and drops cacheRead to 0. Volatile blocks
      // ride the user-message tail instead — exactly as the Claude path already
      // does (buildTextPrompt / buildSDKUserMessage append context to the tail).
      const fullSystemPrompt = [
        systemPrompt,
        ...stableParts,
        // P3.279 — the connected MCP servers' own `instructions`, which reached
        // claude and codex and never reached here. Placed after the stable
        // context and before the hook band: it describes the tool surface the
        // manifest above just declared, and it is not hook-authored, so it must
        // not sit inside that band. Session-stable in practice (a server's
        // `initialize` prose does not change while it stays connected), so it
        // rides the cached prefix with the rest of the stable context.
        this.composeMcpServerInstructions(),
        // The SessionStart hook's stdout, and the most trusted band it lands in
        // on any runtime — see {@link fenceHookContext}. `_sessionHookContext`
        // stays RAW in the field and in the serialized session state; the fence
        // is applied where the bytes become model context, so a restored session
        // cannot end up double-wrapped.
        fenceHookContext(this._sessionHookContext),
      ].filter(Boolean).join('\n\n');

      const userMessage = this.buildTurnUserMessage(volatileParts, attachmentParts, message, promptHookContext);

      // P3.364 · said BEFORE the turn goes out, so the user learns the bytes were
      // dropped while the answer is still being written rather than after reading
      // one built on a filename. Worded as codex's twin
      // (`codex-agent.ts`, same row) so one user meets one sentence on both
      // silent runtimes, and it names the runtime that DOES carry the bytes,
      // because that is the action available to them.
      if (uncarriedDocumentNames.length > 0) {
        const names = uncarriedDocumentNames.join(', ');
        this.debug(`[attachments] ${uncarriedDocumentNames.length} document(s) carried to Pi as a path only: ${names}`);
        yield {
          type: 'info',
          level: 'warning',
          message: `Attachment${uncarriedDocumentNames.length === 1 ? '' : 's'} sent as a file path only — the Pi runtime cannot read `
            + `${uncarriedDocumentNames.length === 1 ? 'its' : 'their'} contents, and neither can codex. `
            + `The Claude runtime carries a PDF's bytes to the model: ${names}.`,
        };
      }

      // Send prompt to subprocess
      const turnId = `turn-${++this.rpcIdCounter}`;
      this.send({
        type: 'prompt',
        id: turnId,
        message: userMessage,
        systemPrompt: fullSystemPrompt,
        autoCompactionInstructions: composePiCompactionInstructions(
          undefined,
          this.config.getPiCompactionReferences?.(),
        ),
        manifestGeneration: executionManifest.snapshotGeneration,
        manifestHash: executionManifest.manifestHash,
        images: images.length > 0 ? images : undefined,
        // R18: schema-on-prompt for turn-level structured output. Absent field
        // keeps the wire byte-identical to today.
        ...(options?.outputSchema ? { outputSchema: options.outputSchema } : {}),
      });
      // The composed message is now in the subprocess's conversation, which the
      // SDK re-sends on every later turn — so this generation's pinned block is
      // in context from here until a compaction, a `/clear` or a failed resume
      // drops it. Confirmed HERE and not at composition time: every branch above
      // (blocked prompt hook, failed spawn, workflow dispatch) can end the turn
      // with the message never sent, and those must keep re-sending it.
      this.notePinnedCapabilityContextDelivered();

      // Yield events as they arrive. The source-activation drain controller
      // captures a pending restart on the first triggering tool_result and
      // drains sibling tool_results from the same parallel-tool batch before
      // firing `source_activated` + `forceAbort` — Pi's subprocess only picks
      // up new proxy tools on the next handlePrompt, so the restart is needed
      // here too. Without the drain, sibling tool_results from parallel
      // source_test calls are lost (#790).
      const sourceActivationDrain = new SourceActivationDrainController('fire-on-non-tool-result');
      const maxBudgetUsd = this.getMaxBudgetUsd();
      for await (const event of this.eventQueue.drain()) {
        // Pre-yield check: when we're past capture and the incoming event is
        // not a tool_result, fire BEFORE yielding it (the event belongs to
        // the about-to-be-aborted next turn — letting it through would leak
        // a fragment of the cancelled response into the session journal).
        const preFire = sourceActivationDrain.shouldFireBeforeEvent(event);
        if (preFire) {
          this.debug(`source_test activated "${preFire.sourceSlug}", drained sibling tool_results, restarting turn`);
          yield preFire;
          this.forceAbort(AbortReason.SourceActivated);
          return;
        }

        if (this.exceedsMaxBudgetUsd(event, maxBudgetUsd)) {
          this.debug(`maxBudgetUsd exceeded (${this.sessionCostUsd}/${maxBudgetUsd}); aborting Pi session`);
          // Same shape as the shared base path (base-agent.ts chat()): name the
          // budget on the backend's own complete when that is the breaching
          // event, because sendMessage's chat loop stops at the first complete
          // and a reason appended afterwards would never be read.
          if (event.type === 'complete') {
            yield { ...event, terminalReason: 'max_budget_usd' };
          } else {
            yield event;
            yield { type: 'complete', terminalReason: 'max_budget_usd' };
          }
          this.forceAbort(AbortReason.MaxBudgetUsd);
          return;
        }

        if (event.type === 'typed_error') {
          const fallback = this.getRetryFallbackModel(event.error, piOptions);
          if (fallback) {
            yield* this.retryWithFallbackModel(event.error, fallback, message, attachments, piOptions);
            return;
          }
          this.emitStopFailureHookOnce(event.error);
        }

        // P2.66 — past every branch that can abandon this event, so from here
        // the next statement yields it either way. That is what makes the floor
        // row "delivered" rather than merely "enqueued".
        this.noteDebugSinkFaultRowDelivered(event);

        if (sourceActivationDrain.observe(event, () => this.consumePendingSourceActivationRestart())) {
          yield event;
          continue;
        }

        yield event;
      }

      // Stream-end fallback: queue drained naturally with a captured restart
      // still pending. Fire and return (no further events expected).
      const sourceActivationFireAtEnd = sourceActivationDrain.shouldFireAtBoundary();
      if (sourceActivationFireAtEnd) {
        this.debug(`source_test activated "${sourceActivationFireAtEnd.sourceSlug}", stream ended with pending restart, restarting turn`);
        yield sourceActivationFireAtEnd;
        this.forceAbort(AbortReason.SourceActivated);
        return;
      }

      // F1.628 / F1.1162 — a plan or sign-in handoff, or a user Stop, latched this turn before its `agent_end` could
      // arrive, so no `complete` has carried the model calls it made: one does now (see `handoffUsageComplete`).
      const handoffComplete = this.handoffUsageComplete(maxBudgetUsd);
      if (handoffComplete) yield handoffComplete;
    } catch (error) {
      if (error instanceof Error && typeof error.message === 'string' && error.message.includes('abort')) {
        // A handoff's or a Stop's abort (or any other): the turn is over. F1.628 / F1.1162 — its usage, as above.
        const handoffComplete = this.handoffUsageComplete(this.getMaxBudgetUsd());
        if (handoffComplete) yield handoffComplete;
        return;
      }

      const errorObj = error instanceof Error ? error : new Error(PiAgent.describeThrown(error));
      const typedError = this.parsePiError(errorObj);

      if (typedError.code !== 'unknown_error') {
        const fallback = this.getRetryFallbackModel(typedError, piOptions);
        if (fallback) {
          yield* this.retryWithFallbackModel(typedError, fallback, message, attachments, piOptions);
          return;
        }
        this.emitStopFailureHookOnce(typedError);
        yield { type: 'typed_error', error: typedError };
      } else {
        // The unknown-error branch shows `errorObj.message` to the user, so
        // that string — not the typed error's generic title — is what
        // `:2420`'s "rendered error text shown in the conversation" means here.
        this.emitStopFailureHookOnce(typedError, errorObj.message);
        yield { type: 'error', message: errorObj.message };
      }

      yield { type: 'complete' };
    } finally {
      if (ownsModelTurnBudget) {
        this.maxPiModelTurnsThisChat = 0;
        this.piModelTurnsThisChat = 0;
        // `model-config.md:364`'s turn scope: "The switch lasts for the current
        // turn only, so your next message tries the primary model first again."
        // `setModel` re-forwards `set_model` to the live subprocess, so the next
        // message really does start on the primary; without this the first drain
        // switched the session for good.
        //
        // Only the turn that OWNS the walk restores — a nested re-entry doing it
        // would land hop two back on the primary mid-walk — and it restores ONLY
        // a model this walk itself installed. A model change from anywhere else
        // (the user's picker mid-turn is the reachable one: `updateSessionModel`
        // has no in-flight gate) must survive, so the guard compares against the
        // entry we switched to, not merely against the primary.
        const chainPrimary = this.fallbackChainPrimaryModel;
        if (chainPrimary !== undefined) {
          if (this.getModel() === this.fallbackChainActiveModel && this.getModel() !== chainPrimary) {
            this.debug(`Restoring primary model ${chainPrimary} after a fallback-chain turn`);
            this.setModel(chainPrimary);
          }
          this.fallbackChainPrimaryModel = undefined;
          this.fallbackChainActiveModel = undefined;
        }
      }
      this.emitStopHookOnce();
      // SessionEnd is a session-lifecycle event, not a per-turn one — it fires
      // in destroy()/clearHistory(), never here (chatImpl runs once per prompt).
      this._isProcessing = false;
    }
  }

  // ============================================================
  // Permission Handling
  // ============================================================

  /**
   * Respond to a pending permission request.
   * Permission checking now happens in the main process, so this resolves locally.
   */
  /**
   * P4 outside-root approval: the subprocess suspended one tool call on a path
   * outside the captured scope. Publish a structured permission request; the
   * user's approve/approve-always maps to request/session lifetime. Denial
   * responds null and has no side effect.
   */
  private handleOutsideRootRequest(request: { requestId: string; canonicalTarget: string; access: 'read' | 'write' }): void {
    const judgeRefused = refuseGuardianJudgeCard(this.config, request.canonicalTarget, line => this.debug(line)); // F1.861 + F1.959: the file end
    if (judgeRefused || !this.onPermissionRequest) {
      this.send({ type: 'outside_root_response', requestId: request.requestId, root: null, ...(judgeRefused ? { reason: GUARDIAN_JUDGE_HOST_REFUSAL } : {}) });
      return;
    }
    if (piBypassGrantsOutsideRootRead(this, request)) { // F1.1254 — Bypass: a read is granted for this request, floors kept
      this.send({ type: 'outside_root_response', requestId: request.requestId, root: { canonicalRoot: request.canonicalTarget, access: 'read', receiptId: request.requestId, expires: 'request' } });
      return;
    }
    this.pendingPermissions.set(request.requestId, {
      kind: 'outside_root',
      toolName: request.access === 'write' ? 'Write' : 'Read',
      canonicalTarget: request.canonicalTarget,
      access: request.access,
    });
    this.onPermissionRequest({
      requestId: request.requestId,
      toolName: request.access === 'write' ? 'Write' : 'Read',
      command: request.canonicalTarget,
      description: `Allow ${request.access} access outside the session root: ${request.canonicalTarget}`,
      type: 'outside_root',
    });
  }

  /**
   * F1.957 (origin SIT-ak, RC #3) — the subprocess's `outside_root_cancel`: the tool call that asked ended before an
   * answer (its deadline, "Tool execution timed out", or an abort), so no call waits for this card any more
   * (`pi-agent-server/src/local-tools/outside-root-call-end.ts`). Before this the card stayed on screen after the call
   * and the turn had ended, answerable by nothing. The pending entry is dropped, so a later Allow or Deny sends nothing
   * and adds no root; the card leaves the host with the reason in the log — on the turn in flight as
   * `permission_request_cancelled` (the arm a withdrawn question takes), with no turn through the out-of-turn channel
   * ({@link withdrawElicitationDialog}, F1.369). An id no longer held (answered, or refused by a Stop) is a no-op. A
   * NOTIFICATION like `ask_user_cancel`: nothing is sent back, and a throw stays here (P2.33: the chunk tail survives).
   * A card whose call is still waiting is untouched by a turn's end (F1.900): only the call's own end sends this.
   */
  private handleOutsideRootCancel(req: { requestId: string; reason?: string }): void {
    try {
      const pending = this.pendingPermissions.get(req.requestId);
      if (pending?.kind !== 'outside_root') {
        this.debug(`F1.957: outside-root cancel for ${req.requestId} found no pending card`);
        return;
      }
      this.pendingPermissions.delete(req.requestId);
      const why = req.reason === 'timed_out' ? 'timed out' : 'ended (its deadline or an abort)';
      this.debug(`F1.957: withdrew the outside-root ${pending.access} card for ${pending.canonicalTarget} (${req.requestId}): the tool call that asked ${why} before an answer`);
      if (this._isProcessing) this.eventQueue.enqueue({ type: 'permission_request_cancelled', requestId: req.requestId });
      else this.withdrawElicitationDialog(req.requestId);
    } catch (error) {
      this.debug(`F1.957: outside-root cancel for ${req.requestId} failed: ${PiAgent.describeThrown(error)}`);
    }
  }

  /**
   * P3.272 — the host answers which of a result set's paths the `deniedPaths`
   * floor withholds.
   *
   * `settings-reference.md#exclude-sensitive-files`, verbatim: *"Claude Code
   * excludes matching files from file discovery and search results, denies reads
   * of them, and blocks the Edit and Write tools on the matching paths."* Three
   * promises. The request gate (`getDeniedPathViolation`) delivers the second and
   * third; the FIRST is about the response, and a `grep` rooted one directory
   * above a denied file has a perfectly legal `path` argument. `ea0085113` built
   * the response-side filter and it had no production caller — codex closes this
   * half natively (P3.175, OS-enforced), the 2.1.223 shipped then did NOT deliver
   * its own published clause on claude (P3.174, measured — the vendor repaired it
   * at 2.1.251, which changes nothing here), and Pi's tools are ours end
   * to end, so Pi is the one runtime where the host must run it.
   *
   * ## Why the answer is asked for across the process boundary
   *
   * `denied-result-filter.ts` records the two measurements that decided this, and
   * they are not re-litigated here: importing `mode-manager.ts` into the Pi
   * subprocess costs 8.81 MB over 828 modules against a 112 KB baseline, and that
   * subprocess installs a `permissionManager` whose `evaluateToolCall` THROWS —
   * permission decisions are host-side by recorded design. A SECOND matcher was
   * rejected outright: four defects shipped out of the one compiler in a single
   * day. So the runtime asks in one batch per result set and the host answers with
   * the one matcher, which is the shape `requestOutsideRootApproval` already uses
   * on this wire.
   *
   * ## Why `shouldAllowToolInMode` and not `matchesDeniedPath`
   *
   * `matchesDeniedPath` is private to `mode-manager.ts` and reachable only through
   * this entry, and `denyPathBlocked` is set by exactly one branch of it — the
   * FIRST one, ahead of every mode, allow-list and rule check, which is what makes
   * the floor a floor. `SessionManager.ts` and `codex-agent.ts` already read the
   * floor by that flag; this is the same read, not a new predicate. The mode is
   * passed live rather than pinned to a constant so the call cannot start meaning
   * something else if that ordering ever changes.
   *
   * ALWAYS ANSWERS. A batch that goes unanswered suspends the search that asked,
   * so every failure path sends the empty set — which withholds nothing, i.e. the
   * behaviour before this row, and never the inverse. `denied-result-filter.ts`
   * states why that direction is the safe one: an allowed-subset contract
   * answered wrongly with `[]` would withhold EVERY result of every search.
   */
  private handleDeniedResultPathsRequest(request: { requestId: string; paths: unknown }): void {
    const paths = Array.isArray(request.paths)
      ? request.paths.filter((value): value is string => typeof value === 'string')
      : [];
    const denied: string[] = [];
    if (paths.length > 0) {
      const permissionsContext: PermissionsContext =
        this.permissionManager.getCapabilityPermissionsContext?.() ?? {
          workspaceRootPath: this.config.workspace.workspaceRootPath,
          activeSourceSlugs: Array.from(this.sourceManager.getActiveSlugs()),
        };
      const mode = this.permissionManager.getPermissionMode();
      for (const path of paths) {
        // `Read` with `file_path` is the spelling `extractFileToolTargetPath`
        // reads first, and the deny side of the contract is checked against the
        // Read/Edit rule kinds only — the same pair P3.147's claude mirror emits.
        const verdict = shouldAllowToolInMode('Read', { file_path: path }, mode, { permissionsContext });
        if (verdict.allowed === false && verdict.denyPathBlocked === true) denied.push(path);
      }
    }
    this.send({ type: 'denied_paths_response', requestId: request.requestId, denied });
  }

  respondToPermission(
    requestId: string,
    allowed: boolean,
    alwaysAllow?: boolean,
    options?: { rememberForMinutes?: number; askUserAnswer?: AskUserAnswer; updatedInput?: Record<string, unknown>; comment?: string },
  ): void {
    void alwaysAllow;
    void options?.rememberForMinutes;
    if (this.hostAskUserRequestIds.has(requestId) && this.config.askUserPort) {
      const sessionKey = { workspaceId: this.config.workspace.id, sessionId: this.config.session?.id || this._sessionId };
      const terminal = allowed && options?.askUserAnswer
        ? this.config.askUserPort.answer({ sessionKey, requestId, answer: options.askUserAnswer })
        : this.config.askUserPort.cancel({ sessionKey, requestId });
      void terminal.catch(error => this.debug(`AskUser host terminal failed: ${PiAgent.describeThrown(error)}`));
      return;
    }
    const pending = this.pendingPermissions.get(requestId);
    if (pending) {
      this.pendingPermissions.delete(requestId);
      if (pending.kind === 'outside_root') {
        // Narrowest requested target only; write includes read for this root.
        const root = allowed
          ? {
              canonicalRoot: pending.canonicalTarget,
              access: pending.access,
              receiptId: requestId,
              expires: (alwaysAllow ? 'session' : 'request') as 'session' | 'request',
            }
          : null;
        if (root && root.expires === 'session') this.config.onOutsideRootGranted?.(root);
        // F1.960 — the host's refusal of a host-consult session's request (a judge,
        // or a session beneath one: `SessionManager.insideHostConsult`, whose
        // backend-door Deny hands it as `comment`) reaches the model as F1.959's
        // `reason`, the same no-content header the judge's own door sends. The
        // backend cannot see the parent chain (a session beneath a judge has an
        // ordinary child's config), so the host's text IS the signal: any other
        // Deny note is NOT carried here (owner call, 2026-09-26; the desktop card
        // offers none on this type, `answerNoteOffered`) and keeps the scope
        // sentence. The host's copy is pinned equal to this constant by
        // `guardian-judge-outside-root.test.ts`; a note that spelled it verbatim
        // would only send that same sentence. F1.1040: a plugin hook agent's refusal is carried the same way.
        const hostRefusal = !root && (options?.comment === GUARDIAN_JUDGE_HOST_REFUSAL || options?.comment === PLUGIN_HOOK_AGENT_HOST_REFUSAL) ? options.comment : undefined;
        this.send({ type: 'outside_root_response', requestId, root, ...(hostRefusal ? { reason: hostRefusal } : {}) });
        return;
      }
      if (pending.kind === 'ask_user') {
        if (!allowed) {
          pending.resolve({ error: 'User cancelled the question.' });
          return;
        }

        const answer = options?.askUserAnswer;
        if (!answer) {
          pending.resolve({ error: 'No answer was provided.' });
          return;
        }

        if (answer.type === 'batched') {
          try {
            validateBatchedAskUserAnswer(pending.askUser.questions, answer);
          } catch {
            pending.resolve({ error: 'Invalid batched answer.' });
            return;
          }
          pending.resolve({ answer });
          return;
        }

        if (answer.type === 'option') {
          const expected = pending.askUser.options[answer.optionIndex];
          if (!Number.isInteger(answer.optionIndex) || expected === undefined || answer.value !== expected) {
            pending.resolve({ error: 'Invalid option answer.' });
            return;
          }
          pending.resolve({ answer });
          return;
        }

        if (answer.type === 'free_text') {
          if (!pending.askUser.allowFreeText) {
            pending.resolve({ error: 'Free-text answers are not allowed for this question.' });
            return;
          }
          if (!answer.value.trim()) {
            pending.resolve({ error: 'Free-text answer cannot be empty.' });
            return;
          }
          pending.resolve({ answer: { type: 'free_text', value: answer.value } });
          return;
        }

        pending.resolve({ error: 'Invalid answer type.' });
        return;
      }

      pending.resolve({ allowed, updatedInput: options?.updatedInput });
    }
  }

  // ============================================================
  // Model Forwarding
  // ============================================================

  async updateRuntimeConfig(update: BackendRuntimeUpdate): Promise<boolean> {
    const previousModel = this.getModel();
    const previousRuntime = getBackendRuntime(this.config);
    const previousProviderType = this.config.providerType;
    const nextRuntime: BackendRuntimePayload = { ...previousRuntime, ...(update.runtime ?? {}) };
    const providerType = update.providerType ?? this.config.providerType;

    this.config = {
      ...this.config,
      providerType,
      authType: update.authType ?? this.config.authType,
      model: update.model,
      // UB12.11 — the re-resolved background-tier model (absent = unchanged); the adapter's call_llm default follows below.
      miniModel: update.miniModel ?? this.config.miniModel,
      runtime: nextRuntime,
      /**
       * F1.110 - re-classify the MCP withholding target when the endpoint moves
       * under a live session, which on this runtime it can.
       *
       * D1.425 taught `BaseAgent.setSourceServers` to re-run the MODEL half of
       * the classification on every materialization. This is the other half, and
       * it is pi's alone: `update_runtime_config` carries `baseUrl` (see
       * `packages/shared/AGENTS.md`), `buildRestartRequiredSignature` hashes no
       * endpoint, so a user editing a `pi_compat` connection's URL mid-session
       * keeps the SAME agent object - and, before this line, the verdict
       * classified for the endpoint it no longer points at. codex refuses any
       * update that is not model-only (`codexUpdateIsModelOnly`) and is disposed
       * and recreated through the factory; claude declares no
       * `updateRuntimeConfig` at all. So one line here covers the one runtime
       * that needs it, rather than a rule in `BaseAgent` two backends never run.
       *
       * The derivation is the factory's own, imported rather than re-spelled,
       * and {@link modelTargetForEndpoint} returns the construction verdict
       * UNTOUCHED when the derived URL did not move - so a model-only update, a
       * customModels refresh and an auth-type change are all byte-identical to
       * before this row.
       */
      modelTarget: modelTargetForEndpoint(
        this.config.modelTarget,
        {
          baseUrl: previousRuntime.baseUrl,
          providerType: previousProviderType,
          piAuthProvider: previousRuntime.piAuthProvider,
        },
        { baseUrl: nextRuntime.baseUrl, providerType, piAuthProvider: nextRuntime.piAuthProvider },
        update.model,
      ),
    };
    this._model = update.model;
    this.adapter.setMiniModel(this.config.miniModel);
    this.refreshCatalogContextWindow(update.model);

    if (!this.subprocess) {
      this.emitConfigChangeHook(['authType', 'model', 'providerType', 'runtime']);
      this.debug(`Runtime config updated locally (no subprocess): ${previousModel} → ${update.model}`);
      return true;
    }

    const updated = await this.requestRuntimeConfigUpdate({
      ...update,
      providerType: this.config.providerType,
      authType: this.config.authType,
      runtime: getBackendRuntime(this.config),
    });
    this.emitConfigChangeHook(['authType', 'model', 'providerType', 'runtime']);
    this.debug(`Runtime config refreshed in subprocess: ${previousModel} → ${update.model}`);
    return updated;
  }

  override setModel(model: string): void {
    const previousModel = this.getModel();
    super.setModel(model);
    if (model !== previousModel) this.emitConfigChangeHook(['model']);
    this.refreshCatalogContextWindow(model);
    // Forward to subprocess so it uses the new model on next turn
    if (this.subprocess) {
      this.debug(`Forwarding model change to subprocess: ${previousModel} → ${model}`);
      this.send({ type: 'set_model', model });
    } else {
      this.debug(`Model updated but no subprocess to forward to: ${previousModel} → ${model}`);
    }
  }

  /**
   * C3.167 (QK6) — Pi is the runtime with no plan-mode effort of its own, so the
   * host supplies it here.
   *
   * Measured at HEAD before this was written: `plan_mode_reasoning_effort` is
   * codex's key and nothing in the Pi SDK or in this fork's Pi surface carries a
   * plan-phase effort — Pi has ONE session effort, forwarded as
   * `set_thinking_level`, which is exactly the seam
   * `BaseAgent.applyPlanModeEffort` drives for the length of one turn. claude's
   * plan-mode lever is a model alias rather than an effort and is refused with
   * its reason on the row, so this override is Pi's alone.
   */
  protected override get appliesHostPlanModeEffort(): boolean { return true; }

  protected override get deliversPathScopedActivations(): boolean { return true; }

  override setThinkingLevel(level: ThinkingLevel): void {
    const previousLevel = this.getThinkingLevel();
    super.setThinkingLevel(level);
    // P6.30 · read BACK off the agent rather than forwarding the ARGUMENT.
    // `BaseAgent.setThinkingLevel` may pin the level to the one
    // `CLAUDE_CODE_EFFORT_LEVEL` / `MAX_THINKING_TOKENS=0` names, and forwarding
    // the requested value would send the subprocess a level the host is not
    // using — the host and its own subprocess disagreeing about how hard to
    // think, with nothing anywhere saying so.
    const effectiveLevel = this.getThinkingLevel();
    if (effectiveLevel !== previousLevel) this.emitConfigChangeHook(['thinkingLevel']);
    // Forward to subprocess so it uses the new thinking level on next turn
    if (this.subprocess) {
      this.debug(`Forwarding thinking level change to subprocess: ${previousLevel} → ${effectiveLevel}`);
      this.send({ type: 'set_thinking_level', level: effectiveLevel });
    } else {
      this.debug(`Thinking level updated but no subprocess to forward to: ${previousLevel} → ${effectiveLevel}`);
    }
  }

  // ============================================================
  // Source / MCP Integration
  // ============================================================

  override async setSourceServers(
    mcpServers: Record<string, SdkMcpServerConfig>,
    apiServers: Record<string, unknown>,
    intendedSlugs?: string[],
    // MUST be forwarded: TypeScript accepts a narrower override, so omitting
    // this parameter would silently discard the send path's `awaitConnect:
    // false` and put connect back on the turn's critical path with no error.
    // The same hazard applies to `dpSessionState`: dropping it here would send
    // the materialization back to its `'unavailable'` fallback and evict every
    // DP-bound server, with no type error to catch it.
    options?: { awaitConnect?: boolean; dpSessionState?: 'ready' | 'needs-login' | 'unavailable' }
  ): Promise<void> {
    // BaseAgent.setSourceServers() handles SourceManager state tracking (active slugs) and the McpClientPool sync (MCP + API sources).
    // F1.893 — except for a Guardian judge (the F1.892 predicate): its opted-in built-in dp servers and the administrator's managed servers are folded in AFTER the view F1.889 emptied (`materializeRuntimePoolServers`), so it leases an EMPTY set instead — no server, no server instructions, no pending sign-in reminder. The set is recorded before the pool's first await (never awaited: nothing to connect), and it supersedes the dp preflight's sync under this same leaser.
    if (isHostConsultChildConfig(this.config)) void this.mcpPool?.sync({}, {}, this.config.mcpLeaserId ? { leaserId: this.config.mcpLeaserId } : {}).catch(error => this.debug(`F1.893: the judge's empty MCP reconcile failed: ${error instanceof Error ? error.message : String(error)}`));
    else await super.setSourceServers(mcpServers, apiServers, intendedSlugs, options);

    if (this.subprocess && this.capabilityTurnRuntime) {
      await this.syncExecutionManifestForCurrentTurn();
    }
  }

  // ============================================================
  // Lifecycle
  // ============================================================

  isProcessing(): boolean {
    return this._isProcessing;
  }

  /**
   * The `AgentBackend.abort` member — step-isolated with {@link forceAbort}
   * (P2.360), for the same reason and with the same primitive.
   *
   * The step ordering differs from `forceAbort`'s and is left exactly as it was:
   * here `send({ type: 'abort' })` sits in the MIDDLE, ahead of the manifest
   * clear and the event-queue completion, so on this path a throw skipped the
   * consumer wake-up rather than the subprocess abort. Different skipped tail,
   * same defect, and the belt does not reorder anything.
   */
  async abort(reason?: string): Promise<void> {
    this.runTeardownStep('pi abort pre-model work', () => this.abortPreModelWork(reason));
    // A `/quota` read is in flight only outside a turn, so this is the ONLY
    // path that can end it before its 10s timeout (T19).
    this.runTeardownStep('pi abort quota', () => this.quotaAbortController?.abort());
    this.runTeardownStep('pi abort stop hook', () => this.emitStopHookOnce());
    this.runTeardownStep('pi abort continuation boundary', () => this.finishContinuationBoundary('cancelled'));

    // Deny all pending permissions. F1.1286 — and withdraw an outside-root card as {@link forceAbort} does (F1.1243):
    // this member has no caller today, so a future one must not leave the card counted, durable and re-drivable.
    this.runTeardownStep('pi abort pending permissions', () => {
      for (const [requestId, pending] of this.pendingPermissions) {
        this.cancelPendingPermission(requestId, pending);
        if (pending.kind === 'outside_root') this.withdrawElicitationDialog(requestId);
      }
      this.pendingPermissions.clear();
    });

    // Send abort to subprocess
    this.runTeardownStep('pi abort subprocess abort', () => this.send({ type: 'abort' }));
    this.runTeardownStep('pi abort execution manifest', () => this.clearExecutionManifestAuthority());
    this.rawEventAttemptTerminal = true;
    this.runTeardownStep('pi abort event queue', () => this.eventQueue.complete());

    // Clear bridge cache for this interrupted turn.
    this.preToolMetadataByCallId.clear();
    this.editFeedbackInputByCallId.clear();
    this.pendingEditFeedback.clear();
  }

  /**
   * F1.628 — the `complete` of a turn a plan or sign-in handoff ended, carrying the usage of the model calls it made.
   *
   * `forceAbort(PlanSubmitted | AuthRequest)` latches the raw-event stream and completes the queue, so the subprocess's
   * `agent_end` — the only producer of this turn's usage-bearing `complete` — never reaches the adapter, and the drain
   * returned with nothing: the session totals, the goal record and the budget cap missed every call of the turn (DN-269
   * measured 0 output tokens and 0 USD where the same turn ending through `agent_end` totals 5 and 0.50). The adapter's
   * sum ({@link PiEventAdapter.takeTurnUsage}, F1.1073) is what those calls reported up to the latch. Residue: calls the
   * subprocess still makes after the latch are not seen here (the handoff aborts it since F1.1242, `forceAbort` below).
   *
   * The reason is STAMPED on purpose: `BaseAgent.chat` holds a reason-free `complete` for a model-skill continuation,
   * and continuing after a handoff would re-enter the turn it ended. The host folds a `complete` that arrives after it
   * ended the turn in as usage only (`SessionManager`'s chat loop, F1.573 / F1.628), so the reason parks nothing there.
   * No usage, no event: a handoff before any model call reported keeps the shape it always had.
   *
   * F1.1162 — a user Stop latches the turn the same way (`forceAbort(UserStop)`, from the host's `cancelProcessing`), so
   * a stopped turn's calls were missing from the totals and the goal too; it takes this exit stamped `user_stop` (the
   * value `AbortReason.UserStop` spells, and what keeps `BaseAgent.chat` from continuing the stopped turn). The host
   * already ended that turn but lowers its flag only at the loop exit, so its chat loop folds this `complete` in as
   * usage only while the Stop is pending and still ends the turn as interrupted (`SessionManager`, F1.1162).
   */
  private handoffUsageComplete(maxBudgetUsd: number): AgentEvent | undefined {
    const terminalReason = this.abortReason === AbortReason.PlanSubmitted ? 'plan_submitted' as const
      : this.abortReason === AbortReason.AuthRequest ? 'auth_request' as const
        : this.abortReason === AbortReason.UserStop ? 'user_stop' as const
          : undefined;
    if (!terminalReason) return undefined;
    const usage = this.adapter.takeTurnUsage();
    if (!usage) return undefined;
    const event: AgentEvent = { type: 'complete', usage, terminalReason };
    // Counted by the cap's own accumulator like every `complete` in the drain; the verdict is not acted on, because
    // the handoff already ended this turn. A breach trips the cap at the next priced event.
    this.exceedsMaxBudgetUsd(event, maxBudgetUsd);
    return event;
  }

  /**
   * A user Stop. P2.360 — step-isolated, and this is the path that needed it
   * MOST rather than least, on the frequency argument alone.
   *
   * `SessionManager.cancelProcessing` calls `forceAbort` by name for every user
   * Stop, so this runs orders of magnitude more often than a restart — and
   * unlike `disposeForRestart` it is SYNCHRONOUS, so before this row a throwing
   * step really did take its caller down.
   *
   * THE LAST STATEMENT IS THE ONE THAT MATTERS, exactly as on
   * {@link disposeForRestart}: `send({ type: 'abort' })` is the only thing that
   * tells the Pi subprocess to stop the turn. A throw anywhere above it left the
   * child running the turn the user had just stopped while the UI had already
   * been told it ended — the whole visible state says "stopped" and the tokens
   * keep being spent. `eventQueue.complete()` sits above it too, so a consumer
   * blocked on the queue was never woken either.
   *
   * `runTeardownStep` despite the name, and deliberately. `shared/AGENTS.md`
   * separates a turn abort from a disposal BY NAME, and that separation is about
   * WHAT the path does — this borrows only the ENFORCEMENT primitive, whose
   * whole content is "one step's failure cannot cancel the next" and which
   * reports through the sink-belted `reportDetachedFault`. A second identically
   * bodied helper under an abort-shaped name would be two names for one
   * mechanism, and the next sweep would have to diff them.
   */
  forceAbort(reason: AbortReason): void {
    this.runTeardownStep('pi stop pre-model work', () => this.abortPreModelWork(reason));
    this.runTeardownStep('pi stop quota abort', () => this.quotaAbortController?.abort());
    this.runTeardownStep('pi stop hook', () => this.emitStopHookOnce());
    this.runTeardownStep('pi stop continuation boundary', () => this.finishContinuationBoundary('cancelled'));

    this.abortReason = reason;
    this._isProcessing = false;
    this.rawEventAttemptTerminal = true;
    this.runTeardownStep('pi stop execution manifest', () => this.clearExecutionManifestAuthority());

    // Reject all pending permissions. F1.1243 (CR-B) — an outside-root card also leaves the host (record, durable copy,
    // renderer) through the out-of-turn channel (F1.369): only denying its call left it counted and durable, and after a
    // restart one Allow re-drove the stopped call. Here and on a subprocess exit (F1.1287): only a dispose for a restart keeps R7's re-projection.
    this.runTeardownStep('pi stop pending permissions', () => {
      for (const [requestId, pending] of this.pendingPermissions) {
        this.cancelPendingPermission(requestId, pending);
        if (pending.kind === 'outside_root') this.withdrawElicitationDialog(requestId);
      }
      this.pendingPermissions.clear();
    });

    // Reject all pending tool executions
    this.runTeardownStep('pi stop pending tool executions', () => {
      for (const pending of this.pendingToolExecutions.values()) pending.abort();
      this.pendingToolExecutions.clear();
    });

    // UB2.10 — a DETACHED call survives only the TURN-scoped reasons Claude answers with `interrupt()`, query kept (`UserStop`, `MaxBudgetUsd`;
    // UB12.13 — the `PlanSubmitted`/`AuthRequest` handoffs too): a Stop or a handoff ends the reply, not a background write.
    // Every other reason is session death there — a capability revoke (`InternalError`, the host's revoke-active-snapshot
    // arm) included — so it takes the detached calls too, as the sweep above did before they moved out of its map.
    if (!PI_DETACHED_CALL_SURVIVING_ABORT_REASONS.has(reason)) {
      this.runTeardownStep('pi stop detached tool executions', () => {
        for (const pending of this.detachedToolExecutions.values()) pending.abort();
        this.detachedToolExecutions.clear();
      });
    }

    // UB2.3 (#1058/#1060) — a pending manual compact RPC cannot outlive the turn its /compact
    // was typed in: the rejection is what the waiting `runSessionCommand` catch turns into the
    // turn's error, so a Stop during /compact ANSWERS the turn instead of hanging to the RPC's
    // own deadline. A late `compact_result` from the child then has no pending request to land on.
    this.runTeardownStep('pi stop pending compactions', () => {
      for (const pending of this.pendingCompactions.values()) pending.reject(new Error('Compaction cancelled: the turn was stopped'));
      this.pendingCompactions.clear();
    });

    // Signal turn complete to wake up any waiting consumers
    this.runTeardownStep('pi stop event queue', () => this.eventQueue.complete());

    // Clear bridge cache for aborted turn.
    this.preToolMetadataByCallId.clear();
    this.editFeedbackInputByCallId.clear();
    this.pendingEditFeedback.clear();

    // F1.1242 (CR-A, final sitting 2026-10-01) — EVERY reason aborts the subprocess's run, a PlanSubmitted or AuthRequest
    // handoff too, as Claude's `interruptForHandoff` interrupts its query: left running past the latch, the handed-off
    // run retried SubmitPlan on the cleared manifest and the retry landed in the user's feedback turn as the old plan's
    // card, every feedback tool refused. Its late `agent_end` is dropped by the latch like a Stop's; the calls made up
    // to the latch still count (F1.628). The last statement on purpose (P2.360): a throw above cannot skip it.
    this.runTeardownStep('pi stop subprocess abort', () => this.send({ type: 'abort' }));
  }

  /**
   * Redirect mid-stream via Pi SDK's steer().
   * Delivers the message after the current tool finishes, skips remaining
   * queued tools, and continues with full context intact.
   * Events flow through the existing generator — no abort needed.
   */
  override redirect(message: string): boolean {
    if (this.isCompactionInFlight()) {
      // UB2.3 (COR-3; craft-agents-oss #1058): a manual /compact owns this turn — no agent
      // loop is running to consume a steer, so it would vanish. Refuse WITHOUT aborting the
      // compaction; the session layer queues the message for replay. F1.540 — the refusal
      // disturbed nothing, so the host must not stamp `wasInterrupted` on it.
      this.refusedSteerInterruptedTurn = false;
      this.debug('Steer refused during manual compaction; message must be queued');
      return false;
    }
    if (!this._isProcessing || !this.subprocess) {
      // Not streaming or no subprocess — fall back to abort
      this.refusedSteerInterruptedTurn = true;
      this.forceAbort(AbortReason.Redirect);
      return false;
    }
    this.debug(`Steering mid-stream: "${message.slice(0, 100)}"`);
    this.send({ type: 'steer', message });
    return true;
  }

  /**
   * UB6.13 — `AgentBackend.canSteerNow`: would {@link redirect} steer now rather than refuse or
   * take its abort fallback? Exactly its accepting arm (craft-agents-oss v0.15.1
   * `PiAgent.canSteerNow`, Apache-2.0).
   */
  canSteerNow(): boolean {
    return this._isProcessing && !!this.subprocess && !this.isCompactionInFlight();
  }

  /**
   * F1.540 — `AgentBackend.redirectFallbackInterruptsTurn`, the Pi half: answered for the
   * `redirect` call just made (the host reads it synchronously after a `false`, in the same
   * stretch of `sendMessage`, via `backendInterruptsOnFailedSteer`). `false` for an inert
   * refusal — UB2.3's compaction refusal leaves the /compact running — and `true` only when
   * the abort fallback ran. Before this seam existed on Pi the host read `true` for every
   * refusal.
   */
  redirectFallbackInterruptsTurn(): boolean {
    return this.refusedSteerInterruptedTurn !== false; // unset (no refusal yet) reads as the old `true`
  }

  /** F1.540 — what {@link redirectFallbackInterruptsTurn} answers: the last refused `redirect`'s effect on its turn. */
  private refusedSteerInterruptedTurn = true;

  /** A pending manual compact RPC owns the turn; see `AgentBackend.isCompactionInFlight`. (UB2.3) */
  override isCompactionInFlight(): boolean {
    // `?.` — a bare-prototype rig (`Object.create(PiAgent.prototype)`, the mid-stream
    // tests' shape) has no field initialisers; it has no compaction in flight either.
    return (this.pendingCompactions?.size ?? 0) > 0;
  }

  /** Test seam for the compact RPC deadline (UB2.3; upstream v0.15.1 names the same field). */
  protected compactTimeoutMs = 300_000;

  // ============================================================
  // Session ID overrides — Pi maintains its own subprocess session id
  // ============================================================

  override getSessionId(): string | null {
    return this.piSessionId;
  }

  override setSessionId(sessionId: string | null): void {
    this.piSessionId = sessionId;
  }

  /**
   * P6.106 · Pi's resumable anchor IS `piSessionId` — the subprocess session id
   * the next spawn resumes from (`this.piSessionId = config.session?.sdkSessionId`
   * at construction, and `sessionStartSource` reads `'resume'` off it).
   */
  protected override runtimeSessionAnchor(): string | null {
    return this.piSessionId;
  }

  // UA12.217 — the one-shot spawn posture, BELOW every doc-cited line of this file on purpose.
  // `piStartFreshNextSpawn` is armed by `clearHistory`: the subprocess picks its session by
  // DIRECTORY (`continueRecent`), so a respawn after /clear resumed the pre-clear conversation
  // and the model saw history the user had just cleared (measured 2026-10-09, BK-6,
  // work/bk-6/measure-f1291.ts). `piResumeSessionFile` is armed by `adoptRuntimeSessionAnchor`:
  // the host resolves the /resume id to its own sidecar so the subprocess opens the NAMED file
  // instead of the newest one. Both are consumed by the next init (`takePiResumeInitFields`)
  // and crossed by `setWorkspace` like every session-scoped field.
  private piStartFreshNextSpawn = false;
  private piResumeSessionFile: string | null = null;

  /**
   * UA12.217 — read-and-clear the spawn posture for the init message. One-shot by
   * construction: the first spawn after a /clear (or after a /resume) carries it, and any
   * later respawn of the same chat carries neither field — a plain respawn must keep
   * resuming the conversation by directory.
   */
  private takePiResumeInitFields(): { startFresh?: true; resumeSessionFile?: string } {
    const fields: { startFresh?: true; resumeSessionFile?: string } = {};
    if (this.piStartFreshNextSpawn) {
      fields.startFresh = true;
      this.piStartFreshNextSpawn = false;
    }
    if (this.piResumeSessionFile) {
      fields.resumeSessionFile = this.piResumeSessionFile;
      this.piResumeSessionFile = null;
    }
    return fields;
  }

  /**
   * UA12.217 — resolve a Pi session id to its sidecar under this chat's `.pi-sessions`
   * directory (Pi names files `<timestamp>_<sessionId>.jsonl`), newest mtime first. The
   * host, not the subprocess, owns the lookup, so `/resume` of an id whose file is gone
   * is refused HERE, where the seam can answer honestly, instead of silently opening
   * whatever else is newest in the directory.
   */
  private findNamedPiSessionFile(sessionId: string): string | null {
    if (!sessionId) return null;
    const sessionDir = this.config.session
      ? getSessionDirPath(this.config.workspace.id, this._sessionId)
      : '';
    if (!sessionDir) return null;
    const piSessionsDir = join(sessionDir, '.pi-sessions');
    let entries: string[];
    try {
      entries = readdirSync(piSessionsDir);
    } catch {
      return null;
    }
    const suffix = `_${sessionId}.jsonl`;
    let best: { path: string; mtime: number } | null = null;
    for (const entry of entries) {
      if (!entry.endsWith(suffix)) continue;
      const fullPath = join(piSessionsDir, entry);
      try {
        const mtime = statSync(fullPath).mtimeMs;
        if (!best || mtime > best.mtime) best = { path: fullPath, mtime };
      } catch {
        // A file that vanished between readdir and stat is simply not a candidate.
      }
    }
    return best?.path ?? null;
  }

  protected override async adoptRuntimeSessionAnchor(sessionId: string): Promise<boolean> {
    // UA12.217 — the anchor is adoptable only while its sidecar is still on disk; the
    // resolved file rides the next init as `resumeSessionFile`. (The old comment claimed
    // the next spawn "resumes this id" — no spawn ever saw the id; the subprocess resumed
    // by directory, which is exactly the defect this row closes.)
    const file = this.findNamedPiSessionFile(sessionId);
    if (!file) return false;
    this.piSessionId = sessionId;
    this.piResumeSessionFile = file;
    return true;
  }

  override setWorkspace(workspace: Workspace): void {
    super.setWorkspace(workspace);
    this.piSessionId = null;
    this._sessionToolContext = null;
    // P2.43 — `this.sessionCostUsd = 0` USED TO BE HERE, AND IS GONE ON PURPOSE.
    // The spend ceiling is not a per-conversation counter (see the field's own
    // docstring in `base-agent.ts` for the one rule and the argument for it).
    // The WebSearch budget below IS per-conversation and keeps its reset: it has
    // a documented per-session semantics of its own (tools-reference.md:451) and
    // the two were only ever adjacent, never the same kind of thing. A workspace
    // change is also where the CAP itself changes — `maxBudgetUsd` is a
    // workspace default — so zeroing the spend here handed the user a fresh
    // allowance under a new limit, i.e. the walk-past in its cheapest form.
    this._sessionStartHooksApplied = false;
    this._sessionHookContext = undefined;
    // A workspace change is the OTHER "this is now a different logical session"
    // boundary, and every session-scoped hook field has to cross it the same way
    // it crosses `clearHistory`. Post-compaction context queued in workspace A
    // would otherwise be injected into workspace B's first turn, and a latched
    // `clear` source would report the wrong reason for a session nobody cleared.
    this._pendingCompactHookContext = [];
    // P2.332 — dropping this handle un-awaited is SAFE ONLY BECAUSE the promise
    // is built with its own rejection handler at the `compaction_end` seam; see
    // there. Do not remove that handler and leave these two bare assignments.
    this._postCompactHookEmission = undefined;
    this._nextSessionStartSource = undefined;
    // UA12.217 — a workspace change is the same "different logical session" boundary as
    // above: a /clear (or /resume) posture armed in workspace A must not reach workspace B.
    this.piStartFreshNextSpawn = false;
    this.piResumeSessionFile = null;
    resetPreferencesDriftState(this.preferencesDriftState);
    // R48: same "different logical session" boundary as `sessionCostUsd` above
    // — the WebSearch count must not follow the session across workspaces.
    this.config.onPiWebSearchUsage?.(0);
    this.killSubprocess();
  }

  override async clearHistory(): Promise<void> {
    // hooks.md#sessionend: `clear` is "Session cleared with `/clear` command".
    await this.endLifecycle('clear');
    this.piSessionId = null;
    // UA12.217 — the cleared conversation must not ride back in: the subprocess picks its
    // session by directory (`continueRecent`), so without this one-shot posture the next
    // spawn resumed the pre-clear sidecar. The sidecar stays on disk for /resume.
    this.piStartFreshNextSpawn = true;
    // P2.43 — `this.sessionCostUsd = 0` USED TO BE HERE. Pi was the only runtime
    // that zeroed the spend ceiling on `/clear`; the rule is now one rule for
    // all of them and it is stated on the field in `base-agent.ts`. The
    // WebSearch reset below stays, for the reason written under it.
    this.killSubprocess();
    // tools-reference.md:451 — "Running /clear resets the count" (the session
    // WebSearch budget). The clear signal never reaches the subprocess as a
    // message: killSubprocess() above IS the subprocess half of the reset (the
    // replacement process starts a fresh module-scope budget). This is the
    // host half: zero the remembered total, or the next spawn would re-seed
    // the new budget with the pre-clear count via InitMessage.webSearchesUsed.
    this.config.onPiWebSearchUsage?.(0);
    resetPreferencesDriftState(this.preferencesDriftState);
    this._sessionStartEmitted = false;
    this._sessionEndEmitted = false;
    this._sessionStartHooksApplied = false;
    this._sessionHookContext = undefined;
    this._pendingCompactHookContext = [];
    // P2.332 — dropping this handle un-awaited is SAFE ONLY BECAUSE the promise
    // is built with its own rejection handler at the `compaction_end` seam; see
    // there. Do not remove that handler and leave these two bare assignments.
    this._postCompactHookEmission = undefined;
    // hooks.md#sessionstart: `clear` is the source "after `/clear`". Without the
    // latch the next turn reads a null Pi session id and reports `startup`,
    // which is the source of a session that was never cleared.
    this._nextSessionStartSource = 'clear';
    // F1.1119: the next spawn is seeded from the envelope again, exactly as before.
    this.continuationActivatedTools.clear();
    this.continuationActivatedToolsReported = false;
    super.clearHistory();
    this.debug('History cleared - next chat will start new subprocess');
  }

  /**
   * F1.1119 — the loaded deferred tools a spawning subprocess is seeded with (its init message).
   *
   * The subprocess reports its loaded set after every load and every surface build (`continuation_state`,
   * `publishContinuationState` in `pi-agent-server/src/index.ts`); the persisted continuation envelope is written
   * only at a compaction boundary. A respawn inside this agent (a capability refresh, a crash, a model switch)
   * resumes a conversation that already shows those loads, so it is seeded with the REPORTED set — an empty
   * report included — and the subprocess re-validates every lease against its new catalogue (F1.803/F1.835).
   * Before any report (a new agent after an app restart) and after `/clear`, the envelope seeds it, as before.
   * Residue: an app restart still restores only what the last compaction boundary saved.
   */
  private initContinuationActivatedTools(): readonly CapabilityActivationLeaseV1[] | undefined {
    if (this.continuationActivatedToolsReported) return [...this.continuationActivatedTools.values()].slice(0, 64);
    return this.config.getPiContinuationEnvelope?.()?.activatedTools;
  }

  /**
   * Emit SessionEnd at most once per started logical session.
   *
   * `reason` is the documented exit reason and matcher value
   * (hooks.md#sessionend); `other` is the documented catch-all for every
   * teardown that is not a `/clear`.
   */
  private async emitSessionEndOnce(reason: SessionEndReason): Promise<void> {
    if (this._sessionStartEmitted && !this._sessionEndEmitted) {
      this._sessionEndEmitted = true;
      await this.emitAutomationEvent('SessionEnd', { hook_event_name: 'SessionEnd', reason });
    }
  }

  override async endLifecycle(reason: SessionEndReason = 'other'): Promise<void> {
    await this.emitSessionEndOnce(reason);
    await super.endLifecycle(reason);
  }

  captureLifecycleState(): AgentLifecycleState {
    return {
      sessionStartEmitted: this._sessionStartEmitted,
      sessionEndEmitted: this._sessionEndEmitted,
      sessionStartHooksApplied: this._sessionStartHooksApplied,
      ...(this._sessionHookContext ? { sessionHookContext: this._sessionHookContext } : {}),
      ...(this._pendingCompactHookContext.length > 0
        ? { pendingCompactHookContext: [...this._pendingCompactHookContext] }
        : {}),
      ...this.captureHookSessionDirectives(),
    };
  }

  restoreLifecycleState(state: AgentLifecycleState): void {
    this._sessionStartEmitted = state.sessionStartEmitted;
    this._sessionEndEmitted = state.sessionEndEmitted;
    this._sessionStartHooksApplied = state.sessionStartHooksApplied;
    this._sessionHookContext = state.sessionHookContext;
    this._pendingCompactHookContext = [...(state.pendingCompactHookContext ?? [])];
    this.restoreHookSessionDirectives(state);
  }

  /**
   * Compose one turn's user message: volatile context + attachments + the actual
   * message (the skill read directive is already prepended by
   * `BaseAgent.chat()`). Queued top-level hook-block feedback rides this VOLATILE
   * tail, never the system prefix — it is one-shot per turn, and the system block
   * is pi-ai's cache prefix (#862). CONSUMES the queue, so call it exactly once
   * per turn.
   */
  private buildTurnUserMessage(
    volatileParts: string[],
    attachmentParts: string[],
    message: string,
    // hooks.md § Add context for Claude: for `UserPromptSubmit` and
    // `UserPromptExpansion` the injected text sits "alongside the submitted
    // prompt", so it rides the user tail with the other per-turn context.
    promptHookContext?: string,
  ): string {
    return [
      ...volatileParts,
      // The post-compaction `SessionStart` body is the SAME event and the same
      // field as the system-prefix half, arriving through its own one-shot
      // queue, so it takes the same fence. Its own element rather than a merge
      // with `promptHookContext`: they are separate hook runs, and merging them
      // would move the hook-block feedback that sits between them.
      fenceHookContext(this.consumeCompactHookContext()),
      this.consumeHookBlockFeedback(),
      // P6.864 (YES arm) — the note the user attached to an APPROVAL, drained
      // beside the hook feedback because it is the same one-shot host queue and
      // the same position: a host statement on the user tail, once.
      this.consumePermissionAnswerNotes(),
      promptHookContext,
      ...attachmentParts,
      message,
    ].filter(Boolean).join('\n\n');
  }

  /**
   * hooks-guide.md § Re-inject context after compaction: the guide's only
   * context-injection recipe is a `SessionStart` hook matched on `compact`, and
   * hooks.md#sessionstart lists `compact` — "after compaction" — as one of the
   * five documented `source` values. Nessy only ever emitted `startup`/`resume`,
   * so that recipe could not fire at all.
   *
   * The re-injected text rides the VOLATILE user tail, never `_sessionHookContext`
   * (which is folded into the Pi system prefix). The prefix is pi-ai's cache key
   * before all history: a value that changes on every compaction is volatile by
   * `packages/shared/AGENTS.md`'s own split, and re-stamping the prefix would
   * invalidate the cached prefix on top of the history the compaction already
   * rewrote (#862).
   */
  private async emitPostCompactSessionStart(): Promise<void> {
    const result = await this.emitAutomationEvent('SessionStart', {
      hook_event_name: 'SessionStart',
      source: 'compact',
    });
    this.surfaceSessionStartHookMessage(result);
    const context = result?.decision?.additionalContext?.trim();
    // Repeated compactions between two turns run the same hook again and get the
    // same reminder back. Delivering it N times is noise, not emphasis — the
    // same de-duplication `recordHookBlockFeedback` applies to queued hook
    // feedback for the same reason.
    if (context && !this._pendingCompactHookContext.includes(context)) {
      this._pendingCompactHookContext.push(context);
    }
    // `sessionTitle` is already gone by here — the executor applied
    // hooks.md:1060's source gate to a `compact` input. `reloadSkills` is NOT
    // gated by that sentence, and a hook that installed a skill during
    // compaction still means it.
    await this.applyHookSessionDirectives(result?.decision);
  }

  /**
   * D1.238 — a host-emitted `SessionStart` hook's `systemMessage`, on the one
   * surface this backend already has for it.
   *
   * MEASURED at HEAD before this was built: `systemMessage` occurred ZERO times
   * in this file, against 11 in `codex-agent.ts` and 7 in `claude-agent.ts`. So
   * pi fed the hook's `additionalContext` to the MODEL and discarded its
   * user-facing half — a hook was being RUN with half its output dropped, which
   * is the same shape D1.216 closed on claude one runtime over.
   *
   * `hooks.md#json-output` gives the field one meaning — *"Warning message shown
   * to the user"* — and the `SessionStart` section is not among the several that
   * declare it discarded. The prefix is codex's, character for character
   * (`surfaceHookUserFacingOutput` composes `${event} hook: ${systemMessage}`),
   * and claude's D1.216 is the same string, so one user switching runtimes meets
   * one sentence rather than three spellings of it. No locale key, for the
   * reason D1.216 gives on the same seam: the hook's own text is unlocalisable,
   * so a translated frame around it would be half a sentence in each language.
   *
   * ONE CHANNEL SERVES BOTH EMIT SITES, and the ordering is why rather than a
   * convenience: `resetEventQueueForTurn` runs BEFORE `chatImpl`'s
   * `SessionStart` capture and the drain loop runs AFTER it, so an enqueue at
   * the capture survives to the same turn; `emitPostCompactSessionStart` runs
   * mid-turn, which is the position the runtime-restart notice already enqueues
   * from. A second, claude-style deferred queue would buy nothing here.
   *
   * NOT MIRRORED from codex's helper, recorded rather than dropped: its
   * `continue: false` + `stopReason` arm. `#decision-control` lists
   * `SessionStart` as *"Context only … No blocking or decision control"* while
   * `#json-output` calls `continue` universal and says only that *"some events
   * discard them"* without naming `SessionStart` either way; claude declined it
   * for the same reason, and two hosts declining the same null is the honest
   * state until the page settles it.
   */
  private surfaceSessionStartHookMessage(result: AgentEventExecutionResult | undefined): void {
    const systemMessage = result?.universal?.systemMessage?.trim();
    if (!systemMessage) return;
    this.eventQueue.enqueue({
      type: 'info',
      level: 'warning',
      message: `SessionStart hook: ${systemMessage}`,
    });
  }

  /** Drain the queued post-compaction hook context for exactly one turn. */
  private consumeCompactHookContext(): string | undefined {
    if (this._pendingCompactHookContext.length === 0) return undefined;
    const text = this._pendingCompactHookContext.join('\n\n');
    this._pendingCompactHookContext = [];
    return text;
  }

  /**
   * `AgentBackend.stopHookActive` — the public read of the same
   * consecutive-block streak `recordHookBlockFeedback` maintains.
   *
   * `Stop` reads it inline below because this agent owns that emission site.
   * `SubagentStop` is emitted by the HOST (`SessionManager`), from a site the
   * agent cannot see, so it needs a way in; widening the protected reader is
   * that way, and it keeps both events answering from one counter.
   */
  stopHookActive(event: AutomationAgentEvent): boolean {
    return this.isContinuingFromHookBlock(event);
  }

  /** Emit Stop once for the current turn, including natural completion. */
  private emitStopHookOnce(): void {
    if (this.stopHookEmittedForTurn) return;
    this.stopHookEmittedForTurn = true;
    // hooks.md § Stop: a blocking Stop hook does NOT cancel anything — it feeds
    // its reason back so the agent knows what still needs doing. The turn is
    // already over here, so the reason rides the next turn's user tail.
    void this.emitAutomationEvent('Stop', {
      hook_event_name: 'Stop',
      // `:2190` — true when we are already continuing as a result of a stop
      // hook. Read BEFORE `recordHookBlockFeedback` below updates the streak, so
      // it describes the turn that is ending rather than the one about to start.
      stop_hook_active: this.isContinuingFromHookBlock('Stop'),
      // `:2192` — absent, not empty, when the turn produced no assistant text
      // (an abort before the first message): there is no final response for the
      // field to "contain the text content of".
      ...(this.lastAssistantMessageText !== undefined
        ? { last_assistant_message: this.lastAssistantMessageText }
        : {}),
      // `:2194` — present whenever the registry is reachable, EMPTY rather than
      // absent when nothing is in flight. Read synchronously: this call has to
      // happen before `SessionEnd`'s, and `emitAutomationEvent` orders by call.
      ...hookTaskRegistryInput(this.config.hookTaskRegistryPort),
    })
      .then(result => this.recordHookBlockFeedback('Stop', result))
      // P2.73's class, on a host-initiated emission: a `.then` with no rejection
      // handler is an unhandled rejection for the emit AND for the callback.
      .catch((error: unknown) => this.reportAutomationEventFault('Stop', error));
    // hooks.md:2117 — `TaskCompleted` ALSO fires with no tool call when a turn
    // ends holding in-progress tasks. This is that moment.
    //
    // P2.334 — the ONE site in this file whose failure had no name anywhere.
    // `taskPort` is a HOST port: a rejection here means the turn-end
    // `TaskCompleted` fan-out did not happen, and nothing else in this process
    // observes that promise, so `.catch(() => {})` made a missing hook event
    // indistinguishable from a delivered one. `reportDetachedFault` is belted
    // against a host `onDebug` that throws.
    void this.config.taskPort?.notifyTurnEnd?.()
      .catch((error: unknown) => this.reportDetachedFault('Task turn-end notice', error));
  }

  /**
   * hooks.md:2414 — "StopFailure hooks receive `error`, optional
   * `error_details`, and optional `last_assistant_message`."
   *
   * `error` is a PROJECTION of Nessy's `ErrorCode` onto the documented ten
   * values, not a rename of `error_code`: our `rate_limited` / `service_error`
   * / `invalid_model` are a different vocabulary. `error_code` keeps the raw
   * Nessy value beside it, and the matcher reads `error_code` first, so every
   * existing matcher is byte-identical after this change.
   *
   * `last_assistant_message` is the ONE event where this field is not the
   * model's output — `:2420`, "Unlike `Stop` and `SubagentStop` … for
   * `StopFailure` it contains the API error string itself, such as `"API Error:
   * Rate limit reached"`" — so it carries the rendered error text, never
   * `this.lastAssistantMessageText`.
   */
  private emitStopFailureHookOnce(
    error: string | { code: string; title?: string; message?: string; originalError?: string; details?: string[] },
    renderedText?: string,
  ): void {
    if (this.stopFailureHookEmittedForTurn) return;
    this.stopFailureHookEmittedForTurn = true;
    const typed = typeof error === 'string' ? { code: error } : error;
    // "Additional details about the error, when available" — free text, so it
    // gets a free-text bound rather than the 64-char code slice.
    const errorDetails = typed.originalError ?? (typed.details?.length ? typed.details.join('; ') : undefined);
    // The error string the conversation shows. `title`/`message` are the two
    // halves the renderer displays for a typed error; the plain-error branch
    // passes its own rendered text instead.
    const rendered = renderedText
      ?? (typed.title && typed.message ? `${typed.title}: ${typed.message}` : typed.title ?? typed.message);
    this.emitAutomationEventDetached('StopFailure', {
      hook_event_name: 'StopFailure', lifecycle_version: 1,
      error: toDocumentedStopFailureError(typed.code),
      error_code: typed.code.slice(0, 64),
      ...(errorDetails ? { error_details: errorDetails.slice(0, 1024) } : {}),
      ...(rendered ? { last_assistant_message: rendered.slice(0, 1024) } : {}),
    });
  }

  private emitConfigChangeHook(configKeys: string[]): void {
    const keys = [...new Set(configKeys)].sort();
    void this.emitAutomationEvent('ConfigChange', {
      hook_event_name: 'ConfigChange', lifecycle_version: 1, config_keys: keys,
      config_digest: createHash('sha256').update(keys.join('\0')).digest('hex'),
    }).then(result => {
      // ConfigChange is blockable in the docs, but the config has already been
      // committed by the time this fires (and hooks.md exempts managed
      // `policy_settings` from blocking outright), so the block is advisory: the
      // reason is receipted and reaches the model, not a rollback.
      const reason = result?.decision?.reason;
      if (result?.decision?.decision === 'block' || result?.decision?.decision === 'deny') {
        this.debug(`__HOOK_BLOCK__${JSON.stringify({ event: 'ConfigChange', keys, reason, applied: false })}`);
      }
      this.recordHookBlockFeedback('ConfigChange', result);
    }).catch((error: unknown) => this.reportAutomationEventFault('ConfigChange', error));
  }

  /**
   * hooks.md#notification: the event "Matches on notification type", so the
   * documented `notification_type` is what a matcher reads — `title` and
   * `message` are the human-readable halves and are free text.
   */
  private emitNotificationHook(notificationType: HookNotificationType, title: string, message: string): void {
    this.emitAutomationEventDetached('Notification', {
      hook_event_name: 'Notification',
      notification_type: notificationType,
      title,
      message,
    });
  }

  /**
   * P2.333 — TOTAL, and this override is the one the row's "Pi is immune" line
   * gets most wrong. Pi is immune to the SPECIFIC path the row names
   * (`usageTracker.reset()` through an unbelted `debug`) for two reasons, only
   * one of which the row states: this class belts `debug`, AND it never chains
   * `super.destroy()`, so `usageTracker.reset()` is not on this path at all.
   *
   * Neither of those protects the steps that ARE here. `killSubprocess()`,
   * `stopConfigWatcher()`, `releaseElicitationSurface(...)` and the
   * session-scoped unregister run in sequence with nothing between them, so the
   * first one to throw silently skips the rest — and because this override does
   * not chain `super`, there is no base-class safety net underneath it either.
   */
  destroy(): void {
    // SessionManager awaits this before dispose; direct callers retain fail-soft cleanup.
    // P2.303 · the survivor in a file BOTH P2.73 and P2.76 already swept.
    // `endLifecycle` emits `SessionEnd` through `emitAutomationEvent`, and
    // `destroy()` is sync, so the rejection has nowhere to go without this.
    //
    // Reachability differs here from the other backends and was measured rather
    // than assumed: this class overrides `debug` with a try/catch (P2.66's
    // broken-sink floor, below), so a throwing host sink — the path that makes
    // the same emission reject on `CodexAgent` and `NestorCloudAgent` — cannot
    // reject it here. The handler is still required: it is the emitter's
    // guarantee that is doing the work, one line away from the call site, and
    // "currently unreachable" is not a property a caller can rely on.
    void this.endLifecycle()
      .catch((error: unknown) => this.reportAutomationEventFault('SessionEnd', error));
    this.runTeardownStep('pi quota abort', () => this.quotaAbortController?.abort());
    this.runTeardownStep('pi config watcher', () => this.stopConfigWatcher());
    // This override does not chain super.destroy(), so the base cleanup never
    // runs on the dispose() path either — the elicitation registration has to be
    // released explicitly or it outlives the agent on the shared pool.
    this.runTeardownStep('pi elicitation surface', () =>
      this.releaseElicitationSurface('The session ended before the question was answered.'));

    // Unregister session-scoped tool callbacks
    this.runTeardownStep('pi session-scoped tools', () => {
      if (this.config.session?.id) {
        unregisterSessionScopedToolCallbacks({ workspaceId: this.config.workspace.id, sessionId: this.config.session.id });
      }
    });

    this._sessionToolContext = null;
    // Pool clients are owned by the main process — don't close them here.
    this.runTeardownStep('pi subprocess kill', () => this.killSubprocess());
    this.debug('PiAgent destroyed');
  }

  /**
   * P2.361 — the fourth application of P2.347's belt, and the one with a cost
   * the other three do not have.
   *
   * `SessionManager.disposeManagedAgentRuntime` prefers `disposeForRestart()`
   * whenever a backend defines one, so this — not `destroy()` — is the method a
   * Pi restart actually takes. Its synchronous prologue was a bare sequence, and
   * `killSubprocessGracefully()` was its LAST statement: a throw anywhere above
   * skipped the kill entirely and left the Pi child RESIDENT. That is the
   * distinct cost. A leaked elicitation registration is a record in a map; a
   * leaked Pi subprocess is hundreds of megabytes to a gigabyte of RSS the
   * user's machine notices, and the restart then spawns a SECOND one beside it.
   *
   * MEASURED before the fix against a real child process, with a throwing
   * `stopConfigWatcher()`: `disposeForRestart` rejected and the spawned child
   * was still alive afterwards — `kill(pid, 0)` succeeded, RSS unchanged. With
   * the belt the same scenario reaps it. See
   * `__tests__/fixtures/subprocess-orphan-probe.ts`.
   *
   * The ASYNC half deliberately keeps rejecting, exactly as on Codex and Nestor:
   * `killSubprocessGracefully` throwing `pi-subprocess-termination-unconfirmed`
   * is the signal a quiescence owner acts on, and it RETAINS the captured child
   * for a later retry rather than dropping it. Totality here means "no step can
   * cancel another", not "failures are swallowed".
   */
  async disposeForRestart(): Promise<void> {
    this.runTeardownStep('pi restart quota abort', () => this.quotaAbortController?.abort());
    this.runTeardownStep('pi restart config watcher', () => this.stopConfigWatcher());
    // The teardown SessionManager actually performs. The replacement runtime
    // registers under a FRESH leaser id, so leaving this one attached does not
    // even get overwritten — it accumulates.
    this.runTeardownStep('pi restart elicitation surface', () =>
      this.releaseElicitationSurface('The session runtime restarted before the question was answered.'));

    this.runTeardownStep('pi restart session-scoped tools', () => {
      if (this.config.session?.id) {
        unregisterSessionScopedToolCallbacks({ workspaceId: this.config.workspace.id, sessionId: this.config.session.id });
      }
    });

    this._sessionToolContext = null;
    await this.killSubprocessGracefully();
    this.debug('PiAgent disposed for restart');
  }

  /**
   * Reconnect by killing subprocess -- next chat() will spawn fresh.
   */
  async reconnect(): Promise<void> {
    this.killSubprocess();
    this.debug('PiAgent reconnected (subprocess will be respawned on next chat)');
  }

  /**
   * Gracefully stop the subprocess and wait briefly for the child to exit.
   * Used before an idle runtime restart so we don't leave transient children behind.
   */
  private async killSubprocessGracefully(
    timeoutMs = 2_000,
    forcedTimeoutMs = 1_000,
  ): Promise<void> {
    const error = new Error('Pi subprocess startup cancelled for restart');
    const attempt = this.subprocessAttempt;
    if (attempt) {
      this.cancelSubprocessAttempt(attempt, error);
    }
    this.rejectPendingSubprocessRequests(error);
    // P6.271 half (a) — the notice claude has had and Pi has not.
    //
    // The SDK's own contract for the message we are matching
    // (`SDKWorkerShuttingDownMessage`, rendered by
    // `backend/claude/event-adapter.ts` as `Claude worker is shutting down
    // (<reason>).` at `level:'warning'`) is verbatim: *"Emitted by the bridge on
    // opt-in graceful worker teardown (only when the teardown caller supplied a
    // reason) … Absence is NOT a dead-host signal: handoffs (/update, /teleport,
    // respawn), auto-disable, mode transitions, and internal fatal-error paths
    // emit nothing by design."*
    //
    // Two consequences, both deliberate:
    //  · This is the GRACEFUL teardown site and its only caller is
    //    `disposeForRestart`, so the reason is known statically and is stated.
    //    `killSubprocess()` — abort, reconnect, error recovery, final destroy —
    //    stays SILENT, which is the same shape claude has: an internal
    //    fatal-error path emits nothing.
    //  · Nothing has to be learned here. The signal is HOST-originated
    //    (`this.send({ type: 'shutdown' })` below), so the host already knew and
    //    simply said nothing; the wording is claude's, verbatim but for the
    //    runtime name, so a user switching runtimes reads one sentence.
    //
    // ORDER IS LOAD-BEARING: `EventQueue.drain()` breaks out of its loop as soon
    // as `complete()` has been signalled and the queue is drained, so an enqueue
    // AFTER the line below can be dropped without a trace. It goes first.
    this.eventQueue.enqueue({
      type: 'info',
      level: 'warning',
      message: 'Pi worker is shutting down (runtime_restart).',
    });
    this.eventQueue.complete();

    let child = this.subprocess;
    let readline = this.readline;

    // A detached error/reconnect path may already own a captured child. Retry
    // that exact cleanup first; a failed barrier must never be skipped by a
    // replacement admission or by a later disposal attempt.
    if (this.subprocessTermination || this.pendingSubprocessTerminations.length > 0) {
      await this.awaitSubprocessTerminationBarrier();
      child = this.subprocess;
      readline = this.readline;
    }

    if (!child) {
      this.killSubprocess();
      await this.awaitSubprocessTerminationBarrier();
      return;
    }

    const pid = child.pid;

    try {
      this.send({ type: 'shutdown' });
    } catch {
      // stdin may already be closed
    }

    try {
      await this.terminateCapturedSubprocess(child, readline, timeoutMs, forcedTimeoutMs);
    } catch (terminationError) {
      this.retainCapturedSubprocessTerminationFailure(child, readline, terminationError);
      throw terminationError;
    }

    this.clearCapturedSubprocessReferences(child, readline);
    this.debug(
      `Pi subprocess ${pid ?? '(unknown pid)'} stopped for restart: code=${child.exitCode}, signal=${child.signalCode}`,
    );
  }

  /**
   * Kill the subprocess and clean up resources.
   */
  private killSubprocess(options: { completeEventQueue?: boolean } = {}): void {
    const error = new Error('Pi subprocess startup cancelled');
    const attempt = this.subprocessAttempt;
    const child = this.subprocess;
    const readline = this.readline;
    if (attempt) {
      this.cancelSubprocessAttempt(attempt, error);
    }
    this.rejectPendingSubprocessRequests(error);
    if (options.completeEventQueue !== false) this.eventQueue.complete();
    if (child) {
      // Try graceful shutdown first
      try {
        this.send({ type: 'shutdown' });
      } catch {
        // stdin may already be closed
      }
    }
    if (this.readline === readline) this.readline = null;
    if (this.subprocess === child) this.subprocess = null;
    this.queueCapturedSubprocessTermination(child, readline);

    // (F1.710: no callback port to clear.)
    this.preToolMetadataByCallId.clear();
    this.editFeedbackInputByCallId.clear();
    this.pendingEditFeedback.clear();

    // Clear any in-flight overflow-recovery state so a stale fallback timer
    // doesn't fire on a torn-down adapter.
    this.adapter.resetOverflowState();
  }

  // ============================================================
  // Mini Completion (for title generation + summarization)
  // ============================================================

  /**
   * Run a simple text completion via the subprocess.
   * Sends a mini_completion request and waits for the result.
   */
  async runMiniCompletion(prompt: string): Promise<string | null> {
    // Mini completions run on an ephemeral subprocess session with NO proxy tools (queryLlm
    // in pi-agent-server). A COLD spawn requires AND publishes a capability-turn execution
    // manifest (register_tools), so only a caller HOLDING a capability turn drives one —
    // F1.127: the host's `/recap` does (`withSideChannelAgent`), as `/btw`'s `queryLlm`
    // always has. Title generation fires off-turn (SessionManager.generateTitle) with no
    // turn bound; spawning there surfaced "Pi execution manifest registration requires an
    // active capability runtime" and could race the chat turn's own spawn, so it reuses a
    // subprocess an owning turn spawned (awaiting any in-flight startup), else skips.
    if (!this.subprocess) {
      const attempt = this.subprocessAttempt;
      if (attempt) {
        try {
          await attempt.startup;
        } catch {
          // Owning spawn failed — fall through to the no-subprocess guard below.
        }
      }
      if (!this.subprocess && this.capabilityTurnRuntime) await this.ensureSubprocess();
      if (!this.subprocess) {
        this.debug('[runMiniCompletion] No active Pi subprocess; skipping mini completion');
        return null;
      }
    }

    const id = `mini-${++this.rpcIdCounter}`;
    const text = await new Promise<string | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pendingMiniCompletions.get(id);
        if (!pending) return;
        this.pendingMiniCompletions.delete(id);
        this.debug(`[runMiniCompletion] Timed out after ${LLM_QUERY_TIMEOUT_MS / 1000}s`);
        this.cancelSubprocessEphemeralQuery(id);
        pending.resolve(null);
      }, LLM_QUERY_TIMEOUT_MS);
      this.pendingMiniCompletions.set(id, {
        resolve: value => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: error => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.send({ type: 'mini_completion', id, prompt });
      } catch (error) {
        const pending = this.pendingMiniCompletions.get(id);
        if (!pending) return;
        this.pendingMiniCompletions.delete(id);
        pending.reject(error instanceof Error ? error : new Error(PiAgent.describeThrown(error)));
      }
    });
    this.debug(`[runMiniCompletion] Result: ${text ? `"${text.slice(0, 200)}"` : 'null'}`);
    return text;
  }

  /**
   * Execute an LLM query via the subprocess.
   * Used by session-scoped tool callbacks (call_llm).
   *
   * Sends the full LLMQueryRequest over the `llm_query` RPC so the subprocess's
   * model-aware queryLlm() can honor `request.model`, `request.systemPrompt`,
   * and (transitively via buildCallLlmRequest) `request.outputSchema`.
   * See packages/shared/CLAUDE.md → "queryLlm backend contract" and
   * packages/pi-agent-server/src/index.ts → handleLlmQuery for the invariant.
   */
  async queryLlm(request: LLMQueryRequest): Promise<LLMQueryResult> {
    this.debug('[PiAgent.queryLlm] Starting');

    await this.ensureSubprocess();

    const id = `llm-${++this.rpcIdCounter}`;
    return new Promise<LLMQueryResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pendingLlmQueries.get(id);
        if (!pending) return;
        this.pendingLlmQueries.delete(id);
        this.cancelSubprocessEphemeralQuery(id);
        pending.reject(new Error(`queryLlm timed out after ${LLM_QUERY_TIMEOUT_MS / 1000}s`));
      }, LLM_QUERY_TIMEOUT_MS);
      this.pendingLlmQueries.set(id, {
        resolve: result => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: error => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.send({ type: 'llm_query', id, request });
      } catch (error) {
        const pending = this.pendingLlmQueries.get(id);
        if (!pending) return;
        this.pendingLlmQueries.delete(id);
        pending.reject(error instanceof Error ? error : new Error(PiAgent.describeThrown(error)));
      }
    });
  }

  /**
   * F1.239 — settle a utility-path failure on the ONE request it names. A
   * subprocess build that sends no `id` gets the sweep it always had, but only
   * over the pending requests of the error's own kind.
   */
  private settleUtilityRequestError(
    code: 'mini_completion_error' | 'llm_query_error',
    id: string | undefined,
    message: string,
  ): void {
    const pendings: Map<string, { reject: (error: Error) => void }> = code === 'mini_completion_error'
      ? this.pendingMiniCompletions
      : this.pendingLlmQueries;
    const ids = id === undefined ? [...pendings.keys()] : [id];
    for (const pendingId of ids) {
      const pending = pendings.get(pendingId);
      if (!pending) continue;
      pendings.delete(pendingId);
      pending.reject(new Error(message));
    }
  }

  /**
   * F1.239 — the host gave up on a utility request: tell the subprocess, so its
   * ephemeral session is aborted instead of running on with nobody waiting for
   * it (`cancel_ephemeral_query`, matched by id by the subprocess's coordinator).
   * Best effort — the subprocess may already be gone, and its own deadline
   * (inside this one) is the backstop.
   */
  private cancelSubprocessEphemeralQuery(id: string): void {
    try {
      this.send({ type: 'cancel_ephemeral_query', id });
    } catch (error) {
      this.debug(`[cancel_ephemeral_query] ${id} could not be sent: ${PiAgent.describeThrown(error)}`);
    }
  }

  // ============================================================
  // Helpers
  // ============================================================

  /**
   * Resolve working directory to an absolute path.
   * BaseAgent stores paths with tilde (~) but Node.js spawn doesn't expand tilde.
   */
  private resolvedCwd(): string {
    const wd = this.workingDirectory;
    if (wd.startsWith('~/')) return join(homedir(), wd.slice(2));
    if (wd === '~') return homedir();
    return wd;
  }

  // ============================================================
  // Error Parsing
  // ============================================================

  /**
   * Parse a Pi error into a typed AgentError.
   */
  private parsePiError(error: Error): AgentError {
    const errorMessage = error.message.toLowerCase();
    // F1.932 — a quota refusal first, as in `parseError`; auth errors below.
    if (isQuotaExhaustedText(errorMessage)) return parseError(error);
    if (
      errorMessage.includes('api key') ||
      errorMessage.includes('unauthorized') ||
      errorMessage.includes('401') ||
      errorMessage.includes('authentication')
    ) {
      // For OAuth connections, attempt token refresh before giving up
      if (this.config.authType === 'oauth') {
        this.refreshAndPushTokens().catch(err => {
          // P2.332 sweep — MEASURED, not inferred: the probe scenario
          // `pi:tokenRefreshFault` reported `escapes: ["No default value"]`
          // against this exact line before the change. Floated `.catch`, raw
          // interpolation, unrenderable rejection value.
          this.debug(`Token refresh from parsePiError failed: ${PiAgent.describeThrown(err)}`);
        });
      }

      return {
        code: 'invalid_api_key',
        title: 'Invalid API Key',
        message: 'Your API key was rejected. Check your credentials in Settings.',
        actions: [
          { key: 's', label: 'Update API key', command: '/settings', action: 'settings' },
        ],
        canRetry: this.config.authType === 'oauth',
        originalError: error.message,
      };
    }

    // Rate limiting
    if (
      /\brate(?:[_ -]?limit(?:ed|ing)?)\b/.test(errorMessage)
      || /\b429\b/.test(errorMessage)
      || errorMessage.includes('too many requests')
    ) {
      return {
        code: 'rate_limited',
        title: 'Rate Limited',
        message: 'Too many requests. Please wait a moment before trying again.',
        actions: [
          { key: 'r', label: 'Retry', action: 'retry' },
        ],
        canRetry: true,
        retryDelayMs: 5000,
        originalError: error.message,
      };
    }

    // Service errors
    if (
      errorMessage.includes('500') ||
      errorMessage.includes('502') ||
      errorMessage.includes('503') ||
      errorMessage.includes('service') ||
      errorMessage.includes('overloaded')
    ) {
      return {
        code: 'service_error',
        title: 'Service Error',
        message: 'The AI service is temporarily unavailable. Please try again.',
        actions: [
          { key: 'r', label: 'Retry', action: 'retry' },
        ],
        canRetry: true,
        retryDelayMs: 2000,
        originalError: error.message,
      };
    }

    // Network errors
    if (
      errorMessage.includes('network') ||
      errorMessage.includes('econnrefused') ||
      errorMessage.includes('fetch failed')
    ) {
      return {
        code: 'network_error',
        title: 'Connection Error',
        message: 'Could not connect to the server. Check your internet connection.',
        actions: [
          { key: 'r', label: 'Retry', action: 'retry' },
        ],
        canRetry: true,
        retryDelayMs: 1000,
        originalError: error.message,
      };
    }

    // Fall back to shared error parsing
    return parseError(error);
  }

  // ============================================================
  // Debug
  // ============================================================

  /**
   * P2.54 (M5) — the safeDebug every belt logs through.
   *
   * `onDebug` is HOST-supplied and called synchronously, and every belt in this
   * class reports its fault through it from INSIDE the catch. A throwing sink
   * therefore escaped the catch and the stdout chunk tail was lost anyway —
   * measured. Belting it here, at the one site they all share, is what makes
   * that impossible for the belts written before this task as well as after it;
   * the alternative (a separate helper used only by belts) would have left the
   * ordinary `this.debug` calls INSIDE a case — `case 'error'` opens with one —
   * able to abandon their own case body.
   *
   * Swallowed rather than re-thrown, because a logger that throws is a host bug
   * and the one thing it must not do is cost the traffic it was only supposed to
   * describe.
   *
   * P2.66 — but "swallowed" used to mean SILENT, and that is a hole with a floor
   * available for one line. This sink is where every belt in this class reports;
   * a host whose `onDebug` throws therefore loses every diagnostic the session
   * has, including the fault that broke it, and the session reads as quiet. The
   * only other channel is `surfaceSubprocessFault`'s error row, and that one is
   * dropped downstream whenever no turn is in flight — which is exactly when
   * three of the belted messages (`ready`, `session_id_update`,
   * `ensure_session_ready_result`) arrive. So the FIRST swallow surfaces one row
   * saying a diagnostic was lost. Latched, because a per-swallow row would flood
   * the transcript with the noise the swallow exists to prevent.
   *
   * Note what is NOT claimed: this method keeps calling `onDebug` on every line
   * afterwards, so a sink that recovers resumes logging by itself. The row
   * therefore reports what actually happened — one line was dropped — and says
   * so once. A sink that breaks, recovers and breaks again is deliberately not
   * reported a second time: re-arming on a successful call would make an
   * every-other-line sink emit a row per failure, which is the flood the latch
   * exists to prevent.
   */
  protected override debug(message: string): void {
    try {
      this.onDebug?.(`[pi] ${message}`);
    } catch (error) {
      this.reportBrokenDebugSink(error);
    }
  }

  /**
   * P2.66 — the one-shot floor under {@link debug}'s swallow.
   *
   * Called only from inside that catch, which is itself reached from inside
   * every other belt's catch, so this method may not throw under any input:
   * `describeThrown` is total, `EventQueue.enqueue` is a push plus a resolve,
   * and the outer `try` covers the pair anyway. A failure here has nowhere left
   * to be reported — logging it would call the sink that just threw.
   *
   * The row is REMEMBERED, not just posted: a queue reset would otherwise
   * destroy it unread while the latch stayed spent — see
   * {@link resetEventQueueForTurn}, where it is re-posted until delivered.
   */
  private reportBrokenDebugSink(error: unknown): void {
    if (this.debugSinkFaultSurfaced) return;
    this.debugSinkFaultSurfaced = true;
    try {
      const row: AgentEvent = {
        type: 'error',
        message: `A Pi diagnostic line could not be written to the app's log and was dropped (reported once per session): ${PiAgent.describeThrown(error)}`,
      };
      this.pendingDebugSinkFaultRow = row;
      this.eventQueue.enqueue(row);
    } catch {
      // Nothing left to report with — see above.
    }
  }

  /**
   * F1.930 — is the turn aborting because a handoff THIS turn's own tool call raised?
   * `interruptForHandoff` fires from inside the session tool's own route (SubmitPlan's
   * `onPlanSubmitted`, the auth tools' `onAuthRequest`), so the manifest authority it clears
   * is that call's own doing — {@link handleToolExecuteRequest}'s staleness check lets the
   * call's own success answer instead of reporting a handoff as a stale route. Read only
   * while the aborted turn is still the active one; a new turn resets `abortReason` first.
   */
  private isOwnHandoffAbort(): boolean {
    return this.abortReason === AbortReason.PlanSubmitted || this.abortReason === AbortReason.AuthRequest;
  }
}

/**
 * F1.130 (origin D1.441) — the receipt for a hook-supplied `Bash` session rule,
 * written HONESTLY when the dangerous-command floor will still ask.
 *
 * DECISION (controller, 2026-09-23, under the owner's standing delegation):
 * keep the floor, change the receipt. A `PermissionRequest` hook answering
 * `git push origin main` with `addRules` `Bash(git:*)` stores the session key
 * `git` — a real grant, it covers every NON-dangerous git subcommand — but the
 * floor that asks for `git push` reads the WHOLE COMMAND LINE against the
 * dangerous list (D1.284, D1.291, D1.401; `bashSessionGrantCoversLine`), and no
 * session rule of any width lifts it. The receipt used to say `applied` all the
 * same, so a model told its rule was applied met the same card on the repeat.
 * The floor is not lowered — a session grant overriding a safety floor is the
 * one thing it must not do — so the receipt says what happened: the rule was
 * stored, and the dangerous floor still asks for THIS command.
 *
 * The test is `bashSessionGrantCoversLine` with EVERY key granted: if the line
 * is still not covered, nothing a session rule can store would cover it, which
 * is exactly "the floor still asks". It reads the same splitter and the same
 * dangerous predicate the gate reads, so the receipt cannot disagree with the
 * card. The input is the one the model ISSUED (the handler's `input`, never a
 * sandbox-rewritten or hook-replaced form), because that is the call it repeats.
 * Without the prompting input (the private method's older two-argument
 * callers, and any non-Bash prompt) the receipt is `applied`, as before.
 */
function recordBashSessionRuleReceipt(
  sinks: {
    applied: Array<Record<string, unknown>>;
    deferred: Array<{ code: string; message: string }>;
  },
  receipt: {
    ruleContent: string;
    sessionKey: string;
    toolName: string;
    promptingInput: Record<string, unknown> | undefined;
    isDangerous: (line: string) => boolean;
  },
): void {
  const command = receipt.toolName === 'Bash' && typeof receipt.promptingInput?.command === 'string'
    ? receipt.promptingInput.command.trim()
    : '';
  if (command && bashSessionGrantCoversLine(command, () => true, receipt.isDangerous) === null) {
    // Which floor, named: the splitter's refusal (an unreadable line is never
    // granted) is told apart from the dangerous list by re-asking with the
    // dangerous predicate switched off.
    const floor = bashSessionGrantCoversLine(command, () => true, () => false) === null
      ? 'the line cannot be split into commands, and an unreadable line is never covered by a session rule'
      : 'the dangerous-command floor asks for that command every time, whatever a session rule says';
    sinks.deferred.push({
      code: 'updated_permissions_stored_floor_still_asks',
      message: `Bash rule "${receipt.ruleContent}" was stored as the session key "${receipt.sessionKey}", but it does not lift the prompt for "${command}": ${floor}.`,
    });
    return;
  }
  sinks.applied.push({ type: 'addRules', rule: `Bash(${receipt.ruleContent})`, sessionWhitelist: receipt.sessionKey });
}

/**
 * F1.83 (origin D1.389) — a named Pi child's declared `maxTurns` binds its own
 * agentic loop, through the cap this class already enforces.
 *
 * `sub-agents.md#supported-frontmatter-fields`: `maxTurns` is the "Maximum
 * number of agentic turns before the subagent stops", and
 * `agent-sdk/agent-loop.md#turns-and-messages` says what a turn is: "one round
 * trip inside the loop … Turns continue until Claude produces output with no
 * tool calls". PiAgent counts exactly that — one `turn_start` per model round
 * trip — and force-aborts at N+1 with `terminalReason: 'max_agent_turns'`. The
 * definition's value never reached it: the spawner forwarded it, the host
 * clamped it and stored it on the child's restrictions, and then counted the
 * child's STARTS and RESUMES against it instead (`child-session-service.ts`),
 * so a `maxTurns: "1"` agent ran its whole three-step body (RS-98 on the
 * packaged 1.40.0: six lines against its uncapped twin's three).
 *
 * Native-first, asked before building: the Pi SDK declares no turn limit of its own (`maxTurns`,
 * `max_turns`, `turnLimit`, `maxIterations` score 0 over every `@earendil-works/*` 0.84.4 `dist`), so
 * this host cap is the mechanism and the child's value is the one input it lacked.
 *
 * The LOWER bound wins, because both are ceilings: the operator's `maxAgentTurns` /
 * `CLAUDE_CODE_MAX_TURNS` (0 = off) and the author's `maxTurns`. A child cannot widen past the
 * operator by declaring more, and an operator with no cap does not unbound an author's. ONE
 * exception, F1.828: a Guardian judge (`hostConsult`) keeps its OWN value, never above
 * `GUARDIAN_JUDGE_MAX_TURNS`, and the operator's is not consulted — why: `config/max-agent-turns.ts`.
 */
export function capAgentTurnsByChildDefinition(operatorCap: number, childMaxTurns: number | undefined, hostConsult = false): number {
  if (childMaxTurns === undefined || !Number.isSafeInteger(childMaxTurns) || childMaxTurns < 1) return operatorCap;
  return Math.min(childMaxTurns, hostConsult ? GUARDIAN_JUDGE_MAX_TURNS : operatorCap > 0 ? operatorCap : childMaxTurns);
}

/**
 * F1.320 — the host environment a Pi child inherits, minus the AWS names an
 * IAM connection must not inherit (two since F1.320, three since F1.465).
 *
 * Since F1.242 an `iam` credential is not stored in Pi's credential store; it
 * rides on the child's environment, which `buildAwsEnv` writes at spawn
 * (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, and AWS_SESSION_TOKEN when the
 * connection has one). The child env starts from a spread of the HOST's own, and
 * vendored pi-ai 0.84 (`dist/api/bedrock-converse-stream.js`) then reads two
 * inherited names against the connection:
 *
 * - `AWS_SESSION_TOKEN` — `getConfiguredBedrockCredentials` pairs whatever
 *   session token the env carries with the access key; a stale shell token
 *   beside the connection's long-lived key is a pairing AWS rejects.
 * - `AWS_BEARER_TOKEN_BEDROCK` — read BEFORE any key (`options.bearerToken ||
 *   options.apiKey || AWS_BEARER_TOKEN_BEDROCK`), so an inherited bearer
 *   silently outranks the connection the user configured.
 * - `AWS_BEDROCK_SKIP_AUTH` (F1.465) — `=1` makes pi-ai sign with
 *   `dummy-access-key` and never send a configured key (it exists for proxies
 *   that need no auth), so an inherited flag silently discards the connection.
 *   DECIDED by the same rule as the two above (no page speaks to it): a
 *   connection carrying its own IAM keys is the explicit choice; an ambient
 *   connection keeps the flag, because there the shell's setting IS the
 *   configuration.
 *
 * So when `awsEnv` carries an IAM key the inherited names are dropped here;
 * the connection's own session token, if any, comes back from the `awsEnv`
 * spread after this one ("absent means absent" — `applyRotatedAwsEnv` applies
 * the same rule on rotation). Without an IAM key (an ambient-chain Bedrock
 * connection, any other provider) the host env passes through untouched: those
 * names may BE its credential. The IAM signal is `awsEnv.AWS_ACCESS_KEY_ID`
 * because `buildAwsEnv` writes it for an `iam` credential and for nothing else.
 * A copy is filtered, never `process.env` itself — the Bun env-spread trap
 * (AGENTS.md) concerns writes to `process.env`, and this touches none.
 *
 * Pinned at the SDK, not by a copy of its precedence:
 * `__tests__/pi-bedrock-inherited-aws-env.test.ts` spawns a Bun child with the
 * env this builds and reads the credential vendored pi-ai SENDS, so F1.255's
 * Pi lift re-measures the rule instead of trusting this docblock.
 */
function withoutInheritedIamCompanions(
  processEnv: NodeJS.ProcessEnv,
  awsEnv: Record<string, string>,
): NodeJS.ProcessEnv {
  if (!awsEnv.AWS_ACCESS_KEY_ID) return processEnv;
  const {
    AWS_SESSION_TOKEN: _inheritedSessionToken,
    AWS_BEARER_TOKEN_BEDROCK: _inheritedBearer,
    AWS_BEDROCK_SKIP_AUTH: _inheritedSkipAuth, // F1.465
    ...rest
  } = processEnv;
  return rest;
}

/**
 * F1.545 (origin WJ-au P-WJau-1) — when the Pi child's environment says `AWS_BEDROCK_SKIP_AUTH=1`, the Bedrock
 * bearer the HOST'S SHELL carried is not handed to the child.
 *
 * Vendored pi-ai (0.84.4, and 0.85.1 after F1.255's lift; `dist/api/bedrock-converse-stream.js`) states the flag's meaning in its own code — "Support
 * proxies that don't need authentication" — and refuses its OWN bearer under it (`useBearerToken = bearerToken !==
 * undefined && !skipAuth`). But the AWS SDK beneath pi-ai reads `AWS_BEARER_TOKEN_BEDROCK` from the process
 * environment again and sends it: measured 2026-09-24 (WJ-au, F1.465's run), an ambient-chain connection whose shell
 * carried both names sent `Bearer <the shell's token>` to the endpoint the user declared needs no auth.
 *
 * DECIDED (WJ-bd, the transparent-and-simple rule — no page speaks to it; pi-ai's code is the nearest statement of
 * intent): the host makes pi-ai's rule hold one layer down. The flag is read where the child will read it (the
 * connection's `awsEnv`, then its `envOverrides`, then the inherited env — the spread order above); only the
 * INHERITED bearer is dropped, so a bearer the connection sets itself (`envOverrides`) still rides, and without the
 * flag the inherited bearer passes (for an ambient connection it may BE the credential). A copy is filtered, never
 * `process.env` (the Bun env-spread trap concerns writes). `__tests__/pi-bedrock-skip-auth-bearer.test.ts` reads what
 * vendored pi-ai SENDS, so a pi-ai or AWS SDK lift re-measures the rule.
 */
function withoutSkippedAuthBearer(
  processEnv: NodeJS.ProcessEnv,
  parts: { envOverrides?: Record<string, string>; awsEnv: Record<string, string> },
): NodeJS.ProcessEnv {
  const skipAuth = parts.awsEnv.AWS_BEDROCK_SKIP_AUTH ?? parts.envOverrides?.AWS_BEDROCK_SKIP_AUTH ?? processEnv.AWS_BEDROCK_SKIP_AUTH;
  if (skipAuth !== '1' || processEnv.AWS_BEARER_TOKEN_BEDROCK === undefined) return processEnv;
  const { AWS_BEARER_TOKEN_BEDROCK: _skippedBearer, ...rest } = processEnv;
  return rest;
}

// Alias for consistency with other backend naming
export { PiAgent as PiBackend };

/**
 * F1.727 — the PATH a Pi-requested child start runs under: the host's own PATH,
 * then the directory of the ripgrep this build vendors, then every enabled
 * plugin's `bin/` (the rule `handleProcessStartRequest` cites above its call).
 *
 * WHY THE HOST, NOT THE PI CHILD. Pi's `grep`, `find` and `search_files` are
 * `LocalToolRuntime` operations that run a bare `rg …` through the HOST's process
 * supervisor (`requestSupervisedProcess` in `pi-agent-server` →
 * `handleProcessStartRequest` → `port.start`, which merges this `env` over the
 * host environment). So `rg` is found on THIS value or not at all, whatever the
 * Pi subprocess's own env says. A packaged app runs on the user's login-shell
 * PATH (`apps/electron/src/main/shell-env.ts`), which holds an `rg` only where
 * the user installed one, and the bundle's own copy
 * (`Contents/Resources/app/node_modules/@vscode/ripgrep/bin/rg`, a plain file:
 * `asar: false`) was on no PATH — measured on the 1.41.0 release sitting (SIT-i):
 * `find` answered "This tool requires `rg` … exit 127". 1.40.0 had the same wiring.
 *
 * The binary is the one `resolveBackendHostTooling` gives the session search
 * service — the same file, read by `piDriver.buildRuntime` into
 * `runtime.paths.ripgrep`. `require('@vscode/ripgrep').rgPath` is NOT usable
 * here: the bundle ships no `@vscode/ripgrep-<platform>-<arch>` package, so that
 * resolver throws on the packaged layout (measured on the sitting's bundle).
 *
 * APPENDED, never prepended — the plugin `bin/` rule's reason: a host that
 * already resolves `rg` keeps the one it has (a dev run with a system ripgrep
 * starts byte-identically), and the vendored copy only fills an absence. It sits
 * BEFORE the plugin directories so a plugin cannot supply the host's search
 * binary where the user has none. Returns `undefined` when there is nothing to
 * add, so the caller keeps its "no `PATH` key" shape.
 */
export function piChildStartPath(
  basePath: string | undefined,
  ripgrepPath: string | undefined,
  pluginBundleRoots: Iterable<string>,
): string | undefined {
  const ripgrepDir = ripgrepPath ? dirname(ripgrepPath) : undefined;
  const present = ripgrepDir !== undefined && (basePath ?? '').split(delimiter).includes(ripgrepDir);
  // The host's own value is kept byte for byte (an empty entry included), as `appendPluginBinPath` keeps it.
  const withRipgrep = ripgrepDir && !present ? (basePath ? `${basePath}${delimiter}${ripgrepDir}` : ripgrepDir) : basePath;
  return appendPluginBinPath(withRipgrep, pluginBundleRoots) ?? (withRipgrep === basePath ? undefined : withRipgrep);
}

/**
 * F1.856 — the refusals Pi's own `AgentSession.compact()` throws when `prepareCompaction` finds
 * nothing to summarise: `@earendil-works/pi-coding-agent` 0.85.1, `dist/core/agent-session.js`,
 * the `!preparation` branch — `Already compacted` when the last entry is already a compaction,
 * otherwise `Nothing to compact (session too small)`. Plain `Error`s with no code, forwarded
 * verbatim by `pi-agent-server`'s `handleCompact` as `compact_result.errorMessage`, so the TEXT
 * is the only signal there is. Matched EXACTLY: a failure that merely quotes one ("Compaction
 * failed: …") is still a failure. Re-read the branch when Pi is lifted.
 */
export const PI_NOTHING_TO_COMPACT_REFUSALS = ['Nothing to compact (session too small)', 'Already compacted'] as const;

/** F1.856 — is this `requestCompact` rejection Pi's nothing-to-compact refusal? */
export function isPiNothingToCompactRefusal(error: unknown): error is Error {
  return error instanceof Error && (PI_NOTHING_TO_COMPACT_REFUSALS as readonly string[]).includes(error.message);
}

/**
 * F1.861 — a Guardian safety-judge child never raises a user card of its own.
 * `handleOutsideRootRequest` reads this before it publishes anything: for a
 * judge child it answers `root: null` — the answer a Deny gives — at once, logs
 * one debug line, and shows no card.
 *
 * THE MEASURED DEFECT (release sitting SIT-ae, RC `69a6d33da`, check 3b; Pi
 * `pi-api-key`, Guardian `auto`, `rm -rf ~/sit-ae-danger`): the judge's
 * investigative read of the target was outside the session root, so its Pi
 * subprocess asked for it, this door published it, and the host showed it in the
 * visible parent under the child's name — "Requested by: scout: Judge the
 * following planned action… Command: rm -rf ~/…". The user pressed Deny, which
 * refused only the READ; the judge answered `no_objection` and the `rm` ran with
 * no card. A card whose first line is the destructive command and whose Deny
 * does not deny it.
 *
 * DECIDED (transparent/simple), option (a) of the row, not (b):
 *  (a) the judge never asks: its out-of-root reads are refused silently and it
 *      judges from what it was given. `GUARDIAN_POLICY_PROMPT` already says what
 *      to do then — "If important context is missing and cannot be verified,
 *      lean conservative" and "Emit unsure when … missing evidence you could not
 *      resolve" — and `unsure` sends the ACTION to the human through the
 *      action's OWN card, the card whose Deny does deny it.
 *  (b) "a user Deny of anything raised while judging X is a deny of X" was not
 *      taken: one card would ask two questions (its Allow grants a read, its
 *      Deny refuses a command), and it needs a link from a child's card back to
 *      the parent's in-flight consult that nothing in the tree carries.
 * (a) is also the reference behaviour: codex runs its guardian reviewer "pinned
 * to a read-only sandbox with `approval_policy = never`" because "The guardian
 * itself should not mutate state or trigger further approvals"
 * (`codex-rs/core/src/guardian/review.rs` at `rust-v0.156.1`, the doc comment on
 * `run_guardian_review_session_before_deadline`).
 *
 * NEVER AN AUTO-ALLOW: the refusal widens nothing. The read is refused, no root
 * joins any scope, and the verdict path is untouched — `no_objection`, `deny` and
 * `unsure` mean what the judge said, and every failure is still `unsure`.
 *
 * WHAT THE JUDGE IS TOLD (F1.959): the `root: null` carries `reason` =
 * `GUARDIAN_JUDGE_HOST_REFUSAL` (`prompts/guardian.ts`), the no-content header
 * F1.955 gave the host's own doors, and the subprocess fails the call with it in
 * place of the scope error's sentence — the OpenAI-completions wire drops
 * `isError`, so that text is all a gateway judge reads. Evaluated before the
 * no-door check, so a judge with no card door is told too; an ordinary refusal
 * names no reason and keeps the scope sentence. Measured on the real completions
 * wire by `pi-agent-server/src/__tests__/outside-root-refusal-reason-real-server.test.ts`.
 *
 * IDENTITY — the one `isHostConsultRecord` (`pi-harness/child-session-service.ts`,
 * F1.739) already uses, read off this backend's config: a child whose prompt is
 * LED by `GUARDIAN_POLICY_PROMPT`. The host judge port
 * (`SessionManager.createGuardianJudgePort`) starts the judge with that text as
 * `restrictions.prompt`, the host child port only APPENDS to it, and the host
 * hands it to this backend as `childSystemPrompt`. A model never chooses a
 * child's prompt, and a prompt that merely quotes the policy is not led by it. A
 * workspace agent whose own body begins with the same text would also be refused
 * outside-root reads — a narrowing, never a widening. A fork's child prompt is
 * the empty string, so every fork, every subagent and every top-level session
 * asks exactly as before.
 *
 * RESIDUE, corrected by F1.920: this is NOT the only card a judge child can raise
 * — a readable-DSL `ask` match on its in-root read, a PreToolUse hook's `ask` and
 * a plugin command hook's own card all reached the user — so the HOST refuses every
 * request from a host-consult child (`SessionManager.insideHostConsult`); this stays
 * the early door. A judge run through `pi-agent-server`'s `runGuardianJudge` would
 * arrive here under the PARENT's config; that runner has no production caller.
 * `server-core/src/sessions/__tests__/guardian-judge-outside-root.test.ts` drives
 * the real judge port, so a change to how the judge's prompt is built goes red there.
 */
function refuseGuardianJudgeCard(
  config: { childSystemPrompt?: string },
  canonicalTarget: string,
  debug: (line: string) => void,
): boolean {
  if (!isHostConsultChildConfig(config)) return false; // F1.892: the one predicate (base-agent.ts), which both skill selections ask too (model-side; user-origin since F1.1115)
  debug(`F1.861: refused a Guardian judge's read outside the session root without a card: ${canonicalTarget}`);
  return true;
}

/**
 * F1.902 — the command a Pi readable-rule `ask` card asks about.
 *
 * SIT-ac (packaged RC `69a6d33da`): over a call the gate itself would have run,
 * the readable permission DSL's `ask` match is what raises the card, in
 * `handlePreToolUseRequest`, and that card carried the rule sentence and NO
 * `command` — the whole visible card was "Permission required · Tool: Bash ·
 * Bash requires approval by readable permission policy rule
 * `Bash(echo SITAC-ASK:*)` (workspace scope)." and its buttons, on the main
 * thread and on both child cards. Every hop after the builder forwards `command`
 * verbatim (the permission service, the host's `requestPiToolApproval`, the
 * renderer's command preview), so the builder was the one place it was missing.
 *
 * The value is the one a no-rule card of the same call shows, read the way the
 * gate reads it: a shell `command` for a shell call, else the DSL's own path
 * parameter (`rawDslInputPath` — the value a path rule tested; undefined when two
 * path parameters disagree), else the tool name, which is the gate's generic
 * fallback and claude's host ask-rule card's (`claudeReadablePermissionAskCheckResult`).
 * It is read from the ORIGINAL input, as the gate's own cards are: the string the
 * model asked for, while a rewrite travels as the executed input.
 *
 * Display only, by construction: the card keeps its `permission_dsl` type, so
 * the host's permanent Bash rule (minted for a `bash`-typed card only) and its
 * remember window (keyed on a `commandHash` this card never carries) are
 * untouched. The one effect beyond the preview narrows: a restart-settled answer
 * now matches this command rather than any call of the tool.
 */
function piReadableAskCardCommand(toolName: string, input: Readonly<Record<string, unknown>>): { command: string } {
  const shell = typeof input.command === 'string' && input.command.trim() ? input.command : undefined;
  return { command: shell ?? rawDslInputPath(input) ?? toolName };
}

/**
 * F1.902's twin — a readable-rule `ask` over a card the MODE already raised.
 *
 * Measured by the F1.902 rig
 * (`server-core/src/sessions/__tests__/pi-ask-rule-card-command.test.ts`) at
 * `e4d255395`: in Manual, with an ask rule over a command the mode prompts for
 * anyway, the merge left the mode's card as it was — "Execute: <command>", the
 * rule unnamed, and the mode's `commandHash` + `rememberForMinutes: 10`. One
 * Always Allow stored the host's session remember window under that hash
 * (`SessionManager.respondToPermission`), and `handleAgentPermissionRequest`
 * answered every later identical call with no card: an explicit ask rule
 * switched off for the rest of the session, where
 * `permission-modes.md#actions-no-mode-auto-approves` lists "Tools matched by an
 * explicit ask rule" among what no mode auto-approves.
 *
 * F1.860 closed the same seam on claude (`claudeReadablePermissionAskCheckResult`)
 * and this is its shape, one runtime over: the card names the rule and carries no
 * remember window — those two fields ARE the don't-ask-again mechanism, and Pi's
 * gate already withholds them from its own ask-rule card — keeping its type,
 * command and payload. A floor's card keeps its own text; it carries no remember
 * window to begin with. The judge-cleared marker belongs to the other arm only: a
 * judge `no_objection` turns the prompt into an allow before this merge.
 *
 * F1.913 — and the card offers no Always Allow (`noAlwaysAllow`, the codex
 * ask-rule card's shape, F1.870). It keeps type `bash`, and the host's
 * `respondToPermission` mints the permanent repository `Bash(<key> *)` rule for
 * an Always on a `bash`-typed card, which the ask outranks on every later call
 * (`permission-dsl.ts` ACTION_WEIGHT ask 1 > allow 0): a lasting grant that never
 * stops this ask. The gate-allow arm's `permission_dsl` card carries the same
 * flag, whose Always was already one call. A floor's card is left as the gate
 * built it. A client that sends Always anyway is the host's guard (F1.888).
 */
function piReadableAskOverModePrompt(
  decision: Extract<PiPermissionPolicyDecision, { outcome: 'ask' }>,
  checkResult: PreToolUseCheckResult,
  ruleSentence: string,
): PiPermissionPolicyDecision {
  const { rememberForMinutes: _remember, commandHash: _hash, ...card } = decision.request;
  const floor = checkResult.type === 'prompt' && checkResult.nonNegotiable !== undefined;
  return { ...decision, request: floor ? card : { ...card, description: ruleSentence, noAlwaysAllow: true } };
}

/**
 * F1.841 — the refusal Unattended (`dontAsk`) gives a call a readable-rule `ask`
 * matches, or `undefined` when this call is not one.
 *
 * `permission-modes.md#allow-only-pre-approved-tools-with-dontask-mode`,
 * verbatim: "Claude Code denies calls matching your explicit `ask` rules rather
 * than prompting." Pi's gate already refuses what the MODE would prompt for in
 * dontAsk, but the readable ask is merged AFTER the gate, in
 * `handlePreToolUseRequest`, and that merge turned a gate allow — a workspace
 * `Read`, which dontAsk runs — into an `ask` whatever the mode. The permission
 * service hands every `ask` to the host's card, so an unattended run waited on
 * a card nobody answers (measured red by
 * `server-core/src/sessions/__tests__/pi-dont-ask-ask-rule.test.ts`: one card).
 *
 * The sentence is claude's twin's (`claudeReadablePermissionAskCheckResult`,
 * F1.830), so the two runtimes refuse alike, and the rule is named the way every
 * readable-policy renderer names it ({@link describePermissionDslMatch}). It
 * rides the merge's deny arm: the refusal keeps the judge provenance (D1.156),
 * and no hook reopens it — "Deny and ask rules are still evaluated regardless of
 * what the hook returns" (hooks.md#pretooluse). A gate refusal is left as the
 * gate wrote it, by the ask arm's own test (`allow` or `ask` only).
 */
function piReadableAskDontAskRefusal(
  readable: { action?: string; match?: Parameters<typeof describePermissionDslMatch>[0] },
  decision: PiPermissionPolicyDecision,
  mode: PermissionMode,
  toolName: string,
): string | undefined {
  if (mode !== 'dontAsk' || readable.action !== 'ask' || decision.outcome === 'deny') return undefined;
  const named = describePermissionDslMatch(readable.match);
  const clause = named.length === 0 ? 'readable permission policy' : `readable permission policy ${named}`;
  return `Tool blocked: ${toolName} requires approval by ${clause}, and ${PERMISSION_MODE_AGENT_LABELS.dontAsk} mode never prompts.`;
}

/**
 * F1.933 — the MCP wire name the Guardian judge is told about, or `undefined`
 * when the call is not an MCP call.
 *
 * An `mcp__…` name is its own wire name. A Pi SESSION tool is gated under its
 * binding's bare `permissionName` (`CronCreate`, the handler name — the
 * `binding` builder in `pi-harness/harness-tool-descriptor.ts`), so it used to
 * take `buildGuardianAction`'s "any other prompted tool" fallback, and
 * `describeAction` (`prompts/guardian.ts`) renders a command with NO parameters:
 * SIT-af's judge read `Command: CronCreate` with nothing else, answered `unsure`
 * ("without the full argument payload") and a Pi bypass session stopped on a
 * card. A bare name now maps to the binding whose `bindingName` is
 * `mcp__session__<name>` AND whose `permissionName` is that name — the exact
 * identity, and no other Pi binding shares a session tool's bare name (measured
 * over `PI_TOOL_BINDINGS` 2026-09-25: 57 session bindings, 22 others, 0
 * collisions) — so the judge sees `MCP tool: session.<name>` with its parameters
 * inside the untrusted fence, like every other MCP call, and both spellings are
 * one judged subject (one verdict-cache and override key).
 *
 * RESIDUE, stated and NOT changed here: every other non-Bash tool on that
 * fallback (Write, Edit, WebFetch, …) still reaches the judge as
 * `Command: <name>` with its input unrendered; that is its own plan row.
 */
function piGuardianMcpWireName(toolName: string): string | undefined {
  if (toolName.startsWith('mcp__')) return toolName;
  const wireName = `mcp__session__${toolName}`;
  return getPiToolBindingByBindingName(wireName)?.permissionName === toolName ? wireName : undefined;
}

/**
 * F1.1254 (origin: the final CDP sitting 2026-10-01, TRIAGE D-4, the F1.256 posture) — whether Bypass permissions
 * grants a Pi outside-root READ without the card. Decided under the owner's rule (2026-10-08): yes, for that one
 * request (`expires: 'request'`, nothing remembered), as Claude and codex do not ask for such a read in Bypass and
 * Pi's own Bash already read the same folder without one. The floors stay, by asking the host's own read check —
 * `shouldAllowToolInMode('Read', …, 'bypassPermissions')`, whose `deniedPaths` floor and operator read fence run
 * before its bypass return — and by never granting inside Nessy's data folder (`CONFIG_DIR`, every other session's
 * records); either one raises the card exactly as before. A write, and every other mode, raise the card as before.
 */
function piBypassGrantsOutsideRootRead(
  agent: PiAgent,
  request: { canonicalTarget: string; access: 'read' | 'write' },
): boolean {
  const permissionManager = (agent as unknown as { permissionManager: PiAgent['permissionManager'] }).permissionManager;
  if (request.access !== 'read' || permissionManager.getPermissionMode() !== 'bypassPermissions') return false;
  const target = request.canonicalTarget;
  const dataFolder = CONFIG_DIR_FOR_OUTSIDE_ROOT.endsWith(sep) ? CONFIG_DIR_FOR_OUTSIDE_ROOT : CONFIG_DIR_FOR_OUTSIDE_ROOT + sep;
  if (target === CONFIG_DIR_FOR_OUTSIDE_ROOT || target.startsWith(dataFolder)) return false;
  const permissionsContext = permissionManager.getCapabilityPermissionsContext?.();
  const verdict = shouldAllowToolInMode('Read', { file_path: target }, 'bypassPermissions', permissionsContext ? { permissionsContext } : undefined);
  return verdict.allowed === true;
}
// F1.1254 — imported at the end for the line-citation reason above.
import { CONFIG_DIR as CONFIG_DIR_FOR_OUTSIDE_ROOT } from '../config/paths.ts';
import { readdirSync, statSync } from 'node:fs'; // UA12.217 — findNamedPiSessionFile (kept below the doc-cited region with its sibling imports)
import { sep } from 'node:path';

/**
 * F1.1287 (origin: lane PI-1's report, 2026-10-02) — a Pi subprocess CRASH counts as stopped for an outside-root card:
 * the call that asked died with the subprocess and the turn has ended ("Pi subprocess exited unexpectedly"), so the
 * card leaves the host through the out-of-turn channel (F1.369), exactly as a Stop withdraws it (F1.1243, forceAbort)
 * and `abort()` does (F1.1286). Before this the crash path only denied the call: the host record stayed counted and
 * durable, and after a restart R7 re-projected a card whose call no longer existed. Called from
 * `handleSubprocessExit` only, before `rejectPendingSubprocessRequests` empties the map; a dispose for a restart
 * still keeps R7's re-projection, as F1.1243 left it. Decided under the owner's rule (2026-10-08), measured first.
 */
function withdrawCrashedOutsideRootCards(agent: PiAgent): void {
  const self = agent as unknown as {
    pendingPermissions: Map<string, { kind: string }>;
    withdrawElicitationDialog(requestId: string): void;
  };
  for (const [requestId, pending] of self.pendingPermissions) {
    if (pending.kind === 'outside_root') self.withdrawElicitationDialog(requestId);
  }
}
