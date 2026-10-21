/**
 * CodexAgent — a first-class Nessy backend over the bundled codex `app-server`.
 *
 * Lifecycle is modeled on `PiAgent` but delegates the transport to the spike's
 * `CodexRuntimeManager` + `AppServerClient` (`@nessy-agent/codex-agent-server`)
 * and runs the Phase 2 `codex-responses-adapter` in-process on an ephemeral
 * loopback port (the app-server child reaches it via 127.0.0.1).
 *
 * Scope (Phase 3): a stored `codex-runtime` connection runs a real turn.
 * Approvals are AUTO-APPROVED in the app-server request handler (the full
 * onPermissionRequest/respondToPermission bridge is Phase 4). config.toml uses
 * static approval/sandbox values (Phase 4 makes them Nessy-mode-driven).
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, parse as parsePath, resolve as resolvePath } from 'node:path';
import type {
  AgentEvent,
  AgentRetryFacts,
  AskUserAnswer,
  AskUserPermissionRequest,
  AskUserQuestionItem,
} from '@nessy-agent/core/types';
import { retryStatusEvent } from '@nessy-agent/core/types';
import { reportToolSearchDisposition } from './options.ts';
import {
  CodexRuntimeManager,
  AppServerClient,
  hostCodexPlatformDir,
  isCodexIntegrityError,
  CODEX_WARNING_METHOD,
  codexServerWarningNotice,
} from '@nessy-agent/codex-agent-server';
import {
  CODEX_OPTED_OUT_NOTIFICATION_METHODS,
  HANDLED_CODEX_NOTIFICATION_METHOD_SET,
  OPTED_OUT_CODEX_NOTIFICATION_METHOD_SET,
  UNREAD_CODEX_NOTIFICATION_METHOD_SET,
  describeCodexDeprecationNotice,
  describeCodexModelReroute,
} from './codex-notification-families.ts';
import {
  isApprovalMethod,
  approvalKindForMethod,
  mapCommandApprovalToRequest,
  mapFileChangeApprovalToRequest,
  mapElicitationApprovalToRequest,
  mapPermissionsApprovalToRequest,
  mapLegacyExecApprovalToRequest,
  mapLegacyPatchApprovalToRequest,
  buildApprovalResponse,
  buildAbortResponse,
  buildUnsupportedResponse,
  buildUrlElicitationResponse,
  execpolicyAmendmentForApproval,
  isUrlElicitation,
  describeGuardianReviewAction,
  readProposedNetworkPolicyAmendments,
  type ApprovalKind,
} from '@nessy-agent/codex-agent-server';
import { boardTaskDeveloperSection, getSafetyAndEngineeringSections, gitAttributionSection, pagesPromptSection, untrustedProjectPromptSection } from '../prompts/system.ts';
import { resolveGitAttribution } from '../config/preferences.ts';
import { CODEX_RUNTIME_GUIDANCE } from '../prompts/codex-runtime-guidance.ts';
import {
  outputStyleProjectRootFor,
  resolveOutputStyleComposition,
  type OutputStyleComposition,
} from '../prompts/output-styles.ts';
import { resolveChildOutputStyleId } from './child-session-scope.ts';
import { planOutputStyleSwitch } from './core/output-style-switch.ts';
import { safeHttpUrl } from '../mcp/elicitation.ts';
import {
  mcpDefaultToolTimeoutMsFromEnv,
  readMcpTimeoutEnv,
  MCP_DEFAULT_TOOL_TIMEOUT_MS,
  MCP_TOOL_TIMEOUT_COMPAT_ENV,
  MCP_TOOL_TIMEOUT_ENV,
} from '../mcp/server-config-values.ts';
import { composeProjectCompactSteering } from '../prompts/compaction.ts';
import { customHeadersOffGatewayNotice, gatewaySessionFetch } from '../telemetry/gateway-headers.ts';
import { openUrl } from '../utils/open-url.ts';
import { randomUUID } from 'node:crypto';
import { startAdapter, type AdapterHandle } from '@nessy-agent/codex-responses-adapter';
import {
  buildCodexRuntimeConfigOverride,
  codexSandboxConfigForMode,
  formatCodexClaudeSettingsProjectionDiagnostics,
  mapDeniedPathsToCodexFilesystemKeys,
  writeCodexConfig,
  REASONING_EFFORT,
  resolveCodexContextWindow,
  CODEX_API_KEY_ENV, CODEX_PROVIDER_KEY,
  CODEX_APPROVAL_POSTURE_PREFIX,
  CODEX_ASSUMED_CONTEXT_WINDOW,
  CODEX_HOOK_PROJECTION_NOTICE,
  CODEX_POOL_MCP_TOKEN_ENV,
  type CodexHostAuthoredHooksPlan,
  type CodexMcpServerSpec,
  type CodexSandboxMode,
} from '@nessy-agent/codex-responses-adapter/config-writer';
import { otelExporterDisabled, resolveTelemetryIdentity, telemetryOptedIn, telemetryOptedOut, tracingOptedIn } from '../telemetry/usage-metrics.ts';
import { CODEX_TELEMETRY_COVERAGE, hasResourceAttribute, withTelemetryCoverage } from './telemetry-coverage.ts';
import { DEFAULT_UPSTREAM, postChat, type UpstreamAuthScheme, type UpstreamTarget } from '@nessy-agent/codex-responses-adapter/nestor-client';
import { readNestorCreds } from '@nessy-agent/codex-responses-adapter/nestor-auth';
import { attachUpstreamCredential } from './backend/internal/drivers/upstream-target.ts';
import { buildCodexRuntimeUpstream } from './backend/internal/drivers/codex.ts';
import { getCredentialManager } from '../credentials/index.ts';
import { hookBlockEndsTurn, isBlockingHookDecision } from '../automations/hook-decision-contract.ts';
import type { AgentEventExecutionResult, SessionEndReason } from '../automations/types.ts';
import { BaseAgent, buildRuntimeHandoffContext } from './base-agent.ts';
import { SESSION_BRANCHING_SUPPORT } from './runtime-agent-support.ts';
import { buildCodexInjectItems } from './codex-handoff-items.ts';
import { AbortReason } from './backend/types.ts';
import type { AgentLifecycleState, BackendConfig, ChatOptions, PermissionResponseOptions, PostInitResult, RuntimeHandoffPayload } from './backend/types.ts';
import type { BackendRuntimeUpdate, LlmAuthType, LlmProviderType, RedirectMetadata } from './backend/types.ts';
import type { FileAttachment } from '../utils/files.ts';
import type { FuzzyFileSearchResponse } from '../protocol/index.ts';
import type { LLMQueryRequest, LLMQueryResult } from './llm-tool.ts';
import { getBackendRuntime } from './backend/internal/driver-types.ts'; import { appendBundledRipgrepDir, bundledRipgrepPathEnv } from './backend/internal/runtime-resolver.ts';
import {
  CodexEventAdapter,
  codexTerminalReasonForError,
  readCodexMessageUsage,
  readCodexTokenCount,
  CODEX_BACKGROUND_TERMINAL_ID_KEYS,
  extractCodexBackgroundTerminals,
  readCodexBackgroundTerminalsCursor,
  readCodexCommandActions,
} from './backend/codex/event-adapter.ts';
import {
  startCodexSessionCallbackBridge,
  type CodexSessionCallbackBridgeHandle,
} from './backend/codex/session-callback-bridge.ts';
import {
  buildCodexDetachedReviewParams,
  describeCodexDetachedReviewFindings,
  describeCodexDetachedReviewStart,
  type CodexDetachedReviewInput,
} from './backend/codex/detached-review.ts';
import { CODEX_SKILL_EXTRA_ROOTS_SWITCH_NOTE } from './backend/codex/skill-extra-roots.ts';
import {
  classifyCodexUnboundPermissionRules,
  describeCodexUnboundPermissionRules,
} from './codex-permission-rule-support.ts';
import { NESSY_AGENT_PROJECT_DIR } from '../projects/nessy-agent-layout.ts';
import { PROJECT_AGENT_SKILLS_DIR } from '../skills/storage.ts';
import {
  compileStructuredOutputSchema,
  validateStructuredOutputText,
  type CompiledStructuredOutputSchema,
} from '../structured-output/index.ts';
import { hookTaskRegistryInput } from '../automations/hook-task-registry.ts';
import { ensureSessionJobDir, getSessionDataPath, getSessionDirPath, getSessionPlansDir, SESSION_JOB_DIR_ENV_VAR } from '../sessions/storage.ts';
import { createFileCheckpoint, finalizeFileCheckpoint } from '../sessions/file-checkpoints.ts';
import { parseSessionCommand } from '../slash-commands/session-command.ts';
import { getPermissionModeDiagnostics, shouldAllowToolInMode } from './mode-manager.ts';
import {
  findNonNegotiableFloors,
  firstNonNegotiableFloor,
  type NonNegotiableFloorVerdict,
} from './core/pre-tool-use.ts';
import {
  bareFileViewerOperand,
  READ_BEFORE_WRITE_TOOLS,
  SessionFileReadLedger,
  writeTargetPath,
} from './core/read-before-write.ts';
import {
  collectExecpolicyAllowPrefixes,
  collectExecpolicyDenyPrefixes,
  collectExecpolicyPromptPrefixes,
  loadRawWorkspacePermissions,
  mergeExecpolicyAllowGrant,
  permissionsConfigCache,
  saveWorkspacePermissions,
  type PermissionsContext,
} from './permissions-config.ts';
import { evaluatePermissionDslV1, loginShellScript, permissionDslDenyReason } from './pi-harness/permission-dsl.ts';
import { PROTECTED_DIRECTORIES } from './pi-harness/protected-paths.ts';
import { activeEffortLevelForModel, normalizeThinkingLevel, type ThinkingLevel } from './thinking-levels.ts';
import { ElicitationAskUserBridge } from './elicitation-ask-user.ts';
import { getAskUserQuestionTimeoutMs } from '../config/storage.ts';
/**
 * P6.344 — codex's own clarifying-question request. Named rather than inlined
 * because the bridge answers it in one place and the handler is registered in
 * another, and a literal in both is how the two drift apart.
 */
const CODEX_REQUEST_USER_INPUT_METHOD = 'item/tool/requestUserInput';

/**
 * P6.344 — `ToolRequestUserInputQuestion` and `ToolRequestUserInputParams`,
 * RESTATED here rather than imported.
 *
 * `@nessy-agent/codex-protocol`'s own package description is the reason:
 * "nothing imports generated/*.ts as a module, and generated/ is in no
 * typecheck program". The bindings are consumed as DATA and as parsed source
 * text by two drift ties. So this is the same discipline P6.28 applied to
 * `UserInput` — a restated union, narrowed to what this file reads, with the
 * generated file named so the next reader can diff it:
 * `packages/codex-protocol/generated/v2/ToolRequestUserInputQuestion.ts` and
 * `…/ToolRequestUserInputParams.ts`, both from rust-v0.148.0.
 *
 * Every field is optional here and required upstream, deliberately: this shape
 * describes what arrives on a wire we do not control, and a missing field must
 * degrade to a declined question rather than to a crash inside a JSON-RPC
 * handler.
 */
interface CodexRequestUserInputQuestion {
  id: string;
  header?: string;
  question: string;
  isOther?: boolean;
  isSecret?: boolean;
  options?: Array<{ label: string; description?: string }> | null;
}

interface CodexRequestUserInputParams {
  questions?: CodexRequestUserInputQuestion[];
  isBlocking?: boolean;
}
/**
 * P6.368 — the host's own name for codex's `plan_mode_reasoning_effort`.
 *
 * Declared here rather than in a settings module because it has exactly one
 * reader and one writer, and because it is an INVENTED name: no claude
 * documentation and no shipped binary carries a plan-mode effort variable, so
 * there is no family for it to join. See {@link CodexAgent.planModeThinkingLevel}.
 */
const CODEX_PLAN_MODE_EFFORT_ENV_VAR = 'NESSY_PLAN_MODE_EFFORT';
import { readClaudeProjectSettingsKeys } from './claude-shell-command-settings.ts';
import {
  CODEX_REQUIREMENT_UNAPPLIED_PREFIXES,
  isDefinitiveAppServerRefusal,
  formatCodexRequirementClockDiagnostics,
  probeCodexConfigRequirements, codexManagedModelProviderRedirect, formatCodexManagedModelProviderRefusal, codexOpenedModelProviderRefusal, codexReforkedModelProviderRefusal,
  resolveCodexManagedNewThreadModel,
  type CodexConfigRequirementsReadingV1, type CodexManagedModelProviderRedirectV1,
} from './codex-config-requirements.ts';
import { probeCodexConfigOrigins, recordCodexConfigProvenance } from './codex-config-origins.ts';
import { systemPromptAppendSection } from '../prompts/system-prompt-append.ts';
import { recordCodexInAppUpdatesRequirement } from '../config/managed-in-app-updates.ts';
import { persistCodexInAppUpdatesRequirement } from '../config/codex-managed-requirement-cache.ts';
import { recordCodexInAppBrowserRequirement } from '../config/managed-in-app-browser.ts';
import { recordAndPersistCodexLocalAutomationRequirement } from '../config/codex-managed-requirement-cache.ts';
import { buildShellChildNetworkEnv, getProxyEnvVars } from '../config/proxy-env.ts';
import { canonicalizeForDecision } from './session-filesystem-scope.ts';
import { CONFIG_DIR } from '../config/paths.ts';
import { getMemoryEnabled, getUserSandboxSettings, loadConfigDefaults, loadStoredConfig, resolveManagedSandboxEnabledFloor, resolvePlansDirectory } from '../config/storage.ts';
import {
  CODEX_THREAD_MEMORY_MODE_SET_METHOD,
  buildCodexThreadMemoryModeSetParams,
  projectSessionMemoryScopeToCodex,
  resolveSessionMemoryScope,
} from './memory/session-memory-scope.ts';
import { resolveFallbackModelChain } from '../config/fallback-model-chain.ts';
import { bundledSkillsDisabled } from '../config/bundled-skills-settings.ts';
import {
  applyRuntimeAgentSkillsToDescriptors,
  materializeClaudeRuntimeAgentSkills,
} from './claude-runtime-agents.ts';
import type { PiRuntimeAgentDefinitionDescriptor } from './pi-harness/runtime-agent-definition.ts';
import {
  describeUnattendedApprovalRefusal,
  resolveUnattendedApprovalFallback,
} from '../config/unattended-approval.ts';
import {
  resolveSkillOverride,
  resolveSkillOverrides,
  skillOverrideHidesFromModelListing,
} from '../config/skill-overrides.ts';
import { codexUsageLimitResetClause } from './usage-limit-reset.ts';
import { parseNumericSetting } from '../config/numeric-setting.ts';
// P3.2 · kept on a SEPARATE import from the same module so the byte-exact line
// above stays intact for `codex-sandbox-globally-enabled.test.ts`'s import guard.
import { getCodexAutoReviewEnabled, getCodexAutoReviewPolicy, getCodexSubagentsEnabled } from '../config/storage.ts';
import { getOutputStyleId } from '../config/storage.ts';
// P3.13 · same reason as the line above — its own import so neither line's bytes
// move when the other grows.
import { getAdvisorEnabled, getDecisionLayerSettings } from '../config/storage.ts';
// P6.156 codex arm · its own import line, same reason as the two above.
import { getLlmConnection } from '../config/storage.ts';
// F1.6 / F1.7 — the two `/quota` reads (the gateway budget; codex's own windows), see
// `describeQuota`; its gateway discriminator is imported with the egress sink below.
import { NessyGatewayQuotaRead } from './backend/internal/nestor-quota.ts';
import { codexUsageLimitWindowReset, formatCodexAccountWindows, mergeCodexRateLimitUpdate, readCodexAccountWindows, type CodexAccountWindows } from './backend/codex/rate-limit-windows.ts';
import {
  CODEX_BEDROCK_CARD_ENV_VAR, CODEX_BEDROCK_MODEL_PROVIDER, CODEX_CHATGPT_MODEL_PROVIDER,
  resolveCodexModelProvider,
  resolveGatewayFastModelId,
  resolveModelGenerationDefaults,
  type CodexModelProvider,
} from '../config/llm-connections.ts';
import {
  buildBuiltinAgentTierNotice,
  inertBuiltinAgentTiers,
  type BuiltinAgentTierModelMap,
} from '../agents/builtin-tier-notice.ts';
import { i18n, setupI18n } from '../i18n/index.ts';
import { SUBAGENT_MARKER_PREFIX } from '../prompts/untrusted-text.ts';
import { resolveSandboxEnabled } from '../config/sandbox-settings.ts'
import { isNessyGatewayBaseUrl, noteModelTargetToolEgress } from './backend/internal/drivers/upstream-target.ts'
import { getConfiguredAdditionalDirectories } from './additional-directories.ts'
import {
  BASH_MAX_OUTPUT_LENGTH_COMPAT_ENV,
  BASH_MAX_OUTPUT_LENGTH_ENV,
  resolveBashReadBackChars,
} from '../config/bash-output-limits.ts'
import { declaredBashTimeoutCeiling } from './pi-harness/process-supervisor-port.ts'
import { resolveMaxApiRetries, resolveStreamIdleTimeoutMs } from '../config/api-retry-env.ts'
import { declaredMaxConcurrentSubagents } from '../config/subagent-limits.ts'
import { resolveSubagentModelOverride } from '../config/subagent-model.ts'
import { isManagedModelSelectable } from '../config/managed-model-allowlist.ts'
import {
  MAX_SUBAGENT_SPAWN_DEPTH_COMPAT_ENV_VAR,
  MAX_SUBAGENT_SPAWN_DEPTH_ENV_VAR,
  resolveMaxSubagentSpawnDepth,
} from '../config/subagent-spawn-depth.ts';
import { extractReasoning } from '../llm/think-splitter.ts';
import {
  appendPluginBinPath,
  enabledPluginBundleRoots,
  pluginRuntimeEnvForProfile,
} from '../plugins/data-paths.ts';
import { fenceHookBand } from '../automations/hook-context-fence.ts';

/** Gateway coder default (00-context). Resolved from the connection when set. */
export const DEFAULT_CODEX_MODEL = 'tgpt/qwen35-397b-a17b-fp8';

/** Small async event queue: bridges the client's event callbacks into an async generator. */
/**
 * P3.3 · is this app-server refusal DEFINITIVE — i.e. will asking again ever help?
 *
 * Measured against the shipped binary rather than inferred, because the obvious
 * signal does not exist: `codex-app-server` contains NO "Method not found"
 * string (0 occurrences). `ClientRequest` is a serde-tagged enum, so an
 * unrecognised method is a DESERIALIZATION failure — `unknown variant` (32
 * occurrences) — and a wrong param shape is `missing field` (41) / `unknown
 * field` (20) / `invalid type` (15). All of those are permanent for a given
 * binary: retrying re-sends the same bytes and gets the same answer.
 *
 * Everything else is transient and must NOT latch: `thread not found` (the
 * thread is not ready yet), "thread already has an active or pending turn", a
 * closed client during teardown, a stdio write that did not land.
 *
 * The JSON-RPC code is checked first and is the authority when present
 * (-32601 method not found, -32602 invalid params); `AppServerClient` now
 * preserves it on the rejected Error. The text match is the fallback, since this
 * server answers an unknown method with a serde message rather than a code.
 */
function isDefinitiveBackgroundTerminalsRefusal(error: unknown): boolean {
  // P2.243 · ONE classifier for what were two. This function used to carry its
  // own copy of the rule — codes `-32601`/`-32602` kept for a future binary,
  // everything else decided on serde tokens — while
  // `codex-config-requirements.ts` decided the SAME question about the SAME
  // binary on a code set that included `-32600`. Measured over six conditions on
  // the shipped binary, `-32600` is the server's catch-all "Invalid request" (an
  // unknown method, params on a unit method, a wrong field type, a missing
  // required field and a bad thread id all return it), so the code set was
  // stating a false rule in a durable comment while this side had already
  // reached the right one. The rule that survived is this one; it now lives in
  // the sibling module, with the measurement, and both sides call it.
  return isDefinitiveAppServerRefusal(error);
}

/**
 * P2.245 · how long a turn's head will wait for the OPTIONAL background-terminal
 * listing — a budget for the WHOLE cursor walk, not a ceiling on one call.
 *
 * WHY A BUDGET RATHER THAN A PER-CALL CEILING. The walk is cursor-chained, so the
 * pages MUST be sequential: page N+1's `cursor` is read off page N's response,
 * and the binary parses that cursor as a number IT issued (measured: an invented
 * `cursor` is refused with `invalid cursor: invalid digit found in string`), so
 * there is nothing to fetch ahead. A per-call ceiling of T would therefore still
 * let {@link CodexAgent.syncBackgroundTerminalsIntoSink}'s ten pages hold the
 * head of the user's turn for 10 x T. One budget for the walk is what actually
 * bounds the wait a user can feel.
 *
 * CHOSEN AGAINST THE RESTING STATE, not against zero — a bound below the floor
 * manufactures its own failures. MEASURED on the shipped binary
 * (`apps/electron/resources/bin/codex/darwin-arm64/codex-app-server`, reporting
 * `0.148.0`, 2026-08-27, two cold spawns): `thread/backgroundTerminals/list`
 * answered in 0.05-0.97 ms — cold first call and warm alike — and answered
 * `{"data":[],"nextCursor":null}`, so a real turn issues ONE call and ten is the
 * drift ceiling rather than the normal cost. Five seconds is ~5000x the slowest
 * single answer measured, for the whole walk, so it can only fire on an
 * app-server that is not answering at all — never on one that is merely slow.
 *
 * Deliberately the SAME number as `CODEX_CONFIG_REQUIREMENTS_TIMEOUT_MS`
 * (`codex-config-requirements.ts`, P2.138). Both answer one question — "is this
 * app-server still answering an instant, local query?" — and two numbers for one
 * judgement is a second rule to keep true.
 */
export const CODEX_BACKGROUND_TERMINALS_TIMEOUT_MS = 5_000;

/**
 * P6.111 · floor between two BETWEEN-TURNS terminal refreshes.
 *
 * The refresh is kicked by `backgroundWorkCount()`, which is a synchronous
 * getter the idle reaper and the live-agent ceiling call — the reaper once a
 * sweep (60 s by default), the ceiling on its own admissions. A poll per read
 * would let an admission storm drive an RPC loop against the app-server for a
 * level that changes at human speed.
 *
 * The gap applies to the TURN-END refresh too, deliberately and not by
 * oversight: a turn that ends inside the gap of an earlier poll skips its own,
 * and that is harmless because the reads it feeds are decided against a
 * thirty-MINUTE idle TTL. Half a sweep: short enough that a stale-high count
 * comes down on the next sweep, long enough that nothing loops.
 */
const CODEX_BACKGROUND_TERMINALS_REFRESH_MIN_GAP_MS = 30_000;

/**
 * P6.118 · codex's own error vocabulary projected onto the ten values
 * `StopFailure.error` is bound to.
 *
 * Pi does the same thing from Nessy's `ErrorCode` (`toDocumentedStopFailureError`)
 * and the reason is the payload's: hooks.md gives `error` a CLOSED ten-value
 * vocabulary, so a hook switching on it must never meet a word its case list
 * cannot contain. The source vocabulary here is codex's `CodexErrorInfo`
 * (`packages/codex-protocol/generated/v2/CodexErrorInfo.ts`, `rust-v0.148.0`),
 * read from the generated union rather than from prose.
 *
 * DELIBERATELY NARROW: only the seven whose meaning is unambiguous are mapped (F1.1224 added two),
 * and every other codex code — `contextWindowExceeded`, `sessionBudgetExceeded`,
 * `cyberPolicy`, `sandboxError`, the `httpStatusCode`-carrying object variants,
 * `other` — projects to the documented catch-all `unknown` rather than to a
 * neighbour that is merely close. Nothing is lost by that: the RAW codex code
 * always rides beside it on `error_code`, and the matcher reads `error_code`
 * FIRST (`getMatchValueForSdkInput`), which is exactly how Pi keeps its own
 * Nessy-specific codes reachable.
 */
const CODEX_ERROR_INFO_TO_DOCUMENTED_STOP_FAILURE: Readonly<Record<string, string>> = Object.freeze({
  usageLimitExceeded: 'rate_limit', rateLimitExceeded: 'rate_limit', // F1.1224 — rust-v0.159.3: codex's in-stream rate limit
  serverOverloaded: 'overloaded', flexUnavailable: 'overloaded', // F1.1224 — "Flex capacity unavailable." (protocol/src/error.rs): capacity, not a quota
  internalServerError: 'server_error',
  unauthorized: 'authentication_failed',
  badRequest: 'invalid_request',
});

/**
 * P6.366, the LADDER half — the codex error codes that switch to the next
 * fallback model, and the far longer list of codes that must not.
 *
 * ## The trigger set is the PAGE's, verbatim, not a judgement call
 *
 * `model-config.md#fallback-model-chains`: *"When the primary model is
 * overloaded, unavailable, or returns another non-retryable server error, Claude
 * Code can switch to a fallback model instead of failing the request.
 * Authentication, billing, rate-limit, request-size, and transport errors, and a
 * denial by your organization's policy check, never trigger a switch; those
 * follow their normal retry and error handling."*
 *
 * That sentence names both halves, so this set is a TRANSLATION of it into
 * codex's own vocabulary rather than an opinion about which failures deserve a
 * second model. The vocabulary is `CodexErrorInfo`
 * (`packages/codex-protocol/generated/v2/CodexErrorInfo.ts`, generated from
 * `rust-v0.148.0` — the tier that outranks a page on this runtime), whose
 * members (twenty at rust-v0.159.3, F1.1224) map onto that sentence as:
 *
 * | Member | Verdict |
 * | --- | --- |
 * | `serverOverloaded`, `flexUnavailable` (F1.1224) | **switches** — the page's "overloaded" / "unavailable" ("Flex capacity unavailable.") |
 * | `internalServerError` | **switches** — "another non-retryable server error" |
 * | `usageLimitExceeded`, `sessionBudgetExceeded`, `rateLimitExceeded` (F1.1224) | never — billing / rate-limit |
 * | `contextWindowExceeded` | never — request-size |
 * | `unauthorized` | never — authentication |
 * | `httpConnectionFailed`, `responseStreamConnectionFailed`, `responseStreamDisconnected` | never — TRANSPORT, named as excluded |
 * | `cyberPolicy`, `misalignmentPolicyViolation`, `tooManyDenials` (F1.1224) | never — the policy-check denial (the reviewer's, for the last) |
 * | `badRequest`, `sandboxError`, `threadRollbackFailed`, `activeTurnNotSteerable`, `other` | never — none is a server verdict on the MODEL, and a switch would answer a request the next model refuses identically |
 *
 * `responseTooManyFailedAttempts` is the one that reads like a candidate and is
 * deliberately excluded: it is codex reporting that its OWN retry loop gave up,
 * i.e. an accumulation of the transport failures the page excludes, not a fresh
 * server verdict. Its `httpStatusCode` could in principle carry a 5xx, and
 * reading it would be inventing a rule the page does not state.
 *
 * **Why this is narrower than Pi's set and that is not a divergence.** Pi
 * retries on six `AgentError` codes including `network_error`, because those are
 * Pi's own error vocabulary and its ladder predates this reading. The page's
 * exclusion of transport errors is explicit, so the codex arm follows the page;
 * bringing Pi's set into line is a separate row rather than a silent change to a
 * working ladder.
 */
const CODEX_FALLBACK_RETRY_ERROR_CODES: ReadonlySet<string> = new Set([
  'serverOverloaded',
  'internalServerError', 'flexUnavailable', // F1.1224 — the page's "unavailable"; work/wi16/QUESTIONS.md
]);

/**
 * P6.118 · the code name off a `TurnError.codexErrorInfo`, which is a string for
 * the plain variants and a single-key object for the ones carrying an HTTP
 * status (`{ httpConnectionFailed: { httpStatusCode } }`).
 */
function readCodexErrorInfoCode(info: unknown): string | undefined {
  if (typeof info === 'string') return info;
  if (info && typeof info === 'object') {
    const keys = Object.keys(info as Record<string, unknown>);
    return keys.length === 1 ? keys[0] : undefined;
  }
  return undefined;
}

/**
 * **P6.274 (a) — a retrying codex turn stops being MISLABELLED as an error.**
 *
 * The row's demotion is the whole subject: a retrying codex turn was never
 * silent, it was pushed onto the transcript as `{type:'error'}` while the turn
 * was still going. Pi and claude both put the same moment on the STATUS channel,
 * where the renderer draws a retry chip.
 *
 * ## The vocabulary is not this site's to choose
 *
 * P6.916 — the `status` branch now carries an optional `retry` field, so this
 * site names FACTS and `retryStatusEvent` (`core/types/message.ts`) mints both
 * the payload `SessionManager` stamps `statusType: 'retrying'` off and the
 * sentence the transcript keeps. Pi's adapter produces the same facts from
 * `auto_retry_start` and claude's `buildRetryFacts` from `api_retry`; this is
 * the third producer, which is what the row means by *"driven off `willRetry`
 * rather than a fourth spelling"*.
 *
 * ## Classified off codex's own error code, not off "it retried"
 *
 * `willRetry` is true for overload, 5xx and connection failures as well, so
 * naming a rate limit unconditionally would state a false cause on most retries
 * — the same reason Pi's adapter classifies off the message rather than the
 * event. `usageLimitExceeded` is codex's `CodexErrorInfo` member for the limit
 * (`rust-v0.148.0`), and `CODEX_ERROR_INFO_TO_DOCUMENTED_STOP_FAILURE` projects
 * BOTH limit members — `usageLimitExceeded` and, since F1.1224, `rateLimitExceeded`
 * — to `rate_limit`, so this reads the SAME mapping, not a second opinion.
 *
 * ## The attempt number is OURS, and the countdown is still absent
 *
 * `ErrorNotification` is `{ error, willRetry, threadId, turnId }` and carries
 * neither an attempt number nor a delay, so the attempt appended below is a
 * count of the retries WE observed for the turn in flight — an observation, not
 * an invention, and that is the only reason it may be shown. It carries NO
 * denominator: codex publishes no retry budget either, and `retry 2/?` would be
 * a maximum nobody named. The renderer reads `retry <n>` with no maximum
 * (`renderer/event-processor/retry-status.ts`).
 *
 * The COUNTDOWN stays absent for the reason the attempt number no longer is:
 * there is nothing to observe. A delay we did not measure and codex did not
 * publish would be a number the user could check and find wrong.
 *
 * THE CLEAR IS INFERRED, since P6.917. Pi pushes `Retry succeeded — resuming...`
 * from `auto_retry_end`; codex publishes no retry-END signal at all, so the chip
 * used to stand until the next status superseded it or the turn finished. The
 * honest substitute is the model speaking again — the request being retried has
 * succeeded, because its answer is arriving — so the first `text_delta` after a
 * retry clears it, in Pi's own words so the two runtimes cannot drift. See
 * {@link CodexAgent.codexRetryChipStanding}.
 */
function codexRetryFacts(codexErrorInfo: unknown, attempt?: number): AgentRetryFacts {
  return {
    kind: CODEX_ERROR_INFO_TO_DOCUMENTED_STOP_FAILURE[readCodexErrorInfoCode(codexErrorInfo) ?? ''] === 'rate_limit' // F1.1224 — the SAME mapping, so rateLimitExceeded too
      ? 'rate_limit'
      : 'provider_error',
    // No `maxAttempts` and no `delaySeconds`: codex publishes neither, and the
    // attempt below is one this host COUNTED for the turn in flight.
    ...(attempt !== undefined && attempt > 0 ? { attempt } : {}),
  };
}

/**
 * P2.257 · how long a turn's head will wait for the RE-FORK — the whole walk
 * ({@link CodexAgent.applySelectedPluginSkillRuntimePolicy}'s `thread/fork` plus
 * the `thread/start` it falls back to), not one call.
 *
 * WHY A BUDGET FOR THE WALK. The two legs are strictly sequential and the second
 * is only reachable through the first: `thread/start` runs ONLY after
 * `thread/fork` has already come back refused. Two per-call ceilings of T would
 * therefore let the head of the user's turn hold for 2 x T while each leg stayed
 * "in budget". One budget, spent across both, bounds the thing a user can feel.
 * Nothing is starved by sharing it: the refusal that opens the second leg is
 * MEASURED at 0.53-1.13 ms, so the fallback inherits essentially the whole
 * budget.
 *
 * NOT P2.245's FIVE SECONDS, AND THAT ROW'S OWN PREMISE IS WHY. Its poll answers
 * in 0.05-0.97 ms, so 5 s is ~5000x its slowest answer. `thread/fork` is three
 * orders of magnitude more expensive and it SCALES WITH HISTORY. MEASURED on the
 * shipped binary (`apps/electron/resources/bin/codex/darwin-arm64/
 * codex-app-server`, reporting `0.148.0`, 2026-08-27, warm connection, carrying
 * the product's own `config` override on every call):
 *
 *   - 1-turn rollout            239-498 ms   (n=8)
 *   - + ~0.9 MB injected        531-803 ms   (n=6)
 *   - + ~2.7 MB injected        874-1218 ms  (n=6)
 *   - + ~6.3 MB injected        926-1465 ms  (n=6)
 *   - + ~11.7 MB injected      1238-1509 ms  (n=6)
 *   - the `thread/start` fallback leg, warm: 96-227 ms, plus one 2538 ms sample
 *     taken while another test lane had the machine.
 *
 * Growth is sublinear — 13x the history cost ~3x the time — so a long session
 * cannot walk itself into this bound. What CAN move it is the HOST: every number
 * above was taken on a machine also running other suites, and the spread within
 * one rollout size (239 ms to 498 ms for the identical call) is that noise, not
 * codex. 30 s was ~20x the slowest fork and ~12x the slowest thread boundary of
 * any kind observed, which is what it takes for "this did not answer" to mean the
 * app-server stopped answering rather than the laptop being busy. F1.1018 re-measured it on 0.156.1 — see the end of this file.
 *
 * DELIBERATELY GENEROUS, because the failure here is NOT degradable. P2.245's
 * poll is optional: on expiry the turn runs with an incomplete chip set. This
 * walk is the only thing that applies a drifted model AND a drifted
 * sandbox/permission layer, so on expiry there is no honest way to continue and
 * the turn fails (see the throw below). A bound that fires early therefore
 * MANUFACTURES a failed turn, which is exactly P2.232's objection; what defeats
 * that objection here is not that the call is cheap (it is not) but that it runs
 * on an already-warm connection, so the 34.7 s cold-spawn spread that makes
 * `initialize`/`thread/start` untouchable is absent from these numbers.
 *
 * MCP STARTUP IS NOT ON THIS PATH, and it was the one plausible source of a
 * legitimately multi-second fork — the product always writes
 * `[mcp_servers.session]` and a user may add slow ones. Probed with that entry
 * pointed at a stdio command that says nothing for 60 s: `initialize` returned in
 * 92 ms and eight forks in 324-729 ms. A thread boundary does not wait on an MCP
 * handshake.
 */
export const CODEX_THREAD_REFORK_TIMEOUT_MS = 120_000; // F1.1018 — was 30_000; see CODEX_THREAD_OPEN_SLOWEST_MEASURED_MS at the end of this file

/**
 * P2.260 · how long a turn's head will wait for `thread/inject_items` — the
 * runtime handoff's native delivery, and the LAST RPC before `turn/start`.
 *
 * DELIBERATELY THE SAME NUMBER AS {@link CODEX_THREAD_REFORK_TIMEOUT_MS}, and
 * an alias rather than a copy so the two cannot drift apart. They are one
 * judgement — "how long may a THREAD-BOUNDARY RPC on an already-warm connection
 * hold the head of a user's turn?" — asked about two calls that sit three lines
 * apart in `chatImpl`, the fork first and this one last. A second number here
 * would be a second rule to keep true, and P2.245's own comment records why that
 * is worth avoiding.
 *
 * THE ASYMMETRY ARGUES THE OTHER WAY AND THE MEASUREMENT OVERRULES IT. Unlike
 * the re-fork this one CAN degrade: expiry falls through to the text handoff in
 * the same turn, so a bound that fires early costs the user the native-history
 * upgrade rather than the turn. That asymmetry is a real argument for a SHORTER
 * bound — P2.245's 5 s, say — and the measurement is what forbids it.
 *
 * MEASURED on the shipped binary
 * (`apps/electron/resources/bin/codex/darwin-arm64/codex-app-server`, reporting
 * `0.148.0`, 2026-08-27), warm connection, the product's own item shape, on a
 * host also running four other test lanes (load average 9-15, ~23 concurrent
 * `bun` processes — the same caveat P2.257 recorded). Two runs, 111 samples:
 *
 *   payload                        run 2 (n=20/20/10)     run 1 (n=8/6/4)
 *   2 items, ~0.2 KB               7.5-56.5 ms (p50 10)   24-876 ms
 *   24 items, ~30 KB               —                      452-591 ms
 *   200 items, ~407 KB             19.4-106.5 ms (p50 32) 41-15286 ms
 *   600 items, ~2.4 MB             49.9-119.2 ms          58-118 ms
 *   1000 items, ~9.8 MB            98.7-174.5 ms (p50 127) 145-170 ms
 *   COLD first call, fresh thread  267 ms                 2500 ms
 *
 * THE REAL WORK IS 7-175 ms across a 50 000x payload range, and it does not
 * grow with the ROLLOUT: run 2 drove the rollout from 0 to 159 MB and the
 * per-call numbers stayed flat, so a long session cannot walk itself into this
 * bound any more than it can walk into P2.257's. Run 1's scatter — including a
 * single 15.3 s sample and a 876 ms answer to a 200-BYTE payload — is the HOST,
 * not codex: 20 repeats of that identical 407 KB call in run 2 topped out at
 * 106 ms. It is recorded rather than discarded because it happened on real
 * hardware, and a user's laptop is a busy machine too.
 *
 * SO: 5 s would be ~29x the slowest honest answer and would still have fired on
 * that 15.3 s sample — a bound sized against a floor it had already been seen
 * below, which is the trap AGENTS.md records twice. 30 s is ~170x the slowest
 * honest answer and ~2x the worst pathological one observed. (120 s since F1.1018, through the alias.)
 *
 * NOT LATCHING, and no capability is switched off on expiry: the handoff is
 * one-shot, the payload is consumed before the call, and the fallback settles
 * the obligation inside the same turn.
 */
export const CODEX_INJECT_ITEMS_TIMEOUT_MS = CODEX_THREAD_REFORK_TIMEOUT_MS;

/**
 * The spawn flag that puts `advisor_consult` on codex's session-MCP surface.
 *
 * {@link CodexAgent.refreshSessionMcpAdvisorAdvertisement} used to read it back
 * off the spec to decide whether the live surface had drifted; since F1.116 it
 * compares the WHOLE argv, so what binds the spelling now is the test below.
 *
 * That method keeps the bare literal rather than this constant, because
 * `codex-callback-bridge-host.test.ts` asserts its emitting expression as source
 * TEXT. What binds the two spellings is mechanical rather than lexical:
 * `codex-advisor-advertisement.test.ts` asserts, with the advisor ON, that the
 * argv `buildSessionMcpSpec` produces CONTAINS this value — so a rename in
 * either place that is not made in both fails immediately, which is the property
 * a shared literal would have bought.
 */
export const CODEX_ADVISOR_CONSULT_FLAG = '--advisor-consult';

/**
 * UB6.11 — is the decision layer configured, for `decide`'s spawn offer? The
 * sync, local stored-settings read (master switch on — the same fact
 * `SessionManager.decisionFeatureActive` reads at binding time, so the offer
 * and the port cannot disagree by more than one respawn). Fail-closed: a read
 * trouble means off, and off means the tool is not advertised.
 */
function decisionToolConfigured(): boolean {
  try {
    const settings = getDecisionLayerSettings();
    return settings.enabled && settings.features.decideTool;
  } catch {
    return false;
  }
}

/**
 * P3.120 · the prefix `describeCodexConfigWarning` stamps on every line it
 * classifies (`codex-agent-server/src/config-warning.ts`).
 *
 * Matched, not imported: that module is exported by neither
 * `codex-agent-server`'s barrel nor its `exports` map, so there is no import
 * path to it from here. The prefix is already the shape P3.81's own live gate
 * selects diagnostics by, so this pins a coupling that exists rather than
 * inventing one — and a drift in it fails LOUDLY, because the surfacing test
 * asserts on a real classifier sentence.
 */
/**
 * P3.348 — codex's own bytes-per-token approximation, `APPROX_BYTES_PER_TOKEN`
 * in `codex-rs/utils/string/src/truncate.rs` at `rust-v0.150.1`.
 *
 * Copied rather than guessed because the round trip depends on it: the host's
 * ceiling is CHARACTERS, `tool_output_token_limit` is TOKENS, and
 * `models-manager/src/model_info.rs::with_config_overrides` converts our token
 * value straight back to bytes with this same constant when the model's
 * truncation policy is byte-shaped — which the production fallback
 * (`model_info_from_slug`, `truncation_policy: bytes(10_000)`) is. Divide by any
 * other number and the operator's 30 000 characters arrive as something else.
 */
const CODEX_APPROX_BYTES_PER_TOKEN = 4;

/**
 * P3.341 — the five resources `cleanupRuntimeResources` releases, as a closed
 * set, so a step added later cannot be reported anonymously.
 */
export type CodexTeardownStep = 'client' | 'manager' | 'adapter' | 'callbackBridge' | 'codexHome';

/**
 * P3.341 — the stable handle a teardown leaf begins with.
 *
 * Exported so the attribution test matches the emitter rather than a copy of its
 * wording: this tree has measured a restated string eventually disagreeing with
 * itself, and this one is read by a human at the exact moment a runtime switch
 * has just been refused.
 */
export const CODEX_TEARDOWN_STEP_FAILURE_PREFIX = 'codex-teardown-step-failed: ';

const CODEX_CONFIG_WARNING_DIAGNOSTIC_PREFIX = '[codex configWarning]';

/**
 * P6.580/F1.734 · codex's "Model metadata for `X` not found" `warning`, matched on BOTH halves of
 * its sentence: a message that merely mentions metadata is a different warning, and neither the
 * caveat nor the repeat-to-debug routing may attach to one.
 */
function isCodexModelMetadataConstantWarning(params: unknown): boolean {
  const message = (params as { message?: unknown } | null)?.message;
  const lowered = typeof message === 'string' ? message.toLowerCase() : '';
  return lowered.includes('model metadata') && lowered.includes('not found');
}

/**
 * P3.267 · the config-writer diagnostic families that describe what THIS SESSION
 * can and cannot do, by the stable machine-readable prefix their formatters
 * stamp (`codex-responses-adapter/src/config-writer.ts`).
 *
 * Restated rather than imported — see
 * {@link CodexAgent.noteCodexConfigWriterDiagnostic} for the cost and the
 * pin that stops it drifting silently.
 */
const CODEX_CONFIG_WRITER_USER_FACING_PREFIXES = [
  'codex-sandbox-egress-denied:',
  'codex-execpolicy-grant-unsandboxed:',
  'codex-execpolicy-grant-sandbox-retained:',
  // P3.337 · `formatCodexAgentRoleDropDiagnostics` — ONE aggregated line naming
  // every agent definition this runtime could not declare. Aggregated rather
  // than per definition precisely because of the eight-notice ceiling below.
  'codex-agent-roles-dropped:',
  // P6.485 · `formatCodexUnhonouredRoleToolGrantNotice` — the sibling that names
  // a role declared WITHOUT the tool restriction it asked for. Its own line
  // rather than a widening of the one above, because that one is a loss and this
  // one is a widening; the model gets MORE than the definition declared.
  'codex-agent-role-tool-grant-unhonoured:',
  // D1.358 · the approval posture this session's config earns, one line per
  // config write — and the one entry here that is IMPORTED rather than restated,
  // because `config-writer.ts` now exports it (see the cost recorded below).
  // Both arms share it: `CODEX_BOUNDED_APPROVAL_NOTICE` for a session whose
  // permission profile bounds the writes, which is every real one, and
  // `CODEX_UNBOUNDED_APPROVAL_NOTICE` for one with no profile. It is a POSTURE
  // rather than a loss, and it is here because a posture the user cannot see is
  // indistinguishable from a defect — the same argument that put the egress
  // line on this list, which rides the very same `writeCodexConfig` call.
  CODEX_APPROVAL_POSTURE_PREFIX,
] as const;

/**
 * P3.28 · per-call bound on the two app-server requests that re-advertise the
 * session MCP surface (`config/value/write`, then `config/mcpServer/reload`).
 *
 * MEASURED, not inherited. {@link CODEX_THREAD_REFORK_TIMEOUT_MS} sat at 30 s (120 s since F1.1018)
 * because a fork carries the conversation and was measured in the hundreds of
 * milliseconds; this pair is a config-key edit and a re-spawn trigger, and 20
 * samples against the bundled binary (2026-08-27, with a deliberately slow
 * 3 s/response second MCP server also configured, so the reload had something
 * to be slow about) gave min 7.2 ms / p50 14.1 ms / max 31.8 ms. `reload`
 * TRIGGERS re-initialization rather than awaiting it, which is why a slow server
 * does not enter this number.
 *
 * 5 s is ~157x that slowest sample — the same order of headroom the re-fork
 * bound took, sized against this call's own resting state rather than a
 * sibling's. It is deliberately not smaller: a bound set near the resting state
 * manufactures its own failures on a busy laptop.
 *
 * NOT LATCHING and nothing is switched off on expiry: the caller leaves its
 * record of the live surface alone, so the next turn retries, and the meantime
 * behaviour is exactly the pre-P3.28 one.
 */
const CODEX_MCP_ADVERTISEMENT_REFRESH_TIMEOUT_MS = 5_000;

/**
 * The result {@link requestWithinDeadline} resolves when the deadline expires
 * before the app-server answers.
 *
 * A SENTINEL RATHER THAN A REJECTION — the one place this deliberately diverges
 * from P2.138's `requestWithDeadline`. The caller's `catch` classifies a
 * rejection as DEFINITIVE ("this method is not here", latch the capability off
 * for the session) or transient, and a deadline is neither: it is the ABSENCE of
 * an answer to classify. P2.138 kept its deadline off the definitive arm by
 * giving the rejection no `code`; here the classifier reads the MESSAGE
 * ({@link isDefinitiveBackgroundTerminalsRefusal}), so a timeout worded one
 * serde-looking word differently would latch background terminals off for the
 * whole session. Resolving a sentinel means a deadline cannot reach the
 * classifier at all — but ONLY because {@link CODEX_DEADLINE_CHANNEL_MARGIN_MS}
 * makes the sentinel win the tie.
 *
 * IT DID NOT WIN AS FIRST SHIPPED, and the sentence above was false on every real
 * channel for one commit: both timers were armed with the same number, the
 * client's was registered first, and so every production deadline reached that
 * `catch` after all. Nothing latched even then — but by a SECOND mechanism,
 * unclaimed and undocumented: `app-server request <method> timed out after <n>ms`
 * carries no serde token and no `code`, so
 * {@link isDefinitiveBackgroundTerminalsRefusal} returns false — and so does the
 * `configRequirements` probe, which since P2.243 asks the same shared function. That mechanism is real and is
 * kept — it is why the wrong branch was survivable rather than a session-wide
 * latch — but it is one reworded upstream message away from untrue, which is the
 * exact fragility the sentinel exists to remove. Both hold now; the sentinel is
 * the one that fires.
 */
const CODEX_REQUEST_TIMED_OUT = Symbol('codex-request-timed-out');

/**
 * P2.245 · extra time handed to the CHANNEL's own timer so that the SENTINEL
 * wins the tie.
 *
 * WITHOUT IT THE SENTINEL IS DEAD IN PRODUCTION, which is how this row first
 * shipped. Both timers were armed with the same number, and `client.request(...)`
 * is evaluated FIRST in the race below, so a real {@link AppServerClient}
 * registered its `setTimeout` first and its rejection always arrived first. The
 * sentinel branch was reachable only from a double that DROPS the `timeoutMs`
 * option — which is what every test in this row used, so the suite was green with
 * the behaviour and without it.
 *
 * WHAT THAT COST, MEASURED with a faithful three-argument double against the
 * committed code: a mid-walk deadline announced NOTHING (`EVENTS: []`) and wrote
 * no `did not answer within` line. Pages that had ALREADY arrived were discarded
 * by the transient `catch`, and the operator-facing degradation line — the whole
 * of "degradation is announce-only, not silence" — never fired on a real channel.
 *
 * THE ORDERING IS DETERMINISTIC rather than a gamble: timers fire in DUE-TIME
 * order, not registration order, so the earlier deadline wins however starved the
 * loop is. 50 ms is large enough to survive the rounding below and a coarser
 * timer implementation, and it is 1% of this row's 5 s budget, so it moves no
 * bound anybody reasons about.
 *
 * LOSING DOES NOT MAKE THE CHANNEL'S TIMER REDUNDANT: it is the only thing that
 * deletes the pending entry and its `reject` closure from
 * {@link AppServerClient}'s map, which a race cannot reach inside to do. It must
 * still be armed — just late.
 *
 * NOT A KNOB. Every caller of {@link requestWithinDeadline} is written around the
 * sentinel arm, so a margin a caller could forget to pass would be the same
 * defect with a longer fuse.
 */
const CODEX_DEADLINE_CHANNEL_MARGIN_MS = 50;

/**
 * Ask the app-server, and give up after `timeoutMs` whatever the channel does.
 *
 * TWO mechanisms, and the second is not redundant — the pairing P2.138
 * established. The `timeoutMs` handed to the channel is what lets a real
 * {@link AppServerClient} reclaim its pending entry and its timer, which a race
 * cannot do from outside. The race is what makes the deadline a property of THIS
 * caller rather than a favour from whichever object sits on `this.client`: a
 * channel whose `request` takes two arguments drops the option on the floor, and
 * that would restore the exact hang this exists to prevent.
 *
 * THE TWO ARE ORDERED, and the order is the whole behaviour — see
 * {@link CODEX_DEADLINE_CHANNEL_MARGIN_MS}. Armed with the same number the
 * CHANNEL wins, and the caller gets an error to classify instead of the sentinel
 * it is written around; armed with the margin the sentinel wins on every channel,
 * and the classifier is never reached. Neither arm can be pinned by a double that
 * ignores `timeoutMs`, which is why the tests below drive one double of each kind
 * on purpose — a suite that is green with the behaviour and without it is not a
 * suite.
 *
 * THE LOSER'S LATE REJECTION IS NOT UNHANDLED. `Promise.race` subscribes to both
 * arms, so when the channel rejects a margin later — after this function has
 * already returned the sentinel — that rejection is delivered to a reaction the
 * race installed and goes nowhere (pinned below).
 *
 * The timer is cleared on the fast path, so a poll that answers in 0.2 ms does
 * not hold the event loop open for five seconds afterwards.
 */
async function requestWithinDeadline(
  client: { request: (method: string, params?: unknown, options?: { timeoutMs?: number }) => Promise<unknown> },
  method: string,
  params: unknown,
  timeoutMs: number,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      // WHOLE milliseconds, and MORE of them than the race gets. Whole, because
      // this number reaches an operator verbatim inside the channel's own message
      // (`… timed out after 59.70074999999997ms` was a real debug line — the
      // budget arrives here as a `performance.now()` difference). More, because of
      // {@link CODEX_DEADLINE_CHANNEL_MARGIN_MS}.
      client.request(method, params, { timeoutMs: Math.ceil(timeoutMs) + CODEX_DEADLINE_CHANNEL_MARGIN_MS }),
      new Promise<typeof CODEX_REQUEST_TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(CODEX_REQUEST_TIMED_OUT), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function createEventQueue() {
  const buffer: AgentEvent[] = [];
  let done = false;
  let wake: (() => void) | null = null;
  return {
    push(e: AgentEvent) {
      buffer.push(e);
      wake?.();
    },
    finish() {
      done = true;
      wake?.();
    },
    async *drain(): AsyncGenerator<AgentEvent> {
      for (;;) {
        if (buffer.length) {
          yield buffer.shift()!;
          continue;
        }
        if (done) return;
        await new Promise<void>((r) => {
          wake = () => {
            wake = null;
            r();
          };
        });
      }
    },
  };
}

// ============================================================
// Permission rules on the approval path (R6)
// ============================================================

/**
 * One codex approval expressed as the tool call our permission rules are
 * written about — Claude's canonical tool name, the manifest id the shell
 * matchers key off, and the tool input a rule reads.
 *
 * `cwd` is the directory the action will actually run in (the request's own,
 * when it carries one), because a `Bash(...)` rule may be rooted at a directory
 * and a relative path rule anchors there.
 */
export interface CodexApprovalRuleRequest {
  toolName: string;
  semanticId: string;
  input: Record<string, unknown>;
  cwd: string; alias?: CodexRuleRequestAlias; // F1.379 — Pi's name for the SAME call; see the type
}

/**
 * P2.280 · the T5 host-callback bridge's outcome for the LIVE runtime.
 *
 * - `not-started` — no runtime has been built yet, or the last one was torn
 *   down. **The scheduling surface is UNKNOWN, not absent**, and nothing may
 *   withhold a capability on the strength of it. This is the state every codex
 *   session is in until its first turn calls `ensureRuntime`.
 * - `active` — the bridge is listening, so `--host-callback-port` reached the
 *   session MCP spawn and the eight bridged tools are advertised.
 * - `unavailable` — the bridge did not start (a failed listen, or a config with
 *   no session identity to bind to). The spawn omits the argument either way,
 *   so the four cron tools do not exist for this runtime's lifetime.
 */
export type CodexSchedulingBridgeState = 'not-started' | 'active' | 'unavailable';

/**
 * An argv word that survives `join(' ')` as the same command.
 *
 * v1's `execCommandApproval` carries argv, not a command line, and a rule is
 * written against a command line. Joining `['bash', '-c', 'rm -rf /']` produces
 * a string whose shell parse is NOT the call codex is asking about, so a word
 * carrying whitespace, quoting or any other shell metacharacter takes the whole
 * request off the rule path and back to the human. Answering a request we did
 * not really match is the one outcome worse than not consulting rules at all.
 */
const SHELL_SAFE_ARGV_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * P6.644 — the ONE vocabulary for "codex is about to change this file", shared
 * by both approval projections.
 *
 * ## The defect
 *
 * The two projections spelled the same act differently: the rule path emitted
 * `Edit` and the floor path emitted `Write`. So an `Edit(...)` deny had no floor
 * subject and a `Write(...)` allow had no rule subject — each rule silently
 * missed half the gate, and the mismatch was reasoned nowhere. Found twice
 * independently (W7-s2, then W8-doc1).
 *
 * ## BOTH names, not one — the deviation from the row's "one spelling", with the
 * reason
 *
 * Picking a winner closes the asymmetry and SILENTLY BREAKS every existing rule
 * written with the loser: an `Edit(src/**)` deny aimed at a codex patch would
 * stop matching, with nothing to tell the user. That is the same class of defect
 * the row exists to remove, moved rather than removed.
 *
 * And "one spelling" is not what the host's own vocabulary has. `mode-manager.ts`
 * already treats `Write`, `Edit`, `MultiEdit` and `NotebookEdit` as ONE class for
 * the write act (`:3276`, `:3463`), matching any of the four — so this act has
 * always had several names here, and each projection had simply picked a
 * different one of them. The `permission-dsl` matcher does NOT expand that class:
 * it matches a rule against `semanticId` or the literal `toolName`
 * (`permission-dsl.ts:1237`), which is exactly why one name cannot serve.
 *
 * Emitting both is safe in both directions. A deny matching either name refuses,
 * and a deny outranks an allow. An allow matches only the name the user actually
 * wrote. And neither name is a fabrication: codex's `applyPatchApproval` both
 * CREATES and MODIFIES files, so `Write` is right for the create half and `Edit`
 * for the modify half — which is why no single name was ever correct.
 *
 * The order is `Write` first because that is the name the floor already renders
 * to the user (`"Write attempted to access …"`, pinned in
 * `codex-permission-floors.test.ts`), so the sentence a refusal produces does not
 * change.
 */
const CODEX_FILE_CHANGE_TOOL_NAMES = ['Write', 'Edit'] as const;

/**
 * UB12.65 — the directory a codex approval's command runs in: the frame's own `cwd` (both command kinds carry
 * one, `CommandExecutionRequestApprovalParams.cwd` and `ExecCommandApprovalParams.cwd`), else `fallbackCwd`
 * (the session's working directory, where the codex child was spawned; a v1 patch frame has no `cwd`). ONE
 * reading for the rule path ({@link codexApprovalRuleRequests}) and the `deniedPaths` floor
 * (`CodexAgent.deniedPathVerdict`), so a relative token cannot be resolved at one directory by the path that may
 * approve and at another by the path that must refuse.
 */
function codexApprovalCwd(params: unknown, fallbackCwd: string): string {
  const p = isPlainRecord(params) ? params : {};
  return typeof p.cwd === 'string' && p.cwd.trim().length > 0 ? p.cwd : fallbackCwd;
}

/**
 * The rule requests one codex approval maps to, or `[]` when none is faithful.
 *
 * FAITHFUL, and nothing else — the three honest limits are deliberate, not
 * gaps waiting to be filled:
 *
 * - **`fileChange` (v2) names no path IN THE FRAME, and C3.386 supplies them
 *   from the item instead.** `FileChangeRequestApprovalParams` is
 *   `{threadId, turnId, itemId, startedAtMs, reason?, grantRoot?}`; `grantRoot`
 *   is "allow writes under this root for the remainder of the session", which
 *   is not the file being written. Reading it as `file_path` would let
 *   `Edit(src/**)` answer a request about a directory nobody named — so it
 *   still is not read, and that refusal stands. What changed is the SOURCE: the
 *   frame's `itemId` names an item whose `changes[].path` this process already
 *   received on `item/started`, and the caller passes that set in as
 *   `fileChangePaths`. With it, this case emits exactly what `fileChangeV1`
 *   emits; without it (the set is empty, or the announcement has not arrived)
 *   it still returns `[]` and the human is still the fallback. Nothing is
 *   inferred from the frame that the frame does not contain.
 * - **An MCP elicitation is judged only as codex's MCP TOOL-CALL approval**
 *   (F1.272): at `rust-v0.154.0` that frame names the tool in codex's fixed
 *   sentence, and {@link codexMcpToolCallRuleRequests} projects it under the
 *   name Pi and claude record for the same call. A server's own question, a url
 *   elicitation or a connector's template sentence names no tool and stays `[]`.
 * - **A `request_permissions` approval has no rule vocabulary at all.** It asks
 *   to widen the turn's sandbox (network, extra read/write roots); no rule form
 *   speaks about that, so every one of them reaches the human.
 *
 * Each of those returns `[]`, which is the "unmatched → ask the user" path.
 */
export function codexApprovalRuleRequests(
  kind: ApprovalKind,
  params: unknown,
  fallbackCwd: string,
  /**
   * C3.386 — the paths the v2 `fileChange` frame does not carry, resolved by the
   * caller from the frame's `itemId`. Empty (the default) keeps this function's
   * pre-C3.386 answer for that kind exactly: `[]`, i.e. ask the human.
   */
  fileChangePaths: readonly string[] = [],
): CodexApprovalRuleRequest[] {
  const p = isPlainRecord(params) ? params : {};
  const cwd = codexApprovalCwd(params, fallbackCwd);
  switch (kind) {
    case 'command': {
      // I2.15 · THE SAME REFUSAL P7.2 MADE ON THE CARD AND ON THE DURABLE
      // GRANT, on the one layer that answers ABOVE both of them.
      //
      // `approvalKindForMethod` maps every frame on
      // `item/commandExecution/requestApproval` to the host kind `'command'` —
      // correctly, that is the METHOD — so the WIRE kind
      // (`CommandExecutionApprovalKind`, `"command" | "writeStdin"` at
      // `rust-v0.154.0`) has to be read here. A `writeStdin` frame carries
      // `command` as the command that STARTED the terminal, so projecting it
      // let a `Bash(<that command>)` allow rule approve sending arbitrary input
      // into the running process — silently, because `consultPermissionRules`
      // returns before the card `mapCommandApprovalToRequest` would have
      // rendered, and needing neither a durable grant nor an unattended turn.
      //
      // `[]` is this function's own documented "unmatched → ask the user"
      // answer, and it is what makes a third enum member safe on arrival. No
      // stdin rule vocabulary is invented: there is no rule form that speaks
      // about stdin, and one built here could only WIDEN.
      // {@link codexApprovalFloorSubjects} is deliberately NOT changed — it may
      // only tighten, so its wider rendering of the same frame is safe.
      const wireKind = typeof p.kind === 'string' && p.kind ? p.kind : 'command';
      if (wireKind !== 'command') return [];
      // F1.823 — v2 carries codex's login-shell TRANSPORT (`/bin/zsh -lc '<cmd>'`), while a `Bash(...)` rule is written
      // against the model's `<cmd>`: {@link loginShellScript} unwraps exactly one layer, else the frame's text as before.
      const frame = typeof p.command === 'string' ? p.command.trim() : '', command = loginShellScript(frame) ?? frame;
      return command ? [{ toolName: 'Bash', semanticId: 'bash', input: { command }, cwd }] : [];
    }
    case 'commandV1': {
      const argv = Array.isArray(p.command) ? p.command : [];
      const usable = argv.length > 0
        && argv.every(word => typeof word === 'string' && SHELL_SAFE_ARGV_WORD.test(word));
      return usable
        ? [{ toolName: 'Bash', semanticId: 'bash', input: { command: argv.join(' ') }, cwd }]
        : [];
    }
    case 'fileChange':
    case 'fileChangeV1': {
      // v1's `applyPatchApproval` DOES name its files: the changed paths are the
      // keys of `fileChanges`. C3.386 · v2's frame does not, so its paths arrive
      // as `fileChangePaths`, resolved by the caller from the frame's `itemId`.
      // ONE branch for both, deliberately: two would be two chances for the two
      // protocol versions to answer the same user rule differently.
      const changes = kind === 'fileChange'
        ? [...fileChangePaths]
        : (isPlainRecord(p.fileChanges) ? Object.keys(p.fileChanges) : []);
      // P6.644 · one request per path PER NAME. See
      // `CODEX_FILE_CHANGE_TOOL_NAMES`: the floor spelled this act `Write` and
      // this path spelled it `Edit`, so each rule missed half the gate.
      return changes
        .filter(filePath => filePath.trim().length > 0)
        .flatMap(filePath => CODEX_FILE_CHANGE_TOOL_NAMES.map(toolName => ({
          toolName,
          semanticId: toolName.toLowerCase(),
          input: { file_path: filePath },
          cwd,
        })));
    }
    default:
      return kind === 'elicitation' ? codexMcpToolCallRuleRequests(p, cwd) : [];
  }
}

/**
 * The subjects one codex approval offers the FLOOR matchers — a strictly wider
 * rendering than {@link codexApprovalRuleRequests} produces, and deliberately so.
 *
 * ## Why this is a second projection and not a reuse
 *
 * `codexApprovalRuleRequests` is the ALLOW path's projection, and it is narrow
 * on purpose: a word carrying shell metacharacters takes a v1 argv request off
 * the rule path entirely, because "answering a request we did not really match
 * is the one outcome worse than not consulting rules at all". That asymmetry is
 * correct for a path that can APPROVE and wrong for a path that can only refuse
 * (P2.123, may-only-tighten). Reusing it here would have been the whole gap in
 * one line: `['bash', '-lc', 'rm -rf ~']` fails `SHELL_SAFE_ARGV_WORD` on its
 * third word, so the allow projection yields `[]` — and a floor that reads `[]`
 * sees nothing in exactly the class it exists for.
 *
 * So the floor reads the argv BOTH ways: the joined command line AND every
 * individual word, because a `-c`/`-lc` operand IS a whole script sitting in one
 * argv slot and the joined form loses its quoting. A false floor hit costs a
 * card; a missed one costs the user's home directory.
 *
 * ## What carries no subject at all, stated rather than left to be discovered
 *
 * - `fileChange` (v2) names no path — `{threadId, turnId, itemId, startedAtMs,
 *   reason?, grantRoot?}` — so the protected-path floor has nothing to read. The
 *   v1 `applyPatchApproval` DOES name its files and is covered.
 * - `elicitation` and `permissions` have no shell or path vocabulary; the first
 *   is an MCP server's question and the second asks to widen the turn's sandbox.
 *
 * Those three return `[]`, which means "no floor is visible here" and NOT "no
 * floor applies". The residual is written into the report rather than hidden: on
 * codex, a v2 patch approval is floor-invisible for protected paths.
 *
 * ## P6.700 — AN MCP TOOL CALL REACHES NO HOST FLOOR ON CODEX, and why
 *
 * Written here because every row that touches this subject has re-derived it
 * from scratch (P6.466 was the third). Two measurements, both at HEAD:
 *
 * 1. **This function is the whole floor surface on codex, and it has three
 *    subjects.** `command`, `commandV1` and `fileChangeV1` — an MCP tool call is
 *    none of them, so it produces no subject and no floor is consulted.
 * 2. **The other gate does not run here at all.** `runPreToolUseChecks`, where
 *    `INTERACTION_ONLY_TOOLS` and the rest of the Pi/claude pre-tool vocabulary
 *    live (`core/pre-tool-use.ts`), has **zero call sites in this file** — the
 *    only occurrence is the comment recording that zero.
 *
 * **NATIVE MECHANISM: there is none to enable, and the source says so by
 * enumeration.** `packages/codex-protocol/generated/ServerRequest.ts` is the
 * complete set of requests codex initiates toward this client, and it has TEN
 * methods: `item/commandExecution/requestApproval`,
 * `item/fileChange/requestApproval`, `item/tool/requestUserInput`,
 * `mcpServer/elicitation/request`, `item/permissions/requestApproval`,
 * `item/tool/call`, `account/chatgptAuthTokens/refresh`,
 * `attestation/generate`, plus the v1 `applyPatchApproval` and
 * `execCommandApproval`. **None is an MCP tool-call approval.** The only
 * MCP-shaped member is `mcpServer/elicitation/request`, which is an MCP SERVER
 * asking the user a question — not codex asking to run a tool. Every other
 * MCP-tool-call type in the generated tree is a REPORT after the fact
 * (`McpToolCallProgressNotification`, `McpToolCallStatus`, `McpToolCallResult`,
 * `McpToolCallError`). The two approval methods that ARE there are the positive
 * control: the union was read, and the absence is of a member rather than of a
 * file.
 *
 * So gating an MCP tool call on codex is only reachable the way P6.466 did it —
 * a HOST CLOSURE around the tool itself, which is why that pattern exists rather
 * than being a stylistic choice. The switch-cost table is deliberately unchanged:
 * P6.466 measured no cost, because the host closure it added covers the session
 * tools on all three runtimes.
 *
 * ## P6.880 — WHICH host floors are owed here, asked one by one (2026-09-08)
 *
 * The zero above is a fact about a call site; it is not by itself a gap. The row
 * asked the only question that decides whether a call belongs here, and the
 * answer is different for each of the three floors it named. **No
 * `runPreToolUseChecks` call site is owed in this file**, and the reasons are
 * three rather than one:
 *
 * 1. **The read fence (P6.202 / P6.809) has NO SUBJECT here, structurally.** It
 *    keys on `Read`/`Grep`/`Glob`/`Find`/`Ls`
 *    (`READS_OUTSIDE_WORKING_DIRECTORIES_TOOLS`), and codex performs those with
 *    its OWN built-ins inside the app-server. Every request codex initiates
 *    toward this client is enumerated above — TEN methods, none of them a read
 *    approval — so a gate placed on the approval path would never see one. The
 *    native mechanism that CAN express a read boundary is codex's own
 *    `[permissions.<profile>.filesystem]` map, which is OS-enforced, emitted for
 *    every real session by `resolveCodexRuntimePathPolicy`, and whose
 *    `FileSystemAccessMode` is a real three-value `read`/`write`/`deny` with
 *    `deny` beating `write` beating `read` (`config-schema.json`). Projecting
 *    the fence into it means denying the whole filesystem and granting `read` on
 *    the working roots — which would also refuse toolchains, caches and every
 *    path outside the project. That is a PRODUCT POSTURE, not a lane's call, so
 *    it is reported rather than built.
 * 2. **The worktree floor (P6.137) is already CLOSED here, by a different
 *    route.** `evaluateWorktreeApproval` runs inside `runPreToolUseChecks`, so
 *    the three worktree tools crossing to a bridged codex spawn brought their
 *    own floor: `SessionManager.authorizeWorktreeEnter` sits in front of the
 *    `worktree/enter` bridge route and raises the host's own card with the same
 *    sentence Pi and claude get (`describeWorktreeEnterApproval`). Driven by
 *    `server-core/src/sessions/__tests__/codex-worktree-enter-floor.test.ts`.
 *    Nothing is owed.
 * 3. **`code_edit_tool.decision` is not a floor at all**, and treating it as one
 *    is what made P6.461 call it *"the cheapest of the six"*. It counts a
 *    PERSON'S answer — `monitoring-usage.md#code-edit-tool-decision-counter`:
 *    *"Incremented when user accepts or rejects Edit, Write, or NotebookEdit
 *    tool usage."* — so its uniform site is `SessionManager.respondToPermission`,
 *    which claude and Pi reach through the pre-tool gate's prompt and codex
 *    reaches through this file's approval bridge. Landed there, not here.
 */
function codexApprovalFloorSubjects(
  kind: ApprovalKind,
  params: unknown,
  /** C3.386 — see {@link codexApprovalRuleRequests}'s parameter of the same name. */
  fileChangePaths: readonly string[] = [],
): Array<{ toolName: string; input: Record<string, unknown> }> {
  const p = isPlainRecord(params) ? params : {};
  switch (kind) {
    case 'command': {
      const command = typeof p.command === 'string' ? p.command.trim() : '';
      return command ? [{ toolName: 'Bash', input: { command } }] : [];
    }
    case 'commandV1': {
      const argv = (Array.isArray(p.command) ? p.command : [])
        .filter((word): word is string => typeof word === 'string');
      if (argv.length === 0) return [];
      const subjects = [{ toolName: 'Bash', input: { command: argv.join(' ') } }];
      // Every word on its own too: a `-c`/`-lc` script is one argv slot, and
      // joining it into the line destroys the quoting the matcher reads.
      for (const word of argv) {
        if (word.trim().length > 0) subjects.push({ toolName: 'Bash', input: { command: word } });
      }
      return subjects;
    }
    case 'fileChange':
    case 'fileChangeV1': {
      // C3.386 · v2's frame carries no paths, so they arrive as
      // `fileChangePaths` from the caller's `itemId` lookup. Same single branch
      // as the rule path, for the same reason.
      const changes = kind === 'fileChange'
        ? [...fileChangePaths]
        : (isPlainRecord(p.fileChanges) ? Object.keys(p.fileChanges) : []);
      // P6.644 · the same two names the rule path now emits, so a floor pattern
      // and a user rule cannot be written against different halves of one act.
      return changes
        .filter(filePath => filePath.trim().length > 0)
        .flatMap(filePath => CODEX_FILE_CHANGE_TOOL_NAMES
          .map(toolName => ({ toolName, input: { file_path: filePath } })));
    }
    default:
      return [];
  }
}

/**
 * The extra CA file this app hands its other subprocesses, for the codex child
 * to receive under the ONE name its trust store reads (`CODEX_CA_CERTIFICATE`
 * — see `applyCodexCaCertificate` in `runtime-manager.ts` for the contract,
 * verified against `openai/codex`'s `custom_ca.rs` and the shipped binary).
 *
 * THIS function is still not a spread: exactly ONE key is read out of
 * `getProxyEnvVars()` here, and the mTLS trio stays out because it is a
 * passphrase the binary provably never reads (P2.213's scan: zero occurrences,
 * against `CODEX_HOME` 34 and `OPENAI_API_KEY` 16).
 *
 * **What is no longer true, and was, until C3.369 on 2026-09-12:** that codex is
 * not a consumer of the env projection at all. The spawn literal in
 * {@link CodexAgent.createRuntime} now spreads
 * `packages/shared/src/config/proxy-env.ts` symbol `buildShellChildNetworkEnv`,
 * because the condition P2.213 attached to that refusal — *"adding it is a
 * REGRESSION unless loopback is exempted first"* — is discharged twice over
 * there. That projection carries the proxy names and `NODE_EXTRA_CA_CERTS`
 * for codex's own shell CHILDREN; this one re-badges a single path for the
 * codex BINARY, whose trust store reads neither of those names. Two different
 * consumers, which is why both exist.
 *
 * Two terms, because the projection deliberately OMITS `NODE_EXTRA_CA_CERTS`
 * in the one case where the operator's own ambient value must win over the
 * app-default bundle — in that case the winning file is the ambient one, and
 * the codex child needs it re-badged just the same. When the projection does
 * emit the key it has already resolved the managed > custom > operator >
 * bundled ladder, so its answer is taken first and no second copy of that
 * precedence lives here.
 */
function resolveCodexCaCertificatePath(): string | undefined {
  const projected = getProxyEnvVars().NODE_EXTRA_CA_CERTS;
  const path = projected ?? process.env.NODE_EXTRA_CA_CERTS;
  return path ? path : undefined;
}

/**
 * P3.182 — codex persists EVERY tool output to a rollout file, secrets
 * included, and nothing told anyone.
 *
 * ## Native-first: asked before anything was built, and the answer is `cannot`
 *
 * All three plausible controls were probed against the shipped
 * `codex-app-server` (`apps/electron/resources/bin/codex/darwin-arm64`, md5
 * `eb2144664b1c4eb0697b69b4b242b737`, rust-v0.148.0, 2026-09-01). STRONG tier —
 * the artifact we ship, not a vendor page:
 *
 *  - **Disabling persistence: no.** The binary's own serde field list —
 *    `struct ConfigToml with 97 elements` — carries `history`, `sqlite_home`
 *    and `log_dir`, and NO rollout key of any spelling. The full `CODEX_*`
 *    environment surface likewise has no off switch;
 *    `CODEX_ROLLOUT_TRACE_ROOT` relocates a debug TRACE, not the rollout.
 *  - **A retention setting: no.** `codex_rollout::maintenance` and
 *    `::compression` exist, but they ARCHIVE and COMPRESS rollouts; neither is
 *    an operator-settable retention. `[memories]`'s `max_rollout_age_days` /
 *    `min_rollout_idle_hours` bound what the memories feature READS, not what
 *    is kept.
 *  - **Redaction: no.** Every occurrence of `redact` in the artifact is inside
 *    the vendored AWS SDK's `Debug` impls (`** redacted **` beside
 *    `secret_access_key`). Nothing redacts a rollout.
 *
 * So the runtime cannot, on all three. What exists is entirely ours.
 *
 * ## What was measured, and the premise it corrects
 *
 * Driving the shipped binary over stdio against a scratch home: `thread/start`
 * ALONE materialises `CODEX_HOME/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<uuid>
 * .jsonl`, and one turn put the user's prompt into it verbatim, twice.
 *
 * The file lands at mode **644**, and `sessions/` and all three date segments
 * at **755** — codex sets no restrictive mode of its own (umask 022 on the
 * rig). POSITIVE CONTROL on the same rig, which is what makes that a reading
 * rather than an instrument artifact: `.sandbox_migration`, written by the same
 * process into the same home, lands at **600**. Codex does choose 0600 where it
 * wants to; for the rollout it does not.
 *
 * The row asked whether this is "entirely acceptable" or "a credential at rest
 * we did not know we had", and the answer is nearer the first than it assumed —
 * but for a reason the row did not have: {@link createRuntime} builds the home
 * with `mkdtempSync` + `chmodSync(0o700)` and `cleanupRuntimeResources` removes
 * it with `rmSync`. The rollout is owner-only (since F1.1074 kept per session until the session is deleted — `linkCodexKeptSessions`). THE
 * CONTAINMENT IS OURS, NOT CODEX'S — two lines, in two different methods,
 * neither previously documented as load-bearing and neither pinned by a test.
 * That is the real residue, and it is why this row ships a sentence and a
 * regression pin rather than a mechanism.
 *
 * ## The distinction worth stating to an operator
 *
 * A credential the permission floor stops a tool from READING is a different
 * thing from a credential a tool has already read and codex has written to
 * disk. The floor and the persistence are SEPARATE controls, and only the first
 * one exists as a control at all.
 *
 * ## C3.254 — re-measured at `rust-v0.150.1`, and the sentence gained a noun
 *
 * Everything above was measured at `rust-v0.148.0`. W15-e then drove the
 * `0.150.1` binary across three boots and saw **no `sessions/` directory at
 * all**, while `state_5.sqlite-wal` grew to 1.7 MB — which reads like the
 * transcript having moved into the state DB, i.e. like this sentence naming a
 * path that no longer exists. It has not moved. Two readings, 2026-09-12, both
 * at `rust-v0.150.1`:
 *
 *  - **The source says the path is unchanged and the MOMENT moved.**
 *    `codex-rs/rollout/src/lib.rs` still has `SESSIONS_SUBDIR = "sessions"` and
 *    `recorder.rs`'s `precompute_new_rollout_path` still builds
 *    `<codex_home>/sessions/<yyyy>/<mm>/<dd>/`; what changed is that
 *    `RolloutRecorder::new` now *"defers file creation/open until an explicit
 *    `persist()` call"* for a new session (`deferred_creation: true`). A boot
 *    with no turn therefore leaves no directory, which is exactly what W15-e
 *    saw and is not a relocation.
 *  - **The shipped binary agrees, driven.**
 *    `__tests__/codex-rollout-path-e2e.test.ts` boots it against the loopback
 *    stub adapter: `thread/start` alone leaves no rollout (the control), one
 *    real turn creates `sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<uuid>.jsonl`
 *    carrying the prompt verbatim, still not owner-only.
 *
 * **What the re-measurement DID change is that there are now two copies.**
 * `rollout/src/state_db.rs`'s `apply_rollout_items` hands the same items to the
 * state DB beside the file, and the same run found the fixture marker inside
 * `state_5.sqlite` in the same home. Both copies sit under the 0700 directory
 * this app deletes, so the containment is unchanged — but a sentence naming
 * only the `.jsonl` would leave an operator believing that file is the whole of
 * it, so the sentence names the state DB too.
 *
 * Both readings are WAITED for rather than taken once: the rollout file is
 * created empty and flushed by codex's own writer task, so a single read
 * straight after the turn returns `''` and would have been recorded as "the
 * prompt is no longer in the rollout" — measured, it was, before the wait.
 */
export function describeCodexRolloutPersistence(codexHome: string): string {
  return '[codex persistence] codex writes every turn — prompts, tool arguments and full tool '
    + `OUTPUT — to a rollout file under ${codexHome}/sessions/, at file mode 0644 (codex sets no `
    + 'restrictive mode of its own), and since rust-v0.150.1 the same turn is written a SECOND '
    + `time into the state database in that home (${codexHome}/state_5.sqlite), so the rollout `
    + 'file is not the only copy. This app contains both: the home is private (0700) and deleted when the runtime is torn down, and the '
    + 'rollout files sit in a private (0700) folder beside it that is kept so a restart can resume the thread, and deleted with the session. '
    + 'Codex offers no redaction, no retention setting and no way to disable this, so containment '
    + 'is the only control available. Note that a secret the permission floor stops a tool from '
    + 'READING is a different thing from a secret a tool already read: the floor does not reach '
    + 'what codex has already written.';
}

/**
 * C3.67 — the paths one codex `fileChange` item is about to write, absolute.
 *
 * Pure and exported so the extraction can be tested without a live app-server;
 * the call site is {@link CodexAgent.checkpointCodexFileChange}.
 *
 * ## What the notification carries, read at the tag
 *
 * `github.com/openai/codex` at `rust-v0.150.1`,
 * `app-server-protocol/src/protocol/item_builders.rs`: `build_file_change_begin_item`
 * builds `ThreadItem::FileChange { id, changes, status: InProgress }` from a
 * `PatchApplyBeginEvent`, and `convert_patch_changes` maps codex's
 * `HashMap<PathBuf, FileChange>` into `FileUpdateChange { path, kind, diff }`,
 * sorted by path. Those are codex's own resolved paths, so they are normally
 * absolute; a relative one is resolved against the session's working directory
 * rather than dropped, because `createFileCheckpoint` refuses a relative
 * `authorizedTarget` outright and a dropped path is a silent non-checkpoint.
 *
 * Anything that is not a non-empty string is skipped rather than guessed at.
 */
export function codexFileChangePaths(item: unknown, workingDirectory: string | undefined): string[] {
  if (!isPlainRecord(item) || item.type !== 'fileChange') return [];
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const paths: string[] = [];
  for (const change of changes) {
    const raw = isPlainRecord(change) ? change.path : undefined;
    if (typeof raw !== 'string' || raw.trim().length === 0) continue;
    const absolute = isAbsolute(raw)
      ? raw
      : (workingDirectory ? resolvePath(workingDirectory, raw) : undefined);
    if (!absolute) continue;
    if (!paths.includes(absolute)) paths.push(absolute);
  }
  return paths;
}

/**
 * Where the host keeps the one codex identity that outlives a session.
 * A file rather than a preference key: it is written by the runtime builder,
 * which runs before any preference store is guaranteed loaded, and codex's own
 * copy of it is a file too.
 */
const CODEX_INSTALLATION_ID_FILE = 'codex-installation-id';

/** A canonical 8-4-4-4-12 UUID, the only shape codex keeps — see below. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * P3.296 — one host-stable `installation_id`, seeded into every per-session
 * `CODEX_HOME`.
 *
 * ## The problem, measured
 *
 * {@link CodexAgent.createRuntime} builds a fresh `mkdtempSync` home per session
 * and `cleanupRuntimeResources` deletes it, so codex's own durable state is
 * destroyed every session. Driven on the shipped
 * `darwin-arm64/codex-app-server` (2026-09-03, `initialize` → `thread/start` →
 * one turn), a cold home comes back holding `installation_id`, five sqlite
 * databases with their WALs (`state_5`, `goals_1`, `logs_2`, `memories_1`,
 * `queue_1`), the re-extracted bundled `skills/` tree (87 entries),
 * `shell_snapshots/`, `thread-writer-locks/` and `.sandbox_migration` — about
 * 2.6 MiB by `du`, all of it thrown away. Two cold homes get two DIFFERENT
 * `installation_id`s, which is the positive control that this is regenerated
 * rather than derived.
 *
 * ## What is restored here, and what is declined
 *
 * RESTORED: the identity. `installation_id` is the binary's own long-lived
 * identifier and the cheapest thing to make stable — one file, written once.
 *
 * DECLINED, with the cost measured rather than asserted: the five sqlite
 * databases and the skills re-extraction. Alternating cold and skills-warm homes
 * on the same rig (four pairs, load 14 → 23, so the arms share the noise) put
 * the median `thread/start` at **957 ms cold against 771 ms warm** — roughly
 * 190 ms of per-session startup, against carrying a shared mutable sqlite set
 * across concurrent sessions that the per-session home exists to keep apart.
 * The containment is the same one P3.182 documents on the rollout file, and it
 * is not free to give up. So: identity yes, state no, and the trade is written
 * here instead of being rediscovered.
 *
 * ## The detail that would have been invented wrong
 *
 * **The seed must be a canonical UUID or the binary discards it.** Measured over
 * four arms in one run: `nessy-host-stable-0000-0000` came back REPLACED by a
 * fresh UUID, while `00000000-1111-2222-3333-444444444444` survived verbatim,
 * with and without a trailing newline. A seed of any other shape therefore looks
 * exactly like the bug it was meant to fix. The file is also rewritten by the
 * binary at mode 0644 even when it keeps our value (control: a `writeFileSync`
 * with `mode: 0o600` on the same rig stays 0600), so the 0700 home is again the
 * whole containment.
 *
 * Best-effort by construction: every failure returns `null` and the session
 * starts with codex's own fresh id, which is exactly today's behaviour. An
 * identity convenience must never be able to stop a runtime from starting.
 *
 * ## P3.8 — and the one directory a reader will expect to find here is NOT one
 *
 * `security/cli/reference` publishes `$CODEX_HOME/state/plugins/<name>/` as a
 * plugin's durable home, which reads like a second thing this builder destroys.
 * It is not: that layout belongs to the `codex-security` CLI, a separate binary
 * this fork does not ship. RE-MEASURED here rather than taken on trust, with a
 * home pre-seeded at `state/plugins/codex-security/marker.txt` so both halves
 * were answerable — after a real `initialize` → `thread/start` → turn, `state/`
 * gained nothing and the marker was byte- AND mtime-identical, while the same
 * run wrote `state_5.sqlite` and `installation_id` into the same home (the
 * positive control that makes the absence a reading rather than a dead rig).
 * `git grep -al codex-security` over `packages/`+`apps/` returns ONE file, and
 * it is a prompt-template example in a docblock, not an integration.
 *
 * So no persistence is built for it and no warning is invented — a warning on a
 * path nothing in this build writes is a control that controls nothing. The
 * residue is real, conditional, and belongs elsewhere: if a user ever installs
 * `codex-security` as a codex PLUGIN, the PLUGIN writes under that path with the
 * `CODEX_HOME` it inherits from us, and this home's teardown takes it. That
 * warning belongs at the codex plugin-install seam, which does not exist yet.
 */
export function resolveHostStableCodexInstallationId(configDir: string = CONFIG_DIR): string | null {
  const file = join(configDir, CODEX_INSTALLATION_ID_FILE);
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (UUID_PATTERN.test(existing)) return existing;
  } catch {
    // No file yet, or unreadable — fall through and write one.
  }
  try {
    const minted = randomUUID();
    mkdirSync(configDir, { recursive: true });
    writeFileSync(file, minted, { mode: 0o600 });
    return minted;
  } catch {
    return null;
  }
}

/**
 * P3.38 — say, in one sentence an operator can read, WHAT CODEX TRUSTS.
 *
 * ## The gap P3.30 left, deliberately, and why it is worse than an ordinary one
 *
 * P3.30 made the corporate CA reach codex. Nothing says so. No diagnostic, no
 * settings text and no docs-site line reports what codex trusts, whether our
 * bundle was applied, or whether an operator's own certificate variable was
 * PRESERVED rather than overwritten — and a support case behind TLS
 * interception is most of the value of that fix.
 *
 * The guard makes it harder to diagnose, not easier, which is the part worth
 * stating plainly: the CORRECT behaviour — we stand aside for an operator's own
 * bundle — is byte-for-byte indistinguishable from the bug it replaced. In both
 * cases we set nothing. Only a sentence can tell them apart.
 *
 * ## The rule, replicated from the one place that owns it
 *
 * `applyCodexCaCertificate` (`codex-agent-server/src/runtime-manager.ts`)
 * writes `CODEX_CA_CERTIFICATE` only when BOTH it and `SSL_CERT_FILE` are
 * absent-or-empty in the child's env, because codex loads exactly ONE bundle
 * and `CODEX_CA_CERTIFICATE` OUTRANKS `SSL_CERT_FILE` — so writing ours over an
 * operator's would REPLACE their trust material, not add to it. P3.30 measured
 * that arm going ok -> FAIL with the guard removed.
 *
 * Emptiness is tested exactly as that function tests it — `(value ?? '') !== ''`
 * with NO trim — because codex itself treats `VAR=""` as unset
 * (`.filter(|value| !value.is_empty())`, `custom_ca.rs`). A `trim()` here would
 * describe a decision the spawn does not make.
 *
 * This DESCRIBES; it never decides. The env it reads is `process.env`, which is
 * what the manager merges under `opts.env` (the agent's own `opts.env` carries
 * no CA variable), so the four outcomes below are the four the child actually
 * gets.
 *
 * Evidence tier for every clause: STRONG — `openai/codex`'s
 * `codex-rs/http-client/src/custom_ca.rs` at `rust-v0.150.1` plus the shipped
 * binary, never the vendor page. On this runtime the source outranks the page,
 * and this path is TLS.
 */
export function describeCodexTrustDecision(
  env: Record<string, string | undefined>,
  ourCaCertificatePath: string | undefined,
): string {
  const operatorCodexVar = (env.CODEX_CA_CERTIFICATE ?? '') !== '' ? env.CODEX_CA_CERTIFICATE : undefined;
  const operatorSslVar = (env.SSL_CERT_FILE ?? '') !== '' ? env.SSL_CERT_FILE : undefined;
  const ours = ourCaCertificatePath ? ourCaCertificatePath : undefined;
  if (operatorCodexVar || operatorSslVar) {
    const name = operatorCodexVar ? 'CODEX_CA_CERTIFICATE' : 'SSL_CERT_FILE';
    const value = operatorCodexVar ?? operatorSslVar;
    return `[codex CA] codex trusts the OS root store PLUS your own bundle at ${value} `
      + `(\`${name}\`), which this app PRESERVED rather than overwrote. `
      + `${ours
        ? `The app's own bundle (${ours}) was deliberately NOT applied: codex loads exactly one `
          + 'bundle, so writing ours would have REPLACED yours and silently dropped whatever only '
          + 'yours carries. If codex must also trust the app bundle, append its certificates to '
          + 'your own file rather than unsetting the variable.'
        : 'The app has no extra CA bundle of its own to add.'}`;
  }
  if (ours) {
    return `[codex CA] codex trusts the OS root store PLUS this app's bundle at ${ours}, applied as `
      + '`CODEX_CA_CERTIFICATE` — the only variable codex\'s trust store reads besides '
      + '`SSL_CERT_FILE`. It is ADDITIVE to the platform roots, and it was applied because neither '
      + 'variable was already set. Setting either yourself takes precedence and this app will stand '
      + 'aside.';
  }
  return '[codex CA] codex trusts the OS root store ONLY. Neither `CODEX_CA_CERTIFICATE` nor '
    + '`SSL_CERT_FILE` is set and this app has no extra CA bundle to add, so behind TLS interception '
    + 'codex will fail to verify where the other runtimes succeed. Note codex NEVER reads '
    + '`NODE_EXTRA_CA_CERTS`: setting that variable will not help this runtime.';
}

/**
 * P6.488 — the named opt-in that lets an OTLP collector credential be written
 * into this session's own `config.toml`.
 *
 * Owner decision 2026-09-05, Q24, option 3. codex accepts nothing else:
 * `OtlpHttp.headers` is a literal map in `config/src/types.rs` at
 * `rust-v0.148.0`, with no env-var-NAME form anywhere in `OtelExporterKind`. So
 * the writer's standing invariant — `config.toml` holds `env_key` /
 * `bearer_token_env_var` and never a value — is the thing being relaxed, and it
 * is relaxed deliberately, on request, and on one runtime only.
 *
 * The one-runtime existence of this knob is the shape native-first exists to
 * prevent, so it is documented rather than quiet: Pi and claude read
 * `OTEL_EXPORTER_OTLP_HEADERS` from the environment and need no such switch;
 * codex cannot, and this is the price of parity for an operator who wants it.
 */
const CODEX_OTLP_HEADERS_ON_DISK_ENV_VAR = 'NESSY_CODEX_OTLP_HEADERS_ON_DISK';

/** What {@link resolveCodexOtelExport} decided, and — when it declined — why. */
export interface CodexOtelExportPlan {
  /** Full OTLP/HTTP logs URL for `[otel].exporter`, absent when nothing exports. */
  readonly logsEndpoint?: string;
  /**
   * P6.459 arm (1) — full OTLP/HTTP traces URL for `[otel].trace_exporter`,
   * absent unless {@link tracingOptedIn} answers yes. Resolved SEPARATELY from
   * {@link CodexOtelExportPlan.logsEndpoint} because the two selectors are
   * independent: an operator may export spans and not logs, and codex's own
   * field comment forbids inferring one endpoint from the other.
   */
  readonly tracesEndpoint?: string;
  /**
   * P6.488 — the OTLP headers to write as LITERALS into `config.toml`, present
   * only when the operator set {@link CODEX_OTLP_HEADERS_ON_DISK_ENV_VAR}.
   * Absent is the default and the refusal below is what happens instead.
   */
  readonly otlpHeaders?: Readonly<Record<string, string>>;
  /** One line for the session's diagnostics when an ASKED-FOR export was declined. */
  readonly notice?: string;
}

/**
 * `OTEL_EXPORTER_OTLP_HEADERS`, in the W3C-baggage form the OTLP specification
 * gives it: `key=value,key2=value2`, percent-decoded per entry.
 *
 * Entries with no `=`, an empty key, or a control character in either half are
 * DROPPED rather than repaired — a header we cannot spell faithfully is a header
 * codex would reject the whole file for, and this file failing to parse takes
 * the provider block and every deny floor with it.
 */
function parseOtlpHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const entry of raw.split(',')) {
    const at = entry.indexOf('=');
    if (at <= 0) continue;
    const key = entry.slice(0, at).trim();
    const value = entry.slice(at + 1).trim();
    if (!key || /[\u0000-\u001f\u007f]/.test(key)) continue;
    let decoded = value;
    try { decoded = decodeURIComponent(value); } catch { /* keep the raw form */ }
    if (/[\u0000-\u001f\u007f]/.test(decoded)) continue;
    headers[key] = decoded;
  }
  return headers;
}

/**
 * P2.450 — turn the host's telemetry env into codex's own `[otel]` exporter.
 *
 * ## The gate is the host's, and it is the SAME gate for all three runtimes
 *
 * Native-first says enable the runtime's own mechanism; the second half of the
 * rule says the host must make the residual difference uniform or honest. codex
 * has no telemetry env of its own — its exporter is config-only — and the config
 * is a file this process owns, so the only place an operator's intent can enter
 * is the env the other two runtimes already read. `telemetryOptedOut`,
 * `telemetryOptedIn` and `otelExporterDisabled` are imported rather than
 * re-derived for exactly the reason their own docblocks give: one predicate, so
 * three runtimes can never disagree about what an operator's opt-out meant.
 *
 * Precedence is theirs too, in their order: the standard opt-out
 * (`DO_NOT_TRACK` / `DISABLE_TELEMETRY` /
 * `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`) beats everything, the opt-in
 * (`NESSY_ENABLE_TELEMETRY`, or the documented Claude name) gates everything, and
 * the logs signal's own `OTEL_LOGS_EXPORTER=none` beats even an explicit opt-in.
 *
 * ## The endpoint, and the one thing that is refused
 *
 * `monitoring-usage.md`'s rule, applied exactly as the Pi exporter applies it:
 * `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` "overrides general setting" and is used with
 * its path AS GIVEN, while the general `OTEL_EXPORTER_OTLP_ENDPOINT` gets
 * `/v1/logs` appended. Credentials in the URL and non-HTTP schemes are refused,
 * same as there.
 *
 * `OTEL_EXPORTER_OTLP_HEADERS` is REFUSED rather than honoured, and this is the
 * one place codex genuinely cannot match the other two: its `OtlpHttp.headers`
 * is a literal map in the config file, with no env indirection anywhere in
 * `OtelExporterKind` (`config/src/types.rs` at `rust-v0.150.1`). Honouring it
 * would write a collector credential to disk, in a writer whose every other
 * credential is an env var NAME and never a value. Declining is the smaller and
 * safer half of that trade — and it is declined OUT LOUD, because an operator who
 * set a header and silently got no telemetry would read the silence as "nothing
 * happened", which is the failure this whole row exists to stop.
 */
export function resolveCodexOtelExport(
  env: Record<string, string | undefined> = process.env,
): CodexOtelExportPlan {
  if (telemetryOptedOut(env)) return {};
  if (!telemetryOptedIn(env)) return {};
  // P6.459 arm (1) · the two signals are resolved INDEPENDENTLY, because their
  // selectors are: `OTEL_LOGS_EXPORTER=none` must not silence spans, and
  // `OTEL_TRACES_EXPORTER` unset must not silence events. `tracingOptedIn` is
  // the one host rule all three runtimes read, so an operator gets one answer.
  const logsOn = !otelExporterDisabled(env, 'OTEL_LOGS_EXPORTER');
  const tracesOn = tracingOptedIn(env);
  if (!logsOn && !tracesOn) return {};
  const signalEndpoint = logsOn ? env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?.trim() : undefined;
  const tracesSignalEndpoint = tracesOn ? env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() : undefined;
  const raw = logsOn ? (signalEndpoint || env.OTEL_EXPORTER_OTLP_ENDPOINT) : undefined;
  const tracesRaw = tracesOn ? (tracesSignalEndpoint || env.OTEL_EXPORTER_OTLP_ENDPOINT) : undefined;
  if (!raw?.trim() && !tracesRaw?.trim()) return {};
  const rawHeaders = env.OTEL_EXPORTER_OTLP_HEADERS?.trim();
  // P6.488 · the named opt-in. UNSET is the default and it still refuses; what
  // changed is that the refusal now names the way out instead of being a dead
  // end. See {@link CODEX_OTLP_HEADERS_ON_DISK_ENV_VAR}.
  const headersOnDisk = ['1', 'true', 'yes', 'on']
    .includes((env[CODEX_OTLP_HEADERS_ON_DISK_ENV_VAR] ?? '').trim().toLowerCase());
  let otlpHeaders: Record<string, string> | undefined;
  if (rawHeaders && !headersOnDisk) {
    return {
      notice:
        'Codex TELEMETRY DECLINED — OTEL_EXPORTER_OTLP_HEADERS is set, and codex takes OTLP headers '
        + 'only as literal values in config.toml — writing your collector credential to disk. '
        + `This session exports no codex events. Set ${CODEX_OTLP_HEADERS_ON_DISK_ENV_VAR}=1 to accept `
        + 'that trade: the headers are then written into this session\'s own private CODEX_HOME '
        + `(0700 directory, 0600 file) and deleted with it. ${describeOtherRuntimeTelemetryReach(env)}`,
    };
  }
  if (rawHeaders) {
    const parsed = parseOtlpHeaders(rawHeaders);
    // An opt-in that yields nothing usable must not silently export headerless:
    // the collector would answer 401 and the operator would be told nothing.
    if (Object.keys(parsed).length === 0) {
      return {
        notice:
          'Codex TELEMETRY DECLINED — OTEL_EXPORTER_OTLP_HEADERS carries no usable `key=value` entry, '
          + `so ${CODEX_OTLP_HEADERS_ON_DISK_ENV_VAR} had nothing to write and this session exports no `
          + 'codex events.',
      };
    }
    otlpHeaders = parsed;
  }
  /**
   * One URL rule for both signals. The `/v1/<signal>` suffix is appended ONLY to
   * the general endpoint: `monitoring-usage.md` says the per-signal name
   * "overrides general setting" and its documented example already carries the
   * path, so appending there would produce `/v1/logs/v1/logs`.
   */
  const resolveSignal = (
    value: string,
    signal: 'logs' | 'traces',
    perSignal: boolean,
  ): string | { notice: string } => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return signal === 'logs'
        ? { notice: `Codex TELEMETRY DECLINED — ${value} is not a URL, so no codex event exporter was written.` }
        : { notice: `Codex TRACING DECLINED — ${value} is not a URL, so no codex span exporter was written.` };
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
      return signal === 'logs'
        ? {
          notice:
            'Codex TELEMETRY DECLINED — an OTLP endpoint must be http/https and carry no credentials in the URL. '
            + 'This session exports no codex events.',
        }
        : {
          notice:
            'Codex TRACING DECLINED — an OTLP endpoint must be http/https and carry no credentials in the URL. '
            + 'This session exports no codex spans.',
        };
    }
    url.search = '';
    url.hash = '';
    if (!perSignal) {
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/v1/${signal}`;
    }
    return url.toString();
  };
  let logsEndpoint: string | undefined;
  let tracesEndpoint: string | undefined;
  if (raw?.trim()) {
    const resolved = resolveSignal(raw, 'logs', Boolean(signalEndpoint));
    if (typeof resolved !== 'string') return resolved;
    logsEndpoint = resolved;
  }
  if (tracesRaw?.trim()) {
    const resolved = resolveSignal(tracesRaw, 'traces', Boolean(tracesSignalEndpoint));
    if (typeof resolved !== 'string') return resolved;
    tracesEndpoint = resolved;
  }
  return {
    ...(logsEndpoint ? { logsEndpoint } : {}),
    ...(tracesEndpoint ? { tracesEndpoint } : {}),
    ...(otlpHeaders ? { otlpHeaders } : {}),
  };
}

/**
 * P6.488 — what the OTHER two runtimes are doing with the same environment, said
 * accurately instead of generously.
 *
 * The refusal sentence used to end "Pi and claude are unaffected". Half of that
 * is unconditionally true and half is not: the host's own Pi exporter reads
 * `OTEL_EXPORTER_OTLP_HEADERS` from the environment and is genuinely untouched,
 * but the CLAUDE child is the vendored SDK, and it gates its own exporter on its
 * own name. `telemetryOptedIn` accepts `NESSY_ENABLE_TELEMETRY` as the primary
 * spelling with `CLAUDE_CODE_ENABLE_TELEMETRY` as the compat alias — so an
 * operator who used only the Nessy spelling has a claude child that exports
 * NOTHING either, and telling them claude is unaffected sends them looking in
 * the wrong place.
 */
function describeOtherRuntimeTelemetryReach(env: Record<string, string | undefined>): string {
  const claudeSpelling = ['1', 'true', 'yes', 'on']
    .includes((env.CLAUDE_CODE_ENABLE_TELEMETRY ?? '').trim().toLowerCase());
  return claudeSpelling
    ? 'Pi and claude are unaffected — both read the headers from the environment.'
    : 'Pi is unaffected — it reads the headers from the environment. Claude is NOT exporting either: '
      + 'the vendored SDK gates its own exporter on CLAUDE_CODE_ENABLE_TELEMETRY, and only the Nessy '
      + 'spelling of the opt-in is set.';
}

/**
 * P2.450 — the codex child's `OTEL_RESOURCE_ATTRIBUTES` addition, or nothing.
 *
 * The marker rides the OTLP RESOURCE, not `[otel].span_attributes`: that table
 * is applied by codex's `SpanAttributesProcessor::on_start`, i.e. to TRACE SPANS
 * only, so it would be invisible on the log signal this projects. The resource
 * is built by `Resource::builder()` (`otel/src/provider.rs`), whose env detector
 * reads `OTEL_RESOURCE_ATTRIBUTES` — MEASURED end to end rather than inferred
 * from an SDK version: with this value on the child env, the bundled
 * `codex-app-server` 0.148.0 posted two OTLP/HTTP JSON batches to a loopback
 * `/v1/logs` whose resource read
 * `service.name=codex-app-server, service.version=0.148.0, env=dev,
 * nessy.telemetry.coverage=codex-events-only`.
 *
 * Two restraints, both carried verbatim from the claude side (P2.423):
 *
 * - **Only when the child will actually export.** A coverage marker on a session
 *   that emits nothing is noise, and worse, a claim that a stream exists.
 * - **Never over an operator's own value for the key.** If they have already
 *   declared their coverage, they outrank us; we describe their pipeline, we do
 *   not own it.
 */
export function codexTelemetryResourceAttributes(
  env: Record<string, string | undefined>,
  logsEndpoint: string | undefined,
  sessionId?: string,
): string | undefined {
  if (!logsEndpoint) return undefined;
  const marked = withTelemetryCoverage(env.OTEL_RESOURCE_ATTRIBUTES ?? '', CODEX_TELEMETRY_COVERAGE);
  // C4.25 · the two answers are INDEPENDENT and are composed in that order.
  // `withTelemetryCoverage` declining (`undefined`) means only that the operator
  // already declared `nessy.telemetry.coverage` and outranks us on THAT key — it
  // says nothing about `session.id`, which they enabled by name through a
  // documented switch. So identity is appended to their own value in that case,
  // and to the marked value otherwise; with identity off, the answer is exactly
  // what it was before this row.
  return withCodexTelemetryIdentity(marked ?? env.OTEL_RESOURCE_ATTRIBUTES ?? '', env, sessionId)
    ?? marked;
}

/**
 * C4.25 (QM2, owner answer C, 2026-09-11) — codex's `session.id`, through the
 * child's `OTEL_RESOURCE_ATTRIBUTES`.
 *
 * ## Why this channel and not `[otel].span_attributes`
 *
 * `span_attributes` is a real key in the pinned `config-schema.json` and it was
 * the obvious candidate, which is why the reason it was declined is written down
 * rather than left as a preference: codex applies it in
 * `SpanAttributesProcessor::on_start`, i.e. to TRACE SPANS only, so the marker
 * would be invisible on the LOG signal. `OTEL_RESOURCE_ATTRIBUTES` reaches the
 * OTLP RESOURCE, which rides every signal, and P2.450 already MEASURED it end
 * to end against the shipped binary. One channel, already paid for, covering
 * both.
 *
 * **A3.1 (2026-09-17) re-read that decision now that the fork projects TWO
 * streams rather than one, and it holds — against the row's own premise.** That
 * row is worded *"`[otel].span_attributes` is the only channel it has"*, from a
 * reading taken when `buildCodexOtelToml` wrote logs alone; P6.459 arm 1 has
 * since landed `[otel] trace_exporter` behind `tracingOptedIn`, so the trace
 * stream the identity would decorate now exists, and the question is whether
 * the resource reaches it. Read from `codex-rs/otel/src/provider.rs` at
 * `rust-v0.154.0` — the STRONG tier: `build` calls `make_resource(settings,
 * ResourceKind::Logs)` AND `make_resource(settings, ResourceKind::Traces)`, and
 * `make_resource` is one `Resource::builder()` for both, whose env detector
 * reads `OTEL_RESOURCE_ATTRIBUTES`. The ONLY kind-specific difference is
 * `host.name`, which `resource_attributes` adds on `Logs` alone. So `session.id`
 * put on this channel decorates the trace resource too, by construction, and
 * `span_attributes` — applied by `SpanAttributesProcessor::on_start`, a span
 * processor the same file installs only on the TRACER provider — would have
 * been strictly narrower. The row asks for a Size-M build onto the worse
 * channel; the better one was already built by C4.25 and covers both signals.
 * What remains of A3.1 is a DRIVEN arm on a packaged build with both exporters
 * on, which is a sitting and not a lane edit.
 *
 * ## The gate is the HOST's, and it is the same one for all three runtimes
 *
 * {@link resolveTelemetryIdentity} — owner decision D13 = option B, identity
 * behind the documented toggles, DEFAULT OFF, using the vendor's own switch
 * names. It is imported rather than re-derived for the reason its own docblock
 * gives: an operator who turns identity on must get the same answer from Pi,
 * from claude and from here, not three.
 *
 * codex has no identity switch of its own — the pinned `[otel]` block carries
 * none — so unlike the claude arm (`agent/options.ts` `applyTelemetryIdentityPin`,
 * which flips the vendor's switch and lets the vendor supply the value) the HOST
 * has to supply the value here. That is the whole difference between the two
 * arms, and it is also why only ONE of the two documented names is served.
 *
 * ## `user.account_uuid` is DECLINED, with the reading rather than silently
 *
 * On claude the value behind that switch is the vendor's own account uuid. codex
 * has no account on a session of this fork: it authenticates against our
 * loopback adapter with a synthetic key. The only person-naming identifier this
 * host could put there is the gateway directory subject from the `dp` JWT
 * (`auth/dp/jwt.ts`, `sub` → `userId`) — a corporate directory id, which is a
 * STRONGER disclosure than the vendor account uuid the owner approved under
 * D13=B, and therefore a product posture rather than a wiring gap. Left
 * unexported and rowed.
 *
 * Never over an operator's own `session.id`: they outrank us, exactly as
 * {@link withTelemetryCoverage} already treats the coverage key.
 */
export function withCodexTelemetryIdentity(
  attributes: string,
  env: Record<string, string | undefined>,
  sessionId: string | undefined,
): string | undefined {
  if (!sessionId) return undefined;
  if (!resolveTelemetryIdentity(env).sessionId) return undefined;
  if (hasResourceAttribute(attributes, 'session.id')) return undefined;
  const head = attributes.trim().replace(/,+$/, '');
  const pair = `session.id=${sessionId}`;
  return head ? `${head},${pair}` : pair;
}

/**
 * P3.33 · the host's safety guidance, for codex's `developerInstructions`
 * channel — the third of A3 the row asked for and nothing more.
 *
 * ## Why this field, and NOT the one the ledger named
 *
 * The capability ledger's A3 says codex "has an instructions channel
 * (`config-writer.ts`'s `base_instructions`, 7 hits)". **Both halves are wrong,
 * and the second one is dangerous.** `base_instructions` does not occur in a
 * single source file in this repo (`git grep -a` scores 0 outside `docs/`;
 * positive control `approvalPolicy` scores in the same trees). The channel that
 * does exist is a pair of `ThreadStartParams` fields — `baseInstructions` and
 * `developerInstructions`, also on `thread/fork` and `thread/resume` — and they
 * are NOT interchangeable.
 *
 * Measured against the bundled `codex-app-server` (rust-v0.148.0,
 * darwin-arm64) driven at a loopback Responses provider, reading the request
 * body it puts on the wire:
 *
 * | `thread/start` param | top-level `instructions` | our text lands |
 * | --- | --- | --- |
 * | *(neither field)* | 20,751 chars — codex's own prompt | nowhere |
 * | `developerInstructions` | **20,751 chars, unchanged** | first `developer` item, ahead of codex's own `<skills_instructions>` / `<permissions instructions>` and ahead of the user turn |
 * | `baseInstructions` | **68 chars — ours, and ONLY ours** | replaces the entire prompt |
 *
 * So taking the ledger literally would have DELETED codex's whole 20,751-char
 * base prompt in the act of adding a safety defence. The binary says as much in
 * its own words: it refuses a model that "is missing both `base_instructions`
 * and `model_messages.instructions_template`" — `base_instructions` IS the base
 * prompt, not a slot beside it. `developerInstructions` is additive, and is the
 * same concept `config-writer.ts` already writes per agent role
 * (`developer_instructions` = that role's system prompt).
 *
 * ## Why the SAFETY HALF only
 *
 * `includeCodingInstructions: false` is an EXISTING mode of the shared builder,
 * so no new prompt text is authored here — the block Pi and Claude already get
 * is routed to a third runtime. The half it drops is the `coding: true` bullets
 * (`output-styles.md`'s "how to scope changes, write comments, and verify
 * work"), and codex ships 20,751 characters of its own engineering guidance
 * that would contradict them at no safety return. Every untagged bullet — all
 * of Untrusted Content, Security Work, the secrets bullet, all of Git, all of
 * Interaction Boundaries — is what A3 is about and is what travels.
 *
 * ## P6.36 — the output style now rides this same channel
 *
 * codex used to receive NO output style at all: not the prose, not the per-turn
 * reminder. Both halves land here and in {@link CodexAgent.activeOutputStyle}:
 *
 *  - **The prose** is appended to this string, where Claude Code puts a
 *    style's instructions: in the system prompt, sent with every request
 *    (`output-styles.md#how-output-styles-work`, as read 2026-10-17: "Claude
 *    Code sends the active style's instructions with every request"). The
 *    app-server owns codex's actual system prompt, so `developerInstructions`
 *    is the nearest additive channel; it lands as the first `developer` item,
 *    ahead of codex's own `<skills_instructions>` and ahead of the user turn.
 *  - **Thread-scoped, and a switch rides the turn (UB12.63).** This string is
 *    built at `thread/start` and re-built on the `thread/fork` walk, and nothing
 *    on `turn/start` replaces it. P6.36 called that the page's own rule, quoting
 *    a `/clear`-or-new-session sentence `output-styles.md#change-your-output-style`
 *    no longer carries. The page now reads "When you switch styles mid-session,
 *    Claude uses the new style starting with your next message", and
 *    `prompt-caching.md#changing-output-style` says Claude Code "delivers the new
 *    style's instructions as a message in the conversation". So
 *    {@link CodexAgent.chatImpl} puts a switched style's block on the turn once,
 *    through `core/output-style-switch.ts`, the module claude uses for its
 *    recorded system prompt (UB12.21).
 *  - **The per-turn reminder** does NOT ride here.
 *    `PromptBuilder.buildOutputStyleReminder` emits it onto the user turn for
 *    every runtime. It was wired and inert on codex only because nothing called
 *    `setActiveOutputStyle`; {@link CodexAgent.chatImpl} now does. (P6.36 quoted
 *    a reminder sentence from `#how-output-styles-work` that the page no longer
 *    carries, read 2026-10-17.)
 *
 * ## `keep-coding-instructions` is REPORTED, not honoured, and that is the
 * honest answer rather than the convenient one
 *
 * `includeCodingInstructions: false` is an EXISTING mode of the shared builder,
 * so no new prompt text is authored here — the block Pi and Claude already get
 * is routed to a third runtime. The half it drops is the `coding: true` bullets
 * (`output-styles.md`'s "how to scope changes, write comments, and verify
 * work"), and codex ships 20,751 characters of its own engineering guidance
 * that would contradict them at no safety return. Every untagged bullet — all
 * of Untrusted Content, Security Work, the secrets bullet, all of Git, all of
 * Interaction Boundaries — is what A3 is about and is what travels.
 *
 * P3.33's note said the widening was `{ includeCodingInstructions: <style flag> }`
 * "once codex reads the active style at all". Codex now reads it, and that line
 * was NOT taken, deliberately:
 *
 *  - Passing the flag would ADD our coding half on every codex session, because
 *    every built-in style declares `keepCodingInstructions: true`. That reverses
 *    P3.33's measured reason (codex has its own engineering prompt) for every
 *    user, in the name of a style setting most of them never touched.
 *  - The SUBTRACTION half — a custom style's documented default of
 *    `keep-coding-instructions: false` — is unimplementable on codex in either
 *    direction: the engineering guidance a codex session actually runs on is the
 *    app-server's own 20,751-char base prompt, and the only field that could
 *    remove it is `baseInstructions`, which replaces the WHOLE prompt.
 *
 * So on codex `keep-coding-instructions` is inert in both directions, and an
 * inert control that says nothing is the fork's largest defect class. It is
 * therefore announced on the debug channel once per thread rather than left
 * silent — see {@link CodexAgent.activeOutputStyle}.
 */
export function codexDeveloperInstructions(outputStylePrompt?: string, sections?: CodexDeveloperSections): string {
  const safety = getSafetyAndEngineeringSections('Codex', { includeCodingInstructions: false }).trim();
  const style = outputStylePrompt?.trim();
  // P3.251 · the codex-only runtime guidance, on the one channel that reaches
  // this model. It sits BETWEEN the safety block and the style for the same
  // reason the style sits last: safety outranks operating guidance, and
  // operating guidance outranks response shaping. `codex-runtime-guidance.ts`
  // carries the measurement — including the two sections that were deleted
  // instead of routed here because they are false on this runtime.
  // P6.441 - the git-attribution block, from the SAME builder Pi and claude use.
  // codex never calls `getSystemPrompt` (P3.251 measured that and built
  // `codex-runtime-guidance.ts` as codex's one prose channel), so without this
  // line codex is the one runtime still attributing its own way - the exact
  // divergence the row's control forbids: the same repository committed from a
  // Pi, a claude and a codex session must produce byte-identical trailers.
  // `resolveGitAttribution()` with no pinned legacy value resolves exactly as
  // `getSystemPrompt` does when its caller passes none, so the three cannot
  // drift. It sits with the operating guidance rather than with safety: it
  // shapes what the model WRITES, not what it may do.
  const parts = [safety, CODEX_RUNTIME_GUIDANCE, gitAttributionSection(resolveGitAttribution()).trim(), sections?.board?.trim() ?? '', sections?.pages?.trim() ?? '', sections?.projectTrust?.trim() ?? ''] // UA3.5 / UA6.5 — offer-scoped tool guidance; F1.791 — the project-trust sentence (CodexDeveloperSections)
    .filter(part => part.length > 0);
  // `resolveOutputStyleComposition` already fences the style in its own
  // `## Output Style: <label>` section with the precedence sentence, so the
  // block is appended verbatim and the safety guidance stays FIRST — a style is
  // response shaping and must not read as outranking the section above it.
  if (style) parts.push(style);
  // P6.515 — the operator's append, LAST and on codex's own additive channel.
  // `developerInstructions` is the one field that reaches this model's system
  // prompt without replacing it (measured: codex's 20,751-char base prompt is
  // unchanged with it set), and codex never calls `getSystemPrompt`, so this is
  // the third and last of the three slots. Last for the reason the other two
  // are: a later block cannot delete an earlier one, so the safety sections
  // above it stay above it. Empty composes byte-identical bytes.
  const operatorAppend = systemPromptAppendSection().trim();
  if (operatorAppend) parts.push(operatorAppend);
  return parts.join('\n');
}

/**
 * P6.95 — a codex session that fell back to codex's fabricated context window
 * tells the operator, on the host channel that already exists for exactly this.
 *
 * ## What goes wrong, and why nobody could see it
 *
 * The writer emits `model_context_window` only when the connection carries one
 * ({@link resolveCodexContextWindow}, and every spelling of that predicate must
 * be that one function — its docblock records the bug two spellings already
 * caused). With none, codex does NOT run windowless: `model_info_from_slug`
 * hands it {@link CODEX_ASSUMED_CONTEXT_WINDOW} for any slug it has no
 * catalogue entry for, which is every gateway id. So the session gets a
 * fabricated denominator for the meter, a fabricated 95 % usable reserve, and —
 * with the limit key withheld — a fabricated 90 % compaction trigger. All three
 * are silent, and the meter looks authoritative.
 *
 * ## Native mechanism, asked and answered
 *
 * (2) THE HOST ALREADY SUPPLIES IT UNIFORMLY. `PostInitResult.authWarning` is
 * read provider-agnostically by `SessionManager` right after construction and
 * turned into a session `info` event at the level the backend chose; claude
 * uses it for the identical defect through `buildClaudeContextWindowWarning`.
 * Codex simply never overrode `postInit` at all — `BaseAgent.postInit` returns
 * a bare `{ authInjected: true }`, and that inherited answer is preserved here
 * verbatim so nothing about codex's auth changes.
 *
 * Codex's own channels were asked first and neither fits: the runtime reports
 * the fabricated figure as if it were fact (it has no way to know it was
 * fabricated), and the uniform `contextWindowSource` provenance seam needs a
 * `ContextUsageSnapshot` codex never emits — measured and rejected as strictly
 * larger in the row.
 *
 * ## Why this does NOT silence on the auto-compaction off-switch
 *
 * `buildClaudeContextWindowWarning` returns `{}` when the user turned
 * auto-compaction off, and P6.53's reason is right there: that sentence reports
 * *compaction is off and you did not ask for that*, which becomes false the
 * moment the user did ask. This sentence's subject is different — the window is
 * fabricated — and the off-switch does not make it true. It makes it WORSE:
 * P3.286 moved the limit key alone, so in the off position codex falls back to
 * its own 90 % term computed off the same fabricated figure. Silencing here
 * would hide the number in the position where it does the most.
 */
export function buildCodexContextWindowWarning(
  contextWindow: unknown,
  model: string,
): Pick<PostInitResult, 'authWarning' | 'authWarningLevel'> {
  // TWO steps, and they are the writer call's own two steps rather than a third
  // spelling: `createRuntime` narrows `BackendRuntimePayload`'s untyped
  // `contextWindow` with `typeof … === 'number'` before it passes the key at
  // all, and the writer then applies `resolveCodexContextWindow` to what it
  // receives. Both are reproduced here in that order, so a value this warning
  // calls "declared" is exactly a value the writer emits.
  const declared = typeof contextWindow === 'number' ? contextWindow : undefined;
  if (resolveCodexContextWindow({ contextWindow: declared }) !== undefined) return {};
  const assumed = CODEX_ASSUMED_CONTEXT_WINDOW.toLocaleString('en-US');
  return {
    authWarning:
      `No context window is recorded for model "${model}", so this session runs against the `
      + `${assumed}-token window codex assumes for a model it has no catalogue entry for instead `
      + "of this one's: the usage meter, codex's own 95% usable-capacity reserve and — with "
      + 'auto-compaction off — its 90% compaction trigger are all derived from that figure. Set a '
      + 'context window for this model on the connection, or pick a model that has one.',
    authWarningLevel: 'warning',
  };
}

/** A permission rule's answer to one codex approval. */
interface CodexRuleAnswer {
  action: 'allow' | 'deny' | 'ask'; // F1.870 — an 'ask' is CARRIED to the card (codexAskRuleCard), never answered
  ruleId: string; toolName?: string; // F1.887 — an ask carries the host tool name its rule matched (the card's lead)
  scope: string; reason?: string; // F1.1002 — a policy that failed closed refuses with its diagnostic, naming no rule
}

export class CodexAgent extends BaseAgent {
  protected backendName = 'Codex';

  /**
   * C3.75 (QF9, owner answer A, 2026-09-11) — codex asks the SHARED loop to
   * count its turns, because it has no cap of its own to configure.
   *
   * `BaseAgent.countsAgentTurnsInSharedLoop` is opt-IN and its own docblock
   * names this runtime as the arm that needs it: Pi counts `turn_start` inside
   * its own loop and force-aborts at N+1, claude projects the same setting onto
   * the SDK's `Options.maxTurns`, and defaulting the host counter ON would count
   * those two twice under one setting name. codex has neither — its release
   * `packages/codex-protocol/schema/config-schema.json` carries zero `max_turn*`
   * keys — so the host ceiling is the only seam, and this is the line that opens
   * it.
   *
   * The UNIT is the host's, not codex's, and the base class states it: a model
   * round-trip — the first model call plus each group of consecutive tool
   * activity the model comes back from. Under one setting name the three arms
   * count three comparable things, and nothing here claims they are identical.
   *
   * With the shipped default (`workspaceDefaults.maxAgentTurns` 0) the ceiling
   * is off and this flag decides nothing, so it changes no existing session.
   */
  protected override countsAgentTurnsInSharedLoop = true;

  /** P6.78 · the clock statement is once per agent, not once per respawn. */
  private announcedRequirementClock = false;

  private manager: CodexRuntimeManager | null = null;
  /**
   * P6.106 · a thread id `/resume` asked for, honoured by the next thread open.
   *
   * Separate from {@link CodexAgent.threadId}, which means "the thread this
   * agent is CURRENTLY driving". Writing the id straight into that field would
   * make `turn/start` address a thread this process has not opened.
   */
  private resumeThreadId: string | null = null;
  /**
   * C3.169 — the service tier an administrator's `models.newThread` requirement
   * asked for, held from the moment the requirement is resolved until the thread
   * that carries it is opened.
   *
   * A FIELD and not a local, because the verdict is resolved ~100 lines before
   * `openThreadParams` is built and is resolved once per runtime while a thread
   * can be opened again (a config drift re-forks, `/resume` re-opens): a local
   * would apply the administrator's tier to the first thread of a session and to
   * no other, which is the half-applied shape this file refuses elsewhere by name.
   *
   * `undefined` when the requirement carried no tier, so every call site spreads
   * nothing and the wire shape is byte-identical to before this row.
   */
  private managedServiceTier: string | undefined = undefined;
  private client: AppServerClient | null = null;
  private adapter: AdapterHandle | null = null;
  /**
   * T5 — the per-session host-callback bridge, whose port reaches the bundled
   * `session-mcp-server` through `[mcp_servers.session]`'s argv. Lives and dies
   * with the runtime, exactly like {@link adapter}: its port is written into a
   * `config.toml` the app-server only reads at start, so a bridge that outlived
   * a teardown would be advertised to nothing.
   */
  private callbackBridge: CodexSessionCallbackBridgeHandle | null = null;
  private readonly eventAdapter = new CodexEventAdapter();
  /**
   * P3.2 · the most recent guardian auto-review DENIAL params seen on OUR thread,
   * so {@link approveGuardianDeniedAction} can replay its assessment event to the
   * app-server. Best-effort: the exact `GuardianAssessmentEvent` shape codex
   * wants for the replay is a live-binary question owed at close-out — this holds
   * the notification we have and the replay degrades on refusal.
   */
  private lastGuardianDeniedEvent: unknown = undefined;
  /**
   * P3.270 — notification families already reported once by
   * {@link noteUnreadCodexNotification}. Agent-scoped rather than turn-scoped:
   * the point is one line per family per session, not per turn.
   */
  private readonly seenUnreadNotificationMethods = new Set<string>();
  /** P6.36 · one `keep-coding-instructions` residue line per runtime, not per turn. */
  private outputStyleResidueAnnounced = false;
  /**
   * UB12.63 — the output-style block this thread's model holds now (`''` for
   * none; `undefined` while this instance cannot know). Seeded by a
   * `thread/start` from the block its `developerInstructions` carried; a
   * `thread/resume` or a branch `thread/fork` leaves it as it was, because the
   * thread's history was rendered earlier (by this instance, or by one this
   * instance cannot see). Moved by {@link planOutputStyleSwitch} once per turn,
   * committed when `turn/start` is sent. Rules and residue:
   * `core/output-style-switch.ts`.
   */
  private deliveredOutputStylePrompt: string | undefined;
  /** C3.13 · one unscanned-subagent-report statement per agent, not per spawn. */
  private subagentReportResidueNoted = false;
  private codexHome: string | null = null;
  private runtimeSetup: Promise<void> | null = null;
  private runtimeDisposal: Promise<void> | null = null;
  private destroyed = false;
  /**
   * P6.271 (codex half) — is this teardown FINAL, or a restart?
   *
   * `destroyed` cannot answer that: `destroy()` opens with
   * `if (this.destroyed) return`, so the flag is still false when it reaches
   * `disposeForRestart()`, and `disposeForRestart` is the ONE method both paths
   * take (unlike Pi, where the final path ends in a different kill). A worker
   * notice is worth saying when the runtime is being REPLACED and pointless when
   * the session is going away, so `destroy()` raises this before it delegates.
   */
  private teardownIsFinal = false;
  private threadId: string | null = null;
  private processing = false;
  private aborted = false;
  private stopHookForTurn: Promise<void> | null = null;

  /**
   * P6.118 · has this turn already minted `StopFailure`?
   *
   * Pi's `stopFailureHookEmittedForTurn`, same rule and the same reason: codex
   * can send more than one `error` notification for one failed turn (a retrying
   * error followed by the terminal one), and the event is once-per-occurrence.
   */
  private stopFailureHookEmittedForTurn = false;

  /**
   * P6.118 · did THIS turn ask for the compaction that is about to be observed?
   *
   * Set beside the `thread/compact/start` request and read once by the
   * `PostCompact` mint, which is how `trigger` gets the documented
   * `manual` / `auto` value hooks.md#postcompact matches on. Per-turn, cleared
   * at the head of `chatImpl` with the other turn state: a compaction observed
   * in a LATER turn was not the one this `/compact` asked for.
   */
  private manualCompactionRequestedForTurn = false;
  private _sessionStartEmitted = false;
  private _sessionEndEmitted = false;
  private _sessionStartHooksApplied = false;
  private _sessionHookContext: string | undefined;
  private runtimeConfigSignature: string | null = null;
  /**
   * C4.13 · review thread id → the plain-English target it is reviewing.
   *
   * A detached `review/start` runs on a thread this session did not open, so
   * without this map `handleNotification`'s foreign-thread guard drops the whole
   * review. Keyed by the REVIEW thread because that is what every notification
   * from it names; holding the target because the findings sentence must say
   * what was reviewed and the turn that asked is long over.
   */
  private readonly detachedReviewThreads = new Map<string, string>();
  /** C4.13 · the last assistant text each live review thread produced. */
  private readonly detachedReviewFindings = new Map<string, string>();
  /**
   * C4.24 · the extra skill roots last handed to codex, joined, or `null` before
   * the first set.
   *
   * A `skills/extraRoots/set` makes codex emit `skills/changed`
   * (`app-server/tests/suite/v2/skills_list.rs`,
   * `skills_extra_roots_set_updates_process_runtime_roots`, which waits for one
   * after every set) — and this session runs {@link syncCodexSkillsConfig} ON
   * `skills/changed`. Re-sending an unchanged list would therefore be a loop,
   * so the set is sent only when the list actually moves.
   *
   * Seeded EMPTY rather than `null`, because empty is what a freshly spawned
   * app-server actually has: `extraRoots` is process-runtime state with no
   * config key behind it, and this fork's `CODEX_HOME` is a new `mkdtemp`
   * directory every session. So a session with no added folders sends nothing at
   * all, instead of one inert request plus the `skills/changed` it provokes.
   */
  private lastCodexSkillExtraRoots = '';
  /**
   * P3.3 · latched ONLY when the app-server's refusal is DEFINITIVE — the method
   * does not exist, or our params do not fit it. A transient failure must NOT
   * latch, and the first version of this got that wrong in a way that mattered:
   * the methods DO ship (the binary's own table reads
   * `thread/backgroundTerminals/clean|list|terminate`; only the TS bindings lag),
   * so latching on ANY error meant one poll landing during startup — or on a
   * thread that was not ready, or while a turn was still pending — permanently
   * disabled background-terminal chips for the whole session.
   *
   * The taxonomy is measured off the shipped binary, not guessed
   * ({@link isDefinitiveBackgroundTerminalsRefusal}): this app-server has NO
   * "Method not found" string at all (0 occurrences) because `ClientRequest` is a
   * serde-tagged enum, so an unrecognised method fails as `unknown variant`
   * (32 occurrences); a wrong param shape fails as `missing field` (41) /
   * `unknown field` (20) / `invalid type` (15). Everything else — `thread not
   * found` (2), "thread already has an active or pending turn", a closed client,
   * a write failure — is transient and RETRIES at the next turn boundary.
   *
   * Reset by {@link teardownRuntime} so a fresh runtime re-probes.
   */
  private backgroundTerminalsUnsupported = false;

  /**
   * P6.111 · chip events a refresh produced that could not reach the host yet,
   * flushed by the next turn's head or (UA12.101) by the end of the open turn.
   *
   * Anything pushed after a turn's `complete` is dropped, so a refresh that ends
   * while a turn is open, or with no host door, parks its events here. With the
   * door (`BackendConfig.onBetweenTurnsEvent`) a refresh outside a turn delivers
   * at once ({@link deliverRefreshedTerminalEvent}), and the turn's `finally`
   * hands it what a mid-turn one parked, before the Stop hook ({@link releaseParkedTerminalEvents});
   * with no door the next turn's head flushes them (P3.3's order holds).
   */
  private pendingBackgroundTerminalEvents: AgentEvent[] = [];

  /** P6.111 · the in-flight refresh, so a turn head and a reaper read cannot double-poll. */
  private backgroundTerminalRefresh: Promise<void> | null = null;

  /** P6.111 · when the last refresh started, so a busy reader cannot drive an RPC loop. */
  private lastBackgroundTerminalRefreshAt = 0;
  /** Current turn's event sink (set per chatImpl call). */
  private turnSink: ReturnType<typeof createEventQueue> | null = null;
  /**
   * P2.408 — operator notices from codex's plain `warning` channel that arrived
   * with no turn open, held for the next one.
   *
   * NOT a general-purpose queue, and not speculative plumbing: MEASURED against
   * the shipped binary (2026-08-29), the one class we can name on this channel —
   * "under-development features enabled" — arrives in the SAME FLUSH as
   * `thread/started`, once per thread, and `thread/start` runs in
   * {@link createRuntime}. So at the moment it lands `turnSink` is always null,
   * and a `turnSink?.push(...)` would have surfaced it exactly never. Deferring
   * is what makes the surfacing real rather than inert.
   *
   * Bounded, because it is fed by the runtime and drained by the user: a session
   * that never takes a turn must not grow this without limit. Deliberately kept
   * across turns' ends and cleared only on drain — a notice that would have been
   * dropped is worth one late row, and this channel is low-rate by construction
   * (one frame per `thread/start`).
   */
  private readonly pendingServerWarningNotices: string[] = [];
  /**
   * P3.335 — `toolUseId` → the tool name and input its `tool_start` carried,
   * for the turn currently running.
   *
   * codex's `item/completed` notification carries the OUTPUT and not the input,
   * and Pi's `PostToolUse` payload carries `tool_input` — so a hook body written
   * once for both would read `undefined` here unless the start is remembered.
   * Cleared on `turn/completed`: a tool id cannot recur across turns, and an
   * unbounded map on a long session is a leak.
   */
  private readonly codexToolCallInputs = new Map<string, { toolName: string; input: Record<string, unknown> }>();
  /**
   * D1.342 — the paths this codex session has seen, for the read-before-write
   * rule {@link readBeforeWriteVerdict} enforces at the approval bridge.
   *
   * One per agent, which is one per session: the lifetime IS the *"current
   * conversation"* the rule is written against, and it is the same class
   * `ClaudeAgent` and `LocalToolRuntime` hold for the same reason.
   */
  private readonly readBeforeWriteLedger = new SessionFileReadLedger();
  /**
   * Pending approval requests keyed by the Nessy requestId we surfaced. The
   * request's own `params` are kept because the response shape is per-method:
   * an MCP elicitation's accept answers the form it was asked with.
   */
  private readonly pendingApprovals = new Map<string, {
    kind: ApprovalKind;
    params: unknown;
    /** For a url-mode elicitation, the validated href to open once allowed. */
    urlToOpen?: string;
    /**
     * The floor that put this card on screen, if any (P2.140).
     *
     * Carried on the record rather than recomputed at answer time because the
     * permission mode can change between the ask and the answer, and the request
     * must be answered under the floor it was RAISED under — recomputing could
     * silently drop a floor a mode switch made invisible.
     */
    floor?: NonNegotiableFloorVerdict; askRule?: CodexRuleAnswer; sandboxRetained?: true; // F1.870 — the ask rule that carded it: no don't-ask-again; F1.780 — the card said codex keeps it sandboxed, so no durable rule ({@link codexCommandStaysSandboxed})
    resolve: (payload: Record<string, unknown>) => void;
  }>();
  /**
   * Browser opener for url-mode elicitation — the repo's single `openUrl` seam
   * (Electron `shell.openExternal`, with the `open` package as the non-Electron
   * fallback). A field rather than a direct call so tests never launch a real
   * browser, mirroring `McpElicitationOptions.openUrl` on the Pi path.
   */
  private openExternalUrl: (url: string) => Promise<void> = openUrl;
  /** Guards `withCodexUsage` against re-adding a snapshot it already reported. */
  private lastEmittedUsageTimestamp: number | null = null;
  /**
   * The app-server's id for the turn currently running on THIS thread, or null
   * between turns.
   *
   * `turn/steer` carries it as `expectedTurnId`, and that field's own contract
   * is a precondition, not a hint: "Required active turn id precondition. The
   * request fails when it does not match the currently active turn"
   * (`codex-protocol/generated/v2/TurnSteerParams.ts`, `required` in
   * `schema/codex_app_server_protocol.v2.schemas.json`).
   *
   * Written from `TurnStartedNotification`, NOT from the `turn/start` response,
   * for three reasons and only the first is convenience. (1) The notification
   * handler is already the one place that sees this thread's stream, and it is
   * already thread-attributed by `isForeignThreadNotification`, so a subagent's
   * turn cannot clobber the parent's id. (2) It is the server's own
   * announcement of what is running, so it also covers a turn this client did
   * not start — a server-side auto-compaction turn, or a turn on a resumed
   * thread. (3) The response is an unordered race against the stream:
   * `chatImpl` fires `turn/start` WITHOUT awaiting it, so a response that
   * landed after `turn/completed` would resurrect a dead id, and a steer sent
   * against a finished turn is refused with an error the user did not cause.
   * That makes notification-only correct rather than merely simpler.
   */
  private activeTurnId: string | null = null;
  /**
   * P6.274 (b) · retries codex has announced for the turn in flight.
   *
   * Reset at `turn/started` and nowhere else, so it counts ONE turn's ladder
   * rather than the session's — a session-scoped count would keep climbing
   * across unrelated turns and read as a single endless retry.
   */
  /**
   * C3.67 — the file checkpoints this session has opened for a codex
   * `fileChange` item, keyed by the item's id (codex's `call_id`).
   *
   * A PROMISE per item rather than a value, because the create and the finalize
   * arrive as two notifications and the second must not run before the first has
   * written its entry. Deleted at finalize, so the map is the set of patches in
   * flight and not a session-long ledger.
   */
  private readonly codexFileCheckpoints = new Map<string, Promise<string[]>>();
  /**
   * C3.386 — the paths one in-flight `fileChange` item is about to write, keyed
   * by the item's id, so the APPROVAL for that item can name them.
   *
   * codex's v2 approval frame carries no paths at all
   * (`FileChangeRequestApprovalParams` is `{threadId, turnId, itemId,
   * startedAtMs, reason?, grantRoot?}`), which is why RS-12 met a bare
   * `ApplyPatch / Apply file changes / Always Allow` card on 1.37.0. It does
   * carry `itemId`, and {@link checkpointCodexFileChange}'s own comment records
   * the fact that makes this work: *"The approval request and the patch-begin
   * event carry the SAME `call_id`"*. So the paths are already in this process
   * — `item/started` delivered them — and only the correlation was missing.
   *
   * SEPARATE from {@link codexFileCheckpoints} rather than derived from it,
   * because that map is gated on a session storage path and on not having
   * checkpointed the item already: a session with nowhere to write checkpoints
   * would otherwise get an unnamed card as well as no rewind, which is the two
   * failures a user can least afford together.
   *
   * Bounded by the same lifecycle: written at `item/started`, deleted at
   * `item/completed` beside the checkpoint finalize, so it holds the patches in
   * flight and never a session-long ledger.
   */
  private readonly codexFileChangeItemPaths = new Map<string, string[]>();
  private codexRetryAttempt = 0;
  /**
   * P6.917 · a retry chip is standing on this turn and nothing has cleared it.
   *
   * codex publishes no retry-END signal at all — `ErrorNotification` is
   * `{ error, willRetry, threadId, turnId }` and there is no resolution
   * notification beside it — so the fallback the row names applies: the retry is
   * over when the model speaks again. Reset at `turn/started` beside the attempt
   * counter, and cleared at most ONCE per retry, because a second
   * `Retry succeeded` would republish the line and re-anchor the renderer's
   * countdown.
   */
  private codexRetryChipStanding = false;
  /**
   * In-flight `turn/steer` requests BELONGING TO THE CURRENT TURN. Their only job
   * is to keep that turn's event sink open until a refusal can be reported on it
   * — see {@link finishTurnSinkAfterPendingSteers}.
   *
   * The set is REPLACED at every boundary that ends a turn ({@link
   * detachTurnSteers}), and {@link redirect} captures the instance it added to.
   * That is what keeps a steer's lifetime inside its own turn, and it is not a
   * detail. The first version of this was ONE AGENT-SCOPED set emptied only by
   * each steer's own `.finally`, so a steer the server never answered stayed in
   * it forever and `finishTurnSinkAfterPendingSteers` then gated EVERY LATER
   * TURN on that dead promise. Measured: turn 1 steers, the request is held
   * open, the user presses Stop, turn 2 receives its own `turn/completed` and
   * its sink never finishes — the agent is wedged for the rest of the session.
   * The doc that used to sit here claimed the transport bounded that
   * ("`AppServerClient.close()` rejects every pending request"); `close()` runs
   * on teardown, never on Stop, so it bounded nothing for a live agent.
   */
  private turnSteers = new Set<Promise<unknown>>();
  /**
   * R18 · the current turn's structured-output obligation, or null when no
   * schema rode `turn/start`.
   *
   * Armed immediately before `turn/start` (never earlier — the field would
   * outlive a turn that returns before firing one), READ by
   * {@link withStructuredOutput} on every `complete` of the turn, and cleared
   * only in `chatImpl`'s `finally`. `lastAssistantText` is the LATEST assistant
   * message of the turn, because the protocol's own description of the field is
   * about the LAST one: "Optional JSON Schema used to constrain the final
   * assistant message for this turn"
   * (`codex-protocol/schema/v2/TurnStartParams.json`).
   *
   * `turnId` is which turn "the turn" means. The app-server multiplexes every
   * thread's notifications, and `isForeignThreadNotification` only separates
   * THREADS — a second turn on OUR OWN thread (a server-side auto-compaction
   * turn) is not foreign and its `agentMessage` would otherwise overwrite the
   * answer we are about to validate. Pinned from the first `turn/started` seen
   * after arming, which is ours: the arming sits microseconds before the
   * `turn/start` that causes it, and the app-server does not begin turns on an
   * idle thread of its own accord.
   *
   * RESIDUAL, deliberately not papered over: nothing on this wire identifies a
   * turn as ours. `TurnStartParams.clientUserMessageId` is the only candidate
   * and it is echoed on the `userMessage` ThreadItem, not on the
   * `agentMessage`, so adopting it would mean sending a field and depending on
   * an item notification neither the bindings nor our own live evidence
   * promises. A null `turnId` (no `turn/started` arrived) and a notification
   * with no readable `turnId` therefore both fall back to accepting the text —
   * the pre-pin behaviour — because refusing would silently produce
   * "no structured output" for a turn that answered perfectly well.
   */
  private turnStructuredOutput: {
    compiled: CompiledStructuredOutputSchema;
    turnId: string | null;
    lastAssistantText: string | null;
  } | null = null;

  constructor(config: BackendConfig) {
    super(config, DEFAULT_CODEX_MODEL);
    // P6.101 — the instance answer and the session list's cold answer come from
    // ONE record, so a codex session reports the same branching verdict whether
    // or not its agent happens to be running. `BaseAgent`'s field defaults to
    // `true`, which is what offered Branch on a runtime that reads no
    // `branchFrom` at all.
    this._supportsBranching = SESSION_BRANCHING_SUPPORT['codex-runtime'];
    if (!config.isHeadless) this.startConfigWatcher();
    // Q13-D1: codex reaches MCP servers through the SHARED workspace pool via
    // `[mcp_servers.sources]`, so a server's `elicitation/create` arrives at the
    // pool's client in this process, not at codex. Without this the pool has no
    // user for this leaser and every such request is declined.
    this.registerMcpElicitationHandler();
    // P6.643 — the codex arm of the session's hook-run store, a settable field (no options
    // bag on the field initializer); the adapter already builds the observation, and this is
    // the only place a SUCCESSFUL hook run is legible. F1.467 — the compaction info's trigger
    // reads the SAME flag the PostCompact hook does, at the same moment.
    this.eventAdapter.onHookRun = observation => this.recordHookRun(observation);
    this.eventAdapter.isManualCompactionRequested = () => this.manualCompactionRequestedForTurn;
  }

  // ============================================================
  // Runtime lifecycle
  // ============================================================

  private resolveBinaryPath(): string {
    const binary = getBackendRuntime(this.config).paths?.codexBinary;
    if (!binary) {
      throw new Error('codex-app-server binary path not resolved (codexDriver.buildRuntime). Run scripts/fetch-codex.mjs.');
    }
    return binary;
  }

  /**
   * Build the `[mcp_servers.session]` spec for the bundled
   * session-mcp-server, or undefined when the session/workspace/binary aren't
   * all resolvable (a Codex session with no workspace still starts). Passes
   * `--external-standalone-only` so only callback-free tools are advertised
   * (Phase 5 Task 5.3).
   *
   * T5 — plus `--host-callback-port` when a bridge is running, which is the
   * spawn flag that lifts the exclusion for the five scheduling/watching tools.
   * ONE argument does both jobs (it names the channel and proves it exists), so
   * there is no state in which the subprocess advertises a tool whose calls have
   * nowhere to land. Deliberately not the old `--callback-port`: that one named
   * the separate `call_llm` HTTP callback no spawn passed (F1.710), removed (F1.1135).
   *
   * No bridge → no argument → the pre-T5 18-tool surface, unchanged.
   *
   * P3.13 — and `--advisor-consult` beside it, under the same rule: emitted only
   * when a bridge exists (its route is one of that bridge's) AND the advisor is
   * enabled. The setting is read HERE because the SUBPROCESS's tool list is
   * fixed for its own lifetime — it parses argv once. The consult's own second
   * belt still runs on every call (`BaseAgent.executeAdvisorConsult` re-reads
   * the setting), so a user who turns the advisor OFF mid-session is refused
   * with the documented sentence rather than advised.
   *
   * P3.28 — this comment used to continue "a mid-session toggle therefore lands
   * on the next runtime start", and that inference was WRONG at the runtime
   * level. A fixed subprocess is not a fixed SURFACE: the app-server re-spawns
   * its MCP children on `config/mcpServer/reload`, so a flip needs a new
   * subprocess, not a new runtime. {@link refreshSessionMcpAdvisorAdvertisement}
   * is the seam that does it, and it re-derives its argv from THIS method so
   * the spawn rule and the refresh rule are one rule.
   *
   * ## The argv classification — F1.161 / F1.174, and it is the thing to read
   * before adding a flag here
   *
   * This argv is the ONLY channel for host state the child cannot read, and the
   * child parses it ONCE. Three sites must agree per flag: this emitter, the
   * argv loop in `session-mcp-server/src/index.ts`, and `createCodexContext`'s
   * binding. Each flag below arrived with its own docblock in a different file
   * and the class it belongs to was written nowhere, which is what made F1.116
   * possible — the drift check recorded one boolean over the advisor and was
   * structurally blind to the rest of the line.
   *
   * Every flag this method can write is classified exactly once, and
   * `codex-session-mcp-argv-class.test.ts` is what keeps that true: a flag added
   * here and not below turns it red and asks one question of its author.
   *
   * PER-CHAT: `--memory-scope-write`, `--working-directory` — this chat's own
   * controls, which a user moves mid-chat. They go STALE in a running child,
   * and {@link sessionMcpAdvertisedArgs} is the record the turn-head comparison
   * corrects them from, on the same thread, with no runtime restart. A new flag
   * of this class needs nothing but a line here.
   *
   * SPAWN: `--host-callback-port`, `--advisor-consult` — they describe the SPAWN
   * (a channel, and which tools exist on it), not the chat. Kept out of the
   * class deliberately: if every flag were in it the classification would carry
   * no information, and this pair is what makes it a class rather than a list.
   *
   * FIXED: `--session-id`, `--session-path` (F1.765), `--workspace-root`, `--config-root`, `--credential-home`,
   * `--external-standalone-only` — constant for the whole life of the session,
   * so they cannot drift and cost the comparison nothing.
   *
   * SETTING: `--plans-folder`, `--memory-app-write`, `--user-memory-root`, `--sandbox-reads-fenced`,
   * `--sandbox-denied-read-root` — per session, neither this chat's control nor a
   * constant (F1.118's APP-WIDE switch; F1.196's host read policy). F1.175 pinned
   * the first: a mid-session move DOES re-advertise, on P6.704's reasoning — this
   * child writes a plan on codex, so a `plansDirectory` stopped at the host would
   * move the gate and the prompt and leave the file in the old place.
   */
  private buildSessionMcpSpec(bridgePort?: number): CodexMcpServerSpec | undefined {
    const paths = getBackendRuntime(this.config).paths;
    const sessionServer = paths?.sessionServer;
    const sessionId = this.config.session?.id;
    const workspaceRoot = this.config.workspace.workspaceRootPath;
    const workspaceId = this.config.workspace?.id;
    if (!sessionServer || !sessionId || !workspaceRoot || !workspaceId) return undefined;
    return {
      command: paths?.node ?? process.execPath,
      args: [
        ...bunProjectIsolationArgs(paths?.node ?? process.execPath), sessionServer, // F1.1066 — codex spawns this child in the thread's cwd, the session folder (measured, 0.156.1), so Bun must not read that folder's .env files or bunfig.toml; Bun consumes the switches, the child's argv is unchanged
        '--session-id',
        sessionId, '--session-path', getSessionDirPath(workspaceId, sessionId), // F1.765 — the storage-v2 folder pi/claude bind; the child's pre-v2 guess wrote where no host reader looks
        '--workspace-root',
        workspaceRoot,
        '--plans-folder',
        // P6.704 - the session MCP server is what actually WRITES a plan on
        // codex, so a configured `plansDirectory` that stopped here would move
        // the gate and the prompt while leaving the file in the old place.
        // Unset is today's path byte-for-byte.
        resolvePlansDirectory(this.workingDirectory) ?? getSessionPlansDir(workspaceId, sessionId),
        '--config-root',
        CONFIG_DIR,
        '--external-standalone-only',
        // D1.426 — this chat's memory WRITE axis, on the one runtime whose
        // `remember` is served by a child. Emitted ONLY for an axis the chat
        // actually set, so a session that never touched the control spawns
        // HEAD's argv byte-for-byte and the child keeps following the app-wide
        // switch alone (D1.371). Read here rather than captured, for the reason
        // `--advisor-consult` is: the child parses argv once. The resolution,
        // the ground rule and the residue are `codexMemoryWriteAxis`'s docblock
        // in `session-mcp-server/src/index.ts`.
        ...(typeof this.config.session?.memoryScopeOverride?.write === 'boolean'
          ? ['--memory-scope-write', String(this.config.session.memoryScopeOverride.write)]
          : []),
        // F1.118 — the APP-WIDE half of the same switch, for the one install
        // the child cannot answer for on its own. See
        // {@link codexAppMemoryWriteArgs}.
        ...this.codexAppMemoryWriteArgs(), ...this.codexSandboxReadFloorArgs(), ...codexUserMemoryRootArgs(),
        // D1.372 — this session's PROJECT directory, for the same reason and in
        // the same shape: `handleRemember` resolves `scope: "project"` from
        // `ctx.workingDirectory`, and no argv carried one here, so that scope
        // was refused BY NAME on every codex call while pi and claude saved.
        //
        // `this.config.session?.workingDirectory`, deliberately NOT the
        // protected `this.workingDirectory` read above for the plans folder:
        // `BaseAgent`'s constructor defaults that field to the workspace root,
        // so sending it would write `<workspace>/MEMORY.md` for every session
        // that chose no project — a file pi and claude never write — and do it
        // silently, since the handler cannot tell a fallback from a choice. The
        // session field is absent exactly when there is no project, which is the
        // state pi (`getSessionToolContext`) and claude (its
        // `getSessionScopedTools(...)` call site) are in, and both spell it this
        // way. A blank is refused here rather than in the child because
        // `join('', MEMORY_FILE_NAME)` is a RELATIVE path the child would
        // resolve against its own cwd.
        ...(typeof this.config.session?.workingDirectory === 'string'
          && this.config.session.workingDirectory.trim() !== ''
          ? ['--working-directory', this.config.session.workingDirectory]
          : []),
        ...(typeof bridgePort === 'number' ? ['--host-callback-port', String(bridgePort)] : []),
        // The literal, NOT {@link CODEX_ADVISOR_CONSULT_FLAG}, and deliberately:
        // `codex-callback-bridge-host.test.ts` reads this whole expression as
        // SOURCE TEXT (it cannot call the method without spawning an app-server),
        // so substituting the constant here would break a sibling package's
        // suite to buy a property a test already provides — see the flag's own
        // doc for what binds the two spellings.
        ...(typeof bridgePort === 'number' && getAdvisorEnabled() ? ['--advisor-consult'] : []),
        // UB6.11 — `decide`'s offer flag, `--advisor-consult`'s exact shape: the
        // route is one of the bridge's, so the flag is emitted ONLY beside a
        // bridge port, and ONLY when the decision layer is configured (the
        // sync, local stored-settings read — the same fact
        // `SessionToolFilterOptions.decidePort` names). The tool list is fixed
        // at thread start, so a provider configured mid-thread appears on the
        // NEXT codex thread: the residue the Settings diagnostic names.
        ...(typeof bridgePort === 'number' && decisionToolConfigured() ? ['--decide-port'] : []),
      ],
    };
  }

  /**
   * F1.118 · the APP-WIDE memory write switch, stated on the argv because the
   * child cannot read it on a moved-config install.
   *
   * `codexMemoryWriteAxis` (`session-mcp-server/src/index.ts`) reads that switch
   * with `getMemoryEnabled()`, which resolves its config file from shared's
   * module-level `CONFIG_DIR` — the CHILD's, not ours. D1.371 gated the read on
   * `CONFIG_DIR === configRoot` because codex's `create_env_for_mcp_server`
   * (`codex-rs/rmcp-client/src/utils.rs`) builds a stdio MCP server's
   * environment from an allowlist that does not carry `NESSY_CONFIG_DIR`, so on
   * any host that moved its config directory the grounds differ, the child
   * answers `undefined`, the key stays absent and `handleRemember` WRITES. That
   * docblock declined fail-closed for a stated reason (it would break `remember`
   * outright on every dev rig and every moved-config install); this is the third
   * option it did not have — **the host knows the answer, so the host says it**,
   * in the shape `--memory-scope-write` and `--working-directory` already use.
   *
   * ## Only the OFF position is written
   *
   * {@link codexMemoriesOption}'s own rule, for its reason: ON is the default,
   * the unreadable-config fallback on both sides, and the state in which nothing
   * withholds a write — so an absent flag and `true` are the same instruction,
   * and an ordinary session's argv stays byte-identical to HEAD's. The value is
   * carried rather than made a bare presence flag so this child's parse is one
   * shape with its sibling and an inverted default would be one line here.
   *
   * ## The two axes cross SEPARATELY and are resolved once, in the child
   *
   * `resolveSessionMemoryScope` is the documented either-direction precedence
   * (`settings-reference.md#automemoryenabled`), and resolving it here as well
   * would decide it twice inside one session. So this method reads the app-wide
   * switch ALONE and never the override beside it.
   *
   * A read that throws decides nothing and emits nothing — `codexMemoriesOption`
   * and `applyCodexThreadMemoryMode` answer the same failure the same way, and
   * it lands on the child's own "an unreadable switch reads as ON".
   *
   * Read at spec time, never captured: {@link refreshSessionMcpAdvisorAdvertisement}
   * compares the whole argv at the head of every turn, so a mid-session flip of
   * the app-wide switch re-spawns the running child instead of waiting for the
   * next runtime start.
   */
  private codexAppMemoryWriteArgs(): string[] {
    let globalEnabled: boolean;
    try {
      globalEnabled = getMemoryEnabled();
    } catch (error) {
      this.debug(
        '[Memories] the host auto-memory switch could not be read, so the session MCP child keeps '
        + `following its own ground rule: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
    return globalEnabled ? [] : ['--memory-app-write', 'false'];
  }

  /**
   * The LIVE app-server's `[mcp_servers.session]` argv, exactly as this runtime
   * wrote it — or `null` when no runtime is up (nothing to compare against; the
   * next spawn reads every input for itself).
   *
   * Recorded from the spec that was actually written, never from the settings
   * behind it, so a spawn that could not build a spec at all leaves this `null`
   * rather than claiming a surface nothing serves.
   *
   * F1.116 — the WHOLE argv, where this was ONE BOOLEAN
   * (`args.includes(CODEX_ADVISOR_CONSULT_FLAG)`) until 2026-09-20.
   * `buildSessionMcpSpec` puts three pieces of per-chat host state on that argv
   * and the child parses argv ONCE, so a boolean could only ever carry a flip of
   * the advisor: a memory untick-then-reset (F1.138, measured live by SIT-10 on
   * dmg #4 — `Memory is disabled for this workspace.` on a chat that had already
   * turned memory back on) and a project directory chosen mid-chat (D1.372's
   * `--working-directory`) each produced NO request at all and landed at the
   * next runtime start. Comparing the argv makes the spawn rule and the refresh
   * rule one rule for every value on it, INCLUDING ones added later — which is
   * the property the boolean could not have.
   */
  private sessionMcpAdvertisedArgs: readonly string[] | null = null;

  /**
   * P3.28 · make an advisor flip visible to codex WITHOUT a runtime restart.
   *
   * F1.116 · and every OTHER piece of per-chat host state on the same argv, for
   * exactly the same reason and through exactly the same pair — the method name
   * keeps saying "advisor" because it is cited by symbol in the parity plan and
   * a rename buys nothing the docblock cannot say. What it compares is
   * {@link sessionMcpAdvertisedArgs}, whose own doc carries the two measured
   * cases a boolean could not see (F1.138's memory reset, D1.372's project
   * directory).
   *
   * ## The premise this replaces, and the measurement that refuted it
   *
   * P3.13 raised the flip as a latency gap on the reasoning that codex's tool
   * list is fixed at spawn. Half of that is true and the half that matters is
   * not: our `session-mcp-server` parses argv once, but the APP-SERVER re-spawns
   * its MCP children on demand. Measured 2026-08-27 against the bundled
   * `codex-app-server` (rust-v0.148.0) with a stub MCP server and a loopback
   * Responses provider:
   *
   * - `config/value/write { keyPath: 'mcp_servers.session.args', … }` +
   *   `config/mcpServer/reload` → the stub is re-spawned with the new argv, and
   *   turn N+1 **on the same thread** carries the new tool in the model-visible
   *   `mcp__session` schema. Reversing the write removes it again.
   * - Config fidelity: codex edits the one key in place. Over a 20-iteration
   *   run, ZERO lines of our generated `config.toml` were lost (the only
   *   addition was the app-server's own `[projects.<ws>] trust_level`).
   * - Cost: the write+reload pair measured min 7.2 ms / p50 14.1 ms / max
   *   31.8 ms over 20 samples, with a deliberately slow (3 s/response) second
   *   MCP server configured — `reload` triggers re-initialization rather than
   *   waiting for it.
   *
   * So this is a SPLIT under the share-vs-split rule with the codex-native
   * mechanism NAMED and measured, not a shared mechanism and not an open gap:
   * pi rebuilds its proxy tool defs per turn and claude clears a per-session
   * cache, so neither needs anything.
   *
   * ## Why a TURN-HEAD drift check and not the toggle's own call site
   *
   * The obvious trigger is `BaseAgent.describeAdvisor` — the `/advisor on|off`
   * handler. It is the wrong one, twice over. It is not the only writer the
   * setting can have (a hand-edited `config.json`, a managed push), and — see
   * the report for P3.28 — nothing in production reaches it today: `chat()`'s
   * session-command block has arms for `clear`, `quota` and `approve` and NONE
   * for `advisor`, so `/advisor` falls through to `chatImpl` and is sent to the
   * model as prose. Hanging this off that method would have shipped a path no
   * turn can reach. Comparing at the head of a turn is trigger-independent: it
   * closes on the next turn however the setting moved.
   *
   * ## Failure posture
   *
   * Best-effort and structurally silent to the user. Every failure — no client,
   * no spec, a refusal, a deadline — leaves {@link sessionMcpAdvertisedArgs}
   * ALONE, so the next turn tries again, and degrades to exactly the pre-P3.28
   * behaviour (the flip lands at the next runtime start) with one debug line.
   * The consult's second belt is unaffected either way: an advisor turned OFF
   * mid-session still refuses with the documented sentence even if this never
   * runs.
   */
  private async refreshSessionMcpAdvisorAdvertisement(
    /**
     * Budget for EACH of the two calls. Overridable for the reason
     * {@link applySelectedPluginSkillRuntimePolicy}'s is — a test must be able to
     * pick a bound it can actually wait out — and production takes the constant,
     * which is what the suite's own "production budget reaches the channel" row
     * exists to keep true.
     */
    timeoutMs: number = CODEX_MCP_ADVERTISEMENT_REFRESH_TIMEOUT_MS,
  ): Promise<void> {
    const client = this.client;
    // `null` is "no runtime recorded a spec" — there is nothing live to correct,
    // and the next `createRuntime` reads every input on its own.
    const advertised = this.sessionMcpAdvertisedArgs;
    if (!client || advertised === null) return;
    const spec = this.buildSessionMcpSpec(this.callbackBridge?.port);
    if (!spec) return;
    // F1.116 · element-wise over the WHOLE argv, and ORDER-SENSITIVE on purpose:
    // `buildSessionMcpSpec` emits one fixed sequence, so an unchanged session
    // compares identical and performs ZERO RPCs — which is the property that
    // lets this sit at the head of every turn, since the pair below
    // re-initialises every configured MCP server and not only ours.
    if (advertised.length === spec.args.length
      && advertised.every((arg, index) => arg === spec.args[index])) return;

    try {
      const wrote = await requestWithinDeadline(client, 'config/value/write', {
        keyPath: 'mcp_servers.session.args',
        value: spec.args,
        mergeStrategy: 'replace',
      }, timeoutMs);
      if (wrote === CODEX_REQUEST_TIMED_OUT) {
        this.debug('[codex-session-mcp] config/value/write did not answer; the change lands at the next runtime start');
        return;
      }
      const reloaded = await requestWithinDeadline(client, 'config/mcpServer/reload', undefined, timeoutMs);
      if (reloaded === CODEX_REQUEST_TIMED_OUT) {
        this.debug('[codex-session-mcp] config/mcpServer/reload did not answer; the change lands at the next runtime start');
        return;
      }
      // Only an ANSWERED pair may record the new surface. Recording it earlier
      // would make the next turn skip a refresh that never happened.
      this.sessionMcpAdvertisedArgs = spec.args;
      this.debug(`[codex-session-mcp] re-advertised: ${spec.args.join(' ')}`);
    } catch (error) {
      this.debug(
        `[codex-session-mcp] could not re-advertise the session MCP surface; the change lands at the next runtime start: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Whether this session's host-callback bridge is up — and therefore whether
   * the four cron tools, `Monitor`, `ProcessStop` and the `Goal` pair exist on
   * this runtime at all. Measured on HEAD: an unbridged codex surface is 18
   * tools with NONE of the cron four; a bridged one is 26 with all four.
   *
   * Three states and not a boolean, because "the bridge failed" and "no turn
   * has started one yet" are different facts and only the first may withhold a
   * surface. {@link CodexAgent.getSchedulingBridgeState} is the reader.
   */
  private schedulingBridgeState: CodexSchedulingBridgeState = 'not-started';

  /**
   * @see schedulingBridgeState
   *
   * Read across the package boundary by `SessionManager`, duck-typed the way
   * `getRecentAgentStderr` reads `getRecentStderr` — an optional method on the
   * agent rather than a widening of `AgentInstance`, so no other backend has to
   * answer for a bridge it does not have.
   */
  getSchedulingBridgeState(): CodexSchedulingBridgeState {
    return this.schedulingBridgeState;
  }

  /**
   * P2.294 — TELL TURN 1 THE TRUTH, because the turn's own capability view
   * cannot be made to carry it.
   *
   * ## The hole, stated exactly
   *
   * `SessionManager` freezes the model-facing capability view (skill listing
   * included) in `createCapabilityTurn`, and only THEN builds the agent through
   * `getOrCreateAgent`; this class starts the bridge later still, inside
   * `ensureRuntime()`. So on turn 1 the view's `schedulingBridgeKnownAbsent`
   * read has no agent to ask, answers `false`, and the listing offers the `loop`
   * skill in a session whose cron tools may already be gone. From turn 2 the
   * view is rebuilt per send and gates correctly, so the hole is exactly one
   * turn wide — and P2.280 measured what it costs: 18 tools with none of the
   * cron four, against 26 with them.
   *
   * ## The two designs, and why this is the one built (owner-visible choice)
   *
   * **A — ordering.** Split the capability turn in two: freeze enough of the
   * view to construct the agent, spawn the runtime, then recompute the skill
   * list once the bridge has answered. It removes the lie at its source. It also
   * (a) inverts a real dependency — `getOrCreateAgent(managed, runtime)` takes
   * the view as an argument, so the agent is built FROM the thing being
   * recomputed; (b) puts the runtime SPAWN on the head of turn 1 before the
   * model-facing surface is fixed, and P2.232 measured that spawn at 232 ms to
   * 34.7 s on one machine — a ~170x spread, which is the same "wait on the
   * turn's head" this row already refuted once; and (c) lands entirely in
   * `SessionManager.ts`, whose every reader assumes one frozen view per turn.
   *
   * **B — this one.** Say the true thing in the band the model already reads.
   * One host-authored context part, emitted only in a session whose bridge
   * actually failed. No vocabulary change (the third, "refusing" tool state the
   * row offered is not introduced), no wait, no cross-runtime blast radius, and
   * nothing about what the model MAY do changes.
   *
   * **B is a POSTURE, and this is the site saying so:** it adds text a codex
   * model reads, and it answers the row's question "who is not being told?" with
   * *the model* rather than *the user*. The user is already told, at the moment
   * of failure and by a durable warning — `startCallbackBridge`'s
   * `surfaceCodexOperatorNotice` (P3.267), flushed onto this same turn by
   * `flushPendingServerWarnings`. That notice is a host `info` event; it becomes
   * a transcript row and is never injected into codex's own thread, so the model
   * had no way to learn the fact from it. B closes that half and only that half.
   *
   * ## Why the state is EXACT here rather than a hedge
   *
   * `chatImpl` awaits `ensureRuntimeReportingProgress()` BEFORE it builds the
   * context parts, and the bridge is started inside that await. So by the time
   * this is read the state is already `active` or `unavailable` — including on
   * turn 1. The sentence is never "we do not know".
   *
   * ## Why it is not scoped to turn 1, and why it names no tool
   *
   * Not scoped, because the fact is true for the whole session and the four
   * missing tools are missing on every later turn too; keying it to "the view
   * still lists `loop`" would need `LOOP_SKILL_SLUG`, which lives in
   * `server-core` and cannot be imported here — a hand copy of a slug across a
   * package boundary is the two-lists shape this plan keeps finding. It costs
   * nothing in a healthy session, which is the overwhelming majority: the part
   * exists only when the bridge is `unavailable`.
   *
   * Names no tool for the same reason: the model can see its own tool list, and
   * an enumeration here is a third copy of a set that has already moved once.
   *
   * @returns the context part, or `null` when the bridge is fine or untried.
   */
  private schedulingBridgeContextPart(): string | null {
    if (this.schedulingBridgeState !== 'unavailable') return null;
    return [
      '<scheduling_unavailable>',
      'The host callback bridge for this session did not start, so the scheduling and advisor',
      'tools that reach it are absent from your tool surface for the whole session. Your skill',
      'listing is frozen before the bridge is attempted, so it may still offer a skill that needs',
      'those tools. Your tool list is the truth: if a skill or an instruction asks you to schedule,',
      're-arm or poll work, say that this session cannot and do the work now instead — never report',
      'a schedule as set.',
      '</scheduling_unavailable>',
    ].join('\n');
  }

  /**
   * Start the T5 host-callback bridge for this session, or return undefined
   * when there is no session identity to bind it to.
   *
   * A failure here is NOT fatal: the session still runs, with the pre-T5 tool
   * surface, and the reason goes to the diagnostic channel. Losing scheduling
   * is a smaller harm than refusing to start the runtime, and the subprocess
   * derives its advertisement from the same argument this returns, so the two
   * halves cannot disagree about what happened.
   *
   * P2.280 — non-fatal is not the same as unobservable, and until this row it
   * was BOTH. `debug()` routes through electron-log, whose transports the main
   * process disables (see {@link getRecentStderr}'s own note), so the sentence
   * below reached no terminal, no file and no reader: a bridge-less session was
   * indistinguishable from a bridged one from outside this class. Every remedy
   * for "`/loop` is offered on a runtime whose scheduling tools are missing"
   * needs that fact to exist first, so both outcomes are RECORDED here — at the
   * one place that knows — rather than inferred later from a missing tool.
   *
   * The identity early-return records `unavailable` too, and deliberately: it
   * omits the same `--host-callback-port` argument a throw does, so the
   * subprocess's surface is stripped identically. Reporting it as anything
   * softer would be a second copy of the optimistic claim this row deletes.
   */
  private async startCallbackBridge(): Promise<CodexSessionCallbackBridgeHandle | undefined> {
    const sessionId = this.config.session?.id;
    const workspaceId = this.config.workspace?.id;
    if (!sessionId || !workspaceId) {
      this.schedulingBridgeState = 'unavailable';
      return undefined;
    }
    try {
      const handle = await startCodexSessionCallbackBridge({
        sessionKey: { workspaceId, sessionId },
        // P3.13 — the advisor consult is bound by the AGENT, not by
        // `SessionManager`: `executeAdvisorConsult` packages THIS session's
        // transcript, applies the gates and rides THIS agent's `queryLlm`. The
        // bridge is created and closed with this agent, so the reference cannot
        // outlive its owner the way a captured PORT could across a runtime
        // switch — which is why the three ports stay on the fresh-per-request
        // seam and this one does not.
        advisorConsult: args => this.executeAdvisorConsult(args),
        // C4.13 · bound by the AGENT for the same reason the consult above is:
        // `review/start` runs on THIS session's open codex thread, over THIS
        // agent's app-server client, and the bridge is created and closed with
        // this agent — so the reference cannot outlive its owner. See
        // {@link startDetachedReview}.
        detachedReview: input => this.startDetachedReview(input),
        onDiagnostic: message => this.debug(message),
      });
      this.schedulingBridgeState = 'active';
      return handle;
    } catch (error) {
      this.schedulingBridgeState = 'unavailable';
      const detail = error instanceof Error ? error.message : String(error);
      this.debug(`[codex-callback-bridge] failed to start; scheduling tools stay unavailable this session: ${detail}`);
      // P3.267 · the third binding, and the one whose SITE the row's sweep named
      // and whose FACT sits one line over. `startCodexSessionCallbackBridge`'s
      // own `onDiagnostic` carries a routine "listening on 127.0.0.1:<port>" and
      // a per-request foreign-session refusal (already answered with a 403, and
      // unbounded — lifting it would let a looping client fill the notice
      // queue). The switch-visible fact is HERE: this bridge decides the eleven
      // bridge-only tools `runtime-switch-costs.ts` warns about, so a session
      // that lost them silently is a runtime quietly less capable than the one
      // the user switched from. Once per session, so the bound is not at risk.
      // D1.255 · C3.331's first half — the app's OWN WORDS about the app's own
      // host, addressed to the person in the chat, so they follow the UI
      // language. `detail` is codex's or the OS's text and is passed through.
      if (!i18n.isInitialized) setupI18n();
      this.surfaceCodexOperatorNotice(i18n.t('chat.codexNotice.callbackBridgeUnavailable', { detail }));
      return undefined;
    }
  }

  /**
   * P2.232 · which awaited step of {@link createRuntime} is running, or `null`
   * when no runtime build is in flight. Read only by
   * {@link ensureRuntimeReportingProgress}; see {@link CodexStartupPhase}.
   */
  private startupPhase: CodexStartupPhase | null = null;

  /**
   * P2.232 · run {@link ensureRuntime} and TELL the user while it runs.
   *
   * A generator rather than a callback because the one surface a spawn can
   * reach before a turn exists is the turn's own event stream, and `chatImpl` is
   * where that stream is. `surfaceCodexOperatorNotice`'s queue is the wrong
   * mechanism here for a reason worth writing down: it DEFERS to the next turn,
   * which is exactly the wrong direction for a signal whose whole value is
   * arriving during the wait.
   *
   * `info` WITHOUT `level: 'warning'`, deliberately: this is momentary status,
   * not a durable notice, and a slow start is not a fault. The session layer
   * persists the warning family and not this one.
   *
   * Rethrows whatever `ensureRuntime` threw, unchanged and at the same point in
   * the caller's control flow — the integrity-seatbelt catch at the call site
   * depends on that and this must not become a second error channel.
   *
   * The ticker is `unref`'d where the runtime allows it, so a progress timer can
   * never be the reason a headless server or a CLI-spawned server refuses to
   * exit — the same property {@link startManagedDeliveryPolling} states for its
   * own timer.
   */
  private async *ensureRuntimeReportingProgress(): AsyncGenerator<AgentEvent, void> {
    const startedAt = performance.now();
    let settled = false;
    let failure: unknown;
    let failed = false;
    // Attached immediately, so the rejection is never unhandled while the
    // ticker below is between races.
    const guarded = this.ensureRuntime().then(
      () => { settled = true; },
      (error: unknown) => { settled = true; failed = true; failure = error; },
    );
    let nextNoticeAt = CODEX_STARTUP_FIRST_NOTICE_MS;
    while (!settled) {
      const waitMs = Math.max(1, nextNoticeAt - (performance.now() - startedAt));
      await Promise.race([guarded, new Promise<void>(resolve => {
        const timer = setTimeout(resolve, waitMs);
        (timer as unknown as { unref?: () => void }).unref?.();
      })]);
      if (settled) break;
      const seconds = Math.round((performance.now() - startedAt) / 1000);
      yield {
        type: 'info',
        message: `Codex is still starting (${seconds}s) — ${this.startupPhase ?? 'preparing the session'}. `
          + 'A cold start can take half a minute; nothing is being retried and nothing will time out.',
      };
      nextNoticeAt += CODEX_STARTUP_NOTICE_INTERVAL_MS;
    }
    this.startupPhase = null;
    if (failed) throw failure;
  }

  /**
   * Where this session's model traffic goes, and with which auth (C1).
   *
   * `codexDriver.buildRuntime` classified the connection's endpoint into a
   * secret-free target; the connection credential is attached here, per use, so
   * a rotated key is picked up without a restart and so gateway sessions never
   * touch the credential store (`getCredentialManager()` throws when it is not
   * initialized, which a headless gateway run must survive — it did before C1).
   *
   * Both consumers — the local adapter and `queryLlm`'s direct fetch — resolve
   * through this one method; `Nestor-Token` is then physically confined to
   * `kind: 'nestor'` by the adapter's own transport (`nestor-client.ts`).
   */
  /**
   * Recent upstream auth SCHEMES, newest last — never a credential.
   *
   * Named `getRecentStderr` because that is the method the session diagnostics
   * accessor probes for (`SessionManager.getRecentAgentStderr`), and the Pi
   * agent already answers it from its subprocess ring buffer.
   *
   * **This agent DOES have a subprocess.** The sentence here said it had none,
   * which was true before the app-server arrived and has read as current
   * documentation of process topology ever since — the shape that made P2.410's
   * hole look closed. `CodexRuntimeManager.spawn` starts `codex-app-server`
   * with piped stdio, from `createRuntime` below.
   *
   * What is absent is a SINK, and saying "no reader" would be the same kind of
   * half-truth. The child's stderr IS read: `AppServerClient` subscribes to it
   * and forwards each chunk as an `[app-server stderr]` line through
   * `onDiagnostic`, which this agent wires to `debug()` at the spawn site. But
   * `debug()` routes through electron-log, whose transports the packaged main
   * process disables — the same fact {@link startCallbackBridge} is built
   * around — so those lines reach no terminal, no file and no reader, and there
   * is no buffer here holding them. That is why this method answers from what
   * the adapter observed directly instead.
   *
   * The check to run rather than to trust: anything in this file that RETAINS
   * an `[app-server stderr]` chunk makes the paragraph above wrong.
   *
   * Bounded because a long session must not accumulate one line per request
   * forever.
   */
  private upstreamAuthLines: string[] = [];

  /**
   * P6.585 — the whole {@link UpstreamAuthScheme} vocabulary, not a subset.
   *
   * It was narrowed to three members while the codex driver could not produce an
   * `x-api-key` upstream, and the adapter dropped that scheme rather than
   * reporting it as something it was not. Both halves land together: the driver
   * threads the connection's `credentialHeader` and this ring can name what left.
   */
  private recordUpstreamAuthScheme(scheme: UpstreamAuthScheme): void {
    this.upstreamAuthLines.push(`[codex-adapter] upstream auth: ${scheme}`);
    if (this.upstreamAuthLines.length > 50) this.upstreamAuthLines.shift();
  }

  /**
   * Session FACTS, which must not age out — one entry per `key`, newest wins.
   *
   * The ring above is a per-REQUEST log and it is bounded, so anything written
   * into it once at runtime start is gone fifty requests later. A standing
   * property of the session — "your user and plugin hooks are not projected into
   * codex's config, and here is why" — is not a log line: a user who asks the
   * diagnostics accessor on turn sixty needs the same answer as one who asked on
   * turn one. Keyed rather than appended so a respawn restates rather than
   * accumulates.
   */
  private sessionFacts = new Map<string, string>();

  /** @see sessionFacts */
  private recordSessionFact(key: string, line: string): void {
    this.sessionFacts.set(key, line);
  }

  /** @see upstreamAuthLines */
  getRecentStderr(): string {
    return [...this.sessionFacts.values(), ...this.upstreamAuthLines].join('\n');
  }

  /**
   * P2.414 — the hooks the HOST ITSELF authored, and the sentence about the
   * ones we do not project.
   *
   * ## The owner's decision, executable
   *
   * Projecting a hook into codex's own `[hooks]` table has it executed by codex
   * directly: outside `ProcessSupervisor`, outside plugin-integrity
   * verification, and outside the managed kill switches. The owner ruled
   * (2026-08-29) that this is admissible only for hooks whose content is OURS —
   * a host-authored command has nothing for plugin-integrity to verify, while a
   * user- or plugin-authored one would hand codex something to execute that we
   * neither wrote nor can revoke.
   *
   * ## What the host authors: ONE hook since F1.386, and only under a reviewer
   *
   * Searched before this method was written. Every hook a Nessy codex session
   * runs is dispatched HOST-SIDE by our own automation system
   * (`buildPinnedAgentAutomationSystem` -> `emitAutomationEvent`), from the
   * three tiers that system knows — user settings, project settings, plugins.
   * All three are authored by someone other than the host, so none of them is
   * projectable under the decision above. The one `command` hook the host writes
   * is F1.386's automation floor — {@link unattendedAutomationFloorHookProjection}.
   *
   * With no reviewer (the toggle off, and no remembered administrator list that
   * requires one, F1.514) the config stays BYTE-IDENTICAL — the load-bearing default `buildCodexHooksToml` was built around,
   * because codex fails a config OPEN and WHOLE-FILE and a capability nobody
   * uses must not be able to cost the deny floors of every session.
   *
   * A future lane adding one writes it HERE, through
   * `mintHostAuthoredCodexHooks` — the only door — and owes two more things
   * before it ships: the trust second pass (a projected entry is INERT until
   * `[hooks.state."<key>"]` names it, and the honest source for both key and
   * hash is a read of `hooks/list` — the key's FORMAT is published, as
   * `hook_key` in codex's `hooks/src/lib.rs`, but its `key_source` spelling is
   * codex's and the hash is a sha256 of something this repo has not identified,
   * so it is write -> boot -> read -> trust; F1.386 trusts in ONE boot), and an answer to
   * {@link CodexHostHookRevocation} that is true.
   *
   * P6.1068 — and a THIRD thing if that lane reaches for codex's `mcp_tool`
   * handler kind, which the binary now runs (#39296) and which would keep the
   * host on the path rather than handing codex a command string. Two residues
   * measured at `rust-v0.150.1` are what make it more than a line, and both are
   * recorded where the decision lives, in `buildCodexHooksToml`'s §"Why
   * `command` only": such a handler never receives the hook payload (its `input`
   * is a static `${field}` template and a missing field FAILS the hook), and it
   * has no exit-code channel (a failed call yields empty stdout). Whether that
   * changes P2.414's authorship boundary for USER- and PLUGIN-authored hooks is
   * an owner's call, filed as a row, not taken here.
   *
   * ## What is SAID, every runtime build
   *
   * A notice, unconditionally — F1.386's own when its hook is projected.
   * An absent `[hooks]` table reads as "this session has no hooks", and that is
   * the misreading consequence (2) of the decision exists to prevent. It goes to
   * the session-facts map as well as `debug()`, because `debug()` routes through
   * electron-log, whose transports the packaged main process disables — P2.280
   * measured that on this same class, for exactly this kind of standing fact.
   */
  private hostAuthoredHookProjection(codexHome?: string): { hooks?: CodexHostAuthoredHooksPlan } {
    const hooks = this.unattendedAutomationFloorHookProjection(codexHome); // F1.386/F1.532 — see the helper at the class end
    if (hooks) { this.recordSessionFact('codex-hooks-projection', CODEX_AUTOMATION_FLOOR_HOOK_NOTICE); this.debug(CODEX_AUTOMATION_FLOOR_HOOK_NOTICE); return { hooks }; }
    this.recordSessionFact('codex-hooks-projection', CODEX_HOOK_PROJECTION_NOTICE); this.debug(CODEX_HOOK_PROJECTION_NOTICE); return {};
  }

  /**
   * P6.532 — the codex `model_provider` this session's CONNECTION declared, or
   * `undefined` when the writer keeps its loopback pin (every install that
   * declared nothing).
   *
   * The host half landed at `8bdf9d061` and the writer half at `3a1ee181a`; this
   * is the producer that joins them, and it is deliberately the ONLY thing that
   * decides. `resolveCodexModelProvider` reads the connection and the operator
   * switch and NO ambient AWS name, so a session pinned to the gateway stays
   * pinned on a machine whose shell exports a full AWS identity — the whole
   * safety property of Q-den 72's option (b).
   *
   * Same connection lookup {@link CodexAgent.noteBuiltinAgentTiersOnce} uses, so
   * a session whose slug resolves to nothing declares nothing.
   */
  private declaredCodexModelProvider(): CodexModelProvider | undefined {
    const slug = this.config.connectionSlug;
    const connection = slug ? getLlmConnection(slug) : null;
    return connection ? resolveCodexModelProvider(connection) : undefined;
  }

  private async resolveUpstream(): Promise<UpstreamTarget> {
    return attachUpstreamCredential({
      target: getBackendRuntime(this.config).upstream ?? DEFAULT_UPSTREAM,
      slug: this.config.connectionSlug,
      credentialManager: () => getCredentialManager(),
    });
  }

  /**
   * T1 (2026-08-12) master switch, resolved for the codex config writer.
   *
   * `CodexAgent` lives in `packages/shared`, which cannot import
   * `resolveHostSandboxSettings` (server-core owns the managed
   * `ManagedPiPolicyV1` object that composition needs) — but it must still see
   * the SAME managed floor `getMacosSeatbeltBashSandboxEnabled` (contour b)
   * does, via the identical registered bridge
   * ({@link resolveManagedSandboxEnabledFloor}), or an org policy forcing the
   * master switch back on would reach the `ProcessSupervisor` wrap (contour a)
   * and stop there. codex's app-server is spawned directly by
   * `CodexRuntimeManager`, never through `ProcessSupervisor`, so this is the
   * ONLY sandboxing layer codex's own shell executions get.
   */
  private sandboxGloballyEnabled(): boolean {
    return resolveSandboxEnabled([getUserSandboxSettings()], resolveManagedSandboxEnabledFloor());
  }

  /**
   * P3.175 — the `deniedPaths` credential floor, for the codex-side mirror.
   *
   * Read from the SAME merged config `getDeniedPathViolation` reads
   * (`mode-manager.ts`), so a workspace or managed layer that widens the floor
   * widens the mirror with it. The context falls back to the session's own
   * workspace exactly as {@link consultPermissionRules} does — the floor is not
   * something a turn without a capability view should lose.
   *
   * Called from all FOUR `buildCodexRuntimeConfigOverride`/`writeCodexConfig`
   * sites rather than computed once, because the second of those sites hashes
   * the config into {@link runtimeConfigSignature}: a floor that moved mid-session
   * has to move the signature too, or the refork that would apply it never runs.
   *
   * Fails OPEN by design and says so: an unreadable permissions config leaves
   * codex with the host's own exact denies and no mirror, which is exactly
   * today's behaviour. It never fails the runtime build — a credential mirror
   * that can brick a session is worse than one that is absent and logged.
   */
  /**
   * C3.285 (the build C3.12 asked for) — SAY which of the user's permission
   * rules codex's own approval path cannot consult.
   *
   * `codexApprovalRuleRequests` projects three tool names and two input fields
   * and returns `[]` for everything else, each omission for a stated reason. The
   * narrowness is right; the SILENCE was the defect — P6.214 measured it as a
   * SILENT-LOOSER switch verdict on ledger A51/A52, where a user who wrote an
   * `Agent(...)` rule or a parameter rule on some other field kept a rule that
   * compiles, loads and is never consulted here.
   *
   * Read from the SAME merged config {@link consultPermissionRules} evaluates,
   * through the same context fallback as {@link credentialFloorPatterns}, so the
   * sentence describes the policy this session will actually be judged by.
   *
   * Fails OPEN and silently: an unreadable permissions config leaves the session
   * exactly as it was before this method existed. A diagnostic that can brick a
   * session is worse than one that is absent.
   */
  private noteUnboundPermissionRules(): void {
    try {
      const permissionContext: PermissionsContext =
        this.permissionManager.getCapabilityPermissionsContext?.() ?? {
          workspaceRootPath: this.config.workspace.workspaceRootPath,
          activeSourceSlugs: Array.from(this.sourceManager.getActiveSlugs()),
          projectTrusted: this.config.projectTrusted === true,
        };
      const policy = permissionsConfigCache.getMergedConfig(permissionContext).permissionDsl;
      const line = describeCodexUnboundPermissionRules(classifyCodexUnboundPermissionRules(policy));
      // Keyed, so a respawn restates rather than accumulates — and a policy that
      // has since been fixed clears the fact instead of leaving a stale one.
      if (line) this.recordSessionFact('codex-unbound-permission-rules', line);
      else this.sessionFacts.delete('codex-unbound-permission-rules');
    } catch (error) {
      this.debug(`[CodexAgent] permission rule subjects could not be read: ${String(error)}`);
    }
  }

  private credentialFloorPatterns(): readonly string[] {
    try {
      const permissionContext: PermissionsContext =
        this.permissionManager.getCapabilityPermissionsContext?.() ?? {
          workspaceRootPath: this.config.workspace.workspaceRootPath,
          activeSourceSlugs: Array.from(this.sourceManager.getActiveSlugs()),
          projectTrusted: this.config.projectTrusted === true,
        };
      return anchorCodexFloorOnCredentialHome(permissionsConfigCache.getMergedConfig(permissionContext).deniedPathsBeyondShippedFloor ?? []); // F1.1057 — the user's and operator's entries only, not the shipped floor
    } catch (error) {
      this.debug(`[CodexAgent] credential floor could not be read for the codex mirror: ${String(error)}`);
      return [];
    }
  }

  /**
   * P6.36 · the output style this codex session runs under, or `undefined` when
   * none applies.
   *
   * Same three inputs Pi and Claude resolve from, in the same order, so a
   * runtime switch does not change which style answers:
   *
   *  - `resolveChildOutputStyleId` — `sub-agents.md:933` / `output-styles.md:104`,
   *    a NAMED subagent runs its own system prompt and gets no style, a fork
   *    inherits the parent's. Codex has no `piChildKind` today; the guard is
   *    here so it cannot acquire one and silently start styling named children.
   *  - the nested project walk's stop boundary, derived from the live cwd.
   *  - the plugin-shipped styles of THIS capability generation. Read through
   *    `pluginOutputStyleSources`, which returns an empty list on a generation
   *    mismatch rather than last generation's prose.
   *
   * Called from the thread-start / thread-fork walk (where the prose goes into
   * the thread's `developerInstructions`) and once per turn from `chatImpl`,
   * where the label feeds the reminder and the prose feeds UB12.63's switch
   * notice when the style differs from the block the thread holds.
   */
  private activeOutputStyle(): OutputStyleComposition | undefined {
    const styleId = resolveChildOutputStyleId(this.config.piChildKind, getOutputStyleId());
    if (!styleId) return undefined;
    const projectRoot = outputStyleProjectRootFor(this.config.session?.workingDirectory);
    const pluginStyles = this.pluginOutputStyleSources();
    const composition = resolveOutputStyleComposition(styleId, {
      workspaceRootPath: this.config.workspace.workspaceRootPath,
      ...(this.config.session?.workingDirectory ? { workingDirectory: this.config.session.workingDirectory } : {}),
      projectTrusted: this.config.projectTrusted,
      ...(pluginStyles.length ? { pluginStyles } : {}),
      ...(projectRoot ? { projectRoot } : {}),
    });
    // The residue, said out loud exactly once per runtime rather than left
    // silent: on codex `keep-coding-instructions` cannot control anything in
    // either direction (see {@link codexDeveloperInstructions}).
    //
    // P6.172 · ON THE DURABLE OPERATOR CHANNEL, not `debug()`. P6.36 wrote this
    // sentence and it reached nobody: `debug()` routes through electron-log,
    // whose transports the PACKAGED main process disables outside debug mode —
    // the trap register's own "an empty packaged `main.log` is not evidence" —
    // while `output-styles.ts` makes `false` the DEFAULT for a custom style, so
    // this is the ordinary case and not a corner. `surfaceCodexOperatorNotice`
    // is the one event family the session layer persists, which is what makes
    // the line survive a reload.
    //
    // The `composition.prompt` half of the old guard is REPLACED, not merely
    // dropped, and that was the second silence: a style whose body is empty
    // contributes no prompt, so it announced nothing while its
    // `keep-coding-instructions` setting was just as unhonoured — and
    // `output-styles.ts` makes `false` that style's DEFAULT. Dropping the guard
    // outright would have gone too far the other way and announced for a style
    // that is not running at all, so the condition is read off the composition's
    // own two signals: `label === ''` is the documented "the id resolved to
    // nothing" answer (an unresolvable style subtracts nothing and must stay
    // silent), and a resolved style with neither prose NOR a subtraction — the
    // Default built-in — has no residue to report either.
    const residueApplies = composition.label !== ''
      && (composition.prompt !== '' || composition.keepCodingInstructions === false);
    if (residueApplies && !this.outputStyleResidueAnnounced) {
      this.outputStyleResidueAnnounced = true;
      this.surfaceCodexOperatorNotice(
        `Codex OUTPUT STYLE PARTIALLY APPLIED — the style '${composition.label}' `
        + (composition.prompt
          ? 'is applied as developer instructions, but its '
          : 'carries no prose to apply, and its ')
        + `keep-coding-instructions=${composition.keepCodingInstructions} setting is NOT honoured on `
        + 'this runtime: the app-server owns the base engineering prompt, and the only key that could '
        + "replace it would delete codex's whole base prompt. The built-in engineering guidance stays "
        + 'either way. Pi and claude sessions honour the setting normally.',
      );
    }
    return composition.prompt ? composition : undefined;
  }

  private async ensureRuntime(): Promise<void> {
    if (this.destroyed) throw new Error('codex-agent-destroyed');
    // P6.223 · a permission-mode change USED to force a teardown here, because
    // `config.toml` carries `approval_policy`/`sandbox_mode` and the app-server
    // reads it only at start. It no longer does: the approval half rides
    // `turn/start`'s declared `approvalPolicy` override and the sandbox half
    // rides the per-turn config-drift re-fork, both on the next turn. See
    // {@link setPermissionMode}. Nothing else ever set that flag, so the whole
    // respawn path is gone rather than left unreachable.
    if (this.manager) return;

    if (!this.runtimeSetup) {
      const setup = this.createRuntime();
      const tracked = setup.finally(() => {
        if (this.runtimeSetup === tracked) this.runtimeSetup = null;
      });
      this.runtimeSetup = tracked;
    }
    await this.runtimeSetup;
  }

  /**
   * P2.437 — make the thrash guard's own sentence true.
   *
   * The guard already counts the refills, warns once durably and stamps the
   * turn's terminal reason, and its notice tells the user *"this turn stops
   * instead of looping"*. Nothing stopped it. The adapter observes the
   * notification stream and has no control channel by construction, so the
   * interrupt has to come from here.
   *
   * ## The decision, made deliberately because the runtimes now differ
   *
   * Pi's guard calls `session.setAutoCompactionEnabled(false)`, which makes the
   * NEXT overflow terminal. Codex gets `turn/interrupt`, which stops the CURRENT
   * turn. Two different levers, and the difference is not a preference — it is
   * forced by what each runtime does when the context refills:
   *
   * - **Pi's loop is self-limiting.** Its guard trips on an assistant
   *   `message_end` with `stopReason: 'error'`, i.e. the model has ALREADY
   *   failed and the turn has already ended. There is nothing to interrupt;
   *   the only useful action is about the next turn.
   * - **Codex's loop is not.** Codex compacts SERVER-SIDE and continues, and
   *   never surfaces the overflow error at all. The only observable is the
   *   compaction, in the past tense. So a codex thrash loop does not end on its
   *   own — it keeps compacting and keeps spending gateway tokens until the user
   *   presses Stop. Naming the ending is worth nothing when the ending never
   *   arrives.
   *
   * Read against the contract, both are the SAME behaviour:
   * `how-claude-code-works.md#when-context-fills-up` — *"Claude Code stops
   * auto-compacting after a few attempts and shows an error instead of
   * looping."* Each runtime reaches "instead of looping" with the only lever it
   * has, and both end on the shared `auto_compaction_thrashing` reason, so the
   * ending reads identically.
   *
   * ## The residue, which is real and is NOT closed here
   *
   * Pi's protection PERSISTS for the session; codex's does not. `turn/interrupt`
   * ends one turn, and codex's auto-compaction trigger is
   * `model_auto_compact_token_limit` in `config.toml`, which the app-server
   * reads only at START — so there is no mid-session equivalent of Pi's disable,
   * and a user who immediately re-sends the same oversized read gets a fresh
   * turn with a fresh count. That is a deliberate stop short of respawning the
   * app-server, which would drop the running thread; the guard's notice already
   * tells the user what to change, and it is the same notice on both runtimes.
   *
   * ## Once per turn, and `aborted` set for the same reason Stop sets it
   *
   * Once-ness lives in the adapter's `consumeAutoCompactionThrashTrip()`, which
   * hands out the trip EDGE exactly once. This method deliberately keeps no
   * "already interrupted" state of its own: the first version latched on the
   * turn id and re-interrupted the following turn, because the guard's reset
   * runs on `startTurn()` rather than on the `turn/started` notification. Two
   * pieces of state for one event is how they drift apart.
   *
   * `this.aborted` is set for exactly the reason {@link withStructuredOutput}
   * documents for Stop: the turn's text is cut off mid-flight, and reporting
   * that as `error_max_structured_output_retries` would tell the user their
   * schema could not be satisfied when what actually happened is that the host
   * stopped a runaway loop.
   */
  private stopThrashingTurn(): void {
    const turnId = this.activeTurnId;
    this.aborted = true;
    if (!this.client || !this.threadId || !turnId) {
      // An interrupt with no `turnId` is refused by definition — see `abort`'s
      // docblock. Say so rather than sending a request that cannot be served.
      this.debug('Codex auto-compaction thrashing — no active turn id, so nothing to interrupt');
      return;
    }
    this.debug(`Codex auto-compaction thrashing — interrupting turn ${turnId}`);
    // Detached: `handleNotification` is the transport's synchronous dispatch, so
    // there is nothing here to await into. The ORDER that matters is preserved
    // anyway — the request is written before this returns, and the sink is
    // settled by the `turn/completed` this interrupt provokes, which cannot
    // arrive first.
    void this.client.request('turn/interrupt', { threadId: this.threadId, turnId })
      .catch(() => { /* the turn may already have completed on its own */ });
  }

  /**
   * P2.436 — the project's standing `Compact Instructions`, projected onto
   * codex's own `compact_prompt`.
   *
   * ## Native-first, and here it is the ONLY lever
   *
   * codex compacts SERVER-SIDE. There is no host seam to inject a prompt at the
   * way Pi's compaction owner gives us, and no way to inspect the summary that
   * comes back. `compact_prompt` — pinned schema `.properties.compact_prompt`,
   * *"Compact prompt used for history compaction."* — is the whole mechanism,
   * and the config writer wrote neither it nor its
   * `experimental_compact_prompt_file` sibling until this row.
   *
   * ## P6.54's composer, reused rather than rewritten
   *
   * `composeProjectCompactSteering` already reads the `Compact Instructions`
   * section out of the instruction bodies the host composed, with the section
   * grammar, the `@path` expansion, the block-comment strip and the index caps
   * all applied once by their existing owner. Writing a second reader here would
   * fork that grammar; it carries the two filters this row must keep VERBATIM:
   *
   * - only `agent-instruction` resources, never memory or MCP-prompt content;
   * - **anything with an `mcp:` provenance is dropped.** Worse here than on Pi:
   *   codex compacts server-side, so a connected server steering what survives
   *   would do so where we cannot see the result at all.
   *
   * ## The residue, stated because it is invisible otherwise
   *
   * `config.piContextResources` was populated by the host for `provider === 'pi'`
   * ONLY (`SessionManager`) when this was written, so the sentence that stood
   * here said a codex session gets `undefined` and this returns `{}`. HEAD
   * refutes it — `SessionManager.ts:563-571` composes the field for codex too
   * and `codex-agent.ts:2599` consumes it — so codex no longer keeps only its
   * own default compaction prompt, exactly
   * as before. What is left of the residue is not the gate but the EMPTY case: a
   * session that composed no instruction resources at all still returns `{}`, and
   * the debug line below says which of the two states a session is actually in,
   * so nobody reads "no steering" as "steering is broken".
   */
  /**
   * P3.369 — the user's added directories, made WRITABLE for the codex child.
   *
   * ## The gap, and the qualification that no longer holds
   *
   * `getConfiguredAdditionalDirectories` has five readers and this file was
   * none of them: the host gate says yes to a path under an added root and the
   * subprocess is never told, so a tool call the gate permitted fails inside the
   * sandbox. The filed qualification — *"with the sandbox off it emits
   * danger-full-access, so the roots are moot"* — is false since P3.315/P3.327:
   * the Profiles syntax wins, the credential floor is unconditional, and a
   * `:workspace`-extending profile is emitted for every real session. An added
   * directory outside the workspace is therefore unwritable today with no
   * operator action available.
   *
   * ## The mechanism, and why it is NOT the one the row proposed
   *
   * `sandbox_workspace_write.writable_roots` is the LEGACY-syntax table. What
   * this writer already emits, and what P3.315 measured winning, is the
   * profile's own `filesystem: { <abs path>: 'write' }` map — which is exactly
   * what {@link CodexConfigOptions.writablePaths} feeds. So the wiring is a
   * caller change, not a new key.
   *
   * ## The three fail shapes naive wiring introduces, each closed here
   *
   * `normalizeRuntimePaths` THROWS on a filesystem root
   * (`codex-writable-path-too-broad`) and `resolveCodexRuntimePathPolicy` throws
   * when a writable path is also a denied one
   * (`codex-runtime-path-policy-conflict`). Today the roots are ignored, so
   * neither can fire; after the wiring either would kill the session at spawn
   * for a setting the user typed. Both are filtered here, with a diagnostic, so
   * a bad entry costs the entry rather than the session.
   *
   * The third is the one worth reading twice, because it is a WIDENING rather
   * than a crash: `mapDeniedPathsToCodexFilesystemKeys` drops a credential-floor
   * deny key that collides EXACTLY with a grant (`conflicts-with-grant`), since
   * `deny` beats `write` on codex's side and emitting both would revoke a grant
   * the host asked for. That precedence is right for the host's own plugin data
   * paths; it is wrong for a path a USER typed into a settings field, because it
   * would let `additionalDirectories: ["~/.ssh"]` silently remove a floor entry.
   * So for THIS family the floor wins and the grant is dropped, named on the
   * diagnostic channel. The two families keep different precedence on purpose,
   * and that is the difference between a host decision and a user one.
   */
  /**
   * P3.335 — mint the tool-call hook events on codex, from the stream the
   * transcript is already built from.
   *
   * ## What was wrong
   *
   * `codex-agent.ts` had FOUR `emitAutomationEvent` sites — SessionStart,
   * UserPromptSubmit, Stop, SessionEnd — and `runtime-hook-events.ts` marked
   * PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest and
   * PermissionDenied `unwired`: the occurrence EXISTS on codex and nothing
   * minted it. A plugin whose hooks were installed and reported enabled did
   * nothing on this runtime, silently — the shape P6.13's warning is meant to
   * catch, except that a cell reading `unwired` is exactly what that warning
   * reads as "nothing to call".
   *
   * ## Native-first was asked and CLOSED by an owner ruling, not by absence
   *
   * codex HAS `[hooks]` and `buildCodexHooksToml` exists. The owner closed that
   * route on 2026-08-29: *"a user- or plugin-authored one would hand codex
   * something to execute that we neither wrote nor can revoke"*. So step 1 is
   * recorded as refused-by-policy rather than missing, and the host supplies it.
   *
   * ## Why THIS seam
   *
   * The occurrence is already parsed: `backend/codex/event-adapter.ts` maps the command, file-change, MCP,
   * collab and web-search (F1.623) items and the plan update through `createToolStart`/`createToolResult` with name, input,
   * output and an `isError`. Minting from the adapter's own event stream rather
   * than from a second parse of the notification means the hook and the
   * transcript can never disagree about what ran — and the payload is Pi's,
   * field for field, so ONE hook body behaves the same on both.
   *
   * ## THREE RESIDUES, stated rather than papered over
   *
   *  1. `updatedToolOutput` is UNACHIEVABLE here. Pi rewrites a tool result
   *     before the model sees it; on codex the item is already committed by the
   *     time `item/completed` arrives. A hook that returns one is told so on the
   *     debug channel rather than being silently ignored.
   *  2. A top-level `decision: "block"` feeds `reason` back to the model on Pi
   *     through the tool result. Same reason: there is no result left to append
   *     to. Also reported, never silently dropped.
   *  3. PreToolUse, PermissionRequest and PermissionDenied are NOT minted here
   *     and remain `unwired`. They are a different question, not a smaller one:
   *     PreToolUse's whole contract is that it can DENY, and on codex the only
   *     place a call can still be stopped is the approval bridge — which codex
   *     does not raise under `dangerFullAccess` or auto-approval. Minting a
   *     report-only PreToolUse would move its cell to `emitted` while its deny
   *     enforced nothing, which is a worse lie than the silence it replaces.
   */
  private noteCodexToolCallForHooks(event: AgentEvent): void {
    if (event.type === 'tool_start') {
      const id = event.toolUseId
      if (typeof id === 'string' && id) {
        this.codexToolCallInputs.set(id, {
          toolName: event.toolName,
          input: (event.input ?? {}) as Record<string, unknown>,
        })
      }
      return
    }
    if (event.type !== 'tool_result') return
    const id = typeof event.toolUseId === 'string' ? event.toolUseId : ''
    const started = id ? this.codexToolCallInputs.get(id) : undefined
    if (id) this.codexToolCallInputs.delete(id)
    const toolName = started?.toolName ?? event.toolName
    if (!toolName) return
    const isError = event.isError === true
    const eventName = isError ? 'PostToolUseFailure' : 'PostToolUse'
    // Detached, like Pi's `emitAutomationEventDetached`: this runs inside the
    // synchronous notification handler that feeds the transcript, and a hook
    // must never hold a frame. A rejection is reported, never thrown.
    void this.emitAutomationEvent(eventName, {
      hook_event_name: eventName,
      tool_name: hostMcpToolNameForCodexRow(toolName), // F1.274 — Pi's name, so a host-spelled matcher fires
      tool_input: started?.input ?? {},
      ...(isError ? { error: event.result } : { tool_response: event.result }),
    }).then(result => {
      // C3.361 · a hook's user-facing output on the tool-call events too, not
      // only on the four lifecycle ones.
      this.surfaceHookUserFacingOutput(eventName, result)
      const decision = result?.decision
      if (decision?.updatedToolOutput !== undefined) {
        this.debug(
          `[hooks] ${eventName} returned updatedToolOutput for ${toolName}, which codex cannot honour: `
          + 'the item is already committed when `item/completed` arrives, so the model has seen the original',
        )
      }
      if (decision?.decision === 'block') {
        this.debug(
          `[hooks] ${eventName} returned decision "block" for ${toolName}; on codex there is no tool `
          + 'result left to append the reason to, so it reaches the model on neither channel',
        )
      }
    }).catch(error => {
      this.debug(`[hooks] ${eventName} failed for ${toolName}: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /**
   * D1.342 — what a codex turn has SEEN, credited into the read-before-write
   * ledger, from codex's OWN classification of its own command.
   *
   * ## Measured first, 2026-09-18, and the native mechanism was already there
   *
   * A real turn was driven against the staged `codex-app-server`
   * (darwin-arm64) over the loopback stub adapter on a fake key, in an isolated
   * `CODEX_HOME` and a temp workspace. Codex has no dedicated read tool, so a
   * read is a shell command — and the shape it arrives in is not the model's:
   * `cat target.txt` reaches this host as a `commandExecution` item whose
   * `command` is `"/bin/zsh -lc 'cat target.txt'"`, which the shared
   * {@link bareFileViewerOperand} cannot read (it requires two tokens). A
   * ledger built on that `command` string alone would therefore credit NOTHING
   * and refuse every write — the failure D1.332 declined to ship. (D1.350: the
   * `tool_start` frame now carries `commandActions` beside that string, so the
   * sentence is about the COMMAND and no longer about the frame.)
   *
   * The item carries the answer itself. `ThreadItem`'s `commandExecution`
   * variant has `commandActions: Array<CommandAction>`, documented in the
   * generated protocol as *"A best-effort parsing of the command to understand
   * the action(s) it will perform. This returns a list of CommandAction objects
   * because a single shell command may be composed of many commands piped
   * together."*, and `CommandAction` is
   * `{type:'read', command, name, path} | {type:'listFiles'…} |
   * {type:'search'…} | {type:'unknown'…}`. Measured over seven commands in
   * seven turns, it is accurate AND it hands back the UNWRAPPED command plus an
   * ABSOLUTE path it resolved itself:
   *
   * | command the model sent | `commandActions` |
   * | --- | --- |
   * | `cat target.txt` | one `read`, `command: "cat target.txt"`, absolute `path` |
   * | `cat ./target.txt` | one `read`, absolute `path` — codex resolves it |
   * | `nl target.txt` | one `read` |
   * | `head -n 1 target.txt` | one `read` — a PARTIAL read it still calls `read` |
   * | `tail -n 1 target.txt` | one `read` — partial |
   * | `sed -n 1,1p target.txt` | one `read` — partial |
   * | `grep sable target.txt` | one **`search`** (the control: it discriminates) |
   * | `cat a.txt b.txt` | one **`unknown`** (the second control) |
   * | `cat target.txt \| grep sable` | **two** actions, `read` + `search` |
   * | `cat target.txt && echo done` | one **`unknown`** |
   *
   * ## So codex names the FILE and this host decides whether it was SEEN
   *
   * `type: 'read'` answers *"which file did this command touch"*, not *"did the
   * conversation see the whole of it"* — `head -n 1` and `sed -n '1,1p'` are
   * both `read`. Crediting those would mark a file seen whose middle nobody
   * looked at, the permissive-direction error {@link bareFileViewerOperand}'s
   * docblock exists to refuse, and it would make codex looser than Pi on the
   * same command. So the action's own unwrapped `command` is passed to that
   * shared predicate and only its four whole-file viewers credit: the credited
   * SET is identical on all three runtimes, which is the whole point of
   * `core/read-before-write.ts`, and codex contributes the two things the host
   * cannot get right by itself — the unwrap and the absolute path.
   *
   * **Exactly one action**, because two means a pipe or a chain: `cat f | grep x`
   * shows only the matching lines while its first action is a clean `read` of
   * `f`. That is the same judgement `bareFileViewerOperand` makes by refusing
   * any command carrying a metacharacter, applied where the metacharacter is no
   * longer visible.
   *
   * ## POST-hoc on exit 0, which is Pi's rule and better than claude's
   *
   * Pi credits a viewer AFTER the command, on exit code 0; claude's PreToolUse
   * hook runs before it and can only ask whether the file exists. Codex reports
   * `exitCode` on `item/completed`, so the accurate condition is free here —
   * and it is not theoretical: the measured `bat target.txt` run answered a
   * `read` action with **exit 127** (no `bat` on the rig) and `cat missing.txt`
   * answered a `read` action with exit 1. Neither showed anybody anything.
   *
   * ## An APPLIED patch credits its own paths
   *
   * Pi's decision 2 — *"a file this session WROTE counts as seen"* — is what
   * keeps a second patch of a file codex just rewrote from being refused. The
   * gate is codex's own `PatchApplyStatus`: measured `"completed"` when the
   * patch landed and `"declined"` when the approval was refused, so a declined
   * patch credits nothing. The paths come from {@link codexFileChangePaths},
   * not a second extractor, so the credit and the approval card cannot disagree
   * about which files a patch touched.
   */
  private creditCodexFileRead(item: unknown): void {
    if (!isPlainRecord(item)) return;
    if (item.type === 'fileChange') {
      if (item.status !== 'completed') return;
      for (const path of codexFileChangePaths(item, this.workingDirectory)) {
        this.readBeforeWriteLedger.add(path);
      }
      return;
    }
    if (item.type !== 'commandExecution' || item.exitCode !== 0) return;
    // D1.350 · through the adapter's own parser rather than a second inline
    // narrowing of the same field. `readCodexCommandActions` is the ONE reader
    // of `commandActions`, and `CodexEventAdapter` publishes its result on the
    // `tool_start` frame, so the transcript's account of a command and this
    // ledger's cannot disagree about what codex said the command was. See that
    // function's docblock for why it is a shared function and not a read of the
    // emitted frame.
    const actions = readCodexCommandActions(item);
    if (actions.length !== 1) return;
    const action = actions[0]!;
    if (action.type !== 'read') return;
    const command = action.command;
    if (!command || !bareFileViewerOperand(command)) return;
    const raw = typeof action.path === 'string' ? action.path : '';
    if (!raw) return;
    const base = typeof item.cwd === 'string' && item.cwd ? item.cwd : this.workingDirectory;
    this.readBeforeWriteLedger.add(isAbsolute(raw) ? raw : resolvePath(base, raw));
  }

  /**
   * C3.13 (QA6, owner answer A, 2026-09-11; ledger A24) — a codex session's
   * delegated agent returns its report UNSCANNED, and the user is told once.
   *
   * ## Why there is nothing to build instead
   *
   * A24 is refused by STRUCTURE, not by effort: codex's spawned agent thread
   * returns to the parent INSIDE the app-server, so no host code sits on that
   * path and there is no artifact to splice a scan into. The other two runtimes
   * both have it — Pi through `scanSubagentOutput` +
   * `subagentReportMarkerLine` in `pi-agent-server`'s `orchestrator/subagent-tool.ts`,
   * claude through the SDK's own subagent output scanning — and the switch
   * report already prices the loss on both legs INTO codex
   * (`runtime-switch-costs.ts`, `subagentReportScan`). What was missing is the
   * statement to the user who never switches runtimes and therefore never sees
   * that dialog.
   *
   * ## Why it fires on the SPAWN and not at session start
   *
   * Codex's delegation tools are live on every session we start
   * (`AgentsToml.enabled` defaults true and this host writes
   * `[features] multi_agent = true`), so a session-start notice would be
   * unconditional — a sentence every codex session opens with, about something
   * most of them never do. The item stream names the tool, so the honest trigger
   * is the first delegation actually happening. ONCE per agent: the point is one
   * statement per session, not one per spawn, exactly as
   * {@link noteUnreadCodexNotification} is scoped.
   *
   * The tool NAMES are codex's own multi-agent set, matched on the name the
   * adapter already publishes (the same spelling `stub-tool-namespace.test.ts`
   * pins). `resume_agent` is in the set because it re-opens a report path, and
   * `wait_agent`/`close_agent` are not because they cannot be reached without a
   * spawn that already fired this.
   */
  private noteCodexSubagentReportResidue(event: AgentEvent): void {
    if (this.subagentReportResidueNoted) return;
    if (event.type !== 'tool_start') return;
    const toolName = typeof event.toolName === 'string' ? event.toolName : '';
    if (toolName !== 'spawn_agent' && toolName !== 'resume_agent') return;
    this.subagentReportResidueNoted = true;
    const notice = 'Codex is delegating to its own agent. Its report comes back to this conversation '
      + 'UNSCANNED: the spawned thread returns to the parent inside the codex app-server, so Nessy has '
      + 'no place on that path to defang instruction-shaped text or a forged transcript marker. Subagent '
      + 'output scanning is available on Claude and Pi only. Treat a delegated agent\'s report as '
      + 'untrusted text, the same way you would treat a web page it fetched.';
    this.debug(notice);
    this.surfaceCodexOperatorNotice(notice);
  }

  /**
   * P6.118 · `StopFailure` — the failed-turn hook, minted HOST-side from codex's
   * `ErrorNotification`.
   *
   * ## Why host-side at all
   *
   * `stopFailure` is NOT one of codex's eleven `HookEventName` values
   * (`packages/codex-protocol/generated/v2/HookEventName.ts`: `preToolUse`,
   * `permissionRequest`, `postToolUse`, `preCompact`, `postCompact`,
   * `sessionStart`, `sessionEnd`, `userPromptSubmit`, `subagentStart`,
   * `subagentStop`, `stop`) — it is our vocabulary. The MOMENT exists there all
   * the same: `ErrorNotification { error, willRetry, threadId, turnId }`. And
   * even for the events codex does name, the native `[hooks]` route is closed by
   * the owner's 2026-08-29 ruling for anything the host did not author, which is
   * what left P3.335 minting the POST events from the item stream. Same seam,
   * same reason.
   *
   * ## The payload is Pi's, with the one projection named
   *
   * `error` / `error_code` / `error_details` / `last_assistant_message` are Pi's
   * four fields in Pi's order. `error` is the documented ten-value vocabulary,
   * projected from codex's own `CodexErrorInfo` by
   * {@link CODEX_ERROR_INFO_TO_DOCUMENTED_STOP_FAILURE}; `error_code` carries
   * the RAW codex code, which is what the matcher reads first, so a
   * codex-specific matcher stays reachable exactly as Pi's Nessy-specific ones
   * do. `last_assistant_message` is the error TEXT and not the model's output —
   * hooks.md's own exception for this event ("Unlike `Stop` and `SubagentStop` …
   * it contains the API error string itself").
   *
   * The bounds are Pi's too: 64 chars for the code, 1024 for the free text.
   */
  private emitCodexStopFailureHookOnce(error: unknown, renderedText: string): void {
    if (this.stopFailureHookEmittedForTurn) return;
    this.stopFailureHookEmittedForTurn = true;
    const turnError = (error && typeof error === 'object' ? error : {}) as {
      message?: unknown;
      codexErrorInfo?: unknown;
      additionalDetails?: unknown;
    };
    const code = readCodexErrorInfoCode(turnError.codexErrorInfo) ?? 'other';
    const details = typeof turnError.additionalDetails === 'string' ? turnError.additionalDetails : undefined;
    const message = typeof turnError.message === 'string' && turnError.message ? turnError.message : renderedText;
    void this.emitAutomationEvent('StopFailure', {
      hook_event_name: 'StopFailure',
      lifecycle_version: 1,
      error: CODEX_ERROR_INFO_TO_DOCUMENTED_STOP_FAILURE[code] ?? 'unknown',
      error_code: code.slice(0, 64),
      ...(details ? { error_details: details.slice(0, 1024) } : {}),
      ...(message ? { last_assistant_message: message.slice(0, 1024) } : {}),
    }).then(result => {
      // C3.361 · `systemMessage` / `stopReason` reach the user here too.
      this.surfaceHookUserFacingOutput('StopFailure', result);
    }).catch(error_ => {
      this.debug(`[hooks] StopFailure failed: ${error_ instanceof Error ? error_.message : String(error_)}`);
    });
  }

  /**
   * P6.118 · `PostCompact` — minted from the compaction the adapter just
   * announced.
   *
   * ## The payload, field for field with Pi's
   *
   * Pi's emitter is the lifecycle bridge's `pi.on('session_compact')`:
   * `{ hook_event_name, trigger, compact_summary, source }`, no
   * `lifecycle_version`. Each field, and what codex can answer:
   *
   * - `trigger` — the documented matcher value, `manual` for `/compact` and
   *   `auto` for the context-window path. Known here because this fork issues
   *   the only manual compaction there is ({@link manualCompactionRequestedForTurn}).
   * - `compact_summary` — hooks.md:2810's "summary the compact operation
   *   generated". Codex publishes NONE: the item is
   *   `{ "type": "contextCompaction", id: string }` in `ThreadItem.ts` and the
   *   deprecated notification is `{ threadId, turnId }`, so there is no summary
   *   on either channel. It is emitted as `''` — Pi's own value when its
   *   compaction entry carries no summary, so a hook reading the field meets the
   *   same type on both runtimes rather than an absent key on one.
   * - `source` — Pi's raw compaction reason. Codex sends no reason, so this
   *   carries `manual` when we asked and Pi's own no-reason fallback `compact`
   *   otherwise.
   *
   * `PreCompact` stays `unwired` and is NOT minted beside this: the adapter's own
   * docblock records that codex reports compaction only in the past tense and
   * there is no start notification at all, so there is no moment to hang it on —
   * an absence to state, not a gap to fill.
   */
  private emitCodexPostCompactHook(): void {
    const manual = this.manualCompactionRequestedForTurn;
    this.manualCompactionRequestedForTurn = false;
    void this.emitAutomationEvent('PostCompact', {
      hook_event_name: 'PostCompact',
      trigger: manual ? 'manual' : 'auto',
      compact_summary: '',
      source: manual ? 'manual' : 'compact',
    }).then(result => {
      // C3.361 · see {@link surfaceHookUserFacingOutput}.
      this.surfaceHookUserFacingOutput('PostCompact', result);
    }).catch(error => {
      this.debug(`[hooks] PostCompact failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /**
   * P6.579 · `PermissionDenied` — minted host-side, on the two moments Pi mints
   * it on.
   *
   * ## Why this one and not its two parked neighbours
   *
   * `PreToolUse` and `PermissionRequest` stay `unwired` on codex for the reason
   * P3.335 recorded: a host emission there would report a decision it cannot
   * enforce, because codex has already resolved the call by the time the item
   * stream carries it. That reason does not apply to a REPORT of a denial that
   * has already happened — the denial is ours, it is final, and the only thing
   * missing was the event saying so. `PermissionDenied` is our own vocabulary
   * (codex's eleven `HookEventName` values have no counterpart, so
   * {@link codexNativeHookEvent} answers `undefined`), which is why this is a
   * host mint and not a `[hooks]` entry.
   *
   * ## Which denials, and why not every one
   *
   * Pi's eligibility is `guardianDenied || dont_ask_would_prompt` — explicitly
   * "never for floors or ordinary gate blocks" (`pi-agent.ts`). A hook body
   * written against Pi must therefore see the same two causes here, or a switch
   * onto codex changes how often it runs. The two analogues:
   *
   * - the `dontAsk` denial of an action that would otherwise have raised a card
   *   — the same cause, spelled on codex's answer path;
   * - codex's own auto-review denial (`item/autoApprovalReview/completed` with
   *   `review.status === 'denied'`), which is the judge Pi calls the guardian.
   *
   * A floor refusal, a `deniedPaths` refusal and a user `deny` RULE are all
   * silent here exactly as they are on Pi.
   *
   * ## The one residue, stated rather than implied
   *
   * Pi honours the documented `{retry: true}` output by re-running the
   * permission decision. Codex cannot: our answer is the return value of a
   * synchronous request/response, and the auto-review verdict arrives as a
   * notification with nothing left to re-decide. So this fires and forgets, and
   * a `{retry: true}` a hook returns on codex changes nothing — which is the
   * honest half of "the column reads `emitted`".
   */
  private emitCodexPermissionDeniedHook(
    toolName: string,
    toolInput: Record<string, unknown>,
    reason: string,
  ): void {
    void this.emitAutomationEvent('PermissionDenied', {
      hook_event_name: 'PermissionDenied',
      tool_name: hostMcpToolNameForCodexRow(toolName), // F1.274 — the same shift as PostToolUse
      tool_input: toolInput,
      permission_mode: this.getPermissionMode(),
      ...(reason ? { error: reason } : {}),
    }).then(result => {
      // C3.361 · see {@link surfaceHookUserFacingOutput}.
      this.surfaceHookUserFacingOutput('PermissionDenied', result);
    }).catch(error => {
      this.debug(`[hooks] PermissionDenied failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /**
   * The tool name for an auto-review verdict's `action`, in the SAME vocabulary
   * the approval cards use (an MCP call: the host's `mcp__<wire>__<tool>`, F1.382) — `shell` from {@link mapCommandApprovalToRequest},
   * `ApplyPatch` from {@link mapFileChangeApprovalToRequest},
   * `request_permissions` from the permissions mapper — so one matcher pattern
   * covers a denial whichever of the two channels produced it.
   *
   * Falls back to the bare `type`, and to `shell` when there is no readable
   * action at all: a hook matching on a name is better served by codex's own
   * word for the variant than by an empty string.
   */
  private static codexReviewActionToolName(action: unknown): string {
    const type = action && typeof action === 'object'
      ? (action as { type?: unknown }).type
      : undefined;
    switch (typeof type === 'string' ? type : '') {
      case 'command':
      case 'execve':
      case 'networkAccess':
        return 'shell';
      case 'applyPatch':
        return 'ApplyPatch';
      case 'requestPermissions':
        return 'request_permissions';
      case 'mcpToolCall': {
        const record = action as { server?: unknown; toolName?: unknown; toolTitle?: unknown };
        const tool = typeof record.toolName === 'string' && record.toolName ? record.toolName : '';
        // F1.382 — with the server known, the HOST's name (Pi's guardian sends `mcp__<wire>__<tool>`).
        if (tool && typeof record.server === 'string' && record.server) return hostMcpToolNameForCodexRow(`mcp__${record.server}__${tool}`);
        return tool || (typeof record.toolTitle === 'string' && record.toolTitle ? record.toolTitle : '') || 'MCP server';
      }
      default:
        return typeof type === 'string' && type ? type : 'shell';
    }
  }

  private codexAdditionalWritableRoots(): string[] {
    const configured = getConfiguredAdditionalDirectories()
    if (configured.length === 0) return []
    // Derived with NO grants, so this is the floor as it would be emitted before
    // any of these roots is considered — the set a grant must not silently
    // remove.
    const floorKeys = new Set(
      mapDeniedPathsToCodexFilesystemKeys(this.credentialFloorPatterns(), []).keys,
    )
    const deniedReadPaths = new Set(codexConfigDirProjection('', CONFIG_DIR, undefined, [CONFIG_DIR]).deny) // F1.664 (read-only since F1.678): a grant on that key would conflict; F1.1057 — no credentials.enc deny any more
    const accepted: string[] = []
    for (const root of configured) {
      const absolute = resolvePath(root)
      if (absolute === parsePath(absolute).root) {
        this.debug(
          `[additionalDirectories] "${root}" is a filesystem root and is not granted to codex: `
          + 'codex refuses a permission entry that broad, and emitting it would fail the whole session',
        )
        continue
      }
      const insideDataFolder = codexAddedRootInsideConfigDir(root, absolute) // F1.693 — see the helper at the file end
      if (insideDataFolder || deniedReadPaths.has(absolute)) {
        this.debug(insideDataFolder ?? `[additionalDirectories] "${root}" is also a denied-read path and is not granted to codex: `
          + 'the two would conflict and codex would reject the config',
        )
        continue
      }
      if (floorKeys.has(absolute) || floorKeys.has(absolute.replace(latchedHomeDir(), '~'))) {
        this.debug(
          `[additionalDirectories] "${root}" is covered by the credential floor and is not granted `
          + 'to codex: granting it would remove the floor entry rather than widen it',
        )
        continue
      }
      accepted.push(absolute)
    }
    if (accepted.length > 0) {
      this.debug(`[additionalDirectories] granting codex write access to ${accepted.length} added root(s): ${accepted.join(', ')}`)
    }
    return accepted
  } /** F1.1003 — {@link codexAdditionalWritableRoots} plus, in plan and explore, this session's plans and data folders: {@link codexModeWritablePaths}. */
  private codexWritablePaths(): string[] { return codexModeWritablePaths(this.getPermissionMode(), this.codexAdditionalWritableRoots(), { cwd: this.workingDirectory, workspace: this.config.workspace, sessionId: this._sessionId, denied: () => this.codexReadOnlyPaths(), floor: () => this.credentialFloorPatterns(), protectedSubpaths: () => this.codexProtectedWorkspaceSubpaths() }, message => this.debug(message)) }
  /**
   * C3.343 — the host's protected-path floor, handed to codex in codex's own
   * `":workspace_roots"` vocabulary.
   *
   * ## Why the list travels instead of the decision
   *
   * `protectedPathOutcome` (`pi-harness/protected-paths.ts`) is reached from
   * `core/pre-tool-use.ts`, and the codex path has no `runPreToolUseChecks` — so
   * on codex that floor decided nothing, and RS-13 measured the consequence on
   * the packaged 1.36.0: a `<cwd>/.git/` write landing with no card where Pi and
   * claude raise one. Native-first says ask what codex already has before
   * building beside it, and codex has exactly this: a per-path
   * `FileSystemAccessMode` in the profile this runtime already writes. So the
   * HOST'S OWN LIST is projected onto codex's own mechanism rather than a second
   * gate being grown on the notification path (which could not gate anything —
   * see {@link CodexAgent.checkpointCodexFileChange} for why `item/started` is a
   * race and not a seam).
   *
   * `PROTECTED_DIRECTORIES` and not the protected FILES: the directories are the
   * class RS-13 measured and the class codex's own defaults already cover three
   * names of, and `read` on codex is a REFUSAL where the host floor prompts, so
   * widening it to 36 file names — `.npmrc`, `bunfig.toml`, every shell rc — is a
   * product posture that belongs to the owner and not to this method. Recorded as
   * a residue rather than taken silently.
   *
   * ## The one filter, and why it is here rather than in the writer
   *
   * A user who added `<workspace>/.vscode` through `additionalDirectories` asked
   * for it to be writable; emitting `read` for the same path would revoke a grant
   * the host had already said yes to, and the writer cannot see the collision
   * because a `":workspace_roots"` subpath is relative and the grants are
   * absolute. This method has both, so it drops the protected entry and says so.
   */
  private codexProtectedWorkspaceSubpaths(): string[] {
    const workspace = this.workingDirectory
    const granted = this.codexAdditionalWritableRoots()
    const kept: string[] = []
    for (const entry of [...PROTECTED_DIRECTORIES, ...codexWorkspaceRecordSubpaths(workspace, this.config.workspace.workspaceRootPath)]) {
      const absolute = resolvePath(workspace, entry)
      const collision = granted.find(root => root === absolute || root.startsWith(`${absolute}/`))
      if (collision) {
        this.debug(
          `[protectedPaths] "${entry}" is not projected onto codex for this session: `
          + `"${collision}" is an added writable directory at or below it, and emitting the floor `
          + 'would revoke a grant the host already made',
        )
        continue
      }
      kept.push(entry)
    }
    return [...kept, ...this.configDirProjection().subpaths] // F1.664
  }

  /**
   * P3.347 — the two subagent ceilings, forwarded to codex's `[agents]` table,
   * and ONLY the value an operator set explicitly.
   *
   * ## What was broken
   *
   * `NESSY_MAX_SUBAGENT_SPAWN_DEPTH` and `NESSY_MAX_CONCURRENT_SUBAGENTS` are
   * applied by `applySubagentSpawnDepth` / `applyConcurrentSubagentCeiling`,
   * which are called from `buildClaudeSubprocessEnv` and nowhere else — so they
   * bind on Pi and claude and vanished here, with no diagnostic. One knob, three
   * runtimes, one of them deaf.
   *
   * ## Why the explicit value only, and never the resolved one
   *
   * P6.16's refutation, and it bites hardest here.
   * {@link maxConcurrentSubagents} narrows the documented 20 by installed RAM,
   * because on Pi and claude a subagent is another AGENT RUNTIME — roughly a
   * gibibyte of subprocess. A codex subagent is a THREAD inside the app-server
   * child that already exists, so the memory bound describes a cost codex does
   * not pay, and forwarding it would impose our machine's limit on a runtime it
   * was never measured against. `declaredMaxConcurrentSubagents` is the reader
   * that answers "did the operator say a number", which is the only number that
   * belongs on the wire.
   *
   * The depth pair has no such reader in `subagent-spawn-depth.ts`
   * (`resolveMaxSubagentSpawnDepth` falls back to the documented default), so
   * the presence test is spelled here and the VALUE still comes from the shared
   * resolver — the parse contract and the fallback stay in one place. Adding a
   * `declaredMaxSubagentSpawnDepth` beside its sibling is strictly better and is
   * a change to a file this lane does not hold; reported as a hand-off.
   *
   * ## The residue, which is a real per-runtime difference
   *
   * With neither knob set, codex uses its OWN defaults —
   * `DEFAULT_AGENT_MAX_THREADS = Some(6)` and `DEFAULT_AGENT_MAX_DEPTH = 1`
   * (`core/src/config/mod.rs`, `rust-v0.150.1`) — against the host's documented
   * 20 and 3. So an unconfigured codex session nests one level where an
   * unconfigured Pi session nests three. Aligning the DEFAULTS would mean
   * writing our numbers for every user who asked for nothing, which is a
   * product posture rather than a knob repair; it is stated here and left to the
   * owner.
   */
  /**
   * P6.368 — the operator's plan-phase effort, or `undefined`.
   *
   * `NESSY_PLAN_MODE_EFFORT`, and the name is OURS: `env-vars.md` documents no
   * plan-mode effort variable and the shipped 2.1.247 binary scores 0 for
   * `CLAUDE_CODE_PLAN_MODE_EFFORT` and 0 for `PLAN_MODE_EFFORT` — re-measured
   * 2026-09-12 (C3.252), 0 lines / 0 occurrences each, control
   * `CLAUDE_CODE_EFFORT_LEVEL` -> 10/19 (it read 17 at 2.1.233 with no
   * instrument named; C3.294). Claude's plan-mode lever is a MODEL alias
   * (`opusplan`), not an effort, so there is nothing to be compatible with and no
   * compat spelling is offered — a `CLAUDE_CODE_` name we made up would claim a
   * contract that does not exist.
   *
   * Unset, or set to anything that is not one of the six level words, answers
   * `undefined` and the key is omitted: codex then keeps its own plan-mode
   * behaviour. Deliberately NOT falling back to the session's execution effort,
   * which would emit this session's own level under a second name — a no-op
   * dressed as a setting.
   */
  private planModeThinkingLevel(): ThinkingLevel | undefined {
    const raw = process.env[CODEX_PLAN_MODE_EFFORT_ENV_VAR];
    if (raw === undefined) return undefined;
    const level = normalizeThinkingLevel(raw.trim());
    if (!level) {
      this.debug(
        `${CODEX_PLAN_MODE_EFFORT_ENV_VAR}="${raw}" is not one of the levels this setting accepts; `
        + 'codex keeps its own plan-mode behaviour',
      );
      return undefined;
    }
    return level;
  }

  /**
   * P6.273's codex READ half — the operator's retry ceiling and streaming idle
   * deadline, resolved where every other `CodexConfigOptions` value is.
   *
   * The emit side landed first (`config-writer.ts`'s `providerMaxRetries` /
   * `providerStreamIdleTimeoutMs` -> `request_max_retries`,
   * `stream_max_retries`, `stream_idle_timeout_ms` on `[model_providers.*]`,
   * read from the vendored `config-schema.json` generated from
   * `codex-rs/model-provider-info/src/lib.rs` at `rust-v0.150.1` — P7.11, the
   * path cited here before 404s at every tag this repo has shipped), and until
   * this hunk
   * it was unreached — `api-retry-env.ts`'s own "WHO READS WHAT" note says so
   * in as many words, so that the exported-and-uncalled reader could not be
   * mistaken for the parse-never-read defect this plan hunts. This is the call
   * that note was waiting for.
   *
   * EXPLICIT-ONLY, like every ceiling in this family: unset, both keys are
   * omitted entirely and codex keeps its own defaults byte for byte, which is
   * the control the row's `done_means` names.
   *
   * A malformed value is REFUSED BY NAME rather than silently defaulted — the
   * other half of that same `done_means` — and the refusal is routed to
   * `this.debug`, the channel the sibling ceilings use, so the operator reads
   * it in the same place. `resolveMaxApiRetries` owns the sentence; nothing is
   * re-worded here, because two spellings of one rejection is how the two drift.
   *
   * ONE host value feeds BOTH of codex's retry counters, and that is the
   * writer's decision recorded at `providerMaxRetries`: the operator's question
   * is "how many times may a turn try again", and splitting it into two names on
   * codex alone would be a divergence Pi and claude have no answer for.
   */
  private codexProviderRetryOptions(): {
    providerMaxRetries?: number;
    providerStreamIdleTimeoutMs?: number;
  } {
    const env = process.env
    const write = (message: string) => this.debug(`[retry] ${message}`)
    const options: { providerMaxRetries?: number; providerStreamIdleTimeoutMs?: number } = {}

    const maxRetries = resolveMaxApiRetries(env, write)
    if (maxRetries !== undefined) options.providerMaxRetries = maxRetries

    const idleMs = resolveStreamIdleTimeoutMs(env, write)
    if (idleMs !== undefined) options.providerStreamIdleTimeoutMs = idleMs

    return options
  }

  private codexSubagentCeilingOptions(): {
    maxConcurrentSubagentThreads?: number;
    maxSubagentSpawnDepth?: number;
  } {
    const env = process.env
    const options: { maxConcurrentSubagentThreads?: number; maxSubagentSpawnDepth?: number } = {}

    const concurrency = declaredMaxConcurrentSubagents(env)
    if (concurrency !== undefined) options.maxConcurrentSubagentThreads = concurrency

    // P6.486 · THE DEPTH IS WRITTEN ALWAYS; THE THREAD COUNT IS NOT. Owner
    // decision 2026-09-05, Q18 option (c), and the asymmetry is the decision.
    //
    // Codex's own unset defaults are `DEFAULT_AGENT_MAX_DEPTH = 1` and
    // `DEFAULT_AGENT_MAX_THREADS = Some(6)` (source, rust-v0.148.0, recorded at
    // `config-writer.ts`'s `maxConcurrentSubagentThreads`). So an unconfigured
    // codex session nested ONE subagent level where an unconfigured Pi or claude
    // session nests three — a three-level workflow that works before a switch
    // simply stops working after it, with nothing said.
    //
    // Why depth and not both:
    //
    //  - **Depth has a user-visible failure and thread count does not.** A
    //    nesting workflow either runs or it does not; a lower concurrency
    //    ceiling makes the same work slower, which is a resource choice rather
    //    than a capability loss.
    //  - **6 is a plausible resource choice the host's 20 does not price.** Our
    //    concurrency ceiling is derived for a Pi SUBPROCESS at roughly a
    //    gibibyte each (`config/subagent-limits.ts`); a codex subagent is a
    //    THREAD inside the existing child, so neither number describes the
    //    other's cost. Writing ours would be P6.16's refuted move with the sign
    //    flipped.
    //
    // `resolveMaxSubagentSpawnDepth` already answers "the operator's value, or
    // the documented default 3", including the fallbacks for a malformed value
    // and for `0` — so an explicit operator value still wins and this is one
    // call rather than a second precedence rule beside it.
    options.maxSubagentSpawnDepth = resolveMaxSubagentSpawnDepth(env)
    const depthIsOperators = (env[MAX_SUBAGENT_SPAWN_DEPTH_ENV_VAR]
      ?? env[MAX_SUBAGENT_SPAWN_DEPTH_COMPAT_ENV_VAR]) !== undefined

    this.debug(
      '[Subagents] codex [agents] ceilings: '
      + `max_concurrent_threads_per_session=${options.maxConcurrentSubagentThreads ?? '(left to codex: 6)'} `
      + `max_depth=${options.maxSubagentSpawnDepth}`
      + `${depthIsOperators ? ' (operator)' : ' (host default, so a switch keeps three-level nesting)'} `
      + '(codex\'s own defaults are 6 and 1; V1 is the backend in force, measured)',
    )
    return options
  }

  /**
   * P3.348 — the host's tool-output ceiling, projected into codex's own
   * `tool_output_token_limit`, and ONLY for an operator who set it.
   *
   * ## Why the gate is "explicitly set" rather than "always"
   *
   * The two knobs are not the same knob. `NESSY_BASH_MAX_OUTPUT_LENGTH` is
   * CHARACTERS of one tool's read-back window; codex's is TOKENS applied to
   * every stored tool output. Forwarding the host's DEFAULT would apply a
   * Bash-shaped budget to every tool on this runtime, which is a broader change
   * than the knob promises — so an operator who never touched it keeps codex's
   * own default, and an operator who did gets the knob binding on the third
   * runtime instead of vanishing there. Same rule
   * {@link CodexAgent.codexCompactPromptOption} follows, and the same rule the
   * writer's own option docblock records with codex's measured default.
   *
   * ## The conversion is codex's own constant, not ours
   *
   * `codex-rs/utils/string/src/truncate.rs` at `rust-v0.150.1`:
   * `APPROX_BYTES_PER_TOKEN: usize = 4`, and
   * `models-manager/src/model_info.rs::with_config_overrides` converts the token
   * value back through `approx_bytes_for_tokens` because the fallback model's
   * policy is byte-shaped. So `ceil(chars / 4)` round-trips to the character
   * count the operator typed, and no number is invented on the way.
   *
   * ## Why the "was it set" read is here and not in `bash-output-limits.ts`
   *
   * That module has `resolveBashReadBackChars` (which falls back to the
   * documented default) and no declared-only reader, the way
   * `subagent-limits.ts` has `declaredMaxConcurrentSubagents`. Adding one is a
   * change to a file this lane does not hold, so the presence test lives here
   * and the VALUE still comes from the shared resolver — the clamp to the
   * documented 150 000 ceiling stays in one place. Reported as a hand-off.
   */
  /**
   * P6.146 · THE OPERATOR'S BASH TIMEOUT CEILING IS NOT HONOURED HERE, AND
   * SAYING SO IS THE WHOLE ROW.
   *
   * ## The asymmetry, measured
   *
   * The OUTPUT ceiling binds on all three runtimes — Pi through the process
   * store, claude through `buildClaudeSubprocessEnv`, codex through
   * {@link codexToolOutputTokenLimitOption} one method below. The TIMEOUT
   * ceiling binds on two: `resolveBashTimeoutCeilingMs` bounds the HOST's own
   * supervised Bash tool, and codex runs its shell inside the app-server, which
   * this host never clamps.
   *
   * ## Native mechanism, asked against the pinned schema rather than assumed
   *
   * `packages/codex-protocol/schema/config-schema.json` carries eleven
   * timeout-shaped keys and NONE of them is a per-command deadline (measured
   * 2026-09-06): `timeout` on a hook handler, `timeout_ms` on the auth token
   * command, `startup_timeout_ms`/`startup_timeout_sec` and `tool_timeout_sec`
   * on MCP entries (the last is P6.140's), `stream_idle_timeout_ms` on a model
   * provider, `websocket_connect_timeout_ms`, the three `*_wait_timeout_ms`
   * fields of `MultiAgentV2ConfigToml` (the V2 surface we do not enable), and
   * `background_terminal_max_timeout` — which its own description defines as the
   * "Maximum poll window for background terminal output (`write_stdin`)", i.e. a
   * bound on how long we WAIT FOR OUTPUT, not on how long the command may run.
   * The near-miss is the reason this is written out: adopting it because the
   * name is close would cap output polling and leave the command unbounded,
   * while looking like the knob had been honoured.
   *
   * So step 1 of native-first has no answer, step 2 cannot invent one that binds
   * a runtime the host does not schedule, and step 3 is refused: the host cannot
   * enforce a deadline inside the app-server's own shell. What is left is the
   * honest surface, which is what this is.
   *
   * ## Explicit-set-only, on P3.348's gate and for its reason
   *
   * The resolver falls back to the documented 600 000 ms, so an unconditional
   * line would tell every codex operator that a knob they never touched is not
   * being honoured — noise that trains a reader to skip the channel. The
   * presence test WAS spelled here, because `process-supervisor-port.ts` was
   * not that lane's file, and this docblock recorded that a declared-value
   * reader beside the resolver would be strictly better. That hand-off is now
   * applied: {@link declaredBashTimeoutCeiling} holds the alias precedence, the
   * present-but-blank rule and the effective number in ONE place, so the
   * sentence reporting the ceiling can no longer disagree with the clamp that
   * enforces it. The sibling method's `bash-output-limits.ts` note stands
   * unchanged — that file is still another lane's.
   *
   * NOT a runtime-switch cost row, and that is the row's own narrowing:
   * `runtimeSwitchCosts(from, to)` takes no session and `RuntimeSwitchCostRow.on`
   * is a static total `Record` with no predicate, so "fires only when an operator
   * set the value" is inexpressible there — and unconditionally it would fire for
   * every operator who never set the knob.
   */
  /**
   * P6.156's codex arm — say once per session which bundled agents' declared
   * model tier resolves to nothing here.
   *
   * Host-side by construction (case 2 of native-first): the definitions, the
   * tier map and the diagnostic channel are all ours, and codex publishes no
   * tier mechanism to enable. Same builder as Pi's arm
   * ({@link buildBuiltinAgentTierNotice}, mounted at
   * `PiAgent.noteBuiltinAgentTiersOnce`) and claude's
   * (`claudeBuiltinAgentTierDiagnostics`), so the three sentences cannot drift.
   * Same grade too — the log, latched once, never the transcript banner: it is
   * W6-b's MEASURED decision and not a default. (P6.179's question — whether
   * `debug()` is durable enough for an operator-facing fact on a PACKAGED build
   * — applies to this line exactly as it does to its siblings, and is that
   * row's to answer for all three at once.)
   *
   * ## Why this arm cannot simply pass `undefined`, which is what codex means
   *
   * MEASURED at HEAD: `tierModelMap` has exactly two consumers —
   * `pi-agent-server/src/orchestrator/spawner.ts` (`resolveAgentModelId`) and
   * `claude-runtime-agents.ts`. Nothing on the codex path reads a tier at all,
   * so on codex EVERY tier is inert, `small` included — while on Pi and claude
   * `small` DOES resolve whenever the connection's catalogue publishes the
   * gateway `fast` alias (`SessionManager` T1, `claude-agent.ts`'s
   * `tierModelMap: { small: fastModelId }`).
   *
   * So the shared line is emitted for the tiers that are inert on ALL THREE —
   * its own sentence claims that uniformity, and passing `undefined` here would
   * have made it claim it for a tier codex alone loses. The tier this
   * connection CAN resolve, and codex still cannot honour, gets its own
   * sentence naming the model it would have run on. Reporting them as one
   * would record a real per-runtime loss as a shared fact, which is the
   * silent-divergence class this plan exists to end.
   *
   * The user-visible switch COST that follows from the second sentence — "move
   * this session to codex and `scout` stops running on the cheap model" — is a
   * different surface (`runtime-switch-costs.ts`) and a different row; this is
   * the session's own statement about itself.
   */
  /** Latched per agent, like {@link claudeSettingsProjectionNoted}: a standing
   * fact about this connection, not a per-turn one. */
  private builtinTierNoticeEmitted = false;

  /**
   * P6.200 — say once that a codex subagent's report reaches the parent model
   * WITHOUT this product's untrusted-text scan.
   *
   * ## The gap is structural, and that is exactly why the surface is the build
   *
   * Pi scans: `orchestrator/subagent-tool.ts` runs `scanSubagentOutput` and
   * prepends `subagentReportMarkerLine` from `prompts/untrusted-text.ts`.
   * claude scans its own: `sub-agents.md` § *Subagent output scanning* requires
   * v2.1.210 or later, a floor the vendored SDK clears: it self-reported 2.1.251 on
   * 2026-09-17, `claudeCodeVersion` and `claude --version` agreeing. On codex the
   * subagent thread returns to the parent INSIDE the app-server, so there is no artifact
   * for a host scan to sit on — measured on the shipped binary (W7-f, strong tier):
   * `subagent` 172 hits, and `output_scan` / `scan_output` / `subagent_output` /
   * `instruction-shaped` / `harness:` **0 each**, with `enabled_tools` 17 as the positive
   * control and `zzz_not_real` 0 as the negative one. There is no native mechanism to
   * enable and nothing the host can interpose, so what is owed is the honest sentence.
   *
   * ## Why HERE and not at session start
   *
   * A session that never spawns a subagent has lost nothing, and a notice that
   * fires for every codex session is a notice people learn to skip. The first
   * ADMITTED child-thread notification is proof that a subagent of ours is
   * actually running: `adaptForeignChildThread` returns events only for a child
   * this session spawned, and returns `[]` for compaction threads and other
   * sessions. A child we cannot attribute stays silent, which is correct — we
   * would be describing someone else's thread.
   *
   * The durable operator channel, not `debug()`: this is a standing property of
   * the session that a user needs after the fact, and P3.267 measured that the
   * packaged main process writes no `debug()` line at all.
   */
  private noteSubagentReportUnscannedOnce(): void {
    if (this.subagentUnscannedNoticeEmitted) return;
    this.subagentUnscannedNoticeEmitted = true;
    this.surfaceCodexOperatorNotice(
      'Codex SUBAGENT REPORT UNSCANNED — a subagent\'s report returns to the parent inside the '
      + 'app-server, so this product\'s untrusted-text scan cannot sit on that path: no '
      + `"${SUBAGENT_MARKER_PREFIX}" line is added on codex, and instruction-shaped text in a `
      + 'subagent\'s report reaches the parent model unmarked. Pi scans the report host-side and the '
      + 'claude SDK scans its own; codex publishes no scan to enable, so this is a property of the '
      + 'runtime rather than a setting.',
    );
  }

  /** Latched per agent: one standing property of the session, not a per-spawn event. */
  private subagentUnscannedNoticeEmitted = false;

  /**
   * **P6.366, the LADDER — the next model to try, or null once the chain is
   * spent.** The mirror of `PiAgent.getRetryFallbackModel`, deliberately down to
   * the walk: the two runtimes read the SAME `resolveFallbackModelChain`, and a
   * second traversal rule would be the divergence this row exists to remove.
   *
   * NATIVE MECHANISM, asked and answered: **codex has none to enable.**
   * `fallback` over `packages/codex-protocol/schema/config-schema.json` returns
   * four keys and not one is a model-availability chain
   * (`disable_in_process_fallback`, `auto_compact_fallback_buffer_tokens`,
   * `auto_compact_fallback_prompt`, `project_doc_fallback_filenames`). So the
   * ladder is the HOST's — step 2 — and what makes it CHEAP here is that codex
   * publishes the seam it needs: `TurnStartParams.model`, *"Override the model
   * for this turn and subsequent turns"* (`generated/v2/TurnStartParams.ts`,
   * `rust-v0.148.0`), which `chatImpl` already sends on every turn. Switching
   * models is therefore a re-issued turn and not a respawned app-server.
   *
   * `model-config.md#fallback-model-chains`: *"Configure one or more fallback
   * models and Claude Code tries them in order, showing a notice when it
   * switches."* The walk resumes at the cursor rather than stopping after one
   * hop, and an entry equal to the model we are already on is skipped per-entry,
   * because a chain may name the primary in the middle.
   */
  private nextFallbackModelHop(): { modelId: string; index: number } | null {
    if (this.turnTerminalErrorCode === null) return null;
    if (!CODEX_FALLBACK_RETRY_ERROR_CODES.has(this.turnTerminalErrorCode)) return null;
    let chain: string[];
    try {
      chain = resolveFallbackModelChain(
        loadConfigDefaults().workspaceDefaults.fallbackModel,
        process.env,
      );
    } catch {
      // A defaults file that cannot be read must never be the thing that fails a
      // turn — the same posture the disclosure this replaced took.
      return null;
    }
    const running = this.getModel();
    for (let index = this.fallbackChainCursor + 1; index < chain.length; index += 1) {
      const modelId = chain[index]!;
      if (modelId === running) continue;
      return { modelId, index };
    }
    return null;
  }

  /**
   * The code that ended this turn, or null — set by the `error` notification's
   * terminal arm and read once, after the turn's queue has drained.
   */
  private turnTerminalErrorCode: string | null = null;

  /** How far down the chain this turn's walk has gone. `-1` = not started. */
  private fallbackChainCursor = -1;

  /** Set only across a ladder re-entry, so the head knows not to reset the walk. */
  private fallbackChainRetrying = false;

  /**
   * The model in force when the walk BEGAN, and the entry it installed.
   *
   * `model-config.md#fallback-model-chains`: *"The switch lasts for the current
   * turn only, so your next message tries the primary model first again."* Both
   * are needed rather than the primary alone: a model change from anywhere else
   * — the user's picker mid-turn is the reachable one — must survive, so the
   * restore compares against the entry this walk installed and not merely
   * against the primary. Same guard `PiAgent` states at its own restore.
   */
  private fallbackChainPrimaryModel: string | null = null;

  private fallbackChainActiveModel: string | null = null;


  private noteBuiltinAgentTiersOnce(): void {
    if (this.builtinTierNoticeEmitted) return;
    this.builtinTierNoticeEmitted = true;
    const slug = this.config.connectionSlug;
    const connection = slug ? getLlmConnection(slug) : null;
    // Resolved exactly as the host resolves it for Pi and for claude — same
    // function, same alias, same `undefined` for a catalogue without one — so
    // "what Pi and claude would get" is not an estimate here.
    const fastModelId = connection ? resolveGatewayFastModelId(connection) : undefined;
    const elsewhere: BuiltinAgentTierModelMap | undefined = fastModelId
      ? { small: fastModelId }
      : undefined;
    for (const line of buildBuiltinAgentTierNotice(elsewhere)) this.debug(line);
    if (!fastModelId) return;
    // Every bundled agent is inert against an EMPTY map, so this is exactly the
    // set the shared line above left out: the tiers this connection resolves
    // for the other two runtimes and codex cannot honour.
    const carried = inertBuiltinAgentTiers(undefined)
      .filter(entry => Boolean(elsewhere?.[entry.tier]))
      .map(entry => entry.agent);
    if (carried.length === 0) return;
    // Localised like the shared sentence it stands beside — two lines on one
    // channel in two languages is its own small defect.
    if (!i18n.isInitialized) setupI18n();
    this.debug(i18n.t('chat.builtinAgentTier.codexTierUnread', {
      agents: carried.join(', '),
      model: fastModelId,
      count: carried.length,
    }));
  }

  private noteUnhonouredBashTimeoutCeiling(): void {
    // The alias precedence and the present-but-blank rule now live ONCE, beside
    // the resolver whose number this line quotes — P6.146's own hand-off,
    // applied.
    const declared = declaredBashTimeoutCeiling()
    if (declared === undefined) return
    this.debug(
      `[Bash] the operator's Bash timeout ceiling (${declared.envVar}=${declared.raw}, effective `
      + `${declared.ceilingMs} ms) is NOT honoured on codex: it bounds the host's own `
      + 'supervised Bash tool, and codex runs its shell inside the app-server, whose config exposes no '
      + 'per-command deadline — the closest key, `background_terminal_max_timeout`, bounds the output '
      + 'poll window rather than the command. The ceiling still binds on Pi and claude sessions.',
    )
  }

  private codexToolOutputTokenLimitOption(): { toolOutputTokenLimit?: number } {
    const env = process.env
    const raw = env[BASH_MAX_OUTPUT_LENGTH_ENV] !== undefined
      ? env[BASH_MAX_OUTPUT_LENGTH_ENV]
      : env[BASH_MAX_OUTPUT_LENGTH_COMPAT_ENV]
    if (raw === undefined) return {}
    // P6.565 · the SAME rule `resolveBashReadBackChars` applies, because this is
    // the same key: `BASH_MAX_OUTPUT_LENGTH`'s row in `env-vars.md` notes nothing
    // about plain digits, so `env-vars.md#variables`' general clause grants it
    // scientific notation and separators. The `/^\d+$/` this replaced would have
    // made `2e4` set the host window and reach codex as nothing — one setting,
    // two meanings, on the same session. A zero is a fallback rather than a
    // setting on every reader in this family, so it still reaches codex as
    // nothing; the rejection itself is reported once by the shared resolver
    // inside `resolveBashReadBackChars`, so it is not restated here.
    const parsedRaw = parseNumericSetting(raw)
    if (!parsedRaw.ok || parsedRaw.value === 0) return {}
    const chars = resolveBashReadBackChars(env)
    const tokens = Math.ceil(chars / CODEX_APPROX_BYTES_PER_TOKEN)
    this.debug(
      `[Output] projecting the host output ceiling onto codex: ${chars} chars `
      + `-> tool_output_token_limit = ${tokens} (codex's own default is 10000 BYTES)`,
    )
    return { toolOutputTokenLimit: tokens }
  }

  /**
   * P6.140 — the host's MCP tool wall clock, projected onto codex's own
   * per-entry `tool_timeout_sec`, and ONLY for an operator who set it.
   *
   * ## The gap
   *
   * A hung MCP transport had no deadline at all on codex. The pinned
   * `config-schema.json` gives `RawMcpServerConfig` three transport deadlines
   * and the writer emitted none of them on either of the two entries it writes,
   * while the same tool call is bounded on Pi and claude by the host pool's
   * `defaultToolTimeoutMs` — read from this very lever.
   *
   * ## Native mechanism, asked and answered: (1), codex already has it
   *
   * `tool_timeout_sec` is codex's own key in the file we already author. There
   * is nothing to build and nothing for the host to supply uniformly; we were
   * simply not writing it.
   *
   * ## EXPLICIT-SET-ONLY, and here that gate is not a nicety
   *
   * {@link mcpDefaultToolTimeoutMsFromEnv} falls back to
   * `MCP_DEFAULT_TOOL_TIMEOUT_MS` — 100 000 000 ms, about 28 hours, chosen
   * deliberately so the lever changes nothing at rest. Projecting the RESOLVED
   * value unconditionally would therefore write a ~100 001-second deadline into
   * every codex session that never asked for one: a key that looks like a
   * setting and means nothing. So the presence test is
   * {@link readMcpTimeoutEnv} — which is also the function that decides which of
   * the two documented spellings wins, so this cannot disagree with the pool
   * about whether the operator set anything.
   *
   * ## The margin, which is the row's required guard
   *
   * The `sources` entry IS the loopback pool endpoint, so on that entry two
   * clocks now bound one call: ours and codex's. They must not race, and the one
   * that has to win is ours — P6.26's abort names the server and the tool, and
   * codex's says only that a tool timed out. So the projected deadline is
   * strictly LOOSER: whole seconds rounded UP from the host's millisecond
   * ceiling, plus one. At the documented one-second floor that is 2 s against
   * 1 000 ms; at 45 000 ms it is 46 s. The `+ 1` is what survives the rounding —
   * `ceil(1000 / 1000)` alone would be 1 s, i.e. exactly the host's ceiling and
   * a coin toss.
   *
   * The lever lands on `sources` only (UA12.24): `session` instead always
   * carries the writer's `CODEX_SESSION_TOOL_TIMEOUT_SEC` floor — the session
   * bridge's own 120 s callback ceiling plus one, so a publish card answered
   * inside the host's card window reaches the model instead of a bare codex
   * timeout — raised to this lever when the lever is looser.
   */
  private codexMcpToolTimeoutOption(): { mcpToolTimeoutSec?: number } {
    const env = process.env
    // Presence FIRST, and through the pool's own reader: a name that is present
    // but blank counts as unset there, and it must count as unset here too.
    const reading = readMcpTimeoutEnv(env, MCP_TOOL_TIMEOUT_ENV, MCP_TOOL_TIMEOUT_COMPAT_ENV)
    if (!reading) return {}
    const hostCeilingMs = mcpDefaultToolTimeoutMsFromEnv(env)
    // A malformed value resolves to the enormous documented default in that
    // reader; forwarding it would write the 28-hour deadline this gate exists to
    // keep out, so an unparseable setting is dropped rather than projected. An
    // operator who typed that number EXACTLY gets the same answer, and it is the
    // right one for them too: they asked for the ceiling that changes nothing,
    // and a 100 001-second key is how you spell that in a file.
    if (hostCeilingMs >= MCP_DEFAULT_TOOL_TIMEOUT_MS) {
      this.debug(
        `[MCP] ${reading.name} is set but does not resolve to a real ceiling, so codex `
        + 'gets no `tool_timeout_sec` rather than a 28-hour one',
      )
      return {}
    }
    const seconds = Math.ceil(hostCeilingMs / 1000) + 1
    this.debug(
      `[MCP] projecting the host tool wall clock onto codex: ${hostCeilingMs}ms (${reading.name}) `
      + `-> tool_timeout_sec = ${seconds} on sources, deliberately looser so the host's `
      + 'attributed abort fires first',
    )
    return { mcpToolTimeoutSec: seconds }
  }

  /**
   * P6.166 — the host's auto-memory off switch reaches codex, so a switch INTO
   * codex stops re-enabling memory the user turned off.
   *
   * ## The gap
   *
   * `getMemoryEnabled()` is the one host switch. Pi honours it on its own path;
   * claude got `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` at P6.33
   * (`applyAutoMemoryOffSwitch` in `options.ts`). Codex honoured nothing —
   * `[memories]` appeared in three DOCBLOCK lines of this file and in zero
   * emitted keys — so a user who turned memory off and switched a session to
   * codex silently got it back on. That is the same
   * setting-silently-reversed shape P6.53 fixed on claude, and it is the
   * fork's largest defect class.
   *
   * ## Native mechanism, asked and answered: (1), codex already has it
   *
   * `[memories]` is codex's own table in the `config.toml` we already author,
   * and its two keys say exactly what we want in the schema's own words. There
   * is nothing to build and nothing for the host to supply uniformly. **And it
   * was MEASURED rather than assumed** — the two-arm run on the shipped binary,
   * including the half that turned out to be unobservable, is recorded at
   * `CodexConfigOptions.memoriesEnabled`.
   *
   * ## Only the OFF direction is written
   *
   * `true` writes nothing. Writing our `true` would re-assert a default we did
   * not choose, on a subsystem whose defaults are codex's — the same
   * explicit-only discipline P3.348 established in this writer, and the same
   * direction `applyAutoMemoryOffSwitch` takes for claude.
   *
   * A `getMemoryEnabled()` that throws decides NOTHING, exactly as it decides
   * nothing for claude: the table stays unwritten and codex's own default
   * applies. Logged rather than silent, because "no `[memories]` table" and "we
   * could not read the switch" are different facts and only one of them is a
   * fault.
   */
  /**
   * P6.155 — the connection's served cheap model, in codex's own
   * `[agents] default_subagent_model`.
   *
   * ## The gap
   *
   * Codex has two of its own model levers for cheap helpers and we wrote
   * neither. This is the GLOBAL one, and the row says to start with it: a real
   * key of `AgentsToml` in the pinned schema — *"Default model for spawned
   * subagents when the spawn call does not select one."* — sitting in the
   * `[agents]` table this writer already emits, and known in this tree only as a
   * reserved role name.
   *
   * ## Native mechanism, asked and answered: (1), codex already has it
   *
   * Nothing to build and nothing for the host to supply uniformly; the key is
   * codex's, in the file we already author, and we were not writing it.
   *
   * ## `miniModel` is the SERVED id, which is why the writer's `model` refusal
   * ## does not apply
   *
   * `buildCodexAgentRoles` drops a role's `model` because one session drives ONE
   * upstream through the loopback adapter, so a FOREIGN id can only fail at
   * spawn. `config.miniModel` is the host's own
   * `getMiniModel(connection) ?? connection.defaultModel` — the same connection,
   * the same upstream, and the same field the claude gateway path already
   * resolves.
   *
   * ## Omitted when it would restate codex's own default
   *
   * That `?? connection.defaultModel` fallback means a connection with no
   * distinct cheap model resolves `miniModel` TO the session model. Writing it
   * then would re-assert codex's documented behaviour — its own `spawn_agent`
   * text says *"Spawned agents inherit your current model by default"* — so
   * this returns `{}`, the same explicit-only discipline
   * {@link CodexAgent.codexToolOutputTokenLimitOption} follows.
   *
   * ## The per-ROLE half is NOT here, and the reason is a missing field
   *
   * A role's own `config_file` layer accepts root-level keys — we already write
   * `model_reasoning_effort` into one — so per-role model selection is not
   * structural. It is blocked on `CodexAgentRoleDescriptor` carrying no `tier`
   * at all, which has to be threaded from the definition first. That is its own
   * unit and is reported rather than half-built.
   */
  /**
   * P6.364 (K10) — the OPERATOR's override, ahead of the derived cheap model.
   *
   * `NESSY_SUBAGENT_MODEL` (with `CLAUDE_CODE_SUBAGENT_MODEL` as its compat
   * alias) bound on Pi alone and reached codex not at all. It reaches it here,
   * through codex's OWN key rather than anything built beside it — native-first
   * case (1): `AgentsToml.default_subagent_model` is *"Default model for
   * spawned subagents when the spawn call does not select one"*, which is the
   * documented tier-3 role of the variable, in the file this writer already
   * authors.
   *
   * It outranks {@link CodexAgent.codexDefaultSubagentModelOption}'s
   * connection-derived `miniModel` because one is a DECLARATION and the other
   * an inference: `miniModel` is `getMiniModel(connection) ?? defaultModel`,
   * chosen for the operator; the variable is chosen BY them.
   *
   * Screened by the managed allowlist for the same reason the Pi spawner
   * screens it — an operator variable outranks the delegated model inputs, not
   * the organization's policy — and a refused value is DROPPED rather than
   * raised, so the session continues on codex's own default. That is
   * `model-config.md` § *Restrict model selection* applied to the same knob the
   * Pi path already applies it to.
   *
   * NOT projected: `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`. codex has no equivalent
   * and the writer already drops a role's own `model`
   * (`buildCodexAgentRoles`), so on codex this key is the only model a spawned
   * agent can be given — the FORCE distinction is unobservable here and
   * inventing a projection for it would be a mechanism, not a configuration.
   */
  private codexOperatorSubagentModelOption(): { defaultSubagentModel?: string } | null {
    const declared = resolveSubagentModelOverride();
    if (declared === undefined) return null;
    if (!isManagedModelSelectable(declared)) {
      this.debug(
        `[Subagents] the subagent-model override ${declared} is outside this organization's `
        + 'available-models allowlist, so it is dropped and codex keeps its own default',
      );
      return null;
    }
    this.debug(
      '[Subagents] projecting the operator\'s subagent-model override onto codex: '
      + `[agents] default_subagent_model = ${declared}`,
    );
    return { defaultSubagentModel: declared };
  }

  /**
   * C3.373 — and the FIRST question is whether codex can resolve ANY id we
   * project here, which on this product's ordinary session it cannot.
   *
   * ## The refusal, read at the source
   *
   * R6b measured it on packaged `70d269e46`: with `[agents]
   * default_subagent_model = "tgpt/qwen36-35b-a3b-fp8"` in the session's own
   * `config.toml`, the FIRST `spawn_agent` came back *"refused before an agent
   * existed"*, the model said *"The default model isn't available for subagents;
   * retrying with an explicit model"*, and the retry succeeded.
   *
   * `github.com/openai/codex` at `rust-v0.150.1` says why, and it is not about
   * subagents at all —
   * `core/src/tools/handlers/multi_agents_common.rs`
   * `apply_requested_spawn_agent_model_overrides` folds this key and the spawn
   * call's own `model` into ONE variable, then `find_spawn_agent_model_name`
   * resolves it against `models_manager.list_models(RefreshStrategy::Offline,
   * …)` — **codex's own cached, auth-filtered OpenAI preset catalogue, read with
   * no network** — and returns
   * `FunctionCallError::RespondToModel("Unknown model … for spawn_agent.
   * Available models: …")` when it is not there. The provider actually serving
   * the session is never consulted. So a gateway id cannot pass, and neither can
   * anything else that is not an OpenAI preset; the advertised list is filtered
   * to `show_in_picker` and capped at five, so on a catalogue with no OpenAI
   * presets cached the sentence ends after the colon.
   *
   * It is not fatal — `RespondToModel` becomes a `function_call_output` with
   * `success: false` and the turn continues — which is exactly why it went
   * unnoticed: the model retries and the user sees one wasted call.
   *
   * ## The condition, which is a predicate this file already has
   *
   * {@link declaredCodexModelProvider} is `undefined` precisely when the writer
   * keeps its LOOPBACK pin — every install that declared nothing — and a
   * loopback-pinned session's model ids are ours, never OpenAI presets. So on
   * that session no id we could project is resolvable, and the honest projection
   * is none.
   *
   * **Native-first, and the runtime's own default is the right answer.** With
   * the key absent, `apply_requested_spawn_agent_model_overrides` never reaches
   * the catalogue at all and codex applies its documented *"spawned agents
   * inherit your current model"* — the one model this session is already known
   * to serve. That is why this is a guard and not a rewrite.
   *
   * **The OPERATOR's override is declined here too, and that is the safe
   * direction rather than an override of their choice.** A value codex's cache
   * happens to hold from an earlier OpenAI-authenticated use would PASS
   * `find_spawn_agent_model_name` and then run the child against
   * `model_provider = nessy_gateway` with an id the gateway does not serve —
   * a worse failure, one step later. Said out loud on the durable channel for
   * that reason, the same one {@link hostAuthoredHookProjection} uses and for
   * the same reason: an absent key reads as "nothing was configured".
   *
   * ## D1.172 — this guard has no negative in the shipped product, and that is
   * the product posture rather than a narrow decline
   *
   * The `if` above reads as a narrow condition. It is not. Measured at HEAD on
   * 2026-09-17 (`git grep -aln`, tracked blobs):
   *
   *  - `CodexModelProvider` WAS a one-member union (`'amazon-bedrock'`,
   *    `config/llm-connections.ts`), so `resolveCodexModelProvider` had exactly
   *    one non-`undefined` answer;
   *  - `codexModelProvider` occurred in **5** files, three of them tests, and
   *    **0** files under `apps/`, `packages/server-core/` or `packages/core/`
   *    named it: no card seed, no renderer surface, no RPC handler wrote it.
   *    Positive control then: `miniModel` answered 58 files, 11 of them renderer.
   *
   * **F1.202 (2026-09-24) restored the negative, exactly as the last paragraph
   * below predicted.** The union gained `openai`, and the ChatGPT (Codex) card
   * (`server-core` template `chatgpt-codex`, behind the `chatgpt` provider flag)
   * declares it — so on that card `declaredCodexModelProvider()` answers
   * `openai`, the ids ARE codex's own catalogue, and this method projects the
   * connection's cheap model (or the operator's `NESSY_SUBAGENT_MODEL`). Every
   * OTHER shipped card still declares nothing, so there the notice below is
   * still what a session records; it is standing on those cards, not on all.
   * The census above is kept as the reading it was on its date, superseded.
   *
   * **It cannot be made to discriminate, and the reason is not this predicate.**
   * The predicate is exactly the right one — it asks whose catalogue the ids
   * come from, which is the question `find_spawn_agent_model_name` asks — and it
   * already answers correctly for the declared case (proved by
   * `codex-explicit-operator-ceilings.test.ts`, which plants a declaring
   * connection for real). What makes it unconditional is that the product ships
   * no surface that writes `codexModelProvider`; a second `CodexModelProvider`
   * member, or a card that declares the one that exists, restores the negative
   * with no change here.
   */
  private codexDefaultSubagentModelOption(): { defaultSubagentModel?: string } {
    if (this.declaredCodexModelProvider() === undefined) {
      const wanted = resolveSubagentModelOverride() ?? this.config.miniModel?.trim();
      if (wanted) {
        const notice = '[Subagents] no `[agents] default_subagent_model` is projected on this session: '
          + 'codex resolves that key against its own cached OpenAI model catalogue, never against the '
          + `provider serving the session, so \`${wanted}\` would be refused at the first spawn_agent. `
          + 'Spawned agents inherit this session\'s model, which is codex\'s own default.';
        this.recordSessionFact('codex-subagent-model-projection', notice);
        this.debug(notice);
      }
      return {};
    }
    const declared = this.codexOperatorSubagentModelOption();
    if (declared) return declared;
    const mini = this.config.miniModel?.trim();
    if (!mini) return {};
    if (mini === this._model.trim()) {
      this.debug(
        `[Subagents] the connection resolves no cheap model distinct from ${this._model}, so codex `
        + 'keeps its own "spawned agents inherit your current model" default',
      );
      return {};
    }
    this.debug(
      `[Subagents] projecting the connection's served cheap model onto codex: `
      + `[agents] default_subagent_model = ${mini}`,
    );
    return { defaultSubagentModel: mini };
  }

  /**
   * P6.390 — this chat's memory scope, projected onto codex's own per-thread
   * memory mode.
   *
   * ## Native mechanism: (1), and it is a WIRE control rather than a config key
   *
   * `thread/memoryMode/set` exists at `rust-v0.148.0` and is reachable — we
   * already declare `experimentalApi: true` in `initialize` — but it is
   * `#[experimental]`, so the generator emits no `generated/v2` params type and
   * no SDK lift will produce one. The method name and the params shape are
   * therefore spelled once in `memory/session-memory-scope.ts`, read off the
   * source, and sent by string from here.
   *
   * ## Why it is sent on EVERY open, including the fully-on case
   *
   * The mode is PERSISTED per thread in codex's state DB (W8-m measured this,
   * and it is why the row asks for `thread/resume` as well as `thread/start`).
   * So sending only the OFF case would be a one-way door: a chat excluded from
   * memory once would stay excluded after the user turned it back on, because
   * nothing would ever say `enabled` again. The hand-off's `if (!scope.read ||
   * !scope.write)` gate is deliberately NOT taken for that reason — the extra
   * request costs one round trip per runtime build and buys a control that
   * moves in both directions.
   *
   * ## Best-effort, and legible when it fails
   *
   * A server without the experimental capability answers *"thread/memoryMode/set
   * requires experimentalApi capability"*, which names itself; a runtime build
   * must not die because a memory preference could not be projected. The
   * conjunction is lossy — one codex enum over the row's two axes — and the user
   * is already told so by the session menu's own lossy line
   * (`sessionMenu.memoryScopeLossy`), so nothing is re-worded here.
   */
  private async applyCodexThreadMemoryMode(
    client: AppServerClient,
    threadId: string,
    openedBy: string,
  ): Promise<void> {
    let globalEnabled: boolean;
    try {
      globalEnabled = getMemoryEnabled();
    } catch (error) {
      // Exactly what `codexMemoriesOption` does with the same failure: decide
      // nothing, and say which of the two facts this is.
      this.debug(
        '[Memories] the host auto-memory switch could not be read, so this thread keeps codex\'s own '
        + `memory mode: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    const override = this.config.session?.memoryScopeOverride;
    const scope = resolveSessionMemoryScope({ globalEnabled, ...(override ? { override } : {}) });
    const params = buildCodexThreadMemoryModeSetParams(threadId, scope);
    try {
      await client.request(CODEX_THREAD_MEMORY_MODE_SET_METHOD, params);
      this.debug(`[Memories] ${openedBy} → thread memory mode ${params.mode}`);
    } catch (error) {
      this.debug(
        `[Memories] codex refused ${CODEX_THREAD_MEMORY_MODE_SET_METHOD} (${params.mode}); the thread keeps `
        + `its own mode: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * P6.166 — the auto-memory switch in codex's own `[memories]` vocabulary.
   *
   * P6.754 — and it resolves THIS CHAT's scope, not the app-wide switch alone,
   * through the very same projection {@link applyCodexThreadMemoryMode} sends on
   * the wire. Before that the two answered different questions: a chat opted out
   * of memory while the app-wide switch was on wrote no `[memories]` table at
   * all, and a chat opted IN while the app-wide switch was off wrote
   * `generate_memories = false` — so a reader comparing the config with the wire
   * found them disagreeing, and the wire won only because it is sent later.
   *
   * The per-chat scope is legitimately in scope HERE, and that is the fact that
   * settles the row: `createRuntime` builds a FRESH `CODEX_HOME`
   * (`mkdtempSync`) per runtime, so this `config.toml` belongs to one chat and
   * nothing else reads it. A per-chat value in a shared config would have been
   * the opposite answer.
   *
   * Agreement is by CONSTRUCTION rather than by two matching conditions: both
   * sites call {@link projectSessionMemoryScopeToCodex}, the one place the
   * two-axis host scope collapses into codex's single `ThreadMemoryMode`. So the
   * lossy conjunction cannot drift between them, and the residue sentence the
   * user already sees (`sessionMenu.memoryScopeLossy`) still describes both.
   *
   * It also stops being a one-sided guard: `thread/memoryMode/set` is
   * `#[experimental]` and a server that refuses it leaves the thread on whatever
   * the config said. With the config carrying the same answer, a refused request
   * costs the chat nothing in either direction.
   *
   * Only the OFF position is written, unchanged: an absent table is codex's own
   * default, and writing `true` would re-assert a default we did not choose.
   */
  private codexMemoriesOption(): { memoriesEnabled?: boolean } {
    let globalEnabled: boolean;
    try {
      globalEnabled = getMemoryEnabled();
    } catch (error) {
      this.debug(
        '[Memories] the host auto-memory switch could not be read, so codex keeps its own default: '
        + `${error instanceof Error ? error.message : String(error)}`,
      );
      return {};
    }
    const override = this.config.session?.memoryScopeOverride;
    const scope = resolveSessionMemoryScope({ globalEnabled, ...(override ? { override } : {}) });
    if (projectSessionMemoryScopeToCodex(scope) === 'enabled') return {};
    this.debug(
      '[Memories] this chat\'s memory scope resolves to codex mode "disabled", so it gets '
      + '[memories] generate_memories=false + use_memories=false (measured: a new thread records '
      + 'memory_mode="disabled")',
    );
    return { memoriesEnabled: false };
  }

  /**
   * P6.534 — the host's bundled-skills OFF switch, in codex's own vocabulary.
   *
   * Native-first case (1): `SkillsConfig.bundled.enabled` IS the analogue of our
   * switch and we had never written it, so a cold managed `CODEX_HOME` came back
   * holding codex's own bundled tree — 87 entries measured on the shipped
   * `darwin-arm64` build — that the host switch could not touch. Q-den 76.
   *
   * Read through `bundledSkillsDisabled`, the same composed reader the seed
   * suppression uses, so the setting file and both env spellings mean the same
   * thing here as they do on Pi. A config that cannot be read leaves codex on
   * its own default rather than guessing OFF: the switch is a restriction, and
   * inventing one from a read error would remove skills nobody asked to remove.
   * Same shape and same reason as {@link codexMemoriesOption}.
   */
  private codexBundledSkillsOption(): { bundledSkillsEnabled?: boolean } {
    let disabled: boolean;
    try {
      disabled = bundledSkillsDisabled(loadStoredConfig());
    } catch (error) {
      this.debug(
        '[Skills] the host bundled-skills switch could not be read, so codex keeps its own default: '
        + `${error instanceof Error ? error.message : String(error)}`,
      );
      return {};
    }
    if (!disabled) return {};
    this.debug(
      '[Skills] the host bundled-skills switch is OFF, so codex gets [skills.bundled] enabled=false — '
      + "codex's own bundled tree goes with it, including $skill-installer",
    );
    return { bundledSkillsEnabled: false };
  }

  /**
   * P6.309 (1) · the session's agent descriptors, with their declared skills'
   * bodies materialized into each `systemPrompt`.
   *
   * Returns `undefined` when there are no definitions at all, so the spread at
   * the call site stays byte-identical for a session with none.
   *
   * A session with NO pinned capability view returns the descriptors unchanged —
   * today's behaviour, so nothing regresses — and SAYS so through the same
   * sentence the claude path uses for the un-materialized case. `capabilityTurnRuntime`
   * is null before the first turn's view is pinned, which is exactly when the
   * runtime config is written, so this is the ordinary path rather than an edge:
   * the row it closes is a role that names a skill and gets no body, and a role
   * that gets no body WITH a line saying why is strictly better than one that
   * gets no body in silence.
   */
  private async materializeCodexAgentSkills(): Promise<readonly PiRuntimeAgentDefinitionDescriptor[] | undefined> {
    const definitions = this.config.piRuntimeAgentDefinitions;
    if (!definitions?.length) return undefined;
    const runtime = this.capabilityTurnRuntime;
    const announce = (message: string): void => { this.debug(`[Subagents] ${message}`); };
    let skills;
    try {
      skills = runtime
        ? await materializeClaudeRuntimeAgentSkills({
          definitions,
          materializer: runtime.materializer,
          skills: runtime.view.skills ?? [],
          generation: runtime.view.generation,
          sessionModel: this._model,
          onDiagnostic: announce,
        })
        : undefined;
    } catch (error) {
      // A materialization that throws leaves the roles declared and bodiless —
      // the pre-row state — rather than taking the whole runtime build down.
      announce(
        'skill bodies could not be materialized for this session, so codex roles run without them: '
        + `${error instanceof Error ? error.message : String(error)}`,
      );
      return definitions;
    }
    return applyRuntimeAgentSkillsToDescriptors({ definitions, skills, announce });
  }

  /** P6.399 · one `skills/list` walk at a time; a burst of `skills/changed` is one read. */
  private codexSkillsSyncInFlight = false;

  /**
   * P6.399 — codex's own `skills/*` methods, SENT.
   *
   * ## Native-first case (1): the mechanism existed and was never used
   *
   * The pinned schema publishes `skills/list`, `skills/config/write` and
   * `skills/extraRoots/set` (`codex_app_server_protocol.schemas.json`,
   * `ClientRequest`), and this fork sent none of them. The consequence was not
   * only a missing feature: the reason recorded for ignoring `skills/changed`
   * — "codex reloading its own set changes nothing we present" — was CIRCULAR,
   * because nothing changed in what we presented only for as long as we never
   * asked what codex would load.
   *
   * `skills/extraRoots/set` is deliberately NOT sent here: P6.399's own text
   * excludes it, and P6.169 sequences it with the §1.4 + §2.3 decisions.
   *
   * ## What the two requests do
   *
   * `skills/list` returns `SkillsListEntry[]` — `{ cwd, errors, skills }`, each
   * skill a `SkillMetadata { name, description, path, scope, enabled, … }`. So
   * the response carries codex's own view of BOTH which skills exist and which
   * are on, which is what makes the control below a measurement rather than an
   * assumption.
   *
   * `skills/config/write` takes `{ enabled, name?, path? }` and answers
   * `{ effectiveEnabled }`. The NAME selector is used, because
   * `skillOverrides` is keyed by skill name — *"Per-skill listing overrides
   * keyed by skill name"* — and a path selector would need a path the host does
   * not have for a skill it never installed.
   *
   * ## Why a host override reaches codex's own skills at all
   *
   * `skillOverrides` names are "passed through unexamined: a name no skill
   * claims is simply never looked up" (`config/skill-overrides.ts`). A user who
   * writes `"$skill-installer": "off"` is naming a skill that exists only in
   * codex's own tree, and until this row that entry did nothing on codex while
   * doing exactly what it says on Pi. `off` and `user-invocable-only` are the
   * two states that hide a skill from the model — the same predicate the host
   * listing uses, `skillOverrideHidesFromModelListing`, so the two cannot drift.
   *
   * `name-only` is deliberately NOT projected: it suppresses a DESCRIPTION, and
   * codex's key is a boolean. Disabling the skill would be a stricter action
   * than the user asked for.
   *
   * ## Failure is reported, never fatal
   *
   * A refusal or a timeout leaves codex on its own configuration and says so on
   * the diagnostics channel. This runs after the thread is open and off the
   * turn path, so a slow `skills/list` costs the user nothing.
   */
  /**
   * C4.24 (QL3, owner answer C, 2026-09-11) — the ADDED FOLDERS' skills, through
   * codex's own `skills/extraRoots/set`.
   *
   * ## What was absent, and it was not the mechanism
   *
   * A user who adds a folder to this session gets its skills on Pi and claude —
   * the host scans `<root>/.agents/skills` and `<root>/.nessy-agent/skills` for
   * every nested root (`capabilities/native-sources.ts`
   * `nestedSkillDirectories`). codex saw none of them: its skill roots are
   * `CODEX_HOME` and the cwd, and this fork's `CODEX_HOME` is a per-session
   * `mkdtemp` directory. So the capability existed on two runtimes of three and
   * nothing said so — P6.399 wired `skills/list` and `skills/config/write` and
   * left this third member by its own row text.
   *
   * ## Native-first: the method exists and takes exactly this
   *
   * `skills/extraRoots/set` is declared in
   * `packages/codex-protocol/generated/ClientRequest.ts` with
   * `SkillsExtraRootsSetParams` = `{ extraRoots: Array<AbsolutePathBuf> }`, and
   * codex's own test settles the SEMANTICS that the type alone does not:
   * `app-server/tests/suite/v2/skills_list.rs`,
   * `skills_extra_roots_set_updates_process_runtime_roots`, writes
   * `<extra_root>/skills/runtime-skill/SKILL.md` and passes
   * `<extra_root>/skills` — so a member of this list is a directory CONTAINING
   * skill directories, not a project root. The same test passes a root that does
   * not exist and gets a normal response, so a missing directory is accepted;
   * this method filters anyway, because handing codex a list of paths that are
   * not there is noise on every sync rather than a capability.
   *
   * ## The roots are the ACCEPTED added folders, and that is a boundary question
   *
   * {@link codexAdditionalWritableRoots} is reused rather than re-derived:
   * those roots are already granted to codex for WRITING, so reading skills out
   * of them opens no boundary this session did not already open — and its three
   * refusals (a filesystem root, a denied-read path, a credential-floor overlap)
   * are the ones that must not be widened here either.
   *
   * ## The loop this would otherwise be
   *
   * Every `set` makes codex emit `skills/changed`, and `skills/changed` is what
   * calls the sync this sits inside. {@link lastCodexSkillExtraRoots} is what
   * stops that: the request goes out only when the list actually moves.
   *
   * ## The residue, said out loud
   *
   * Skills discovered this way live on codex for as long as the session does.
   * `CODEX_SKILL_EXTRA_ROOTS_SWITCH_NOTE` is the sentence for it, recorded on
   * the session-facts channel beside the rollout disclosure; the switch-report
   * row that belongs beside it is handed off with the row, because that table
   * and the locale files are another lane's zone this wave.
   */
  private async syncCodexSkillExtraRoots(client: { request(method: string, params: unknown): Promise<unknown> }): Promise<void> {
    const roots = this.codexSkillExtraRoots();
    const signature = roots.join('\n');
    if (signature === this.lastCodexSkillExtraRoots) return;
    try {
      await client.request('skills/extraRoots/set', { extraRoots: roots });
      this.lastCodexSkillExtraRoots = signature;
      this.debug(
        roots.length > 0
          ? `[Skills] handed codex ${roots.length} extra skill root(s) from added folders: ${roots.join(', ')}`
          : '[Skills] cleared codex\'s extra skill roots: no added folder carries a skills directory',
      );
      if (roots.length > 0) this.recordSessionFact('codex-skill-extra-roots', CODEX_SKILL_EXTRA_ROOTS_SWITCH_NOTE);
    } catch (error) {
      // NOT fatal and NOT retried on this notification: a codex that refuses the
      // method keeps every skill it already had, and the session keeps running
      // on codex's own roots — the same degradation `skills/config/write` takes
      // one block below.
      this.debug(
        '[Skills] codex refused skills/extraRoots/set, so an added folder\'s skills stay invisible to it: '
        + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * C4.24 · the two skill layers a nested root may own, for every ACCEPTED added
   * folder, filtered to the ones that exist.
   *
   * The two names are imported rather than spelled so this can never disagree
   * with `capabilities/native-sources.ts`'s `nestedSkillDirectories`, which is
   * what Pi and claude are handed.
   */
  private codexSkillExtraRoots(): string[] {
    const roots = new Set<string>();
    for (const added of this.codexAdditionalWritableRoots()) {
      for (const directory of [
        join(added, PROJECT_AGENT_SKILLS_DIR),
        join(added, NESSY_AGENT_PROJECT_DIR, 'skills'),
      ]) {
        if (existsSync(directory)) roots.add(directory);
      }
    }
    return [...roots].sort();
  }

  private async syncCodexSkillsConfig(reason: 'startup' | 'skills/changed'): Promise<void> {
    const client = this.client;
    if (!client || this.destroyed) return;
    // A burst of `skills/changed` (codex re-scans a tree, several roots move)
    // must not become a burst of list walks; the last one wins because the next
    // notification after this returns will run a fresh read.
    if (this.codexSkillsSyncInFlight) return;
    this.codexSkillsSyncInFlight = true;
    try {
      await this.syncCodexSkillExtraRoots(client);
      const listed = await client.request('skills/list', {}) as {
        data?: { cwd?: string; skills?: { name?: unknown; enabled?: unknown; path?: unknown }[] }[];
      };
      const skills = (listed?.data ?? []).flatMap(entry => entry?.skills ?? []);
      const named = skills.filter(
        (skill): skill is { name: string; enabled?: unknown; path?: unknown } => typeof skill?.name === 'string',
      );
      this.debug(
        `[Skills] codex lists ${named.length} skill(s) of its own (${reason}); `
        + codexSkillsSyncDisabledCount(named, this.codexRestrictedRepoSkillsOff), // F1.948 — the thread-layer disables codex's process-level list does not see
      );
      if (named.length === 0) return;

      const overrides = resolveSkillOverrides({
        userConfig: loadStoredConfig(),
        ...(this.config.session?.workingDirectory
          ? { workingDirectory: this.config.session.workingDirectory }
          : {}),
        projectTrusted: this.config.projectTrusted === true,
      });
      for (const skill of named) {
        if (this.destroyed) return;
        if (!skillOverrideHidesFromModelListing(resolveSkillOverride(overrides, skill.name))) continue;
        if (skill.enabled === false) continue;
        try {
          const written = await client.request('skills/config/write', {
            name: skill.name,
            enabled: false,
          }) as { effectiveEnabled?: unknown };
          // codex's OWN answer, not our request echoed back: `effectiveEnabled`
          // is what it resolved, and a `true` here means the write did not take.
          this.debug(
            `[Skills] host skillOverrides hides "${skill.name}"; codex skills/config/write `
            + `answered effectiveEnabled=${String(written?.effectiveEnabled)}`,
          );
        } catch (error) {
          this.debug(
            `[Skills] codex refused skills/config/write for "${skill.name}", so it stays on codex's own `
            + `setting: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } catch (error) {
      this.debug(
        '[Skills] codex skills/list failed, so this session keeps codex\'s own skill configuration: '
        + `${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.codexSkillsSyncInFlight = false;
    }
  }

  private codexCompactPromptOption(): { compactPrompt?: string } {
    const resources = this.config.piContextResources;
    if (!resources) {
      this.debug(
        '[Compaction] no instruction resources on this session, so codex keeps its own '
        + 'compact_prompt (this session composed none; the gate admits codex since P2.451)',
      );
      return {};
    }
    const steering = composeProjectCompactSteering(resources);
    if (!steering) return {};
    this.debug(`[Compaction] steering codex compact_prompt with ${steering.length} chars`);
    return { compactPrompt: steering };
  }

  /**
   * P3.301 — an agent definition that asks for `isolation` runs on codex WITHOUT
   * it, and until this method nothing said so.
   *
   * ## Why the report has to be here and not in the writer
   *
   * `buildCodexAgentRoles` (`codex-responses-adapter/src/config-writer.ts`)
   * reports every other field it cannot honour — a tool grant and a lowered
   * permission mode DENY the role by name, a foreign `model` is dropped with a
   * sentence — and reports nothing for `isolation` for a reason that looks like
   * completeness and is the opposite: `isolation` is absent from
   * `CodexAgentRoleDescriptor` ENTIRELY, so the writer never receives it and
   * has nothing to report. The full descriptors exist on exactly one side of
   * that boundary, which is this one.
   *
   * ## What is actually lost, which is why silence is wrong here
   *
   * `isolation: worktree` is an author's explicit request that the subagent run
   * against a scratch checkout rather than the user's own tree
   * (`sub-agents.md` § *Choose where a subagent runs*), and Pi honours it —
   * `runtime-agent-definition.ts` records that the spawner keys on
   * `isolation === 'worktree'`. On claude the SDK accepts the field
   * (`claude-runtime-agents.ts`). So the SAME definition edits a throwaway
   * worktree on two runtimes and the real repository on the third, with nothing
   * on screen or in the log to say the difference exists — the silent-divergence
   * class this plan treats as its largest defect.
   *
   * Same channel and same wording family as its three siblings, deliberately:
   * this is per-DEFINITION and a session can carry many, so it stays on the
   * diagnostic channel rather than the eight-deep operator queue (the same
   * bound P3.267 respects for the per-entry families).
   */
/**
   * P6.309 (2) — the EIGHT declared subagent fields codex cannot express, named
   * per definition instead of vanishing.
   *
   * ## Why here and not in the writer
   *
   * `CodexAgentRoleDescriptor` does not carry them AT ALL — `config-writer.ts`'s
   * role docblock lists `maxTurns`, `memory`, `background`, `color`, `tier`,
   * `skillKeys`, `mcpServerKeys` and `initialPrompt` as fields with "no codex
   * counterpart and no authority to widen", dropped before the writer sees them.
   * So the writer cannot report what never reaches it, exactly as P3.301 found
   * for `isolation`; the full definitions exist on this side of the boundary and
   * on no other.
   *
   * ## What each loss actually is, because "dropped" is not one thing
   *
   * `maxTurns` and `background` are BOUNDS the author asked for and codex has no
   * key for: a child runs unbounded, in the foreground of its parent turn.
   * `memory` names a per-child store — Pi and the claude SDK each give the child
   * its own; on codex the child has none. `tier` and `color` are a model tier and
   * a label. `skillKeys` and `mcpServerKeys` are the child's declared SURFACE,
   * and their fuller answers are P6.309(1) and P6.342's own; naming them here is
   * the honest floor, not a claim that they are solved.
   *
   * ## Shape, copied from its two siblings deliberately
   *
   * Per-definition `debug` lines (the developer's detail) plus ONE aggregated
   * operator notice however many definitions are affected — the eight-deep queue
   * P3.267 respects, and the reason P3.337 aggregated the isolation family.
   * Silent when nothing declares any of them, which is the rule every diagnostic
   * on this path follows: a line that always prints is a line nobody reads.
   */
  private reportUnexpressibleCodexAgentFields(): void {
    const affected: string[] = [];
    for (const definition of this.config.piRuntimeAgentDefinitions ?? []) {
      const declared: string[] = [];
      if (definition.maxTurns !== undefined) declared.push(`maxTurns=${definition.maxTurns}`);
      if (definition.memory !== undefined) declared.push(`memory=${definition.memory}`);
      if (definition.background !== undefined) declared.push(`background=${definition.background}`);
      if (definition.color !== undefined) declared.push(`color=${definition.color}`);
      if (definition.tier !== undefined) declared.push(`tier=${definition.tier}`);
      if (definition.skillKeys?.length) declared.push(`skills=${definition.skillKeys.length}`);
      if (definition.mcpServerKeys?.length) {
        declared.push(`mcpServers=${definition.mcpServerKeys.length}`);
      }
      if (definition.initialPrompt !== undefined) declared.push('initialPrompt');
      if (declared.length === 0) continue;
      this.debug(
        `Imported agent ${definition.key} declares ${declared.join(', ')}, which codex's `
        + '[agents.<role>] table has no counterpart for; the role is declared without them',
      );
      affected.push(`${definition.key} (${declared.join(', ')})`);
    }
    if (affected.length === 0) return;
    this.surfaceCodexOperatorNotice(
      `codex-agent-roles-unexpressible: ${affected.length} agent definition`
      + `${affected.length === 1 ? '' : 's'} declare fields codex's [agents.<role>] table cannot `
      + `express, and the roles are declared without them: ${affected.join('; ')}. `
      + 'A per-child turn cap, a background flag, a memory store, a model tier, declared skills and '
      + 'declared MCP servers all bind on Pi and on claude and bind nothing here — the child runs '
      + "with this session's own bounds and surface instead.",
    );
  }

    private reportDroppedCodexAgentIsolation(): void {
    const dropped: string[] = [];
    for (const definition of this.config.piRuntimeAgentDefinitions ?? []) {
      if (!definition.isolation) continue;
      this.debug(
        `Imported agent ${definition.key} declares isolation "${definition.isolation}", which codex `
        + 'has no counterpart for; the role runs in this session\'s own working directory instead',
      );
      dropped.push(`${definition.key} ("${definition.isolation}")`);
    }
    // P3.337 · the isolation family joins the drop family on the SAME channel,
    // and for the same reason P3.301 could not: it is now ONE line however many
    // definitions declare it, so it costs one of the eight notices rather than
    // one per agent. The per-definition `debug` lines above are unchanged — they
    // are the detail a developer reads; this is the fact a user needs.
    if (dropped.length === 0) return;
    this.surfaceCodexOperatorNotice(
      `codex-agent-roles-dropped: ${dropped.length} agent definition${dropped.length === 1 ? '' : 's'} `
      + `declare isolation codex has no counterpart for and run in this session's own working `
      + `directory instead of a scratch checkout: ${dropped.join(', ')}. `
      + 'On the Pi runtime the same definitions get their own worktree, so an agent that edits '
      + 'files behaves differently here — this is a per-runtime difference rather than a fault.',
    );
  }

  /**
   * **P6.167 — say which `.claude` settings families this codex session honours.**
   *
   * ## The premise the ledger had backwards
   *
   * Ledger L1 read `absent` for codex — *a user's `.claude/settings.json` does
   * nothing here*. Measured at HEAD it is false for the family that matters most:
   * `capabilities/native-sources.ts` pushes both settings files as project/local
   * PERMISSION records with `sourceTier: 'portable'` and no provider gate,
   * `permissions-config.ts` recognises the Claude-shaped `permissions` block
   * before the Nessy schema runs, and this class calls
   * `consultPermissionRules(...)` on its own approval path. So the allow/ask/deny
   * rules a user wrote DO bind a codex session.
   *
   * What was true is that nothing said which of the OTHER families do, and they
   * differ from each other — projected, host-enforced, unprojectable, refused.
   * `CLAUDE_SETTINGS_CODEX_PROJECTION` carries one verdict per family with its
   * reader and its reason; this method is the surface.
   *
   * ## Why it reads the files' KEYS rather than their values
   *
   * The point is to name what THIS project asked for and did not get. A table
   * printed unconditionally would be a line nobody reads (the bound every
   * diagnostic in the writer respects), and a value-comparing version would need
   * every family's reader imported here for no gain — the loss is the same
   * whatever the value is. Top-level keys are exactly the question *which
   * families did this user write?*
   *
   * Deliberately silent about `projected` and `host-enforced` families: telling a
   * user that a setting which takes effect identically on all three runtimes "is
   * not projected" is the false-divergence direction, and it teaches the reader
   * to distrust the lines that are true.
   *
   * ## Bounds
   *
   * Latched per agent, like {@link noteCodexRequirementClock}. Structurally
   * no-throw and size-capped: a settings file is JSONC and may be absent,
   * unreadable, enormous or malformed, and a channel that exists to end a silence
   * must not be able to create a new one. A file we cannot parse yields no keys,
   * which is the same outcome as a file with none — correct, because an
   * unparseable settings file is not honoured by any family's reader either.
   */
  private claudeSettingsProjectionNoted = false;

  /**
   * P6.344 — the model's own clarifying questions, on the same permission
   * channel an MCP elicitation rides.
   *
   * A SECOND instance of the shared bridge rather than a reuse of
   * `BaseAgent.elicitationAsk`, exactly as `ClaudeAgent.modelQuestionAsk` is:
   * the class carries everything both need — the documented batch validation,
   * the `askUserQuestionTimeout` stamp, the `dontAsk` refusal, answer
   * validation, cancel-and-settle — but the id prefix is what a log reads back,
   * and a model question filed under `mcp-elicit-…` is a lie the next person
   * debugging this has to unlearn.
   */
  private readonly modelQuestionAsk = new ElicitationAskUserBridge({
    idPrefix: 'codex-ask', withdraw: requestId => this.withdrawElicitationDialog(requestId),
    surface: request => this.surfaceElicitationDialog(request),
    permissionMode: () => this.getPermissionMode(),
    timeoutMs: () => getAskUserQuestionTimeoutMs(),
  });

  /**
   * P6.344 — answer codex's `item/tool/requestUserInput` with a real user's
   * answer instead of `{ answers: {} }`.
   *
   * ## What was wrong
   *
   * The bridge already RECEIVED this request and answered an empty map, saying
   * on the degrade sink that "this runtime has no question surface". It had one:
   * the host renders the identical card for Pi and for claude. So a codex turn
   * that wanted to ask a clarifying question was told nobody was there, on a
   * product where somebody was.
   *
   * ## The mapping, field by field, and where it is LOSSY
   *
   * `ToolRequestUserInputQuestion` is `{ id, header, question, isOther,
   * isSecret, options }` and `AskUserQuestionItem` is
   * `{ question, header, options, multiSelect }`. Three notes:
   *
   * - `isOther` is codex's "the user may write their own answer", which is
   *   `allowFreeText` here. It is read off the FIRST question for the legacy
   *   single-question projection and honoured per question by the batch form.
   * - `isSecret` is REFUSED rather than approximated. Our card renders an answer
   *   into the transcript, and a secret typed into it would be persisted in
   *   clear — so a question marked secret declines the whole request with a
   *   named reason rather than collecting one.
   * - `multiSelect` has no counterpart on codex's question and is left unset;
   *   the response type (`answers: string[]`) would carry several, but nothing
   *   on the request says whether several are allowed, and offering a
   *   multi-select the model did not ask for changes what it is told.
   *
   * ## The answer, mapped back BY ID
   *
   * `ToolRequestUserInputResponse.answers` is keyed by question ID; the batched
   * `AskUserAnswer` is keyed by question TEXT (`user-input.md`'s own envelope).
   * The text→id map is rebuilt from the request rather than assumed positional,
   * because a user may answer a subset and an index would then shift.
   *
   * ## Every failure is a well-formed empty answer, never a throw
   *
   * A refusal, a timeout, a malformed request and a `dontAsk` session all end at
   * `{ answers: {} }` — codex's own "nothing was answered" — with the reason on
   * the degrade sink. Throwing here would leave the app-server waiting on a
   * frame it cannot parse, which is strictly worse than a declined question.
   */
  private async handleCodexRequestUserInput(params: unknown): Promise<Record<string, unknown>> {
    const empty = { answers: {} };
    const request = (params ?? {}) as CodexRequestUserInputParams;
    const questions = Array.isArray(request.questions) ? request.questions : [];
    if (questions.length === 0) {
      this.reportDegradedApproval('item/tool/requestUserInput carried no question');
      return empty;
    }
    if (questions.some(question => question?.isSecret === true)) {
      this.reportDegradedApproval(
        'item/tool/requestUserInput declined: a question is marked secret, and this card renders '
        + 'the answer into the transcript',
      );
      return empty;
    }
    if (!this.onPermissionRequest) {
      this.reportDegradedApproval('item/tool/requestUserInput declined: no user is attached to this session');
      return empty;
    }

    const items: AskUserQuestionItem[] = questions.map((question): AskUserQuestionItem => ({
      question: question.question,
      ...(question.header ? { header: question.header } : {}),
      options: (question.options ?? []).map(option => ({
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
      })),
    }));
    const byText = new Map<string, string>();
    for (const question of questions) byText.set(question.question, question.id);

    const first = questions[0]!;
    const askUser: AskUserPermissionRequest = {
      question: first.question,
      options: (first.options ?? []).map(option => option.label),
      allowFreeText: first.isOther === true,
      questions: items,
    };

    let answer: AskUserAnswer;
    try {
      answer = await this.modelQuestionAsk.ask(askUser);
    } catch (error) {
      this.reportDegradedApproval(
        `item/tool/requestUserInput unanswered: ${error instanceof Error ? error.message : String(error)}`,
      );
      return empty;
    }

    const answers: Record<string, { answers: string[] }> = {};
    if (answer.type === 'batched') {
      for (const [text, value] of Object.entries(answer.answers)) {
        const id = byText.get(text);
        if (!id) continue;
        answers[id] = { answers: Array.isArray(value) ? value : [value] };
      }
      // `response` is the documented freeform reply that REPLACES the per-question
      // list. Codex has no field for it, so it is attached to the first question
      // rather than dropped — the model asked, and a user who typed a sentence
      // instead of picking is answering.
      if (answer.response && Object.keys(answers).length === 0) {
        answers[first.id] = { answers: [answer.response] };
      }
    } else {
      answers[first.id] = { answers: [answer.value] };
    }
    return { answers };
  }

  private noteClaudeSettingsProjection(): void {
    if (this.claudeSettingsProjectionNoted) return;
    this.claudeSettingsProjectionNoted = true;
    // The reader moved to `claude-shell-command-settings.ts` when P6.254 needed
    // the same two files on the claude path: the loop, the two filenames and the
    // 1 MiB ceiling are unchanged, and one copy is what keeps the two runtimes
    // reading the same thing.
    const keys = readClaudeProjectSettingsKeys(this.workingDirectory);
    if (keys.length === 0) return;
    // C3.304 — the shell-command refusal that used to be spread in here left
    // with the user scope C3.49 had added FOR it. The reason was already written
    // one comment down: the refusal is "this product does not accept an
    // admin-supplied executable", a product ruling equally true on Pi and
    // claude, where this report is "codex cannot express this", a runtime fact
    // about one runtime. A product ruling stated on one runtime's path is a
    // product ruling two runtimes never state, so it moved to the host seam —
    // `packages/server-core/src/sessions/SessionManager.ts` symbol
    // `warnIfClaudeSettingsCarryRefusedKeys` — and this report kept the PROJECT
    // scope alone, because `~/.claude/settings.json` is not projected into a
    // project's config and reporting a projection that never happens is the
    // false-divergence `classifyClaudeSettingsFamilyKey`'s docblock warns about.
    for (const line of formatCodexClaudeSettingsProjectionDiagnostics(keys)) {
      this.debug(line);
      this.surfaceCodexOperatorNotice(line);
    }
  }

  /**
   * P6.95 — codex's FIRST use of the host's own post-init warning channel.
   *
   * `BaseAgent.postInit` returns `{ authInjected: true }` and codex inherited it
   * unchanged, which is why `grep -an 'postInit' codex-agent.ts` scored 0 over
   * the whole file. That inherited answer is reproduced here verbatim — codex's
   * auth is injected on the adapter, not here, and nothing about it moves.
   *
   * The window is read off `config.runtime` rather than off anything
   * `createRuntime` computes, so this does not depend on running first or
   * second: it is the SAME value `createRuntime` hands the writer at the
   * `contextWindow` key, and {@link buildCodexContextWindowWarning} applies the
   * writer's own exported predicate to it.
   */
  override async postInit(): Promise<PostInitResult> {
    return {
      authInjected: true,
      ...buildCodexContextWindowWarning(getBackendRuntime(this.config).contextWindow, this._model),
    };
  }

  /** Transactional runtime creation: every partial resource is rolled back. */
  private async createRuntime(): Promise<void> {
    // P6.145 · the three-runtime tool-search disposition report, which until this
    // row ran only inside `buildClaudeSubprocessEnv` — so a codex session emitted
    // no tool-search line at all, and the codex entry saying this knob CANNOT
    // reach codex (`state: 'unreachable'`, a measured refutation, not a gap) was
    // the one line a codex operator never saw. Same report, same words, no second
    // mechanism built beside it.
    reportToolSearchDisposition();
    const codexHome = this.newCodexHome(); // F1.652 · outside every agent-writable root when one can be had — see the helper at the class end
    // P3.182 · 0700 IS A CONTROL, not housekeeping. Codex writes every tool
    // OUTPUT to `sessions/**/rollout-*.jsonl` at mode 0644 and offers no
    // redaction, no retention setting and no way to switch it off (measured
    // against the shipped binary — see `describeCodexRolloutPersistence`). This
    // line and the `rmSync` in `cleanupRuntimeResources` are the whole of the
    // containment; `codex-rollout-persistence.test.ts` pins both so neither can
    // be dropped as a tidy-up.
    chmodSync(codexHome, 0o700);
    // P3.296 · the one piece of codex's OWN durable state this per-session home
    // gives back: its identity. Everything else it writes here (five sqlite
    // databases, the re-extracted skills tree) is deliberately declined, with
    // the measured cost — see `resolveHostStableCodexInstallationId`.
    const installationId = resolveHostStableCodexInstallationId();
    if (installationId) {
      try {
        writeFileSync(join(codexHome, 'installation_id'), installationId, { mode: 0o600 });
      } catch (error) {
        // Never fatal: without it codex mints its own, which is what every
        // session did before this line existed.
        this.debug(`[codex home] could not seed installation_id: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // And SAY so, on the facts channel, because an unstated control is
    // indistinguishable from an absent one to the operator who has to answer
    // for it.
    this.recordSessionFact('codex-rollout-persistence', describeCodexRolloutPersistence(codexHome));
    // C3.285 · and say which of the user's permission rules codex's own
    // approval path cannot consult, on the same channel and for the same
    // reason: an unstated narrowing is indistinguishable from an absent one.
    this.noteUnboundPermissionRules();
    let adapter: AdapterHandle | null = null;
    let manager: CodexRuntimeManager | null = null;
    let client: AppServerClient | null = null;
    let callbackBridge: CodexSessionCallbackBridgeHandle | null = null;

    // P6.532 · resolved BEFORE the adapter, because it decides whether there is
    // one. A session whose connection declared its own `model_provider` routes
    // to that provider directly, so the loopback adapter has nothing to serve:
    // starting it would bind a port and hold this connection's credential for a
    // route the written config does not even mention (the writer suppresses the
    // `[model_providers.*]` table for a declared session, and that table is
    // `adapterPort`'s only reader).
    const declaredModelProvider = this.declaredCodexModelProvider();

    try {
      // In gateway mode the adapter reads the JWT itself (readNestorJwt); a BYO
      // upstream carries its own bearer credential. COMPANY_LLM_API_KEY is a
      // placeholder codex forwards but the adapter ignores either way.
      this.startupPhase = 'starting the local model adapter';
      // P6.532 · a declared session starts no adapter, so the progress line must
      // not claim to be starting one — it is the only thing the user sees while
      // a slow spawn is in flight.
      if (declaredModelProvider) this.startupPhase = 'routing to the declared model provider';
      // `null` for a declared session, so no credential is resolved either — the
      // upstream this host would have proxied is not on the path at all.
      const upstream = declaredModelProvider ? null : await this.resolveUpstream();
      // P6.180 · the operator header channel is NARROWER here than on Pi, and
      // until this row that was true silently: an operator set
      // `NESSY_CUSTOM_HEADERS`, watched it work on a Pi session, and got nothing
      // on this one with no way to find out. The narrowing itself stands — see
      // the notice builder — so what lands is the sentence, on the durable
      // channel a packaged build writes. Names only, never values.
      const customHeaderNotice = upstream ? customHeadersOffGatewayNotice('Codex', upstream) : undefined;
      if (customHeaderNotice) this.surfaceCodexOperatorNotice(customHeaderNotice);
      // DA1.22 — read ONCE, here, and closed over by `generationDefaultsForModel`
      // below: the catalogue moves at refresh rather than mid-turn, and a config
      // read on every request of every session would be a real cost for a value
      // that does not move. Same slug `resolveUpstream` authenticates with.
      const adapterConnection = this.config.connectionSlug
        ? getLlmConnection(this.config.connectionSlug)
        : null;
      adapter = upstream ? await startAdapter({
        upstream,
        // The adapter runs IN-PROCESS, so the stderr its Pi twin writes to has
        // no reader here. Recording the scheme on the agent puts it where the
        // session's own diagnostics already live — the same accessor a driver
        // reads for the Pi path. Scheme only, never the credential.
        onUpstreamAuth: (scheme) => this.recordUpstreamAuthScheme(scheme),
        // P2.422 — the same correlation seam as the claude runtime, and for the
        // same reason: the codex app-server child talks to a loopback port, and
        // the host that makes the real gateway request serves many sessions from
        // one process, so a process-wide `NESSY_SESSION_ID` could not name this
        // one. The id travels as an argument instead.
        //
        // `this.config.session?.id` rather than any synthesized fallback: an
        // absent session must send NO header, not a fabricated one the gateway
        // would aggregate under. Scope stays where it belongs — inside
        // `gatewayRequestHeaders`, which stamps the verified gateway prefix and
        // nothing else, so this loopback hop and a BYO upstream both stay bare.
        fetchImpl: gatewaySessionFetch(this.config.session?.id),
        /**
         * DA1.22 — the generation config THIS MODEL'S catalogue row published.
         *
         * Owner decision 2026-09-17: adopt the gateway's own `reasoning.effort`
         * and `sampling_params`. Applied by the adapter as DEFAULTS only.
         *
         * THIS is the runtime the effort half was born for. The shipped
         * `codex-app-server` sends a `reasoning` object on every request and, with
         * `model_reasoning_effort` unset, sends it with NO `effort` member at all
         * (the control arm driven against the binary on 2026-09-03, recorded on
         * `ResponsesRequest.reasoning` in `to-chat.ts`) — so a gateway model whose
         * row recommends an effort, on a session that named none, is the ordinary
         * case here and was the silent drop DA1.16 went looking for. A user who
         * HAS chosen an effort keeps it: the config key fills `reasoning.effort`
         * and the first branch of the adapter's precedence takes it.
         *
         * The connection is read ONCE here rather than per request: the catalogue
         * moves at refresh, not mid-turn, and `this.config.connectionSlug` is the
         * same slug `resolveUpstream` authenticates with.
         */
        generationDefaultsForModel: (model: string) => resolveModelGenerationDefaults(adapterConnection, model),
        /**
         * P3.363 (W5-c's row, wired here on hand-off) — upgrade the
         * model-target disclosure from "every MCP tool schema this session
         * exposes" to the names actually on the wire.
         *
         * The adapter reports and the host classifies: that package is the
         * dependency root of the pair and cannot import `@nessy-agent/shared`,
         * so `onOutboundTools` hands up names and this closure is where the
         * endpoint is known.
         *
         * `baseUrl` is omitted for the built-in gateway, deliberately rather
         * than defaulted: `classifyModelTarget` answers `provider-default`,
         * `restricted: false` for an absent endpoint, which is the honest
         * verdict for a target that carries no endpoint of its own — and the
         * gateway is unrestricted under either spelling.
         *
         * WAS A MEASURED LIMIT, AND IS NOT ONE ANY MORE (DA2.6, 2026-09-14).
         * W5-b measured that `noteModelTargetToolEgress` deduped on
         * `(class, host, model-namespace)` with no tools/no-tools distinction,
         * and that `backend/factory.ts` claims that key at BACKEND CONSTRUCTION
         * — before any turn, with no names — so this call was correct and
         * permanently SUPPRESSED. The tier it was waiting for landed the SAME
         * DAY, in `89f28509e`: the key in
         * `backend/internal/drivers/upstream-target.ts` symbol
         * `noteModelTargetToolEgress` now carries a fourth ` +tools` term, so
         * the unnamed notice and the named one are two keys and this call
         * EMITS. One strictly-more-informative notice per target is the intent:
         * the unnamed one once, the named one once.
         *
         * The sentence above is kept rather than deleted because it was read as
         * a live limitation of a DIFFERENT module for long enough to reach a
         * plan row, and a reader who meets the old claim elsewhere needs to find
         * its withdrawal here. `upstream-target.test.ts` pins the two-notice
         * behaviour, which is the guard this comment never had.
         */
        onOutboundTools: (info) => {
          noteModelTargetToolEgress({
            ...(upstream.kind === 'nestor' ? {} : { baseUrl: upstream.baseUrl }),
            model: info.model,
            toolNames: info.toolNames,
            // DA2.15 — the host's ONE sink, the same field `factory.ts` passes
            // at backend construction and `claude-agent.ts` passes at its own
            // outbound-tools seam. Absent leaves the helper's `console.warn`.
            emit: this.config.onModelTargetDisclosure,
          });
        },
      }) : null;
      if (this.destroyed) throw new Error('codex-agent-destroyed');
      if (adapter && upstream) {
        this.debug(`Codex adapter listening on 127.0.0.1:${adapter.port} (upstream: ${upstream.kind})`);
      } else {
        // P6.532 · on the durable operator channel as well as `debug()`, for the
        // reason P2.280 measured on this class: a packaged build disables the
        // electron-log transports, so a session that routes somewhere other than
        // this host's own adapter would otherwise say so nowhere at all.
        const line = `[Model provider] this connection declares codex's own \`${declaredModelProvider}\` provider, `
          + 'so the session routes there directly and the local Responses adapter is not started. '
          + (declaredModelProvider === CODEX_BEDROCK_MODEL_PROVIDER ? `Turn the card off with ${CODEX_BEDROCK_CARD_ENV_VAR}=0 to restore the loopback pin.` : 'It is the ChatGPT (Codex) card (F1.202): codex signs in with this connection\'s own ChatGPT sign-in.');
        this.recordSessionFact('codex-declared-model-provider', line);
        this.debug(line);
      }
      // T5 — before `writeCodexConfig`, because its port becomes an argv entry
      // in the `[mcp_servers.session]` block that config writes.
      callbackBridge = (await this.startCallbackBridge()) ?? null;
      if (this.destroyed) throw new Error('codex-agent-destroyed');
      // P2.450 · resolved ONCE per runtime build, because the same answer decides
      // two things that must never disagree: what `[otel]` says and whether the
      // child carries a coverage marker. A marker on a child that exports nothing
      // would be a claim that a stream exists.
      const otelExport = resolveCodexOtelExport();
      // P6.179 · ON THE DURABLE OPERATOR CHANNEL, not `debug()`. Every arm of
      // `resolveCodexOtelExport` that declines — the `OTEL_EXPORTER_OTLP_HEADERS`
      // refusal, an unparseable endpoint, and a scheme/credential refusal, THREE
      // and not the two the row counted — ends a configured telemetry pipeline
      // for this session. `debug()` routes through electron-log, whose transports
      // the packaged main process disables, so on a shipped build an operator who
      // had configured a collector saw nothing at all and had no way to tell a
      // refusal from a silent exporter. `surfaceCodexOperatorNotice` is the one
      // event family the session layer persists, so the sentence survives a
      // reload; it queues for the next turn when no turn is open, which is always
      // the case here (this runs inside the runtime build).
      if (otelExport.notice) this.surfaceCodexOperatorNotice(otelExport.notice);
      // P3.301 · before the config is written, because the writer never sees the
      // field this reports. See the method.
      this.reportDroppedCodexAgentIsolation();
      // P6.309 (2) · its seven siblings, for the same reason and on the same two
      // channels. See the method.
      this.reportUnexpressibleCodexAgentFields();
      // P6.146 · and the ceiling this runtime does NOT honour, said once per
      // runtime build beside the one it does. See the method.
      this.noteUnhonouredBashTimeoutCeiling();
      // P6.156 codex arm · and which bundled agents' declared model TIER this
      // session cannot resolve, said once beside the two ceilings above. See
      // the method.
      this.noteBuiltinAgentTiersOnce();
      const planModeThinkingLevel = this.planModeThinkingLevel();
      // P6.309 (1) · a codex role that names a skill gets the skill's BODY.
      //
      // Until this row it got the name and nothing else: the machinery existed,
      // claude-named, and codex was simply not a caller. The descriptors handed
      // to `writeCodexConfig` below are the SAME ones the Claude backend hands
      // the SDK, so prepending each skill's blocks to the descriptor's
      // `systemPrompt` here gives codex the same body — one implementation, two
      // callers, rather than a second projection to keep in step.
      //
      // The narrowed `tools`/`disallowedTools` ride along DELIBERATELY. codex has
      // no per-role tool policy, so `buildCodexAgentRoles` records any descriptor
      // carrying them as an unhonoured grant (P6.485) and says so out loud.
      // Stripping them would hand the child a wider surface than its skill
      // declares AND remove the sentence that admits it.
      const codexAgentDefinitions = await this.materializeCodexAgentSkills();
      writeCodexConfig({
        codexHome,
        model: this._model,
        // C4.11 · the effort pair rides the config.toml the thread OPENS with,
        // not only the per-turn fork override — otherwise the very first turn
        // would find a drifted `shell_environment_policy` and fork before the
        // user's first word. See {@link codexShellEffortEnvironment}; the
        // signature seeded at the end of this method passes the SAME value, so
        // the two descriptions of the open thread agree.
        shellEnvironment: this.codexShellEffortEnvironment(),
        ...(otelExport.logsEndpoint ? { otelLogsEndpoint: otelExport.logsEndpoint } : {}),
        // P6.459 arm (1) · codex's own spans, under the same gate.
        ...(otelExport.tracesEndpoint ? { otelTracesEndpoint: otelExport.tracesEndpoint } : {}),
        // P6.488 · literals on disk, and only behind the named opt-in — the
        // resolver above is the only thing that can produce this field.
        ...(otelExport.otlpHeaders ? { otelLogsHeaders: otelExport.otlpHeaders } : {}),
        // config.toml is read when app-server STARTS, and nothing here respawns
        // it on a model switch — `setModel` only updates `_model`, and the
        // subsequent `thread/fork` carries the new model but not a new config
        // layer. So a mid-session switch leaves this window stale until the next
        // runtime start. Accepted rather than papered over: respawning the
        // app-server on every model change would drop the running thread.
        ...(typeof getBackendRuntime(this.config).contextWindow === 'number'
          ? { contextWindow: getBackendRuntime(this.config).contextWindow as number }
          : {}),
        // P3.234 · the host's ONE auto-compaction policy, delivered to every
        // backend as `BackendConfig.autoCompaction` since P6.53 and, until this
        // row, read by every backend except this one. A user who turned
        // auto-compaction off and switched a session to codex kept it on — the
        // same setting-silently-reversed shape P6.53 fixed on claude.
        //
        // The writer withholds BOTH `model_context_window` and
        // `model_auto_compact_token_limit` for it; `CodexConfigOptions
        // .autoCompactionEnabled` carries the source measurement for why the
        // window has to go too.
        autoCompactionEnabled: this.config.autoCompaction?.enabled !== false,
        thinkingLevel: this._thinkingLevel,
        // P6.368 · codex's own plan-phase effort. Omitted unless the operator
        // named one — see {@link CodexAgent.planModeThinkingLevel}.
        ...(planModeThinkingLevel ? { planModeThinkingLevel } : {}),
        // P6.532 · both conditional and mutually exclusive by construction: a
        // declared session has no adapter to name a port for, and the writer
        // refuses an ordinary session that omits it.
        ...(adapter ? { adapterPort: adapter.port } : {}),
        ...(declaredModelProvider ? { declaredModelProvider } : {}),
        mode: this.getPermissionMode(), ...this.codexProjectTrustOptions(), // F1.750 — the host's project trust as codex's own trust entry, so codex never auto-trusts
        sandboxGloballyEnabled: this.sandboxGloballyEnabled(),
        // P3.2 · the inertness fix — read the codex auto-review setting and hand
        // the writer the fields it emits. OFF (default) → `{}`, so config-writer
        // emits nothing; ON → `approvals_reviewer = "auto_review"` (+ optional
        // `[auto_review].policy`), still subject to the writer's interactive-
        // policy eligibility gate.
        ...this.noteConfiguredApprovalsReviewer(buildCodexAutoReviewOptions(getCodexAutoReviewEnabled(), getCodexAutoReviewPolicy())),
        // C3.109 · the caller `CodexConfigOptions.subagentsEnabled`'s docblock
        // said did not exist. Passed UNCONDITIONALLY and filtered THERE: the
        // writer honours only an explicit `false`, so an operator who has not
        // set the key gets a byte-identical config.toml.
        subagentsEnabled: getCodexSubagentsEnabled(),
        // P2.436 · steer WHAT compaction preserves, through codex's own
        // `compact_prompt`. See `codexCompactPromptOption`.
        ...this.codexCompactPromptOption(),
        // P3.348 · the host output ceiling an operator set explicitly, in
        // codex's own unit. See `codexToolOutputTokenLimitOption`.
        ...this.codexToolOutputTokenLimitOption(),
        // P3.347 · the two subagent ceilings, likewise explicit-only. See
        // `codexSubagentCeilingOptions`.
        ...this.codexSubagentCeilingOptions(),
        // P6.273 · the operator's retry ceiling and streaming idle deadline, in
        // codex's own `[model_providers.*]` vocabulary, likewise explicit-only.
        // See `codexProviderRetryOptions`.
        ...this.codexProviderRetryOptions(),
        // P6.140 · the MCP tool wall clock: `sources` explicit-only; `session`
        // always carries the UA12.24 card-window floor. See
        // `codexMcpToolTimeoutOption` for the margin and the floor's derivation.
        ...this.codexMcpToolTimeoutOption(),
        // P6.166 · the host's auto-memory OFF switch, in codex's own
        // `[memories]` vocabulary. See `codexMemoriesOption`.
        ...this.codexMemoriesOption(),
        // P6.534 · the host bundled-skills switch, in codex's own
        // `[skills.bundled]` vocabulary. See `codexBundledSkillsOption`.
        ...this.codexBundledSkillsOption(),
        // P6.155 · the connection's served cheap model, in codex's own
        // `[agents] default_subagent_model`. See `codexDefaultSubagentModelOption`.
        ...this.codexDefaultSubagentModelOption(),
        sessionMcp: this.buildSessionMcpSpec(callbackBridge?.port),
        poolMcpUrl: this.config.poolServerUrl, webSearchAllowedDomains: resolveWebSearchAllowedDomains(), // F1.570 — written only where codex's own search is on
        readOnlyPaths: this.codexReadOnlyPaths(), // F1.670; F1.678 — the host writes no exact deny any more
        // P3.175 · the `deniedPaths` credential floor, mirrored onto codex's own
        // OS-enforced deny map. Defence in depth: our gate still runs first.
        deniedReadPatterns: this.credentialFloorPatterns(),
        // P3.369 · the user's added directories, as `filesystem: {<path>:'write'}`
        // entries in the session's permission profile. Until this line the host
        // gate said yes and the subprocess was never told. See
        // `codexAdditionalWritableRoots` for the three fail shapes it filters.
        writablePaths: this.codexWritablePaths(), // F1.1003 — plus the session's plans/data folders in plan and explore
        // C3.343 · the host's protected-path floor, in codex's own
        // `":workspace_roots"` vocabulary. See
        // `codexProtectedWorkspaceSubpaths` for why the LIST travels and the
        // decision does not, and `CodexConfigOptions.protectedWorkspaceSubpaths`
        // for what the shipped binary does with and without it.
        protectedWorkspaceSubpaths: this.codexProtectedWorkspaceSubpaths(),
        // Project the durable Always-Allow grants from the workspace store into
        // `CODEX_HOME/rules/`. Re-derived here on every runtime build (spawn and
        // the mode-change respawn), which is what makes a grant survive both.
        execpolicyAllowPrefixes: this.collectExecpolicyAllowPrefixes(),
        // …and the DENY half, projected as `decision="forbidden"` (P2.141b).
        // Defence in depth: it refuses one layer earlier than our own gate for
        // the un-wrapped common case, and cannot carry the guarantee, because a
        // single malformed line drops every rule in the file and codex does not
        // split a script using `$FOO`/`*`/`$(…)`/redirects. The floor that DOES
        // carry it is `findNonNegotiableFloors`, on the approval path above.
        execpolicyDenyPrefixes: this.collectExecpolicyDenyPrefixes(),
        // …and the MIDDLE tier, projected as `decision="prompt"` (P6.1). The
        // `ask` action was the one the DSL had and codex was never told about:
        // it works for every call codex asks about, and decided nothing for the
        // calls codex auto-approves — which includes every command our own
        // `decision="allow"` grants exist to let it "bypass approval".
        execpolicyPromptPrefixes: this.collectExecpolicyPromptPrefixes(), ...noteCodexMcpLeverBuild(this, this.codexMcpRuleProjection(await this.codexMcpRuleCatalogue()), codexConfigFollowsCodexWebSearch({ declaredModelProvider })), // F1.378, F1.482 (2); F1.1019 — recorded for the turn-head re-fork
        // The session's agent definitions become `[agents.<role>]` blocks plus
        // one role layer each. Same descriptors the Claude backend hands the
        // SDK's `agents` option and the Pi backend ships over its wire, so one
        // agent answers to one name on all three runtimes — `writeCodexConfig`
        // reads the subset codex can express and denies the rest by omission.
        //
        // `SessionManager` only materializes these when
        // `AGENT_DEFINITION_RUNTIMES` admits the provider, so the two sides are
        // one decision: a runtime dropped from that set stops receiving
        // definitions AND stops having its catalog rows called active.
        ...(codexAgentDefinitions
          ? { agents: codexAgentDefinitions }
          : {}),
        // P2.414 · codex's own inline `[hooks]` table, fed ONLY by hooks the
        // host itself authored — the owner's boundary is AUTHORSHIP, and it is
        // enforced where the plan is CONSTRUCTED, not here. This spread is `{}`
        // today (the host authors none), which keeps the config byte-identical;
        // what it always does is SAY so, because an absent `[hooks]` table reads
        // as "this session has no hooks" and that is false.
        ...this.hostAuthoredHookProjection(codexHome),
        // A denial is never fatal and never silent. This is the same channel
        // the adapter's own port line goes to, so an agent that did not become
        // a role says so beside the runtime it was dropped from.
        onDiagnostic: (message) => {
          this.debug(message);
          // P3.267 · "never silent" was true of the CHANNEL and false of the
          // BUILD: `debug` writes nothing on a packaged app. The two families
          // that describe what this session can and cannot do — the sandbox
          // egress denial and the execpolicy grant note — reach the user, on
          // the same queue and in the same shape as P3.120's sibling.
          this.noteCodexConfigWriterDiagnostic(message);
        },
      });
      // P3.234 · give the context meter a denominator from turn zero.
      //
      // THE PREMISE THIS COMMENT WAS WRITTEN UNDER IS GONE, and saying so is the
      // point: it read *"keep the context meter alive when the window key was
      // withheld"*, from the first fix, which withheld `model_context_window` on
      // the auto-compaction-off path. That withholding was retracted (P3.286 —
      // it made codex fall back to a fabricated 272 000, above the gateway's
      // published window), so the key is now written in BOTH switch positions
      // and codex's own `thread/tokenUsage/updated` reports a window on every
      // path. The seeding below is nonetheless KEPT and is still correct: that
      // notification arrives after the first turn, so without it the meter has
      // no denominator until then.
      //
      // `thread/tokenUsage/updated`'s `modelContextWindow` is this agent's ONLY
      // producer for `UsageTracker`'s window (the one `withCodexUsage` stamps on
      // every `complete`), and codex derives that figure from the
      // `model_context_window` the writer emits — the same catalogue number
      // seeded here, so the two agree by construction rather than by luck.
      //
      // Unconditional rather than gated on the off-switch, deliberately: codex's
      // own first usage notification overwrites this within the first turn on
      // every path, so the only difference is that the meter has a denominator
      // from turn zero instead of after the first
      // notification. The two numbers are not identical — codex reports
      // `window * effective_context_window_percent / 100` (default 95,
      // `openai_models.rs:910` / `turn_context.rs:304`), its own usable-capacity
      // reserve — and that 5% is codex's to state, not ours to restate here.
      const hostContextWindow = getBackendRuntime(this.config).contextWindow;
      if (typeof hostContextWindow === 'number' && Number.isFinite(hostContextWindow) && hostContextWindow > 0) {
        this.usageTracker.setContextWindow(Math.floor(hostContextWindow));
      }
      if (this.config.autoCompaction?.enabled === false) {
        // P3.234 · this line used to claim BOTH window keys were withheld AND
        // that codex therefore never auto-compacted. Both clauses were measured
        // false. (The retracted sentence is described rather than quoted, so
        // `codex-auto-compaction-off-diagnostic.test.ts` can assert its absence
        // from this file — a pin that quotes what it forbids cannot fail.)
        //
        // The window key is now written in both switch positions (P3.286 — with
        // it withheld codex falls back to 272 000, above what the gateway
        // publishes), so only the LIMIT key moves with the switch. And
        // withholding that key never disabled anything:
        // `ModelInfo::auto_compact_token_limit()` is `min(config, window*9/10)`
        // and falls back to the 90 % term with no config key at all — driven on
        // the shipped binary, an OFF session compacted at 250 000 usage and did
        // not at 240 000, with both controls in the same run.
        //
        // So the honest sentence is what codex actually gives: a HIGHER trigger,
        // not none. A diagnostic that told an operator "never" would be the same
        // false assurance the config-writer's own docblock exists to retract.
        this.debug(
          '[codex] auto-compaction is set to OFF by host policy, and codex has NO off-switch: '
          + 'withholding model_auto_compact_token_limit raises the trigger from our 85% to codex\'s '
          + 'own 90% of the context window, which is the highest it will accept — it does not stop '
          + 'auto-compaction. model_context_window is still written, from the host model catalogue, '
          + 'so every limit codex derives stays inside the endpoint\'s real ceiling. '
          + 'The context meter is seeded from that same catalogue rather than waiting for codex\'s report.',
        );
      }
      // P6.96 · the two WINDOW knobs, which are a different question from the
      // off-switch above and had no answer at all on this runtime.
      //
      // `NESSY_AUTO_COMPACT_WINDOW` and `NESSY_AUTOCOMPACT_PCT_OVERRIDE` reach
      // `resolveAutoCompactionSettings` on every backend, and exactly two
      // runtimes consume them: Pi narrows to any value, claude to any value at
      // or above the SDK's 100 000 floor. Codex reads NEITHER. Its trigger is
      // the host's own `AUTO_COMPACT_WINDOW_FRACTION` over the catalogue window
      // — a constant, not a setting — so an operator who narrows the window
      // gets exactly what they would have got without the variable, and nothing
      // anywhere said so.
      //
      // On the transcript rather than to `debug`, for the reason the claude arm
      // records: a control that silently stops controlling is worse than one
      // that is absent. Over the notice channel this file already owns; the
      // ceiling and the hold-for-next-turn behaviour are that channel's.
      const knobs = this.config.autoCompaction;
      if (knobs?.enabled !== false && (knobs?.contextWindow !== undefined || knobs?.thresholdPercent !== undefined)) {
        const set = [
          knobs.contextWindow !== undefined ? `NESSY_AUTO_COMPACT_WINDOW=${knobs.contextWindow}` : null,
          knobs.thresholdPercent !== undefined ? `NESSY_AUTOCOMPACT_PCT_OVERRIDE=${knobs.thresholdPercent}` : null,
        ].filter((entry): entry is string => entry !== null).join(' and ');
        this.surfaceCodexOperatorNotice(
          `${set} has no effect on codex: it compacts at its own fraction of the model's context window `
          + 'whatever these are set to. Pi uses the values as written and Claude uses them too, but never '
          + 'narrows its window below 100000 tokens.',
        );
      }
      // P3.28 · the argv the config just written advertises — F1.116, where this
      // read one boolean off it.
      //
      // Re-derived from the same method rather than captured out of the options
      // literal above, because that expression is asserted as source TEXT by
      // `codex-callback-bridge-host.test.ts`. The two calls are adjacent and
      // SYNCHRONOUS — no `await` separates them — so they cannot read different
      // settings; the value is only assigned onto the agent below, once the
      // runtime is real. `undefined` spec (no session identity) reads as `null`:
      // there is no `[mcp_servers.session]` block to re-advertise, and the drift
      // check must not think there is one.
      const advertisedSessionMcpArgs = this.buildSessionMcpSpec(callbackBridge?.port)?.args ?? null;

      const otelResourceAttributes = codexTelemetryResourceAttributes(
        process.env,
        otelExport.logsEndpoint,
        // C4.25 · the HOST's session id, because codex has no identity switch
        // of its own to flip — see `withCodexTelemetryIdentity`. Gated there,
        // default OFF, on the one resolver all three runtimes read.
        this.config.session?.id,
      );
      // P6.535 (codex arm) · resolved before the spawn literal so the value is
      // a `string | undefined` local rather than a union of object shapes the
      // `Record<string, string>` parameter refuses.
      const codexSessionJobDir = ensureSessionJobDir(this.config.workspace.id, this._sessionId);
      this.startupPhase = 'starting the codex app-server';
      manager = new CodexRuntimeManager();
      const child = manager.spawn({
        binaryPath: this.resolveBinaryPath(),
        cwd: this.workingDirectory,
        codexHome,
        env: {
          [CODEX_API_KEY_ENV]: 'loopback',
          // C3.369 · the in-app Settings proxy, which is the ONLY proxy a codex
          // shell could not see.
          //
          // R6b measured `envSeen: []` inside a codex shell against claude's
          // seven names in the same run, and the row read that as "codex shells
          // are stripped". The source says otherwise, and the correction is what
          // makes this two lines instead of a config-writer feature:
          // `ShellEnvironmentPolicyInherit` (`codex-rs/protocol/src/config_types.rs`,
          // `rust-v0.150.1`) marks `All` — not `Core` — as `#[default]`, and
          // `ShellEnvironmentPolicy::default()` pairs it with
          // `ignore_default_excludes: true`. So codex hands a shell command the
          // WHOLE parent environment with no default excludes, and an ambient
          // `HTTPS_PROXY` from a corporate `.zshrc` already reached one, because
          // `CodexRuntimeManager.spawn` spreads `process.env`. What never
          // reached it is a proxy the user configured in Settings, which lives
          // in the stored config and in no environment at all — and that is
          // exactly the proxy claude's seven names came from.
          //
          // `runtime-manager.ts`'s own docblock had already named this and
          // declined it: *"the projection would add only the in-app Settings
          // proxy — and adding it is a REGRESSION unless loopback is exempted
          // first"*. That condition is now discharged twice over. The helper
          // exempts loopback itself, and `applyLoopbackNoProxy` runs on the
          // merged env immediately after this spread — which is also what
          // supplies codex's BARE `::1` spelling, the one that binary needs and
          // a bracket-only list never gives it.
          //
          // HERE and not in `runtime-manager.ts` for the reason the session-job
          // bullet below gives verbatim: that package cannot import
          // `@nessy-agent/shared` without closing a cycle, and `opts.env` is
          // spread into its env build unchanged.
          //
          // `buildShellChildNetworkEnv` is the shared helper W19-a built for
          // C3.382's Pi arm, called rather than copied — same precedence
          // (Settings over ambient), same `NODE_EXTRA_CA_CERTS` so a
          // TLS-inspecting proxy does not turn every `curl` the model runs into
          // a certificate error, and the same refusal to hand a
          // model-written command the app's mTLS identity. It returns `{}` when
          // no proxy is in effect, so a machine without one keeps a
          // byte-identical codex environment.
          ...buildShellChildNetworkEnv(),
          // P6.535 (codex arm) · the per-session scratch root, CREATED before
          // it is named. codex reads no name of its own (measured: nothing like
          // `CLAUDE_JOB_DIR` in `packages/codex-protocol`), so this is the
          // HOST-supplied equivalent the switch report names.
          //
          // It is set HERE and not in `runtime-manager.ts`'s env build, where
          // the row first scoped it, for a measured reason: `getSessionJobDir`
          // lives in `@nessy-agent/shared`, and `@nessy-agent/shared` already
          // imports `@nessy-agent/codex-agent-server` — the cycle that file's
          // own docblock records for `LOOPBACK_NO_PROXY_HOSTS`. Placing it
          // there would mean either a second copy of the path rule or a new
          // dependency edge; `opts.env` is spread into that build unchanged, so
          // the child receives it either way.
          ...(codexSessionJobDir ? { [SESSION_JOB_DIR_ENV_VAR]: codexSessionJobDir } : {}), ...bundledRipgrepPathEnv(process.env.PATH, getBackendRuntime(this.config).paths?.ripgrep), // F1.1301 · the bundled rg on the PATH every codex shell inherits; codex's own codex-path/ needs a package layout we do not ship
          ...(this.config.poolServerBearerToken
            ? { [CODEX_POOL_MCP_TOKEN_ENV]: this.config.poolServerBearerToken }
            : {}),
          // P2.450 · the coverage marker, on the OTLP RESOURCE by way of the
          // env — codex's `[otel].span_attributes` decorates TRACE SPANS only,
          // so it would be invisible on the log signal we project. This spawn
          // spreads `process.env`, so an operator's own value is what the helper
          // reads and never what it overwrites.
          ...(otelResourceAttributes ? { OTEL_RESOURCE_ATTRIBUTES: otelResourceAttributes } : {}),
        },
        // Verify the bundled binary's SHA against the manifest before spawn.
        platformDir: hostCodexPlatformDir(),
        // Corporate TLS interception: without this the codex child trusts the
        // OS store or nothing, while every other runtime verifies against the
        // app's CA — a session that works on Pi/Claude stops working on codex.
        ...(() => {
          const caCertificatePath = resolveCodexCaCertificatePath();
          // P3.38 · SAY what codex ends up trusting. The channel is the session
          // FACTS map, not `debug()`, for the reason that map exists: a standing
          // property of the session must answer the same on turn sixty as on
          // turn one, and `debug()` routes through electron-log, whose
          // transports the packaged main process disables. A support case
          // behind TLS interception starts here.
          this.recordSessionFact(
            'codex-ca-trust',
            describeCodexTrustDecision(process.env, caCertificatePath),
          );
          return caCertificatePath ? { caCertificatePath } : {};
        })(),
      });
      client = new AppServerClient(child, {
        // P6.459 arm (2) — the host's turn span, so codex's own app-server
        // spans parent to it instead of starting a second trace. Read through
        // the config on every request rather than captured: the span is a
        // property of the TURN and this client lives for the session.
        //
        // Absent when tracing is off — `AppServerClient` then sends no `trace`
        // key at all, which is the row's control. The codex source is why the
        // request field is the seam rather than the `TRACEPARENT` env var:
        // `app_server_tracing.rs:45-52`/`:129-140` make the request's `trace`
        // the PARENT of the app-server span, while the env fallback is a
        // process-wide `OnceLock` that cannot move per turn.
        resolveTraceparent: () => this.config.resolveTraceparent?.(),
        onDiagnostic: (m) => {
          this.debug(m);
          // P3.120 · the log line stays exactly where it was; this adds the
          // half a packaged build could never show. See
          // {@link noteCodexConfigWarningDiagnostic} — it filters to the one
          // classified family and ignores every other diagnostic on this
          // channel (stderr chunks, unparseable lines, unknown response ids).
          this.noteCodexConfigWarningDiagnostic(m);
          // P3.287 · THE NOTE FOR WHOEVER OPENS THE `/models` SEAM, left at the
          // binding that would have to carry it rather than in a plan row.
          //
          // A `/models` response codex cannot decode is an `ERROR` line on THIS
          // channel and nothing else — no `configWarning`, no notification —
          // and the session continues on fallback metadata, so a lane that
          // shipped a pass-through catalog would measure no effect and conclude
          // it worked. Measured by W2-d on the shipped binary, 2026-09-03:
          // `failed to refresh available models: … failed to decode models
          // response: model \`…\` is missing both \`base_instructions\` and
          // \`model_messages.instructions_template\``.
          //
          // NOT lifted today, deliberately, and the reason is that the line
          // cannot arrive: the adapter answers `/v1/models` with a named 404 and
          // codex never asks in the first place — `should_refresh_models` is
          // `uses_codex_backend() || has_command_auth()` and our provider block
          // emits `env_key`, so both operands are false (same measurement, with
          // an `[…auth]` provider as the positive control that turns the fetch
          // on). An untested reader on a path this build cannot reach is the
          // shape this plan treats as worse than a named gap.
          //
          // So: if the seam is opened — which is a credential REPLACEMENT in
          // `config-writer.ts`, since `auth` and `env_key` are mutually
          // exclusive — this filter learns the refresh-failure prefix FIRST,
          // with a driven case, and only then does the catalog get served.
        },
        onNotification: (method, params) => this.handleNotification(method, params),
        onServerRequest: ({ method, params }) => this.handleServerRequest(method, params),
      });

      this.startupPhase = 'waiting for codex to initialize';
      await client.request('initialize', {
        clientInfo: { name: 'nessy-codex', title: null, version: '0.0.0' },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          // P3.270 · codex's OWN suppression, not a host-side filter. Every name
          // in this list is one no code path in this fork can receive a fact on;
          // the reasons, the measurement that the mechanism works, and the
          // hazard (it also silences a family we DO read, `configWarning`
          // included) are in `codex-notification-families.ts`.
          optOutNotificationMethods: [...CODEX_OPTED_OUT_NOTIFICATION_METHODS],
        },
      });
      client.notify('initialized');
      await this.trustProjectedHostHooks(client); if (this.destroyed) throw new Error('codex-agent-destroyed'); // F1.386

      // P2.7 — the codex half of the one managed floor, read where the method
      // says to read it: after `initialize`, before any thread exists. It never
      // throws (an app-server that does not know the method must still start a
      // session), it degrades with one debug line, and every requirement it read
      // but does not apply is named on the same channel rather than dropped.
      // P6.169 — where this runtime's effective configuration actually came
      // from, asked of the runtime rather than inferred from the `config.toml`
      // we author. Native mechanism, step 1: `config/read` with
      // `includeLayers: true`, a request family this client had never sent.
      //
      // HERE, beside its sibling, and for the same three reasons: after
      // `initialize` and before any thread exists (it is a property of the
      // configuration, not of a conversation); it can never fail a spawn (the
      // probe degrades with one debug line and returns a reading); and it is a
      // READ that changes no posture, which is what separates it from the
      // `skills/extraRoots/set` arm.
      //
      // NOT awaited into the critical path's ordering beyond this line, and
      // deliberately not gated on anything: the answer is recorded for the
      // settings page, and a session that never opens that page pays one
      // bounded request. `recordCodexConfigProvenance` ignores `undefined`, so
      // a probe that could not run leaves the previous session's good answer
      // alone rather than erasing it.
      const configOrigins = await probeCodexConfigOrigins(client, {
        // The workspace directory, so the project layer between it and the repo
        // root is resolved. `ConfigReadParams.cwd` is documented for exactly
        // this, and the shipped binary returns no project layer without it.
        ...(this.workingDirectory ? { cwd: this.workingDirectory } : {}),
        onDiagnostic: message => this.debug(message),
      });
      // P6.823 — keyed by WORKSPACE. The answer above was resolved from this
      // session's `cwd`, so it describes one workspace's layer stack; a
      // process-wide slot handed every open workspace whichever one started a
      // codex session last.
      recordCodexConfigProvenance(this.config.workspace?.id, configOrigins.provenance);
      if (this.destroyed) throw new Error('codex-agent-destroyed');

      const requirements = await probeCodexConfigRequirements(this.recordManagedApprovalsReviewers(client), {
        // P6.484 · owner Q15(b). The administrator's `models.newThread` is a
        // DEFAULT, not enforcement, so the probe needs the one bit
        // `this._model = config.model || defaultModel` used to discard: did the
        // USER pick this model, or did the connection default it? Supplying it
        // is what lets the diagnostics below say which of the three outcomes
        // happened instead of printing the pre-row guess.
        session: { model: this._model, modelChosenExplicitly: this.modelChosenExplicitly },
        onDiagnostic: message => {
          this.debug(message);
          // P3.267 · the same channel-vs-build gap as its two siblings. An
          // administrator requirement this build did not apply is exactly the
          // class that must not end in a log a packaged app never writes.
          this.noteCodexUnappliedRequirementDiagnostic(message);
        },
      });
      // P6.78 · and WHEN it was read. The per-field verdicts above say what each
      // requirement means; this says that the channel carrying them is on a
      // different clock from the host's own composed policy, which is the fact
      // an administrator needs before they interpret any of the others.
      this.noteCodexRequirementClock(requirements); this.refuseManagedModelProviderRedirect(); // F1.589 — before any thread opens
      // P6.484 · and APPLY it, exactly as codex's own client does. The reference
      // implementation, read at `rust-v0.148.0` — the tag shipped when this was
      // read, so STRONG tier — is `tui/src/managed_new_thread_defaults.rs`,
      // which fills `config.model` ONLY when the invocation carried no `-m` and
      // no `-c model=`, under *"Managed values are defaults rather than
      // enforcement. Preserve explicit launch choices"*. Owner decision
      // 2026-09-05 Q15 took option (b) for that reason: (a) leaves an
      // administrator's control inert, and (c) — overriding a model the user
      // picked — is strictly stronger than codex itself, which codex's own
      // source explicitly declines.
      //
      // The same pure resolver the probe used, on the same inputs, so the
      // sentence it printed and the model this thread starts on cannot
      // disagree.
      //
      // `setModel` rather than a bare assignment: `CLAUDE_CODE_EFFORT_LEVEL=auto`
      // resolves against the MODEL's default, so a model change can move the
      // pinned effort, and skipping that re-read would leave the session on an
      // effort chosen for a model it is no longer running.
      //
      // THE RESIDUE, said aloud rather than hidden: `config.toml` was written
      // above with the inherited model and is NOT rewritten. It does not matter
      // for this thread — `thread/start` carries the model explicitly, one line
      // below — but the file's own `model` line stays the pre-override value,
      // and a future path that starts a thread WITHOUT naming a model would read
      // it. Rewriting the file here would mean respawning the app-server, which
      // the block at `writeCodexConfig` already refuses for a heavier reason.
      //
      // The reasoning effort is deliberately NOT applied even when the
      // requirement carries one: the posture is "fill only what the invocation
      // did not choose", and this build records no explicit-vs-inherited bit for
      // the thinking level at all. Applying it unconditionally would be option
      // (c) for effort — stronger than codex — through the back door. It stays
      // REPORTED, in the line above.
      //
      // C3.169 (QK7, owner answer A, 2026-09-11) — `serviceTier` USED TO SHARE
      // that sentence and no longer does, because the posture's precondition
      // parts them. A thinking level is a choice this build OFFERS, so applying
      // an administrator's over it needs the bit we do not have. A service tier
      // is a choice this build offers NOWHERE — no setting, no picker, no
      // connection field — so there is no user choice for the requirement to
      // override and the precondition is satisfied unconditionally rather than
      // skipped. The field is codex's own on the call we already make
      // (`ThreadStartParams.serviceTier`, *"Override the service tier for this
      // turn and subsequent turns"*), so nothing is invented; the honest surface
      // above now says which of the three fields moved.
      const newThreadVerdict = resolveCodexManagedNewThreadModel(
        requirements.managedNewThreadDefaults,
        { model: this._model, modelChosenExplicitly: this.modelChosenExplicitly },
      );
      if (newThreadVerdict.kind === 'applied') {
        this.setModel(newThreadVerdict.model);
        // Only on `applied`: a `preserved` verdict is the requirement standing
        // down over an explicit launch choice, and standing down is whole.
        this.managedServiceTier = newThreadVerdict.serviceTier;
      }
      // P6.167 · and WHICH of this project's own `.claude` settings families this
      // runtime honours. Placed beside the requirement clock deliberately: both
      // are session-scoped statements about configuration this session read, and
      // both ride the same bounded queue.
      this.noteClaudeSettingsProjection();
      // The write is what flips a settings page already on screen: the electron
      // host subscribes to these registries, so a codex runtime starting
      // mid-session broadcasts the managed state with no user action
      // (`config/managed-in-app-updates.ts`, P2.7 clause (b); and since P2.463
      // `config/managed-in-app-browser.ts`, whose subscriber CLOSES a browser
      // pane the policy has just forbidden).
      //
      // P2.137 — ONLY AN ANSWER MAY WRITE THE TIER. `recordCodex…(undefined)`
      // CLEARS the codex tier, and until this guard existed every probe outcome
      // reached it: `requirements.inAppUpdatesDisabled` is `undefined` for
      // `status:'failed'` (a transport hiccup, a timeout, a busy server) exactly
      // as it is for `status:'none'` (the server answered, and it carries no
      // requirement). Those are not the same fact, and treating them as one
      // meant a single failed probe re-opened a security-update channel an
      // administrator had closed — in a codex-only fleet, silently and with no
      // user action.
      //
      // So the two ANSWERS write and the two NON-ANSWERS do not:
      //   - `read` — the server produced a requirements document. Write it.
      //   - `none` — the server answered and reported nothing. Write the clear;
      //     an administrator withdrawing the requirement must take effect.
      //   - `failed` — we do not know. Leave the last known value standing.
      //   - `unsupported` — THIS app-server refused the request permanently:
      //     the method is not in its `ClientRequest` enum, or our params do not
      //     fit its struct. Our own bundled binary answers it (P2.7 measured
      //     `configRequirements/read` present), so it is a drifted artifact —
      //     downgraded, substituted, or newer than our request shape. P2.243
      //     widened this line: it read "can only be a downgraded or substituted
      //     artifact", which stopped being true once the verdict stopped resting
      //     on `-32600` and started resting on the serde token, so a param-shape
      //     drift lands here too. Either way it is the last circumstance in
      //     which to trust it over a value an administrator already deployed.
      //
      // The registrar's `undefined` → clear contract is unchanged and correct at
      // its own layer; the defect was this CALLER passing "we do not know" into a
      // parameter that means "there is no requirement". That is why the pin named
      // `a non-boolean clears the tier rather than deciding something` still holds
      // verbatim — fixing this did not change its intent.
      //
      // P3.261 / P3.85 — WHOLE, and this comment says so because it used to
      // name a remaining half that is now closed. The tier is module-scope, so
      // it can only ever be armed once the first codex runtime of the process
      // has started, and in a codex-only fleet `checkForUpdatesOnLaunch()`
      // therefore ran UNGATED at every boot. The answered requirement is
      // PERSISTED (below) by
      // `config/codex-managed-requirement-cache.ts::persistCodexInAppUpdatesRequirement`,
      // and its reader `restoreCodexInAppUpdatesRequirement` is CALLED from the
      // electron host's bootstrap (`apps/electron/src/main/index.ts:433`,
      // `abb980e6c`) ahead of both `registerEnforcedManagedInAppUpdatesProvider()`
      // (`:442`) and `checkForUpdatesOnLaunch()` further down the same handler.
      // Both orderings are pinned against that file's source by
      // `apps/electron/src/main/__tests__/managed-update-registration.test.ts`,
      // which is the only instrument that can catch a re-ordering — there is
      // nothing at runtime to notice one.
      //
      // Composition is unchanged either way: tightest wins, and a live runtime
      // answering later overwrites the cached answer with a fresher one.
      // The HEADLESS host needs no such call: `checkForUpdatesOnLaunch` is an
      // electron-only entry point (`git grep -a` finds it in
      // `apps/electron/src/main/` and in prose alone), so there is no second
      // launch check for a cache to gate.
      //
      // The browser tier below shares the lateness and NOT the consequence, which
      // is why P2.399 built it the way it did: its subscriber closes a pane that
      // is already open, so a window opened before the first codex runtime is
      // retracted rather than left running. An update already INSTALLED cannot be.
      const requirementAnswered = requirements.status === 'read' || requirements.status === 'none';
      if (requirementAnswered) {
        recordCodexInAppUpdatesRequirement(requirements.inAppUpdatesDisabled);
        // P3.261 — and the same answer, on disk, so the NEXT boot can gate its
        // launch update check before any codex runtime has started. Inside this
        // guard and nowhere else: only an ANSWERED requirement may write, which
        // is P2.137's rule and the reason the two non-answers above write
        // nothing. Best-effort — a cache that cannot be written must not stop a
        // runtime from starting, and the in-memory tier is unaffected either way.
        if (!persistCodexInAppUpdatesRequirement(requirements.inAppUpdatesDisabled)) {
          this.debug(
            '[managed] codex in-app-updates requirement could not be cached; the next launch check '
            + 'will run with whatever tier the host has at boot',
          );
        }
        // P2.463 — the second host-facing `[features]` switch, and the one line
        // P2.399 could not write from its own zone. Without it the gate in
        // `apps/electron/src/main/browser-pane-manager.ts` has a codex tier that
        // nothing ever writes, so a fleet deploying `in_app_browser = false` and
        // nothing else is NOT gated while the report says it is.
        //
        // INSIDE the same guard as its twin rather than beside it, for the same
        // measured reason: `inAppBrowserDisabled` is `undefined` for
        // `status:'failed'` exactly as it is for `status:'none'`, so an unguarded
        // write would let one transport hiccup re-open a browser an administrator
        // had closed — P2.137's defect, on a capability instead of an update
        // channel.
        recordCodexInAppBrowserRequirement(requirements.inAppBrowserDisabled);
        // D1.205 — the THIRD host-facing `[features]` switch, and the one line
        // that lane could not write from its own zone. Without it the gates in
        // `SessionManager`'s `AutomationSystem` construction and in
        // `capabilities/runtime-automations.ts` have a tier nothing ever writes,
        // so a fleet deploying `in_app_local_automation = false` is NOT gated
        // while the verdict table says it is — the false assurance P2.373 spent
        // a row removing. Inside the same `requirementAnswered` guard as both
        // twins, for P2.137's measured reason: a `failed` probe reads
        // `undefined` exactly as "no requirement" does, and clearing on it would
        // re-enable automations an administrator turned off.
        recordAndPersistCodexLocalAutomationRequirement(requirements.localAutomationDisabled);
      } else {
        this.debug(
          `codex configRequirements ${requirements.status}: the managed in-app-updates and `
          + 'in-app-browser tiers are left as they were rather than cleared',
        );
      }
      if (this.destroyed) throw new Error('codex-agent-destroyed');

      // P2.330 — the credential deny is VERIFIED here, not assumed, and this is
      // the only place in the process that consults anything about it.
      await this.verifyPermissionProfileAccepted(client); void this.noteProjectPermissionProfileAdditions(client); await this.signInCodexChatGptSubscription(client, declaredModelProvider); void this.refreshChatGptSubscriptionModels(client, declaredModelProvider); // F1.202 + F1.566 — both no-ops on every card but ChatGPT (Codex); F1.751 — never throws
      if (this.destroyed) throw new Error('codex-agent-destroyed');

      this.startupPhase = 'opening the codex thread'; await this.refreshCodexRestrictedRepoSkills(client, CODEX_THREAD_REFORK_TIMEOUT_MS); // F1.845 — before EVERY open (start/resume/fork): an untrusted project's skills off
      // P6.102 · a BRANCH opens the parent's thread forked, not a fresh one.
      //
      // Native mechanism, and it was reachable the whole time: `thread/fork`
      // takes `lastTurnId` — "Optional last turn id to fork through, inclusive.
      // When specified, turns after `last_turn_id` are omitted from the fork"
      // (`codex-protocol/generated/v2/ThreadForkParams.ts`) — and forks BY
      // THREAD ID, loading the thread from disk, so a cold parent forks as well
      // as a live one. This file already called `thread/fork` for config-drift
      // re-forks and never for the one job the parameter exists for.
      //
      // Until this row a branched codex session called `thread/start`, so the
      // host copied the parent's messages up to the branch point into the
      // child's record while the model was handed an empty thread: the user
      // read a conversation the model had never seen.
      //
      // A fork with no `lastTurnId` is codex's own documented full-history
      // fork. `SessionManager` degrades to that when the turn anchor is missing
      // or its lineage does not match, and says so in the log — the child then
      // sees TOO MUCH rather than nothing, which is the safe direction for a
      // degradation nobody can see.
      const branchFrom = this.config.session?.branchFrom;
      const forkFromThreadId = branchFrom?.sdkSessionId;
      // UB12.63 · resolved once, so the block a `thread/start` carries is the one
      // `deliveredOutputStylePrompt` is seeded from below.
      const openOutputStylePrompt = this.activeOutputStyle()?.prompt ?? '';
      const openThreadParams = {
        cwd: this.workingDirectory, config: this.codexThreadSecurityLayer(), // F1.723 — outranks any project `.codex` layer
        model: this._model,
        // C3.169 — the administrator's service tier, on every leg that OPENS a
        // thread (`start`, `fork`, `resume`), because codex's own field is
        // documented as governing "this turn and subsequent turns" and a new
        // thread inherits nothing. Spread, so a session with no requirement
        // sends the same params it sent before this row.
        ...(this.managedServiceTier ? { serviceTier: this.managedServiceTier } : {}),
        // P3.33 — the host's safety guidance. See
        // {@link codexDeveloperInstructions} for why this field and not
        // `baseInstructions`, which REPLACES codex's own prompt.
        developerInstructions: codexDeveloperInstructions(openOutputStylePrompt, this.developerSections(callbackBridge?.port)),
      };
      type OpenThreadResult = { thread?: { id?: string }; sandbox?: { type?: string } };
      let openedBy: 'thread/fork' | 'thread/start' | 'thread/resume' = 'thread/start';
      let threadResult: OpenThreadResult | undefined;
      // P6.106 · `/resume` asked for a thread this session set aside. Codex's
      // own primitive, and the one this file had never called despite four
      // comments naming it: `thread/resume` "load[s] the thread from disk by
      // thread_id and resume[s] it", and rejoins it when it is still running
      // (`generated/v2/ThreadResumeParams.ts`, which also says "Prefer using
      // thread_id whenever possible" — so the id, not the path).
      //
      // Ahead of the fork arm because the two cannot both apply: a branch's
      // fork metadata is retired by `onSdkSessionIdUpdate` the moment the child
      // thread exists, long before any `/clear` could set one aside.
      if (this.resumeThreadId) {
        const resumeThreadId = this.resumeThreadId;
        this.resumeThreadId = null;
        threadResult = (await client.request('thread/resume', {
          threadId: resumeThreadId, excludeTurns: true, // F1.1237 — this host never reads the response's `thread.turns`; without the flag a paginated thread makes codex (thread_processor.rs at rust-v0.159.3) send a "Full-history hydration is deprecated" notice to the chat, and codex's own TUI sets it the same way (app_server_session.rs)
          ...openThreadParams,
        })) as OpenThreadResult;
        openedBy = 'thread/resume';
      } else if (forkFromThreadId) {
        try {
          threadResult = (await client.request('thread/fork', {
            threadId: forkFromThreadId, excludeTurns: true, // F1.1237 — F1.1273: codex then skips its restored usage replay (thread_processor.rs, CR-3), so a branch's meter fills at its first turn's usage update, as a claude or Pi branch's does: the host carries no usage into any branch, codex offers no usage read, and a parent's figure would overstate a mid-transcript branch
            ...(branchFrom?.sdkTurnId ? { lastTurnId: branchFrom.sdkTurnId } : {}),
            ...openThreadParams,
          })) as OpenThreadResult;
          openedBy = 'thread/fork';
        } catch (error) {
          // The anchor is not always a codex thread. Every codex session created
          // BEFORE this row carries the HOST session id in `sdkSessionId` — the
          // `agent.getSessionId()` fallback filled it, because nothing here
          // published the real one — and forking that id answers the same
          // `no rollout found for thread id …` a rollout-less thread does
          // (measured on rust-v0.148.0, T1a). Left unhandled, branching one of
          // those sessions would fail to open a thread at all, which is worse
          // than the defect this row fixes.
          //
          // The refusal is matched by its MESSAGE, exactly as the config-drift
          // re-fork below does, and for the same reason: it is the one error
          // that proves there is nothing to fork. Every other fork failure —
          // a timeout above all — must throw, because a fresh thread would then
          // silently drop a conversation the parent thread really holds.
          //
          // On the refusal, fall back to the fresh thread this call site used
          // until now and SAY SO on the transcript rather than only to `debug`.
          // The user then knows the messages above are ones this thread's model
          // has not seen.
          if (!(error instanceof Error) || !error.message.startsWith('no rollout found')) throw error;
          // D1.255 · C3.331's first half: every word here is ours and is about
          // what the PERSON is looking at — a transcript the model cannot see.
          // The thread id is data.
          if (!i18n.isInitialized) setupI18n();
          this.surfaceCodexOperatorNotice(i18n.t('chat.codexNotice.threadForkFailed', { threadId: forkFromThreadId }));
          this.debug(`codex thread/fork refused for ${forkFromThreadId}: ${error.message}`);
        }
      }
      // P6.649 · AN ORDINARY RELAUNCH RESUMES ITS OWN THREAD.
      //
      // `thread/resume` had exactly one caller — P6.106's explicit `/resume`
      // above — so a session reopened after a restart showed the user its whole
      // transcript while codex opened a FRESH thread that had seen none of it.
      // That is the same "the model has not seen this" shape P6.102 closed for
      // branching, and the mechanism was already wired: one guard away.
      //
      // The id is the one codex itself published and this host persisted
      // (`onSdkSessionIdUpdate`, P6.102) — never a host session id. Sessions
      // created BEFORE P6.102 carry the HOST id in that field, which is exactly
      // the `no rollout found for thread id …` case the fork arm documents, so
      // the fallback below is not hypothetical.
      //
      // THIRD, after the two arms that name a specific thread: an explicit
      // `/resume` asked for a thread the user chose, and a branch's fork anchor
      // names its parent. Both outrank "carry on where this session left off".
      const persistedThreadId = threadResult ? undefined : this.config.session?.sdkSessionId;
      if (persistedThreadId) {
        try {
          threadResult = (await client.request('thread/resume', {
            threadId: persistedThreadId, excludeTurns: true, // F1.1237
            ...openThreadParams,
          })) as OpenThreadResult;
          openedBy = 'thread/resume';
        } catch (error) {
          // ALWAYS fall back — the session has to open — and SAY SO on the
          // durable channel rather than only to `debug`, because the user is
          // looking at a transcript the model can no longer see. Unlike the fork
          // arm this does not narrow on the message: any refusal here has the
          // same consequence for the user, and re-throwing would turn a lost
          // history into a session that will not start.
          // D1.255 · the fork arm's twin, localised with it and for the same
          // reason: one sentence per user, in the user's own language, about a
          // transcript the model can no longer see.
          if (!i18n.isInitialized) setupI18n();
          this.surfaceCodexOperatorNotice(i18n.t('chat.codexNotice.threadResumeFailed', { threadId: persistedThreadId }));
          this.debug(
            `codex thread/resume refused for ${persistedThreadId}: `
            + `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (!threadResult) {
        threadResult = (await client.request('thread/start', openThreadParams)) as OpenThreadResult;
      }
      // P3.315 — the field this cast used to drop. `ThreadStartResponse.sandbox`
      // is the policy the binary RESOLVED, which is the only thing that can
      // contradict the mode this host wrote.
      this.noteResolvedSandboxPolicy(threadResult.sandbox); this.noteResolvedApprovalPolicy((threadResult as { approvalPolicy?: unknown }).approvalPolicy); // F1.723
      const threadId = threadResult.thread?.id ?? null;
      if (!threadId) throw new Error(`codex ${openedBy} returned no thread id`); const providerRefusal = codexOpenedModelProviderRefusal(threadResult, declaredModelProvider ?? CODEX_PROVIDER_KEY, requirements); if (providerRefusal) { this.debug(`[managed] F1.634: ${providerRefusal}`); throw new Error(providerRefusal); } // F1.634 — codex's own reported provider, before the host adopts the thread
      if (this.destroyed) throw new Error('codex-agent-destroyed');

      this.codexHome = codexHome;
      this.adapter = adapter;
      this.callbackBridge = callbackBridge;
      this.manager = manager;
      this.client = client;
      this.threadId = threadId;
      // UB12.63 · a fresh thread holds exactly the block its developer
      // instructions carried. A resumed or forked one holds what its history
      // was rendered with, so the value stays as it was (unknown in a new
      // instance) and the first turn's switch plan decides.
      if (openedBy === 'thread/start') this.deliveredOutputStylePrompt = openOutputStylePrompt;
      // P6.102 · the host learns codex's OWN thread id.
      //
      // Nothing published it before: `codex-agent.ts` scored 0 for
      // `sdkSessionId`, so `managed.sdkSessionId` was filled by
      // `SessionManager`'s `agent.getSessionId()` fallback — which on this
      // backend returns the HOST session id, a value `thread/fork` cannot use.
      // The branch guard ("sdk-fork requires parent SDK session ID") therefore
      // passed on a value that was never a codex thread. The callback writes
      // the per-provider anchor and retires the parent's branch metadata, so a
      // child that has forked is not a branch any more.
      this.config.onSdkSessionIdUpdate?.(threadId);
      // P6.390 · this chat's memory scope, in codex's OWN per-thread vocabulary.
      // After the convergence point, so `thread/start`, `thread/resume` and
      // `thread/fork` are all covered by one call that no future open path can
      // walk past. See the method for why it is sent on every open.
      await this.applyCodexThreadMemoryMode(client, threadId, openedBy);
      // P6.399 · codex's own `skills/*` family, read once the thread is open.
      // Fire-and-forget: it is a diagnosis plus a projection, and blocking
      // startup on it would trade a real latency for a configuration nicety.
      void this.syncCodexSkillsConfig('startup');
      // P3.28 — the live surface, as read off the config this runtime wrote.
      this.sessionMcpAdvertisedArgs = advertisedSessionMcpArgs;
      this.runtimeConfigSignature = codexThreadConfigSignature(buildCodexRuntimeConfigOverride({
        mode: this.getPermissionMode(),
        sandboxGloballyEnabled: this.sandboxGloballyEnabled(),
        readOnlyPaths: this.codexReadOnlyPaths(), // F1.670; F1.678 — the host writes no exact deny any more
        // P3.175 · the `deniedPaths` credential floor, mirrored onto codex's own
        // OS-enforced deny map. Defence in depth: our gate still runs first.
        deniedReadPatterns: this.credentialFloorPatterns(),
        // C4.11 · the SAME value `writeCodexConfig` above put in the opened thread's `config.toml`, so this seed
        // describes the thread that exists rather than one without the pair — which is what keeps the first turn
        // of a plugin-free session fork-free, exactly as it was before the pair. `codexThreadConfigSignature` is
        // `JSON.stringify`, so the KEY ORDER has to match too: both sides get the map from one method, spread
        // last over an otherwise empty object at the turn site.
        shellEnvironment: this.codexShellEffortEnvironment(),
        // C3.343 · the SAME floor `writeCodexConfig` put in the opened thread's `config.toml`. Omitted here, the
        // seed would describe a thread without it and the first plugin turn's refork would read as a drift that
        // is really this line's absence.
        protectedWorkspaceSubpaths: this.codexProtectedWorkspaceSubpaths(),
        // F1.671 · the added roots (P3.369), the list `writeCodexConfig` and the turn-head re-fork override carry
        // too; without it every session with an added directory re-forked once, for nothing, at its first turn.
        writablePaths: this.codexWritablePaths(), // F1.1003 — the same list writeCodexConfig got
      }));
    } catch (error) {
      try {
        await this.cleanupRuntimeResources({ client, manager, adapter, callbackBridge, codexHome });
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'codex-runtime-startup-failed');
      }
      throw error;
    }
  }

  /**
   * C3.67 — take the pre-image of every file a codex patch is about to touch.
   *
   * ## Why there is a call site here at all
   *
   * `RUNTIME_FILE_CHECKPOINT_PRODUCERS` recorded `'codex-runtime': false` with
   * the reason *"none, and no upstream API to wire"*, and every rewind surface
   * reads that record: with it `false` the session menu's revert, the
   * conversation rewind's `restoreFiles` and the `rewind_checkpoint` request all
   * say "not tracked" instead of promising a restore. Flipping the boolean
   * without a producer would have re-created the exact defect the record exists
   * for, so the boolean follows the call site rather than the other way round.
   *
   * ## The direction is codex's own contract
   *
   * `packages/codex-protocol/generated/v2/ThreadRevertParams.ts` (it replaced
   * the removed `thread/rollback` params type at `rust-v0.156.1`, F1.590):
   * *"This only changes persisted conversation history. It does not revert
   * local file changes."* So the runtime says in its own generated type that
   * the file half is left to the client — native-first is asked and
   * answered `the runtime does not, and says so`.
   *
   * ## The seam, read at the tag
   *
   * `github.com/openai/codex` at `rust-v0.150.1`,
   * `core/src/tools/handlers/apply_patch.rs`: `emitter.begin(event_ctx).await`
   * runs BEFORE the `ToolOrchestrator` that applies the patch, and
   * `app-server-protocol/src/protocol/item_builders.rs`'s
   * `build_file_change_begin_item` turns that event into the `fileChange` item
   * this method reads. So `item/started` is codex's own pre-write announcement,
   * and it carries every path.
   *
   * **The residue, stated rather than hidden.** Codex does not WAIT for us: the
   * ordering above is inside codex's process, and our snapshot happens in this
   * one. The window is between codex writing that notification to stdout and
   * this process reading it, against codex's own remaining work before the
   * write (approval resolution, sandbox/environment selection, the orchestrator
   * run). `codex-file-change-preimage-e2e.test.ts` measures the window on the
   * shipped binary rather than asserting it away, and `finalizeFileCheckpoint`
   * records the post-image, so a checkpoint whose pre- and post-images are equal
   * is reported as `no-op` rather than as a restore that would do nothing.
   *
   * Never throws into the notification path: a failed checkpoint must not take
   * the turn's event stream with it, and the honest outcome is one debug line
   * plus a manifest with no entry for that path — which every consumer already
   * reads as "not tracked".
   */
  /**
   * C3.386 — remember what a `fileChange` item is about to write.
   *
   * Reuses {@link codexFileChangePaths} rather than re-reading the item, so the
   * card, the floor and the checkpoint all name the SAME set: that function
   * already resolves a relative path against the working directory and skips
   * anything that is not a non-empty string, and a second reader would be a
   * second chance to disagree about which files a patch touches.
   *
   * The FIRST sighting wins, matching the checkpoint's own rule one method
   * down: codex may announce an item twice (the approval and the patch-begin
   * share a `call_id`), and the earliest announcement is the one taken before
   * any write.
   */
  private rememberCodexFileChangePaths(item: unknown): void {
    const itemId = isPlainRecord(item) && typeof item.id === 'string' ? item.id : undefined;
    if (!itemId || this.codexFileChangeItemPaths.has(itemId)) return;
    const paths = codexFileChangePaths(item, this.workingDirectory);
    if (paths.length > 0) this.codexFileChangeItemPaths.set(itemId, paths);
  }

  /**
   * C3.386 — the paths an approval frame is about, or `[]` when they are not
   * known yet.
   *
   * `[]` is not a defect to belt against: codex's `item/started` is its own
   * pre-write announcement and normally precedes the approval
   * (`core/src/tools/handlers/apply_patch.rs` at `rust-v0.150.1` runs
   * `emitter.begin(event_ctx).await` BEFORE the orchestrator that applies the
   * patch), but the two are separate messages and nothing in the protocol
   * promises the order. So the empty answer is a real state, and every consumer
   * below treats it as *"this act cannot be named"* rather than as
   * *"this act touches nothing"* — which is the whole reason the card refuses
   * Always Allow in that case.
   */
  private codexFileChangeApprovalPaths(params: unknown): string[] {
    const itemId = isPlainRecord(params) && typeof params.itemId === 'string' ? params.itemId : undefined;
    return itemId ? (this.codexFileChangeItemPaths.get(itemId) ?? []) : [];
  }

  private checkpointCodexFileChange(item: unknown): void {
    // C3.386 · the paths are recorded FIRST and unconditionally, before any of
    // the checkpoint guards below: the approval card needs them whether or not
    // this session can write a checkpoint, and a session with nowhere to write
    // one must not also lose the file name on its permission prompt.
    this.rememberCodexFileChangePaths(item);
    const sessionPath = this.getSessionStoragePath();
    if (!sessionPath) return;
    const itemId = isPlainRecord(item) && typeof item.id === 'string' ? item.id : undefined;
    if (!itemId) return;
    // The approval request and the patch-begin event carry the SAME `call_id`,
    // so an item can be announced twice. The first sighting is the earliest
    // pre-image, and a second checkpoint of the same path would snapshot bytes
    // codex may already have written.
    if (this.codexFileCheckpoints.has(itemId)) return;
    const paths = codexFileChangePaths(item, this.workingDirectory);
    if (paths.length === 0) return;
    const opened = (async () => {
      const ids: string[] = [];
      for (const filePath of paths) {
        try {
          const [checkpoint] = await createFileCheckpoint({
            sessionPath,
            adapter: 'file',
            // codex's OWN tool name, not the host's `Edit`/`Write` projection.
            // The field is display text on the rewind surfaces
            // (`SessionManager.projectFileCheckpoints` bounds it and hands it
            // to the renderer), and naming the act the runtime performed is
            // what lets a user match a checkpoint to the row above it. The
            // approval-rule projection keeps both host spellings for a
            // different job — matching a user's rules — and that asymmetry is
            // deliberate.
            toolName: 'apply_patch',
            toolCallId: itemId,
            input: { file_path: filePath },
          });
          if (checkpoint) ids.push(checkpoint.id);
        } catch (error) {
          this.debug(
            `codex file checkpoint failed for ${filePath}: `
            + (error instanceof Error ? error.message : String(error)),
          );
        }
      }
      return ids;
    })();
    this.codexFileCheckpoints.set(itemId, opened);
  }

  /**
   * C3.67 — close the checkpoints this item opened, with codex's own verdict.
   *
   * `item/completed` for a `fileChange` carries a `PatchApplyStatus`
   * (`item_builders.rs`'s `build_file_change_end_item`), and `failed` is the one
   * value that makes `finalizeFileCheckpoint` record the outcome as a failure
   * rather than an application. The post-image is read either way, because that
   * is what lets `listFileCheckpoints` tell a real edit from a no-op.
   */
  private finalizeCodexFileChange(item: unknown): void {
    const completedId = isPlainRecord(item) && typeof item.id === 'string' ? item.id : undefined;
    // C3.386 · released here and not below, for the same reason it is recorded
    // above the checkpoint guards: the two maps have the same lifetime but not
    // the same preconditions, and a path set that outlived its item would make
    // a later approval name a file it is not about.
    if (completedId) this.codexFileChangeItemPaths.delete(completedId);
    const sessionPath = this.getSessionStoragePath();
    if (!sessionPath) return;
    const itemId = completedId;
    if (!itemId) return;
    const opened = this.codexFileCheckpoints.get(itemId);
    if (!opened) return;
    this.codexFileCheckpoints.delete(itemId);
    const succeeded = !(isPlainRecord(item) && item.status === 'failed');
    void (async () => {
      for (const checkpointId of await opened) {
        try {
          await finalizeFileCheckpoint({ sessionPath, checkpointId, succeeded });
        } catch (error) {
          this.debug(
            `codex file checkpoint could not be finalized (${checkpointId}): `
            + (error instanceof Error ? error.message : String(error)),
          );
        }
      }
    })();
  }

  private handleNotification(method: string, params: unknown): void {
    // A spawned subagent's thread streams over the SAME connection, and every
    // thread-scoped notification names its thread. Without this guard the
    // child's `turn/completed` finished the PARENT's turn sink early — the
    // parent's final message after `wait_agent` was dropped on the floor — and
    // the child's own messages landed in the parent transcript. Measured live
    // on the codex agent-roles gate (CDX-ROLES, 2026-08-13). Notifications
    // that carry no threadId (connection-scoped errors, auth) pass through.
    if (isForeignThreadNotification(params, this.threadId)) { this.noteSubagentThreadLifecycle(method, params); // F1.493 (2) — ahead of every early return below
      // C4.13 · a DETACHED REVIEW thread is foreign by construction — codex
      // opened it, not us — and it is the one foreign thread whose report the
      // user is waiting for. Checked ahead of the orchestration re-admit
      // because a review is not a spawned child and is in no run's roster, so
      // `adaptForeignChildThread` would return [] and the review would vanish.
      if (this.admitDetachedReviewNotification(method, params)) return;
      // P3.4 · a foreign threadId is USUALLY a drop — but a thread WE spawned is
      // not truly foreign. Give the adapter a chance to re-admit a known child's
      // notification as orchestration progress on the parent turn's sink, ahead
      // of the drop. Anything it does not recognise as one of our children
      // returns [], so compaction threads and other sessions stay filtered; and
      // even an admitted child never drives the parent transcript or turn
      // lifecycle, because control still returns here.
      const admitted = this.eventAdapter.adaptForeignChildThread(method, params);
      // P6.200 · a child thread WE spawned is the first proof this session has a
      // subagent at all, and it is the moment the unscanned-report fact becomes
      // true for this user. See the method.
      if (admitted.length > 0) { this.noteSubagentReportUnscannedOnce(); this.noteCodexNativeWebSearch(method, params); } // F1.598 — a spawned child's search counts too
      for (const event of admitted) {
        this.turnSink?.push(event);
      }
      return;
    }
    // The turn id `turn/steer` will be checked against. Set here and nowhere
    // else — the reasoning is on the field.
    if (method === 'turn/started') {
      this.activeTurnId = readCodexTurnId(params); this.turnMonitorSteers = []; // F1.896 — a fresh turn owns a fresh accepted-monitor-steer record; a completed turn's ticks stay reported (delivered)
      // P6.274 (b) · the attempt ladder belongs to this turn only.
      this.codexRetryAttempt = 0;
      // P6.917 · and so does the chip it raised.
      this.codexRetryChipStanding = false;
      // R18 · the FIRST turn announced after the obligation was armed is the
      // one our `turn/start` opened, and it is the only turn whose assistant
      // message may be validated against the caller's schema. See the field.
      if (this.turnStructuredOutput && this.turnStructuredOutput.turnId === null) {
        this.turnStructuredOutput.turnId = this.activeTurnId;
      }
    }
    /*
     * P3.201 / P3.203 / P2.462 — THREE native codex self-reports, read at
     * `rust-v0.148.0`, and NONE of them gets a consumer here. The reasons are
     * different for each, and writing them down is the deliverable: each row
     * asked the native-first question, and "the runtime has a surface" is not
     * yet "the surface says something we can use".
     *
     * ## P3.203 · `modelProvider/capabilities/read` describes a CEILING, and for
     * every session this fork starts it is the same three constants
     *
     * The row's worry was that the endpoint reports `webSearch: true` while
     * `buildCodexConfigToml` writes `web_search = "disabled"`. Measured at the
     * source, the disagreement is benign and structural:
     * `app-server/src/request_processors/config_processor.rs:183` builds a
     * provider from `config.model_provider` — so it DOES describe OUR
     * `nessy_gateway`, not codex's own — and returns `provider.capabilities()`,
     * whose type carries its own answer: *"These capabilities are a
     * provider-owned upper bound. Callers can disable more functionality through
     * normal config, but should not expose a feature that the active provider
     * marks unsupported here."* (`model-provider/src/provider.rs:41-45`).
     * `ConfiguredModelProvider::capabilities` (`provider.rs:299`) varies only
     * `remote_compaction`, which is NOT in the response, and spreads
     * `ProviderCapabilities::default()` for the rest. So the three fields the
     * endpoint publishes are `{namespaceTools: true, imageGeneration: true,
     * webSearch: true}` on every codex session we will ever open. A consumer
     * would be reading a constant, and a constant that would contradict our own
     * narrowing. Not wired, and this is why.
     *
     * Driven on the shipped `darwin-arm64` `codex-app-server`, three arms in one
     * run with the BARE-CONFIG control the row asked for: our full config, our
     * config with auto-compaction off, and a `CODEX_HOME` with **no config.toml
     * at all** all answered `{"namespaceTools":true,"imageGeneration":true,
     * "webSearch":true}` — identical, so the response is invariant to our
     * configuration. Instrument control on the same rig: an unparseable
     * `config.toml` makes the SAME call fail outright ("failed to resolve
     * feature override precedence"), so the rig can distinguish answers.
     *
     * ## P3.201 · `model_catalog_json` is real, and its cost is out of
     * proportion to what it would buy
     *
     * It is codex's own mechanism for describing a model it does not ship, and
     * the row is right that we describe `tgpt/qwen35-397b-a17b-fp8` with two
     * scalars. Measured:
     *
     *  - It is a PATH to a `ModelsResponse`, and it **replaces** the catalog for
     *    the whole process (`core/src/config/mod.rs:905-907`, and
     *    `ConfiguredModelProvider::models_manager` swaps in a
     *    `StaticModelsManager` when it is set). codex's own models — including
     *    the ones its review/guardian paths name — go with it.
     *  - Its failure mode is the opposite of every other key this writer emits.
     *    A parse error or an empty `models` array is an `Err` out of
     *    `load_catalog_json` (`mod.rs:1973-1993`), i.e. config load fails,
     *    where an unknown key elsewhere is silently ignored.
     *  - `ModelInfo` has 42 fields of which **14 carry no serde default**
     *    (`slug`, `display_name`, `description`, `supported_reasoning_levels`,
     *    `shell_type`, `visibility`, `supported_in_api`, `priority`,
     *    `availability_nux`, `upgrade`, `support_verbosity`,
     *    `apply_patch_tool_type`, `truncation_policy`,
     *    `experimental_supported_tools`). Several are enums we would be guessing.
     *
     * And what it would buy is thin: the context window we already write
     * (`model_context_window`), `input_modalities` we must NOT author (P3.115
     * refuted exactly that), and `supports_search_tool` — see below, which is a
     * product posture rather than a config detail.
     *
     * There is a SECOND native surface here and it is the better seam, so it is
     * named rather than left for someone to rediscover: with `model_catalog_json`
     * unset, `ConfiguredModelProvider::models_manager` builds an
     * `OpenAiModelsManager` over an `OpenAiModelsEndpoint` pointed at the
     * provider's own `base_url`, and `codex-api/src/endpoint/models.rs` fetches
     * `GET {base_url}/models?client_version=…`. Our `base_url` is the loopback
     * adapter, whose router 404s everything but `/responses` and `/messages`
     * (`codex-responses-adapter/src/server.ts`), so that fetch fails on every
     * session and codex falls back to bundled metadata. **That endpoint, not the
     * gateway, is where a truthful model description would belong** — and it
     * lives in the adapter's server, outside this lane's files.
     *
     * ## P2.462 · the deferred-tool wire items stay unread, because the ON state
     * is one deliberate decision away and that decision is not ours
     *
     * `tool_search_call` / `tool_search_output` are first-class v2 items, so
     * unlike claude, codex's ON state WOULD be visible here. It is inert because
     * `search_tool_enabled` (`core/src/tools/spec_plan.rs:581`) is
     * `model_info.supports_search_tool && provider.capabilities().namespace_tools`
     * and the first operand is false for a slug codex does not ship.
     *
     * TWO corrections to what the earlier rows recorded, both measured here:
     *
     *  1. The gate is **not** unreachable from `config.toml`. `supports_search_tool`
     *     is a `ModelInfo` field, and both surfaces above set `ModelInfo` — the
     *     catalog file, and the provider's `/models` endpoint. It is reachable;
     *     it is reachable only through a change we are choosing not to make.
     *  2. The switch does **not** belong to the gateway. `ConfiguredModelProvider`
     *     fetches its catalog from `base_url`, which is our own loopback adapter,
     *     never `code-completion-nestor.tcsbank.ru`. No models reply from the
     *     gateway can reach this operand.
     *
     * Turning it on defers every MCP tool until searched for
     * (`tool_search_always_defer_mcp_tools` is `Stage::Removed` precisely because
     * that is now unconditional), which changes what the model can see without
     * asking. That is a posture, not a knob. Until it is taken, a reader for
     * these two items would be a reader for an event that cannot fire.
     */
    // Route token usage to the shared UsageTracker; everything else maps to events.
    if (method === 'thread/tokenUsage/updated') {
      const usage = CodexEventAdapter.readTokenUsage(params);
      if (usage?.last) {
        // P6.446 · both cache counters, and the input reduced by their sum.
        // codex's `inputTokens` is the WHOLE input (`non_cached_input()` at
        // `rust-v0.148.0` is `input_tokens - cached_input()`) while this host's
        // tracker sums the three, so carrying the numbers across unconverted
        // would bill the cached half twice. The conversion and its source read
        // live at `readCodexMessageUsage`, beside the type it reads.
        this.usageTracker.recordMessageUsage(readCodexMessageUsage(usage.last));
      }
      if (usage?.modelContextWindow) {
        this.usageTracker.setContextWindow(usage.modelContextWindow);
      }
      return;
    }
    if (method === 'account/rateLimits/updated') return void this.noteCodexRateLimitUpdate(params); // F1.7
    // Surface server error notifications so a failed turn is visible, not silent.
    if (method === 'error') {
      const msg = (params as { message?: string; error?: { message?: string } } | undefined);
      const text = msg?.message ?? msg?.error?.message ?? JSON.stringify(params);
      // P6.503 · Q-den 20 = A — say plainly where no reset was published.
      // `usageLimitExceeded` is a BARE STRING in `CodexErrorInfo` at
      // `rust-v0.148.0`, so the signal that stops the turn carries no reset;
      // codex's own reset rides `RateLimitWindow.resetsAt` on the windows F1.7
      // holds, and F1.569 pairs the FULL window's reset with this stop on the
      // ChatGPT (Codex) card. The error is asked first, so a release that stamps
      // one is reported — and with neither, the user is TOLD no reset was
      // published instead of an empty string where the reason should be. The
      // turn stops either way: codex performs no wait, so the clause never
      // promises one (`codexUsageLimitResetClause`, `waitIsWired: false`).
      const codexError = msg?.error as { codexErrorInfo?: unknown; resetsAt?: unknown } | undefined;
      const resetClause = codexUsageLimitResetClause(
        readCodexErrorInfoCode(codexError?.codexErrorInfo),
        codexError?.resetsAt ?? codexUsageLimitWindowReset(this.codexAccountWindows),
      );
      // P6.274 (a) · a RETRYING error is a turn that is still going, so it goes
      // on the status channel where the other two put it, not onto the transcript
      // as a failure. See {@link codexRetryFacts} for why the kind is
      // not this site's to choose and why the cause is read off codex's own
      // error code. The full text is not lost — it goes to `debug`, which is
      // where Pi's adapter leaves it too.
      //
      // The CONTROL for this branch is the `else`: a non-retrying error still
      // renders as an error, which is the row's own stated control and the thing
      // a status-only change would have quietly broken.
      const willRetry = (params as { willRetry?: unknown } | undefined)?.willRetry === true;
      if (willRetry) {
        this.debug(`codex retrying after error: ${text}`);
        this.codexRetryAttempt += 1;
        // P6.917 · armed here, disarmed by the next assistant delta.
        this.codexRetryChipStanding = true;
        this.turnSink?.push(
          retryStatusEvent(codexRetryFacts(codexError?.codexErrorInfo, this.codexRetryAttempt)),
        );
      } else {
        this.turnSink?.push({ type: 'error', message: `codex: ${text}${resetClause}` });
      }
      // A turn that failed for good is over even if no `turn/completed` follows.
      // `ErrorNotification` carries `willRetry`
      // (`codex-protocol/generated/v2/ErrorNotification.ts`), so a retrying
      // error leaves the turn — and its id — alone; a terminal one drops the id
      // rather than leave a steer aimed at a turn that is not coming back.
      //
      // …AND ONLY FOR THE TURN THE ERROR NAMES. `ErrorNotification` is
      // `{ error, willRetry, threadId, turnId }` with all four `required`
      // (`schema/codex_app_server_protocol.v2.schemas.json`), so the id is in the
      // payload this handler already reads. Without the check, a terminal error
      // attributable to a DIFFERENT turn on this thread dropped the live turn's
      // steer precondition, and the user's next mid-turn send was silently
      // downgraded to a queue. A payload with no readable `turnId` still clears —
      // that is the pre-existing behaviour and the safe direction, because a
      // steer aimed at a dead turn is refused and re-queued while an id dropped
      // in error cannot be recovered.
      const erroredTurnId = (params as { turnId?: unknown } | undefined)?.turnId;
      const namesActiveTurn = typeof erroredTurnId !== 'string'
        || erroredTurnId.length === 0
        || erroredTurnId === this.activeTurnId;
      if (namesActiveTurn && (params as { willRetry?: unknown } | undefined)?.willRetry !== true) {
        this.activeTurnId = null;
      }
      // P6.118 · MINT `StopFailure` on the terminal arm of the same test.
      // Gated on both halves deliberately: a `willRetry` error is a turn that is
      // still going, and an error naming another turn on this thread did not
      // fail THIS one — emitting on either would report a stop that did not
      // happen, which is the confident-wrong-answer shape this fork keeps
      // finding. Once per turn, like Pi's `emitStopFailureHookOnce`.
      if (namesActiveTurn
        && (params as { willRetry?: unknown } | undefined)?.willRetry !== true) {
        this.emitCodexStopFailureHookOnce(msg?.error, text);
        // P6.443 · and NAME THE ENDING. Until this row a codex turn stopped by a
        // provider error ended with a bare `complete`: the `codex: …` line above
        // said what broke and the turn's verdict said nothing, while the same
        // ending on claude names itself through `CLAUDE_RESULT_SUBTYPE_REASON`.
        // Terminality is decided HERE — the same two conditions this branch
        // already tests — because a retrying error is a turn that is still going
        // and an error naming another turn did not end this one.
        this.eventAdapter.noteTerminalError(
          codexTerminalReasonForError((msg?.error as { codexErrorInfo?: unknown } | undefined)?.codexErrorInfo),
        );
        // P6.366 (the ladder) · and remember WHICH code ended it, for the one
        // reader that has to decide whether a second model would answer
        // differently. Recorded here rather than derived later because this is
        // the only place the raw `codexErrorInfo` is in hand, and under exactly
        // the two conditions above — a `willRetry` error is a turn that is still
        // going, and an error naming another turn did not end this one.
        this.turnTerminalErrorCode = readCodexErrorInfoCode(
          (msg?.error as { codexErrorInfo?: unknown } | undefined)?.codexErrorInfo,
        ) ?? null;
      }
    }
    // R18 · remember the turn's latest assistant message, because on codex the
    // structured result IS that message — `turn/completed` carries no separate
    // `structured_output` field the way the Claude SDK's result message does.
    // Read off `item/completed`, the same notification the transcript row is
    // built from, so what the user saw is what gets validated;
    // `TurnCompletedNotification.turn.items` is NOT used because its own
    // `itemsView` says how much of that array is loaded, and a `partial` view
    // would silently validate the wrong (or no) message.
    if (this.turnStructuredOutput && method === 'item/completed') {
      const text = readCodexAgentMessageText(params);
      if (text !== null && itemBelongsToTurn(params, this.turnStructuredOutput.turnId)) {
        this.turnStructuredOutput.lastAssistantText = text;
      }
    }
    // P2.408 · codex's PLAIN `warning` — the channel that says the session is
    // running something incomplete. Read here rather than in the event adapter
    // because it needs the deferral below: it lands with `thread/started`, and
    // no turn exists yet. `AppServerClient` has already put the runtime's own
    // full sentence on the diagnostic channel; this is the operator's half.
    if (method === CODEX_WARNING_METHOD) {
      this.noteCodexServerWarning(params);
      return;
    }
    // P2.508 · an MCP server that did not come up. Read here for exactly the
    // reason the `warning` branch above is: measured on the shipped binary the
    // frame lands ~1 ms after the `thread/start` response, before any turn
    // exists, so it needs the same push-or-defer. See
    // {@link codexMcpStartupFailureNotice} for the two mechanisms codex offers,
    // why they are mutually exclusive, and why `mcpServerStatus/list` is not
    // the channel it looks like.
    if (method === CODEX_MCP_STARTUP_STATUS_METHOD) {
      const notice = codexMcpStartupFailureNotice(params);
      if (notice) this.surfaceCodexOperatorNotice(notice);
      return;
    }
    // P3.270 · MODEL REROUTED — the strongest fact in the set this host was
    // dropping. `ModelReroutedNotification { threadId, turnId, fromModel,
    // toModel, reason }` says the model that answered is NOT the model the user
    // picked, and at `rust-v0.148.0` its `ModelRerouteReason` has exactly one
    // member, `"highRiskCyberActivity"` — so this is a SAFETY substitution the
    // runtime performed on its own. Pi and claude have no equivalent silent
    // swap, which makes it switch-visible by the wave's own test, and until this
    // branch the session simply ran on a different model with nothing said.
    // P6.399 · codex says its own skill set moved. Re-read it rather than
    // assuming a list we never fetched still matches — the circularity that
    // used to justify ignoring this notification.
    if (method === 'skills/changed') {
      void this.syncCodexSkillsConfig('skills/changed');
      return;
    }
    if (method === 'model/rerouted') {
      this.surfaceCodexOperatorNotice(describeCodexModelReroute(params));
      return;
    }
    // P3.270 · DEPRECATION NOTICE — `{ summary, details }`, the runtime telling
    // us a thing we depend on is going away. Same operator-notice path as
    // `warning` and `configWarning`: it lands around bootstrap, so it needs the
    // push-or-defer queue rather than a bare push.
    if (method === 'deprecationNotice') {
      this.surfaceCodexOperatorNotice(describeCodexDeprecationNotice(params));
      return;
    }
    // P3.270 · the honest state for everything that is neither handled nor
    // opted out: RECORDED, once per family per session, rather than dropped in
    // silence. This is deliberately the diagnostic channel and not the
    // transcript — these are families with no reader yet, so there is nothing
    // to tell the user; what was missing was any trace that they arrive at all,
    // which is what made "57 families are dropped" a fact nobody could check
    // from a running session.
    this.noteUnreadCodexNotification(method);
    // P3.2 · remember the latest guardian DENIAL on our thread so `/approve`
    // (`approveGuardianDeniedAction`) can replay its assessment event. Reached
    // only for our own thread — a foreign thread returned above.
    if (method === 'item/autoApprovalReview/completed'
      && (params as { review?: { status?: unknown } } | null | undefined)?.review?.status === 'denied') {
      this.lastGuardianDeniedEvent = params;
      // P2.407 · RECORD WHAT WAS REVIEWED. Both auto-review notifications carry
      // an `action` beside the `review`, and it was read in zero files: the
      // verdict reached us, the SUBJECT did not. So a denial that changed a
      // permission outcome left behind "Auto-review denied this action" with
      // "this action" naming nothing — an influence on permissions with no
      // receipt, which P2.384 called worse than an absent one.
      //
      // Recording, not deciding: the row says read `action` and record what
      // arrives before proposing any behaviour change, and nothing here routes
      // on it. The remaining half is the user-facing line — the adapter's
      // "Auto-review denied this action" should name the action too — and that
      // is a `backend/codex/event-adapter.ts` edit, outside this lane's files.
      const action = (params as { action?: unknown }).action;
      const described = describeGuardianReviewAction(action);
      this.debug(
        `Codex auto-review DENIED: ${described ?? 'the action was not readable on the notification'}`,
      );
      // P6.579 · Pi's `guardianDenied` cause. Codex's auto-review IS the judge
      // Pi calls the guardian, and this notification is the moment its verdict
      // becomes final, so the event carries the same four fields here.
      this.emitCodexPermissionDeniedHook(
        CodexAgent.codexReviewActionToolName(action),
        this.codexReviewDeniedToolInput(action, params), // F1.384 — an MCP call's own arguments, Pi's tool_input
        described
          ? `Auto-review denied this action: ${described}`
          : 'Auto-review denied this action.',
      );
    }
    // C3.67 · the codex file-checkpoint producer. BEFORE the adapter, because
    // this is the pre-image and the adapter only renders the row; and beside the
    // adapter rather than inside it, because the adapter is a pure mapper with
    // no session path and no disk of its own.
    if (method === 'item/started') {
      this.checkpointCodexFileChange((params as { item?: unknown } | undefined)?.item); this.noteCodexNativeWebSearch(method, params); // F1.598
    } else if (method === 'item/completed') {
      this.finalizeCodexFileChange((params as { item?: unknown } | undefined)?.item);
      // D1.342 · and the read-before-write ledger, from the ITEM rather than
      // from the adapter's `tool_start` — for the same reason the checkpoint is
      // taken here: this runs ABOVE `adapt()`, and the item is the only place
      // `exitCode` exists (the `tool_result` frame carries `isError`, which
      // cannot tell exit 1 from exit 127). D1.350 corrected half of what this
      // comment used to say: the adapter no longer DROPS `commandActions`, it
      // publishes the same parse this credit reads, through the one shared
      // `readCodexCommandActions`. Beside the adapter, not inside it.
      this.creditCodexFileRead((params as { item?: unknown } | undefined)?.item);
    }
    for (const event of this.eventAdapter.adapt(method, params)) {
      // P3.335 · mint the tool-call hook events from the SAME stream the
      // transcript is built from. See `noteCodexToolCallForHooks`.
      this.noteCodexToolCallForHooks(event);
      // C3.13 · and say, once, that a delegated agent's report is not scanned
      // here. Same stream, same reason: it is the only place this runtime can
      // see a delegation happen.
      this.noteCodexSubagentReportResidue(event);
      // P6.917 · the retry chip's CLEAR, and it is an inference said out loud.
      // codex announces no retry resolution (see `codexRetryChipStanding`), so
      // the honest signal is the model speaking again: the request being retried
      // has succeeded, because its answer is arriving. Emitted BEFORE the delta
      // so the chip is gone by the time the first characters land, and in the
      // same words Pi's `auto_retry_end` uses — `SessionManager` stamps
      // `statusType: 'retrying'` by matching that prefix, and a second spelling
      // would be a silent divergence between two runtimes.
      if (this.codexRetryChipStanding && event.type === 'text_delta') {
        this.codexRetryChipStanding = false;
        this.turnSink?.push(retryStatusEvent({ kind: 'succeeded' }));
      }
      this.turnSink?.push(event.type === 'complete'
        ? this.withCodexUsage(this.withStructuredOutput(event))
        : event);
    }
    // P2.437 · AFTER the adapter's events, so the durable notice is already on
    // the sink when the interrupt goes out, and BEFORE the `turn/completed`
    // branch below — which is the branch that settles the sink.
    if (this.eventAdapter.consumeAutoCompactionThrashTrip()) this.stopThrashingTurn();
    // P6.118 · and the compaction the same adapter call may have observed. Read
    // here, from the adapter's own funnel, rather than re-testing `method` and
    // `params`: `observedCompaction()` is where BOTH channels meet (the
    // `contextCompaction` item and the deprecated `thread/compacted`
    // notification), and a second predicate over the wire would be free to drift
    // from it.
    if (this.eventAdapter.consumeObservedCompaction()) this.emitCodexPostCompactHook();
    if (method === 'turn/completed') {
      // P3.335 · the input map is per TURN, not per session: a tool id cannot
      // recur across turns and an unbounded map on a long session is a leak.
      this.codexToolCallInputs.clear();
      // A finished turn's id must not survive it. `expectedTurnId` is a
      // precondition, so a steer carrying a stale id is REFUSED — and the user
      // would be shown a failure they did not cause, for a message that should
      // simply have been queued as the next turn.
      this.activeTurnId = null;
      this.finishTurnSinkAfterPendingSteers();
    }
  }

  /**
   * P2.408 — surface one `warning` where an operator can actually see it.
   *
   * Durable `info` + `level: 'warning'`, the one event family the session layer
   * PERSISTS (the same shape `guardianWarning` already uses), so the notice
   * survives a reload instead of scrolling past as a momentary status.
   *
   * PUSH OR DEFER, and the defer is the load-bearing half. Measured on the
   * shipped `codex-app-server` (rust-v0.148.0, 2026-08-29): the frame arrives in
   * the same flush as `thread/started`, which `createRuntime` triggers long
   * before `chatImpl` sets `turnSink`. A straight push would report nothing at
   * all for the only class we can name.
   *
   * Structurally no-throw: this runs inside the transport's notification
   * dispatch, where a throw would take the rest of the notification with it.
   */
  private noteCodexServerWarning(params: unknown): void {
    let notice: string | null = null;
    try {
      notice = codexServerWarningNotice(params);
    } catch (error) {
      // The classifier is pure and defensive, so this is unreachable by design —
      // and a channel that exists to end a silence must not be able to create a
      // new one, so the failure itself is reported rather than swallowed.
      this.debug(`Codex warning classifier threw: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!notice) return;
    // F1.734 · codex repeats the constant on every turn (the 1.41.0 sitting); once said with its
    // caveat, a repeat is a log line, never another transcript row.
    if (this.modelMetadataConstantNoted && isCodexModelMetadataConstantWarning(params)) {
      this.debug(`Codex model-metadata warning repeated (a constant, already said this session): ${notice}`);
      return;
    }
    this.surfaceCodexOperatorNotice(notice);
    // P6.580 · and the sentence codex's own warning cannot carry. See the method.
    this.noteCodexModelMetadataConstantOnce(params);
  }

  /**
   * P6.580 — codex's "Model metadata for `X` not found" warning is a CONSTANT on
   * this product, and read as a signal it is actively misleading.
   *
   * MEASURED by W6-l (P6.164, `437a9b7f4`) by driving the shipped darwin-arm64
   * `codex-app-server` with an isolated `CODEX_HOME` from the real
   * `buildCodexConfigToml`: a model id no catalogue serves (`opus`) is forwarded
   * VERBATIM, the turn runs to `turn/completed`, and neither `configWarning` nor
   * `model/verification` is emitted at all. The one notification naming the id is
   * this `warning` — and the CONTROL arm, pinned to the gateway's own
   * `tgpt/qwen35-397b-a17b-fp8`, emits the identical sentence with its own id,
   * because codex's catalogue does not know that model either.
   *
   * So the warning fires on EVERY Nessy codex session and says nothing about
   * whether the pinned id resolved. Surfaced alone — which is what happened
   * until this method — it reads as "your model is broken", and a user acting on
   * it would change a model that is working.
   *
   * Native mechanism: NONE. The binary's warning is the constant; there is
   * nothing to configure and nothing else to read, so the honest sentence is the
   * whole deliverable. It names the id THIS session asked for; codex's own
   * sentence, with the id codex names, sits beside it on the same channel, so a
   * mismatch between the two is visible to the reader without us parsing prose
   * out of a warning.
   *
   * Once per session: the warning arrives per thread, and a repeated caveat on
   * an eight-deep queue would crowd out facts that are not constants.
   */
  private noteCodexModelMetadataConstantOnce(params: unknown): void {
    if (this.modelMetadataConstantNoted) return;
    if (!isCodexModelMetadataConstantWarning(params)) return;
    this.modelMetadataConstantNoted = true;
    if (!i18n.isInitialized) setupI18n();
    this.surfaceCodexOperatorNotice(i18n.t('chat.codexModelMetadata.constant', {
      model: this._model,
    }));
  }

  /** Latched per agent: the caveat is about the warning's nature, not about one arrival. */
  private modelMetadataConstantNoted = false;

  /**
   * P2.408/P3.120 — push one operator notice onto the transcript, or hold it for
   * the next turn.
   *
   * Extracted from {@link noteCodexServerWarning} so P3.120's `configWarning`
   * half rides the SAME queue rather than a second one beside it. Two queues
   * would each need their own bound, and the two channels are fed by the same
   * producer at the same moment (both land around `initialize`/`thread/start`),
   * so one shared ceiling is the honest bound on what a runtime can put in front
   * of a user before the user has done anything.
   */
  private surfaceCodexOperatorNotice(notice: string, opts?: { holdForNextTurn?: boolean }): void {
    const event: AgentEvent = { type: 'info', message: notice, level: 'warning' };
    // C3.361 · `holdForNextTurn` is for a caller that runs while `turnSink` is
    // non-null and ALREADY DRAINED. The Stop hook is the one such caller:
    // `chatImpl`'s `finally` awaits `emitStopHookOnce()` BEFORE it clears the
    // field, so a straight push there lands in a queue whose consumer has
    // finished — measured, the notice reached neither turn. The field is not a
    // reliable "is anyone listening" test for that one moment, so the caller
    // that knows it says so.
    if (this.turnSink && !opts?.holdForNextTurn) {
      this.turnSink.push(event);
      return;
    }
    // 8 is not a tuning knob; it is a ceiling on an unbounded producer. One frame
    // per `thread/start` means a session would have to re-fork its thread eight
    // times without the user taking a single turn to reach it.
    if (this.pendingServerWarningNotices.length >= 8) return;
    if (this.pendingServerWarningNotices.includes(notice)) return;
    this.pendingServerWarningNotices.push(notice);
    this.debug(`Codex warning held for the next turn: ${notice}`);
  }

  /**
   * C3.361 — the two universal hook fields codex dropped: `systemMessage` and
   * `stopReason`.
   *
   * ## What claude does, and why it is not portable
   *
   * `hooks.md#json-output`, the universal field table, verbatim: `systemMessage`
   * is a *"Warning message shown to the user."* and `stopReason` the *"Message
   * shown to the user when `continue` is `false`. It stays in the conversation,
   * so Claude sees it if the conversation continues"*. On claude the host renders
   * neither — `packages/shared/src/plugins/hooks-automation.ts` symbol
   * `sdkUniversalHookOutput` hands both straight back to the SDK, and the
   * vendored runtime renders them (it is the same runtime that owns the
   * `continue: false` sentence: "Operation stopped by hook" occurs 5 times in
   * `node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`, instrument
   * `grep -aoF … | wc -l`, i.e. OCCURRENCES, 2026-09-12).
   *
   * codex has no equivalent to hand them to: this fork's hooks are host-side on
   * this runtime by an owner ruling (P3.335 records it — a codex-native
   * `[hooks]` entry "would hand codex something to execute that we neither wrote
   * nor can revoke"). So step 1 of native-first is refused-by-policy rather than
   * missing, and the host is the seam, which is the same answer P3.335 and
   * P6.579 already gave for the events themselves.
   *
   * ## Why this surface
   *
   * {@link surfaceCodexOperatorNotice} — durable `info` + `level: 'warning'`,
   * the one family the session layer persists, and the same push-or-defer queue
   * every other codex operator notice uses. A hook can fire before the turn sink
   * exists (`SessionStart` and `UserPromptSubmit` both run ahead of it in
   * `chatImpl`), and `flushPendingServerWarnings` then puts the line at the head
   * of the SAME turn rather than a later one.
   *
   * The event name is prefixed because the sentence is a hook's own words
   * arriving unannounced: on claude the runtime renders it as an informational
   * message, which carries its provenance in the surface itself; here it would
   * otherwise be an anonymous warning in the transcript.
   *
   * ## Two deliberate gaps
   *
   *  1. `stopReason` is gated on `continue === false`, because that is the
   *     condition the page attaches the field to. A `stopReason` printed without
   *     it would tell the user a turn ended when it did not.
   *  2. The MODEL half of a stop is not this method's: `recordHookBlockFeedback`
   *     (`base-agent.ts`) queues `decision.reason` onto the next turn, and
   *     `packages/shared/src/automations/hook-command.ts` symbol
   *     `parseHookOutputForEvent` deliberately does NOT copy `stopReason` into
   *     `reason` — the two are the user half and the model half of one stop.
   *
   * NOT called from the `UserPromptSubmit` block branch: that branch returns
   * before the turn sink opens, so it yields its own `info` row and renders the
   * stop's sentence as the turn's `error` row — one stop, one sentence.
   */
  private surfaceHookUserFacingOutput(
    event: string,
    result: AgentEventExecutionResult | undefined,
    opts?: { holdForNextTurn?: boolean },
  ): void {
    const universal = result?.universal;
    const systemMessage = universal?.systemMessage?.trim();
    if (systemMessage) this.surfaceCodexOperatorNotice(`${event} hook: ${systemMessage}`, opts);
    if (universal?.continue !== false) return;
    const stopReason = universal.stopReason?.trim();
    if (!stopReason) return;
    // "asked to stop", not "stopped this turn": on codex a `Stop` hook's
    // `continue: false` cancels nothing — hooks.md#stop-decision-control gives
    // the event no cancel at all, only feedback — and a notice held for the next
    // turn would otherwise name the wrong turn.
    this.surfaceCodexOperatorNotice(`${event} hook asked to stop: ${stopReason}`, opts);
  }

  /**
   * P3.120 — raise the `configWarning` diagnostic P3.81 wrote onto a surface a
   * real user on a real build can actually see.
   *
   * ## What P3.81 left, honestly, and why it was still silent
   *
   * P3.81 made codex's `configWarning` audible by classifying it in
   * `AppServerClient.handleLine` and putting one sentence on the `onDiagnostic`
   * channel. This agent binds that channel to {@link debug} — and `debug()`
   * routes through electron-log, whose transports the PACKAGED main process
   * disables (the trap register's own "an empty packaged `main.log` is not
   * evidence"). So for a user on a shipped build the line reached nobody: the
   * class it reports is *"this session has NO projected non-negotiable deny
   * rules and NO durable Always-Allow grants"*, and that stayed invisible.
   *
   * ## Why the classifier's own sentence, matched rather than re-derived
   *
   * The wording was already written and argued (`config-warning.ts`,
   * `describeCodexConfigWarning`). Re-deriving it here would be a second
   * classifier for one channel, which this tree has measured going wrong the
   * ordinary way — a string spelled twice eventually disagrees with itself.
   *
   * It is MATCHED on its prefix rather than imported because
   * `codex-agent-server/src/config-warning.ts` is on neither the package barrel
   * nor its `exports` map, so `@nessy-agent/codex-agent-server` cannot reach it
   * today. The prefix is already treated as this module's published shape by
   * P3.81's own live gate (`config-warning-live.test.ts` selects diagnostics
   * with the same `startsWith`), so the coupling is one that already exists
   * rather than one introduced here. Exporting the classifier and importing it
   * is strictly better and is a one-line change in a file this lane does not
   * own; see the row's report.
   *
   * ## Same shape as its sibling, deliberately
   *
   * Durable `info` + `level: 'warning'` — the one family the session layer
   * persists — and the same push-or-defer queue, because a `configWarning`
   * lands in the same flush as the `initialize` response, long before any turn
   * exists (measured by P3.81 at 92 ms on darwin-arm64 and 260 ms under
   * Rosetta). A straight push would have surfaced it exactly never.
   */
  private noteCodexConfigWarningDiagnostic(message: string): void {
    if (!message.startsWith(CODEX_CONFIG_WARNING_DIAGNOSTIC_PREFIX)) return;
    this.surfaceCodexOperatorNotice(message);
  }

  /**
   * P3.267 — the config-writer families that carry a switch-visible fact.
   *
   * The row this closes is a HONESTY grading, not a missing channel: rows 26
   * (codex sandbox egress) and 28 (the execpolicy grant note) were graded
   * "honest" because they are reported — on `onDiagnostic`, which this agent
   * binds to {@link debug}, which a packaged build never writes (P3.120's
   * finding, re-recorded in the trap register as "an empty packaged `main.log`
   * is not evidence"). So they were honest two grades weaker than they read.
   * Nothing new is built here; the notice queue and its bound already exist.
   *
   * Matched on the formatters' own stable prefixes, so no classifier is written
   * and no prose is matched:
   *  - `codex-sandbox-egress-denied:` — `formatCodexSandboxEgressDiagnostics`
   *  - `codex-execpolicy-grant-unsandboxed:` and
   *    `codex-execpolicy-grant-sandbox-retained:` —
   *    `formatCodexExecpolicyGrantSandboxDiagnostics`, its two arms
   *  - {@link CODEX_APPROVAL_POSTURE_PREFIX} —
   *    `formatCodexUnboundedApprovalDiagnostics`, whose two arms share it
   *
   * FOUR OF THE PREFIXES ARE RESTATED HERE AND THAT IS A KNOWN COST, not an
   * oversight. They are inline template literals in
   * `codex-responses-adapter/src/config-writer.ts`; exporting them and importing
   * them is strictly better, and D1.358 did exactly that for the FIFTH entry
   * only — `CODEX_APPROVAL_POSTURE_PREFIX` is imported, because that row had to
   * add a constant to the writer anyway and the file was no longer held by
   * another lane. Converting the other four is a separate tidy: each moves a
   * formatter that row had no reading on. P3.120's sibling accepted the same
   * restatement for the same reason, and `codex-operator-notice-lift.test.ts`
   * pins each prefix against a real formatter output so the two cannot drift in
   * silence.
   *
   * Deliberately NOT lifted from the same sink: the P3.175 denied-path mirror
   * and the P6.14 refused-hook lines are PER ENTRY and can be many, and
   * {@link surfaceCodexOperatorNotice}'s bound is eight notices — a blanket lift
   * would push the two families this row is about off the queue.
   */
  private noteCodexConfigWriterDiagnostic(message: string): void {
    if (!CODEX_CONFIG_WRITER_USER_FACING_PREFIXES.some(prefix => message.startsWith(prefix))) return;
    this.surfaceCodexOperatorNotice(message);
  }

  /**
   * P3.267 — an administrator requirement this build did NOT apply reaches the
   * administrator.
   *
   * Same defect, same sink, one layer over: `probeCodexConfigRequirements`
   * reports every requirement it read and did not honour, and every one of those
   * lines went to `onDiagnostic → debug` and therefore to nobody on a packaged
   * build. The three prefixes are IMPORTED from the formatter's own module
   * rather than restated ({@link CODEX_REQUIREMENT_UNAPPLIED_PREFIXES}) — the
   * better shape its sibling above could not have, because that module is
   * reachable from here and `config-writer.ts` is not.
   *
   * Only the "we did not do it" bucket is lifted. `honoured`, `codexEnforced`
   * and `inapplicable` all say a control IS in force or has nothing to govern,
   * and an operator notice for a working control is how an eight-deep queue
   * fills with news nobody needs.
   */
  private noteCodexUnappliedRequirementDiagnostic(message: string): void {
    if (!CODEX_REQUIREMENT_UNAPPLIED_PREFIXES.some(prefix => message.startsWith(prefix))) return;
    this.surfaceCodexOperatorNotice(message);
  }

  /**
   * P6.78 — say WHEN this channel is read, once per session that carries a
   * requirement.
   *
   * ## The gap, which is a missing sentence rather than a missing carrier
   *
   * Codex's requirement channel and the host's composed managed policy run on
   * different clocks — `probeCodexConfigRequirements` per session after
   * `initialize`, the host's composition at each turn boundary, with what
   * `createStorageRuntime` built at boot waiting for a restart — and nothing
   * said so. The CARRIER was never missing: {@link surfaceCodexOperatorNotice}
   * and its bounded defer queue are the path P3.120/P2.408 built, and the sibling
   * above already rides it. Only the statement was absent.
   *
   * ## Native mechanism, asked and answered
   *
   * Both channels are already the runtime's own and both are already read. There
   * is nothing to enable and nothing to build per runtime: Pi and claude publish
   * no counterpart to `configRequirements/read`, which is also why P2.420
   * refused this as a switch-cost row — *"There is no set difference to state."*
   * What the host can do is make the residual difference HONEST, and this is
   * that, in the smallest form: a sentence rather than a mechanism.
   *
   * The value-COMPARING variant is deliberately NOT here. It would need a
   * registered cross-package bridge — this file is in `packages/shared`, which
   * cannot import `resolveHostSandboxSettings` — and that is the M variant and
   * the owner's call.
   *
   * ## LATCHED
   *
   * Once per agent. `createRuntime` can run more than once for one session (a
   * teardown and a re-spawn), and a clock statement repeated on every respawn is
   * how an eight-deep operator queue fills with a fact the user already has.
   */
  private noteCodexRequirementClock(reading: CodexConfigRequirementsReadingV1): void {
    if (this.announcedRequirementClock) return;
    const [line] = formatCodexRequirementClockDiagnostics(reading);
    if (!line) return;
    this.announcedRequirementClock = true;
    this.surfaceCodexOperatorNotice(line);
  }

  /**
   * P3.270 — record ONCE that an unread notification family arrived.
   *
   * Once per family per agent, because several of them are per-delta
   * (`item/reasoning/textDelta`, `process/outputDelta`) and a line each would
   * make the channel useless for the families that arrive once.
   *
   * A method that is in NEITHER classification list is reported differently and
   * on purpose: that is an upstream family this fork has never seen, which is
   * the case the classification exists to catch. `codex-notification-families`'
   * test fails the build when the vendored union grows, but a substituted or
   * newer binary can emit one without the schema in this tree moving.
   */
  private noteUnreadCodexNotification(method: string): void {
    // HANDLED FIRST, and this is the branch that makes the record usable. Most
    // handled families are read by the EVENT ADAPTER below, and this dispatch
    // falls THROUGH to it rather than returning — `turn/started`, `item/started`,
    // `item/completed`, `thread/status/changed` and the rest all reach this line
    // on a perfectly healthy session. Without this guard the families this host
    // reads best would each be announced as unclassified.
    if (HANDLED_CODEX_NOTIFICATION_METHOD_SET.has(method)) return;
    if (this.seenUnreadNotificationMethods.has(method)) return;
    this.seenUnreadNotificationMethods.add(method);
    if (UNREAD_CODEX_NOTIFICATION_METHOD_SET.has(method)) {
      this.debug(`codex notification not read by this host: ${method} (classified unread; see codex-notification-families.ts)`);
      return;
    }
    if (OPTED_OUT_CODEX_NOTIFICATION_METHOD_SET.has(method)) {
      // The suppression did not take. Its own class, because the two causes are
      // different repairs: an app-server that ignores the capability, or a name
      // that no longer exists upstream and is silently accepted.
      this.debug(`codex notification arrived DESPITE the opt-out: ${method} — optOutNotificationMethods was declared at initialize and this family came anyway`);
      return;
    }
    this.debug(`codex notification UNCLASSIFIED: ${method} — not in the handled, opted-out or unread lists; the app-server emits a family this build does not know`);
  }

  /**
   * P2.408 — drain {@link pendingServerWarningNotices} onto a turn that has just
   * opened its sink.
   *
   * Takes the queue explicitly rather than reading `this.turnSink`, for the same
   * reason `syncBackgroundTerminalsIntoSink` does: the caller owns the sink it
   * just created, and a later turn may already have replaced the field.
   */
  private flushPendingServerWarnings(queue: ReturnType<typeof createEventQueue>): void {
    for (const message of this.pendingServerWarningNotices.splice(0)) {
      queue.push({ type: 'info', message, level: 'warning' });
    }
  }

  /**
   * End the turn's event stream — but not before an in-flight `turn/steer` has
   * been answered.
   *
   * {@link redirect} cannot await the steer (it is synchronous and returns a
   * boolean), so a REFUSED steer is reported late, as `steer_undelivered` on
   * this same sink. Closing the sink the instant `turn/completed` lands would
   * race that report: `drain()` would already have returned and the user's
   * correction would be dropped in silence. The wait is one local stdio round
   * trip for a decision the server has already made.
   *
   * WHAT BOUNDS THE WAIT, since the transport does not. `AppServerClient.close()`
   * rejects every pending request, but it runs on teardown only, so it cannot
   * bound a live agent — the earlier version of this comment claimed otherwise
   * and that claim is what let one unanswered steer wedge the agent. The bound
   * is that every path which ends a turn DETACHES this turn's steers
   * ({@link detachTurnSteers}), so at worst a server that never answers holds
   * open the turn it belongs to and nothing else; the user's Stop finishes that
   * sink directly (`abort`/`forceAbort`), and the next turn starts clean.
   *
   * The sink and the steer set are read ONCE, here, and the deferred `finish()`
   * targets the captured `sink` — never `this.turnSink`, which a later turn may
   * already own. Finishing whatever happens to be current would truncate the
   * next turn's stream and leave this one's open forever.
   */
  private finishTurnSinkAfterPendingSteers(): void {
    const sink = this.turnSink;
    const steers = this.detachTurnSteers();
    if (!sink) return;
    if (steers.size === 0) {
      sink.finish();
      return;
    }
    void Promise.allSettled([...steers]).then(() => sink.finish());
  }

  /**
   * Hand back the current turn's pending steers and give the agent a fresh,
   * empty set — so a steer can never be awaited on behalf of a turn it does not
   * belong to.
   *
   * Called from every boundary that ends (or starts) a turn: `turn/completed`
   * via {@link finishTurnSinkAfterPendingSteers}, `abort`, `forceAbort`,
   * `clearHistory`, `teardownRuntime`, and both the top and the `finally` of each
   * `chatImpl` turn.
   *
   * NOT from the terminal-`error` handler, and this list said otherwise until the
   * code was read against it. That path drops `activeTurnId` — no further steer
   * may be aimed at the turn — but it does NOT finish the sink, because codex may
   * still send `turn/completed` afterwards. A steer already in flight there must
   * therefore stay ATTACHED, or its refusal would have nowhere to be reported and
   * the user's correction would vanish after `redirect` had already promised to
   * deliver it. The turn-start detach is what stops such a steer surviving into
   * the next turn.
   *
   * Replacing the set rather than clearing it
   * is deliberate: each steer's own `.finally` deletes itself from the set it
   * was ADDED to, captured in the closure, so a detached set drains itself and a
   * detached steer cannot touch the live one.
   */
  private detachTurnSteers(): Set<Promise<unknown>> {
    const steers = this.turnSteers;
    if (steers.size > 0) {
      this.debug(`Codex detaching ${steers.size} pending steer(s) from the ended turn`);
    }
    this.turnSteers = new Set();
    return steers;
  }

  /**
   * P6.111 · REFRESH THE TERMINAL LEVEL OUTSIDE A TURN, fire-and-forget.
   *
   * Two callers, and they close the two directions the turn-boundary sync
   * cannot:
   *
   * - **The turn's `finally`.** A terminal spawned during turn N is announced at
   *   the head of turn N+1, so between those two moments the level reads zero
   *   while real work is running — the window the reaper and the ceiling read
   *   in. Running one poll as the turn ends closes it: the idle TTL is thirty
   *   minutes and the sweep a minute, so a poll that starts within a second of
   *   the turn is far ahead of any decision either makes.
   * - **{@link backgroundWorkCount} on a non-zero count.** The other direction:
   *   a terminal that ends after the last turn would otherwise keep the session
   *   busy forever, because nothing polls again until the user sends.
   *
   * Never awaited by its callers and structurally no-throw (the callee's own
   * guarantee, belted again here), because both call sites are places where a
   * failure must not surface: one is a turn's teardown and the other is a
   * synchronous getter the reaper calls.
   */
  private scheduleBackgroundTerminalRefresh(): void {
    if (this.backgroundTerminalRefresh) return;
    if (this.backgroundTerminalsUnsupported) return;
    if (!this.client || !this.threadId) return;
    const now = Date.now();
    if (now - this.lastBackgroundTerminalRefreshAt < CODEX_BACKGROUND_TERMINALS_REFRESH_MIN_GAP_MS) return;
    this.lastBackgroundTerminalRefreshAt = now;
    this.backgroundTerminalRefresh = this.syncBackgroundTerminalsIntoSink({
      push: event => { this.deliverRefreshedTerminalEvent(event); }, // UA12.101: the host door when no turn is open
    })
      .catch(error => {
        this.debug(`Codex background-terminal refresh threw unexpectedly: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => { this.backgroundTerminalRefresh = null; });
  }

  /**
   * P3.3 · TURN-BOUNDARY background-terminal sync — poll the app-server's
   * `thread/backgroundTerminals/list` and push the resulting chip events onto the
   * turn's sink.
   *
   * WHY TURN START, and not `turn/completed`. Codex has no between-turns event
   * channel (Pi and, since F1.492, claude have one: `BackendConfig`'s sink), and
   * a turn's `complete` event makes `SessionManager` return its chat iterator, so
   * anything pushed after `complete` is dropped. The only reliable in-turn
   * delivery is BEFORE a turn's `complete`, which is why this runs at the head of
   * `chatImpl` (before `turn/start`) rather than when a terminal is first
   * observed. The out-of-turn refresh (UA12.101) uses `BackendConfig`'s sink when
   * no turn is open, so an exit seen between turns no longer waits for turn N+1.
   *
   * PROTOCOL-DRIFT SEATBELT (mandatory), and it degrades in THREE different ways
   * on purpose. The method is probed rather than assumed, because the pinned
   * bindings do not declare it even though the binary serves it. A DEFINITIVE
   * refusal (no such method / our params do not fit) latches
   * {@link backgroundTerminalsUnsupported} and writes one debug line; a TRANSIENT
   * failure writes a debug line and simply RETRIES at the next turn boundary.
   * Neither ever throws — a background-terminal poll must not be able to fail a
   * user's turn.
   *
   * THE THIRD IS NO ANSWER AT ALL, and it is the one this sits on the critical
   * path for (P2.245). "Never throws" was never the whole guarantee, because A
   * HANG IS NOT A THROW: every page below used to be an unbounded
   * `client.request`, and an app-server that IGNORES a method rather than
   * refusing it leaves that promise pending forever — with this `await` at the
   * head of `chatImpl`, that is the user's message followed by nothing, on EVERY
   * turn, with no status and no error. So the whole walk now runs under
   * {@link CODEX_BACKGROUND_TERMINALS_TIMEOUT_MS}: when it expires the turn
   * STARTS anyway, whatever pages did arrive are announced (the set is marked
   * incomplete, so no chip is retired on a prefix), one debug line says the
   * listing did not answer, and the next turn boundary asks again. A deadline is
   * transient by definition and deliberately does NOT latch — the capability is
   * not absent, the answer is.
   *
   * `list` is called with `{ threadId }` only. The binary declares
   * `struct ThreadBackgroundTerminalsListParams with 3 elements`, so two fields
   * are unsent; they are almost certainly the optional pagination pair this
   * app-server uses elsewhere (`cursor` / `limit`, both present in the binary),
   * and if either turns out to be REQUIRED the refusal arrives as serde
   * `missing field` — which the classifier treats as definitive, so we stop
   * asking instead of retrying a request that can never succeed.
   *
   * `thread/backgroundTerminals/clean` IS DELIBERATELY NOT CALLED, and that is a
   * decision rather than an oversight. It is the third method in the family —
   * live-confirmed as `clean {threadId}` → `{}`, thread-scoped, with no terminal
   * id to aim it at — so by both name and arity it is a whole-thread garbage
   * collect of settled entries, not a way to stop one terminal (`terminate` is
   * that).
   *
   * The two real harms, corrected: an earlier version of this comment claimed a
   * `clean`-induced disappearance would drop the chip with NO `task_completed`,
   * and that is FALSE — the exit branch fires on `current === undefined`, so it
   * does emit one, with status `completed`. That is precisely what makes it
   * dangerous rather than merely lossy:
   *   1. a terminal `clean` reaps while it is STILL RUNNING is reported to the
   *      user as **completed** — a confident wrong answer, not a missing one; and
   *   2. a terminal born and reaped between two polls is **never announced at
   *      all**, so work that ran leaves no trace in the UI.
   * If codex-side records ever need reaping it belongs to session teardown, as
   * its own row, where nothing is mid-diff.
   */
  private async syncBackgroundTerminalsIntoSink(
    sink: { push: (event: AgentEvent) => void },
    /** Budget for the WHOLE walk. Overridable so a test can pick a bound it can actually wait out; production takes the constant. */
    timeoutMs: number = CODEX_BACKGROUND_TERMINALS_TIMEOUT_MS,
  ): Promise<void> {
    // THE NO-THROW GUARANTEE IS STRUCTURAL, NOT INCIDENTAL. Everything below —
    // the RPCs, the parse, and the pushes — sits inside this one try. It used to
    // sit outside it: only the request was guarded, so a hostile `list` shape
    // reaching the parse would have propagated out of an `await` at the head of
    // `chatImpl` and failed the user's TURN, for a background-chip poll. The
    // row's mandate is that this can never happen, so the guarantee is now a
    // property of the code's shape rather than of which lines happen to throw.
    try {
      if (this.backgroundTerminalsUnsupported) return;
      const client = this.client;
      const threadId = this.threadId;
      if (!client || !threadId) return;

      // FOLLOW THE CURSOR. `nextCursor` is real (measured: `list {threadId}` →
      // `{"data":[],"nextCursor":null}`), and the exit half of the diff needs the
      // COMPLETE set — a prefix read as the whole set reports a running terminal
      // as finished. Bounded, because a server that always returns a cursor must
      // not be able to spin a turn's head: on exhausting the bound we hand the
      // adapter `complete: false`, which keeps announcements flowing and holds
      // back only the disappearance arm.
      const MAX_PAGES = 10;
      const entries: unknown[] = [];
      let cursor: string | null = null;
      let complete = false;
      let deadlineExpired = false;
      // ONE budget for the whole walk, spent across the pages — see
      // {@link CODEX_BACKGROUND_TERMINALS_TIMEOUT_MS} for why per-call would not
      // bound what the user waits for. `performance.now()` rather than
      // `Date.now()` because this is a duration: a monotonic clock cannot be
      // moved backwards by the host (or by a test that sets the system time) into
      // a walk that skips every page without asking.
      const deadlineAt = performance.now() + timeoutMs;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const remainingMs = deadlineAt - performance.now();
        if (remainingMs <= 0) { deadlineExpired = true; break; }
        const result: unknown = await requestWithinDeadline(
          client,
          'thread/backgroundTerminals/list',
          cursor === null ? { threadId } : { threadId, cursor },
          remainingMs,
        );
        if (result === CODEX_REQUEST_TIMED_OUT) { deadlineExpired = true; break; }
        entries.push(...extractCodexBackgroundTerminals(result));
        cursor = readCodexBackgroundTerminalsCursor(result);
        if (cursor === null) { complete = true; break; }
      }
      // Two ways to reach an incomplete set, and they are not the same fact: one
      // server is answering and paging without end, the other is not answering.
      // Both hand the adapter `complete: false` — announcements keep flowing and
      // only the disappearance arm is held back — but the line an operator reads
      // has to name which one happened.
      if (deadlineExpired) {
        this.debug(
          `Codex background-terminal listing did not answer within ${timeoutMs}ms; `
          + `the turn starts anyway and the set is treated as incomplete `
          + `(announcements only, no completions). Retrying at the next turn boundary.`,
        );
      } else if (!complete) {
        this.debug(
          `Codex background-terminal listing still had a cursor after ${MAX_PAGES} pages; `
          + `treating the set as incomplete (announcements only, no completions).`,
        );
      }

      for (const event of this.eventAdapter.syncBackgroundTerminals(entries, { complete })) {
        sink.push(event);
      }
    } catch (error) {
      if (isDefinitiveBackgroundTerminalsRefusal(error)) {
        this.backgroundTerminalsUnsupported = true;
        this.debug(
          `Codex background terminals disabled for this runtime — thread/backgroundTerminals/list `
          + `was refused definitively (${error instanceof Error ? error.message : String(error)}).`,
        );
      } else {
        this.debug(
          `Codex background-terminal poll failed transiently, will retry next turn `
          + `(${error instanceof Error ? error.message : String(error)}).`,
        );
      }
    }
  }

  /**
   * R18 · map a schema-bearing turn's result onto its `complete` event.
   *
   * THE CONTRACT IS THE HOST'S, NOT CODEX'S. The three fields below are the
   * only ones a `complete` may carry for this
   * (`__tests__/adjacent-backend-frozen-contract.test.ts`'s `EVENT_FIELDS`),
   * and their meanings are fixed by the two runtimes that already emit them —
   * `backend/claude/event-adapter.ts:898` off the SDK's result message and
   * `pi-agent-server/src/index.ts`'s `runTurnStructuredOutputValidation` — plus
   * the one consumer that branches on them, `apps/cli/src/index.ts:792`:
   *
   *   - valid JSON matching the schema → `success` + `structuredOutput`
   *   - anything else                  → `error_max_structured_output_retries`
   *                                      + `structuredOutputErrors`, and the
   *                                      matching terminal reason
   *   - no assistant message at all    → `success` with NO `structuredOutput`
   *                                      and the errors entry Pi uses verbatim
   *                                      (the CLI's third branch)
   *
   * The error subtype is named for retries this arm does not run, and that is
   * deliberate rather than sloppy: it is the ONLY violation arm the frozen
   * contract has, Pi already reuses it for its own no-retry endings (an errored
   * attempt), and it is what makes the CLI print "Could not produce valid
   * structured output" instead of silently succeeding. Codex does the
   * constraining itself, so a violation reaching here means the constraint did
   * not hold — see the `turn/start` call site for when that happens.
   *
   * DELIBERATELY NOT ONE-SHOT, and the first version of this was: a second
   * `turn/completed` can reach an open sink (a server-side compaction turn on
   * this thread), and `BaseAgent.chat`'s pass loop HOLDS BACK every reason-free
   * `complete` and yields only the LAST one — measured, `base-agent.ts:3982`.
   * Clearing the state on the first completion therefore made the second one
   * bare and the caller saw a turn with NO structured result at all. Re-reading
   * the same `lastAssistantText` is deterministic, so every completion of the
   * turn carries the same answer; the state's real scope is the turn, and
   * `chatImpl`'s `finally` is what owns it.
   *
   * A STOPPED TURN IS NOT A STRUCTURED-OUTPUT FAILURE, which is the arm Pi has
   * and this did not: its loop forwards the held `agent_end` UNENRICHED when
   * `state.aborted` (`pi-agent-server/src/index.ts:4043`). The race is real
   * rather than theoretical — {@link abort} sets `aborted`, then AWAITS
   * `turn/interrupt`, and only then finishes the sink, so a `turn/completed`
   * landing inside that await reaches this mapper with the turn's text
   * truncated or never written. Reporting that as
   * `error_max_structured_output_retries` would tell the user their schema
   * could not be satisfied when what actually happened is that they pressed
   * Stop. `chatImpl` resets the flag at the top of every turn, so this cannot
   * leak into the next one.
   */
  private withStructuredOutput(event: AgentEvent & { type: 'complete' }): AgentEvent & { type: 'complete' } {
    if (this.aborted) return event;
    const state = this.turnStructuredOutput;
    if (!state) return event;

    const text = state.lastAssistantText?.trim() ?? '';
    if (!text) {
      return {
        ...event,
        structuredOutputSubtype: 'success',
        structuredOutputErrors: ['run completed without a structured output'],
      };
    }
    const validated = validateStructuredOutputText(state.compiled, text);
    if (validated.ok) {
      return { ...event, structuredOutputSubtype: 'success', structuredOutput: validated.value };
    }
    return {
      ...event,
      structuredOutputSubtype: 'error_max_structured_output_retries',
      structuredOutputErrors: validated.errors,
      terminalReason: 'structured_output_retry_exhausted',
    };
  }

  /**
   * Attach this turn's usage to the adapter's bare `complete`.
   *
   * The counts come from the UsageTracker the `thread/tokenUsage/updated`
   * notifications feed, which is the only place codex reports them; the adapter
   * stays pure. `costReporting: 'unsupported'` is the substantive half: the
   * app-server's token-usage payload carries token counts and no money field
   * at all (`CodexTokenUsage`), so a cost of zero here would be a
   * number nothing produced.
   */
  private withCodexUsage(event: AgentEvent & { type: 'complete' }): AgentEvent {
    const usage = this.usageTracker.getLastMessageUsage();
    if (!usage) {
      return event;
    }
    // The tracker's snapshot survives across turns, and the session layer
    // ACCUMULATES outputTokens off this event. A turn that produced no new
    // notification would therefore re-add the previous turn's output, so a
    // re-seen snapshot contributes context (assigned) and no output (added).
    const isFresh = usage.timestamp !== this.lastEmittedUsageTimestamp;
    this.lastEmittedUsageTimestamp = usage.timestamp;
    const contextWindow = this.usageTracker.getContextWindow();
    return {
      ...event,
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: isFresh ? usage.outputTokens : 0,
        ...(contextWindow === undefined ? {} : { contextWindow }),
        costReporting: 'unsupported',
      },
    };
  }

  /**
   * P2.195 — codex establishes no USD figure on the wire this agent reads.
   *
   * {@link withCodexUsage} stamps `costReporting: 'unsupported'` on every
   * `complete` it decorates, and that is the per-TURN half. This is the
   * per-RUNTIME half, which `BaseAgent.takeUnenforceableBudgetNotice` needs for
   * the `absent` case: `withCodexUsage` returns the event UNDECORATED when
   * `this.usageTracker.getLastMessageUsage()` is falsy, so an error, abort or
   * sub-flow turn, or any turn whose tracker has no snapshot, yields a bare
   * `complete` → `classifyEventCost` = `absent` → `notMetered` false (the base
   * default is `true`) → no notice, and a configured `maxBudgetUsd` reads as a
   * satisfied budget check.
   *
   * THE DISTINCTION THIS KEEPS: the question is whether the RUNTIME can price,
   * never whether one completion carried usage. `claude-agent.ts` and
   * `pi-agent.ts` both emit usage-less `complete`s on error and abort paths and
   * CAN price; collapsing the two would fire the notice on healthy sessions.
   *
   * NOT A PROTOCOL IMPOSSIBILITY — A CHOICE OF WIRE, AND ONE WITH AN EXPIRY.
   * `thread/tokenUsage/updated`, the only usage notification this agent reads,
   * carries token counts and no money field. But
   * `ThreadUsage.estimatedUsageUsdMicros` (`bigint | null`,
   * `packages/codex-protocol/generated/v2/ThreadUsage.ts`) IS a real USD figure,
   * on `GetAccountTokenUsageResponse` — an RPC with zero callers in this repo.
   * WHOEVER WIRES IT MUST DELETE THIS OVERRIDE, or the app will keep announcing
   * that it cannot price a runtime that by then can — a false statement is worse
   * than the silence this override was written to end. P2.258 holds the other
   * half: `BaseAgent.chat`'s `maxBudgetUsd` cap already runs for codex but
   * accumulates `usage.costUsd`, which the codex adapter emits nowhere, so today
   * the ceiling is inert as well as unenforceable (`config-writer.ts`, the
   * `buildCodexConfigToml` preamble, measures that absence against the schema).
   */
  protected override reportsCostUsd(): boolean {
    return false;
  }

  /**
   * Server→client request handler. Approval requests bridge to Nessy's
   * permission round-trip: we surface `onPermissionRequest` and return a Promise
   * that resolves to the method's own JSON-RPC response — `{decision}` for the
   * exec/patch families, `{action}` for an MCP elicitation — when
   * `respondToPermission` fires. Headless (no permission callback) auto-approves
   * so unattended turns complete.
   *
   * A method that is NOT an approval but whose feature we do not implement gets
   * the refusal its own schema defines (`buildUnsupportedResponse`). `{}` — the
   * generic empty JSON-RPC result — is left only for a genuinely unknown method
   * and for the two whose responses are pure required credentials, where every
   * value we could invent would be a forged one.
   *
   * R13 — `dontAsk` is answered here and never shown. Its contract is the same
   * sentence on every runtime, "never prompt; run what the rules pre-approve,
   * deny the rest", and BOTH halves are enforced on this path: the rule consult
   * below may still allow, and everything it does not allow is refused without a
   * card.
   *
   * WHICH METHODS THIS REACHES, stated at the width it was actually measured —
   * an earlier draft of this comment claimed it applied only with the sandbox
   * master switch off, and that is wrong for half the methods here:
   *
   * - COMMAND APPROVALS (the exec/patch families) are gated by
   *   `approval_policy`. With the sandbox ON, `dontAsk` emits `never` and codex
   *   raises none of them, so this branch is unreachable for those. With the
   *   switch OFF it used to emit `untrusted` (R13's config half) and they
   *   arrived — and THAT HALF IS GONE since `rust-v0.150.1` retired the value
   *   (P7.2): the switch-off emission is `on-request`, under which codex's own
   *   decision table `Allow`s an unmatched command instead of raising it. So
   *   with the switch off this branch is now reached only by a DANGEROUS
   *   command or a sandbox-escalation request. `UNBOUNDED_NEVER_DEGRADES_TO`
   *   (`codex-responses-adapter/src/config-writer.ts`) carries the source
   *   reading and the operator notice.
   * - `mcpServer/elicitation/request` is NOT a command approval and is NOT
   *   gated by `approval_policy` at all — it originates from an MCP server, not
   *   from codex's approval loop. So the `dontAsk` deny is live for it in BOTH
   *   switch positions, measured on an isolated rig: before R13 the mode
   *   surfaced a card; after it, `{action: 'decline'}` and no card.
   *
   * Declining an elicitation under `dontAsk` is the intended reading of "never
   * prompt" and matches what Pi already does for interaction-required tools
   * (`core/pre-tool-use.ts`). It is named here because it means R13 is not
   * switch-off-scoped, which is what the first version of this paragraph said.
   */
  private handleServerRequest(method: string, params: unknown): unknown | Promise<unknown> {
    // P6.344 · codex's own clarifying-question channel, which was already
    // ROUTED here and answered `{ answers: {} }` because no host surface was
    // bound to it. Native-first is satisfied twice over — codex's protocol
    // carries the request, and the host already renders this exact card for Pi
    // and claude — so nothing new is built: the request is mapped onto
    // `AskUserPermissionRequest` and handed to the same shared bridge
    // `elicitationAsk` uses.
    if (method === CODEX_REQUEST_USER_INPUT_METHOD) {
      return this.handleCodexRequestUserInput(params);
    }
    if (!isApprovalMethod(method)) { if (method === CODEX_CHATGPT_AUTH_TOKENS_REFRESH_METHOD && this.chatGptSubscriptionSlug()) return this.answerChatGptSubscriptionRefresh(params); // F1.202 — elsewhere `{}` stands
      return buildUnsupportedResponse(method, params, this.reportDegradedApproval) ?? {};
    }

    const kind = approvalKindForMethod(method);
    const requestId = randomUUID();
    const deniesWithoutAsking = this.getPermissionMode() === 'dontAsk';
    const surfaceToUser = this.onPermissionRequest;

    // P2.140 — THE FLOOR, computed before anything here can answer.
    //
    // Until this gate existed the floors did not run on codex at all: measured
    // on the production path 2026-08-25, an `item/commandExecution/requestApproval`
    // for `rm -rf ~` returned `{decision:'accept'}` with no card whenever an
    // ordinary `allow: ['Bash(rm:*)']` rule was active, `{decision:'accept'}`
    // headless, and otherwise raised a card whose Always Allow was accepted. The
    // same rule cannot clear the same floor on Pi, so one rule meant two
    // different things depending on which runtime read it.
    //
    // Its position is the whole fix: ABOVE the headless yes and ABOVE the rule
    // consult, the two things that could otherwise answer. Nothing about what
    // codex asks for changes; what changes is what our side is allowed to say.
    const floor = this.floorVerdict(kind, params), unnamedPatch = codexPatchUnnamed(kind, this.codexFileChangeApprovalPaths(params), message => this.debug(message)); // F1.719 — see the helper

    // The `Remove-Item` ladder's two rungs are denied "in every mode, without
    // asking you" — so this returns before any card and in every mode.
    if (floor?.outcome === 'deny') {
      const why = `Denied by the ${floor.floor} floor: ${floor.description}`;
      this.debug(`codex approval denied by the ${floor.floor} floor: ${floor.description}`);
      // P6.1 — the same sentence the log gets, on the one channel the protocol
      // gives a refusal. It lands on the v1 kinds only; `buildApprovalResponse`
      // records why v2 has nowhere to put it.
      return buildApprovalResponse(kind, params, false, undefined, this.reportDegradedApproval, why);
    }

    // P6.62 — THE `deniedPaths` FLOOR, which on codex reached a card instead of
    // a refusal.
    //
    // ## What was wrong
    //
    // `shouldAllowToolInMode` carries the deny-path verdict, and on this runtime
    // it was consulted in exactly ONE place: inside `consultPermissionRules`,
    // AFTER a user rule had already matched. So the guard did its job for a user
    // who happened to have written a rule covering the same call, and for
    // everyone else a `cat ~/.aws/credentials` produced an ordinary approval
    // card — the outcome Pi and claude both refuse outright. The credential
    // floor on codex therefore rested entirely on the OS sandbox profile
    // (P3.175's `permissions.filesystem` mirror), which is real and stronger
    // than any tool-mediated gate but is not the whole answer: P3.308 measured a
    // root-anchored deny making the profile fail to BUILD rather than deny.
    //
    // ## Why it is HERE and not in `findNonNegotiableFloors`
    //
    // That function is SHARED — Pi and claude run the same four floors out of
    // it — so adding a fifth there would change all three runtimes to close a
    // gap only one of them has. This is the codex-shaped half of a floor the
    // other two already enforce on their own paths, so it goes on the codex
    // answer path, reading the SAME matcher through the same public entry
    // (`shouldAllowToolInMode` → `getDeniedPathViolation`) rather than a second
    // copy of it. `NestorCloudAgent.deniedResultPaths` and
    // `PiAgent.handleDeniedResultPathsRequest` are the two precedents for
    // reading that flag from outside the pipeline.
    //
    // ## Position: above the headless yes, above the card, in every mode
    //
    // Same reason P2.140 puts `floorVerdict` where it is. A deny path is not a
    // thing to ask a human about — `mode-types.ts` documents these as must not
    // be read or written in ANY permission mode — so it must also outrank the
    // unattended fallback's yes and the `bypassPermissions` answer P6.61 added
    // just below.
    const deniedPathRefusal = this.deniedPathVerdict(kind, params);
    if (deniedPathRefusal) {
      this.debug(`codex approval denied by the deniedPaths floor: ${deniedPathRefusal}`);
      return buildApprovalResponse(
        kind, params, false, undefined, this.reportDegradedApproval, deniedPathRefusal,
      );
    }

    // D1.342 — READ BEFORE WRITE, the third thing our side is not allowed to
    // say yes to, and it sits here for the reason the two above it do.
    //
    // No permission answer can satisfy *"the conversation has not seen this
    // file"*, so a card in front of it would be a click that changes nothing —
    // which is why Pi refuses before `onFileMutationAuthorized` and claude
    // refuses before its own gate. It is BELOW `deniedPathVerdict` because a
    // deny-path is the stronger refusal and should keep naming itself, and
    // ABOVE the rule consult, the headless yes and the card, all three of which
    // could otherwise approve an overwrite of bytes nobody looked at.
    const unseenWriteRefusal = this.readBeforeWriteVerdict(kind, params);
    if (unseenWriteRefusal) {
      this.debug(`codex approval refused by read-before-write: ${unseenWriteRefusal}`);
      return buildApprovalResponse(kind, params, false, undefined, this.reportDegradedApproval, unseenWriteRefusal);
    }
    const readOnlyModeRefusal = this.dataFolderControlRefusal(kind, params) ?? this.readOnlyModeSessionToolRefusal(kind, params); // F1.693, F1.234 — see the helpers
    if (readOnlyModeRefusal) return readOnlyModeRefusal;

    // R6 — the user's own permission rules answer BEFORE a human is asked.
    // An allow match approves, a deny match refuses, and anything else falls
    // through to the card exactly as before. This makes our ANSWER rule-aware;
    // it adds no gate in front of codex and changes nothing about what codex
    // asks about.
    //
    // P6.713 — AND BEFORE THE UNATTENDED FALLBACK, which is where this block
    // moved from below.
    //
    // Until this row the consult sat under the headless block, so on an
    // unattended turn every mode except `dontAsk` answered from the fallback
    // without ever reading the rules — and its debug line said *"no rule and no
    // floor covered the call"*, a claim the code could not make from there. The
    // rule layer was unreachable in BOTH directions the fallback has pointed:
    // before P6.531 an explicit `deny` was overridden by the headless yes, and
    // after it an explicit `allow` was overridden by the headless no. A rule the
    // user wrote is exactly the instruction a turn with nobody watching is meant
    // to run on, so the documented order — rules first, the fallback for what no
    // rule covers — is not a posture but what a rule layer is FOR.
    //
    // WHAT THE MOVE DOES NOT DISTURB, each checked rather than assumed:
    //  · both floors and the deniedPaths refusal still return above it, so
    //    nothing a floor refuses can be reached by a rule;
    //  · `floor` is still passed in, so P2.123's may-only-tighten asymmetry
    //    holds unattended exactly as it does attended;
    //  · the url-scheme gate still outranks every ANSWER for an elicitation:
    //    `codexApprovalRuleRequests` returns `[]` for a url elicitation and for
    //    `permissions` (F1.272 projects codex's MCP tool-call frame only), so
    //    this consult is a no-op on precisely the kinds that gate covers;
    //  · `dontAsk` is unchanged — it already reached the consult, being the one
    //    mode excluded from the headless block.
    //
    // A FLOOR SUSPENDS THE ALLOW HALF OF THIS CONSULT (P2.123): the rule layer
    // may still refuse — refusing is never a widening — but it may not approve
    // what a floor has already said must reach a person. `consultPermissionRules`
    // takes the verdict rather than being skipped so that a `deny` rule on a
    // floor command still short-circuits the card.
    const ruleVerdict = this.consultPermissionRules(kind, params, floor ?? undefined), askRule = ruleVerdict?.action === 'ask' ? ruleVerdict : undefined, ruleAnswer = askRule ? null : ruleVerdict; // F1.870
    if (ruleAnswer) {
      this.debug(
        `codex approval ${ruleAnswer.action === 'allow' ? 'auto-allowed' : 'refused'} by permission rule `
        + `"${ruleAnswer.ruleId}" (${ruleAnswer.scope}): ${method}`,
      );
      // `alwaysAllow` is deliberately not passed: a rule is OUR answer, and
      // `acceptForSession` would ask codex to remember a decision the rule
      // already re-makes on every call.
      return buildApprovalResponse(
        kind, params, ruleAnswer.action === 'allow', undefined, this.reportDegradedApproval,
        // P6.1 — the refusal names the rule that made it. Until this existed a
        // rule denial and a human's "no" were the same two words to the model.
        ruleAnswer.reason ?? `Denied by permission rule "${ruleAnswer.ruleId}" (${ruleAnswer.scope}).`,
      );
    }

    // The headless auto-approve exists because an unattended turn has no human
    // to ask. `dontAsk` is the one mode that does not need one: it already says
    // what to do when nobody can be asked, so it keeps its own answer instead of
    // borrowing the fallback's yes.
    //
    // A FLOOR TURNS THAT FALLBACK INTO A REFUSAL. "Nobody is available to be
    // asked" is the one situation a floor is least able to tolerate an approval
    // in: the fallback's yes exists so unattended turns complete, not so that
    // removing the human removes the floor.
    if (!surfaceToUser && !deniesWithoutAsking) {
      if (floor) {
        this.debug(`codex approval refused headless by the ${floor.floor} floor: ${floor.description}`);
        return buildApprovalResponse(
          kind, params, false, undefined, this.reportDegradedApproval,
          `Refused with no user present: the ${floor.floor} floor is non-negotiable (${floor.description}).`,
        );
      }
      // P6.531 · and with NO floor matching, an unattended turn still refuses.
      //
      // Until this row codex approved here while Pi (`pi-agent.ts`'s fail-closed
      // fallback) and claude (`CAN_USE_TOOL_NO_SURFACE_DENIAL`) both refused, so
      // the ABSENCE OF A HUMAN widened what could run on exactly one runtime and
      // nothing said so. Q-den 68 = A + C: deny by default, with an operator
      // escape hatch whose default is deny.
      //
      // Read per request rather than cached: an operator who changes the setting
      // between turns of a long unattended run means it for the next call, and
      // this path runs once per approval rather than once per token.
      //
      // NATIVE-FIRST, ASKED AND ANSWERED — P6.698, and the answer is NO.
      //
      // codex's own `AskForApproval::Granular` would make codex reject these
      // categories itself, and the writer can already emit it
      // (`CodexConfigOptions.granularApproval`, P6.224); nothing selects it. The
      // row asked for the mode × attendance matrix first, then selection, then a
      // live measurement. The matrix and the SOURCE settle it before the live
      // run, in the direction that removes the work — and the live measurement
      // was deliberately NOT run, because it would measure a variant this
      // reading says must not be selected. The matrix is pinned by
      // `__tests__/codex-approval-attendance-matrix.test.ts`.
      //
      // ## What the source says, read at `rust-v0.148.0`
      //
      // The tier that outranks a page on this runtime:
      //  · `codex-rs/protocol/src/protocol.rs`, on the variant itself, verbatim:
      //    *"When a field is `true`, commands in that category are allowed. When
      //    it is `false`, those requests are automatically rejected instead of
      //    shown to the user."*
      //  · `codex-rs/core/src/safety.rs` is where that becomes behaviour, and it
      //    folds granular-false into the SAME predicate as `never`:
      //    `let rejects_sandbox_approval = matches!(policy, AskForApproval::Never)
      //    || matches!(policy, AskForApproval::Granular(c) if !c.sandbox_approval)`,
      //    and every branch where that predicate is false ends in
      //    `SafetyCheck::AskUser` — i.e. in a request that reaches US.
      //
      // So the variant does not change WHO says no. It removes the request.
      //
      // ## The two costs of removing it, neither of which is a posture call
      //
      // 1. **`dontAsk` loses the half it exists for.** `approval_policy` is
      //    session-level, and the one mode that reaches the rule consult with no
      //    human present IS `dontAsk` — it is excluded from this block on
      //    purpose so that *"a pre-approving rule still allows … the whole 'run
      //    what the rules pre-approve' half"*. A granular-false session rejects
      //    those categories before we are asked, so a `dontAsk` run would stop
      //    honouring the `allow:` rules that are its entire operating model.
      // 2. **The refusal stops being auditable.** Every denial on this path
      //    carries our sentence, `reportDegradedApproval`, and
      //    `emitCodexPermissionDeniedHook`. A rejection codex makes for itself
      //    reaches none of them, and the owner rule is explicit that an
      //    unauditable influence on permission outcomes is worse than an absent
      //    one.
      //
      // WHAT WOULD CHANGE THE ANSWER, so this is a verdict and not a refusal: a
      // granular field whose `false` still ASKS. There is none — all five
      // (`sandbox_approval`, `rules`, `skill_approval`, `request_permissions`,
      // `mcp_elicitations`) are allow-or-auto-reject.
      //
      // ## The finding this matrix turned up, and P6.713 fixed
      //
      // This block used to sit ABOVE the rule consult, so an unattended session
      // in every mode except `dontAsk` answered before the user's own rules were
      // read — while the debug line below claimed *"no rule and no floor covered
      // the call"*, which the code could not know from there. The consult now
      // runs above this block (its own comment carries the reasoning), so by the
      // time execution reaches here the rules HAVE been read and answered
      // nothing: the sentence is true, and the fallback decides only what no rule
      // covers. Nothing in the granular verdict above changes — that is about
      // WHO makes the refusal, not about which of our own layers is asked
      // first.
      const unattendedFallback = askRule || unnamedPatch ? 'deny' : resolveUnattendedApprovalFallback(loadStoredConfig()); // F1.870 — a rule covers it; F1.719 — no fallback yes for an unnamed patch
      if (unattendedFallback === 'deny') {
        const refusal = askRule ? codexAskRuleRefusal(askRule, 'no one is present to answer it') : unnamedPatch ? `Refused with no user present: ${CODEX_UNNAMED_PATCH_REASON}.` : describeUnattendedApprovalRefusal();
        this.debug(`codex approval refused headless: no rule and no floor covered the call (${kind})`);
        return buildApprovalResponse(
          kind, params, false, undefined, this.reportDegradedApproval, refusal,
        );
      }
      this.debug(
        `codex approval auto-approved headless by the operator escape hatch (${kind}): `
        + 'unattendedApprovalFallback = allow',
      );
      return buildApprovalResponse(kind, params, true, undefined, this.reportDegradedApproval);
    }

    // URL mode: the scheme gate runs BEFORE anything is shown, so a link we
    // would never open is also a link nobody is asked about. Same gate as the
    // Pi path (`safeHttpUrl`), and the refusal is logged rather than silent.
    let urlToOpen: string | undefined;
    if (kind === 'elicitation' && isUrlElicitation(params)) {
      const validated = safeHttpUrl((params as { url?: unknown }).url);
      if (!validated) {
        return buildUrlElicitationResponse(false, 'url-mode refused: not an http(s) url', this.reportDegradedApproval);
      }
      urlToOpen = validated;
    }

    // R13 — the second half of `dontAsk`. No rule pre-approved this, and the
    // mode forbids the card, so the answer is the one the mode already states:
    // deny. Placed AFTER the rule consult so a pre-approving rule still allows
    // (that is the whole "run what the rules pre-approve" half), and after the
    // url-scheme gate so a refused scheme keeps its own reason.
    //
    // `|| !surfaceToUser` is the same condition written twice, not a second
    // case: every mode except `dontAsk` already returned above when no one is
    // attending — the P6.531 refusal by default (`61d6c51ca`), or the fallback
    // yes when `unattendedApprovalFallback` opens it; "the headless yes" this
    // sentence named until 2026-09-11 (W13-b) has not been the answer since —
    // so a missing callback HERE can only be unattended `dontAsk`. It is spelt
    // out because it is also what proves the card below always has somewhere to
    // go.
    if (deniesWithoutAsking || !surfaceToUser) {
      this.debug(`codex approval denied by dontAsk: no permission rule pre-approves ${method}`);
      const why = askRule ? codexAskRuleRefusal(askRule, 'the dontAsk permission mode never prompts') // F1.886 — an ask rule is named, as the unattended refusal names it
        : 'Denied by the dontAsk permission mode: no permission rule pre-approves this, and the mode never prompts.';
      // P6.579 · Pi's `dont_ask_would_prompt` cause, on codex's answer path. The
      // tool name comes from the CARD mapper rather than from a second table, so
      // the event names what the user would have been shown — but an MCP tool call:
      this.emitCodexPermissionDeniedHook(
        // F1.371 — named and described as the rule consult judged it (Pi's payload).
        ...codexDontAskDeniedSubject(kind, params, this.workingDirectory, () => this.mapApprovalRequest(kind, requestId, params).toolName),
        why,
      );
      return buildApprovalResponse(
        kind, params, false, undefined, this.reportDegradedApproval, why,
      );
    }

    // P6.61 — THE MODE ANSWER `bypassPermissions` never had, and the exit
    // condition `CODEX_MODES_KEEPING_ON_REQUEST_UNBOUNDED` was written against.
    //
    // ## What was wrong, and why it could not be fixed in the table
    //
    // With the sandbox master switch off, six of the seven modes degraded
    // `on-request` to `untrusted` so that codex ROUTED calls here and the
    // non-negotiable floors could run at all (P2.197) — a routing upstream
    // removed at `rust-v0.150.1` and that P7.2 could not replace; see
    // `UNBOUNDED_NEVER_DEGRADES_TO`. `bypassPermissions` was the
    // seventh and was excluded, because this method had no way to answer from
    // the MODE: when this was written `shouldAllowToolInMode` was consulted in
    // exactly ONE place, inside `consultPermissionRules`, i.e. only once a user
    // rule had already matched, so degrading the mode would have carded every
    // non-read-only command in the one mode whose own guidance says *"full
    // autonomy, no approval prompts; everything runs freely"*. The stated cost
    // was that the removal circuit breaker and the `Remove-Item` ladder never
    // ran there.
    //
    // P6.994 — THAT SENTENCE IS NO LONGER TRUE, and the correction belongs here
    // rather than one paragraph away. There are TWO consults of
    // `shouldAllowToolInMode` on this runtime now, and the ORDER is the whole of
    // it: P6.62's `deniedPathVerdict` calls it FIRST, above this block, above
    // the card and above the unattended yes, in every mode — so the deny-path
    // floor no longer waits for a user rule to match. `consultPermissionRules`
    // is the other consult and remains the only one that can APPROVE from a
    // rule. This block answers after both. Kept beside the claim it corrects
    // because a paragraph asserting what a sibling path does not do has no
    // guard, and nothing about the falsifying edit gives it a reason to look.
    //
    // ## The answer, and where it sits
    //
    // AFTER the rule consult and BEFORE the card, which is the whole of the
    // change:
    //
    // - a `deny` floor already returned far above, so the `Remove-Item` ladder
    //   still refuses in every mode without asking;
    // - a `prompt` floor (`floor` non-null here) falls through to the card, so
    //   `rm -rf ~` still raises the removal circuit breaker — that floor's
    //   contract is that it must reach a person and cannot be remembered, and
    //   `bypassPermissions` does not outrank it;
    // - a user `deny` rule already returned too, because refusing is never a
    //   widening;
    // - everything else — the ordinary `touch`/`echo` the mode's own sentence is
    //   about — is answered YES here, with no card.
    //
    // So the mode keeps its promise and the two unconditional floors start
    // running, which is exactly what the exclusion set's exit condition asked
    // for. It is empty now.
    //
    // `!floor` rather than a floor-outcome test: `floorVerdict` returns at most
    // one verdict and the only outcome that can still be live at this line is
    // `prompt`. Spelling it as the ABSENCE of a floor is the fail-closed
    // direction — a floor added later with a third outcome cards by default
    // instead of being auto-approved by a test that did not know about it.
    if (!floor && !askRule && !unnamedPatch && this.getPermissionMode() === 'bypassPermissions') { // F1.870 — an ask rule still asks here; F1.719 — so does a patch codex has not named
      this.debug(`codex approval auto-allowed by the bypassPermissions mode (no floor fired): ${method}`);
      return buildApprovalResponse(kind, params, true, undefined, this.reportDegradedApproval);
    }

    const sandboxRetained = codexCommandStaysSandboxed(kind, params, () => codexDenyReadEntryCount({ deniedReadPatterns: this.credentialFloorPatterns(), writablePaths: this.codexWritablePaths() })), decisionPromise = new Promise<Record<string, unknown>>((resolve) => { // F1.780; F1.1057 — any deny entry reaching codex
      this.pendingApprovals.set(requestId, {
        kind,
        params,
        ...(urlToOpen ? { urlToOpen } : {}),
        ...(floor ? { floor } : {}), ...(askRule ? { askRule } : {}), ...(sandboxRetained ? { sandboxRetained: true as const } : {}),
        resolve,
      });
    });

    const request = this.mapApprovalRequest(kind, requestId, params, urlToOpen);
    // P2.407 · RECORD THE AMENDMENTS CODEX PROPOSED, which were consumed in zero
    // files. `proposedNetworkPolicyAmendments` is codex offering to remember
    // allow/deny for a host, and the only way to accept one is the
    // `applyNetworkPolicyAmendment` decision variant — a durable egress policy,
    // and a product posture this row defers rather than takes. So it is written
    // down and NOT offered: a card with an Always Allow that silently did
    // nothing, or one that quietly wrote an egress rule, are both worse than a
    // card that asks about this request only. The host itself IS on the card
    // (`mapCommandApprovalToRequest`); this is the part with no control behind it.
    const proposedNetworkAmendments = readProposedNetworkPolicyAmendments(params);
    if (proposedNetworkAmendments.length > 0) {
      this.debug(
        `codex proposed ${proposedNetworkAmendments.length} network policy amendment(s) with this approval, `
        + `none applied: ${proposedNetworkAmendments.map(a => `${a.action} ${a.host}`).join(', ')}`,
      );
    }
    try {
      surfaceToUser({
        ...request, ...this.codexMcpToolCardRemember(kind, params, floor ?? askRule), ...codexAlwaysAllowScope(kind, params, !floor && !askRule && request.noAlwaysAllow !== true, sandboxRetained), // F1.372; F1.870 — no window on an ask; F1.1236
        description: codexSandboxRetainedCard(floor ? `${floor.description}\n\n${request.description}` : askRule ? codexAskRuleCard(askRule, request.toolName, request.description) : request.description, sandboxRetained, !floor && !askRule && request.noAlwaysAllow !== true), // F1.778; F1.780
        // P6.709 — codex's own approval request, relayed. This branch is
        // reached only from `isApprovalMethod`, i.e. one of
        // `item/commandExecution/requestApproval`,
        // `item/fileChange/requestApproval` or
        // `item/permissions/requestApproval` at `rust-v0.148.0`. The host
        // FLOOR that may have fired above it does not change who asked: codex
        // asked, we narrowed the answers.
        origin: 'codex_approval',
        // A floor prompt hides Always Allow rather than accepting it and then
        // silently doing nothing with it (P2.140). `noAlwaysAllow` already exists
        // for exactly this — "for prompts nothing can remember … the button would
        // promise what neither side implements" — and the floor is the strongest
        // case of that: this class's `respondToPermission` refuses the persistence on `pending.floor`, and the host's on this flag (F1.888), so
        // leaving the button visible would make the refusal invisible instead of
        // absent. F1.778 — the floor's sentence LEADS `description`, the field the card
        // renders and every Pi/claude floor uses. F1.799 — said there ONCE: `reason` (read by the admin card alone) is not appended to.
        ...(askRule && !floor ? { noAlwaysAllow: true as const } : {}), ...(floor // F1.870 — an ask-rule card hides Always Allow
          ? {
            noAlwaysAllow: true as const,
            // `reason` stays codex's own cause (`MCP server: …`, codex's `reason`), from the `...request` spread (F1.799).
          }
          : {}),
      });
    } catch (error) {
      // The request never reached a user, so it is refused — in a frame the
      // app-server can parse, rather than left hanging or answered with `{}`.
      this.pendingApprovals.delete(requestId);
      this.debug(`codex approval bridge failed to surface ${method}: ${error instanceof Error ? error.message : String(error)}`);
      return buildApprovalResponse(kind, params, false);
    }

    return decisionPromise;
  }

  /**
   * The FLOOR verdict for one codex approval — the same predicate, from the same
   * function, that stops the same command on Pi and on Claude.
   *
   * `findNonNegotiableFloors` is `core/pre-tool-use.ts`'s: this is not a codex
   * re-implementation of the floors and must never become one. The whole value
   * of the seam is that a change to `findRootOrHomeRemoval` moves all three
   * runtimes at once — the alternative (a codex-shaped copy) is how the two
   * halves of one floor drift apart without either looking wrong.
   *
   * Every subject the request offers is checked and the FIRST verdict wins, in
   * the pipeline's own precedence (`firstNonNegotiableFloor`), with `deny`
   * outranking `prompt` across subjects: a patch touching four files is ONE
   * answer, and a denied file is not made allowable by the three beside it.
   *
   * The permission mode is read for the protected-path floor and for nothing
   * else, exactly as the pipeline reads it. It is asked of `getPermissionMode()`
   * rather than of the config we wrote for codex, because the mode is the user's
   * current intent and the config file is a snapshot taken at spawn.
   *
   * Never throws. A floor evaluator that could take the approval bridge down
   * would be a denial-of-service on every turn; a defect here degrades to "no
   * floor visible", which is the pre-P2.140 behaviour and is logged.
   */
  private floorVerdict(kind: ApprovalKind, params: unknown): NonNegotiableFloorVerdict | null {
    try {
      const mode = this.getPermissionMode();
      // C3.378 — the agent-config shell floor's second reading is the gate's own
      // read-only classifier now, and it needs this session's merged config to
      // run. Built with the same fallback `deniedPathVerdict` uses six hundred
      // lines below, so the bridge's two floor gates read one context; without it
      // codex would silently keep the positive word list that `sed -i`, `tar -x`
      // and `python -c` walk past, which is the divergence the row is named for.
      const permissionsContext: PermissionsContext =
        this.permissionManager.getCapabilityPermissionsContext?.() ?? {
          workspaceRootPath: this.config.workspace.workspaceRootPath,
          activeSourceSlugs: Array.from(this.sourceManager.getActiveSlugs()),
          projectTrusted: this.config.projectTrusted === true,
        };
      let prompt: NonNegotiableFloorVerdict | null = null;
      for (const subject of codexApprovalFloorSubjects(kind, params, this.codexFileChangeApprovalPaths(params))) {
        const verdict = firstNonNegotiableFloor(
          findNonNegotiableFloors(subject.toolName, subject.input, mode, permissionsContext),
        );
        if (!verdict) continue;
        if (verdict.outcome === 'deny') return verdict;
        prompt ??= verdict;
      }
      return prompt ?? this.unattendedAutomationEditFloor(kind, params, mode);
    } catch (error) {
      this.debug(
        `codex floor evaluation failed, no floor applied: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * P6.62 — the `deniedPaths` refusal for one codex approval, or `null`.
   *
   * Reads the SAME matcher the rest of the product reads, through the same
   * public entry: `shouldAllowToolInMode` sets `denyPathBlocked` in exactly one
   * branch — the FIRST one, ahead of every mode, allowlist and rule check, which
   * is what makes it a floor rather than a mode opinion.
   *
   * This is the SECOND consult of `shouldAllowToolInMode` on this runtime and
   * the first to RUN. {@link CodexAgent.consultPermissionRules} is the other,
   * and it can only answer once a user rule has matched — which is why the
   * `bypassPermissions` narrative below this method used to say the matcher was
   * consulted "only" there. That paragraph carries the correction now (P6.994);
   * this is its back-pointer, so an edit that changes the ORDER meets both. A second matcher was
   * refused on `PiAgent.handleDeniedResultPathsRequest` and refused again on
   * `NestorCloudAgent.deniedResultPaths`, on the evidence that four defects
   * shipped out of one compiler in a single day; it is refused here for the
   * third time.
   *
   * The SUBJECTS are `codexApprovalFloorSubjects`', not the rule path's: the
   * allow projection drops a v1 argv whose words carry shell metacharacters,
   * because "answering a request we did not really match" is worse than not
   * answering — correct for a path that can approve, wrong for one that can only
   * refuse. `getDeniedPathViolation` reads a `Bash` subject through
   * `extractShellPathTokens`, so a `cat` of a denied file is seen on the command
   * string, and a v1 patch's files are seen as `Write` targets.
   *
   * The mode is passed LIVE rather than pinned, for the reason
   * `NestorCloudAgent` records: the call must not start meaning something else
   * if that ordering ever changes.
   *
   * ## Fails OPEN, with the same reason {@link floorVerdict} gives
   *
   * A refusal evaluator that could throw on the approval bridge would be a
   * denial of service on every turn of every session. A defect here degrades to
   * "no deny-path floor visible", which is the pre-P6.62 behaviour and is
   * logged — and the OS profile that carried this floor alone until now is still
   * carrying it underneath.
   */
  private deniedPathVerdict(kind: ApprovalKind, params: unknown): string | null {
    try {
      const subjects = codexApprovalFloorSubjects(kind, params, this.codexFileChangeApprovalPaths(params));
      if (subjects.length === 0) return null;
      const permissionsContext: PermissionsContext =
        this.permissionManager.getCapabilityPermissionsContext?.() ?? {
          workspaceRootPath: this.config.workspace.workspaceRootPath,
          activeSourceSlugs: Array.from(this.sourceManager.getActiveSlugs()),
          projectTrusted: this.config.projectTrusted === true,
        };
      const mode = this.getPermissionMode();
      // UB12.65 (CRITICAL) — the base a RELATIVE token resolves at, as UB12.60 gave Pi and claude: the frame's `cwd`,
      // else the session's working directory. Without it `cat ../../secret/a.txt` was judged lexically, so a user's
      // deniedPaths entry never saw it: measured `accept` with no card in bypassPermissions (v1 and v2), under an
      // allow rule and headless with the hatch open, where the absolute spelling of the same file was refused.
      const deniedPathBase = codexApprovalCwd(params, this.workingDirectory);
      for (const subject of subjects) {
        const verdict = shouldAllowToolInMode(
          subject.toolName, subject.input, mode, { permissionsContext, deniedPathBase },
        );
        if (verdict.allowed === false && verdict.denyPathBlocked === true) {
          return verdict.reason ?? 'Denied by the deniedPaths floor.';
        }
      }
      return null;
    } catch (error) {
      this.debug(
        'codex deny-path evaluation failed, no deny-path floor applied: '
        + `${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * D1.342 — the read-before-write refusal, on the one codex seam that can
   * still withhold a write.
   *
   * ## The bridge CAN carry it, and that is a measurement (2026-09-18)
   *
   * D1.332 left this arm unbuilt on a reading taken over SHELL commands —
   * `config-writer.ts`'s binary-driven table measures `echo` and `touch ~/…`
   * and finds `on-request` asking about nothing in any sandbox mode. A FILE
   * CHANGE is a different approval kind and behaves differently, which that
   * table's own note records as unmeasured (*"Whether a codex FILE EDIT prompts
   * … was NOT measurable on this rig"*). Driven at the staged
   * `codex-app-server` (darwin-arm64) over the loopback stub adapter on a fake
   * key, one turn per row, an `apply_patch` of a file inside the workspace:
   *
   * | `sandbox_mode` / `approval_policy` | `item/fileChange/requestApproval` | the write |
   * | --- | --- | --- |
   * | `read-only` / `on-request` | **1** | `accept` → applied; `decline` → **file left at its pre-image** |
   * | `workspace-write` / `on-request` | 0 | applied |
   * | `danger-full-access` / `on-request` | 0 | applied |
   *
   * The accept/decline pair is the control, taken on the same rig in the same
   * minute with only the answer varied: `accept` left `tawny-harbour-41` on
   * disk and `decline` left `sable-harbour-41`. So a refusal here is real — the
   * write is withheld, not reported after the fact — and `read-only` is what
   * `CODEX_PERMISSION_MODE_TABLE` emits for `explore` and `plan`.
   *
   * **The residue, stated rather than hidden.** With the sandbox master switch
   * OFF — this product's standing posture — every mode resolves to
   * `danger-full-access` and codex raises no approval at all, so this refusal
   * never runs there. That is the same territory `CODEX_UNBOUNDED_APPROVAL_NOTICE`
   * already tells the operator about, and it is a reason to keep the gate
   * cheap, not a reason to omit it. And the v2 response carries no channel for
   * a reason (`buildApprovalResponse`), so the model sees `decline` while the
   * sentence goes to the debug log — the v1 `applyPatchApproval` kind, which
   * this function also covers, does carry it.
   *
   * Reads the SAME subjects the deny-path floor reads, through the same
   * `codexApprovalFloorSubjects`, so the two cannot disagree about which file
   * an approval is about; that projection emits `{toolName: 'Write'|'Edit',
   * input: {file_path}}`, which is exactly {@link writeTargetPath}'s shape.
   *
   * Fails OPEN, for {@link deniedPathVerdict}'s reason: a refusal evaluator
   * that could throw on the approval bridge would be a denial of service on
   * every turn of every session.
   */
  private readBeforeWriteVerdict(kind: ApprovalKind, params: unknown): string | null {
    try {
      const subjects = codexApprovalFloorSubjects(kind, params, this.codexFileChangeApprovalPaths(params));
      for (const subject of subjects) {
        if (!READ_BEFORE_WRITE_TOOLS.has(subject.toolName)) continue;
        const target = writeTargetPath(subject.input);
        if (!target) continue;
        const path = isAbsolute(target) ? target : resolvePath(this.workingDirectory, target);
        const refusal = this.readBeforeWriteLedger.refuseUnseenWriteSync(path);
        if (refusal) return refusal;
      }
      return null;
    } catch (error) {
      this.debug(
        'codex read-before-write evaluation failed, no unseen-write refusal applied: '
        + `${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * The user's merged permission rules, asked about one codex approval.
   *
   * `null` means "the rules do not answer this" — no rule matched, one matched
   * with `ask`, the request carries nothing a rule can judge, or the evaluation
   * itself failed. Every one of those reaches the human, which is what this
   * path did for every request before R6.
   *
   * THE SAME RULE SET AS PI. `permissionsConfigCache.getMergedConfig(...)
   * .permissionDsl` is the readable policy `pi-agent.ts:4649` consults on its
   * own answer path, composed from the same layers (managed policy, the app
   * default, the workspace file, per-source files, `.claude/settings.json`
   * allow/ask/deny, session rules).
   *
   * **AN ALLOW IS ALSO CHECKED AGAINST THE MODE AND THE UNCONDITIONAL FLOORS,
   * and the first version of this row was wrong to skip that.** Reading the
   * rules alone made a rule outrank a mode — in `plan` or `explore` an allow
   * rule auto-approved a write, with no card — and outrank `deniedPaths`, so an
   * allow rule approved a write to a private-key file that `mode-types.ts`
   * documents as must not be read or written in ANY permission mode. Both were measured
   * on the real seam before this guard existed. With the standing sandbox-off
   * default emitting `danger-full-access` for every mode, our card was the only
   * thing left holding a read-only mode's intent on codex.
   *
   * The asymmetry is deliberate and is what keeps this an ANSWER rather than a
   * gate: a rule may only answer what the mode and the floors would have
   * permitted anyway, so it can never WIDEN. A rule `deny` needs no such check —
   * refusing is never a widening — and still refuses on its own.
   *
   * The generation asked with is the compiled program's OWN. Pi asks with its
   * capability manifest's generation so a stale manifest fails closed; codex
   * has no manifest to be stale against, and a mismatch there answers `deny`
   * for everything — a blanket refusal no user rule wrote.
   */
  private consultPermissionRules(
    kind: ApprovalKind,
    params: unknown,
    floor?: NonNegotiableFloorVerdict,
  ): CodexRuleAnswer | null {
    const requests = codexApprovalRuleRequests(
      kind,
      params,
      this.workingDirectory,
      this.codexFileChangeApprovalPaths(params),
    );
    if (requests.length === 0) return null;

    try {
      const permissionContext: PermissionsContext =
        this.permissionManager.getCapabilityPermissionsContext?.() ?? {
          workspaceRootPath: this.config.workspace.workspaceRootPath,
          activeSourceSlugs: Array.from(this.sourceManager.getActiveSlugs()),
          projectTrusted: this.config.projectTrusted === true,
        };
      const policy = permissionsConfigCache.getMergedConfig(permissionContext).permissionDsl;
      if (!policy) return null;

      let firstAllow: CodexRuleAnswer | null = null;
      let everyRequestAllowed = true; let askAnswer: CodexRuleAnswer | null = null; // F1.870
      for (const request of requests) {
        const evaluation = evaluateCodexRuleRequest(policy, request, { // F1.379 — both names of one call
          generation: policy.generation,
          semanticId: request.semanticId,
          toolName: request.toolName,
          input: request.input,
          cwd: request.cwd,
          canonicalizePath: (value, cwd) => canonicalizeForDecision(resolvePath(cwd, value)),
        });
        if (evaluation.action === undefined) {
          // No rule matched — the ordinary case, and the reason the human is
          // still the default. The loop continues so a deny further down the
          // list is still found.
          everyRequestAllowed = false;
          continue;
        }
        const matched = evaluation.match;
        if (!matched) {
          // A deny naming nothing — a program compiled at another generation,
          // which the program's own generation above rules out — is no answer:
          // the human sees the card, as before R6. F1.1002 (option A's managed
          // half): an `invalid-policy` deny (a broken MANAGED document, or the
          // P2.269 cap overflow) is NOT this — it falls through and refuses, as
          // Pi refuses every call, its diagnostic as the reason (below).
          this.debug(
            'codex permission rules were not consulted: '
            + (evaluation.diagnostic?.message ?? 'the permission policy could not answer'),
          );
          return null;
        }
        // A deny anywhere refuses the whole approval: an apply-patch touching
        // four files is ONE answer, and a denied file is not made allowable by
        // the three beside it. Checked before the allow bookkeeping so a deny
        // later in the list still outranks an allow earlier in it.
        if (evaluation.action === 'deny') {
          return { action: 'deny', ruleId: matched.ruleId, scope: matched.scope, ...(matched.ruleId === 'invalid-policy' ? { reason: permissionDslDenyReason(evaluation) } : {}) };
        }
        if (evaluation.action !== 'allow') {
          // F1.870 — an `ask` rule matched: carried to the card (it asks in every mode), never an answer.
          everyRequestAllowed = false; askAnswer ??= { action: 'ask', ruleId: matched.ruleId, scope: matched.scope, toolName: request.toolName }; // F1.887
          continue;
        }
        if (floor) {
          // P2.123, may-only-tighten. A floor has already decided this call
          // reaches a person; an allow rule may not undo that. The deny arm
          // above still runs, because a rule making the answer STRICTER is
          // always allowed to — that asymmetry is the rule, not an exception to
          // it. Pi expresses the same thing structurally (`nonNegotiable` is set
          // and `promptIsNonNegotiable` refuses the readable-DSL merge, the
          // PreToolUse hook `allow` and the PermissionRequest band alike); codex
          // has no gate result to carry the marker on, so it is spelt out here.
          this.debug(
            `codex permission rule "${matched.ruleId}" did not answer: `
            + `the ${floor.floor} floor is non-negotiable`,
          );
          everyRequestAllowed = false;
          continue;
        }
        // The guard the first version lacked. `shouldAllowToolInMode` is the
        // same call Pi's answer path makes, and it carries BOTH the mode's
        // classification and the unconditional deny floors. If it refuses, the
        // rule does not get to answer and the human sees the card, exactly as
        // before R6. Pi has the same asymmetry: `pi-agent.ts:4667` lets a
        // readable allow flip a decision only when the outcome was `ask`.
        const mode = this.getPermissionMode();
        const modeCheck = shouldAllowToolInMode(
          request.toolName,
          request.input,
          mode,
          // UB12.65 — the same base `deniedPathVerdict` judges a relative token at (`codexApprovalCwd`), so this
          // guard's deny-path half sees what the floor above it sees.
          { permissionsContext: permissionContext, deniedPathBase: request.cwd },
        );
        // The line between "the rule may save a click" and "the rule may not
        // widen", and it has to be drawn here because `allowed: false` means
        // BOTH "this would have asked" and "this is refused outright".
        //
        // A rule exists to pre-approve what the runtime would otherwise ask
        // about, so an ordinary refusal is exactly what it is for. What it may
        // never do is overturn a floor — a deny-path or an `askRuleDenied`
        // band, both of which the result flags explicitly — or a read-only
        // mode, which is the user saying "no writes" in the one place codex
        // does not decide it for us (since F1.787 its own `:read-only` profile
        // refuses a shell write in these two modes, but a patch it RAISES is ours
        // to answer, and the card is all that carries the intent).
        //
        // `dontAsk` is deliberately NOT read-only here: its own contract is
        // "never prompt; run what the rules pre-approve, deny the rest", so a
        // rule answering is the whole point of that mode. R13 did not reverse
        // that decision — it added the OTHER half of the same sentence, in
        // `handleServerRequest`: what no rule pre-approves is denied rather than
        // shown. Widening this guard to treat `dontAsk` as read-only would leave
        // the mode with nothing but denials and make R6 inert here.
        const isFloor = !modeCheck.allowed
          && (modeCheck.denyPathBlocked === true || modeCheck.askRuleDenied === true);
        const readOnlyMode = mode === 'plan'; // F1.1050: explore retired (read as plan)
        if (isFloor || (readOnlyMode && !modeCheck.allowed)) {
          this.debug(
            `codex permission rule "${matched.ruleId}" did not answer: `
            + (modeCheck.allowed ? 'refused by the permission mode' : modeCheck.reason),
          );
          everyRequestAllowed = false;
          continue;
        }
        firstAllow ??= { action: 'allow', ruleId: matched.ruleId, scope: matched.scope };
      }
      // Allow only when EVERY request in the approval was allowed by a rule.
      return everyRequestAllowed ? firstAllow : askAnswer;
    } catch (error) {
      // A policy that cannot be read or evaluated must not become an answer in
      // either direction — the human is the fallback, as before R6.
      this.debug(`codex permission rules were not consulted: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** The permission card for one bridged approval, per method family. */
  private mapApprovalRequest(kind: ApprovalKind, requestId: string, params: unknown, validatedUrl?: string) {
    switch (kind) {
      case 'fileChange':
        return mapFileChangeApprovalToRequest(
          requestId,
          (params ?? {}) as never,
          this.codexFileChangeApprovalPaths(params),
        );
      case 'elicitation':
        return mapElicitationApprovalToRequest(requestId, params, validatedUrl);
      case 'permissions':
        return mapPermissionsApprovalToRequest(requestId, params);
      case 'commandV1':
        return mapLegacyExecApprovalToRequest(requestId, params);
      case 'fileChangeV1':
        return mapLegacyPatchApprovalToRequest(requestId, params);
      default:
        return mapCommandApprovalToRequest(requestId, (params ?? {}) as never);
    }
  }

  // ============================================================
  // Chat
  // ============================================================

  private resolveSelectedPluginSkillRuntimePolicy(): {
    environment: Record<string, string>;
    writablePaths: string[];
  } {
    // P6.415 — `plugins-reference.md` § File locations, `bin/`: *"Executables
    // added to the Bash tool PATH. Files here are invokable as bare commands in
    // any Bash tool call while the plugin is enabled."* Pi and claude both build
    // that PATH (`appendPluginBinPath` + `enabledPluginBundleRoots`); this
    // same-named method called NEITHER, so an enabled plugin's `bin/` resolved
    // on two runtimes out of three and nothing said so.
    //
    // Keyed off the turn's runnable capability view rather than the selected
    // skills, because the documented condition is ENABLEMENT, not selection —
    // which is also why it has to be computed before the early return below: a
    // turn that pins no skill runtime still has enabled bundles.
    const binBundleRoots = enabledPluginBundleRoots(this.capabilityTurnRuntime?.view);
    // C4.11 (QG4 B) · the effort pair, on BOTH branches, because it has nothing
    // to do with plugins — see {@link CodexAgent.codexShellEffortEnvironment}.
    const effortEnvironment = this.codexShellEffortEnvironment();
    if (this.activePluginSkillRuntimes.length === 0) {
      const pluginBinPath = appendPluginBinPath(appendBundledRipgrepDir(process.env.PATH, getBackendRuntime(this.config).paths?.ripgrep), binBundleRoots); // F1.1301 · this PATH replaces the spawn's, so it carries the rg too
      // No skill runtime is pinned this turn, so none of the plugin env aliases
      // apply — but an enabled bundle's bin/ still belongs on PATH.
      return {
        environment: {
          ...(pluginBinPath === undefined ? {} : { PATH: pluginBinPath }),
          ...effortEnvironment,
        },
        writablePaths: [],
      };
    }

    const environment: Record<string, string> = {};
    const writablePaths = new Set<string>();
    const mergeEnvironment = (next: Readonly<Record<string, string>>) => {
      for (const [key, value] of Object.entries(next)) {
        const existing = environment[key];
        if (existing !== undefined && existing !== value) {
          throw new Error(`plugin-skill-runtime-environment-ambiguous:${key}`);
        }
        environment[key] = value;
      }
    };

    for (const binding of this.activePluginSkillRuntimes) {
      const runtime = binding.runtime;
      mergeEnvironment(pluginRuntimeEnvForProfile(runtime.profile, {
        bundleRoot: runtime.rootPath,
        dataPath: runtime.dataPath,
        ...(runtime.projectPath ? { projectPath: runtime.projectPath } : {}),
      }));
      writablePaths.add(runtime.dataPath);
    }

    const nodeRuntime = this.config.pluginNodeRuntime;
    if (!nodeRuntime || !isAbsolute(nodeRuntime.command)) {
      throw new Error('plugin-node-runtime-unavailable');
    }
    const shimDirectory = nodeRuntime.nodeShimDirectory;
    if (!shimDirectory || !isAbsolute(shimDirectory)) {
      throw new Error('plugin-node-shim-unavailable');
    }
    mergeEnvironment(nodeRuntime.environment ?? {});
    // Same ORDER as the claude arm, and the order is the safety property: the
    // node shim stays FIRST because it is the host's own runtime redirect, and
    // the plugin `bin/` directories stay LAST, after the system PATH, so a
    // plugin can never shadow a system binary of the same name.
    const shimPath = `${shimDirectory}${delimiter}${appendBundledRipgrepDir(process.env.PATH, getBackendRuntime(this.config).paths?.ripgrep) ?? ''}`; // F1.1301
    mergeEnvironment({
      NESSY_BUN: nodeRuntime.command,
      PATH: appendPluginBinPath(shimPath, binBundleRoots) ?? shimPath,
    });
    // C4.11 · spread rather than merged, so the HOST value wins if a plugin
    // profile ever exported the same name. Same precedence as the Pi site
    // (`pi-agent.ts`'s `childEnvironment`), where the pair is spread over the
    // plugin env for the same reason: the level is the session's, not a
    // bundle's, and an ambiguity throw here would fail a turn over a variable
    // that is only ever informational.
    return {
      environment: { ...environment, ...effortEnvironment },
      writablePaths: [...writablePaths].sort(),
    };
  }

  /**
   * C4.11 (QG4, owner answer B, 2026-09-11) — `$CLAUDE_EFFORT`/`$NESSY_EFFORT`
   * for codex's shell children, through codex's OWN mechanism.
   *
   * ## The contract, and why codex was the runtime missing it
   *
   * `hooks.md` § Hook input, the `effort` field: *"The level is also available
   * to hook commands and the Bash tool as the `$CLAUDE_EFFORT` environment
   * variable."* Pi exports the pair on every supervised child start
   * (`pi-agent.ts`, the `childEnvironment` literal) and the host hook runner
   * exports it for all three (`automations/hook-command.ts`
   * `setSanitized(env, 'CLAUDE_EFFORT', …)`). codex's TOOL children got
   * nothing, so the same documented variable resolved on two runtimes out of
   * three and nothing said so — the silent-divergence shape, not a gap.
   *
   * ## Native-first: this builds no mechanism
   *
   * codex has the seam and the host already writes it. `[shell_environment_policy].set`
   * is codex's own per-thread map for exactly this, and
   * `buildCodexRuntimeConfigOverride`
   * (`packages/codex-responses-adapter/src/config-writer.ts`) already emits
   * `{ shell_environment_policy: { set: policy.environment } }` from this very
   * method's return value — today carrying the plugin runtime aliases, `PATH`
   * and `NESSY_BUN`. Two more entries in that map is configuration on a written
   * seam.
   *
   * ## One resolver for all three runtimes, so they cannot disagree
   *
   * {@link activeEffortLevelForModel} is the shared narrowing the page asks for
   * twice — present only when the model supports the effort parameter, and
   * holding the level the model ACTUALLY used rather than the requested one. It
   * is imported rather than re-derived, which is also what bounds the cost
   * below: `off` and a `supportsThinking: false` model both answer `undefined`,
   * and then this returns `{}` and nothing changes at all.
   *
   * Read PER TURN, never cached, for the reason the Pi site records:
   * `setThinkingLevel` can move the level mid-session and an invoked skill
   * overrides it for exactly one turn.
   *
   * ## THE COST, named and bounded rather than traded away
   *
   * This map is hashed by {@link codexThreadConfigSignature}, so a level change
   * BETWEEN TURNS now produces one extra `thread/fork` in
   * {@link CodexAgent.applySelectedPluginSkillRuntimePolicy}. Its bounds:
   *
   *  - at most ONE fork, and only on a turn whose level differs from the last
   *    one — the signature comparison returns early otherwise, so a steady
   *    session forks exactly as often as it did before;
   *  - ZERO forks for every model with no effort control and for `off`, where
   *    the pair is absent from the map in both directions;
   *  - never mid-turn: the walk runs at the head of a turn, under the same
   *    bounded budget ({@link CODEX_THREAD_REFORK_TIMEOUT_MS}) that the plugin
   *    and sandbox layers already ride;
   *  - and a fork is what codex itself offers for this — `thread/resume`
   *    deliberately ignores config overrides, so there is no cheaper native
   *    path to decline in favour of.
   */
  private codexShellEffortEnvironment(): Record<string, string> {
    const level = activeEffortLevelForModel(this._thinkingLevel, this._model);
    // `undefined` means there is no level to report, and BOTH names stay unset
    // — the same withholding rule the hook input and the Pi child use.
    if (level === undefined) return {};
    return { NESSY_EFFORT: level, CLAUDE_EFFORT: level };
  }

  /**
   * Re-fork the thread when its plugin/sandbox configuration layer has drifted.
   * That layer is fixed at `thread/start` and `TurnStartParams` has no member
   * for any of it; the MODEL is not part of it since P6.365 and rides
   * `turn/start` (the override is sent unconditionally there, and
   * {@link codexThreadConfigSignature} hashes the sandbox/permission override
   * alone). This docblock said the model was fixed at `thread/start` too, and
   * that half was false from the moment P6.365 landed.
   *
   * P2.257 · BOUNDED, because this is `await`ed at the head of a turn one line
   * above the poll P2.245 bounded, and it fires on any plugin/sandbox policy
   * change (it fired on a model change too until P6.365 moved that to
   * `turn/start`). Unbounded it had the identical symptom: `AppServerClient`
   * settles a request on a matching response or on `close()`, so an app-server
   * that never answers leaves the promise — and the user's turn — pending
   * forever, printing nothing and ending never.
   *
   * ON EXPIRY THIS THROWS, and that is the whole difference from P2.245. Its
   * poll is optional and degrades; this walk is the ONLY thing that applies the
   * drifted sandbox/permission layer, and continuing
   * without it would run the user's turn under the OLD permission profile — a
   * silent widening whenever the drift was a tightening. A failed turn is the
   * honest outcome, and it is already this method's contract for a fork that
   * errors (`codex-runtime-handoff.test.ts`: a non-`no rollout` fork error
   * rejects the chat).
   *
   * The throw below is the one that actually happens on a real connection only
   * because {@link CODEX_DEADLINE_CHANNEL_MARGIN_MS} makes the sentinel win the
   * tie. Without it the channel's own rejection arrives first and the user is
   * left with `app-server request thread/fork timed out after 30000ms` — true,
   * and silent about the sandbox policy that did not get applied.
   */
  private async applySelectedPluginSkillRuntimePolicy(pluginRuntime: {
    environment: Record<string, string>;
    writablePaths: string[];
  },
  /** Budget for the WHOLE walk. Overridable so a test can pick a bound it can actually wait out; production takes the constant. */
  timeoutMs: number = CODEX_THREAD_REFORK_TIMEOUT_MS, /** F1.1028 — called once when the walk WILL re-open the thread (never on the early return), so the turn head can say so while it waits. */ onReopen?: () => void,
  ): Promise<void> {
    const config = { ...buildCodexRuntimeConfigOverride({
      mode: this.getPermissionMode(),
      sandboxGloballyEnabled: this.sandboxGloballyEnabled(),
      readOnlyPaths: this.codexReadOnlyPaths(), // F1.670; F1.678 — the host writes no exact deny any more
      // P3.175 · the `deniedPaths` credential floor, mirrored onto codex's own
      // OS-enforced deny map. Defence in depth: our gate still runs first.
      deniedReadPatterns: this.credentialFloorPatterns(),
      shellEnvironment: pluginRuntime.environment,
      // P3.369 · the added roots ride the re-fork override too, and that is not
      // cosmetic: `codexThreadConfigSignature` hashes THIS object, so without
      // them a mid-session edit to `additionalDirectories` would leave the
      // running thread on the old permission layer with nothing to notice the
      // drift. Deduplicated because the plugin family can name the same path.
      writablePaths: [...new Set([...pluginRuntime.writablePaths, ...this.codexWritablePaths()])].sort(), // F1.1003
      // C3.343 · the floor rides the re-fork override for the same reason the
      // added roots do: this override REPLACES the thread's permission layer, so
      // a plugin-runtime refork without it would silently drop the protected-path
      // entries mid-session — the "setting silently reversed" shape this file
      // records elsewhere.
      protectedWorkspaceSubpaths: this.codexProtectedWorkspaceSubpaths(),
    }), ...codexMcpLeverOverrideForTurn(this, this.config.workspace.workspaceRootPath, this.codexHome, this.codexMcpRuleProjection(await this.codexMcpRuleCatalogue()).mcpToolLevers) }; // F1.1019 — an MCP rule changed since the runtime was built rides the re-fork; see codexMcpLeverOverrideForTurn
    const signature = codexThreadConfigSignature(config);
    const execpolicyRules = codexProjectedExecpolicyRules(this.config.workspace.workspaceRootPath); const rulesDrift = codexRulesDriftForTurn(this, this.codexHome, execpolicyRules, (m) => this.debug(m)); if (signature === this.runtimeConfigSignature && !rulesDrift) return; if (rulesDrift && this.eventAdapter.runningSpawnedChildCount > 0) this.surfaceCodexOperatorNotice(codexRulesDriftChildNotice(this.eventAdapter.runningSpawnedChildCount)); // F1.928 — a rules change re-forks too; see codexRulesDriftForTurn; F1.939 — a running sub-agent is not re-forked, so the turn head says so

    // ONE budget for the whole walk — see
    // {@link CODEX_THREAD_REFORK_TIMEOUT_MS}. `performance.now()` rather than
    // `Date.now()` because this is a duration: a monotonic clock cannot be moved
    // backwards by the host (or by a test setting the system time) into a walk
    // that skips its second leg without asking.
    const deadlineAt = performance.now() + timeoutMs; onReopen?.(); await this.refreshCodexRestrictedRepoSkills(this.client!, timeoutMs); // F1.845 — re-read inside the walk's ONE budget; F1.1028 — the turn head is told first

    // app-server intentionally ignores config overrides when `thread/resume`
    // rejoins an already-running thread. Forking is the supported boundary that
    // preserves history while loading a fresh, complete config layer.
    let result: unknown;
    try {
      // P3.33 · `developerInstructions` on BOTH legs of this walk, and the
      // asymmetry is measured rather than assumed. A `thread/fork` INHERITS the
      // parent's value when the params omit it, and re-passing it does NOT
      // duplicate it (both measured on the bundled binary: exactly one
      // occurrence either way) — so on this leg the field is belt-and-braces,
      // held here so the invariant is structural rather than resting on
      // inheritance behaviour we do not own. On the `thread/start` FALLBACK leg
      // below it is load-bearing: that starts a BRAND NEW thread with nothing to
      // inherit from, in exactly the window its own comment describes — a model
      // change or a plugin skill on the first turn of a fresh thread. Omitting
      // it there is how the defence would silently stop travelling.
      result = await requestWithinDeadline(this.client!, 'thread/fork', {
        threadId: this.threadId, excludeTurns: true, // F1.1237
        cwd: this.workingDirectory,
        model: this._model,
        config: this.codexThreadSecurityLayer(config), // F1.723
        developerInstructions: codexDeveloperInstructions(this.activeOutputStyle()?.prompt, this.developerSections(this.callbackBridge?.port)),
        // C3.169 — the administrator's service tier travels with the re-fork for
        // the reason the paragraph above gives about `developerInstructions`:
        // belt-and-braces on this leg, load-bearing on the `thread/start`
        // fallback below, which has nothing to inherit from.
        ...(this.managedServiceTier ? { serviceTier: this.managedServiceTier } : {}),
      }, Math.max(1, Math.ceil(deadlineAt - performance.now()))); // F1.845 — the list above spent part of the one budget
    } catch (error) {
      // A thread that has NEVER produced a rollout record cannot be forked —
      // the app-server refuses with `no rollout found for thread id …`.
      // Measured 2026-08-20 on BOTH rust-v0.147.0 and rust-v0.148.0 (not a
      // bump regression): `thread/start` alone writes no rollout; the first
      // turn or the first `thread/inject_items` does. The window is real in
      // the product: a plugin skill invoked on the very first turn of a fresh
      // thread, or a model change before the first turn, both drift the
      // signature and land here with zero history.
      //
      // A rollout-less thread provably holds NOTHING — no turns, no injected
      // items (either would have created the rollout) — so a fresh
      // `thread/start` with the same cwd/model/config is a LOSSLESS
      // replacement for the fork, not an approximation of it. Any other fork
      // error still throws: only the empty-thread refusal has a safe fallback.
      if (!(error instanceof Error) || !error.message.startsWith('no rollout found')) throw error;
      this.debug(`thread/fork refused for rollout-less thread ${this.threadId}; starting a fresh thread with the drifted config`);
      // The SECOND leg spends what the first left. It cannot be starved in
      // practice — the refusal that gets us here is measured at 0.53-1.13 ms —
      // but a walk that has already spent its budget must not open a fresh one,
      // or the bound is 2 x T after all.
      result = await requestWithinDeadline(this.client!, 'thread/start', {
        cwd: this.workingDirectory,
        model: this._model,
        config: this.codexThreadSecurityLayer(config), // F1.723
        developerInstructions: codexDeveloperInstructions(this.activeOutputStyle()?.prompt, this.developerSections(this.callbackBridge?.port)),
        // C3.169 — load-bearing here: a brand-new thread inherits no tier.
        ...(this.managedServiceTier ? { serviceTier: this.managedServiceTier } : {}),
      }, Math.max(1, deadlineAt - performance.now()));
    }

    // A DEADLINE IS NOT A REFUSAL, and this check sits OUTSIDE the `catch` so
    // that stays true by construction. Were the sentinel a rejection instead, it
    // would be measured against `no rollout found` on its way past — passing
    // today only because of how a timeout happens to be worded, and taking the
    // fallback arm the day that wording changed. It must never take that arm:
    // `thread/start` is a LOSSLESS replacement only for a thread PROVEN empty,
    // and a fork that merely did not answer proves nothing — the thread may hold
    // the entire conversation, which a fresh `thread/start` would drop.
    //
    // Nor can it reach {@link isDefinitiveBackgroundTerminalsRefusal} — or the
    // `configRequirements` probe, which since P2.243 asks the same shared
    // function: the sentinel is not an error, and the message below carries no
    // serde token and no `code`.
    if (result === CODEX_REQUEST_TIMED_OUT) {
      throw new Error(
        `codex thread re-fork did not answer within ${timeoutMs}ms; the drifted thread configuration `
        + `(model and plugin/sandbox policy) could not be applied, so this turn was not started`,
      );
    }
    const threadId = (result as { thread?: { id?: string } }).thread?.id;
    if (!threadId) throw new Error('codex thread/fork returned no thread id'); const reforkProviderRefusal = codexReforkedModelProviderRefusal(result, this.declaredCodexModelProvider() ?? CODEX_PROVIDER_KEY); if (reforkProviderRefusal) { this.debug(`[managed] F1.1030: ${reforkProviderRefusal}`); throw new Error(reforkProviderRefusal); } // F1.1030 — F1.634's comparison on the re-fork, before the host adopts the thread
    this.threadId = threadId;
    // P6.102 · a re-fork REPLACES the live thread, so the host's anchor must
    // move with it. Left unpublished, every turn anchor written after a model
    // change would name the pre-drift thread, and a later branch would read the
    // lineage mismatch and silently degrade to a full-history fork — correct,
    // but it would disable branch cutoff for the rest of the session.
    this.config.onSdkSessionIdUpdate?.(threadId);
    this.runtimeConfigSignature = signature; noteCodexThreadRules(this, this.codexHome, execpolicyRules); // F1.928
  }

  /**
   * T1a · claim this turn's handoff for `thread/inject_items`.
   *
   * True only when the SWITCH decided `native`. The decision is not this
   * agent's to make and is deliberately not re-derived here: `planHistoryCarry`
   * weighed the target model's context window against the payload before the
   * modal promised the user anything, and `buildCodexConfigToml` emits
   * `model_context_window` only when the catalogue has one — so a seeded
   * gateway model can arrive with no window at all and codex's own
   * auto-compaction is not a backstop we may rely on. That case resolves to
   * `text` in the planner, and this returns false for it.
   *
   * `plan` absent (a payload armed before T1a, or by a host with no planner)
   * reads as `text` — the shipped behaviour, and the safe one.
   */
  protected override shouldSuppressTextHandoff(handoff: RuntimeHandoffPayload): boolean {
    return handoff.plan === 'native';
  }

  /**
   * Deliver the stashed handoff as Codex's own model-visible history.
   *
   * Returns the message to send. On success that is `effectiveMessage`
   * untouched; on a rejection it is `effectiveMessage` with the text handoff
   * block prefixed, exactly as an unsuppressed turn would have composed it —
   * the fail-safe P2's stash exists for.
   *
   * **Call this as the LAST RPC before `turn/start`, and never re-inject.**
   * Both halves are measured, not stylistic. `thread/inject_items` stamps its
   * records with
   * `internal_chat_message_metadata_passthrough: {"turn_id":"auto-compact-0"}`
   * and never closes that turn, so a `thread/fork` AFTER an inject appends a
   * model-visible `developer` message — `<turn_aborted> The previous turn was
   * interrupted on purpose…` — which is a false statement about this
   * conversation. And injected items survive `thread/fork` byte-identically, so
   * "re-inject after the re-fork" would append a second copy of the whole span
   * rather than restore a lost one. The fork this turn needs has already
   * happened in `applySelectedPluginSkillRuntimePolicy`; nothing between there
   * and `turn/start` opens another.
   *
   * **What crosses, and what does not.** T1b (2026-08-21) added the second
   * half: a `native` payload now carries `history`, the row-level projection,
   * and a tool row becomes a PAIRED `function_call` + `function_call_output`
   * emitted adjacent and in order. The mapping itself is
   * `buildCodexInjectItems`, extracted so the pipeline test calls the shipped
   * one rather than restating it.
   *
   * Still deliberately excluded, with the category string the deviation
   * register harvests from T1a/T1b's rows in
   * `docs/superpowers/plans/2026-08-20-cross-runtime-history-carry.md`:
   *
   * - *Reasoning items: documented, not implemented* — the app-server accepts
   *   them and writes `encrypted_content: null`, and replaying that through our
   *   loopback adapter is a request class we have no reason to invent.
   *
   * The volatile per-turn context blocks are untouched by all of this: they
   * stay on the user message where G5 put them.
   *
   * Known limit, recorded and NOT fixed: `thread/read` answers `turns: []`
   * after an inject, because codex reconstructs its visible turn list from
   * `event_msg` records the inject does not write. Harmless here — the
   * transcript the user sees is ours, not codex's.
   *
   * **P2.260 · BOUNDED, and the bound's whole job is to REACH the `catch` that
   * was already here.** The `try/catch` below has always degraded correctly on a
   * rejection — but `AppServerClient.request` settles on a matching response or
   * on `close()` and NOTHING else (its `timeoutMs` is opt-in and this call did
   * not opt in), so an app-server that accepted the inject and never answered it
   * left the promise pending forever. The `catch` was unreachable by the one
   * failure mode it could not otherwise survive: the turn printed nothing and
   * ended never, three lines short of `turn/start`. This is the same hole
   * P2.245 closed on the background-terminal poll and P2.257 on the re-fork one
   * line up, and it is the last one on this sequence.
   *
   * **It does NOT throw, and that is the deliberate difference from P2.257.**
   * That row's re-fork applies a drifted permission layer, so on expiry there is
   * no honest way to continue and it fails the turn. Here the degradation
   * already exists and is already correct, so the sentinel is converted to an
   * Error INSIDE the `try` and falls into that same `catch` — one degradation
   * path, not two. See {@link CODEX_INJECT_ITEMS_TIMEOUT_MS} for the bound.
   */
  private async deliverRuntimeHandoff(
    effectiveMessage: string,
    /**
     * Budget for the inject. Overridable so a test can pick a bound it can
     * actually wait out; production takes the constant, and the test that pins
     * THAT is the only place production's own number reaches the wire.
     */
    timeoutMs: number = CODEX_INJECT_ITEMS_TIMEOUT_MS,
  ): Promise<string> {
    const handoff = this.pendingRuntimeHandoff;
    // Consume before the await: a delivery is owed exactly once per arming, and
    // whichever branch below runs, this turn settles the obligation.
    this.pendingRuntimeHandoff = null;
    if (!handoff || handoff.messages.length === 0) return effectiveMessage;

    const items = buildCodexInjectItems(handoff);
    const toolPairs = handoff.history?.filter(entry => entry.kind === 'tool').length ?? 0;

    try {
      const result = await requestWithinDeadline(
        this.client!,
        'thread/inject_items',
        { threadId: this.threadId, items },
        timeoutMs,
      );
      // THROWN ON PURPOSE, and inside the `try` on purpose. The sentinel is not
      // an error — {@link CODEX_REQUEST_TIMED_OUT} exists precisely so a
      // deadline cannot be mistaken for a refusal by a caller that classifies
      // one — but here the two want the SAME outcome, and the route to it is the
      // `catch` below. Converting it here rather than adding a second fallback
      // arm is what keeps this method with exactly one degradation path: a
      // second one would be a second place for the text handoff, the
      // `markRuntimeHandoffApplied('text')` call and the empty-text guard to
      // drift apart.
      //
      // Nothing classifies this message, so the wording is free: this method has
      // no capability latch, `isDefinitiveBackgroundTerminalsRefusal` is a
      // different call's classifier, and the `catch` only debug-logs what it
      // caught. It still carries no serde token and no `code`, so it would be
      // read as transient if that ever changed.
      if (result === CODEX_REQUEST_TIMED_OUT) {
        throw new Error(`thread/inject_items did not answer within ${timeoutMs}ms`);
      }
      this.config.markRuntimeHandoffApplied?.('native-inject');
      this.debug(`[runtime-handoff] injected ${items.length} items from ${handoff.from} as native history (${toolPairs} tool call/result pairs)`);
      return effectiveMessage;
    } catch (error) {
      // The armed payload is spent either way — falling back inside the SAME
      // turn is what keeps the history from waiting for a turn that may never
      // come, and the text block is the honest channel: it frames itself as a
      // prior transcript and tells the model to re-check what it depends on.
      //
      // "did not deliver" rather than the "refused" this line used to say: since
      // P2.260 a deadline reaches here too, and a request the app-server never
      // answered was not refused by it.
      const message = error instanceof Error ? error.message : String(error);
      this.debug(`[runtime-handoff] thread/inject_items did not deliver (${message}); falling back to the text handoff`);
      const text = buildRuntimeHandoffContext(handoff.from, handoff.messages);
      if (!text) return effectiveMessage;
      this.config.markRuntimeHandoffApplied?.('text');
      return `${text}\n\n${effectiveMessage}`;
    }
  }

  /**
   * P2.299 — codex compacts on demand, and this is the override that says so at
   * the `BaseAgent.chat` seam.
   *
   * The mechanism is `chatImpl`'s `thread/compact/start` request, which is a
   * REQUEST and not a turn — the app-server's own method, beside `thread/start`
   * and `thread/fork` in the bundled binary's client-request table. A `true`
   * here does not answer the command; it lets it reach that arm.
   *
   * Note what is NOT claimed. `thread/fork` is in the same table and this file
   * DOES call it — but to re-fork the thread on a config drift and then continue
   * in it (`applySelectedPluginSkillRuntimePolicy`), which produces no
   * background subagent with its own transcript and controls. So codex inherits
   * `canForkConversation() === false` and `/subtask` is answered honestly at the
   * seam. Wiring a real fork means adding that override in the same commit — the
   * biconditional test asserts the claim and the mechanism are one set.
   */
  protected override canCompactContext(): boolean {
    return true;
  }

  protected async *chatImpl(
    message: string,
    attachments?: FileAttachment[],
    options?: ChatOptions,
  ): AsyncGenerator<AgentEvent> {
    this.processing = true;
    this.aborted = false;
    this.stopHookForTurn = null;
    this.stopFailureHookEmittedForTurn = false;
    this.manualCompactionRequestedForTurn = false;
    // P6.366 (the ladder) · per-TURN, and the walk is per-MESSAGE.
    //
    // The terminal code belongs to this turn and is cleared on every entry. The
    // cursor and the primary belong to the WALK, so a re-entry from the ladder
    // below must not reset them — which is what the one-shot flag says, and why
    // it is cleared immediately: a turn that does not itself retry leaves the
    // next ordinary message starting the walk from scratch.
    this.turnTerminalErrorCode = null;
    if (!this.fallbackChainRetrying) {
      this.fallbackChainCursor = -1;
      this.fallbackChainPrimaryModel = null;
      this.fallbackChainActiveModel = null;
    }
    this.fallbackChainRetrying = false;
    const sessionStartSource = this.threadId ? 'resume' : 'startup';
    try {
      // R18 · the schema gate runs BEFORE the runtime is started: an invalid
      // schema is the caller's error, and spinning up an app-server to discover
      // it costs a subprocess for a turn that cannot succeed.
      // `compileStructuredOutputSchema` throws the documented
      // `invalid structured-output schema: …` error, and the turn ends on it
      // rather than running unconstrained — a silently schema-less turn is the
      // one outcome a structured caller cannot detect. Same error + complete
      // shape the integrity refusal below uses, for the same reason: a bare
      // `return` leaves `sendMessage` finalizing as `interrupted`.
      let compiledOutputSchema: { compiled: CompiledStructuredOutputSchema; schema: Record<string, unknown> } | undefined;
      if (options?.outputSchema) {
        const schema = options.outputSchema;
        try {
          compiledOutputSchema = { compiled: compileStructuredOutputSchema(schema), schema };
        } catch (error) {
          yield { type: 'error', message: error instanceof Error ? error.message : String(error) };
          yield { type: 'complete' };
          return;
        }
      }
      const pluginRuntime = this.resolveSelectedPluginSkillRuntimePolicy();
      try {
        // P2.232 — the same await, plus a progress signal while it runs. The
        // spread on this path is about 170x (232 ms warm to 34.7 s cold,
        // measured), which is why it is a signal and never a deadline; the
        // numbers and the native-first measurement are on
        // {@link CODEX_STARTUP_FIRST_NOTICE_MS}.
        yield* this.ensureRuntimeReportingProgress();
      } catch (error) {
        // The integrity seatbelt refused, and a refusal that reaches nobody is the
        // defect this catch exists for: measured on the 1.25.1 gate, a tampered
        // nested binary produced one user message and NOTHING else — no reply, no
        // error row, no toast — and a packaged build writes no application log, so
        // the verifier's own diagnostic was invisible too.
        //
        // The channel is the established one, not a new surface: an `error` event
        // becomes a `role: 'error'` transcript row in
        // `SessionManager.processEvent`'s `case 'error'`, the same route
        // `pi-agent.ts`'s unknown-error branch and `base-agent.ts`'s
        // "Skill(s) not found" already take, and the trailing `complete` is what
        // ends the turn there too (a generator that just returns leaves
        // `sendMessage` finalizing as `interrupted`).
        //
        // ONLY the integrity refusal is caught. Every other startup failure keeps
        // throwing exactly as before — including `codex-agent-destroyed`, whose
        // whole point is that the session is already gone.
        if (!isCodexIntegrityError(error)) throw error;
        this.debug(`Codex runtime refused by the integrity gate: ${error.message}`);
        yield { type: 'error', message: error.userMessage };
        yield { type: 'complete' };
        return;
      }
      if (!this._sessionStartHooksApplied) {
        const result = await this.emitAutomationEvent('SessionStart', {
          hook_event_name: 'SessionStart',
          source: sessionStartSource,
        });
        this._sessionStartHooksApplied = true;
        this._sessionStartEmitted = true;
        this._sessionEndEmitted = false;
        // C3.361 · a `SessionStart` hook's `systemMessage`/`stopReason`. The
        // notice queues when no turn sink exists yet, which is this event's
        // ordinary case.
        this.surfaceHookUserFacingOutput('SessionStart', result);
        this._sessionHookContext = result?.decision?.additionalContext?.trim() || undefined;
        // Awaited before the turn is assembled below, so a `reloadSkills`
        // rescan is visible to this turn (hooks.md:1062).
        await this.applyHookSessionDirectives(result?.decision);
      }
      const promptResult = await this.emitAutomationEvent('UserPromptSubmit', {
        hook_event_name: 'UserPromptSubmit',
        prompt: message,
      });
      // hooks.md: `UserPromptSubmit` "ends the turn on `decision: block`
      // regardless of `continue`" — the prompt never reaches the model, and the
      // reason is what the user is told instead.
      if (hookBlockEndsTurn('UserPromptSubmit') && isBlockingHookDecision(promptResult?.decision)) {
        // C3.361 · `stopReason` as the SECOND source of the sentence, before the
        // generic one. `hooks.md#json-output` calls `stopReason` the "Message
        // shown to the user when `continue` is `false`", and the ordering is the
        // page's own where it spells one out —
        // `hooks.md#posttoolbatch-decision-control`: "The blocking message comes
        // from the JSON `reason` or `stopReason`, or from stderr on exit 2."
        // (That sentence lives in the PostToolBatch section, not the
        // UserPromptSubmit or Stop ones, which give no ordering at all; it is
        // quoted because it is the only place the page ranks the two fields.)
        // Until this row a hook that stopped
        // the prompt with `{continue:false, stopReason}` alone reached the
        // generic sentence: `parseHookOutputForEvent` maps `continue:false` onto
        // `decision: 'block'` WITHOUT a `reason` (deliberately — `stopReason` is
        // the user half, `reason` the model half), so `decision.reason` is empty
        // on that shape and the hook's own words went nowhere.
        const reason = promptResult?.decision?.reason?.trim()
          || promptResult?.universal?.stopReason?.trim()
          || 'A UserPromptSubmit hook blocked this prompt.';
        // Only the systemMessage arm, and YIELDED rather than queued: this
        // branch returns before `chatImpl` opens a turn sink, so
        // {@link surfaceCodexOperatorNotice} would defer the line to the NEXT
        // turn — a warning about a prompt the user has already been told was
        // blocked, arriving above a different prompt. The stop's own sentence is
        // the `error` row below; surfacing it twice would read as two stops.
        const blockedSystemMessage = promptResult?.universal?.systemMessage?.trim();
        if (blockedSystemMessage) {
          yield { type: 'info', message: `UserPromptSubmit hook: ${blockedSystemMessage}`, level: 'warning' };
        }
        this.debug(`__HOOK_BLOCK__${JSON.stringify({ event: 'UserPromptSubmit', applied: true })}`);
        yield { type: 'error', message: reason };
        return;
      }
      // C3.361 · the turn PROCEEDS and the hook still had something to say —
      // R4's own control arm for this row (C3.89, 2026-09-12), which claude
      // renders in the pane and codex surfaced nowhere.
      this.surfaceHookUserFacingOutput('UserPromptSubmit', promptResult);
      // After the block check: a blocked prompt is erased from context, so it
      // names nothing (hooks.md:1266).
      await this.applyHookSessionDirectives(promptResult?.decision);
      // A session command goes out BARE. `BaseAgent.chat`'s seam comment: it "is
      // an instruction to the SESSION, not a prompt: it must reach the backend
      // as the bare command", because anything composed onto the FRONT "pushes
      // the leading slash out of the backend's command branch. That is how BOTH
      // `/compact` and `/subtask` shipped reaching the model as prose." Claude
      // guards inside its own chatImpl (its `SDK_SLASH_COMMANDS` branch matches
      // the trimmed message and writes it raw, skipping `buildTextPrompt`); Pi
      // classifies from the ORIGINAL message at the top of its `chatImpl`, ahead
      // of the resume-recovery prefix.
      //
      // P2.300 — this said "Codex has no command branch of its own yet, so
      // nothing observably breaks today". It HAS one: the `thread/compact/start`
      // arm below, added while this sentence stayed put. The composition would
      // therefore not make a branch "born dead" — it would break a live one, and
      // every `/compact` would pay a full context block for a turn that is not a
      // prompt. (Symbols rather than line numbers on purpose: every line number
      // this comment carried was stale by the time anyone read it.) `message` is
      // never reassigned here, so this classifies the turn as the user typed it.
      const sessionCommand = parseSessionCommand(message);

      // The PromptBuilder context parts, in Claude's shape: every block on the
      // outgoing user turn, ahead of the user's own text (`claude-agent.ts:2622`,
      // `:2668`). Pi's split — stable blocks folded into the cached system
      // prefix — is not available here: the app-server owns the system prompt,
      // so the user turn is the only channel codex has. Without this the skill
      // LISTING (which rides the stable part, `base-agent.ts:642`) never reached
      // the model, and neither did date/time, `session_state`, `<sources>`,
      // workspace capabilities or the working directory.
      //
      // `buildContextParts` calls `buildVolatileContextParts`, which CONSUMES
      // the one-shot mode-change signal — so it runs exactly once per chatImpl,
      // never a second time to recompute, and not at all on a command turn
      // (which leaves the signal intact for the next real prompt — the same
      // reason the base-agent seam returns early).
      let effectiveMessage: string;
      // P6.28 · this turn's attachments, resolved once. Filled only on the
      // NON-command arm: the seam's rule above is that a session command "must
      // reach the backend as the bare command", and a `[Attached …]` block
      // composed onto it is exactly the prefix that pushed the leading slash out
      // of the backend's command branch before. In production the arm is
      // unreachable anyway (`BaseAgent.chat` answers every command kind, and
      // `/compact` returns above) — it is a direct-`chatImpl` caller's path.
      let turnImageInputs: Array<{ type: 'localImage'; path: string }> = [];
      let uncarriedImageNames: string[] = [];
      // P3.364 · the document half of the same report; see `CodexAttachmentInput`.
      let uncarriedDocumentNames: string[] = [];
      // UB12.63 · the block the thread holds once this turn's message is sent;
      // `undefined` on a command turn, which plans nothing and leaves a notice
      // owed to the next real prompt.
      let outputStyleDeliveredBySend: string | undefined;
      if (sessionCommand) {
        effectiveMessage = message.trim();
      } else {
        const modeDiagnostics = getPermissionModeDiagnostics({
          workspaceId: this.config.workspace.id,
          sessionId: this._sessionId,
        });
        this.debug(
          `[ModeSnapshot] sessionId=${this._sessionId} codexTurn mode=${modeDiagnostics.permissionMode} `
          + `modeVersion=${modeDiagnostics.modeVersion} changedBy=${modeDiagnostics.lastChangedBy} changedAt=${modeDiagnostics.lastChangedAt}`,
        );
        // P6.36 · the per-turn style reminder. The builder has emitted it for
        // every runtime since it was written; codex was the one backend that
        // never fed it, so the seam was wired and inert. Fed from the SAME
        // child-kind-guarded resolution the `developerInstructions` prose comes
        // from. A composition with no prose (Default, an unresolvable id) clears
        // the label and emits nothing.
        //
        // UB12.63 · and the PROSE of a style picked mid-session. The
        // `developerInstructions` carrying it are fixed when the thread opens:
        // `TurnStartParams` has no such field at `rust-v0.162.0` (the generated
        // schema), the per-turn `collaborationMode.settings.developer_instructions`
        // is codex's own preset slot that F1.788 leaves `null` on purpose, and a
        // `thread/resume` that rejoins a running thread ignores overrides (the
        // re-fork walk's own comment). So the reminder used to name the new style
        // while the thread still held the old prose. Now the switch rides this
        // turn as the one-shot notice claude got in UB12.21: Claude Code's
        // documented delivery (`prompt-caching.md#changing-output-style`:
        // "delivers the new style's instructions as a message in the
        // conversation"), and `output-styles.md#change-your-output-style`'s "Claude
        // uses the new style starting with your next message". Every non-command
        // codex turn continues a thread whose instructions are already set.
        // `switchNotices` points the reminder at the latest block, not at the
        // developer instructions. Rules and the unknown-case residue:
        // `core/output-style-switch.ts`.
        const turnOutputStyle = this.activeOutputStyle();
        this.promptBuilder.setActiveOutputStyle(turnOutputStyle?.label ?? null, { switchNotices: true });
        const outputStyleSwitch = planOutputStyleSwitch({
          delivered: this.deliveredOutputStylePrompt,
          current: turnOutputStyle,
          continuesRecordedPrompt: true,
        });
        outputStyleDeliveredBySend = outputStyleSwitch.delivered;
        const contextParts = this.promptBuilder.buildContextParts(
          // P6.704 - the configured `plansDirectory` when set and contained;
          // unset is today's session path byte-for-byte.
          { plansFolderPath: resolvePlansDirectory(this.workingDirectory)
            ?? getSessionPlansDir(this.config.workspace.id, this._sessionId) },
          this.sourceManager.formatSourceState(),
        );

        // P2.59 — THE HOOK CONTEXT IS UNTRUSTED, AND ON THIS RUNTIME IT WAS THE
        // ONE UNFENCED BODY LEFT.
        //
        // `additionalContext` is a hook's STDOUT — a shell script's bytes, and
        // often not even the script's own words (a `git log`, a linter's report,
        // a file it cat-ed). Composed raw into this list it sat DIRECTLY among
        // host-authored parts (`<sources>`, `session_state`, the capability
        // block) with no element and no defang, in the band the host speaks in
        // and ABOVE the user's own message. Measured on this path before the
        // fence: a hook printing `</sources>` followed by `<system-reminder>`
        // guidance ended a host element and put live harness instructions over
        // the user's turn — strictly worse than the shape P2.31 fixed on
        // nestor-cloud, which at least had an enclosing element to escape from.
        //
        // CLAUDE NEVER HAD THIS. PI STILL DOES — P2.225.
        //
        // `claude-agent.ts` passes `additionalContext` to the SDK as a discrete
        // FIELD and never composes it into text, so it is genuinely clean.
        // `pi-agent.ts` is NOT: it composes the `SessionStart` body raw into
        // `fullSystemPrompt` — the SYSTEM block, `.filter(Boolean).join()` — and
        // the `UserPromptSubmit` body raw into `buildTurnUserMessage`'s tail.
        // No element, no fence, no defang, in a band strictly MORE trusted than
        // the one codex used. Measured while closing P2.59, with a positive
        // control on the same rig: `rg -a -c` for this file's three fence
        // identifiers scores 0 in `pi-agent.ts`, 7 in `nestor-cloud-agent.ts`
        // and 5 here.
        //
        // THIS COMMENT USED TO SAY CODEX WAS THE ONLY RUNTIME LEFT, and the
        // measurement that closed the row refuted it. Corrected rather than
        // deleted, because the wrong sentence did not merely go stale — it
        // pointed the next reader AWAY from a defect that is still open.
        //
        // Same mitigation as the sibling, and since P3.281 it is literally the
        // same code: `automations/hook-context-fence.ts:fenceHookBand` composes
        // the outer `<hook_context>` element, `UNTRUSTED_HOOK_NOTICE`, and
        // `untrusted-text.ts:wrapUntrusted`'s `<untrusted source="...">` fence
        // with the body through `neutralizeHarnessMarkers`. The fence is
        // SELF-PROTECTING — `untrusted` is one of the defanger's three names —
        // so a body cannot write the tag that closes it, and a body writing the
        // outer closing tag is stuck inside the fence.
        //
        // This paragraph described a HAND-COPY of that expression until P3.281,
        // and the copy had drifted in the one way a copy always drifts: it never
        // gained the notice the shared helper added, so this runtime's hook band
        // was contained and unexplained while three others were both.
        //
        // ORDER AND CONTENT ARE UNCHANGED: session context first, then this
        // prompt's, both still after `contextParts` and before the user's
        // message. What the model is told, and when, is what it was; what
        // changed is that it can now tell which half a hook wrote.
        const hookContext = [
          this._sessionHookContext,
          promptResult?.decision?.additionalContext?.trim() || undefined,
        ].filter((part): part is string => Boolean(part)).join('\n\n');

        // P6.28 · attachments sit BETWEEN the host's context and the user's own
        // text — Claude's order (`buildSDKUserMessage` pushes every context part,
        // then each `[Attached file: …]` pointer, then the user text) and Pi's
        // (`buildTurnUserMessage(volatileParts, attachmentParts, message, …)`).
        // Composed into this ONE text member rather than added as a second one,
        // so the request keeps the shape every existing reader asserts on
        // (`params.input[0].text`).
        const attachmentInput = buildCodexAttachmentInput(attachments);
        turnImageInputs = attachmentInput.images;
        uncarriedImageNames = attachmentInput.uncarriedImages;
        uncarriedDocumentNames = attachmentInput.uncarriedDocuments;

        // P6.11 · the delivery half of the Stop hook's block. `recordHookBlockFeedback`
        // queues `<hook_feedback event="Stop">…</hook_feedback>` and the queue had
        // exactly one consumer repo-wide, in `pi-agent.ts` — so on codex the
        // reason was recorded and never spoken. Drained here, once per turn,
        // riding the volatile user tail like Pi's.
        //
        // FENCED, unlike Pi's, and deliberately: the body is a hook's stdout,
        // and this file's P2.59 note records that composing such a body raw into
        // a host band is a live defect Pi still carries. The `<hook_feedback>`
        // element the recorder writes survives the fence — it is not one of the
        // defanger's three harness names — so the model still sees which event
        // spoke.
        //
        // Placed AFTER `hookContext` so every hook-authored band sits together
        // with the most recent last, and before the user's own message.
        const hookBlockFeedback = this.consumeHookBlockFeedback();
        // P6.864 (YES arm) — see `BaseAgent.recordPermissionAnswerNote`. Placed
        // with the host's own parts below rather than among the hook bands: it
        // is the USER's text relayed by the host, not bytes a hook wrote.
        const permissionAnswerNotes = this.consumePermissionAnswerNotes();

        effectiveMessage = [
          ...contextParts,
          // UB12.63 · the output-style notice, once, right after the context
          // blocks that carry the per-turn style reminder (claude's place for it).
          outputStyleSwitch.notice,
          // P2.294 · the one fact turn 1's frozen skill listing cannot carry,
          // said in the band the model already reads. `null` in every session
          // whose bridge came up, which is the overwhelming majority; the design
          // it implements, the design it declines, and the posture it takes are
          // all on {@link schedulingBridgeContextPart}. Placed with the host's
          // own parts and ABOVE every hook-authored band, because it is a host
          // statement about this session's surface and must not sit among bytes
          // a hook wrote.
          this.schedulingBridgeContextPart(),
          // P6.864 (YES arm) — the user's approval note, relayed by the host.
          // Beside the scheduling part and above every hook-authored band for
          // the reason stated there: it is a host relay of the USER's own words,
          // and it must not sit among bytes a hook wrote.
          permissionAnswerNotes,
          // P3.281 · composed by the SHARED `fenceHookBand` now, so this band
          // carries `UNTRUSTED_HOOK_NOTICE` like the other four. The element,
          // the fence and the defang are byte-identical to the hand-copy this
          // replaces; what is added is the sentence telling the model what a
          // hook's bytes may and may not do — and a notice that only some bands
          // carry is worse than none, because it teaches the model that an
          // unannotated fence is a more trustworthy kind of thing.
          fenceHookBand({ element: 'hook_context', source: 'hook_context', body: hookContext }),
          // P3.281 · and the OUTER WRAP IS GONE. `consumeHookBlockFeedback`
          // returns what `recordHookBlockFeedback` already composed through this
          // same helper — `<hook_feedback event="…">`, the notice, the fenced
          // and defanged body — so the line here re-fenced an already-fenced
          // band inside a SECOND, differently-named element. The model was shown
          // a `<hook_context>` that contained a fence that contained a
          // `<hook_feedback>` that contained another fence, and the outer pair
          // said nothing the inner pair had not already said.
          hookBlockFeedback,
          ...attachmentInput.pathParts,
          message,
        ].filter((part): part is string => Boolean(part)).join('\n\n');
      }

      // P3.28 · turn-head advisor-surface drift check. BEFORE the re-fork below,
      // so a thread forked for a drifted model/policy is the one that starts
      // with the corrected MCP inventory. Structurally no-throw and a boolean
      // compare when nothing moved, which is every turn but the one after a
      // flip; the RPC pair only runs on an actual drift.
      await this.refreshSessionMcpAdvisorAdvertisement();
      { let reopening!: () => void; const reopened = new Promise<true>(resolve => { reopening = () => resolve(true); }); const refork = this.applySelectedPluginSkillRuntimePolicy(pluginRuntime, CODEX_THREAD_REFORK_TIMEOUT_MS, reopening); const announced = await Promise.race([reopened, refork.then(() => false, () => false)]); if (announced) { if (!i18n.isInitialized) setupI18n(); yield { type: 'status', message: i18n.t('chat.codexStatus.reopeningThread', { seconds: Math.round(CODEX_THREAD_REFORK_TIMEOUT_MS / 1000) }), phase: true }; } await refork; if (announced) yield { type: 'status', message: '', phase: true }; } // F1.1028 — a re-fork (13-49 s on 0.156.1, F1.1018) says so on the status channel, only when one runs; F1.1150 — as a phase label the turn clears once the re-fork has settled (a failed one ends the turn, and the turn's end clears it)
      this.eventAdapter.startTurn();
      const queue = createEventQueue();
      this.turnSink = queue;
      // P2.408 · anything codex warned about while no turn was open goes out
      // FIRST, ahead of this turn's own events — it describes the session this
      // turn is about to run in, so it belongs before the run, not after it.
      this.flushPendingServerWarnings(queue);
      // A fresh turn owns a fresh steer set. The boundary that ended the last
      // turn already detached its own; this is the belt to that braces, and it
      // guarantees `redirect` on this turn can never capture a set an earlier
      // turn is still finishing against.
      this.detachTurnSteers();

      // P3.3 · turn-boundary background-terminal sync. Runs BEFORE `turn/start`
      // so the chip events precede this turn's `complete` (the only reliable
      // delivery window — see {@link syncBackgroundTerminalsIntoSink}). Awaited
      // so ordering is deterministic; one local stdio round-trip on a supporting
      // binary, and a no-op after the first probe on one that lacks the method.
      // Defence in depth: the callee is structurally no-throw AND bounded
      // (P2.245 — a hang is not a throw, and this `await` is on every turn), and
      // this `catch` means even a future edit that breaks the no-throw promise
      // cannot fail the turn.
      try {
        // P6.111 · a between-turns refresh may still be walking its pages; it is
        // bounded by the same deadline this call is, so awaiting it costs at
        // most that budget and removes the only path on which two walks could
        // announce one terminal twice. Then its parked events go out FIRST —
        // they describe terminals observed before this turn started.
        await this.backgroundTerminalRefresh;
        for (const event of this.pendingBackgroundTerminalEvents.splice(0)) queue.push(event);
        await this.syncBackgroundTerminalsIntoSink(queue);
      } catch (error) {
        this.debug(`Codex background-terminal sync threw unexpectedly: ${error instanceof Error ? error.message : String(error)}`);
      }

      // `/compact` is a REQUEST, not a prompt. Sending the text as a turn asked
      // the model to talk ABOUT compaction; the app-server has a method for it.
      //
      // `thread/compact/start` ({threadId} → {}) was confirmed served by the
      // bundled binary, not assumed: its string sits in the client-request
      // method table, in sequence with `initialize`, `thread/start`,
      // `thread/resume` and `thread/fork` — every one of which we already call.
      //
      // UNVERIFIED, and deliberately made harmless: whether the compaction
      // notification lands before or after the response, and whether a
      // `turn/completed` follows at all. So the queue is closed on the response
      // itself rather than on a notification that may never arrive — a manual
      // compaction can lose its transcript row, but it can never hang the
      // composer. F5-codex is the live case that settles the ordering.
      //
      // AND IT CLOSES THROUGH THE STEER-AWARE PATH, not a bare `queue.finish()`.
      // A `/compact` turn is a turn: while this request is open the session is
      // processing, so a mid-stream send reaches `redirect()`, and a compact turn
      // is EXACTLY the turn codex refuses to steer ("cannot steer a compact
      // turn") — a refusal this client cannot predict, because codex also
      // compacts on its own token budget. `redirect()` has already returned
      // `true` by then, so the message is shown as accepted; closing the queue on
      // the response would let `drain()` return before the refusal arrives and
      // the user's correction would be dropped in silence. Measured on the
      // helper: with a steer pending the sink stays open, the refusal lands as
      // `steer_undelivered`, and only then does the stream end.
      if (sessionCommand?.kind === 'compact') {
        try {
          // P6.118 · the ONE place this fork asks for a compaction, so it is the
          // only place `trigger: 'manual'` can be known. Set before the request:
          // the compaction notification can land while it is still in flight.
          this.manualCompactionRequestedForTurn = true;
          await this.client!.request('thread/compact/start', { threadId: this.threadId });
        } catch (err) {
          queue.push({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        } finally {
          this.finishTurnSinkAfterPendingSteers();
        }
        yield* queue.drain();
        return;
      }

      // T1a · the runtime handoff, delivered natively when the switch planned
      // it that way. HERE, and not earlier, for two reasons that are both
      // measured: the thread id must be post-fork (the fork happens in
      // `applySelectedPluginSkillRuntimePolicy` above), and the inject must be
      // the LAST RPC before `turn/start` — a fork after it appends a
      // model-visible `<turn_aborted>` developer message. See
      // {@link deliverRuntimeHandoff}.
      //
      // P2.300 — this listed `/subtask`, `/btw`, `/recap` and `/heapdump` as
      // session commands that reach this line. None of them do any more. P2.292
      // moved `btw`/`recap`/`heapdump` to the `BaseAgent.chat` seam and P2.298
      // claims `subtask` there for any runtime that cannot fork — which is codex
      // — so on THIS backend every kind is now either answered at the seam or
      // returned by the `/compact` arm above. `sessionCommand` is therefore
      // non-null here only for a DIRECT `chatImpl` caller (a test, a relayed or
      // legacy sender), and it becomes reachable again the day codex claims
      // `canForkConversation()`.
      //
      // Either way it is fine rather than a hole: the base seam returns before
      // it reads the handoff, so `pendingRuntimeHandoff` is only non-null there
      // if an earlier suppressed turn failed before delivering — in which case
      // the obligation really is still owed and delivering it is right.
      effectiveMessage = await this.deliverRuntimeHandoff(effectiveMessage);

      // R18 · armed HERE, immediately before the request that carries the
      // schema, so no notification of this turn can be missed and no turn that
      // returned earlier leaves the obligation behind. `turn/start` is fired
      // WITHOUT await, so the arming must precede the call, not follow it.
      this.turnStructuredOutput = compiledOutputSchema
        ? { compiled: compiledOutputSchema.compiled, turnId: null, lastAssistantText: null }
        : null;

      // P3.101 · an image this backend could not carry is SAID, not swallowed.
      // The upstream filter cannot report it — `filterAttachmentsForModelInput`
      // only fires when the runtime declares `images: 'no'` — so the only place
      // that knows is the adapter that failed to build the member. Same channel
      // and same wording family as `SessionManager`'s own omission notice, and
      // it is yielded BEFORE `turn/start` so it precedes this turn's output.
      if (uncarriedImageNames.length > 0) {
        const names = uncarriedImageNames.join(', ');
        this.debug(`[attachments] ${uncarriedImageNames.length} image(s) not sent to codex: ${names}`);
        yield {
          type: 'info',
          level: 'warning',
          message: `Image attachment${uncarriedImageNames.length === 1 ? '' : 's'} not sent to the model — codex carries an image by file path and no readable file was found: ${names}.`,
        };
      }

      // P3.364 · the DOCUMENT half, and a separate yield rather than a widened
      // one, because the two promises differ. An uncarried image is an accident
      // a readable file would fix; an uncarried document is codex's own ceiling
      // — its `UserInput` union has no document member at `rust-v0.148.0` — so
      // the sentence says the bytes are not carried on this runtime AT ALL, and
      // names the runtime that does carry them, because that is the action
      // available to the user.
      if (uncarriedDocumentNames.length > 0) {
        const names = uncarriedDocumentNames.join(', ');
        this.debug(`[attachments] ${uncarriedDocumentNames.length} document(s) carried to codex as a path only: ${names}`);
        yield {
          type: 'info',
          level: 'warning',
          message: `Attachment${uncarriedDocumentNames.length === 1 ? '' : 's'} sent as a file path only — codex cannot read `
            + `${uncarriedDocumentNames.length === 1 ? 'its' : 'their'} contents, and neither can the Pi runtime. `
            + `The Claude runtime carries a PDF's bytes to the model: ${names}.`,
        };
      }

      // P6.28 · typed against the restated union so a member that is not on
      // codex's wire cannot be added here without the type being corrected
      // against the schema first.
      const turnInput: CodexTurnInput[] = [
        { type: 'text', text: effectiveMessage, text_elements: [] },
        ...turnImageInputs,
      ];

      // F1.532 · the floor hook's state file follows the mode this turn is started with, whatever
      // path set it (a restore or a clamp writes the mode state around the agent).
      this.writeFloorHookState();

      // UB12.63 · the thread holds this turn's style block once the message is
      // sent, and not before: a turn that ends ahead of `turn/start` (a failed
      // re-fork above) leaves the notice owed, and a refused `turn/start` puts
      // the previous value back (its `.catch` below).
      const outputStyleDeliveredBeforeSend = this.deliveredOutputStylePrompt;
      if (outputStyleDeliveredBySend !== undefined) this.deliveredOutputStylePrompt = outputStyleDeliveredBySend;

      // Fire the turn; the notification handler drains events onto the queue.
      void this.client!.request('turn/start', {
        threadId: this.threadId,
        // P6.365 · THE PER-TURN MODEL OVERRIDE codex declares and we were not
        // sending.
        //
        // `TurnStartParams.model` — "Override the model for this turn and
        // subsequent turns" (`codex-protocol/schema/v2/TurnStartParams.json`,
        // bindings `generated/v2/TurnStartParams.ts`, both generated from
        // rust-v0.148.0, the tag `manifest.json` pinned then).
        //
        // Until this line a mid-session model change was treated as a CONFIG
        // drift and answered with a `thread/fork` — see
        // {@link codexThreadConfigSignature}, whose own docblock asserted that
        // "turn/start carries no model" and was wrong. The fork preserved
        // history, so nothing looked broken; what it cost was a round trip, the
        // re-fork budget, a new thread id, and on a rollout-less thread a
        // fallback `thread/start` that begins an EMPTY thread.
        //
        // Sent on EVERY turn and not only after a change: the field is the
        // thread's model as this session understands it, and an unconditional
        // send is the one form that cannot go stale. It is the same value
        // `thread/start` and `thread/fork` already carry, so an unchanged
        // session sends what codex already has.
        //
        // DRIFT FAILURE MODE, the same one `outputSchema` records below:
        // `TurnStartParams` does not declare `additionalProperties: false`, so
        // an app-server older than the field would ACCEPT this and ignore it —
        // and a mid-session model change would then be silently inert. The
        // bundled binary is pinned to the tag the schema is generated from, so
        // the two cannot disagree without the pin moving first.
        model: this._model,
        // P6.365 · `TurnStartParams.effort` — "Override the reasoning effort for
        // this turn and subsequent turns", the same sentence `model` carries and
        // the same pinned schema.
        //
        // The SAME table `model_reasoning_effort` is written from, imported
        // rather than restated: two spellings of one six-row mapping is the
        // drift this repo keeps paying for. `off` is Nessy's own level and maps
        // to codex's `none`, which is a real `ReasoningEffort` variant — the
        // reasoning behind that pair is at the table's own declaration.
        //
        // Why it matters beyond tidiness: `model_reasoning_effort` lives in
        // `config.toml`, which the app-server reads only at START, so before
        // this line an `/effort` change mid-session reached codex on the next
        // RUNTIME BUILD and not on the next turn.
        effort: REASONING_EFFORT[this._thinkingLevel],
        // P6.223 · THE PER-TURN APPROVAL POLICY, and the end of the
        // respawn-on-mode-change.
        //
        // `TurnStartParams.approvalPolicy` — "Override the approval policy for
        // this turn and subsequent turns", the same sentence and the same pinned
        // schema as `model` and `effort` above. Until this line a permission-mode
        // change set `pendingModeRestart`, and `ensureRuntime` TORE THE RUNTIME
        // DOWN to rewrite `config.toml` — because the app-server reads that file
        // only at start. Pi and claude apply `setPermissionMode` live; codex was
        // the one runtime where tightening a session cost a respawn.
        //
        // Derived through `codexSandboxConfigForMode`, the same function the
        // config writer uses, so the turn cannot express a pair the file would
        // not have written — including the two UNBOUNDED DEGRADATIONS (R13's
        // `never` and P2.197's `on-request`, both to a single value when the
        // sandbox master switch is off; which value moved at `rust-v0.150.1`
        // and that function is the one place that says so). Restating the table
        // here instead would have
        // been a second source of truth for the one setting that decides whether
        // a session asks before acting.
        //
        // `sandboxPolicy` is deliberately NOT sent beside it, and the reason is
        // the sentence this call already embodies: `CODEX_PERMISSION_MODE_TABLE`
        // (`packages/codex-responses-adapter/src/config-writer.ts`), read here
        // through {@link codexSandboxConfigForMode}, stays the SINGLE WRITER of
        // sandbox intent. Sending the policy inline would make this turn a
        // second writer of four values that table derives in one place
        // (`workspaceWrite` requires `writableRoots`, `networkAccess`,
        // `excludeTmpdirEnvVar` and `excludeSlashTmp`), and a wrong
        // `networkAccess` there is a SILENT WIDENING rather than a loud refusal
        // — while the union cannot name a `[permissions.<profile>]` block at
        // all, which is what codex actually resolves. See
        // {@link setPermissionMode} §"Why `sandboxPolicy` is NOT sent" for the
        // measurement and for the road the sandbox half travels instead.
        //
        // C3.8 (owner answer QA4=D, 2026-09-11) re-confirms this as a DECISION
        // rather than a missing wire: the field is declared on
        // `TurnStartParams` and the call it would ride is already ours, so the
        // refusal is what needs recording, not the gap.
        //
        // The direction that survives either way, stated at the strength it is
        // proven: a permission change made mid-turn never reaches what CODEX
        // enforces for the turn already running — the approval override lands on
        // the NEXT `turn/start` and the profile rides the per-turn drift
        // re-fork. What still moves inside a running turn is the HOST gate,
        // consulted per call at {@link consultPermissionRules}. So nothing codex
        // itself enforces can be widened mid-turn; the host half is the only
        // road a mid-turn change travels, in either direction.
        approvalPolicy: codexSandboxConfigForMode(
          this.getPermissionMode(),
          this.sandboxGloballyEnabled(),
        ).approval_policy,
        // F1.373 · `TurnStartParams.approvalsReviewer` — only Auto and Bypass are decided by codex's auto-review
        // reviewer (F1.1169); every other mode says `'user'`, and each says it again, because the override is sticky.
        // F1.482 (1): only a reviewer an administrator's list allows. F1.781: the Settings toggle is re-read
        // here, so turning it off reaches a live session. See {@link codexTurnApprovalsReviewer}.
        ...codexTurnApprovalsReviewer(this.getPermissionMode(), this.configuredApprovalsReviewer, this.managedApprovalsReviewers, this.autoReviewSettingOn()),
        // F1.788 · codex's OWN collaboration mode, on every turn (sticky): `plan` in Plan, `default` otherwise, with
        // codex's preset instructions filled in by codex itself. See {@link codexTurnCollaborationMode}.
        ...codexTurnCollaborationMode({
          permissionMode: this.getPermissionMode(),
          model: this._model,
          effort: REASONING_EFFORT[this._thinkingLevel],
          planEffort: (planLevel => (planLevel ? REASONING_EFFORT[planLevel] : undefined))(this.planModeThinkingLevel()),
        }),
        // P6.28 · codex's own image mechanism, not a port of anyone else's.
        // `UserInput` is a seven-member union and this used to send exactly one
        // member, so a composer image had no wire to travel on. `localImage`
        // takes the resolved stored PATH — no base64 — and the members ride the
        // same array as the text (`TurnStartParams.input: UserInput[]`,
        // `codex-protocol/schema/v2/TurnStartParams.json`, bindings
        // `generated/v2/UserInput.ts`, both from rust-v0.148.0).
        //
        // DRIFT FAILURE MODE, and it is the opposite of `outputSchema`'s above:
        // `UserInput` is a `oneOf`, so an app-server too old to know
        // `localImage` cannot silently ignore the member — it fails to
        // deserialize the request, and the rejection lands on the `.catch` below
        // as a turn `error`. Loud, which is the wanted direction here.
        input: turnInput,
        // R18 · the host's turn-level schema, on codex's own wire.
        // `TurnStartParams.outputSchema` — "Optional JSON Schema used to
        // constrain the final assistant message for this turn"
        // (`codex-protocol/schema/v2/TurnStartParams.json`, bindings
        // `generated/v2/TurnStartParams.ts:45`; both generated from the tag
        // `manifest.json` pins the bundled binary to, rust-v0.148.0).
        //
        // THE DRIFT FAILURE MODE, since bindings and binary are versioned
        // together but not guaranteed to stay so: `TurnStartParams` does NOT
        // declare `additionalProperties: false`, so an app-server older than
        // the field accepts this request and IGNORES it — no error, and a turn
        // that answers in prose while the caller was promised JSON. That is why
        // the result is validated host-side in {@link withStructuredOutput}
        // instead of being trusted: an unenforced schema then surfaces as the
        // documented violation arm rather than as silent free text.
        ...(compiledOutputSchema ? { outputSchema: compiledOutputSchema.schema } : {}),
      }).catch((err) => {
        this.deliveredOutputStylePrompt = outputStyleDeliveredBeforeSend; // UB12.63 — a refused turn carried nothing to the thread
        queue.push({ type: 'error', message: codexTurnStartRefusalMessage(err, this.getPermissionMode(), this.managedApprovalsReviewers) });
        // Same steer-aware close as every other end of a turn. A rejected
        // `turn/start` should not have a steer outstanding (there was no
        // `turn/started` to license one), but "should not" is not a reason to
        // keep a second, unaware way to close a turn's stream in the file.
        this.finishTurnSinkAfterPendingSteers();
      });

      yield* queue.drain();

      // P6.366 (the ladder) · the turn is over. If it ended because the model was
      // overloaded or the server failed, try the next id in the chain instead of
      // handing the user the error — *"Claude Code tries them in order, showing a
      // notice when it switches"* (`model-config.md#fallback-model-chains`).
      //
      // AFTER the drain, not inside the notification handler, for the reason the
      // handler's own comments give: terminality is decided there and consumed
      // here, so the retry cannot fire on a `willRetry` error (a turn still
      // going) or on an error naming a different turn on this thread.
      //
      // The re-entry is `chatImpl` itself, exactly as Pi's `retryWithFallback-
      // Model` does — one implementation of "run a turn", not a second one that
      // has to be kept in step. `setModel` reaches codex through
      // `TurnStartParams.model`, which the request above already carries, so the
      // next turn really runs on the fallback with the thread's history intact.
      const hop = this.aborted ? null : this.nextFallbackModelHop();
      if (hop) {
        const previousModel = this.getModel();
        // Recorded at the FIRST hop only: the model in force when the walk began
        // is the one the page calls the primary, and a later hop overwriting it
        // would restore hop one instead of the primary.
        this.fallbackChainPrimaryModel ??= previousModel;
        this.setModel(hop.modelId);
        this.fallbackChainActiveModel = hop.modelId;
        this.fallbackChainCursor = hop.index;
        this.fallbackChainRetrying = true;
        this.debug(
          `codex retrying turn with fallbackModel=${hop.modelId} (chain #${hop.index}) `
          + `after ${this.turnTerminalErrorCode} on ${previousModel}`,
        );
        // One notice per HOP, so a three-entry walk is visible as three switches
        // rather than as one — the same shape Pi emits.
        yield {
          type: 'info',
          message: `Retrying with fallback model ${hop.modelId} after ${this.turnTerminalErrorCode} `
            + `on ${previousModel}. Effective model: ${hop.modelId}`,
        };
        yield* this.chatImpl(message, attachments, options);
      }
    } finally {
      try {
        // UA12.101 follow-up 2 · BEFORE the Stop input is built: an exit a
        // mid-turn refresh parked must already have retired the host's shell
        // entry, or this turn's Stop hook lists the ended terminal as running.
        this.releaseParkedTerminalEvents();
        await this.emitStopHookOnce();
      } finally {
        // P6.366 (the ladder) · *"The switch lasts for the current turn only, so
        // your next message tries the primary model first again."* The DEEPEST
        // frame restores and clears, so the frames above it find nothing to do —
        // and the restore only ever undoes a model THIS walk installed, so a
        // change from the user's picker mid-turn survives.
        if (this.fallbackChainPrimaryModel !== null) {
          if (this.getModel() === this.fallbackChainActiveModel
            && this.getModel() !== this.fallbackChainPrimaryModel) {
            this.debug(`codex restoring primary model ${this.fallbackChainPrimaryModel} after a fallback-chain turn`);
            this.setModel(this.fallbackChainPrimaryModel);
          }
          this.fallbackChainPrimaryModel = null;
          this.fallbackChainActiveModel = null;
        }
        this.processing = false;
        this.turnSink = null;
        // P6.111 · the turn is over and its sink is gone, so the level the
        // reaper reads is now frozen at THIS turn's head — a terminal the turn
        // just spawned reads as no work at all. One fire-and-forget poll closes
        // that window; its chip events go to the host's between-turns door
        // (UA12.101), and so do the ones a refresh parked while this turn ran.
        this.releaseParkedTerminalEventsThenRefresh();
        // R18 · the obligation dies with the turn, and this is its ONLY clear —
        // {@link withStructuredOutput} deliberately does not consume it, so that
        // a turn reporting two completions reports the same result on both.
        this.turnStructuredOutput = null;
        // The turn's stream is gone, so a steer still outstanding has nowhere to
        // report. Detach it here too: the consumer can end this generator early
        // (`SessionManager` calls `chatIterator.return?.()` on `complete`), and
        // that is a turn boundary no notification announces.
        this.detachTurnSteers();
      }
    }
  }

  async fuzzyFileSearch(query: string): Promise<FuzzyFileSearchResponse | null> {
    await this.ensureRuntime();
    const response = (await this.client!.request('fuzzyFileSearch', {
      query,
      roots: [this.workingDirectory],
      cancellationToken: null,
    })) as Partial<FuzzyFileSearchResponse> | null;

    if (!response) return null;
    return { files: Array.isArray(response?.files) ? response.files : [] };
  }

  /**
   * P3.3 · STOP A BACKGROUND TERMINAL — the codex arm of the interface method
   * `SessionManager.stopAgentTask` calls first (`AgentInstance.stopBackgroundTask`).
   *
   * The three return states are the contract's (see `backend/types.ts`):
   *   - `{ stopped: true }` — the app-server terminated the terminal.
   *   - `{ stopped: false }` (no error) — "not mine, fall through": either the id
   *     is not a terminal we announced, or the method is unavailable/failed. We
   *     collapse the drift/failure case into this arm deliberately: a
   *     codex-internal error must not become the user-facing text, and a fresh
   *     poll at the next turn boundary already reconciles a terminal that did in
   *     fact end.
   *
   * PROTOCOL-DRIFT SEATBELT: `thread/backgroundTerminals/terminate` is probed and
   * any rejection degrades silently with a debug line — never a throw.
   *
   * NOTE (P6.111, re-measured 2026-09-06): this paragraph used to end "wiring the
   * shell chip's Stop button to it needs a codex fallback in `killShell`", and
   * that obligation is DONE — the sentence outlived the work by describing an
   * older `SessionManager`. `killShell` now routes a non-Pi handle here itself
   * (`if (!isPiProcessHandle(shellId) && typeof backend?.stopBackgroundTask ===
   * 'function')`), deletes the map entry and emits `shell_killed`, falling
   * through to `piProcessSupervisor.stop` only for a Pi handle. So the chip's
   * Stop button reaches this lever, and so does `stopAgentTask`.
   */
  async stopBackgroundTask(taskId: string): Promise<{ stopped: boolean; error?: string }> {
    // Only claim ids we actually announced — otherwise "not mine".
    if (!this.eventAdapter.isKnownBackgroundTerminal(taskId)) return { stopped: false };
    if (this.backgroundTerminalsUnsupported) return { stopped: false };
    const client = this.client;
    const threadId = this.threadId;
    if (!client || !threadId) return { stopped: false };

    // THE FIELD NAME COMES FROM THE APP-SERVER, NOT FROM US. This used to send
    // `{ threadId, terminalId }` and `terminalId` occurs ZERO times in the
    // shipped binary — every Stop would have been refused. The binary declares
    // `struct ThreadBackgroundTerminalsTerminateParams with 2 elements` but names
    // neither, and no response struct is exposed to read them off, so the only
    // sound source is the `list` entry that introduced this terminal: we echo
    // back the key its id arrived under. The remaining candidates (all strings
    // that DO occur in the binary) are then tried in order, because a rejection
    // is free and a silently unstoppable chip is not.
    const learnedKey = this.eventAdapter.backgroundTerminalIdKey(taskId);
    const keys = [...new Set([...(learnedKey ? [learnedKey] : []), ...CODEX_BACKGROUND_TERMINAL_ID_KEYS])];
    let lastError: unknown;
    for (const key of keys) {
      try {
        const result: unknown = await client.request(
          'thread/backgroundTerminals/terminate',
          { threadId, [key]: taskId },
        );
        // THE ANSWER IS READ, NOT ASSUMED. Live-measured: the binary replies
        // `{"terminated": false}` for a process id it did not kill, and a
        // non-throwing response used to be rounded up to success — which is the
        // exact lie the renderer's Stop button exists not to tell (it drops the
        // row only on a confirmed stop). An absent field keeps the old benefit of
        // the doubt, for a future binary that answers `{}`.
        const terminated = (result as { terminated?: unknown } | null | undefined)?.terminated;
        if (terminated === false) {
          this.debug(`Codex background terminal terminate(${taskId}) answered terminated=false.`);
          return { stopped: false };
        }
        if (key !== learnedKey) {
          this.debug(`Codex background terminal terminate(${taskId}) accepted under param "${key}".`);
        }
        return { stopped: true };
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        // Which refusals are worth another NAME?
        //   - a serde shape error: this key is not the parameter → try the next.
        //   - `invalid digit` / `invalid … process id`: the FIELD was right but
        //     our VALUE is not digit-parseable. Measured, and it is not a shape
        //     error, so the original `break` here made Stop fail silently for an
        //     entry whose id came from a non-numeric key while a numeric
        //     `processId` sat beside it. Another candidate may carry the numeric
        //     one, so keep walking. (The normaliser now prefers the numeric key
        //     up front; this is the belt to that braces.)
        // Anything else (no such terminal, no such method) cannot be helped by a
        // different parameter name.
        const worthAnotherKey = /unknown field|missing field|invalid type|invalid length/i.test(message)
          || /invalid digit|invalid background terminal process id/i.test(message);
        if (!worthAnotherKey) break;
      }
    }
    this.debug(
      `Codex background terminal terminate(${taskId}) failed: `
      + `${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
    return { stopped: false };
  }

  /**
   * C4.28 (QM7, owner answer C, 2026-09-11) — `/quota` on codex, answered with
   * the MEASUREMENT rather than built on an assumption.
   *
   * ## The owner's option C was a measurement first, and the measurement says no
   *
   * codex publishes the usage window natively on three RPCs and one
   * notification — `account/rateLimits/read`, `account/usage/read`,
   * `account/rateLimitResetCredit/consume` and `account/rateLimits/updated`
   * carrying `RateLimitWindow { usedPercent, windowDurationMins, resetsAt }`
   * (`packages/codex-protocol/generated/ClientRequest.ts`, `.../v2/RateLimitWindow.ts`)
   * — and the host seam that would show it already exists
   * (`BaseAgent.describeQuota`). The one unknown was whether the window is
   * POPULATED behind our loopback adapter, and option C made that the gate:
   * build the codex arm only if the reading supports it.
   *
   * **Measured 2026-09-11 on the shipped `codex-app-server 0.150.1`
   * (darwin-arm64), a `CODEX_HOME` this fork's own `buildCodexConfigToml` wrote,
   * `initialize` + `initialized`, no turn, behind a refusing loopback proxy sink
   * so nothing could leave the machine:**
   *
   * | request | answer |
   * | --- | --- |
   * | `account/rateLimits/read` | `-32600 "codex account authentication required to read rate limits"` |
   * | `account/usage/read` | `-32600 "codex account authentication required to read token usage"` |
   * | `account/read` | `{ account: null, requiresOpenaiAuth: false }` |
   * | `getAuthStatus` | `{ authMethod: null, authToken: null, requiresOpenaiAuth: false }` |
   *
   * No `account/rateLimits/updated` notification arrived in the same boot
   * (`remoteControl/status/changed` was the only one, which is the control that
   * the notification channel was live), and the proxy sink recorded **zero**
   * attempts — so the refusal is local and structural, not a network failure.
   *
   * ## Why that cannot be configured away
   *
   * The refused thing is a codex ACCOUNT, i.e. a ChatGPT login. A session of
   * this fork authenticates against our own loopback Responses adapter with a
   * synthetic key under `[model_providers.nessy_gateway]`, and
   * `writeCodexConfig` writes no `auth.json` into the per-session `CODEX_HOME`
   * at all. There is no configuration under which these methods answer, and a
   * host that called them anyway would have to render an error as a budget.
   *
   * ## So the cell closes with a NULL, out loud
   *
   * This override exists to say the sentence rather than to read a number: the
   * base answer (*"Quota is not available on this runtime"*) is true and says
   * nothing about a native surface that exists, was asked, and refused — which
   * is exactly the shape that sends the next reader to build it. The gateway
   * budget a user actually spends is the host's, and it is the Pi path's
   * `describeNestorQuota`; the codex arm is not it and will not become it.
   *
   * ## F1.6 (origin D1.77) — the gateway card READS that budget now
   *
   * OWNER 2026-09-18 ~16:40, item 3, build (b): a non-BYO (gateway) codex card
   * uses the llm-proxy quota. `codex-gateway` carries the Pi card's base URL, dp
   * prefill and per-user limiter, so on it this override answers with the SAME
   * host-side read the Pi card makes — {@link NessyGatewayQuotaRead}, off
   * `describeNestorQuota` — and says nothing about codex's own account family,
   * which that card never uses. DA1.17's pointer sentence ("run /quota on a Pi
   * session") is gone with it. The menu offers the row on the same predicate
   * (`backend/composer-capabilities.ts` symbol `offersNestorQuota`). A BYO codex
   * connection has no Nessy budget, and the gateway read is never made for it.
   *
   * ## F1.7 (origin D1.77) — codex's OWN windows, when codex names an account
   *
   * Build (b)'s subscription half: a session codex has signed in to a ChatGPT
   * account reads that subscription's windows through codex's native
   * `account/rateLimits/read` and `account/rateLimits/updated`
   * (`backend/codex/rate-limit-windows.ts`). The C4.28 verdict above is KEPT as
   * behaviour: `account/read` is asked first — it answers without an account —
   * and the window read is sent only when codex names a `chatgpt` account, so a
   * call that cannot succeed is never made and no error renders as a budget.
   * Asked of the LIVE app-server only: `/quota` answers at the `BaseAgent.chat`
   * seam and must not spawn a runtime; with none running, the last windows codex
   * PUSHED are shown, marked as such, and otherwise the null stands.
   *
   * **F1.202 (2026-09-24) closed the residue this paragraph used to state.** The
   * ChatGPT (Codex) card (`chatgpt-codex`, behind the `chatgpt` provider flag)
   * signs codex in with `account/login/start` `chatgptAuthTokens` at runtime
   * start ({@link signInCodexChatGptSubscription}), so on that card the account
   * read names a `chatgpt` account and the windows branch runs. Every other
   * codex card still authenticates against the loopback adapter, where the
   * null below stands; the live reading of the windows is F1.8's sitting.
   */
  protected override async *describeQuota(): AsyncGenerator<AgentEvent> {
    // F1.6 — on the gateway card the answer is the gateway budget, read by the
    // host exactly as the Pi card reads it; the codex-native null below is the
    // answer everywhere else (a BYO connection has no Nessy budget to read).
    //
    // The discriminator is the CONNECTION's `baseUrl` through
    // `isNessyGatewayBaseUrl` — the WHOLE-URL rule, and the same value
    // `offersNestorQuota` reads when it decides whether the menu offers the row,
    // so the menu and this answer cannot disagree.
    //
    // DA1.44, corrected 2026-09-17: it used to be `isNestorCliBaseUrl`, a
    // `startsWith` over `…/api/v1/cli/`, which told a BYO connection on any
    // other CLI-prefix path of the gateway host that it spends the Nessy Gateway
    // budget. DA1.44 moved it to `isNestorGatewayCredentialUrl`, which is the
    // REQUEST-url rule and accepts everything under the chat base too, so a BYO
    // card at a chat-base subpath kept being told the same false thing. The
    // whole-URL rule is what gates the dp JWT on a CONNECTION, so the budget
    // claim and the credential can no longer disagree.
    const slug = this.config.connectionSlug;
    const connection = slug ? getLlmConnection(slug) : null;
    if (isNessyGatewayBaseUrl(connection?.baseUrl)) {
      const { fetchImpl, credsPath } = this.quotaTransport();
      yield* this.nessyGatewayQuota.describe({
        fetchImpl,
        ...(credsPath ? { credsPath } : {}),
        baseUrl: connection?.baseUrl,
      });
      return;
    }
    // F1.7 — codex's own windows, when codex names a ChatGPT account (docblock).
    const client = this.client;
    let unreadable: string | null = null;
    if (client) {
      const read = await readCodexAccountWindows(client);
      if (read.kind === 'windows') {
        this.codexAccountWindows = read.windows;
        yield { type: 'info', message: formatCodexAccountWindows(read.windows) };
        return;
      }
      if (read.kind === 'unreadable') unreadable = read.reason.replace(/\s+/g, ' ').trim().slice(0, 200);
    } else if (this.codexAccountWindows) {
      yield {
        type: 'info',
        message: `${formatCodexAccountWindows(this.codexAccountWindows)}\n`
          + '(As last pushed by codex — the codex runtime is not running now, so nothing was re-read.)',
      };
      return;
    }
    // F1.6 — this sentence reaches only a NON-gateway session, so it no longer
    // names the Nessy Gateway: such a session talks, through the same local
    // adapter, to the endpoint its own connection names.
    const codexNativeNull =
      'Quota is not available on this runtime. Codex publishes its own usage windows '
      + '(account/rateLimits/read and the account/rateLimits/updated notification) only for a '
      + 'session signed in to a Codex ACCOUNT — a ChatGPT login — and this session is not: it '
      + 'authenticates through a local adapter against the endpoint its connection names, or its '
      + 'ChatGPT (Codex) sign-in did not complete. Measured on the shipped app-server: '
      + 'without one, the window read answers "codex account authentication required".';
    yield {
      type: 'info',
      message: unreadable ? `${codexNativeNull} (Codex did not answer the account read: ${unreadable}.)` : codexNativeNull,
    };
  }

  /**
   * F1.7 — the last windows codex reported for this session: set by a foreground
   * `/quota` read, merged by every `account/rateLimits/updated` (sparse, per the
   * notification's own contract). Only a session codex has signed in to an
   * account ever receives one, so on every card this app has today it stays null.
   */
  private codexAccountWindows: CodexAccountWindows | null = null;

  /** F1.7 — `handleNotification`'s one-line arm for `account/rateLimits/updated`. */
  private noteCodexRateLimitUpdate(params: unknown): void {
    this.codexAccountWindows = mergeCodexRateLimitUpdate(this.codexAccountWindows, params);
  }

  /**
   * F1.6 — the gateway-budget read `describeQuota` makes on the gateway card,
   * with the in-flight read's Stop. Aborted from `abort`, `forceAbort` and
   * `destroy`, as `PiAgent` aborts its own.
   */
  private readonly nessyGatewayQuota = new NessyGatewayQuotaRead();

  /**
   * The quota read's transport and credential source — the seam that keeps the
   * quota tests off the live gateway and out of `~/.nessy/dp_auth_creds.json`
   * (the same seam `PiAgent` and `NestorCloudAgent` expose).
   */
  protected quotaTransport(): { fetchImpl: typeof fetch; credsPath?: string } {
    return { fetchImpl: fetch };
  }

  /**
   * P6.793 — codex CANNOT move a blocking tool call into the background, and
   * this method exists to SAY so.
   *
   * Native-first, asked and answered: the app-server has no lever of this shape.
   * `grep -ril background packages/codex-protocol/generated` returns ONE file
   * (`ImageGenerationItem.ts`) against 562 generated v2 types — re-measured at
   * HEAD, the same control P6.308 took. The `thread/backgroundTerminals/*` pair
   * this class does drive is not it and must not be mistaken for it: those act
   * on terminals codex itself already started in the background, listing and
   * terminating them. There is no request that takes a running foreground call
   * and lets the turn continue without it.
   *
   * IMPLEMENTED RATHER THAN OMITTED, which is the entire point of the arm. The
   * interface declares this optional and an omitting backend is one with no
   * lever — but from the caller's side an absent method and a refusing one look
   * identical, and only the refusing one can carry a reason. Leaving it off
   * would produce the silent block this row exists to remove: a press that
   * appears accepted and changes nothing.
   *
   * `unsupported` rather than an `error` string, because the two are different
   * facts with different sentences: "this runtime has no such lever" is not "the
   * lever went wrong", and rounding the first into the second would tell a codex
   * user their press failed when nothing failed.
   */
  async backgroundInFlightTasks(_toolUseId?: string): Promise<{ backgrounded: false; unsupported: true }> {
    this.debug('Codex has no lever to background an in-flight foreground tool call; refusing by name.');
    return { backgrounded: false, unsupported: true };
  }

  /**
   * C4.13 (QH1, owner answer B, 2026-09-11) — start codex's OWN detached review.
   *
   * The generic lever above genuinely does not exist, and this is the one that
   * does: `review/start` with `delivery: "detached"` puts the review on a thread
   * of its own, which is exactly what `code-review.md#review-a-diff-locally`
   * promises (*"runs as a background subagent with its own context window, so it
   * doesn't fill your conversation"*) and what Pi and claude already do. The
   * target, the diff and the rubric are all the HOST's — see
   * `backend/codex/detached-review.ts` for why `custom` is the member and why
   * the three native ones are declined.
   *
   * ## The subscription, and why it is a map rather than a flag
   *
   * A detached review runs on a NEW thread id, and every thread-scoped
   * notification names its thread — so `handleNotification`'s foreign-thread
   * guard would drop the whole review. {@link detachedReviewThreads} is what
   * re-admits exactly those threads, keyed by the review thread id and holding
   * the target description, because the findings sentence has to name what was
   * reviewed and the parent turn is long over by then. Entries are removed on
   * `turn/completed`, so a review reports once.
   *
   * ## DEGRADES, never throws onto the user's review
   *
   * Every failure returns `null` and the caller falls back to the inline
   * delegation this build has always done: an app-server with no `review/start`
   * (an older codex), a refusal, a response without `reviewThreadId`, a session
   * with no open thread. A background review that could not start must not cost
   * the user the review.
   */
  private async startDetachedReview(input: CodexDetachedReviewInput): Promise<string | null> {
    const client = this.client;
    const threadId = this.threadId;
    if (!client || !threadId || this.destroyed) {
      this.debug('[review] no open codex thread, so the background review falls back to inline delegation.');
      return null;
    }
    try {
      const response = await client.request(
        'review/start',
        buildCodexDetachedReviewParams(threadId, input),
      ) as { reviewThreadId?: unknown };
      const reviewThreadId = typeof response?.reviewThreadId === 'string' ? response.reviewThreadId : '';
      // codex's OWN answer, not our request echoed back. An inline delivery
      // returns the ORIGINAL thread id here (the field's own docblock says so),
      // and that is not a background review — it is the review we already had,
      // running where it always ran, so it must fall back rather than claim the
      // capability.
      if (!reviewThreadId || reviewThreadId === threadId) {
        this.debug(
          `[review] codex accepted review/start but delivered it on ${reviewThreadId || 'no'} thread; `
          + 'treating it as inline and falling back.',
        );
        return null;
      }
      this.detachedReviewThreads.set(reviewThreadId, input.target);
      return describeCodexDetachedReviewStart(input.target);
    } catch (error) {
      this.debug(
        '[review] codex refused review/start, so this review runs inline: '
        + `${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * C4.13 · the read-back half — a detached review thread reporting in.
   *
   * Returns `true` when the notification belonged to a review this session
   * started, which is what keeps `handleNotification`'s foreign-thread guard
   * from dropping it. The findings ride
   * {@link CodexAgent.surfaceCodexOperatorNotice}, which pushes them onto the
   * live turn when there is one and HOLDS them for the next turn otherwise —
   * the second case being the ordinary one, since the point of a background
   * review is that the user went on working.
   */
  private admitDetachedReviewNotification(method: string, params: unknown): boolean {
    const record = (params ?? {}) as Record<string, unknown>;
    const reviewThreadId = typeof record.threadId === 'string' ? record.threadId : '';
    const target = reviewThreadId ? this.detachedReviewThreads.get(reviewThreadId) : undefined;
    if (target === undefined) return false;
    if (method === 'item/completed') {
      const item = (record.item ?? {}) as { text?: unknown; itemType?: unknown };
      if (typeof item.text === 'string' && item.text.trim()) {
        this.detachedReviewFindings.set(reviewThreadId, item.text);
      }
      return true;
    }
    if (method !== 'turn/completed') return true;
    this.detachedReviewThreads.delete(reviewThreadId);
    const findings = this.detachedReviewFindings.get(reviewThreadId) ?? '';
    this.detachedReviewFindings.delete(reviewThreadId);
    this.surfaceCodexOperatorNotice(describeCodexDetachedReviewFindings(target, findings));
    return true;
  }

  // ============================================================
  // Abort / lifecycle abstracts
  // ============================================================

  /**
   * P3.2 · `/approve` — the user overrules a guardian auto-review DENIAL.
   *
   * Two halves, and only the first is fully ours: resetting the local surfacing
   * breaker (`eventAdapter.notifyGuardianOverride()`) is unconditional and its
   * notice is pushed to the turn sink regardless of the codex round-trip — the
   * human overrode, so surfacing must resume this turn. The second half relays
   * the override to the app-server via `thread/approveGuardianDeniedAction`
   * (`{threadId, event}`, `event` a serialized `GuardianAssessmentEvent`) using
   * the `event` passed by the caller, or the last denial we captured. That method
   * is [UNSTABLE], so it is PROBED and DEGRADES with a debug line on any refusal
   * — never thrown onto a user action (fire-and-forget, like {@link redirect}).
   *
   * P3.25 registered the `/approve` slash command and dispatched it at the
   * `BaseAgent.chat` seam; {@link approveGuardianDenial} is that arm's codex
   * override and shares the relay below. This method stays for a MID-TURN
   * caller, which is the only position where `turnSink` is set. Still owed at
   * P5.4 (live smoke): whether the captured notification is the exact
   * `GuardianAssessmentEvent` codex accepts is a live-binary question.
   */
  approveGuardianDeniedAction(event?: unknown): void {
    for (const e of this.eventAdapter.notifyGuardianOverride()) this.turnSink?.push(e);
    this.relayGuardianOverride(event);
  }

  /**
   * P3.25 — the `/approve` arm, entered from `BaseAgent.chat` BEFORE `chatImpl`.
   *
   * IT YIELDS THE LOCAL HALF INSTEAD OF PUSHING IT, and that is the whole reason
   * this exists beside {@link approveGuardianDeniedAction}: `turnSink` is set by
   * `chatImpl`, which the seam never enters, so the sibling's
   * `this.turnSink?.push(...)` would silently drop the one notice that tells the
   * user the breaker was reset — the command would look like it did nothing.
   * The relay half is identical and shared, because it depends on the client and
   * the thread rather than on the turn.
   */
  protected override async *approveGuardianDenial(): AsyncGenerator<AgentEvent> {
    for (const event of this.eventAdapter.notifyGuardianOverride()) yield event;
    this.relayGuardianOverride();
  }

  /**
   * The app-server half of `/approve`: `thread/approveGuardianDeniedAction`
   * (`{threadId, event}`) replayed best-effort. [UNSTABLE] on the wire, so it is
   * PROBED and DEGRADES with a debug line on any refusal — never thrown onto a
   * user action (fire-and-forget, like {@link redirect}). The local breaker has
   * already been reset by the caller either way: the human overrode.
   */
  private relayGuardianOverride(event?: unknown): void {
    const client = this.client;
    const threadId = this.threadId;
    const replay = event ?? this.lastGuardianDeniedEvent;
    if (!client || !threadId || replay === undefined) {
      this.debug(
        `Codex /approve: reset the local auto-review breaker; nothing relayed to the app-server `
        + `(client=${client ? 'up' : 'none'}, thread=${threadId ?? 'none'}, denial=${replay === undefined ? 'none' : 'captured'})`,
      );
      return;
    }
    // P2.407 · name WHAT is being overridden. `/approve` re-approves a specific
    // denied action, and until `action` was read this line could only say that
    // something had been relayed — the least useful sentence in a permission
    // audit trail, and the one most likely to be read after the fact.
    const overridden = describeGuardianReviewAction((replay as { action?: unknown } | null)?.action);
    void client.request('thread/approveGuardianDeniedAction', { threadId, event: replay })
      .then(() => this.debug(
        `Codex /approve: relayed guardian override to the app-server${overridden ? ` for: ${overridden}` : ''}`,
      ))
      .catch((error: unknown) => this.debug(
        `Codex /approve: app-server refused thread/approveGuardianDeniedAction `
        + `(${error instanceof Error ? error.message : String(error)}); the local breaker was already reset`,
      ));
  }

  /**
   * Steer the in-flight turn with codex's OWN mechanism — `turn/steer` — rather
   * than interrupting the turn and replaying the message as a new one.
   *
   * WHAT THE USER GETS: a correction typed a minute into a wrong refactor
   * reaches the model at the running turn's next boundary, instead of after the
   * remaining two minutes of the wrong refactor. This is the divergence L8
   * measured on the Claude side of the same product, in the Codex half.
   *
   * SYNCHRONOUS RETURN OVER AN ASYNCHRONOUS REQUEST — the decision, and its
   * price. `redirect` is `boolean` on the frozen `AgentInstance` contract
   * (`backend/types.ts:1069`) and `SessionManager.sendMessage` branches on the
   * value in the same tick, while `turn/steer` is a JSON-RPC request. So the
   * `true` here is a claim about the PRECONDITION, not a receipt from the
   * server: a live client, this thread, and an active turn id the server itself
   * announced. Everything else the server can object to is reported LATE, as
   * `steer_undelivered` on the turn's own sink, which
   * `SessionManager.processEvent`'s `steer_undelivered` case re-queues for the
   * next turn — the same channel ClaudeAgent's emulated steer already uses, and
   * the reason
   * {@link finishTurnSinkAfterPendingSteers} holds the sink open. The
   * alternative — an optimistic `true` with no late channel — is how a refused
   * steer LOSES the user's message, and this plan has already shipped that
   * class of defect twice.
   *
   * `false` MEANS "the session layer must queue and re-send" (that contract is
   * written on `AgentInstance.redirect`), and it is reached here WITHOUT a
   * `forceAbort`. `BaseAgent.redirect`'s default fires
   * `forceAbort(AbortReason.Redirect)` because a backend that cannot steer must
   * stop the turn it is about to talk over; there is no such turn on this
   * branch, and interrupting codex's thread for a message that is simply going
   * to be the next turn would throw away work for nothing. `ClaudeAgent.redirect`
   * DOES abort in its equivalent branch — its steer is an emulation whose parked
   * text must not outlive the turn that was supposed to carry it — while
   * `NestorCloudAgent.redirect`, which likewise has nothing in flight to abort,
   * returns a bare `false`. This follows Nestor's shape.
   *
   * THE DOCUMENTED REFUSAL takes the late channel rather than a local guess.
   * `CodexErrorInfo` names `{ activeTurnNotSteerable: { turnKind } }` with
   * `NonSteerableTurnKind = "review" | "compact"`, and the shipped app-server
   * carries the matching messages ("cannot steer a review turn", "cannot steer a
   * compact turn", "no active turn to steer"). That refusal is NOT locally
   * predictable: codex compacts on its own budget
   * (`model_auto_compact_token_limit`), so a compact turn can be the active turn
   * without this client having asked for one. And `CodexErrorInfo` reaches us as
   * nothing more than a string: it rides the JSON-RPC error's untyped `data`
   * (`schema/JSONRPCErrorError.json` declares `data: true`), and
   * `AppServerClient.handleLine` rejects with `new Error(err.message)` —
   * DISCARDING `data`. So every refusal is treated the same way, by rejection
   * rather than by discrimination, and every one ends up queued.
   */
  override redirect(message: string, metadata?: RedirectMetadata): boolean {
    const client = this.client;
    const threadId = this.threadId;
    const expectedTurnId = this.activeTurnId;
    const sink = this.turnSink;
    // `!sink` is load-bearing, not defensive padding: the `true` this method can
    // return is a PROMISE to report a refusal, and the only channel for that
    // report is the turn's own sink. With no sink there is nothing to report on,
    // so the rejection handler below would throw inside a floating promise and
    // the user's message would be lost while the composer said "accepted".
    // `activeTurnId` alone does not imply a sink: it is written from
    // `turn/started`, which also fires for a turn this client is not draining
    // (a server-side compaction turn, a resumed thread), and `chatImpl`'s
    // `finally` nulls the sink independently of any notification.
    if (!client || !threadId || !expectedTurnId || !sink) {
      this.debug(`Codex steer declined — no active turn to steer (turnId=${expectedTurnId ?? 'none'}, sink=${sink ? 'open' : 'none'})`);
      return false;
    }

    this.debug(`Codex steering turn ${expectedTurnId}: "${message.slice(0, 100)}"`);
    const steer = client.request('turn/steer', {
      threadId,
      expectedTurnId,
      input: [{ type: 'text', text: message, text_elements: [] }],
    });
    // THIS turn's set, captured — see {@link turnSteers}. The `.finally` below
    // deletes from the captured instance, so a set detached by a turn boundary
    // drains itself instead of reaching into the live turn's.
    const steers = this.turnSteers;
    steers.add(steer);
    void steer
      .then(
        (response: unknown) => {
          // F1.896 — an ACCEPTED steer is silent here by design (the refusal
          // handler below is the only reporter), which is exactly the hole a
          // user Stop falls through: codex applies the input at its own next
          // sampling boundary, the abort can land first, and the host has
          // already shown a monitor's tick as delivered. Recorded so
          // {@link CodexAgent.forceAbort} can report what the Stop really took.
          if (metadata?.origin === 'monitor') {
            this.turnMonitorSteers.push({ message, ...(metadata.messageId === undefined ? {} : { messageId: metadata.messageId }) });
          }
          // OBSERVABILITY, not control flow — and the one thing about `turn/steer`
          // the generated bindings do not settle. `TurnSteerResponse` is
          // `{ turnId }`, and whether that is an ECHO of the steered turn or the
          // id of a NEW one decides whether the running turn's accounting still
          // holds: a new turn would complete the old one, closing the sink this
          // `chatImpl` is draining. `expectedTurnId`'s "active turn" wording and
          // the review/compact refusal both read as "the active turn continues",
          // so this logs the disagreement rather than acting on it — the live
          // sitting reads this line first.
          const turnId = (response as { turnId?: unknown } | null | undefined)?.turnId;
          if (typeof turnId === 'string' && turnId !== expectedTurnId) {
            this.debug(`Codex steer answered with a DIFFERENT turn id (asked ${expectedTurnId}, got ${turnId}) — turn accounting assumes the steered turn continues`);
          }
        },
        (error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error);
          this.debug(`Codex steer refused (${reason}) — re-queuing the message for the next turn`);
          // The late half of the bridge. `steer_undelivered` is the frozen
          // event for exactly this ("re-queue it so it's sent as a normal
          // message on the next turn", `SessionManager.processEvent`), and
          // it is pushed on the sink captured above rather than on
          // `this.turnSink`, which a later turn may already own.
          // F1.330 — and it names THAT message: the transcript id the host gave
          // `redirect()` (and a plugin monitor's origin, F1.343), as Claude's
          // hand-back does. Text alone let two identical-text steers — the first
          // delivered, the second refused — re-queue the wrong one.
          sink.push({
            type: 'steer_undelivered',
            message,
            ...(metadata?.messageId === undefined ? {} : { messageId: metadata.messageId }),
            ...(metadata?.origin === undefined ? {} : { origin: metadata.origin }),
          });
        },
      )
      .finally(() => {
        steers.delete(steer);
      });
    return true;
  }

  /**
   * UB6.13 — `AgentBackend.canSteerNow`, the native-first answer: whether {@link redirect}
   * would SEND `turn/steer` now (an active turn this client is draining). Whether the input
   * lands is codex's own call — it accepts or refuses natively, and a refusal comes back as
   * `steer_undelivered` on that turn's sink, which re-queues the message. No upstream
   * counterpart (upstream has no codex backend).
   */
  canSteerNow(): boolean {
    return !!this.client && !!this.threadId && !!this.activeTurnId && !!this.turnSink;
  }

  /**
   * NO — a `false` from {@link redirect} on this backend interrupted nothing.
   *
   * `SessionManager`'s mid-stream branch sets `wasInterrupted` after a failed
   * steer, which makes the NEXT turn open by telling the model its previous
   * reply was cut off. That is true for the backends whose `redirect()` fallback
   * fires `forceAbort(AbortReason.Redirect)` — `BaseAgent`'s default, and
   * therefore Pi's and Claude's — and it is FALSE here: this backend's `false`
   * means "there was no turn to steer", the running turn (if any) is untouched,
   * and the message is simply the next turn. Read through
   * `backendInterruptsOnFailedSteer` in
   * `server-core/src/sessions/mid-stream-interruption.ts`, which is where the
   * whole decision lives.
   *
   * Declared here rather than on `AgentBackend` only because of this change's
   * file zone; promoting it to an optional member of that interface (and
   * overriding it on `NestorCloudAgent`, whose `redirect` also returns a bare
   * `false`) is the follow-up, and the reader of the predicate says so too.
   */
  redirectFallbackInterruptsTurn(): boolean {
    return false;
  }

  /**
   * INTERRUPTING A CODEX TURN NEEDS BOTH IDS, AND FOR AS LONG AS THIS FILE HAS
   * EXISTED IT SENT ONE.
   *
   * `TurnInterruptParams` is `{ threadId, turnId }` with BOTH `required` — in the
   * bindings (`codex-protocol/generated/v2/TurnInterruptParams.ts`), in the
   * schema (`codex_app_server_protocol.v2.schemas.json`) and in the shipped
   * binary (`struct TurnInterruptParams with 2 elements`). Measured against the
   * bundled `codex-app-server` (rust-v0.147.0, sha256 b1a7e99d…) rather than
   * argued:
   *
   *   - `{"id":2,"method":"turn/interrupt","params":{"threadId":…}}` →
   *     `{"error":{"code":-32600,"message":"Invalid request: missing field \`turnId\`"}}`
   *     — the shape this method used to send, rejected, and the rejection was
   *     swallowed by the `catch` below as "turn may already be done".
   *   - `{"method":"turn/interrupt","params":{"threadId":…}}` as a NOTIFICATION —
   *     the shape `forceAbort` used to send on every user Stop — produced NO
   *     response at all. `turn/interrupt` is a member of `ClientRequest`, and
   *     `ClientNotification` is `{ "method": "initialized" }` and nothing else,
   *     so the server never dispatched it. A user pressing Stop on a Codex
   *     session was interrupting nothing.
   *   - with both fields present the same request reaches thread-id validation
   *     (`"invalid thread id: …"` for a non-UUID) — the positive control that
   *     the two-field shape is the one the server actually processes.
   *
   * So both paths now send a REQUEST carrying the id captured from
   * `turn/started`, and neither sends anything when there is no active turn: an
   * interrupt with no `turnId` is refused by definition, so skipping it loses
   * nothing and stops manufacturing an error the user did not cause.
   *
   * AND THE BINDINGS ARE BEHIND THE BINARY, so "the generated type says so" is
   * weaker than it looks. The same binary reports `struct TurnSteerParams with 6
   * elements` against the binding's 4 fields and `struct TurnStartParams with 20
   * elements` against 13, naming fields no pinned type carries (`_meta`,
   * `responses`, `apiClientMetadata`, `permissions`, `collaborationMode`,
   * `multiAgentMode`, `environments`). `packages/codex-protocol/generated` is
   * therefore NOT a complete description of what the app-server accepts — check
   * a params shape against `strings -a` on the bundled binary before concluding
   * a field does not exist.
   */
  async abort(_reason?: string): Promise<void> {
    this.aborted = true;
    this.runTeardownStep('codex abort quota', () => this.nessyGatewayQuota.abort());
    // Settle pending approvals so the app-server is never left blocked on a
    // dead request (mirrors PiAgent.abort). Cancel the turn but keep the process.
    //
    // P2.360 — step-isolated, and this call is why. `denyPendingApprovals` ends
    // in `elicitationAsk.cancelAll`, i.e. in FOREIGN resolvers on a shared pool;
    // a throw there used to skip the interrupt below, and the interrupt is the
    // only thing that stops the codex turn. The user's Stop would then have
    // settled nothing at all.
    this.runTeardownStep('codex abort pending approvals', () => this.denyPendingApprovals());
    // Read before the clear below: the id IS the interrupt's precondition, so a
    // path that cleared it first would send an interrupt that cannot be served.
    const turnId = this.activeTurnId;
    if (this.client && this.threadId && turnId) {
      try {
        await this.client.request('turn/interrupt', { threadId: this.threadId, turnId });
      } catch {
        /* turn may already be done */
      }
    } else if (this.client && this.threadId) {
      // `debug` is UNBELTED on this class — `pi-agent.ts` holds the tree's only
      // `override debug` — so a host `onDebug` that throws reaches this line and
      // takes the rest of the method with it. That is the realistic thrower here.
      this.runTeardownStep('codex abort interrupt notice', () =>
        this.debug('Codex abort — no active turn id, so nothing to interrupt'));
    }
    // An interrupted turn is a turn that ended: drop the steer precondition
    // with it, or the next `redirect()` aims at a turn nobody is running.
    this.activeTurnId = null;
    this.runTeardownStep('codex abort turn steer detach', () => this.detachTurnSteers());
    this.runTeardownStep('codex abort turn sink', () => this.turnSink?.finish());
    await this.emitStopHookOnce();
  }

  /**
   * A user Stop. Same interrupt contract as {@link abort} — read its doc.
   *
   * P2.360 — step-isolated, and of the four abort entry points on this backend
   * and Nestor this is the one where it changes the most. It is SYNCHRONOUS and
   * `SessionManager.cancelProcessing` calls it by name on every user Stop, so a
   * throwing step genuinely took the caller down — on the path that runs far
   * more often than any restart. The two steps after the interrupt are the ones
   * a failure used to cancel: `turnSink.finish()` is what ends the turn for the
   * UI, and the Stop hook below it never fired at all.
   *
   * `runTeardownStep` despite the name: `shared/AGENTS.md` separates a turn
   * abort from a disposal BY NAME, and that separation is about what the path
   * DOES. This borrows only the enforcement primitive — "one step's failure
   * cannot cancel the next", reported through the sink-belted
   * `reportDetachedFault` — and a second identically bodied helper under an
   * abort-shaped name would be two names for one mechanism.
   */
  forceAbort(_reason: AbortReason): void {
    this.aborted = true;
    this.runTeardownStep('codex stop quota abort', () => this.nessyGatewayQuota.abort());
    this.runTeardownStep('codex stop pending approvals', () => this.denyPendingApprovals());
    const turnId = this.activeTurnId;
    // Captured into locals rather than read through `this` inside the callback:
    // TypeScript discards a narrowing of a mutable property once it crosses into
    // a nested function, so the `if` below would not survive the arrow.
    const client = this.client;
    const threadId = this.threadId;
    if (client && threadId && turnId) {
      // A REQUEST, not a notification: measured, the notification was dropped
      // undispatched, so every Stop before this interrupted nothing. Nothing
      // awaits the answer — the sink is finished below either way — but a
      // rejection must not surface as an unhandled promise.
      this.runTeardownStep('codex stop turn interrupt', () => {
        void client.request('turn/interrupt', { threadId, turnId })
          .catch(() => { /* turn may already be done */ });
      });
      // F1.896 — what the Stop really took from the model: every monitor steer
      // this turn had ACCEPTED but (per the SIT-ab measurement) codex never
      // sampled before the interrupt. Reported on the sink while it is still
      // open — `steer_undelivered` is the frozen event, and the host's monitor
      // requeue (F1.343) hands each tick to the user's next send (F1.530's
      // hold). The record is consumed here, so a second Stop reports nothing,
      // and a steer whose request never answered is NOT reported twice: it is
      // not in this record until it resolves, and its own rejection handler
      // reports it. A user's own steer stays silent — replaying a person's
      // correction could repeat an instruction the model already acted on.
      this.runTeardownStep('codex stop undelivered monitor steers', () => {
        if (!this.turnSink) return;
        for (const steer of this.turnMonitorSteers.splice(0)) {
          this.turnSink.push({
            type: 'steer_undelivered',
            message: steer.message,
            ...(steer.messageId === undefined ? {} : { messageId: steer.messageId }),
            origin: 'monitor' as const,
          });
        }
      });
    } else if (client && threadId) {
      this.runTeardownStep('codex stop interrupt notice', () =>
        this.debug('Codex forceAbort — no active turn id, so nothing to interrupt'));
    }
    this.activeTurnId = null;
    this.runTeardownStep('codex stop turn steer detach', () => this.detachTurnSteers());
    this.runTeardownStep('codex stop turn sink', () => this.turnSink?.finish());
    // P2.303 · the sibling the guard eight lines above missed. `abort()` AWAITS
    // this same call; `forceAbort` is sync and cannot, so the rejection needs a
    // handler here for exactly the reason stated up there — a rejection must not
    // surface as an unhandled promise. `emitStopHookOnce` MEMOISES the promise it
    // returns, so an unhandled rejection here is also stored and re-thrown at
    // every later consumer of `stopHookForTurn` (`endLifecycle` awaits it).
    void this.emitStopHookOnce()
      .catch((error: unknown) => this.reportDetachedFault('Automation event Stop', error));
  }

  /**
   * Settle every pending approval as a teardown, not as a user's refusal.
   *
   * F1.170 — and WITHDRAW each card from the host while doing it. Settling
   * codex's request is only half of it: the host holds its own record of the
   * card (`pendingPermissionRequests`), a DURABLE copy an app restart
   * re-presents (`pendingApproval`), and the card on screen, and the one event
   * that clears all three is `permission_request_cancelled`
   * (`SessionManager.processEvent` → `removePendingPermissionRequest`). Pi and
   * the claude deadline module already produce it; codex produced none, so a
   * Stop, an abort or a runtime restart left a card for a request nobody waits
   * on, whose click answers nothing. Pushed onto the turn sink, which every
   * caller finishes right after this, so the event drains to the host.
   */
  private denyPendingApprovals(): void {
    for (const [requestId, pending] of this.pendingApprovals) {
      pending.resolve(buildAbortResponse(pending.kind, pending.params));
      this.turnSink?.push({ type: 'permission_request_cancelled', requestId });
    }
    this.pendingApprovals.clear();
    // A pool elicitation's dialog is torn down the same way: the MCP server
    // gets a settled `cancel`, never a request left open on a dead surface.
    this.elicitationAsk.cancelAll('The session was interrupted.');
    // P6.344 · same teardown, same reason: a question awaiting an answer nobody
    // will give is a turn that never ends.
    this.modelQuestionAsk.cancelAll('The session was interrupted.');
  }

  isProcessing(): boolean {
    return this.processing;
  }

  /**
   * P6.111 · BACKGROUND WORK THIS SESSION IS HOLDING BETWEEN TURNS.
   *
   * The optional `AgentInstance.backgroundWorkCount()` — `SessionManager` reads
   * it into `backendBackgroundTasks`, which `liveAgentBusyDomains` turns into
   * the `background_task` domain. Until this method existed `CodexAgent`
   * defined none, so the `?? 0` at the call site answered ZERO for every codex
   * session: a session holding a live background terminal was indistinguishable
   * from an empty one, and both the idle reaper and the ceiling's eviction were
   * free to dispose the runtime — which kills the app-server, the terminal and
   * its output.
   *
   * The LEVEL already existed and was simply unread: `knownBackgroundTerminals`
   * is filled from `thread/backgroundTerminals/list` and emptied when a terminal
   * exits or disappears. What did not exist is a way for it to MOVE between
   * turns, and that is the half this row calls the fix — see
   * {@link scheduleBackgroundTerminalRefresh}.
   *
   * The read schedules a refresh only when the count is non-zero, which is the
   * direction that would otherwise LATCH: a terminal that exits after the last
   * turn would hold the session busy forever, since nothing else polls. The
   * zero case is left alone deliberately — it costs nothing and it cannot be
   * stale for long, because the turn-end refresh has already run.
   *
   * UA12.191 (P-LF-5-1) — plus every `spawn_agent` child running a turn that has
   * sent a notification within `CodexEventAdapter.SPAWNED_CHILD_LIVENESS_BOUND_MS`
   * (`freshRunningSpawnedChildCount`). Codex never wakes the parent when a child
   * ends (UA12.99's reading), so a child working between turns is the same kind
   * of work a terminal is: a reap kills the app-server with the child inside it.
   * The bound is what makes counting it safe — an entry whose end never arrives
   * drops out after that much silence instead of keeping the session for good.
   */
  backgroundWorkCount(): number {
    return this.backgroundTerminalWorkCount() + this.eventAdapter.freshRunningSpawnedChildCount();
  }

  /** The background-terminal half of {@link backgroundWorkCount}, refresh kick included (P6.111). */
  private backgroundTerminalWorkCount(): number {
    const count = this.eventAdapter.backgroundTerminalCount;
    if (count > 0) this.scheduleBackgroundTerminalRefresh();
    return count;
  }

  /**
   * In-place runtime refresh (`AgentBackend.updateRuntimeConfig`).
   *
   * Returning `false` is not a failure — it is this backend telling
   * `SessionManager.runAgentRuntimeRefresh` to dispose and recreate. Only a
   * model change is applied here; the new model reaches codex on the next turn
   * through `applySelectedPluginSkillRuntimePolicy`'s fork, which is codex's
   * own supported boundary for a fresh config layer WITH the thread's history
   * intact. Before this existed, every model change on a live codex session
   * took the recreate path and silently started an empty thread.
   *
   * UB12.37 — the model-only branch also adopts `update.miniModel`, the host's
   * re-resolved background-tier id (UB12.11 sends it on every refresh). A
   * gateway catalogue refresh that rotated the id behind `fast` arrives here as
   * a model-only update, and {@link CodexAgent.runMiniCompletion} reads `config.miniModel`
   * at call time, so without this every later title kept asking for the retired
   * id (which the gateway answers with a 404) until a respawn. Absent means
   * unchanged, as on Pi. It is adopted only AFTER the model-only check: a
   * declined update is rebuilt with a freshly resolved mini model anyway.
   * Residue: `[agents] default_subagent_model`
   * ({@link CodexAgent.codexDefaultSubagentModelOption}) is written into `config.toml` at
   * spawn and keeps the build-time id until a respawn; it is projected only for
   * a declared codex model provider, which no shipped surface writes.
   */
  // NOT `override`: `updateRuntimeConfig` is an OPTIONAL member of the
  // `AgentBackend` interface (`backend/types.ts:1134`) and `BaseAgent` does not
  // declare it, so `override` is TS4113 and `typecheck:all` fails. The
  // precedent is `pi-agent.ts:7604`, which declares it with no modifier.
  async updateRuntimeConfig(update: BackendRuntimeUpdate): Promise<boolean> {
    const upstream = getBackendRuntime(this.config).upstream;
    const pinned: CodexPinnedRuntime = {
      providerType: this.config.providerType,
      authType: this.config.authType,
      baseUrl: upstream?.kind === 'openai-compatible' ? upstream.baseUrl : undefined,
    };
    if (!codexUpdateIsModelOnly(update, pinned)) return false;
    this.setModel(update.model);
    if (update.miniModel !== undefined) this.config = { ...this.config, miniModel: update.miniModel }; // UB12.37
    return true;
  }

  /**
   * An Allow the bridge could not honour in full — a decline for an
   * elicitation, a narrower grant for a permissions request. On the wire either
   * is indistinguishable from the silent rejection this bridge exists to fix,
   * so the branch that fired is named in the log rather than swallowed.
   */
  private readonly reportDegradedApproval = (reason: string): void => {
    this.debug(`codex ${reason}`);
  };

  /** Resolve a pending approval with the codex response derived from the UI answer. */
  respondToPermission(
    requestId: string,
    allowed: boolean,
    alwaysAllow?: boolean,
    options?: PermissionResponseOptions,
  ): void {
    // A pool elicitation's dialog is answered here too — it rides the same
    // channel, and its answer arrives in `options.askUserAnswer`.
    if (this.elicitationAsk.respond(requestId, allowed, options?.askUserAnswer)) return;
    // P6.344 · the model's own clarifying question rides a SECOND bridge with
    // its own id prefix, for the reason claude's `modelQuestionAsk` records: a
    // model question filed under `mcp-elicit-…` is a lie the next person
    // debugging this has to unlearn.
    if (this.modelQuestionAsk.respond(requestId, allowed, options?.askUserAnswer)) return;
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return;
    this.pendingApprovals.delete(requestId);
    if (pending.urlToOpen) {
      // Answering means opening a browser, so the answer waits for the opener.
      void this.resolveUrlElicitation(pending.urlToOpen, allowed, pending.params, pending.resolve);
      return;
    }
    // A FLOOR HAS NO DON'T-ASK-AGAIN (P2.140). `nonNegotiable` prompts on the
    // other two runtimes deliberately carry neither `rememberForMinutes` nor
    // `commandHash` — those two fields ARE the remember mechanism — and the
    // codex card's Always Allow is the same control by another name. It reaches
    // further, in fact: it writes a durable workspace rule AND asks codex to
    // remember the decision for the session, so honouring it on a floor call
    // would both persist an allow-prefix above a floor and hand the next
    // identical call to codex's own `acceptForSession` where our gate never sees
    // it again. So a floor answer is a ONE-SHOT yes: the user may approve THIS
    // call and is asked again for the next one.
    //
    // The approval itself is honoured — `allowed` is passed through untouched.
    // Downgrading the answer would be a different (and wrong) change: the floor's
    // contract is "a person decides every time", not "a person cannot decide".
    const alwaysAllowHonoured = alwaysAllow === true && pending.floor === undefined && pending.askRule === undefined; // F1.870
    if (alwaysAllow === true && pending.floor !== undefined) {
      this.debug(
        `codex Always Allow refused by the ${pending.floor.floor} floor: `
        + 'a floor prompt has no don\'t-ask-again',
      );
    }
    // An Always Allow on a command becomes a DURABLE grant, not just codex's session-scoped
    // `acceptForSession`: persisted to the workspace store here, projected into `CODEX_HOME/rules/` on
    // the next home build — except where the card said codex keeps the command sandboxed (F1.780): that
    // grant stays codex's session one. Best-effort — the approval round-trip is answered regardless.
    if (allowed && alwaysAllowHonoured) { if (pending.sandboxRetained) this.debug(CODEX_SANDBOX_RETAINED_NOT_PERSISTED); else this.persistExecpolicyGrant(pending.kind, pending.params); }
    pending.resolve(buildApprovalResponse(
      pending.kind,
      pending.params,
      allowed,
      alwaysAllowHonoured,
      this.reportDegradedApproval,
    ));
  }

  /**
   * The durable Always-Allow store, read for the `CODEX_HOME/rules/` projection.
   *
   * Reads the workspace `permissions.json` DIRECTLY rather than the capability
   * merged config: the codex gate evaluates a pinned capability SNAPSHOT
   * (`getCapabilityPermissionsContext` → `pinnedConfigs`), which does not read
   * this file, so a freshly written grant would not be in it until the snapshot
   * regenerates. The file is the durable store the brief names, and reading it
   * here makes the projection reflect a just-persisted grant on the very next
   * build — which is what "Always Allow survives a mode change" needs.
   */
  private collectExecpolicyAllowPrefixes(): string[][] {
    try {
      return collectExecpolicyAllowPrefixes(
        loadRawWorkspacePermissions(this.config.workspace.workspaceRootPath),
      );
    } catch (error) {
      this.debug(`codex execpolicy projection skipped: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /**
   * The durable DENY store, read for the same `CODEX_HOME/rules/` projection.
   *
   * Same file and same reason as {@link collectExecpolicyAllowPrefixes} — the
   * durable workspace `permissions.json`, not the pinned capability snapshot —
   * so an imported Claude `deny` block reaches the projection on the next home
   * build. Same fail-soft posture too: a projection is defence in depth, and a
   * build that cannot read the store must still start a session.
   */
  private collectExecpolicyDenyPrefixes(): string[][] {
    try {
      return collectExecpolicyDenyPrefixes(
        loadRawWorkspacePermissions(this.config.workspace.workspaceRootPath),
      );
    } catch (error) {
      this.debug(`codex execpolicy deny projection skipped: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /**
   * The durable ASK store — the DSL's middle tier, which codex was told nothing
   * about until P6.1.
   *
   * Same file and same fail-soft posture as its two siblings. What it adds is
   * the only half of `ask` the host could not carry alone: an `ask` rule already
   * reaches the card for every call codex ASKS about, but a call codex
   * auto-approves never becomes an approval request, so nothing of ours runs.
   * Projected as codex's own `decision="prompt"`, which outranks an `allow` in
   * codex's own merge, that call becomes a request again.
   */
  private collectExecpolicyPromptPrefixes(): string[][] {
    try {
      return collectExecpolicyPromptPrefixes(
        loadRawWorkspacePermissions(this.config.workspace.workspaceRootPath),
      );
    } catch (error) {
      this.debug(`codex execpolicy prompt projection skipped: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /**
   * Persist an Always-Allow command grant to the workspace store as a structural
   * `bash` ALLOW rule. The prefix is codex's own `proposedExecpolicyAmendment`
   * (v2) or argv (v1); a request that carries neither persists nothing and keeps
   * the session-only grant. Idempotent and best-effort — any failure is logged,
   * never thrown onto the approval path.
   */
  private persistExecpolicyGrant(kind: ApprovalKind, params: unknown): void {
    const tokens = execpolicyAmendmentForApproval(kind, params);
    if (!tokens) return;
    // Second, independent refusal (P2.140). `respondToPermission` already drops
    // `alwaysAllow` for a floor request, so reaching here with one is either a
    // future second caller or a bug — and a durable allow-prefix written above a
    // floor is the one mistake this file cannot afford, because it OUTLIVES the
    // session: the store is projected into `CODEX_HOME/rules/` on every later
    // build and re-read by the rule consult on every later call. Checked against
    // the tokens actually about to be written, not against the request that
    // produced them.
    const grantFloor = firstNonNegotiableFloor(
      findNonNegotiableFloors(
        'Bash',
        { command: tokens.join(' ') },
        this.getPermissionMode(),
        // C3.378 — same context as `floorVerdict`'s, for the same reason: a
        // durable allow-prefix must be refused by the SAME floor that refused
        // the request, and the two would answer differently if only one of them
        // could reach the read-only allowlist.
        this.permissionManager.getCapabilityPermissionsContext?.() ?? {
          workspaceRootPath: this.config.workspace.workspaceRootPath,
          activeSourceSlugs: Array.from(this.sourceManager.getActiveSlugs()),
          projectTrusted: this.config.projectTrusted === true,
        },
      ),
    );
    if (grantFloor) {
      this.debug(
        `codex Always Allow not persisted: the ${grantFloor.floor} floor refuses `
        + `\`${tokens.join(' ')}\``,
      );
      return;
    }
    const workspaceRoot = this.config.workspace.workspaceRootPath;
    try {
      const merged = mergeExecpolicyAllowGrant(loadRawWorkspacePermissions(workspaceRoot), tokens);
      saveWorkspacePermissions(workspaceRoot, merged);
      this.debug(`codex Always Allow persisted as execpolicy rule: ${tokens.join(' ')}`);
    } catch (error) {
      this.debug(`codex Always Allow persist failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Open an approved url-mode elicitation, then answer codex.
   *
   * `accept` says the URL was opened, not that the user finished the flow —
   * codex learns that from the MCP server's own
   * `notifications/elicitation/complete`, keyed by the `elicitationId` only url
   * mode carries. So there is no second confirmation dialog here, and an
   * opener that fails declines rather than accepting on a browser that never
   * appeared.
   */
  private async resolveUrlElicitation(
    url: string,
    allowed: boolean,
    params: unknown,
    resolve: (payload: Record<string, unknown>) => void,
  ): Promise<void> {
    if (!allowed) {
      // A refusal the user chose is not a degradation, so it is not logged as one.
      resolve(buildApprovalResponse('elicitation', params, false));
      return;
    }
    try {
      await this.openExternalUrl(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      resolve({ ...buildUrlElicitationResponse(false, `url-mode could not open the browser: ${message}`, this.reportDegradedApproval) });
      return;
    }
    resolve({ ...buildUrlElicitationResponse(true) });
  }

  // ============================================================
  // Mini completion / queryLlm — direct one-shot to the gateway
  // ============================================================

  async queryLlm(request: LLMQueryRequest): Promise<LLMQueryResult> {
    // F1.202 — refused BEFORE the upstream is resolved: see the method.
    this.refuseQueryLlmOnDeclaredProvider();
    // Deliberately bypasses the local adapter (a one-shot needs no Responses
    // translation), but NOT the adapter's auth rule: `postChat` is the single
    // place that maps a target to a URL + headers, so this path cannot send
    // `Nestor-Token` anywhere the session's turns would not.
    const upstream = await this.resolveUpstream();
    // DA1.12 · the THIRD rendering site of the gateway credential refusal, and
    // the one a test set scoped to "both adapter wires" misses: this path never
    // touches the adapter, so it has to say WHY on its own. `readNestorCreds`
    // gives it the same two reasons the adapter's gate renders, so an expired
    // token sends the user to the re-mint (Target scheme clause 1) rather than
    // to an API key that is fine. The expired sentence keeps the substring
    // `token is expired`, which the shared auth-retry heuristic in
    // `SessionManager` already matches.
    let jwt: string | null = null;
    if (upstream.kind === 'nestor') {
      const creds = readNestorCreds();
      if (!creds.ok) {
        throw new Error(creds.reason === 'credentials_expired'
          ? 'Nessy Gateway authentication token is expired for queryLlm — sign in again to re-mint it'
          : 'Nessy Gateway credentials not found for queryLlm');
      }
      jwt = creds.jwt;
    }
    const model = request.model || this._model;
    const messages: Array<{ role: string; content: string }> = [];
    if (request.systemPrompt) messages.push({ role: 'system', content: request.systemPrompt });
    messages.push({ role: 'user', content: request.prompt });

    const res = await postChat({
      model,
      messages,
      temperature: typeof request.temperature === 'number' && request.temperature > 0 ? request.temperature : 0.7,
      top_p: 0.8,
      max_tokens: request.maxTokens ?? 4096,
      stream: false,
    }, { upstream, ...(jwt ? { jwt } : {}) });
    if (!res.ok) throw new Error(`codex queryLlm upstream (${upstream.kind}) failed: ${res.status}`);
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const raw = json.choices?.[0]?.message?.content ?? '';
    // Surface only the answer (reasoning stripped) as the completion text.
    const { answer } = extractReasoning(raw);
    return {
      text: answer.trim() || raw.trim(),
      model,
      inputTokens: json.usage?.prompt_tokens,
      outputTokens: json.usage?.completion_tokens,
    };
  }

  /**
   * C3.364 — the BACKGROUND tier's model. On codex it was the session model.
   *
   * This is the whole codex title arm: `BaseAgent.generateTitle` and
   * `regenerateTitle` build their prompt and hand it here, and `runMiniCompletion`
   * takes no model parameter, so whatever this method passes to
   * {@link queryLlm} is what a title is billed at. It passed nothing, and
   * `queryLlm`'s `request.model || this._model` then picked the chat model — so
   * every session title, and every other mini completion, spent a flagship turn
   * while the resolved cheap model sat unused on the same config.
   *
   * The other two runtimes already do it: `claude-agent.ts` symbol
   * `runMiniCompletion` REQUIRES `config.miniModel` and throws without it, and
   * `packages/pi-agent-server/src/index.ts` symbol `queryLlm` defaults to
   * `config.miniModel` inside the subprocess. So this is the host's own
   * mechanism reused, not a new one — `config.miniModel` is already on this
   * config, already screened (`getMiniModel` applies the managed allowlist
   * before this agent ever sees the value), and already consumed elsewhere in
   * THIS file for `[agents] default_subagent_model`
   * ({@link codexDefaultSubagentModelOption}), which is what made the title gap
   * look deliberate.
   *
   * **It also makes a shipped sentence true.** `packages/shared/src/config/llm-connections.ts`
   * symbol `formatMiniModelDegradationNotice` tells the user *"Background tasks
   * on `<slug>` — session titles, summaries and mini completions — run on
   * `<used>` and are billed at that model's rate"*, where `<used>` is the
   * RESOLVED mini model, and `SessionManager` raises it on every runtime with no
   * codex gate. On codex that sentence named a model the title never touched —
   * and it is SUPPRESSED in exactly the case codex diverged most, because
   * `describeMiniModelDegradation` returns nothing when a cheap model resolves
   * cleanly.
   *
   * Absent `miniModel`, the request is sent unchanged and `queryLlm` falls back
   * to the session model exactly as before — codex has no third id to invent,
   * and claude's throw is not portable here (a title is fire-and-forget on this
   * runtime; `runMiniCompletion` already answers `null` on any failure).
   *
   * NOT changed: {@link queryLlm}'s own default. It also serves the model-facing
   * `call_llm` tool, where a caller that names no model means *this session's
   * model*; moving that onto the cheap tier is a product posture nobody asked
   * for, and the row asks only for the title request.
   */
  async runMiniCompletion(prompt: string): Promise<string | null> {
    try {
      const mini = this.config.miniModel?.trim();
      const result = await this.queryLlm(mini ? { prompt, model: mini } : { prompt });
      return result.text || null;
    } catch (err) {
      this.debug(`runMiniCompletion failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  // ============================================================
  // Teardown
  // ============================================================

  /**
   * P2.330 — refuse to start a session whose permission profile the binary threw
   * away, because a discarded profile is INVISIBLE at every other surface.
   *
   * THE FAILURE THIS EXISTS FOR, measured 2026-08-28 on `rust-v0.148.0`
   * (`docs/superpowers/specs/2026-08-28-codex-sandbox-enforcement.md` §4): an
   * `extends` the binary rejects produces **no RPC error**. It writes
   * `Invalid configuration; using defaults` to **stderr only** and discards the
   * WHOLE `config.toml` — our `deny` on `credentials.enc` with it. Codex's own
   * default `workspace-write` then keeps refusing outside writes and network, so
   * from every angle EXCEPT the credential read the session still looks
   * sandboxed. Exactly one protection is downgraded, silently, and it is the one
   * the file existed to carry. The negative-control arm of that measurement read
   * a decoy secret while the profile reported `allowed: false`.
   *
   * `[doc:codex]` — the rejection itself is the documented contract, so a fixed
   * `extends` that works today can be rejected by a future pin without any
   * change of ours. `learn.chatgpt.com/docs/permissions.md#configuration-spec`,
   * verbatim, on `permissions.<name>.extends`:
   *
   *   "Starts this profile from another named profile or the built-in
   *   `:read-only` or `:workspace` profile. Codex rejects `:danger-full-access`,
   *   unknown parents, and inheritance cycles."
   *
   * The page says Codex REJECTS. It does not promise the rejection is legible to
   * a client, and measurement says it is not — hence an explicit in-band check.
   *
   * WHY A HARD FAILURE, and why only on this one signal:
   *
   * - `allowed: false` on OUR profile is unambiguous: either the binary refused
   *   it, or managed `allowed_permission_profiles` forbids selecting it
   *   ("Whether the effective requirements allow selecting this profile" —
   *   `PermissionProfileSummary`). In BOTH states our filesystem deny is not in
   *   force, and a session that cannot carry it must not present itself as one
   *   that does. Continuing is the fail-open.
   * - Every other outcome DEGRADES with a named debug line and starts the
   *   session — the same contract `probeCodexConfigRequirements` uses ten lines
   *   above, and for the same reason: an app-server that does not know the method
   *   (a downgraded or substituted artifact), a transport hiccup, or a profile
   *   missing from the listing are all "we do not know", and "we do not know" is
   *   not evidence of a downgrade. Refusing on those would brick codex sessions
   *   on version drift, which is a bigger hole than the one being closed.
   * - When we declare NO profile at all (no filesystem policy — the config
   *   writer omits `default_permissions` entirely) there is nothing to verify and
   *   this returns immediately. The declared name is re-derived from the same
   *   builder rather than hardcoded, so it cannot drift from what was written.
   *
   * WHAT THIS METHOD CANNOT SEE, named here rather than left to be rediscovered
   * on the platform where it bites (P3.308). `allowed: true` means the profile
   * was ACCEPTED, not that its denies are in force. On Linux a filesystem deny
   * anchored at the filesystem root is accepted here and then makes sandbox
   * CONSTRUCTION fail, so every command dies — measured on the real binary, with
   * a plain read of a non-secret file dying identically, which is what separates
   * it from a deny doing its job. That failure has no in-band signal at startup;
   * it is recognised from the first command's output by
   * `backend/codex/event-adapter.ts::sandboxConstructionFailureEvents`. The two
   * halves are deliberately at different layers because the two facts are.
   */
  /**
   * P3.315 — say which one wins when the written mode and the resolved policy
   * disagree.
   *
   * The measurement, the source and the two respellings that were NOT taken are
   * on {@link CODEX_MODE_RESOLVES_TO}. This method is the honest half: it reads
   * codex's own answer rather than restating a precedence rule, so it survives
   * the rule changing.
   *
   * DEGRADES rather than refusing, for {@link verifyPermissionProfileAccepted}'s
   * reason: an absent or unrecognised field is "we do not know", and refusing a
   * session on a shape drift would be a bigger hole than the one being reported.
   *
   * ONCE PER SESSION, at `thread/start`. `thread/fork` and `thread/resume`
   * re-apply the same config layer from the same builder, so a second reading
   * there could only repeat this one; a fork that somehow resolved DIFFERENTLY
   * would be a finding this method cannot see, and that residue is stated here
   * rather than left to be rediscovered.
   */
  /**
   * F1.723 — the host's sandbox, approval and permission choice as the request `config` layer of
   * every thread OPEN (`thread/start`/`resume`/`fork`) and both REFORK legs.
   *
   * codex stacks user (`CODEX_HOME/config.toml`, what this host writes) BELOW every project layer
   * (`<cwd>/.codex/config.toml` and the dirs up to the project root), and a request `config` map
   * ABOVE both, as `SessionFlags` (`config/src/loader/mod.rs` `load_config_layers_state`,
   * `app-server/src/config_manager.rs` `load_with_cli_overrides`, read at `rust-v0.156.1`). A project
   * layer may set `sandbox_mode`, `approval_policy`, `default_permissions` and `permissions` (only a
   * provider/URL denylist is stripped), and `resolve_permission_config_syntax` lets the highest layer
   * naming `sandbox_mode` discard a lower `default_permissions` profile — so a project's bare
   * `sandbox_mode = "danger-full-access"` turned the sandbox off. codex also AUTO-TRUSTS the cwd on
   * `thread/start` (`thread_processor.rs` `thread_start_task`) whenever it has no trust entry, which
   * is why the host's "Keep restricted" never kept that layer out; with the home directory as the
   * project, the user's own Codex CLI `~/.codex/config.toml` is that layer (measured, SIT-u).
   *
   * Native-first: a `SessionFlags` `default_permissions` always selects the profile syntax, so
   * restating the three keys (and the profile table the override already carries; F1.926 adds the reviewer) there makes the
   * host's choice win without disabling the project layer's other keys (measured: a project's
   * `model_reasoning_effort` still applies). The refork already sent this very layer, so one
   * mechanism now covers every leg; app-server `-c` flags (the same `SessionFlags` layer, fixed at
   * spawn) would have been a second one. An `untrusted` trust entry was not taken: measured, it also
   * switches off a legitimate project's non-security keys. A `granular` approval policy is an object
   * built from options this call site does not see, so it is left to `config.toml` rather than
   * restated wrong. The auto-trust itself is closed by F1.750, not here: see
   * {@link CodexAgent.codexProjectTrustOptions} — a project the host did not trust is written
   * `trust_level = "untrusted"`, so codex never auto-trusts it and its `.codex` layer stays out.
   *
   * F1.845 — the same map carries `skills.config` for an UNTRUSTED project: one `{ path, enabled: false }`
   * per skill codex's own `skills/list` reported with `scope: 'repo'` just before this open
   * ({@link CodexAgent.refreshCodexRestrictedRepoSkills}). The trust entry cannot do it — codex builds
   * skill roots from every layer INCLUDING a disabled one — and `SessionFlags` is one of the two layers
   * codex reads per-skill rules from, the later one, so this disable outranks a user-layer rule.
   */
  private codexThreadSecurityLayer(override?: Record<string, unknown>): Record<string, unknown> {
    const { sandbox_mode, approval_policy } = codexSandboxConfigForMode(this.getPermissionMode(), this.sandboxGloballyEnabled());
    return {
      sandbox_mode, ...codexThreadApprovalsReviewer(this.configuredApprovalsReviewer, this.managedApprovalsReviewers, this.autoReviewSettingOn()), // F1.926
      ...(approval_policy === 'granular' ? {} : { approval_policy }),
      ...(override ?? buildCodexRuntimeConfigOverride({
        mode: this.getPermissionMode(),
        sandboxGloballyEnabled: this.sandboxGloballyEnabled(),
        readOnlyPaths: this.codexReadOnlyPaths(), // F1.670; F1.678 — the host writes no exact deny any more
        deniedReadPatterns: this.credentialFloorPatterns(),
        shellEnvironment: this.codexShellEffortEnvironment(),
        writablePaths: this.codexWritablePaths(), // F1.1003
        protectedWorkspaceSubpaths: this.codexProtectedWorkspaceSubpaths(),
      })),
      ...(this.codexRestrictedRepoSkillsOff.length > 0 ? { skills: { config: [...this.codexRestrictedRepoSkillsOff] } } : {}), // F1.845
    };
  }

  /** F1.845 · the untrusted project's repo-scope skills as codex listed them before the latest thread open; empty when trusted. */
  private codexRestrictedRepoSkillsOff: Array<{ path: string; enabled: false }> = [];

  /**
   * F1.845 — keep a restricted project's skills out on codex, with codex's OWN per-skill disable.
   *
   * WHY. Measured on the shipped `codex-app-server` 0.156.1 (WJ-crit-jjj, pinned by
   * `codex-responses-adapter/src/__tests__/config-writer-untrusted-project-skills-live.test.ts`): under
   * the `untrusted` entry F1.750 writes, codex still lists a project's `.codex/skills` and every
   * `.agents/skills` from the project root down to the cwd enabled, puts their descriptions in the
   * model's catalog and injects a body on a `$name` mention. Source at `rust-v0.156.1`:
   * `ext/skills/src/host_roots.rs` `roots_from_layer_stack` walks every layer "including disabled
   * layers", `repo_agents_skill_roots` has no trust check, and `config/src/skills_config.rs` has no key
   * that keeps a ROOT or a scope out — only per-skill `skills.config` rules.
   *
   * WHAT. For a project the host did not trust (the same decision F1.750 writes,
   * {@link codexProjectTrustOptionsFor}), ask codex itself — `skills/list { cwds: [cwd], forceReload:
   * true }` — and hand every `scope: 'repo'` path back as `enabled: false` in the request `config` map
   * ({@link CodexAgent.codexThreadSecurityLayer}). Called before EVERY open: `createRuntime`'s
   * `thread/start`, relaunch `thread/resume` and branch `thread/fork` (one call before the open params
   * are built), and inside the refork walk's one budget, so both of its legs carry a fresh read. The
   * discovery stays codex's: no host folder scan, so nothing codex finds can be missed by a mirror.
   * Measured with the product's own writer, that map removes the skills from the first turn's catalog and
   * from a `$name` mention. The user's own skills (`scope: 'user'`) and codex's bundled ones are never
   * named. A trusted project lists nothing here and its request is what it was before this row.
   *
   * FAIL CLOSED, and that is a posture stated here (TRANSPARENT rule): a `skills/list` that throws or
   * does not answer REFUSES the open with a sentence naming why, rather than opening a thread with the
   * project's skills live. codex's `skills/list` is a local directory walk inside the skill roots, so
   * the refusal is expected only when the app-server itself is failing, where the open would fail too.
   * A response that carries no `data` array is read as "codex lists no project skill" — the shape the
   * pinned schema publishes (`SkillsListResponse`) is re-proven on the shipped binary by the gated test.
   *
   * RESIDUE, said out loud: (1) a skill created in the project AFTER a thread opened loads until the
   * next open (a refork, a relaunch, a mode change) — codex re-scans the roots it watches, and the
   * disable is a snapshot of the list; (2) codex's process-level `skills/list` — which reads no thread's
   * `SessionFlags` layer — still reports these skills `enabled: true` (measured; pinned by the gated
   * test's third case), which the {@link CodexAgent.syncCodexSkillsConfig} debug count now subtracts (F1.948);
   * (3) which skills are `repo` is codex's call — the host does not second-guess its scope.
   */
  private async refreshCodexRestrictedRepoSkills(
    client: { request: (method: string, params?: unknown, options?: { timeoutMs?: number }) => Promise<unknown> },
    timeoutMs: number,
  ): Promise<void> {
    const trust = codexProjectTrustOptionsFor(this.workingDirectory, this.config.projectTrusted === true);
    if (!trust.projectRoot || trust.projectTrusted) {
      this.codexRestrictedRepoSkillsOff = [];
      return;
    }
    let listed: unknown;
    try {
      listed = await requestWithinDeadline(client, 'skills/list', { cwds: [this.workingDirectory], forceReload: true }, timeoutMs);
    } catch (error) {
      throw new Error(codexRestrictedSkillsListRefusal(error instanceof Error ? error.message : String(error)));
    }
    if (listed === CODEX_REQUEST_TIMED_OUT) {
      throw new Error(codexRestrictedSkillsListRefusal(`no answer within ${Math.ceil(timeoutMs)}ms`));
    }
    this.codexRestrictedRepoSkillsOff = codexRestrictedRepoSkillsOff(listed);
    this.debug(
      `[Skills] F1.845: this project is not trusted, so ${this.codexRestrictedRepoSkillsOff.length} project skill(s) codex `
      + 'listed are disabled for the thread being opened',
    );
  }

  /**
   * F1.750 — the host's project trust, handed to `writeCodexConfig` on EVERY runtime build (spawn
   * and the mode-change respawn), so the session's `CODEX_HOME/config.toml` carries an explicit
   * trust entry for the cwd and codex's own auto-trust on `thread/start` never fires.
   *
   * Until this row the call passed neither `projectRoot` nor `projectTrusted`, so P6.540's
   * projection was inert and codex AUTO-TRUSTED every project — "Keep restricted" included
   * (`thread_processor.rs` `thread_start_task` trusts a cwd whose `active_project.trust_level` is
   * `None`, at `rust-v0.156.1`). Measured on the shipped 0.156.1 (`work/wjcritaa/f1750-probe.ts`):
   * a restricted project's `.codex/config.toml` MCP server command RAN at thread open and its
   * `rules/*.rules` applied. With the entry, neither.
   *
   * The decision is `this.config.projectTrusted`, the host's own trust captured at agent creation
   * (anything but an explicit `trusted` stays untrusted). The key is
   * {@link codexProjectTrustOptionsFor}'s. Keyed session fact `codex-project-trust` states the cost
   * of an untrusted project on codex — no `.codex` layer, no project AGENTS.md (I2.27) and no project skills
   * (F1.845's {@link CodexAgent.refreshCodexRestrictedRepoSkills}; F1.947), the content the host withholds — and is cleared when trusted.
   */
  private codexProjectTrustOptions(): { projectRoot?: string; projectTrusted: boolean } {
    const options = codexProjectTrustOptionsFor(this.workingDirectory, this.config.projectTrusted === true);
    if (options.projectRoot && !options.projectTrusted) {
      this.recordSessionFact('codex-project-trust', `[codex] This project is not trusted in this app ("Keep restricted", or never trusted), `
        + `so codex was told \`trust_level = "untrusted"\` for ${options.projectRoot}: codex loads nothing from the project's \`.codex\` `
        + 'folder (config, MCP servers, hooks, rules), reads no project AGENTS.md, and every project skill codex listed when the thread opened '
        + '(`.codex/skills`, `.agents/skills`) is switched off — the same project content this app withholds from an untrusted project. Trust the project to load them.');
    } else {
      this.sessionFacts.delete('codex-project-trust');
    }
    return options;
  }

  /**
   * F1.723 · the approval policy codex RESOLVED for the opened thread, SAID when it is not the
   * host's (a managed requirement, or any layer this host could not outrank), so the session facts
   * never claim the host's own policy for a thread running another. Keyed, so a respawn restates.
   */
  private noteResolvedApprovalPolicy(resolved: unknown): void {
    const asked = codexSandboxConfigForMode(this.getPermissionMode(), this.sandboxGloballyEnabled()).approval_policy;
    if (typeof resolved !== 'string' || asked === 'granular' || resolved === asked) {
      this.sessionFacts.delete('codex-resolved-approval-policy');
      return;
    }
    const line = `codex resolved approval policy "${resolved}" for this thread, not the "${asked}" this app `
      + 'asked for; the resolved policy is the one being enforced.';
    this.recordSessionFact('codex-resolved-approval-policy', line);
    this.surfaceCodexOperatorNotice(line);
  }

  /** F1.734 · the `written->resolved` pairs already said, so a respawn does not restate one. */
  private readonly reportedSandboxDivergences = new Set<string>();

  private noteResolvedSandboxPolicy(resolved: { type?: string } | undefined): void {
    const written = codexSandboxConfigForMode(
      this.getPermissionMode(),
      this.sandboxGloballyEnabled(),
    ).sandbox_mode;
    const type = resolved?.type;
    if (typeof type !== 'string' || !type) {
      this.debug(
        `codex thread/start reported no sandbox policy, so the "${written}" mode this host wrote could `
        + 'not be checked against what the binary resolved; the session starts unverified',
      );
      return;
    }
    const expected = CODEX_MODE_RESOLVES_TO[written];
    if (type === expected) {
      this.debug(`codex resolved sandbox policy "${type}", which is what the "${written}" mode this host wrote asks for`);
      return;
    }
    // F1.1124 (repair) — with the switch off the host writes `danger-full-access` for every mode, and since
    // F1.787 (owner option B) plan and dontAsk build the profile on codex's `:read-only` parent, so the two
    // resolutions that parent produces are the host's own construction, not codex's precedence overriding it:
    // a bare `readOnly` when no write key lands, and — the real Plan spawn since F1.1003 — a `workspaceWrite`
    // whose only writable roots are this session's own grants (measured on the shipped 0.159.3, 2026-10-10:
    // plans+data keys → `workspaceWrite`, no keys → `readOnly`). The egress line already states the posture,
    // so both go to the debug channel only. The P3.315 `default` disclosure (`workspaceWrite` under the
    // `:workspace` parent) and every other pair are still said. Residue, stated: a resolved `dangerFullAccess`
    // here stays quiet on the agreement arm above (the bare mode line is honoured; no measurement has codex
    // reporting it with the profile written) — a profile that failed to land would be silent.
    if (written === 'danger-full-access'
      && (type === 'readOnly' || type === 'workspaceWrite')
      && codexModeKeepsReadOnlyParent(this.getPermissionMode())) {
      this.debug(type === 'workspaceWrite'
        ? `codex resolved sandbox policy "workspaceWrite": the session's permission profile extends ":read-only" in this mode on purpose (F1.787), and its only writable roots are the folders this session grants (F1.1003) — the profile supersedes the "${written}" line`
        : `codex resolved sandbox policy "readOnly": the session's permission profile extends ":read-only" in this mode on purpose (F1.787), which supersedes the "${written}" line`);
      return;
    }
    // F1.734 · once per DIVERGENCE per agent: every respawn re-reads the policy, and an unchanged
    // divergence restated each time is noise (the 1.41.0 sitting); a different pair is a new fact.
    const divergence = `${written}->${type}`;
    if (this.reportedSandboxDivergences.has(divergence)) {
      this.debug(`codex again resolved "${type}" for the "${written}" mode this host wrote; already reported to this session`);
      return;
    }
    this.reportedSandboxDivergences.add(divergence);
    this.surfaceCodexOperatorNotice(
      `Codex is not running under the sandbox mode this app asked for. The config written for this `
      + `session says sandbox_mode = "${written}", and codex resolved a sandbox policy of "${type}" `
      + `instead — the resolved policy is the one being enforced. The cause is codex's own precedence: `
      + `a "default_permissions" profile in the same config file supersedes "sandbox_mode", and this `
      + `app always writes one because the protected-path floor lives in it (measured on `
      + `rust-v0.148.0, both directions). Read the session's permissions as "${type}".`,
    );
  }

  private async verifyPermissionProfileAccepted(client: AppServerClient): Promise<void> {
    const declared = buildCodexRuntimeConfigOverride({
      mode: this.getPermissionMode(),
      sandboxGloballyEnabled: this.sandboxGloballyEnabled(),
      readOnlyPaths: this.codexReadOnlyPaths(), // F1.670; F1.678 — the host writes no exact deny any more
      // P3.175 · the `deniedPaths` credential floor, mirrored onto codex's own
      // OS-enforced deny map. Defence in depth: our gate still runs first.
      deniedReadPatterns: this.credentialFloorPatterns(),
      // C3.343 · the fourth site. It reads only `default_permissions`, and this
      // floor can PRODUCE that key on a session that has no other filesystem
      // policy — so omitting it here would ask the binary about a profile name
      // this session does not declare.
      protectedWorkspaceSubpaths: this.codexProtectedWorkspaceSubpaths(),
    }).default_permissions;
    if (typeof declared !== 'string' || !declared) return;

    let listed: { data?: { id?: string; allowed?: boolean }[] } | undefined;
    try {
      // `cwd` is what resolves the project config layers, per
      // `PermissionProfileListParams` — without it the answer describes a
      // different layer stack than the session runs under.
      listed = (await client.request(
        'permissionProfile/list',
        { cwd: this.workingDirectory },
      )) as { data?: { id?: string; allowed?: boolean }[] };
    } catch (error) {
      this.debug(
        `codex permissionProfile/list did not answer (${error instanceof Error ? error.message : String(error)}); `
        + `the "${declared}" permission profile could not be verified and the session starts unverified`,
      );
      return;
    }

    const ours = listed?.data?.find(entry => entry?.id === declared);
    if (!ours) {
      this.debug(
        `codex permissionProfile/list did not list "${declared}"; `
        + 'the session starts unverified rather than being refused on an absence',
      );
      return;
    }
    if (ours.allowed === true) {
      // P3.308 · "accepted" is NOT "in force", and on Linux the difference is
      // the whole session. Driven on the real Linux binary
      // (`scripts/platform-rig/run-linux-codex-probe.mjs`, `rust-v0.148.0`
      // aarch64-musl, 2026-09-03): a filesystem deny anchored at the filesystem
      // root is reported `allowed: true` here — truthfully, the profile WAS
      // accepted — and then every sandboxed exec dies with
      // `error building bubblewrap command`, including a plain read of a
      // non-secret file. The profile is accepted at one layer and unusable at
      // the next, and this check can only ever see the first.
      //
      // Nothing is widened here, because there is nothing to widen: the signal
      // this method reads is correct and the failure is not in it. The
      // construction failure is recognised where it actually appears — in the
      // output of a command that tried to run —
      // by `backend/codex/event-adapter.ts::sandboxConstructionFailureEvents`,
      // which carries the four-arm measurement and both of its controls.
      //
      // The line therefore stops claiming enforcement it cannot observe.
      this.debug(
        `codex permission profile "${declared}" was ACCEPTED by permissionProfile/list. That is the `
        + 'strongest in-band signal available at startup and it is not enforcement: the sandbox is '
        + 'built later, and a profile accepted here can still fail to construct one (P3.308). A '
        + 'construction failure is reported on the transcript by the event adapter, from the first '
        + 'command that tries to run.',
      );
      return;
    }
    throw new Error(
      `codex refused the "${declared}" permission profile (permissionProfile/list reports allowed=${String(ours.allowed)}). `
      + 'The whole config.toml is discarded in that state, including the protected-path entries and every '
      + 'deniedPaths entry of yours, and codex\'s own defaults keep the session LOOKING sandboxed. '
      + 'Refusing to start rather than running one protection short.',
    );
  }

  /**
   * F1.751 — a TRUSTED project's `.codex/config.toml` can ADD entries to this session's permission
   * profile, and the request layer cannot take them back out: codex merges config tables key by key
   * (`merge_toml_values`, `codex-rs/config/src/merge.rs` at rust-v0.159.3) and `permissions` is not on
   * `PROJECT_LOCAL_CONFIG_DENYLIST`, so {@link CodexAgent.codexThreadSecurityLayer}'s restated profile
   * (and F1.926's reviewer, which a project can no longer set) leaves a project's extra filesystem keys
   * in force. Measured on the shipped 0.159.3 (BK-8, `work/bk-8/f1751-probe.ts`): a trusted project
   * adding `"<outside>" = "write"` put that folder in the thread's `writableRoots` and an agent command's
   * write there landed; the control was refused.
   *
   * DECIDED (TRANSPARENT and SIMPLE, `work/wi16/QUESTIONS.md`): SAY it, do not refuse — a trusted project
   * is the user's own choice and codex's own trust model lets it configure permissions. codex's own
   * report is read (`config/read { cwd, includeLayers }`, the layer stack this session runs under): every
   * enabled `project` layer that names this session's profile is listed, with its entries, as one operator
   * notice and a session fact. A project the host keeps restricted is a DISABLED layer (F1.750) and is
   * skipped. Residues: read once per runtime build, so an edit made mid-session is seen at the next build;
   * a `config/read` that does not answer is a debug line, never a refusal.
   */
  private async noteProjectPermissionProfileAdditions(client: { request: (method: string, params?: unknown) => Promise<unknown> }): Promise<void> {
    try {
      const profile = this.codexThreadSecurityLayer().default_permissions;
      if (typeof profile !== 'string' || !profile) return;
      type Layer = { name?: { type?: string; dotCodexFolder?: string }; config?: unknown; disabledReason?: string | null };
      let read: { layers?: Layer[] | null } | undefined;
      try {
        read = (await client.request('config/read', { cwd: this.workingDirectory, includeLayers: true })) as { layers?: Layer[] | null };
      } catch (error) {
        this.debug(`codex config/read did not answer (${error instanceof Error ? error.message : String(error)}); `
          + `a trusted project's additions to the "${profile}" permission profile could not be checked`);
        return;
      }
      const added: string[] = [];
      for (const layer of read?.layers ?? []) {
        if (layer?.name?.type !== 'project' || layer.disabledReason) continue;
        const ours = ((layer.config as { permissions?: Record<string, unknown> } | undefined)?.permissions ?? {})[profile];
        if (!ours || typeof ours !== 'object') continue;
        const filesystem = (ours as { filesystem?: Record<string, unknown> }).filesystem;
        const entries = filesystem && typeof filesystem === 'object'
          ? Object.entries(filesystem).map(([path, access]) => `${path} = ${JSON.stringify(access)}`)
          : Object.keys(ours);
        added.push(`${layer.name.dotCodexFolder ?? 'a project .codex folder'} (${entries.join(', ')})`);
      }
      if (added.length === 0) {
        this.sessionFacts.delete('codex-project-permission-profile');
        return;
      }
      const line = `A trusted project's Codex config adds to this session's "${profile}" permission profile, and codex `
        + `applies those entries: ${added.join('; ')}. This app restates the sandbox, the approval policy, the reviewer and its `
        + 'own entries above every project layer, but cannot take back an entry a project adds. To run without it, remove it '
        + "from the project's .codex/config.toml, or keep the project restricted.";
      this.recordSessionFact('codex-project-permission-profile', line);
      this.surfaceCodexOperatorNotice(line);
    } catch (error) {
      this.debug(`F1.751 — the project permission-profile check failed (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  private emitStopHookOnce(): Promise<void> {
    if (!this.stopHookForTurn) {
      this.stopHookForTurn = this.emitAutomationEvent('Stop', {
        hook_event_name: 'Stop',
        // `hooks.md:2190` — "`true` when Claude Code is already continuing as a
        // result of a stop hook". Read HERE, before `recordHookBlockFeedback`
        // below updates the streak, so it describes the turn that is ending
        // rather than the one about to start — the same ordering pi-agent.ts
        // states at its own emission site, off the same counter. A codex Stop
        // hook could not previously see this field at all, so the documented
        // "check this value to prevent a condition that will never resolve"
        // recipe had nothing to check.
        stop_hook_active: this.isContinuingFromHookBlock('Stop'),
        // `hooks.md:2194` — `background_tasks` / `session_crons` are PRESENT
        // whenever the task registry is reachable, EMPTY rather than absent when
        // nothing is in flight. T3 widened the port's binding to every scheduled
        // runtime and recorded that codex's Stop still omitted the keys; this is
        // that line. Without it a codex session can hold cron records its own
        // Stop hooks are structurally unable to see — the same defect the Pi
        // path fixed at `pi-agent.ts`, through the same one helper.
        ...hookTaskRegistryInput(this.config.hookTaskRegistryPort),
      }).then(result => {
        // P6.11 — this was `.then(() => undefined)`, and the discard was the
        // whole defect: a Stop hook's `decision: block` and its `reason`
        // reached NOTHING on this runtime. hooks.md is explicit that a blocking
        // Stop hook does not cancel anything — it feeds its reason back so the
        // agent knows what still needs doing — so dropping the result is not a
        // conservative reading of the contract, it is the contract's only
        // channel closed. `recordHookBlockFeedback` is the shared BaseAgent
        // implementation Pi already routes into: it maintains the consecutive
        // block streak `stop_hook_active` above reads, applies
        // `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`, and queues the reason for the next
        // turn's user tail (drained in `chatImpl`).
        //
        // Belted rather than left to reject: this promise is awaited on the
        // teardown path (`endLifecycle`), and a throw from the recorder there
        // would turn a hook bookkeeping fault into a failed session close.
        // C3.361 · the USER half, beside the model half below.
        // `hooks.md#stop-decision-control` gives Stop's own event fields and says
        // nothing about `stopReason`; the universal table
        // (`hooks.md#json-output`) does — "Message shown to the user when
        // `continue` is `false`" — and that is the field
        // `recordHookBlockFeedback` cannot carry, because it reads
        // `decision.reason`, the MODEL half, and queues it onto the next turn.
        this.surfaceHookUserFacingOutput('Stop', result, { holdForNextTurn: true });
        try {
          this.recordHookBlockFeedback('Stop', result);
        } catch (error) {
          this.debug(`Stop hook feedback could not be recorded: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    }
    return this.stopHookForTurn;
  }

  /**
   * `reason` is SessionEnd's documented exit reason (hooks.md#sessionend).
   *
   * C3.361 does NOT surface this event's `systemMessage`, and the omission is
   * deliberate: {@link surfaceCodexOperatorNotice} defers a notice to the NEXT
   * turn when no turn sink is open, and by definition there is no next turn
   * here — the queued line would either vanish with the session or reappear in a
   * resumed one, dated wrongly. hooks.md#sessionend says the event "cannot block
   * session termination", so a message from it has no stop to explain either.
   */
  private async emitSessionEndOnce(reason: SessionEndReason): Promise<void> {
    if (!this._sessionStartEmitted || this._sessionEndEmitted) return;
    this._sessionEndEmitted = true;
    await this.emitAutomationEvent('SessionEnd', { hook_event_name: 'SessionEnd', reason });
  }

  override async endLifecycle(reason: SessionEndReason = 'other'): Promise<void> {
    if (this.stopHookForTurn) await this.stopHookForTurn;
    await this.emitSessionEndOnce(reason);
    await super.endLifecycle(reason);
  }

  captureLifecycleState(): AgentLifecycleState {
    return {
      sessionStartEmitted: this._sessionStartEmitted,
      sessionEndEmitted: this._sessionEndEmitted,
      sessionStartHooksApplied: this._sessionStartHooksApplied,
      ...(this._sessionHookContext ? { sessionHookContext: this._sessionHookContext } : {}),
      ...this.captureHookSessionDirectives(),
    };
  }

  restoreLifecycleState(state: AgentLifecycleState): void {
    this._sessionStartEmitted = state.sessionStartEmitted;
    this._sessionEndEmitted = state.sessionEndEmitted;
    this._sessionStartHooksApplied = state.sessionStartHooksApplied;
    this._sessionHookContext = state.sessionHookContext;
    this.restoreHookSessionDirectives(state);
  }

  /**
   * `/clear` (f074): without this override the base reset left `threadId`
   * standing (it was only nulled in teardown), so the next turn still resumed
   * the same `thread/resume` id and history survived the clear. Dropping the
   * thread anchor is the whole reset on this backend — the next chat starts a
   * fresh thread.
   */
  override async clearHistory(): Promise<void> {
    this.threadId = null; const branch = this.config.session?.branchFrom; if (branch) { branch.sdkSessionId = undefined; branch.sdkCwd = undefined; branch.sdkTurnId = undefined; } // F1.1278 — the build-time fork anchor goes too: the thread-open block forks `branchFrom.sdkSessionId` at EVERY open and `/clear` keeps the agent, so a branched chat re-forked its parent and the model saw the cleared history (the host retired its copy at the first fork; F1.1235's sdkSessionId twin is at the base seam)
    this.activeTurnId = null;
    // A steer against the thread being discarded can no longer be answered on
    // any turn, and must not gate the first turn of the fresh thread.
    this.detachTurnSteers();
    // P6.106 · AND TEAR THE RUNTIME DOWN, which this override did not do.
    //
    // Dropping `threadId` alone left `manager` standing, and `ensureRuntime`
    // returns early on `if (this.manager) return` — so nothing re-opened a
    // thread and the next turn fired `turn/start` with `threadId: null`. Pi's
    // `/clear` has always ended its subprocess (`killSubprocess()`); this is
    // the same ending, and it is also what lets `/resume` reach
    // `thread/resume`, since only a rebuild passes through the thread-open
    // block.
    //
    // A teardown failure does not cancel the clear: the conversation is already
    // gone from this agent's point of view, and leaving the user with neither a
    // clear nor an explanation is the worse end. It is reported instead, on the
    // transcript rather than only to `debug`.
    //
    // F1.490 (DECIDED 2026-09-24 under the TRANSPARENT/SIMPLE rule, WJ-az): what
    // a failed `/clear` teardown could not release is NOT kept for a retry, and
    // nothing retries it. Option (a) — keep the bundle like a restart does
    // (F1.483) — would make `disposeForRestart` reject while the leftover still
    // fails, so a `/clear` leak could refuse a LATER runtime switch or plugin
    // refresh: a new posture that trades a user action for one directory. The
    // directory is this runtime's `mkdtemp` CODEX_HOME (F1.652: under the host's config dir or,
    // failing that, the per-user temp root), 0700, so its 0644 rollouts are readable by
    // this user only; and the notice below names the failed step and, for that
    // step, the fs error's own path. Residue, stated: the directory stays until
    // it is removed by hand. CONTROL: `codex-restart-teardown-retry.test.ts`'s
    // arm "a failed /clear teardown keeps nothing" — option (a) turns it red.
    try {
      await this.teardownRuntime();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // D1.255 · C3.331's first half; `/clear` and `app-server` are names, not prose.
      if (!i18n.isInitialized) setupI18n();
      this.surfaceCodexOperatorNotice(i18n.t('chat.codexNotice.clearTeardownFailed', { detail }));
      this.debug(`codex teardown failed during clearHistory: ${detail}`);
    }
    super.clearHistory();
  }

  /**
   * P6.106 · codex's resumable anchor is the THREAD id — what `thread/resume`
   * takes, and what {@link CodexAgent.clearHistory} drops.
   *
   * `getSessionId()` is deliberately not used: this backend does not override
   * it, so it answers the base's `_sessionId` — the HOST session id, which
   * `thread/resume` would refuse.
   */
  protected override runtimeSessionAnchor(): string | null {
    return this.threadId;
  }

  protected override async adoptRuntimeSessionAnchor(sessionId: string): Promise<boolean> {
    this.resumeThreadId = sessionId;
    return true;
  }

  /**
   * P6.223 — a permission-mode change takes effect on the NEXT TURN, with no
   * respawn and no `CODEX_HOME` rebuild, which is what Pi and claude already do.
   *
   * ## What used to happen, and why it was not necessary
   *
   * This method set `pendingModeRestart` and `ensureRuntime` tore the runtime
   * down, because `config.toml` — where `approval_policy` and `sandbox_mode`
   * live — is read only when the app-server STARTS. Measured at HEAD, the mode
   * reaches codex by two other roads that need no restart:
   *
   *  1. **The filesystem half already rides the per-turn drift walk.**
   *     {@link applySelectedPluginSkillRuntimePolicy} runs before EVERY
   *     `turn/start`, builds `buildCodexRuntimeConfigOverride({ mode: … })` and
   *     re-forks the thread when the signature moves. A mode change moves it:
   *     the emitted profile's `extends` parent is `:read-only` for a read-only
   *     sandbox and, since F1.787, for plan and explore in both switch positions,
   *     else `:workspace` (`config-writer-permissions.ts`); F1.1003's plans/data grants follow the mode too. And the profile is what codex actually
   *     resolves — P6.149 measured a `[permissions.<profile>]` block emitted for
   *     every real session (10 filesystem keys, 9 workspace globs against the
   *     real credential floor; `false` for empty options as the control), with
   *     codex resolving `workspaceWrite` from it rather than from the written
   *     `sandbox_mode`.
   *  2. **The approval half now rides `turn/start`.** `approvalPolicy` is a
   *     declared per-turn override ("for this turn and subsequent turns") and it
   *     was the only piece of a mode change that a fork could not carry.
   *
   * ## Why `sandboxPolicy` is NOT sent, though the same params declare it
   *
   * `SandboxPolicy` is the legacy four-member union, and its `workspaceWrite`
   * member REQUIRES `writableRoots` plus `networkAccess`, `excludeTmpdirEnvVar`
   * and `excludeSlashTmp`. Sending it would mean restating, on every turn, four
   * values the config layer derives in one place — a second source of truth for
   * the sandbox, where getting `networkAccess` wrong is a silent widening. It
   * also cannot express a NAMED `[permissions.<name>]` profile at all, which is
   * the thing codex resolves. So the sandbox stays with the profile, on the road
   * that already carries it. `externalSandbox` remains unreachable for the
   * reason `CodexResolvedSandboxType` records: no mode of ours asks for it.
   *
   * ## The residue, stated rather than assumed away
   *
   * `config.toml` keeps the `approval_policy`, `sandbox_mode` and role set
   * written at spawn. The first two are outranked by the two roads above; the
   * ROLE set is not — `buildCodexAgentRoles` denies a role asking for a mode
   * stricter than the session's, so after a mid-session change the declared
   * roles are the ones the mode at SPAWN allowed. Neither direction can exceed
   * the session's own mode (a role's stricter ask was never enforced — see the
   * writer's `permissionMode` deny), so this is a stale declaration rather than
   * an escalation; re-deriving it needs a config rewrite, which is the cost this
   * row removed.
   *
   * An in-flight turn is untouched: the override lands on the NEXT `turn/start`,
   * which is the same boundary the old restart waited for.
   */
  override setPermissionMode(mode: import('./mode-types.ts').PermissionMode): void {
    super.setPermissionMode(mode);
    // F1.532 · after `super`, so the file holds the mode the change callback LEFT (a clamp may
    // rewrite it), and the projected floor hook sees a switch into or out of bypass at once.
    this.writeFloorHookState();
  }

  private async cleanupRuntimeResources(resources: {
    client: AppServerClient | null;
    manager: CodexRuntimeManager | null;
    adapter: AdapterHandle | null;
    callbackBridge: CodexSessionCallbackBridgeHandle | null;
    codexHome: string | null;
  }): Promise<void> {
    const failures: unknown[] = [];
    /**
     * P3.341 — every failure carries the NAME OF ITS STEP.
     *
     * T25 landed `flattenDisposalFailure` (depth 4) as the instrument for this
     * class and left the cause OPEN by design; it has never been used, and the
     * reason it could not be is here: the five steps pushed their callees' raw
     * errors, so a leaf read `EACCES: permission denied, rmdir '/var/…'` at best
     * and something unattributable at worst. One sitting on leg 6 with debug
     * logging on could not have said WHICH resource leaked.
     *
     * The wrapper keeps the callee's own message and adds `cause`, so nothing is
     * lost and the leaf now begins with the step. It changes no control flow:
     * the same `AggregateError` is thrown with the same arity, and the owner
     * decision recorded at that throw is untouched.
     */
    const failed = (step: CodexTeardownStep, error: unknown): void => {
      failures.push(new Error(
        `${CODEX_TEARDOWN_STEP_FAILURE_PREFIX}${step}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      ));
    };
    try {
      resources.client?.close();
    } catch (error) {
      failed('client', error);
    }
    try {
      await resources.manager?.kill();
    } catch (error) {
      failed('manager', error);
    }
    try {
      await resources.adapter?.close();
    } catch (error) {
      failed('adapter', error);
    }
    // After the app-server is dead, so the subprocess it spawned can never find
    // the bridge open with nothing behind it.
    try {
      await resources.callbackBridge?.close();
    } catch (error) {
      failed('callbackBridge', error);
    }
    if (resources.codexHome) {
      try {
        rmSync(resources.codexHome, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 50,
        });
      } catch (error) {
        failed('codexHome', error);
      }
    }
    if (failures.length > 0) {
      /**
       * P3.341 — AN OWNER DECISION SITS HERE. The lane measured; it did not
       * decide, and the two options are written out with their costs so the
       * sitting can.
       *
       * ## What this throw costs today
       *
       * `SessionManager` awaits `strictDrainSessionForMutation` inside a try
       * whose catch re-codes only `WORKTREE_DIRTY` and rethrows, so this
       * rejection SKIPS `clearRuntimeScopedSessionState` and the marker write:
       * the user's runtime switch is refused, and the session is left on codex.
       *
       * ## WHICH of the five steps can actually get here — measured at
       * `rust-v0.148.0`-era HEAD, by reading each callee rather than by
       * reproducing (T25's leaf log exists and has never been used, so the prior
       * had to be narrowed by code first):
       *
       *  1. `client.close()` — sync; `readline.close()` plus REJECTING the
       *     pending promises. It rejects OTHER promises; the only throw source
       *     is `readline.close()` itself. Structurally near-unable.
       *  2. `manager.kill()` — `new Promise(resolve => …)` with NO `reject`, so
       *     the only settled rejection is a SYNCHRONOUS throw inside the
       *     executor, which `child.kill('SIGTERM')` can do on EPERM. **This
       *     corrects the row's "resolve-only, cannot reject":** narrow, but real.
       *     Its broad failure is the other one — an unbounded `await` on a child
       *     that never exits HANGS.
       *  3. `adapter.close()` — `new Promise(r => server.close(() => r()))`.
       *     `server.close(cb)` passes an Error when the server was not open and
       *     that argument is DISCARDED, so this one truly cannot reject. It can
       *     hang on a held connection (it has no `closeAllConnections`, unlike
       *     the bridge below).
       *  4. `callbackBridge.close()` — same shape, plus a synchronous
       *     `closeAllConnections?.()` in the executor. Near-unable.
       *  5. `rmSync(codexHome, { recursive, force, maxRetries: 5 })` — `force`
       *     swallows ENOENT and `maxRetries` covers EBUSY/ENOTEMPTY/EPERM, so it
       *     throws on EACCES/ENOTDIR or after the retries are exhausted. P3.296
       *     measured a 1.6 MB WAL still being written into this directory.
       *     **This is the honest prior**, and step 2's EPERM the narrow second.
       *
       * ## OPTION A — keep the throw (today's behaviour)
       *
       * Cost: a teardown failure REFUSES the runtime switch. The user is told
       * the switch failed and stays on codex; nothing leaks, because the caller
       * treats the session as still live and can retry.
       * Argument for: `disposeForRestart`'s own docblock states this rejection
       * IS the contract SessionManager awaits — "must not publish the
       * replacement until the old app-server, adapter and managed CODEX_HOME are
       * fully gone". Totality here means no step can cancel another, not that
       * failures are swallowed.
       *
       * ## OPTION B — make a teardown failure non-fatal to the switch
       *
       * Shape: keep the per-step isolation, keep the leaf log, and let the
       * switch proceed with a durable operator notice naming the leaked
       * resource instead of an exception.
       * Cost, stated plainly: the switch would proceed over a possibly-leaked
       * app-server child (its loopback port with it) and a possibly-undeleted
       * per-session CODEX_HOME — which holds `sessions/**\/rollout-*.jsonl`, every
       * tool OUTPUT this session produced, at mode 0644 (see
       * `describeCodexRolloutPersistence`). Since the prior is step 5, Option B
       * is in practice "switch anyway and leave that directory on disk", which
       * is a data-retention posture rather than a robustness tweak.
       *
       * NOT A LANE'S CALL either way. The measurement above is the lane's whole
       * deliverable; `codex-teardown-failure-attribution.test.ts` forces each of
       * the five to throw and asserts the leaf is named, so whichever option is
       * chosen, WHICH step failed is already legible.
       */
      throw new AggregateError(failures, 'codex-runtime-cleanup-failed');
    }
  }

  /**
   * Kill child + adapter, then remove managed CODEX_HOME after handles close.
   *
   * P2.347 — the two FOREIGN calls in the prologue (`detachTurnSteers`, the
   * event adapter's terminal reset) are step-isolated, because everything that
   * actually releases an OS resource happens in `cleanupRuntimeResources` on the
   * last line. A throw above it skipped the whole cleanup while the field resets
   * had already erased the only references to the child, the adapter, the
   * callback bridge and the CODEX_HOME path — an unrecoverable leak, not a
   * retryable one. `cleanupRuntimeResources` is already per-step isolated and
   * ends in an `AggregateError`; this extends the same discipline one frame up.
   */
  private async teardownRuntime(keepUnreleased = false): Promise<void> {
    const resources = {
      client: this.client,
      manager: this.manager,
      adapter: this.adapter,
      callbackBridge: this.callbackBridge,
      codexHome: this.codexHome,
    };
    this.client = null;
    this.manager = null;
    this.adapter = null;
    this.callbackBridge = null;
    // Back to "no turn has started one" and NOT to `unavailable`: the next
    // `createRuntime` re-attempts the listen, so a torn-down session must not
    // report a failure it has not had yet. This is the line that makes the
    // state a property of the LIVE runtime rather than a latch.
    this.schedulingBridgeState = 'not-started';
    this.codexHome = null;
    this.forgetFloorHookState(); // F1.532/F1.609 · the state file and its build directory go with the runtime
    this.threadId = null;
    this.activeTurnId = null;
    this.runTeardownStep('codex turn steer detach', () => this.detachTurnSteers());
    this.runtimeConfigSignature = null;
    // P3.3 · a fresh app-server starts with an empty terminal set and re-probes
    // the capability. Forgetting our announced terminals here stops a stale id
    // from stranding a chip that can never be stopped, and lets the next runtime
    // discover a binary that now serves the method.
    this.runTeardownStep('codex background terminal reset', () => this.eventAdapter.resetBackgroundTerminals());
    this.backgroundTerminalsUnsupported = false;
    // P6.111 · parked chip events name terminals of the app-server being torn
    // down. Delivering them on the next runtime's first turn would announce
    // chips whose ids nothing can stop — the same stranding the reset above
    // exists to prevent.
    this.pendingBackgroundTerminalEvents = [];
    this.lastBackgroundTerminalRefreshAt = 0;
    // P3.28 · the recorded surface belongs to the app-server that is going away.
    // A fresh one re-derives it from the spec it writes, so keeping this would
    // let the first turn after a respawn compare against a dead process.
    this.sessionMcpAdvertisedArgs = null;
    await this.releaseRuntimeResources(resources, keepUnreleased); // F1.483 — a RESTART keeps what it could not release, for its retry
  }

  /**
   * Idle provider replacement must not publish the replacement until the old
   * app-server, adapter, and managed CODEX_HOME are fully gone. SessionManager
   * awaits this contract while transferring the logical lifecycle state.
   *
   * P2.347 — the SYNCHRONOUS prologue is step-isolated, and this is the method
   * that needed it rather than `destroy()`:
   * `SessionManager.disposeManagedAgentRuntime` prefers `disposeForRestart()`
   * whenever a backend defines one, so P2.333's belt landed on the path a
   * restart never takes. MEASURED before the fix, with a throwing
   * `stopConfigWatcher()`: the method rejected and `teardownRuntime` was never
   * even SCHEDULED — the app-server child, its loopback port, the adapter, the
   * callback bridge and the managed CODEX_HOME all survived the teardown, along
   * with a shared-pool elicitation registration and unsettled approvals. Worse
   * than a one-off leak, because `destroyed = true` was the FIRST statement:
   * `destroy()` opens with `if (this.destroyed) return`, so nothing could pick
   * the work up later. That ordering is corrected below as well.
   *
   * The ASYNC half deliberately keeps rejecting. `teardownRuntime`'s failure is
   * the contract SessionManager awaits ("must not publish the replacement until
   * … fully gone") and `disposeManagedAgentRuntime` collects it into the strict
   * `AggregateError` a quiescence owner acts on. Totality here means "no step
   * can cancel another", not "failures are swallowed".
   */
  async disposeForRestart(): Promise<void> {
    if (!this.runtimeDisposal) {
      // P6.271, the codex half — the notice claude has had, Pi gained in
      // `d4bf58cc3`, and codex said on no surface at all.
      //
      // The row recorded codex as `absent` — STRUCTURAL, and that verdict was
      // about the wrong direction. It is true of RECEIVING: `shutdown` appears
      // in exactly one of 562 generated v2 files (`CollabAgentStatus.ts`, a
      // spawned agent's status), so codex never TELLS us its worker is going.
      // But this signal is HOST-originated on codex exactly as it is on Pi — we
      // are the ones tearing the app-server down — so there is nothing to learn
      // and only something to say. Half (b) of the row (stating codex's
      // inability) stands as written: it is about the runtime-originated notice,
      // which still does not exist.
      //
      // GATED ON GRACEFUL TEARDOWN, which is the SDK's own contract for the
      // message being matched (`SDKWorkerShuttingDownMessage`, verbatim):
      // *"Emitted by the bridge on opt-in graceful worker teardown (only when
      // the teardown caller supplied a reason) … Absence is NOT a dead-host
      // signal: handoffs (/update, /teleport, respawn), auto-disable, mode
      // transitions, and internal fatal-error paths emit nothing by design."*
      // `destroy()` raises `teardownIsFinal` before it delegates here, so a
      // session that is ENDING stays silent and only a runtime REPLACEMENT
      // speaks — the same shape claude and Pi have.
      //
      // ORDER IS LOAD-BEARING, and differently from Pi's: it goes before the
      // `turnSink?.finish()` step below, because a finished sink accepts
      // nothing. `surfaceCodexOperatorNotice` is the runtime's own seam and
      // already answers the no-turn case (hold for the next turn) rather than
      // inventing a second queue beside it. Wrapped in `runTeardownStep` like
      // every other statement in this prologue: no step may cancel another.
      if (!this.teardownIsFinal) {
        this.runTeardownStep('codex restart worker notice', () =>
          // Claude's wording verbatim but for the runtime name
          // (`backend/claude/event-adapter.ts`: `Claude worker is shutting down
          // (<reason>).`), and Pi's reason token, so a user who switches
          // runtimes reads one sentence.
          this.surfaceCodexOperatorNotice('Codex worker is shutting down (runtime_restart).'));
      }
      this.runTeardownStep('codex restart config watcher', () => this.stopConfigWatcher());
      // `destroy()` reaches the base cleanup, but it opens with
      // `if (this.destroyed) return` and the latch below sets that — so once
      // disposal has run, destroy() can never release the registration. Release
      // it here, on the path SessionManager takes.
      this.runTeardownStep('codex restart elicitation surface', () =>
        this.releaseElicitationSurface('The session runtime restarted before the question was answered.'));
      this.runTeardownStep('codex restart pending approvals', () => this.denyPendingApprovals());
      this.runTeardownStep('codex restart turn sink', () => this.turnSink?.finish());
      const pendingSetup = this.runtimeSetup;
      this.runtimeDisposal = (async () => {
        // createRuntime owns transactional cleanup for resources not published
        // yet. Wait for that cleanup before tearing down published handles.
        await pendingSetup?.catch(error => {
          this.debug(`Codex runtime setup settled during disposal: ${error instanceof Error ? error.message : String(error)}`);
        });
        await this.teardownRuntime(true); // F1.483
      })();
      // THE LATCH GOES LAST, and it used to go first. `destroyed` is what makes
      // `destroy()` return without doing anything, so setting it before the work
      // it forbids retrying is what turned a skipped teardown into an
      // UNRECOVERABLE one: the pre-fix order left `destroyed = true` with
      // `runtimeDisposal` still unassigned, so the app-server child, its
      // loopback port and the managed CODEX_HOME had no second chance from any
      // caller.
      //
      // The belt above already closes the reachable case — none of those four
      // steps can throw past `runTeardownStep` any more — so this is
      // defence-in-depth rather than a second fix, and it is free: every
      // statement in this block is synchronous, and the only readers of
      // `destroyed` are `destroy()` and the checkpoints inside the async runtime
      // setup, which cannot resume before this block ends. Ordering, not timing.
      this.destroyed = true;
    }
    await this.settleRuntimeDisposal(); // F1.483 — forgets a FAILED teardown so the next call retries it; a successful one stays memoised
  }

  override destroy(): void {
    if (this.destroyed) return;
    this.runTeardownStep('codex quota abort', () => this.nessyGatewayQuota.abort());
    // P6.271 — FIRST, before anything below can reach `disposeForRestart()`.
    // This is the final teardown, not a restart, so the worker notice stays
    // unsaid: claude's own contract keeps its internal end-of-life paths silent
    // and there is no session left to read the sentence.
    this.teardownIsFinal = true;
    // P2.303 · `endLifecycle` awaits the memoised Stop promise and emits
    // `SessionEnd`; both reach `emitAutomationEvent`, which rejects whenever its
    // own `onError` handler throws (the handler calls `this.debug`, and `debug`
    // ends in the HOST's `onDebug`). `destroy()` is sync and cannot await, so the
    // handler goes here — the sibling call two lines down already had one.
    void this.endLifecycle()
      .catch((error: unknown) => this.reportDetachedFault('Session lifecycle end', error));
    super.destroy();
    // P2.333 — `super.destroy()` is total, and so is the tail after it: this
    // class does NOT belt `debug` (only `PiAgent` does), so a host sink that
    // throws could otherwise escape `destroy()` from the rejection handler's own
    // interpolation before the detached cleanup was ever started.
    this.runTeardownStep('codex runtime disposal', () => {
      void this.disposeForRestart().catch(error => {
        this.reportDetachedFault('Codex runtime cleanup', error);
      });
    });
  }

  /**
   * F1.191 + F1.196 · `script_sandbox`'s read policy for codex's session-MCP
   * child, which cannot resolve it: the child's `HOME` is the host's LIVE one
   * (codex-rs `create_env_for_mcp_server` passes `HOME` through from the
   * app-server's environment) and its `NESSY_CONFIG_DIR` never arrives, so on
   * claude and Pi `createClaudeContext` binds these as accessors and here the
   * host says them — `CodexSandboxReadArgs` in `session-mcp-server/src/index.ts`
   * carries the codex-rs reading and the child's parse.
   *
   * Classified in {@link buildSessionMcpSpec}'s §"The argv classification":
   * `--credential-home` is FIXED (the latch never moves); the fence flag and the
   * roots are SETTING, so an edited `deniedPaths` re-spawns the child through the
   * turn-head argv comparison instead of waiting for the next runtime.
   *
   * The fence flag is written ALWAYS, carrying its value, because its presence
   * is what tells the child the host declared a policy at all — an empty policy
   * and an undeclared one print different receipts. The roots are the SAME
   * resolution claude and Pi read ({@link resolveSessionToolSandboxReadFloor});
   * its partial projection and its diagnostics are that function's to state.
   */
  private codexSandboxReadFloorArgs(): string[] {
    const floor = resolveSessionToolSandboxReadFloor(this.config.workspace.workspaceRootPath);
    return [
      '--credential-home',
      latchedHomeDir(),
      '--sandbox-reads-fenced',
      String(floor.readsFencedToWorkingDirectory),
      ...floor.deniedReadRoots.flatMap((root) => ['--sandbox-denied-read-root', root]),
    ];
  }

  /**
   * F1.227 (origin WJ-l P-WJ-l-4) — F1.113 + F1.228's card on codex: an
   * `automation_update` that changes WHAT or WHEN an automation stored above the
   * model-facing ceiling runs unattended is a FLOOR here, so it reaches a person
   * and cannot be remembered, exactly as the claude/Pi gate's
   * `unattendedAutomationEdit` class does.
   *
   * ## What codex's source says reaches us (read at `rust-v0.154.0`)
   *
   * `core/src/mcp_tool_call.rs`: an MCP tool call that needs approval (our
   * session tools carry no `readOnlyHint`, and the default `AppToolApproval` is
   * `Auto`) is sent as `mcpServer/elicitation/request` whenever the feature
   * `tool_call_mcp_elicitation` is on — `Stage::Stable`, `default_enabled: true`
   * in `features/src/lib.rs` — with `_meta.codex_approval_kind =
   * "mcp_tool_call"` and `_meta.tool_params` carrying the call's ARGUMENTS
   * (`build_mcp_tool_approval_elicitation_meta`; key names from
   * `protocol/src/mcp_approval_meta.rs`). So the rule reads the real patch.
   *
   * ## What does NOT reach us, stated
   *
   * - A remembered "Allow for this session": codex keys it by server + tool and
   *   answers later calls itself (`mcp_tool_approval_is_remembered`), but it
   *   records one only when OUR accept carries `_meta.persist`, and ours never
   *   does (`buildElicitationResponse` answers `{action, content}`; the card is
   *   `noAlwaysAllow`). So that path cannot open.
   * - `approvals_reviewer = "auto_review"` (P3.2, setting-gated, default OFF):
   *   codex's guardian answers before any request is sent. With that setting on,
   *   the card is codex's reviewer's call, not a person's — the residue this
   *   floor cannot reach; F1.233 read why at the pinned tag, and the toggle says so.
   *
   * ## Uniform with claude and Pi
   *
   * `bypassPermissions` skips it (the gate skips it there too, as it skips the
   * worktree floor), `dontAsk` refuses it (the bridge's existing branch), and an
   * unattended turn refuses it even with the operator's `allow` escape hatch
   * open, because a floor turns that fallback into a refusal. The sentence is the
   * gate's own (`describeUnattendedAutomationEdit`) and the rule is one call.
   * Identified by the server name and the ARGUMENT SHAPE (`automationId` +
   * `patch`, which only `automation_update` takes), not by codex's message
   * wording, which is a template that can change.
   */
  private unattendedAutomationEditFloor(
    kind: ApprovalKind,
    params: unknown,
    mode: ReturnType<CodexAgent['getPermissionMode']>,
  ): NonNegotiableFloorVerdict | null {
    if (kind !== 'elicitation' || mode === 'bypassPermissions') return null;
    const request = params && typeof params === 'object' ? params as Record<string, unknown> : {};
    const meta = request._meta && typeof request._meta === 'object' ? request._meta as Record<string, unknown> : {};
    if (request.serverName !== 'session' || meta.codex_approval_kind !== 'mcp_tool_call') return null;
    const toolParams = meta.tool_params && typeof meta.tool_params === 'object'
      ? meta.tool_params as Record<string, unknown>
      : undefined;
    if (!toolParams) return null;
    const edit = unattendedAutomationEdit(
      'mcp__session__automation_update',
      toolParams,
      this.config.workspace.workspaceRootPath,
    );
    return edit
      ? { outcome: 'prompt', floor: 'unattendedAutomationEdit', description: describeUnattendedAutomationEdit(edit) }
      : null;
  }

  /**
   * F1.220 — withdraw a question dialog the ask-user bridge settled without an
   * answer (an MCP server's elicitation or the model's own
   * `item/tool/requestUserInput`), on the turn it was raised in — the same sink
   * {@link denyPendingApprovals} withdraws codex's own approval cards through
   * (F1.170). With no turn in flight the base hands it to the host's out-of-turn
   * channel (F1.369, F1.479), and says so only when no host is wired.
   */
  protected override withdrawElicitationDialog(requestId: string): void {
    if (this.turnSink) {
      this.turnSink.push({ type: 'permission_request_cancelled', requestId });
      return;
    }
    super.withdrawElicitationDialog(requestId);
  }

  /**
   * F1.234 (origin WJ-l P-WJ-l-7) — `explore` and `plan` REFUSE a
   * session-configuration tool on codex, with the sentence claude and Pi refuse
   * it with, instead of putting a card in front of the person.
   *
   * ## The divergence this closes
   *
   * On claude and Pi the pre-tool gate's first step is `shouldAllowToolInMode`
   * (`core/pre-tool-use.ts`), and for a `mcp__session__*` tool outside
   * `SESSION_SAFE_ALLOWED_TOOL_NAMES` in a read-only mode it answers
   * `allowed: false` with *"Session configuration changes are blocked in
   * Explore. …"* (`mode-manager.ts`). Codex never runs that gate: the call
   * reaches this host as codex's own MCP tool-call approval (`core/src/
   * mcp_tool_call.rs` at `rust-v0.154.0` asks for every tool without
   * `readOnlyHint`, and codex's explore/plan config is `on-request`), and the
   * bridge carded it — so a read-only mode ASKED on one runtime and REFUSED on
   * two. The verdict here is that same call with the same merged permissions
   * context the bridge's other consults build, so a change to the mode block
   * moves all three runtimes at once; nothing codex-shaped is re-implemented.
   *
   * ## Scope, and what does not reach anyone, stated
   *
   * - The session server and the pool (`sources`) server, named by codex's own
   *   frame (`serverName`), the tool read by `codexMcpToolCallRowName` from
   *   codex's fixed sentence and then shifted into the name Pi records by
   *   `hostMcpToolNameForCodexRow` (F1.272) — so a pool write tool is refused
   *   with Pi's own *"MCP write operations are blocked in …"* (F1.374), and a
   *   pool tool the workspace marks read-only (`allowedMcpPatterns`) keeps its
   *   card exactly as it passes the mode block on Pi.
   * - F1.373: while auto-review is on, explore and plan turns carry
   *   `approvalsReviewer: 'user'`, so these approvals reach this method at all
   *   instead of being answered by codex's reviewer first.
   * - The answer is a `decline`, and codex tells its model the fixed *"user
   *   rejected MCP tool call"* — the elicitation response has no reason channel
   *   at the pinned tag (`parse_mcp_tool_approval_elicitation_response`). The
   *   sentence reaches the debug log; `PermissionDenied` is not minted, because
   *   Pi never mints it for an ordinary gate block
   *   ({@link emitCodexPermissionDeniedHook}).
   * - It sits above the rule consult, the unattended fallback and the card —
   *   the gate's order, where the mode block is step one — so neither a turn
   *   with nobody watching nor the operator's `allow` escape hatch can accept
   *   what the mode refuses. A tool rule that makes `shouldAllowToolInMode`
   *   answer `allowed: true` is honoured here exactly as on Pi.
   *
   * Fails OPEN, for {@link floorVerdict}'s reason: an evaluator that could throw
   * on the approval bridge would be a denial of service on every turn; a defect
   * here degrades to the card, which is the pre-row behaviour, and is logged.
   */
  private readOnlyModeSessionToolRefusal(kind: ApprovalKind, params: unknown): Record<string, unknown> | null {
    const mode = this.getPermissionMode();
    if (kind !== 'elicitation' || mode !== 'plan') return null; // F1.1050: explore retired
    try {
      const request = isPlainRecord(params) ? params : {};
      const meta = isPlainRecord(request._meta) ? request._meta : {};
      if (request.serverName !== 'session' && request.serverName !== 'sources') return null;
      const rowName = codexMcpToolCallRowName(request, meta);
      if (!rowName) return null;
      const toolName = hostMcpToolNameForCodexRow(rowName); // F1.374 — Pi's name for a pool tool
      const input = isPlainRecord(meta.tool_params) ? meta.tool_params : {};
      const permissionsContext: PermissionsContext =
        this.permissionManager.getCapabilityPermissionsContext?.() ?? {
          workspaceRootPath: this.config.workspace.workspaceRootPath,
          activeSourceSlugs: Array.from(this.sourceManager.getActiveSlugs()),
          projectTrusted: this.config.projectTrusted === true,
        };
      const verdict = shouldAllowToolInMode(toolName, input, mode, { permissionsContext });
      if (verdict.allowed) return null;
      const why = verdict.reason ?? `${toolName} is blocked in the ${mode} permission mode.`;
      this.debug(`codex approval refused by the ${mode} permission mode (${toolName}): ${why}`);
      return buildApprovalResponse(kind, params, false, undefined, this.reportDegradedApproval, why);
    } catch (error) {
      this.debug(
        'codex read-only mode evaluation failed, the card decides: '
        + `${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * F1.693 (WJ-crit-p, 2026-09-25) — Nessy's DATA FOLDER as a floor on this bridge, in
   * EVERY mode, `bypassPermissions` included: a patch (v2 `fileChange`, v1
   * `fileChangeV1`) whose file is one of the control places
   * {@link codexDataFolderControlTarget} names, and a `permissions` write grant over one,
   * are refused with a named reason before the rule consult, the unattended fallback,
   * the bypass yes and the card.
   *
   * MEASURED before this existed (`work/wjcritp/f1693-probe.ts`, the shipped
   * rust-v0.156.1, the product's config writer in `bypassPermissions` with the
   * `nessy_runtime` profile a real session always carries): an `apply_patch` adding
   * `<config>/mcp.json`, the relocated home's `rules/agent.rules` (F1.652's defeat, one
   * `thread/fork` later) and another workspace's `hooks.json` each raised
   * `item/fileChange/requestApproval`; this bridge answered `accept` ("auto-allowed by
   * the bypassPermissions mode") and codex wrote all three — it applies an approved
   * patch itself, outside the profile. A `require_escalated` SHELL write to the same
   * targets was accepted too and refused by the OS (`operation not permitted`) — but only
   * while the profile denied a read: since F1.1057 a default session's approved escalation
   * runs outside codex's sandbox, so F1.717 judges commands here too, with the records
   * guard's own resolver ({@link codexShellCommandOverDataFolderControl}, at the file end).
   *
   * Every mode, not only bypass: codex's own profile already makes the four workspace
   * records read-only, and the global control records bind every mode on Pi and claude
   * (F1.701), so a card that could approve them here would be the one divergent door.
   * A patch whose paths codex has not announced yet (`[]`, C3.386) is not judged here, and since F1.719
   * nothing on the bridge answers it yes either ({@link codexPatchUnnamed}); a thrown evaluator fails open.
   */
  private dataFolderControlRefusal(kind: ApprovalKind, params: unknown): Record<string, unknown> | null {
    try {
      const workspaceRoot = this.config.workspace.workspaceRootPath;
      const p = isPlainRecord(params) ? params : {};
      let hit: { path: string; entry: string } | null = null;
      if (kind === 'fileChange' || kind === 'fileChangeV1') {
        const paths = kind === 'fileChange'
          ? this.codexFileChangeApprovalPaths(params)
          : (isPlainRecord(p.fileChanges) ? Object.keys(p.fileChanges).map(path => resolvePath(this.workingDirectory, path)) : []);
        for (const path of paths) {
          const entry = codexDataFolderControlTarget(path, workspaceRoot);
          if (entry) { hit = { path, entry }; break; }
        }
      } else if (kind === 'permissions') {
        hit = codexWriteGrantOverDataFolderControl(params, workspaceRoot);
      } else if (kind === 'command' || kind === 'commandV1') hit = codexShellCommandOverDataFolderControl(kind, params, this.workingDirectory, workspaceRoot); // F1.717
      if (!hit) return null;
      const why = `Denied by the data-folder floor (F1.693): ${hit.path} is ${hit.entry} in Nessy's data folder `
        + `(${CONFIG_DIR}), which an agent may not write in any permission mode — change it from Nessy itself.`;
      this.debug(`codex approval refused by the data-folder floor (F1.693): ${why}`);
      return buildApprovalResponse(kind, params, false, undefined, this.reportDegradedApproval, why);
    } catch (error) {
      this.debug(
        'codex data-folder floor evaluation failed, no refusal applied: '
        + `${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * F1.384 (origin the WJ-hh verifier on F1.274) — the `tool_input` of codex's
   * AUTO-REVIEW `PermissionDenied`. For an MCP call it is the call's own
   * arguments, as Pi's guardian denial sends them (`canonicalInput`): the
   * review's `action` names the call but carries none
   * (`GuardianApprovalReviewAction`'s `mcpToolCall` arm), and codex emits the
   * item's `item/started` — `arguments` included — BEFORE it asks for approval
   * (`core/src/mcp_tool_call.rs` at `rust-v0.156.1`: `notify_mcp_tool_call_started`
   * precedes `maybe_request_mcp_tool_approval`), so the input the adapter's
   * `tool_start` recorded under the review's `targetItemId`
   * ({@link noteCodexToolCallForHooks}) is exactly that. Every other action, and
   * an MCP review whose target was never started or is not named, keeps the
   * action as before — nothing is invented. The dontAsk half is F1.371's.
   */
  private codexReviewDeniedToolInput(action: unknown, params: unknown): Record<string, unknown> {
    const recorded = (action && typeof action === 'object' ? action : {}) as Record<string, unknown>;
    if (recorded.type !== 'mcpToolCall') return recorded;
    const target = (params as { targetItemId?: unknown } | null | undefined)?.targetItemId;
    const started = typeof target === 'string' && target ? this.codexToolCallInputs.get(target) : undefined;
    return started ? { ...started.input } : recorded;
  }

  /**
   * F1.373 — the reviewer the `config.toml` this runtime was started with carries: `'auto_review'` when the
   * writer emitted `approvals_reviewer = "auto_review"`, `undefined` when it emitted none (the toggle off, or a
   * `never` policy at the write). Set at the one config write, read by every `turn/start` ({@link codexTurnApprovalsReviewer}).
   */
  private configuredApprovalsReviewer: 'auto_review' | undefined = undefined;
  /**
   * F1.781 — the Settings toggle, re-read at every `turn/start` and floor-hook state write, so turning it OFF
   * reaches a live session (the turn asks for `'user'`, the floor hook steps aside). Turning it ON reaches the next
   * codex session only: F1.386's floor hook and `[auto_review].policy` exist only in a config written with it on.
   */
  private autoReviewSettingOn: () => boolean = getCodexAutoReviewEnabled;

  /** F1.373 — records whether the config being written carries the reviewer, through the writer's own gate
   * ({@link codexConfigEmitsAutoReview}) over the write's mode and sandbox switch; the options pass through unchanged. */
  private noteConfiguredApprovalsReviewer<T extends { approvalsReviewer?: 'auto_review' }>(options: T): T {
    const policy = codexSandboxConfigForMode(this.getPermissionMode(), this.sandboxGloballyEnabled()).approval_policy;
    this.configuredApprovalsReviewer = codexConfigEmitsAutoReview(options.approvalsReviewer, policy)
      ? 'auto_review'
      : undefined;
    return options;
  }

  /**
   * F1.482 (1) — the administrator's `allowed_approvals_reviewers`, as the
   * running app-server reported it on `configRequirements/read` (normalised by
   * {@link codexManagedApprovalsReviewers}); `undefined` when nothing is managed
   * or the read failed. Read by every `turn/start` through
   * {@link codexTurnApprovalsReviewer}, and by the refusal wording in
   * {@link codexTurnStartRefusalMessage}.
   */
  private managedApprovalsReviewers: readonly ('user' | 'auto_review')[] | undefined = undefined;

  /**
   * F1.589 — what the last `configRequirements/read` said a managed
   * `model_provider` / `model_providers` does to the provider this session
   * configured; `undefined` when it moves nothing, or when the read did not
   * answer. Written by {@link recordManagedApprovalsReviewers}, read by
   * {@link refuseManagedModelProviderRedirect}.
   */
  private managedModelProviderRedirect: CodexManagedModelProviderRedirectV1 | undefined = undefined;

  /**
   * F1.482 (1) — the requirements channel, recording the reviewer list on the way
   * through. The field is ts-rs-dropped from the generated bindings but IS on
   * the wire (`CODEX_EXPERIMENTAL_REQUIREMENT_GATES`; measured 2026-09-24 on the
   * shipped 0.154.0: `allowedApprovalsReviewers: ["auto_review"]`), so the probe's
   * own read is the one place it arrives — no second request, no second clock.
   * A failed read records no list, which is F1.373's wire.
   *
   * When the list leaves out `user`, codex starts the thread with the administrator's
   * reviewer and says nothing (measured with the toggle off: no `configWarning`), so the
   * host says it once — and, F1.1198, with the toggle on too, where Manual, Accept edits and
   * Don't ask want `'user'` and keep the reviewer instead. The opposite case — the toggle on
   * under a list without `auto_review` — needs no second sentence: codex's own `configWarning`
   * ("falling back to required value User") already reaches the transcript.
   *
   * F1.514 — and the same answer is REMEMBERED, in-process and on disk
   * (`recordAndPersistCodexManagedApprovalsReviewers`, the F1.101 shape), so the
   * NEXT runtime build projects F1.386's floor hook when the list leaves out
   * `user` ({@link unattendedAutomationFloorHookProjection}). Only the RESOLVED
   * arm writes it: a resolved read is an answer (the probe reads it as `read` or
   * `none`, never `failed`), and a rejection — a timeout, a refusal — writes
   * nothing, so the last known list stands (P2.137's rule). A session whose own
   * build projected no hook says so in the notice above, because in it the
   * reviewer answers a change the floor would refuse.
   *
   * F1.611 — and the mirror: the toggle ON while the REMEMBERED list left out
   * `auto_review` (an older `["user"]`) projected no hook, so when this read
   * finds the policy withdrawn, widened or now requiring the reviewer
   * ({@link codexFloorHookReviewerAnswers}), the reviewer answers this whole
   * session with no floor in front of it. The answered read has refreshed the
   * cache for the next build, and this build says the gap once. A read that did
   * not answer says nothing: the list is then unknown (P2.137).
   */
  private recordManagedApprovalsReviewers(channel: CodexRequestChannel): CodexRequestChannel {
    return {
      request: async (method, params, options) => {
        let result: unknown;
        try {
          result = await channel.request(method, params, options);
        } catch (error) {
          this.managedApprovalsReviewers = undefined;
          this.managedModelProviderRedirect = undefined;
          throw error;
        }
        const declaredProvider = this.declaredCodexModelProvider();
        this.managedModelProviderRedirect = codexManagedModelProviderRedirect(result, {
          provider: declaredProvider ?? CODEX_PROVIDER_KEY,
          hostDefined: !declaredProvider,
        });
        const managed = codexManagedApprovalsReviewers(result);
        this.managedApprovalsReviewers = managed;
        if (!recordAndPersistCodexManagedApprovalsReviewers(managed)) {
          this.debug('[managed] F1.514: the codex allowed_approvals_reviewers list could not be cached; the next '
            + 'launch decides the automation floor hook from whatever the host has at boot');
        }
        if (managed && !managed.includes('user')) { // F1.1198 — toggle ON too: Manual, Accept edits, Don't ask want 'user', which the list forbids (codexTurnApprovalsReviewer)
          const toggleOn = this.configuredApprovalsReviewer === 'auto_review'; // with it on, F1.611's own notice names a missing floor hook
          const floorGap = this.projectedHostHookCommands.length > 0 || toggleOn ? '' : ' This session started before the app knew this policy, so the app\'s unattended-automation floor does '
              + 'not hold in this session: the reviewer may approve a change to what an unattended automation does or '
              + 'when it runs. Codex sessions started from now on refuse such a change before the reviewer is asked.';
          const who = toggleOn ? 'auto-review reviewer: in Manual, Accept edits and Don\'t ask too, which otherwise ask you or refuse, the reviewer — not you — answers the approvals this session escalates, so in Don\'t ask it may approve what that mode would refuse.'
            : 'auto-review reviewer: although auto-review is off in Settings, the reviewer — not you — answers the approvals this session escalates.';
          this.surfaceCodexOperatorNotice(
            `Your organisation's Codex policy (allowed_approvals_reviewers: ${managed.join(', ')}) requires Codex's `
            + who + ' Plan cannot run on Codex under this policy, because a '
            + `read-only mode is never handed to a reviewer; every other mode runs.${floorGap}`,
          );
        }
        // F1.611 — the mirror of the gap above: the toggle on, the REMEMBERED list kept the hook out, and this live
        // read lets the reviewer answer after all. The read has just refreshed the cache, so the next build projects
        // the hook; this build says so, once. See the docblock.
        const withheldBy = this.floorHookWithheldByRememberedList;
        if (withheldBy && codexFloorHookReviewerAnswers(codexManagedListRequiresReviewer(managed),
          this.configuredApprovalsReviewer, this.autoReviewSettingOn(), managed)) {
          this.floorHookWithheldByRememberedList = undefined;
          const notice = 'Codex\'s auto-review reviewer answers the approvals this session escalates, but this session '
            + 'started while the app still remembered an older Codex policy from your organisation '
            + `(allowed_approvals_reviewers: ${withheldBy.join(', ')}) that kept the reviewer out, so the app's `
            + 'unattended-automation floor does not hold in this session: the reviewer may approve a change to what an '
            + 'unattended automation does or when it runs. Codex sessions started from now on refuse such a change '
            + 'before the reviewer is asked.';
          this.surfaceCodexOperatorNotice(notice);
          this.debug(`[managed] F1.611: ${notice}`);
        }
        // F1.516 (1) — an administrator's `allow_managed_hooks_only` keeps codex from loading the floor hook this
        // runtime projected, and the trust pass (which runs first) could only say "could not be trusted". The
        // requirement read here is the cause, so the session fact now names it. See the notice's docblock.
        if (this.projectedHostHookCommands.length > 0 && codexRequirementsAllowManagedHooksOnly(result)) {
          this.recordSessionFact('codex-hooks-projection', CODEX_AUTOMATION_FLOOR_HOOK_MANAGED_ONLY_NOTICE);
          this.debug(CODEX_AUTOMATION_FLOOR_HOOK_MANAGED_ONLY_NOTICE);
        }
        return result;
      },
    };
  }

  /**
   * F1.589 — refuse to open a thread on a model provider this app did not
   * configure.
   *
   * Measured on the shipped 0.156.1 (`codex-managed-model-provider.test.ts`): a
   * managed `model_provider` naming another key, or a managed table under OUR
   * key, sends every request of the session to the administrator's provider, and
   * the second does it with no warning while `thread/start` still reports our
   * key. Called once, straight after the requirements probe and before
   * `thread/start` — so the refusal lands before anything is sent, and the
   * user's first prompt never reaches a provider they did not pick. Refuse, not
   * warn: the decision and its reason are on
   * {@link formatCodexManagedModelProviderRefusal}.
   *
   * THE RESIDUE, said aloud: a read that did not answer (timeout, refusal)
   * leaves {@link managedModelProviderRedirect} `undefined`, so this check passes
   * — the same "we do not know" the other requirement readers take (P2.137).
   * F1.634 then compares the provider codex reports for the opened thread with
   * ours ({@link codexOpenedModelProviderRefusal}); the same-key table stays invisible.
   */
  private refuseManagedModelProviderRedirect(): void {
    const redirect = this.managedModelProviderRedirect;
    if (!redirect) return;
    const message = formatCodexManagedModelProviderRefusal(redirect);
    this.debug(`[managed] F1.589: ${message}`);
    throw new Error(message);
  }

  /**
   * F1.386 — the command lines of the host-authored hooks this runtime build
   * projected, which {@link trustProjectedHostHooks} trusts and nothing else.
   */
  private projectedHostHookCommands: string[] = [];

  /**
   * F1.611 — the remembered administrator list that kept this build's floor hook
   * out with the Settings toggle ON (a list that leaves out `auto_review`, so
   * F1.532's "who answers" arm hands the approvals to the user); `undefined`
   * otherwise. Set by {@link unattendedAutomationFloorHookProjection}; read and
   * cleared by {@link recordManagedApprovalsReviewers}, which says the gap once
   * when the live read lets the reviewer answer after all.
   */
  private floorHookWithheldByRememberedList: readonly string[] | undefined = undefined;

  /**
   * F1.386 (DECIDED 2026-09-23) — the unattended-automation floor as a
   * `PermissionRequest` hook, projected ONLY when codex's reviewer will answer
   * this runtime's approvals: the config being written carries
   * `approvals_reviewer = "auto_review"` (read off
   * {@link configuredApprovalsReviewer}, which the same write set a few keys
   * earlier), OR — F1.514 — the administrator's `allowed_approvals_reviewers`
   * the last answered probe reported leaves out `user`
   * ({@link codexManagedListRequiresReviewer}), in which case codex takes the
   * reviewer whatever the toggle says and every non-read-only turn asks for
   * nothing ({@link codexTurnApprovalsReviewer}). Without a reviewer this host
   * is asked, and {@link unattendedAutomationEditFloor} already answers; with
   * one, codex asks its hooks first, so the hook is the one place the floor can
   * still refuse. The command is the session MCP server's own entry point with
   * `--permission-request-hook` — the same binary and script codex already runs
   * for `[mcp_servers.session]`. See `backend/codex/automation-floor-hook.ts`.
   *
   * The list is the one REMEMBERED before this build
   * (`getCodexManagedApprovalsReviewers`: restored at bootstrap, refreshed by
   * every answered probe), because `config.toml` is written before the
   * app-server that answers the probe exists — so the first session after a
   * policy lands runs without the hook, and says so
   * ({@link recordManagedApprovalsReviewers}). A list that ALLOWS `user`
   * projects nothing: every turn then asks for `'user'` explicitly, so this host
   * is asked. F1.516 (1), measured on the MDM rig at `rust-v0.154.0` and
   * `rust-v0.156.1`: a requirement that ALSO sets `allow_managed_hooks_only`
   * keeps codex from loading this hook at all (`hooks/list` omits it, with no
   * warning — this app writes codex's USER layer), so the reviewer answers such
   * a change; {@link recordManagedApprovalsReviewers} says so once it reads the
   * requirement.
   *
   * F1.532 — two more things decide it, both found by the 1.41.0 review:
   *
   * - **Who answers.** The toggle on under a remembered list that leaves out
   *   `auto_review` is NOT a reviewer session: every turn then asks for nothing
   *   and codex falls back to the user ({@link codexTurnApprovalsReviewer}), so
   *   this host is asked and {@link unattendedAutomationEditFloor} cards a
   *   person. Projecting the hook there refused the edit before anyone could be
   *   asked, so it is projected only when the reviewer answers. A remembered
   *   list gone stale that way leaves one build without the hook while the
   *   reviewer answers; F1.611 — {@link recordManagedApprovalsReviewers} says so.
   * - **The session's mode.** `bypassPermissions` skips the floor on every
   *   runtime ({@link unattendedAutomationEditFloor}, and the Pi/claude gate), but
   *   a mode change does not respawn codex (P6.223) and codex's hook payload
   *   cannot say bypass (`hook_permission_mode` names it for policy `never`
   *   only). So a runtime build (one with a `codexHome`) names a state file on
   *   the command line, which {@link writeFloorHookState} writes now, on every
   *   {@link CodexAgent.setPermissionMode} and before every `turn/start`; the
   *   hook gives no verdict in bypass and fails closed on a file it cannot read.
   *   The file also says whether the remembered list requires the reviewer, so
   *   the refusal names that policy instead of the Settings toggle. Built without
   *   a `codexHome` (no runtime directory) the command is F1.386's own.
   *
   * F1.609 — and the hook trusts that file only because of WHERE it is, so it
   * is never in `codexHome`: that was a `mkdtemp` under `$TMPDIR` (and still is when
   * F1.652's relocation falls back), which an agent command writes with no card, so one
   * `printf` turned the floor off (measured on the shipped binary). It goes in
   * a per-build directory under the host's config directory, and only when no
   * root the profile lets an agent write covers it
   * ({@link newFloorHookStateFile}); otherwise none is named, and the hook keeps
   * the floor in every mode, which the session says.
   */
  private unattendedAutomationFloorHookProjection(codexHome?: string): CodexHostAuthoredHooksPlan | undefined {
    this.projectedHostHookCommands = [];
    this.forgetFloorHookState();
    const remembered = getCodexManagedApprovalsReviewers();
    const reviewerAnswers = codexManagedListRequiresReviewer(remembered)
      || (this.configuredApprovalsReviewer === 'auto_review' && (remembered === undefined || remembered.includes('auto_review')));
    // F1.611 — the toggle on and no hook: only the remembered list (one without `auto_review`) kept it out.
    this.floorHookWithheldByRememberedList = !reviewerAnswers && this.configuredApprovalsReviewer === 'auto_review' ? remembered : undefined;
    if (!reviewerAnswers) return undefined;
    const paths = getBackendRuntime(this.config).paths;
    const sessionServer = paths?.sessionServer;
    const workspaceRoot = this.config.workspace.workspaceRootPath;
    if (!sessionServer || !workspaceRoot) return undefined;
    const node = paths?.node ?? process.execPath;
    const stateFile = codexHome ? this.newFloorHookStateFile() : undefined; // F1.609 · never inside codexHome
    this.floorHookStateFile = stateFile ?? null;
    this.writeFloorHookState();
    this.projectedHostHookCommands = [codexAutomationFloorHookCommand(node, sessionServer, workspaceRoot, stateFile)];
    return codexAutomationFloorHookPlan(node, sessionServer, workspaceRoot, undefined, stateFile);
  }

  /**
   * F1.532 — the floor hook's state file for this runtime build, or `null` when
   * no hook was projected, the build had no `codexHome`, or (F1.609) no
   * directory outside every agent-writable root could be had.
   */
  private floorHookStateFile: string | null = null;

  /** F1.609 — the per-build directory holding {@link floorHookStateFile}; removed with its runtime (F1.654: after a crash, by a later build's sweep). */
  private floorHookStateBuildDir: string | null = null;

  /**
   * F1.609 — where the per-build state directories go: the host's own config
   * directory, which {@link newFloorHookStateFile} accepts only when no
   * agent-writable root covers it, or (F1.704) when F1.664's read-only projection
   * of the config dir keeps agent commands out of it there, as for
   * {@link codexHomeRoot}. A field so a rig can point it elsewhere.
   */
  private floorHookStateRoot: string = join(CONFIG_DIR, CODEX_FLOOR_HOOK_STATE_ROOT);

  /**
   * F1.609 — every root the session's codex permission profile lets an agent
   * COMMAND write with no card: the profile extends `:workspace` — the cwd plus
   * `$TMPDIR` and `/tmp` (`CODEX_BOUNDED_APPROVAL_NOTICE`: codex's own defaults,
   * `exclude_tmpdir_env_var` and `exclude_slash_tmp` both false; codex inherits
   * this process's `TMPDIR`) — and grants each added directory
   * ({@link codexAdditionalWritableRoots}). Read at the runtime build; a plugin
   * skill's per-turn data directory is not in it (they live under the plugin
   * data directory, beside this one, never above it).
   */
  private codexAgentWritableRoots(): string[] {
    return [this.workingDirectory, tmpdir(), '/tmp', ...this.codexAdditionalWritableRoots()].filter(Boolean);
  }

  /**
   * F1.670 — the host's EXACT read-only paths for codex's permission profile (the writer's
   * `readOnlyPaths`, codex's own absolute `read` key): F1.659's guarded workspace records
   * whenever an added directory ({@link codexAdditionalWritableRoots}), or a cwd path through a
   * folder named exactly `~` (F1.927), covers them and the cwd's `":workspace_roots"` `read`
   * entries do not — F1.696 widens that predicate: the cwd or an added root covers them by real
   * path as well as as written, the cwd counting as a coverer, and a root reached through a
   * symlink keeps its keys even when the cwd's `read` subpaths DO carry them
   * ({@link codexWorkspaceRecordDenyPaths}); and (F1.678) F1.664's absolute key on
   * the config dir ({@link configDirProjection}). `read`, no longer `deny`: an agent command's
   * write is still refused there and its read now works (measured, see the
   * {@link codexWorkspaceRecordDenyPaths} docblock). One method for the four builders — the
   * config, the turn-head seed, the re-fork override and the profile read — so they cannot
   * disagree about the permission layer (`codexThreadConfigSignature`). Since F1.678 the host
   * writes no exact `deny` (F1.1057 had already removed the credential store's).
   */
  private codexReadOnlyPaths(): string[] {
    const records = codexWorkspaceRecordDenyPaths(
      this.workingDirectory, this.config.workspace.workspaceRootPath, this.codexAdditionalWritableRoots(),
    );
    if (records.length > 0) {
      this.debug(
        `[protectedPaths] the cwd or an added directory (a cwd path through a folder named "~" included; by real path as well as spelled, F1.696) covers the workspace records, `
        + `so ${records.length} absolute read keys over the records' spellings are read-only to codex (reads kept, writes refused)`,
      );
    }
    return [...records, ...this.configDirProjection().deny]; // F1.678 — the field keeps its F1.664 name; the key is `read` now
  }

  /**
   * F1.664 — {@link codexConfigDirProjection} for this session: the cwd-relative `read`
   * subpaths travel in {@link codexProtectedWorkspaceSubpaths}, the absolute `read` key (F1.678;
   * a `deny` before it) in {@link codexReadOnlyPaths}. Every one of the four builders — the config, the
   * turn-head seed, the plugin re-fork override ({@link applySelectedPluginSkillRuntimePolicy})
   * and the profile read — calls through here, so a root widened mid-session is re-derived
   * at the next re-fork. The roots other than the cwd are `$TMPDIR`, `/tmp` and the added
   * directories: the same set {@link codexAgentWritableRoots} names.
   */
  private configDirProjection(): { subpaths: string[]; deny: string[] } {
    const projection = codexConfigDirProjection(
      this.workingDirectory, CONFIG_DIR, this.config.workspace.workspaceRootPath,
      [tmpdir(), '/tmp', ...this.codexAdditionalWritableRoots()],
    );
    if (projection.subpaths.length > 0 || projection.deny.length > 0) {
      this.debug(
        `[protectedPaths] a codex writable root contains the Nessy config dir ${CONFIG_DIR}, so it is kept out of `
        + `agent commands' writes: read-only [${projection.subpaths.join(', ')}], read-only absolute [${projection.deny.join(', ')}]`,
      );
    }
    return projection;
  }

  /**
   * F1.609 — a fresh state file for this runtime build, in its own `mkdtemp`
   * directory under {@link floorHookStateRoot}, or `undefined` when that root
   * lies inside an agent-writable root or cannot be made. F1.704 — a root that
   * F1.664's projection keeps agent commands out of is no reason, as for
   * {@link newCodexHome} (F1.680's shield, same projection). Then the hook is
   * given no file and keeps the floor in every mode — F1.386's posture: in
   * bypassPermissions it refuses a change the host floor would let run — and
   * the session says so, because a withheld control nobody can see is
   * indistinguishable from a defect.
   */
  private newFloorHookStateFile(): string | undefined {
    const projection = this.configDirProjection(); // F1.704 — the value newCodexHome's shield reads (F1.680)
    const resolved = resolveCodexFloorHookStateDirectory(this.floorHookStateRoot, this.codexAgentWritableRoots(),
      (root, dir) => codexConfigDirProjectionShields(dir, root, this.workingDirectory, CONFIG_DIR, projection));
    let reason = 'withheld' in resolved ? resolved.withheld : '';
    if ('dir' in resolved) {
      try {
        this.floorHookStateBuildDir = mintCodexFloorHookStateBuildDir(resolved.dir, line => this.debug(line)); // F1.654 · build-<pid>-, dead hosts' swept
        this.sessionFacts.delete(CODEX_FLOOR_HOOK_STATE_FACT);
        return join(this.floorHookStateBuildDir, CODEX_AUTOMATION_FLOOR_HOOK_STATE_FILE);
      } catch (error) {
        reason = `its state directory under ${resolved.dir} could not be created (${error instanceof Error ? error.message : String(error)})`;
      }
    }
    const line = '[codex-hooks] the unattended-automation floor hook is not told this session\'s permission mode: '
      + `${reason}. So it refuses a change to what an unattended automation does or when it runs in every mode, `
      + 'bypassPermissions included, where the host floor lets it run (F1.609).';
    this.recordSessionFact(CODEX_FLOOR_HOOK_STATE_FACT, line);
    this.debug(line);
    return undefined;
  }

  /**
   * F1.652 — where the per-session `CODEX_HOME` directories go: the host's own
   * config directory, which {@link newCodexHome} accepts when no agent-writable
   * root covers it, or (F1.680) when F1.664's read-only projection of the config
   * dir keeps agent commands out of it there. A field so a rig can point it elsewhere.
   */
  private codexHomeRoot: string = join(CONFIG_DIR, CODEX_HOME_ROOT);

  /**
   * F1.652 — a fresh private `CODEX_HOME` for this runtime build, in its own
   * `mkdtemp` directory under {@link codexHomeRoot} when no root the session's
   * codex profile lets an agent command write covers it
   * ({@link codexAgentWritableRoots}, compared by real path). The home holds
   * `rules/nessy.rules` — the user's durable Always-Deny grants, which codex
   * alone enforces — and `config.toml` with the host hooks and their trust.
   * Under `$TMPDIR` an agent command rewrote both with no card, and codex read
   * the rewritten rules at the host's next `thread/fork` (codex-rs
   * `thread_manager.rs` forks with no inherited exec policy), so a denied
   * command then ran (measured on the shipped `rust-v0.156.1`,
   * `work/wjcrite/f1652-probe.ts`).
   *
   * F1.680 — a writable root that contains the host root is no reason to leave
   * it when F1.664's projection ({@link configDirProjection}, the value this
   * build writes) already keeps agent commands out of the config dir there:
   * the home as the project, the project IS the config dir, the config dir
   * under `$TMPDIR`, `/tmp` or an added directory
   * ({@link codexConfigDirProjectionShields} reads the projection, re-derives
   * none of it). Measured on the shipped `rust-v0.156.1`
   * (`work/wjcritn/f1680-probe.ts`, every approval accepted): in each of those
   * layouts the agent's `rm rules/nessy.rules` is refused, the durable deny
   * holds after the host's `thread/fork`, and commands run (a cwd write works,
   * except where the project IS the config dir — F1.664's posture there).
   * Only where neither holds does the home fall back to `$TMPDIR`, today's
   * place, and the session says so, because a withheld control nobody can see
   * is indistinguishable from a defect: a writable root INSIDE the config dir
   * that contains the host root (an added `codex-home`, say — the more specific
   * root wins), a config dir whose path carries a glob character (F1.664
   * projects nothing), a host root outside the config dir, or one that cannot
   * be created. Teardown is unchanged: `cleanupRuntimeResources` removes either place; F1.681 sweeps a crashed host's home ({@link mintCodexHome}).
   */
  private newCodexHome(): string {
    const projection = this.configDirProjection(); // F1.680
    const resolved = resolveCodexHostOnlyDirectory(this.codexHomeRoot, this.codexAgentWritableRoots(), 'its home directory',
      (root, dir) => codexConfigDirProjectionShields(dir, root, this.workingDirectory, CONFIG_DIR, projection));
    let reason = 'withheld' in resolved ? resolved.withheld : '';
    if ('dir' in resolved) {
      try {
        const home = mintCodexHome(resolved.dir, line => this.debug(line)); linkCodexKeptSessions(home, resolved.dir, { workspaceId: this.config.workspace?.id, sessionId: this.config.session?.id, branchFrom: this.config.session?.branchFrom }, line => this.debug(line)); // F1.681 — `<prefix><pid>-XXXXXX`, after sweeping the homes a crashed host left; F1.1074 — the session's rollouts outlive the build, so a rebuild resumes by id; F1.1076 — a branch's folder is seeded with the parent's thread
        this.sessionFacts.delete(CODEX_HOME_LOCATION_FACT);
        return home;
      } catch (error) {
        reason = `its home directory under ${resolved.dir} could not be created (${error instanceof Error ? error.message : String(error)})`;
      }
    }
    const line = '[codex home] this session\'s CODEX_HOME is under the temporary directory, which an agent command can write with no card: '
      + `${reason}. So an agent command in an unattended or bypassPermissions session could rewrite the durable Always-Deny rules `
      + 'and the host hooks codex reads from it, taking effect at the next thread fork (F1.652; the config dir\'s read-only '
      + 'projection does not cover the host root there, F1.680).';
    this.recordSessionFact(CODEX_HOME_LOCATION_FACT, line);
    this.debug(line);
    return mkdtempSync(join(tmpdir(), CODEX_HOME_PREFIX));
  }

  /** F1.609 — forget this build's state file and remove its directory (never throws). */
  private forgetFloorHookState(): void {
    this.floorHookStateFile = null;
    const dir = this.floorHookStateBuildDir;
    this.floorHookStateBuildDir = null;
    if (!dir) return;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      this.debug(`[codex-hooks] F1.609: the floor hook's state directory could not be removed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * F1.532 — writes the session's CURRENT mode (read back after any change
   * callback, so a clamp is what lands) and whether the administrator list —
   * the live probe's answer, else the remembered one — requires the reviewer.
   * Never throws: a write that fails is debugged, and the hook then fails
   * closed on the stale or missing file (the floor holds; in bypass it refuses
   * what the host floor would let run, which is F1.386's posture before this row).
   * F1.609 — the file is where no agent command can write it, so this method is
   * its only writer ({@link newFloorHookStateFile}).
   */
  private writeFloorHookState(): void {
    if (!this.floorHookStateFile) return;
    const list = this.managedApprovalsReviewers ?? getCodexManagedApprovalsReviewers();
    // F1.781 — and whether the reviewer still answers, the Settings toggle re-read now (off: the hook steps aside).
    const required = codexManagedListRequiresReviewer(list);
    const answers = codexFloorHookReviewerAnswers(required, this.configuredApprovalsReviewer, this.autoReviewSettingOn(), list) && (required || codexModeHandsApprovalsToReviewer(this.getPermissionMode())); // F1.1169
    try {
      const state = codexAutomationFloorHookState(this.getPermissionMode(), required, answers);
      writeFileSync(this.floorHookStateFile, state, { mode: 0o600 });
    } catch (error) {
      this.debug(`[codex-hooks] F1.532: the floor hook's state file could not be written: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * F1.386 — the one-boot trust pass, after `initialize` and before any thread:
   * a projected hook is INERT until `[hooks.state]` names it. Never throws; a
   * hook left untrusted is SAID, because then the reviewer answers the edit.
   */
  private async trustProjectedHostHooks(client: AppServerClient): Promise<void> {
    if (this.projectedHostHookCommands.length === 0) return;
    const trusted = await trustCodexHostAuthoredHooks(
      client,
      this.workingDirectory ?? this.config.workspace.workspaceRootPath,
      this.projectedHostHookCommands,
      message => this.debug(message),
    );
    if (trusted < this.projectedHostHookCommands.length) {
      this.recordSessionFact('codex-hooks-projection', CODEX_AUTOMATION_FLOOR_HOOK_UNTRUSTED_NOTICE);
      this.debug(CODEX_AUTOMATION_FLOOR_HOOK_UNTRUSTED_NOTICE);
    }
  }

  /**
   * F1.378 (DECIDED 2026-09-23, native-first) — the user's exact-name `mcp__`
   * DENY and ASK rules, handed to the writer as codex's own per-server levers
   * (`disabled_tools`, `tools.<name>.approval_mode = "prompt"`), so they hold
   * where this host is never asked: a tool its server marks `readOnlyHint`, and
   * every MCP call while codex's auto-review reviewer is on. Read from the SAME
   * merged policy {@link consultPermissionRules} evaluates, through the same
   * context fallback as {@link noteUnboundPermissionRules}. A whole-server or
   * pattern rule is enumerated over `catalogue` ({@link codexMcpRuleCatalogue},
   * F1.482 (2)) and carried for every tool it matches; without a catalogue it is
   * SAID on the session-facts channel, as is the one reach the enumeration
   * leaves (a source still connecting when the wait ran out). Read
   * when the runtime is built, like every key of `config.toml`: a rule added
   * mid-session is judged by the host's consult of an asked call until the next
   * build. Fails OPEN to HEAD's config, for {@link noteUnboundPermissionRules}'s
   * reason: a projection that could brick a session is worse than an absent one.
   */
  private codexMcpRuleProjection(catalogue?: CodexMcpToolCatalogue): Pick<CodexConfigOptions, 'mcpToolLevers'> {
    try {
      const projection = projectCodexMcpPermissionRules(this.codexMcpRuleProgram(), catalogue);
      const line = describeCodexUnprojectedMcpRules(projection.unexpressible)
        ?? describeCodexMcpRuleCatalogueGap(projection.enumerated ?? [], catalogue);
      if (line) this.recordSessionFact('codex-mcp-rules-unprojected', line);
      else this.sessionFacts.delete('codex-mcp-rules-unprojected');
      const carries = (levers: CodexMcpToolLevers) => levers.disabledTools.length > 0 || levers.promptTools.length > 0;
      const levers = {
        ...(carries(projection.session) ? { session: projection.session } : {}),
        ...(carries(projection.sources) ? { sources: projection.sources } : {}),
      };
      return Object.keys(levers).length > 0 ? { mcpToolLevers: levers } : {};
    } catch (error) {
      this.debug(`[CodexAgent] F1.378 MCP rule projection skipped: ${String(error)}`);
      return {};
    }
  }

  /**
   * F1.378 / F1.482 (2) — the merged policy the projection reads: the SAME one
   * {@link consultPermissionRules} evaluates, through the same context fallback
   * as {@link noteUnboundPermissionRules}.
   */
  private codexMcpRuleProgram(): CodexMcpRuleProjectionInput | undefined {
    const permissionContext: PermissionsContext =
      this.permissionManager.getCapabilityPermissionsContext?.() ?? {
        workspaceRootPath: this.config.workspace.workspaceRootPath,
        activeSourceSlugs: Array.from(this.sourceManager.getActiveSlugs()),
        projectTrusted: this.config.projectTrusted === true,
      };
    return withToolRulesWebSearchDeny(permissionsConfigCache.getMergedConfig(permissionContext)); // F1.1175 — plus a toolRules WebSearch deny
  }

  /**
   * F1.482 (2) (origin WJ-rr-a's F1.378 residue) — the tools codex will be
   * handed, for a whole-server or pattern `mcp__` deny/ask rule to be carried by
   * codex's exact-name lists. `undefined` (and no wait) unless the policy has such
   * a rule, so every other session's runtime build is unchanged.
   *
   * - session: every tool the session-tool registry defines (`SESSION_TOOL_NAMES`),
   *   a superset of what this session's server advertises — an unadvertised name
   *   in codex's lists is inert.
   * - sources: the pool's tools for this session, read the way `McpPoolServer`
   *   answers codex's `tools/list` (`getProxyToolDefs` over the leaser's slugs),
   *   AFTER waiting for the pool's reconcile under the SAME cap that answer waits
   *   under (`MCP_POOL_SERVER_STARTUP_WAIT_MS`). codex lists a server's tools once,
   *   at start, and never re-lists (`mcp/pool-server.ts`), so this is the set it
   *   will be handed — except a source still connecting when the cap ran out,
   *   which `incomplete` carries to the facts sentence.
   *
   * Fails OPEN to no catalogue (F1.378's stated residue), for
   * {@link codexMcpRuleProjection}'s reason.
   */
  private async codexMcpRuleCatalogue(): Promise<CodexMcpToolCatalogue | undefined> {
    try {
      const program = this.codexMcpRuleProgram();
      const hasPatternRule = (program?.rules ?? []).some(rule => rule.matcher.kind === 'mcp'
        && (rule.action === 'deny' || rule.action === 'ask')
        && !!rule.matcher.server
        && (!rule.matcher.tool || rule.matcher.server.includes('*') || rule.matcher.tool.includes('*')));
      if (!hasPatternRule) return undefined;
      const pool = this.config.mcpPool;
      const leaserId = this.config.mcpLeaserId;
      let incomplete = false;
      if (pool) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        incomplete = await Promise.race([
          pool.whenReconciled().then(() => false),
          new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(true), MCP_POOL_SERVER_STARTUP_WAIT_MS); }),
        ]);
        if (timer !== undefined) clearTimeout(timer);
      }
      const sources = pool
        ? pool.getProxyToolDefs(leaserId !== undefined ? [...pool.slugsForLeaser(leaserId)] : undefined, leaserId)
          .map(def => def.name)
        : [];
      return {
        session: [...SESSION_TOOL_NAMES].map(name => `mcp__session__${name}`),
        sources,
        ...(incomplete ? { incomplete: true } : {}),
      };
    } catch (error) {
      this.debug(`[CodexAgent] F1.482 MCP rule catalogue skipped: ${String(error)}`);
      return undefined;
    }
  }

  /**
   * F1.372 (origin WJ-hh P-WJ-hh-6) — codex's MCP tool-call card offers Always
   * Allow, honoured by the SAME host record Pi's MCP card writes: the card
   * carries `commandHash` = sha256 of the HOST tool name
   * (`hostMcpToolNameForCodexRow`, F1.272) and Pi's remember window, exactly the
   * pair `rememberablePrompt` (`core/pre-tool-use.ts`) puts on Pi's card for the
   * same call, so `SessionManager`'s `storeAdminRememberApproval` /
   * `hasActiveAdminRememberApproval` answer the next identical card on either
   * runtime. Session-scoped and in memory, as on Pi and claude; nothing is
   * persisted, and codex's own `persist` metadata is still not echoed. A floor
   * card keeps `noAlwaysAllow` (P2.140 — the spread after this one says so) and
   * every elicitation that is not a tool call is left exactly as the bridge built it.
   */
  private codexMcpToolCardRemember(
    kind: ApprovalKind,
    params: unknown,
    floor: unknown,
  ): { noAlwaysAllow?: boolean; commandHash?: string; rememberForMinutes?: number } {
    if (kind !== 'elicitation' || floor) return {};
    const request = isPlainRecord(params) ? params : {};
    if (request.mode === 'url') return {};
    const rowName = codexMcpToolCallRowName(request, isPlainRecord(request._meta) ? request._meta : {});
    if (!rowName) return {};
    const hostName = hostMcpToolNameForCodexRow(rowName);
    return {
      noAlwaysAllow: false,
      commandHash: createHash('sha256').update(hostName, 'utf8').digest('hex'),
      rememberForMinutes: CODEX_MCP_CARD_REMEMBER_MINUTES,
    };
  }

  /**
   * F1.483 (origin: WJ-ss-b's P-WJ-ss-b-1, F1.411's residue) — await this
   * agent's runtime disposal and FORGET it when it failed, so the next
   * {@link disposeForRestart} re-runs the teardown instead of re-awaiting the
   * same rejection.
   *
   * `runtimeDisposal` memoised the FIRST teardown and `destroyed` latched, while
   * a strict dispose that rejects keeps `managed.agent`
   * (`SessionManager.disposeManagedAgentRuntime`). So F1.411's still-pending
   * plugin refresh re-awaited one rejection at every turn end and send, and the
   * session could never be refreshed again. A successful teardown is still kept
   * and never re-run. The retry re-runs the whole of `disposeForRestart`, its
   * synchronous prologue included, and that is harmless by measurement: the
   * config watcher, the elicitation release, the approvals and the turn sink
   * have nothing left to do, and the worker notice is not repeated because
   * `surfaceCodexOperatorNotice` holds a notice once (a guard that skipped the
   * prologue was tried and SURVIVED every arm, so it bought nothing but code).
   * `destroyed` stays latched — this agent is being REPLACED, not revived; the
   * retry only lets its replacement go ahead once it is really gone. The
   * identity check keeps a second caller of the same failed attempt from
   * forgetting a retry that a first caller has already started.
   */
  private async settleRuntimeDisposal(): Promise<void> {
    const disposal = this.runtimeDisposal;
    try {
      await disposal;
    } catch (error) {
      if (this.runtimeDisposal === disposal) this.runtimeDisposal = null;
      throw error;
    }
  }

  /**
   * F1.483 — the handle bundles a FAILED restart teardown could not free, kept
   * for its retry. Empty on every agent whose restart teardown succeeded.
   */
  private readonly unreleasedRuntimeResources: CodexRuntimeResources[] = [];

  /**
   * F1.483 — release this teardown's handles AND every bundle an earlier failed
   * RESTART teardown kept; a restart keeps again whatever still fails.
   *
   * WHY KEEP THEM. `teardownRuntime` nulls every field before its handles are
   * released, so forgetting the memo alone would make a retry release nothing and
   * RESOLVE — the refresh landing over the managed CODEX_HOME the first attempt
   * could not delete (its rollouts at 0644), which is P3.341's OPTION B ("switch
   * anyway and leave that directory on disk") at the throw in
   * {@link cleanupRuntimeResources}, where the owner kept OPTION A: the caller
   * "can retry". This is what makes that retry real.
   *
   * ONLY A RESTART KEEPS (`keepUnreleased`, passed by {@link disposeForRestart}).
   * `clearHistory` tears the runtime down too and deliberately goes on after a
   * failure (it reports it and clears anyway); keeping ITS bundle would let a
   * leak from a `/clear` refuse a LATER runtime switch. F1.490 decided that
   * path stays as it was — the decision and its reasons are on
   * {@link CodexAgent.clearHistory}. A kept bundle exists only on
   * a destroyed agent, which never builds another runtime, so a retry releases
   * the kept bundle and an empty one; the merge below is for completeness, so a
   * second failure is never dropped from the report.
   *
   * RE-RELEASING A STEP THAT ALREADY SUCCEEDED IS HARMLESS, read per callee:
   * `client.close()` returns on its `closed` latch, `manager.kill()` nulls its
   * child before anything else, both servers' `close` resolve on a server that
   * is no longer listening, and the `rmSync` is `force`. RESIDUE, stated: for the
   * same reason a retry cannot re-kill a child `manager.kill()` already ABANDONED
   * after SIGKILL — its leaf was reported on the first attempt, and there is no
   * stronger signal to send. So `codexHome`, the honest prior, is the step a
   * retry really re-runs.
   */
  private async releaseRuntimeResources(resources: CodexRuntimeResources, keepUnreleased: boolean): Promise<void> {
    const failures: unknown[] = [];
    for (const bundle of [...this.unreleasedRuntimeResources.splice(0), resources]) {
      try {
        await this.cleanupRuntimeResources(bundle);
      } catch (error) {
        if (keepUnreleased) this.unreleasedRuntimeResources.push(bundle);
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures.flatMap(failure => (failure instanceof AggregateError ? failure.errors : [failure])),
        'codex-runtime-cleanup-failed',
      );
    }
  }

  /**
   * F1.482 (3) (origin WJ-rr-a's F1.386 residue) — a run of the host-authored
   * floor hook that codex could not complete is SAID on the turn that met it,
   * with its consequence: the floor refused nothing and codex went on to its next
   * approval step (the reviewer, with auto-review on). codex's own `hook/completed`
   * line already names the failure ("Hook … failed: … [error] hook timed out
   * after 30s"); what it cannot say is what that meant for the request. Every
   * run is still recorded first, exactly as before. See
   * `backend/codex/automation-floor-hook.ts` for the source reading.
   */
  protected override recordHookRun(observation: HookRunObservation): void {
    super.recordHookRun(observation);
    if (codexAutomationFloorHookRunFailed(observation)) {
      this.surfaceCodexOperatorNotice(CODEX_AUTOMATION_FLOOR_HOOK_FAILED_NOTICE);
    }
  }

  /**
   * F1.202 option (a) (OWNER-approved 2026-09-24) — the ChatGPT (Codex) card's
   * sign-in, and the ONLY place this client sends `account/login/start`.
   *
   * A no-op unless the connection declares codex's own `openai` provider
   * (`config/llm-connections.ts` symbol `CODEX_CHATGPT_MODEL_PROVIDER`) — so
   * `codex-gateway`, the BYO codex card and a Bedrock declaration never log in,
   * and the gateway's structural refusal of every account method (C4.28, pinned
   * in `codex-quota-window.test.ts`) is untouched.
   *
   * On the card: the host's ONE ChatGPT OAuth filled this connection's
   * `llm_oauth` slot; the token is refreshed first when it has expired, then
   * handed to codex as `chatgptAuthTokens` (`backend/codex/chatgpt-subscription-auth.ts`
   * has the source reading, the residues, and why the slot is per card). Called
   * after `initialize` and before any thread opens, so the first turn already
   * spends the subscription.
   *
   * A sign-in that cannot be made ENDS the runtime build, with the reason on
   * the auth-required card (`onBackendAuthRequired`) and in the thrown error:
   * without it codex's `openai` provider has no credential, and a thread that
   * opened anyway would fail every turn with codex's own words instead of ours.
   * No token is ever in either: the reasons are composed from fixed words, and
   * codex's own refusal is scrubbed before it is quoted.
   */
  private async signInCodexChatGptSubscription(
    client: { request(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown> },
    declared: CodexModelProvider | undefined,
  ): Promise<void> {
    if (declared !== CODEX_CHATGPT_MODEL_PROVIDER) return;
    const slug = this.config.connectionSlug;
    if (!slug) throw new Error('The ChatGPT (Codex) session has no connection to sign in with.');
    this.startupPhase = 'signing codex in to the ChatGPT subscription';
    const resolved = await resolveCodexChatGptTokens(slug, this.chatGptSubscriptionAuthDeps());
    if (!resolved.ok) {
      this.onBackendAuthRequired?.(resolved.reason);
      throw new Error(resolved.reason);
    }
    try {
      await client.request(
        CODEX_ACCOUNT_LOGIN_START_METHOD,
        buildCodexChatGptLoginParams(resolved.tokens),
        { timeoutMs: CODEX_CHATGPT_LOGIN_TIMEOUT_MS },
      );
    } catch (error) {
      const said = scrubCodexChatGptAuthText(error instanceof Error ? error.message : String(error), resolved.tokens);
      throw new Error(`Codex refused this connection's ChatGPT sign-in: ${said}`);
    }
    this.chatGptSubscriptionAccessToken = resolved.tokens.accessToken;
    this.recordSessionFact('codex-chatgpt-subscription', CODEX_CHATGPT_SUBSCRIPTION_SIGNED_IN_FACT);
    this.debug(CODEX_CHATGPT_SUBSCRIPTION_SIGNED_IN_FACT);
  }

  /**
   * F1.202 — the access token this runtime last HANDED codex, kept only to tell
   * a refused token from one a sibling session already renewed (see
   * `answerCodexChatGptAuthTokensRefresh`). Never logged, never persisted; the
   * store is the credential of record.
   */
  private chatGptSubscriptionAccessToken: string | null = null;

  /** F1.202 — this session's ChatGPT (Codex) connection slug, or `undefined` on every other card. */
  private chatGptSubscriptionSlug(): string | undefined {
    return this.declaredCodexModelProvider() === CODEX_CHATGPT_MODEL_PROVIDER ? this.config.connectionSlug : undefined;
  }

  /**
   * F1.202 — the answer to codex's `account/chatgptAuthTokens/refresh`, from
   * this connection's own sign-in. Reached from {@link handleServerRequest}
   * only on the ChatGPT (Codex) card; everywhere else that request keeps its
   * `{}` (`approval-bridge.ts` `buildUnsupportedResponse` — a forged credential
   * is the one answer never given). A refresh that cannot be made raises the
   * auth-required card and rejects, which `AppServerClient` turns into a
   * JSON-RPC error codex reports by code only.
   */
  private async answerChatGptSubscriptionRefresh(params: unknown): Promise<CodexChatGptTokens> {
    const slug = this.chatGptSubscriptionSlug();
    if (!slug) throw new Error('This session is not signed in to ChatGPT through codex.');
    try {
      const tokens = await answerCodexChatGptAuthTokensRefresh(
        slug,
        params,
        this.chatGptSubscriptionAccessToken ?? undefined,
        this.chatGptSubscriptionAuthDeps(),
      );
      this.chatGptSubscriptionAccessToken = tokens.accessToken;
      this.debug('[ChatGPT subscription] codex asked for a fresh token and was answered from this connection\'s sign-in');
      return tokens;
    } catch (error) {
      this.onBackendAuthRequired?.(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /**
   * F1.202 — the store and the refresh the sign-in reads: the credential
   * manager's `llm_oauth` slot for this connection, and the host's one ChatGPT
   * token refresh (the resolver's default). A seam for the same reason as
   * {@link quotaTransport}: a test must never reach the real store or the network.
   */
  protected chatGptSubscriptionAuthDeps(): ResolveCodexChatGptTokensDeps {
    return {
      store: {
        get: slug => getCredentialManager().getLlmOAuth(slug),
        set: (slug, credentials) => getCredentialManager().setLlmOAuth(slug, credentials),
      },
    };
  }

  /**
   * F1.566 — after the sign-in, the card's model list is refreshed from codex's
   * own `model/list` (`backend/codex/chatgpt-subscription-models.ts` has the
   * source reading and every rule). A no-op on every other card: `model/list`
   * describes codex's own provider, which only this card uses.
   *
   * NOT awaited by the runtime build: the first read may go online, and no turn
   * should wait on a picker list. It never throws; the outcome goes to the debug
   * channel. The renderer picks the new list up with the connection.
   */
  private async refreshChatGptSubscriptionModels(
    client: CodexModelListRequester,
    declared: CodexModelProvider | undefined,
  ): Promise<void> {
    if (declared !== CODEX_CHATGPT_MODEL_PROVIDER) return;
    const slug = this.config.connectionSlug;
    if (!slug) return;
    try {
      const outcome = await refreshCodexChatGptSubscriptionModels(client, slug, this.chatGptSubscriptionModelStore());
      this.debug(describeCodexChatGptModelRefresh(outcome));
    } catch (error) {
      this.debug(`[ChatGPT subscription] model list: the refresh failed (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  /** F1.566 — where the card's list is read and written; a seam for the same reason as the auth store. */
  protected chatGptSubscriptionModelStore(): CodexChatGptModelStore {
    return { get: slug => getLlmConnection(slug), update: (slug, updates) => updateLlmConnection(slug, updates) };
  }

  /**
   * F1.598 — codex's OWN web searches on the ChatGPT (Codex) card, counted
   * against the host cap and SAID once past it; `backend/codex/native-web-search-cap.ts`
   * has the source reading and the decision. The host's `web_search` (which the
   * cap bounds) is withheld on that card by F1.570, and codex has no per-session
   * limit of its own, so nothing is refused here: the user is told.
   *
   * Fed from `handleNotification` for this thread's items and for a subagent
   * thread this session spawned (the cap counts across both). Keyed to the
   * thread, so a new thread starts the count again. Inert on every other card:
   * the writer's own predicate decides, from the connection's declaration.
   */
  private codexNativeWebSearchTally: { threadId: string | null; tally: CodexNativeWebSearchTally } | null = null;

  private noteCodexNativeWebSearch(method: string, params: unknown): void {
    if (!isCodexWebSearchItemStart(method, params)) return;
    if (!codexConfigFollowsCodexWebSearch({ declaredModelProvider: this.declaredCodexModelProvider() })) return;
    if (!this.codexNativeWebSearchTally || this.codexNativeWebSearchTally.threadId !== this.threadId) {
      this.codexNativeWebSearchTally = { threadId: this.threadId, tally: createCodexNativeWebSearchTally() };
    }
    const notice = this.codexNativeWebSearchTally.tally.note(method, params);
    if (!notice) return;
    this.debug(`[web search] ${notice}`);
    this.turnSink?.push({ type: 'info', message: notice, level: 'warning' });
  }

  /**
   * F1.202 — a one-shot completion (`queryLlm`, and so every title and mini
   * completion through `runMiniCompletion`) is REFUSED on a connection that
   * declares codex's own provider, by name, before any upstream is resolved.
   *
   * Measured at HEAD: `resolveUpstream` falls back to `DEFAULT_UPSTREAM`, the
   * Nessy Gateway, for an endpoint-less codex connection
   * (`drivers/codex.ts` `buildCodexRuntimeUpstream`: no base URL is the
   * gateway). A declared connection is endpoint-less by construction, so
   * without this line a ChatGPT (Codex) session's title prompt — the user's own
   * words — would have gone to the corporate gateway on the dp credential, and
   * a Bedrock declaration the same. There is no host route to codex's own
   * provider outside a codex turn (the local adapter is not started for such a
   * session), so the honest answer is the refusal: `runMiniCompletion` answers
   * `null` on it and the session keeps its default title. A route through
   * codex's own provider is a follow-up, not a guess made here.
   */
  private refuseQueryLlmOnDeclaredProvider(): void {
    const declared = this.declaredCodexModelProvider();
    if (!declared) return;
    throw new Error(
      `A one-shot completion is not available on this connection: it routes to codex's own \`${declared}\` provider, `
      + 'and this host has no route to that provider outside a codex turn (the Nessy Gateway is not this '
      + 'connection\'s endpoint, so nothing is sent there instead).',
    );
  }

  /**
   * F1.493 (2) (origin WJ-yy P-WJ-yy-3) — which codex SUBAGENT made a bridged session-tool call: the calling thread,
   * when it is not this session's own. The host asks while the call runs (`SessionManager.raisingOriginOf`, the same
   * structural seam F1.475 gave `ClaudeAgent.subagentOfToolUse`) and stamps a card the call raises with that
   * subagent instead of the running parent turn, so a later parent turn's end no longer cancels a card a child is
   * still waiting on.
   *
   * The thread comes from codex itself: its MCP client writes `_meta.threadId` on every `tools/call`
   * (`core/src/mcp_tool_call.rs`, `with_mcp_tool_call_ids_meta`, at the pinned `rust-v0.156.1`), and the bridge
   * carries it into the host scope (`HostCallbackBridgeCallOrigin`). Measured on the shipped binary: a main-thread
   * call names the main thread, a `spawn_agent` child's call names the child's own thread (its collab item's
   * `receiverThreadIds[0]`), and the child called the tool AFTER the parent's turn had completed. A spawned child
   * inherits `[mcp_servers.session]` because its config is the parent turn's config cloned
   * (`core/src/agent/child_config.rs`, `build_agent_shared_config`).
   *
   * Any thread other than this session's own counts, grandchildren included — only threads of this codex runtime
   * reach this session's bridge, and the bridge's owner check has already run. A thread named falsely by something
   * else on the loopback socket can only move WHICH end declines a card (a person still answers it, and the runtime
   * teardown and the session sweep still decline it), never approve anything.
   */
  subagentOfToolUse(_callId: string, threadId?: string): string | undefined {
    return threadId && this.threadId && threadId !== this.threadId ? threadId : undefined;
  }

  /** F1.493 (2) — true once a subagent thread's turn has ended (or the thread closed) and no new turn re-opened it. */
  subagentEnded(threadId: string): boolean {
    return this.endedSubagentThreads.has(threadId);
  }

  /**
   * F1.631 — whether the codex turn a main-thread bridged call names is still the live one. The call's turn id
   * rides the same `_meta` as its call and thread ids (`_meta["x-codex-turn-metadata"].turn_id`), and MEASURED on
   * the shipped binary (0.159.3, sha = the manifest pin; probe `work/bk-17/probe-f1631-turn-id.ts`) it EQUALS the
   * `turn/started` `turn.id` that `activeTurnId` keeps — so a turnId that is no longer `activeTurnId` (the null
   * after `turn/completed`, or a newer turn's id) names a turn that ended while the raise was in flight, and the
   * host refuses the card at entry instead of raising it for a turn nobody runs (F1.406's codex residue).
   * Structural, like `subagentOfToolUse`: the host imports no backend class.
   */
  raisingTurnEnded(turnId: string): boolean {
    return turnId !== this.activeTurnId;
  }

  /**
   * F1.493 (2) — called with a subagent thread's id when its turn ends or its thread closes, whether or not a parent
   * turn is open. The host sets it and declines exactly the cards that subagent raised. Structural, like
   * `ClaudeAgent.onSubagentEnded`: the host imports no backend class.
   */
  onSubagentEnded?: (threadId: string) => void;

  private static readonly SUBAGENT_THREAD_MEMORY = 256;
  private readonly endedSubagentThreads = new Set<string>();

  /**
   * F1.493 (2) — a foreign thread's lifecycle, read at the top of {@link handleNotification}'s foreign-thread branch,
   * ahead of the detached-review and orchestration re-admits and whether or not either admits it: the child
   * roster those use is turn-scoped (`CodexEventAdapter.onTurnStart` clears it), and a child outlives the parent turn
   * that spawned it. `turn/started` re-opens a thread (a `send_input` starts a new child turn); `turn/completed` —
   * whatever its status, an interrupt included — and `thread/closed` end it. Read for every foreign thread: the host
   * matches the id against its own cards, so a compaction or review thread's end simply matches none. Bounded.
   */
  private noteSubagentThreadLifecycle(method: string, params: unknown): void {
    const threadId = (params as { threadId?: unknown } | null | undefined)?.threadId;
    if (typeof threadId !== 'string' || threadId.length === 0 || threadId === this.threadId) return;
    this.eventAdapter.noteSpawnedChildLifecycle(method, params); // UA12.99 — the session-scoped spawn_agent roster
    if (method === 'turn/started') {
      this.endedSubagentThreads.delete(threadId);
      return;
    }
    if (method !== 'turn/completed' && method !== 'thread/closed') return;
    this.endedSubagentThreads.delete(threadId);
    this.endedSubagentThreads.add(threadId);
    if (this.endedSubagentThreads.size > CodexAgent.SUBAGENT_THREAD_MEMORY) {
      const oldest = this.endedSubagentThreads.values().next().value;
      if (oldest !== undefined) this.endedSubagentThreads.delete(oldest);
    }
    try { this.onSubagentEnded?.(threadId); } catch (error) {
      this.debug(`onSubagentEnded(${threadId}) threw: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * F1.769 (DN-273, 2026-09-29) — the working-directory rebind hook Pi already has, so a rebind hands codex the
   * host's trust decision for the NEW folder together with the path. `SessionManager`'s session project mutation
   * calls `prepareWorkingDirectoryUpdate({ path, projectTrusted })` on a runtime that defines it and otherwise only
   * `updateWorkingDirectory(path)`; codex defined none, so `this.config.projectTrusted` kept the decision captured at
   * agent creation. A trusted session rebound to a restricted project then wrote the new folder `trusted` at its next
   * runtime build (F1.750's entry, {@link codexProjectTrustOptions}) and kept that project's repo skills on at its next
   * thread open (F1.845, {@link refreshCodexRestrictedRepoSkills}). Commit moves the path and the trust together and
   * rollback restores both. Nothing is sent to the app-server here: the entry is written at the next build and the
   * skills are re-read at the next open or re-fork, as for any other change of either.
   */
  async prepareWorkingDirectoryUpdate(
    input: import('./backend/types.ts').WorkingDirectoryUpdateInput,
  ): Promise<import('./backend/types.ts').WorkingDirectoryUpdateTransaction> {
    const previousTrust = this.config.projectTrusted;
    let committed = false;
    return {
      generation: 0,
      commit: async () => {
        this.updateWorkingDirectory(input.path);
        this.config.projectTrusted = input.projectTrusted;
        committed = true;
      },
      rollback: async () => {
        if (!committed) return;
        this.updateWorkingDirectory(input.previousPath);
        this.config.projectTrusted = previousTrust;
        committed = false;
      },
      finalize: async () => {},
    };
  }

  /**
   * UA3.5 — the {@link codexDeveloperInstructions} sections this spawn's OFFER earns: `board` exactly when
   * `create_board_task` is offered, i.e. the session MCP server is spawned WITH the host-callback bridge (the tool is
   * in `SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK`), so a spawn without the bridge neither offers the tool nor reads its
   * guidance. The same predicate `buildSessionMcpSpec` applies when it adds `--host-callback-port`.
   */
  private developerSections(bridgePort: number | undefined): CodexDeveloperSections | undefined {
    // F1.791 — on the SAME predicate as the `codex-project-trust` fact ({@link codexProjectTrustOptions}): a project root
    // codex was told is untrusted. Independent of the bridge: it names no tool.
    const trust = codexProjectTrustOptionsFor(this.workingDirectory, this.config?.projectTrusted === true);
    const projectTrust = trust.projectRoot && !trust.projectTrusted ? untrustedProjectPromptSection() : undefined;
    if (typeof bridgePort !== 'number' || !this.buildSessionMcpSpec(bridgePort)) return projectTrust ? { projectTrust } : undefined;
    // UA6.5 — `pages` on the same predicate: the six page tools are in `SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK` too.
    return { board: boardTaskDeveloperSection(), pages: pagesPromptSection(), ...(projectTrust ? { projectTrust } : {}) };
  }

  /**
   * UA12.101 — where an OUT-OF-TURN terminal refresh ({@link scheduleBackgroundTerminalRefresh}) puts its chip
   * events. With no turn open and the host's between-turns door present (`BackendConfig.onBetweenTurnsEvent`, the one
   * Pi and Claude already use), they go out at once, so `SessionManager` retires an exited terminal's
   * `backgroundShellCommands` entry after the refresh that saw it exit, not at the next turn's head — which may never
   * come, and until then the Background Tasks bar, `/tasks` and the Stop hook read the ended shell as running.
   * While a turn is open (it set `processing` and awaits this refresh before draining) they are parked for that
   * turn's head, which keeps P3.3's order: terminals observed before the turn go out first; a refresh that ends after
   * that head is released by the turn's end, before its Stop hook ({@link releaseParkedTerminalEvents}). No door (a headless or
   * test construction) parks them too — the P6.111 behaviour. A throwing door must not fail a refresh.
   */
  private deliverRefreshedTerminalEvent(event: AgentEvent): void {
    const door = this.config.onBetweenTurnsEvent;
    if (!door || this.processing) {
      this.pendingBackgroundTerminalEvents.push(event);
      return;
    }
    try {
      door(event);
    } catch (error) {
      this.debug(`Codex between-turns terminal event ${event.type} failed at the host door: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * UA12.99 — the ACTIVITY level the Tasks Conductor's settlement gate reads (`AgentBackend.backgroundActivityCount`,
   * via `SessionManager.getBackendBackgroundActivity`): the background terminals {@link backgroundWorkCount} counts,
   * plus every `spawn_agent` child of this session that is running a turn now
   * (`CodexEventAdapter.runningSpawnedChildCount`). Codex queues a finished child's result for the parent's NEXT turn
   * and never starts one for it (`rust-v0.159.3`, `trigger_turn: false`), so a node that left a child running would
   * otherwise be accepted at its door while the child worked. UA12.191: `backgroundWorkCount` (the idle reaper's and
   * the ceiling's liveness level) counts them too, but only within a silence bound, so a roster entry whose end never
   * arrives cannot make a session unreapable; this settlement level is not bounded (the node's deadline is its bound).
   */
  backgroundActivityCount(): number {
    return this.backgroundTerminalWorkCount() + this.eventAdapter.runningSpawnedChildCount;
  }

  /**
   * UA12.101 follow-up — the TURN'S END releases what a refresh parked while the turn ran. A refresh that a busy or
   * reaper read ({@link backgroundWorkCount}) starts mid-turn finishes after the head's drain, so
   * {@link deliverRefreshedTerminalEvent} parks its events; the adapter has by then forgotten an exited terminal, the
   * level reads 0 and the turn-end refresh finds nothing new, so before this an exit seen mid-turn waited for the user's
   * NEXT turn — the latch the row removes (Background Tasks bar, `/tasks`, the Stop hook, the busy count). Called from
   * `chatImpl`'s `finally` after `processing` is cleared, to hand over what a refresh parked while the Stop hook ran
   * (the first hand-over, {@link releaseParkedTerminalEvents}, runs before that hook). Then the usual fire-and-forget
   * refresh.
   */
  private releaseParkedTerminalEventsThenRefresh(): void {
    if (!this.processing) this.releaseParkedTerminalEvents();
    this.scheduleBackgroundTerminalRefresh();
  }

  /**
   * UA12.101 follow-up 2 — hand every parked terminal event to the host door, in order, each call fail-soft; with no
   * door they stay parked for the next head (the P6.111 behaviour). `chatImpl`'s `finally` calls this BEFORE
   * `emitStopHookOnce` although `processing` is still set: the turn's head has drained by then, so anything parked is
   * an exit a mid-turn refresh saw, and the door's `processEvent` retires the `backgroundShellCommands` entry
   * synchronously (before its first await) — so the Stop input built on the next line no longer lists the ended
   * terminal as running. Releasing only after the hook (the first follow-up) told the hook of the very turn that saw
   * the exit that the shell still ran, which a hook blocking on running shells turns into a wrong extra turn. Residue:
   * an `abort()`/`forceAbort()` builds the Stop input itself before this `finally` runs, so a user-stopped turn's hook
   * can still list it — a hook `hooks.md#stop` says should not run at all ("Does not run if the stoppage occurred due
   * to a user interrupt").
   */
  private releaseParkedTerminalEvents(): void {
    const door = this.config.onBetweenTurnsEvent;
    if (!door) return;
    for (const event of this.pendingBackgroundTerminalEvents.splice(0)) {
      try {
        door(event);
      } catch (error) {
        this.debug(`Codex parked terminal event ${event.type} failed at the host door: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * F1.896 (origin SIT-ab WJ-ac(2), FAIL 2 of 2) — the monitor steers THIS turn
   * has had ACCEPTED (the `turn/steer` resolved) and therefore cannot report
   * through {@link CodexAgent.redirect}'s rejection handler: an accepted steer
   * says nothing, codex applies it at its own next sampling boundary, and a
   * user Stop that lands first takes the notice with the turn while the host
   * has already shown it as delivered. {@link CodexAgent.forceAbort} reads this
   * record and reports each entry `steer_undelivered` before the sink is
   * finished, so the host's monitor requeue (F1.343's origin arm) hands the
   * tick to the user's next send (F1.530's hold) instead of dropping it.
   * Reset at `turn/started` beside the other per-turn state, so a completed
   * turn's ticks are never re-reported by a later Stop. Deliberately
   * monitor-scoped: replaying a person's own correction on abort could repeat
   * an instruction the model already acted on — a posture this row does not
   * take. Appended at the class end so no docs-cited line above moves.
   */
  private turnMonitorSteers: Array<{ message: string; messageId?: string }> = [];
}

/** F1.483 — the five handles {@link CodexAgent} releases per runtime, as one bundle. */
type CodexRuntimeResources = Parameters<CodexAgent['cleanupRuntimeResources']>[0];

/**
 * The `UserInput` members this client emits, structurally.
 *
 * `packages/codex-protocol` is not a dependency of `@nessy-agent/shared` (see
 * its `package.json`), so the union is restated here rather than imported —
 * the same convention every other codex wire shape in this file follows, with
 * the schema cited so the two can be diffed. Verified at HEAD against
 * `codex-protocol/schema/v2/TurnStartParams.json` and the bindings
 * `codex-protocol/generated/v2/UserInput.ts`, both generated from
 * `rust-v0.148.0` — the tag `codex-protocol/manifest.json` pins the bundled
 * binary to. `UserInput` there is a SEVEN-member union (`text`, `image`,
 * `localImage`, `audio`, `localAudio`, `skill`, `mention`); we emit two of
 * them, and `text_elements` is required on the `text` member in the bindings
 * even though the schema gives it a default.
 */
export type CodexTurnInput =
  | { type: 'text'; text: string; text_elements: [] }
  | { type: 'localImage'; path: string };

/**
 * P3.315 · the RESOLVED sandbox policy's discriminant, as `thread/start`
 * answers it, mapped to the mode this host WRITES.
 *
 * ## The divergence, measured in both directions on the shipped binary
 *
 * W2-p7 read `sandbox_mode = "danger-full-access"` and a resolved
 * `sandbox_policy` of `workspace-write` seconds apart from one live
 * `CODEX_HOME`, and could not say which one the binary obeys. Both halves are
 * now measured.
 *
 * SOURCE (`rust-v0.148.0`, strong): `resolve_permission_config_syntax`
 * (`core/src/config/mod.rs`) walks the config layers and, within one layer,
 * sets `Legacy` for `sandbox_mode` and then unconditionally sets `Profiles` for
 * `default_permissions` — so in ONE file the profile wins. With `Profiles`
 * active, `Config::load` compiles the selected profile and `sandbox_mode` is
 * read in no branch it can reach; the mode is consulted only in the final
 * `else`, `derive_permission_profile(sandbox_mode, …)`.
 *
 * DRIVEN (bundled `darwin-arm64/codex-app-server`, 2026-09-03, load 19-27, six
 * arms, two of them controls; the assertion is `ThreadStartResponse.sandbox`):
 *
 * | config | resolved |
 * | --- | --- |
 * | our shipped shape: `danger-full-access` + `default_permissions` (extends `:workspace`) | **`workspaceWrite`** |
 * | CONTROL: `danger-full-access` ALONE | `dangerFullAccess` |
 * | our shipped read-only shape: `read-only` + the profile (extends `:read-only`) | `readOnly` — AGREES |
 * | CONTROL: `read-only` ALONE | `readOnly` |
 * | `default_permissions = ":danger-full-access"` | `dangerFullAccess` |
 * | `extends = ":danger-full-access"` | config REJECTED, whole file discarded |
 *
 * The two controls are what make the first row a reading rather than a dead
 * rig: the same mode ALONE is honoured. So the mode is not ignored — it is
 * SUPERSEDED, and only where a profile exists.
 *
 * ## Why this leaves exactly ONE diverging mode, and why the host cannot just
 * respell it
 *
 * `resolveCodexRuntimePathPolicy` maps our mode to the profile's parent as
 * `:read-only` for `read-only` and (F1.787) for plan and explore, else `:workspace`, and the credential-deny floor is
 * unconditional, so a profile is always emitted. Six of our seven modes
 * therefore ask for exactly what their parent grants and agree. The seventh is
 * the sandbox-OFF master switch: it writes `danger-full-access` and gets
 * `:workspace` — or, in plan and explore, `:read-only` on purpose (F1.787; the plans/data grants are F1.1003's).
 *
 * The obvious respelling — `extends = ":danger-full-access"` — is FATAL:
 * `extensible_builtin_parent_profile` resolves only `:read-only` and
 * `:workspace`, anything else raising `cannot extend unsupported built-in
 * profile`, which discards the WHOLE config.toml. That is P2.330's fail-open
 * shape, and the driven arm above reproduces it. The other respelling —
 * `default_permissions = ":danger-full-access"` — works, and costs the deny
 * floor with it, because a deny is enforced BY the sandbox and that arm has
 * none. Choosing between "the switch works and the floor goes" and "the floor
 * stays and the switch does not" is a product posture and is NOT decided here;
 * the patch and the trade are in this row's report, and the site that would
 * make the change is `codex-responses-adapter/src/config-writer.ts`.
 *
 * ## What IS decided here: the divergence stops being silent
 *
 * Native-first — codex publishes the resolved policy in-band on the very call
 * this host already makes, and we were discarding the field. Reading it means
 * the check keeps working if the precedence ever changes, which a hard-coded
 * statement of today's precedence would not.
 *
 * ## P3.327 — WHAT THIS DOES *NOT* DECIDE: the patch-safety verdict
 *
 * P3.238 closed partly on this chain: with the sandbox-off default the host
 * writes `danger-full-access`, `SandboxPolicy::DangerFullAccess` compiles to
 * `FileSystemSandboxPolicy::unrestricted()`, so `assess_patch_safety` reaches
 * `SafetyCheck::AutoApprove` down both remaining branches and no
 * `applyPatchApproval` is raised. P3.327 asked whether the table above narrows
 * that argument. **It does not narrow it — it strikes it, and a SECOND fact
 * strikes it harder and first.** Both re-measured at HEAD:
 *
 * 1. The resolved policy is `workspaceWrite`, not `dangerFullAccess` (the table
 *    above). Re-driven here rather than inherited: with the real credential
 *    floor (`permissionsConfigCache.getMergedConfig(...).deniedPaths`, 19
 *    entries) `resolveCodexRuntimePathPolicy` yields 10 filesystem keys and 9
 *    workspace globs, so `hasCodexFilesystemPolicy` is TRUE and the profile is
 *    emitted for every real session — against `false` for empty options, which
 *    is the control that makes it a reading.
 * 2. **The approval policy in that pair is no longer `on-request`.** P3.238
 *    recorded the pair as `danger-full-access`/`on-request`; P2.197 landed after
 *    it closed, and `degradeUnboundedApprovalPolicy` now maps `on-request` to
 *    `untrusted` for every mode but `bypassPermissions` whenever the master
 *    switch was off — driven over all seven modes when that was written.
 *    `untrusted` is `AskForApproval::UnlessTrusted` (`protocol/src/protocol.rs`,
 *    serde-renamed), and `assess_patch_safety` (`core/src/safety.rs`) returns
 *    `SafetyCheck::AskUser` on the FIRST match for it — before the
 *    writable-path check, before `has_full_disk_write_access()`, before the
 *    sandbox policy is consulted at all. So in `explore` and `plan` the chain
 *    P3.238 reasoned about did not merely reach a different branch; it never
 *    ran, and every patch raised an `applyPatchApproval` that reached
 *    {@link CodexAgent.consultPermissionRules} and then the user's card.
 *
 *    **P7.2 (2026-09-11) RETIRED THE PREMISE OF THIS PARAGRAPH**, and it is
 *    recorded rather than deleted because the reasoning is still the right
 *    reasoning about a value that no longer exists. Upstream #39630 removed
 *    `untrusted` from the public config at `rust-v0.150.1` — fatally: the binary
 *    exits 1 rather than start — so the switch-off emission is `on-request`,
 *    that first `assess_patch_safety` match no longer fires, and the chain
 *    P3.238 reasoned about runs again. `UNBOUNDED_NEVER_DEGRADES_TO` carries the
 *    source reading and the operator notice; the posture question it leaves is
 *    filed as a row rather than settled here.
 *
 * **P3.238 STAYS CLOSED, on the other leg, which is unchanged and re-verified
 * at HEAD.** Its `SubmitPlan` half was DRIVEN over MCP stdio (27 tools, no
 * `SubmitPlan`, three positive controls) and nothing here touches it. Its
 * "nothing blocks edits in `explore`" half never needed the sandbox argument:
 * `runPreToolUseChecks` has zero call sites in this file (grep at HEAD: every
 * hit is `pi-agent.ts`), and the only mode-derived denial on the approval path
 * is `dontAsk`'s — `consultPermissionRules` reads the user's DSL and not the
 * permission mode, so an `explore` patch is not refused by us, it is put to the
 * user. The guidance was corrected for the right reason by the wrong argument.
 *
 * The residue this leaves is NOT in this file: `formatCodexModeGuidance`
 * (`mode-manager.ts`) told the codex model that `explore` is "a rule you keep
 * rather than a block you will hit" and that "Nessy does not check each action
 * before it runs" — sentences written against a runtime that asked about
 * nothing. Under `untrusted` codex asked about everything and this host
 * answered with floors and rules before the action ran — true when written, and
 * narrowed by P7.2 to dangerous commands and escalation requests once upstream
 * retired that policy. Rowed as P3.328 rather than
 * edited from here, and CLOSED: the user-facing twin
 * (`chat.permissionModeRuntimeNote.codex`) by `7843b293b` and both guidance
 * lines by the close-out lane, in the same words.
 */
type CodexResolvedSandboxType = 'dangerFullAccess' | 'readOnly' | 'externalSandbox' | 'workspaceWrite';

/**
 * What each written mode resolves to when nothing supersedes it — the CONTROL
 * arms above, as a table. `externalSandbox` is deliberately unreachable from
 * this map: no mode of ours asks for it, so seeing it is itself a divergence.
 */
const CODEX_MODE_RESOLVES_TO: Readonly<Record<CodexSandboxMode, CodexResolvedSandboxType>> = Object.freeze({
  'read-only': 'readOnly',
  'workspace-write': 'workspaceWrite',
  'danger-full-access': 'dangerFullAccess',
});

/**
 * P2.232 · how long a cold spawn may run before the user is TOLD it is running.
 *
 * ## The decision, and why it is a signal and not a deadline
 *
 * P2.138 bounded the optional probes and deliberately left `initialize` and
 * `thread/start` unbounded, for a reason this row does not overturn: both are
 * mandatory, and a bound on a mandatory call manufactures failures instead of
 * preventing them. What it left behind is the other half — a 35-second cold
 * start is indistinguishable from a hang, and nothing said which it was.
 *
 * The row offered two honest options: a progress signal, or a deadline generous
 * enough that only a true hang trips it. The distribution decides between them,
 * and it is far too wide for the second. Measured on the bundled
 * `darwin-arm64/codex-app-server`:
 *
 * | reading | `initialize` | `thread/start` |
 * | --- | --- | --- |
 * | P2.138, two cold spawns, 2026-08-27 | — | 10.5 s and 34.7 s for the pair |
 * | W3-a, first spawn of a cold binary, load 19, 2026-09-03 | 3 162 ms | 2 938 ms |
 * | W3-a, five later spawns, same run, fresh homes | 253-975 ms | 232-447 ms |
 * | P3.296, cold vs skills-warm homes, four pairs | — | 957 ms vs 771 ms median |
 *
 * That is a spread of about 170x on the same machine. A deadline safe against
 * the tail would be a minute, which detects nothing; one tight enough to detect
 * a hang fires on a loaded laptop. So: a signal.
 *
 * ## Native-first: the runtime has no progress channel, measured
 *
 * Every inbound frame between the `initialize` write and the `thread/start`
 * response was timestamped on the same rig. There are exactly three, on every
 * arm: the `initialize` response, one `remoteControl/status/changed`
 * notification (a family we opt out of), and `thread/started` AFTER the
 * response. Nothing reports progress, so the host has to.
 *
 * ## The numbers
 *
 * FIRST notice at 5 s — above every warm spawn measured (975 ms worst) by 5x, so
 * an ordinary start says nothing at all, and below the cold readings, so a cold
 * start does. Deliberately the same 5 s as
 * {@link CODEX_BACKGROUND_TERMINALS_TIMEOUT_MS}: both answer "has this
 * app-server stopped being quick?", and two numbers for one judgement is a
 * second rule to keep true.
 *
 * Then every 10 s, which keeps a 35-second spawn to three lines rather than
 * seven. Chosen against the measured tail, not against zero.
 *
 * NOTHING IS BOUNDED BY THIS. There is no timeout here and no throw; the ticker
 * stops when the spawn settles, either way.
 */
const CODEX_STARTUP_FIRST_NOTICE_MS = 5_000;

/** Follow-ups, after {@link CODEX_STARTUP_FIRST_NOTICE_MS}. See its docblock. */
const CODEX_STARTUP_NOTICE_INTERVAL_MS = 10_000;

/**
 * P2.232 · what a slow spawn is DOING, for the progress signal above.
 *
 * Set at the four awaited steps that can actually be slow. Any label other than
 * `null` reads as "still here"; the point of naming the step is that
 * "starting the codex runtime" and "codex is not answering `initialize`" call
 * for different actions from whoever is watching.
 */
type CodexStartupPhase =
  | 'starting the local model adapter'
  /** P6.532 · the adapter-less arm: the connection declared codex's own provider. */
  | 'routing to the declared model provider'
  | 'starting the codex app-server'
  | 'waiting for codex to initialize'
  /** F1.202 · the ChatGPT (Codex) card's `account/login/start`, between the two. */
  | 'signing codex in to the ChatGPT subscription'
  | 'opening the codex thread';

/** What one turn's attachments contribute to `turn/start`. */
export interface CodexAttachmentInput {
  /** Path-pointer text parts, in the `[Attached …]` shape Claude and Pi both emit. */
  pathParts: string[];
  /** Native `localImage` members, one per image whose bytes are readable on disk. */
  images: Array<{ type: 'localImage'; path: string }>;
  /** Names of images that could NOT be carried — the honest-loss report (P3.101). */
  uncarriedImages: string[];
  /**
   * P3.364 — names of NON-image attachments whose bytes this runtime does not
   * carry and whose contents no `Read` can recover: a PDF, an audio file, an
   * office file with no markdown twin.
   *
   * Kept apart from {@link CodexAttachmentInput.uncarriedImages} because the two
   * make DIFFERENT promises. An uncarried image is an accident — the file was
   * not readable on disk, and finding it would fix it. An uncarried document is
   * the runtime's own ceiling: codex's `UserInput` union has no document member,
   * so no fix at this layer carries the bytes, and the sentence a user reads
   * must not suggest otherwise.
   */
  uncarriedDocuments: string[];
}

/**
 * P6.28 · turn attachments on codex's OWN wire.
 *
 * `chatImpl` took `_attachments` and never read it, so an image dropped into
 * the composer reached this backend and stopped: the model never saw it, and —
 * because `modelSupportsImages` answered `true` for `codex-runtime` — nothing
 * upstream reported the loss either (P3.101). Every other runtime carries the
 * same attachment: Claude as a base64 `image` block beside a `[Stored at: …]`
 * text block (`claude-agent.ts:buildSDKUserMessage`), Pi as `images[]` beside
 * the same pointer text (`pi-agent.ts` attachment loop).
 *
 * This is the native-first rule paying off rather than a port: codex already
 * has the mechanism, and it wants a PATH, not bytes —
 * `LocalImageUserInput { type: 'localImage', path }`. Nothing is encoded, and
 * the file we point at is the one `handlers/rpc/files.ts` already wrote, which
 * is the RESIZED buffer when a resize happened (`writeFile(storedPath,
 * decoded)` runs after `decoded = result.buffer`) — so codex gets the same
 * API-sized image Claude does, not the original.
 *
 * Two deliberate refusals, both about not guessing:
 *
 * - **A non-absolute path is reported as uncarried, not sent.** The field is a
 *   plain `string` in the schema (not codex's `AbsolutePathBuf`), so a relative
 *   path would be resolved against the APP-SERVER's cwd, which is not
 *   necessarily ours. Sending it is a guess, and a guess that renders as a
 *   missing image is exactly the silent shape this row exists to remove. In
 *   production it cannot fire: `storedPath` is absolute and
 *   `readFileAttachment` resolves `path`.
 * - **A path that does not exist is reported too.** `existsSync` is injected so
 *   this stays a pure function under test.
 *
 * P3.364 — the DOCUMENT half of the same honesty. A PDF's bytes reach the model
 * on claude (`claude-agent.ts` emits a real `document`/base64 block) and reach
 * it on neither other runtime, and until this row no channel said so. See
 * {@link isUndecodableCodexAttachment} for the set, for why native-first is
 * closed at tier 1 on both, and for the one taxonomy member left out on purpose.
 *
 * The image predicate is `isImageAttachment`'s (`server-core`'s
 * `runtime-config.ts`) restated rather than imported: `shared` cannot depend on
 * `server-core`. Keep the two in step — a widened predicate there that is not
 * mirrored here re-opens the silent arm for the new type.
 *
 * ## P3.126 — AUDIO IS DECLINED HERE, NOT MISSING. Once, with the condition.
 *
 * An `audio` attachment takes the `[Attached file: …]` pointer above and its
 * bytes go nowhere. That is a decision, and this is the only place it is
 * written down.
 *
 * **Native-first, asked first: codex HAS the mechanism.** `UserInput::LocalAudio
 * { path }` (`app-server-protocol/src/protocol/v2/turn.rs`) is snapshotted by
 * `snapshot_local_user_input` (`protocol/src/local_media.rs`) into
 * `ContentItem::InputAudio { audio_url: "data:<mime>;base64,…" }` — wav, mp3,
 * m4a, webm, ogg, bounded at `MAX_PROMPT_AUDIO_INPUT_BYTES` (50 MB), all at
 * `rust-v0.148.0`. It is the exact shape of the `localImage` branch below, so
 * the composer half would be a handful of lines.
 *
 * **It is codex-ONLY by construction** (W3-b measured the other two): Anthropic
 * Messages has no audio content block, and pi-ai's `input` is (0.84.2, re-read
 * unchanged at 0.84.3 — W11-pi, 2026-09-11)
 * `("text"|"image")[]` — its one `audio` field is a PRICE. So this is not a
 * parity gap; it is a question about one runtime.
 *
 * **Declined, on the end of the wire rather than on effort.** Every shipped
 * codex connection runs through the loopback Responses adapter, and
 * `codex-responses-adapter/src/to-chat.ts` already RECOGNISES `input_audio` and
 * substitutes a visible marker ("the chat-completions API has no audio content
 * part") — the resting state P3.114 chose, where the loss is stated rather than
 * silent. Carrying audio here would move the loss one layer later and change
 * nothing a user sees on the upstream we ship.
 *
 * The owner's 2026-08-28 posture — *carry it faithfully and let the endpoint
 * refuse* — is conditional on carrying it at all, and being faithful END TO END
 * means `to-chat.ts` forwarding the part instead of substituting the marker.
 * That is a posture change on a shared adapter with a worse failure shape than
 * the one it replaces: a forwarded part the gateway rejects fails the WHOLE
 * request, where the marker costs one sentence and the turn still answers. The
 * image precedent is not an argument for it — that part was forwarded only
 * after the gateway was MEASURED naming it in a 400 ("Model Does Not Support
 * Image Inputs"), and no reachable model has been measured accepting audio.
 *
 * **What revives it, so this can be met rather than merely re-argued:** a model
 * in a reachable catalogue that declares audio input. On that day `to-chat.ts`
 * forwards `input_audio` for it, and the half missing HERE is one `localAudio`
 * branch beside the `localImage` one below, taking `storedPath` under the same
 * absolute-and-exists test and reporting an uncarried file the same way.
 */
export function buildCodexAttachmentInput(
  attachments: FileAttachment[] | undefined,
  fileExists: (path: string) => boolean = existsSync,
): CodexAttachmentInput {
  const pathParts: string[] = [];
  const images: Array<{ type: 'localImage'; path: string }> = [];
  const uncarriedImages: string[] = [];
  const uncarriedDocuments: string[] = [];

  for (const attachment of attachments ?? []) {
    const storedPath = attachment.storedPath || attachment.path;
    const isImage = attachment.type === 'image' || attachment.mimeType?.startsWith('image/') === true;
    const undecodable = !isImage && isUndecodableCodexAttachment(attachment);

    if (storedPath) {
      let pathInfo = `[Attached ${isImage ? 'image' : 'file'}: ${attachment.name}]\n[Stored at: ${storedPath}]`;
      if (attachment.markdownPath) {
        pathInfo += `\n[Markdown version: ${attachment.markdownPath}]`;
      }
      // P3.364 · the pointer stops inviting a wasted `Read`. Without this line
      // the model is handed a path and nothing else, and the ordinary next move
      // — reading it — returns undecodable bytes and costs a turn.
      if (undecodable) {
        pathInfo += '\n[Contents NOT available: this runtime carries the path only,'
          + ' and this file is not readable as text.]';
      }
      pathParts.push(pathInfo);
    }

    if (undecodable) uncarriedDocuments.push(attachment.name);
    if (!isImage) continue;

    if (storedPath && isAbsolute(storedPath) && fileExists(storedPath)) {
      images.push({ type: 'localImage', path: storedPath });
    } else {
      uncarriedImages.push(attachment.name);
    }
  }

  return { pathParts, images, uncarriedImages, uncarriedDocuments };
}

/**
 * P3.364 — an attachment whose BYTES this runtime does not carry and whose
 * contents no `Read` can recover.
 *
 * ## The gap this predicate serves
 *
 * `claude-agent.ts` emits a real `document`/base64 block for a PDF; Pi and codex
 * emit `[Attached file: …]\n[Stored at: …]` and stop. So the same PDF is READ by
 * the model on one runtime and is a filename on the other two — and no channel
 * said so: the model-input filter omits only images, the uncarried-attachment
 * warning names images only, the pre-send composer check is image-only, and the
 * capability model has no document axis at all (`files: true` everywhere).
 *
 * ## Native-first is CLOSED at tier 1, with its controls
 *
 * codex's `UserInput` union is seven members and none is a document; pi-ai
 * declares `input: ("text"|"image")[]` (0.84.2, re-read unchanged at 0.84.3 —
 * W11-pi, 2026-09-11; the `image` literal is the
 * control proving the probe reads the union). So this is a capability neither
 * runtime publishes, which is what leaves honest-loss as the option taken here
 * and host-uniform conversion as the one deliberately not taken — extending the
 * office→markdown conversion to PDFs would substitute EXTRACTED TEXT for the
 * real thing on the runtime that can carry the real thing, which is a product
 * posture rather than a repair.
 *
 * ## The set, and the member deliberately left out
 *
 * `FileAttachmentKind` is already the taxonomy, so nothing is guessed from a
 * mime string: `pdf` and `audio` are never decodable as text, and `office` is
 * only when its markdown twin exists — which the pointer already names.
 *
 * `unknown` is EXCLUDED on purpose. It is what the classifier answers for an
 * extension it does not know, which is most often a text file, and a warning
 * that fires on a readable file trains the reader to ignore the family. An
 * undecodable `unknown` therefore still costs one wasted `Read`; that residue is
 * stated rather than papered over with a guess.
 */
function isUndecodableCodexAttachment(attachment: FileAttachment): boolean {
  if (attachment.type === 'pdf' || attachment.type === 'audio') return true;
  if (attachment.type === 'office') return !attachment.markdownPath;
  return false;
}

/**
 * Is this notification scoped to a thread OTHER than the session's own?
 *
 * The app-server multiplexes every thread's notifications over one connection,
 * and a codex agent role spawns real subagent threads. Anything carrying a
 * `threadId` that is not ours belongs to a child (or a sibling) and must not
 * drive this session's transcript, turn lifecycle, or usage. A notification
 * with no threadId is connection-scoped and is never filtered; before the
 * session's own thread exists (`sessionThreadId` null) nothing is filtered,
 * because there is nothing to attribute to yet.
 */
export function isForeignThreadNotification(params: unknown, sessionThreadId: string | null): boolean {
  const threadId = (params as { threadId?: unknown } | null | undefined)?.threadId;
  return typeof threadId === 'string' && sessionThreadId !== null && threadId !== sessionThreadId;
}

/**
 * P2.508 — the notification that says an MCP server did not come up.
 *
 * `McpServerStatusUpdatedNotification` in
 * `codex-protocol/generated/v2/McpServerStatusUpdatedNotification.ts`:
 * `{ threadId, name, status, error, failureReason }`, where `status` is
 * `McpServerStartupState` — `starting` | `ready` | `failed` | `cancelled`.
 */
export const CODEX_MCP_STARTUP_STATUS_METHOD = 'mcpServer/startupStatus/updated';

/**
 * P2.508 — turn one `mcpServer/startupStatus/updated` into the operator's
 * sentence, or `null` for the frames that are not news.
 *
 * ## What this closes, and what it deliberately does not
 *
 * Codex is the only one of the three runtimes with a mechanism here, and it has
 * TWO — measured against the shipped `darwin-arm64` `codex-app-server` (SHA-256
 * byte-identical to `codex-protocol/manifest.json`'s pinned `binarySha256`),
 * each arm with its control:
 *
 * - `required = true` on an `[mcp_servers.<name>]` entry: `thread/start` and
 *   `thread/resume` both FAIL, naming the server. Works identically on the
 *   stdio and `url` transports. The control is the same config without the key:
 *   both succeed.
 * - No `required`: this notification fires twice per server — `starting`, then
 *   `failed` carrying a real `error` string — about 1 ms after the `thread/start`
 *   response, in the same flush class as `thread/started`.
 *
 * **They are mutually exclusive.** With `required` the thread never starts, so
 * this notification never arrives; measured, the hard arm emitted no
 * `mcpServer/*` frame at all. There is no setting that both refuses to run
 * degraded and explains itself, so a client picks one.
 *
 * We take the soft one, and {@link writeCodexConfig} states why it does not
 * write `required`: the product emits exactly two `[mcp_servers.*]` entries
 * (`session` and `sources`), so the key could only ever mark OUR two servers,
 * never an operator's.
 *
 * Not a substitute for the missing per-server mark, and it must not read as
 * one: this says "codex could not start this server", which for `sources` means
 * the whole pool endpoint, not the one server an operator cared about.
 *
 * ## Why not `mcpServerStatus/list`
 *
 * It looks like the observability channel and is not one. Measured on the same
 * rig, it returns the failed server as `serverInfo: null`, `tools: {}`, with no
 * failure reason — and returns BYTE-IDENTICALLY in the hard and soft arms, so
 * it cannot even separate "one server is down" from "the session refused to
 * start". This notification is the only channel carrying the reason.
 *
 * Pure and total, because its one caller runs inside the transport's
 * synchronous notification dispatch, where a throw takes the rest of the
 * dispatch with it.
 */
export function codexMcpStartupFailureNotice(params: unknown): string | null {
  const frame = params as {
    name?: unknown;
    status?: unknown;
    error?: unknown;
    failureReason?: unknown;
  } | null | undefined;
  // `starting` / `ready` / `cancelled` are not news for an operator, and
  // `cancelled` least of all — it is what a teardown looks like.
  if (frame?.status !== 'failed') return null;
  const name = typeof frame.name === 'string' && frame.name.trim() ? frame.name.trim() : null;
  const named = name ? `MCP server "${name}"` : 'An MCP server';
  const reason = typeof frame.error === 'string' && frame.error.trim()
    ? frame.error.trim().slice(0, 400)
    : null;
  // The fail-soft posture, said to the person affected by it. Two docblocks
  // already state it to a developer reading the type; this is the half that
  // reaches a user, and it is the whole point of the row.
  const consequence = ' — this session is running without its tools.';
  const reauth = frame.failureReason === 'reauthenticationRequired'
    ? ' It needs to be signed in again.'
    : '';
  return `Codex: ${named} failed to start${consequence}${reauth}${reason ? ` (${reason})` : ''}`;
}

/**
 * P3.2 · the auto-review options `writeCodexConfig` receives, derived from the
 * two `codexAutoReview*` settings. Pure + exported so the setting → config-writer
 * wiring is unit-tested without spawning the runtime.
 *
 * OFF (the default) → `{}`, so the writer emits nothing. ON →
 * `approvals_reviewer = "auto_review"`, plus `[auto_review].policy` only when a
 * non-blank policy is set. The writer still applies its own eligibility gate (a
 * `never` approval policy emits neither), so this never forces an inert key.
 */
export function buildCodexAutoReviewOptions(
  enabled: boolean,
  policy: string,
): { approvalsReviewer?: 'auto_review'; autoReviewPolicy?: string } {
  if (!enabled) return {};
  const trimmed = typeof policy === 'string' ? policy.trim() : '';
  return { approvalsReviewer: 'auto_review', ...(trimmed ? { autoReviewPolicy: policy } : {}) };
}

/**
 * The turn id out of a `TurnStartedNotification`, or null when the payload does
 * not carry one.
 *
 * `TurnStartedNotification = { threadId, turn: Turn }` and `Turn.id` is the
 * "Identifier for this turn" (`codex-protocol/generated/v2/Turn.ts`) — so the id
 * is one level DOWN, not on the notification itself, which is the mistake a
 * `params.turnId` read would make. A non-string is reported as absent rather
 * than coerced: `expectedTurnId` is a precondition the server rejects, and a
 * `"undefined"` sent as a turn id is a refusal we manufactured ourselves.
 */
export function readCodexTurnId(params: unknown): string | null {
  const id = (params as { turn?: { id?: unknown } } | null | undefined)?.turn?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * The assistant's own text out of an `item/completed` notification, or null for
 * every other kind of item.
 *
 * `ItemCompletedNotification = { item: ThreadItem, threadId, turnId,
 * completedAtMs }` and the assistant arm of `ThreadItem` is
 * `{ "type": "agentMessage", id, text, phase, memoryCitation }`
 * (`codex-protocol/generated/v2/ThreadItem.ts:30`). Every OTHER item type that
 * carries a `text` — `plan`, `reasoning`'s summaries, a tool row — must read as
 * absent here: this text is what a structured turn is validated against, and
 * validating a reasoning summary against the caller's schema would fail a turn
 * whose real answer was fine. An EMPTY string is returned as-is rather than as
 * null, because "the model answered with nothing" is its own documented result
 * and is not the same as "this notification was about something else".
 */
export function readCodexAgentMessageText(params: unknown): string | null {
  const item = (params as { item?: { type?: unknown; text?: unknown } } | null | undefined)?.item;
  if (!item || item.type !== 'agentMessage' || typeof item.text !== 'string') return null;
  return item.text;
}

/**
 * Does this item notification belong to the turn a structured obligation is
 * pinned to?
 *
 * `ItemCompletedNotification` declares `turnId` REQUIRED
 * (`codex-protocol/generated/v2/ItemCompletedNotification.ts`), but the
 * adapter's own message-identity reader already treats it as optional
 * (`backend/codex/event-adapter.ts:459` falls back when it is not a non-empty
 * string), and the bindings are known to lag the binary both ways — so an
 * unreadable id is degraded to a MATCH rather than a mismatch. Same for an
 * unpinned obligation: both mean "no evidence this is someone else's turn",
 * and refusing on no evidence would report "no structured output" for a turn
 * that answered.
 */
export function itemBelongsToTurn(params: unknown, pinnedTurnId: string | null): boolean {
  if (pinnedTurnId === null) return true;
  const turnId = (params as { turnId?: unknown } | null | undefined)?.turnId;
  if (typeof turnId !== 'string' || turnId.length === 0) return true;
  return turnId === pinnedTurnId;
}

/**
 * The identity of a codex thread's configuration layer.
 *
 * ## P6.365 — the MODEL came back out, and the premise it was put in on was wrong
 *
 * This docblock used to say "codex fixes a thread's model at `thread/start` and
 * `turn/start` carries no model". **Measured at HEAD, that is false**, and it
 * had been false since the tag our binary is built from:
 * `packages/codex-protocol/schema/v2/TurnStartParams.json` declares
 * `model: {"description": "Override the model for this turn and subsequent
 * turns.", "type": ["string","null"]}`, with `effort`, `summary`, `serviceTier`
 * and `personality` beside it carrying the same sentence. Codex HAS a
 * per-turn model override and we were not sending it.
 *
 * The cost of the wrong premise was a `thread/fork` on every model change: the
 * fork preserves history, so the visible behaviour was correct, but a mid-session
 * model switch spent a round trip, took the {@link CODEX_THREAD_REFORK_TIMEOUT_MS}
 * budget, moved the thread id, and on a rollout-less thread fell through to a
 * `thread/start` that begins an empty one. The fix is to send what the wire
 * already declares — `turn/start` now carries `model` — and to stop calling a
 * model change a CONFIG drift, which it never was.
 *
 * What stays in here is what genuinely cannot ride a turn: the sandbox and
 * approval layer, the writable paths, the denied-read map. `config.toml` is
 * read when the app-server STARTS and `TurnStartParams` has no member for any
 * of it, so a change there still needs the fork.
 *
 * ONE builder, called from both the `thread/start` and the `thread/fork` side,
 * because two hand-written copies of "what makes a thread stale" is exactly the
 * drift that produced the original bug.
 */
export function codexThreadConfigSignature(config: unknown): string {
  return JSON.stringify({ config });
}

/**
 * The runtime fields a live codex agent is pinned to and cannot re-point.
 *
 * `baseUrl` is the EFFECTIVE upstream base URL, i.e. what
 * {@link buildCodexRuntimeUpstream} derived — `undefined` means the built-in
 * gateway (`kind: 'nestor'`), which is the whole reason this is not the
 * connection's raw `baseUrl`. See {@link codexUpdateIsModelOnly}.
 */
export interface CodexPinnedRuntime {
  providerType: LlmProviderType | undefined;
  authType: LlmAuthType | undefined;
  baseUrl: string | undefined;
}

/**
 * May this runtime update be applied to a LIVE codex agent?
 *
 * Only a model change may. The adapter, its upstream credential and the managed
 * `CODEX_HOME` are all established once in `createRuntime` from `this.config`,
 * which never mutates — so an endpoint, provider or auth change cannot be
 * re-pointed in place and must fall through to a backend recreate.
 *
 * An update whose runtime block merely REPEATS the pinned values is still
 * model-only: `SessionManager` sends the whole connection shape on every
 * refresh, so requiring an absent block would decline every real update.
 *
 * The endpoint is compared as the DERIVED upstream, never as the raw string.
 * `SessionManager.runAgentRuntimeRefresh` sends `connection.baseUrl`, and on a
 * gateway card that is the gateway URL — which {@link buildCodexRuntimeUpstream}
 * maps to `{ kind: 'nestor' }`, whose pinned base URL is `undefined`. Comparing
 * the two strings directly declined every gateway model change, i.e. the
 * feature on its primary card.
 *
 * `update.model` is deliberately not read: it is the field being changed, and
 * this predicate answers only whether everything ELSE stayed put. The parameter
 * is the whole `BackendRuntimeUpdate` rather than a `Pick` of the other three
 * so a caller may pass the update it actually received — a `Pick` rejects the
 * `model` key under excess-property checking at every literal call site.
 */
export function codexUpdateIsModelOnly(
  update: BackendRuntimeUpdate,
  pinned: CodexPinnedRuntime,
): boolean {
  if (update.providerType !== undefined && update.providerType !== pinned.providerType) return false;
  if (update.authType !== undefined && update.authType !== pinned.authType) return false;
  const nextBaseUrl = update.runtime?.baseUrl;
  if (nextBaseUrl !== undefined) {
    const next = buildCodexRuntimeUpstream({ baseUrl: nextBaseUrl });
    const nextEffective = next.kind === 'openai-compatible' ? next.baseUrl : undefined;
    if (nextEffective !== pinned.baseUrl) return false;
  }
  return true;
}

// F1.191 / F1.196 — read by `codexSandboxReadFloorArgs` only, and placed HERE
// rather than with the imports at the top because `docs/**` cites this file by
// line (highest citation 10174) and an import added up there would move every
// citation below it. Import declarations are hoisted.
import { resolveSessionToolSandboxReadFloor } from './pi-harness/session-tool-sandbox-read-floor.ts';
import { latchedHomeDir } from '../config/home-latch.ts';
// F1.227 — the gate's own rule and sentence, read by `unattendedAutomationEditFloor`;
// imported at the end for the same line-citation reason as the two above.
import { describeUnattendedAutomationEdit, unattendedAutomationEdit } from './core/pre-tool-use.ts';
// F1.234 — the tool name codex's MCP tool-call approval names, read by
// `readOnlyModeSessionToolRefusal`; imported at the end for the same reason.
import { codexMcpToolCallRowName } from '@nessy-agent/codex-agent-server';

/**
 * F1.272 (origin WJ-z P-WJ-z-1) — the rule request for codex's MCP TOOL-CALL
 * approval, so a user's allow/deny rule answers codex's card the way it answers
 * the same call on Pi and claude.
 *
 * ## The premise this replaces
 *
 * {@link codexApprovalRuleRequests} returned `[]` for every elicitation on the
 * premise that one "carries no wire tool name". At `rust-v0.154.0` codex's MCP
 * tool-call approval (`_meta.codex_approval_kind = "mcp_tool_call"`,
 * `core/src/mcp_tool_call.rs`, `build_mcp_tool_approval_fallback_message`) names
 * the tool in its fixed sentence, and `codexMcpToolCallRowName`
 * (`codex-agent-server/src/approval-bridge.ts`, F1.218) reads it — measured on
 * the shipped binary, `codex-mcp-tool-approval-modes.test.ts`.
 *
 * ## The name, and why the DSL's missing `sources` shift does not bite
 *
 * The request carries the HOST's name for the call
 * (`hostMcpToolNameForCodexRow`, `capabilities/mcp-wire-name.ts`): a pool tool
 * is `mcp__<wire>__<tool>`, as `base-event-adapter.ts` `buildMcpToolName`
 * records it on Pi and claude, and a session tool keeps `mcp__session__<tool>`,
 * which is claude's spelling (F1.379 adds Pi's, below). The `mcp` matcher takes the
 * second `__` segment as the server with no bridge shift, so handing it codex's
 * row name would read server `sources` and miss every Pi-spelled rule; the shift
 * happens HERE, once, before the matcher. The consequence is stated and pinned
 * (`codex-mcp-tool-call-permission-rules.test.ts`): a rule spelled in codex's
 * row form names a server no runtime records and matches nothing.
 *
 * `semanticId` is `mcp_dynamic`, the descriptor Pi judges a pool tool under
 * (`pi-harness/harness-manifest.ts`), and `input` is the call's own arguments
 * (`_meta.tool_params`), which is what Pi's gate reads — so a `parameter` or
 * `Host` rule judges the same fields here as there.
 *
 * Everything around the answer is unchanged: a floor still suspends an allow
 * (P2.123, F1.227's automation floor included), a read-only mode still keeps an
 * allow from widening it, a deny still refuses in every mode, and the
 * url-scheme gate never sees a request from here — a url elicitation is not a
 * tool call and projects nothing.
 */
function codexMcpToolCallRuleRequests(p: Record<string, unknown>, cwd: string): CodexApprovalRuleRequest[] {
  if (p.mode === 'url') return [];
  const meta = isPlainRecord(p._meta) ? p._meta : {};
  const rowName = codexMcpToolCallRowName(p, meta);
  if (!rowName) return [];
  const input = isPlainRecord(meta.tool_params) ? { ...meta.tool_params } : {};
  const toolName = hostMcpToolNameForCodexRow(rowName);
  const alias = codexSessionToolPiAlias(toolName);
  return [{ toolName, semanticId: 'mcp_dynamic', input, cwd, ...(alias ? { alias } : {}) }];
}

// F1.272 — the host vocabulary's name for a codex MCP row, read by
// `codexMcpToolCallRuleRequests`; imported at the end for the line-citation reason above.
import { hostMcpToolNameForCodexRow } from '../capabilities/mcp-wire-name.ts';

// F1.192 — the floor's `~` anchored on the latched home when the codex child's HOME moved;
// imported at the end for the line-citation reason above.
import { anchorCodexFloorOnCredentialHome, codexDenyReadEntryCount } from '@nessy-agent/codex-responses-adapter/config-writer'; // F1.1057

/**
 * F1.200 — the workspace's own RECORDS, read-only to codex exactly when its cwd IS
 * the workspace root.
 *
 * Codex writes never pass `runPreToolUseChecks`, so F1.123's `hooks.json` ask and
 * D1.438's `automations.json`/`permissions.json` refusal reach codex only through
 * codex's own sandbox. Measured 2026-09-23 on the vendored `codex-app-server`
 * with the host-shaped `acceptEdits` config (`command/exec`, fake workspace):
 * with a project cwd a write to `<workspaceRoot>/hooks.json` is refused by the OS
 * (`Operation not permitted`), so codex has to escalate and the ask reaches the
 * host's card; with the cwd AT the workspace root — every session that chose no
 * project, since `BaseAgent` falls back to `workspaceRootPath` — the write exits 0
 * and the file changes, unasked. A `":workspace_roots"` `read` subpath refuses it
 * (the read and a sibling write still work), so this is C3.343's mechanism
 * extended to the four record FILES for that population only.
 *
 * For the three D1.438 records that is the same posture (refused). For
 * `hooks.json` it is a REFUSAL where Pi and claude ASK — codex has no ask for a
 * write inside a writable root — which is C3.343's stated asymmetry, attributed
 * on the diagnostic channel by `formatCodexProtectedPathFloorDiagnostics`. With a
 * project cwd nothing is added: codex already asks there.
 *
 * F1.653 — and whenever the workspace root lies BELOW the cwd, the same records
 * travel relative to it (`.nessy-agent-1/workspaces/<id>/permissions.json`),
 * because the cwd's writable root then covers them too. Measured 2026-09-25 on
 * the shipped `codex-app-server` 0.156.1 (`buildCodexConfigToml`, `default`,
 * `command/exec`, rig under `$HOME`): with the cwd the home directory and a MOVED
 * config dir, or the cwd `<config dir>/workspaces`, all three records were
 * written with exit 0 and nothing asked; with the relative `read` subpaths each
 * write fails `Operation not permitted` while a sibling write and a read still
 * work. (With the default `~/.nessy-agent` and the cwd at home, the directory
 * floor's `.nessy-agent` entry already made the whole config dir read-only.) A
 * relative path codex cannot take as a subpath — a glob character in it —
 * projects nothing rather than failing the config write: a stated residue.
 *
 * F1.927 — the spelling travels verbatim (a `~cfg` or a space-edged folder name is an
 * ordinary subpath to codex; measured 2026-09-26 on 0.156.1: the record write refused, its
 * read and a sibling write kept). Only a first folder named exactly `~` has no subpath
 * spelling, since codex reads `~/…` there as a HOME path: that layout projects nothing
 * here and {@link codexWorkspaceRecordDenyPaths} denies the records instead.
 */
function codexWorkspaceRecordSubpaths(workingDirectory: string, workspaceRootPath: string): string[] {
  if (!workingDirectory || !workspaceRootPath) return []
  const below = relativePath(resolvePath(workingDirectory), resolvePath(workspaceRootPath))
  const first = below.split(pathSeparator)[0]
  if (isAbsolute(below) || first === '..' || first === '~' || /[*?[\]]/.test(below)) return []
  const prefix = below === '' ? '' : `${below.split(pathSeparator).join('/')}/`
  return codexWorkspaceRecordNames().map(record => `${prefix}${record}`)
}

// F1.653 — the workspace root's place below the cwd; imported at the end for the
// line-citation reason above.
import { relative as relativePath } from 'node:path';

// F1.200 — the record names the host's own gate guards; imported at the end for the
// line-citation reason above.
import { GUARDED_WORKSPACE_RECORDS } from './core/pre-tool-use.ts';

/** F1.123's record, which the host floor keys on the workspace root. */
const WORKSPACE_HOOK_RECORD = 'hooks.json'

/**
 * UA12.8 follow-up (LF-2-fix, 2026-10-09) — the workspace-relative records codex's profile keeps from
 * agent commands, for both projections ({@link codexWorkspaceRecordSubpaths}, {@link codexWorkspaceRecordDenyPaths}):
 * the guarded records, F1.123's hook record, and the t-artifacts registry
 * ({@link ARTIFACT_REGISTRY_RELATIVE_PATH}). The registry is here because the host acts on it with no
 * card: an entry carrying `pendingDelete` is DELETED on the service with the user's token at the next
 * Artifacts list or dp `ready` boundary (`retryOwedArtifactDeletes`, server-core `handlers/rpc/artifacts.ts`),
 * so a no-project codex command that added the field deleted the user's pages silently. Measured
 * 2026-10-09 on the shipped codex-app-server 0.159.3 (`default`, `command/exec`, cwd a workspace root
 * under `$HOME`): as a `read` subpath the write, an unlink, a create and `mv artifacts` all fail
 * `Operation not permitted`; the read and a sibling `artifacts/other.txt` write still work. Only the
 * WRITE is taken: the read stays open on codex (UA12.8, `codexDenyReadEntryCount`). Not in
 * {@link codexDataFolderControlTarget}'s set (that reader matches one segment below a workspace).
 */
function codexWorkspaceRecordNames(): string[] {
  return [...GUARDED_WORKSPACE_RECORDS.keys(), WORKSPACE_HOOK_RECORD, ARTIFACT_REGISTRY_RELATIVE_PATH].sort()
}

// UA12.8 follow-up — imported at the end for the line-citation reason above.
import { ARTIFACT_REGISTRY_RELATIVE_PATH } from '../artifacts/registry.ts';

/**
 * F1.659 — the same records (five since UA1.10) as ABSOLUTE paths for codex's denied-read map, exactly
 * when an ADDED directory lies at or above the workspace root and the cwd does not
 * already carry them ({@link codexWorkspaceRecordSubpaths} returned nothing).
 *
 * Measured 2026-09-25 on the shipped `codex-app-server` 0.156.1 (`buildCodexConfigToml`,
 * `default`, `command/exec`, cwd a project beside the workspace, rig under `$HOME`, 0
 * escalations asked): with the home directory added (default or moved config dir), the
 * config dir added, its `workspaces` folder added, or the workspace root itself added,
 * all three record writes exit 0 and the files change, unasked. An added directory is a
 * flat `write` key and codex resolves the `":workspace_roots"` table against the cwd
 * only — the records written relative to the ADDED root in that table still landed. As
 * absolute `deny` keys each write fails `Operation not permitted`, a missing record
 * cannot be created, and a sibling write inside the workspace still lands. An added
 * directory beside the workspace needs nothing (refused already), and whenever the cwd
 * covers the workspace root its more specific `read` entry wins over any added grant
 * (measured with the grant at, above and below the cwd).
 *
 * F1.670 — carried as absolute `read` keys ({@link CodexAgent.codexReadOnlyPaths}, the writer's
 * `readOnlyPaths`), no longer `deny`: an absolute `read` key also refuses the writes and keeps
 * the reads (measured on 0.156.1 by WJ-crit-g/WJ-crit-j, re-measured on 0.159.3 by BK-8), so an
 * agent COMMAND can read the records again in this layout. The function keeps its F1.659 name.
 * A workspace root spelled with a glob character projects nothing, as in F1.653. `$TMPDIR` and `/tmp` are writable roots too and are NOT covered: a config dir
 * under either is a residue, recorded rather than taken.
 *
 * F1.927 — also when the cwd covers the root only through a folder named exactly `~`
 * (no subpath spelling, see {@link codexWorkspaceRecordSubpaths}); measured 2026-09-26 on
 * 0.156.1: the absolute `deny` refuses the write under the cwd, a sibling write lands.
 *
 * F1.696 — coverage is judged by real path as well as as written, on both sides, and the cwd counts
 * as a covering root when only its real path covers the workspace's; the keys are emitted under every
 * spelling of the root ({@link codexRecordRootSpellings}: only the real one binds on codex). A root
 * reached through a symlink keeps its records read-only where an added directory, or the cwd, holds
 * its real folder. Measured 2026-10-09 on 0.159.3 (`work/bk-10/f1696-probe.ts`), with the real-path
 * keys: a hard link to a record (into the cwd or the added directory), a rename of the record or of
 * the workspace folder, and a write through a new symlink in the cwd are all refused
 * `Operation not permitted`, which answers F1.696's rename/hardlink question for the records.
 */
function codexWorkspaceRecordDenyPaths(
  workingDirectory: string, workspaceRootPath: string, addedRoots: readonly string[],
): string[] {
  if (!workspaceRootPath) return []
  const roots = codexRecordRootSpellings(workspaceRootPath) // F1.696 — as written, then the real path when it differs
  if (codexWorkspaceRecordSubpaths(workingDirectory, workspaceRootPath).length > 0 && roots.length === 1) return []
  if (roots.some(root => /[*?[\]]/.test(root))) return []
  const root = roots[0]!
  const homeSpelled = !!workingDirectory && relativePath(resolvePath(workingDirectory), root).split(pathSeparator)[0] === '~'
  // F1.696 — every writable root (the cwd too) compared as written AND by real path, against both spellings of the root.
  const covered = homeSpelled || [...(workingDirectory ? [workingDirectory] : []), ...addedRoots].some(added =>
    codexRecordRootSpellings(added).some(spelled => roots.some(candidate => {
      const below = relativePath(spelled, candidate)
      return !isAbsolute(below) && below.split(pathSeparator)[0] !== '..'
    })))
  if (!covered) return []
  return roots.flatMap(spelled => codexWorkspaceRecordNames().map(record => join(spelled, record)))
}

/**
 * F1.696 — a path as written and, when it exists and differs, by its real path. Codex resolves a writable
 * root by its real path but matches an absolute `read` key AS SPELLED: measured 2026-10-09 on the shipped
 * `codex-app-server` 0.159.3 (`work/bk-10/f1696-probe.ts`, rig under `$HOME`), a record key spelled
 * through a symlinked workspace root leaves the write landing, the same key by the real path refuses it.
 */
function codexRecordRootSpellings(path: string): string[] {
  const literal = resolvePath(path)
  try {
    const real = realpathSync(literal)
    return real === literal ? [literal] : [literal, real]
  } catch {
    return [literal]
  }
}

/**
 * F1.664 — the WHOLE Nessy config dir (global `hooks.json`, `mcp.json`, `config.json`,
 * `permissions/default.json`, `skills/`, every OTHER workspace's records) kept out of reach
 * of codex agent commands whenever a codex writable root contains it. F1.200/F1.653/F1.659
 * protected only the session's own four records.
 *
 * Measured 2026-09-25 on the shipped `codex-app-server` 0.156.1 (`work/wjcritj/f1664-probe.ts`:
 * `buildCodexConfigToml`, `default`, `command/exec`, rig under `$HOME`, 0 escalations asked).
 * Every one of those files was written with exit 0, and a new `skills/<x>/SKILL.md` created,
 * with the cwd at home and a MOVED config dir, with the cwd AT the config dir (the default
 * name too), and with home ADDED as a directory. The default layout (cwd home,
 * `~/.nessy-agent`) and a sibling project were refused. The rename-an-ancestor bypass does
 * not land: `mv` of the workspace dir, of `workspaces`, of the config dir itself (parent
 * writable) and of a record all fail `Operation not permitted` in every layout — codex
 * protects the ancestors of a read entry. Three carriers, each measured closing it:
 *
 * - the config dir strictly below the cwd: its cwd-relative `":workspace_roots"` `read`
 *   subpath — reads kept, a write anywhere under it refused;
 * - the cwd IS the config dir: `"." = "read"`, the whole cwd read-only (an absolute `read`
 *   key on the cwd's own path LOSES to the cwd's write, measured) — and likewise a cwd
 *   INSIDE the config dir but outside the session's own workspace root (its `workspaces`
 *   folder, say), where other workspaces' records sit under the cwd;
 * - the config dir under ANOTHER writable root (`$TMPDIR`, `/tmp`, an added directory): an
 *   absolute key, because codex resolves `":workspace_roots"` against the cwd only (F1.659).
 *   F1.678 — `read` since 2026-10-09, `deny` before (measured on 0.159.3, `work/bk-8/f1670-probe.ts`
 *   and `config-writer-protected-workspace-paths.test.ts`: with home added, and under `$TMPDIR`,
 *   every write under the config dir fails `Operation not permitted` and a read works), so agent
 *   COMMANDS read the config dir again there; a cwd inside it still writes there (its more
 *   specific root wins, measured).
 *
 * DECIDED (TRANSPARENT and SIMPLE): a relative spelling whose first folder is named exactly
 * `~` (codex reads `~/…` as a home path) falls back to the absolute key instead of failing
 * the boot; F1.1114 aligned this with the writer's F1.927 grammar, so a `~cfg` or a
 * whitespace-edged folder name travels verbatim as a `read` subpath and keeps its reads
 * (both spellings measured honoured by codex 0.156.1, DN-087); a glob
 * character anywhere in the config dir path
 * projects nothing (codex takes a glob key only as a pattern) — a stated residue. Paths are
 * compared as written AND as real paths, so a symlinked cwd or config dir is caught too.
 *
 * RESIDUES (F1.700, stated rather than taken):
 * - (closed by F1.678) the absolute key was a `deny` until 2026-10-09, so in that layout an agent
 *   COMMAND could neither read nor run any file under the config dir (`skills/`, plugins' files);
 *   as a `read` key it reads them, and only writes there are refused;
 * - the cwd-inside-the-config-dir carrier keys on the session's workspace root (`ownWorkspace`
 *   below): a workspace root that itself CONTAINS the config dir makes every cwd inside the
 *   config dir "its own workspace", and no `"." = "read"` entry is projected there;
 * - F1.664's probe drove `command/exec` only; that the model-driven `apply_patch` path meets
 *   the same projection is a hypothesis owed a live reading.
 * - F1.697 (decided 2026-10-09 under the owner's rule: codex defaults, no heuristic): only THIS
 *   instance's config dir is projected. A sibling instance's relocated config dir (a second app
 *   run with another `NESSY_CONFIG_DIR`, `~/.nessy-agent-1` say) stays writable to this session's
 *   agent commands wherever a codex writable root contains it — a multi-instance residue. A
 *   pattern over `~/.nessy-agent-*` would guess at directories no instance told this one about.
 */
export function codexConfigDirProjection(
  workingDirectory: string, configDir: string, workspaceRootPath: string | undefined, otherRoots: readonly string[],
): { subpaths: string[]; deny: string[] } { // F1.678 — `deny` keeps its F1.664 name: the absolute paths, carried as `read` keys since F1.678
  const spellings = (path: string): string[] => {
    const literal = resolvePath(path)
    try {
      const real = realpathSync(literal)
      return real === literal ? [literal] : [literal, real]
    } catch {
      return [literal]
    }
  }
  const below = (root: string, path: string): string | undefined => {
    const rel = relativePath(root, path)
    return isAbsolute(rel) || rel.split(pathSeparator)[0] === '..' ? undefined : rel
  }
  const configs = spellings(configDir)
  const subpaths = new Set<string>()
  let unexpressible = false
  for (const cwd of workingDirectory ? spellings(workingDirectory) : []) {
    for (const config of configs) {
      const rel = below(cwd, config)
      if (rel === undefined) {
        const ownWorkspace = workspaceRootPath ? spellings(workspaceRootPath).some(ws => below(ws, cwd) !== undefined) : true
        if (below(config, cwd) !== undefined && !ownWorkspace) subpaths.add('.')
      } else if (rel === '') {
        subpaths.add('.')
      } else {
        const segments = rel.split(pathSeparator)
        if (segments[0] === '~' || /[*?[\]]/.test(rel)) unexpressible = true // F1.1114 — the writer's F1.927 grammar: only `~` alone or `~/…` is codex's home spelling
        else subpaths.add(segments.join('/'))
      }
    }
  }
  const covered = unexpressible || otherRoots.some(root => spellings(root).some(r => configs.some(c => below(r, c) !== undefined)))
  return { subpaths: [...subpaths].sort(), deny: covered ? configs.filter(c => !/[*?[\]]/.test(c)) : [] }
}

/**
 * F1.194 (F1.104's residue) — the HOST's user-memory root, for the one install the
 * session-MCP child cannot answer for on its own.
 *
 * The child resolves `getUserMemoryFilePath()` itself only when its `CONFIG_DIR`
 * equals `--config-root`; codex's `create_env_for_mcp_server` allowlist does not
 * carry `NESSY_CONFIG_DIR`, so on a moved-config install it kept
 * `join(configRoot, MEMORY.md)` — with `autoMemoryDirectory` set, a second index
 * the host's loader never reads (`getUserMemoryRoot()` =
 * `getAutoMemoryDirectory() ?? CONFIG_DIR`). F1.118's shape: emitted ONLY when the
 * root differs from `--config-root`, so every install that set nothing spawns
 * HEAD's argv byte-for-byte; a SETTING-class flag, so the turn-head comparison
 * (F1.116) re-spawns the child when an operator moves the directory mid-session.
 * A read that throws emits nothing and leaves the child's own ground rule.
 */
function codexUserMemoryRootArgs(): string[] {
  let root: string
  try {
    root = getUserMemoryRoot()
  } catch {
    return []
  }
  return root === CONFIG_DIR ? [] : ['--user-memory-root', root]
}

// F1.194 — the host's one answer to where the user-memory index lives; imported at
// the end for the line-citation reason above.
import { getUserMemoryRoot } from './memory/memory-store.ts';

/**
 * F1.373 (DECIDED 2026-09-23, fix (i)) — what one `turn/start` says about who
 * reviews an escalated approval.
 *
 * Read at `rust-v0.154.0`: `Session::request_approval` (`core/src/tools/approvals.rs`) orders "1. Hooks
 * 2. If StrictAutoReview || Guardian enabled, then Guardian. Else, user." — this host is the "user" arm, so
 * with the reviewer on, F1.234's plan refusal and the rule consult never run. A read-only mode must never be
 * decided by a reviewer, so `plan` sends `'user'`; F1.1056: so does `dontAsk`; F1.1169: and Manual and Accept edits, which ask the user — only Auto and Bypass keep the reviewer. The update is STICKY —
 * `core/src/session/step_settings.rs` keeps it in both `selected.approvals_reviewer` and
 * `mcp_approvals_reviewer_override` ("for this turn and subsequent turns") — so Auto and Bypass say
 * `'auto_review'` again rather than inheriting the last `'user'` turn's reviewer.
 *
 * `configured` is what the written `config.toml` carries (`CodexAgent.configuredApprovalsReviewer`). With
 * none (the toggle off at the build, the shipped default) and no administrator list, the turn carries no
 * field — HEAD's wire, byte for byte.
 *
 * F1.781 — `settingOn` is the Settings toggle, re-read at every turn: turned OFF in a session whose config
 * carries the reviewer, every mode sends `'user'`, because the override is sticky and a turn asking for
 * nothing kept the reviewer until a fresh session. Turned ON after a build without it, nothing changes.
 *
 * ## F1.482 (1) — an administrator's `allowed_approvals_reviewers`
 *
 * `allowed` is that list as `configRequirements/read` reported it
 * ({@link codexManagedApprovalsReviewers}). Measured 2026-09-24 on the shipped
 * `codex-app-server` 0.154.0, the requirement delivered through codex's own
 * macOS MDM reader and the config written by `buildCodexConfigToml`:
 *
 * - `["auto_review"]`: the explore turn asking for `'user'` is REFUSED, `-32600`
 *   ("invalid thread settings override: invalid value for `approvals_reviewer`:
 *   `User` is not in the allowed set [AutoReview] (set by MDM …)"); default
 *   turns start. With the toggle OFF the thread starts under `auto_review`
 *   silently, so a turn that asks for nothing runs Explore under the reviewer.
 * - `["user"]` with the toggle ON: codex warns at start ("falling back to
 *   required value User") and then refused EVERY default turn, because F1.373
 *   asked for `'auto_review'` on it.
 * - With no field in `config.toml` codex takes the list's FIRST value
 *   (`config/src/config_requirements.rs`, `Constrained::new(initial_value, …)`
 *   with `reviewers.first()`; its own test says "it picks the first allowed
 *   value"), so `["auto_review", "user"]` with the toggle off is the reviewer.
 *
 * So, under a list: a turn asks for the reviewer it WANTS — `'user'` in Plan, `configured` in Auto and Bypass
 * while `settingOn` (F1.1169), `'user'` in every other mode — whenever the list allows it; a mode whose wanted
 * reviewer the list forbids asks for nothing (the administrator's reviewer stands, and the host notice — with the
 * toggle on or off since F1.1198 — or codex's own warning says so at start); and a read-only mode STILL asks for
 * `'user'`, so codex refuses the turn rather than handing Plan to a reviewer — F1.373's decision, kept, with the refusal
 * worded by {@link codexTurnStartRefusalMessage}.
 */
export function codexTurnApprovalsReviewer(
  mode: import('./mode-types.ts').PermissionMode,
  configured: 'auto_review' | undefined,
  allowed?: readonly string[],
  settingOn = true,
): { approvalsReviewer?: 'user' | 'auto_review' } {
  const readOnly = mode === 'plan'; // F1.1050: explore retired (read as plan)
  const reviewer = configured === 'auto_review' && settingOn && codexModeHandsApprovalsToReviewer(mode) ? 'auto_review' : undefined; // F1.781; F1.1056/F1.1169 — the rest want 'user' (nothing under a list that forbids it)
  if (allowed === undefined) {
    if (configured !== 'auto_review') return {};
    return { approvalsReviewer: readOnly || !reviewer ? 'user' : 'auto_review' };
  }
  const wanted = readOnly ? 'user' : (reviewer ?? 'user');
  if (readOnly || allowed.includes(wanted)) return { approvalsReviewer: wanted };
  return {};
}

/**
 * F1.482 (1) — `configRequirements/read`'s `allowedApprovalsReviewers`, as this
 * host spells reviewers, or `undefined` when nothing is managed. The field is one
 * of the four ts-rs drops from the bindings
 * (`CODEX_EXPERIMENTAL_REQUIREMENT_GATES`), so it is read off the raw result.
 * Codex rejects an empty list at load (`empty_allowed_approvals_reviewers_is_rejected`),
 * so an empty or malformed value reads as no list; the legacy
 * `guardian_subagent` spelling is `auto_review` (`deserialize_legacy_allowed_approvals_reviewer`).
 * An unknown value is dropped rather than guessed at.
 */
export function codexManagedApprovalsReviewers(result: unknown): readonly ('user' | 'auto_review')[] | undefined {
  const requirements = (result as { requirements?: unknown } | null | undefined)?.requirements;
  const list = (requirements as { allowedApprovalsReviewers?: unknown } | null | undefined)?.allowedApprovalsReviewers;
  if (!Array.isArray(list) || list.length === 0) return undefined;
  const out: ('user' | 'auto_review')[] = [];
  for (const entry of list) {
    const value = entry === 'guardian_subagent' ? 'auto_review' : entry;
    if ((value === 'user' || value === 'auto_review') && !out.includes(value)) out.push(value);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * F1.482 (1) — the error a refused `turn/start` puts on the transcript. Every
 * refusal is passed through as codex worded it, except the one this host asks
 * for on purpose: a read-only mode asking for `'user'` under an administrator
 * list that forbids it (see {@link codexTurnApprovalsReviewer}). That one says
 * which mode, why, and what still runs — with codex's own sentence beside it,
 * because it names where the requirement came from (MDM, a file, the cloud).
 */
export function codexTurnStartRefusalMessage(
  err: unknown,
  mode: import('./mode-types.ts').PermissionMode,
  allowed: readonly string[] | undefined,
): string {
  const message = err instanceof Error ? err.message : String(err);
  if (mode !== 'plan' || !message.includes('invalid value for `approvals_reviewer`')) return message;
  const modeName = 'Plan'; // F1.1050: explore retired, so plan is the one read-only mode
  const policy = allowed ? ` (allowed_approvals_reviewers: ${allowed.join(', ')})` : '';
  return `Codex refused this ${modeName} turn: your organisation's Codex policy${policy} lets only Codex's `
    + `auto-review reviewer answer approvals, and ${modeName} is a read-only mode this app never hands to a `
    + `reviewer. Switch to another mode to work under the reviewer. Codex said: ${message}`;
}

// F1.373 — the writer's one auto-review gate, read by `noteConfiguredApprovalsReviewer`;
// imported at the end for the line-citation reason above.
import { codexConfigEmitsAutoReview } from '@nessy-agent/codex-responses-adapter/config-writer';
// F1.482 (1) — the requirements channel `recordManagedApprovalsReviewers` wraps; same reason.
import type { CodexRequestChannel } from './codex-config-requirements.ts';

/**
 * F1.514 — does an administrator's `allowed_approvals_reviewers` put codex's
 * reviewer in front of this host whatever the Settings toggle says? Only a list
 * that leaves out `user`: with `user` allowed, every turn asks for `'user'`
 * explicitly ({@link codexTurnApprovalsReviewer}), and with no list codex
 * follows the written config.
 */
export function codexManagedListRequiresReviewer(allowed: readonly string[] | undefined): boolean {
  return allowed !== undefined && allowed.length > 0 && !allowed.includes('user');
}

// F1.514 — the remembered administrator reviewer list (the F1.101 cache shape), read by
// `unattendedAutomationFloorHookProjection` and written by `recordManagedApprovalsReviewers`.
import {
  getCodexManagedApprovalsReviewers,
  recordAndPersistCodexManagedApprovalsReviewers,
} from '../config/codex-managed-requirement-cache.ts';

/**
 * F1.379 (origin the WJ-hh verifier on F1.272; DECIDED 2026-09-23) — the SECOND
 * name one codex rule request answers to: Pi's.
 *
 * Codex projects a session tool as `mcp__session__<tool>` under
 * `semanticId: 'mcp_dynamic'` (claude's spelling — the SDK mints the same
 * name). Pi judges the same call under its binding's `permissionName` (the
 * handler name) and `descriptorId` (`pi-harness/harness-tool-descriptor.ts`
 * `sessionBinding`), so before this `deny spawn_session` DECLINED on Pi and
 * CARDED on codex, and a Pi-spelled allow never answered codex's card. The
 * probe that measured it: `deny mcp__*` declined on codex and matched nothing
 * on Pi; `allow mcp__session` accepted on codex and matched nothing on Pi.
 *
 * An ALIAS, not a second request, and that is a decision stated here: the
 * consult allows a multi-request approval only when EVERY request is allowed
 * (right for an apply-patch naming four files), so a second request would have
 * made F1.272's `allow mcp__session__<tool>` stop answering and made no single
 * allow rule able to approve a session tool at all. The two names are ONE
 * subject: {@link evaluateCodexRuleRequest} reads both, a deny or an ask under
 * either wins (deny > ask > allow, the DSL's own order), and an allow under
 * either answers — except a path or host allow, which answers a session tool
 * under neither name (F1.377, F1.463). Never a widening: each name is one Pi or
 * claude honours for this call, and Pi reads claude's spelling too (F1.478).
 */
export interface CodexRuleRequestAlias {
  toolName: string;
  semanticId: string;
}

/** F1.379 — Pi's `(permissionName, descriptorId)` for a session tool, or `undefined`. */
function codexSessionToolPiAlias(toolName: string): CodexRuleRequestAlias | undefined {
  if (!toolName.startsWith('mcp__session__')) return undefined;
  const binding = getPiToolBindingByBindingName(toolName);
  return binding ? { toolName: binding.permissionName, semanticId: binding.descriptorId } : undefined;
}

/**
 * F1.379 — one codex rule request evaluated under BOTH of its names (see
 * {@link CodexRuleRequestAlias}), answering what the consult reads per request.
 * Without an alias it is exactly `evaluatePermissionDslV1`.
 *
 * F1.489 (2) — through the SAME merge Pi's gate runs for the mirror alias
 * (`pi-harness/session-tool-rule-alias.ts`,
 * `evaluatePermissionDslUnderSessionToolAlias`, F1.478), so the two runtimes
 * cannot drift apart on deny > ask > allow. This copy used to carry one extra
 * step — a failed document answered first — and dropping it changes no answer:
 * a failed document (`stale-generation`, `invalid-policy`) depends on no tool
 * name, so both names fail alike and the shared merge returns the primary's
 * deny, which is what the step returned (the consult refuses it since F1.1002,
 * under either name alike).
 */
function evaluateCodexRuleRequest(
  policy: Parameters<typeof evaluatePermissionDslV1>[0],
  request: CodexApprovalRuleRequest,
  dsl: Parameters<typeof evaluatePermissionDslV1>[1],
): ReturnType<typeof evaluatePermissionDslV1> {
  return evaluatePermissionDslUnderSessionToolAlias(policy, request.alias, dsl);
}

// F1.489 (2) — Pi's alias merge, read by `evaluateCodexRuleRequest`; imported at the end for the line-citation reason above.
import { evaluatePermissionDslUnderSessionToolAlias } from './pi-harness/session-tool-rule-alias.ts';

// F1.379 — Pi's binding for a session tool; imported at the end for the line-citation reason above.
import { getPiToolBindingByBindingName } from './pi-harness/harness-tool-descriptor.ts';

/**
 * F1.371 (origin WJ-hh P-WJ-hh-5) — what codex's DONTASK `PermissionDenied` names.
 *
 * For an MCP tool-call approval the payload used two fields Pi's does not: the
 * card's display name, which is the tool's `tool_title` whenever it declares one
 * (`mapElicitationApprovalToRequest`'s `toolTitle ??`), so a matcher on
 * `mcp__<wire>__.*` missed; and the raw elicitation FRAME as `tool_input`. Both
 * now come from {@link codexMcpToolCallRuleRequests}' request — the subject the
 * rule consult judged a moment earlier: the host's `mcp__<wire>__<tool>` (or
 * `mcp__session__<tool>`) and the call's own `_meta.tool_params`. Every other
 * approval keeps the card mapper's name and the frame, as before.
 */
function codexDontAskDeniedSubject(
  kind: ApprovalKind,
  params: unknown,
  cwd: string,
  cardToolName: () => string,
): [string, Record<string, unknown>] {
  const p = isPlainRecord(params) ? params : {};
  const [call] = kind === 'elicitation' ? codexMcpToolCallRuleRequests(p, cwd) : [];
  if (call) return [call.toolName, call.input];
  return [cardToolName(), (params && typeof params === 'object' ? params : {}) as Record<string, unknown>];
}

// F1.386 — the unattended-automation floor hook's builder, trust pass and notices,
// read by `unattendedAutomationFloorHookProjection` / `trustProjectedHostHooks`;
// imported at the end for the line-citation reason above.
import {
  CODEX_AUTOMATION_FLOOR_HOOK_FAILED_NOTICE,
  CODEX_AUTOMATION_FLOOR_HOOK_MANAGED_ONLY_NOTICE,
  CODEX_AUTOMATION_FLOOR_HOOK_NOTICE,
  CODEX_AUTOMATION_FLOOR_HOOK_STATE_FILE, mintCodexFloorHookStateBuildDir,
  CODEX_AUTOMATION_FLOOR_HOOK_UNTRUSTED_NOTICE,
  codexAutomationFloorHookCommand,
  codexAutomationFloorHookPlan,
  codexAutomationFloorHookRunFailed,
  codexAutomationFloorHookState, codexFloorHookReviewerAnswers, codexModeHandsApprovalsToReviewer,
  codexRequirementsAllowManagedHooksOnly,
  trustCodexHostAuthoredHooks,
} from './backend/codex/automation-floor-hook.ts';
// F1.482 (3) — the observation `recordHookRun` receives; imported at the end for the same reason.
import type { HookRunObservation } from './hook-run-report.ts';

// F1.378 — the MCP deny/ask rule projection and its facts sentence, read by
// `codexMcpRuleProjection`; imported at the end for the line-citation reason above.
import {
  describeCodexMcpRuleCatalogueGap,
  describeCodexUnprojectedMcpRules,
  projectCodexMcpPermissionRules, withToolRulesWebSearchDeny, // F1.1175 on this line: every cited line keeps its place
  type CodexMcpRuleProjectionInput,
  type CodexMcpToolCatalogue,
  type CodexMcpToolLevers,
} from './codex-permission-rule-support.ts';
// F1.482 (2) — the session-tool registry and the pool-server's own wait cap, read
// by `codexMcpRuleCatalogue`; imported at the end for the same reason.
import { SESSION_TOOL_NAMES } from '@nessy-agent/session-tools-core';
import { MCP_POOL_SERVER_STARTUP_WAIT_MS } from '../mcp/server-config-values.ts';
import type { CodexConfigOptions } from '@nessy-agent/codex-responses-adapter/config-writer';

/**
 * F1.372 — Pi's remember window for an MCP card (`core/pre-tool-use.ts`
 * `DEFAULT_REMEMBER_FOR_MINUTES`, module-private there), restated once and pinned
 * equal to Pi's card by `codex-mcp-card-always-allow.test.ts`.
 */
const CODEX_MCP_CARD_REMEMBER_MINUTES = 10;

// F1.372 — imported at the end for the line-citation reason above.
import { createHash } from 'node:crypto';
// F1.202 — the ChatGPT (Codex) card's sign-in; imported at the end for the same line-citation reason.
import {
  CODEX_ACCOUNT_LOGIN_START_METHOD,
  CODEX_CHATGPT_AUTH_TOKENS_REFRESH_METHOD,
  CODEX_CHATGPT_LOGIN_TIMEOUT_MS,
  CODEX_CHATGPT_SUBSCRIPTION_SIGNED_IN_FACT,
  answerCodexChatGptAuthTokensRefresh,
  buildCodexChatGptLoginParams,
  resolveCodexChatGptTokens,
  scrubCodexChatGptAuthText,
  type CodexChatGptTokens,
  type ResolveCodexChatGptTokensDeps,
} from './backend/codex/chatgpt-subscription-auth.ts';
// F1.570 — the operator's web-search allowlist, handed to the writer for the card whose search is codex's own;
// imported at the end for the same line-citation reason.
import { resolveWebSearchAllowedDomains } from '../config/web-search-allowlist.ts';
// F1.566 — the card's model list from codex's own model/list; imported at the end for the same reason.
import {
  describeCodexChatGptModelRefresh,
  refreshCodexChatGptSubscriptionModels,
  type CodexChatGptModelStore,
  type CodexModelListRequester,
} from './backend/codex/chatgpt-subscription-models.ts';
import { updateLlmConnection } from '../config/storage.ts';
// F1.598 — codex's own searches against the host cap; imported at the end for the same line-citation reason.
import {
  createCodexNativeWebSearchTally,
  isCodexWebSearchItemStart,
  type CodexNativeWebSearchTally,
} from './backend/codex/native-web-search-cap.ts';
import { codexConfigFollowsCodexWebSearch } from '@nessy-agent/codex-responses-adapter/config-writer';

/** F1.609 — the directory under the host's config directory that holds the floor hook's per-build state. */
const CODEX_FLOOR_HOOK_STATE_ROOT = 'codex-floor-hook-state';

/** F1.609 — the session-facts key of the sentence said when the hook is told no mode. */
const CODEX_FLOOR_HOOK_STATE_FACT = 'codex-floor-hook-state';

/**
 * F1.652 — the directory under the host's config directory that holds the
 * per-session `CODEX_HOME`s, and the prefix each is minted with (the same one
 * the `$TMPDIR` fallback uses, so a reader scanning both finds either).
 */
const CODEX_HOME_ROOT = 'codex-home';
const CODEX_HOME_PREFIX = 'nessy-codex-home-';

/** F1.652 — the session-facts key of the sentence said when the home falls back to `$TMPDIR`. */
const CODEX_HOME_LOCATION_FACT = 'codex-home-location';

/**
 * F1.609 — `candidate`, created (0700) and resolved to its real path, when it
 * lies outside every one of `agentWritableRoots` (compared by real path too, so
 * a symlink into a root does not pass); otherwise the reason it is withheld.
 * Outside every root is also what makes a rename of any directory above the
 * file impossible for an agent command: a rename needs a write to that
 * directory's parent, and every such parent is outside the roots as well.
 * Measured on the shipped `codex-app-server` (`rust-v0.156.1`, 2026-09-25,
 * `work/wjcrita/f1609-probe.ts`): in such a directory an overwrite, a new file,
 * an unlink and a rename of the parent each fail "Operation not permitted",
 * while the same write into `CODEX_HOME` under `$TMPDIR` lands.
 *
 * F1.704 — `shielded` is {@link resolveCodexHostOnlyDirectory}'s (F1.680):
 * `newFloorHookStateFile` passes {@link codexConfigDirProjectionShields}, as
 * `newCodexHome` does, since both roots lie in the config dir. The hook still
 * reads the file under the outright deny: codex spawns a hook command with no
 * sandbox (codex-rs `hooks/src/engine/command_runner.rs` at `rust-v0.156.1`,
 * `build_command`: a plain `Command::new` of the shell). Measured on that
 * binary (`work/dn018/f1704-probe.ts`, every approval accepted), home as the
 * project, the project IS the config dir, home added, and the config dir under
 * `$TMPDIR`: the agent's overwrite, new file, unlink, and rename of the build
 * dir, the state root or the config dir itself each leave the file intact.
 */
export function resolveCodexFloorHookStateDirectory(
  candidate: string,
  agentWritableRoots: readonly string[],
  shielded?: (root: string, dir: string) => boolean,
): { dir: string } | { withheld: string } {
  return resolveCodexHostOnlyDirectory(candidate, agentWritableRoots, 'its state directory', shielded);
}

/**
 * F1.652 — {@link resolveCodexFloorHookStateDirectory}'s body, for any host-only
 * directory: `label` names the directory in the withheld reason. The per-session
 * `CODEX_HOME` is the second caller (`CodexAgent.newCodexHome`).
 *
 * F1.680 — `shielded(root, dir)`, when given, excuses a root that contains the
 * real directory because something else keeps agent commands from writing it
 * through that root ({@link codexConfigDirProjectionShields}). F1.704 — F1.609's
 * caller passes the same predicate: its state root is in the config dir too.
 */
export function resolveCodexHostOnlyDirectory(
  candidate: string,
  agentWritableRoots: readonly string[],
  label: string,
  shielded?: (root: string, dir: string) => boolean,
): { dir: string } | { withheld: string } {
  let dir: string;
  try {
    mkdirSync(candidate, { recursive: true, mode: 0o700 });
    dir = realpathSync(candidate);
  } catch (error) {
    return { withheld: `${label} ${candidate} could not be created (${error instanceof Error ? error.message : String(error)})` };
  }
  for (const root of agentWritableRoots) {
    let base: string;
    try {
      base = realpathSync(root);
    } catch {
      base = resolvePath(root);
    }
    if (dir === base || dir.startsWith(base.endsWith(pathSeparator) ? base : `${base}${pathSeparator}`)) {
      if (shielded?.(root, dir)) continue;
      return { withheld: `${label} ${dir} lies inside ${root}, which this session's codex sandbox lets an agent command write with no card` };
    }
  }
  return { dir };
}

/**
 * F1.680 — whether F1.664's config-dir projection (`projection`, the value
 * {@link codexConfigDirProjection} returned for this session and the one its
 * config carries) keeps agent commands from writing `dir` (a real path) through
 * `root`, a writable root that contains it. It reads the projection and
 * re-derives none of it; the two carriers, as that function emits them:
 *
 * - the cwd's `":workspace_roots"` `read` entries — codex resolves them against
 *   the cwd only (F1.659), so they shield `dir` from the cwd root alone: `"."`
 *   makes the whole cwd read-only, and every other entry is the config dir's own
 *   cwd-relative path, so it shields `dir` when `dir` lies in the config dir;
 * - an absolute `read` path (F1.678; a `deny` before it) containing `dir` and lying strictly below `root` —
 *   a writable root inside (or equal to) that path is the more specific
 *   entry and wins (measured E1 on F1.664's probe), so it is never shielded.
 *
 * Measured on the shipped `rust-v0.156.1` (`work/wjcritn/f1680-probe.ts`) for
 * both carriers: a `CODEX_HOME` so shielded refuses the agent's tamper of
 * `rules/nessy.rules`, and the durable deny holds after the host's `thread/fork`.
 */
export function codexConfigDirProjectionShields(
  dir: string,
  root: string,
  workingDirectory: string,
  configDir: string,
  projection: { readonly subpaths: readonly string[]; readonly deny: readonly string[] },
): boolean {
  const real = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return resolvePath(path);
    }
  };
  const within = (parent: string, child: string): boolean => {
    const rel = relativePath(parent, child);
    return !isAbsolute(rel) && rel.split(pathSeparator)[0] !== '..';
  };
  const base = real(root);
  if (projection.subpaths.length > 0 && workingDirectory && base === real(workingDirectory)
    && (projection.subpaths.includes('.') || within(real(configDir), dir))) {
    return true;
  }
  return projection.deny.some(denied => {
    const path = real(denied);
    return path !== base && within(path, dir) && within(base, path);
  });
}

// F1.609 — imported at the end for the line-citation reason above.
import { realpathSync } from 'node:fs';
import { sep as pathSeparator } from 'node:path';

/** F1.693 — the global control records of the data folder (F1.701's set, plus the credential store). */
const CODEX_DATA_FOLDER_CONTROL_RECORDS = new Set(['hooks.json', 'mcp.json', 'config.json', 'credentials.enc', 'host-approvals-key.sealed']) // UA12.23: + the desktop's sealed ledger key
/** F1.693 — the data-folder directories that are control places whole: the codex homes (F1.652) and the permission files. */
const CODEX_DATA_FOLDER_CONTROL_DIRECTORIES = new Set(['codex-home', 'permissions'])

/** F1.693 — both spellings of a path (as written, and by real path) for a containment decision. */
function codexPathSpellings(path: string): string[] {
  const absolute = resolvePath(path)
  return [...new Set([absolute, canonicalizeForDecision(absolute)])]
}

/** F1.693 — `path`'s segments strictly below `root`, or null when it is not strictly below it. */
function codexSegmentsBelow(root: string, path: string): string[] | null {
  const rel = relativePath(root, path)
  if (rel === '' || isAbsolute(rel) || rel.split(pathSeparator)[0] === '..') return null
  return rel.split(pathSeparator)
}

/**
 * F1.693 (WJ-crit-p, 2026-09-25) — which CONTROL PLACE of Nessy's data folder `path` is,
 * or null. The data folder is the real `CONFIG_DIR`, compared as written and by real
 * path, names compared case-insensitively (the default macOS volume is):
 *
 * - `codex-home/` (the per-session codex homes, F1.652 — their `rules/` are the durable
 *   denies) and `permissions/`, whole;
 * - the global `hooks.json`, `mcp.json`, `config.json` (F1.701's records), `credentials.enc`
 *   and the sealed ledger key `host-approvals-key.sealed` (UA12.23);
 * - the five records of ANY workspace under `workspaces/<id>/` — `automations.json`, `automations-history.jsonl`,
 *   `permissions.json`, `host-approvals.json` (UA1.10) (`GUARDED_WORKSPACE_RECORDS`) and
 *   `hooks.json` (F1.123's record) — and of the session's own workspace root wherever
 *   it lies.
 *
 * DECIDED (transparent and simple): everything else in the data folder — skills, plans,
 * session data — stays ordinary agent work, as F1.701 decides for Pi and claude.
 */
export function codexDataFolderControlTarget(path: string, workspaceRootPath?: string): string | null {
  const records = new Set([...GUARDED_WORKSPACE_RECORDS.keys(), WORKSPACE_HOOK_RECORD].map(name => name.toLowerCase()))
  for (const spelled of codexPathSpellings(path)) {
    for (const config of codexPathSpellings(CONFIG_DIR)) {
      const lower = codexSegmentsBelow(config, spelled)?.map(part => part.toLowerCase())
      if (!lower) continue
      if (CODEX_DATA_FOLDER_CONTROL_DIRECTORIES.has(lower[0]!)) return `under ${lower[0]}/`
      if (lower.length === 1 && CODEX_DATA_FOLDER_CONTROL_RECORDS.has(lower[0]!)) return `the control record ${lower[0]}`
      if (lower.length === 3 && lower[0] === 'workspaces' && records.has(lower[2]!)) return `the workspace record ${lower[2]}`
    }
    for (const root of workspaceRootPath ? codexPathSpellings(workspaceRootPath) : []) {
      const lower = codexSegmentsBelow(root, spelled)?.map(part => part.toLowerCase())
      if (lower?.length === 1 && records.has(lower[0]!)) return `the workspace record ${lower[0]}`
    }
  }
  return null
}

/**
 * F1.693 — the first write path of a `permissions` request that is, or CONTAINS, a
 * control place of the data folder: the data folder itself or any folder above it, the
 * `workspaces` folder or one workspace, the session's own workspace root, or a path
 * {@link codexDataFolderControlTarget} names. A `special` root write counts as a folder
 * above it. NOT judged, and said so: a `glob_pattern` entry (a pattern is not a path).
 * Not reachable from the model on the product's config today — the shipped build offers
 * no `request_permissions` tool (measured, the F1.693 probe) — and kept because a grant
 * is what the bypass yes would echo verbatim.
 */
function codexWriteGrantOverDataFolderControl(params: unknown, workspaceRootPath?: string): { path: string; entry: string } | null {
  const p = isPlainRecord(params) ? params : {}
  const profile = isPlainRecord(p.permissions) ? p.permissions : {}
  const fileSystem = isPlainRecord(profile.fileSystem) ? profile.fileSystem : {}
  const writes = (Array.isArray(fileSystem.write) ? fileSystem.write : []).filter((w): w is string => typeof w === 'string')
  for (const entry of Array.isArray(fileSystem.entries) ? fileSystem.entries : []) {
    if (!isPlainRecord(entry) || entry.access !== 'write' || !isPlainRecord(entry.path)) continue
    if (entry.path.type === 'path' && typeof entry.path.path === 'string') writes.push(entry.path.path)
    if (entry.path.type === 'special' && isPlainRecord(entry.path.value) && entry.path.value.kind === 'root') writes.push(parsePath(CONFIG_DIR).root)
  }
  const cwd = typeof p.cwd === 'string' ? p.cwd : undefined
  for (const raw of writes) {
    const path = cwd ? resolvePath(cwd, raw) : resolvePath(raw)
    const named = codexDataFolderControlTarget(path, workspaceRootPath)
    if (named) return { path, entry: named }
    for (const spelled of codexPathSpellings(path)) {
      for (const config of codexPathSpellings(CONFIG_DIR)) {
        if (spelled === config || codexSegmentsBelow(spelled, config)) return { path, entry: 'a folder holding its control places' }
        const below = codexSegmentsBelow(config, spelled)
        if (below && below[0]!.toLowerCase() === 'workspaces' && below.length <= 2) return { path, entry: 'a folder holding workspace records' }
      }
      for (const root of workspaceRootPath ? codexPathSpellings(workspaceRootPath) : []) {
        if (spelled === root || codexSegmentsBelow(spelled, root)) return { path, entry: 'a folder holding workspace records' }
      }
    }
  }
  return null
}

/**
 * F1.693 — the refusal sentence for an added directory strictly INSIDE the data folder,
 * or null. Such a directory used to be granted to codex as a writable root (only the
 * data folder ITSELF was refused), and a write grant there hands agent commands the
 * other workspaces' records and the codex homes with no approval at all — the round-2
 * MEDIUM on F1.664/F1.659. The data folder itself keeps its own refusal (the denied-read
 * conflict); a folder ABOVE it is F1.664's projection's to deny.
 */
export function codexAddedRootInsideConfigDir(root: string, absolute: string): string | null {
  const inside = codexPathSpellings(absolute)
    .some(spelled => codexPathSpellings(CONFIG_DIR).some(config => codexSegmentsBelow(config, spelled) !== null))
  return inside
    ? `[additionalDirectories] "${root}" is inside Nessy's data folder (${CONFIG_DIR}) and is not granted to codex: `
      + 'a write grant there would let agent commands rewrite other workspaces\' records and the codex homes with no approval (F1.693)'
    : null
}

/**
 * F1.750 — the trust entry codex is given for a session cwd. `untrusted` is keyed on the CWD
 * itself; `trusted` on its git repo root (the host's own `.git` walk,
 * {@link outputStyleProjectRootFor}), else the cwd. Both keys are the realpath.
 *
 * Why the two keys differ (read in `github.com/openai/codex` at `rust-v0.156.1`):
 *
 * - `get_active_project` (`config/src/config_toml.rs`) looks up the cwd FIRST, then codex's own
 *   repo root; the auto-trust fires only when both miss. `decision_for_dir`
 *   (`config/src/loader/mod.rs`) answers each `.codex` folder from the cwd up to the project root
 *   by its own entry, then the project root's, then the repo root's — and anything but `Trusted`
 *   keeps that layer out. So ONE `untrusted` entry on the cwd stops the auto-trust and keeps every
 *   layer out, whereas an entry on a repo root would miss a linked worktree (codex resolves its
 *   repo root to the MAIN checkout, so the auto-trust would fire and the project AGENTS.md load).
 * - A `trusted` entry on the repo root is codex's OWN auto-trust key, so a trusted project that is
 *   a subdirectory keeps its repo root's `.codex` exactly as it loaded before this row.
 * - The realpath, because codex's lookup keys lead with the canonical spelling
 *   (`dunce::canonicalize`) while a map key is matched as written; a path that cannot be resolved
 *   is keyed as spelled.
 */
export function codexProjectTrustOptionsFor(
  cwd: string | undefined,
  trusted: boolean,
): { projectRoot?: string; projectTrusted: boolean } {
  const dir = cwd?.trim()
  if (!dir) return { projectTrusted: trusted }
  const key = trusted ? (outputStyleProjectRootFor(dir) ?? dir) : dir
  let projectRoot = key
  try {
    projectRoot = realpathSync(key)
  } catch {
    // Not there (yet): keyed as spelled, which is still codex's second lookup key.
  }
  return { projectRoot, projectTrusted: trusted }
}

/**
 * F1.870 (origin WJ-crit-tt P-2) — a readable ASK rule on codex, F1.830's codex twin.
 *
 * `permission-modes.md#actions-no-mode-auto-approves`: "Tools matched by an explicit ask rule" are
 * not auto-approved "in any mode, including `bypassPermissions`". Measured first at `123de1bcd`
 * (`codex-ask-rule-card.test.ts` carries the readings): `consultPermissionRules` returned `null` for
 * an ask exactly as for "no rule matched", so `bypassPermissions` answered codex's request YES with
 * no card — the request P6.1's `decision="prompt"` projection exists to make codex send — an MCP card
 * kept F1.372's remember window (the host then answered the next identical call with no card), and a
 * shell card's Always answered `acceptForSession`, which codex caches for the session
 * (`openai/codex@rust-v0.156.1` `codex-rs/core/src/tools/sandboxing.rs` `with_cached_approval`: "If
 * all keys are already approved for session, we skip prompting") beside a durable allow grant.
 *
 * The decision, transparent and the smallest honest one: the ask is CARRIED (`CodexRuleAnswer`
 * action `'ask'`), never an answer. Where a person can be asked — every attended mode but `dontAsk`,
 * `bypassPermissions` included — the call is carded with the rule's sentence leading the card and NO
 * don't-ask-again: no F1.372 hash, `noAlwaysAllow`, and `respondToPermission` honours an Always as a
 * one-shot yes (no `acceptForSession`, no persisted grant), the floor's P2.140 shape. Where nobody can
 * be — an unattended turn, even with the operator's escape hatch open, since the fallback is for what
 * NO rule covers — it is refused naming the rule, and `dontAsk`'s refusal names it too (F1.886). A deny rule
 * and every floor are unchanged, and so is a call no rule matches.
 */
function codexAskRuleCard(ask: CodexRuleAnswer, toolName: string, description: string): string { // F1.887 — led by the host name the rule matched (`Bash`, the host MCP name), as claude and Pi lead; codex's card name only as a fallback
  return `${ask.toolName ?? toolName} requires approval by readable permission policy rule \`${ask.ruleId}\` (${ask.scope} scope).\n\n${description}`
}

/** F1.870 — the refusal for an ask-rule call nobody can answer (see {@link codexAskRuleCard}). */
function codexAskRuleRefusal(ask: CodexRuleAnswer, why: string): string {
  return `Refused: this call requires approval by readable permission policy rule "${ask.ruleId}" (${ask.scope} scope), and ${why}.`
}

// F1.928 · imported at the end for the line-citation reason above.
import { buildCodexExecpolicyRules, CODEX_RULES_DIR, CODEX_RULES_FILE } from '@nessy-agent/codex-responses-adapter/config-writer';
import { getWorkspacePermissionsPath } from './permissions-config.ts';

/**
 * F1.928 — a readable deny/ask rule added while a codex thread is live reaches that thread from the
 * NEXT TURN HEAD, through the re-fork {@link CodexAgent.applySelectedPluginSkillRuntimePolicy} already
 * owns (the model-switch / option-drift path), and never mid-turn.
 *
 * Why a re-fork and not just a rewrite, measured first (WJ-crit-iii, `work/wjcritiii/f1928-probe.ts`,
 * the shipped `rust-v0.156.1`, mode `bypassPermissions`): a `forbidden` touch and a `prompt` mkdir rule
 * written into `rules/nessy.rules` under a LIVE thread both did nothing — the touch ran, the mkdir ran
 * with no approval request — and after the host's `thread/fork` the touch was refused and the mkdir
 * asked. The source agrees (`openai/codex@rust-v0.156.1` `codex-rs/core/src/session/mod.rs`
 * `spawn_internal`): `ExecPolicyManager::load` runs once per session spawn, a `thread/fork` spawns one
 * with no inherited policy, and codex has no request that reloads rules into a running thread.
 *
 * The mechanism, the smallest honest one: at every turn head the workspace store is re-projected with
 * the SAME builder and collectors `writeCodexConfig` uses at `createRuntime`
 * ({@link codexProjectedExecpolicyRules}); when the text moved from what the live thread opened with,
 * the file is rewritten (or removed when nothing projects, as the writer leaves none) and the thread is
 * re-forked under the same bounded budget. Fail closed: a file that cannot be written, or a fork that
 * errors or does not answer, fails the turn, and the recorded text stays the OLD one so the next turn
 * head tries again. An unreadable store (a malformed or half-saved `permissions.json`) moves nothing:
 * it never loosens the thread's rules.
 *
 * RESIDUE, stated rather than hidden: (1) a rule changed DURING a turn reaches codex at the next turn
 * head — the command in flight, and any later one in the same turn that codex auto-approves, runs under
 * the rules the thread opened with; a command codex asks about still meets the host's live
 * `consultPermissionRules`. (2) Only the execpolicy file is re-projected: an MCP rule's codex-side
 * lever ({@link CodexAgent.codexMcpRuleProjection}, `config.toml`) still follows `createRuntime`, and
 * the host's own MCP gate is what enforces those mid-session. (3) A codex sub-agent spawned before the
 * re-fork keeps the policy it inherited from the old thread: in Bypass, or for any command codex auto-approves,
 * it runs a newly denied command unchecked (no request reaches `consultPermissionRules`, and the codex path
 * has no host PreToolUse gate). The host cannot re-fork a child, so when one is still running at the re-fork
 * the turn head says so ({@link codexRulesDriftChildNotice}, F1.939); an idle child a later `send_input`
 * wakes is not counted, and whether the forked parent can still reach it is unmeasured.
 */
export function codexProjectedExecpolicyRules(workspaceRootPath: string): string | null {
  try {
    const raw = loadRawWorkspacePermissions(workspaceRootPath)
    // Present but unparseable reads as `null` too, like an absent file: keep what the thread has.
    if (raw === null && existsSync(getWorkspacePermissionsPath(workspaceRootPath))) return null
    return buildCodexExecpolicyRules(
      collectExecpolicyAllowPrefixes(raw),
      collectExecpolicyDenyPrefixes(raw),
      collectExecpolicyPromptPrefixes(raw),
    )
  } catch {
    return null
  }
}

/** F1.928 — the rules text each agent's LIVE thread was opened with, keyed by the `CODEX_HOME` it was read from. */
const codexThreadRules = new WeakMap<object, { home: string; text: string }>()

/**
 * F1.928 — whether the live thread must be re-forked for `projected` to reach it (see
 * {@link codexProjectedExecpolicyRules} for the mechanism). Rewrites the file whenever it differs from
 * `projected`; THROWS when it cannot, so the turn is not started under rules the user already changed.
 * The first call of a runtime reads back what `writeCodexConfig` wrote, which is what that thread loaded.
 */
export function codexRulesDriftForTurn(
  agent: object,
  codexHome: string | null,
  projected: string | null,
  debug: (message: string) => void = () => {},
): boolean {
  if (!codexHome || projected === null) return false
  const file = join(codexHome, CODEX_RULES_DIR, CODEX_RULES_FILE)
  const read = (): string | null => {
    try {
      return existsSync(file) ? readFileSync(file, 'utf8') : ''
    } catch {
      return null
    }
  }
  let seen = codexThreadRules.get(agent)
  if (!seen || seen.home !== codexHome) {
    // `null` (unreadable) never equals a projection, so an unknown start state re-forks.
    seen = { home: codexHome, text: read() ?? '\u0000unreadable' }
    codexThreadRules.set(agent, seen)
  }
  if (read() !== projected) {
    try {
      if (projected) {
        mkdirSync(join(codexHome, CODEX_RULES_DIR), { recursive: true })
        writeFileSync(file, projected, 'utf8')
      } else {
        rmSync(file, { force: true })
      }
    } catch (error) {
      throw new Error(
        'the workspace permission rules changed and the codex rules file could not be updated '
        + `(${error instanceof Error ? error.message : String(error)}), so this turn was not started under the old rules`,
      )
    }
  }
  if (projected === seen.text) return false
  debug('codex execpolicy rules changed since this thread opened (F1.928); re-forking so they apply from this turn')
  return true
}

/**
 * F1.939 — the turn-head notice for residue (3) of {@link codexProjectedExecpolicyRules}: `running` `spawn_agent`
 * children (`CodexEventAdapter.runningSpawnedChildCount`) outlive the rules re-fork, which reaches the parent
 * thread only. Durable `info` + `warning`, through the operator-notice queue, so it is shown at this turn's head.
 */
export function codexRulesDriftChildNotice(running: number): string {
  const one = running === 1
  return `The permission rules changed, but ${running} sub-agent${one ? '' : 's'} started earlier ${one ? 'is' : 'are'} still running `
    + `under the previous permission rules until ${one ? 'it finishes' : 'they finish'}: a command codex runs there without asking `
    + 'is not checked against the new rules.'
}

/** F1.928 — record that the live thread was (re)opened on `projected`, after a successful re-fork. */
export function noteCodexThreadRules(agent: object, codexHome: string | null, projected: string | null): void {
  if (!codexHome || projected === null) return
  codexThreadRules.set(agent, { home: codexHome, text: projected })
}

/**
 * F1.845 — the per-skill disable codex is handed for an UNTRUSTED project, read off codex's own
 * `skills/list` answer (`SkillsListResponse` = `{ data: SkillsListEntry[] }`, each entry's `skills`
 * a `SkillMetadata { path, scope, … }`): every skill with `scope: 'repo'` becomes
 * `{ path, enabled: false }`, in codex's order, once per path. The shape of codex's
 * `skills.config` entry (`config/src/skills_config.rs` `SkillConfig`, `deny_unknown_fields`) is
 * exactly `path` + `enabled`, so nothing else is emitted. Anything that is not that shape names
 * nothing — see {@link CodexAgent.refreshCodexRestrictedRepoSkills} for why that is not a hole.
 */
export function codexRestrictedRepoSkillsOff(listed: unknown): Array<{ path: string; enabled: false }> {
  const data = (listed as { data?: unknown } | null | undefined)?.data
  if (!Array.isArray(data)) return []
  const paths = new Set<string>()
  for (const entry of data) {
    const skills = (entry as { skills?: unknown } | null | undefined)?.skills
    if (!Array.isArray(skills)) continue
    for (const skill of skills) {
      const listedSkill = skill as { scope?: unknown; path?: unknown } | null | undefined
      if (listedSkill?.scope === 'repo' && typeof listedSkill.path === 'string' && listedSkill.path.length > 0) paths.add(listedSkill.path)
    }
  }
  return [...paths].map(path => ({ path, enabled: false as const }))
}

/** F1.845 · the sentence a refused open carries: what failed, why the thread was not opened, what to do. */
function codexRestrictedSkillsListRefusal(reason: string): string {
  return `codex could not list this project's skills (${reason}), so no codex thread was opened: the project is not trusted `
    + 'in this app ("Keep restricted", or never trusted), and without codex\'s own list its .codex/skills and .agents/skills '
    + 'would load. Try again, or trust the project.'
}

/**
 * **F1.1003 (F1.787's remainder) — in `plan` and `explore`, this session's plans and data
 * folders are `write` keys on codex's `:read-only` profile.** Owner decision 2026-09-26, F1.787
 * option B: the `:read-only` parent "with `write` keys for plansFolderPath/dataFolderPath and the
 * same read denies".
 *
 * F1.787 (`ec42c3d83`) gave these two modes codex's own `:read-only` parent in both positions of
 * the sandbox master switch (`codexModeKeepsReadOnlyParent`, `config-writer-permissions.ts`), so
 * the two folders the host's plan gate lets the model write (`shouldAllowToolInMode` in
 * `mode-manager.ts` allows `plansFolderPath` and `dataFolderPath`) refused a shell write and put a
 * patch to the user. Native-first: a `write` key over `:read-only` is codex's own mechanism for
 * exactly that — measured on the shipped codex-app-server 0.156.1 through the product's own
 * `writeCodexConfig` (DN-121 rig, switch off and on, plan and explore): with both folders inside
 * the data folder's `sessions/`, codex resolves `workspaceWrite` whose ONLY writable roots are
 * the two folders, a `printf` and an `apply_patch` into the plans folder land with 0 approval
 * requests, and a `printf` into the project is still "operation not permitted". The other five
 * modes get the added roots unchanged: their parent is `:workspace`, and the decision names
 * these two.
 *
 * The folders are the ones the model is told (`<session_state>`, and the session MCP server's
 * `--plans-folder`): the configured `plansDirectory` when set and contained, else the session's
 * `plans/`; and the session's `data/`. Both defaults are LEAVES of this session's own directory,
 * which is why F1.693's refusal of an added directory inside the data folder (other workspaces'
 * records, the codex homes) is not applied to them. A folder is NOT granted, and the debug line
 * says why, when it is a filesystem root; an exact denied-read path (the writer would throw
 * `codex-runtime-path-policy-conflict` and fail the session); a credential-floor key (the grant
 * would remove the floor entry); a folder that CONTAINS the project, the workspace or the data
 * folder (a `plansDirectory` of "." would open the whole project, one above the data folder would
 * open that); or one at or inside a protected project folder (the `read` entries
 * {@link CodexAgent.codexProtectedWorkspaceSubpaths} emits, which the grant must not undercut).
 * Residue, stated: such a folder behaves as before this row — a shell write is refused and a patch
 * asks. Mode-dependent on purpose: `codexThreadConfigSignature` hashes the override, so a switch
 * into or out of these two modes moves the signature and re-forks the thread onto the right set.
 */
export function codexModeWritablePaths(
  mode: string,
  addedRoots: readonly string[],
  session: {
    cwd: string
    workspace: { id: string; workspaceRootPath?: string }
    sessionId: string
    denied: () => readonly string[]
    floor: () => readonly string[]
    protectedSubpaths: () => readonly string[]
  },
  debug: (message: string) => void = () => {},
): string[] {
  if (mode !== 'plan') return [...addedRoots] // F1.1050: explore retired (read as plan upstream)
  const atOrBelow = (root: string, path: string): boolean => codexPathSpellings(root)
    .some(r => codexPathSpellings(path).some(p => p === r || codexSegmentsBelow(r, p) !== null))
  const folders = [
    resolvePlansDirectory(session.cwd) ?? getSessionPlansDir(session.workspace.id, session.sessionId),
    getSessionDataPath(session.workspace.id, session.sessionId),
  ]
  const denied = new Set(session.denied())
  const floorKeys = new Set(mapDeniedPathsToCodexFilesystemKeys(session.floor(), []).keys)
  const guarded = [session.cwd, session.workspace.workspaceRootPath, CONFIG_DIR].filter((p): p is string => !!p)
  const protectedFolders = session.protectedSubpaths().map(sub => resolvePath(session.cwd, sub))
  const granted = [...addedRoots]
  for (const folder of folders) {
    const absolute = resolvePath(folder)
    if (granted.includes(absolute)) continue
    const refused = absolute === parsePath(absolute).root ? 'it is a filesystem root'
      : denied.has(absolute) ? 'it is also a denied-read path, and the two would conflict'
      : floorKeys.has(absolute) || floorKeys.has(absolute.replace(latchedHomeDir(), '~'))
        ? 'the credential floor covers it, and the grant would remove the floor entry'
      : guarded.some(root => atOrBelow(absolute, root)) ? 'it contains the project, the workspace or Nessy\'s data folder'
      : protectedFolders.some(root => atOrBelow(root, absolute)) ? 'it is inside a protected project folder'
      : null
    if (refused) {
      debug(`[F1.1003] the session folder "${absolute}" is not made writable for codex in ${mode}: ${refused}; `
        + 'there a shell write is refused and a patch asks')
      continue
    }
    granted.push(absolute)
  }
  return granted
}

/**
 * F1.719 (owner decision 2026-09-26, option B) — a v2 `fileChange` approval whose files codex has
 * not announced on `item/started` yet ({@link CodexAgent.codexFileChangeApprovalPaths} answers `[]`).
 *
 * Every refusal above the card judges a patch by its paths — the data-folder floor (F1.693), the
 * deny-path floor, read-before-write, the rule consult — so with none, all of them stay silent, and
 * until this row the `bypassPermissions` yes and the operator's unattended `allow` answered for the
 * user. The bridge now takes the posture C3.386 already took on the card ("this act cannot be
 * named", no Always Allow) for its automatic answers too: bypass raises the ordinary card, an
 * unattended turn refuses even with the escape hatch open, and `dontAsk` refuses as it already did
 * (no rule can pre-approve a request {@link codexApprovalRuleRequests} projects to `[]`).
 *
 * Today this never fires: at `rust-v0.156.1`, `core/src/tools/handlers/apply_patch.rs`
 * `execute_verified_patch` runs `emitter.begin(event_ctx).await` before `orchestrator.run(...)`,
 * where the approval is asked. The protocol does not promise that order, and the v2 frame
 * (`FileChangeRequestApprovalParams`: `threadId, turnId, itemId, startedAtMs, reason?, grantRoot?`)
 * carries no paths of its own, so a changed order becomes one extra card rather than a silent pass.
 * v1 `applyPatchApproval` names its files in the frame and is not affected. Logs once per request.
 */
function codexPatchUnnamed(kind: ApprovalKind, announcedPaths: readonly string[], debug: (message: string) => void): boolean {
  if (kind !== 'fileChange' || announcedPaths.length > 0) return false
  debug(`codex patch approval names no files yet: ${CODEX_UNNAMED_PATCH_REASON}`)
  return true
}

/** F1.719 — the reason {@link codexPatchUnnamed} logs, and the unattended refusal gives. */
const CODEX_UNNAMED_PATCH_REASON = 'codex asked to apply a patch before announcing which files it changes (F1.719), '
  + 'so no floor could check it and neither the permission mode nor the unattended fallback answers it for you'

/**
 * F1.780 (owner decision 2026-09-26, option A) — codex runs an APPROVED command inside its sandbox
 * for as long as this session's permission profile denies a read. Until F1.1057 a real session's always
 * did (the credential store, D1.342/D1.349); now only a user's or operator's deniedPaths entry does.
 *
 * codex's own, deliberate behaviour at `rust-v0.156.1`, `core/src/tools/sandboxing.rs`
 * (`sandbox_override_for_first_attempt`): "Deny-read restrictions are part of the active permission
 * policy. Running without a filesystem sandbox would discard them, even if the command was otherwise
 * approved by rules or explicit escalation." `sandbox_permissions_preserving_denied_reads` turns
 * `RequireEscalated` into `UseDefault` the same way. So an Allow on an escalation (`touch ~/x`,
 * SIT-l E21) still ends in `Operation not permitted`, and an Always Allow used to mint a durable
 * `bash` allow rule (P3.1) that only stops the asking — and would take the whole prefix out of the
 * sandbox the day the profile stops denying reads (P3.80).
 *
 * Accepted, not fought (native-first): the card says so ({@link codexSandboxRetainedCard}) and Always
 * Allow stays codex's own session grant (`acceptForSession`) with no durable rule. Option B (drop the
 * host's denied reads) is what F1.1057 chose on 2026-09-28; option C (`exec_permission_approvals`, which
 * widens while staying sandboxed) is `Stage::UnderDevelopment` — revisit when it is Stable.
 *
 * RESIDUE, stated: the frame carries no escalation flag (`CommandExecutionRequestApprovalParams` has
 * no `sandboxPermissions`), so this keys on the profile, not on the request. A command codex cards for
 * another reason — its dangerous-command heuristic (`is_dangerous_command.rs`, a forced `rm build`), which works
 * inside the sandbox — gets the same (true) sentence and loses its durable Always Allow too: it is
 * asked again next session. Rules minted before this row stay in the store; the config writer's
 * `codex-execpolicy-grant-sandbox-retained:` notice already says they skip the prompt but stay
 * sandboxed. Only an ordinary command frame qualifies: a `writeStdin` or network frame has no Always
 * Allow to keep, and a file change is not held back this way (an out-of-workspace `apply_patch` lands
 * once approved, WI-az and SIT-r).
 */
function codexCommandStaysSandboxed(kind: ApprovalKind, params: unknown, denyReadEntries: () => number): boolean {
  if ((kind !== 'command' && kind !== 'commandV1') || denyReadEntries() === 0) return false
  if (kind === 'commandV1') return true
  const frameKind = (params as { kind?: unknown } | null)?.kind
  return (typeof frameKind !== 'string' || frameKind === '' || frameKind === 'command') && readNetworkApprovalContext(params) === null
}

/** F1.780 — the card's sentence for {@link codexCommandStaysSandboxed}; the Always Allow clause only where the button is shown. */
function codexSandboxRetainedCard(description: string, sandboxRetained: boolean, alwaysAllowOffered: boolean): string {
  if (!sandboxRetained) return description
  return `${description}\n\nCodex runs this command inside its sandbox: while a deniedPaths entry applies to Codex, approving it does not lift `
    + 'the sandbox, so anything the sandbox blocks still fails.'
    + (alwaysAllowOffered ? ' Always Allow applies to this session only and saves no permanent rule.' : '')
}

/** F1.780 — the log line when {@link codexCommandStaysSandboxed} keeps an Always Allow session-only. */
const CODEX_SANDBOX_RETAINED_NOT_PERSISTED = 'codex Always Allow not persisted (F1.780): codex keeps this command inside its sandbox '
  + 'while the permission profile denies reads, so a durable rule would only stop the asking; the grant stays codex\'s session one'

// F1.780 · imported at the end for the line-citation reason above.
import { readNetworkApprovalContext } from '@nessy-agent/codex-agent-server';

/**
 * F1.926 — the reviewer half of F1.723's request layer ({@link CodexAgent.codexThreadSecurityLayer}), so
 * a project's `.codex/config.toml` cannot hand this host's approvals to codex's reviewer.
 *
 * Read at `rust-v0.156.1`: `approvals_reviewer` is a top-level key `PROJECT_LOCAL_CONFIG_DENYLIST`
 * (`config/src/loader/mod.rs`) does not strip, so a TRUSTED project layer — with the home directory as
 * the project, the user's own `~/.codex/config.toml` — naming `auto_review` outranked this host's user
 * layer, which names no reviewer while the Settings toggle is off; a turn then asks for none either
 * ({@link codexTurnApprovalsReviewer}), so codex's reviewer, not this host, answered every escalated
 * approval. `core/src/config/mod.rs` resolves `approvals_reviewer_override.or(cfg.approvals_reviewer)
 * .unwrap_or(User)` over the merged layers, where the request `config` map (`SessionFlags`) sits above
 * every project layer; and `thread/resume` / `thread/fork` restore a parent's persisted reviewer only when
 * that map does NOT name `approvals_reviewer` (`app-server/src/request_processors/thread_processor.rs`),
 * so naming it on every leg also keeps a reviewer an earlier thread was given from coming back on a refork.
 *
 * Measured on the shipped `codex-app-server` 0.156.1 (DN-171, 2026-09-26; config from the product's
 * `writeCodexConfig`, toggle off, the project trusted): with the project's `.codex/config.toml` saying
 * `approvals_reviewer = "auto_review"`, `thread/start` resolved `approvalsReviewer: "auto_review"` without
 * this key and `"user"` with it, the project's `model_reasoning_effort` applying in both; a project with no
 * `.codex` resolved `"user"`.
 *
 * The value restates the host's choice in codex's own enum (`ApprovalsReviewer`: `user`, `auto_review`):
 * `auto_review` only while the written config carries it AND the toggle is still on (F1.781's re-read),
 * else `user`, codex's own default. Under an administrator's `allowed_approvals_reviewers` that forbids
 * that value nothing is named: codex would fall back to the required reviewer with a startup warning, and
 * F1.482/F1.514 already say who answers, so the requirement stays codex's to enforce. Explore and Plan need
 * nothing more here: whenever a reviewer could be in play their turns ask for `user` themselves.
 */
export function codexThreadApprovalsReviewer(
  configured: 'auto_review' | undefined,
  allowed: readonly string[] | undefined,
  settingOn: boolean,
): { approvals_reviewer?: 'user' | 'auto_review' } {
  const wanted = configured === 'auto_review' && settingOn ? 'auto_review' : 'user'
  return allowed !== undefined && !allowed.includes(wanted) ? {} : { approvals_reviewer: wanted }
}

/**
 * F1.1018 — the slowest thread open measured on the shipped `codex-app-server` 0.156.1, and the reason
 * {@link CODEX_THREAD_REFORK_TIMEOUT_MS} moved from 30 s to 120 s (its alias {@link CODEX_INJECT_ITEMS_TIMEOUT_MS}
 * moved with it, one judgement as before).
 *
 * The 30 s bound was sized on 0.148.0, where a warm `thread/fork` answered in 239-1509 ms. On 0.156.1 a
 * fork, like `thread/start`, re-runs codex's AGENTS.md discovery, and while the permission profile carries
 * a deny-read entry — until F1.1057 this host always wrote one, the credential floor (`CodexAgent.codexDeniedReadPaths`, gone since F1.678)
 * — the metadata probes of that walk go through codex's sandboxed file-system helper
 * (`fs.get_metadata{sandboxed=true}` → `fs.sandbox_execute` in codex's own trace). The probes are fired
 * together, and a batch of them took 7-15 s each where a lone one took ~30 ms.
 *
 * Measured (DN-198, 2026-09-28; the product's `buildCodexConfigToml`, a scratch CODEX_HOME, bypass, a stub
 * upstream, the host at load average 8-10 with other lanes running; `agents_md.load` is codex's span):
 *  - cwd five directories below a git root: `thread/start` 45.7 s and 47.1 s, `thread/fork` 48.6 s and 48.2 s,
 *    with and without `[mcp_servers.sources]` (`agents_md.load` idle 45.4 s and 43.3 s) — the pool entry costs nothing;
 *  - cwd at a git root: start 21.7 s and 16.1 s, fork 16.5 s and 20.2 s (the second pair with the product's own
 *    re-fork override from `buildCodexRuntimeConfigOverride`);
 *  - a non-git cwd: start 15.5 s and 19.7 s, fork 13.4 s and 18.2 s;
 *  - CONTROL, the same rig with no deny-read path: start 2.4 s, fork 267 ms, zero sandboxed probes.
 * So a turn-head re-fork that would have answered failed the user's turn at 30 s (DN-183's "did not answer").
 *
 * Kept then: the deny-read floor (dropped on codex by F1.1057, 2026-09-28) and AGENTS.md discovery (`project_doc_max_bytes = 0`
 * would silently drop the user's AGENTS.md). 120 s is ~2.5x the slowest fork measured; `thread/start` itself
 * is unbounded (P2.138), so the re-fork is no longer failed under a cost the session's own open already paid.
 * Residue: on a busier machine or a deeper cwd a re-fork can still outlast it, and every codex thread open
 * costs seconds while the floor is on — codex's cost, stated here rather than hidden.
 */
export const CODEX_THREAD_OPEN_SLOWEST_MEASURED_MS = 48_570;

/**
 * F1.1019 (origin DN-183) — a codex MCP deny or ask rule added mid-session reaches the live thread at the
 * NEXT TURN HEAD, where the host is never asked: a tool its server marks `readOnlyHint`, and every MCP call
 * while codex's auto-review reviewer answers first. There only codex's own levers hold (F1.378:
 * `disabled_tools`, `tools.<name>.approval_mode = "prompt"`), and until this row they were written once, into
 * `config.toml` at `createRuntime`; the F1.928 re-fork carried the permission layer and the execpolicy file,
 * no MCP lever.
 *
 * Measured first (DN-238, 2026-09-28; the shipped `codex-app-server` 0.156.1, a scratch CODEX_HOME, the
 * product's `buildCodexConfigToml` and `buildCodexRuntimeConfigOverride` with the deny-read floor, the real
 * `McpPoolServer`, a stub upstream; the pool tool annotated `readOnlyHint: true`; rig `work/dn238/lever-probe.ts`):
 *  - CONTROL: no lever, a fork with the product override alone — the tool is handed to the model and runs on
 *    both turns, with zero approval requests;
 *  - `thread/fork` whose `config` adds `mcp_servers.sources.disabled_tools = [<tool>]` — the fork's model
 *    request no longer lists the tool and the call is refused (`unsupported call`), the fixture not called;
 *  - `mcp_servers.sources.tools.<tool>.approval_mode = "prompt"` on the fork — codex raised
 *    `mcpServer/elicitation/request` for the read-only tool (bypass and default);
 *  - the other direction: a thread opened with the tool disabled, forked with `disabled_tools = []`, is handed
 *    it again; one opened with `prompt`, forked with `approval_mode = "auto"`, runs it unasked;
 *  - rewriting `config.toml` and forking with no lever works too, but is not taken: the override is narrower;
 *  - A SECOND fork WITHOUT the lever override handed the disabled tool back: a fork does not inherit its
 *    parent's request `config`, so the override must ride EVERY later re-fork, not only the one that applied it.
 * codex deep-merges the request map over `config.toml` (the entry's `url` and token survived: the tool ran
 * after `disabled_tools = []`), and reads `approval_mode` as `tool.approval_mode.or(default_tools_approval_mode)
 * .unwrap_or_default()` with `AppToolApproval::Auto` the default (`core/src/mcp_tool_call.rs`
 * `custom_mcp_tool_approval_mode`, `config/src/mcp_types.rs`); this host writes no `default_tools_approval_mode`,
 * so an explicit `"auto"` is what an absent entry means.
 *
 * The mechanism: the levers `writeCodexConfig` was handed are recorded ({@link noteCodexMcpLeverBuild}); at each
 * turn head the SAME projection is re-read ({@link CodexAgent.codexMcpRuleProjection}) and, for an entry
 * `config.toml` actually has, when it differs from the recorded one the entry's FULL lever state is added to the
 * re-fork override — hashed by the thread signature, so it forks once when it moves and rides every later fork.
 * An unchanged projection adds nothing (the first turn forks nothing new). The session entry keeps the host's
 * own `web_search` withheld on the card where codex's search is on (F1.570), as the writer does.
 *
 * Fail closed, as F1.928: an unreadable workspace store (present but not parseable) keeps the last override
 * computed, never loosening; a failed or unanswered re-fork fails the turn (F1.928's path). RESIDUE: a rule
 * changed during a turn reaches codex at the next turn head; a sub-agent spawned before the re-fork keeps its
 * inherited levers; a whole-server or pattern rule is enumerated over the pool's tools as at build (F1.482 (2)).
 */
interface CodexMcpLeverBuild {
  sessionExtraDisabled: string[];
  levers: CodexConfigOptions['mcpToolLevers'];
  /** F1.1072 — the writer's F1.570 provider test: this card's search is codex's own. */
  followsCodexWebSearch: boolean;
}
const codexMcpLeverBuilds = new WeakMap<object, CodexMcpLeverBuild>()
const codexMcpLeverLastOverride = new WeakMap<object, Record<string, unknown>>()

/**
 * F1.1019 — records the MCP levers `createRuntime` hands `writeCodexConfig` for `agent`'s runtime, and passes the
 * projection through. `followsCodexWebSearch` is the writer's own F1.570 test on the same provider, so the session
 * entry's override keeps the host `web_search` withheld exactly where `config.toml` withholds it.
 */
export function noteCodexMcpLeverBuild<T extends Pick<CodexConfigOptions, 'mcpToolLevers'>>(agent: object, projection: T, followsCodexWebSearch: boolean): T {
  codexMcpLeverBuilds.set(agent, {
    sessionExtraDisabled: followsCodexWebSearch ? [CODEX_HOST_WEB_SEARCH_TOOL] : [],
    levers: projection.mcpToolLevers,
    followsCodexWebSearch,
  })
  codexMcpLeverLastOverride.delete(agent)
  return projection
}

/** F1.1019 — the `[mcp_servers.*]` entries the runtime's `config.toml` has, read off the file codex read (the writer's own header lines). */
function codexConfigMcpEntries(codexHome: string | null | undefined): { session: boolean; sources: boolean } {
  try {
    const text = codexHome ? readFileSync(join(codexHome, 'config.toml'), 'utf8') : ''
    return { session: /^\[mcp_servers\.session\]$/m.test(text), sources: /^\[mcp_servers\.sources\]$/m.test(text) }
  } catch {
    return { session: false, sources: false }
  }
}

/** The writer's own reading of one entry's levers (`codexMcpToolLeverLines`): usable names, deduplicated, a deny beating an ask. */
function codexMcpLeverState(levers: { readonly disabledTools?: readonly string[]; readonly promptTools?: readonly string[] } | undefined): { disabled: string[]; prompted: string[] } {
  const usable = (names: readonly string[] | undefined) =>
    [...new Set((names ?? []).filter(name => name.trim() !== '' && !/[\u0000-\u001f\u007f]/.test(name)))].sort()
  const disabled = usable(levers?.disabledTools)
  return { disabled, prompted: usable(levers?.promptTools).filter(name => !disabled.includes(name)) }
}

/**
 * F1.1019 — the `mcp_servers` part of the turn-head re-fork override: `{}` while the projection equals what
 * `config.toml` carries (or when this agent's runtime was never built through {@link noteCodexMcpLeverBuild}),
 * else each moved entry's full state. See the docblock above for the measurement.
 */
export function codexMcpLeverOverrideForTurn(
  agent: object,
  workspaceRootPath: string,
  codexHome: string | null | undefined,
  current: CodexConfigOptions['mcpToolLevers'],
): Record<string, unknown> {
  const built = codexMcpLeverBuilds.get(agent)
  if (!built) return {}
  const entries = codexConfigMcpEntries(codexHome)
  try {
    if (loadRawWorkspacePermissions(workspaceRootPath) === null && existsSync(getWorkspacePermissionsPath(workspaceRootPath))) {
      return codexMcpLeverLastOverride.get(agent) ?? {}
    }
  } catch {
    return codexMcpLeverLastOverride.get(agent) ?? {}
  }
  const servers: Record<string, unknown> = {}
  for (const entry of ['session', 'sources'] as const) {
    if (!entries[entry]) continue
    const was = codexMcpLeverState(built.levers?.[entry])
    const now = codexMcpLeverState(current?.[entry])
    if (JSON.stringify(was) === JSON.stringify(now)) continue
    const disabled = [...new Set([...now.disabled, ...(entry === 'session' ? built.sessionExtraDisabled : [])])]
    const tools: Record<string, { approval_mode: 'prompt' | 'auto' }> = {}
    for (const name of [...new Set([...was.prompted, ...now.prompted])].sort()) {
      if (disabled.includes(name)) continue
      tools[name] = { approval_mode: now.prompted.includes(name) ? 'prompt' : 'auto' }
    }
    servers[entry] = { disabled_tools: disabled, ...(Object.keys(tools).length > 0 ? { tools } : {}) }
  }
  const override = {
    ...(Object.keys(servers).length > 0 ? { mcp_servers: servers } : {}),
    // F1.1072 — a WebSearch deny added since the build also switches codex's OWN search off on the card
    // whose search is codex's; see codexWebSearchOffForTurn.
    ...(codexWebSearchOffForTurn(built, current) ? { web_search: 'disabled' } : {}),
  }
  codexMcpLeverLastOverride.set(agent, override)
  return override
}
// F1.1019 · imported at the end for the line-citation reason above.
import { CODEX_HOST_WEB_SEARCH_TOOL } from '@nessy-agent/codex-responses-adapter/config-writer';

/**
 * F1.681 (origin WJ-crit-i P-WJcriti-1, 2026-09-25) — a crashed or killed host runs no teardown, so its
 * per-session `CODEX_HOME` stayed under `<config>/codex-home` for good (F1.652 moved it there from `$TMPDIR`,
 * which the OS reaps; the config dir is never reaped). Native first, asked: codex has no sweep for a home the
 * host chose, and nothing in it is codex's to keep — it is a directory the host minted. So the host sweeps it,
 * through F1.654's one helper (`backend/codex/host-owned-dirs.ts`, `mintHostOwnedDir`): each home is minted as
 * `nessy-codex-home-<pid>-XXXXXX`, and every runtime build first removes the homes whose pid names no running
 * process. Kept: this process's pid (every live session of this host shares it), any other answer but `ESRCH`,
 * and a name with no pid (a pre-row dev build of 1.41.0; `<config>/codex-home` shipped in no release).
 *
 * The row's precondition — whether a relaunch resumes a thread FROM an old home, which deleting would lose —
 * was measured first (DN-268, 2026-09-28; the shipped `codex-app-server` 0.156.1, scratch homes, codex's
 * `openai` provider pointed at a loopback stub): one turn in home A leaves
 * `sessions/<yyyy>/<mm>/<dd>/rollout-…-<thread id>.jsonl` there; a new app-server on home A resumes the thread
 * by id (the CONTROL), and one on a fresh home B answers `no rollout found for thread id …`. The host always
 * boots a fresh home ({@link CodexAgent.newCodexHome}) and resumes by id alone (P6.649, no `path`), so no host
 * build ever reads another process's home: a crashed one holds nothing a session can be resumed from, and the
 * sweep loses no history the product could reach. The `$TMPDIR` fallback keeps its unswept `mkdtemp` name.
 */
export function mintCodexHome(root: string, debug?: (line: string) => void): string {
  return mintHostOwnedDir(root, CODEX_HOME_PREFIX, 'codex homes', debug)
}
// F1.681 · imported at the end for the line-citation reason above.
import { linkCodexKeptSessions, mintHostOwnedDir } from './backend/codex/host-owned-dirs.ts'; // F1.1074 — linkCodexKeptSessions

/**
 * F1.1072 (origin DN-261, 2026-09-28) — whether the turn-head re-fork must carry codex's own top-level
 * `web_search = "disabled"`: a whole-tool `WebSearch` deny projected NOW (F1.1061's `webSearchDenied`) that the
 * runtime was not built with, on the card whose search is codex's own. Until this row F1.1019's re-fork carried
 * the app's `web_search` in the session entry's `disabled_tools` but not codex's own switch, so a deny added
 * mid-session reached codex's hosted search only at the next runtime build.
 *
 * Measured first (DN-268, 2026-09-28; the shipped `codex-app-server` 0.156.1, a scratch CODEX_HOME, the product's
 * `buildCodexConfigToml` for the ChatGPT (Codex) card and `buildCodexRuntimeConfigOverride`, codex's `openai`
 * provider pointed at a loopback recorder): a thread opened with codex's default carries the hosted
 * `{"type":"web_search"}` in its model request; a `thread/fork` whose `config` adds `web_search: "disabled"`
 * carries none (7 tools to 6, under workspace-write and under full access alike); a SECOND fork without the key
 * hands it back, so it rides every later re-fork, as F1.1019's levers do. The other direction is not carried: a
 * deny present at build and removed mid-session leaves codex's own search off (`config.toml` says `disabled`,
 * and restoring it would take codex's default mode plus the `[tools.web_search]` allowlist the writer derives)
 * until the next runtime build — the fail-closed side.
 */
function codexWebSearchOffForTurn(built: CodexMcpLeverBuild, current: CodexConfigOptions['mcpToolLevers']): boolean {
  return built.followsCodexWebSearch && built.levers?.session?.webSearchDenied !== true && current?.session?.webSearchDenied === true
}

/**
 * F1.948 (origin WJ-crit-lll P-2) — the "already disabled" half of {@link CodexAgent.syncCodexSkillsConfig}'s debug
 * line. That sync reads codex's PROCESS-level `skills/list`, which reads no thread's `SessionFlags` layer, so a
 * restricted project's own skills — disabled for the thread by F1.845's request map
 * ({@link CodexAgent.codexThreadSecurityLayer}, `skills.config`) — were listed `enabled: true` and counted as enabled
 * (measured, F1.845's residue (2)). They are counted as disabled here, by `path` (the key F1.845 disables by), and
 * the line says how many of them are those and why, so the number matches what the thread runs. Debug-only.
 */
export function codexSkillsSyncDisabledCount(
  named: ReadonlyArray<{ enabled?: unknown; path?: unknown }>,
  threadDisabled: ReadonlyArray<{ path: string }>,
): string {
  const offForThread = new Set(threadDisabled.map(entry => entry.path))
  const byThread = named.filter(skill => skill.enabled !== false && typeof skill.path === 'string' && offForThread.has(skill.path)).length
  const disabled = named.filter(skill => skill.enabled === false).length + byThread
  return byThread > 0
    ? `${disabled} already disabled (${byThread} of them a project skill this restricted project's thread disables (F1.845), `
      + 'which codex\'s process-level list still reports enabled)'
    : `${disabled} already disabled`
}
// F1.1066 · imported at the end for the line-citation reason above.
import { bunProjectIsolationArgs } from './bun-project-isolation.ts';

/**
 * F1.717 (DN-263, 2026-09-28) — the first control place of the data folder, as
 * {@link codexDataFolderControlTarget} names them, that a codex SHELL command approval
 * (v2 `command`, v1 `commandV1`) names; else null. {@link CodexAgent.dataFolderControlRefusal}
 * refuses it in every mode, as it refuses a patch there.
 *
 * WHY NOW: F1.693 left commands to codex's own profile, measured holding an ACCEPTED
 * `require_escalated` write on 0.156.1. That profile denied a read (the credential floor), and
 * with a read denied codex keeps every command sandboxed ({@link codexCommandStaysSandboxed}).
 * F1.1057 removed that floor, so a default session gets codex's own behaviour — an approved
 * escalation runs OUTSIDE the sandbox — and the bypass yes alone stood between the command and
 * the records. Native-first was asked: codex has no path-scoped refusal for an escalated
 * command (its execpolicy rules match a command prefix, not a path), so the host answers.
 *
 * - **Resolution** — the records guard's own, exported from `core/pre-tool-use.ts` rather than
 *   copied: every token of every {@link shellRecordScanTexts} copy (as written, quotes blanked,
 *   quotes joined, the command's own assignments substituted) plus {@link shellRecordExtraNames}
 *   (the name a copy writes into a folder, a glued `of=`), against the frame's cwd and every
 *   `cd`/`pushd` target ({@link shellRecordBaseDirs}), `~` / `$HOME` expanded; over the frame as
 *   {@link codexApprovalFloorSubjects} renders it (v1: the argv joined, and each word) and its
 *   one unwrapped login-shell script ({@link loginShellScript}).
 * - **Read or write alike, DECIDED** — as F1.701's shell arm for Pi and claude: a command that
 *   only reads a record is refused too WHEN codex asks about it; a command codex runs without
 *   asking (a safe read inside its sandbox) never reaches this floor.
 * - **The folder half (F1.1160, DN-263's proposed row)** — after the token loop each command copy
 *   also runs the Pi/claude folder helpers ({@link shellCopyFolderWrite}, then
 *   {@link shellMovedRecordFolder}) with an EMPTY own-workspace carve-out: codex's floor carves
 *   nothing out, its record arm already guarding the own workspace's five records. Native-first,
 *   MEASURED on the shipped 0.159.3 (the lane's probe, workspace-write / on-request — the
 *   product's config): `rm -rf <workspace>/sub` and `mv <workspace>/sub2 <tmpdir>` both EXECUTED
 *   (no refusal; the one approval ask ran once accepted), a copy into a workspace folder is
 *   inside the granted writable root, and the execpolicy rules match command prefixes with no
 *   path scope — so the host floor is the only place this is judged, as DN-263 concluded for
 *   the records. Still not judged, and said so: a directory held in a variable the command does
 *   not assign; `eval` text. A thrown evaluator fails open, as the patch arm does.
 */
function codexShellCommandOverDataFolderControl(
  kind: ApprovalKind, params: unknown, workingDirectory: string, workspaceRootPath?: string,
): { path: string; entry: string } | null {
  const p = isPlainRecord(params) ? params : {}
  const cwd = resolvePath(workingDirectory, typeof p.cwd === 'string' && p.cwd ? p.cwd : '.')
  // Only a path strictly below the data folder or the own workspace root (as written, or by real
  // path) can be a control place: that cheap test runs first, over real paths memoized per
  // directory, so a heredoc's thousands of tokens under one folder cost one lookup each. A token
  // longer than PATH_MAX (4096 on Linux, 1024 on macOS) names no file the shell can open, and is
  // skipped: a quoted heredoc body is one such token, and walking its thousand `/` was quadratic.
  const roots = [CONFIG_DIR, ...(workspaceRootPath ? [workspaceRootPath] : [])].flatMap(codexPathSpellings)
  const realPaths = new Map<string, string>()
  const real = (path: string): string => {
    let known = realPaths.get(path)
    if (known === undefined) {
      const parent = dirname(path)
      known = parent === path || existsSync(path) ? canonicalizeForDecision(path) : join(real(parent), basename(path))
      realPaths.set(path, known)
    }
    return known
  }
  const judged = new Set<string>()
  for (const subject of codexApprovalFloorSubjects(kind, params)) {
    const frame = typeof subject.input.command === 'string' ? subject.input.command : ''
    for (const command of new Set([frame, loginShellScript(frame) ?? frame].filter(Boolean))) {
      const baseDirs = shellRecordBaseDirs(command, cwd)
      for (const text of [...shellRecordScanTexts(command), shellRecordExtraNames(command)]) {
        for (const match of text.matchAll(/'([^']+)'|"([^"]+)"|([^\s'";|&()<>]+)/g)) {
          const token = (match[1] ?? match[2] ?? match[3] ?? '').trim()
          for (const base of token && token.length <= 4096 ? baseDirs : []) {
            const path = expandPath(token, base)
            if (judged.has(path)) continue
            judged.add(path)
            if (![path, real(path)].some(spelled => roots.some(root => codexSegmentsBelow(root, spelled) !== null))) continue
            const entry = codexDataFolderControlTarget(path, workspaceRootPath)
            if (entry) return { path: `${path}, which this shell command names (F1.717: read or write alike),`, entry }
          }
        }
      }
      // F1.1160 — the records the tokens name are not the whole floor: a `rm -rf` of the data
      // folder or of a workspace folder names NO record and passed. Pi and claude refuse the
      // folder cases since F1.722 / F1.922 (`shellCopyFolderWrite`, then
      // `shellMovedRecordFolder`, the caller's order); both take the session's OWN workspace
      // carve-out, which codex's floor does not use — its record arm already guards the own
      // workspace's five records wherever they lie (`codexDataFolderControlTarget`) — so the
      // carve-out runs EMPTY here and an ordinary folder inside the data folder or inside the
      // own workspace stays ordinary work (the controls in codex-data-folder-approval-floor.test.ts).
      const copied = shellCopyFolderWrite(command, baseDirs, [CONFIG_DIR, canonicalizeForDecision(CONFIG_DIR)], [], real)
      if (copied !== null) return { path: `${copied}, which this shell command writes into under names it does not spell (F1.1160),`, entry: codexGuardedFolderEntry(copied, workspaceRootPath) }
      const removed = shellMovedRecordFolder(command, baseDirs, [CONFIG_DIR, canonicalizeForDecision(CONFIG_DIR)], [], real)
      if (removed !== null) return { path: `${removed}, which this shell command moves or removes (F1.1160),`, entry: codexGuardedFolderEntry(removed, workspaceRootPath) }
    }
  }
  return null
}

/**
 * F1.1160 — the floor sentence's `entry` half for a GUARDED FOLDER (the records' wording, one
 * line below {@link codexDataFolderControlTarget}, reads "… is <entry> in Nessy's data folder"):
 * the data folder itself, the folder that holds every workspace's records, or a workspace's
 * folder — this session's own (carved out for Pi and claude, NOT for codex) or another's.
 */
function codexGuardedFolderEntry(folder: string, workspaceRootPath?: string): string {
  if (folder === CONFIG_DIR) return 'the data folder itself'
  if (folder === 'workspaces') return "the folder that holds every workspace's records"
  const own = workspaceRootPath ? relativePath(CONFIG_DIR, workspaceRootPath).replace(/\\/g, '/').toLowerCase() : null
  return folder === own ? "this session's own workspace folder" : "another workspace's folder"
}
// F1.717 · imported at the end for the line-citation reason above.
import { shellCopyFolderWrite, shellMovedRecordFolder, shellRecordBaseDirs, shellRecordExtraNames, shellRecordScanTexts } from './core/pre-tool-use.ts';
import { expandPath } from '../utils/paths.ts';
import { basename, dirname } from 'node:path';

/**
 * F1.1236 (final sitting SIT2-d, 2026-10-01) — the card's Always Allow footnote follows the write.
 * Since F1.1057 an Always Allow on an ordinary command card is DURABLE: `respondToPermission` hands
 * it to `persistExecpolicyGrant`, which saves codex's proposed prefix in the workspace
 * `permissions.json` and every later session in the workspace runs the command without a card. The
 * card still read "remembers this for the session" (its request carries no `type`, so the renderer's
 * fallback answered). This names the durable case with the SAME three tests the write applies — the
 * button is offered (no floor, no ask rule, no `noAlwaysAllow`), the command is not held in codex's
 * sandbox (F1.780), and codex proposed a prefix (`execpolicyAmendmentForApproval`) — so every other
 * card keeps the session sentence, which is what codex's own `acceptForSession` then gives. Residue:
 * `persistExecpolicyGrant` re-checks the floors against the prefix tokens, so a prefix a floor refuses
 * while the whole command passed would still read "workspace"; no such prefix is known.
 */
function codexAlwaysAllowScope(kind: ApprovalKind, params: unknown, alwaysAllowOffered: boolean, sandboxRetained: boolean): { alwaysAllowScope?: 'workspace' } {
  return alwaysAllowOffered && !sandboxRetained && execpolicyAmendmentForApproval(kind, params) !== null ? { alwaysAllowScope: 'workspace' } : {}
}

/**
 * UA3.5 — offer-scoped guidance sections for {@link codexDeveloperInstructions} (plan: `codexDeveloperInstructions(outputStylePrompt?,
 * sections?)`). Codex never calls `getSystemPrompt`, so a host tool's guidance reaches it only here, and only when the
 * spawn offers the tool ({@link CodexAgent.developerSections}). `board` is UA3.5's `create_board_task` guidance (UA4.10
 * widened it with the board guide, `DOC_REFS.board`); later rows add their own keys (UA6.5 `pages`). A section sits with the operating guidance: after the
 * safety block, before the output style. Absent = byte-identical to the one-argument call.
 */
export interface CodexDeveloperSections {
  board?: string;
  /** UA6.5 — the "## Pages" section (`pagesPromptSection`), offered with the six page tools. */
  pages?: string;
  /** F1.791 — `untrustedProjectPromptSection()`, when codex was told the project is untrusted (not offer-scoped). */
  projectTrust?: string;
}

// F1.1124 — imported at the end for the line-citation reason above.
import { codexModeKeepsReadOnlyParent } from '@nessy-agent/codex-responses-adapter/config-writer';
// F1.788 — imported at the end for the line-citation reason above.
import { codexTurnCollaborationMode } from './backend/codex/collaboration-mode.ts';
