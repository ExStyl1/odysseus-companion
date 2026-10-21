import { randomUUID } from 'node:crypto';
import { query, createSdkMcpServer, tool, AbortError, type Query, type SDKMessage, type SDKUserMessage, type SDKAssistantMessageError, type SDKCompactBoundaryMessage, type Options, type CanUseTool, type HookPermissionDecision, type PreToolUseHookSpecificOutput, type ElicitationRequest, type ElicitationResult } from '@anthropic-ai/claude-agent-sdk';
import type { ElicitRequest } from '@modelcontextprotocol/sdk/types.js';
import { claudeSessionDiagnosticPath, getDefaultOptions, resetClaudeConfigCheck, workspaceClaudeConfigDir } from './options.ts';
import { appendSessionRuntimeHostNote, claudeSessionDebugLogCandidates } from './session-debug-log.ts';
import { getConfiguredAdditionalDirectories } from './additional-directories.ts';
import { buildClaudeRuntimeAgentOptions, materializeClaudeRuntimeAgentSkills, type ClaudeRuntimeAgentAliasModelMap, type ClaudeRuntimeAgentModelPolicy, type ClaudeRuntimeAgentNotice, type ClaudeSdkModelAlias } from './claude-runtime-agents.ts';
import { buildClaudeRuntimeBuiltinAgentEnv } from './claude-runtime-builtin-agent-env.ts';
// P6.791 — capability KEY -> MCP WIRE NAME, the one translation between our
// agent descriptors and the SDK's `AgentMcpServerSpec` reference form.
import { mcpWireNamesByCapabilityKey } from '../capabilities/views.ts';
// P3.345 — the claude projection of the session-tool registry, read for the
// roster grant's "only a name the parent pool carries" narrowing.
import { getSessionToolNames } from '@nessy-agent/session-tools-core';
import { claudeAttributionFloor, claudeCommandPluginSourceFloor, claudeManagedPolicyUnenforcedKeys, claudeManagedPolicyUnhonouredAllowNotices, claudePowerShellToolDenyFloor, formatClaudeManagedSettingsDiagnostics, mapManagedPolicyToClaudeSettings } from './claude-managed-settings.ts';
import { buildClaudeAutoModePolicySettings, buildClaudeFlagSettingsOptions, buildClaudeSwitchModelsOnFlagSettings, claudeSwitchModelsInertNotice, refusedClaudeManagedAutoModeKeys } from './claude-auto-mode-policy.ts';
import { buildClaudeAutoCompactionKnobEnv, claudeAutoCompactionKnobDiagnostics } from './claude-auto-compaction-knobs.ts';
import { buildClaudeUltracodeSettings } from './ultracode-mode.ts';
import { i18n, setupI18n } from '../i18n/index.ts';
import {
  buildClaudeAutoModeDenialReceipt,
  buildClaudeStreamDenialReceipt,
  formatClaudePermissionDenialReceipt,
  type ClaudePermissionDenialReceiptV1,
} from './claude-permission-denial-receipt.ts';
import { buildClaudeDeniedPathSettingsOptions, formatClaudeDeniedPathDiagnostics, mapDeniedPathsToClaudeRules } from './claude-denied-path-rules.ts';
import { permissionsConfigCache } from './permissions-config.ts';
import { resolveManagedPiPolicyFloor } from './pi-harness/managed-policy.ts';
import { buildClaudeEndpointFlagSettings, claudeSettingsFileEndpointNotices, claudeSpawnSettingsFiles } from './claude-endpoint-settings.ts';
// Local type for SDK user message content blocks (text, image, document); replaces the @anthropic-ai/sdk/resources import
type ContentBlockParam =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: string; data: string } };
import { z } from 'zod';
import { getSystemPrompt } from '../prompts/system.ts';
import { outputStyleProjectRootFor, resolveOutputStyleComposition } from '../prompts/output-styles.ts';
import { resolveChildOutputStyleId } from './child-session-scope.ts';
import { BaseAgent, type MiniAgentConfig, MINI_AGENT_TOOLS, MINI_AGENT_MCP_KEYS } from './base-agent.ts';
import { ElicitationAskUserBridge } from './elicitation-ask-user.ts';
import type { AskUserAnswer, AskUserPermissionRequest, AskUserQuestionItem } from '@nessy-agent/core/types';
import type { AgentProvider, BackendConfig, PendingSteer, PermissionResponseOptions, PostInitResult, RedirectMetadata, RuntimeAdvertisedRostersV1, RuntimeHandoffPayload } from './backend/types.ts';
// Plan types are used by UI components; not needed in nessy-general-agent.ts since Safe Mode is user-controlled
import { parseError, type AgentError, type RecoveryAction } from './errors.ts';
import { mapClaudeSdkAssistantError, type ClaudeSdkApiError } from './claude-sdk-error-mapper.ts';
import { runErrorDiagnostics } from './diagnostics.ts';
import {
  getAskUserQuestionTimeoutMs,
  getDefaultLlmConnection,
  getLlmConnection,
  getMacosSeatbeltBashSandboxEnabled,
  getOutputStyleId,
  getRtkEnabled,
  getRtkExcludeCommands,
  loadConfigDefaults,
  resolvePlansDirectory,
  type AuthType,
  type LlmConnection,
} from '../config/storage.ts';
import { resolveFallbackModelChain } from '../config/fallback-model-chain.ts';
import { resolveMaxAgentTurns } from '../config/max-agent-turns.ts';
import type { ResolvedAutoCompactionSettings } from '../config/auto-compaction-settings.ts';
import type { ResolvedWorkspace as Workspace } from '../workspaces/types.ts';
import { getValidClaudeOAuthToken } from '../auth/state.ts';
import { nestorGatewayModelWindow } from '../auth/nestor.ts';
import { NessyGatewayQuotaRead } from './backend/internal/nestor-quota.ts';
import { customHeadersOffGatewayNotice, gatewaySessionFetch } from '../telemetry/gateway-headers.ts';
// P3.363 — the disclosure sink the adapter's `onOutboundTools` feeds.
import { noteModelTargetToolEgress } from './backend/internal/drivers/upstream-target.ts';
import { CLAUDE_SDK_TELEMETRY_COVERAGE, withTelemetryCoverage } from './telemetry-coverage.ts';
import { CLAUDE_LAUNCHER_ENV_KEYS } from '../config/claude-provider-routing-env.ts';
import { claudeRestrictedModeNotice } from '../config/managed-env.ts';
import type { AgentEventExecutionResult, SessionEndReason } from '../automations/types.ts';
import { fenceHookBand } from '../automations/hook-context-fence.ts';
import {
  MCP_DEFAULT_TOOL_TIMEOUT_MS,
  MCP_TOOL_TIMEOUT_COMPAT_ENV,
  MCP_TOOL_TIMEOUT_ENV,
  mcpDefaultToolTimeoutMsFromEnv,
  readMcpTimeoutEnv,
} from '../mcp/server-config-values.ts';
import { resolveWorktreeSettings } from '../config/worktree-settings.ts';
import { createPooledResourceSdkServer, POOLED_RESOURCE_SERVER_NAME } from '../mcp/pool-server.ts';
import { getFileCheckpointingEnabled, getSessionAgentName, getSessionToolUniverse, getUserWorktreeSettings } from '../config/storage.ts';
import {
  clearClaudeCloudProviderRoutingEnvVars,
  getMiniModel,
  resolveAuthEnvVars,
  resolveGatewayFastModelId,
  resolveModelGenerationDefaults,
} from '../config/llm-connections.ts';
import { startAdapter, type AdapterHandle, type UpstreamCallObservation } from '@nessy-agent/codex-responses-adapter';
import { readWithIdleTimeout } from '../llm/stream-idle.ts';
import { classifyHostOverheadSource, hostOverheadTurn } from '../telemetry/host-overhead-usage.ts';
import { buildClaudeRuntimeWireRouter, resolveClaudeRuntimeUpstream, stripClaudeModelSelectorSuffix } from './backend/internal/drivers/anthropic.ts';
import { isNessyGatewayBaseUrl } from './backend/internal/drivers/upstream-target.ts';
import type { UpstreamTarget } from '@nessy-agent/codex-responses-adapter/nestor-client';
import type { McpClientPool, McpReconnectResult } from '../mcp/mcp-pool.ts';
import { claudeProxyToolInput } from './backend/claude/mcp-root-combinator.ts';
import type { McpServerConnectionState, McpServerStatusLine } from '../mcp/server-status.ts';
import { DEFAULT_MODEL, isClaudeModel, isAdaptiveThinkingAlwaysOnModel, getDefaultSummarizationModel, getModelContextWindow, type ModelDefinition } from '../config/models.ts';
import { getCredentialManager } from '../credentials/index.ts';
import type { CredentialManager } from '../credentials/manager.ts';
import { formatPreferencesForPrompt, getCoAuthorPreference, resolveGitAttribution } from '../config/preferences.ts';
import type { FileAttachment } from '../utils/files.ts';
import type { LLMQueryRequest, LLMQueryResult } from './llm-tool.ts';
import { consumeLlmQueryMessages } from './claude-llm-query.ts';
import { debug, isDebugEnabled } from '../utils/debug.ts';
import { resolveClaudeFlagSettings, resolveClaudeSettingSources, type ClaudeFlagSettings } from '../config/claude-flag-settings.ts';
import { guardLargeResult } from '../utils/large-response.ts';
import { mcpOutputTokenLimit } from '../config/mcp-output-settings.ts';
import {
  getSessionPlansDir,
  clearPlanFileState,
  registerSessionScopedToolCallbacks,
  mergeSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
  getSessionScopedTools,
  cleanupSessionScopedTools,
  type AuthRequest,
} from './session-scoped-tools.ts';
import {
  hookTaskRegistryInput,
  type AgentAutomationSystem,
  type BackgroundTaskEntryV1,
  type HookTaskRegistryPort,
  type SdkAutomationCallback,
  type SdkAutomationCallbackMatcher,
  type SdkAutomationInput,
  type SessionCronEntryV1,
} from '../automations/index.ts';
import {
  getPermissionMode,
  getPermissionModeDiagnostics,
  setPermissionMode,
  cyclePermissionMode,
  initializeModeState,
  unregisterModeCallbacks, // F1.397 (cleanupModeState — F1.257: the mode entry is the HOST's; `SessionManager.deleteSession` clears it)
  blockWithReason,
  denyToolWithReason,
  shouldAllowToolInMode,
  type PermissionMode,
} from './mode-manager.ts';
// UB1.16 — a guarded result keeps its password-entry lines so the host can still redact the stored input.
import { keepPasswordEntryLines } from './browser-tool-redaction.ts';
import { isCanonicalBrowserToolName } from './browser-tool-names.ts';
import { largePdfNote, shouldInlinePdfForRoute } from './pdf-inline.ts';
import { rewriteClaudeSearchOutput } from './claude-search-result-filter.ts';
import { buildClaudePermissionModeOptions, type ClaudeSdkPermissionMode } from './claude-permission-mode.ts';
import { resolveClaudeSessionPersistence } from './claude-session-persistence.ts';
import { withClaudeWorktreeHooks } from './backend/claude/worktree-hooks.ts';
import { claudeContextAfterCompaction, claudeContextUsageSnapshot } from './backend/claude/sdk-context-usage.ts';
import { resolveSubagentPromptAppend } from '../config/subagent-prompt-append.ts';
import type { ContextUsageSnapshot } from '@nessy-agent/core';
import { getSessionDataPath, getSessionDirPath } from '../sessions/storage.ts';
import type { SessionKey } from '../sessions/session-key.ts';
import { getLastApiError, type LastApiError } from '../interceptor-common.ts';
import { extractWorkspaceSlug } from '../utils/workspace.ts';
// Centralized PreToolUse pipeline
import {
  runPreToolUseChecks,
  sessionWhitelistKeyForApproval,
  type PreToolUseCheckResult,
  type PreToolUseInput,
} from './core/pre-tool-use.ts';
import {
  bareFileViewerOperand, readCreditingToolResultSucceeded,
  READ_BEFORE_WRITE_TOOLS,
  SessionFileReadLedger,
  writeTargetPath,
} from './core/read-before-write.ts';
import { getRtkPath } from './core/rtk-detector.ts';
import { planOutputStyleSwitch, type OutputStyleSwitchPlan } from './core/output-style-switch.ts';
import type { RtkContext } from './core/rtk-rewrite.ts';
import { type ThinkingLevel, THINKING_LEVEL_IDS, THINKING_TO_EFFORT, getThinkingTokens } from './thinking-levels.ts';
import {
  clampClaudeEffortLevel,
  lookupClaudeModelCapabilities,
  recordClaudeModelCapabilities,
  type ClaudeModelCapabilityRow,
} from './claude-model-capabilities.ts';
import { buildBranchFallbackContext, generateConversationSummary } from './conversation-summary.ts';
import { parseSessionCommand } from '../slash-commands/session-command.ts';
import type { LoadedSource } from '../sources/types.ts';
import type {
  ChatOptions,
  PermissionCallback,
  PermissionRequestType,
} from './backend/types.ts';
import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import {
  isExistingDirectory,
  extractSdkReportedBinaryPath,
  isSpawnEnoent as detectSpawnEnoent,
} from './spawn-helpers.ts';
import {
  claudeTranscriptIsLoadable, claudeTranscriptPath,
  resolveClaudeTranscriptCwd,
} from './claude-transcript-rebuild.ts';
import { claudeReadableAskCardSkipsHostWhitelist, claudeReadablePermissionAskCheckResult, claudeReadablePermissionDeny } from './claude-readable-permission-deny.ts'; // F1.813, F1.830, F1.921
import { IMAGE_LIMITS } from '../utils/files.ts';
import {
  appendPluginBinPath,
  enabledPluginBundleRoots,
  pluginRuntimeEnvForProfile,
} from '../plugins/data-paths.ts';
import { supportsSessionDirectiveSink } from '../plugins/hooks-automation.ts';

/** Image extensions that may need size-guard in PreToolUse (matches Read tool's image detection) */
const IMAGE_READ_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff']);

/**
 * The shipped SDK's own truthiness test for `CLAUDE_CODE_ENABLE_TELEMETRY`,
 * reproduced rather than guessed. Read out of the native binary
 * (`@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`, manifest 2.1.223):
 *
 *     function tr(e){if(!e)return!1;if(typeof e==="boolean")return e;
 *       let t=String(e).toLowerCase().trim();
 *       return["1","true","yes","on"].includes(t)}
 *
 * RE-READ AT 2.1.233 and unchanged (P6.960, 2026-09-09), and RE-READ AGAIN at
 * 2.1.247 and still unchanged (C3.252, 2026-09-12). The body above is
 * byte-identical in the shipped binary; only the minified symbol keeps moving,
 * `tr` → `Ln` → `p`, and the local `t` → `n`, so
 * `function tr(e){if(!e)return!1` occurs zero times while the quoted body
 * occurs once (1 line / 1 occurrence — both instruments, because they disagree
 * on a minified artefact, C3.294). It is still the reader of this variable:
 * three call sites spell `<parser>(process.env.CLAUDE_CODE_ENABLE_TELEMETRY)`,
 * now through two module-local aliases rather than one, which is why the ROLE
 * and not the letter is written here. The version was
 * read by the two self-reports AGENTS.md prescribes, which agree —
 * `claude --version` → `2.1.247 (Claude Code)`, and the SDK manifest's
 * `claudeCodeVersion` → `2.1.247` (they agreed at `2.1.233` on 2026-09-09).
 * The 2.1.223 above is kept because it is
 * PROVENANCE: it says when the bytes were first read, and a renamed symbol is
 * exactly the drift that makes a re-read cheap to describe and impossible to
 * infer.
 *
 * Matching it exactly matters in one direction: a value the SDK accepts and we
 * reject would mean an exporting child carrying no coverage marker — telemetry
 * arriving at a SIEM with nothing to say what it covers, which is the precise
 * failure this marker exists to prevent.
 */
function isClaudeTelemetryEnabled(raw: string | undefined): boolean {
  if (!raw) return false;
  const value = raw.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

/**
 * Internal gates own the only SDK PreToolUse callback. Trusted PreToolUse
 * automations are executed inside that callback so their final rewritten input
 * is revalidated before the SDK can execute it. Other events retain their
 * native SDK hook semantics.
 *
 * ## P3.197 — what the drop COSTS, so this site stands on its own
 *
 * The row's complaint was not that the drop is wrong; it is that the drop and
 * the thing dropped live two files apart, so neither reads as dead and a reader
 * of either one draws a conclusion the other contradicts (it made P3.176's own
 * auto-approve framing overstated). The measurement, at HEAD:
 *
 * - `trustedHooks` is `PluginScopedAutomationSystem.buildSdkHooks()`, which
 *   builds a `PreToolUse` bucket from its settings tiers plus the component
 *   (skill/subagent frontmatter) layer. Every session. All of it discarded here.
 * - **Nothing is lost by that**, because `runClaudePreToolUseHookPipeline` calls
 *   `automationSystem.executeAgentEvent('PreToolUse', …)`, and
 *   `executeAgentEventInner` dispatches every tier `buildSdkHooks` builds a
 *   bucket from — read that method's own list rather than a copy of it here —
 *   through the executor that can revalidate a rewrite.
 * - `workspaceHookConfig` USED to be the one tier `executeAgentEvent` did not
 *   consult, and this bullet predicted that a constructor which set it would
 *   silently lose that event on this backend. D1.429 made
 *   `buildPinnedAgentAutomationSystem` exactly that caller — a workspace
 *   `automations.json` now lands there — and moved the dispatch in the same
 *   commit for exactly this reason. The prediction was right; it is spent.
 *
 * So the translator arm on the other side (`automationResultToSdkHookResult`'s
 * `PreToolUse` branch) has no live reader BY THIS FUNCTION, which is why it must
 * keep answering every question the live gate answers the same way — two answers
 * to one question, one of them reachable, is how a later wiring change turns a
 * dead branch into a stranded turn. `claude-agent-plugin-runtime.test.ts` pins
 * the drop with `PostToolUse` as the positive control.
 */
/**
 * The events this backend emits HOST-SIDE, and therefore must not also hand to
 * the SDK child as callback matchers.
 *
 * `PreToolUse` has been here since P3.197: `runClaudePreToolUseHookPipeline`
 * calls `executeAgentEvent('PreToolUse', …)` through the same tiers, so the
 * trusted copy would be a second run of the same matchers.
 *
 * D1.155 adds `SessionStart` and `SessionEnd` for the same reason and on the
 * opposite evidence: those two were measured NOT to reach our callbacks in the
 * child (W19-r's headless rig, all three runtimes, only claude silent, and
 * `SessionEnd` absent on both signals), so the host now emits them. Dropping
 * them here is what keeps that a MIGRATION rather than a duplication — if a
 * later SDK starts delivering them, the host stays the single emitter and
 * nobody has to notice the day it changed.
 *
 * D1.165 adds `PreModelSwitch` and `PostModelSwitch`, and there the reason is
 * the THIRD of the three this set now covers — not "the host already runs them
 * through the same tiers" (PreToolUse) and not "the child does not deliver
 * them" (the session pair), but a SWITCH VERDICT.
 *
 * Both have been `AgentEvent`s and host-emitted on all three runtimes since
 * `25f2781e8`: `SessionManager.updateSessionModel` awaits `runModelSwitchHook`
 * before the switch is applied, fail-closed on a block, with no provider gate —
 * which is exactly what makes the three runtimes answer alike. At `0.3.251` the
 * SDK grew its OWN pair (`HOOK_EVENTS` 31 -> 33) and the vendored binary
 * constructs `hook_event_name:"PreModelSwitch"` at one site whose gate is
 * `if (b3n()) return !0; return oT("PreModelSwitch", …registry, e.id)` — it runs
 * the generic hook runner, the same one that delivers to SDK-registered
 * callbacks, and its output can `{decision:"block"}` the switch. Both names
 * scored 0 in the binary at `0.3.247`.
 *
 * Handing a user's matcher to the child therefore does NOT duplicate the host's
 * emission — a switch this fork drives is applied by respawning with a new
 * `Options.model`, and the child does not "switch" into it. It does something
 * less obvious and worse: it gives that matcher a SECOND set of occurrences,
 * on claude only, that no host switch minted (a fallback, an auto-downgrade at
 * a usage limit) and that codex cannot have at all, since codex's own
 * `HookEventName` carries no model-switch event. On a decision hook with a
 * documented veto, one runtime of three answering a question the other two are
 * never asked is the silent divergence native-first exists to prevent — and
 * `CODEX_ONLY_HOOK_EVENTS` is this repo's precedent for RECORDING such an
 * asymmetry rather than inheriting it.
 *
 * So the vendor's pair is declined, structurally, here. Adopting it is a real
 * proposal and not a gap — it would need a distinct occurrence vocabulary so a
 * matcher can tell a host switch from a child one, and a host-side mint for the
 * other two runtimes — and that is an owner-facing M, recorded as a proposed
 * row rather than taken by a lane.
 *
 * A list rather than five `if`s, so the next event that moves to the host is
 * one line in one place.
 */
const CLAUDE_HOST_EMITTED_HOOK_EVENTS: ReadonlySet<string> = Object.freeze(
  new Set(['PreToolUse', 'SessionStart', 'SessionEnd', 'PreModelSwitch', 'PostModelSwitch']),
);

export function mergeClaudeSdkHooks(
  internalHooks: Partial<Record<string, SdkAutomationCallbackMatcher[]>>,
  trustedHooks: Partial<Record<string, SdkAutomationCallbackMatcher[]>>,
): Record<string, SdkAutomationCallbackMatcher[]> {
  const merged: Record<string, SdkAutomationCallbackMatcher[]> = {};
  for (const [sourceIndex, source] of [internalHooks, trustedHooks].entries()) {
    for (const [event, matchers] of Object.entries(source)) {
      if (!matchers?.length) continue;
      if (sourceIndex === 1 && CLAUDE_HOST_EMITTED_HOOK_EVENTS.has(event)) continue;
      merged[event] = [...(merged[event] ?? []), ...matchers];
    }
  }
  return merged;
}

/**
 * `hooks.md :2190` (Stop) and `:2046` (SubagentStop) — the two events whose
 * payload carries `background_tasks` and `session_crons`. One constant, because
 * `:2194` and `:2046` give them the SAME presence and scoping rule and a
 * wiring that answered them from different registries could contradict it.
 */
const CLAUDE_TASK_REGISTRY_HOOK_EVENTS = ['Stop', 'SubagentStop'] as const;

/**
 * T9 — the host's task registry reaches a claude session's Stop hooks by
 * ENRICHING the child's payload, not by emitting a second `Stop`.
 *
 * The measurement this is built on: `ClaudeAgent` calls `emitAutomationEvent`
 * ZERO times (`base-agent.ts`: "Non-Claude backends call this directly.
 * ClaudeAgent uses SDK's buildSdkHooks() instead"). Every Stop hook a claude
 * session runs — this fork's own `hooks.json`/plugin/project automations, and
 * the `.claude/settings.json` tiers `settingSources` loads — is driven by the
 * SDK child. So a host-side `Stop` emission would not ADD the missing payload;
 * it would run every one of our automations' Stop matchers a SECOND time per
 * turn, with a payload that disagreed with the first. The callbacks, however,
 * execute in THIS process: the SDK delivers a hook input to the matcher we
 * registered, so the one place the host's records are missing is also a place
 * the host can still write to, exactly once, before the user's hook sees it.
 *
 * UNION of what each side OWNS, which is not the same as a union of both
 * registries — the original of this comment claimed the two describe disjoint
 * sets, and for shells that is FALSE:
 *  - `session_crons` really is disjoint. The child's is empty today only
 *    because `CLAUDE_CODE_DISABLE_CRON=1` suppresses its scheduler, and the
 *    union stays correct if that suppression is ever lifted, where a
 *    replacement would silently start dropping the child's half.
 *  - The host's `background_tasks` are monitors and child sessions — and
 *    SHELLS, which on this runtime are MINTED FROM THE CHILD'S OWN Bash
 *    results: `extractToolResults` raises `shell_backgrounded` off the SDK
 *    child's tool output and `SessionManager` stores it into
 *    `backgroundShellCommands` unconditionally, so the host copy is a
 *    derivative of the very entry the child is already reporting. Worse, that
 *    copy lags: `reconcileEndedBackgroundShells` only deletes on a
 *    `piProcessStore` record proving an exit (an SDK-owned shell has none), and
 *    since UA12.101 the copy retires on the CLI's `task_notification` (the
 *    `task_completed` keyed on its id) — until then `projectBackgroundTasks`
 *    stamps it `status: 'running'`. Unioning both halves therefore DOUBLE-reports
 *    a live backgrounded shell and can report an ended one as still running.
 *
 * So the host's SHELL entries are dropped here and only its non-shell entries
 * are appended: on claude-runtime the child owns its shells' truth — it is the
 * only side that knows one exited — and the host owns the work the child cannot
 * see (its monitors, its child sessions). Every other consumer of the port is a
 * runtime where the host really did start the shell, so the filter lives here
 * rather than in the shared projection.
 *
 * An ABSENT port is left strictly alone — `:2194`'s "the task registry is [not]
 * reachable" is the one documented state where the keys are missing rather than
 * present-and-empty, and it is the child's answer to give, not ours to invent.
 *
 * The PORT is taken once (the SDK's `hooks` option is construction-only — there
 * is no live setter, so this map is rebuilt on every respawn anyway); its VALUES
 * never are. `buildHookTaskRegistryPort` returns two arrow functions that read
 * the host's live monitor and cron maps at call time, which is why the snapshot
 * is taken inside the callback rather than beside it — see
 * {@link claudeHostTaskRegistrySnapshotReader} for the once-per-DISPATCH rule.
 *
 * Residual, recorded rather than papered over (Dev-18): Stop hooks declared in
 * the SDK's own settings tiers run INSIDE the child and never reach a callback
 * we registered, so they keep reading the child's arrays. This seam covers the
 * hook surface Nessy owns and manages.
 */
export function withClaudeHostTaskRegistry(
  hooks: Record<string, SdkAutomationCallbackMatcher[]>,
  port: HookTaskRegistryPort | undefined,
): Record<string, SdkAutomationCallbackMatcher[]> {
  if (!port) return hooks;
  // ONE reader for the whole map, so every matcher on a given dispatch is
  // enriched from the same snapshot.
  const readSnapshot = claudeHostTaskRegistrySnapshotReader(port);
  const wrapped: Record<string, SdkAutomationCallbackMatcher[]> = { ...hooks };
  for (const event of CLAUDE_TASK_REGISTRY_HOOK_EVENTS) {
    const matchers = wrapped[event];
    if (!matchers?.length) continue;
    wrapped[event] = matchers.map(matcher => ({
      ...matcher,
      hooks: matcher.hooks.map(callback => (
        (input, toolUseId, options) => {
          const host = readSnapshot(input);
          return callback({
            ...input,
            background_tasks: [...(input.background_tasks ?? []), ...host.background_tasks],
            session_crons: [...(input.session_crons ?? []), ...host.session_crons],
          }, toolUseId, options);
        }
      ) satisfies SdkAutomationCallback),
    }));
  }
  return wrapped;
}

/** The host half of one enriched `Stop`/`SubagentStop` payload. */
interface ClaudeHostTaskRegistrySnapshot {
  readonly background_tasks: readonly BackgroundTaskEntryV1[];
  readonly session_crons: readonly SessionCronEntryV1[];
}

/**
 * The registry is read ONCE PER DISPATCH, not once per matcher.
 *
 * The SDK hands each registered callback its own `hook_callback` control
 * request, so one `Stop` with three matchers arrives here as three separate
 * calls carrying three separately-deserialized copies of the SAME payload.
 * Reading the port in each of them cost a monitor sweep plus the cron store's
 * synchronous file read per matcher, and — the part that is not just cost —
 * let two matchers on ONE event disagree, because a cron created between the
 * two reads appears to one hook and not the other.
 *
 * SNAPSHOT SEMANTICS, stated because they are the thing to check when this
 * looks wrong:
 *  - The dispatch identity is the child's payload itself, serialized. Two calls
 *    whose input is byte-identical are treated as one dispatch and share one
 *    read; anything else re-reads. Only the most recent signature is held, so
 *    the cache is one entry and nothing is retained across a turn.
 *  - A payload that cannot be serialized re-reads. "I could not tell" resolves
 *    to a fresh read, never to a reused one.
 *  - Reuse is therefore bounded by what the hooks themselves can distinguish:
 *    a real dispatch carries `last_assistant_message` and `prompt_id`, which is
 *    what makes the next `Stop` a different signature and re-reads the port. A
 *    turn that schedules a cron still sees it in the `Stop` that ends the turn.
 */
function claudeHostTaskRegistrySnapshotReader(
  port: HookTaskRegistryPort,
): (input: SdkAutomationInput) => ClaudeHostTaskRegistrySnapshot {
  let last: { signature: string; snapshot: ClaudeHostTaskRegistrySnapshot } | undefined;
  return input => {
    let signature: string | undefined;
    try {
      signature = JSON.stringify(input);
    } catch {
      signature = undefined;
    }
    if (signature !== undefined && last?.signature === signature) return last.snapshot;
    const host = hookTaskRegistryInput(port);
    const snapshot: ClaudeHostTaskRegistrySnapshot = {
      // The host's shell entries are the child's own, copied and never retired
      // — see `withClaudeHostTaskRegistry`'s note. `type` is the seam the
      // shared projection stamps, so this reads the same word the docs do.
      background_tasks: (host.background_tasks ?? []).filter(task => task.type !== 'shell'),
      session_crons: host.session_crons ?? [],
    };
    last = signature === undefined ? undefined : { signature, snapshot };
    return snapshot;
  };
}

export type ClaudePreToolUseHookPipelineResult<T> =
  | { kind: 'blocked'; reason?: string }
  | {
      kind: 'validated';
      input: Record<string, unknown>;
      /**
       * The hook decision that survives to the payload builder. `defer` is
       * carried rather than dropped — what the builder DOES with it is the
       * posture recorded on `buildClaudePreToolUseContinue`. Before P3.262 this
       * union stopped at two members, so a `defer` fell into the empty branch
       * below and the builder, seeing no decision, named `allow` — the one
       * value `hooks.md` § `#pretooluse-decision-control` says it outranks.
       */
      hookDecision?: 'allow' | 'ask' | 'defer';
      hookReason?: string;
      additionalContext?: string;
      validation: T;
    };

/**
 * Execute trusted PreToolUse automations first, overlay their replacement
 * fields, then invoke the host checker exactly once with the final input. A
 * hook deny/block is terminal; an ask decision remains a restrictive floor.
 */
export async function runClaudePreToolUseHookPipeline<T>(options: {
  automationSystem?: AgentAutomationSystem;
  hookInput: SdkAutomationInput;
  signal?: AbortSignal;
  revalidate: (input: Record<string, unknown>) => Promise<T> | T;
}): Promise<ClaudePreToolUseHookPipelineResult<T>> {
  const originalInput = options.hookInput.tool_input ?? {};
  const hookResult = options.automationSystem
    ? await options.automationSystem.executeAgentEvent('PreToolUse', options.hookInput, options.signal)
    : undefined;
  const decision = hookResult?.decision;
  if (decision?.decision === 'block' || decision?.decision === 'deny') {
    return { kind: 'blocked', ...(decision.reason ? { reason: decision.reason } : {}) };
  }
  // `hooks.md` § `#pretooluse-decision-control` withholds the three companion
  // fields from this one value, in three separate sentences: `permissionDecisionReason`
  // — "For "defer", ignored"; `updatedInput` — "For "defer", ignored";
  // `additionalContext` — "Ignored when `permissionDecision` is "defer"".
  // So a `defer` carries its decision and nothing else, and the degrade the
  // builder applies to the DECISION never resurrects the payload the page drops.
  const deferred = decision?.decision === 'defer';
  const hookDecision = decision?.decision === 'ask' || decision?.decision === 'allow' || decision?.decision === 'defer'
    ? decision.decision
    : undefined;
  const finalInput = decision?.updatedInput && !deferred
    ? { ...originalInput, ...decision.updatedInput }
    : originalInput;
  const validation = await options.revalidate(finalInput);
  return {
    kind: 'validated',
    input: finalInput,
    ...(hookDecision ? { hookDecision } : {}),
    ...(decision?.reason && !deferred ? { hookReason: decision.reason } : {}),
    ...(decision?.additionalContext && !deferred ? { additionalContext: decision.additionalContext } : {}),
    validation,
  };
}

/**
 * P2.496 · does the USER tier's `disableAllHooks` withhold our two subagent
 * debug matchers?
 *
 * Exported and taking the system as an argument — the same shape
 * {@link runClaudePreToolUseHookPipeline} uses — so the gate is assertable
 * without standing up a `ClaudeAgent`, and so the two matchers that must NEVER
 * consult it can be shown not to.
 *
 * `settings-reference.md#disableallhooks`, verbatim: *"In any other settings
 * file: Claude Code disables user, project, local, and plugin hooks; managed
 * hooks, Agent SDK hooks, and hooks from plugins force-enabled in managed
 * `enabledPlugins` keep running."* Everything this file registers is an Agent
 * SDK hook, so surviving the switch is the VENDOR'S STATED INTENT and not a
 * leak. W2-g established that; the owner then decided our own host-authored
 * additions should stand down anyway, because a user who turns hooks off
 * reasonably believes hooks are off. A narrowing, only ever a narrowing.
 *
 * `=== true` and not a truthiness test, because absent means UNKNOWN and a host
 * that cannot answer must not have its hooks silenced by a default — the
 * semantics {@link AgentAutomationSystem.userTierDisableAllHooks} states at the
 * field.
 *
 * SCOPE, and it is the whole of it: `SubagentStart` and `SubagentStop`, which
 * are two `debug()` lines. W2-g measured the honest size of the prize —
 * `withClaudeHostTaskRegistry` only DECORATES `Stop`/`SubagentStop` matchers
 * that already exist, so once `buildSdkHooks()` has returned nothing it is
 * already inert. `PreToolUse` and `PermissionDenied` stay UNREACHED by this
 * predicate, and that is a permission boundary rather than a style: routing a
 * convenience switch into the permission gate would widen permissions, and
 * silencing the `PermissionDenied` audit receipt is worse than changing nothing.
 */
export function claudeSubagentDebugHooksWithheld(
  automationSystem: Pick<AgentAutomationSystem, 'userTierDisableAllHooks'> | undefined,
): boolean {
  return automationSystem?.userTierDisableAllHooks === true;
}

/** What the internal PreToolUse callback hands back to the SDK. */
type ClaudePreToolUseResult = Awaited<ReturnType<SdkAutomationCallback>>;

/**
 * Reason attached to an `ask` that a trusted PreToolUse automation asked for
 * and that named no reason of its own. `permissionDecisionReason` on an `ask`
 * is "shown to the user but not Claude", so this text is written for a person
 * reading a permission prompt.
 */
export const TRUSTED_HOOK_ASK_REASON = 'Approval requested by a trusted PreToolUse hook';

/**
 * Build the PreToolUse payload for a call that is allowed to proceed — the one
 * place the Claude runtime hears a decision of ours that is not a denial.
 *
 * `hooks.md` § PreToolUse decision control, quoted as whole sentences because
 * the page grows and line numbers drift:
 *
 *   "Unlike other hooks that use a top-level `decision` field, PreToolUse
 *   returns its decision inside a `hookSpecificOutput` object."
 *
 *   `permissionDecision` — "`"allow"` skips the permission prompt, except for
 *   tools that require user interaction and connector tools your organization
 *   set to `ask`. `"deny"` prevents the tool call. `"ask"` prompts the user
 *   to confirm. `"defer"` exits gracefully so the tool can be resumed later.
 *   Deny and ask rules are still evaluated regardless of what the hook returns"
 *
 *   `permissionDecisionReason` — "For `"allow"` and `"ask"`, shown to the
 *   user but not Claude. For `"deny"`, shown to Claude. For `"defer"`,
 *   ignored"
 *
 *   `updatedInput` — "Modifies the tool's input parameters before execution.
 *   Replaces the entire input object, so include unchanged fields alongside
 *   modified ones."
 *
 *   "When multiple PreToolUse hooks return different decisions, precedence is
 *   `deny` > `defer` > `ask` > `allow`." And a hook "that blocks by exiting 2
 *   routes the same way as `"deny"`".
 *
 * And the note that convicts the shape this replaced: "PreToolUse previously
 * used top-level `decision` and `reason` fields, but these are deprecated for
 * this event. Use `hookSpecificOutput.permissionDecision` and
 * `hookSpecificOutput.permissionDecisionReason` instead. The deprecated values
 * `"approve"` and `"block"` map to `"allow"` and `"deny"` respectively."
 *
 * What this replaced, measured on 2026-08-16: the allow path returned
 * `{ continue: true }` carrying no `permissionDecision` at all, and the
 * trusted-hook ask path returned a top-level `decision: 'ask'` — not even one
 * of the two deprecated top-level values, so it named no decision the SDK
 * reads. Both were invisible because `permissionMode: 'bypassPermissions'`
 * meant there was no prompt to skip or to force. **That bypass is gone (R3), so
 * this field is now load-bearing rather than preparatory**: an allow carrying no
 * decision falls through to normal permission evaluation, and Safe Mode would
 * start prompting on the read-only bash commands it had just approved — the
 * regression the bypass was introduced to avoid. `claude-permission-mode.test.ts`
 * asserts that path end to end, gate decision through to payload.
 *
 * This changes how a decision is EXPRESSED and never which decision is made.
 * A trusted automation's `ask` floor still asks (unless a Nessy approval has
 * already satisfied it, which is what `hookAskAlreadyApproved` carries);
 * everything else still allows. Denial is not built here: it has its own
 * payload and already spoke this vocabulary — `denyToolWithReason` /
 * `blockWithReason` in `mode-manager.ts`.
 *
 * ## `defer` — EMITTED, since P2.525
 *
 * P3.262 found the hole: `defer` never reached this builder, because the
 * pipeline in front narrowed the union to two members, so a `defer` landed in
 * the empty branch and the builder — seeing no decision — named `allow`. The
 * page's own ordering is "When multiple PreToolUse hooks return different
 * decisions, precedence is `deny` > `defer` > `ask` > `allow`", so that was a
 * silent upgrade past the two values `defer` outranks, reachable by any user,
 * project or plugin hook. P3.262 closed it by degrading one rank to `ask`, and
 * said in the same breath why it could not simply pass the value through: the
 * host could not RECEIVE a deferral, so emitting one would have traded a
 * permission bypass for a stranded turn.
 *
 * That prerequisite is met. The value is now passed through, and the posture is
 * stated here because it is a product decision and because Pi had to make the
 * same one:
 *
 *  - **The runtime has the mechanism and we enable it rather than rebuild it.**
 *    `hooks.md` § `#defer-a-tool-call-for-later`: "`"defer"` is for integrations
 *    that run `claude -p` as a subprocess and read its JSON output, such as an
 *    Agent SDK app or a custom UI built on top of Claude Code" — which is
 *    exactly what this fork is. The tool does not execute, "the process exits
 *    with `stop_reason: "tool_deferred"` and the pending tool call preserved in
 *    the transcript", and on the next turn "The same tool call fires
 *    `PreToolUse` again". So the RESUME is the runtime's own: we resume the SDK
 *    session we already resume on every turn, and the held call comes back by
 *    itself. Nothing host-side re-drives it.
 *  - **The host can now receive it.** `backend/claude/event-adapter.ts` maps
 *    both endings onto `terminalReason` and fills `deferredToolUse`, reading
 *    `stop_reason` as well as `terminal_reason` because the binary omits the
 *    latter on the re-defer exit. `SessionManager` persists the held call
 *    through the resume port (ungated in the same commit as this change, which
 *    is the pairing P3.262 demanded), and `tool_deferred` has transcript copy,
 *    so the turn no longer ends with the tool unrun and nothing on screen.
 *  - **The two documented refusals stay the RUNTIME's**, not ours: it honours
 *    `defer` "only in non-interactive mode with the `-p` flag" and "only when
 *    Claude makes a single tool call in the turn", and in both other cases
 *    "the tool proceeds through the normal permission flow" — i.e. our own gate
 *    and the user's own rules still decide. That is the safe failure direction,
 *    which is why no host-side copy of either constraint is written here: a
 *    second enforcement beside the runtime's is the silent-divergence shape.
 *  - The three companion fields stay dropped upstream, in the pipeline, because
 *    the page drops them for `defer` in three separate sentences
 *    (`permissionDecisionReason`, `updatedInput`, `additionalContext`). A
 *    `defer` carries its decision and nothing else.
 *
 * Per-runtime, so the difference is honest rather than silent: Pi honours
 * `defer` under the same documented constraints, enforced in its own harness
 * because Pi IS the harness; claude passes the value to a runtime that enforces
 * them itself; codex's own `pre-tool-use.command.output` schema has no fourth
 * member, so there it genuinely cannot.
 */
export function buildClaudePreToolUseContinue(context: {
  hookDecision?: 'allow' | 'ask' | 'defer';
  hookReason?: string;
  additionalContext?: string;
}): (updatedInput?: Record<string, unknown>, hookAskAlreadyApproved?: boolean) => ClaudePreToolUseResult {
  return (updatedInput, hookAskAlreadyApproved = false) => {
    // P2.525 — the hook's `defer` is EMITTED, and it carries nothing else.
    //
    // Returned before the ask/allow shape below rather than folded into it,
    // because the page withholds all three companion fields from this one value
    // and a shared code path would have to remember to suppress each of them.
    // `hookAskAlreadyApproved` is not consulted either: an approval already
    // given answers "may this run", and a defer is not a question about
    // permission — it is a request to come back later, which the runtime
    // honours by re-firing `PreToolUse` for the same call on the next turn.
    if (context.hookDecision === 'defer') {
      return {
        continue: true,
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'defer' },
      };
    }
    const asksForApproval = context.hookDecision === 'ask' && !hookAskAlreadyApproved;
    const permissionDecision: HookPermissionDecision = asksForApproval ? 'ask' : 'allow';
    const hookSpecificOutput: PreToolUseHookSpecificOutput = {
      hookEventName: 'PreToolUse',
      permissionDecision,
      // Only the ask carries a reason. On an allow the field is "shown to the
      // user but not Claude", and a prompt that is being skipped has no user
      // to show it to.
      ...(asksForApproval
        ? { permissionDecisionReason: context.hookReason ?? TRUSTED_HOOK_ASK_REASON }
        : {}),
      // The callers hand over the WHOLE resolved input, never a patch —
      // `updatedInput` "replaces the entire input object".
      ...(updatedInput ? { updatedInput } : {}),
      ...(context.additionalContext ? { additionalContext: context.additionalContext } : {}),
    };
    return { continue: true, hookSpecificOutput };
  };
}

/**
 * P3.186 — **the single seam onto `Options.managedSettings`, built BEFORE a
 * second contributor arrives rather than after.**
 *
 * `Options.settings` is one option and it acquired a second contributor
 * (`80fcb81a3` credential floor, `ecddf100a` classifier policy). The near miss
 * is the whole reason this exists: a second `...{ settings }` spread into the
 * options literal would not merge — it would REPLACE, silently deleting the
 * credential floor from the spawn, with no error and no log line. That one is
 * composed and guarded now (`buildClaudeFlagSettingsOptions`).
 *
 * `managedSettings` has the identical shape and ONE contributor today, so the
 * trap is PRE-LOADED there. This is the same seam for it, so the second
 * contributor is added by editing this function's inputs — where the merge is
 * visible — instead of by spreading beside the first.
 *
 * **A key collision is refused, not resolved.** `buildClaudeFlagSettingsOptions`
 * merges two contributors that own disjoint keys (`permissions`, `autoMode`) and
 * a shallow merge is right for that; here the future contributors are unknown,
 * and a silent last-writer-wins is the same defect one level down from the one
 * this seam exists to prevent. The caller is told by name.
 *
 * Returned as a spreadable partial: with nothing to say the option is absent and
 * the spawn is byte-identical to one built without this function, which is what
 * an unmanaged install gets.
 *
 * ## The ONE key that is composed rather than refused — P6.688
 *
 * `permissions` is the exception, and it is an exception the refusal rule
 * created. Two contributors write it — the administrator's own rules, and the
 * product's PowerShell floor — and refusing the second means the floor is
 * DROPPED for exactly the fleets that have an administrator, which is the
 * opposite of what a floor is. So `deny` and `ask` are UNIONED, because both
 * lists are pure restrictions and their union is the only composition that
 * keeps both promises; the merge says so on the same channel rather than
 * silently.
 *
 * Every OTHER sub-key of `permissions` keeps the refusal — the first writer
 * holds it and the second is named — because `allow` and
 * `additionalDirectories` WIDEN, and a rule that unioned those would turn this
 * seam into the last-writer-wins it exists to prevent.
 */
/**
 * P6.352's claude read, as a pure mapper so the shape is testable without a
 * child: one `McpServerStatus` from the vendored SDK becomes one
 * {@link McpServerStatusLine}.
 *
 * - **`tools` absent is `null`, never `0`.** The SDK documents the field as
 *   *"available when connected"*, so a `failed` or `pending` server simply has
 *   no array; `0` there would print "connected but offering no tools" about a
 *   server nobody counted.
 * - **`error` rides through as `detail`, unchanged** — the child's own reason.
 * - **F1.656 — a `connected` line with no `error` takes the host pool's `detail`
 *   for the same name.** The pool skipped those tools (F1.643/F1.644) before the
 *   proxy, so the child never saw them and `McpServerStatus` has no field for them;
 *   the pool's "N tools skipped: …" (what `/mcp` prints on Pi and codex) is the only
 *   record. Only a CONNECTED pool line is read, once, and only if a line can use it.
 *
 * `status` is passed through unmapped on purpose: `McpServerConnectionState` is
 * defined as *"the five states, spelled as the claude SDK spells them"*, so a
 * translation table here would be a place for the two to drift.
 */
export function claudeSdkMcpStatusLines(
  statuses: readonly {
    name: string; status: McpServerConnectionState; error?: string | undefined; tools?: readonly unknown[] | undefined;
  }[],
  poolLines?: () => readonly McpServerStatusLine[] | null,
): readonly McpServerStatusLine[] {
  let pool: readonly McpServerStatusLine[] | undefined;
  const skipDetail = (name: string): string | undefined =>
    (pool ??= poolLines?.() ?? []).find(line => line.name === name && line.state === 'connected')?.detail;
  return statuses.map(entry => {
    const detail = entry.error || (entry.status === 'connected' ? skipDetail(entry.name) : undefined);
    return { name: entry.name, state: entry.status, toolCount: entry.tools ? entry.tools.length : null, ...(detail ? { detail } : {}) };
  });
}

export function buildClaudeManagedSettingsOptions(
  contributors: Readonly<Record<string, NonNullable<Options['managedSettings']> | undefined>>,
  onCollision?: (message: string) => void,
): Pick<Options, 'managedSettings'> {
  const merged: Record<string, unknown> = {};
  const owner = new Map<string, string>();
  for (const [name, value] of Object.entries(contributors)) {
    if (!value) continue;
    for (const [key, entry] of Object.entries(value)) {
      const held = owner.get(key);
      if (held !== undefined) {
        if (key === CLAUDE_MANAGED_UNIONED_KEY) {
          const composed = composeClaudeManagedPermissions(merged[key], entry);
          merged[key] = composed.value;
          onCollision?.(
            `[managedSettings] "permissions" is written by both ${held} and ${name}; the deny and ask`
            + ' lists are UNIONED, because both are restrictions and dropping either would silently'
            + ` un-enforce it (P6.688).${composed.refused.length > 0
              ? ` ${name}'s ${composed.refused.join(', ')} is NOT merged — ${held} keeps it.`
              : ''}`,
          );
          continue;
        }
        onCollision?.(
          `[managedSettings] "${key}" is written by both ${held} and ${name}; keeping ${held}'s value.`
          + ' Compose the two deliberately instead of letting one overwrite the other.',
        );
        continue;
      }
      owner.set(key, name);
      merged[key] = entry;
    }
  }
  if (Object.keys(merged).length === 0) return {};
  return { managedSettings: merged as NonNullable<Options['managedSettings']> };
}

/** The single `managedSettings` key {@link buildClaudeManagedSettingsOptions} composes. */
const CLAUDE_MANAGED_UNIONED_KEY = 'permissions';

/** The restricting sub-lists of `permissions`, and the only ones that union. */
const CLAUDE_MANAGED_UNIONED_PERMISSION_LISTS = ['deny', 'ask'] as const;

/**
 * Union the two restricting lists of a `permissions` block; refuse the rest.
 *
 * `held` wins every non-list sub-key it already carries, and the loser is
 * NAMED to the caller — see the seam's docblock for why `allow` must never
 * union.
 */
function composeClaudeManagedPermissions(
  held: unknown,
  incoming: unknown,
): { value: unknown; refused: string[] } {
  const out: Record<string, unknown> = { ...(held as Record<string, unknown> | undefined) };
  const refused: string[] = [];
  for (const [sub, value] of Object.entries((incoming ?? {}) as Record<string, unknown>)) {
    if ((CLAUDE_MANAGED_UNIONED_PERMISSION_LISTS as readonly string[]).includes(sub)) {
      const left = Array.isArray(out[sub]) ? (out[sub] as unknown[]) : [];
      const right = Array.isArray(value) ? value : [];
      const union = [...new Set([...left, ...right])];
      if (union.length > 0) out[sub] = union;
      continue;
    }
    if (!(sub in out)) { out[sub] = value; continue; }
    refused.push(sub);
  }
  return { value: out, refused };
}

/**
 * The SDK's clarifying-question tool, spelled once so the three sites that must
 * agree — the tool list, the PreToolUse card suppression and the `canUseTool`
 * route — cannot drift apart.
 */
export const ASK_USER_QUESTION_TOOL = 'AskUserQuestion';

/**
 * How long a turn may stay open after we asked the CLI to interrupt it, before
 * the session is ended instead.
 *
 * This is a RESTORED guarantee, not a new precaution. Before one `query()` per
 * agent, a Stop was `abortController.abort()`, and the SDK's own abort handler
 * is `() => this.close()` — stdin EOF immediately, SIGTERM about two seconds
 * later. So a Stop always ended the turn within a bound no matter what the child
 * was doing. `interrupt()` is a control request written to stdin, so a wedged
 * child never answers it and the turn would wait forever; measured in L2's
 * review with a fake CLI that acknowledges the interrupt and then emits nothing.
 *
 * Five seconds rather than the SDK's ~2: an interrupt that IS being handled has
 * to unwind a tool call and write the turn's own result, and killing a session
 * that was about to answer cleanly is the worse error. It also sits inside
 * `SessionManager.cancelProcessing`'s own 5 s watchdog closely enough that the
 * user is not left waiting through both.
 */
const INTERRUPT_DEADLINE_MS = 5_000;

/**
 * P3.267 — how many switch-visible degradation banners one turn may post.
 *
 * Eight, matching codex's `surfaceCodexOperatorNotice`, so the two runtimes
 * spend the same transcript budget on the same class of fact. The bound exists
 * because two of the three sources are PER-ENTRY (one line per imported agent),
 * and a workspace with many agents would otherwise bury the turn's answer.
 */
const CLAUDE_SWITCH_VISIBLE_DEGRADATION_LIMIT = 8;

/**
 * P3.267 + P3.310 — the fragment that identifies the ONE stderr line from the
 * child that is a switch-visible fact rather than a diagnostic.
 *
 * Measured in the vendored 0.3.233 binary, at both of its emit sites: when
 * `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is set the runtime discards the CLI mode,
 * an agent's frontmatter mode and `dangerouslySkipPermissions` alike, pins the
 * mode to `default`, and writes `⚠ Permission mode forced to default — …` to
 * stderr. W2-x classified and honoured the variable host-side (P3.310,
 * `303d65594`); this is the half that tells the person whose chosen mode was
 * overridden.
 *
 * A PROSE MATCH, which this plan has measured wrong before, so the trade is
 * stated: stderr is the only channel the vendor gives for this fact — there is
 * no structured event and no result field — and the failure direction is
 * today's behaviour exactly (no banner, the line still reaching the debug log
 * and the ring buffer). The fragment is the shortest stable part of the
 * sentence, deliberately excluding the em dash and the variable name so a
 * rewording of the explanation does not silently disarm it.
 */
const CLAUDE_FORCED_DEFAULT_MODE_STDERR = 'Permission mode forced to default';

/**
 * C3.259 — the fragment of the OTHER recognisable stderr line from the child,
 * the one that is EXPECTED on this fork's own connections rather than a fault.
 *
 * A BRACKETED TAG, not prose: the vendored binary builds the line as
 * `` `${BFo} ${le({model:e,query_source:t})}` `` with
 * `var BFo="[claude-code:unrecognized_model]"`, so the tag is a string constant
 * a rewording of the payload cannot move — unlike its sibling above, which had
 * to take the prose trade because the vendor gives no tag there.
 */
const CLAUDE_UNRECOGNIZED_MODEL_STDERR = '[claude-code:unrecognized_model]';

/**
 * C3.259 — what the child means by `[claude-code:unrecognized_model]`, said
 * where the line is printed, because nothing in this tree said it anywhere.
 *
 * ## What was measured, and where
 *
 * W15-b's live gateway run recorded the child writing
 * `[claude-code:unrecognized_model] {"model":"tgpt/…","query_source":"sdk"}` to
 * stderr on EVERY spawn. Read out of the vendored binary at
 * `claudeCodeVersion 2.1.247` (the emitter, lightly reflowed; three occurrences
 * of the tag, two of the telemetry name, `nessyNotARealSdkKey` 0 as the control):
 *
 * ```js
 * function kNe(e,t){ … if(!Ww().claim(`unrecognized-model-signal:${n}`))return;
 *   if(afe(e)||afe(n))return;
 *   D("tengu_api_unrecognized_model",{model:mr(e),querySource:Qp(t)});
 *   let r=`${BFo} ${le({model:e,query_source:t})}`.replace(IOn,"");
 *   if(xt()&&V.CLAUDE_CODE_SESSION_KIND!=="bg")SNe(`${r}\n`); else _(r,{level:"warn"}); … }
 * ```
 *
 * So it is a once-per-model signal about the runtime's OWN model table, not
 * about the request: the turn proceeds, and the same binary's changelog says as
 * much, verbatim — *"Improved print mode diagnostics: a
 * `[claude-code:unrecognized_model]` line is written to stderr when a request
 * goes out for a model ID Claude Code doesn't recognize; map it with
 * `modelOverrides` to silence"*.
 *
 * ## The row's three options, and why RECORD won over MAP and over SILENCE
 *
 * **MAP is the vendor's own remedy and is still refused, on the vendor's own
 * description of the key** (read from the same binary's settings schema):
 * *"Override mapping from Anthropic model ID (e.g. "claude-opus-4-6") to
 * provider-specific model ID (e.g. a Bedrock inference profile ARN)."* The
 * mapping is keyed by an ANTHROPIC id, and its two readers rewrite in both
 * directions — one substitutes the override's value for a known id's wire
 * spelling, the other answers "which Anthropic model is this" for a
 * provider-specific one. Silencing the line therefore means telling the runtime
 * that the gateway's model IS some Anthropic model, with that model's context
 * window, capabilities and price. A cosmetic fix that changes what the runtime
 * believes about the model is not a cosmetic fix.
 *
 * **SILENCE — dropping the line at our sink — was refused because the line is
 * true.** The id really is outside the runtime's table, and a reader who meets
 * it in a bug report needs an answer, not an absence.
 *
 * **RECORD is what is built**: the raw line still reaches every sink it reached
 * before, and one sentence goes beside it saying it is expected and why nothing
 * maps it away. The user-facing half of this subject already exists and is a
 * different fact — P6.362's host diagnostic names an id that is absent from the
 * CONNECTION's catalogue, which is actionable; this one is about the vendor's
 * built-in table, which no user of a gateway or BYO connection can act on.
 *
 * Pure and exported for the test; returns `null` when the chunk carries no such
 * line, so the caller's other sinks are untouched.
 */
export function describeClaudeUnrecognizedModelStderr(stderrChunk: string): string | null {
  if (!stderrChunk.includes(CLAUDE_UNRECOGNIZED_MODEL_STDERR)) return null;
  // stderr arrives in chunks that can carry several lines, so the line is picked
  // out of the chunk rather than the whole chunk being relabelled — the same
  // reason `surfaceForcedDefaultModeNotice` splits.
  const line = stderrChunk
    .split('\n')
    .find(entry => entry.includes(CLAUDE_UNRECOGNIZED_MODEL_STDERR))
    ?.trim();
  if (!line) return null;
  return `${line} — EXPECTED on this connection and not a failure: the model id this session sends `
    + 'is absent from the runtime\'s own built-in model table, which is true of every Nessy Gateway '
    + 'model and every BYO connection, and the turn proceeds normally. The runtime\'s own remedy is '
    + 'not applied deliberately: its override map is keyed by an Anthropic model id, so silencing '
    + 'the line would also tell the runtime this model IS that Anthropic model, with that model\'s '
    + 'context window, capabilities and price. An id that is genuinely absent from this '
    + "connection's catalogue is a different fact and the host reports it separately.";
}

/**
 * SDK tools this runtime bans for the whole session.
 *
 * - `EnterPlanMode`/`ExitPlanMode` — Safe Mode is the user-controlled surface
 *   here instead, and the plan row that would hand plan mode back to the SDK is
 *   recorded REFUTED in this plan rather than pending.
 * - (`Skill` was a third until F1.862 — Claude's own Skill tool now serves the skills Claude Code loads itself.)
 *
 * `AskUserQuestion` used to be a fourth entry, under the reason "Requires
 * interactive UI to show question options to user". That reason was stale: the
 * UI is here (option cards with descriptions and previews, the
 * `askUserQuestionTimeout` countdown, batched multi-select), our
 * `AskUserQuestionItem`/`AskUserAnswer` types match the documented envelope
 * field for field, and Pi has been asking through them all along. Banning it
 * meant the same model in the same window could ask a clarifying question on one
 * runtime and not the other. It now reaches the user through `canUseTool` — see
 * `buildClaudeCanUseTool`, which is the half that makes removing it safe.
 *
 * Session-level, so it reaches subagent contexts too. That was a known cost for
 * `Skill` until F1.862 lifted it; for `AskUserQuestion` the subagent exclusion is
 * the DESIRED outcome and is enforced in `buildClaudeCanUseTool` instead, since
 * the docs already withhold the tool there.
 */
export const CLAUDE_SESSION_DISALLOWED_TOOLS: readonly string[] = Object.freeze([
  'EnterPlanMode',
  'ExitPlanMode',
  // F1.862 — `Skill` lifted (owner rule 2026-10-08, native): trusted `.claude/skills` were loaded and unreachable.
  // T3 — the child's NATIVE `Monitor`, not ours. Ours is projected onto every
  // Claude card as `mcp__session__Monitor`, whose start is gated host-side by
  // `SessionManager.authorizeMonitor` (T2); the child's own tool reaches none of
  // that gate, so a session offering both would let the model pick the ungated
  // one. Bare `Monitor` names the built-in only: the documented rule syntax
  // matches a plain name to the built-in tool and matches an MCP tool under its
  // `mcp__<server>__<tool>` name. The three entries above are NOT precedent for
  // that — `EnterPlanMode`/`ExitPlanMode`/`Skill` are not session-tool names, so
  // none of them has ever had a namesake to spare; `Monitor` is the first
  // collision SUBTRACTED, and this entry rests on the documented syntax alone.
  //
  // "the first collision" is what this sentence said until P2.512, and it read
  // as *the only one*. Measured against the vendored declarations: FOURTEEN of
  // our 56 session tools share a name with a built-in, seven of them pi-only and
  // seven projected onto claude. What kept the other six from being six live
  // duplicates is measured tool by tool below — not symmetry, and not luck.
  //
  // T4's live Monitor smoke is the FALSIFICATION of that assumption: if bare
  // `Monitor` also killed `mcp__session__Monitor`, the projection this task
  // built would be silently dead and every static check here would still pass.
  // So T4 must observe a watch ACTUALLY STARTING, not merely see the tool
  // offered in the surface.
  //
  // The measurement this entry rests on, since the plan asked for it explicitly:
  // `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set on the GATEWAY path only
  // (the `envOverrides` block in `startLocalAdapter` below) and is NOT set on
  // the subscription path, so nothing was already making the native tool
  // unreachable there. Disallowing it covers both paths at once, which is the
  // stronger of the two placements anyway.
  'Monitor',
  // P2.512 — the child's native `ScheduleWakeup`, and it is the ONE remaining
  // live duplicate of the seven projected names. The other five are each
  // already absent for a reason of their own, read out of the vendored binary
  // rather than assumed:
  //
  //  - `CronCreate`/`CronDelete`/`CronList` — each of the three tool objects
  //    carries `isEnabled(){return tQ()}`, and `tQ()` is
  //    `!isTruthy(process.env.CLAUDE_CODE_DISABLE_CRON) && <gate>`. `options.ts`
  //    forces `CLAUDE_CODE_DISABLE_CRON=1` on every claude spawn path,
  //    authoritatively, so the three leave the surface. `scheduled-tasks.md`
  //    § `#disable-scheduled-tasks` says the same from the vendor's side: "The
  //    cron tools and `/loop` become unavailable". Adding them here would be a
  //    second suppression of a tool that is already gone.
  //  - `TodoWrite` — its `isEnabled` is the exact inverse of the four Task
  //    tools' gate, and that gate reads
  //    `if (settings.CLAUDE_CODE_ENABLE_TASKS === false) return false; return true`.
  //    (P3.309 — the predicate used to be cited by its minified name; a bump
  //    reassigns those, so it is located by that verbatim line instead.)
  //    Nothing in this fork sets that name, so the built-in checklist is off.
  //    `tools-reference.md` § `#task-tool-availability` agrees: "Wherever the
  //    tools are available, you get the four Task tools, or `TodoWrite` instead
  //    when you set `CLAUDE_CODE_ENABLE_TASKS=0`".
  //    P3.338 — that is only HALF the gate. `TodoWrite` and the four Task tools
  //    SHARE a model factor (`<todoGate>`, transcribed in
  //    `__tests__/claude-native-tool-collisions.test.ts`): at 2.1.274 it KEEPS
  //    them on an allowlist of older models, an inference-profile id or an
  //    undefined canonical id (F1.1220); on any other model, our default too,
  //    all five leave unless an opt-in fires. Ours is the env `options.ts`
  //    writes (P6.724): the four come back, `TodoWrite` stays off (tasks half).
  //  - `ReportFindings` — present, and DELIBERATELY LEFT. The built-in is a
  //    documented superset of ours: same three `outcome` states
  //    (`fixed`/`skipped`/`no_change_needed`) that our own handler exists to
  //    carry, plus `level`, `short_summary` and a severity-ordered 32-item cap.
  //    Ours lands its extra state on `structuredContent`, which its own handler
  //    records that NO host surface in this fork reads. Subtracting the better
  //    implementation to enforce symmetry is the failure this row warns about.
  //
  // `ScheduleWakeup` is the sharp one, and the shape of its failure is why it is
  // here rather than left with the crons it looks like it belongs to. Its tool
  // object declares NO `isEnabled` at all, so `CLAUDE_CODE_DISABLE_CRON` does
  // not remove it the way it removes the three cron tools — it stays on the
  // model's surface beside our `mcp__session__ScheduleWakeup`. And its `call`
  // is gated separately, on a remote flag that defaults to false: on the
  // closed arm it records `gate_off` and RETURNS SUCCESS,
  // `{ scheduledFor: 0, clampedDelaySeconds: 0, wasClamped: false }`. So a model
  // that picks the native one is told the wakeup was scheduled, our host is
  // never asked to schedule anything, and the user's next iteration simply never
  // arrives. A silent no-op wearing a success result is worse than a refusal,
  // which is what makes this a measured defect rather than a tidy-up.
  'ScheduleWakeup', 'Artifact', 'ClaudeDesign', 'Projects', 'RemoteTrigger', // F1.253: CLAUDE_AI_CLOUD_TOOLS, end of file
]);

/**
 * The SDK's hosted web-search tool, withheld per session rather than banned for
 * the runtime — see {@link resolveClaudeHostedWebSearchWithheld}.
 *
 * `tools-reference.md#websearch-tool-behavior`, verbatim: *"WebSearch permission
 * rules take no specifier. A bare `WebSearch` entry in `allow` or `deny` is the
 * only form."* So this string is the whole name; there is no
 * `WebSearch(domain:…)` narrowing to reach for.
 */
export const CLAUDE_HOSTED_WEB_SEARCH_TOOL = 'WebSearch';

/**
 * **P6.220 (+ UA1.20) — the built-ins we ban because the child's copy reaches no
 * gate (or reaches claude.ai) are ALIASED onto their host twins, so a call that
 * arrives anyway is gated instead of lost.**
 *
 * Native-first, step 1: the runtime already has the mechanism and we had no
 * caller. `Options.toolAliases` is documented in the vendored SDK
 * (`sdk.d.ts`) and on `agent-sdk/typescript.md#options`, verbatim: *"Map
 * built-in tool names to MCP tool names so Claude calls your MCP implementation
 * in place of the built-in. For example, `{ Bash: 'mcp__workspace__bash' }`"* —
 * and the bundle's own docblock names our exact case: *"if the model emits
 * `Bash` (e.g. because a skill document instructed it to), the call is routed to
 * the MCP tool instead of failing as unknown."*
 *
 * ## Why these three names and no others
 *
 * {@link CLAUDE_SESSION_DISALLOWED_TOOLS} bans `Monitor` and `ScheduleWakeup`
 * for ONE shared reason, written out at each entry: the child's own copy reaches
 * neither the host gate (`SessionManager.authorizeMonitor`) nor the host's
 * instrumentation, and `ScheduleWakeup`'s native call returns SUCCESS while
 * scheduling nothing. Banning removes them from the model's CONTEXT, which is
 * the right default — but a name a skill document utters is still emitted, and
 * until now that emission died as an unknown tool. Aliased, it lands on the
 * gated twin.
 *
 * `Artifact` (F1.253 bans it: it publishes to claude.ai) aliases onto our
 * `publish_artifact` (UA1.20) — t-artifacts, behind the same host card. The rest
 * must not follow by symmetry: `EnterPlanMode`/`ExitPlanMode`/`Skill` have no
 * `mcp__session__*` twin, and `WebSearch` is withheld because no implementation
 * of it works on this path — an alias would route it to a missing tool.
 *
 * ## The alias is COMPLEMENTARY to the ban, not a replacement for it
 *
 * The SDK says so in as many words: *"`toolAliases` is complementary to
 * `disallowedTools`, not a replacement for it: the alias only affects name-based
 * lookup of model-emitted `tool_use` blocks, whereas `disallowedTools` also
 * blocks harness-internal direct calls that hold the tool object without a name
 * lookup."* So both stay: the ban keeps the ungated copy off the surface, the
 * alias catches the utterance.
 *
 * Single-hop by the SDK's own rule (*"an alias that points at another aliased
 * name resolves that target literally rather than following a chain"*), so
 * these entries cannot loop.
 */
export const CLAUDE_TOOL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  Monitor: 'mcp__session__Monitor', ScheduleWakeup: 'mcp__session__ScheduleWakeup', // P6.220
  Artifact: 'mcp__session__publish_artifact', // UA1.20: the native shape is mapped in handlers/publish-artifact.ts
});

/**
 * Session tools that hand the turn to the UI from inside their handler (plan card, auth prompt).
 * UB2.1 (COR-1), ported from craft-agents-oss v0.15.1 `claude-agent.ts` `HANDOFF_TOOL_NAMES`
 * (Apache-2.0): interrupting before such a tool returns makes the SDK store the call as rejected
 * ("The user doesn't want to proceed with this tool use"), which the model then reads as the
 * user's refusal — so the handoff interrupt waits for the tool's result first.
 */
const HANDOFF_TOOL_NAMES = new Set([
  'mcp__session__SubmitPlan',
  'mcp__session__source_oauth_trigger',
  'mcp__session__source_google_oauth_trigger',
  'mcp__session__source_microsoft_oauth_trigger',
  'mcp__session__source_slack_oauth_trigger',
  'mcp__session__source_credential_prompt',
]);
/** How long a handoff interrupt waits for the handing-off tool's result before interrupting anyway. */
const HANDOFF_RESULT_WAIT_MS = 3_000;

/**
 * The aliases to pass for a given MCP set — empty unless the `session` server is
 * actually in it.
 *
 * The mini path filters `mcpServers` down to `miniConfig.mcpServerKeys`, and a
 * projection that dropped `session` would leave these aliases pointing at a name
 * the child cannot resolve. That is no worse than today's unknown-tool failure,
 * but it would be a lie in the option object, and the next reader would have to
 * re-derive that it is harmless. Gate it instead.
 */
/**
 * **P6.374 — the two documented gateway-400 escapes, per connection.**
 *
 * `llm-gateway-connect.md#troubleshoot-gateway-errors` is the contract and it
 * names both by variable. For *"`400` errors naming `thinking` or `adaptive`,
 * such as `Input tag 'adaptive' found`"*: *"On Opus 4.6 and Sonnet 4.6,
 * `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1` works instead."* For *"`400` errors
 * naming `context_management`, `Extra inputs are not permitted`, or other
 * unrecognized fields"*: *"Set `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`, which
 * suppresses most pre-release fields."* Both are in the shipped bundle
 * (6 and 7 occurrences, against 0 for a control name) and were set by nothing.
 *
 * PER CONNECTION, because which upstream rejects which field is a property of
 * the upstream. The reactive alternative was considered and refused for the
 * first: `anthropic/passthrough-negotiation.ts` lists `thinking` among the
 * fields it must never silently rewrite, so that path cannot rescue the
 * `adaptive` class by design — the module argues against widening it on purpose.
 *
 * `'1'` on both, and never a falsy string. The page writes `=1` for each; the
 * neighbouring `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is the variable whose
 * own trap is that `0` still disables, and these two are not it — so the opt-out
 * here is an ABSENT key, which is what an unset flag produces.
 *
 * The two are independent by the page's own carve-out: *"The variable doesn't
 * affect adaptive reasoning, which is selected by model rather than by beta."*
 * Setting the betas flag therefore cannot stand in for the thinking flag, and a
 * single knob spanning both would be wrong on one of them.
 */
export function buildClaudeGatewayEscapeEnv(
  connection: Pick<LlmConnection, 'disableAdaptiveThinking' | 'disableExperimentalBetas'>,
): Record<string, string> {
  return {
    ...(connection.disableAdaptiveThinking ? { CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: '1' } : {}),
    ...(connection.disableExperimentalBetas ? { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1' } : {}),
  };
}

export function claudeToolAliasesFor(
  mcpServers: Options['mcpServers'] | undefined,
): Record<string, string> | undefined {
  if (!mcpServers || !Object.prototype.hasOwnProperty.call(mcpServers, 'session')) return undefined;
  return { ...CLAUDE_TOOL_ALIASES };
}


/**
 * **P3.314 — `WebSearch` completes, searches nothing, and hands the model an
 * imperative written by a different model. Withheld where it cannot work.**
 *
 * ## What was measured (W2-p PKG-3, packaged 1.33.0, run twice, identical)
 *
 * On `claude-gateway` the tool is dispatched and REPORTS SUCCESS: the call
 * reaches the runtime's transcript, `is_error` is null, the host row reads
 * `toolStatus: 'completed'` — and `toolUseResult.searchCount` is **0 every
 * time**. What comes back in `results[0]` is the upstream gateway model's own
 * attempted tool call rendered as prose (`<|DSML|>tool_calls … name="web_search"`
 * in one run, a `<search>…</search>` wrapper in the other — the shape is
 * whatever that model emits), onto which the SDK appends its own postscript:
 * *"REMINDER: You MUST include the sources above in your response to the user
 * using markdown hyperlinks"* — an instruction pointing at sources that do not
 * exist. The model noticed both runs and fell back to `WebFetch`, which works;
 * nothing in the product said so.
 *
 * ## Why WITHHOLDING is the answer, read from the page rather than chosen
 *
 * `tools-reference.md#websearch-tool-behavior` (anchor verified on the rendered
 * page): *"WebSearch runs a query against Anthropic's web search backend and
 * returns result titles and URLs."* It is a SERVER-side tool executed by the
 * API the session talks to, and the page states the consequence for providers
 * that do not implement one: *"deployments hosted on Azure don't support
 * server-side tools, so the WebSearch call fails"*, and *"Amazon Bedrock doesn't
 * expose the server-side web search tool."* The vendor scopes availability by
 * PROVIDER, and it also names the alternative it endorses: *"The search backend
 * is not configurable. To search with a different provider, add an MCP server
 * that exposes a search tool."*
 *
 * A `claude-runtime` session does not talk to that API. Its turns go to a
 * loopback adapter, and unless the model is marked `wire: 'anthropic-messages'`
 * the request is TRANSLATED — `anthropic/inbound.ts` maps the Anthropic
 * `web_search` server tool onto the Responses-API `{ type: 'web_search' }`, and
 * `to-chat.ts` then has to reach a chat-completions endpoint that has no such
 * tool. So on the translated arm the capability is structurally unservable, not
 * merely unavailable today.
 *
 * Native-first, in order: the runtime already HAS the withholding mechanism, so
 * nothing is built here. `Options.disallowedTools` — the same list that carries
 * the entries above — is documented in the vendored SDK (`0.3.233` `sdk.d.ts`,
 * so this half comes from the BUNDLE) as *"List of tool names that are
 * disallowed. These tools will be removed from the model's context and cannot be
 * used, even if they would otherwise be allowed."* Removed from the CONTEXT is
 * the property that matters: the model is not offered a tool it will be told
 * succeeded. And the host already makes exactly this call for
 * codex, with the same reason in the same words — `buildCodexConfigToml` writes
 * `web_search = "disabled"` because *"Hosted web_search executes on OpenAI's
 * backend — unreachable through the Nestor adapter, so keep it out of the
 * model's tool list entirely."* This makes the two runtimes agree instead of
 * diverging. **Pi is the open third:** its `web_search` is a Pi-side tool with a
 * host-mirrored session budget (`config/web-search-budget.ts`), a different
 * mechanism, and whether it returns real results through this gateway is
 * UNMEASURED — the instrument is a live turn on a Pi gateway session, and the
 * reading is whether the tool's own result carries hits.
 *
 * ## What is deliberately NOT withheld
 *
 * The native-passthrough arm. When the connection marks a model
 * `wire: 'anthropic-messages'` the adapter forwards that request unchanged to
 * the user's own endpoint, which may well implement server-side tools — and
 * removing a tool that works is the failure this repo has already paid for twice
 * (a credential control, a CA control). The router is asked with the model the
 * SDK will actually name, so the withholding follows the request's real route
 * rather than a URL allowlist. Gateway mode routes nothing by construction
 * (`buildClaudeRuntimeWireRouter` returns `undefined` for `kind: 'nestor'`), so
 * every gateway turn is translated and every gateway turn withholds.
 *
 * ## The fence question, decided explicitly (P3.314's second half)
 *
 * The fabricated result is third-party text carrying an imperative, arriving as
 * a tool RESULT, and its author is an upstream MODEL rather than a server an
 * operator admitted. That is a different source from the one
 * `mcp/third-party-text.ts` settles for MCP `instructions` and tool
 * descriptions (P3.293: carried VERBATIM on all three runtimes, because the
 * vendor ships those bytes unframed and the model is MEANT to act on a server's
 * own self-description), and from the hook-stdout family next door
 * (`automations/hook-context-fence.ts`, P2.236).
 *
 * **Decision: no fence is added, because the SOURCE is removed instead.** A
 * fence exists for text we must carry — a server's designated self-description,
 * a hook's output the user asked for. This text is neither: it is an artefact of
 * a capability that cannot function, and wrapping it in an untrusted marker
 * would preserve a useless tool call and add a notice about it. Deleting the
 * call deletes the text. Where the tool IS left standing — the passthrough arm —
 * its results come from the endpoint the user chose, which is the P3.293 case
 * exactly, and is unfenced there for P3.293's reasons.
 *
 * The residue, stated: this closes the hazard on the arm that was measured. If a
 * future path lets a translated turn produce any other server-side tool result,
 * that result reaches the model unfenced, and the answer will be the same one —
 * withhold the tool — for the same reason.
 *
 * AND IT FAILS OPEN, deliberately, in exactly one state: `upstreamKind` is null
 * until `postInit` has resolved an adapter, so a turn that somehow ran before
 * that keeps the tool. That is the same read the gateway error-wording gate
 * already makes from the same field, and the failure direction is today's
 * behaviour — a useless tool call — rather than a session that loses a working
 * capability because a field had not been filled in yet.
 */
export function resolveClaudeHostedWebSearchWithheld(input: {
  /**
   * The upstream mode the local adapter resolved, or `null`/`undefined` on a
   * session that has no local adapter — i.e. every provider type but
   * `claude-runtime`, which reaches Anthropic's own API and keeps the tool.
   */
  upstreamKind: string | null | undefined;
  /** The session's wire router, or `null` when no model is marked. */
  wireRouter: ((model: string) => UpstreamTarget | undefined) | null | undefined;
  /** The model id the SDK will name in the request. */
  model: string;
}): boolean {
  if (!input.upstreamKind) return false;
  return input.wireRouter?.(input.model) === undefined;
}

/**
 * What the model is told when a call reaches `canUseTool` and there is genuinely
 * no person behind this session — a headless run, or a client that never
 * attached a permission handler.
 *
 * R2 returned this shape for EVERY non-question tool, because no approval
 * surface was wired to the callback yet. That was fail-closed and temporary,
 * and it was also a live behaviour change with two victims: a user whose own
 * `"permissions": { "ask": ["Bash(git push:*)"] }` rule made `git push`
 * impossible without ever being asked, and a trusted automation whose
 * `decision: 'ask'` did the same to a call our gate allows. R3 replaces the
 * refusal with the real card, so this text is now only what an unattended
 * session hears.
 */
export const CAN_USE_TOOL_NO_SURFACE_DENIAL =
  'This call needs a person to approve it and this session has nobody attached to ask, '
  + 'so it was refused rather than approved without asking.';

/** What the model is told when the person said no. */
export const CAN_USE_TOOL_DECLINED_DENIAL = 'The user declined this tool call.';

/**
 * What the model is told when a call reaches the callback in a mode that never
 * prompts.
 *
 * The SDK should not route one here at all — "In `dontAsk` mode, this step is
 * skipped and the tool is denied" (`agent-sdk/permissions.md`) — but the mode it
 * is applying was captured when this process started, while ours is read live
 * per call. A session that moved into `dontAsk` mid-turn is exactly the case
 * where the two disagree, and a card in a mode whose contract is "never prompt"
 * is the wrong way to resolve that disagreement.
 */
export const CAN_USE_TOOL_DONT_ASK_DENIAL =
  'This call needed approval, and this session is in a permission mode that never prompts, '
  + 'so it was denied instead of asked about.';

/**
 * Whether this PreToolUse prompt is the one `canUseTool` is about to raise
 * properly, so showing our own card would ask the same user twice.
 *
 * The shared gate marks `AskUserQuestion` interaction-required — it is in
 * `INTERACTION_ONLY_TOOLS` — and that is right for Pi, where the PreToolUse gate
 * IS the ask surface. On Claude it is the wrong surface twice over: our card is
 * a yes/no on "may the model ask?", and the SDK routes the call onward
 * regardless, because "`AskUserQuestion` … always fall[s] through to the
 * callback, even when an allow rule matches" (`permissions.md`). The user would
 * answer a permission prompt and then answer the question.
 *
 * Deliberately narrow, and deliberately HERE rather than in
 * `core/pre-tool-use.ts`: that file serves Pi as well, where the same floor is
 * documented and correct. Only this tool, and only the interaction floor; another
 * prompt class on it would still show its card. F1.843: an `ask` rule on it raises
 * none (a `toolRules` ask only rewords this floor's prompt, and a readable ask
 * keeps a floor's marker), so the question is the one dialog, and a deny refuses.
 * `dontAsk` never gets here: the gate blocks ("both cases are denied instead").
 */
export function askUserQuestionPromptBelongsToCanUseTool(
  toolName: string,
  checkResult: PreToolUseCheckResult,
): boolean {
  return toolName === ASK_USER_QUESTION_TOOL
    && checkResult.type === 'prompt'
    && checkResult.nonNegotiable === 'requiresUserInteraction';
}

/**
 * What an auto-continue reports when it expired with nothing selected at all.
 *
 * `afkTimeoutMs` says the user was away; it does not say they chose nothing, and
 * an empty `answers` on its own reads as "the question was answered with
 * silence". Only used when there is genuinely nothing else to send, because
 * `response` REPLACES the per-question list.
 */
const ASK_USER_AUTO_CONTINUE_NOTE =
  'The user may be away from their keyboard, so the question auto-continued with no options selected. '
  + 'Proceed on your own judgment; you can re-ask later if needed.';

/**
 * Read the SDK's `AskUserQuestion` input into the ask-request shape this
 * product's permission channel already renders.
 *
 * The two shapes match field for field, which is why this is a projection and
 * not a translation. `user-input.md` § Question format: `question` is "The full
 * question text to display", `header` is a "Short label for the question (max 12
 * characters)", `options` is an "Array of 2-4 choices, each with `label` and
 * `description`. TypeScript: optionally `preview`", and `multiSelect` means "If
 * `true`, users can select multiple options".
 *
 * Nothing is validated here on purpose — `ElicitationAskUserBridge.ask` runs
 * `validateAskUserQuestions` on the way in, so a malformed batch is refused at
 * one place rather than two. An empty `questions` array therefore survives this
 * function and is rejected by the bridge with its own reason.
 *
 * `allowFreeText` is on because the documented flow requires it: "Display an
 * additional 'Other' choice after Claude's options that accepts text input" and
 * "Use the user's custom text as the answer value (not the word 'Other')".
 * `question`/`options` carry the first question as the legacy single-question
 * projection, which is what a downgraded client renders.
 */
export function askUserRequestFromQuestionInput(
  input: Record<string, unknown>,
): AskUserPermissionRequest {
  const rawQuestions = Array.isArray(input.questions) ? input.questions : [];
  const questions: AskUserQuestionItem[] = rawQuestions.map(rawQuestion => {
    const item = (rawQuestion ?? {}) as {
      question?: unknown; header?: unknown; options?: unknown; multiSelect?: unknown;
    };
    const options = (Array.isArray(item.options) ? item.options : []).map(rawOption => {
      const option = (rawOption ?? {}) as { label?: unknown; description?: unknown; preview?: unknown };
      return {
        label: typeof option.label === 'string' ? option.label : '',
        ...(typeof option.description === 'string' ? { description: option.description } : {}),
        ...(typeof option.preview === 'string' ? { preview: option.preview } : {}),
      };
    });
    return {
      question: typeof item.question === 'string' ? item.question : '',
      ...(typeof item.header === 'string' ? { header: item.header } : {}),
      options,
      ...(item.multiSelect === true ? { multiSelect: true } : {}),
    };
  });
  const first = questions[0];
  return {
    question: first?.question ?? '',
    options: first?.options.map(option => option.label) ?? [],
    allowFreeText: true,
    questions,
  };
}

/**
 * Turn one answer into the `updatedInput` the `AskUserQuestion` tool consumes.
 *
 * `user-input.md` § Response format, the two required fields: `questions` —
 * "Pass through the original questions array (required for tool processing)";
 * `answers` — "Object where keys are question text and values are selected
 * labels". Hence the spread of the caller's own `input`: the original array goes
 * back untouched rather than re-serialized from our projection of it.
 *
 * `response` is the third, optional field and it REPLACES the per-question list:
 * "Set `response` only when your UI lets the user dismiss the question card and
 * type a general reply that isn't an answer to any specific question. When
 * `response` is set, Claude receives 'The user responded: …' instead of the
 * per-question answer list."
 *
 * A legacy `free_text` answer maps to a per-question value, NOT to `response` —
 * it is the "Other" box on a single-question card, which the docs make a
 * per-question answer ("Use the user's custom text as the answer value (not the
 * word 'Other')").
 *
 * **Two corrections the SDK's own `AskUserQuestionOutput` forced, neither of
 * which is in the prose.** Read from the installed `sdk-tools.d.ts`, and both
 * are the kind of thing that ships wrong if only the page is consulted:
 *
 * - `answers` is typed `{ [k: string]: string }` — a STRING, never an array,
 *   with the comment "multi-select answers are comma-separated". The page says
 *   "pass an array of labels or join them with `\", \"`" and its Python sample
 *   passes an array; its TypeScript sample joins. The type is the narrower of
 *   the two and it is the one this runtime is compiled against, so multi-select
 *   selections are joined here.
 * - `afkTimeoutMs` exists and is documented on the field as "Set when the dialog
 *   auto-resolved after this many milliseconds of idle (user away from
 *   keyboard). Absent on every human-resolved path." That is the SDK's own
 *   channel for exactly what our `autoContinued` means, so an auto-continue
 *   keeps BOTH its selections and its away signal. The prose alternative —
 *   borrowing `response` — would have replaced the answers the user did make.
 *   `response` is now used for an expiry only when nothing was selected at all.
 */
export function askUserQuestionAnswerEnvelope(
  input: Record<string, unknown>,
  answer: AskUserAnswer,
  request: AskUserPermissionRequest,
): Record<string, unknown> {
  const firstQuestion = request.questions?.[0]?.question ?? request.question;
  if (answer.type === 'option' || answer.type === 'free_text') {
    return { ...input, answers: { [firstQuestion]: answer.value } };
  }
  const answers: Record<string, string> = {};
  for (const [question, selection] of Object.entries(answer.answers ?? {})) {
    answers[question] = Array.isArray(selection) ? selection.join(', ') : selection;
  }
  const emptied = Object.keys(answers).length === 0;
  const response = answer.response
    ?? (answer.autoContinued && emptied ? ASK_USER_AUTO_CONTINUE_NOTE : undefined);
  return {
    ...input,
    answers,
    ...(response === undefined ? {} : { response }),
    ...(answer.autoContinued && request.timeoutMs !== undefined
      ? { afkTimeoutMs: request.timeoutMs }
      : {}),
  };
}

/**
 * The tools whose approval card is about a file being written, for the one
 * field the renderer styles by kind. `Edit` covers `Write` and `NotebookEdit` on
 * the rules side too — "`Edit(path)` rules govern all built-in tools that write
 * files, including `Write` and `NotebookEdit`" (`agent-sdk/permissions.md`) — so
 * they are one class here as well.
 */
const CLAUDE_FILE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'Edit', 'MultiEdit', 'Write', 'NotebookEdit',
]);

/** One tool call, projected onto the permission card this product already has. */
/**
 * P6.951 — the answer to one `canUseTool` card.
 *
 * A shape rather than a boolean, because the SDK's own `PermissionResult` deny
 * branch carries `message` — the reason the model is told — and the user may now
 * write it. `comment` is absent on every path that is not a person typing one:
 * an approval, an aborted turn, a torn-down session.
 */
export interface ClaudeToolApprovalAnswer {
  allowed: boolean;
  /** The note attached to a DENIAL, which becomes `deny.message`. */
  comment?: string;
  /**
   * C3.312 — the user answered "always allow" on a card whose grant this fork
   * can actually honour.
   *
   * It is NOT the raw `alwaysAllow` boolean off the wire: it is that boolean AND
   * {@link ClaudeToolApprovalRequest.canRememberForSession}, re-tested where the
   * answer is settled, so a client that ignores `noAlwaysAllow` cannot produce a
   * grant this runtime would drop. Absent on every other path.
   */
  rememberForSession?: boolean;
}

export interface ClaudeToolApprovalRequest {
  requestId: string;
  toolName: string;
  command: string;
  description: string;
  type?: PermissionRequestType;
  reason?: string;
  /**
   * C3.370 — the subagent that raised this call, from the SDK's own `agentID`.
   *
   * Named `agentLabel` because that is the `PermissionRequest` field the card
   * renders; absent on a main-thread call, which is what makes the chip mean
   * something when it appears.
   */
  agentLabel?: string;
  /**
   * C3.312 — whether an "always allow" answer on THIS call can be honoured, and
   * therefore whether the card may offer the button at all.
   *
   * Derived rather than assumed: see {@link claudeToolApprovalRequest} for the
   * predicate and the measurement behind it.
   */
  canRememberForSession?: boolean;
  /**
   * F1.1219 — the SDK's own `defaultToNo` hint: one stray keystroke must not
   * approve this call, so the card must not pre-select Allow. Absent unless the
   * SDK set it; the reading is on {@link claudeToolApprovalRequest} (I2.7).
   */
  defaultToNo?: boolean;
}

/** What {@link claudeSessionPermissionUpdateBoundary} let through, and what it did not. */
export interface ClaudePermissionUpdateVerdict {
  /** Entries that may be returned to the runtime, in the order they arrived. */
  readonly allowed: readonly Record<string, unknown>[];
  /** One sentence per refused entry, for the debug channel and for a receipt. */
  readonly refusals: readonly string[];
}

/**
 * C3.279 — the privilege boundary for anything this fork ever returns to the
 * claude runtime as `updatedPermissions`.
 *
 * ## Why it exists BEFORE the first producer does
 *
 * On Pi, `PiAgent.applyPermissionRequestUpdates` is both the applier and the
 * boundary, and it refuses four things BY NAME: `userSettings` outright, an
 * allow rule aimed at any settings file unless it echoes a suggestion the host
 * itself offered, `replaceRules`/`removeRules` at a settings destination, and
 * the non-rule entry types anywhere but the session.
 *
 * **The claude runtime shares none of those refusals, measured.** C3.85 drove
 * all six kinds against all five destinations on the vendored `2.1.247`
 * (`__tests__/claude-permission-update-destinations-e2e.test.ts`): thirty runs,
 * every one `result: success`, with `userSettings` writing
 * `<CLAUDE_CONFIG_DIR>/settings.json`, `projectSettings` writing a
 * `<cwd>/.claude/settings.json` a repository checks in, and `removeRules`
 * emptying `permissions.allow`. There is no ask-first step: whatever reaches
 * `updatedPermissions` is performed.
 *
 * So the asymmetry is not a Pi feature — it is a claude EXPOSURE that has been
 * harmless only because nothing here produces an update. The moment a producer
 * exists (C3.278's seam is the first), the same boundary has to exist, or one
 * runtime's plugin stdout can write to a user's settings files where the other
 * runtime refuses by name. It is written here rather than inside that producer
 * so a SECOND producer cannot be added without it.
 *
 * ## The rule, and it is deliberately narrower than Pi's
 *
 *  - **`session` and nothing else.** Pi accepts `localSettings`/`projectSettings`
 *    for restrictions and for echoed suggestions because Pi's own writer is
 *    additive-only and host-owned. Here the RUNTIME performs the write, with no
 *    additive-only guarantee we control, so every settings destination is
 *    refused — including `cliArg`, which C3.85 measured as writing nothing at
 *    all, because an entry that silently does nothing is a grant a user may
 *    believe in.
 *  - **Nothing may remove or replace a rule.** `removeRules`, `replaceRules` and
 *    `removeDirectories` are refused at every destination, for Pi's reason
 *    stated in its own words: nothing may remove a rule it did not add.
 *  - **`setMode` is refused.** A grant path must not change the session's mode,
 *    and C3.281 measured the runtime accepting `bypassPermissions` and silently
 *    doing nothing — so a success verdict there would not even be evidence.
 *  - **`addRules` only when it ECHOES what the runtime offered for this call.**
 *    `canUseTool`'s own options carry `suggestions`, documented as *"Suggestions
 *    for updating permissions so that the user will not be prompted again for
 *    this tool during this session … if presenting the user an option 'always
 *    allow' or similar, then this full set of suggestions should be returned as
 *    the `updatedPermissions`"*. That is the same mechanism hooks.md gives Pi,
 *    from the other side, so the same test applies: an allow rule nobody offered
 *    is not an echo of a user's choice, it is a rule invented downstream.
 *  - **`addDirectories` at `session` is the one entry allowed on its own merit**,
 *    because C3.7 measured it: it applies to the rest of the running turn, with
 *    no respawn, and writes nothing anywhere.
 *
 * Pure, and it returns REFUSALS rather than throwing: a refused entry must not
 * cost the user the approval they just gave, exactly as Pi's `deferred` list
 * does not abort its applied ones.
 */
export function claudeSessionPermissionUpdateBoundary(
  entries: readonly unknown[],
  options: { offeredSuggestions?: readonly unknown[] } = {},
): ClaudePermissionUpdateVerdict {
  const allowed: Record<string, unknown>[] = [];
  const refusals: string[] = [];
  const asRecord = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  /** Rule entries as comparable strings, the shape Pi's `wasOffered` compares. */
  const ruleStrings = (rulesValue: unknown): string[] => {
    const raws: string[] = [];
    for (const ruleValue of Array.isArray(rulesValue) ? rulesValue : []) {
      const rule = asRecord(ruleValue);
      const toolName = typeof rule?.toolName === 'string' ? rule.toolName : '';
      const content = typeof rule?.ruleContent === 'string' ? rule.ruleContent : undefined;
      if (!toolName) continue;
      raws.push(content ? `${toolName}(${content})` : toolName);
    }
    return raws.sort();
  };
  const wasOffered = (entry: Record<string, unknown>): boolean => {
    const wanted = JSON.stringify(ruleStrings(entry.rules));
    if (wanted === '[]') return false;
    return (options.offeredSuggestions ?? []).some(value => {
      const suggestion = asRecord(value);
      return suggestion?.type === 'addRules'
        && suggestion.behavior === entry.behavior
        && JSON.stringify(ruleStrings(suggestion.rules)) === wanted;
    });
  };

  for (const value of entries) {
    const entry = asRecord(value);
    if (!entry) {
      refusals.push('Refused a non-object updatedPermissions entry.');
      continue;
    }
    const destination = entry.destination ?? 'session';
    const type = typeof entry.type === 'string' ? entry.type : '<no type>';
    if (destination !== 'session') {
      refusals.push(
        `Refused "${type}" at destination "${String(destination)}": on this runtime the child performs the`
        + ' write itself, so only session scope is returned from here.',
      );
      continue;
    }
    if (type === 'removeRules' || type === 'replaceRules' || type === 'removeDirectories') {
      refusals.push(`Refused "${type}": nothing may remove or replace a permission it did not add.`);
      continue;
    }
    if (type === 'setMode') {
      refusals.push('Refused "setMode": a grant path does not change the session mode.');
      continue;
    }
    if (type === 'addRules') {
      if (!wasOffered(entry)) {
        refusals.push('Refused "addRules": it does not echo a suggestion the runtime offered for this call.');
        continue;
      }
      allowed.push(entry);
      continue;
    }
    if (type === 'addDirectories') {
      const directories = Array.isArray(entry.directories)
        ? entry.directories.filter((item): item is string => typeof item === 'string' && item.length > 0)
        : [];
      if (directories.length === 0) {
        refusals.push('Refused "addDirectories": it named no directory.');
        continue;
      }
      allowed.push({ ...entry, directories });
      continue;
    }
    refusals.push(`Refused "${type}": not an entry kind this fork returns.`);
  }
  return { allowed, refusals };
}

/**
 * C3.314 — the refusals {@link claudeSessionPermissionUpdateBoundary} makes
 * become a line the USER can read, and the `setMode` one says why silence was
 * the alternative.
 *
 * ## The gap C3.281 left, stated exactly
 *
 * C3.281 wrote the measurement down at {@link buildClaudeCanUseTool} and that
 * is where it stopped: a comment. The refusals themselves went to
 * `context.debug` alone, and a packaged build logs nothing outside debug mode —
 * so a permission change a user's "always allow" click asked for could be
 * dropped with no trace anywhere they look. AGENTS.md states the consequence in
 * general terms and it is exact here: *"an undocumented choice nobody can see is
 * indistinguishable from a defect"*.
 *
 * ## Why `setMode` gets a sentence of its own
 *
 * It is the one kind where the RUNTIME'S OWN ANSWER would have been misleading.
 * C3.85 drove all six update kinds against all five destinations on the vendored
 * `2.1.247` (`__tests__/claude-permission-update-destinations-e2e.test.ts`):
 * thirty runs, every one `result: success`, nothing thrown — and
 * `setMode: 'bypassPermissions'` wrote NOTHING at `userSettings`, where
 * `acceptEdits` writes `permissions.defaultMode`, and did not take at `session`
 * either. So a fork that forwarded it would have been told it worked. That is
 * the difference between this refusal and the other four classes, and it is the
 * half worth spending a sentence on.
 *
 * ## C3.331 — HALF localised, and the line between the halves is the point
 *
 * The controller's posture for the shared warning seam is LOCALISE, and this
 * notice is where the rule that decides every member of that seam is written
 * down, because this is the sentence that sits on both sides of it.
 *
 * **The app's own words follow the UI language.** The frame here is addressed to
 * the person in the chat, in the second person — *your approval stands* — and a
 * bilingual app saying that in English beside a fully translated permission card
 * is the divergence the posture is about. It is localised, and so is the
 * renderer's own warning bubble (`ChatDisplay.tsx`, `chat.warningBubble.*`).
 *
 * **A verbatim quotation is not translated, because a translated quote is no
 * longer a quote.** That is what the rest of this seam is made of, and it is
 * why the refusal LIST below is passed through as data rather than composed from
 * keys: each entry names an SDK entry kind (`"setMode"`, `"addRules"`) or a
 * destination (`userSettings`) that exists in exactly one spelling. The same
 * rule keeps three siblings in English and the reason is theirs, not an
 * oversight: `formatClaudeWideningDefaultModeRefusal`
 * (`packages/shared/src/agent/claude-default-mode-scope.ts`) QUOTES
 * `settings-reference.md` inside its own sentence;
 * `formatClaudeShellCommandSettingRefusal`
 * (`packages/shared/src/agent/claude-shell-command-settings.ts`) and
 * `formatClaudeDangerousModeAckRefusal`
 * (`packages/shared/src/agent/claude-dangerous-mode-settings.ts`) are addressed
 * to whoever administers a `.claude` settings file and name its keys; and the
 * SDK shadow warning `ClaudeAgent` relays is the vendor's own sentence, carried
 * verbatim so a paraphrase cannot be wrong about another product's behaviour.
 * All four are PINNED by
 * `packages/shared/src/agent/__tests__/claude-warning-seam-localisation.test.ts`,
 * so the day someone localises one the test names this decision instead of
 * leaving the next reader to guess.
 *
 * Residue, stated rather than left to be met: the seam is not four sentences.
 * `level: 'warning'` occurs on 32 lines of `SessionManager.ts`, 12 of this file,
 * 9 of `codex-agent.ts` and 2 of `pi-agent.ts` (`grep -ac`, i.e. matching LINES,
 * 2026-09-13), and the rule above is what each of them has to be read against.
 *
 * Returns `undefined` when nothing was refused, so the caller has no branch of
 * its own to get wrong.
 */
export function formatClaudeSessionGrantRefusalNotice(input: {
  /** The tool whose approval carried the grant. */
  toolName: string;
  /** The boundary's own verdict, refusals in the order they arrived. */
  verdict: ClaudePermissionUpdateVerdict;
}): string | undefined {
  const { refusals } = input.verdict;
  if (refusals.length === 0) return undefined;
  // The guard every localized notice in this tree carries: an uninitialized
  // i18next returns `undefined` from `t()`, and the headless `nessy-server`
  // entry never calls `setupI18n()`.
  if (!i18n.isInitialized) setupI18n();
  // `forwarded` and `dropped` rather than `count`: i18next reads `count` as a
  // PLURAL selector and would look for `…_one`/`…_other` forms these keys
  // deliberately do not have — the English says "change(s)", so neither locale
  // needs a plural family.
  const kept = input.verdict.allowed.length > 0
    ? i18n.t('chat.claudeGrantRefusal.standsWithForwarded', {
      tool: input.toolName,
      forwarded: input.verdict.allowed.length,
    })
    : i18n.t('chat.claudeGrantRefusal.stands', { tool: input.toolName });
  const head = `${kept} ${i18n.t('chat.claudeGrantRefusal.dropped', { dropped: refusals.length })}`;
  const body = refusals.join(' ');
  // The measured half, and only when the kind it is about was actually refused.
  const bypassNote = refusals.some(refusal => refusal.includes('"setMode"'))
    ? ` ${i18n.t('chat.claudeGrantRefusal.bypassNote')}`
    : '';
  return `${head} ${body}${bypassNote}`;
}

/**
 * Read the SDK's `canUseTool` arguments into the permission-request shape
 * `onPermissionRequest` renders — the same surface the PreToolUse `prompt`
 * branch raises, and the same one the Codex approval path uses.
 *
 * **The prompt text is the SDK's own wherever it supplied one**, because it
 * says so on the field: `title` is the "Full permission prompt sentence
 * rendered by the bridge (e.g. \"Claude wants to read foo.txt\"). Use this as
 * the primary prompt text when present instead of reconstructing from
 * toolName+input." Reconstructing it from the input is the fallback, not the
 * default — the bridge knows things about a call that its raw input does not
 * carry.
 *
 * `reason` is assembled rather than picked, because the three fields that can
 * explain a prompt are independent and a user reading a card needs whichever
 * ones fired: `decisionReason` ("Explains why this permission request was
 * triggered"), `matchedAskRule` (set "when a user-configured ask RULE
 * (permissions.ask) forced this prompt"), and `blockedPath` ("The file path
 * that triggered the permission request … when a Bash command tries to access a
 * path outside allowed directories"). A rule-forced ask names the rule, so the
 * answer to "why am I being asked this, I never see this prompt" is on the card
 * instead of in a support thread.
 *
 * The request id is the SDK's `requestId` — "The control_request envelope's
 * `request_id`" — and not the tool-use id, because one tool call can raise both
 * our own PreToolUse card and this one, and two cards sharing an id is a
 * mis-routed answer.
 *
 * ## C3.370 — `agentID` rides `agentLabel`, and it used to ride only `reason`
 *
 * R6b measured the consequence on the packaged 1.37.0 (C5.11 / RS-14): a
 * background subagent's `Write` raised a card in the parent's pane whose text
 * was shape-identical to the control's, and the subagent's id appeared nowhere.
 * The cause is two fields for one fact. This function already spelled the
 * subagent into `reason` (the clause below), and the card
 * (`apps/electron/src/renderer/components/app-shell/input/structured/PermissionRequest.tsx`)
 * renders `agentLabel` — which had exactly one producer,
 * `SessionManager.permissionSurfaceRouting`, gated on `managed.piParentSessionKey`
 * and therefore **Pi-only**. A claude subagent runs inside the claude child and
 * has no `ManagedSession` of its own, so nothing ever set the field the card
 * reads, and `reason` is rendered on no permission card at all.
 *
 * So the value travels on BOTH, deliberately, because they answer different
 * questions: `agentLabel` is the chip that says WHO is asking, and the `reason`
 * clause is one of up to four sentences saying WHY this call was stopped. The
 * SDK's own `agentID` is the source — *"If running within the context of a
 * sub-agent, the sub-agent's ID"* — so there is nothing to derive and nothing to
 * correlate.
 *
 * ## I2.7 / F1.1219 — the two SAFETY hints, read through the callback
 *
 * The permission ask carries two fields whose whole purpose is to constrain how
 * a host renders it. Through 0.3.267 `sdk.mjs` dropped both between the wire and
 * this callback (I2.7 pinned the absence as a tripwire); 0.3.268 projects them
 * into the options (F1.1213 saw the tripwire fire), and
 * `agent-sdk/typescript.md#canusetool` documents them, verbatim:
 *
 *   `defaultToNo` — "When `true`, a single stray keystroke must not approve this
 *   request: open your prompt on its decline option, don't pre-select approve,
 *   and offer no one-key approve shortcut."
 *
 *   `suppressAlwaysAllowRule` — "When `true`, don't offer a persistent
 *   always-allow choice for this request, because the rule it would write grants
 *   more than the request's own action."
 *
 * Native-first, each rides what the card already has, as Claude Code's prompt:
 *
 *  - `suppressAlwaysAllowRule` folds into `claudeCallCanRememberForSession`: the
 *    "always allow" here IS the runtime's own suggested rule echoed back, so the
 *    hint withholds exactly that and the card goes out with `noAlwaysAllow: true`
 *    — a field every client (iOS too) already honours. A one-time Allow stays.
 *  - `defaultToNo` rides the request as its own optional field, since no existing
 *    one says it; the card (`PermissionRequest.tsx`) opens with focus on Deny and
 *    draws Allow without the filled default style. It has no one-key approve
 *    shortcut to withhold. The durable record keeps it and a re-fired card carries
 *    it (F1.1231), though a claude record on that path expires instead (F1.954).
 *
 * `decision_reason_type` and `classifier_approvable` are still dropped by the
 * SDK and are NOT safety-shaped in the same way — they are policy inputs a host
 * may act on, not constraints on the rendering — so they are named here for
 * completeness rather than queued.
 */
export function claudeToolApprovalRequest(
  toolName: string,
  input: Record<string, unknown>,
  options: Parameters<CanUseTool>[2],
): ClaudeToolApprovalRequest {
  const isMcp = toolName.startsWith('mcp__');
  const command = toolName === 'Bash' && typeof input.command === 'string'
    ? input.command
    : CLAUDE_FILE_WRITE_TOOLS.has(toolName) && typeof input.file_path === 'string'
      ? input.file_path
      : options.blockedPath ?? toolName;
  const type: PermissionRequestType | undefined = toolName === 'Bash'
    ? 'bash'
    : CLAUDE_FILE_WRITE_TOOLS.has(toolName)
      ? 'file_write'
      : isMcp
        ? 'mcp_mutation'
        : undefined;
  const rule = options.matchedAskRule;
  const reason = [
    options.decisionReason,
    rule
      ? `Your own "ask" permission rule requires approval for ${rule.ruleContent
        ? `${rule.toolName}(${rule.ruleContent})`
        : rule.toolName} (from ${rule.source}).`
      : undefined,
    options.blockedPath && command !== options.blockedPath
      ? `Path outside the allowed directories: ${options.blockedPath}`
      : undefined,
    options.agentID ? `Requested by the "${options.agentID}" subagent.` : undefined,
  ].filter((value): value is string => Boolean(value)).join(' ') || undefined;
  return {
    requestId: `perm-${options.requestId}`,
    toolName,
    command,
    description: options.title
      ?? options.description
      ?? (command === toolName ? `${toolName} requires your approval` : `${toolName}: ${command}`),
    ...(type ? { type } : {}),
    ...(reason ? { reason } : {}),
    // C3.370 — the chip the card actually renders. See the header for why the
    // same fact also rides `reason`.
    ...(options.agentID ? { agentLabel: options.agentID } : {}),
    ...(claudeCallCanRememberForSession(options) ? { canRememberForSession: true } : {}),
    ...(options.defaultToNo === true ? { defaultToNo: true } : {}), // F1.1219 — see the I2.7 header
  };
}

/**
 * C3.312 — may this card offer "always allow", and the two reasons it usually
 * may not.
 *
 * ## The mechanism is the runtime's own, and it is per call
 *
 * `canUseTool`'s options carry `suggestions`, documented as exactly this
 * button's mechanism: *"Suggestions for updating permissions so that the user
 * will not be prompted again for this tool during this session. Typically if
 * presenting the user an option 'always allow' or similar, then this full set of
 * suggestions should be returned as the `updatedPermissions` in the
 * PermissionResult."* C3.278 built the echo seam, C3.279 the boundary that vets
 * it, C3.7 measured that a session-scoped entry binds for the rest of the turn
 * and writes nothing. What nobody had asked is WHICH CALLS carry a suggestion
 * this fork will actually forward.
 *
 * ## The measurement that decided the predicate (2026-09-12, vendored `2.1.247`)
 *
 * Driven through the offline loopback rig
 * (`__tests__/fixtures/claude-permission-update-probe.ts`, which now records the
 * option), on a three-request turn in `default` mode. The runtime offered a
 * suggestion on BOTH consultations — and they are not the same kind:
 *
 * | the call | the runtime's suggestion |
 * | --- | --- |
 * | `Write` inside the working directory | `{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }` |
 * | `Read` of a path OUTSIDE it | `{ type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Read', ruleContent: '//<dir>/**' }] }` |
 *
 * So "always allow this edit" is a MODE CHANGE on this runtime, and
 * {@link claudeSessionPermissionUpdateBoundary} refuses `setMode` — both because
 * a grant path must not change the session mode and because C3.281 measured the
 * runtime reporting success for a `setMode` it does not apply. Offering the
 * button there would be a click that does nothing, followed by the C3.314 notice
 * explaining why: a promise this fork cannot keep, which is the shape
 * `noAlwaysAllow` exists to prevent.
 *
 * The predicate is therefore **the boundary itself**, run over the runtime's own
 * suggestions with those same suggestions as the offer set — which is the echo
 * test, satisfied by construction — and asking whether ANYTHING survives. No
 * second policy, and a boundary change moves the button with it rather than
 * leaving the two to drift.
 *
 * ## POSTURE — C3.312 held `bash` back; C4.46 (OWNER, 2026-09-13) let it through
 *
 * C3.312's exclusion read: *"`bash` is excluded even when its suggestion would
 * pass"*, because the host's own `SessionManager.persistBashAlwaysAllowRule`
 * fires on the same click for a card of that type and writes a PERMANENT
 * per-repository rule into `.claude/settings.local.json` — which the claude child
 * really does read, so it is not inert. That reasoning was right and the row
 * deliberately left the wider grant to the owner.
 *
 * The owner took it, with the safety half attached: a Bash approval on the claude
 * card may be remembered FOR THE SESSION, never written to a settings file. So
 * two things move together and neither is optional:
 *
 *  1. this clause goes, and the predicate becomes the boundary alone — a Bash
 *     card offers the button exactly when the runtime itself offered a
 *     session-scoped `addRules` for that call, and the grant is that suggestion
 *     echoed back, so it covers the command the runtime named and nothing wider;
 *  2. the PERSIST CUT, in `SessionManager.respondToPermission`: the permanent
 *     `Bash(<base> *)` write is now refused for a card whose `origin` is
 *     `claude_native`. Without it, one click on a card the renderer labels
 *     "session" (`PermissionRequest.tsx` symbol `permissionRememberScope`
 *     returns 'session' for a bash card on claude) would also mint a permanent
 *     repository-wide shell allow rule — the widest grant class, with the
 *     sandbox off. That is the exact shape `noAlwaysAllow` exists to prevent.
 *
 * The vendor's own tier table (`permissions.md#permission-system`, the Bash row)
 * documents that remember as *"Permanently per repository and command"*, so the
 * PAGE is wider than what ships here. That is a deliberate narrowing, not a
 * parity gap closed by accident: this fork's gate keeps asking on the host side
 * regardless (C3.365), so a repository rule would buy the user the widening and
 * none of the convenience.
 *
 * The EDIT card is untouched and stays excluded — not by a clause but by the
 * boundary, which refuses the `setMode` the runtime offers there. No page reading
 * moves that: C3.281 measured the runtime reporting success for a `setMode` it
 * does not apply. With the `bash` clause gone there is no card-TYPE term left in
 * this predicate at all, which is why it no longer takes one: the boundary run
 * over the runtime's own suggestions is the whole rule.
 */
function claudeCallCanRememberForSession(
  options: Parameters<CanUseTool>[2],
): boolean {
  if (options.suppressAlwaysAllowRule === true) return false; // F1.1219 — the SDK withholds this very rule (I2.7 header)
  const suggestions = (options as unknown as { suggestions?: readonly unknown[] }).suggestions;
  if (!Array.isArray(suggestions) || suggestions.length === 0) return false;
  return claudeSessionPermissionUpdateBoundary(suggestions, { offeredSuggestions: suggestions })
    .allowed.length > 0;
}

/**
 * The `canUseTool` callback: the one channel through which a Claude-runtime tool
 * call can reach a person.
 *
 * What this replaced, measured 2026-08-16 by unbounded `grep -a canUseTool` over
 * `packages` and `apps` (node_modules, dist and release excluded): a single stub,
 * `async (_toolName, input) => ({ behavior: 'allow', updatedInput: input })`,
 * carrying the comment "This callback is NOT called by the SDK because we set
 * `permissionMode: 'bypassPermissions'`". **That comment is wrong today, not
 * merely after the bypass goes.** `permissions.md` § How permissions are
 * evaluated puts three routes ahead of the permission-mode step:
 *
 *   "Check `ask` rules from settings.json. If an ask rule matches, the call
 *   falls through to your `canUseTool` callback for confirmation, even in
 *   `bypassPermissions` mode."
 *
 *   "Tools that require user interaction behave the same way: `AskUserQuestion`
 *   and MCP tools whose server sets `_meta[\"anthropic/requiresUserInteraction\"]`
 *   always fall through to the callback, even when an allow rule matches. In
 *   `dontAsk` mode both cases are denied instead, because that mode never
 *   prompts."
 *
 *   "[claude.ai connector] tools your organization has set to `ask` also leave
 *   the flow at this step. Every call falls through to the callback, even in
 *   `bypassPermissions` mode and even when an allow rule matches."
 *
 * We pass `settingSources` with `user` (and, for a trusted project, `project` and
 * `local` — F1.768), so a user's own `ask` rule is loaded and lands here — where
 * the stub answered yes for them. Every one of those three routes asked for a human.
 *
 * **R3 is what finally gives them one.** R2 refused them instead, fail-closed
 * and explicitly temporary, and that refusal was itself a live behaviour change:
 * a user who wrote `"ask": ["Bash(git push:*)"]` could no longer push and was
 * never asked why, and a trusted automation answering `ask` on a tool our gate
 * allows was refused the same way. Both now raise the SAME card the PreToolUse
 * `prompt` branch raises and the Codex approval path uses, so the user's own
 * rule does what they wrote it to do. With the bypass gone this is also no
 * longer a callback the SDK can shadow: `permissionMode: 'bypassPermissions'`
 * is one of the two configurations that make it unreachable and emit
 * `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` (`agent-sdk/permissions.md`).
 *
 * Three things this deliberately does NOT do. It does not return
 * `updatedPermissions`: the SDK offers `suggestions` "for updating permissions
 * so that the user will not be prompted again", and taking them writes rules
 * into the user's settings files behind an "always allow" click, which is a
 * different decision from approving one call — so the card is raised with
 * `noAlwaysAllow`, and a remembered approval stays what it already is here, our
 * own session whitelist.
 *
 * **C3.7 QUALIFIES that sentence, measured rather than argued (2026-09-11,
 * vendored `0.3.247` / `2.1.247`).** "Writes rules into the user's settings
 * files" is true of the SETTINGS destinations and FALSE of `session`. On the
 * scripted three-request turn in `__tests__/fixtures/claude-permission-update-probe.ts`,
 * an `addDirectories` update returned from this callback:
 *
 *  - `destination: 'projectSettings'` wrote `permissions.additionalDirectories`
 *    into `<cwd>/.claude/settings.json` — a file a repository checks in;
 *  - `destination: 'session'` wrote NOTHING, anywhere;
 *  - and BOTH applied to the rest of the running turn, with no respawn: the
 *    later read of a path outside the working directory never reached this
 *    callback again, while a no-update control arm shows that same read DOES
 *    reach it.
 *
 * So the refusal is right PER DESTINATION rather than per field, and the reading
 * is what ledger row A62 was waiting on.
 *
 * **C3.312 — there IS a host trigger now, and this paragraph used to say there
 * was not.** The user's "always allow" answer on the claude card is it: the
 * answer carries {@link ClaudeToolApprovalAnswer.rememberForSession} and the
 * `sessionPermissionGrant` below echoes the runtime's OWN `suggestions` for that
 * call. The card offers the button only where
 * `claudeCallCanRememberForSession` says the boundary would forward something —
 * which excludes an edit card, whose suggestion the runtime spells as a
 * `setMode`. The measurement covers `addDirectories` and, through that echo, the
 * session `addRules` the runtime itself proposes; it does not cover the other
 * four kinds, and the boundary refuses those.
 *
 * **C3.281 — and ONE update kind is refused SILENTLY, which is why a future
 * forwarding path must verify rather than assume.** C3.85 drove all six kinds
 * against all five destinations on the same bundle (2026-09-11,
 * `__tests__/claude-permission-update-destinations-e2e.test.ts`): thirty runs,
 * every one `result: success`, nothing thrown. `setMode: 'bypassPermissions'`
 * was among them and wrote NOTHING at `userSettings` — where `acceptEdits`
 * writes `permissions.defaultMode` — and did not take at `session` either, shown
 * by the later outside read still reaching this callback, which
 * `bypassPermissions` would have shadowed. No error, no subtype change, no
 * diagnostic of any kind. So on this runtime a success verdict is not evidence
 * that an update applied. Harmless while nothing here returns updates; whoever
 * wires the first one reads the EFFECT back — a file that gained the rule, or a
 * call that stops arriving — rather than the answer, and never tells a user a
 * bypass grant took on the strength of the silence.
 *
 * It does not consult the permission rules a second time:
 * on this runtime the SDK is the thing enforcing them, and a rule-aware answer
 * on top of a rule-aware gate is how an allow rule ends up out-voting the ask
 * rule that forced the prompt. And it does not deny a subagent's approval the
 * way it denies a subagent's question — the user can answer "may this run",
 * they simply need to know who asked, so the agent id goes on the card.
 *
 * Returning `null` is not the third option it looks like. The SDK's own comment:
 * "Fail-closed: an accidental null means no control_response is sent and the
 * tool stays blocked indefinitely — permission prompts have no park deadline."
 *
 * `AskUserQuestion` is the kind we CAN answer, and answering it is this row's
 * subject: "Claude requests user input in two situations: when it needs
 * permission to use a tool …, and when it has clarifying questions (via the
 * `AskUserQuestion` tool). Both trigger your `canUseTool` callback"
 * (`user-input.md`). Subagents are excluded because the same page excludes them:
 * "Subagents: `AskUserQuestion` is not currently available in subagents spawned
 * via the Agent tool." The SDK withholds it there today; this guard is what
 * keeps a vendor change from putting a card on screen out of a context the user
 * has no frame for, and it is the one enforcement point we own.
 */
export function buildClaudeCanUseTool(context: {
  /** Ask this session's user; rejects when the question never reached one. */
  askUser: (request: AskUserPermissionRequest, signal?: AbortSignal) => Promise<AskUserAnswer>;
  /**
   * Put one tool call in front of this session's user and wait. Resolves false
   * when they decline; rejects when there is nobody to ask.
   */
  askPermission: (request: ClaudeToolApprovalRequest, signal?: AbortSignal) => Promise<ClaudeToolApprovalAnswer>;
  /**
   * Did OUR PreToolUse card already approve this exact `tool_use_id`?
   *
   * Without this the user answers TWICE for one call. `permissions.md` puts the
   * hook at step 1 and the ask-rule check at step 6, and says plainly that "a
   * hook that returns `allow` does not skip the deny and ask rules below" — so
   * a call we prompted for and the user approved is re-routed here and asks
   * again. Measured on the shipped default policy: `git push origin main`
   * returns `prompt` in `default`, `acceptEdits` AND `auto`.
   *
   * This is the same defect the question route already fixes with
   * `askUserQuestionPromptBelongsToCanUseTool`, and the same principle the gate
   * states one line above its own return: one Nessy approval satisfies both.
   */
  alreadyApprovedByGate: (toolUseID: string | undefined) => boolean;
  /** This session's mode, read per call — see `CAN_USE_TOOL_DONT_ASK_DENIAL`. */
  permissionMode: () => PermissionMode;
  /**
   * C3.278 — the session-scoped grant seam, and the ONE place an
   * `updatedPermissions` may be produced on this runtime.
   *
   * C3.7 measured the capability: an `addDirectories` returned from this
   * callback at `destination: 'session'` applies to the rest of the running
   * turn, with no respawn and with nothing written to any file. What was
   * missing is a host trigger, and the SDK says what the trigger is meant to
   * be, on `canUseTool`'s own options: *"Suggestions for updating permissions so
   * that the user will not be prompted again for this tool during this session.
   * Typically if presenting the user an option 'always allow' or similar, then
   * this full set of suggestions should be returned as the `updatedPermissions`
   * in the PermissionResult."*
   *
   * So the host is asked, with the runtime's own suggestions and the path the
   * runtime blocked, AFTER the user has allowed the call — never before, because
   * a grant that outlives one call needs the answer that granted it. Whatever
   * comes back passes {@link claudeSessionPermissionUpdateBoundary} before it
   * reaches the runtime, so a second producer cannot be added without the
   * boundary.
   *
   * OPTIONAL, and absent is still a complete behaviour: with no callback the
   * result carries no `updatedPermissions` at all. **C3.312 supplied the
   * producer**, and it needed no `SessionManager` line after all — the wire
   * already carried the user's `alwaysAllow` into `ClaudeAgent`'s own
   * `pendingPermissions` resolver, where it was being discarded, and the card's
   * button is gated by the `noAlwaysAllow` this fork sends. So the whole
   * producer is: `claudeCallCanRememberForSession` decides whether the button
   * appears, `askToolApproval` carries the answer back as
   * `rememberForSession`, and the call site echoes the runtime's own
   * suggestions.
   */
  sessionPermissionGrant?: (input: {
    readonly toolName: string;
    readonly answer: ClaudeToolApprovalAnswer;
    /** The runtime's own `suggestions` for this call, verbatim. */
    readonly suggestions?: readonly unknown[];
    /** The runtime's own `blockedPath` for this call, when it supplied one. */
    readonly blockedPath?: string;
  }) => readonly unknown[] | undefined;
  /**
   * C3.314 — where a REFUSED grant is said out loud, once per sentence.
   *
   * Separate from {@link debug} because `debug` is not a user surface: a
   * packaged build logs nothing outside debug mode, so the refusals C3.279
   * produces were reaching nobody. Optional, and absent is HEAD's behaviour
   * exactly — the caller in `ClaudeAgent` wires it to
   * `queueDegradationNotice`, which is the same `info`/`level: 'warning'`
   * channel the host's shared warning seam uses.
   */
  warn?: (message: string) => void;
  debug?: (message: string) => void;
}): CanUseTool {
  return async (toolName, input, options) => {
    if (toolName !== ASK_USER_QUESTION_TOOL) {
      if (context.alreadyApprovedByGate(options.toolUseID)) {
        // Our card already asked, for this exact call, and the user said yes.
        // Asking again is not extra safety — it is the same question twice, and
        // a second card the user cannot tell apart from the first.
        context.debug?.(`canUseTool allowed ${toolName}: our gate already approved ${options.toolUseID}`);
        return { behavior: 'allow' };
      }
      if (context.permissionMode() === 'dontAsk') {
        context.debug?.(`canUseTool denied ${toolName}: dontAsk never prompts`);
        return { behavior: 'deny', message: CAN_USE_TOOL_DONT_ASK_DENIAL };
      }
      const request = claudeToolApprovalRequest(toolName, input, options);
      // Same reason the question route is wrapped: an unhandled rejection out of
      // this callback sends no control_response, and the SDK's own note says a
      // missing response parks the tool with no deadline.
      try {
        const answer = await context.askPermission(request, options.signal);
        context.debug?.(`canUseTool ${answer.allowed ? 'approved' : 'declined'} ${toolName} (${request.requestId})`);
        // P6.951 · NATIVE. `PermissionResult`'s deny branch already carries the
        // reason the model is told, and until now it was always the constant.
        // The user's note REPLACES it rather than being appended to it: the page
        // says the comment IS "the reason for the denial", and a sentence
        // beginning "The user declined this tool call." followed by their own
        // words reads as boilerplate the model learns to skip.
        if (!answer.allowed) {
          return { behavior: 'deny', message: answer.comment?.trim() || CAN_USE_TOOL_DECLINED_DENIAL };
        }
        // C3.278 — the session-scoped grant, asked for only after the user has
        // allowed this call, and only when a host supplied the seam.
        const sdkOptions = options as unknown as {
          suggestions?: readonly unknown[];
          blockedPath?: string;
        };
        const grant = context.sessionPermissionGrant?.({
          toolName,
          answer,
          ...(sdkOptions.suggestions ? { suggestions: sdkOptions.suggestions } : {}),
          ...(sdkOptions.blockedPath ? { blockedPath: sdkOptions.blockedPath } : {}),
        });
        if (!grant || grant.length === 0) return { behavior: 'allow' };
        const verdict = claudeSessionPermissionUpdateBoundary(grant, {
          ...(sdkOptions.suggestions ? { offeredSuggestions: sdkOptions.suggestions } : {}),
        });
        for (const refusal of verdict.refusals) context.debug?.(`canUseTool grant refused: ${refusal}`);
        // C3.314 — and once, in one sentence, somewhere the user actually reads.
        const refusalNotice = formatClaudeSessionGrantRefusalNotice({ toolName, verdict });
        if (refusalNotice) context.warn?.(refusalNotice);
        if (verdict.allowed.length === 0) return { behavior: 'allow' };
        context.debug?.(
          `canUseTool granted ${verdict.allowed.length} session permission update(s) for ${toolName}`,
        );
        // C3.281 — a success verdict is NOT evidence that an update applied on
        // this runtime, so nothing here tells the user it did. The effect a
        // caller may rely on is the one C3.7 measured: the next such call stops
        // arriving here. C3.314 closes the other side of the same fact: what was
        // REFUSED is said out loud, on `warn` above.
        return { behavior: 'allow', updatedPermissions: verdict.allowed as never };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        context.debug?.(`canUseTool could not ask about ${toolName}: ${reason}`);
        return { behavior: 'deny', message: `${CAN_USE_TOOL_NO_SURFACE_DENIAL} (${reason})` };
      }
    }
    if (options.agentID) {
      context.debug?.(`canUseTool refused ${toolName} from subagent ${options.agentID}`);
      return {
        behavior: 'deny',
        message: 'AskUserQuestion is not available to subagents — they have no surface to ask through. '
          + 'Decide with the information you have, or report what you need to the main thread.',
      };
    }
    // The projection is inside the try with the ask: an unhandled rejection out
    // of this callback sends no control_response, and the SDK's own note says a
    // missing response parks the tool with no deadline. Every path out of here
    // must be a settled decision.
    try {
      const request = askUserRequestFromQuestionInput(input);
      const answer = await context.askUser(request, options.signal);
      return { behavior: 'allow', updatedInput: askUserQuestionAnswerEnvelope(input, answer, request) };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      context.debug?.(`canUseTool question unanswered: ${reason}`);
      return { behavior: 'deny', message: `The question was not answered: ${reason}` };
    }
  };
}

// Re-export permission mode functions for application usage
export {
  // Permission mode API
  getPermissionMode,
  setPermissionMode,
  cyclePermissionMode,
  subscribeModeChanges,
  type PermissionMode,
  PERMISSION_MODE_ORDER,
  PERMISSION_MODE_CONFIG,
} from './mode-manager.ts';
// Documentation is served via local files at ~/.nessy-agent/docs/

// Import and re-export AgentEvent from core (single source of truth)
import type { AgentEvent } from '@nessy-agent/core/types';
export type { AgentEvent };

// Stateless tool matching — pure functions for SDK message → AgentEvent conversion
import { ToolIndex } from './tool-matching.ts';

// Claude event adapter — extracts SDK message → AgentEvent conversion into testable class
import { ClaudeEventAdapter, buildWindowsSkillsDirError as buildWindowsSkillsDirErrorFn } from './backend/claude/event-adapter.ts';
import { classifyClaudeTaskProgress } from './backend/claude/task-notification.ts';
import {
  ClaudeInputChannel,
  claudeDenyListDrift, claudeFlagLayerDeny,
  claudeLiveSessionSignature, describeClaudeLiveRespawn, claudeEffortClampDrift,
  claudeLiveSettings,
  reloadClaudePlugins,
  sameMcpServerNames,
  type ClaudeLiveSettings,
  type ClaudePluginReloadOutcome,
} from './backend/claude/live-session.ts';
import { ClaudeTurnSlot } from './backend/claude/turn-slot.ts';
import { describeClaudeAutoMemory } from './memory/claude-auto-memory.ts';
import { awaitClaudeNativeCardAnswer, awaitClaudePermissionCardAnswer, CLAUDE_PERMISSION_CARD_DEADLINE_MS } from './backend/claude/permission-card-deadline.ts';
// Re-export types for UI components
export type { LoadedSource } from '../sources/types.ts';

// Import and re-export AbortReason and RecoveryMessage from core module (single source of truth)
// Re-exported for backwards compatibility with existing imports from claude-agent.ts
import { AbortReason, type RecoveryMessage } from './core/index.ts';
export { AbortReason, type RecoveryMessage };

/** File extensions that can be converted to readable text by CLI tools. */
const CONVERTIBLE_FILE_HINTS: Record<string, string> = {
  pdf: 'markitdown or pdf-tool extract',
  docx: 'markitdown', xlsx: 'markitdown or xlsx-tool read', pptx: 'markitdown or pptx-tool extract',
  doc: 'markitdown', xls: 'markitdown', ppt: 'markitdown',
  msg: 'markitdown', eml: 'markitdown', rtf: 'markitdown',
  ics: 'ical-tool read',
};

/**
 * P3.268 — the runtime's own capability self-report, consulted BEFORE the string
 * match, with the string match kept as the answer for the case the self-report
 * cannot cover.
 *
 * `ModelInfo.supportsAdaptiveThinking` / `supportsEffort` / `supportedEffortLevels`
 * are published on the `initialize` response of every claude session
 * (`claude-model-capabilities.ts` records them). Two things follow, and the
 * second is the reason the string match STAYS rather than being deleted:
 *
 *  - When the runtime has spoken about this model, it decides. The host stops
 *    guessing at `!model.includes('haiku')`, and an effort level the model does
 *    not accept is clamped HERE instead of being silently downgraded inside the
 *    Anthropic SDK (`thinking-levels.ts`: *"On models that don't accept `xhigh`,
 *    the Anthropic SDK silently falls back to `high`"*).
 *  - When it has not — the first turn before `initialize` lands, and every
 *    gateway or BYO model the CLI does not list at all — the string match is the
 *    only answer there is. Deleting it would leave the fork's own default
 *    upstream with no thinking policy.
 *
 * `onDiagnostic` is how a reader tells the two apart; a capability decision with
 * no visible source is the shape of a defect (AGENTS.md, transparent-and-simple).
 */

/**
 * UB7.14 — the haiku ids the BUDGET form still belongs to, for the first-turn
 * heuristic only: pre-5.5 Haiku (4.5 and earlier) reject adaptive thinking, and
 * `claude-haiku-5-5` and any later major accept it (`thinking.md`, curled
 * 2026-10-14 by B2 — "adaptive" with `thinking: {type: "disabled"}` accepted at
 * effort `high` or below). A bare `haiku` alias has no major to read and stays
 * budget-only until the runtime's `supportedModels` row answers for it — the
 * same unknown-means-old conservatism the heuristic always had, now scoped to
 * the ids that actually are.
 */
export function isBudgetOnlyHaikuModel(model: string): boolean {
  if (!model.toLowerCase().includes('haiku')) return false;
  // Unanchored, like the id shapes `preferredModelRank` matches: the Bedrock
  // inference-profile and provider-prefixed forms (`us.anthropic.claude-haiku-5-5`)
  // carry the same major after their prefixes.
  const match = /claude-haiku-(\d+)/.exec(model.toLowerCase());
  return match === null || Number(match[1]) < 5;
}

export function resolveClaudeThinkingOptions(args: {
  thinkingLevel: ThinkingLevel;
  model: string;
  providerType?: BackendConfig['providerType'];
  minimizeThinking: boolean;
  /** Injected in tests; production reads the process-scoped record. */
  capabilities?: ClaudeModelCapabilityRow;
  onDiagnostic?: (message: string) => void;
  /**
   * P3.267 — the STRICT SUBSET of `onDiagnostic` that changed what the user
   * asked for, split out so the caller needs no prose matcher.
   *
   * Exactly one of the two messages qualifies. A CLAMP lowers the effort the
   * user selected, and the same selection would land differently on Pi or
   * codex — a switch-visible fact. The authority line ("the runtime says
   * supportsAdaptiveThinking=…, the heuristic said … — the runtime wins")
   * attributes a SOURCE: both branches produce the same user-visible
   * behaviour, so putting it on a transcript would be noise.
   *
   * When supplied it OWNS that line — `onDiagnostic` does not also receive it,
   * because the caller's handler logs it (see `noteSwitchVisibleDegradation`)
   * and one sentence twice in one log teaches a reader to skim. When it is
   * absent nothing changes: `onDiagnostic` still gets every line, which is what
   * the resolver's own tests read.
   */
  onDegradation?: (message: string) => void;
}): Partial<Options> {
  const { thinkingLevel, model, minimizeThinking, onDiagnostic, onDegradation } = args;
  const isClaude = isClaudeModel(model);
  // UB7.14 — Haiku 5.5 (and later Haiku) are ADAPTIVE-capable: the thinking
  // page (curled 2026-10-14 by B2) gives `claude-haiku-5-5` adaptive thinking
  // and "`thinking: {type: "disabled"}` at effort `high` or below", while the
  // budget form this branch used to send for every haiku id is a documented
  // 400 there. Only the pre-5.5 Haiku ids — and an unknown bare `haiku` alias,
  // conservatively, until the runtime's own capability list corrects the
  // heuristic on a later turn — stay on `maxThinkingTokens`.
  const isHaiku = isBudgetOnlyHaikuModel(model);
  const reported = args.capabilities ?? lookupClaudeModelCapabilities(model);

  let effort = THINKING_TO_EFFORT[thinkingLevel];
  if (effort) {
    const clamped = clampClaudeEffortLevel(effort, reported, THINKING_LEVEL_IDS.filter(id => id !== 'off'));
    if (clamped !== effort) {
      const line = `[thinking] ${model} reports effort levels ${JSON.stringify(reported?.supportedEffortLevels ?? null)}`
        + ` (supportsEffort=${String(reported?.supportsEffort)}); requested ${effort} → ${clamped ?? 'none'}`;
      // `onDegradation` OWNS this line when supplied — it logs it too, and two
      // copies of one sentence in one log is how a reader learns to skim.
      (onDegradation ?? onDiagnostic)?.(line);
      effort = clamped as typeof effort;
    }
  }

  // The runtime's answer when it gave one, ours when it did not. `undefined` is
  // "not told", which is why this is an explicit `=== undefined` test and not a
  // `??` over a boolean that may legitimately be `false`.
  const supportsAdaptiveThinking = reported?.supportsAdaptiveThinking === undefined
    ? isClaude && !isHaiku
    : reported.supportsAdaptiveThinking;
  if (reported?.supportsAdaptiveThinking !== undefined
      && reported.supportsAdaptiveThinking !== (isClaude && !isHaiku)) {
    onDiagnostic?.(
      `[thinking] ${model}: the runtime says supportsAdaptiveThinking=${String(reported.supportsAdaptiveThinking)}`
      + `, the id heuristic said ${String(isClaude && !isHaiku)} — the runtime wins`,
    );
  }
  // Always-on models (Fable, Mythos, Opus 5.5, Sonnet 5.5 — models.ts) have adaptive
  // thinking ALWAYS ON and reject `thinking: { type: 'disabled' }`. No way to turn it off;
  // the lowest we can go is adaptive + 'low' effort.
  const adaptiveAlwaysOn = isAdaptiveThinkingAlwaysOnModel(model);

  if (minimizeThinking || !isClaude || !effort) {
    if (adaptiveAlwaysOn) {
      return { thinking: { type: 'adaptive' as const }, effort: 'low' as const };
    }
    // P3.375 — `maxThinkingTokens` is `@deprecated` in the shipped 0.3.233
    // `sdk.d.ts` ("Use `thinking` instead"), and the SDK is the contract, so the
    // SDK side governs. It is still emitted HERE and at the one site below, and
    // only on the branch where `supportsAdaptiveThinking` is false — models the
    // replacement's own text is about ("`{ type: 'enabled', budgetTokens: N }`
    // — Fixed thinking token budget (older models)"). The migration is
    // `{ maxThinkingTokens: 0 }` → `{ thinking: { type: 'disabled' } }` and
    // `{ maxThinkingTokens: N }` → `{ thinking: { type: 'enabled',
    // budgetTokens: N } }`, both spelled by the same page. It is NOT done here:
    // it changes what a live claude turn sends on the non-adaptive branch, and
    // this close-out has no live arm for that branch. Recorded with the
    // replacement named so the next lane does not have to re-derive it.
    return supportsAdaptiveThinking
      ? { thinking: { type: 'disabled' as const } }
      : { maxThinkingTokens: 0 };
  }

  if (supportsAdaptiveThinking) {
    return {
      thinking: { type: 'adaptive' as const },
      effort,
    };
  }

  return {
    maxThinkingTokens: getThinkingTokens(thinkingLevel, model),
  };
}

/**
 * The turn-shape SDK options Nessy passes explicitly on a Claude query.
 *
 * Extracted from `chatImpl`'s inline options object so the three shapes are
 * testable without spawning a query. Two of them are corrected from the docs by
 * the SDK typings spike (`docs/superpowers/specs/2026-07-25-claude-sdk-typings-spike.md`):
 * `excludeDynamicSections` nests **inside** `systemPrompt` as a sibling of
 * `type`/`preset`/`append`, and `maxTurns` is only ever a child restriction here.
 */
/**
 * P6.528 — the MCP servers the CLI connected that our configuration did not
 * supply, said out loud.
 *
 * ## The divergence, in our own code's words
 *
 * `strictMcpConfig` is the vendor's own knob and we deliberately leave it unset.
 * `sdk.d.ts` states what it would do, verbatim: *"Only use MCP servers passed
 * via the `mcpServers` option (and servers declared by explicitly-passed agent
 * definitions in `agents`), ignoring all other MCP configurations: project
 * `.mcp.json`, user settings, plugins, and on-disk agent frontmatter — including
 * subagent frontmatter MCP."* Unset, the CLI runs all of that discovery beside
 * the servers we hand it, and until this function nothing in the product could
 * name one of the results.
 *
 * ## Why REPORT and not `strictMcpConfig: true` — Q-den 65 = option 2
 *
 * Option 1 (turn strict mode on) was refused for now because a user's own
 * `.mcp.json` or `~/.claude.json` servers would stop working on ONE runtime
 * only, and the `onElicitation` wiring built precisely for CLI-discovered
 * servers would become dead code. Option 3 (correct the architecture page and
 * nothing else) leaves the divergence silent to everyone who does not read that
 * page. And option 2 is option 1's PRECONDITION: you cannot cost strict mode
 * until you can see what the CLI is connecting to.
 *
 * ## What is compared, and what is deliberately not
 *
 * Names only, against the keys of the `mcpServers` option we passed on this
 * spawn. Every entry we supply is a `createSdkMcpServer` in-process proxy keyed
 * by its own slug, so the name IS the identity on our side. A server the CLI
 * found carries a `status` the SDK does not enumerate in its typing, so it is
 * echoed verbatim rather than classified — a paraphrase of someone else's state
 * word is a chance to be wrong about their behaviour.
 */
export function claudeCliDiscoveredMcpNotice(
  reported: unknown,
  configured: ReadonlySet<string>,
): string[] {
  if (!Array.isArray(reported)) return [];
  const extra: string[] = [];
  for (const entry of reported) {
    if (!entry || typeof entry !== 'object') continue;
    const name = (entry as { name?: unknown }).name;
    if (typeof name !== 'string' || name.length === 0) continue;
    if (configured.has(name)) continue;
    const status = (entry as { status?: unknown }).status;
    extra.push(typeof status === 'string' && status.length > 0 ? `${name} (${status})` : name);
  }
  if (extra.length === 0) return [];
  return [
    `claude-cli-discovered-mcp: the Claude runtime connected ${extra.length} MCP `
    + `${extra.length === 1 ? 'server' : 'servers'} this session did not configure — `
    + `${extra.join(', ')}. They come from the CLI's own discovery (a project \`.mcp.json\`, `
    + 'user settings, a plugin, or agent frontmatter), which stays enabled on this runtime and has '
    + 'no counterpart on Pi or codex. Their tools are real and their permission prompts are real; '
    + 'the host did not supply them.',
  ];
}

export function buildClaudeTurnShapeOptions(input: {
  /**
   * Mini agents run on a lean plain-string prompt. `excludeDynamicSections` is
   * documented as a no-op for a string prompt, so it is simply absent there.
   */
  miniSystemPrompt?: string;
  /** `append` text for the `claude_code` preset (regular agents). */
  presetAppend?: string;
  /**
   * Child/subagent turn restriction, when one reaches this backend. A main
   * session has no turn cap anywhere in this repo, and inventing a default here
   * would silently truncate long turns users rely on. Claude subagents currently
   * run inside the SDK, so no caller supplies this yet.
   */
  childMaxTurns?: number;
  /**
   * P6.439 clause (1) used to enter HERE, and P6.1009 moved it — this builder
   * is not the seam that owns `Options.settings`.
   *
   * It returned `{ settings: <the flag's value> }`, which was spread into the
   * options literal ~200 lines above `...claudeFlagSettingsOptions`; `settings`
   * is ONE key, the later spread wins, and the composed value is ALWAYS present
   * because its `worktree` contributor is unconditional. So the operator's
   * `--settings` was overwritten on every single spawn, the clause was inert,
   * and these very tests could not see it: they asserted this builder's return.
   *
   * The flag is now the LAST contributor to {@link composeClaudeSpawnSettings},
   * which is the one writer of that key. Read it there — the tier, its
   * precedence against the host's floor, and what a PATH value does are all one
   * decision and belong in one place.
   */
  /**
   * P6.930 clause (2) — the operator's NARROWED filesystem settings sources.
   *
   * NATIVE-FIRST, tier 1 again: `settingSources` is the SDK's own option and
   * the shipped binary's own `--setting-sources` flag; the host chooses the list
   * and the child applies it. Absent when the flag is unset and the project is
   * trusted, which keeps the documented triple below byte-identical; F1.768's
   * `projectTrustSettingSources` hands any other project at most `['user']`.
   *
   * What a narrowing costs is NAMED rather than discovered later — see
   * {@link import('../config/claude-flag-settings.ts').claudeSettingSourcesNarrowingNotice}
   * and the two riders spelled out on the option itself below.
   */
  settingSources?: readonly import('../config/claude-flag-settings.ts').ClaudeSettingSource[];
  /**
   * P6.276 — the OPERATOR's turn ceiling, which is a different thing from the
   * child restriction above and is why that comment's "no turn cap anywhere in
   * this repo" is no longer true.
   *
   * The recorded non-use (`runtime-control-boundary.md:134`, "Not used, by
   * choice") was about not INVENTING a default. `workspaceDefaults.maxAgentTurns`
   * is not a default we invented: it is a number a person typed, and until this
   * row it bound Pi alone — `PiAgent.getMaxAgentTurns` counted `turn_start` and
   * force-aborted, while the identical setting reached this backend as nothing.
   * Zero still means no cap and still passes no option, so an install that has
   * not set it is byte-identical to what it was.
   *
   * NATIVE-FIRST, tier 1: the SDK owns the ceiling. `Options.maxTurns` is spent
   * as `--max-turns` and the CLI ends the query with `error_max_turns`, which
   * `backend/claude/event-adapter.ts` already maps to `max_agent_turns` — the
   * same terminal reason Pi's force-abort produces, with the renderer copy
   * already written. Nothing downstream of this line changes.
   *
   * ## The unit, which the row required to be stated
   *
   * Pi counts MODEL turns (`turn_start`, i.e. API round-trips) and resets the
   * counter at every user message. The SDK spells its unit twice and the two
   * spellings do not agree: `env-vars.md#variables` says `CLAUDE_CODE_MAX_TURNS`
   * caps "the number of agentic turns … Equivalent to passing `--max-turns`",
   * and `AgentDefinition.maxTurns` in the vendored `sdk.d.ts` says "Maximum
   * number of agentic turns (API round-trips) before stopping" — both Pi's unit
   * — while `Options.maxTurns` on the same file says "Maximum number of
   * conversation turns before the query stops. A turn consists of a user message
   * and assistant response."
   *
   * WHERE THE COUNTER RESETS ON A STREAMING SESSION IS NOT DOCUMENTED, and it
   * is not derivable from the bundle: this fork keeps ONE live query across many
   * user messages (see {@link claudeLiveSessionSignature}), so if the CLI counts
   * for the life of the query rather than per user message, a claude cap of N is
   * a session ceiling where Pi's is a per-message one. Searched: both `maxTurns`
   * typings, `env-vars.md#variables`, `cli-reference.md`, and the vendored
   * binary (the comparison site is not legible in the minified bundle). Recorded
   * as a null rather than guessed — the residual belongs in the switch report.
   */
  sessionMaxTurns?: number;
}): Pick<Options, 'systemPrompt' | 'settingSources' | 'maxTurns'> {
  // The smaller of the two ceilings wins when both are set: a child restriction
  // must not raise an operator's ceiling, and an operator's ceiling must not
  // lift a caller's child restriction.
  const caps = [input.childMaxTurns, input.sessionMaxTurns]
    .filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0);
  return {
    systemPrompt: input.miniSystemPrompt !== undefined
      ? input.miniSystemPrompt
      : {
          type: 'preset' as const,
          preset: 'claude_code' as const,
          ...(input.presetAppend === undefined ? {} : { append: input.presetAppend }),
          // Keeps the SDK's working-directory / memory / git-status sections out of
          // the system prompt so it stays static and cacheable; the SDK re-injects
          // them as the first user message. Matches Nessy's Claude strategy of
          // holding per-turn context on the user-message tail (see
          // packages/shared/AGENTS.md § per-message context).
          excludeDynamicSections: true,
          // UB2.13 (v0.15.1:packages/shared/src/agent/claude-agent.ts, the same
          // pin) — record the rendered prompt once per SDK session and re-send it
          // verbatim on every later request and on `resume`. The vendored
          // `sdk.d.ts` documents omitted as the same default ("Omitted or
          // `snapshot: true` (the default)") and UB5.1 measured recording ACTIVE
          // on 0.3.280, so this changes nothing today; it keeps the prompt prefix
          // (and, with extended thinking, the model's earlier reasoning) from
          // moving if a later SDK flips that default. The mini branch's plain
          // string follows the same default and carries no key.
          //
          // The consequence, stated rather than discovered: a different `append`
          // on a later spawn of the same SDK session is ignored until compaction
          // or a new session. UB5.1 read ONE append input a user changes
          // mid-session by design, the output-style prose (`turnOutputStyleId`,
          // re-read each turn), so the recorded prompt keeps the session-start
          // style's prose (or none, after Default) until compaction, and the
          // respawn the changed append forces (`claudeLiveSessionSignature`
          // hashes `systemPrompt`) does not refresh it. UB2.13 decided to keep
          // that shape (the style in the append is where Claude Code itself
          // places it). UB12.21 added the switch-time delivery Claude Code
          // documents (prompt-caching.md#changing-output-style: "delivers the new
          // style's instructions as a message in the conversation"): see
          // `planOutputStyleSwitch` in `chatImpl` and `core/output-style-switch.ts`.
          // The respawn stays, because it puts the new append in place for the
          // next compaction's render (see the `systemPrompt` line of
          // `claudeLiveSessionSignature`).
          snapshot: true,
        },
    // Omitting this loads all three sources (CLI defaults); spelling out the same
    // three (reached for a TRUSTED project only — F1.768's caller hands any other
    // `['user']`) keeps CLAUDE.md discovery, which needs 'project', visible.
    //
    // TWO THINGS NOW RIDE ON `project` BEING IN THIS LIST, so narrowing it is no
    // longer only a settings decision:
    //  - P6.34's `--add-dir` roots. `permissions.md` §"Additional directories
    //    grant file access, not configuration": *"Skills, commands, and subagents
    //    from any flag-added directory load through the `project` setting source
    //    … so they don't load when you exclude that source with
    //    `--setting-sources` on the CLI or `settingSources` in the SDK."*
    //  - The user's own `.claude/settings.json` allow/ask/deny rules, which R3
    //    below stopped pre-empting precisely so the SDK could apply them.
    //
    // P6.3 — THE COLLISION THAT DOES NOT EXIST YET, AND THE VERSION THAT SAYS SO.
    // `cli-reference.md` §CLI flags documents `--restricted`, which "loads only
    // managed settings and `--settings`" and so ignores all three of the sources
    // above — silently disabling both bullets. It cannot reach us today: the same
    // row ends *"Requires Claude Code v2.1.248 or later"*, the vendored native
    // binary reports `2.1.247 (Claude Code)` (re-read 2026-09-12 after the
    // P7.1 lift, from `claude --version` and from the SDK manifest's
    // `claudeCodeVersion`, which agree; this line has twice carried a pre-lift
    // number and the ONE version still separating us from the flag leaves the
    // conclusion untouched — the margin is now a single patch, which is the
    // reason `claude-bundle-version-triggers.test.ts` exists rather than a
    // sentence), and `errors.md`
    // §"Cloud sessions cannot be created from a --restricted session" is explicit
    // about what an older binary does with it — *"Before v2.1.248, Claude Code had
    // no `--restricted` flag; earlier versions reject the flag itself with an
    // unknown-option error."* Measured, not inferred: `--restricted` occurs zero
    // times in the shipped binary and in its 230-line `--help`, while `--add-dir`,
    // `--bare` and `--setting-sources` all appear (the positive controls);
    // re-measured 2026-09-12 at the vendored 2.1.247 (C3.252), `--restricted`
    // still 0 lines / 0 occurrences. Nothing
    // in this fork can smuggle it in either — **and the reason is narrower than
    // this comment used to claim.** It said the SDK's `extraArgs` escape hatch
    // "has no caller in `packages/` or `apps/`", which stopped being true when
    // P6.314 gave it exactly one: `buildClaudeSubagentPromptAppendArg` below
    // assigns `{ 'append-subagent-system-prompt': … }` and nothing else. So what
    // is unreachable is `restricted`, in any spelling `extraArgs` could carry,
    // and that is what `claude-restricted-mode-collision.test.ts` asserts — a
    // blanket "no caller" tripwire would now be red for a reason unrelated to
    // this row.
    // So the row's premise is corrected rather than fixed, and the decision is
    // deferred to the bump that makes it real: `claude-restricted-mode-collision.test.ts`
    // fails the day the vendored bundle grows the flag.
    //
    // ────────────────────────────────────────────────────────────────────────
    // P2.453 — THE OTHER `extraArgs` QUESTION, ANSWERED HERE BECAUSE THIS IS
    // WHERE A READER SEARCHING `extraArgs` LANDS.
    //
    // P6.20 refused to wire the binary's own `-w, --worktree [name]` through
    // `extraArgs`, and recorded the reason: *a worktree the binary creates for
    // itself has a path the host never learns — no lease, no working-directory
    // record, no cwd anchor, no retention sweep — which is P2.427's leak
    // reintroduced on the runtime where it was worst.*
    //
    // **THAT PREMISE IS REFUTED. The refusal is overturned, and this comment is
    // the record so it is not re-litigated in either direction.**
    //
    // The host does not merely LEARN the path — it can CHOOSE it. `hooks.md`
    // §WorktreeCreate: *"Runs when a worktree is being created, whether from
    // `claude --worktree`, from a subagent using `isolation: \"worktree\"`, or
    // for a background session that Claude Code isolates in its own worktree. By
    // default Claude Code creates the isolated working copy with `git worktree`.
    // Configuring a WorktreeCreate hook replaces that default git behavior"* —
    // and *"The hook must return the path to the created worktree directory.
    // Claude Code uses this path as the working directory for the isolated
    // session."* The teardown half is the same shape: `hooks.md`
    // §WorktreeRemove, *"Claude Code passes the path returned by WorktreeCreate
    // as `worktree_path` in the hook input."*
    //
    // Measured against the bundle rather than taken from the page. `sdk.d.ts`
    // (0.3.223) declares `WorktreeCreate` and `WorktreeRemove` in `HOOK_EVENTS`,
    // `WorktreeCreateHookSpecificOutput = { hookEventName, worktreePath: string }`
    // and `WorktreeRemoveHookInput` carrying `worktree_path: string`. The native
    // binary agrees: `WorktreeCreate` 44, `worktreePath` 73, `WorktreeRemove` 27,
    // `worktree_path` 5, against `PreToolUse` 87 as the positive control and a
    // nonsense string at 0 on the same rig.
    //
    // ONE THING THE BUNDLE CARRIES AND THE PAGE DOES NOT, which matters because
    // it is the route an SDK consumer would use: §WorktreeCreate output lists
    // only command and HTTP hooks, while the binary's own failure string names
    // three — *"WorktreeCreate hook failed: hook succeeded but returned no
    // worktree path (command: echo the path to stdout; http/callback: return
    // hookSpecificOutput.worktreePath)"*. Per AGENTS.md, the bundle is the
    // denominator for what the runtime CAN do, so the callback route is real and
    // doc-silent — measure it live before building on it, rather than reading the
    // page and concluding it is impossible.
    //
    // SO THE NATIVE ROUTE IS THE BETTER ONE, and the host port becomes the
    // hook's implementation rather than its rival: the host creates the worktree,
    // so the lease, the working-directory record, the cwd anchor and the
    // retention sweep are all minted by the same code that already mints them.
    // Two containment facts ride with it, both from the page and both true of the
    // vendored 2.1.223: Claude Code *"refuses an absolute path that contains `.`
    // or `..` segments, and any path that passes through a symlink below the
    // repository root"*, and *"Before v2.1.216, worktree creation followed the
    // hook's path without this screening."*
    //
    // AND THE FINDING THAT INVERTS THE ROW'S URGENCY. The hook fires for routes
    // the host does not drive — a subagent with `isolation: "worktree"` and a
    // background session Claude Code isolates on its own, whose `bgIsolation`
    // default is `'worktree'` in this same `sdk.d.ts`. This session registers no
    // `WorktreeCreate` hook (zero occurrences in this file; `PreToolUse` is the
    // only internal one). **So wiring it is not merely a feature — it is the one
    // thing that would close the very leak P6.20 refused to reopen, on paths that
    // are already live.**
    //
    // WIRED SINCE P2.458, and not through `extraArgs`. The decision row left the
    // verdict plus a pin (`claude-worktree-path-surface.test.ts`, which fails the
    // day the vendored bundle stops surfacing the path); the hooks themselves
    // live in `backend/claude/worktree-hooks.ts` and are registered on the
    // `hooks` option below, behind `config.claudeWorktreePort`. The flag stays
    // unwired because the hook makes it unnecessary: the host chooses the path
    // whether the worktree was asked for by a flag, by a subagent's
    // `isolation: "worktree"`, or by a background session — and the flag would
    // only cover the first.
    // ────────────────────────────────────────────────────────────────────────
    //
    // P6.930 clause (2) — the list is the operator's when `--setting-sources`
    // narrowed it or F1.768's trust gate cut it, the triple otherwise. An EMPTY list is a
    // documented value and survives the `??` on purpose: only an unset flag
    // falls back. What the narrowing dropped is said once by the CLI and
    // repeated into `debug()` here, because a narrowing that shows up three
    // turns later as a missing skill reads as a defect.
    settingSources: input.settingSources === undefined
      ? ['user', 'project', 'local']
      : [...input.settingSources],
    // P6.1009 — no `settings` key here. See the input type's own note: this
    // builder returned one, the composed value overwrote it in the literal, and
    // `composeClaudeSpawnSettings` is the single writer of that option.
    ...(caps.length === 0 ? {} : { maxTurns: Math.floor(Math.min(...caps)) }),
  };
}

/**
 * P6.34 — the configured additional roots reach the subprocess as `--add-dir`.
 *
 * NATIVE-FIRST, and the mechanism was already there. `permissions.md`
 * §"Additional directories grant file access, not configuration" is explicit
 * that the SDK option is the flag: *"The SDK passes each entry to Claude Code as
 * `--add-dir`, so those directories behave like flag-added directories."*
 * Measured on the shipped bundle rather than taken from the page —
 * `sdk.mjs` ends its argv builder with `for(let W of e)B.push("--add-dir",W)`,
 * and `claude --help` on the vendored native binary lists
 * `--add-dir <directories...>`.
 *
 * WHY THIS IS NOT MERELY A WIDER GATE. Until this row the configured list was
 * read by `runPreToolUseChecks` and by nothing else, so the runtime could touch
 * an added root but never LOAD from it. The same page's table is the contract
 * the omission broke: skills in `.claude/skills/` load "Yes, with live reload",
 * command files and subagents "Yes, without live reload" — but only for a
 * directory added through the FLAG. The page draws that line itself: *"Directories
 * listed in `permissions.additionalDirectories` in a settings file grant file
 * access only and don't load any of the configuration below."* So mirroring our
 * setting into `permissions.additionalDirectories` would have widened the gate a
 * second time and still loaded nothing; the option is the only spelling that
 * carries the configuration.
 *
 * THE ONE COLLISION CHECKED AND CLEAR. The same section: *"Skills, commands, and
 * subagents from any flag-added directory load through the `project` setting
 * source … so they don't load when you exclude that source with
 * `--setting-sources` on the CLI or `settingSources` in the SDK."*
 * `buildClaudeTurnShapeOptions` above passes `project` for a TRUSTED project, so the
 * exceptions arrive there; an untrusted one gets `['user']` (F1.768, said by its
 * `claude-project-trust` fact). Narrowing the list otherwise silently turns this row off.
 *
 * CLAUDE.md from an added root deliberately does NOT follow: the table gates it
 * behind `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`, and this fork already
 * spells that opt-in `NESSY_ADDITIONAL_DIRECTORIES_MEMORY`
 * (`capabilities/native-sources.ts`) for the Pi side. Leaving the env alone keeps
 * one answer to that question instead of two.
 *
 * Absent option when nothing is configured, so an install without the setting
 * spawns byte-identically to before. The roots are already absolute,
 * existence-checked and symlink-canonicalized by
 * {@link getConfiguredAdditionalDirectories}; order is preserved rather than
 * sorted, because two added roots defining the same command name are resolved by
 * order and a reorder is a real change (see {@link claudeLiveSessionSignature},
 * which hashes this option unsorted for the same reason).
 *
 * Session-scoped grants are NOT folded in HERE, and after C3.312 that is a
 * statement about this OPTION rather than about the runtime.
 * `getSessionAdditionalDirectories` is still declared on `PiAgent` alone — the
 * `PermissionRequest`-hook `addDirectories` path is Pi's — so the spawn-time
 * list this function builds is the configured list and nothing else. A claude
 * session can now gain a grant mid-turn all the same: the user's "always allow"
 * answer echoes the runtime's own `suggestions` through
 * {@link claudeSessionPermissionUpdateBoundary}, and the runtime applies them to
 * the running turn without any option of ours changing (C3.7's measurement).
 * Nothing is folded in because nothing needs to be — which is why this option is
 * byte-identical to what it was.
 */
export function buildClaudeAdditionalDirectoriesOptions(
  roots: readonly string[],
): Pick<Options, 'additionalDirectories'> | Record<string, never> {
  return roots.length === 0 ? {} : { additionalDirectories: [...roots] };
}

/**
 * Tell the SDK subprocess the window of a model it has never heard of.
 *
 * The SDK owns two numbers we cannot reach from here: the context figure it
 * displays, and the point at which it auto-compacts. Both derive from ONE
 * resolution, so one env fixes both — there is no separate threshold knob to
 * set, and inventing one in the renderer would only disagree with the SDK.
 *
 * The gate below is the SDK's own, read verbatim from the binary
 * (`claude-agent-sdk-darwin-arm64/claude`, fn `Jju`; re-measured on the vendored
 * 2.1.233 on 2026-09-03 by S0-3 — the shape is unchanged for the third bump
 * running, and every symbol renamed for the third bump running:
 * 2.1.218 → 2.1.223 → 2.1.233 is `NKc`→`j7p`→`Jju`, `MKc`→`q7p`→`Yju`,
 * `JZn`→`Yzo`→`_Mo`, `XQt`→`Ofr`→`dCr`, and the env module `te`→`V`):
 *
 *     let n = V.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
 *     if (n !== void 0 && n > 0 && !zo(cs(e)).startsWith("claude-")) return n;
 *     return dCr
 *
 * `dCr` is still exactly 200 000, asserted against
 * {@link CLAUDE_UNKNOWN_MODEL_ASSUMED_WINDOW} in
 * `claude-auto-compact-window-env.test.ts` by capturing the symbol out of the
 * anchor rather than writing it down — which is why that assertion survived a
 * bump that renamed the symbol.
 *
 * So the env is ALREADY inert for any id beginning `claude-`, and matching that
 * condition here keeps our behaviour identical to the binary's rather than
 * merely compatible with it. Two nuances worth knowing before changing this:
 *
 * - Three earlier returns in `Jju` short-circuit to 1 000 000 (the `[1m]` id,
 *   the beta header and the natively-1M model), and a remote per-model override
 *   (`_Mo`) is consulted BEFORE the env. None of them can fire for a gateway id.
 * - Under `DISABLE_COMPACT` a DIFFERENT function (`Yju`) reads the same env
 *   with no model gate at all and wins outright, so the value must be right
 *   even where the gate would have rejected it.
 *
 * One env per subprocess, resolved at spawn: a mid-session model switch leaves
 * this stale until the next spawn. Accepted — the alternative is restarting the
 * subprocess on every model change, which costs far more than a display that
 * lags one switch.
 */
export function buildClaudeMaxContextTokensEnv(
  connection: ClaudeSpawnWindowConnection,
  spawnModelId: string | undefined,
): { CLAUDE_CODE_MAX_CONTEXT_TOKENS: string } | Record<string, never> {
  const window = resolveSpawnModelContextWindow(connection, spawnModelId);
  if (window === undefined) return {};
  return { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(window) };
}

/**
 * P3.44 — the second half of `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, for the one id
 * shape where the first half does nothing on its own.
 *
 * `model-config.md#correct-the-window-for-a-gateway-or-custom-model-id` splits
 * the variable's behaviour into three cases by id shape, and the middle one is
 * the trap, verbatim:
 *
 * > If the ID doesn't start with `claude-` but contains `[1m]`, in any casing,
 * > and Claude Code can't resolve it to a Claude model, Claude Code assumes a 1M
 * > window for it and the variable doesn't apply on its own. To correct the
 * > window while keeping proactive compaction, also set
 * > `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`.
 *
 * So for such an id we would declare 262 000, the binary would assume
 * 1 000 000, and the session would run four times past its real window before
 * anything compacted — the exact failure `buildClaudeAutoCompactWindowEnv`
 * exists to prevent, arriving through the door that function does not watch.
 *
 * **Latent, and pinned anyway.** No gateway alias contains `[1m]` today, and our
 * own `[1m]` suffix is appended per QUERY (`claudeModelWithWindowSelector`, F1.1241) rather than at
 * spawn, so the spawn id never carries it from our side. The row is written for
 * the day the gateway ships an alias that does: a latent hole with a one-line
 * documented fix is cheaper to close now than to diagnose later, and the
 * diagnosis would look like "the model got worse", not like a bug.
 *
 * **Verified against the shipped bundle, not only the page** (2026-08-29,
 * `claude-agent-sdk-darwin-arm64/claude`): `CLAUDE_CODE_DISABLE_1M_CONTEXT`
 * occurs 5 times, against 0 for a fabricated control name, and the binary
 * carries the page's own follow-on warning — "CLAUDE_CODE_DISABLE_1M_CONTEXT is
 * set, but the …K limit isn't enforced for …, so this session can grow past it.
 * To enforce it, set CLAUDE_CODE_AUTO_COMPACT_WINDOW=…". That remedy is already
 * satisfied here: the same env block emits `CLAUDE_CODE_AUTO_COMPACT_WINDOW`
 * from the same resolution, so the configuration this function creates is the
 * one the binary asks for rather than the one it complains about.
 *
 * **Narrow on purpose, in three ways.** The variable also removes 1M variants
 * from the model picker and holds a native-1M model to 200K, so a blanket
 * emission would delete a capability the model has (F1.1241: each model's
 * own window decides):
 *
 * - `claude-`-prefixed ids are excluded, because the page's third case says the
 *   binary resolves `claude-opus-4-8[1m]` to Opus 4.8 "even with
 *   `CLAUDE_CODE_DISABLE_1M_CONTEXT` set" — nothing to correct, capability to
 *   lose.
 * - An id we have NO window for gets nothing. The variable's documented job here
 *   is "correct the window", and with no declared window there is no correction
 *   to make; emitting it would be a bare capability removal.
 * - Matching is case-insensitive on both halves, as the page specifies ("in any
 *   casing"). {@link resolveClaudeSpawnContextWindow}'s own `claude-` test is
 *   case-SENSITIVE; that difference is deliberate and safe in this direction —
 *   an id spelled `CLAUDE-…` is treated as a gateway id there (so it gets a
 *   declared window) and is excluded here (so its 1M stays), which is the pair
 *   that loses nothing.
 */
export function buildClaude1MContextCorrectionEnv(
  connection: ClaudeSpawnWindowConnection,
  spawnModelId: string | undefined,
): { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' } | Record<string, never> {
  if (!spawnModelId) return {};
  const id = spawnModelId.toLowerCase();
  if (id.startsWith('claude-') || !id.includes('[1m]')) return {};
  if (resolveSpawnModelContextWindow(connection, spawnModelId) === undefined) return {};
  return { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' };
}

/**
 * F1.1241 — the window a `claude-` model runs with is the MODEL's own, never a
 * setting's. This replaces P6.152's Extended-context hold (and the `use1M` gate
 * in `chatImpl`): the Settings switch is gone, `enable1MContext` is a tolerated
 * legacy key that nothing reads (`stored-config-load.ts`), and the host no
 * longer emits `CLAUDE_CODE_DISABLE_1M_CONTEXT` for a `claude-` id.
 *
 * ## Why the switch could go (native-first, asked and answered)
 *
 * Both of its upstream reasons are gone under today's docs. Platform
 * `context-windows.md`: "For every model with a 1M-token context window, 1M is
 * the default: you don't need a beta header, and long-context requests are
 * billed at standard pricing." Claude Code's own rule, model-config.md, gateway
 * section: it "gives each model it recognizes the same context window the model
 * has on the Anthropic API". So the runtime already sizes the window per model;
 * the host only has to stop overriding it and to say the number it knows.
 *
 * ## The known window, and the three projections that read it
 *
 * {@link resolveClaudeKnownModelWindow}: the connection's own entry first (the
 * Models API's `max_input_tokens` on a direct Anthropic list, F1.1214, or a
 * window the user wrote on a BYO card), else `MODEL_REGISTRY`. One reader for
 * `chatImpl`'s selector, the declared-cap env below and the constructor's
 * BackendConfig window (which closes F1.1232), so the three cannot disagree.
 *
 * - **`[1m]` selector** ({@link claudeModelWithWindowSelector}). Appended for a
 *   `claude-` id whose known window is at least 1M. The bundled 2.1.274 gives a
 *   native-1M model 1M only on `api.anthropic.com`; behind any custom base URL
 *   (our loopback, a BYO card) it holds 200K unless the id carries `[1m]` — the
 *   2.1.285 changelog fixes that ("Changed sessions behind a custom
 *   `ANTHROPIC_BASE_URL` to use the 1M context window of models that have
 *   one"). The suffix is also how Sonnet 4.6 and Opus 4.6 reach 1M at all
 *   (model-config.md#extended-context: they "reach 1M only through their `[1m]`
 *   variant"). Residue, stated: the same section says "Sonnet 4.6 with 1M context
 *   requires usage credits on every subscription plan, including Max"; a
 *   claude.ai login without them gets Claude Code's own message about it.
 * - **Declared cap** ({@link buildClaudeDeclaredWindowEnv}). A connection that
 *   declares a window BELOW 1M for a `claude-` id gets no suffix and that number
 *   as `CLAUDE_CODE_AUTO_COMPACT_WINDOW` — the documented `/autocompact` remedy
 *   for an endpoint that stops short of the model's window.
 * - **Operator cap.** `CLAUDE_CODE_DISABLE_1M_CONTEXT` and
 *   `CLAUDE_CODE_AUTO_COMPACT_WINDOW` exported by the operator reach the child
 *   through `buildClaudeSubprocessEnv`'s `process.env` spread; neither is on a
 *   strip list. The disable outranks our suffix: the 2.1.274 binary carries "1M
 *   context is turned off here (CLAUDE_CODE_DISABLE_1M_CONTEXT is set)" for a
 *   `[1m]` alias. The declared cap defers to an exported window.
 */
export function resolveClaudeKnownModelWindow(
  connection: Pick<LlmConnection, 'models'> | null | undefined,
  modelId: string | undefined,
): number | undefined {
  if (!modelId) return undefined;
  const entry = connection?.models?.find(
    (model): model is ModelDefinition => typeof model !== 'string' && model.id === modelId,
  );
  return usableContextWindow(entry?.contextWindow) ?? getModelContextWindow(modelId);
}

/** The window at and above which a `claude-` id is sent with its `[1m]` selector. */
export const CLAUDE_1M_CONTEXT_WINDOW = 1_000_000;

/** The id `chatImpl` hands the SDK: `[1m]` appended for a `claude-` id known at 1M or more. */
export function claudeModelWithWindowSelector(modelId: string, knownWindow: number | undefined): string {
  const id = modelId.toLowerCase();
  if (!id.startsWith('claude-') || id.endsWith('[1m]')) return modelId;
  return knownWindow !== undefined && knownWindow >= CLAUDE_1M_CONTEXT_WINDOW ? `${modelId}[1m]` : modelId;
}

/** The connection's declared window below 1M for a `claude-` id, as the SDK's compaction window. */
export function buildClaudeDeclaredWindowEnv(
  connection: Pick<LlmConnection, 'models'> | null | undefined,
  spawnModelId: string | undefined,
  policy: Pick<ResolvedAutoCompactionSettings, 'enabled'> | undefined,
  launchEnv: NodeJS.ProcessEnv = process.env,
): { CLAUDE_CODE_AUTO_COMPACT_WINDOW: string } | Record<string, never> {
  if (policy?.enabled === false) return {};
  if (launchEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW) return {};
  if (!spawnModelId?.toLowerCase().startsWith('claude-')) return {};
  const entry = connection?.models?.find(
    (model): model is ModelDefinition => typeof model !== 'string' && model.id === spawnModelId,
  );
  const declared = usableContextWindow(entry?.contextWindow);
  if (declared === undefined || declared >= CLAUDE_1M_CONTEXT_WINDOW) return {};
  return { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(declared) };
}

/**
 * P6.79 — the launcher-drop announcement, said to the person instead of to a
 * file nobody writes.
 *
 * ## The defect: a diagnostic graded as debug output
 *
 * P3.300 scrubs `CLAUDE_CODE_SHELL_PREFIX` and `CLAUDE_CODE_PROCESS_WRAPPER`
 * from the claude child env, deliberately and ALOUD — the whole point of that
 * row was that dropping an administrator's launcher setting silently is the
 * same one-runtime divergence with the sign flipped. But the sentence goes
 * through `debug(...)` in `options.ts`, and `utils/debug.ts` computes
 * `debugEnabled` ONCE at module load from `NESSY_DEBUG === '1'`. A packaged
 * build sets no such variable, so the announcement reaches nobody: the drop is
 * silent on the shipped product, which is exactly the state P3.300 refused.
 *
 * Third instance of the class P3.120 fixed for codex and P3.267 / P3.310 fixed
 * twice for claude. There is nothing native to adopt — the host owns this
 * channel on both runtimes that have one — so this is a step-3 build with the
 * reason written down: the SDK cannot announce a variable we removed before it
 * ever saw it.
 *
 * ## Why the detection is HERE and not in the env builder
 *
 * `buildClaudeSubprocessEnv` is a pure function with one caller. Putting a
 * notice queue inside it would give a pure builder a side channel into session
 * state, and its `debug()` line stays where it is — a file log is the right
 * grade for a second copy of a fact, just not for the only copy.
 *
 * ## The wording, and the one word that had to change
 *
 * `options.ts` says the binary *would* honour it. That was true before the
 * scrub and is the wrong tense for a person reading the result: after the drop
 * the variable is honoured on **no** runtime — claude never sees it, and Pi and
 * codex inherit it and consult it nowhere (`git grep` for either name over
 * `packages`/`apps` returns only the constant that scrubs them). So the sentence
 * says *no runtime*, names the variable, and names P6.9 as the seam that would
 * make it mean something on all three.
 *
 * Read by property from `process.env` rather than from a spread: the spread is
 * the reading that silently drops Bun's pre-created slots, and while neither of
 * these two names is one of them today, an absence check written on the fragile
 * reading is a defect waiting for a rename.
 */
export function buildClaudeLauncherDropNotices(env: NodeJS.ProcessEnv): string[] {
  const notices: string[] = [];
  for (const key of CLAUDE_LAUNCHER_ENV_KEYS) {
    if (env[key] === undefined) continue;
    notices.push(
      `${key} was dropped from the Claude session's environment. `
      + 'It is honoured on no runtime here: this session never receives it, and Pi and codex '
      + 'inherit it and consult it nowhere, so a launcher policy set this way applies to nothing. '
      + 'A launcher seam honoured by all three runtimes is tracked as P6.9.',
    );
  }
  return notices;
}

/**
 * P6.160 — what the SDK's model aliases resolve to on a `claude-runtime` spawn.
 *
 * ## The defect: an agent pinned to `opus` was substituted and warned at
 *
 * `buildAgentModelPolicy` builds `servedModels` from the connection's catalogue
 * IDS, so an alias can never be a member of it, and `resolvedModelField`
 * therefore dropped every alias-declaring agent with a substitution warning —
 * on a gateway where the endpoint really cannot serve a model named `opus`
 * (measured live 2026-08-14, Q6-LIVE claim 3: the SDK child died with "model
 * not available"). Correct as a failure mode and unnecessary as an outcome: the
 * runtime has a documented way to say what an alias means.
 *
 * ## Native mechanism, asked and answered — CONFIGURE, not build
 *
 * `model-config.md#environment-variables`, the row verbatim:
 * *"`ANTHROPIC_DEFAULT_OPUS_MODEL` | The model to use for `opus`, or for
 * `opusplan` when Plan Mode is active."*, and §Model names: *"To pin to a
 * specific version, use the full model name … or set the corresponding
 * environment variable like `ANTHROPIC_DEFAULT_OPUS_MODEL`."* All four names
 * are in the binary we ship — OPUS 23, SONNET 18, FABLE 14, HAIKU 18, against
 * `ANTHROPIC_API_KEY` 105 as the positive control and `ZZZ_FAKE_CONTROL` 0 as
 * the negative — while `git grep` over `packages`/`apps` scored the first three
 * at **0 hits including tests**, with HAIKU's 11 as the same-family control
 * proving the mechanism was already understood and only partly used.
 *
 * ## Mapped to the SESSION model, and that choice is behaviour-preserving
 *
 * The alias resolves to the value `resolvedModelField` was already substituting
 * — the model the agent ran on after the drop. So the change is what the user
 * SEES (the agent registers as `opus`, no warning) and the pinned agent talks
 * to exactly the same endpoint model it talked to before. No owner call arises.
 *
 * REFUSED: mapping onto "the catalogue's coder model". The seeded gateway
 * catalogue is two entries, so that WOULD change which model a pinned agent
 * talks to — the exact test that made P2.318 an owner call.
 *
 * `haiku` is not seeded here: both spawn paths already seed it from the
 * session's MINI model, which is the right answer for a summarization-tier
 * alias and is a different value from the session model. It is carried in the
 * returned MAP (so an agent declaring `haiku` is admitted) without being
 * re-emitted in the ENV, which is why the two are separate functions.
 *
 * ## `claude-runtime` only, deliberately
 *
 * On a DIRECT Anthropic connection the SDK resolves its own aliases against its
 * own catalogue, correctly. Seeding these names there would override that
 * resolution with our session model — changing which model a pinned agent talks
 * to, which is the very thing refused two paragraphs up. The gateway/BYO path
 * is the only one where the alias resolves to nothing today.
 *
 * A connection whose session model is not in its own catalogue gets an EMPTY
 * map: there is no id we can honestly promise the endpoint serves, so the
 * substitution and its warning stay exactly as they were.
 */
export function buildClaudeRuntimeAliasModels(input: {
  sessionModel: string | undefined;
  miniModel: string | undefined;
  servedModels: readonly string[];
}): ClaudeRuntimeAgentAliasModelMap {
  const map: { -readonly [K in ClaudeSdkModelAlias]?: string } = {};
  const { sessionModel, miniModel, servedModels } = input;
  if (sessionModel && servedModels.includes(sessionModel)) {
    map.opus = sessionModel;
    map.sonnet = sessionModel;
    map.fable = sessionModel;
  }
  // Recorded, never re-emitted: the seed itself is the existing
  // `ANTHROPIC_DEFAULT_HAIKU_MODEL` line on each spawn path.
  if (miniModel) map.haiku = miniModel;
  return map;
}

/**
 * P6.160 — the env half of {@link buildClaudeRuntimeAliasModels}, derived from
 * the same map so the two can never disagree about which aliases are live.
 *
 * Omits `haiku` because both spawn paths already write it, and writing it twice
 * from two different resolutions is how one of them silently wins.
 */
export function buildClaudeRuntimeAliasModelEnv(
  aliasModels: ClaudeRuntimeAgentAliasModelMap,
): Record<string, string> {
  return {
    ...(aliasModels.opus ? { ANTHROPIC_DEFAULT_OPUS_MODEL: aliasModels.opus } : {}),
    ...(aliasModels.sonnet ? { ANTHROPIC_DEFAULT_SONNET_MODEL: aliasModels.sonnet } : {}),
    ...(aliasModels.fable ? { ANTHROPIC_DEFAULT_FABLE_MODEL: aliasModels.fable } : {}),
  };
}

/**
 * P6.134 — the user's `worktree.bgIsolation` choice, forwarded to the runtime
 * that would enforce it.
 *
 * ## The pre-fix direction was INVERTED, and that is why this is not cosmetic
 *
 * We set NO SDK `worktree` option at all — `grep -n 'worktree:'` over this file
 * scored 0, and so did `symlinkDirectories|sparsePaths|baseRef`. The SDK's own
 * docblock says the unset default is `'worktree'`
 * (`sdk.d.ts`: *"Isolation mode for background sessions in this repo.
 * 'worktree' (default) blocks Edit/Write in the main checkout until
 * EnterWorktree is called. 'none' lets background jobs edit the working copy
 * directly."*), and `settings-reference.md#worktree-bgisolation` documents the
 * same key in the same words. OUR resolved default is `'none'`
 * (`config/worktree-settings.ts`, with the reason: `EnterWorktree` is pi-only
 * in this fork, so on a claude session the block has no release valve and an
 * unliftable write block reads as a bug).
 *
 * So before this row a claude child ran with the isolation ON while the host's
 * own answer was OFF — the user's choice was not merely dropped, it was
 * silently reversed, and the symptom is a refused first edit with nothing to
 * explain it.
 *
 * ## Native-first: tier 1 is NOT empty here
 *
 * The original remedy for this cell assumed the host had to build the block.
 * It does not: the runtime owns the key, we simply never wrote it. This is a
 * step-1 *configure what the runtime already has*, which is also why only
 * `bgIsolation` is forwarded. The three siblings — `symlinkDirectories`,
 * `sparsePaths`, `baseRef` — govern worktree CREATION, and our lease service
 * mints every worktree on all three runtimes (claude's own creation is
 * intercepted by the `WorktreeCreate` hook), so forwarding them would hand the
 * child inputs for a job it does not do.
 *
 * ## The residual difference, named rather than left to be discovered
 *
 * `worktreeGateContext()` is provider-agnostic and had its single call site in
 * `pi-agent.ts` when this was written; P6.839 gave it a second, HERE, for the
 * host's `EnterWorktree` floor — and deliberately WITHOUT `bgIsolation`, so this
 * paragraph's point survives intact: claude enforces the write block natively
 * and the host does not enforce it a second time
 * ({@link buildClaudeWorktreeFloorContext}). Codex has no equivalent at all
 * (0 `worktree` files in `packages/codex-protocol`). So claude enforces the
 * user's choice natively and Pi enforces it host-side; CODEX remains the one
 * runtime with no mechanism, which is a disclosure rather than a build. It is
 * recorded in `docs/architecture/runtime-capability-gaps.md`.
 *
 * ## The residue this row left open is CLOSED, by the row after it
 *
 * It read: `worktree` is a construction option with no live setter and is not in
 * `claudeLiveSessionSignature`'s whitelist, so a user who changes the setting
 * mid-session keeps a child built with the old value. That was true while
 * `settings` itself was unhashed. P6.439 clause (1) (`427eda2f5`) added
 * `settings: raw.settings ?? null` to that signature, and this contributor
 * reaches the child THROUGH `Options.settings`
 * ({@link composeClaudeSpawnSettings}) — so a changed `bgIsolation` changes the
 * composed value, which changes the hash, which respawns. Re-read 2026-09-10
 * while landing P6.839; no separate `worktree` entry is needed, and adding one
 * would hash the same bytes twice.
 *
 * ## Where it is written, and why not as an `Options` field
 *
 * `worktree` is a member of the SDK's `Settings` type, not of `Options`, so it
 * reaches the child through `Options.settings` — the same seam P3.95 measured
 * for the auto-mode classifier. That option already had two contributors, and
 * `settings` is ONE key: a second `...{ settings }` spread would REPLACE the
 * first and delete P3.147's credential floor silently. So this contributor goes
 * through {@link composeClaudeSpawnSettings}, which merges by key and refuses a
 * collision out loud, and the options literal still carries exactly one
 * `settings`.
 */
export function buildClaudeWorktreeSettings(
  bgIsolation: 'worktree' | 'none',
): { worktree: { bgIsolation: 'worktree' | 'none' } } {
  return { worktree: { bgIsolation } };
}

/**
 * P6.839 — the repository facts the `EnterWorktree` floor needs, and NOT the
 * field claude enforces itself.
 *
 * ## The defect this closes
 *
 * Claude ships `EnterWorktree` natively; it is in no disallow list, and
 * `agent-sdk/permissions.md`'s documented order ends *"If not resolved by any of
 * the above, call your `canUseTool` callback for a decision"*. So the call
 * reaches our callback, which runs `runPreToolUseChecks`, whose worktree floor
 * refuses with *"this session has no repository to create or enter a worktree
 * in"* whenever {@link PreToolUseInput.worktree} is absent — and it was always
 * absent here, because `worktreeGateContext()` is provider-agnostic on
 * `base-agent.ts` and had exactly one call site, in `pi-agent.ts` (W9-ak,
 * P6.799). The runtime's own tool was answered with a reason that was not true.
 *
 * ## Why the whole context is not simply bound (owner decision 2026-09-10)
 *
 * `worktreeGateContext()` also carries `bgIsolation`, which drives the host's
 * MAIN-CHECKOUT WRITE BLOCK — and claude already enforces that natively:
 * {@link buildClaudeWorktreeSettings} forwards the user's `worktree.bgIsolation`
 * to the child on the settings seam the SDK reads it from. Binding it here would
 * make the host a SECOND enforcer of a rule the runtime already enforces, which
 * is the divergence native-first exists to prevent. So the floor gets the
 * repository facts and nothing else: option A minus the field.
 *
 * The two facts are named ONE BY ONE rather than spread with the field deleted,
 * deliberately: a future addition to the shared context type must be considered
 * for this runtime instead of arriving here silently.
 *
 * ## The residual, documented and NOT live-measured
 *
 * Whether a live claude session's SDK really routes its native `EnterWorktree`
 * through `canUseTool` rather than resolving it earlier is what the documented
 * six-step order says, and only a packaged run settles it — a P7.5 sitting case.
 * Until then this is the difference between a live defect and a latent one, and
 * the fix is correct either way: with routing, the tool starts working; without
 * it, nothing changes.
 */
export function buildClaudeWorktreeFloorContext(
  context: { worktree: PreToolUseInput['worktree'] } | undefined,
): { worktree: PreToolUseInput['worktree'] } | undefined {
  const worktree = context?.worktree;
  if (!worktree) return undefined;
  return {
    worktree: {
      repoRoot: worktree.repoRoot,
      ...(worktree.insideWorktree === undefined ? {} : { insideWorktree: worktree.insideWorktree }),
    },
  };
}

/**
 * P6.134 — the second contributor to `Options.settings`, composed rather than
 * spread beside the first.
 *
 * `settings` is ONE option: a second `...{ settings }` in the options literal
 * would REPLACE the first and delete P3.147's credential floor with no error
 * and no log line. That is the near miss `buildClaudeFlagSettingsOptions` was
 * built for, and this function is the same seam one level out — the literal
 * still has exactly one `settings` key, produced by one merge.
 *
 * A key collision is REFUSED, not resolved, exactly as
 * {@link buildClaudeManagedSettingsOptions} refuses one: with unknown future
 * contributors a silent last-writer-wins is the same defect this seam exists to
 * prevent, so the first writer keeps the key and the caller is told by name.
 *
 * A STRING contributor is refused whole. `Options['settings']` is
 * `string | Settings`, and a string is a PATH to a settings file — there is
 * nothing to merge into it, and merging around it would silently drop whichever
 * side lost. No contributor produces one today; the branch exists so that the
 * day one does, it says so instead of producing a half-applied spawn.
 *
 * Returned as a spreadable partial: with nothing to say the option is absent and
 * the spawn is byte-identical to one built without this function.
 */
/**
 * P3.352 (CRU-7) — the WebFetch domain preflight, disabled and PAIRED.
 *
 * ## What it was
 *
 * Before fetching any URL, the vendored binary sends the requested hostname to a
 * HARDCODED `https://api.anthropic.com/api/web/domain_info?domain=…` — hostname
 * as a query parameter, so our loopback adapter cannot intercept it,
 * `ANTHROPIC_BASE_URL` does not move it, and it is not a header anything could
 * strip. `data-usage.md#webfetch-domain-safety-check` says the check "runs
 * regardless of which model provider you use and is not affected by
 * `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`". So an INTERNAL hostname a user
 * asked the model to fetch left the building, on a gateway deployment whose
 * whole point is that it does not talk to the vendor. Pi and codex run no such
 * preflight on any path. The four static facts are pinned against the binary by
 * `__tests__/claude-webfetch-preflight-markers.test.ts`.
 *
 * ## The decision, and it is the owner's
 *
 * Sitting of 2026-09-05, §2.2: **(C)** — *"disable the preflight paired with a
 * host-supplied domain allowlist, the only option that removes the egress
 * without removing the control"*. (A) leave it was refused because the egress is
 * the defect; (B) disable it bare was refused because the model would then fetch
 * anything with nothing consulted at all.
 *
 * ## What the pairing IS, measured rather than built
 *
 * The page prescribes the pairing in its own words —
 * `settings-reference.md#skipwebfetchpreflight`: *"With the check skipped,
 * WebFetch attempts any URL without consulting the blocklist, so pair it with
 * `WebFetch` permission rules if you need to restrict which domains Claude can
 * reach."* Native-first: both halves of that control already exist here and
 * neither is built by this row. An operator's `sandbox.network.deniedDomains`
 * and, under its own lock, `allowedDomains` already reach the child through
 * `managedSettings` (`claude-managed-settings.ts` `mapSandbox`), and the host's
 * `canUseTool` gate judges every `WebFetch` call on all three runtimes, which
 * the vendor blocklist never did.
 *
 * ## So the only thing that could be silent is an EMPTY pairing, and it is not
 *
 * When the operator has configured no domain control at all, disabling the
 * preflight is indistinguishable from option (B) for that install. That case
 * returns a notice rather than a different setting: the removal is stated on the
 * transcript, with what remains named. Choosing to keep the egress instead would
 * re-decide the owner's ruling per-install, which is not a lane's call.
 */
export function buildClaudeWebFetchPreflightSettings(
  hostDomainControl: { readonly allowedDomains?: readonly string[]; readonly deniedDomains?: readonly string[] } | undefined,
): { settings: { skipWebFetchPreflight: true }; notices: string[] } {
  const paired = (hostDomainControl?.allowedDomains?.length ?? 0) > 0
    || (hostDomainControl?.deniedDomains?.length ?? 0) > 0;
  return {
    settings: { skipWebFetchPreflight: true },
    notices: paired ? [] : [
      'claude-webfetch-preflight-disabled: this session no longer sends the hostname of every '
      + 'page it fetches to api.anthropic.com, and no operator domain allowlist or denylist is '
      + 'configured to take the vendor blocklist\'s place. Every WebFetch is still judged by this '
      + 'session\'s own permission gate, which is what Pi and Codex have always relied on — they '
      + 'run no such preflight at all. Set sandbox.network.allowedDomains or deniedDomains in '
      + 'managed policy to restrict which domains this runtime may reach.',
    ],
  };
}

/**
 * P6.314 (H34) — the operator's subagent-prompt append, on claude's own flag.
 *
 * ## The row's native clause was WRONG in our favour, and this is the correction
 *
 * It said the SDK path composes agent prompts itself, so the host is the seam.
 * The host IS the seam for Pi, and `config/subagent-prompt-append.ts` is that
 * answer. But claude's CLI flag is reachable from the SDK after all:
 * `Options.extraArgs` is "Additional CLI arguments to pass to Claude Code. Keys
 * are argument names (without --), values are argument values." So this is
 * native-first step 1 — enable what the runtime already has — rather than step 2.
 *
 * Measured on the vendored 2.1.247 binary, not taken from a page — re-measured
 * 2026-09-12 (C3.252) with the instrument named on both sides because they
 * disagree on a minified artefact (C3.294):
 * `append-subagent-system-prompt` scores 5 lines / 6 occurrences and its
 * internal identifier `appendSubagentSystemPrompt` 15/51, against a fabricated
 * control at 0/0. (The superseded reading was "7 … 24" at 2.1.233.) The binary
 * publishes no ENVIRONMENT spelling for it, which is why the variable name stays
 * ours and is shared with the Pi arm rather than aliased to a contract that does
 * not exist.
 *
 * ## Why this is the whole claude arm
 *
 * The flag applies to every subagent the child spawns, nested ones included, by
 * being the child's own setting rather than a string our spawner concatenates —
 * which is exactly the fork carve-out the row asks for: a fork reuses the
 * conversation prompt, and the runtime that owns forking is the one that knows
 * not to append twice.
 *
 * ## The one guard that had to move with it
 *
 * `__tests__/claude-restricted-mode-collision.test.ts` asserted that NOTHING in
 * this file assigns `extraArgs`, because that hatch is the only route by which
 * `--restricted` could reach the child. The hatch now has exactly one caller and
 * the tripwire is narrowed to the real risk rather than deleted: no `restricted`
 * key, on this file or on `options.ts`.
 */
export function buildClaudeSubagentPromptAppendArgs(
  append: string | undefined,
): Pick<Options, 'extraArgs'> {
  if (append === undefined || append.length === 0) return {};
  return { extraArgs: { 'append-subagent-system-prompt': append } };
}

export function composeClaudeSpawnSettings(
  contributors: Readonly<Record<string, NonNullable<Options['settings']> | undefined>>,
  /**
   * P6.1031 — the second argument is the STRUCTURE of a per-key collision, and
   * it exists so a caller can decide what to do about one without reading the
   * sentence. `detail` is present on a key collision and absent on the
   * whole-contributor path drop (P6.1023 already speaks for that one), so a
   * caller keying on `detail?.loser` cannot accidentally double it.
   *
   * Callers that only log stay source-compatible: an extra argument to a
   * one-parameter arrow is ignored.
   */
  onCollision?: (
    message: string,
    detail?: { readonly key: string; readonly winner: string; readonly loser: string },
  ) => void,
): Pick<Options, 'settings'> {
  const merged: Record<string, unknown> = {};
  const owner = new Map<string, string>();
  for (const [name, value] of Object.entries(contributors)) {
    if (!value) continue;
    if (typeof value === 'string') {
      onCollision?.(
        `[settings] ${name} supplied a settings FILE PATH, which cannot be merged with the other`
        + ' contributors; it is dropped. Compose the keys deliberately instead.',
      );
      continue;
    }
    for (const [key, entry] of Object.entries(value)) {
      const held = owner.get(key);
      if (held !== undefined) {
        onCollision?.(
          `[settings] "${key}" is written by both ${held} and ${name}; keeping ${held}'s value.`
          + ' Compose the two deliberately instead of letting one overwrite the other.',
          { key, winner: held, loser: name },
        );
        continue;
      }
      owner.set(key, name);
      merged[key] = entry;
    }
  }
  if (Object.keys(merged).length === 0) return {};
  return { settings: merged as NonNullable<Options['settings']> };
}

/**
 * P6.1023 — the operator's `--settings` PATH, refused where an operator can read it.
 *
 * ## What this is NOT
 *
 * It is not a second answer to "is this path usable". Existence, regular-file-ness
 * and the 2 MiB ceiling are the child's own checks, and
 * `config/claude-flag-settings.ts` refuses to duplicate them for the reason it
 * records: two answers to one question. Nothing here reads the file, stats it, or
 * decides anything about it.
 *
 * ## What it IS
 *
 * The one sentence that says the value was not applied. P6.1009 made the flag a
 * contributor to {@link composeClaudeSpawnSettings}, which cannot merge a filename
 * into the object the other contributors write, so it drops a string contributor
 * whole — audibly, but only to `onCollision`, which `chatImpl` hands to
 * `this.debug`. A packaged build logs nothing outside debug mode (AGENTS.md
 * §Traps), so today the operator's flag does nothing and says nothing where they
 * are looking. The behaviour is unchanged by this function — a path was
 * overwritten silently before P6.1009 and is dropped audibly after it — and what
 * changes is only who hears it.
 *
 * Pure, and returning the `{ notices: string[] }` shape
 * {@link buildClaudeWebFetchPreflightSettings} already uses in this file, so the
 * caller queues it through the same `queueDegradationNotice` on the same line of
 * the same builder. It contributes no settings of its own: the flag is already a
 * contributor, and a second producer of that option in the options literal is the
 * whole of the defect P6.1009 repaired.
 */
export function buildClaudeOperatorSettingsFlagNotices(
  flagSettings: ClaudeFlagSettings | undefined,
): { notices: string[] } {
  // An object is the composable case and says nothing: its keys reach the child,
  // minus any a host floor already owns, and THAT loss is named by the composer's
  // own per-key collision line rather than by a blanket notice here.
  if (typeof flagSettings !== 'string') return { notices: [] };
  return {
    notices: [
      `claude-settings-flag-path-dropped: --settings was given the file path ${flagSettings}, and `
      + 'nothing from that file is applied to this session. This host composes the flag-settings '
      + 'layer from several contributors — the credential deny list, the auto-mode policy, the '
      + 'WebFetch preflight pairing and your worktree isolation — and a filename cannot be merged '
      + 'with them. Pass the same settings as an inline JSON object instead: the documented flag '
      + 'accepts "a path to a settings JSON file or an inline JSON string", and every key of the '
      + 'object that no host floor already writes reaches the runtime.',
    ],
  };
}

/**
 * P6.1031 — the per-key half of the silence P6.1023 closed for the PATH.
 *
 * The composer keeps the FIRST writer of a key and names the loser out loud —
 * to `onCollision`, which the builder hands to `this.debug`. So an operator
 * whose `--settings` object wrote a key a host floor already owns got the
 * documented behaviour (the floor stays the floor) and NO WAY TO KNOW: the flag
 * looked applied, one of its keys was not, and a packaged build logs nothing
 * outside debug mode.
 *
 * ONE sentence, in the operator's vocabulary rather than the composer's. The
 * composer's own line names internal contributors (`worktree`,
 * `operatorSettingsFlag`) and is the right sentence for a developer reading a
 * debug log; this is the one for the person who set the flag.
 *
 * Pure, `{ notices }`-shaped like {@link buildClaudeOperatorSettingsFlagNotices}
 * beside it, and reached ONLY when the caller has already established from the
 * collision's STRUCTURE that the loser was the operator's flag — never by
 * matching on the message text, which is what would make this fire for a
 * collision between two host contributors.
 */
export function buildClaudeOperatorSettingsFlagCollisionNotice(
  key: string,
): { notices: string[] } {
  return {
    notices: [
      `claude-settings-flag-key-dropped: --settings set "${key}", and this session is using the `
      + "host's own value for it instead. The flag-settings layer is composed from several "
      + 'contributors — the credential deny list, the auto-mode policy, the WebFetch preflight '
      + 'pairing and your worktree isolation — and the first writer of a key keeps it, so the flag '
      + 'cannot lift a host floor. Every OTHER key of your object still reaches the runtime.',
    ],
  };
}

/** The connection fields the spawn-window resolution reads. */
export type ClaudeSpawnWindowConnection = Pick<LlmConnection, 'models' | 'baseUrl'>;

/**
 * Where the window this subprocess spawns with came from — or why there is none.
 *
 * Three outcomes, not two, because "no number" covers two opposite situations
 * and only one of them is a problem. `sdk-owned` is the deliberate abstention
 * for a `claude-*` id (the SDK's own model-tuned window is better than ours) and
 * for a spawn with no model at all. `missing` is the defect state: a real id the
 * SDK has never heard of, for which we ALSO have no window — the combination
 * that silently disables proactive compaction for the whole session.
 *
 * **Exported because a second subsystem now asks the same question** (P6.10).
 * `planHistoryCarry` (`server-core/sessions/runtime-switch.ts`) used to answer
 * it with its own inline `startsWith('claude-')`, which collapsed `sdk-owned`
 * and `missing` into one verdict and degraded every Claude target to a text
 * handoff. Those two are opposite answers to "will the target enforce the window
 * we resolved" — `sdk-owned` means the SDK enforces a better one, `missing`
 * means nothing enforces anything — so the collapse erased exactly the
 * distinction this type was introduced to keep. One classifier, one answer, and
 * no third copy of the prefix test.
 */
export type ClaudeSpawnContextWindow =
  | { kind: 'resolved'; window: number; source: 'catalogue' | 'gateway-preset' }
  | { kind: 'sdk-owned' }
  | { kind: 'missing'; modelId: string };

/** A context window is only usable if it is a positive finite number. */
function usableContextWindow(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/**
 * The window of the model this subprocess will spawn on, and where it came from.
 *
 * Shared by the two env vars below so they can never describe different models
 * or different numbers: `CLAUDE_CODE_MAX_CONTEXT_TOKENS` tells the SDK how big
 * the window is, `CLAUDE_CODE_AUTO_COMPACT_WINDOW` tells it to act on that size.
 * The `claude-` exclusion is part of the resolution because the first env is
 * inert for such ids in the binary; see each function's own note.
 *
 * **The `gateway-preset` tier is why this is not just the catalogue lookup.**
 * `/cli/models` does not report a context window, so `fetchNestorModels` stamps
 * one on from `NESTOR_GATEWAY_MODEL_WINDOWS` — and that refresh REPLACES the
 * connection's model list hourly. A gateway model absent from that table lands
 * in the catalogue with no `contextWindow` at all, and the id is one the SDK has
 * never heard of, so both envs stayed absent and the session never compacted.
 * Reading the same table here means a model whose stored entry lost its window
 * (a refresh that predates the table, a hand-edited connection, a spawn model no
 * longer in the list) still compacts.
 *
 * Gated on {@link isNessyGatewayBaseUrl}, the WHOLE-URL match — not
 * `isNestorCliBaseUrl`'s `…/api/v1/cli/` prefix. A BYO endpoint on the same host
 * under a different path is a different deployment that may serve a same-named
 * id with a different real window, and handing the SDK a window larger than the
 * truth makes it compact too late, which is the failure this whole function
 * exists to prevent. Same rule, same reason, as the one deciding whether
 * `Nestor-Token` may be attached.
 */
export function resolveClaudeSpawnContextWindow(
  connection: ClaudeSpawnWindowConnection,
  spawnModelId: string | undefined,
): ClaudeSpawnContextWindow {
  if (!spawnModelId || spawnModelId.startsWith('claude-')) return { kind: 'sdk-owned' };

  const entry = connection.models?.find(
    (model): model is ModelDefinition => typeof model !== 'string' && model.id === spawnModelId,
  );
  const stored = usableContextWindow(entry?.contextWindow);
  if (stored !== undefined) return { kind: 'resolved', window: stored, source: 'catalogue' };

  if (isNessyGatewayBaseUrl(connection.baseUrl)) {
    const preset = usableContextWindow(nestorGatewayModelWindow(spawnModelId));
    if (preset !== undefined) return { kind: 'resolved', window: preset, source: 'gateway-preset' };
  }

  return { kind: 'missing', modelId: spawnModelId };
}

/** {@link resolveClaudeSpawnContextWindow} as the plain number the envs need. */
function resolveSpawnModelContextWindow(
  connection: ClaudeSpawnWindowConnection,
  spawnModelId: string | undefined,
): number | undefined {
  const resolution = resolveClaudeSpawnContextWindow(connection, spawnModelId);
  return resolution.kind === 'resolved' ? resolution.window : undefined;
}

/**
 * The token count the shipped SDK ASSUMES for a model id it does not recognise
 * — `Ofr` in `claude-agent-sdk-darwin-arm64/claude`, the last fallback of the
 * window resolver's `Ew`/`j7p` chain, and the number the binary prints in its
 * own "the context window it assumes" notice.
 *
 * Exported so the warning below and the test that pins it read ONE number, and
 * so the test can check that number against the bundle rather than against this
 * comment. If a future bundle moves it, that test fails and names what to
 * re-measure — which is exactly what did NOT happen when 2.1.218's behaviour was
 * described in prose and the bundle went to 2.1.223 underneath it (P3.245).
 */
export const CLAUDE_UNKNOWN_MODEL_ASSUMED_WINDOW = 200_000;

/**
 * Say out loud that this session compacts against a window that is not this
 * model's, when that is the case.
 *
 * The durable half of the fix. A window we cannot resolve does not fail loudly:
 * both envs stay absent and the SDK falls back to a guess. There is no error, no
 * boundary and no event — the first symptom a user sees is the model answering
 * worse, or the endpoint rejecting a turn, which they attribute to the model
 * rather than to us. That is precisely why the defect this warning covers
 * survived to be found by a token count rather than by a report.
 *
 * ## The sentence this used to carry was TRUE, then the bundle moved (P3.245)
 *
 * On 2.1.218 the unresolved case meant window source `"auto"`, which that
 * binary's own gate read as "skip proactive compaction entirely", so the
 * accurate warning was *"automatic context compaction is OFF for this session"*.
 * On the 2.1.247 we ship (the arm arrived at 2.1.233 and P7.1 re-ran every
 * probe in `claude-auto-compact-window-env.test.ts` across the lift), a new arm
 * resolves an unrecognised id to
 * `source: "unknown-model"` instead — see {@link buildClaudeAutoCompactWindowEnv}
 * for the branch and its three predicates — the gate PASSES, and compaction runs
 * against {@link CLAUDE_UNKNOWN_MODEL_ASSUMED_WINDOW}. The old sentence was
 * therefore telling an operator the opposite of what the runtime does, which is
 * worse than silence: it invites them to go looking for a compaction feature
 * that is already running at the wrong number.
 *
 * The remedy is unchanged and the severity is unchanged; only the diagnosis is.
 * `warning` rather than `error`: the session works, and `SessionManager` turns
 * an error-level `authWarning` into the same row it uses for a session that
 * failed to authenticate. What is degraded is one capability, and the message
 * says which one and what to do about it.
 *
 * Documented contract, `model-config.md#correct-the-window-for-a-gateway-or-custom-model-id`:
 * "If the ID doesn't start with `claude-` or contain `[1m]`, in any casing, and
 * Claude Code can't resolve it to a Claude model, the variable applies directly
 * and proactive compaction continues at the declared window." A declared window
 * is the whole mechanism; with none there is nothing to declare, and the
 * assumption takes its place.
 */
export function buildClaudeContextWindowWarning(
  connection: ClaudeSpawnWindowConnection,
  spawnModelId: string | undefined,
  policy?: Pick<ResolvedAutoCompactionSettings, 'enabled'>,
): Pick<PostInitResult, 'authWarning' | 'authWarningLevel'> {
  // P6.53 — silence when the user turned auto-compaction OFF. The sentence
  // below reports a DEFECT ("compaction is OFF and you did not ask for that");
  // once the off-switch is honoured, the same state is the setting working, and
  // warning about a setting the user chose trains them to ignore the warning.
  if (policy?.enabled === false) return {};
  const resolution = resolveClaudeSpawnContextWindow(connection, spawnModelId);
  if (resolution.kind !== 'missing') return {};
  return {
    authWarning:
      `No context window is recorded for model "${resolution.modelId}", so this session compacts `
      + `against the ${CLAUDE_UNKNOWN_MODEL_ASSUMED_WINDOW.toLocaleString('en-US')}-token window `
      + 'Claude Code assumes for an unrecognised model instead of this one\'s: a smaller model is '
      + 'rejected by the endpoint before compaction ever runs, and a larger one is compacted long '
      + 'before it needs to be. Set a context window for this model on the connection, or pick a '
      + 'model that has one.',
    authWarningLevel: 'warning',
  };
}

/**
 * Point the SDK's automatic compaction at the window this gateway session
 * actually has. On the bundle where this was found it was the difference
 * between compacting and never compacting; on the bundle we ship today it is
 * the difference between compacting at OUR number and compacting at a constant
 * the SDK assumes — see "THE BUNDLE MOVED" below, and do not read the
 * historical paragraph as current behaviour.
 *
 * F5 measured a claude-runtime session carried to 227 337 tokens — 94.7% of the
 * 240 000 window the SDK itself reports, and 20 337 past the threshold F4
 * displays — with no compaction, no boundary and no error, while manual
 * `/compact` worked in that same session as the control. `DISABLE_AUTO_COMPACT`
 * was never set; that lead was refuted before this one was found.
 *
 * The cause was read verbatim out of the bundled binary WHEN THAT BUNDLE WAS
 * v2.1.218, where the only proactive auto-compaction gate refused an id whose
 * window resolved with `source: "auto"` — which every gateway id did — so the
 * SDK answered `{kind:"not_needed"}` on every turn, forever.
 *
 * ## THE BUNDLE MOVED, AND SO DID THIS (P3.245, re-measured 2026-09-02;
 * ##  re-measured AGAIN on 2.1.233 by S0-3, 2026-09-03)
 *
 * The bundle moved on past it: the two self-reports AGENTS.md prescribes agreed
 * on 2.1.251 (SDK 0.3.251) when re-run 2026-09-18 — that is a STAMP, so re-run
 * them rather than reading this line. **The version-string count it used to
 * carry is deleted rather than refreshed**: it read "the string `2.1.233` occurs
 * 374 times in the binary and both `2.1.223` and `2.1.218` zero times", and
 * grepping a binary for a dotted version is not a reading of its version —
 * re-measured 2026-09-12, `2.1.247` scores 1561 lines / 1680 occurrences while
 * `2.1.233`, `2.1.238` and `2.1.223` each score 1/1 in the very binary that
 * self-reports 2.1.247. Every minified symbol
 * this comment names is renamed on EVERY bump — that is now measured twice, so
 * treat any letter below as a coordinate, never as an identity. The 2.1.223 →
 * 2.1.233 map, so a reader holding the older comment can follow it across:
 * gate `hky`→`ulS`, `Nfr`→`iNr`, `bmt`→`HPt`, `Uk`→`vI`, `YEe`→`Fye`,
 * `aYe`→`i4e`, `v9`→`W9`, `LR`→`EP`, `hA`→`Jx`, `h3e`→`p7e`, `XL_`→`P8b`,
 * `Gvs`→`g0r`, `war`→`nst`, `Ofr`→`dCr`, and the ENV MODULE ITSELF `te`→`V`
 * (that last one broke two probes in `claude-auto-compact-window-env.test.ts`
 * that believed they were anchored on env NAMES; they are now `\w+\.`).
 *
 * The gate is `ulS`, structurally the same function it was at 2.1.218:
 *
 *     if (iNr(n)) return !1;
 *     if (HPt(n)) return !1;
 *     if (!vI()) return !1;
 *     if (Fye() && !i4e(t, r)) return !1;          // ← this line
 *     let s = EP(e, Jx(t)) - o, a = p7e(s, t, r);
 *     return a.level === "compact" || a.level === "blocked"
 *
 * `i4e(model, window)` is still `W9(model, window).source !== "auto"`, and `W9`
 * still walks env → settings → clientdata → experiment → known-id tables. The
 * arm 2.1.223 added ahead of the `"auto"` fallback is unchanged at 2.1.233, and
 * its env still appears exactly 8 times:
 *
 *     if (vI() && !V.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT
 *         && !P8b(e, r) && !g0r(e) && !nst(e, n))
 *       return { window: o, configured: o, source: "unknown-model" };
 *     return { window: o, configured: o, source: "auto" };
 *
 * All three predicates are false for a gateway id — `P8b` is the `[1m]`/beta
 * check, `g0r` wants `"application-inference-profile"` in the id, and `nst` is
 * the known-model-catalogue lookup — so an unrecognised id resolves to
 * `source: "unknown-model"`, `i4e` is TRUE, and **the proactive gate passes
 * without our env**. `Fye()` is still true for us (it goes false only under
 * `CLAUDE_CODE_REMOTE`, and its experiment is `tengu_reactive_compact_remote`,
 * not the `tengu_sepia_moth` the pre-2.1.223 comment named).
 *
 * ONE REAL CHANGE inside `vI()`, and it does not move us. At 2.1.223 it read
 * `if (te.DISABLE_COMPACT) return !1; if (tr(process.env.DISABLE_AUTO_COMPACT))
 * return !1;` — a truthiness parser applied to the raw environment. At 2.1.233
 * it reads `if (V.DISABLE_COMPACT) return !1; if (V.DISABLE_AUTO_COMPACT)
 * return !1;`: the parse moved into the env module's own lazy accessor
 * (`DISABLE_AUTO_COMPACT:()=>gcy`), so both names now go through the same
 * coercion. `buildClaudeAutoCompactionEnv` only ever emits the string `'1'` or
 * omits the key, and `'1'` is truthy under either spelling — but a future
 * change that emitted `'0'` would now be reading a different parser than the
 * one this comment was written against.
 *
 * ## So why this env still exists, and it is a DIFFERENT reason than in 2.1.218
 *
 * Not "compaction is off" any more — "compaction is aimed at a window this
 * session does not have". With neither `CLAUDE_CODE_MAX_CONTEXT_TOKENS` nor
 * this variable set, `Ew` falls through to the constant `Ofr = 200000`, and the
 * binary says so in its own words: "is not a model this version of Claude Code
 * recognizes, so auto-compact will keep this session within 200000 tokens (the
 * context window it assumes)". A 40 960-token gateway model would therefore be
 * compacted at a threshold four times past its real limit — the endpoint
 * rejects the turn long before the SDK acts — and a 1M model would be compacted
 * five times too early. Setting this env makes `v9` return `source: "env"` from
 * its FIRST branch with the number WE know. The threshold it then computes is
 * `window − min(maxOutput, 20 000) − 13 000` — the identical subtraction
 * `context-meter-state.ts` already draws the composer's warning against, so the
 * number the user sees becomes the number the SDK acts on.
 *
 * Documented contract, `model-config.md` § *Set the auto-compact window*: "In
 * scripts and cloud environments: set `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. While
 * it's set, it takes precedence over the command, the flag, and the setting".
 * The `env-vars.md` row adds the two constraints this respects: it "Accepts a
 * plain integer such as `500000` only" (so `String(window)`, never a `k` form),
 * and the range is 100 000–1 000 000. A smaller window is NOT withheld: the
 * binary floors the CONFIGURED value at 100 000 and then takes
 * `Math.min(modelWindow, configured)`, so a 40 960 model keeps its real 40 960
 * window — which on 2.1.223 is the whole point, because without this the same
 * model is compacted against the 200 000 the SDK assumes for an id it does not
 * recognise.
 *
 * Same gate and same value as `CLAUDE_CODE_MAX_CONTEXT_TOKENS` above,
 * deliberately: a `claude-*` spawn model keeps the SDK's own model-tuned window
 * rather than one derived from our catalogue. Unlike that env, this one is read
 * by `NK` for every id, so the exclusion here is our choice and not the
 * binary's — stated so the next reader does not mistake it for a copy.
 */
export function buildClaudeAutoCompactWindowEnv(
  connection: ClaudeSpawnWindowConnection,
  spawnModelId: string | undefined,
): { CLAUDE_CODE_AUTO_COMPACT_WINDOW: string } | Record<string, never> {
  const window = resolveSpawnModelContextWindow(connection, spawnModelId);
  if (window === undefined) return {};
  return { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(window) };
}

/**
 * P6.53 — the auto-compaction OFF switch, projected onto the SDK's own knob.
 *
 * The host resolves ONE auto-compaction policy per process
 * (`resolveAutoCompactionSettings`: user setting ∧ managed floor ∧
 * `DISABLE_AUTO_COMPACT`), and until this function existed that policy reached
 * only the Pi backend. So a user who turned auto-compaction off and then
 * switched the session to `claude-runtime` got it back on — and not merely by
 * default: {@link buildClaudeAutoCompactWindowEnv} exists precisely to turn the
 * SDK's proactive compaction ON for a gateway id, so the switch to Claude
 * actively re-armed the thing the user had switched off, silently.
 *
 * NATIVE-FIRST, and nothing here is built. The bundled SDK already owns this
 * capability three ways; its single proactive-compaction gate, read verbatim
 * out of `claude-agent-sdk-darwin-arm64/claude` (fn `Uk`), is:
 *
 *     function Uk(){
 *       if(te.DISABLE_COMPACT)return!1;
 *       if(tr(process.env.DISABLE_AUTO_COMPACT))return!1;
 *       return bu("autoCompactEnabled",!0).value
 *     }
 *
 * Every compaction decision in the binary is behind `Uk()` — including
 * `Vvs`, which computes `{enabled:Uk(), …}` and whose caller `h3e` drops the
 * window outright when it is false. So `DISABLE_AUTO_COMPACT` beats
 * `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, and emitting the disable INSTEAD OF the
 * window is belt-and-braces rather than a requirement.
 *
 * The env is the right one of the three. `settings-reference.md#autocompactenabled`:
 * "**Per-session overrides**: [`DISABLE_AUTO_COMPACT`](/docs/en/env-vars) turns
 * auto-compact off for one session; whichever of the two turns it off, the
 * other can't turn it back on". A session-scoped override is exactly what we
 * have — the setting itself lives in Nessy's own store, not in the SDK's
 * `settings.json`, and writing into that file would put us in a precedence
 * argument with the user's own Claude Code install. `env-vars.md` states the
 * value and the residue: "Set to `1` to disable automatic compaction when
 * approaching the context limit. The manual `/compact` command remains
 * available."
 *
 * NOT `DISABLE_COMPACT`: that one also kills manual `/compact`
 * ("Set to `1` to disable all compaction: both automatic compaction and the
 * manual `/compact` command"), and `storage.ts` documents our setting as
 * "Enable Pi automatic compaction; manual /compact is independent".
 */
export function buildClaudeAutoCompactionEnv(
  connection: ClaudeSpawnWindowConnection,
  spawnModelId: string | undefined,
  policy: Pick<ResolvedAutoCompactionSettings, 'enabled'> | undefined,
): { DISABLE_AUTO_COMPACT: '1' } | { CLAUDE_CODE_AUTO_COMPACT_WINDOW: string } | Record<string, never> {
  if (policy?.enabled === false) return { DISABLE_AUTO_COMPACT: '1' };
  return buildClaudeAutoCompactWindowEnv(connection, spawnModelId);
}

/*
 * P6.55 · COMPACTION THRASHING ON CLAUDE — DO NOT BUILD A HOST GUARD HERE.
 *
 * The row asks whether a context that refills after every compaction loops the
 * turn, and Pi and codex each carry a host-side guard for it
 * (`applyAutoCompactionThrashingGuard`, `CodexAutoCompactionThrashGuard`, both
 * tripping on the shared `AUTO_COMPACTION_THRASHING_REFILL_LIMIT`). Native-first
 * was asked before anything was written here, and the answer is that the SDK
 * ALREADY HAS THIS, so a third host guard would be a re-implementation beside a
 * working mechanism. Measured in the vendored 2.1.223 binary on 2026-09-02 and
 * re-measured byte-for-byte on 2.1.233 by S0-3 on 2026-09-03 (only the names
 * moved: `n1_`→`H8b`, `CEo`→`TQo`):
 *
 *     function H8b(e){return e?.compacted===!0&&e.turnCounter<3?(e?.consecutiveRapidRefills??0)+1:0}
 *     function TQo(e){let t=H8b(e);return{action:t>=3?"trip":"proceed",consecutiveRapidRefills:t}}
 *     var …=3,…="Autocompact is thrashing: the context refilled to the limit
 *       within 3 turns of the previous compact, 3 times in a row. …"
 *
 * Both the proactive and the reactive compaction paths consult `TQo`; a trip
 * ends the turn (`{reason:"rapid_refill_breaker"}`) after emitting that sentence
 * as an `invalid_request` message. The threshold AGREES with ours — three
 * refills, i.e. the fourth compaction of an uninterrupted run — so there is no
 * number to reconcile. One honest difference: the SDK adds a RECENCY window the
 * host guards do not have (`turnCounter < 3`, so a refill arriving more than
 * three turns after the previous compact resets the count), while ours reset at
 * a turn / user-message boundary instead.
 *
 * ## The residue, which is a SWITCH problem and not a missing capability
 *
 * The SDK publishes the verdict on a typed field — `TerminalReason` in
 * `sdk.d.ts` includes `'rapid_refill_breaker'`, carried as `terminal_reason` on
 * both `SDKResultSuccess` and `SDKResultError`. Our claude event adapter reads
 * `msg.terminal_reason` for `tool_deferred` / `tool_deferred_unavailable` ONLY,
 * so a tripped breaker currently reaches the host as `provider_error` (or as no
 * terminal reason at all) while the identical failure ends as
 * `auto_compaction_thrashing` on Pi and codex. That is a native mechanism
 * adopted without a switch verdict, i.e. exactly the silent divergence
 * native-first exists to prevent.
 *
 * The fix is one arm in `backend/claude/event-adapter.ts` — map
 * `terminal_reason === 'rapid_refill_breaker'` onto
 * `AgentTerminalReason.AutoCompactionThrashing` — and that file belonged to
 * another lane on the round this was measured, so it is REPORTED rather than
 * raced. Nothing in this file should grow a counter in the meantime.
 */

/**
 * R18 turn-level structured output: the SDK `outputFormat` option for the turn
 * query, reusing the exact shape already proven on the `call_llm` path
 * (`queryLlm` below). Absent schema returns an empty object so a schema-less
 * turn's options stay byte-identical. The SDK's own retry knob
 * (`MAX_STRUCTURED_OUTPUT_RETRIES`, default 5) governs this path and reaches
 * the subprocess by env inheritance — deliberately NOT renamed on the Claude
 * side (the Nessy Pi loop has its own `NESSY_`-prefixed knob).
 * Contract: code.claude.com/docs/en/agent-sdk/structured-outputs.md.
 */
export function buildClaudeStructuredOutputOptions(
  outputSchema?: Record<string, unknown>,
): Pick<Options, 'outputFormat'> {
  if (!outputSchema) return {};
  return { outputFormat: { type: 'json_schema' as const, schema: outputSchema } };
}

/**
 * P2.28 — ARM THE SDK'S OWN USD CEILING, FROM THE SAME NUMBER THE HOST READS.
 *
 * `Options.maxBudgetUsd` is documented as *"Maximum budget in USD for the query.
 * The query will stop if this budget is exceeded, returning an
 * `error_max_budget_usd` result"* (`sdk.d.ts`). That result subtype maps to our
 * `max_budget_usd` terminal reason in `backend/claude/event-adapter.ts` — a
 * mapping `b57b284cb` added on 2026-07-25, twenty days AFTER the backend file
 * itself landed (`845cf0a41`, 2026-07-05). This comment first said "since the
 * backend was written"; only the sentence after it survives measurement: nothing
 * on this side ever set the option, so the mapping was a reader for a verdict no
 * session could provoke.
 *
 * ## The ceiling, and where it comes from
 *
 * The caller passes `BaseAgent.getMaxBudgetUsd()`, which re-reads
 * `loadConfigDefaults().workspaceDefaults.maxBudgetUsd` on EVERY call and
 * collapses every "off" spelling (missing, non-finite, non-positive) to 0. It is
 * the same method the host-side loop reads at the top of every turn
 * (`base-agent.ts`: "Read the ceiling once per turn, like the Pi loop does").
 *
 * It is NOT the reader P2.5's subagent cap uses, though this comment claimed so.
 * That gate reads `managed.maxBudgetUsdReached` — a per-turn latch
 * `SessionManager` raises only once the host loop has ALREADY tripped, and
 * clears at the start of every turn. `getMaxBudgetUsd` has exactly three
 * non-test callers: `BaseAgent.chat`, the Pi loop, and the call below. None of
 * them is a spawn path.
 *
 * `0` returns NO KEY rather than `maxBudgetUsd: 0` — the right call for a reason
 * this comment stated wrongly. Zero is not a tight ceiling the SDK would
 * enforce; the shipped native CLI REFUSES it. The SDK forwards the option on an
 * `!== undefined` guard (`sdk.mjs`: `if(f!==void 0)B.push("--max-budget-usd",
 * f.toString())`), and the CLI's own argument parser throws
 * *"--max-budget-usd must be a positive number greater than 0"* for any value
 * `<= 0`. So `maxBudgetUsd: 0` would fail ARGUMENT PARSING for every uncapped
 * session rather than stop its first priced event. Absence is the only spelling
 * the CLI accepts for "no cap", and it keeps an uncapped turn's options
 * byte-identical to what they were before this row.
 *
 * ## Per-turn freshness, and what pays for it
 *
 * The options literal is rebuilt every turn, so the ceiling is re-read every
 * turn — matching the host rather than latching a number at session start.
 * Reaching the RUNNING child is the other half: `Query` has no
 * `setMaxBudgetUsd` (asserted mechanically against `sdk.d.ts` in
 * `claude-live-settings.test.ts`), so this is a construction option and
 * `maxBudgetUsd` is hashed into {@link claudeLiveSessionSignature}. A changed
 * ceiling therefore respawns, which is the documented behaviour for every option
 * with no setter; an unchanged one is not a drift and costs nothing. The user
 * action behind it — editing the spending limit — is rare, and the alternative
 * is a raised cap that the child keeps ignoring while the host loop has already
 * started honouring it.
 *
 * ## Which authority fires, and on what count
 *
 * Both authorities read the ONE ceiling above, but they count against it with
 * counters that do not agree — and on this backend only one of the two has a
 * cost input at all. Neither of the two sentences this section used to carry
 * ("the SDK cap is the finer, earlier ceiling"; a no-cost upstream's sessions
 * "are capped by `BaseAgent.chat` alone") survived measurement.
 *
 * FIRST, the host's counter WAS inflated here, and P2.35 fixed it at the
 * emitter. `sdk.d.ts:4359` documents `total_cost_usd` as *"cumulative across
 * turns in streaming-input sessions — each result carries the running total so
 * far, so read the latest result rather than summing across results"*, while
 * `BaseAgent.exceedsMaxBudgetUsd` does `sessionCostUsd += costUsd` on every
 * result. This comment used to say only that, and end at "row P2.35 owns the
 * fix". The fix is `ClaudeEventAdapter.takeReportedCostDelta`, which differences
 * the running total so `usage.costUsd` carries the turn's OWN cost — the
 * increment its four consumers (this ceiling, `SessionManager`'s session total,
 * the OTLP export, the goal service) each already assumed. Before it, N
 * equal-cost turns counted N(N+1)/2·c against a true N·c and the host tripped
 * from turn TWO at roughly half the real spend; after it, both authorities count
 * the same money at the same rate and the SDK's cap — checked inside the CLI,
 * able to stop a query mid-turn — is again the finer of the two.
 *
 * SECOND, when the CLI cannot price the upstream, NEITHER authority fires — and
 * as of **P2.36** the session is TOLD SO instead of being left to assume it is
 * under budget. The host loop's only cost input on this backend is the SDK's own
 * number: `event-adapter.ts` derives `costUsd` from `msg.total_cost_usd` on the
 * terminal result and nowhere else (`usage_update` carries input tokens and a
 * context window, never a cost), and the shared classifier requires a `reported`
 * verdict. An upstream reporting no cost leaves that total at 0, so every
 * difference is 0 too and P2.35's fix neither closed nor widened this. So a
 * gateway or subscription upstream reporting no cost fails to trip the SDK's
 * ceiling AND leaves `sessionCostUsd` at zero forever: those sessions are capped
 * by nobody, which is the opposite of what this comment once promised.
 *
 * What P2.36 changed is the HONESTY of that state, not the enforcement — the
 * cost does not exist, so no cap can be manufactured from it, and inventing a
 * price table would only make the cap fire on fiction. Two edits carry it: the
 * adapter's `costReporting` is now `claudeCostReporting(msg.total_cost_usd)`
 * rather than an unconditional `'reported'` (an unpriced upstream says
 * `unsupported`, exactly as Pi's does), and `BaseAgent` yields a one-per-session
 * `info`/`warning` naming the configured ceiling and the reason it cannot be
 * enforced. A PRICED session is untouched by the NOTICE — and P2.129 widened
 * that: a crashed turn's zeroed total is an artifact rather than a verdict about
 * the runtime, so a crash no longer latches the notice on a priced session
 * either.
 *
 * It is NOT untouched by the `costReporting` half, and the sentence that used to
 * end this paragraph ("A PRICED session is untouched by both") claimed it was.
 * Any turn this CLI could not price — a crashed one included — puts
 * `unsupported` on the wire, and `mergeCostReporting` folds that against a
 * `reported` verdict to `partial` for the rest of the session's life. Measured,
 * that is order-independent rather than a first-turn quirk: `unsupported` before
 * or after `reported` both give `partial`, and both directions are already
 * pinned ("becomes partial when turns disagree, and stays partial after",
 * `telemetry/cost-reporting.test.ts`).
 *
 * And it should stay that way, which is why only the notice was ever fixed.
 * `agent-sdk/cost-tracking.md` §"Recover totals after a session crash" (fetched
 * 2026-08-27) says that result *"may carry zeroed `usage`, `total_cost_usd`, and
 * `modelUsage`"* — MAY, so the zeros are an artifact of the crash and not
 * evidence that nothing was spent, and the absence of assistant messages is no
 * better evidence: a request can be billed and its response lost with the
 * process. The page's own fallback recovers only *"the main loop's input and
 * cache tokens"* and says outright that *"Subagent usage isn't recoverable this
 * way, and neither are output tokens or USD cost"*. So the two halves point in
 * OPPOSITE directions: the notice guard WITHHOLDS an assertion under
 * uncertainty, while making the display say `reported` would MAKE one. `partial`
 * renders a conservative qualifier on a true number; the notice was a false
 * sentence, persisted as a `level:'warning'` transcript row that survived reload
 * and was never retracted. Only the second was a defect.
 *
 * What DOES survive as the reason to keep the host loop is the SCOPE of the
 * SDK's counter: it is PER CHILD. Every respawn this backend performs — a
 * drifted construction option, a refused live setter, a source activation, the
 * reaper — starts a new query whose budget begins again at zero, while
 * `BaseAgent.sessionCostUsd` persists across all of them. That reason alone is
 * sufficient: without a session-scoped authority, a session could respawn its
 * way past any ceiling. The two are complementary in scope rather than
 * redundant, and that much was true before either correction above.
 *
 * That scope is also what P2.35's fix had to respect: the running total the
 * adapter differences against is per CHILD too, so `ensureLiveSession` clears it
 * on the spawn line beside `resetBackgroundTaskLevel()` while leaving
 * `sessionCostUsd` alone. Each child then contributes its own final total to the
 * session exactly once, and the host counter remains the sum over children.
 *
 * Arming the SDK with the REMAINING budget instead (`cap - sessionCostUsd`)
 * would fix that asymmetry and break something worse: the value would change on
 * every priced turn, and since it is hashed into the signature, every turn would
 * respawn — the one-process-per-message shape L2 removed.
 *
 * ## How a HOST verdict reaches the transcript — not through the reader
 *
 * This comment used to route it through `runLiveReader`'s interrupt seam. That
 * path is DEAD for `MaxBudgetUsd`. On this backend the only event that can carry
 * a cost is the terminal `complete`, and the reader has already called
 * `slot.close('terminal', event)` before the consumer drains it — `close()` sets
 * `stop` synchronously, so the slot reports `settled` by the time
 * `BaseAgent.chat` sees the event at all. The host then yields
 * `{ ...event, terminalReason: 'max_budget_usd' }` and only AFTERWARDS calls
 * `forceAbort(AbortReason.MaxBudgetUsd)`, which dispatches to
 * `interruptLiveTurn` and returns at once on its `slot.settled` guard. So that
 * spread on the host's own yield is the whole mechanism.
 *
 * The reader's `MaxBudgetUsd` arm is therefore reachable only by a cap raised
 * while a turn is still open, which nothing in production does — it is exercised
 * by `claude-live-settings.test.ts`, which aborts mid-script. Its `UserStop`
 * sibling IS live, from `cancelProcessing` during a turn. Keep the arm (it costs
 * nothing and the dispatch is shared), but do not describe it as the fallback
 * that saves an unpriced session: nothing saves one — P2.36 above makes the
 * session say so, which is the only honest thing available.
 *
 * Double-reporting is structurally impossible rather than merely unlikely:
 * `terminalReason` is ONE field on the ONE terminal `complete` a turn produces,
 * both authorities write the SAME value, and `SessionManager.sendMessage` stops
 * at the first `complete`. When the SDK's verdict arrives first the event
 * already carries the reason, so `BaseAgent.chat` leaves it alone (its
 * hold-back arm is `complete && !terminalReason`); when the host fires on the
 * same event it spreads the identical reason onto it. Everything downstream
 * keys off that single field — including P2.5's subagent sweep, which
 * `SessionManager` fires on `terminalReason === 'max_budget_usd'` — so the SDK's
 * verdict now reaches it too, once, on the same path the host verdict uses.
 *
 * NOT armed: `queryLlm` and `runMiniCompletion` build their own one-shot
 * queries. A per-query ceiling there would mean "this single call may spend the
 * whole session's budget", which is a different promise from the one the config
 * makes, and neither call's cost reaches `sessionCostUsd` today anyway.
 */
export function buildClaudeMaxBudgetUsdOptions(maxBudgetUsd: number): Pick<Options, 'maxBudgetUsd'> {
  if (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0) return {};
  return { maxBudgetUsd };
}

/**
 * P3.264 — THE MODEL FALLBACK A CLAUDE TURN DID NOT HAVE, FROM EITHER SIDE.
 *
 * The host owns a fallback CHAIN (`config/fallback-model-chain.ts`,
 * `resolveFallbackModelChain`) and until this row only ONE runtime read it:
 * `PiAgent.getFallbackModel`. `Options.fallbackModel` was never set, so a claude
 * turn whose model was overloaded had no fallback of either kind — the inverse
 * of a thin-host violation, host machinery that exists and reaches nothing.
 *
 * Native-first, and the residual the row anticipated is REFUTED at 0.3.233.
 * `model-config.md#fallback-model-chains`: *"Set a chain for one session with
 * the `--fallback-model` flag, which accepts a comma-separated list"*, and
 * `Options.fallbackModel`'s own typing says the same — *"Fallback model(s) to
 * use if the primary model is overloaded or unavailable. Accepts a
 * comma-separated list to try each in order."* The bundle spends it as one argv
 * pair (`sdk.mjs`: `Y.push("--fallback-model",h)`), so the whole ladder crosses
 * in one string. There is no ladder-vs-one-step residue to state; the residue is
 * elsewhere, and it is listed below.
 *
 * THE PRIMARY MUST BE FILTERED OUT OR THE QUERY THROWS, and the throw is the
 * SDK's, before any child starts:
 * `if(h){if(m&&h===m)throw Error("Fallback model cannot be the same as the main
 * model. Please specify a different model for fallbackModel option.")}`. The
 * guard is a whole-string comparison against `options.model`, so a chain that
 * merely CONTAINS the primary slips past it and simply wastes its first attempt
 * — worse than a throw, because it is silent. Both are removed here by dropping
 * every entry equal to the effective model before joining.
 *
 * BOTH SIDES ARE COMPARED WITH THE `[1m]` SELECTOR STRIPPED (F1.1241 follow-up).
 * `options.model` carries `[1m]` for every 1M `claude-` id while chain entries
 * stay bare (stored ids never hold it), so `claude-opus-4-6` beside a primary of
 * `claude-opus-4-6[1m]` is the same model and the same wasted attempt; it is
 * dropped, as Pi's chain walk skips the current model. Kept entries stay as written.
 *
 * RESIDUE, stated rather than hidden:
 *  - The page says *"Claude Code caps chains at three models after duplicate
 *    removal and ignores extra entries"* and the host's own
 *    `FALLBACK_MODEL_CHAIN_LIMIT` is 3, so the cap is applied twice and agrees.
 *  - `Settings.fallbackModel` is `string[]` while `Options.fallbackModel` is a
 *    comma-joined `string`; we write the option, not the setting, because the
 *    setting is a file the user owns and this value is per-session.
 *  - The chain is a CONSTRUCTION option — no `Query` member moves it — so a
 *    changed chain must respawn the live child. {@link claudeLiveSessionSignature}
 *    hashes it for exactly that reason.
 *  - The page also records what no host code can fix: *"Claude Code doesn't
 *    confirm the chain at startup and `/status` doesn't display it."* The only
 *    visible sign is the switch notice, so a misconfigured chain is invisible
 *    until it fires. The debug line at the call site is the host's half of that.
 */
/**
 * P3.269 — THE SDK'S OWN ELICITATION SEAM, ROUTED TO THE ONE HOST HANDLER.
 *
 * ## The duplication the row named is REFUTED, and the reason matters
 *
 * The coverage analysis filed `ElicitationAskUserBridge` + the two host hook
 * events as a duplicate of `Options.onElicitation`. Measured at HEAD, they do
 * not overlap at all: **every entry of `Options.mcpServers` on this path is
 * built by `createSdkMcpServer`** — `session` plus one per source, each a
 * `{ type: 'sdk', instance }` proxy whose tool calls go through the host's own
 * `McpClientPool`. The CLI therefore holds no MCP connection of its own to the
 * servers we configure, and `onElicitation` can never fire for one of them. The
 * host bridge is not a second implementation; it is the only reachable one,
 * because the host owns every real MCP connection on all three runtimes.
 *
 * ## Wiring it anyway, for the case the refutation does NOT cover
 *
 * `strictMcpConfig` is not set on this path, so the CLI still performs its own
 * MCP config discovery beside the servers we hand it. Anything it connects to
 * that way is a REAL server, and the SDK's default for one is stated in its own
 * typing: *"If not provided, elicitation requests that aren't handled by hooks
 * will be declined automatically."* An automatic decline with no user, no
 * transcript line and no log is the exact shape this plan calls a silent
 * divergence — so the callback is wired to the same handler the pool uses, and
 * the two paths cannot answer differently.
 *
 * Costless when unreachable: an option the CLI never invokes is bytes in the
 * spawn payload. `null` is a legal return meaning *the host declines to answer*,
 * which is what a bridge failure degrades to rather than hanging the server.
 */
export function toClaudeElicitRequest(request: ElicitationRequest): ElicitRequest {
  return {
    method: 'elicitation/create',
    params: {
      message: request.message,
      // The MCP request type requires a schema; the SDK marks it form-only, so a
      // URL elicitation legitimately carries none and gets the empty object the
      // host's own URL route already ignores.
      requestedSchema: request.requestedSchema ?? { type: 'object', properties: {} },
      ...(request.mode === undefined ? {} : { mode: request.mode }),
      ...(request.url === undefined ? {} : { url: request.url }),
      ...(request.elicitationId === undefined ? {} : { elicitationId: request.elicitationId }),
    } as ElicitRequest['params'],
  };
}

export function buildClaudeFallbackModelOptions(
  chain: readonly string[],
  effectiveModel: string,
): Pick<Options, 'fallbackModel'> {
  const usable = chain.filter(entry => typeof entry === 'string' && entry.trim().length > 0)
    .map(entry => entry.trim())
    .filter(entry => stripClaudeModelSelectorSuffix(entry) !== stripClaudeModelSelectorSuffix(effectiveModel));
  if (usable.length === 0) return {};
  return { fallbackModel: usable.join(',') };
}

/**
 * The config `ClaudeAgent` accepts — `BackendConfig` with `provider` optional,
 * because this class IS the anthropic provider and fixes it itself.
 *
 * DERIVED, never hand-listed. This declaration used to enumerate ~25 fields and
 * the constructor copied them one at a time into a fresh `BackendConfig`, so a
 * field that existed on `BackendConfig` and not on that list was DELETED for
 * every Claude session, silently, however correctly `SessionManager` filled it.
 * `PiAgent` and `CodexAgent` take their `BackendConfig` straight to
 * `super(config, …)`, so such a field reached two runtimes of three.
 *
 * That cost real behaviour, not just tidiness — 42 of the 67 fields were being
 * dropped. Q8-D3 (`piRuntimeAgentDefinitions`) was only the one that got
 * noticed: the definitions were materialized for `provider: 'anthropic'`,
 * handed to `createBackend`, and deleted here, so the SDK kept answering
 * `Agent type '<ours>' not found`. Behind it sat a trusted project silently
 * treated as untrusted, a shared MCP pool torn down by one session's
 * `destroy()`, a disabled 1M-context setting that never applied, and images
 * refused instead of resized (`.superpowers/sdd/q11-claude-projection-report.md`).
 *
 * Per-field documentation lives on `BackendConfig` — one copy, not two.
 * `claude-config-projection.test.ts` re-derives this field set from the
 * interface's own source and fails if any member stops reaching the agent, so a
 * field added tomorrow cannot be dropped by omission again.
 */
export type ClaudeAgentConfig = Omit<BackendConfig, 'provider'> & { provider?: AgentProvider };

// Permission request tracking
interface PendingPermission {
  /**
   * P6.951 — `comment` is the note the user attached to a DENIAL, and it travels
   * here rather than being read back off the card, because the two waiters are
   * different promises settled from one place (`respondToPermission`).
   */
  resolve: (allowed: boolean, alwaysAllow?: boolean, comment?: string) => void;
  toolName: string;
  command: string;
  baseCommand: string;
  type?: 'bash' | 'safe_mode';  // Type of permission request
  /**
   * C3.312 — do NOT put this card's answer into the host's own command
   * whitelist.
   *
   * Set for the `claude_native` cards `askToolApproval` raises, for the reason
   * that method's own docblock already states: on this runtime the SDK's rules
   * are what raised the prompt, and "our own session whitelist cannot suppress a
   * prompt the SDK's rules raise". Worse than inert — the `command` on such a
   * card is a file path or the runtime's `blockedPath` for everything but Bash,
   * so `getBaseCommand` of it is not a command and whitelisting it is a junk
   * entry in a store a user can inspect. The grant that DOES take effect is the
   * runtime's own session rule, echoed through
   * {@link claudeSessionPermissionUpdateBoundary}.
   *
   * Byte-identical to HEAD when it was introduced: the button was withheld on
   * every such card, so `alwaysAllow` was never true on this path.
   */
  suppressHostCommandWhitelist?: boolean;
}

// P3.375 — `DANGEROUS_COMMANDS`, a twenty-name "always require permission"
// list, was declared here and read by nothing. Deleted rather than wired,
// because wiring it would add a SECOND authority over the same call: every
// permission decision on this runtime goes through `runPreToolUseChecks`
// (the centralized pipeline), which has its own read-only classifier and its
// own floors. The list is recorded here rather than silently removed because
// its SHAPE was a safety claim — a reader grepping for `rm` in this file found
// it and could conclude the runtime special-cases destructive commands from
// here. It did not, and does not.

// ============================================================
// Global Tool Permission System
// Used by both bash commands (via agent instance) and MCP tools (via global functions)
// ============================================================

interface GlobalPendingPermission {
  resolve: (allowed: boolean) => void;
  toolName: string;
  command: string;
}

const globalPendingPermissions = new Map<string, GlobalPendingPermission>();

// Handler set by application to receive permission requests
let globalPermissionHandler: ((request: { requestId: string; toolName: string; command: string; description: string }) => void) | null = null;

/**
 * Set the global permission request handler (called by application)
 */
export function setGlobalPermissionHandler(
  handler: ((request: { requestId: string; toolName: string; command: string; description: string }) => void) | null
): void {
  globalPermissionHandler = handler;
}

/**
 * Request permission for a tool operation (used by MCP tools)
 * Returns a promise that resolves to true if allowed, false if denied
 */
export function requestToolPermission(
  toolName: string,
  command: string,
  description: string
): Promise<boolean> {
  return new Promise((resolve) => {
    const requestId = `perm-${toolName}-${Date.now()}`;

    globalPendingPermissions.set(requestId, {
      resolve,
      toolName,
      command,
    });

    if (globalPermissionHandler) {
      globalPermissionHandler({ requestId, toolName, command, description });
    } else {
      // No handler - deny by default
      globalPendingPermissions.delete(requestId);
      resolve(false);
    }
  });
}

/**
 * Resolve a pending global permission request (called by application)
 */
export function resolveGlobalPermission(requestId: string, allowed: boolean): void {
  const pending = globalPendingPermissions.get(requestId);
  if (pending) {
    pending.resolve(allowed);
    globalPendingPermissions.delete(requestId);
  }
}

/**
 * Clear all pending global permissions (called on workspace switch)
 */
export function clearGlobalPermissions(): void {
  globalPendingPermissions.clear();
}

/**
 * Create an in-process MCP server that proxies source tool calls through the McpClientPool.
 * This replaces direct MCP connections — the pool owns all source connections centrally.
 *
 * Returns a McpSdkServerConfigWithInstance that can be added to Options.mcpServers.
 */

const MAX_SCHEMA_DEPTH = 5;

/**
 * Convert a JSON Schema property to a Zod type (oneOf/anyOf unions, nested objects, typed arrays, allOf
 * merges, enums) so the LLM sees the full parameter structure instead of z.unknown(). F1.998: zod 4's z.enum
 * keeps strings only (drops a number as a TS reverse-mapping key). F1.1095: an object/array member is left to the server.
 */
export function jsonPropToZod(prop: any, depth = 0): z.ZodTypeAny {
  if (!prop || typeof prop !== 'object') return z.unknown();
  if (depth >= MAX_SCHEMA_DEPTH) return z.unknown();

  // Attach description if present
  const withDesc = (zodType: z.ZodTypeAny): z.ZodTypeAny =>
    prop.description ? zodType.describe(prop.description) : zodType;

  // Enum — all-string stays z.enum; numeric/mixed is ONE z.literal (F1.998); z.literal compares an object or array by identity, so such an enum is offered as written (`.meta`) and checked by the server (F1.1095)
  if (prop.enum && Array.isArray(prop.enum) && prop.enum.length > 0) {
    return withDesc(prop.enum.some((v: unknown) => typeof v === 'object' && v !== null) ? z.unknown().meta({ enum: prop.enum }) : prop.enum.every((v: unknown) => typeof v === 'string') ? z.enum(prop.enum as [string, ...string[]]) : z.literal(prop.enum));
  }

  // oneOf / anyOf — discriminated or plain unions
  const unionVariants = prop.oneOf ?? prop.anyOf;
  if (Array.isArray(unionVariants) && unionVariants.length > 0) {
    const members = unionVariants.map((v: any) => jsonPropToZod(v, depth + 1));
    if (members.length === 1) return withDesc(members[0]!);
    return withDesc(z.union(members as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]));
  }

  // allOf — merge into a single object shape
  if (Array.isArray(prop.allOf) && prop.allOf.length > 0) {
    const mergedProps: Record<string, any> = {};
    const mergedRequired: string[] = [];
    for (const sub of prop.allOf) {
      if (sub.properties) Object.assign(mergedProps, sub.properties);
      if (Array.isArray(sub.required)) mergedRequired.push(...sub.required);
    }
    if (Object.keys(mergedProps).length > 0) {
      return withDesc(jsonPropToZod({
        type: 'object',
        properties: mergedProps,
        required: mergedRequired,
        description: prop.description,
      }, depth));
    }
    // Fallback: if allOf doesn't have properties, take the first variant
    return withDesc(jsonPropToZod(prop.allOf[0], depth + 1));
  }

  switch (prop.type) {
    case 'string':
      return withDesc(z.string());
    case 'number':
    case 'integer':
      return withDesc(z.number());
    case 'boolean':
      return withDesc(z.boolean());
    case 'array': {
      const itemSchema = prop.items
        ? jsonPropToZod(prop.items, depth + 1)
        : z.unknown();
      return withDesc(z.array(itemSchema));
    }
    case 'object': {
      // Nested object with known properties → build z.object({...})
      if (prop.properties && typeof prop.properties === 'object') {
        const shape = jsonSchemaToZodShape(prop, depth + 1);
        const obj = z.object(shape);
        // JSON Schema defaults additionalProperties to true when omitted.
        // Only use strict (strip) mode when explicitly set to false.
        if (prop.additionalProperties === false) {
          return withDesc(obj);
        }
        // P3.375 — was `obj.passthrough()`. zod 4.4.3 marks it
        // `@deprecated Use z.looseObject() or .loose() instead`, and the two
        // declarations return the SAME type (`ZodObject<Shape, core.$loose>`),
        // so this is a rename and not a behaviour change. `.loose()` is chosen
        // over `z.looseObject(shape)` because the shape is already built above.
        return withDesc(obj.loose());
      }
      // Generic object (no properties defined)
      return withDesc(z.record(z.string(), z.unknown()));
    }
    default:
      return withDesc(z.unknown());
  }
}

function jsonSchemaToZodShape(schema: Record<string, unknown>, depth = 0): Record<string, z.ZodTypeAny> {
  const properties = (schema.properties as Record<string, any>) || {};
  const required = new Set((schema.required as string[]) || []);
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, prop] of Object.entries(properties)) {
    let zodType = jsonPropToZod(prop, depth);
    if (!required.has(key)) zodType = zodType.optional();
    shape[key] = zodType;
  }

  return shape;
}

/**
 * Create one SDK MCP server per connected source, using original tool names.
 *
 * Exported ONLY so the instructions contract can be pinned directly
 * (`__tests__/source-proxy-instructions.test.ts`); nothing outside this module
 * calls it.
 * The SDK adds its own `mcp__{serverKey}__` prefix, so we use the source slug
 * as the server key and original tool names to get the correct final names
 * (e.g., `mcp__linear__createIssue`).
 */
/**
 * D1.201 — the host's MCP tool wall clock, in the SDK's own per-server key.
 *
 * SDK 0.3.251 gives every MCP server config a `timeout` and adds an
 * `sdkMcpServerConfigs` field to `initialize` that carries it for the in-process
 * `type:'sdk'` servers, which is every entry this fork supplies. `sdk.mjs`
 * builds it as `Array.from(this.sdkMcpServers).flatMap(([s,{timeout:i}]) =>
 * i!==void 0?[[s,{timeout:i}]]:[])`, so the ONLY way to fill it is
 * `createSdkMcpServer({ timeout })`. Both names had 0 readers in this tree.
 *
 * The row asked whether the host has a per-server timeout to project. It has
 * TWO, and only one of them is reachable here:
 *
 * - a per-SERVER `toolTimeoutMs`, from `.mcp.json`'s `timeout`
 *   (`mcp/project-config.ts`), from source definitions and from plugin-imported
 *   servers. NOT projected, and that is a residue rather than a decision:
 *   `createSourceProxyServers` holds the pool, not its private per-slug
 *   configs, so reaching it is a pool surface this row did not ask for.
 * - the SESSION ceiling behind `NESSY_MCP_TOOL_TIMEOUT` (compat spelling
 *   `MCP_TOOL_TIMEOUT`), which is what this projects.
 *
 * MIRRORED FROM `CodexAgent.codexMcpToolTimeoutOption`, deliberately and
 * line-for-line in its reasoning, because one user-owned setting must not mean
 * different things per runtime — codex has projected this since P3.348 and
 * claude projected nothing:
 *
 * - EXPLICIT-SET-ONLY, through the pool's OWN reader, so a name that is present
 *   but blank counts as unset here exactly as it does there.
 * - the enormous documented default (`MCP_DEFAULT_TOOL_TIMEOUT_MS`, ~28 hours,
 *   chosen so it changes nothing at rest) is DROPPED rather than projected. An
 *   operator who typed that number exactly gets the same answer, and it is the
 *   right one: they asked for the ceiling that changes nothing.
 * - the value is deliberately LOOSER than the host's own, by the same one
 *   second codex adds. The same call is already bounded by `McpPool`'s
 *   `defaultToolTimeoutMs` read from this same lever, and the two must not
 *   race: the host's abort names the server and the tool (P6.26), the SDK's
 *   names neither. So this is a BACKSTOP for a host bound that failed, not a
 *   second deadline.
 *
 * One consequence worth stating because it is the reason a smaller margin would
 * be wrong: the SDK's `timeout` is documented as a *"Hard wall-clock limit per
 * call; progress notifications do not extend it"*, while the host pool's own
 * idle timeout IS reset by progress. A tool that is demonstrably alive must
 * keep running, so the SDK copy has to sit strictly outside the host's.
 */
export function claudeSdkMcpServerTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  const reading = readMcpTimeoutEnv(env, MCP_TOOL_TIMEOUT_ENV, MCP_TOOL_TIMEOUT_COMPAT_ENV);
  if (!reading) return undefined;
  const hostCeilingMs = mcpDefaultToolTimeoutMsFromEnv(env);
  if (hostCeilingMs >= MCP_DEFAULT_TOOL_TIMEOUT_MS) return undefined;
  return hostCeilingMs + 1000;
}

/**
 * D1.219 — the FINER of the host's two tool wall clocks, per server.
 *
 * D1.201 named the residue it was leaving: a per-SERVER `toolTimeoutMs` — from
 * `.mcp.json`'s `timeout`, from source definitions, from plugin-imported servers
 * — existed and could not be reached from the proxy build. `McpClientPool.
 * toolTimeoutMsForSlug` is that reach; this is the arithmetic, and it is the
 * SAME arithmetic, because the two values mean the same thing to the pool.
 *
 * WHICH ONE WINS IS NOT A CHOICE MADE HERE — it is read off the call path.
 * `McpClientPool.callTool` bounds a call at
 * `activeConfigs.get(key)?.toolTimeoutMs ?? defaultToolTimeoutMs`, so a server
 * with its own value is bounded by THAT and the session ceiling never applies to
 * it. Projecting the ceiling for such a server would put the SDK's hard wall
 * clock inside the host's bound whenever the ceiling is the tighter number, and
 * the SDK's abort names neither the server nor the tool (P6.26).
 *
 * The two rules D1.201 established are kept, for the same reasons stated there:
 * the ~28-hour documented default is DROPPED rather than projected (an operator
 * who typed it asked for the ceiling that changes nothing — and here that also
 * covers a per-server value at or above it, where any projection would be
 * tighter than the host's own bound), and the margin is the same one second, so
 * the SDK copy is a backstop for a host bound that failed rather than a second
 * deadline racing it.
 *
 * A server with NO per-server value falls through to the session projection
 * byte-for-byte, so every spawn built before this row is unchanged.
 *
 * The session projection is PASSED IN rather than recomputed, so the build keeps
 * reading the environment exactly once — the property `createSourceProxyServers`
 * stated when D1.201 hoisted that read out of the loop.
 */
export function claudeSdkMcpServerTimeoutForServer(
  perServerToolTimeoutMs: number | undefined,
  sessionProjectionMs: number | undefined,
): number | undefined {
  if (perServerToolTimeoutMs === undefined) return sessionProjectionMs;
  if (perServerToolTimeoutMs >= MCP_DEFAULT_TOOL_TIMEOUT_MS) return undefined;
  return perServerToolTimeoutMs + 1000;
}

/**
 * UB3.9 (upstream v0.15.1 `SOURCE_TOOL_INTENT`): every source proxy declares
 * `_intent` so the model states its purpose per call — it steers large-result
 * handling and labels the tool card; the Claude CLI runs no network
 * interceptor to inject it, so the proxy asks.
 *
 * DESCRIBED as required, TOLERATED when absent: the field is schema-OPTIONAL
 * (upstream's literal is shape-required — the deviation is deliberate, logged
 * for this row) so a call whose `_intent` a stale gate snapshot stripped — or
 * that the model simply omitted — still dispatches (B1-03: the #1086 class
 * must not recur). The handler's `typeof` guard is the second net.
 */
const SOURCE_TOOL_INTENT = z
  .string()
  .optional()
  .describe('REQUIRED: What you are trying to accomplish with this call (1-2 sentences)');

export function createSourceProxyServers(
  pool: McpClientPool,
  context?: {
    leaserId?: string;
    sessionPath?: string;
    summarize?: (prompt: string) => Promise<string | null>;
  },
): Record<string, ReturnType<typeof createSdkMcpServer>> {
  const servers: Record<string, ReturnType<typeof createSdkMcpServer>> = {};
  // D1.201 — read ONCE for the whole build: it is a session-level ceiling, and
  // a per-server read would suggest a per-server answer this seam cannot give.
  const sdkServerTimeoutMs = claudeSdkMcpServerTimeoutMs();

  // Scope the exposed sources to THIS session's leased slugs on a shared pool;
  // absent a leaserId, expose the whole connected union (pre-sharing behavior).
  const slugs = context?.leaserId ? [...pool.slugsForLeaser(context.leaserId)] : pool.getConnectedSlugs();
  // P2.454 — the user's `alwaysLoad` pin, which this seam carried to the pool
  // and then dropped. One pool read for the whole build, over exactly the slugs
  // being exposed, the same shape `pi-agent.ts` uses.
  const alwaysLoadNames = pool.alwaysLoadProxyToolNames(slugs, context?.leaserId);
  for (const slug of slugs) {
    const mcpTools = pool.getTools(slug, context?.leaserId);
    // The server's own `instructions`, which the SDK surfaces to the model as an
    // MCP instructions block. `CreateSdkMcpServerOptions.instructions` says it
    // verbatim: "When proxying a real MCP server through the SDK transport, pass
    // the underlying server's `getInstructions()` here so it isn't dropped." We
    // proxied every source and passed none, so on claude-runtime half of what
    // `mcp.md#scale-with-mcp-tool-search` loads at session start — "Only tool
    // names and server instructions load at session start" — never arrived.
    const instructions = pool.getInstructions(slug, context?.leaserId);
    // A zero-tool source used to contribute NO server at all. That is still
    // right when it has nothing to say, but a resources/prompts-only source has
    // no other channel here — the in-process SDK server type has no `resources`
    // or `prompts` field (P6.25, pinned in `mcp-context-runtime-reach.test.ts`)
    // — so instructions are the only thing it could ever contribute.
    if (mcpTools.length === 0 && !instructions) continue;

    // D1.219 — per SERVER, from the pool's own reader, falling through to the
    // session projection computed once above when this server set nothing.
    const perServerSdkTimeoutMs = claudeSdkMcpServerTimeoutForServer(
      pool.toolTimeoutMsForSlug(slug, context?.leaserId),
      sdkServerTimeoutMs,
    );

    const proxyTools = mcpTools.flatMap(mcpTool => {
      // registerClient is the naming authority: read the registered proxy name
      // (sanitized + collision-safe) instead of recomputing it, so callTool
      // routing and the model-visible name stay in sync (#864).
      const proxyName = pool.getProxyName(slug, mcpTool.name, context?.leaserId);
      // The SDK prepends `mcp__{serverKey}__`; serverKey is the slug, so the
      // tool arg must be the sanitized segment (proxyName minus that prefix).
      const toolSegment = proxyName.slice(`mcp__${slug}__`.length);
      // F1.557 — a root anyOf/oneOf/allOf is flattened first, or this one tool is skipped.
      const input = claudeProxyToolInput(slug, mcpTool);
      if (!input) return [];
      return [tool(
        toolSegment,
        input.description,
        {
          ...jsonSchemaToZodShape(input.inputSchema),
          _intent: SOURCE_TOOL_INTENT,
        },
        async (args: Record<string, unknown>) => {
          // UB3.9: the model's stated purpose rides to the pool (it steers the
          // large-result summariser). Tolerated when absent — see
          // {@link SOURCE_TOOL_INTENT}; `_intent` itself never reaches the
          // pool's args, so API sources cannot confuse the copies.
          const { _intent, ...callArgs } = args;
          const result = await pool.callTool(proxyName, callArgs, undefined, {
            ...(context?.sessionPath ? { sessionPath: context.sessionPath } : {}),
            ...(context?.summarize ? { summarize: context.summarize } : {}),
            ...(context?.leaserId ? { leaserId: context.leaserId } : {}),
            ...(typeof _intent === 'string' && _intent ? { intent: _intent } : {}),
          });
          return {
            content: [{ type: 'text' as const, text: result.content }],
            ...(result.isError ? { isError: true } : {}),
          };
        },
        // P2.454 — PER TOOL, and deliberately not per server.
        //
        // `mcp.md#exempt-a-server-from-deferral` gives both spellings: *"If a
        // server's tools should always be visible to Claude without a search
        // step, set `alwaysLoad` to `true` in that server's configuration"*,
        // and *"An MCP server can also mark individual tools as always-loaded
        // by including `"anthropic/alwaysLoad": true` in the tool's `_meta`
        // object, which has the same effect for that tool only."*
        // `alwaysLoadProxyToolNames` is the UNION of the two — a server-level
        // config pin expands to all of that server's tools inside the pool —
        // so writing the server-level flag here would pin a whole source
        // whenever one tool asked. The SDK says the two are OR'd
        // (`CreateSdkMcpServerOptions.alwaysLoad`: *"Per-tool
        // `tool({ alwaysLoad })` still works and is OR'd with this"*), so
        // passing both is not belt-and-braces, it is over-pinning.
        //
        // An unpinned tool passes `{}`, which is byte-identical to omitting the
        // argument: the vendored `tool()` builds `_meta` only from the two hint
        // keys and returns `_meta: Object.keys(i).length>0?i:void 0`.
        { ...(alwaysLoadNames.has(proxyName) ? { alwaysLoad: true } : {}) },
      )];
    });

    servers[slug] = createSdkMcpServer({
      name: `source-proxy-${slug}`,
      version: '1.0.0',
      ...(instructions ? { instructions } : {}),
      tools: proxyTools,
      // D1.201 + D1.219 — see `claudeSdkMcpServerTimeoutForServer`. The SERVER's
      // own wall clock where it has one, the session ceiling where it does not,
      // which is the order the pool's own call path resolves them in. Absent
      // when neither is set, so the spawn is byte-identical to one built before
      // either row.
      ...(perServerSdkTimeoutMs !== undefined ? { timeout: perServerSdkTimeoutMs } : {}),
    });
  }

  // P6.139 — the leased sources' RESOURCES, on the one SDK seam that can carry
  // them. The per-source proxies above are built by `createSdkMcpServer`, whose
  // option type is tools-only (P6.25 read that as `cannot-at-this-seam`; the
  // seam it measured was the FACTORY). `McpSdkServerConfigWithInstance` accepts
  // a whole `McpServer`, so the resources ride ONE extra server rather than
  // being spread across the per-source ones — the same shape codex's own
  // resource surface takes, with the same `<slug>__<name>` flattening and the
  // same routing, extracted rather than re-derived.
  //
  // Registered UNCONDITIONALLY, for the reason its own docblock gives: MCP
  // carries capabilities in the `initialize` result and has no notification that
  // revises them, so gating registration on "does a leased source advertise a
  // resource right now" would pin the answer at the handshake and make a source
  // that connects afterwards permanently unreachable. An empty `resources/list`
  // is TRUE-empty; a missing server is a resource that exists and cannot be
  // read.
  servers[POOLED_RESOURCE_SERVER_NAME] = createPooledResourceSdkServer(pool, {
    ...(context?.leaserId ? { leaserId: context.leaserId } : {}),
  });

  return servers;
}

// buildWindowsSkillsDirError is now in backend/claude/event-adapter.ts (exported)
const buildWindowsSkillsDirError = buildWindowsSkillsDirErrorFn;

/**
 * R14 — the post-compaction context size, from the SDK message that reports a
 * compaction, or `null`.
 *
 * `SDKCompactBoundaryMessage.compact_metadata` carries `pre_tokens` (required)
 * and `post_tokens` (OPTIONAL). This is the ONLY place the post-compaction
 * context size appears anywhere in the SDK's output — the result message that
 * follows reports the compaction request's own consumption, which is the whole
 * pre-compaction conversation — and until R14 nothing in this repo read
 * `compact_metadata` at all: the event adapter turns the message into
 * `info: 'Compacted Conversation'` and drops the metadata.
 *
 * `post_tokens` being optional is the reason for the `null` arm rather than a
 * fallback. `pre_tokens` is deliberately NOT substituted: it is the size the
 * conversation had BEFORE compaction, so using it would restate the exact
 * number the banner is telling the user is no longer true.
 *
 * Typed against `SDKCompactBoundaryMessage` rather than a `any` cast so a
 * rename of `compact_metadata` or `post_tokens` fails at compile time — the
 * repo has shipped two production bugs from vendor renames landing silently.
 */
function readPostCompactionTokens(
  message: unknown,
): { postTokens: number; trigger: SDKCompactBoundaryMessage['compact_metadata']['trigger'] } | null {
  if (!message || typeof message !== 'object') return null;
  const candidate = message as Partial<SDKCompactBoundaryMessage>;
  if (candidate.type !== 'system' || candidate.subtype !== 'compact_boundary') return null;
  const postTokens = candidate.compact_metadata?.post_tokens;
  if (typeof postTokens !== 'number' || !Number.isFinite(postTokens) || postTokens <= 0) return null;
  return { postTokens, trigger: candidate.compact_metadata!.trigger };
}


/**
 * P6.207 · THE SDK'S OWN "your permission callback is shadowed" WARNING, given
 * a subscriber.
 *
 * ## What was wrong
 *
 * `agent-sdk/permissions.md` names two configurations that make `canUseTool`
 * unreachable, and the SDK announces both — `process.emitWarning(message, {
 * code: 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED' })`, re-measured 2026-09-12 (C3.252)
 * in the vendored `sdk.mjs` at `claudeCodeVersion 2.1.247` and still there —
 * 1 line / 1 occurrence, as `process.emitWarning(r,{code:"CLAUDE_SDK_CAN_USE_TOOL_SHADOWED"…`,
 * and 2/2 in the native binary. Nothing in this tree listened:
 * `process.on('warning'` scored ZERO files across `packages` and `apps`, and
 * the identifier's only two occurrences were comments. So the runtime told us
 * our host gate had been bypassed and the sentence went to Node's default
 * stderr handler — which in a packaged desktop build has no reader at all.
 *
 * ONE configuration can fire from us. `permissionMode: 'bypassPermissions'`
 * is a user's own choice, mapped straight through by `claude-permission-mode.ts`;
 * bare `allowedTools` entries have no producer since F1.638 moved an operator's
 * `sessionAllowedTools` onto `tools` (P6.724 had moved the Task tools). F1.596: the
 * bypass arm is NOT relayed verbatim any more — its sentence says `canUseTool`
 * "will not be invoked", and on 2.1.267 the CLI does invoke it for a call a user
 * ask rule matches, as the documentation says it will; the notice quotes the
 * documented rule instead ({@link formatClaudeSdkShadowWarningNotice}). The
 * other arm, and a sentence of any shape not recognised, is relayed verbatim.
 * The vendor's own words reach the debug log either way.
 *
 * ## Why a process-global listener, and what it costs
 *
 * `process.emitWarning` is a PROCESS event and it fires on `nextTick`, so it
 * can be neither caught by wrapping the `query()` call nor attributed to a
 * session: the warning carries a message and a code and nothing else. One
 * listener is installed for the process (never one per agent — that is the
 * `MaxListenersExceededWarning` this same channel would then emit) and it fans
 * out to whichever agents are subscribed.
 *
 * The residue, stated because it is invisible otherwise: with two live claude
 * sessions, a warning raised by one is delivered to both. Each session latches
 * it once through {@link ClaudeAgent.queueDegradationNotice}, so nobody sees it
 * twice — but a second session may see a sentence its own configuration did not
 * cause. The alternative was to infer the condition ourselves from the options
 * we passed, i.e. to re-derive the runtime's own answer, which is the thing
 * native-first exists to stop.
 */
const CLAUDE_SDK_CAN_USE_TOOL_SHADOWED_CODE = 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED';

const claudeSdkShadowWarningSinks = new Set<(message: string) => void>();
let claudeSdkShadowWarningListenerInstalled = false;

/**
 * Subscribe `sink` to the SDK's shadowed-callback warning; returns the
 * unsubscribe. Exported for the test, which cannot otherwise observe a
 * process-level listener without leaking one.
 */
export function subscribeToClaudeSdkShadowWarning(sink: (message: string) => void): () => void {
  if (!claudeSdkShadowWarningListenerInstalled) {
    claudeSdkShadowWarningListenerInstalled = true;
    process.on('warning', (warning: Error & { code?: string }) => {
      if (warning?.code !== CLAUDE_SDK_CAN_USE_TOOL_SHADOWED_CODE) return;
      const message = typeof warning.message === 'string' ? warning.message.trim() : '';
      if (!message) return;
      // A copy, because a sink may unsubscribe itself while we iterate.
      for (const subscriber of [...claudeSdkShadowWarningSinks]) {
        // One throwing subscriber must not silence the others, and a warning
        // handler that throws would become an uncaught exception on a tick with
        // no owner.
        try { subscriber(message); } catch { /* a sink's own failure is its own */ }
      }
    });
  }
  claudeSdkShadowWarningSinks.add(sink);
  return () => { claudeSdkShadowWarningSinks.delete(sink); };
}

export class ClaudeAgent extends BaseAgent {
  protected backendName = 'Claude';
  // Note: ClaudeAgentConfig is compatible with BackendConfig, so we use the inherited this.config
  /**
   * The ONE live SDK query for this agent.
   *
   * L2 — this used to be per-TURN: `chatImpl` created it, iterated it inline and
   * nulled it in its own `finally`. It is now per-SESSION. Nothing else about
   * the field's meaning changed, which is why `redirect`, `interruptForHandoff`,
   * `forceAbort` and `destroy` still read it by the same name.
   */
  private currentQuery: Query | null = null;
  private currentQueryAbortController: AbortController | null = null;
  /**
   * The channel the live query reads its user messages from. Ending it is EOF to
   * the child process, and therefore the graceful way to close a live session.
   */
  private liveInput: ClaudeInputChannel | null = null;
  /** `claudeLiveSessionSignature` of the options the live query was BUILT with. */
  private liveSignature: string | null = null;
  /**
   * L4 — the model, permission mode and MCP server names the live child is
   * CURRENTLY running with.
   *
   * Not "the options it was built with": each of the three has a setter, so this
   * is updated as each setter succeeds. A settings value is only ever written
   * here AFTER the CLI has acknowledged it, so a rejected setter leaves the
   * record honest and the next turn tries again (or respawns).
   */
  private liveSettings: ClaudeLiveSettings | null = null;
  /** The `resume` value the live query was created with, if any. */
  private liveResumeAnchor: string | null = null;
  /** The `session_id` the live stream reported — the conversation it is actually holding. */
  private liveObservedSessionId: string | null = null;
  /**
   * Bumped on every spawn. A reader that finds the generation changed knows it
   * was superseded and must not touch the new session's state.
   */
  private liveGeneration = 0;
  /**
   * The turn currently attached to the live reader, or `null` between turns.
   *
   * The slot is `chatImpl`-scoped, NOT `chat()`-scoped: one `chat()` carrying a
   * model-emitted `[skill:…]` enters `chatImpl` twice and earns two SDK results.
   * The passes are strictly sequential, so one open slot per agent still holds.
   */
  private openSlot: ClaudeTurnSlot | null = null;
  /** {@link INTERRUPT_DEADLINE_MS}, overridable so a test need not wait it out. */
  private interruptDeadlineMs = INTERRUPT_DEADLINE_MS;
  /** True while `chatImpl` prepares with no slot open yet (`ensureLiveSession`, F1.540's own-turn wait). */
  private turnPreparing = false;
  /** A Stop that arrived in that window, honoured as soon as the await returns. */
  private stopRequestedWhilePreparing = false;
  private lastAbortReason: AbortReason | null = null;
  private sessionId: string | null = null;
  // Whether the most recent user turn included image/PDF attachments. Read by
  // mapSDKErrorToTypedError to decide whether attachment-related hints belong
  // in the invalid_request error message.
  private lastTurnHadAttachments: boolean = false;
  private branchFromSdkSessionId: string | null = null;
  private branchFromSdkCwd: string | null = null;
  private branchFromSdkTurnId: string | null = null;
  /**
   * T2 · the anchor this turn suppressed the text handoff FOR.
   *
   * Set by {@link shouldSuppressTextHandoff} at the top of a turn, while
   * `this.sessionId` still holds the id the rebuild minted; read when the SDK
   * reports the session it is actually holding. Non-null means "a rebuilt
   * transcript is in force this turn and the handoff is still owed"; the
   * comparison against the reported id is the whole read-back arm.
   */
  private rebuiltTranscriptAnchor: string | null = null;
  private isHeadless: boolean = false;
  /**
   * A `/compact` the MODEL asked for through `SlashCommand`, parked until the
   * turn it was requested in has drained.
   *
   * The tool handler runs MID-turn, and only Pi can compact mid-turn: the
   * Claude Agent SDK exposes no compaction control request at all
   * (`SDKControlRequestInner` has no compacting member and `Query` has no
   * `compact()`), so the documented mechanism is a PROMPT —
   * `agent-sdk/slash-commands.md`: "A fresh one-shot `query()` call starts with
   * empty context, so use this pattern in a session with prior turns, for
   * example in streaming input mode or when resuming a session." Our turns are
   * resumed one-shots, which is why the user-typed `/compact` already works.
   *
   * So the model's request is not refused and not faked — it is moved to the
   * seam where the user's identical request already works, the turn boundary.
   *
   * It is consumed at exactly ONE place — the drain point at the end of a clean
   * `chatImpl` turn — and discarded everywhere else, so a request made in a
   * turn that then errored, aborted or fell into recovery cannot fire on an
   * unrelated later turn. The `finally` is the backstop; the two catches and
   * the two in-try recovery arms clear it themselves BEFORE they nest a
   * recovery `chat()`, because the `finally` runs only after that nested turn
   * has already passed its own drain point.
   */
  private pendingModelCompaction: { customInstructions?: string } | null = null;
  private pendingPermissions: Map<string, PendingPermission> = new Map();
  /**
   * Tool-use ids our own permission card has already approved this session.
   *
   * Exists so one call cannot ask the user twice: our hook runs at step 1 of
   * the SDK's evaluation and its `allow` explicitly does not skip the ask rules
   * at step 6, so without this an approved `git push` is re-asked by the SDK's
   * own route. Ids are unique per tool call and the set is cleared with the
   * session, so it neither grows without bound nor outlives the approval.
   */
  private gateApprovedToolUseIds: Set<string> = new Set();
  /**
   * R12 — `definitionDigest`s whose runtime-degradation banner this session has
   * already shown the user.
   *
   * Keyed by the DIGEST rather than by the agent key, because both mistakes are
   * real: keying by turn re-posts the same banner on every send, and keying by
   * agent key permanently silences the notice for an agent whose author later
   * edits the very declaration it is about. The digest changes with the
   * definition's content, so an edited agent announces again.
   */
  private announcedAgentNoticeDigests: Set<string> = new Set();
  /**
   * P3.267 — degradation lines this session has already put on the transcript.
   *
   * R12's sibling set keys on a definition digest because its notices are ABOUT
   * a definition. These are about a turn's resolution (a clamped effort, an
   * agent that could not take its skills, a model this connection cannot
   * serve), so the line itself is the identity: the same sentence twice is the
   * same fact twice, and a different sentence is a different fact worth saying.
   * Session-scoped, so a user who changes the thing hears about the new state.
   */
  private announcedDegradationLines: Set<string> = new Set();
  /**
   * D1.155 — the session lifecycle latches, named exactly as `PiAgent` and
   * `CodexAgent` name them so the three backends read alike.
   *
   * This backend ran `emitAutomationEvent` ZERO times by design — its hooks run
   * inside the SDK child through `buildSdkHooks()` — and W19-r's headless rig
   * measured what that costs: a host `hooks.json` `SessionStart` hook did not
   * fire on claude where pi and codex ran it, and `SessionEnd` was ABSENT on
   * BOTH signals (SIGTERM 143 and SIGINT 130, the process tree gone either way).
   * So the matchers really are serialised to the child — `sdk.mjs`'s
   * `initialize` maps EVERY entry of `this.hooks` with no per-event filter — and
   * the child does not call them back for these two. Two facts, one conclusion:
   * the mechanism exists and the delivery does not, so the host emits them.
   */
  private _sessionStartEmitted = false;
  private _sessionEndEmitted = false;
  private _sessionStartHooksApplied = false;
  /**
   * D1.216 — a `SessionStart` hook's `additionalContext`, waiting for the tail
   * of the turn that fired it. `undefined` once drained.
   *
   * ONE-SHOT, and that is the documented semantics rather than a saving:
   * `hooks.md#sessionstart-decision-control` calls it *"String added to Claude's
   * context at the start of the conversation, before the first prompt"*, and
   * `#add-context-for-claude` says Claude Code *"inserts it into the
   * conversation at the point where the hook fired"* and *"reads the reminder on
   * the next model request"*. One insertion, at one point.
   *
   * It is NOT pi's `_sessionHookContext`, which rides the system prefix on EVERY
   * turn, and the difference is the runtimes' shapes rather than a divergence:
   * pi's system prefix is rebuilt per turn and REPLACES the last one, so its
   * band exists once no matter how many turns run, while on claude every user
   * message is appended to a conversation the child keeps — a per-turn append
   * here would put N copies of one hook's stdout in the transcript.
   *
   * Deliberately NOT serialized with the session state (pi's field is). Nothing
   * on this backend could restore it into the right place: the value belongs to
   * the turn the hook fired on, and a restored session emits its own
   * `SessionStart` on the next turn, which re-fills this from the hook itself.
   */
  private _sessionHookContext: string | undefined;
  /**
   * UB12.21 — the output-style block the model holds now (`''` for none;
   * `undefined` until this instance knows). The recorded system prompt keeps
   * the style it was rendered with, so a turn under a different style owes a
   * notice ({@link planOutputStyleSwitch}). Per instance, not persisted: the
   * unknown case and its residue are stated in `core/output-style-switch.ts`.
   */
  private deliveredOutputStylePrompt: string | undefined;
  /**
   * UB12.21 — this turn's notice, drained by whichever of the two prompt
   * builders composes the message ({@link consumeOutputStyleSwitchNotice}).
   * Re-planned every turn, so a notice a turn never sent is owed again.
   */
  private pendingOutputStyleSwitch: OutputStyleSwitchPlan | null = null;
  /**
   * P3.267 + P3.310 — degradation lines raised OUTSIDE the turn's own build,
   * waiting for a surface.
   *
   * The `stderr` callback fires asynchronously, long after the loop that yields
   * the turn's banners has run, so it pushes onto the open slot instead. This
   * queue is the case where there is no open slot — a line arriving between
   * turns, or before the first one — and it is drained by the next turn's
   * banner loop. Same shape and same reason as codex's own defer queue
   * (`surfaceCodexOperatorNotice`, P3.120): a notice raised before a surface
   * exists must wait for one, not be dropped.
   */
  private pendingDegradationNotices: string[] = [];
  /**
   * P6.528 — the MCP server names WE handed the child on the last spawn, kept
   * so the init message's own list can be diffed against them.
   *
   * A `Set` and not the options object: this is read once per session on a
   * message-loop branch, and holding the configs would keep every source proxy
   * instance alive for the life of the agent.
   */
  private configuredMcpServerNames: ReadonlySet<string> = new Set<string>();
  /**
   * P6.207 — the process-level SDK-warning subscription's release, held so
   * `destroy()` can drop it. A session that ends while its sink stays
   * registered would keep a dead agent reachable from a process listener.
   */
  private unsubscribeSdkShadowWarning: (() => void) | null = null;
  /**
   * P6.160 — the alias map this session's child was ACTUALLY spawned with.
   *
   * Held rather than re-derived at the turn, for the reason
   * `claudeRuntimeWireRouter` states one field over: the env is written once at
   * spawn, so a per-turn re-derivation could admit an alias whose
   * `ANTHROPIC_DEFAULT_*_MODEL` was never written — the agent would register as
   * `opus` and the child would resolve it against its own default, which on a
   * gateway is a model the endpoint does not serve.
   *
   * Consequence, stated because it is invisible otherwise: a session that
   * switches model mid-run keeps the alias pointing at the SPAWN model. The
   * child's env cannot be rewritten without a respawn, and pointing an alias at
   * a model the running child was not told about would be worse than pointing
   * it at a served one. Null on every non-`claude-runtime` session, where the
   * SDK resolves its own aliases.
   */
  private claudeRuntimeAliasModels: ClaudeRuntimeAgentAliasModelMap | null = null;
  /**
   * The model's own clarifying questions, on the same permission channel an MCP
   * elicitation rides.
   *
   * A SECOND instance of the shared bridge rather than a reuse of BaseAgent's
   * `elicitationAsk`: the class carries everything both need (the documented
   * batch validation, the `askUserQuestionTimeout` stamp, the `dontAsk` refusal,
   * answer validation, cancel-and-settle), but the id prefix is what a log reads
   * back, and a model question filed under `mcp-elicit-…` is a lie the next
   * person debugging this has to unlearn. Same surface, same teardown, honest id.
   */
  private readonly modelQuestionAsk = new ElicitationAskUserBridge({
    idPrefix: 'claude-ask', withdraw: requestId => this.withdrawElicitationDialog(requestId),
    surface: request => this.surfaceElicitationDialog(request),
    permissionMode: () => this.permissionManager.getPermissionMode(),
    timeoutMs: () => getAskUserQuestionTimeoutMs(),
  });
  // Permission whitelists are now managed by this.permissionManager (inherited from BaseAgent)
  // Source state tracking is now managed by this.sourceManager (inherited from BaseAgent)
  // Source MCP connections are managed by this.config.mcpPool (centralized in main process)
  // Both MCP sources and API sources are routed through the pool.
  // P2.102 — `private safeMode: boolean = false` lived here and was WRITE-ONLY.
  // Measured: exactly two occurrences of the identifier in this 6k-line file,
  // the declaration and one assignment in `initializeModeState`'s
  // `onStateChange`; no read, no getter, no serialization. It was plausibly the
  // vestige of the offer-filter P2.15 assumed existed and refuted.
  //
  // Four shapes an unused-identifier sweep misses were checked, not assumed
  // (`2026-07-29-inert-worklist.md` §3): no getter/setter pair, no
  // default-parameter read, and the enforcement really is ONE LAYER UP —
  // `pre-tool-use.ts:2489`'s `shouldAllowToolInMode` reads the mode manager
  // directly, which is the authority for `explore`, so nothing lost a check.
  // The fourth shape is the positive control for the absence claim: `safeMode`
  // is LIVE in three sibling subsystems (70 hits in
  // `session-tools-core/tool-defs.ts`'s per-tool metadata, the app-level
  // `config/safe-mode.ts` env switch, `storage-runtime.ts`'s SAFE_MODE_INPUTS),
  // so the search that found no reader was not a search that finds nothing.
  // Event adapter for SDK message → AgentEvent conversion (testable, pluggable)
  private eventAdapter!: ClaudeEventAdapter;
  // Thinking level is managed by BaseAgent
  // Pinned system prompt components (captured on first chat, used for consistency after compaction)
  private pinnedPreferencesPrompt: string | null = null;
  private pinnedIncludeCoAuthoredBy: boolean | null = null;
  // Track if preference drift notification has been shown this session
  private preferencesDriftNotified: boolean = false;
  // Captured stderr from SDK subprocess (for error diagnostics when process exits with code 1)
  private lastStderrOutput: string[] = [];
  /**
   * C3.259 — whether this session has already explained the child's
   * unrecognized-model line. Latched rather than repeated: the runtime claims
   * that signal once per model per child, so a session that respawns would
   * otherwise print the same paragraph again beside a line that has not changed.
   */
  private explainedUnrecognizedModelStderr: boolean = false;

  /**
   * P3.333 — the upstream status THIS agent's own local adapter saw.
   *
   * The mapper's guardrail-403 branch is gated on `capturedApiError?.status`,
   * and on a claude turn that input was STRUCTURALLY null: the only production
   * writer of the shared `api-error.json` store is
   * `unified-network-interceptor.ts`, which is preloaded into the **Pi**
   * subprocess and nowhere else — `build-dmg.sh` says so in its own words ("the
   * Claude native binary doesn't accept Bun's --preload … Phase 2 will
   * reintroduce equivalent functionality for Claude via SDK hooks or a local
   * proxy"), and `drivers/anthropic.ts` has no preload at all. So the branch
   * written FOR this runtime after the 2026-08-15 llm-proxy incident landed on
   * "Your API key may be invalid or expired", `canRetry: true` — the exact wrong
   * story it exists to delete.
   *
   * This is the local proxy that build script promised, at the seam we already
   * own: `startLocalAdapterRuntime` hands the adapter a `fetchImpl`, so the
   * upstream response passes through this class on its way back.
   *
   * **In memory, not in the file store, and that is the point.** The store is
   * process-wide and POPS on read with a five-minute window, so the only way it
   * was ever non-null on a claude turn was by consuming a Pi turn's error —
   * a cross-runtime read that would attribute one session's failure to another.
   * A field on the agent that saw the request cannot do that.
   *
   * Scope, stated rather than implied: this covers the `claude-runtime`
   * connections that go through the local adapter (the Nessy Gateway card and
   * every BYO endpoint). A Claude Pro/Max subscription session talks to
   * api.anthropic.com directly, through the native binary, with no seam of ours
   * in the path — there the branch stays unreachable and nothing in this file
   * can change that.
   */
  private lastUpstreamApiError: LastApiError | null = null;

  /**
   * **P2.513 — the buffer above, finally readable from outside this class.**
   *
   * `SessionManager.getRecentAgentStderr` (RPC `session:getRecentStderr`) is
   * duck-typed: it probes the live agent for a `getRecentStderr` method and
   * answers `''` when there is none. `PiAgent` and `CodexAgent` declare one;
   * this class did not, so **every claude session answered empty** — which is
   * worse than answering nothing, because a caller cannot tell *no diagnostics*
   * from *not wired*, and a driver reading that empty string concludes the child
   * said nothing.
   *
   * **This is one accessor, not a missing mechanism, and that distinction is the
   * whole row.** The ring buffer has always been here (twenty chunks of the SDK
   * child's stderr, written by the `stderr` callback at the query site). The
   * remedy a reader reaches for first — give claude a buffer — would have given
   * it a SECOND one, diverging from this one on clear-timing, which is how this
   * tree grew four copies of a credential path.
   *
   * TWO CONTRACT DIFFERENCES FROM ITS SIBLINGS, stated because a caller
   * comparing runtimes will meet them:
   *
   * - **Scope is the QUERY, not the session.** `chatImpl` clears the buffer at
   *   the start of every query, so this answers "what the child said during the
   *   current/most recent turn". Pi's ring spans the subprocess lifetime. That
   *   is the existing behaviour of the buffer and is deliberately not changed
   *   here: the buffer's first consumer is the `process exited with code 1`
   *   diagnosis, which wants THIS query's output and not a turn from an hour ago.
   * - **It is the child's stderr, led by F1.768's keyed session facts.** Codex's answers from
   *   its own session-facts map and an upstream-auth log, because there the
   *   missing piece is a SINK rather than a reader — its child's stderr is
   *   forwarded to `debug()`, whose transports a packaged build disables, and
   *   nothing retains it. Two runtimes, two different repairs; do not read one's
   *   answer as the other's.
   *
   * Bounded and newline-joined the same way every internal read of this buffer
   * already joins it, so the accessor and the error path cannot render the same
   * chunks differently. Never throws — the accessor above swallows, but a method
   * that relies on being swallowed is not a contract.
   */
  getRecentStderr(): string {
    return [...this.claudeSessionFacts.values(), ...this.lastStderrOutput].join('\n'); // F1.768: keyed facts lead, as on codex
  }

  /**
   * P6.209 (A42) — the denial receipts, retained so something other than
   * `onDebug` can read them.
   *
   * Both mint sites already produced a typed `ClaudePermissionDenialReceiptV1`
   * and handed it to `onDebug` and nothing else, which in a packaged build has
   * no reader at all (electron-log's transports are disabled there). So a
   * session that auto mode had silently narrowed could not be inspected — the
   * evidence existed and was thrown away one line after it was minted.
   *
   * BOTH channels feed this ring, deliberately, and the hand-off named only the
   * hook one. The `PermissionDenied` hook fires only for auto-mode classifier
   * denials and our own `permissionDecision` silences most of them; the SDK's
   * `system/permission_denied` message is the one that is not dormant and
   * carries every denial the binary decides for itself. A list fed by the
   * dormant half alone would render empty on exactly the sessions a user opens
   * it for. The receipt type is the same on both paths, and
   * `claude-permission-denial-receipt.ts` records why both are allowed to fire
   * for one classifier denial.
   *
   * BOUNDED at fifty and never persisted: a long auto-mode session can deny
   * often, and this is a diagnostic ring like `lastStderrOutput` beside it, not
   * an audit log. Session-scoped rather than turn-scoped — unlike the stderr
   * buffer above, which `chatImpl` clears per query — because "what has auto
   * mode refused in this session" is the question the surface asks.
   *
   * OBSERVATIONAL ONLY. Retaining a receipt is not a licence to re-issue the
   * call: a retry re-executes something a safety judge refused, which is a
   * product posture and its own row (W8-lo1 proposed row 5), not a rendering
   * choice that rides in behind a list.
   */
  private readonly recentAutoModeDenials: ClaudePermissionDenialReceiptV1[] = [];

  /** How many denial receipts {@link recentAutoModeDenials} keeps. */
  private static readonly RECENT_AUTO_MODE_DENIAL_LIMIT = 50;

  private retainAutoModeDenial(receipt: ClaudePermissionDenialReceiptV1): void {
    this.recentAutoModeDenials.push(receipt);
    if (this.recentAutoModeDenials.length > ClaudeAgent.RECENT_AUTO_MODE_DENIAL_LIMIT) {
      this.recentAutoModeDenials.shift();
    }
  }

  /**
   * The retained denial receipts, oldest first. Duck-typed from
   * `SessionManager.getRecentAutoModeDenials` exactly like `getRecentStderr`
   * above, so a runtime that mints no receipts answers empty rather than
   * failing. Never throws.
   */
  getRecentAutoModeDenials(): readonly ClaudePermissionDenialReceiptV1[] {
    return [...this.recentAutoModeDenials];
  }
  /** F1.238 — accepted mid-turn steers, oldest first; drained IN ORDER by `deliverPendingSteersOn` */
  private pendingSteers: PendingSteer[] = [];
  /**
   * The `claude-runtime` session's local Anthropic-Messages adapter, or null for
   * every other connection type. Owned by this agent: started in postInit, closed
   * in destroy(). The loopback port is ephemeral, so it is per-session runtime
   * state and is never written back to the connection record.
   */
  private localAdapter: AdapterHandle | null = null;
  /** Set by destroy(); makes the adapter lifecycle safe against a start/destroy race. */
  private localAdapterDisposed = false;
  /**
   * The upstream mode the local adapter resolved at postInit: 'nestor' is the
   * corp gateway (dp sign-in, no key field); 'openai-compatible' and
   * 'anthropic-messages' are BYO endpoints with their own credentials. The
   * error mapper reads this to keep the "gateway sign-in expired" wording off
   * BYO connections (T28) — null means postInit has not resolved one, and the
   * mapper then keeps its historical gateway wording for claude-runtime.
   */
  private claudeRuntimeUpstreamKind: string | null = null;

  /**
   * The per-request wire router the local adapter was started with, kept so the
   * TURN can ask the same question the adapter will answer: does this model's
   * request pass through natively, or go through the OpenAI-wire translator?
   *
   * `null` on every session that is not `claude-runtime`, and on a
   * `claude-runtime` session whose connection marks no model
   * `wire: 'anthropic-messages'` — which is the gateway and every BYO
   * chat-completions endpoint, i.e. the whole translated world.
   *
   * @see resolveClaudeHostedWebSearchWithheld
   */
  private claudeRuntimeWireRouter: ((model: string) => UpstreamTarget | undefined) | null = null;

  /**
   * P6.148 — the last value this session registered as
   * `hostWebSearchOffered`, so a turn that does not move the verdict does not
   * drop the memoized tool list. `undefined` means "never registered", which is
   * why the first turn always writes: the registry's own default is `false`,
   * and a session whose first turn is withheld must offer the host tool.
   *
   * @see resolveClaudeHostedWebSearchWithheld
   */
  private hostWebSearchOfferedLast: boolean | undefined;

  private resolveSelectedPluginSkillRuntimePolicy(): {
    environment: Record<string, string>;
    writablePaths: string[];
  } {
    // `plugins-reference.md` § File locations, `bin/`: "Executables added to the
    // Bash tool PATH. Files here are invokable as bare commands in any Bash tool
    // call while the plugin is enabled." The grant is deliberate and it is real:
    // an enabled plugin can make one of its own files resolvable as a bare
    // command in EVERY Bash call of the session. It is APPENDED, so it can never
    // shadow a system binary of the same name. Keyed off the turn's runnable
    // capability view rather than the selected skills, because the documented
    // condition is enablement, not selection.
    const binBundleRoots = enabledPluginBundleRoots(this.capabilityTurnRuntime?.view);
    if (this.activePluginSkillRuntimes.length === 0) {
      const pluginBinPath = appendPluginBinPath(process.env.PATH, binBundleRoots);
      // No skill runtime is pinned this turn, so none of the plugin env aliases
      // apply — but an enabled bundle's bin/ still belongs on PATH.
      return {
        environment: pluginBinPath === undefined ? {} : { PATH: pluginBinPath },
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
    // The node shim stays FIRST — it is the host's own runtime redirect — and the
    // plugin bin/ directories stay LAST, after the system PATH.
    const shimPath = `${shimDirectory}${delimiter}${process.env.PATH ?? ''}`;
    mergeEnvironment({
      NESSY_BUN: nodeRuntime.command,
      PATH: appendPluginBinPath(shimPath, binBundleRoots) ?? shimPath,
    });
    return { environment, writablePaths: [...writablePaths].sort() };
  }

  /**
   * Get the session ID for mode operations.
   * Returns a temp ID if no session is configured (shouldn't happen in practice).
   */
  private get modeSessionId(): string {
    return this.config.session?.id || `temp-${Date.now()}`;
  }

  /**
   * Composite session identity for session-keyed singleton lookups
   * (permission modes, callback registry, plan state, tools cache).
   */
  private get modeKey(): SessionKey {
    return { workspaceId: this.config.workspace.id, sessionId: this.modeSessionId };
  }

  /**
   * Get the workspace root path for workspace-scoped operations.
   */
  private get workspaceRootPath(): string {
    return this.config.workspace.workspaceRootPath;
  }

  // Callback for permission requests - set by application to receive permission prompts
  public onPermissionRequest: PermissionCallback | null = null;

  /**
   * P6.263 — what the live child said it supports, or `[]` until an
   * `system/init` has been seen. SESSION-scoped and re-read per init, like the
   * other per-child facts `ensureLiveSession` can invalidate.
   */
  private advertisedProtocolCapabilities: readonly string[] = Object.freeze([]);

  /** @see BaseAgent.protocolCapabilities */
  override protocolCapabilities(): readonly string[] {
    return this.advertisedProtocolCapabilities;
  }

  /** P6.263 — see the call site in {@link routeLiveMessage}. */
  private captureAdvertisedProtocolCapabilities(message: SDKMessage): void {
    if (message.type !== 'system' || (message as { subtype?: string }).subtype !== 'init') return;
    const advertised = (message as { capabilities?: unknown }).capabilities;
    if (!Array.isArray(advertised)) return;
    this.advertisedProtocolCapabilities = Object.freeze(
      advertised.filter((name): name is string => typeof name === 'string' && name.length > 0),
    );
  }

  /**
   * P6.263 — whether the interrupt receipt is EVIDENCE on this child.
   *
   * `sdk.d.ts`: `'interrupt_receipt_v1'` = "the interrupt control_response
   * success payload carries still_queued (uuids of async user messages that
   * survive the interrupt)". Until this method the code ASSUMED it: every
   * outgoing message is uuid-stamped precisely so the receipt can name it
   * ({@link stampTurnMessageUuid}), and nothing checked whether this child would
   * send one.
   *
   * It deliberately gates no BRANCH today, and saying so is the point: nothing
   * in this tree consumes `still_queued` yet, so a branch here would be invented
   * rather than read. What it does is make the assumption legible at the one
   * place that rests on it — the interrupt — so the next reader of a Stop that
   * behaved oddly can tell "the child promised a receipt" from "we assumed one".
   */
  private childAdvertisesInterruptReceipt(): boolean {
    return this.advertisedProtocolCapabilities.includes('interrupt_receipt_v1');
  }

  /**
   * A3.3 — WHICH CREDENTIAL AUTHORIZED THIS SESSION, as the child answers it.
   *
   * `null` until a `system/init` has been seen, SESSION-scoped and re-read per
   * init, exactly like {@link advertisedProtocolCapabilities}.
   *
   * `apiKeySource` is a REQUIRED field of `SDKSystemMessage` and had **0**
   * readers across `packages` and `apps` before this: the init message carried
   * the answer to the question every auth defect in this record starts from, and
   * the host discarded it every time.
   *
   * ## What the enum can say, and which two members this fork can produce
   *
   * The vendored 0.3.251 gloss, verbatim: "Where the credential used for API
   * requests came from: 'ANTHROPIC_API_KEY' (environment variable),
   * 'apiKeyHelper' (the configured helper command), '/login managed key' (an API
   * key created and stored by /login with an Anthropic Console account), or
   * 'none' (no API key in use - e.g. claude.ai OAuth login, a bearer token, or a
   * third-party cloud provider). 'user' | 'project' | 'org' | 'temporary' |
   * 'oauth' are legacy members that current CLIs never emit; they remain only so
   * the type stays backward compatible."
   *
   * Nine members, four live and five legacy — and on THIS fork the four collapse
   * to two, because the host decides the child's credential and the environment
   * does not get a vote ({@link announceClaudeCredentialEnvDrops}):
   *
   *  - `'ANTHROPIC_API_KEY'` — the loopback-adapter path, gateway or BYO. The
   *    spawn sets `ANTHROPIC_API_KEY: 'not-needed'` beside a 127.0.0.1 base URL
   *    because the SDK refuses to start without something there; the adapter
   *    authenticates upstream itself.
   *  - `'none'` — a bearer/OAuth path, which here is the Claude subscription
   *    card's `CLAUDE_CODE_OAUTH_TOKEN`.
   *
   * ## Why it is worth reading even though it is nearly constant
   *
   * Because it is nearly constant, a DISAGREEMENT is information and nothing
   * else in the session could produce it. A gateway session reporting `'none'`,
   * a subscription session reporting `'ANTHROPIC_API_KEY'`, or any of the other
   * seven members at all, each mean the child authorized with something the host
   * did not intend — the defect class this row exists for. `'apiKeyHelper'` and
   * `'/login managed key'` would each mean the child reached a credential source
   * on the machine that this fork never configures.
   *
   * It is READ and not yet RENDERED, and saying so is the point: surfacing it
   * beside the connection is a renderer change plus a locale key, which belong
   * to the renderer lane. This is the producer, and the value is named on the
   * debug channel meanwhile, so a support thread can ask for it. The value is a
   * credential SOURCE NAME and never a credential.
   */
  private childApiKeySourceValue: string | null = null;

  /** A3.3 — the child's own answer, or `null` before the first `system/init`. */
  childApiKeySource(): string | null {
    return this.childApiKeySourceValue;
  }

  /** A3.3 — see the call site in {@link routeLiveMessage}. */
  private captureChildApiKeySource(message: SDKMessage): void {
    if (message.type !== 'system' || (message as { subtype?: string }).subtype !== 'init') return;
    const source = (message as { apiKeySource?: unknown }).apiKeySource;
    // Typed as required, read as optional: a CLI that predates the field, or a
    // transport that drops it, must leave the last answer standing rather than
    // overwrite it with a blank — the same guard the init roster fields carry in
    // `backend/claude/event-adapter.ts`.
    if (typeof source !== 'string' || source.length === 0) return;
    if (source === this.childApiKeySourceValue) return;
    this.childApiKeySourceValue = source;
    debug(`[ClaudeAgent] A3.3 — the child authorized this session with apiKeySource=${source}`);
  }

  /**
   * D1.208 — THE RUNTIME'S OWN TELEMETRY VERDICT FOR THIS SESSION, which it has
   * published all along and nobody here could read.
   *
   * `null` until a `system/init` has been seen, SESSION-scoped and re-read per
   * init, exactly like {@link childApiKeySourceValue} above.
   *
   * ## The membership rule, in its sharpest form
   *
   * `analytics_disabled` is an optional boolean the binary writes onto the
   * `system`/`init` object and describes in its own internal schema (paraphrase
   * only — the binary is proprietary) as true when the CLI has analytics or
   * telemetry disabled for this session, by privacy level, by
   * `DISABLE_TELEMETRY` or `DO_NOT_TRACK` from any settings tier, by a
   * third-party provider or by a gateway. Re-measured on the vendored
   * darwin-arm64 binary on 2026-09-18, instrument named
   * (`grep -aoF <needle> <binary> | wc -l`, occurrences and not lines): the
   * needle **5**, a fabricated name **0**, `DO_NOT_TRACK` **14** as the positive
   * control. It occurs **0** times in `sdk.d.ts` and occurred **0** times in
   * this repo. AGENTS.md: the bundle is the denominator and the typings are a
   * subset of it, so the field is read off the object rather than declared —
   * extra fields survive at runtime whether or not a `.d.ts` mentions them.
   *
   * ## [product] POSTURE, stated because it is a choice and not a patch
   *
   * The fact ALWAYS reaches the diagnostic channel. A user-visible line is
   * raised ONLY on the disagreement: the operator named one of the two privacy
   * variables in the environment this host spreads into the child, and the child
   * answers that analytics is still enabled for the session. Three reasons, in
   * descending weight:
   *
   *  1. the reassuring direction — analytics off — is not actionable, and a line
   *     about it on every session is the per-session nag that every notice on
   *     this channel is latched to avoid;
   *  2. the alarming direction with NO operator request is the settings-tier,
   *     provider or gateway case. It is the runtime's documented default
   *     behaviour and this host neither configured nor can undo it, so a line
   *     would be an alarm with no action. **Whether to say it anyway is the
   *     owner's call**; the recommendation is a PULL surface (the config
   *     doctor's per-session facts) rather than a push, and that half is handed
   *     to the lane that holds `config/config-doctor.ts` this wave;
   *  3. the disagreement IS actionable, and there is a measured reason to expect
   *     it: the sitting that produced this row recorded that the binary tests
   *     `DISABLE_TELEMETRY` for truthiness of the raw value while `DO_NOT_TRACK`
   *     goes through a helper first, so `DO_NOT_TRACK=0` plausibly does not
   *     disable anything. That was recorded as a hypothesis about a branch
   *     SHAPE, so nothing here re-implements the binary's truthiness rule — the
   *     trigger is PRESENT-AND-NON-EMPTY, a fact this host can read without
   *     deciding what the binary treats as true, and the sentence says exactly
   *     that: you set the name, the runtime still reports telemetry on, check
   *     the value.
   */
  private childAnalyticsDisabledValue: boolean | null = null;

  /** D1.208 — the child's own answer, or `null` before the first `system/init`. */
  childAnalyticsDisabled(): boolean | null {
    return this.childAnalyticsDisabledValue;
  }

  /**
   * D1.208 — the two names whose PRESENCE makes a still-enabled verdict a
   * disagreement worth one line.
   *
   * Neither is stripped from the child's environment: both are absent from
   * `CLAUDE_SDK_STRIPPED_ENV_KEYS`, which carries provider routing and
   * first-party-assumption names only, so what this process holds is what the
   * child was given.
   */
  private static readonly TELEMETRY_OPT_OUT_ENV_KEYS = ['DISABLE_TELEMETRY', 'DO_NOT_TRACK'] as const;

  /** D1.208 — see the call site in {@link routeLiveMessage}. */
  private captureChildAnalyticsDisabled(message: SDKMessage): void {
    if (message.type !== 'system' || (message as { subtype?: string }).subtype !== 'init') return;
    const disabled = (message as { analytics_disabled?: unknown }).analytics_disabled;
    // Optional in the binary's own schema and absent on older CLIs, so anything
    // that is not a boolean leaves the last answer standing rather than
    // overwriting it — the same guard `captureChildApiKeySource` carries.
    if (typeof disabled !== 'boolean') return;
    if (disabled === this.childAnalyticsDisabledValue) return;
    this.childAnalyticsDisabledValue = disabled;
    debug(`[ClaudeAgent] D1.208 — the child reports analytics_disabled=${disabled} for this session`);
    if (disabled) {
      this.childTelemetryOptOutRequested = null;
      return;
    }
    const asked = ClaudeAgent.TELEMETRY_OPT_OUT_ENV_KEYS.filter(key => {
      const value = process.env[key];
      return typeof value === 'string' && value.length > 0;
    });
    this.childTelemetryOptOutRequested = asked.length > 0 ? asked.join(' and ') : null;
  }

  /**
   * D1.277 — the names the operator set, when the child then reported analytics
   * still ENABLED. `null` when there is no disagreement to report.
   *
   * The trigger is PRESENT-AND-NON-EMPTY rather than the host's own
   * `telemetryOptedOut` truthiness rule, and deliberately: D1.208's sitting
   * recorded that the binary tests `DISABLE_TELEMETRY` for raw truthiness while
   * `DO_NOT_TRACK` goes through a helper, so `DO_NOT_TRACK=0` plausibly does not
   * disable anything. Nothing here re-implements the binary's rule — the fact
   * this host can honestly read is "you set the name and the runtime still
   * reports telemetry on", which is also the actionable one.
   */
  private childTelemetryOptOutRequested: string | null = null;

  /**
   * D1.277 — the disagreement, for the HOST to render.
   *
   * D1.208 shipped this as an English `queueDegradationNotice` from inside the
   * agent. It is the app's own words about its own host, addressed to the person
   * in the chat, which is C3.331's localise case — and the settings-tiers line
   * already carries this session's other two telemetry facts
   * (`telemetry-identity-exported`, `telemetry-event-dialect`) in the user's
   * language. So the agent keeps the measurement, which is its own (the env-name
   * list and the init field), and the host owns the sentence. One fact, one
   * channel.
   */
  childTelemetryOptOutIgnored(): string | null {
    return this.childAnalyticsDisabledValue === false ? this.childTelemetryOptOutRequested : null;
  }

  // Debug callback for status messages
  public onDebug: ((message: string) => void) | null = null;

  /** Callback when permission mode changes */
  public onPermissionModeChange: ((mode: PermissionMode) => void) | null = null;

  // Callback when a plan is submitted - set by application to display plan message
  public onPlanSubmitted: ((planPath: string) => void) | null = null;

  /**
   * Set while a session tool that hands the turn to the UI (SubmitPlan, an auth tool) is still
   * running: `interruptForHandoff` then only marks the interrupt, and the tool's result releases
   * it. UB2.1 (COR-1), ported from craft-agents-oss v0.15.1 `claude-agent.ts` (Apache-2.0).
   */
  private toolHandoff: { interrupt: boolean; timer: ReturnType<typeof setTimeout> | null } | null = null;
  /** Test seam for `HANDOFF_RESULT_WAIT_MS` (UB2.1). */
  private handoffResultWaitMs?: number;

  // Callback when authentication is requested (unified auth flow)
  // This follows the SubmitPlan pattern:
  // 1. Tool calls onAuthRequest
  // 2. Session manager creates auth-request message and calls forceAbort
  // 3. User completes auth in UI
  // 4. Auth result is sent as a "faked user message"
  // 5. Agent resumes and processes the result
  public onAuthRequest: ((request: AuthRequest) => void) | null = null;

  // Callback when a source config changes (hot-reload from file watcher)
  public onSourceChange: ((slug: string, source: LoadedSource | null) => void) | null = null;

  // onSourcesListChange and onSourceActivationRequest are inherited from BaseAgent
  // (P6.884 deleted the third, `onConfigValidationError` — declared, cleared
  // here, and written by nobody; see `base-agent.ts`'s watcher callbacks).

  // Callback when token usage is updated (for context window display).
  // Note: Full UsageTracker integration is planned for Phase 4 refactoring.
  public onUsageUpdate: ((update: { inputTokens: number; contextWindow?: number; cacheHitRate?: number }) => void) | null = null;

  /**
   * C3.69 — the SDK's own never-persist switch, resolved ONCE for this session.
   *
   * Resolved in the constructor and not per turn, because that is what the
   * setting already means everywhere else: `SessionManager` reads the same two
   * inputs at the session-create choke point and `Session.ephemeral` is "FIXED
   * for the life of the session" (`protocol/dto.ts`). A per-turn read would be
   * worse than inconsistent — the value only takes effect when a child is
   * built, so a mid-session flip would bind at whatever unrelated moment
   * `ensureLiveSession` happened to respawn, and a flip from never-persist BACK
   * to persist would then resume a child against a transcript that was never
   * written. One value per session; a changed setting applies to the next one.
   *
   * NOT in `claudeLiveSessionSignature` for the same reason: hashing it would
   * manufacture exactly that respawn.
   *
   * See `claude-session-persistence.ts` for the vendor sentence, the reason a
   * host sweep is not the mechanism, and the measured cost.
   */
  private readonly sessionPersistenceOptions: Pick<Options, 'persistSession'>;

  constructor(config: ClaudeAgentConfig) {
    // Resolve model: prioritize session model > config model > current Anthropic default.
    const model = config.session?.model ?? config.model ?? DEFAULT_MODEL;

    // Build BackendConfig for BaseAgent
    // F1.1241 (closes F1.1232) — the model's known window: the connection's entry, else the registry, else 200K.
    const CLAUDE_CONTEXT_WINDOW = resolveClaudeKnownModelWindow(config.connectionSlug ? getLlmConnection(config.connectionSlug) : null, model) ?? 200_000;
    // The caller's object goes through WHOLE, exactly as `PiAgent` and
    // `CodexAgent` hand theirs to `super(config, …)`. This used to be a
    // hand-written field list, and a `BackendConfig` field that was not named
    // on it did not exist for any Claude session — 42 of 67 fields, including
    // `projectTrusted`, `mcpLeaserId`, `enable1MContext`, `onImageResize` and
    // the `piRuntimeAgentDefinitions` whose absence produced
    // `Agent type '<ours>' not found` live. Only the two values this class
    // OWNS are overridden, and each states why:
    //   `provider`  — this class is the anthropic backend; a caller cannot
    //                 route it elsewhere by handing it another provider.
    //   `model`     — resolved above (session model wins over config model),
    //                 and `CLAUDE_CONTEXT_WINDOW` is derived from that same
    //                 resolution, so the two must not be allowed to disagree.
    // Do NOT reintroduce a field list here: `claude-config-projection.test.ts`
    // re-derives `BackendConfig`'s members from source and fails on the first
    // one that stops arriving.
    const backendConfig: BackendConfig = { ...config, provider: 'anthropic', model };

    // Call BaseAgent constructor - initializes model, thinkingLevel, permissionManager, sourceManager, etc.
    // The inherited this.config is set by super() and compatible with ClaudeAgentConfig
    super(backendConfig, DEFAULT_MODEL, CLAUDE_CONTEXT_WINDOW);

    this.isHeadless = config.isHeadless ?? false;
    this.automationSystem = config.automationSystem;
    // C3.69 — see the field's own docblock for why this is read here and once.
    // C3.280 — and the third input, a caller's own `ephemeral`, which the two
    // readers inside the resolver cannot see. `SessionManager` has already
    // resolved it against the setting and the environment, so this is the
    // resolved answer rather than a fourth opinion.
    this.sessionPersistenceOptions = resolveClaudeSessionPersistence({
      ...(config.sessionEphemeral !== undefined ? { sessionEphemeral: config.sessionEphemeral } : {}),
    });

    // Initialize event adapter for SDK message → AgentEvent conversion
    this.eventAdapter = new ClaudeEventAdapter({
      onDebug: (msg) => this.onDebug?.(msg),
      mapSDKError: (errorCode) => this.mapSDKErrorToTypedError(errorCode),
      // P3.97 — the LIVE half of the denial audit. Read lazily on purpose:
      // both the session id and the permission mode are getters that resolve
      // per call, and this adapter is constructed once and survives every
      // respawn `ensureLiveSession` performs.
      onPermissionDenied: (denial) => this.mintStreamPermissionDenialReceipt(denial),
      // P6.643 — the claude arm of the session's hook-run store. The adapter
      // already builds this observation for the transcript line; recording it
      // costs nothing and is the only place a SUCCESSFUL hook run is legible
      // (the host arm can only see failures — `hookErrors` is all
      // `AgentEventExecutionResult` publishes per hook).
      onHookRun: observation => this.recordHookRun(observation),
    });

    // Log which model is being used (helpful for debugging custom models)
    this.debug(`Using model: ${model}`);

    // Initialize sessionId from session config for conversation resumption
    if (config.session?.sdkSessionId) {
      this.sessionId = config.session.sdkSessionId;
    }
    // Initialize branch params for SDK-level fork (resume parent + forkSession).
    // Branch lineage is the composite `branchFrom` (parent SessionKey + provider anchors).
    if (config.session?.branchFrom?.sdkSessionId) {
      this.branchFromSdkSessionId = config.session.branchFrom.sdkSessionId;
      this.branchFromSdkCwd = config.session.branchFrom.sdkCwd ?? null;
      this.branchFromSdkTurnId = config.session.branchFrom.sdkTurnId ?? null;
    }

    // Initialize permission mode state with callbacks
    const sessionId = this.modeSessionId;
    // Composite key for every session-keyed singleton (captured once so a
    // no-session temp fallback stays stable across the registrations below).
    const sessionKey: SessionKey = { workspaceId: config.workspace.id, sessionId };
    // Get initial mode: from session, or from global default
    const globalDefaults = loadConfigDefaults();
    const initialMode: PermissionMode = config.session?.permissionMode ?? globalDefaults.workspaceDefaults.permissionMode;

    initializeModeState(sessionKey, initialMode, {
      owner: this, onStateChange: (state) => { // F1.397 — the owner lets destroy() remove only this agent's registration
        // Notify UI of permission mode changes. The `this.safeMode` assignment
        // that used to sit above this line was the only writer of a field with
        // no reader (P2.102) — the mode manager whose state this is IS the
        // authority every consumer already reads.
        this.onPermissionModeChange?.(state.permissionMode);
      },
    });

    // Register session-scoped tool callbacks
    registerSessionScopedToolCallbacks(sessionKey, {
      onPlanSubmitted: (planPath) => {
        this.onDebug?.(`[ClaudeAgent] onPlanSubmitted received: ${planPath}`);
        this.beginToolHandoff(); // UB2.1 — the host's interruptForHandoff must wait for this tool's result
        this.onPlanSubmitted?.(planPath);
      },
      onAuthRequest: (request) => {
        this.onDebug?.(`[ClaudeAgent] onAuthRequest received: ${request.sourceSlug} (type: ${request.type})`);
        this.beginToolHandoff(); // UB2.1 — the host's interruptForHandoff must wait for this tool's result
        this.onAuthRequest?.(request);
      },
      queryFn: (request) => this.queryLlm(request), connectionModelIds: () => this.claudeRuntimeServedModelIds(), gatePermissionsContextFn: () => this.permissionManager.getCapabilityPermissionsContext?.() ?? { workspaceRootPath: this.workspaceRootPath, activeSourceSlugs: Array.from(this.sourceManager.getActiveSlugs()) }, // F1.709 — the context `runPreToolUseChecks` reads, for the call_llm attachment floor
      // P2.1 — the advisor consult. Bound here rather than reusing `queryFn`
      // because the gates (settings, entitlement, managed allowlist) and the
      // transcript packaging live above the transport; see the registry's note.
      advisorConsultFn: (args) => this.executeAdvisorConsult(args),
      spawnSessionFn: (input) => this.preExecuteSpawnSession(input),
      // R9 — the model-facing `SlashCommand` seam. Registered here because
      // `session-scoped-tools.ts` builds `ctx.dispatchSlashCommand`
      // UNCONDITIONALLY as an arrow that throws when this slot is empty, and
      // `handlers/slash-command.ts` turns that throw into an errorResponse. So
      // leaving it unregistered was not "the tool is absent on Claude": the
      // tool was advertised as `mcp__session__SlashCommand`, our own `/help`
      // text told the model "/compact [instructions]: compact the active
      // session context", and every `/compact` burned a tool call on a runtime
      // error.
      dispatchSlashCommandFn: (command) => this.dispatchSlashCommand(command),
    });

    // Start config watcher for hot-reloading source changes
    // Only start in non-headless mode to avoid overhead in batch/script scenarios
    if (!this.isHeadless) {
      this.startConfigWatcher();
    }

    // Q13-D1: the Claude runtime reaches MCP servers through `createSourceProxyServers`
    // over the SHARED workspace pool, so a server's `elicitation/create` lands on
    // the pool's client in this process. Without this registration the pool has
    // no user for this leaser and declines every one of them.
    this.registerMcpElicitationHandler();

    // P6.207 — subscribe to the SDK's own shadowed-callback warning. Here and
    // not at the query build: `process.emitWarning` fires on `nextTick`, so a
    // listener installed around the `query()` call would be gone before the
    // event arrives.
    this.unsubscribeSdkShadowWarning = subscribeToClaudeSdkShadowWarning((message) => {
      // F1.596 — what the notice says per shape is decided by
      // `formatClaudeSdkShadowWarningNotice`: the vendor's sentence verbatim
      // behind a lead-in, except the bypass arm, whose sentence is measured
      // wrong about its own CLI and is replaced by the documented rule, quoted
      // — never a paraphrase (the `surfaceForcedDefaultModeNotice` rule). The
      // vendor's own words still reach the debug log, one line below.
      this.debug(`SDK ${CLAUDE_SDK_CAN_USE_TOOL_SHADOWED_CODE}: ${message}`);
      if (claudeShadowWarningReachesSession(message, this.getPermissionMode())) this.queueDegradationNotice(formatClaudeSdkShadowWarningNotice(message)); // F1.759
    });
  }

/**
 * P6.260 — the four credential and base-URL names `postInit` deletes, and what
 * a reader is told about each.
 *
 * Denominator C23's own clause: *"The SDK's own conflict warning is
 * unreachable: we delete the names from `process.env` before the child spawns,
 * so it never sees the conflict. The host must say it — case (2) — and the
 * precedent is in the same file family, where the LAUNCHER scrub was
 * deliberately made to announce itself (P3.300)."* This is that announcement,
 * on the same channel and in the same shape.
 *
 * NAMES ONLY. Three of the four hold credentials, and a diagnostic that printed
 * one would turn a disclosure into a leak; the whole point of the drop is that
 * the value must not travel.
 *
 * ONLY WHAT WAS ACTUALLY THERE. A name nobody exported was not dropped, and
 * saying so on every session start would bury the case that matters under three
 * lines of noise. Read from a SPREAD rather than by `in`, because `in` lies for
 * the names Bun pre-creates slots for and a name read that way would be
 * announced as dropped on a machine where it was never set.
 *
 * ## C30, the verdict the wording depends on — measured at HEAD, not assumed
 *
 * `ANTHROPIC_BASE_URL` is *dropped and not overridable*, and the two halves have
 * different causes:
 *
 *  - On a `claude-runtime` connection (the Nessy Gateway card and every BYO
 *    endpoint) `startLocalAdapterRuntime` writes it into `config.envOverrides`,
 *    which `buildClaudeSubprocessEnv` spreads AFTER `process.env` — so ours wins
 *    even if the delete above had missed. An operator cannot layer their own
 *    proxy on top of the per-session loopback adapter, and should not be able
 *    to: the adapter is what translates the wire.
 *  - On a direct connection without a base URL nothing writes it, and F1.966's
 *    `buildClaudeSubprocessEnv` removes any value the environment brought, so the
 *    child uses the vendor default. The CONNECTION decides it on every path.
 *
 * The other three are *dropped* without that second clause: the session's
 * resolved credential is written back below, so the effective value is the
 * connection's rather than the environment's, and an operator who wants a
 * different one changes the connection.
 */
private announceClaudeCredentialEnvDrops(): void {
  const present = { ...process.env };
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'] as const) {
    if (present[name] === undefined) continue;
    debug(
      `[ClaudeAgent] P6.260 — dropped ${name} from the environment before the Claude child spawns. `
      + 'The session\'s own connection supplies the credential, and an inherited one would silently '
      + 'outrank it; the SDK\'s own conflict warning cannot fire because the child never sees the '
      + 'conflict. The value is never logged.',
    );
  }
  if (present.ANTHROPIC_BASE_URL !== undefined) {
    debug(
      '[ClaudeAgent] P6.260 — dropped ANTHROPIC_BASE_URL from the environment before the Claude '
      + 'child spawns, and it is not overridable: on a claude-runtime connection the per-session '
      + 'loopback adapter\'s address is written into the child env after process.env, and on a direct '
      + 'connection the child env builder removes it (F1.966). The endpoint is the connection\'s, not '
      + 'the environment\'s.',
    );
  }
}

  /**
   * Post-construction auth setup.
   * Fetches credentials into THIS session's envOverrides (F1.958) before the SDK subprocess spawns.
   * The subprocess spawns lazily on first chat(), so postInit() is early enough.
   */
  override async postInit(): Promise<PostInitResult> {
    const slug = this.config.connectionSlug;
    if (!slug) {
      return { authInjected: false, authWarning: 'No connection slug available', authWarningLevel: 'error' };
    }

    const connection = getLlmConnection(slug);
    if (!connection) {
      return { authInjected: false, authWarning: `Connection not found: ${slug}`, authWarningLevel: 'error' };
    }

    // Clear all auth env vars first for clean state.
    // Claude subprocesses must never inherit cloud-provider routing toggles
    // from a previous connection or parent process environment.
    // ANTHROPIC_AUTH_TOKEN is authentication.md's precedence tier 2 (sent as
    // `Authorization: Bearer`), ABOVE the tier-3 ANTHROPIC_API_KEY this method
    // writes below — an ambient bearer token would silently outrank the
    // credential the session resolved.
    //
    // P6.260 — and each drop is now ANNOUNCED, on the same channel the launcher
    // scrub announces itself on (`options.ts`, P3.300). Four names an operator
    // may deliberately have exported were deleted from a SHARED `process.env`
    // with nothing said, and the SDK's own conflict warning is unreachable
    // precisely because of it: the child never sees the conflict, so if the host
    // does not say it, nobody does. Names only, never values — this is the one
    // place in the file where a value is a credential.
    this.announceClaudeCredentialEnvDrops();
    // C3.181 — say whether the SDK's own auto memory is on for this session and
    // where its files land. The directory is per-Workspace and durable, and no
    // other host surface names it.
    debug(`[ClaudeAgent] ${describeClaudeAutoMemory(process.env)}`);
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_BASE_URL;
    clearClaudeCloudProviderRoutingEnvVars();

    const manager = getCredentialManager();

    // P3.235 — the one residual difference the knob projection cannot remove,
    // said out loud on BOTH paths before either branches. The SDK floors
    // `CLAUDE_CODE_AUTO_COMPACT_WINDOW` at 100 000 and Pi floors it nowhere, so
    // `NESSY_AUTO_COMPACT_WINDOW=50000` means two different numbers on the two
    // runtimes; emitted here rather than inside a branch because both spawn
    // paths forward the same knob. Silent when the knob is unset or in range.
    //
    // P6.96 · ON THE TRANSCRIPT, not to `debug`. This is an OPERATOR's setting
    // silently meaning something other than what it says, and it was stated
    // only to a debug log a packaged build never writes — the same defect
    // P3.267 lifted for the launcher drops two blocks below, answered the same
    // way and over the SAME channel. No new channel is built: R12's `info` +
    // `level: 'warning'` already exists, and `queueDegradationNotice` latches
    // per session so a respawn does not repeat the line.
    for (const line of claudeAutoCompactionKnobDiagnostics(this.config.autoCompaction)) {
      this.queueDegradationNotice(line);
    }

    // P6.79 — and the launcher names P3.300 drops, announced on a surface a
    // person reads rather than only into a debug log a packaged build never
    // writes. Before the provider branch, because both spawn paths reach the
    // child through the same env builder and both drop the same names.
    for (const notice of buildClaudeLauncherDropNotices(process.env)) {
      this.queueDegradationNotice(notice);
    }

    // C3.304 — the two `.claude`-settings refusals that used to be queued here
    // (`formatClaudeShellCommandSettingRefusal`, P6.254/C3.49, and
    // `formatClaudeDangerousModeAckRefusal`, P6.495) are NOT missing: both said
    // in their own words that the ruling behind them is product-wide — an
    // admin-supplied executable is refused as a settings source on every runtime,
    // and the bypass confirmation is the host's on every runtime — and being
    // called from here they reached one runtime out of three (`grep -c` over
    // `pi-agent.ts` was 0 against 4 here). They are one call on the host seam
    // now: `packages/server-core/src/sessions/SessionManager.ts` symbol
    // `warnIfClaudeSettingsCarryRefusedKeys`, beside
    // `warnIfProjectSettingsWidenDefaultMode`, on the same
    // `sendEvent({ type: 'info', level: 'warning' })` channel this queue feeds.

    // `claude-runtime` connections never speak to their endpoint directly: the
    // SDK subprocess talks Anthropic Messages to a loopback adapter which
    // re-shapes the turn for the gateway (or a BYO OpenAI-compatible endpoint).
    // This branch OWNS the SDK's auth env, so `resolveAuthEnvVars` is skipped —
    // it would either inject nothing (the provider type is deliberately absent
    // from `isAnthropicProvider`, T4) or, if that predicate is ever widened,
    // overwrite the loopback URL with the raw gateway URL + JWT.
    if (connection.providerType === 'claude-runtime') {
      return await this.startLocalAdapterRuntime(connection, slug, manager);
    }

    // Resolve auth env vars via shared utility
    const result = await resolveAuthEnvVars(connection, slug, manager, getValidClaudeOAuthToken);

    if (!result.success) {
      return { authInjected: false, authWarning: result.warning, authWarningLevel: 'error' };
    }

    // F1.958 — THIS session's envOverrides only, never the shared `process.env` every claude child spreads and hashes (session B's postInit re-keyed session A's child); the credential kind a connection does not use is NEUTRALIZED with '', as the adapter path and `llm-validation.ts` do.
    const resolvedAny = Object.keys(result.envVars).length > 0;
    const authOverrides: Record<string, string> = resolvedAny ? { ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '', ...result.envVars } : {};
    this.config.envOverrides = { ...this.config.envOverrides, ...authOverrides };

    // Pass mini model to SDK subprocess so built-in tools like WebFetch
    // use the correct summarization model (instead of hardcoded Haiku) — critical for custom providers whose endpoint lacks the default Haiku id.
    // F1.965 — THIS session's envOverrides, never the shared `process.env` Pi's and codex's children spread (`buildPiSubprocessEnv`),
    // and UNDER a value the host's overrides already carry: the precedence the old `process.env` write had.
    if (this.config.miniModel) {
      this.config.envOverrides = { ANTHROPIC_DEFAULT_HAIKU_MODEL: this.config.miniModel, ...this.config.envOverrides };
    }

    // P6.53 — the same off-switch on the DIRECT-Anthropic path. No window env
    // is emitted here (a `claude-*` id keeps the SDK's own model-tuned window),
    // so there is nothing to withhold; the disable is the whole projection.
    // Through `envOverrides` rather than `process.env`, for the reason the
    // adapter branch states: `process.env` is shared between sessions.
    if (this.config.autoCompaction?.enabled === false) {
      this.config.envOverrides = { ...this.config.envOverrides, DISABLE_AUTO_COMPACT: '1' };
    }
    // F1.1241 — P6.152's Extended-context hold left with the switch: each model's
    // own window decides and the host emits no CLAUDE_CODE_DISABLE_1M_CONTEXT
    // (an operator's export still reaches the child). What stays is the declared
    // cap: a connection stating a window below 1M for this `claude-` id gets it
    // as the SDK's compaction window. Before the operator knobs, which outrank it.
    const declaredWindowEnv = buildClaudeDeclaredWindowEnv(
      connection,
      this.config.model ?? connection.defaultModel,
      this.config.autoCompaction,
    );
    if (Object.keys(declaredWindowEnv).length > 0) {
      this.config.envOverrides = { ...this.config.envOverrides, ...declaredWindowEnv };
    }
    // P3.235 — and the two operator knobs, which DO cross on this path. The
    // sentence above is about a window we DERIVE from our catalogue; a window
    // the operator wrote by hand is an instruction, and the SDK still clamps it
    // with its own `Math.min(modelWindow, configured)`. Emits nothing when
    // neither knob is set (so a spawn without one stays byte-identical) and
    // nothing when compaction is off, where the disable above is the whole
    // projection.
    const directKnobEnv = buildClaudeAutoCompactionKnobEnv(this.config.autoCompaction);
    if (Object.keys(directKnobEnv).length > 0) {
      this.config.envOverrides = { ...this.config.envOverrides, ...directKnobEnv };
    }

    this.applyTelemetryCoverageMarker();
    return { authInjected: true };
  }

  /**
   * P2.423 — mark the SDK's OWN audit-event stream, so a SIEM can tell what it
   * is looking at and, more importantly, what it is NOT.
   *
   * ## Nothing here is built; the mechanism was always in the binary we ship
   *
   * Native-first, and the answer came back "configure": the shipped SDK carries
   * the whole exporter (`CLAUDE_CODE_ENABLE_TELEMETRY` 14 hits,
   * `OTEL_LOGS_EXPORTER` 22, `OTEL_EXPORTER_OTLP_ENDPOINT` 13, against a
   * nonsense control of 0), and `buildClaudeSubprocessEnv` spreads
   * `process.env` while stripping only the provider-routing keys. An operator
   * who exports those three already gets `claude_code.*` events out of a Nessy
   * session today. There was no gap to close, only a silence to break.
   *
   * ## The null that had to be settled first, and why a page could not settle it
   *
   * `startLocalAdapterRuntime` writes `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:
   * '1'`, and the two pages disagree about what that suppresses: `env-vars.md`'s
   * row says it disables telemetry, `monitoring-usage.md` never names the
   * variable at all. Undecidable from either, and the failure mode is silent —
   * switch on an exporter the same env quietly suppresses and the SIEM's silence
   * looks like "nothing happened". So it was read out of the shipped binary
   * (`@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`, manifest 2.1.223,
   * commit `4535f697`), where the whole decision is four functions:
   *
   *     function hXl(){if(process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC)
   *       return"essential-traffic";…return"default"}
   *     function Jxe(){return hXl()!=="default"}
   *     function rpp(){if(Jxe())return!1;…}                    // FIRST-PARTY reader
   *     function tpp(){return tr(process.env.CLAUDE_CODE_ENABLE_TELEMETRY)}
   *     …let t=tpp();if(t)e.push(...await mnb(r));if(rpp())e.push(gnb());
   *
   * Two independent branches of one `initializeTelemetry`. The transcript above
   * is quoted verbatim from the bundle and is the citation; the NAMES in it are
   * the minifier's and a bump reassigns them (P3.309), so read the branches by
   * what they contain rather than by what they are called. The predicate over
   * `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is the ONLY place that variable
   * reaches, and it gates Anthropic's own 300-second metric reader. The
   * operator's OTLP exporters — metrics AND the log/event stream — hang off the
   * `CLAUDE_CODE_ENABLE_TELEMETRY` reader instead, i.e. off that variable
   * alone. **The two settings therefore do not
   * fight.** The gateway path goes on suppressing Anthropic's first-party
   * channel (and DesignSync, Projects, `/feedback`, the live-preview tunnel and
   * the updater's version lookup, all of which the same flag gates by name)
   * while an operator's SIEM export works. That is the fact this row could not
   * get from either page, and it is why enabling is safe.
   *
   * ## What is still uncovered, which is the whole reason a marker exists
   *
   * The SDK speaks its own vocabulary: 25 event names in this build, every one
   * emitted through a single helper whose LogRecord body is
   * `claude_code.${name}` — `tool_decision`, `user_prompt`, `tool_result`,
   * `compaction`, `permission_mode_changed` and the rest. The host's Pi stream
   * speaks a DISJOINT one — `session.started`, `session.settled`,
   * `permission.decided`, `tool.completed` — and already carries
   * `nessy.telemetry.coverage = pi-sessions-only` for exactly this reason.
   * Neither set contains a single name from the other, so a SIEM query written
   * against either returns silence for the other, and P6.42's lesson is that
   * partial coverage nobody can see is worse than none at all.
   *
   * So the same key is written with a value naming THIS stream, through
   * `OTEL_RESOURCE_ATTRIBUTES` — the documented channel, not an invented one.
   * `monitoring-usage.md#multi-team-organization-support`: "Claude Code attaches
   * these values as attributes on every metric datapoint and event record, in
   * addition to sending them in the OTLP resource block."
   *
   * Two restraints, both deliberate:
   *
   * - **Only when the child will actually export.** A coverage marker on a
   *   session that emits nothing is noise, and it would also be a lie — it
   *   would claim a stream exists.
   * - **Never over an operator's own value for the key.** If they have already
   *   declared their coverage, they outrank us; we are describing their
   *   pipeline, not owning it.
   *
   * Through `envOverrides` rather than `process.env`, for the reason the adapter
   * branch states at length: `process.env` is shared between concurrent
   * sessions.
   */
  private applyTelemetryCoverageMarker(): void {
    // The env the CHILD will see, which is what decides whether it exports:
    // `buildClaudeSubprocessEnv` merges `process.env` under our overrides, so
    // an operator's ambient value and a per-session one both have to be read.
    const childEnv = { ...process.env, ...this.config.envOverrides };
    if (!isClaudeTelemetryEnabled(childEnv.CLAUDE_CODE_ENABLE_TELEMETRY)) return;

    // Never over an operator's own value for the key, and never a stray empty
    // pair from their trailing comma — both rules live in `withTelemetryCoverage`
    // now, shared with the codex side so the two can never drift apart.
    const attributes = withTelemetryCoverage(
      childEnv.OTEL_RESOURCE_ATTRIBUTES ?? '',
      CLAUDE_SDK_TELEMETRY_COVERAGE,
    );
    if (attributes === undefined) return;
    this.config.envOverrides = {
      ...this.config.envOverrides,
      OTEL_RESOURCE_ATTRIBUTES: attributes,
    };
  }

  /**
   * Start this session's local Anthropic-Messages adapter and point the SDK
   * subprocess at it.
   *
   * Transactional, mirroring `CodexAgent.createRuntime`: nothing is published
   * (neither the handle nor the env) until every step has succeeded, and a
   * partially started adapter is closed on the way out. A failure returns an
   * error-level warning rather than throwing — `SessionManager` surfaces it and
   * keeps the session — and, critically, leaves `ANTHROPIC_BASE_URL` unset in
   * both `process.env` and `envOverrides`, so a broken gateway session cannot
   * degrade into one that quietly bills api.anthropic.com.
   */
  private async startLocalAdapterRuntime(
    connection: LlmConnection,
    slug: string,
    credentialManager: CredentialManager,
  ): Promise<PostInitResult> {
    // postInit is normally once per agent, but a re-init must not strand the
    // previous listener: the ports are ephemeral, so an orphan cannot collide —
    // it would simply never be collected until the process exits.
    this.releaseLocalAdapter();
    const previousEnvOverrides = this.config.envOverrides;
    let handle: AdapterHandle | null = null;
    try {
      const upstream = await resolveClaudeRuntimeUpstream({ connection, slug, credentialManager });
      this.claudeRuntimeUpstreamKind = upstream.kind;
      const miniModel = this.resolveLocalAdapterMiniModel(connection);
      // P6.160 — what the SDK's four aliases mean on this child. Computed HERE,
      // beside the mini model it reads, so the map and the env below come from
      // one resolution; held on the agent so the turn admits exactly the
      // aliases whose variables were written.
      this.claudeRuntimeAliasModels = buildClaudeRuntimeAliasModels({
        sessionModel: this.config.model ?? connection.defaultModel,
        miniModel,
        servedModels: (connection.models ?? [])
          .map(model => (typeof model === 'string' ? model : model.id))
          .filter((id): id is string => Boolean(id)),
      });
      // Per-request wire routing (G3). Undefined for every connection whose
      // models are all chat-completions, which is every connection that existed
      // before the probe started recording a wire.
      const upstreamForModel = buildClaudeRuntimeWireRouter(connection, upstream);
      // P3.314 — the turn asks this same router whether ITS model is translated.
      // Held rather than rebuilt so the two questions cannot be answered from
      // different inputs: the adapter routes on what is stored here.
      this.claudeRuntimeWireRouter = upstreamForModel ?? null;
      // P2.422 — the correlation seam. `gatewaySessionFetch` is already the
      // exact `typeof fetch` shape `fetchImpl` accepts; without this argument it
      // was built, tested and reached no wire. The SDK child cannot carry the
      // header itself (it talks to a loopback port, not to the gateway prefix),
      // and the host serves many sessions from one process, so the id has to
      // travel as an ARGUMENT — `process.env.NESSY_SESSION_ID` names no session
      // here.
      //
      // `this.config.session?.id`, NOT `this.modeSessionId`: that getter
      // synthesizes a `temp-${Date.now()}` fallback, and a fabricated id is
      // worse than none — the gateway would aggregate turns under a key that
      // matches nothing. `gatewaySessionFetch(undefined, …)` degrades to a
      // pass-through, so an absent session simply sends no correlation header.
      //
      // Scope is NOT re-implemented here: `gatewayRequestHeaders` stamps only
      // the verified gateway prefix, so the loopback hop the SDK child makes
      // and a BYO upstream both stay bare. P6.43's second mutant is what pins
      // that; dropping the prefix check makes both start receiving the id.
      // P6.180 · the codex twin's sentence, from the same builder and on this
      // runtime's own durable channel. `queueDegradationNotice` latches by
      // identity, so a session says it once however often the adapter is
      // rebuilt — and `startAdapter` here runs before any turn exists, which is
      // exactly the case that queue was built for.
      const customHeaderNotice = customHeadersOffGatewayNotice('Claude', upstream);
      if (customHeaderNotice) this.queueDegradationNotice(customHeaderNotice);
      handle = await startAdapter({
        upstream,
        ...(upstreamForModel ? { upstreamForModel } : {}),
        // C4.10 (owner answer QF3 = B, 2026-09-11) — the idle abort for the
        // Anthropic PASSTHROUGH relay, supplied by the host because the adapter
        // is the dependency leaf of the pair and cannot import this module.
        //
        // Native-first is exhausted rather than skipped: the SDK's own byte
        // watchdog arms only for an `api.anthropic.com` base URL and every
        // session here points `ANTHROPIC_BASE_URL` at this loopback, so it
        // cannot fire (measured, P6.114/P6.115 — the surviving bound is the
        // SDK's ~9-minute transport timeout). Step 2 of the same rule is what
        // this line is: the host supplies the mechanism once, so the three
        // runtimes answer a stalled stream at the same deadline
        // (`NESSY_STREAM_IDLE_TIMEOUT_MS`, defaulting to the SDK's own
        // non-first-party 300 000 ms) instead of at three different ones.
        readWithIdleTimeout: reader => readWithIdleTimeout(reader),
        // P3.333 — the same `typeof fetch`, with the upstream STATUS recorded on
        // its way back. See {@link lastUpstreamApiError}: without this the
        // mapper's 403 branch cannot fire on this runtime at all.
        fetchImpl: this.observeUpstreamApiErrors(gatewaySessionFetch(this.config.session?.id)),
        // P3.98 + P3.122 — model spend the HOST caused, on its own reporting
        // line. Bound only when the host supplied a sink, so an agent built
        // without one starts the adapter exactly as before.
        ...(this.config.onHostOverheadUsage
          ? { onUpstreamCall: (call: UpstreamCallObservation) => this.reportHostOverheadCall(call) }
          : {}),
        /**
         * DA1.22 — the generation config THIS MODEL'S catalogue row published.
         *
         * Owner decision 2026-09-17: adopt the gateway's own `reasoning.effort`
         * and `sampling_params` rather than inventing values beside them. The
         * resolver is per-model because a connection holds many models and each
         * publishes its own row; the adapter applies them as DEFAULTS only, so
         * the SDK's own effort — and a user who turned thinking off — still win.
         *
         * `connection` is captured ONCE, at adapter start, rather than re-read
         * per request. The catalogue is refreshed at startup and on an explicit
         * refresh, so a mid-session change is not a case this has to serve, and
         * a config read on every turn of every session would be a real cost for
         * a value that does not move.
         *
         * On THIS runtime the effort half is very nearly inert by construction,
         * and that is the honest outcome rather than a gap: `anthropic/inbound.ts`
         * derives an effort from the SDK's own thinking setting whenever thinking
         * is on, and omits the whole `reasoning` block when it is off. The
         * sampling half is not inert — every gateway model was getting a
         * hand-typed `temperature: 0.7` / `top_p: 0.8` whatever its row said.
         */
        generationDefaultsForModel: (model: string) => resolveModelGenerationDefaults(connection, model),
        // P3.363 — the model-target tool-egress disclosure, with the TOOL NAMES.
        //
        // `factory.ts` already notes the egress at backend construction, where
        // the session's MCP tool set does not exist yet — so that notice can name
        // the target and not the tools. This sink is the seam where the two are
        // both in scope: W5-c's `onOutboundTools` hands up the names off the body
        // the adapter is about to send, and `noteModelTargetToolEgress` takes an
        // optional `toolNames` for exactly this reason, so no signature moves.
        //
        // NAMES ONLY. The schemas are the payload under discussion and are not
        // copied out of the body to describe themselves. The sink is
        // de-duplicated per `class + host + model namespace`, so this is one
        // notice per target per process rather than one per request, and it
        // WITHHOLDS NOTHING — the withholding posture is the owner's, and this is
        // the disclosure half.
        onOutboundTools: (info) => {
          noteModelTargetToolEgress({
            // Same shape `factory.ts` uses: an absent endpoint on a direct
            // anthropic connection means api.anthropic.com; on anything else it
            // means "the provider's own default", which this seam cannot name.
            baseUrl: connection.baseUrl?.trim()
              || (connection.providerType === 'anthropic' ? 'https://api.anthropic.com' : undefined),
            model: info.model,
            toolNames: info.toolNames,
            // DA2.15 — the host's ONE sink, the same field `factory.ts` passes
            // at backend construction and `codex-agent.ts` passes here. Absent
            // leaves the helper's own `console.warn` in place.
            emit: this.config.onModelTargetDisclosure,
          });
        },
      });
      // destroy() may have landed while the listener was binding; the handle is
      // ours to close and must not be published.
      if (this.localAdapterDisposed) throw new Error('claude-agent-destroyed');

      // The env goes through `envOverrides`, never `process.env`: concurrent
      // sessions each own a different loopback port, and `buildClaudeSubprocessEnv`
      // spreads the overrides AFTER process.env so ours wins.
      this.config.envOverrides = {
        ...previousEnvOverrides,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${handle.port}`,
        // The adapter authenticates upstream itself; the SDK still refuses to
        // start without *something* here.
        ANTHROPIC_API_KEY: 'not-needed',
        // NEUTRALIZED, not merely deleted. `postInit` clears this from
        // process.env above, but that is a one-time clear of a SHARED object:
        // `SessionManager.reinitializeAuth`'s reset restores its LAUNCH value
        // (a token the operator exported), and `buildClaudeSubprocessEnv` spreads
        // process.env UNDER these overrides. Since F1.958/F1.963 no postInit and
        // no reinitializeAuth writes RESOLVED auth there; the '' keeps a launch
        // token, or any later writer, out of this gateway subprocess. Same reason
        // `llm-validation.ts` pairs every credential it sets with a `''` for the
        // other kind.
        CLAUDE_CODE_OAUTH_TOKEN: '',
        // No telemetry/changelog fetches from a subprocess whose only reachable
        // endpoint is a loopback port that answers `/v1/messages` and nothing else.
        //
        // P2.315 — it does NOT cover everything, and this is the exception the
        // 1.18.0 release note got wrong. `data-usage.md#webfetch-domain-safety-check`:
        // "This check runs regardless of which model provider you use and is not
        // affected by `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`." Before
        // fetching a URL, WebFetch sends the requested hostname (hostname only,
        // not the URL, path or page) to `api.anthropic.com` for a safety
        // blocklist check, so on this path an INTERNAL hostname a user asks the
        // model to fetch can reach Anthropic — and, per the same page, if the
        // network blocks `api.anthropic.com` the fetch simply fails instead.
        //
        // The documented opt-out is a settings key, not an env var:
        // `settings-reference.md#skipwebfetchpreflight` — "Skip the WebFetch
        // domain safety check, which sends each requested hostname to
        // `api.anthropic.com` before fetching." It is present in the bundled
        // SDK's own `Settings` type and could ride `Options.settings`.
        //
        // IT IS NOW SET, and not from here: the owner ruled on it, and the seam
        // is `Options.settings` rather than this env block. Sitting of
        // 2026-09-05 §2.2 = **(C)** — "disable the preflight paired with a
        // host-supplied domain allowlist, the only option that removes the
        // egress without removing the control". The pairing is what the same
        // page prescribes ("With the check skipped, WebFetch attempts any URL
        // without consulting the blocklist, so pair it with `WebFetch`
        // permission rules if you need to restrict which domains Claude can
        // reach") and it needed nothing new: the operator's
        // `sandbox.network.deniedDomains` / `allowedDomains` already reach the
        // child through `managedSettings`, and the host's own `canUseTool` gate
        // judges every WebFetch on all three runtimes. See
        // `buildClaudeWebFetchPreflightSettings`, which also states the one case
        // that would otherwise be silent — an install with no operator domain
        // control at all.
        //
        // **P3.352 — "the egress itself cannot be proven from this tree" WAS
        // FALSE, and it is deleted rather than softened.** The native binary is
        // vendored and greppable, and at `claudeCodeVersion 2.1.247` it states
        // all four load-bearing facts itself (transcribed at 2.1.233 and
        // re-verified against the lifted bundle by C3.53 on 2026-09-11 — 4 pass,
        // 26 expect() calls at 2.1.247 — pinned by
        // `__tests__/claude-webfetch-preflight-markers.test.ts` so this
        // paragraph cannot rot the way its predecessor did):
        //
        //  - the endpoint is HARDCODED and the hostname travels as a QUERY
        //    PARAMETER: `` `https://api.anthropic.com/api/web/domain_info?domain=${encodeURIComponent(e)}` ``
        //    — so our loopback adapter cannot intercept it, `ANTHROPIC_BASE_URL`
        //    does not move it, and it is not a header we could strip;
        //  - the ONLY gate is the setting:
        //    `if(!ka().skipWebFetchPreflight)switch((await J4d(b,n)).status){case"allowed":break;case"blocked":throw…;case"check_failed":throw…}`;
        //  - the cache is ALLOW-ONLY, 128 entries, 5 minutes
        //    (`domainChecks=new DD({max:128,ttl:300000})`, written only on
        //    `can_fetch===!0`) — which is why a live probe MUST use a fresh
        //    hostname per run: a cached one produces no egress and reads exactly
        //    like a fix;
        //  - the setting's own describe names the audience: "Skip the WebFetch
        //    blocklist check for enterprise environments with restrictive
        //    security policies".
        //
        // What is genuinely live-only therefore shrinks to two questions — does
        // this execute in a PACKAGED gateway session, and is `WebFetch` in that
        // session's tool set — which is CRU-7 on the live checklist.
        //
        // The owner's three options, DECIDED 2026-09-05 in favour of (C):
        // (A) leave it — every WebFetch hostname, including an internal one,
        // reaches Anthropic, and a network that blocks `api.anthropic.com`
        // fails the fetch outright rather than degrading; (B) set
        // `skipWebFetchPreflight` through `Options.settings` — the egress stops
        // and so does the blocklist, so the model may fetch anything; (C) set it
        // AND pair it with a host-supplied domain allowlist, which is what the
        // page itself prescribes and is native-first: the runtime already ships
        // both `WebFetch(domain:…)` permission rules and
        // `sandbox.network.allowedDomains`, and this repo already parses both.
        // Pi and codex run no such preflight on any path, so the residual
        // difference still owes one disclosure row — now the OTHER way round,
        // because the three runtimes agree since (C) landed.
        //
        // P3.52 — SET HERE AND NOT ON THE SUBSCRIPTION TAIL, DELIBERATELY, and
        // the asymmetry is a POSTURE TRADE rather than a telemetry setting.
        // `env-vars.md#variables`, verbatim: "Set to any non-empty value, such
        // as `1`, to disable nonessential network traffic: auto-updates,
        // telemetry, error reporting, the `/feedback` command, Claude-drafted
        // feedback, release notes, the PR and MR status badge checks, and
        // availability checks such as the fast mode check. It also stops the
        // background runs of plugin `command` sources, which are local commands
        // rather than network traffic, because they can trigger dependency
        // installs." And: "Also disables feature-flag fetching, which makes
        // Remote Control and the other features that need feature-flag fetching
        // unavailable."
        //
        // Re-curled 2026-09-11 (C3.63). Two clauses moved and both are recorded
        // rather than silently dropped: "Doesn't affect gateway model discovery,
        // which has its own opt-in" — so this variable never bought that egress,
        // and what closes it is our never setting
        // `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` (see
        // `config/claude-provider-routing-env.ts` symbol
        // `CLAUDE_FIRST_PARTY_ASSUMPTION_ENV_KEYS`, which measured that gate) — and
        // "Official plugin marketplace auto-install isn't covered; disable it with
        // `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL`", which this fork
        // does not rely on either.
        //
        // So unsetting it would not merely restore telemetry — it would restore
        // auto-updates, release notes, feature-flag fetching and Remote Control
        // on a child whose only reachable upstream is a loopback port that
        // answers `/v1/messages`. Every one of those is a request this fork cannot
        // route, and Remote Control is a control channel a T-Bank deployment
        // has not asked for. The GATEWAY path takes the whole trade; the
        // subscription path is GATED for this plan and stays untouched, which
        // is why the two paths differ.
        //
        // The page's own trap, worth reading twice before "fixing" a value:
        // "**Setting it to `0` or `false` still disables this traffic**, unlike
        // most on/off variables; unset the variable to allow it again." The
        // opt-out is DELETING the key, never writing a falsy one.
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        // P6.396 — THE CLIENT-SIDE OMISSION THE PAGE PRESCRIBES FOR EXACTLY
        // THIS ADAPTER, and native-first case (1) in its purest form: the
        // runtime already has the switch and we had not set it.
        //
        // The SDK prepends an attribution block — client version plus a
        // fingerprint derived from the conversation — as the FIRST `system`
        // block. `api.anthropic.com` strips it positionally; nothing else does.
        // `llm-gateway-protocol.md#system-prompt-attribution-block`, verbatim:
        // "The strip is positional, so it only works when the gateway forwards
        // the `system` array unchanged … prepending another system block,
        // reordering the array, or converting it to a single string defeats the
        // strip, and the block then reaches the model and the prompt cache key."
        //
        // Converting it to a single string is precisely what this adapter does:
        // `codex-responses-adapter/src/anthropic/inbound.ts` runs
        // `systemToInstructions(raw.system)` and joins the parts into one
        // `instructions` string. So on this path the block is not stripped by
        // anyone — it reaches the gateway's model as prompt.
        //
        // The page's own remedy, verbatim: "If your gateway must reshape system
        // content, set `CLAUDE_CODE_ATTRIBUTION_HEADER=0` so Claude Code omits
        // the block. Anthropic and the cloud providers' Claude endpoints read
        // the block for attribution, so omit it at the client rather than
        // stripping or moving it in the gateway." Omitting it in the ADAPTER was
        // the option we did not take, on the page's own advice.
        //
        // Scope, and why it is here rather than beside the subscription tail:
        // this is the adapter path. A subscription session talks to
        // `api.anthropic.com`, where the strip works and the block is read for
        // attribution — removing it there would take something the endpoint
        // wants and give nothing back.
        //
        // The page also carves out one exception that CANNOT apply here: the
        // block survives `0` on auto-mode classifier requests only while they go
        // to `api.anthropic.com` with no third-party provider selected. Behind a
        // loopback base URL both conditions fail, so the classifier requests
        // lose the block too — which is the intent, since they travel the same
        // adapter to the same upstream.
        //
        // `'0'` and not a deletion: unlike its neighbour above (whose own trap
        // is quoted there), this variable is a NORMAL boolean — the page says
        // "set … `=0`" and the binary reads it as one.
        CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
        // P6.374 · the two documented escapes for this connection's upstream,
        // absent unless the operator set them. See
        // {@link buildClaudeGatewayEscapeEnv} for the page's own sentences and
        // for why they are two flags rather than one.
        ...buildClaudeGatewayEscapeEnv(connection),
        ...(miniModel ? { ANTHROPIC_DEFAULT_HAIKU_MODEL: miniModel } : {}),
        // P6.160 — the other three of the same family, so an agent pinned to
        // `opus` resolves instead of being substituted and warned at. Derived
        // from the map above rather than recomputed, and `haiku` is deliberately
        // not among them: the line directly above already owns that name from a
        // different (and correct) resolution.
        ...buildClaudeRuntimeAliasModelEnv(this.claudeRuntimeAliasModels ?? {}),
        // The SDK has no catalogue entry for a gateway id, so without this it
        // falls back to its own constant and both the context readout and the
        // auto-compaction point describe a model that is not running.
        ...buildClaudeMaxContextTokensEnv(connection, this.config.model ?? connection.defaultModel),
        // …and for the one id shape where that variable is inert on its own — a
        // non-`claude-` id containing `[1m]` — the documented companion that
        // makes it apply. Emits nothing for every id we ship today (P3.44).
        ...buildClaude1MContextCorrectionEnv(connection, this.config.model ?? connection.defaultModel),
        // …and without THIS the SDK never acts on either number: an id it does
        // not know resolves to auto-compact window source "auto", which its own
        // gate reads as "skip proactive compaction entirely". See the function.
        //
        // P6.53: unless the host's policy says OFF, in which case the SAME call
        // emits the SDK's own `DISABLE_AUTO_COMPACT` instead — turning the
        // window on here is exactly how a switched-off session got it back.
        ...buildClaudeAutoCompactionEnv(
          connection,
          this.config.model ?? connection.defaultModel,
          this.config.autoCompaction,
        ),
        // F1.1241 — a `claude-` id (BYO card) whose connection declares a window below 1M.
        ...buildClaudeDeclaredWindowEnv(connection, this.config.model ?? connection.defaultModel, this.config.autoCompaction),
        // P3.235 — AFTER the call above, and the order is the whole point: both
        // can write `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, and the number the
        // operator wrote by hand outranks the one derived from our catalogue.
        // Emits nothing when compaction is off, so it cannot re-arm what the
        // line above just disabled.
        ...buildClaudeAutoCompactionKnobEnv(this.config.autoCompaction),
      };
      // After the overrides above, because the marker is only written when the
      // MERGED env says the child will export — and it is one of the two envs
      // that decide that.
      this.applyTelemetryCoverageMarker();
      this.localAdapter = handle;
      this.debug(
        `Claude runtime adapter listening on 127.0.0.1:${handle.port} (upstream: ${upstream.kind}`
        + `${upstreamForModel ? ', per-model anthropic-wire routing on' : ''})`,
      );
      // The adapter is up, so the session works — but if neither env above could
      // be emitted, this session will never compact and nothing else would ever
      // say so. Surfaced HERE rather than logged, because a debug line is the
      // same silence with extra steps.
      return {
        authInjected: true,
        ...buildClaudeContextWindowWarning(
          connection,
          this.config.model ?? connection.defaultModel,
          this.config.autoCompaction,
        ),
      };
    } catch (error) {
      this.config.envOverrides = previousEnvOverrides;
      if (handle) {
        try {
          await handle.close();
        } catch (closeError) {
          this.debug(`Claude runtime adapter rollback close failed: ${closeError instanceof Error ? closeError.message : String(closeError)}`);
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      return {
        authInjected: false,
        authWarning: `Claude runtime adapter failed to start: ${message}`,
        authWarningLevel: 'error',
      };
    }
  }

  /**
   * The model built-in SDK tools (WebFetch summarization, title generation) run
   * on when the endpoint is a gateway. The SDK's built-in default is a Haiku id
   * no gateway serves, so an unresolved value here is a guaranteed 404 on those
   * tools — hence the fallback all the way down to the session model.
   *
   * Two resolvers, in this order, because the catalog changes shape underneath
   * them (T7):
   *
   * 1. `resolveGatewayFastModelId` matches the gateway's `fast` ALIAS, which
   *    `fetchNestorModels` surfaces as `shortName`. It is the only one that
   *    survives the startup model refresh — that refresh replaces
   *    `connection.models` wholesale with the API's list, in the API's order.
   * 2. `getMiniModel`, which since P6.1080 asks the endpoint's OWN `fast` alias
   *    before its keyword search — so on a gateway catalogue the two resolvers
   *    now agree by construction rather than by the seeding order. Its keyword
   *    fallback remains for BYO catalogues that declare nothing.
   *
   *    The sentence this bullet used to carry — that no gateway id contains
   *    'mini'/'haiku'/'flash', so the tier fell through to the LAST catalog
   *    entry — is REFUTED (2026-09-11, W12-f): the gateway's coder id is
   *    `tgpt/deepseek-v4-flash-0731`, and on the two cards whose keyword list
   *    includes that word the tier resolved to the FLAGSHIP.
   *
   * Ids are always read from the connection, never pinned here: the gateway
   * rotates them.
   */
  private resolveLocalAdapterMiniModel(connection: LlmConnection): string | undefined {
    return this.config.miniModel
      ?? resolveGatewayFastModelId(connection)
      ?? getMiniModel(connection)
      ?? connection.defaultModel
      ?? this._model;
  }

  /** Drop the published handle and close it. Idempotent; does NOT end the session. */
  private releaseLocalAdapter(): void {
    const handle = this.localAdapter;
    this.localAdapter = null;
    // P6.160 — and the alias map, for the same reason and in the same breath:
    // it describes what the child that is going away was spawned with. A
    // respawn writes a fresh one from the connection it actually resolved.
    this.claudeRuntimeAliasModels = null;
    // The router describes the adapter that is going away, not the session, so
    // it is dropped with the handle. A re-init sets it again from the connection
    // it actually resolved; a stale one would answer for a listener nobody talks
    // to any more.
    this.claudeRuntimeWireRouter = null;
    if (!handle) return;
    void handle.close().catch(error => {
      this.debug(`Claude runtime adapter close failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /**
   * Terminal close for the per-session adapter. Idempotent, and safe to call
   * while one is still starting: `startLocalAdapterRuntime` re-checks the flag
   * after the listener binds and closes that handle itself.
   */
  private closeLocalAdapter(): void {
    this.localAdapterDisposed = true;
    this.releaseLocalAdapter();
  }

  // Config watcher methods (startConfigWatcher, stopConfigWatcher) are now inherited from BaseAgent
  // Thinking level methods (setThinkingLevel, getThinkingLevel) are inherited from BaseAgent

  protected override get deliversPathScopedActivations(): boolean { return true; }

  // Permission command utilities (getBaseCommand, isDangerousCommand, extractDomainFromNetworkCommand)
  // are now available via this.permissionManager

  /**
   * Respond to a pending permission request.
   * Uses permissionManager for whitelisting.
   */
  respondToPermission(
    requestId: string,
    allowed: boolean,
    alwaysAllow: boolean = false,
    options?: PermissionResponseOptions,
  ): void {
    this.debug(`respondToPermission: ${requestId}, allowed=${allowed}, alwaysAllow=${alwaysAllow}, pending=${this.pendingPermissions.has(requestId)}`);
    // An MCP elicitation's dialog rides the same channel; its answer arrives in
    // `options.askUserAnswer` and belongs to the bridge, not to the tool
    // whitelisting below.
    if (this.elicitationAsk.respond(requestId, allowed, options?.askUserAnswer)) return;
    // The model's own `AskUserQuestion` rides the same channel and settles the
    // `canUseTool` promise the SDK is blocked on. Checked before the whitelisting
    // below for the same reason: an option label is not a command to remember.
    if (this.modelQuestionAsk.respond(requestId, allowed, options?.askUserAnswer)) return;
    const pending = this.pendingPermissions.get(requestId);
    if (pending) {
      this.debug(`Resolving permission promise for ${requestId}`);

      // If "always allow" was selected, remember it (with special handling for curl/wget)
      // C3.312 — except on a card that says the host store is the wrong place;
      // see `PendingPermission.suppressHostCommandWhitelist`.
      if (alwaysAllow && allowed && !pending.suppressHostCommandWhitelist) {
        if (pending.toolName === 'Bash' && ['curl', 'wget'].includes(pending.baseCommand)) { // F1.1108: a Bash card's only — the Bash consult is the one reader of a domain
          // For curl/wget, whitelist the domain instead of the command
          const domains = this.permissionManager.networkCommandHosts(pending.command); // UA12.73: every host of one plain command
          if (domains.length > 0) {
            for (const domain of domains) this.permissionManager.whitelistDomain(domain);
            this.debug(`Added domains "${domains.join(', ')}" to always-allowed domains`);
          }
        } else if (!this.permissionManager.isDangerousCommand(pending.command)) {
          // D1.291 — the WHOLE line against the list for a Bash card, and
          // D1.306 — the key the CONSULT reads, per card type. This branch
          // stored `getBaseCommand(pending.command)` for every card: on a Bash
          // card that made Always-Allow on `git push origin main` write `git`,
          // and on a file-write or API card it wrote a key no reader looks up,
          // so the click bought nothing and said nothing. The rule for every
          // card type lives beside those consults, in
          // {@link sessionWhitelistKeyForApproval}, so the two halves cannot
          // drift apart again.
          const whitelistKey = sessionWhitelistKeyForApproval(
            pending.toolName,
            pending.command,
            pending.baseCommand,
          );
          if (whitelistKey) {
            this.permissionManager.whitelistCommand(whitelistKey);
            this.debug(`Added "${whitelistKey}" to always-allowed commands`);
          } else {
            this.debug(`Always Allow for "${pending.baseCommand}" remembers nothing (no session key narrows it)`);
          }
        }
      }

      pending.resolve(allowed, alwaysAllow, options?.comment);
      this.pendingPermissions.delete(requestId);
    } else {
      this.debug(`No pending permission found for ${requestId}`);
    }
  }

  /**
   * Raise one `canUseTool` approval on the permission channel and wait for the
   * answer — the R3 half of the must-fix R2 left behind.
   *
   * The same map, the same `respondToPermission` route and the same durable
   * approval bookkeeping as the PreToolUse `prompt` branch; only the id differs
   * (the SDK's own control-request id, so the two cards a single tool call can
   * raise cannot collide).
   *
   * Three properties this must hold, each of which is a way the SDK hangs:
   * every path settles exactly once; an aborted turn settles it too, because
   * `forceAbort` tears the query down; and no handler at all rejects rather than
   * resolving, so the caller can tell "the user said no" from "there was no
   * user". F1.169 adds a FOURTH, at the call site: the wait is BOUNDED there.
   *
   * `noAlwaysAllow` was set UNCONDITIONALLY here, for the reason the field
   * documents — "For prompts nothing can remember … the button would promise
   * what neither side implements". Two halves to that, and they have aged
   * differently.
   *
   * The half that STANDS: our own session whitelist cannot suppress a prompt the
   * SDK's rules raise, which is why the pending entry below carries
   * `suppressHostCommandWhitelist` rather than writing to that store.
   *
   * The half C3.7 then qualified: "a remembered approval would have to become a
   * rule in the user's settings file" is true only of the settings destinations
   * — an entry at `destination: 'session'` writes nothing anywhere and still
   * binds for the rest of the turn.
   *
   * **C3.312 built the remaining piece, so the flag is now CONDITIONAL.** The
   * runtime hands us its own `suggestions` per call and documents them as this
   * button's mechanism; `claudeCallCanRememberForSession` asks whether
   * {@link claudeSessionPermissionUpdateBoundary} would forward any of them, and
   * the button appears only then. Every card that fails the predicate — an edit
   * card, whose suggestion the runtime spells as a `setMode`; a call with no
   * suggestion at all — still sends `noAlwaysAllow: true` and behaves exactly as
   * it did before. **A Bash card was a third such case until C4.46** (owner,
   * 2026-09-13), which removed the type clause and paired the button with the
   * persist cut in `SessionManager.respondToPermission`; the reasoning is on
   * {@link claudeCallCanRememberForSession}.
   */
  private askToolApproval(
    request: ClaudeToolApprovalRequest,
    signal?: AbortSignal,
  ): Promise<ClaudeToolApprovalAnswer> {
    const handler = this.onPermissionRequest;
    if (!handler) {
      return Promise.reject(new Error(`${this.backendName} has no interactive permission handler.`));
    }
    return new Promise<ClaudeToolApprovalAnswer>(resolve => {
      let settled = false;
      // P6.951 — an OBJECT rather than a boolean, so a denial can carry the
      // user's note to the SDK's own `deny.message`. An abort and a teardown
      // settle with no comment, which is correct: nobody wrote one.
      // C3.312 — `rememberForSession` rides the same settle, and it is re-tested
      // against the REQUEST rather than trusted off the wire: `noAlwaysAllow`
      // asks a client not to offer the button, and `apps/ios/PROTOCOL-CONFORMANCE.md`
      // records that a client which ignores it is a real shape. A grant this
      // runtime would drop must not be produced by one.
      const settle = (allowed: boolean, alwaysAllow?: boolean, comment?: string) => {
        if (settled) return;
        settled = true;
        this.pendingPermissions.delete(request.requestId);
        const remember = allowed === true
          && alwaysAllow === true
          && request.canRememberForSession === true;
        resolve({
          allowed,
          ...(remember ? { rememberForSession: true } : {}),
          ...(comment ? { comment } : {}),
        });
      };
      if (signal?.aborted) {
        settle(false);
        return;
      }
      signal?.addEventListener('abort', () => { if (this.pendingPermissions.has(request.requestId)) this.withdrawAbandonedCard(request.requestId); else settle(false); }, { once: true }); // F1.541: withdrawn once shown, one line for one
      // Both of the above settle with no `alwaysAllow` and no comment, which is
      // correct: nobody answered.
      this.pendingPermissions.set(request.requestId, {
        resolve: (allowed, alwaysAllow, comment) => settle(allowed, alwaysAllow, comment),
        toolName: request.toolName,
        command: request.command,
        baseCommand: this.permissionManager.getBaseCommand(request.command),
        // C3.312 — the runtime's own session rule is the whole effect of a
        // remember here; the host's command whitelist is the wrong store and for
        // everything but Bash the `command` is not even a command.
        suppressHostCommandWhitelist: true,
      });
      handler({
        requestId: request.requestId,
        toolName: request.toolName,
        command: request.command,
        description: request.description,
        ...(request.type ? { type: request.type } : {}),
        ...(request.reason ? { reason: request.reason } : {}),
        // C3.370 — the chip that says WHO is asking. This projection is
        // field-by-field rather than a spread, which is why adding the value to
        // `claudeToolApprovalRequest` alone would have been a green no-op: the
        // half that ships is this line.
        ...(request.agentLabel ? { agentLabel: request.agentLabel } : {}),
        // C3.312 — withheld unless the RUNTIME offered a suggestion for this
        // call that `claudeSessionPermissionUpdateBoundary` will forward. The
        // predicate is `claudeCallCanRememberForSession`; every card that fails
        // it behaves exactly as it did at HEAD.
        noAlwaysAllow: request.canRememberForSession !== true,
        ...(request.defaultToNo ? { defaultToNo: true } : {}), // F1.1219 — field-by-field, so this line is the half that ships
        // P6.709 — the CHILD asked. This is the SDK's own `can_use_tool`
        // control request relayed to our card, which is what makes it
        // `claude_native` and not `host_gate`: the rules that raised it are the
        // user's own settings inside the child, not our permission gate.
        origin: 'claude_native',
      });
    });
  }

  /**
   * Settle every card still on screen with a refusal.
   *
   * Called from the two teardown paths. Before R3 both simply dropped the map,
   * which was harmless while every waiter was a PreToolUse hook inside a process
   * about to die; a `canUseTool` waiter is a promise the SDK is blocked on, and
   * an unsettled one is the "no control_response … the tool stays blocked
   * indefinitely" case the SDK's own types warn about.
   */
  private cancelPendingPermissions(): void {
    for (const pending of [...this.pendingPermissions.values()]) {
      pending.resolve(false);
    }
    this.pendingPermissions.clear();
    this.gateApprovedToolUseIds.clear();
  }

  // isInSafeMode() is now inherited from BaseAgent

  // P3.375 — `checkToolPermission`, a private method with no caller, was
  // deleted here. It ended `// All other tools are auto-approved / return
  // { allowed: true }`, so reviving it would have installed a
  // permit-by-default decision point beside `runPreToolUseChecks`, which is the
  // one authority this runtime actually consults. A dead permit-all is the more
  // dangerous half of a dead method, which is why the deletion is recorded and
  // not silent.

  /**
   * The model's `SlashCommand` tool, Claude half. It arrives with a BARE
   * command string (`/compact …`) and goes through the SAME
   * `parseSessionCommand` classifier the user's typed form goes through — the
   * `PiAgent.dispatchSlashCommand` shape — so argument parsing, whole-message
   * matching and the blocked set cannot drift between the two runtimes.
   *
   * `/help` is deliberately NOT answered here even though Pi's copy answers it:
   * `handlers/slash-command.ts` answers `help` BEFORE it touches
   * `ctx.dispatchSlashCommand`, a committed invariant
   * (`session-tools-core/src/handlers/slash-command.test.ts`, "answers help
   * without backend dispatch"), so a third copy of that text would be pure
   * drift surface. The model-callable allowlist stays `compact | help` and
   * lives in ONE place — `ALLOWED_SLASH_COMMANDS` plus the tool schema's
   * `z.enum(['compact','help'])`. Do not add a second list here.
   *
   * The throw is the contract for everything else, exactly as on Pi.
   */
  private dispatchSlashCommand(command: string): string {
    const trimmedCommand = command.trim();
    const parsed = parseSessionCommand(trimmedCommand);
    if (parsed?.kind === 'compact') {
      this.pendingModelCompaction = parsed.customInstructions
        ? { customInstructions: parsed.customInstructions }
        : {};
      this.debug(`[SlashCommand] model requested /compact; deferred to this turn's boundary`);
      // Truthful, and deliberately NOT starting with "Compacted": SessionManager
      // stamps `compaction_complete` on any `info` message with that prefix
      // (`SessionManager.ts`, the `info` case: `event.message.startsWith('Compacted')`),
      // and the pre-plan-execution flow waits on that event. The tool result
      // reaches the model as a `tool_result` rather than an `info`, so this
      // string does not reach that sniffer today — but the wording is one
      // refactor away from becoming an info banner, and the false completion it
      // would fire is silent.
      return 'Queued: the session context will be compacted as soon as this turn ends. '
        + 'The Claude runtime cannot compact mid-turn, so nothing in this turn changes; '
        + 'continue and finish your work normally.';
    }

    throw new Error(`Unknown or blocked slash command: ${trimmedCommand || '(empty)'}`);
  }

  /**
   * Consume a model-requested `/compact` at the turn boundary and run it
   * through the EXISTING user-typed path — `chat()` → `parseSessionCommand` →
   * `chatImpl`'s `SDK_SLASH_COMMANDS` branch → a bare resumed
   * `query({ prompt: '/compact …' })`. There is deliberately no second
   * mechanism: what diverges between the user's request and the model's is the
   * TIMING, not the mapping.
   *
   * The nested turn's `complete` is dropped: this is a continuation of the
   * caller's turn, and `SessionManager`'s `complete` case accumulates usage,
   * records usage metrics and records a goal turn — a second one would
   * double-count all three. Everything else the compaction emits (the
   * adapter's `info: 'Compacted Conversation'` on `compact_boundary`, any
   * result text when the SDK reports it had nothing to summarize) is
   * forwarded unchanged.
   */
  private async *drainPendingModelCompaction(): AsyncGenerator<AgentEvent, number | null> {
    const pending = this.pendingModelCompaction;
    this.pendingModelCompaction = null;
    if (!pending) return null;

    const command = pending.customInstructions
      ? `/compact ${pending.customInstructions}`
      : '/compact';
    this.debug(`[SlashCommand] turn drained — running the model's deferred ${command}`);

    // The nested turn re-enters `chatImpl`, whose FIRST statement now hands
    // back every steer it finds (F1.238). It used to CLEAR the one-string slot,
    // which wiped the outer turn's undelivered steer — a message the USER typed
    // mid-turn — before the outer `finally` could emit `steer_undelivered`, so
    // `SessionManager` never re-queued it and the text was silently destroyed.
    // No error, no queue entry, nothing.
    //
    // Measured with a positive control on the real rig: a mid-turn steer alone
    // yields `["complete", "steer_undelivered"]`; the same turn with a model
    // `/compact` yielded `["complete", "info"]` before this guard existed.
    //
    // `base-agent.ts` guards the identical reentrancy on
    // `preModelAbortController` with an identity check; this is the same idea
    // applied to the sibling field the same `finally` manages. The outer
    // turn's steers are taken OUT for the nested turn and put back AHEAD of
    // anything it left behind — they are the older ones — so the outer
    // `finally` reports them, each under its own id, in arrival order.
    const outerSteers = this.suspendSteerTurnForNestedTurn(); // F1.335 — its steers, turn number and pause state
    // R16 — the nested turn's post-compaction context size, handed BACK to the
    // caller. The nested `complete` is filtered out below (it is a continuation,
    // not a second turn), and it is also the only place the corrected size
    // exists — so without returning it the model-requested path would compact
    // and still leave the caller's own `complete` carrying the pre-compaction
    // number. Measured: the badge stayed at 180 000 with `post_tokens` 24 000
    // sitting in an event that never leaves this function.
    let nestedContextTokens: number | null = null;
    try {
      for await (const event of this.chat(command)) {
        if (event.type === 'complete') {
          // `contextTokens`, NOT `inputTokens`. The nested turn's own input IS
          // the pre-compaction conversation — it was sent to be summarized — so
          // reading that would hand the caller the very number this row exists
          // to stop showing. The nested turn set `contextTokens` from its own
          // boundary; that is the size the session is left holding.
          const nested = event.usage?.contextTokens;
          if (typeof nested === 'number' && Number.isFinite(nested) && nested > 0) {
            nestedContextTokens = nested;
          }
          continue;
        }
        yield event;
      }
    } finally {
      // F1.335 — the outer turn's FIFO comes back as it was: its steers AHEAD of anything the
      // nested turn left (they are the older ones), and its turn number and pause state.
      this.resumeSteerTurnAfterNestedTurn(outerSteers);
    }
    return nestedContextTokens;
  }

  /**
   * P2.299 — Claude compacts on demand, and this is the override that says so at
   * the `BaseAgent.chat` seam.
   *
   * The mechanism is `chatImpl`'s `SDK_SLASH_COMMANDS = ['compact']` branch,
   * which writes the trimmed command to the live input with NO context wrapping
   * — the one path in this file that deliberately skips `buildTextPrompt`. A
   * `true` here does not answer the command; it lets it reach that branch. The
   * claim and the branch move together or the biconditional in
   * `__tests__/session-command-runtime-capability-seam.test.ts` fails.
   */
  protected override canCompactContext(): boolean {
    return true;
  }

  /**
   * F1.6 (origin D1.77) — `/quota` on the Claude Nessy Gateway card READS the
   * gateway budget, with the same host-side read the Pi card makes.
   *
   * `claude-gateway` carries the same base URL, the same dp JWT prefill and the
   * same per-user limiter as the Pi gateway card. DA1.17 option B had this
   * override NAME that budget ("run /quota on a Pi session") because reading
   * it meant widening `offersNestorQuota`
   * (`agent/backend/composer-capabilities.ts`), a pinned posture that was the
   * owner's to take. OWNER 2026-09-18 ~16:40, item 3, build (b) took it: the
   * menu offers the row on every gateway card, and this answer is the budget
   * itself through {@link NessyGatewayQuotaRead} — the pointer is gone, because
   * a card that can SHOW the number must not also point elsewhere for it.
   *
   * Off the gateway — a BYO `claude-custom` endpoint — there is no Nessy budget
   * to read, so the base answer stands and NO request is made. The
   * discriminator is the CONNECTION's `baseUrl` through
   * {@link isNessyGatewayBaseUrl}, the WHOLE-URL rule `offersNestorQuota` reads
   * (DA1.44 and review R1 narrowed it twice, 2026-09-17), so the menu, this
   * answer and the dp credential are one reading.
   *
   * Stop: `/quota` answers at the `BaseAgent.chat` seam, outside any turn and
   * its controller, so `forceAbort`, `abort` and `destroy` each abort the read
   * — the same three paths `PiAgent` aborts its own from.
   */
  private readonly nessyGatewayQuota = new NessyGatewayQuotaRead();

  /** The quota read's transport — keeps tests off the live gateway and out of `~/.nessy`. */
  protected quotaTransport(): { fetchImpl: typeof fetch; credsPath?: string } {
    return { fetchImpl: fetch };
  }

  protected override async *describeQuota(): AsyncGenerator<AgentEvent> {
    const slug = this.config.connectionSlug;
    const connection = slug ? getLlmConnection(slug) : null;
    if (!isNessyGatewayBaseUrl(connection?.baseUrl)) {
      yield* super.describeQuota();
      return;
    }
    const { fetchImpl, credsPath } = this.quotaTransport();
    yield* this.nessyGatewayQuota.describe({
      fetchImpl,
      ...(credsPath ? { credsPath } : {}),
      baseUrl: connection?.baseUrl,
    });
  }

  /**
   * P6.352 / P6.711 — the claude arm of the MCP inventory, which
   * `base-agent.ts`'s own docblock has promised since the row landed and which
   * existed nowhere: *"A runtime that publishes its own inventory overrides
   * this — `ClaudeAgent` with `Query.mcpServerStatus()`"*. `/mcp` on a claude
   * session was answering from the host pool, i.e. from what we asked the child
   * to load rather than from what the child believes.
   *
   * Native-first, step 1: the verb is the runtime's own. Vendored
   * `sdk.d.ts:2502` — `mcpServerStatus(): Promise<McpServerStatus[]>` — whose
   * element carries `name`, `status`, an `error` *"available when status is
   * 'failed'"* and `tools` *"available when connected"*. The `error` is the
   * CHILD's own failure reason (the pool keeps its own since P6.715), which is
   * why overriding is a gain and not a second spelling.
   *
   * Falls back to the pool rather than to `null` when there is no live child:
   * between turns `currentQuery` is null and the session still HAS servers —
   * answering "no inventory" there would be a worse lie than the one this
   * override removes. The same reason the read is not routed through the live
   * settings reconciler: this is a read, and it must work when nothing is
   * running.
   */
  /**
   * D1.155 — `SessionEnd`, with the documented exit reason, once.
   *
   * Byte for byte `CodexAgent.emitSessionEndOnce`'s shape, deliberately: the
   * `!this._sessionStartEmitted` guard is what stops a session that never
   * started from announcing that it ended, and the latch is what makes a second
   * teardown a no-op rather than a second hook run.
   *
   * W19-r drove this on a headless rig and claude was the only runtime with
   * NOTHING here: SIGTERM exited 143 and SIGINT 130, the process tree was gone
   * on both, and `SessionEnd` was absent on both. Pi ran it on SIGTERM. So a
   * user's `hooks.json` cleanup hook — the ordinary use of this event — simply
   * did not run on this backend.
   */
  /**
   * D1.193 — a refreshed Claude OAuth token reaching a LIVE session.
   *
   * ## The gap, measured
   *
   * The token reaches the SDK child as `CLAUDE_CODE_OAUTH_TOKEN` in its
   * ENVIRONMENT, written once at `postInit` through `resolveAuthEnvVars`.
   * Nothing pushed a refreshed one afterwards: `SessionManager.reinitializeAuth`
   * runs at `initialize()` and from the connection-save RPC paths, never from an
   * auth error. Pi has had the other half for a long time —
   * `PiAgent.refreshAndPushTokens` sends `token_update` to the running
   * subprocess on a 401 — so a long claude session ended at an expiry whose only
   * remedy was restarting the app, while the same expiry on Pi was invisible.
   * (WI-e's A3.14, item 2: this is named there as one of the two things owed
   * BEFORE the Pro/Max card could default on.)
   *
   * ## Why this is a refresh and a retry, and NOT a respawn mechanism
   *
   * The row and its proposal both priced "recreate the child with the new env",
   * because the child's environment is fixed at spawn and the SDK has no live
   * setter for it. On the path this actually fires from there is nothing left to
   * recreate: an auth failure arrives as `process exited with code 1`, which
   * means the stream already ended and `settleLiveSessionEnd` has already set
   * `currentQuery = null`. The retry therefore spawns a fresh child that reads
   * the refreshed env by itself. Stated because it is the difference between a
   * size-M design and this one, and because a future caller from a path where
   * the child is still ALIVE would need the respawn this does not do.
   *
   * ## What it does not do, deliberately
   *
   * - It does not refresh anything itself. `getValidClaudeOAuthToken`
   *   (`auth/state.ts`) owns the refresh mutex, the dual write to both
   *   credential locations and the deliberately conservative clear that fires
   *   only on `invalid_grant`-shaped errors. A second refresher beside it is the
   *   shape this repo has paid for; this is a consumer.
   * - It returns `false` when the token came back UNCHANGED. That is the whole
   *   guard against a retry loop: if the credential is simply dead, nothing
   *   moved, the caller falls through to the typed error, and the user meets the
   *   same card they met before this row.
   * - It only acts on an `oauth` connection. Every other `authType` puts an API
   *   key in that env, and `getValidClaudeOAuthToken` has nothing to say about
   *   one.
   *
   * F1.958 — NOT `process.env`, which this method also wrote until then: it is
   * shared between sessions and `buildClaudeSubprocessEnv` spreads it into every
   * claude child, whose signature hashes it — so one session's renewal re-keyed
   * (and respawned) every other session's child. The per-session `envOverrides`
   * copy is the only copy, and "unchanged" is measured against it.
   */
  private async refreshClaudeOAuthTokenForLiveSession(
    connection: { authType?: string } | null,
    slug: string | null | undefined,
  ): Promise<boolean> {
    if (!connection || !slug) return false;
    if (connection.authType !== 'oauth') return false;
    const previous = this.config.envOverrides?.CLAUDE_CODE_OAUTH_TOKEN; // F1.958 — the session's own copy
    let refreshed: string | null = null;
    try {
      refreshed = (await getValidClaudeOAuthToken(slug)).accessToken;
    } catch (error) {
      // FAILS CLOSED onto the pre-row behaviour: the user meets the typed
      // credential error, which is what they met before this seam existed.
      this.debug(`[ClaudeAgent] OAuth live refresh failed: ${String(error)}`);
      return false;
    }
    if (!refreshed || refreshed === previous) return false;
    // F1.958 — no `process.env` write (see above): that object is shared by every
    // session's child env and signature.
    // The per-session copy is the only copy, and it is what this session's next spawn reads.
    this.config.envOverrides = {
      ...this.config.envOverrides,
      CLAUDE_CODE_OAUTH_TOKEN: refreshed,
    };
    // Never the value, and never a length that narrows it — the fact is the log.
    this.debug('[ClaudeAgent] Claude OAuth token renewed for this session; retrying the turn');
    return true;
  }

  private async emitSessionEndOnce(reason: SessionEndReason): Promise<void> {
    if (!this._sessionStartEmitted || this._sessionEndEmitted) return;
    this._sessionEndEmitted = true;
    await this.emitAutomationEvent('SessionEnd', { hook_event_name: 'SessionEnd', reason });
  }

  override async endLifecycle(reason: SessionEndReason = 'other'): Promise<void> {
    await this.emitSessionEndOnce(reason);
    await super.endLifecycle(reason);
  }

  override async mcpServerStatuses(): Promise<readonly McpServerStatusLine[] | null> {
    const live = this.currentQuery;
    if (!live || typeof live.mcpServerStatus !== 'function') return super.mcpServerStatuses();
    try {
      return claudeSdkMcpStatusLines(await live.mcpServerStatus(), () => this.config.mcpPool?.serverStatuses(this.config.mcpLeaserId) ?? null);
    } catch (error) {
      // A control request that failed is not an empty inventory. Fall back to
      // the pool's view and say why in the log, rather than printing a report
      // that reads like an answer.
      this.debug(`Claude MCP status read failed, falling back to the pool: ${String(error)}`);
      return super.mcpServerStatuses();
    }
  }

  /**
   * P6.711's claude line — reconnect ONE server through the runtime's own verb.
   *
   * Vendored `sdk.d.ts:2592`: *"Reconnect an MCP server by name. Throws on
   * failure."* `reconnectMcpServer(serverName: string): Promise<void>`. Native
   * mechanism, step 1, and it is the right one on this runtime for the reason
   * the read above is: the SDK-side servers are the CHILD's, so dialling them
   * from the host pool would reconnect our copy and leave the child's alone.
   *
   * Shaped to the interface name `lane-W9-k-report.md` gives the host half —
   * `ISessionManager.reconnectMcpServer(sessionId, slug, workspaceId?)`, whose
   * `SessionManager` implementation is a sibling lane's — so the route lands on
   * this method by name and returns {@link McpReconnectResult}, the pool's own
   * verdict type, unchanged. A verdict rather than a throw for the pool's
   * stated reason: the panel renders every one of these.
   *
   * The pool is the fallback and not a second implementation: a claude session
   * between turns has no live child to ask, and the pooled connection is a real
   * thing to redial. `throw` from the SDK becomes `{ ok: false, reason:
   * 'failed' }` because that is what the vendor's own sentence promises.
   */
  async reconnectMcpServer(slug: string): Promise<McpReconnectResult> {
    const live = this.currentQuery;
    if (!live || typeof live.reconnectMcpServer !== 'function') {
      const pool = this.config.mcpPool;
      if (!pool) return { ok: false, reason: 'unknown-server' };
      return pool.reconnect(slug, this.config.mcpLeaserId);
    }
    try {
      await live.reconnectMcpServer(slug);
      this.debug(`Claude live session reconnected MCP server ${slug}`);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: 'failed', detail: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * P6.412 — the runtime's OWN plugin reload, through a seam the vendored SDK
   * has shipped all along and this fork never called: `git grep -a
   * '\.reloadPlugins('` scored 0 call sites, against `sdk.d.ts:2544`
   * `reloadPlugins(): Promise<SDKControlReloadPluginsResponse>` — "Reload
   * plugins from disk and return the refreshed commands, agents, plugins, and
   * MCP server status."
   *
   * Native-first, step 1: the alternative is our turn-boundary teardown, which
   * throws the child away to pick up a path change. This keeps the session.
   *
   * Between turns there is no live child, and that is not a failure: nothing
   * holds stale paths, so `applied: false` routes the caller back to the
   * teardown path it already has. The verdict never throws, for the reason
   * {@link reloadClaudePlugins} states — the mutation is committed before
   * anybody reloads.
   *
   * Structurally shaped on {@link reconnectMcpServer} directly above, including
   * the `typeof … !== 'function'` guard: `SessionManager` narrows both the same
   * way, so neither needs a line in `backend/types.ts`.
   */
  async reloadPlugins(): Promise<ClaudePluginReloadOutcome> {
    const live = this.currentQuery;
    if (!live || typeof live.reloadPlugins !== 'function') {
      return { applied: false, reason: 'no live session' };
    }
    const outcome = await reloadClaudePlugins(live);
    if (outcome.applied) {
      this.debug(
        `Claude live session reloaded plugins: ${outcome.plugins} plugin(s), `
        + `${outcome.commands} command(s), ${outcome.agents} agent(s), `
        + `${outcome.mcpServers} MCP server(s), ${outcome.errorCount} error(s)`,
      );
    } else {
      this.debug(`Claude live plugin reload did not apply (${outcome.reason}); the turn-boundary refresh stands`);
    }
    return outcome;
  }

  /**
   * P3.267 — a switch-visible fact leaves the debug channel and joins R12's.
   *
   * `onDiagnostic → this.debug` ends at `BaseAgent.debug`, i.e.
   * `this.onDebug?.(…)`: an OPTIONAL callback that `SessionManager` points at a
   * file log, and a packaged build "logs nothing outside debug mode" (the trap
   * `AGENTS.md` records and P3.120 re-measured). So a fact carried only there
   * reaches nobody in the shipped product — which is why two rows graded
   * "honest" were honest two grades weaker than they read.
   *
   * NO NEW CHANNEL IS BUILT HERE, and that is the point: R12's `info` +
   * `level: 'warning'` already exists ten lines below the second call site,
   * already survives a reload, and already reaches the user. This adds the
   * BINDING the sweep found missing, and keeps the debug line in addition to
   * the banner rather than instead of it — the log's copy is what an operator
   * greps, the transcript's copy is what a person reads.
   *
   * Bounded and de-duplicated so a per-entry diagnostic storm cannot push the
   * facts a user needs off the transcript; the same bound codex's
   * `surfaceCodexOperatorNotice` uses, for the same reason.
   */
  /**
   * P3.98 + P3.122 — CLASSIFY one completed loopback call, and report it only
   * when it was not the turn the user asked for.
   *
   * The adapter hands every non-streaming `/v1/messages` call up because it
   * cannot know what a call was FOR: it is the dependency ROOT of the pair, so
   * the recognition marker lives here in `telemetry/host-overhead-usage.ts` and
   * the raw `system` field travels up by reference. `classifyHostOverheadSource`
   * answers `null` for an ordinary conversation request, which is every request
   * this product makes on its own behalf, and that answer ends the call here —
   * a turn's own usage is reported by the turn, through `AgentEventUsage`.
   *
   * The measured non-null case is the SDK's auto-mode permission classifier:
   * 110,519 characters of system prompt per check, up to twice per classified
   * action, billed to our gateway and excluded from `modelUsage`.
   *
   * **Expected to read ZERO in the shipped configuration, and that is said out
   * loud rather than left for a reader to discover.** P3.93 measured the arm we
   * ship — our own `PreToolUse` hook returning `allow` — at **zero** classifier
   * requests, against a positive control of **two** on the same rig with no
   * hook, and P3.139 decided to leave that flag where it is. A zero here is a
   * READING; the state it replaces was a figure that silently omitted the cost.
   *
   * `backend` is the provider name so the data point matches every other line
   * the exporter carries; the model is the one the call actually went out on,
   * which for a classifier hop is the session's model after the binary's own
   * fallback (its declared `claude-sonnet-5` is not served by our gateway).
   */
  /**
   * P2.525 — the session's held-call record, written from the RUNTIME's verdict.
   *
   * Not from the hook's intent, and the difference is the whole reason this
   * lives at the terminal event instead of beside the `defer` we emit.
   * `hooks.md#defer-a-tool-call-for-later` gives the runtime two documented
   * reasons to decline the value — an interactive session, and a turn carrying
   * more than one tool call — and in both "the tool proceeds through the normal
   * permission flow". A record written when we ASKED would then claim a call is
   * held that is already running. The `complete` event is where the answer is.
   *
   * Pi writes the same record from its own hook because Pi IS the harness: its
   * `defer` and its terminal event are decided in the same process, one line
   * apart. Same shape, same persistence, different authority — which is the
   * honest form of "the host makes the residue uniform".
   *
   * Any other ending RESOLVES a held call: it ran, it was denied, the tool went
   * missing (`tool_deferred_unavailable`, which is a resolution and not a hold —
   * there is nothing left to come back to), or the turn ended some other way.
   * The clear is guarded on a record existing so an ordinary turn costs no
   * persist. The port is optional: an agent built without it does nothing here.
   */
  private reconcileDeferredToolCall(event: AgentEvent & { type: 'complete' }): void {
    const write = this.config.onToolCallDeferred;
    if (!write) return;
    if (event.terminalReason === 'tool_deferred' && event.deferredToolUse) {
      write({
        schemaVersion: 1,
        toolUseId: event.deferredToolUse.id,
        toolName: event.deferredToolUse.name,
        input: event.deferredToolUse.input,
        permissionMode: this.permissionManager.getPermissionMode(),
        deferredAt: Date.now(),
      });
      this.debug(`[defer] holding ${event.deferredToolUse.name} (${event.deferredToolUse.id}); the next turn resumes this session and PreToolUse fires for it again`);
      return;
    }
    if (this.config.getDeferredToolCall?.()) {
      write(undefined);
      this.debug('[defer] the held tool call is resolved; the session record is cleared');
    }
  }

  private reportHostOverheadCall(call: UpstreamCallObservation): void {
    const source = classifyHostOverheadSource(call.system);
    if (!source) return;
    this.config.onHostOverheadUsage?.(hostOverheadTurn(source, {
      backend: this.config.provider,
      model: call.model,
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
    }));
    this.debug(`[host-overhead] ${source}: ${call.inputTokens} in / ${call.outputTokens} out on ${call.model}`);
  }

  /**
   * P6.79 — a degradation line raised before any turn exists, latched.
   *
   * Same latch and same queue as {@link surfaceForcedDefaultModeNotice}, split
   * out because that one owns a stderr-parsing job this caller has no part of.
   * `postInit` runs before the first slot, so the open-slot branch is kept for
   * the general case rather than assumed away — a notice raised mid-session
   * (a re-auth, a second `postInit`) must still land on the turn in flight.
   */
  private queueDegradationNotice(message: string): void {
    this.debug(message);
    if (this.announcedDegradationLines.has(message)) return;
    this.announcedDegradationLines.add(message);
    const slot = this.openSlot;
    if (slot && !slot.settled) slot.push({ type: 'info', message, level: 'warning' });
    else this.pendingDegradationNotices.push(message);
  }

  /**
   * D1.216 — a host-emitted `SessionStart` hook's `systemMessage`, on the one
   * surface this backend already has for it.
   *
   * `hooks.md#json-output` gives the field one meaning — *"Warning message shown
   * to the user"* — and the `SessionStart` section is not among the several that
   * declare it discarded (`Notification`, `InstructionsLoaded`, `ConfigChange`,
   * `MessageDisplay`, `WorktreeRemove` and `Setup` each say so by name). So it is
   * shown, and `queueDegradationNotice` is exactly that channel: `info` +
   * `level: 'warning'`, latched per session, queued when no slot is open yet —
   * which this caller needs, because it runs before the turn is assembled.
   *
   * The prefix is codex's, character for character
   * (`surfaceHookUserFacingOutput` composes `${event} hook: ${systemMessage}`),
   * so one user switching runtimes meets one sentence rather than two spellings
   * of it. No locale key, for the reason the other notices on this channel give:
   * it is an English literal channel and the hook's own text is unlocalisable
   * anyway.
   *
   * WHAT IS DELIBERATELY NOT MIRRORED from codex's helper, recorded rather than
   * silently dropped: its second arm, which turns `continue: false` +
   * `stopReason` into an *"asked to stop"* notice. The page does not settle that
   * combination for this event — `#decision-control` lists `SessionStart` as
   * *"Context only … No blocking or decision control"*, while `#json-output`
   * calls `continue` universal and says only that *"some events discard them"*
   * without naming `SessionStart` either way. Neither host acts on it, so the
   * choice is between two spellings of a null; read-don't-invent says record the
   * null (AGENTS.md), and the row it belongs to is the three-runtime one.
   */
  private surfaceSessionStartHookMessage(result: AgentEventExecutionResult | undefined): void {
    const systemMessage = result?.universal?.systemMessage?.trim();
    if (systemMessage) this.queueDegradationNotice(`SessionStart hook: ${systemMessage}`);
  }

  /**
   * D1.216 — the `SessionStart` band, composed once and handed to whichever of
   * the two prompt builders composes this turn's message.
   *
   * Drained rather than read, and beside {@link consumePermissionAnswerNotes}
   * for the same reason P6.864 gives there: `buildTextPrompt` and
   * `buildSDKUserMessage` are alternatives, never both, so a one-shot consume in
   * each cannot fire twice. Placing it INSIDE `buildContextParts` would be wrong
   * on the other side — that builder runs per turn, and this band belongs to one.
   *
   * Fenced through the SHARED `fenceHookBand` with the same element and source
   * every other runtime's `hook_context` band uses, so this backend does not
   * become the one band whose bytes arrive unannotated: the element, the
   * `UNTRUSTED_HOOK_NOTICE`, the `<untrusted>` fence and the defang are the same
   * code, not a copy of it. `fenceHookBand` already returns `undefined` for a
   * blank body, so the `.trim()` at the capture site is belt rather than braces.
   */
  private consumeSessionHookContext(): string | undefined {
    const body = this._sessionHookContext;
    if (body === undefined) return undefined;
    this._sessionHookContext = undefined;
    return fenceHookBand({ element: 'hook_context', source: 'hook_context', body });
  }

  /**
   * UB12.21 — the output-style notice, drained once per turn. Drained rather
   * than read, beside {@link consumeSessionHookContext}, for the reason given
   * there: `buildTextPrompt` and `buildSDKUserMessage` are alternatives, never
   * both. `delivered` moves only here, when a message really carries the
   * notice: a turn that returns before composing one leaves it owed.
   */
  private consumeOutputStyleSwitchNotice(): string | undefined {
    const pending = this.pendingOutputStyleSwitch;
    if (!pending) return undefined;
    this.pendingOutputStyleSwitch = null;
    this.deliveredOutputStylePrompt = pending.delivered;
    return pending.notice ?? undefined;
  }

  /**
   * P6.154 — the bundled agents' inert-tier line, once per session.
   *
   * The policy is rebuilt every turn, so without the latch this would repeat
   * for the life of the session. Reuses `announcedDegradationLines` because the
   * identity rule there is the right one — the same sentence twice is the same
   * fact twice — without reusing the banner the set usually feeds.
   */
  /**
   * P6.63 — which of these result paths the `deniedPaths` floor withholds.
   *
   * The ONE matcher, reached the way `NestorCloudAgent.deniedResultPaths`
   * reaches it: `shouldAllowToolInMode('Read', { file_path }, …)` reading
   * `denyPathBlocked`, the flag set by the FIRST branch of the private
   * `matchesDeniedPath`, ahead of every mode, allowlist and rule check — which
   * is what makes the floor a floor. A SECOND matcher is refused here for the
   * reason P3.105 refused one: four defects shipped out of that one compiler in
   * a single day, and a re-derivation inherits the whole class.
   *
   * The mode is read LIVE rather than pinned, so the call cannot start meaning
   * something else if that ordering changes.
   *
   * FAILS OPEN — a throw withholds nothing, which is the pre-row behaviour.
   * The inverse contract answered wrongly would withhold EVERY result of every
   * search, which is the same trade `denied-result-filter.ts` documents.
   */
  /**
   * D1.332 — the paths this claude session has seen, for the read-before-write
   * rule {@link applyReadBeforeWriteRule} enforces. One per agent, which is one
   * per session: the lifetime IS the *"current conversation"* the page's rule is
   * written against.
   */
  private readonly readBeforeWriteLedger = new SessionFileReadLedger();

  private deniedSearchResultPaths(paths: readonly string[]): readonly string[] {
    if (paths.length === 0) return [];
    try {
      const permissionsContext = this.permissionManager.getCapabilityPermissionsContext?.();
      if (!permissionsContext) return [];
      const mode = this.permissionManager.getPermissionMode();
      return paths.filter((path) => {
        const verdict = shouldAllowToolInMode('Read', { file_path: path }, mode, { permissionsContext });
        return verdict.allowed === false && verdict.denyPathBlocked === true;
      });
    } catch (error) {
      this.debug(`[ClaudeAgent] denied-path search-result filter failed: ${String(error)}`);
      return [];
    }
  }

  /**
   * D1.332 — read-before-write on the claude arm: the reads this host can
   * credit, and the refusal a write gets without one.
   *
   * ## Why the host and not the SDK
   *
   * The rule is the SDK's own — `tools-reference.md#edit-tool-behavior`,
   * verbatim: *"**Read-before-edit**: Claude reads the file in the current
   * conversation before editing it"*, with a model gate one sentence later
   * (*"Claude Opus 4.6, Claude Haiku 4.5, and older models always require the
   * read. Newer models can edit an unread file …"*). RS-76 drove one
   * instruction over one seeded file in one profile: **Pi refused, claude and
   * codex overwrote**, with a NEW file created on all three as the control. So
   * the native mechanism exists and did not fire on a gateway card, and
   * native-first puts the seam here rather than building a second rule beside
   * a working one.
   *
   * ## What is credited, and how the three runtimes came to agree
   *
   * A `Read` credits its path HERE. The Bash viewer credit is not: F1.96 moved
   * it to the PostToolUse seam, because this hook runs before the gate has
   * decided and before the child executes, so a viewer that was DENIED, or that
   * exited non-zero (`bat` absent, exit 127), still marked a file as seen. Pi
   * credits on exit 0 and codex on a non-error return; `hooks.md`'s event table
   * reads *"After a tool call succeeds"* for `PostToolUse`, which is claude's
   * own documented equivalent. See {@link creditBashViewerRead}.
   *
   * A path the gate clears because the file does NOT exist is credited, which
   * is Pi's decision 2 (*"a file this session WROTE counts as seen"*) expressed
   * where this runtime can see it: a second `Write` to a file this turn created
   * must not be refused, and if the user denies the first write the file still
   * does not exist, so the next one is a new-file write — which was never
   * refused either.
   *
   * Bash WRITES are deliberately not covered, on either runtime: Pi's gate sits
   * on `write_file`/`edit_file`/`replace_in_file` and lets `cat > f` through, so
   * covering it here would be a new divergence in the other direction.
   */
  private async applyReadBeforeWriteRule(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<string | undefined> {
    const root = this.config.session?.workingDirectory ?? this.workspaceRootPath;
    if (toolName === 'Read') {
      const read = writeTargetPath(input);
      if (read) this.readBeforeWriteLedger.add(resolve(root, read));
      return undefined;
    }
    // F1.96 — the Bash VIEWER branch is gone from here, and its absence IS the
    // fix. It credited `bareFileViewerOperand(command)` on `existsSync` alone,
    // before the gate had decided and before the child ran, so a denied or
    // failing viewer unlocked an overwrite of a file nobody saw. The credit now
    // happens once the call has SUCCEEDED, in {@link creditBashViewerRead},
    // which the PostToolUse hook calls. Bash needs no branch here at all: it is
    // not in READ_BEFORE_WRITE_TOOLS, so it falls through the line below and
    // returns `undefined` exactly as it did — Bash WRITES stay uncovered on
    // this runtime and on Pi, which the paragraph above records as deliberate.
    if (!READ_BEFORE_WRITE_TOOLS.has(toolName)) return undefined;
    const target = writeTargetPath(input);
    if (!target) return undefined;
    const path = resolve(root, target);
    const refusal = await this.readBeforeWriteLedger.refuseUnseenWrite(path);
    if (refusal) {
      this.onDebug?.(
        `[read-before-write] refused ${toolName} on ${path}: not read in this session`,
      );
      return refusal;
    }
    this.readBeforeWriteLedger.add(path);
    return undefined;
  }

  private noteBuiltinAgentTierOnce(message: string): void {
    if (this.announcedDegradationLines.has(message)) return;
    this.announcedDegradationLines.add(message);
    this.debug(message);
  }

  private noteSwitchVisibleDegradation(sink: string[], message: string): void {
    this.debug(message);
    if (this.announcedDegradationLines.has(message)) return;
    if (sink.length >= CLAUDE_SWITCH_VISIBLE_DEGRADATION_LIMIT) return;
    this.announcedDegradationLines.add(message);
    sink.push(message);
  }

  /**
   * P3.267 + P3.310 — the child's own "your permission mode was overridden"
   * line, lifted off stderr onto the surface a person reads.
   *
   * The runtime already announces this; what it had was the wrong audience.
   * `stderr` reaches `debug()` (an optional callback pointed at a file log a
   * packaged build never writes), `console.error` (no terminal in the desktop
   * app) and a 20-line ring buffer read ONLY when the process fails — so on the
   * shipped product a user whose `plan` or `acceptEdits` was discarded was told
   * nothing at all. That is the same misgrading P3.267 found on
   * `onDiagnostic → debug`, on a third channel.
   *
   * The vendor's own sentence is relayed verbatim rather than paraphrased: it
   * names the reason AND the opt-out (`…=0`), and a paraphrase of a runtime
   * message is a chance to be wrong about someone else's behaviour. Only the
   * leading `⚠ ` is trimmed, because the transcript row carries its own tone.
   *
   * Pushed onto the OPEN SLOT when there is one — the callback fires mid-turn,
   * after the turn's own banner loop has already run — and queued for the next
   * turn otherwise. Latched by the shared set, so a session says it once.
   */
  private surfaceForcedDefaultModeNotice(stderrChunk: string): void {
    // TWO tests of the same fragment, and the SECOND is the authority: stderr
    // arrives in chunks that can carry several lines, so the line has to be
    // picked out of the chunk anyway. The first is an early-out over a whole
    // chunk. A re-break mutant that deleted only the early-out SURVIVED for
    // exactly this reason — a dead control, recorded so the next reader does
    // not mistake the redundancy for the filter.
    if (!stderrChunk.includes(CLAUDE_FORCED_DEFAULT_MODE_STDERR)) return;
    const message = stderrChunk
      .split('\n')
      .find(line => line.includes(CLAUDE_FORCED_DEFAULT_MODE_STDERR))
      ?.replace(/^\s*⚠\s*/, '')
      .trim();
    if (!message) return;
    if (this.announcedDegradationLines.has(message)) return;
    this.announcedDegradationLines.add(message);
    const slot = this.openSlot;
    if (slot && !slot.settled) slot.push({ type: 'info', message, level: 'warning' });
    else this.pendingDegradationNotices.push(message);
  }

  protected async *chatImpl(
    userMessage: string,
    attachments?: FileAttachment[],
    options?: ChatOptions
  ): AsyncGenerator<AgentEvent> {
    // Extract options (ChatOptions interface from AgentBackend)
    const _isRetry = options?.isRetry ?? false;
    // R18: captured here because the SDK options literal below shadows the
    // ChatOptions parameter under the same name.
    const turnOutputSchema = options?.outputSchema;
    // C3.162 (QK5) — the session's ultracode toggle, captured for the same
    // reason and it is NOT optional: `const options: Options` below is
    // block-scoped in this same body, so reading `options?.ultracode` down at
    // the settings composition is a temporal-dead-zone reference, not a shadow
    // that quietly resolves to the wrong object.
    const turnUltracode = options?.ultracode === true;

    // F1.238 — a steer left from an earlier turn is handed back, never dropped; F1.335 — then this turn's FIFO opens
    const steerTurn = yield* this.openSteerTurn();

    // UB2.1 — a handoff deferred in an earlier turn must never interrupt this one
    // (craft-agents-oss v0.15.1 `chatTurn` opening).
    if (this.toolHandoff?.timer) clearTimeout(this.toolHandoff.timer);
    this.toolHandoff = null;

    // THE PER-TURN SLOT. Declared out here so the outer `finally` can close it:
    // a turn that throws before its terminal event must not leave the reader
    // feeding a slot nobody will ever drain.
    let slot: ClaudeTurnSlot | null = null;

    try {
      const sessionId = this.config.session?.id || `temp-${Date.now()}`;
      // Capture the composite identity once so mode-state lookups in the hook
      // below stay stable even in the (unexpected) no-session temp-id case.
      const sessionKey: SessionKey = { workspaceId: this.config.workspace.id, sessionId };

      // Pin system prompt components on first chat() call for consistency after compaction
      // The SDK's resume mechanism expects system prompt consistency within a session
      const currentPreferencesPrompt = formatPreferencesForPrompt();
      const currentCoAuthorPref = getCoAuthorPreference();

      if (this.pinnedPreferencesPrompt === null) {
        // First chat in this session - pin current values
        this.pinnedPreferencesPrompt = currentPreferencesPrompt;
        this.pinnedIncludeCoAuthoredBy = currentCoAuthorPref;
        debug('[chat] Pinned system prompt components for session consistency');
      } else {
        // Detect drift: warn user if context has changed since session started
        const preferencesDrifted = currentPreferencesPrompt !== this.pinnedPreferencesPrompt;

        if (preferencesDrifted && !this.preferencesDriftNotified) {
          yield {
            type: 'info',
            message: `Note: Your preferences changed since this session started. Start a new session to apply changes.`,
          };
          this.preferencesDriftNotified = true;
          debug(`[chat] Detected drift in: preferences`);
        }
      }

      // Check if we have binary attachments that need the AsyncIterable interface
      const hasBinaryAttachments = attachments?.some(a => a.type === 'image' || a.type === 'pdf');
      this.lastTurnHadAttachments = !!hasBinaryAttachments;

      // Validate we have something to send
      if (!userMessage.trim() && (!attachments || attachments.length === 0)) {
        yield { type: 'error', message: 'Cannot send empty message' };
        yield { type: 'complete' };
        return;
      }

      // Pre-spawn detection: a stale `branchFromSdkCwd` carried across machines
      // (via "Send to Workspace") points at a directory that doesn't exist
      // locally. Feeding that into spawn() returns ENOENT, which the SDK
      // wraps as "Claude Code native binary not found at …" — sending users
      // hunting for a bundling bug. Catch it here and route through the same
      // branch fallback recovery the post-failure path uses.
      if (
        !_isRetry &&
        this.branchFromSdkCwd &&
        this.branchFromSdkSessionId &&
        !isExistingDirectory(this.branchFromSdkCwd)
      ) {
        yield* this.recoverFromStaleBranchFork(userMessage, attachments, /* isPreSpawn */ true);
        return;
      }

      // Get centralized mini agent configuration (from BaseAgent)
      // This ensures Claude and Codex agents use the same detection and constants
      const miniConfig = this.getMiniAgentConfig();

      // output-styles.md:104 — a named subagent runs its own system prompt, so
      // the session style must not shape it; a fork inherits. Same guarded
      // shape as the Pi call site (this read used to be a bare
      // getOutputStyleId(), which the spec flags as pre-existing looseness).
      const turnOutputStyleId = resolveChildOutputStyleId(this.config.piChildKind, getOutputStyleId());
      // `output-styles.md:55` — the nested project walk's stop boundary,
      // derived from the live cwd (the server's canonical project path IS the
      // re-bound cwd, so there is nothing to thread from config).
      const outputStyleProjectRoot = outputStyleProjectRootFor(this.config.session?.workingDirectory);
      const turnPluginOutputStyles = this.pluginOutputStyleSources();
      // `output-styles.md:101` — the per-turn adherence reminder. Set BEFORE
      // buildTextPrompt/buildSDKUserMessage run: both compose the volatile
      // context tail that carries it. The label is stashed here, where the
      // presetAppend below resolves the same id, so the volatile builder never
      // re-walks the style directories. Mini agents skip styles entirely, and a
      // composition with no prose (Default, unresolvable id) clears the label.
      const turnOutputStyle = !miniConfig.enabled && turnOutputStyleId
        ? resolveOutputStyleComposition(turnOutputStyleId, {
            workspaceRootPath: this.workspaceRootPath,
            workingDirectory: this.config.session?.workingDirectory,
            projectTrusted: this.config.projectTrusted,
            ...(turnPluginOutputStyles.length ? { pluginStyles: turnPluginOutputStyles } : {}),
            ...(outputStyleProjectRoot ? { projectRoot: outputStyleProjectRoot } : {}),
          })
        : undefined;
      // UB12.21 — `switchNotices`: under the recorded prompt a mid-session
      // style arrives as a notice (planned below), so the reminder points at
      // the latest style block, not at the system prompt.
      this.promptBuilder.setActiveOutputStyle(
        turnOutputStyle?.prompt ? turnOutputStyle.label : null,
        { switchNotices: true },
      );

      const disallowedTools: string[] = [...CLAUDE_SESSION_DISALLOWED_TOOLS];
      // P6.217 — the user's/operator's own session tool universe. The blacklist
      // half is `disallowedTools`; the WHITELIST half narrows the `tools` option
      // below (F1.638, `buildClaudeSessionToolsOption`) — never `allowedTools`,
      // which pre-approves the names it lists and restricts nothing.
      //
      // ADDED to the constant rather than replacing it: those entries each carry
      // their own reason (the two names `CLAUDE_SESSION_DISALLOWED_TOOLS` bans
      // have host twins that must be reached through the gate), and a user list
      // that could unban them would be a permission widening dressed as a
      // preference. An empty whitelist leaves the tool list as it was, because
      // an empty `tools` list would disable every built-in tool.
      //
      // `tools` is hashed by `claudeLiveSessionSignature`, so a changed
      // whitelist mid-session respawns the child with the new universe.
      const sessionToolUniverse = getSessionToolUniverse();
      if (sessionToolUniverse.disallowed.length > 0) {
        disallowedTools.push(...sessionToolUniverse.disallowed);
      }

      // Build MCP servers config
      // Mini agents: only session tools (config_validate) to minimize token usage
      // Regular agents: full set including preferences, docs, and user sources

      // Build per-source proxy servers from centralized MCP pool (if available)
      const sourceProxies = this.config.mcpPool ? createSourceProxyServers(this.config.mcpPool, {
        leaserId: this.config.mcpLeaserId,
        sessionPath: getSessionDirPath(this.config.workspace.id, sessionId),
        summarize: this.getSummarizeCallback(),
      }) : {};
      const sourceProxyCount = Object.keys(sourceProxies).length;
      if (sourceProxyCount > 0) {
        debug('[chat] Source proxy servers created for', sourceProxyCount, 'sources');
      }

      // Build full MCP servers set first, then filter for mini agents
      const fullMcpServers: Options['mcpServers'] = {
        // Session-scoped tools (SubmitPlan, source_test, update_user_preferences, transform_data, etc.)
        session: getSessionScopedTools(sessionId, this.workspaceRootPath, this.config.workspace.id, this.config.session?.workingDirectory, () => this.config.session?.memoryScopeOverride),
        // Per-source proxy servers from centralized MCP pool (MCP + API sources)
        // Each source gets its own SDK server keyed by slug (e.g., 'linear', 'github', 'gmail')
        // so the SDK produces correct tool names: mcp__{slug}__{toolName}
        ...sourceProxies,
      };

      // Mini agents: filter to minimal set using centralized keys
      // Regular agents: use full set including docs and user sources
      const mcpServers: Options['mcpServers'] = miniConfig.enabled
        ? this.filterMcpServersForMiniAgent(fullMcpServers, miniConfig.mcpServerKeys)
        : fullMcpServers;
      const toolAliases = claudeToolAliasesFor(mcpServers);
      // P6.528 — remember what we supplied, so the init message can be diffed
      // against it. `strictMcpConfig` stays UNSET (Q-den 65 = option 2), so the
      // CLI keeps doing its own discovery and this is the only way to see it.
      this.configuredMcpServerNames = new Set(Object.keys(mcpServers ?? {}));
      
      // Configure SDK options
      // Model is always set by caller via connection config
      const model = this._model;

      // Log provider context for diagnostics (custom base URL = third-party provider)
      const defaultConnSlug = getDefaultLlmConnection();
      const defaultConn = defaultConnSlug ? getLlmConnection(defaultConnSlug) : null;
      const activeBaseUrl = defaultConn?.baseUrl;
      if (activeBaseUrl) {
        debug(`[chat] Custom provider: baseUrl=${activeBaseUrl}, model=${model}, hasApiKey=${!!this.config.envOverrides?.ANTHROPIC_API_KEY}`);
      }

      // P3.267 — the turn's switch-visible degradations, collected here and
      // yielded onto R12's banner below. Declared before the first producer:
      // the thinking resolution runs long before `agentNotices` exists.
      const degradationNotices: string[] = [];

      // D1.164 — restricted mode is HONOURED and now SAID.
      //
      // `CLAUDE_CODE_RESTRICTED` classifies `immediate`, so an administrator's
      // managed `env` block reaches `process.env` and `buildClaudeSubprocessEnv`
      // spreads it into this child, which really does restrict itself: the
      // shipped `2.1.251` binary reads it at its entry point. That is the right
      // outcome — an operator asking for restricted mode gets it — but it costs
      // the `project` setting source, and with it P6.34's `--add-dir` skills,
      // commands and subagents and the user's own `.claude/settings.json` rules,
      // and until now nothing said so anywhere a person looks.
      //
      // The sink is the P3.267 banner, deliberately, for the reason that block
      // gives: this is a note about what the agent will NOT do, so it has to
      // still be there when the answer comes back. It is latched by
      // `announcedDegradationLines`, so it is once a session and not once a turn.
      // The decision, the measurement it rests on and why the name is not in the
      // classification table are in `claudeRestrictedModeNotice`'s own docblock.
      const restrictedModeNotice = claudeRestrictedModeNotice();
      if (restrictedModeNotice) {
        this.noteSwitchVisibleDegradation(degradationNotices, restrictedModeNotice);
      }

      // D1.155 — `SessionStart`, emitted HOST-SIDE on claude too.
      //
      // The reference is `pi-agent.ts`'s `chatImpl` and `codex-agent.ts`'s
      // pre-turn block, read rather than re-derived: same latch triple, same
      // `source` discriminator (a resume anchor present means `resume`), the
      // same `applyHookSessionDirectives` call awaited before the turn is
      // assembled so a `reloadSkills` rescan is visible to THIS turn.
      //
      // WHY THIS IS NOT THE DOUBLE-FIRE T9 REFUSED for `Stop`, which is the
      // question a reader of that docblock will arrive with. T9's argument is
      // that the SDK child already runs our matchers, so a host emission would
      // run them a SECOND time. That argument is TRUE for `Stop` and MEASURED
      // FALSE for these two: W19-r's headless rig drove a host `hooks.json`
      // `SessionStart`/`SessionEnd` hook on all three runtimes and only claude
      // was silent, and `SessionEnd` was absent on both signals. And the
      // structural guard is in `mergeClaudeSdkHooks`, not in this comment: both
      // names are dropped from `trustedHooks` beside `PreToolUse`, so if a later
      // SDK starts delivering them the host stays the single emitter instead of
      // the two paths quietly becoming two firings.
      if (!this._sessionStartHooksApplied) {
        const sessionStartResult = await this.emitAutomationEvent('SessionStart', {
          hook_event_name: 'SessionStart',
          // `this.sessionId` is the SDK session this turn will `resume`, read
          // off the same field the options literal reads below — the exact
          // counterpart of codex's `this.threadId ? 'resume' : 'startup'`.
          source: this.sessionId ? 'resume' : 'startup',
        });
        this._sessionStartHooksApplied = true;
        this._sessionStartEmitted = true;
        this._sessionEndEmitted = false;
        // C4.12's band, now arriving on this backend through the SAME path as
        // the other three rather than through the sink registered below. The
        // sink stays: it serves every OTHER event's matchers, which the child
        // does deliver.
        await this.applyHookSessionDirectives(sessionStartResult?.decision);
        // D1.216 — the two OUTPUT fields of the same result, which D1.155 left
        // reaching nobody on this backend alone. The decision band above is what
        // a hook TELLS the host to do; these are what it has to say, and they
        // had no seam here: pi feeds `additionalContext` into `_sessionHookContext`
        // and codex has `surfaceHookUserFacingOutput`, while `claude-agent.ts`
        // read `universal` and `systemMessage` ZERO times.
        //
        // The child cannot deliver either one instead. D1.155 established that
        // it never calls our `SessionStart` matchers back, and `mergeClaudeSdkHooks`
        // now drops the event from `trustedHooks` on purpose — so the host is the
        // only party that can, and a hook that is being RUN while its output is
        // discarded is worse than one that never ran.
        this.surfaceSessionStartHookMessage(sessionStartResult);
        this._sessionHookContext =
          sessionStartResult?.decision?.additionalContext?.trim() || undefined;
      }

      const thinkingOptions = resolveClaudeThinkingOptions({
        thinkingLevel: this._thinkingLevel,
        model,
        providerType: this.config.providerType,
        minimizeThinking: miniConfig.minimizeThinking,
        // P3.268 — which authority answered, so a clamp or an overridden
        // heuristic is readable rather than inferred from the resulting options.
        //
        // P3.267 — and the CLAMP specifically leaves the debug channel. Two
        // messages arrive here and only one of them is switch-visible:
        //
        //  - a clamp (`requested xhigh → high`) changes what the user asked for
        //    and would land differently on Pi or codex, so it goes to the user;
        //  - the "the runtime says supportsAdaptiveThinking=…, the heuristic
        //    said … — the runtime wins" line is a SOURCE attribution. Both
        //    branches produce thinking-off; nothing the user chose changed, so
        //    a banner would be noise. It stays on the log deliberately.
        //
        // The split is made INSIDE the resolver (`onDegradation`), never by
        // matching prose here — a string matcher over a diagnostic is the
        // instrument this plan has already measured wrong twice.
        onDiagnostic: message => debug(message), // F1.822 — module debug(): `this.debug` never reaches a packaged log
        onDegradation: message => this.noteSwitchVisibleDegradation(degradationNotices, message),
      });
      if ('effort' in thinkingOptions && thinkingOptions.effort) {
        debug(`[chat] Thinking: level=${this._thinkingLevel}, effort=${thinkingOptions.effort}`);
      } else if ('maxThinkingTokens' in thinkingOptions) {
        debug(`[chat] Thinking: level=${this._thinkingLevel}, tokens=${thinkingOptions.maxThinkingTokens}`);
      } else {
        debug(`[chat] Thinking: level=${this._thinkingLevel}, disabled`);
      }

      // NOTE: Parent-child tracking for subagents is documented below (search for
      // "PARENT-CHILD TOOL TRACKING"). The SDK's parent_tool_use_id is authoritative.

      // Clear stderr buffer at start of each query
      this.lastStderrOutput = [];

      // Log mini agent mode details (using centralized config)
      if (miniConfig.enabled) {
        debug('[ClaudeAgent] 🤖 MINI AGENT mode - optimized for quick config edits');
        debug('[ClaudeAgent] Mini agent optimizations:', {
          model,
          tools: miniConfig.tools,
          mcpServers: miniConfig.mcpServerKeys,
          thinking: 'disabled',
          systemPrompt: 'lean (no Claude Code preset)',
        });
      }

      // F1.1241 — the model's own window decides, no setting: a `claude-` id whose
      // known window (the connection's entry, else the registry) is 1M or more is
      // sent with its `[1m]` selector. The bundled 2.1.274 holds a native-1M model
      // to 200K behind any custom base URL without it (fixed in 2.1.285), and it is
      // how Sonnet 4.6 and Opus 4.6 reach 1M at all. Re-decided per query, so a
      // mid-session model switch is sized at once. See resolveClaudeKnownModelWindow.
      const windowConnection = this.config.connectionSlug ? getLlmConnection(this.config.connectionSlug) : null;
      const effectiveModel = claudeModelWithWindowSelector(model, resolveClaudeKnownModelWindow(windowConnection, model));

      // P3.314 — the hosted web search leaves the model's tool list on any turn
      // whose request is translated rather than passed through. Asked with
      // `effectiveModel`, the id the SDK will actually name, so this decision and
      // the adapter's routing are made from the same string. P3.319 is why that
      // is now enough: the router normalises the `[1m]` selector on both sides,
      // where it used to miss on it — and while it did, this call inherited the
      // miss and withheld the tool from the one model whose endpoint serves it.
      // See `resolveClaudeHostedWebSearchWithheld`.
      // P6.439 clause (1) — the flag-settings tier for this turn's option set.
      // Resolved here rather than cached on the instance: the env var is the
      // transport, and re-reading it costs a property access while a cached
      // value would outlive a respawn that was meant to pick up a new one.
      const flagSettings = resolveClaudeFlagSettings(process.env, message => debug(`[chat] ${message}`));
      // P6.930 clause (2) — same transport, same reason it is read here rather
      // than cached: the env var IS the flag, and a cached list would outlive a
      // respawn meant to pick up a new one.
      //
      // P6.1030 — and its diagnostics reach the OPERATOR, not only `debug()`.
      // This line used to hand them to `debug()`, with the comment "`apps/cli`
      // is what says it once to a human" — true only for a run launched with the
      // flag, while the case this call exists for is the one its own docblock
      // names: a session that INHERITED the env var without passing the flag.
      // There `apps/cli` never runs, a packaged build logs nothing outside debug
      // mode (AGENTS.md §Traps), and an operator whose narrowed list silently
      // stopped loading their skills, commands and CLAUDE.md was told nothing
      // anywhere. All three of the resolver's sentences are pure, operator-voiced
      // and about the operator's own variable doing less than they typed, so the
      // queue takes them whole rather than one being singled out — and
      // `queueDegradationNotice` latches by text and debugs on the way past, so
      // this is also strictly fewer lines than the split. P6.1023 is the same
      // move for the `--settings` PATH.
      const settingSources = this.projectTrustSettingSources(resolveClaudeSettingSources(
        process.env,
        message => this.queueDegradationNotice(message),
      )); // F1.768 — `project`/`local` only for a project the host trusted (see projectTrustSettingSources)

      const hostedWebSearchWithheld = resolveClaudeHostedWebSearchWithheld({
        upstreamKind: this.claudeRuntimeUpstreamKind,
        wireRouter: this.claudeRuntimeWireRouter,
        model: effectiveModel,
      });
      if (hostedWebSearchWithheld) {
        disallowedTools.push(CLAUDE_HOSTED_WEB_SEARCH_TOOL);
        debug(`[chat] ${CLAUDE_HOSTED_WEB_SEARCH_TOOL} withheld: this upstream cannot serve a server-side search (P3.314)`);
      }

      // P6.148 — the host's own `web_search` fills exactly the hole that
      // withholding leaves, and NOTHING ELSE: a passthrough session keeps the
      // native tool and must not be shown two. Read from the SAME resolver call
      // above so the two answers cannot disagree, and re-registered per turn
      // because the verdict is a property of the TARGET MODEL's wire, which a
      // mid-session model switch moves.
      // MERGE, never `registerSessionScopedToolCallbacks`: that one SETS the
      // whole record (`registry.set(key, callbacks)`), so registering this one
      // field would drop every callback the session registered at init — read
      // them from the `registerSessionScopedToolCallbacks(sessionKey, { … })`
      // call in this class's constructor rather than from a list here, which is
      // the kind of enumeration that ages silently.
      if (this.hostWebSearchOfferedLast !== hostedWebSearchWithheld) {
        this.hostWebSearchOfferedLast = hostedWebSearchWithheld;
        mergeSessionScopedToolCallbacks(sessionKey, { hostWebSearchOffered: hostedWebSearchWithheld });
        // Per-session, not `invalidateAllSessionToolsCaches()`: the tool list is
        // memoized per session and only THIS session's answer moved.
        cleanupSessionScopedTools(sessionKey);
      }

      // Capture the resolved spawn cwd here (rather than via an instance
      // field) so the catch handler reads the value passed to *this*
      // chatImpl invocation, not state left over from an earlier call.
      const resolvedCwd = this.resolveSpawnCwd({ isRetry: _isRetry, sessionId }); syncClaudeProjectTrustEntry({ configDir: workspaceClaudeConfigDir({ ...process.env, ...this.config.envOverrides }.NESSY_WORKSPACE_ID), cwd: resolvedCwd, trusted: this.config.projectTrusted === true, debug }); // F1.789 — the CLI's own trust entry (project-trust-entry.ts)
      const pluginRuntime = this.resolveSelectedPluginSkillRuntimePolicy();

      // R10 — a subagent's declared skills, materialized HERE and inlined into
      // its prompt below, because the SDK's own `skills` field is refused: it
      // resolves names against its own directories (the only one a live session
      // has is the user's `.claude/skills`), so a name match would substitute an
      // unvetted repo file for our vetted skill, and its preload carries none of
      // our per-skill tool restrictions, ceilings or budget. See
      // `claude-runtime-agents.ts` for the full reason.
      //
      // Null runtime means no pinned capability view exists for this turn, so
      // there is nothing to materialize from. That is not silent: the builder
      // announces per skill-declaring agent when the payload is absent.
      const capabilityRuntime = this.capabilityTurnRuntime;
      const agentSkills = capabilityRuntime
        ? await materializeClaudeRuntimeAgentSkills({
          definitions: this.config.piRuntimeAgentDefinitions,
          materializer: capabilityRuntime.materializer,
          skills: capabilityRuntime.view.skills ?? [],
          generation: capabilityRuntime.view.generation,
          sessionModel: model,
          // P3.267 — every message on THIS channel is an imported-agent
          // degradation, so no classifier is needed and none is written. The
          // three producers in `claude-runtime-agents.ts` are: an agent whose
          // declared skills this turn did not materialize ("the agent runs
          // without them"), an agent withheld from the turn entirely
          // ("unavailable this turn: <refusal>"), and — through the model
          // policy bound below, which is the same `announce` sink — an agent
          // whose declared model this connection cannot serve. All three say
          // the agent is weaker or absent HERE and would not be on Pi, which
          // is R12's own subject.
          onDiagnostic: message => this.noteSwitchVisibleDegradation(degradationNotices, message),
        })
        : undefined;

      // R12 — degradations this runtime imposes on an imported agent, collected
      // while the options are built and yielded to the USER below.
      //
      // A separate channel from `onDiagnostic` on purpose. That one ends at
      // `BaseAgent.debug`, which is `this.onDebug?.(…)` — an optional callback
      // that `SessionManager` points at `sessionLog.info`, i.e. a log file, and
      // that is simply absent on an agent built without one. A silent
      // degradation is what this row exists to remove, so it cannot be
      // announced on a channel whose whole failure mode is silence.
      const agentNotices: ClaudeRuntimeAgentNotice[] = [];

      // P2.7 — the composed managed policy, projected onto the SDK's policy
      // tier. Resolved BEFORE the options literal so the diagnostics run even
      // when the mapping produces nothing: "this policy key cannot reach the
      // claude runtime" is exactly the fact an administrator needs, and it is
      // the fact a silent `{}` would hide.
      const managedPiPolicyFloor = resolveManagedPiPolicyFloor();
      const claudeManagedSettings = mapManagedPolicyToClaudeSettings(managedPiPolicyFloor);
      for (const line of formatClaudeManagedSettingsDiagnostics(claudeManagedSettings)) {
        this.debug(line);
      }
      // P6.613 — the two managed facts that belong on the DURABLE operator
      // channel rather than on `debug`.
      //
      // The lines above stay: `formatClaudeManagedSettingsDiagnostics` is the
      // full explanation of every key, and a session log is the right place for
      // thirty reasons. What could not stay on that channel is the SUBSET that
      // means "your policy is not in effect" — `this.onDebug` is an optional
      // callback that `SessionManager` points at a log FILE and that is simply
      // absent on an agent built without one, so the one fact an administrator
      // has to act on was reaching nobody. `queueDegradationNotice` latches per
      // session and lands on the turn in flight, which is the channel the
      // switch-visible degradations already use.
      //
      // `setupI18n()` is guarded for `base-agent.ts`'s measured reason: an
      // uninitialised i18next singleton returns `undefined` from `t()`, and the
      // headless `nessy-server` entry never calls it — an empty warning would be
      // strictly worse than the fact never being raised.
      if (!i18n.isInitialized) setupI18n();
      const unenforcedManagedKeys = claudeManagedPolicyUnenforcedKeys(claudeManagedSettings);
      if (unenforcedManagedKeys.length > 0) {
        this.queueDegradationNotice(i18n.t('chat.managedPolicy.unenforcedKeys', {
          keys: unenforcedManagedKeys.join(', '),
        }));
      }
      for (const notice of claudeManagedPolicyUnhonouredAllowNotices(claudeManagedSettings, i18n.t)) this.queueDegradationNotice(notice); // F1.1001 — a managed permissionDsl allow claude does not honour, said once
      // P6.541 — the ONE autoMode set this runtime withholds, on the same
      // channel and for the same reason. The other three now travel
      // (`buildClaudeAutoModePolicySettings` appends the administrator's entries
      // to ours a few dozen lines below); `allow` is refused on every runtime
      // because a floor never grants, and an administrator whose exception
      // silently did not apply would meet it as a classifier that keeps denying for no stated reason.
      if (refusedClaudeManagedAutoModeKeys(managedPiPolicyFloor?.autoMode).length > 0) {
        this.queueDegradationNotice(i18n.t('chat.managedPolicy.autoModeAllowWithheld'));
      }
      // P6.370 — a control the user set that cannot bind on THIS connection is
      // said out loud, on the same durable channel. `switchModelsOnFlag` binds
      // only where Anthropic's safety classifier runs, i.e. a direct-Anthropic
      // connection; `claudeRuntimeUpstreamKind` is set only on the
      // `claude-runtime` loopback path, so a non-null value IS the gateway/BYO
      // case where the key is inert. `undefined` for every unconfigured
      // session, so nothing new is said to anyone who did not ask.
      const claudeSwitchModelsInert = claudeSwitchModelsInertNotice({
        directAnthropic: this.claudeRuntimeUpstreamKind === null,
      });
      if (claudeSwitchModelsInert) this.queueDegradationNotice(claudeSwitchModelsInert);
      // P3.186 — through the seam, not spread beside a second one later. Today
      // there is exactly one contributor; the point is that the SECOND is added
      // here, where the merge and its collision report are visible.
      const claudeManagedSettingsOptions = buildClaudeManagedSettingsOptions(
        {
          managedPolicyFloor: claudeManagedSettings.settings,
          // P6.511 — and here is that second contributor. The product's own
          // refusal of `command` marketplace sources, which holds with or
          // without an administrator, expressed where the merge and its
          // collision report can see it rather than as an unconditional branch
          // inside a mapper whose root invariant is that a policy saying nothing
          // sends nothing. Silent when the administrator already answered, in
          // either direction; see `claudeCommandPluginSourceFloor`.
          productCommandSourceFloor: claudeCommandPluginSourceFloor(managedPiPolicyFloor),
          // P6.688 — the SECOND route
          // `tools-reference.md#enable-the-powershell-tool` names: *"Set
          // `CLAUDE_CODE_USE_POWERSHELL_TOOL=1` in your environment or in
          // `settings.json`"*. P6.530 closed the environment route; we pass
          // `settingSources` with `project` for a trusted project, so its file
          // could still hand the child a second command executor outside the
          // deny surface we advertise as off.
          //
          // A DENY RULE rather than the vendor's own key, and that is measured
          // rather than chosen: `env` is absent from the SDK's restrictive
          // managed-settings filter, so an `env` entry emitted from this tier
          // would look like enforcement and do nothing
          // (`__tests__/powershell-tool-settings-route.test.ts` reads the
          // filter body out of the vendored bundle). `permissions` IS copied,
          // narrowed to `deny`/`ask` — see `claudePowerShellToolDenyFloor`.
          //
          // Unconditional, unlike the marketplace floor above: the policy
          // schema has no PowerShell term an administrator could widen.
          productPowerShellToolFloor: claudePowerShellToolDenyFloor(),
          // P6.441 — the HOST's git-attribution answer, so a project
          // `.claude/settings.json` cannot hand the child a trailer the user
          // turned off. Only the OFF direction rides this tier and that is
          // measured, not chosen: the SDK's restrictive filter carries
          // `commitTrailers:false` and `sessionUrl:false` and copies no custom
          // text — the trailer's WORDING reaches all three runtimes through the
          // system prompt instead. `undefined` when attribution is on, so an
          // unmanaged install spawns byte-identically.
          hostAttributionFloor: claudeAttributionFloor(resolveGitAttribution()),
        },
        line => this.debug(line),
      );

      // P3.147 — the read-side credential floor, mirrored onto the SDK's OWN
      // deny surface instead of living only at our request gate.
      //
      // `settings-reference.md#exclude-sensitive-files` promises three things of
      // `permissions.deny` — it "excludes matching files from file discovery and
      // search results, denies reads of them, and blocks the Edit and Write
      // tools on the matching paths" — and the same page records
      // `Default: unset`, so until now the SDK denied nothing: only an
      // administrator's managed policy reached `permissions.deny` above.
      //
      // WHAT THIS DID NOT DO, AND NOW DOES: the row opened on the reasoning
      // that this would close P3.105's search-results half for free. Measured on
      // the vendored binary at 2.1.223, 2.1.233 and 2.1.247 it did NOT — a
      // `Read` of the denied file was refused while `Grep` and `Glob` rooted one
      // level above it still returned it, secret value included, in the same run
      // and from this same settings object. Driven again on 2026-09-13 at
      // 2.1.251 (C3.380's lift), all four exclusion facts inverted: the denied
      // file's name and its secret are gone from `Grep` content, `Grep`
      // files-with-matches and `Glob`, with the `Read` refusal and the undenied
      // file's hits as the two controls
      // (`__tests__/claude-denied-path-search-results-e2e.test.ts`). So the
      // mirror now DOES buy the search-results half on claude. Our own filter is
      // kept beside it — retiring it is a switch verdict, not a lift's call.
      //
      // Our gate is unchanged and stays authoritative — it runs first and fails
      // the call before the SDK is consulted. This is defence in depth, and a
      // deliberate SUBSET: `claude-denied-path-rules.ts` drops any pattern it
      // cannot translate faithfully and says so on this channel, because a
      // pattern that silently became "deny nothing" would be worse than one
      // never sent.
      //
      // Resolved from the same merged config the gate reads, so a workspace or
      // managed layer that widens the floor widens the mirror with it. No
      // permissions context (a turn with no capability view) means no mirror and
      // a byte-identical spawn.
      const deniedPathsForMirror = (() => {
        const permissionsContext = this.permissionManager.getCapabilityPermissionsContext?.();
        if (!permissionsContext) return undefined;
        try {
          return permissionsConfigCache.getMergedConfig(permissionsContext).deniedPaths;
        } catch (error) {
          this.debug(`[ClaudeAgent] credential floor could not be read for the SDK mirror: ${String(error)}`);
          return undefined;
        }
      })();
      const claudeDeniedPathMapping = mapDeniedPathsToClaudeRules(deniedPathsForMirror);
      for (const line of formatClaudeDeniedPathDiagnostics(claudeDeniedPathMapping)) {
        this.debug(line);
      }
      // P3.94 — the SDK's own auto-mode classifier, told what deployment it is
      // judging. `claude-auto-mode-policy.ts` carries the measurement (P3.95:
      // `Options.settings` IS the seam that reaches the classifier's prompt,
      // `managedSettings` is not) and the reason each rule earns its place.
      //
      // Composed with the credential-floor mirror rather than spread beside it:
      // `settings` is ONE option, so a second `...{ settings }` in this literal
      // would REPLACE the first and delete P3.147's floor with no error and no
      // log line. `buildClaudeFlagSettingsOptions` is the only writer.
      // P3.352 — resolved before the compose so its notice can reach the user
      // even on a spawn where nothing else has anything to say.
      const claudeWebFetchPreflight = buildClaudeWebFetchPreflightSettings(
        managedPiPolicyFloor?.sandbox?.network,
      );
      for (const notice of claudeWebFetchPreflight.notices) {
        this.queueDegradationNotice(notice);
      }
      // P6.1023 — the operator's `--settings` PATH says so where an operator reads it, not only in
      // `debug()`: the composer's own drop line goes to `onCollision` → `this.debug`, and a packaged build
      // logs nothing outside debug mode. Contributes no settings — the flag itself is a contributor below.
      for (const notice of buildClaudeOperatorSettingsFlagNotices(flagSettings).notices) {
        this.queueDegradationNotice(notice);
      }
      // F1.981 — the connection's endpoint pinned on the flag tier, above every Claude settings file; the operator flag's `env` is folded into it. F1.1008 — the files this child loads are read first, so a credential one names is cancelled too.
      const claudeEndpoint = buildClaudeEndpointFlagSettings({ connectionBaseUrl: this.config.envOverrides?.ANTHROPIC_BASE_URL, operatorFlag: flagSettings, loadedSettingsFiles: claudeSpawnSettingsFiles({ cwd: resolvedCwd, settingSources, envOverrides: this.config.envOverrides }) });
      for (const notice of claudeEndpoint.notices) this.queueDegradationNotice(notice);
      const claudeFlagSettingsOptions = composeClaudeSpawnSettings(
        {
          flags: buildClaudeFlagSettingsOptions({
            deniedPathSettings: buildClaudeDeniedPathSettingsOptions(claudeDeniedPathMapping).settings,
            autoModeSettings: buildClaudeAutoModePolicySettings({
              gatewayUpstream: this.claudeRuntimeUpstreamKind === 'nestor',
            }),
            // P6.370 — the user's model-switch answer, resolved against THIS
            // connection. `claudeRuntimeUpstreamKind` is set only on the
            // `claude-runtime` loopback path (`startLocalAdapterRuntime`), so
            // `null` IS the direct-Anthropic case — the one deployment where
            // the safety classifier that raises the flag runs at all.
            switchModelsSettings: buildClaudeSwitchModelsOnFlagSettings({
              directAnthropic: this.claudeRuntimeUpstreamKind === null,
            }),
          }).settings,
          // C3.162 (QK5) — the session's ultracode toggle, on the vendor's own
          // settings key.
          //
          // A CONTRIBUTOR of its own rather than a fifth key inside `flags`, for
          // the reason the WebFetch preflight below is one: it owns exactly one
          // settings key and it is the only per-TURN value in this object, so a
          // future writer of `ultracode` collides by name here instead of
          // overwriting silently. `agent/ultracode-mode.ts` carries the
          // measurement — the key is in the binary 156 times against a
          // fabricated control at 0, and it is NOT one of the 40 entries in the
          // SDK's restrictive managed-settings table, so the FLAG tier is the
          // only tier that reaches the child.
          //
          // `ChatOptions.ultracode` is set at exactly one place
          // (`SessionManager.sendMessage`, behind `resolveUltracodeAvailability`)
          // and is `true`-or-absent, so a session that never touched the toggle
          // contributes `{}` and spawns byte-identically.
          ultracode: buildClaudeUltracodeSettings({ requested: turnUltracode, model }),
          // P3.352 (CRU-7) — the vendor's WebFetch domain preflight, OFF, and a
          // third contributor rather than a fourth key inside `flags`: it owns
          // exactly one settings key, so the merge can name it if a future
          // contributor writes the same one. Owner sitting §2.2 = (C). See
          // `buildClaudeWebFetchPreflightSettings` for what pairs with it.
          webFetchPreflight: claudeWebFetchPreflight.settings, cloudTools: claudeAiCloudToolSettings(), endpoint: claudeEndpoint.settings,
          // P6.134 — the user's `worktree.bgIsolation`, on the seam the SDK
          // reads it from. Unconditional, and that is the point: the SDK's
          // unset default is `'worktree'` while ours resolves to `'none'`, so
          // omitting it did not leave the choice unenforced, it INVERTED it.
          worktree: buildClaudeWorktreeSettings(
            resolveWorktreeSettings([getUserWorktreeSettings()]).bgIsolation,
          ),
          // P6.439 clause (1), made LIVE by P6.1009 — the operator's
          // `--settings`, and it is LAST in this object on purpose.
          //
          // It used to ride `buildClaudeTurnShapeOptions`'s return into the same
          // options literal as this composed value, ~200 lines apart; `settings`
          // is ONE key and the later spread won, so the flag was discarded on
          // every spawn while its tests passed against the builder. A
          // contributor is the only shape that puts it in the literal at all,
          // because the literal must keep exactly one `settings`.
          //
          // LAST because this composer keeps the FIRST writer of a key and names
          // the loser out loud: the floor stays the floor. P3.147's credential
          // deny list, the auto-mode policy, the WebFetch preflight and the
          // user's `worktree.bgIsolation` all beat the flag on the keys they
          // write, and every one of the flag's OTHER keys reaches the child —
          // which is the whole of what the clause promised. An operator cannot
          // use the tier to lift a host floor, and when they try, the collision
          // is spoken by name rather than resolved silently in either direction.
          //
          // A PATH value is dropped by the composer with its own diagnostic (it
          // cannot merge a filename into an object). That is not new — a path
          // was overwritten silently before — and the residue is deliberate: the
          // child's own existence, regular-file and 2 MiB checks are what
          // `config/claude-flag-settings.ts` refuses to duplicate, so reading
          // the file here would give two answers to one question. P6.1023 is the
          // other half: that drop is now SAID to the operator by
          // `buildClaudeOperatorSettingsFlagNotices` above, because the
          // composer's own line reaches `debug()` and nothing else.
          operatorSettingsFlag: claudeEndpoint.operatorFlag, // F1.981 — minus the `env` the endpoint contributor carries
        },
        // P6.1031 — the decision is made HERE, on the collision's structure, and
        // never on its text: only a collision whose LOSER is the operator's own
        // flag is something an operator can act on, and a collision between two
        // host contributors is a developer's business. `detail` is absent for
        // the whole-contributor path drop, which
        // `buildClaudeOperatorSettingsFlagNotices` above already speaks for, so
        // this cannot double it.
        (message, detail) => {
          if (detail?.loser === 'operatorSettingsFlag') {
            for (const notice of buildClaudeOperatorSettingsFlagCollisionNotice(detail.key).notices) {
              this.queueDegradationNotice(notice);
            }
            this.debug(message);
            return;
          }
          this.debug(message);
        },
      );

      // P6.312 — the agent this session runs AS, read per turn from the host key
      // rather than captured at spawn, for the reason every other per-turn read
      // in this builder has: a user editing `config.json` under a live session
      // must not be answered by the value it launched with. It reaches
      // `claudeLiveSessionSignature` through `agent` and through the pinned
      // entry's own shape, so a changed pin respawns instead of being ignored.
      const sessionAgentName = getSessionAgentName();

      const options: Options = {
        ...getDefaultOptions({
          ...this.config.envOverrides,
          ...pluginRuntime.environment,
          // P6.527 — the SDK's own off switch for its built-in subagents, set on
          // exactly the turns that register a roster of our own. The gate is
          // `buildClaudeRuntimeAgentOptions`'s own pair of conditions, read from
          // the same two inputs a few hundred lines below, so a session with no
          // definitions of its own is unchanged and keeps the SDK's set. The
          // module header carries the two documented residues and the binary
          // measurement that the switch applies only in non-interactive mode —
          // which every SDK session we spawn is.
          //
          // P6.313 — the SAME fragment now also carries the user's answer on
          // the runtime's OTHER documented off switch,
          // `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS`, defaulted from
          // `config.json` inside the builder. It is deliberately NOT gated on
          // the definitions pair above: that gate is about whether WE supply a
          // roster, and the user's standing answer has to hold on the turn
          // shapes the gate leaves alone, which are the only ones where the
          // built-in Explore/Plan pair still exists to remove.
          ...buildClaudeRuntimeBuiltinAgentEnv({
            definitions: this.config.piRuntimeAgentDefinitions,
            mini: miniConfig.enabled,
          }),
          // P6.390 - this chat's memory scope, resolved against the app-wide
          // switch inside `applyAutoMemoryOffSwitch`. Undefined (no per-chat
          // override) is the behaviour this call had before the control existed.
        }, this.config.session?.memoryScopeOverride),
        model: effectiveModel,
        // Capture stderr from SDK subprocess for error diagnostics
        // This helps identify why sessions fail with "process exited with code 1"
        stderr: (data: string) => {
          // Log to both debug file AND console for visibility
          debug('[SDK stderr]', data);
          console.error('[SDK stderr]', data);
          // C3.259 — one line on this channel is EXPECTED on every gateway and
          // BYO spawn. It is not dropped and not mapped away (the reasons are on
          // `describeClaudeUnrecognizedModelStderr`); what is added is the
          // sentence that was missing everywhere, once per session.
          if (!this.explainedUnrecognizedModelStderr) {
            const expectedStderr = describeClaudeUnrecognizedModelStderr(data);
            if (expectedStderr) {
              this.explainedUnrecognizedModelStderr = true;
              debug('[SDK stderr:expected]', expectedStderr);
              console.error('[SDK stderr:expected]', expectedStderr);
            }
          }
          // P3.267 + P3.310 — one line on this channel is a switch-visible fact
          // rather than a diagnostic, and neither of the two sinks above reaches
          // a user on a packaged build. See the method for the measurement and
          // for why the vendor's sentence is relayed rather than paraphrased.
          this.surfaceForcedDefaultModeNotice(data);
          // Keep last 20 lines to avoid unbounded memory growth
          this.lastStderrOutput.push(data);
          if (this.lastStderrOutput.length > 20) {
            this.lastStderrOutput.shift();
          }
        },
        // Thinking config is provider-aware:
        // - true Anthropic backends use adaptive thinking + effort
        // - anthropic_compat/custom endpoints fall back to token budgets
        // - non-Claude models disable thinking entirely
        ...thinkingOptions,
        // System prompt configuration, plus the two other turn-shape options we
        // now pass explicitly (settingSources, and maxTurns only for a child):
        // - Mini agents: Use custom (lean) system prompt without Claude Code preset
        // - Normal agents: Append to Claude Code's system prompt (recommended by docs)
        // P6.439 clause (1) reached the child through this builder until P6.1009
        // measured that the composed `settings` overwrote it here. It is now a
        // contributor to `composeClaudeSpawnSettings` above — resolved ONCE per
        // turn build and applying to BOTH branches for the same reason it always
        // did: a mini agent is a session of this same host, and there is no
        // reading under which the operator's `--settings` applies to one branch
        // and not the other.
        ...buildClaudeTurnShapeOptions(miniConfig.enabled
          ? {
              miniSystemPrompt: this.getMiniSystemPrompt(),
              sessionMaxTurns: this.getMaxAgentTurns(),
              ...(settingSources === undefined ? {} : { settingSources }),
            }
          : {
              sessionMaxTurns: this.getMaxAgentTurns(),
              ...(settingSources === undefined ? {} : { settingSources }),
              // Working directory included for monorepo context file discovery
              presetAppend: getSystemPrompt(
                this.pinnedPreferencesPrompt ?? undefined,
                this.config.debugMode,
                this.workspaceRootPath,
                this.config.session?.workingDirectory,
                undefined, // preset
                undefined, // backendName
                this.pinnedIncludeCoAuthoredBy ?? undefined,
                this.config.session?.id,
                turnOutputStyleId,
                this.config.workspace.id,
                this.config.projectTrusted,
                this.capabilityTurnRuntime !== null,
                turnPluginOutputStyles,
                outputStyleProjectRoot
              ),
            }),
        // Use sdkCwd for SDK session storage - this is set once at session creation and never changes.
        // This ensures SDK can always find session transcripts regardless of workingDirectory changes.
        // Note: workingDirectory is still used for context injection and shown to the agent.
        // For fork attempts: use the parent's sdkCwd so the SDK subprocess can find the parent's
        // session file (stored under ~/.claude/projects/{cwd-hash}/). Without this, cross-CWD
        // branches (e.g., worktree ↔ main repo) fail with "No conversation found".
        cwd: resolvedCwd,
        // C3.69 — never-persist, spoken in the runtime's own vocabulary. The
        // spread is EMPTY unless the session was built under the setting or one
        // of the two documented env spellings, so the SDK keeps its `true`
        // default on every normal session and this cannot fight another
        // contributor of the same option.
        ...this.sessionPersistenceOptions,
        includePartialMessages: true,
        // F1.919 (owner decision 2026-09-26, option (c)) — OFF, sent explicitly.
        // P6.305 turned this on for the SDK's own progress line: `sdk.d.ts`
        // says the subagent's conversation "is forked every ~30s to produce a
        // short present-tense description", and "Defaults to false." That fork
        // is the defect. Its model re-issues the worker's PENDING tool call, our
        // PreToolUse hook's `prompt` branch raises a SECOND, identical card, and
        // an Allow on it runs nothing: the fork's own `canUseTool` denies ("No
        // tools needed for summary"; the binary logs "Hook approved tool use for
        // Bash, but canUseTool is required" — F1.901, `8eb2b456f`). Measured on
        // the RC #4 build (SIT-an2, SIT-an3): the duplicate appears ~30 s after a
        // background worker starts, and the worker's real card expired at 540 s
        // with the model reporting it unanswered. Sent as `false` rather than
        // left out, so a lift that flips the default cannot bring it back
        // unseen (pinned at the `query()` seam, `claude-runtime-agents-seam.test.ts`).
        //
        // What the agent panel shows now: `task_progress.last_tool_name`, which
        // the SDK sends with no option; `event-adapter.ts` already falls back to
        // it (`summary || last_tool_name`). Lost: only the model-written phrase.
        // The memory forks (`extract_memories`, `auto_dream`) do not read this
        // option; `autoMemoryEnabled` / `autoDreamEnabled` gate them.
        agentProgressSummaries: false,
        // P6.561 — ASK for the subagent transcript the runtime already has.
        // Native-first step 1: `forwardSubagentText` is the vendor's own option
        // (`sdk.d.ts` `Options.forwardSubagentText`, CLI `--forward-subagent-text`),
        // so this is configuration, not construction. `cli-reference.md` states
        // it verbatim: "Emit subagent text and thinking blocks in the output
        // stream as `assistant` and `user` messages with `parent_tool_use_id`
        // set, so you can reconstruct each subagent's transcript. Without this
        // flag, Claude Code emits only subagent `tool_use` and `tool_result`
        // blocks." The page requires 2.1.211 (2.1.219 for nested subagents) and
        // the vendored bundle self-reports 2.1.247 (it read 2.1.233 until the
        // P7.1 lift), so both are satisfied, and by a wider margin.
        //
        // What it changes for us, stated as the difference: `event-adapter.ts`
        // already stamps `parentToolUseId` on every `text_delta`/`text_complete`
        // from the SDK's `parent_tool_use_id`, and `turn-utils.ts` already nests
        // an activity carrying that id under its parent tool row — so the whole
        // pipeline was in place and the only missing thing was asking for the
        // frames. Off, a fan-out is a heartbeat counter (which is what Pi does,
        // `subagent-tool.ts` forwards a heartbeat only), and a slow subagent is
        // indistinguishable from a hung one. P6.382 is the disclosure that
        // remains true for the runtimes that still cannot do this.
        forwardSubagentText: true,
        // P7.18 — DECLARE the per-task stop affordance, because at 0.3.247 the
        // absence of this line is itself a behaviour and it is not the one this
        // app has.
        //
        // The option arrived with the lift (`sdk.d.ts` scores 0 for the name at
        // 0.3.233 and declares it twice at 0.3.247 — on `Options` and on
        // `SDKControlInitializeRequest`), and the vendor states the fail-closed
        // rule verbatim: *"The CLI also fails closed on absence: without the
        // declaration, an interrupt kills background tasks, because a spared
        // runaway task would otherwise be unstoppable from this consumer short
        // of ending the session."* So the lift ALONE would change what Stop
        // does here — a user who interrupts a turn would lose every background
        // subagent and workflow the session was holding — and that change would
        // arrive silently, attributable to nothing in this repository.
        //
        // Declaring it is HONEST rather than optimistic: the precondition the
        // vendor names is *"this consumer renders a per-task stop control wired
        // to the `stop_task` control request"*, and this app does. The control
        // is the task chip card's Stop (`BackgroundTaskChip.tsx`, UB14.7); it reaches
        // `SessionManager.killShell`, which routes a non-Pi handle to
        // `AgentInstance.stopBackgroundTask`; and {@link stopBackgroundTask}
        // below is that method on this backend, sending the SDK's own
        // `Query.stopTask(taskId)`. A runaway task is therefore stoppable one at
        // a time, which is the whole condition the fail-closed default protects.
        //
        // What it deliberately does NOT do: it does not build the one gesture
        // that stops EVERY background task at once. That is P6.275, still open
        // on all three runtimes, and inheriting a kill-them-all-on-Stop from a
        // default would not be that feature — it would be the loss of the
        // per-task control, dressed as one.
        perTaskStopAffordance: true,
        // P6.471 — OPT IN to the `preview` field, and pick the format this app
        // actually draws.
        //
        // Native-first step 1: `Options.toolConfig` is the vendor's own switch,
        // so this is configuration rather than construction. It reads like a
        // no-op and is not, because the vendored typings and the page disagree
        // about what "unset" means and only one of them is describing
        // BEHAVIOUR. `sdk.d.ts` annotates the FIELD `@default 'markdown'`;
        // `agent-sdk/typescript.md#toolconfig` describes the OPTION: "Opts into
        // the `preview` field on AskUserQuestion options and sets its content
        // format. When unset, Claude does not emit previews", and
        // `agent-sdk/user-input.md#option-previews-typescript` says it twice
        // more — "Without this setting, Claude does not generate previews and
        // the field is absent", with a table row reading "unset (default) |
        // Field is absent. Claude does not generate previews." The two
        // reconcile exactly: the FIELD defaults to `markdown` once the object
        // exists, and no object means no previews at all. So this line is what
        // turns previews on for claude, not a restatement of a default.
        //
        // `'markdown'` and not `'html'`, deliberately. The page: markdown
        // `preview` contains "ASCII art and fenced code blocks", html "A styled
        // `<div>` fragment". `AskUserRequest.tsx` renders the field into a
        // `<pre>` — the monospace box the SDK's own doc comment describes for
        // the markdown arm — so an HTML fragment would be printed as literal
        // markup. Changing this value means changing that component in the same
        // commit.
        //
        // The two runtimes that do not follow, named so the gap is not read as
        // an oversight: Pi already PRODUCES `option.preview`
        // (`pi-agent-server/src/orchestrator/ask-user-tool.ts`) and needs no
        // switch; codex HAS a question surface — `item/tool/requestUserInput`,
        // mapped in `codex-agent.ts` — but its option type carries no preview at
        // all (`codex-protocol/generated/v2/ToolRequestUserInputOption.ts`:
        // `{ label: string, description: string }`), so codex is an honest
        // `n/a` on this field rather than an unenabled one.
        toolConfig: { askUserQuestion: { previewFormat: 'markdown' } },
        // P6.314 — the operator's append text, on the runtime's own flag.
        // Absent when the knob is unset, so the spawn is byte-identical to one
        // built without it. See `buildClaudeSubagentPromptAppendArgs`.
        ...buildClaudeSubagentPromptAppendArgs(resolveSubagentPromptAppend()),
        // P3.336 — TURN ON the stream the hook-failure warning was already
        // wired to. `event-adapter.ts` handles `hook_started`/`hook_progress`/
        // `hook_response` and persists a warning on `outcome === 'error'`, and
        // `git grep includeHookEvents` scored 0 across the whole repo (positive
        // control on the same command: `includePartialMessages`, 2) while the
        // vendored 0.3.233 SDK declares the option `@default false`. So the
        // handler was live for SessionStart and Setup — which the runtime emits
        // regardless — and dead for the entire tool-call path.
        //
        // What that cost, stated as the difference rather than as a feature:
        // `settingSources` is passed (`user`, plus `project`/`local` when trusted), so hooks
        // the CLI child runs from those tiers can block, rewrite or fail a tool call
        // with NOTHING reaching the host, while host-registered SDK automations
        // already surface through `hookErrors` → `reportHookErrors` on every
        // runtime. A settings-tier hook failure was therefore a transcript
        // notice on Pi and codex and a silence on claude.
        //
        // THE DOUBLE-REPORTING HAZARD IS MEASURED AND REFUSED, in the shipped
        // binary rather than argued from the page — and located by CONTENT, not
        // by minified name: this block named five, the 0.3.233 -> 0.3.247 bump
        // reassigned them, and `scripts/check-minified-citations.ts` caught the
        // rot. Re-derived at `2.1.247` from three byte sequences a minifier does
        // not touch: `allHookEventsEnabled` (4 hits), the literal
        // `["SessionStart","Setup"]` (1) and the emitted `subtype:"hook_started"`
        // (`hook_started` 7).
        //
        // The gate is the function that ends
        // `…allHookEventsEnabled&&<eventList>.includes(e)}` after an early
        // `if(<alwaysOn>.includes(e))return!0`, where `<alwaysOn>` is the
        // `["SessionStart","Setup"]` pair; both emitters open with
        // `if(!<gate>(…))return;` and then `{type:"system",subtype:"hook_started"}`
        // / `"hook_response"`. Every call site of the started-emitter is an
        // `http`, `mcp_tool` or command hook: the `…type==="callback"` branch —
        // where OUR SDK-registered hooks run — returns without touching either
        // emitter, and the `"function"` branch does the same. So turning the flag
        // on reports the settings-tier hooks we cannot otherwise see and does NOT
        // re-report the callbacks `hookErrors` already carries.
        includeHookEvents: true,
        // R18: turn-level structured output rides the same outputFormat shape
        // the call_llm path already proved; absent option = byte-identical.
        ...buildClaudeStructuredOutputOptions(turnOutputSchema),
        // P2.28: the SDK's own USD ceiling, read from the SAME per-turn config
        // reader the host-side loop in `BaseAgent.chat` uses. Absent when the cap
        // is off; a changed cap respawns (no setter — see the builder's note).
        // P3.269 · the SDK's own elicitation seam, answered by the SAME handler
        // the host MCP pool uses. Unreachable for the servers we configure (they
        // are all in-process `type:'sdk'` proxies), and the whole point is the
        // servers we do NOT configure: `strictMcpConfig` is unset, so the CLI's
        // own discovery can connect a real one, and the SDK's documented default
        // for that is a silent automatic decline.
        onElicitation: async (request, callbackOptions) => {
          try {
            return await this.handleMcpElicitation(
              toClaudeElicitRequest(request),
              callbackOptions.signal,
              { server: request.serverName },
            ) as ElicitationResult;
          } catch (error) {
            // A refusal the user can read about, rather than a hang. The MCP
            // server still gets a settled answer — `null` is the SDK's "host
            // declines to answer", which it turns into a decline.
            this.debug(
              `[ClaudeAgent] elicitation from ${request.serverName} could not be surfaced`
              + ` (${error instanceof Error ? error.message : String(error)}); declining`,
            );
            return null;
          }
        },
        ...buildClaudeMaxBudgetUsdOptions(this.getMaxBudgetUsd()),
        // P3.264 · the SAME chain `PiAgent.getFallbackModel` reads, on the
        // runtime that had no fallback of either kind. Absent option when the
        // chain is empty or names only this turn's own model, so an
        // unconfigured install spawns exactly as it did.
        ...buildClaudeFallbackModelOptions(
          resolveFallbackModelChain(loadConfigDefaults().workspaceDefaults.fallbackModel, process.env),
          effectiveModel,
        ),
        // P6.34 · the configured additional roots become `--add-dir` roots, so
        // the skills, commands and subagents the page promises from them
        // actually load. Read here, at the one place the child is constructed,
        // for the reason the builder's docblock gives; absent when unconfigured.
        ...buildClaudeAdditionalDirectoriesOptions(getConfiguredAdditionalDirectories()),
        // P2.7 · the managed floor reaches the SDK's OWN policy tier, not just
        // our gate. Absent option when nothing maps, so an unmanaged install
        // spawns exactly as it did. `claudeManagedSettings` was resolved above
        // so its diagnostics could be emitted whether or not it produced a
        // value — an unmappable key is a surfaced fact, never a silent drop.
        ...claudeManagedSettingsOptions,
        // P3.147 · the credential floor reaches the SDK's own `permissions.deny`
        // through the "flag settings" layer, which applies unconditionally —
        // unlike `managedSettings` above, which the SDK drops by default on a
        // machine that already has an admin managed-settings tier. Absent option
        // when nothing mirrors.
        //
        // P3.94 · the same layer now also carries the `autoMode` policy block,
        // because it is the ONLY tier that reaches the classifier's prompt
        // (measured; `managedSettings` has no `autoMode` branch in the SDK's
        // restrictive-only filter). Both contributors are merged upstream — this
        // must stay the only `settings` spread in this literal.
        ...claudeFlagSettingsOptions,
        // Tools configuration (F1.638: an operator whitelist NARROWS either one):
        // - Mini agents: minimal set for quick config edits (reduces token count ~70%)
        // - Regular agents: full Claude Code toolset
        tools: (() => {
          const toolsValue = buildClaudeSessionToolsOption({
            ...(miniConfig.enabled ? { miniTools: miniConfig.tools } : {}),  // Use centralized tool list
            sessionAllowedTools: sessionToolUniverse.allowed });
          debug('[ClaudeAgent] 🔧 Tools configuration:', JSON.stringify(toolsValue));
          return toolsValue;
        })(),
        // R3 — the Claude runtime decides for itself again. This used to be a
        // hard `permissionMode: 'bypassPermissions'` plus
        // `allowDangerouslySkipPermissions: true`, for every session in every
        // mode: the SDK's whole permission system was switched off and our
        // PreToolUse gate decided alone. The recorded reason was real — their
        // rules match command STRINGS while ours parses the command into an AST
        // (`bash-validator.ts`), which is how Safe Mode allows a genuinely
        // read-only command and refuses one that merely starts like an allowed
        // one — and R1 is what satisfies it without the bypass: our allow now
        // carries `permissionDecision: 'allow'`, which "skips the permission
        // prompt" (`hooks.md`), so an approved read-only command still runs with
        // no card.
        //
        // What comes back with the bypass gone: the user's own permission modes
        // reach the runtime that implements them, and the deny/ask/allow rules
        // in their `.claude/settings.json` — which `settingSources` above
        // already loads — are applied by the system that owns them instead of
        // being pre-empted. The translation table and its reasons live in
        // `claude-permission-mode.ts`.
        //
        // The mode is read once, here, because that is the only place the SDK
        // takes it: this backend starts one process per user message, so a
        // mid-turn mode change reaches OUR gate immediately (it reads the mode
        // per call) and reaches the SDK's copy on the next message. When R7's
        // live session lands, this is one of the settings that has to start
        // moving through `setPermissionMode` instead.
        ...buildClaudePermissionModeOptions(getPermissionMode(sessionKey)),
        // User hooks from automations.json are merged with internal hooks
        hooks: (() => {
          // C4.12 (G17-claude) — the SESSION band of a `SessionStart` (and a
          // `UserPromptSubmit`'s `sessionTitle`) reaches the host on THIS
          // backend too.
          //
          // The absence was a missing CONSUMER, not a missing mechanism.
          // `applyHookSessionDirectives` already exists on `BaseAgent`, the
          // delivery callbacks (`onSessionTitle`, `onReloadSkills`) are wired by
          // the host for every backend, and three backends call it after
          // `emitAutomationEvent`. This one calls `emitAutomationEvent` zero
          // times by design — its hooks run inside the SDK child through
          // `buildSdkHooks()` — so the decision was produced in this process,
          // had its four session fields dropped on the way to the SDK (R64, and
          // rightly: the SDK would rename its own record and re-scan its own
          // skill directories), and reached nobody. A hook author saw a
          // directive vanish, which is indistinguishable from a hook that never
          // ran.
          //
          // Registered HERE rather than at construction because the sink closes
          // over this agent, which does not exist when the automation system is
          // built. The band is handed over by the same producer that feeds the
          // other three, so no rule is re-derived on this arm: the decision has
          // already been projected to the event's surface and already past
          // hooks.md's SessionStart `source` gate.
          //
          // `Notification` — the other half of G17's row-mate G10 — is NOT wired
          // here. The SDK declares the event natively and whether it needs any
          // host code at all is an open measurement; adding richness to one
          // runtime of three ahead of that measurement is the silent divergence
          // native-first exists to prevent.
          if (supportsSessionDirectiveSink(this.automationSystem)) {
            this.automationSystem.setSessionDirectiveSink(
              decision => this.applyHookSessionDirectives(decision),
            );
          }
          // User hooks: the session's AgentAutomationSystem (the host's wrapper over PluginScopedAutomationSystem), never the workspace AutomationSystem
          const userHooks: Partial<Record<string, SdkAutomationCallbackMatcher[]>> = this.automationSystem?.buildSdkHooks?.() ?? {};
          if (Object.keys(userHooks).length > 0) {
            debug('[NessyAgent] User SDK hooks loaded:', Object.keys(userHooks).join(', '));
          }

          // Internal hooks for permission handling and logging
          const internalHooks: Record<string, SdkAutomationCallbackMatcher[]> = {
          PreToolUse: [{
            hooks: [async (_hookInput, _hookToolUseId, callbackOptions) => {
              // Only handle PreToolUse events
              if (_hookInput.hook_event_name !== 'PreToolUse') {
                return { continue: true };
              }
              // Validate the fields we depend on are actually present
              if (!_hookInput.tool_name || !_hookInput.tool_use_id) {
                return { continue: true };
              }
              const input = _hookInput as Required<Pick<typeof _hookInput, 'tool_name' | 'tool_use_id'>> & typeof _hookInput;
              const hookSteerGeneration = this.steerGeneration; // F1.335 — read BEFORE the first await; see deliverPendingSteersOn
              this.rememberSubagentToolUse(input.tool_use_id, input.agent_id); // F1.475 — before any await. Then the permission mode, from its single source of truth:
              const permissionMode = getPermissionMode(sessionKey);
              this.onDebug?.(`PreToolUse hook: ${input.tool_name} (sessionId=${sessionId}, permissionMode=${permissionMode})`);
              const originalToolInput = input.tool_input as Record<string, unknown>;

              // Build RTK context fresh per call so toggling the preference
              // takes effect without restart. `getRtkPath()` is cached per
              // process; only the storage read happens each time.
              const rtkContext: RtkContext | undefined = getRtkEnabled()
                ? { enabled: true, path: getRtkPath(), exclude: getRtkExcludeCommands() }
                : undefined;
              const bashSeatbeltSandboxContext = {
                enabled: getMacosSeatbeltBashSandboxEnabled(),
                cwd: this.config.session?.workingDirectory ?? this.workspaceRootPath,
                writablePaths: [
                  // P6.704 - the seatbelt's writable set must name the SAME
                  // directory the gate above allows, or a configured
                  // `plansDirectory` would be permitted and then blocked by the
                  // sandbox. Unset is today's path byte-for-byte.
                  sessionId
                    ? (resolvePlansDirectory(this.workingDirectory)
                      ?? getSessionPlansDir(this.config.workspace.id, sessionId))
                    : undefined,
                  sessionId ? getSessionDataPath(this.config.workspace.id, sessionId) : undefined,
                  ...pluginRuntime.writablePaths,
                ].filter((path): path is string => Boolean(path)),
              };

              const hookPipeline = await runClaudePreToolUseHookPipeline({
                automationSystem: this.automationSystem,
                hookInput: input,
                ...(callbackOptions.signal ? { signal: callbackOptions.signal } : {}),
                revalidate: async hookResolvedInput => {
                  let exactToolInput = hookResolvedInput; let imageResizeHeld: ClaudeImageResizeHold | undefined; // F1.935 — see readableRuleHoldingImageResize

                  // Image redirects are transformations too: validate the
                  // resized path rather than returning it directly to the SDK (an asked image: after its card, F1.935).
                  if (input.tool_name === 'Read') {
                    const filePath = (exactToolInput as { file_path?: string }).file_path;
                    if (filePath) {
                      const ext = filePath.toLowerCase().split('.').pop() || '';
                      if (IMAGE_READ_EXTENSIONS.has(ext)) {
                        try {
                          const stats = await stat(filePath); if (stats.size > IMAGE_LIMITS.MAX_RAW_SIZE) imageResizeHeld = this.readableRuleHoldingImageResize(exactToolInput, filePath, stats.size);
                          if (stats.size > IMAGE_LIMITS.MAX_RAW_SIZE && !imageResizeHeld) { // F1.923 — never copy a denied image; F1.935 — nor an asked one before its card is approved
                            const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
                            this.onDebug?.(`Image ${filePath} is ${sizeMB}MB, attempting resize...`);
                            const resizedPath = this.config.onImageResize
                              ? await this.config.onImageResize(filePath, IMAGE_LIMITS.MAX_RAW_SIZE)
                              : undefined;
                            if (!resizedPath) {
                              return {
                                kind: 'blocked' as const,
                                exactToolInput,
                                reason: claudeImageTooLargeReason(sizeMB),
                              };
                            }
                            this.onDebug?.(`Image resized, revalidating Read at: ${resizedPath}`);
                            exactToolInput = { ...exactToolInput, file_path: resizedPath };
                          }
                        } catch (err) {
                          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                            this.onDebug?.(`Image size check failed for ${filePath}: ${err}`);
                          }
                        }
                      }
                    }
                    this.prerequisiteManager.trackReadTool(exactToolInput);
                  }
                  if (input.tool_name === CLAUDE_HOSTED_WEB_SEARCH_TOOL) { const scoped = scopeClaudeWebSearchInput(exactToolInput); if ('refusal' in scoped) return { kind: 'blocked' as const, exactToolInput, reason: scoped.refusal }; exactToolInput = scoped.input; } // F1.1041 — the operator's NESSY_WEB_SEARCH_ALLOWED_DOMAINS as WebSearch's own allowed_domains, after the trusted hooks and before the gate
                  // D1.332 — the host's read-before-write rule, refused HERE
                  // rather than after the gate: no permission answer can satisfy
                  // "the conversation has not seen this file", which is why Pi
                  // refuses before `onFileMutationAuthorized` too, so putting a
                  // card in front would be a click that changes nothing. See
                  // {@link applyReadBeforeWriteRule}.
                  const unreadWrite = await this.applyReadBeforeWriteRule(
                    input.tool_name,
                    exactToolInput,
                  );
                  if (unreadWrite) {
                    return { kind: 'blocked' as const, exactToolInput, reason: unreadWrite };
                  }

                  return {
                    kind: 'checked' as const,
                    exactToolInput, imageResizeHeld, // F1.935 — an ask's held resize, done by the prompt case below once the card is approved
                    checkResult: runPreToolUseChecks({
                      toolName: input.tool_name,
                      input: exactToolInput,
                      sessionId,
                      sessionKey,
                      permissionMode,
                      workspaceRootPath: this.workspaceRootPath,
                      workspaceId: extractWorkspaceSlug(this.workspaceRootPath, this.config.workspace.id),
                      // P6.704 - the configured `plansDirectory` when it is set and
                      // contained; unset falls back to today's session path byte-for-byte.
                      plansFolderPath: sessionId
                        ? (resolvePlansDirectory(this.workingDirectory)
                          ?? getSessionPlansDir(this.config.workspace.id, sessionId))
                        : undefined,
                      dataFolderPath: sessionId ? getSessionDataPath(this.config.workspace.id, sessionId) : undefined,
                      workingDirectory: this.config.session?.workingDirectory, shellHasClaudeJobDir: true, runtimeCwd: resolvedCwd, // F1.899 — `buildClaudeSubprocessEnv` names the job dir in this child's shell; UB12.19 — the child's own spawn cwd (the session folder for a no-project session), where its relative paths land
                      // P6.202 clause (3) — "The prompt doesn't appear in
                      // non-interactive `-p` runs or background sessions". The
                      // NEAREST observable this fork already keeps is
                      // `isHeadless`, whose own contract is "disables interactive
                      // tools" (`backend/types.ts`) and which the session layer
                      // sets for exactly those sessions — title generation,
                      // spawned children, automations. No new flag is invented.
                      interactive: !this.isHeadless,
                      activeSourceSlugs: Array.from(this.sourceManager.getActiveSlugs()),
                      allSourceSlugs: this.sourceManager.getAllSources().map(s => s.config.slug),
                      // UB3.9 (upstream v0.15.1): an ACTIVE source's proxy call
                      // keeps `_intent` through the gate — the proxy declares
                      // the field and takes it out itself; an inactive slug
                      // still strips, and the call must dispatch without it.
                      keepSourceToolIntent: true,
                      ...this.getMcpPreToolUseContext(),
                      // R28 wired this on Pi only, so no `paths:` rule has ever
                      // fired here. R30a's `paths`-gated skills ride the same
                      // trigger and would be refused forever without it.
                      ...this.getPathScopedRulePreToolUseContext(),
                      // P6.839 — the worktree floor's own input, which this
                      // runtime never supplied: without it the floor refuses
                      // claude's OWN native `EnterWorktree` with "this session
                      // has no repository to create or enter a worktree in",
                      // true or not. `bgIsolation` is deliberately not among the
                      // facts passed — claude enforces the write block itself
                      // (`buildClaudeWorktreeSettings`), and enforcing it twice
                      // is the divergence native-first exists to prevent. See
                      // {@link buildClaudeWorktreeFloorContext}.
                      ...(buildClaudeWorktreeFloorContext(this.worktreeGateContext()) ?? {}),
                      hasSourceActivation: !!this.onSourceActivationRequest,
                      permissionManager: this.permissionManager,
                      prerequisiteManager: this.prerequisiteManager,
                      rtkContext,
                      bashSeatbeltSandboxContext,
                      onDebug: (msg) => this.onDebug?.(msg),
                    }),
                  };
                },
              });
              if (hookPipeline.kind === 'blocked') {
                return blockWithReason(hookPipeline.reason ?? 'Blocked by a trusted PreToolUse hook');
              }
              if (hookPipeline.validation.kind === 'blocked') {
                return blockWithReason(hookPipeline.validation.reason);
              }
              const { checkResult, exactToolInput, imageResizeHeld } = this.withClaudeReadablePermissionDeny(hookPipeline.validation, input.tool_name, permissionMode, hookPipeline.input); // F1.813, F1.830, F1.923, F1.935
              const toolInputWasRewritten = hookPipeline.input !== originalToolInput
                || exactToolInput !== hookPipeline.input;

              // F1.238 — the user's mid-turn steers are NOT taken here any more.
              // They were: one string slot, consumed before the verdict below, so a
              // second steer overwrote the first and a blocked, denied or deferred
              // call swallowed it. `continueWith` is now wrapped by
              // `deliverPendingSteersOn`, which drains ALL of them, in order, only
              // into an answer that actually carries `additionalContext`.
              // R28: a rule the gate just activated rides the same
              // additional-context channel as the steer message — the delivery
              // hop that makes a path-scoped rule reach the model at all. It
              // lands in the message history (never the pinned block), which is
              // what keeps it "Lost until a matching file is read again" after
              // compaction. Without this consume, `InstructionsLoaded` reported
              // `path_glob_match` loads whose bodies the model never saw.
              const pathScopedRuleContext = this.consumePendingPathScopedRuleContext();
              const additionalContext = [
                hookPipeline.additionalContext,
                pathScopedRuleContext,
                // (F1.344 — the steers are put AHEAD of these two by `deliverPendingSteersOn`
                // at the moment the answer is returned — so a steer that arrives
                // while a permission card is open still rides the approved call)
              ].filter((value): value is string => Boolean(value)).join('\n\n') || undefined;
              // P2.525 — the operator's half, and it says WHICH call a hook
              // asked to hold. The user's half is the transcript verdict the
              // turn's `tool_deferred` ending composes
              // (`TERMINAL_REASON_NOTICE_VALUES` + `terminal-reason-copy.ts`),
              // written from the RUNTIME's own result rather than from this
              // intent — the runtime may decline to honour the value (an
              // interactive session, or several tool calls in one turn) and
              // then the call proceeds through the normal permission flow, so a
              // user-facing sentence written here would sometimes be false.
              if (hookPipeline.hookDecision === 'defer') {
                this.onDebug?.(`PreToolUse defer for ${input.tool_name} (${input.tool_use_id}): passing the hook's decision to the runtime, which ends the turn with tool_deferred and re-fires PreToolUse for this call on the next one.`);
              }
              // R1: the same decisions as before, now named in the SDK's own
              // `hookSpecificOutput.permissionDecision` vocabulary rather than
              // left unsaid on allow and said in a deprecated top-level field
              // on ask. See `buildClaudePreToolUseContinue` for the quoted
              // contract and for why the old shape survived unnoticed.
              const continueWith = this.deliverPendingSteersOn(buildClaudePreToolUseContinue({
                ...(hookPipeline.hookDecision ? { hookDecision: hookPipeline.hookDecision } : {}),
                ...(hookPipeline.hookReason ? { hookReason: hookPipeline.hookReason } : {}),
                ...(additionalContext ? { additionalContext } : {}),
              }), input.agent_id, hookSteerGeneration);

              // Translate result to SDK format
              switch (checkResult.type) {
                case 'allow':
                  return continueWith(toolInputWasRewritten ? exactToolInput : undefined);

                case 'modify':
                  return continueWith(checkResult.input);

                case 'block': {
                  const diagnostics = getPermissionModeDiagnostics(sessionKey);
                  this.onDebug?.(`__PERMISSION_BLOCK__${JSON.stringify({
                    sessionId,
                    toolName: input.tool_name,
                    effectiveMode: diagnostics.permissionMode,
                    modeVersion: diagnostics.modeVersion,
                    changedBy: diagnostics.lastChangedBy,
                    changedAt: diagnostics.lastChangedAt,
                    reason: checkResult.reason,
                  })}`);
                  return blockWithReason(checkResult.reason);
                }

                case 'source_activation_needed': {
                  const { sourceSlug, sourceExists } = checkResult;
                  if (sourceExists && this.onSourceActivationRequest) {
                    this.onDebug?.(`Source "${sourceSlug}" not active, attempting auto-enable...`);
                    try {
                      const activated = await this.onSourceActivationRequest(sourceSlug);
                      if (activated) {
                        this.onDebug?.(`Source "${sourceSlug}" auto-enabled successfully, tools available next turn`);
                        return denyToolWithReason(`STOP. Source "${sourceSlug}" has been activated successfully. The tools will be available on the next turn. Do NOT try other tool names or approaches. Respond to the user now: tell them the source is now active and ask them to send their request again.`);
                      } else {
                        return denyToolWithReason(`Source "${sourceSlug}" could not be activated. It may require authentication. Please check the source status and authenticate if needed.`);
                      }
                    } catch (error) {
                      return denyToolWithReason(`Failed to activate source "${sourceSlug}": ${error instanceof Error ? error.message : 'Unknown error'}`);
                    }
                  } else if (sourceExists) {
                    return denyToolWithReason(`Source "${sourceSlug}" is available but not enabled for this session. Please enable it in the sources panel.`);
                  } else {
                    return denyToolWithReason(`Source "${sourceSlug}" could not be connected. It may need re-authentication, or the server may be unreachable. Check the source in the sidebar for details.`);
                  }
                }

                case 'call_llm_intercept':
                  // Claude's session tools run in-process via SDK — just allow
                  return continueWith(toolInputWasRewritten ? exactToolInput : undefined);

                case 'prompt': {
                  // One question, one card — see the predicate's own comment for
                  // why the double prompt is fixed here and not in the shared
                  // gate, which serves Pi too.
                  if (askUserQuestionPromptBelongsToCanUseTool(input.tool_name, checkResult)) {
                    return continueWith(
                      checkResult.modifiedInput ?? (toolInputWasRewritten ? exactToolInput : undefined),
                    );
                  }
                  const requestId = `perm-${input.tool_use_id}`;
                  const command = checkResult.command || '';
                  const baseCommand = this.permissionManager.getBaseCommand(command);

                  debug(`[PreToolUse] Requesting permission for ${input.tool_name}: ${command}`);

                  const permissionPromise = new Promise<boolean>((resolve) => {
                    this.pendingPermissions.set(requestId, {
                      resolve,
                      toolName: input.tool_name,
                      command,
                      baseCommand,
                      // F1.921 — a readable-ask card whose `command` is now a subject (a path, a URL,
                      // arguments) must not mint a Bash whitelist key from it; see the predicate.
                      ...(claudeReadableAskCardSkipsHostWhitelist(input.tool_name, checkResult) ? { suppressHostCommandWhitelist: true } : {}),
                    });
                  });

                  if (this.onPermissionRequest) {
                    this.onPermissionRequest({
                      requestId,
                      toolName: input.tool_name,
                      command,
                      description: checkResult.description,
                      type: checkResult.promptType,
                      appName: checkResult.appName,
                      reason: checkResult.reason,
                      impact: checkResult.impact,
                      requiresSystemPrompt: checkResult.requiresSystemPrompt,
                      rememberForMinutes: checkResult.rememberForMinutes,
                      commandHash: checkResult.commandHash,
                      approvalTtlSeconds: checkResult.approvalTtlSeconds,
                      // P6.863 — the MODE alone raised this prompt, so switching
                      // mode can remove it. `nonNegotiable` is the gate's own
                      // discriminant and is "Absent on ordinary mode prompts";
                      // this branch is the gate's prompt, so nothing else has to
                      // be consulted. The readable DSL's DENY half ran before
                      // this card (F1.813, `withClaudeReadablePermissionDeny`);
                      // an ASK match marks the card `askRule` there (F1.830).
                      ...(checkResult.nonNegotiable === undefined ? { modePrompt: true as const } : {}), ...(checkResult.noAlwaysAllow ? { noAlwaysAllow: true as const } : {}), // F1.842 — an ask-rule card hides Always Allow; F1.737, F1.982 — so does every gate floor's
                      // P6.202 clause (3) — the card payload, forwarded verbatim
                      // and only when the gate produced one. Spread rather than
                      // assigned so a prompt of any other class stays byte-identical
                      // on the wire.
                      ...(checkResult.outsideWorkingDirectoryRead
                        ? { outsideWorkingDirectoryRead: checkResult.outsideWorkingDirectoryRead }
                        : {}),
                      // P6.709 — `host_gate`, and this is the one that reads
                      // wrong at a glance: the card is raised from INSIDE the
                      // claude child, but by OUR `runPreToolUseChecks` running
                      // as a PreToolUse hook. The rule, the mode and the reason
                      // are all the host's, so this is the host gate wearing
                      // claude's clothes. `claude_native` is `askToolApproval`,
                      // where the SDK itself asks.
                      origin: 'host_gate', ...(input.agent_id ? { agentLabel: input.agent_id } : {}), // F1.961 — the hook input's `agent_id` rides the card exactly as C3.370's canUseTool shape does, so the persisted record knows a subagent raised it and is never re-shown after a restart
                    });
                  } else {
                    this.pendingPermissions.delete(requestId);
                    return denyToolWithReason('No permission handler available');
                  }

                  // F1.541 — and the CLI can ABANDON the call first: `Query.stopTask` on the background subagent
                  // that raised this card aborts the hook call's signal (measured 2.1.267: 1 ms after the stop). The
                  // card then leaves the host at once; see withdrawAbandonedCard.
                  callbackOptions?.signal?.addEventListener('abort', () => this.withdrawAbandonedCard(requestId), { once: true });
                  if (callbackOptions?.signal?.aborted) this.withdrawAbandonedCard(requestId); // abandoned before it was shown
                  // F1.76 — the HOST's own deadline on this wait. Without it the
                  // only thing that ends it is the SDK's 600 000 ms hook backstop,
                  // which blames the transport and withdraws nothing; the module
                  // carries the measurement and why the runtime's own per-matcher
                  // `timeout` knob cannot do this job.
                  const answer = await awaitClaudePermissionCardAnswer({
                    wait: permissionPromise,
                    requestId,
                    toolName: input.tool_name,
                    pending: this.pendingPermissions,
                    slot: this.openSlot,
                    withdrawOffTurn: requestId => this.withdrawElicitationDialog(requestId), // F1.527 — its turn may be gone
                    budgetMs: this.permissionCardBudgetMs,
                  });
                  if (!answer.answered) return denyToolWithReason(answer.notice);
                  if (!answer.allowed) {
                    return denyToolWithReason('User denied permission');
                  }

                  // One Nessy approval satisfies both the core prompt and a
                  // restrictive trusted-hook ask floor for this exact input —
                  // and, since R3, the SDK's own ask-rule step too, which would
                  // otherwise raise a second card for this same call.
                  if (input.tool_use_id) this.gateApprovedToolUseIds.add(input.tool_use_id);
                  const approvedInput = checkResult.modifiedInput ?? (toolInputWasRewritten ? exactToolInput : undefined);
                  if (imageResizeHeld?.by === 'ask') {
                    // F1.935 — the copy of a large image an ask rule covers is made only now; see the method.
                    const resized = await this.resizeImageAfterApprovedAsk(imageResizeHeld, approvedInput ?? exactToolInput);
                    return 'reason' in resized ? blockWithReason(resized.reason) : continueWith(resized.input, true);
                  }
                  return continueWith(approvedInput, true);
                }
              }
            }],
          }],
          // P6.63 — the RESULTS half of the sensitive-files contract, on the
          // one seam the runtime gives us for it.
          //
          // This comment used to read "PostToolUse is intentionally supplied
          // only by trusted projected automation hooks … Nessy does not
          // synthesize a false internal hook." The second half is still true —
          // nothing here synthesizes a hook the user did not get — but the
          // first became a gap: `settings-reference.md#exclude-sensitive-files`
          // promises a denied file is excluded "from file discovery and search
          // results", P3.147/P3.174 measured that the binary did NOT do it up to
          // and including 2.1.247 (the `Read` was refused in the same run while
          // `Grep` returned the secret's own line), and P3.340 ruled this seam
          // "EXISTS and is deliberately unused … the honest verdict for both is
          // 'never wired', not 'cannot'." The vendor closed that gap at 2.1.251
          // (driven 2026-09-13, C3.380), so this filter is no longer the only
          // thing performing the clause on claude — it is kept because it is
          // what makes all three runtimes answer the same way, and because the
          // rewrite fails open, so the gated arm that exercises it is the only
          // proof the shape we send is still accepted.
          //
          // It fails OPEN — `hooks.md#posttooluse-decision-control`: "For
          // built-in tools, a value that doesn't match the tool's output schema
          // is ignored and the original output is used", and the shipped binary
          // carries the validator's own line, "…does not match ${e.name}'s
          // output shape; using original output." So an unrecognised shape is
          // DIAGNOSED here and left alone rather than guessed at, and the
          // filter module returns `unsupported` with a reason for exactly that.
          //
          // `additionalContext` carries the withheld notice rather than the
          // payload doing it: two of the three measured shapes are arrays of
          // paths, and a sentence inside one would read as a filename.
          PostToolUse: [{
            hooks: [async (input) => {
              if (input.hook_event_name !== 'PostToolUse') return { continue: true };
              const post = input as typeof input & {
                tool_name?: unknown; tool_input?: unknown; tool_response?: unknown;
              };
              if (typeof post.tool_name !== 'string') return { continue: true };
              // F1.96 (origin D1.410) — the read-before-write credit for a Bash
              // file viewer, on the seam where the call has actually happened.
              // Before every other line of this hook, because the denied-path
              // rewrite below returns early on the common paths and a credit
              // that depends on where it sits in a filter is a credit nobody
              // can reason about.
              this.creditBashViewerRead(post.tool_name, post.tool_input, post.tool_response);
              const toolPath = (post.tool_input && typeof post.tool_input === 'object')
                ? (post.tool_input as Record<string, unknown>).path
                : undefined;
              const rewrite = await rewriteClaudeSearchOutput({
                toolName: post.tool_name,
                toolResponse: post.tool_response,
                searchRoot: typeof toolPath === 'string' ? toolPath : resolvedCwd,
                filter: paths => this.deniedSearchResultPaths(paths),
              });
              if (rewrite.kind === 'unchanged') return { continue: true };
              if (rewrite.kind === 'unsupported') {
                // Latched on the sentence, so one unknown shape does not repeat
                // for the life of the session. A DEGRADATION, not a debug line:
                // the user's floor is silently not covering this result set.
                this.queueDegradationNotice(
                  `A ${post.tool_name} result could not be filtered against your denied paths `
                  + `(${rewrite.reason}), so it was passed to the model unchanged. `
                  + 'Reads of those paths are still denied.',
                );
                return { continue: true };
              }
              this.debug(
                `[denied-paths] withheld ${rewrite.withheldFiles} file(s) from a ${post.tool_name} result`,
              );
              return {
                continue: true,
                hookSpecificOutput: {
                  hookEventName: 'PostToolUse' as const,
                  // `updatedToolOutput` is `unknown` in the SDK's own
                  // `PostToolUseHookSpecificOutput` and `string` in OUR
                  // automation mirror (`automations/types.ts`), because Pi's
                  // route rewrites a tool result as TEXT and the mirror was
                  // shaped to that one consumer. `Grep`/`Glob` outputs are
                  // objects, so the value the runtime requires is one the mirror
                  // cannot express. The cast is to the MIRROR — the SDK's field
                  // accepts this value as declared — and widening the mirror is
                  // an edit to the automations package, which this lane does not
                  // own. Handed over rather than done here; until it lands, this
                  // one site is the only place the narrowing is bypassed.
                  updatedToolOutput: rewrite.output as unknown as string,
                  additionalContext: rewrite.notice,
                },
              };
            }],
          }],
          // F1.187 (origin WJ-h P-WJ-h-2) — the FAILING twin of the hook above,
          // which this fork had declared, documented and read nothing from.
          // `hooks.md#posttoolusefailure-input`: "For Bash and PowerShell, a
          // command that ran and exited produces a first line `Exit code N`".
          // Driven on the vendored 2.1.251 through the real hook dispatch
          // (`claude-post-tool-use-failure-e2e.test.ts`): `cat` of a missing
          // file, `false`, an absent binary and an absent `bat` each fire THIS
          // event and never `PostToolUse`, so a non-zero viewer is told apart by
          // the EVENT, and the response-shape predicate the credit also reads is
          // only the belt. Observational: it credits nothing, says so on the
          // debug channel with the `error`'s first line (which is what a sitting
          // reads to see which event fired), and never answers with a decision.
          PostToolUseFailure: [{
            hooks: [async (input) => {
              if (input.hook_event_name !== 'PostToolUseFailure') return { continue: true };
              const failed = input as typeof input & {
                tool_name?: unknown; tool_input?: unknown; error?: unknown;
              };
              if (typeof failed.tool_name !== 'string') return { continue: true };
              this.declineBashViewerCredit(failed.tool_name, failed.tool_input, failed.error);
              return { continue: true };
            }],
          }],

          // ═══════════════════════════════════════════════════════════════════════════
          // P3.97 — the audit half of the SDK's own auto-mode classifier.
          //
          // The classifier is a permission authority we enable (P3.58), now
          // configured with this deployment's policy (P3.94), whose verdicts
          // reached NOTHING we record. `hooks.md#permissiondenied`: "This hook
          // only fires in auto mode: it doesn't run when you manually deny a
          // permission dialog, when a `PreToolUse` hook blocks a call, or when a
          // `deny` rule matches." The shipped binary is tighter still — it gates
          // the dispatch on `decisionReason.type === 'classifier' &&
          // classifier === 'auto-mode'` — which is why the receipt may stamp its
          // own type from the CHANNEL rather than inventing one. See
          // `claude-permission-denial-receipt.ts` for that measurement and for
          // the three things this receipt provably does not cover.
          //
          // Observational ONLY. The one documented lever here is
          // `hookSpecificOutput.retry`, which asks the model to try the denied
          // call again; minting an audit record is not a reason to re-run a
          // refused action, and a retry policy nobody asked for is a new
          // permission behaviour smuggled in behind an audit row. So this
          // returns `{ continue: true }` and never `retry`.
          // ═══════════════════════════════════════════════════════════════════════════
          PermissionDenied: [{
            hooks: [async (input) => {
              if (input.hook_event_name !== 'PermissionDenied') return { continue: true };
              const denial = input as typeof input & {
                tool_name?: unknown; tool_use_id?: unknown; tool_input?: unknown; reason?: unknown;
              };
              const receipt = buildClaudeAutoModeDenialReceipt({
                sessionId,
                toolName: denial.tool_name,
                toolUseId: denial.tool_use_id,
                toolInput: denial.tool_input,
                reason: denial.reason,
                permissionMode: getPermissionMode(sessionKey),
              });
              // A payload naming no tool, or joined to no tool call, is not
              // minted: a receipt that looks like evidence and identifies
              // nothing is worse than the absence it papers over.
              if (receipt) {
                this.onDebug?.(formatClaudePermissionDenialReceipt(receipt));
                // P6.209 (A42) — retained so the surface has a feed; see
                // `getRecentAutoModeDenials`.
                this.retainAutoModeDenial(receipt);
              }
              else this.onDebug?.('[ClaudeAgent] PermissionDenied fired with no tool_name/tool_use_id; no receipt minted');
              return { continue: true };
            }],
          }],

          // ═══════════════════════════════════════════════════════════════════════════
          // SUBAGENT HOOKS: Logging only - parent tracking uses SDK's parent_tool_use_id
          // ═══════════════════════════════════════════════════════════════════════════
          //
          // P2.496 — WHAT A USER-TIER `disableAllHooks` DOES NOT REACH, AND WHY
          // THAT IS BOTH DOCUMENTED AND (BY OWNER DECISION) NOT THE WHOLE ANSWER.
          //
          // `settings-reference.md#disableallhooks` exempts these by name:
          // *"In any other settings file: Claude Code disables user, project,
          // local, and plugin hooks; managed hooks, Agent SDK hooks, and hooks
          // from plugins force-enabled in managed `enabledPlugins` keep
          // running."* Everything registered in THIS object is an Agent SDK
          // hook, so the shipped behaviour — these two debug matchers and the
          // `Stop`/`SubagentStop` enrichment below surviving the user's switch —
          // is the vendor's stated intent rather than a leak. W2-g established
          // that half (`f6a6a3736`) and pinned the user tier's real boundary in
          // `capabilities/runtime-automations.ts`.
          //
          // The owner's decision is that our OWN host-authored additions should
          // honour the switch anyway — a narrowing, never a widening. Two of the
          // matchers here must stay unreached whatever is decided, because
          // `disableAllHooks` governs hooks, a status line and a file-suggestion
          // command and never a permission decision: routing it into the
          // `PreToolUse` gate would turn a convenience switch into a permission
          // widening, and the `PermissionDenied` matcher is an audit record.
          //
          // WIRED, 2026-09-03: W2-z landed the reader
          // (`AgentAutomationSystem.userTierDisableAllHooks`, set from what used
          // to be a local of `buildPinnedAgentAutomationSystem`) and the gate is
          // the conditional spread below, `claudeSubagentDebugHooksWithheld`.
          // An empty `buildSdkHooks()` could NOT have stood in for it — that is
          // identical to "no automations configured", the far more common case,
          // which the builder answers with `undefined`.
          //
          // Honest size of the prize, measured by W2-g rather than assumed:
          // `withClaudeHostTaskRegistry` only DECORATES `Stop`/`SubagentStop`
          // matchers that already exist, so once the builder has returned
          // nothing it is already inert. What actually survives the switch today
          // is these two `debug()` lines.
          ...(claudeSubagentDebugHooksWithheld(this.automationSystem) ? {} : {
          SubagentStart: [{
            hooks: [async (input, _hookToolUseID) => {
              const typedInput = input as { agent_id?: string; agent_type?: string };
              debug(`[ClaudeAgent] SubagentStart: agent_id=${typedInput.agent_id}, type=${typedInput.agent_type}`);
              return { continue: true };
            }],
          }],
          SubagentStop: [{
            hooks: [async (input, _toolUseID) => {
              const typedInput = input as { agent_id?: string; agent_transcript_path?: string };
              debug(`[ClaudeAgent] SubagentStop: agent_id=${typedInput.agent_id}, transcript=${typedInput.agent_transcript_path ?? 'none'}`);
              return { continue: true };
            }],
          }],
          }),
          };

          // Merge internal hooks with user hooks from automations.json
          // Internal hooks run first (permissions), then user hooks.
          //
          // T9 — the merged result is then given the host's task registry, so a
          // `Stop`/`SubagentStop` hook on this runtime reads the cron records
          // and background work the HOST holds instead of only the child's
          // (whose scheduler `CLAUDE_CODE_DISABLE_CRON=1` suppresses). Applied
          // to the merged map rather than to `userHooks` alone so an internal
          // matcher added to either event later cannot skip it.
          //
          // P2.458 — and then the host's worktree hooks, OUTSIDE that call so
          // the pin on its exact spelling
          // (`claude-scheduling-projection.test.ts`) keeps reading what it was
          // written to read. `withClaudeWorktreeHooks` sees the MERGED map on
          // purpose: it stands down when a user declared their own
          // `WorktreeCreate`, which it can only know from the merged half.
          // Absent port → the map comes back unchanged and the binary keeps
          // creating worktrees with `git worktree`, exactly as before this row.
          // F1.171 — NONE of the matchers above carries a `timeout`, and that is
          // a DECIDED NULL rather than an omission.
          //
          // `HookCallbackMatcher.timeout` is real and honoured: `sdk.d.ts` calls
          // it "Timeout in seconds for all hooks in this matcher" and the
          // shipped binary reads it at the callback dispatch as
          // `hn.timeout ? hn.timeout*1000 : _`, with `_` defaulting to
          // `var Li=600000`. The row that asked this question was written as
          // "this fork never sets it", and that premise is REFUTED: the USER's
          // hooks do get one, from `buildSdkHooksForConfig`, which F1.171 also
          // repaired — it had been passing a MILLISECOND number into that
          // seconds field, a thousandfold widening of the one backstop that was
          // supposed to be a backstop.
          //
          // The matchers HERE are the host's own, and every one of them is
          // in-process work with no wait in it: the denied-path result filter,
          // the auto-mode denial receipt, two `debug()` lines. Their only long
          // path is the PreToolUse gate, whose card is already bounded by the
          // host at `CLAUDE_PERMISSION_CARD_DEADLINE_MS` (F1.76) — strictly
          // under the runtime's own 600 000 ms default, deliberately, so that
          // the sentence a person reads is ours and not the binary's "host
          // client may be unreachable". A per-matcher timeout here could only
          // be shorter than that deadline (which would re-create F1.76 by
          // killing the card early and blaming the transport) or longer than it
          // (dead code). So the honest value is no value, and the runtime's
          // default stays the outer backstop it was built to be.
          return withClaudeWorktreeHooks(
            withClaudeHostTaskRegistry(
              mergeClaudeSdkHooks(internalHooks, userHooks),
              this.config.hookTaskRegistryPort,
            ),
            this.config.claudeWorktreePort,
            {
              ...(sessionId ? { sessionId } : {}),
              debug: line => { this.onDebug?.(line); debug(line); },
              // D1.128 — the refusal sentence, on the surface a person reads.
              // `queueDegradationNotice` rather than a new channel: it is
              // latched (the same refusal twice is one fact), it lands on the
              // open turn slot when there is one — which is the ordinary case
              // here, since a `WorktreeCreate` fires mid-turn for a subagent
              // isolating itself — and it falls back to the pending queue when
              // there is not. English literal, like every other message on that
              // banner and like `appendWorktreeSetupNotice`'s siblings, whose
              // own comment records that decision.
              notice: sentence => this.queueDegradationNotice(sentence),
            },
          );
        })(),
        // C3.61 (owner QD2 = D, 2026-09-11) — the SDK's
        // `resumed_from_incomplete_thinking` is DELIBERATELY not read here, and the
        // reason is recorded so the next reader does not re-derive it.
        //
        // It is a wrapper-level sibling on `SDKAssistantMessage` (never inside
        // `message.content`), declared in `sdk.d.ts` on the vendored 2.1.247 /
        // 0.3.247 bundle, and it scores ZERO readers across `packages` and `apps`.
        // The SDK's own docblock gives its purpose verbatim: the turn "continued
        // the preceding truncated assistant turn inside its trailing signed
        // thinking block (max-output-tokens recovery)", so "a history replayed
        // through the bridge must carry this flag back for the normalizer to keep
        // the run's prefix on the wire."
        //
        // That consumer is a bridge that REPLAYS assistant history. This resume
        // path is not one: we hand the SDK an anchor (`resume` / `forkSession` /
        // `resumeSessionAt`) and it owns its own transcript from there — we replay
        // no assistant turns at it, so there is nothing to carry the flag onto and
        // ignoring it changes no resume decision. If a future path ever does feed
        // assistant history back through the loopback adapter, this is the flag
        // that must ride with it.
        // Continue from previous session if we have one (enables conversation history & auto compaction)
        // Skip resume on retry (after session expiry) to start fresh
        // For branched sessions: fork the parent session so the agent has full conversation context
        ...(!_isRetry && this.sessionId
          ? { resume: this.sessionId }
          : !_isRetry && this.branchFromSdkSessionId
            ? {
                resume: this.branchFromSdkSessionId,
                forkSession: true,
                // Trim the forked conversation at the branch point so the model
                // only sees messages up to where the user branched, not the full parent.
                ...(this.branchFromSdkTurnId ? { resumeSessionAt: this.branchFromSdkTurnId } : {}),
              }
            : {}),
        mcpServers,
        // R2 + R3. The stub this replaced claimed the SDK never calls it under
        // `bypassPermissions` and answered `allow` to everything on that basis.
        // The claim was already wrong then — ask rules, org-`ask` connector
        // tools and interaction-required tools reach this callback in every
        // mode — so the "yes" was live, not inert. R2 routed the model's own
        // question here and refused the rest; R3 gives the rest the real card,
        // which is what makes a user's `ask` rule mean something on this
        // runtime. `buildClaudeCanUseTool` carries the quoted evaluation order.
        canUseTool: buildClaudeCanUseTool({
          askUser: (request, signal) => this.modelQuestionAsk.ask(request, signal),
          // F1.169 — the HOST's deadline on the OTHER card, the `claude_native`
          // one this callback raises. It is not the `case 'prompt'` card F1.76
          // bounded: that branch runs inside a PreToolUse hook callback, where
          // the binary's own 600 000 ms backstop eventually ends the wait with a
          // sentence blaming the transport. This is a `can_use_tool` CONTROL
          // REQUEST, which reaches no hook dispatch at all, and the SDK's own
          // note (quoted in `buildClaudeCanUseTool`) says a missing response
          // "parks the tool with no deadline". Same budget, same sentence and
          // same withdrawal as F1.76, deliberately: two cards a user cannot tell
          // apart must not expire at two different times or say two different
          // things. The expiry is spelled as a DENIAL carrying the notice as its
          // comment because the deny branch already relays a comment verbatim
          // into the SDK's `deny.message` (P6.951), so no new wire field is
          // invented to carry it.
          askPermission: (request, signal) => awaitClaudeNativeCardAnswer({
            wait: this.askToolApproval(request, signal),
            requestId: request.requestId,
            toolName: request.toolName,
            pending: this.pendingPermissions,
            slot: this.openSlot,
            withdrawOffTurn: requestId => this.withdrawElicitationDialog(requestId), // F1.527 — its turn may be gone
            budgetMs: this.permissionCardBudgetMs,
            expired: notice => ({ allowed: false, comment: notice }),
          }),
          alreadyApprovedByGate: toolUseID => toolUseID !== undefined && this.gateApprovedToolUseIds.has(toolUseID),
          permissionMode: () => this.permissionManager.getPermissionMode(),
          // C3.312 — the producer C3.278's seam was built for, and the whole of
          // it: the user's "always allow" answer echoes the runtime's OWN
          // suggestions for that call back to it, and nothing else. The
          // boundary vets them (so the `setMode` an edit card is offered never
          // leaves), and `claudeCallCanRememberForSession` is why the card only
          // offered the button when something would survive.
          sessionPermissionGrant: ({ answer, suggestions }) => (
            answer.rememberForSession === true ? suggestions : undefined
          ),
          // C3.314 — the latched `info`/`level: 'warning'` channel, which is the
          // one path from here that reaches a user in a packaged build.
          warn: message => this.queueDegradationNotice(message),
          debug: message => this.debug(message),
        }),
        // W2-j F2 — this line read "file tools are disabled (use MCP), web/code
        // controlled by settings" and BOTH halves were false, in the direction
        // that misleads: a reader composing an agent's tool list from it would
        // conclude the native file tools are unreachable on this runtime.
        //
        // Measured at the value actually passed: `disallowedTools` starts as
        // `[...CLAUDE_SESSION_DISALLOWED_TOOLS]`, whose entries each carry their
        // own reason. No file tool is among them, and no entry is
        // settings-controlled.
        //
        // P3.314 gave the array its FIRST conditional entry, so "nothing is ever
        // pushed onto it" — which this comment said, and which was the reason a
        // count could be quoted here — is no longer true: a turn whose request
        // the local adapter must TRANSLATE also withholds
        // `CLAUDE_HOSTED_WEB_SEARCH_TOOL`. Read the constant and the one push
        // above for what is banned; a count here would age the way the sentence
        // this paragraph replaced did, which is exactly how it got written.
        //
        // `Read`/`Edit`/`Write`/`Bash` are LIVE natively here — `tools` above
        // hands the SDK `{ type: 'preset', preset: 'claude_code' }` on the
        // non-mini path unless an operator whitelist narrows it (F1.638) — and
        // they run beside their `mcp__session__*` twins.
        // What restricts them is the permission layer (our PreToolUse gate plus
        // the user's own deny/ask rules), never this list. Read the constant,
        // not this comment, for what is banned: a count here would age the same
        // way the sentence it replaces did.
        disallowedTools,
        // F1.638 — no `allowedTools`. P6.217 passed the whitelist here, and the
        // SDK's own words for this option are "auto-allowed without prompting
        // for permission … To restrict which tools are available, use the
        // `tools` option instead" (`sdk.d.ts`): it pre-approved what the
        // operator named and restricted nothing. The whitelist narrows `tools`.
        // P6.272 — the host's file-checkpointing off switch, on the ONE lever
        // the child actually reads. `settings-reference.md#filecheckpointingenabled`
        // ends with: "In a `-p` run or an Agent SDK session, Claude Code ignores
        // this key. The SDK turns checkpointing on with its
        // `enableFileCheckpointing` option" — so projecting the settings KEY
        // into the child would have been a record with no reader, and the row's
        // premise that a project file could turn it off behind our back is
        // refuted for every session this product runs.
        //
        // P6.851 (owner decision 2026-09-10, balance rule) — the option FOLLOWS
        // the setting in both directions now, instead of being pinned off.
        // Native-first tier 1, pure configuration: the SDK owns the producer
        // (`sdk.d.ts`: "Enable file checkpointing to track file changes during
        // the session. When enabled, files can be rewound to their state at any
        // user message using `Query.rewindFiles()`"), so the host passes the
        // setting and reports rather than building a second one beside it.
        //
        // Until this line the asymmetry was deliberate — an OFF switch only —
        // and the argument against `true` was that it hands `/rewind` a restore
        // path this product has never exercised. That argument is now RECORDED
        // rather than acted on: the owner took the enable, and the restore is a
        // sitting case (P7.5) before anyone relies on it.
        //
        // What is true and what is NOT, so the difference stays honest:
        //   - the SDK checkpoints into ITS OWN store. Our manifest
        //     (`createFileCheckpoint`) still has no claude producer, and
        //     `RUNTIME_FILE_CHECKPOINT_PRODUCERS` keeps `anthropic: false` for
        //     that reason — `file-checkpoint-producers.test.ts` pins that record
        //     against the real call sites, so it cannot be flipped by opinion.
        //   - `Query.rewindFiles()` has ZERO call sites in this tree, so the
        //     host's "Restore code" is still unbuilt on claude
        //     (`rewind-menu.tsx` carries that inventory). Enabling the producer
        //     is what makes wiring it possible; it does not wire it.
        //
        // `claudeLiveSessionSignature` hashes this (its own P3.48 note predicted
        // the writer and said what it costs): a session that changes the setting
        // mid-run respawns instead of keeping a child built the old way.
        enableFileCheckpointing: getFileCheckpointingEnabled(),
        // P6.220 — the two banned names above, routed to their gated host
        // twins if the model utters one anyway. Omitted entirely when the
        // `session` server is not in this projection.
        ...(toolAliases ? { toolAliases } : {}),
        // No plugins — skills are handled by BaseAgent.chat() via read-before-execute
        // (the model reads SKILL.md files directly, enforced by PrerequisiteManager).
        // A plugin's AGENTS do not come this way either: they are registered
        // through the SDK's own `agents` option just below, from the same
        // capability-layer definitions the Pi runtime reads.
        //
        // C3.188 (owner answer QL8, 2026-09-11) asked what it would COST to hand
        // this loader the parts we do NOT deliver, and measured it against the
        // vendored 2.1.247 binary through `--plugin-dir`, the CLI spelling of
        // this option. Three findings, in the order that decides the row:
        //
        //   1. The route exists. A bundle whose manifest names ONLY `lspServers`
        //      and whose DIRECTORY holds no default component directories is
        //      accepted (`init.plugins` carries it) and contributes nothing to
        //      `slash_commands`, `agents` or `mcp_servers`. The double delivery
        //      this comment describes is avoided by CONSTRUCTION — a synthesized
        //      directory — not by a flag. The same manifest in a directory that
        //      still holds `commands/`, `agents/` and `skills/` DID deliver all
        //      three, unnamed, because a manifest field the plugin omits leaves
        //      the default directory scanned
        //      (`plugins/manifest-reference.md#component-path-forms`, "Replaces the
        //      default"). `SdkPluginConfig.skipMcpDiscovery` is the narrower
        //      second answer for the MCP third, so `mcpReconciliationSucceeded`'s
        //      standing condition below is not tripped by such a bundle.
        //   2. MONITORS are not one of the parts we fail to deliver. The host
        //      already runs a plugin's monitors on this runtime
        //      (`PLUGIN_MONITOR_SUPPORT.anthropic`, P6.175), and
        //      `plugins/components.md#monitors` says the loader's own monitors
        //      "run only in interactive CLI sessions". Handing them over would
        //      double-deliver into a session that then skips them.
        //   3. So only LSP is left, and it is REFUSED with a number:
        //      `lspServers`/`lspServer`/`'lsp'` each occur 0 times in the
        //      vendored `sdk.d.ts` (control: `workflow` 17), so a plugin language
        //      server that never starts would be invisible to us, where today the
        //      loss is NAMED (`CapabilityDelta.lostLsp`).
        //
        // The whole reading, its controls and what would flip it live on
        // `PLUGIN_LSP_SUPPORT` (`runtime-agent-support.ts`) — one place, because
        // that record is what a future lane would have to change.
        plugins: [],
        // Q7 — before this, the SDK answered `Agent type '<ours>' not found.
        // Available agents: …` for every agent the capability catalog reported
        // `active`, because nothing ever registered one
        // (`.superpowers/sdd/q6-agent-invocation-report.md`, Q6-D4). The mini
        // gate and the omit-when-empty rule live in the builder, with their
        // reasons.
        ...buildClaudeRuntimeAgentOptions({
          definitions: this.config.piRuntimeAgentDefinitions,
          mini: miniConfig.enabled,
          // On a gateway/BYO connection the SDK's model aliases can never
          // resolve, so an agent pinning one is substituted (with a logged
          // announcement) instead of dying with "model not available" —
          // measured live 2026-08-14, Q6-LIVE claim 3. Anthropic connections
          // pass the alias through: those semantics belong to the SDK.
          modelPolicy: buildAgentModelPolicy(
            this.config.connectionSlug,
            this._model,
            // P3.267 — the same sink as the skills channel above, and it MATTERS
            // that both are bound: `buildClaudeRuntimeAgentOptions` reads
            // `skills?.onDiagnostic ?? modelPolicy?.onDiagnostic`, so on a turn
            // with no pinned capability view (no `agentSkills`) this is the only
            // one of the two that runs.
            (message) => this.noteSwitchVisibleDegradation(degradationNotices, message),
            // P6.154 — the inert-tier line, latched to once a session and sent
            // to the log rather than the banner. Its grade is deliberate and
            // measured: see `claudeBuiltinAgentTierDiagnostics`.
            (message) => this.noteBuiltinAgentTierOnce(message),
            // P6.160 — the aliases this child's env actually carries, so an
            // agent pinned to `opus` is admitted instead of substituted. Read
            // off the field the spawn wrote, never recomputed here.
            this.claudeRuntimeAliasModels,
          ),
          ...(agentSkills ? { skills: agentSkills } : {}),
          onNotice: notice => agentNotices.push(notice),
          // P3.345 — the pool a restricted subagent's roster grant may draw
          // from. `getSessionToolNames()` with no arguments is the CLAUDE
          // projection of the same registry `getSessionScopedTools` builds this
          // turn's `session` server from (re-measured 2026-10-15, UB7.11: 61 names on claude, 69 on
          // Pi — the MCP prompt pair added two to each (upstream v0.15.1, offered unconditionally, OQ-B4-2 (c)), after `project_memory_append`'s one on 2026-10-14 (UB1.12), the page tools' six on 2026-10-02 (UA6.3), UA3.5's one and UA1.18's two — with `list_mcp_resources` absent here because it really is
          // `pi-only` — the same-table control). The two host-port options that
          // factory additionally passes (`includeDeveloperFeedback`,
          // `reviewDiffPort`) gate `developer_feedback` and `review_diff` and
          // nothing else, so they cannot move the roster answer; reading the
          // projection rather than the built server keeps this off the SDK
          // server object's private `_registeredTools`.
          // UB6.11 adds a third port-gated name the bare call leaves out: `decide`,
          // offered only when `ctx.decide` is bound (the decision layer configured),
          // so the 61 here is the roster's floor, not its ceiling.
          availableToolNames: [...getSessionToolNames()],
          // P6.312 — see the read above the option literal.
          ...(sessionAgentName ? { mainThreadAgent: sessionAgentName } : {}),
          onDiagnostic: message => this.noteSwitchVisibleDegradation(degradationNotices, message),
          // P6.791 (P6.342 (b)) — the input this seam never had. Our agent
          // definitions declare their MCP servers as resolved capability KEYS
          // and `AgentMcpServerSpec` wants a NAME, so without a translation the
          // whole declaration could only be dropped and announced. The map is
          // this turn's pinned capability view reduced to key → wire name; a key
          // it cannot resolve is still dropped and still named in the notice,
          // because sending a key as a name would hand the child whatever server
          // answered to it.
          //
          // Bound to the SAME `capabilityRuntime` the skills channel above uses,
          // and absent for the same reason: a turn with no pinned view knows
          // none of this session's wire names, and the builder then behaves
          // exactly as it did before this row.
          ...(capabilityRuntime
            ? { mcpWireNamesByKey: mcpWireNamesByCapabilityKey(capabilityRuntime.view) }
            : {}),
        }),
      };
      for (const notice of claudeSettingsFileEndpointNotices(options)) this.queueDegradationNotice(notice); // F1.981 — a settings file naming the endpoint, said
      // C3.336 — this session's runtime diagnostic file, named where the user
      // reads it rather than only in the host log a developer tails.
      //
      // The Pi arm has said it since C3.302; the claude arm's path is chosen
      // inside `buildClaudeSubprocessEnv`, a module function with no agent
      // instance in scope, so it is read back off the environment that function
      // just wrote (`options.ts` symbol `claudeSessionDiagnosticPath`) rather
      // than threaded out through two signatures for one string.
      //
      // YIELDED, not queued: `noteSessionNoticeOnce`'s queue drains at the top
      // of `chat()`, which this builder is already past, so a queued line would
      // hold a fact about THIS run until the user sent a second message.
      // `takeSessionNoticeOnce` shares the same dedupe set, which is what turns
      // a respawn inside one session into one sentence about a path that never
      // changed — the same property the Pi arm relies on.
      //
      // The key is runtime-neutral and takes the path as a VALUE, so this is one
      // call and not a second sentence about the same file.
      const diagnosticPath = claudeSessionDiagnosticPath(options.env ?? {});
      if (diagnosticPath) {
        const notice = this.takeSessionNoticeOnce(
          'chat.runtimeDiagnostic.path',
          { path: diagnosticPath },
          'info',
        );
        if (notice) yield notice;
      }

      // R12 — announce those degradations where the user can see them.
      //
      // `info` + `level: 'warning'` is the one channel from here that reaches a
      // person: `SessionManager`'s `case 'info'` appends it to the transcript as
      // `role: 'info', infoLevel: 'warning'` (so it survives a reload) and sends
      // it to the renderer. `status` was the alternative and is wrong for this —
      // it is a transient chip, and a note about what an agent will not do has
      // to still be there when the agent's answer comes back.
      // The debug line is IN ADDITION to the banner, never instead of it: the
      // user's copy names the agent the way they wrote it, the log's copy names
      // the capability key an operator can grep for.
      for (const notice of agentNotices) {
        if (this.announcedAgentNoticeDigests.has(notice.definitionDigest)) continue;
        this.announcedAgentNoticeDigests.add(notice.definitionDigest);
        this.debug(`[ClaudeAgent] runtime degradation announced for ${notice.agentKey}: ${notice.message}`);
        yield { type: 'info', message: notice.message, level: 'warning' };
      }

      // P3.267 — the same banner, for the facts that were reaching only
      // `this.debug`. Collected above rather than yielded at the call sites
      // because two of the three producers run before the options literal is
      // built and a `yield` there would interleave with the SDK spawn. The
      // sink is already de-duplicated and bounded
      // (`noteSwitchVisibleDegradation`), so this loop needs no second guard.
      for (const message of degradationNotices) {
        yield { type: 'info', message, level: 'warning' };
      }
      // P3.267 + P3.310 — and anything raised between turns, or before the
      // first slot existed, which the async `stderr` callback could not push
      // onto a surface at the time.
      if (this.pendingDegradationNotices.length > 0) {
        const deferred = this.pendingDegradationNotices.splice(0, this.pendingDegradationNotices.length);
        for (const message of deferred) {
          yield { type: 'info', message, level: 'warning' };
        }
      }

      // Capture the binary path the SDK will actually use (Electron-bundled custom
      // path, CLI/dev-runtime path from getDefaultOptions, or undefined for SDK
      // auto-discovery via node_modules). Used by the ENOENT classifier to tell
      // "binary missing" apart from "cwd missing" — both surface as ENOENT from spawn().
      const resolvedBinaryPath = options.pathToClaudeCodeExecutable;

      // Track whether we're trying to resume a session (for error handling)
      // Also covers branch fork attempts where sessionId is null but branchFromSdkSessionId is set
      const wasResuming = !_isRetry && (!!this.sessionId || !!this.branchFromSdkSessionId);
      // Track whether this turn attempted branch-point cutoff via resumeSessionAt.
      // Needed for targeted fallback when the parent message UUID no longer exists server-side.
      const attemptedBranchCutoff = !_isRetry && !!this.branchFromSdkSessionId && !!this.branchFromSdkTurnId;

      // Log resume attempt for debugging session failures
      if (wasResuming) {
        debug(`[ClaudeAgent] Attempting to resume SDK session: ${this.sessionId}`);
        if (this.branchFromSdkSessionId) {
          debug(`[ClaudeAgent] Branch fork: parentSdkSessionId=${this.branchFromSdkSessionId}, branchFromSdkCwd=${this.branchFromSdkCwd}, resumeSessionAt=${this.branchFromSdkTurnId}, childSdkCwd=${this.config.session?.sdkCwd}`);
        }
      } else {
        debug(`[ClaudeAgent] Starting fresh SDK session (no resume)`);
      }

      // Known SDK slash commands that bypass context wrapping.
      // These are sent directly to the SDK without date/session/source context.
      // Deliberately ONLY 'compact' — do NOT add 'clear' here. The SDK's own
      // note admits the compaction pattern "in a session with prior turns, for
      // example in streaming input mode or when resuming a session"
      // (slash-commands.md:214) — which now describes us twice over — while
      // `/clear` is executed at the `BaseAgent.chat` seam via `clearHistory()`
      // (which nulls `sessionId`, drops the resume anchor and therefore respawns
      // the live session) and never reaches chatImpl.
      const SDK_SLASH_COMMANDS = ['compact'] as const;

      // Detect SDK slash commands - must be sent directly without context wrapping.
      // Pattern: /command or /command <instructions>
      const trimmedMessage = userMessage.trim();
      const commandMatch = trimmedMessage.match(/^\/([a-z]+)(\s|$)/i);
      const commandName = commandMatch?.[1]?.toLowerCase();
      const isSlashCommand = commandName &&
        SDK_SLASH_COMMANDS.includes(commandName as typeof SDK_SLASH_COMMANDS[number]) &&
        !attachments?.length;

      // UB12.21 — the switch-time delivery Claude Code documents
      // (prompt-caching.md#changing-output-style: "Claude Code delivers the new
      // style's instructions as a message in the conversation"). A turn that
      // continues a recorded prompt (`wasResuming`) under a style other than the
      // one the model holds carries that style's block once, on its tail. A
      // fresh SDK session renders the prompt from this turn's append, and so does
      // `/compact` (its child runs this turn's options), so neither owes one.
      // Mini agents carry no style. The rules and the residue are in
      // `core/output-style-switch.ts`.
      const outputStyleSwitch = planOutputStyleSwitch({
        delivered: this.deliveredOutputStylePrompt,
        current: miniConfig.enabled ? undefined : turnOutputStyle,
        continuesRecordedPrompt: !miniConfig.enabled && wasResuming && !isSlashCommand,
      });
      this.pendingOutputStyleSwitch = outputStyleSwitch.notice === null ? null : outputStyleSwitch;
      if (outputStyleSwitch.notice === null) this.deliveredOutputStylePrompt = outputStyleSwitch.delivered;

      // For SDK-fork branches: prepend a one-time context hint so the model treats
      // the parent conversation history (already in the SDK's messages via --fork-session)
      // as part of this conversation. Without this, the model sees new session metadata
      // and treats prior messages as "not this session."
      // branchFromSdkSessionId is non-null only on the first message (cleared after fork/recovery).
      //
      // C3.300 — the same approvals sentence `BaseAgent.buildBranchSeedContext`
      // carries, said HERE as well because the two branch preambles are
      // alternatives, not layers: `SessionManager` pins every NEW branch to
      // `branchContextStrategy: 'sdk-fork'` ("New branches always use strict
      // provider-level SDK fork semantics"), which is this block, and leaves
      // `seeded-fresh-session` — the only strategy that produces branch seed
      // messages — to legacy sessions. A sentence written only in the seed
      // builder would therefore reach no branch a user makes today. The grant
      // stores are host-side and keyed by the host session id, so the loss is
      // the same on both paths.
      let effectiveUserMessage = userMessage;
      if (!_isRetry && this.branchFromSdkSessionId) {
        const branchHint = `<branch_context>
This is a branched conversation. All prior messages in this conversation are part of your shared context with the user. When the user refers to "this conversation" or asks what you discussed, include the full conversation history — not just messages after the branch point.
Approvals the user granted for the parent session alone did not travel into this branch, so a command or path that was approved earlier in this conversation may be asked about again here.
</branch_context>`;
        effectiveUserMessage = `${branchHint}\n\n${userMessage}`;
        debug('[chat] Injected SDK-fork branch context hint into first message');
      }

      // L2 — ONE `query()` per agent, reused across turns.
      //
      // `ensureLiveSession` starts a child only when there is not already one
      // this turn's options can run on — see `claudeLiveSessionSignature` for
      // what is compared and why the resume anchor is compared separately.
      //
      // L4 — it is AWAITED now, and the await is load-bearing rather than
      // incidental: `model`, `permissionMode` and the MCP set are settled on the
      // running child through control requests, and the turn's message must not
      // be written until the CLI has acknowledged them. A drift it cannot settle
      // still respawns, so the floor is the pre-L4 behaviour.
      // A Stop can land HERE, and before this flag it was swallowed. The window
      // is real and new: `ensureLiveSession` now awaits control requests, and
      // `isProcessing()` is slot-based, so a Stop arriving between the two
      // returns at `interruptLiveTurn`'s "no slot open" guard having cancelled
      // the UI and nothing else — and then the turn runs anyway. "Stop did
      // nothing, and then it answered" is the same removed-guarantee class as
      // L2's own blocking finding, so it is caught rather than raced: the flag
      // is set before the await and honoured after it.
      this.turnPreparing = true;
      let liveInput: ClaudeInputChannel;
      const liveRestartNotices: AgentEvent[] = [];
      try {
        // F1.540 — AND THE SLOT OPENS ONLY WHILE THE CHILD IS IDLE. `SessionManager.sendMessage` reads F1.509's
        // own-turn marker once, before this whole preparation, and the child's own `init` can arrive anywhere in it;
        // a slot opened then writes mid-turn (F1.528's rig: the CLI FOLDS the write into its own turn, or answers its
        // own turn into this slot and this message in a turn no slot watches). So the marker is read again here, in
        // the same synchronous stretch that opens the slot, and a running own turn is waited out — the host already
        // shows this turn as running, and the own turn's words reach it through the between-turns door meanwhile.
        // Then the session is ensured AGAIN: the child may have died under that turn (a next turn respawns it), and
        // a Stop or a host teardown during the wait is honoured rather than written over
        // ({@link waitOutRuntimeOwnTurn}). F1.524 (1): the marker opens at the task's `task_notification`, tens of ms
        // before that turn's `init`. RESIDUE, stated: a notification still in transit when this check runs is not seen.
        for (;;) {
          const started = await this.ensureLiveSession(options);
          liveInput = started.input;
          liveRestartNotices.push(...started.notices);
          const ownTurn = this.stopRequestedWhilePreparing ? null : this.runtimeOwnTurnSettled();
          if (!ownTurn) break;
          await this.waitOutRuntimeOwnTurn(ownTurn);
          if (this.stopRequestedWhilePreparing) break;
        }
      } finally {
        this.turnPreparing = false;
      }
      // L5 — before the Stop check, deliberately. A notice here reports work
      // that was ALREADY lost with the previous child; whether this turn goes on
      // to start is a separate question, and a Stop landing in the preparation
      // window must not be the reason the user never hears about it.
      for (const notice of liveRestartNotices) yield notice;
      if (this.stopRequestedWhilePreparing) {
        this.stopRequestedWhilePreparing = false;
        // Nothing was written, so there is no turn to interrupt and nothing for
        // the reader to settle — the honest outcome is that this turn never
        // started. `AbortError` is what every recovery arm already classifies.
        this.debug('Stop landed while the session was being prepared — the turn is not started');
        throw new AbortError('Claude Code process aborted by user');
      }

      // Initialize event adapter for this turn
      // Session directory prevents race condition when concurrent sessions clobber toolMetadataStore.
      const metadataSessionDir = getSessionDirPath(this.config.workspace.id, sessionId);
      this.lastTurnSessionDir = metadataSessionDir; // F1.511 — the between-turns guard writes where this turn did
      this.eventAdapter.updateSessionDir(metadataSessionDir);
      // THE RESET BOUNDARY IS THE SLOT OPENING — our own act — and it stays
      // here. `system/init` arrives once per TURN rather than once per process
      // (measured over six live turns in L0), so moving any reset onto it, or
      // moving `startTurn()` into the reader, would reset mid-turn.
      this.eventAdapter.startTurn();

      // Open the slot BEFORE the message is written: the reader may deliver the
      // first event before `write` returns, and an event with no slot open is
      // dropped.
      slot = new ClaudeTurnSlot({
        userMessage,
        isRetry: _isRetry,
        wasResuming,
        attemptedBranchCutoff,
        metadataSessionDir,
      });
      this.openSlot = slot;

      // Write this turn's message into the live channel — handle slash commands,
      // binary attachments, or regular messages. A string prompt is exactly this
      // shape inside the SDK (`{type:'user', session_id:'', message:{role:'user',
      // content:[{type:'text',…}]}, parent_tool_use_id:null}`), so nothing about
      // what reaches the CLI changed; only who ends the channel afterwards did.
      //
      // Every message is UUID-STAMPED. `SDKUserMessage.uuid` is optional and was
      // never set before, and the interrupt receipt (`still_queued`) can only
      // ever name messages that carry one — so without the stamp the receipt is
      // not evidence about our own traffic.
      //
      // `wrapUserText` and NOT `buildSDKUserMessage` on the two text paths:
      // `buildSDKUserMessage` composes the per-turn context blocks itself, and
      // `buildTextPrompt` has already composed them. Routing the text path
      // through it would send the context twice AND consume the one-shot
      // mode-change signal twice — `buildVolatileContextParts` must run exactly
      // once per turn (packages/shared/AGENTS.md). The slash-command path sends
      // no context at all, exactly as the bare `query({prompt:'/compact'})` did.
      if (isSlashCommand) {
        // Send slash commands directly to SDK without context wrapping.
        // The SDK processes these as internal commands (e.g., /compact triggers compaction).
        debug(`[chat] Detected SDK slash command: ${trimmedMessage}`);
        liveInput.write(this.wrapUserText(trimmedMessage));
      } else if (hasBinaryAttachments) {
        liveInput.write(this.stampTurnMessageUuid(this.buildSDKUserMessage(effectiveUserMessage, attachments)));
      } else {
        // Simple text message (may include text file contents)
        liveInput.write(this.wrapUserText(this.buildTextPrompt(effectiveUserMessage, attachments)));
      }

      try {
        // THE TURN'S OWN LOOP READS THE SLOT, NOT THE SDK STREAM.
        //
        // The reader owns the stream for the whole SESSION and feeds whichever
        // slot is open. `SessionManager.sendMessage` still returns at the first
        // `complete` and its `finally` still calls `chatIterator.return?.()` —
        // and that stops mattering, because `.return()` now abandons a QUEUE
        // instead of unwinding the SDK stream. The reader, the query and the
        // child process are untouched. That is the whole reason the frozen
        // `AgentInstance.chat()` contract needs no change and Pi, Codex and
        // Nestor are not touched by this rewrite.
        for await (const event of slot.drain()) {
          if (event.type === 'complete') {
            // R16 — EVERYTHING BELOW MUST HAPPEN BEFORE THIS EVENT LEAVES.
            // `SessionManager.sendMessage` processes `complete` and then
            // RETURNS out of the whole function ("Exit function, skip finally
            // block"), and its `finally` calls `chatIterator.return?.()`, which
            // unwinds this generator at whatever yield it is suspended on. So
            // code placed after this loop still never runs on a normal turn —
            // measured live 2026-08-17 by CRU-2, which read the app's own event
            // log and found the stream ending at `complete` with the trailing
            // events simply absent. The live session did not change that; it
            // only changed what the hang-up costs.

            // R9's half. The model's deferred `/compact` runs HERE, so the
            // request it was promised is actually kept. The drain filters its
            // nested turn's own `complete` out, which matters more than ever:
            // a nested one arriving first would end the session's interest in
            // this stream and drop the outer turn's completion instead.
            //
            // It nests a whole `chat()` — and it is safe HERE and would not be
            // in the reader, because this is the CONSUMER's loop. A turn started
            // from inside the reader's own drain loop would deadlock: the reader
            // would be waiting on a turn whose events only the reader can
            // deliver.
            const drainedContextTokens = yield* this.drainPendingModelCompaction();

            // R14's half. A separate `usage_update` cannot work here — this
            // very event ASSIGNS the badge, so anything sent before it is
            // overwritten by it.
            //
            // It rides `contextTokens`, NOT `inputTokens`, and the difference
            // is the whole correctness of this: `inputTokens` is what
            // `recordUsageMetrics` exports as the turn's real input
            // consumption, and on a compaction turn that consumption IS the
            // whole pre-compaction conversation — the model was sent all of
            // it to summarize. Overwriting it would have understated real
            // spend by everything the compaction dropped, which a test caught
            // after an earlier draft of this comment claimed the opposite.
            // `contextTokens` answers the other question — how much context
            // the session is left holding — and after a compaction that is
            // `post_tokens`.
            //
            // Either path may have compacted, never both: a user-typed
            // `/compact` sets the slot's field from THIS turn's own boundary,
            // and a model-requested one comes back from the nested turn above.
            const settledContextTokens = slot.postCompactionContextTokens ?? drainedContextTokens;
            if (settledContextTokens !== null && event.usage) {
              event.usage.contextTokens = settledContextTokens;
            }
          }
          yield event;
        }

        // The slot closed. Everything below is the post-turn decision the old
        // shape made after the SDK stream ended — the stream no longer ends, so
        // the slot's own settlement is the boundary.

        // Source-activation restart (#790): the renderer's auto-retry contract
        // wants `source_activated` to be the LAST event of the turn, with no
        // `complete` after it. The reader already pushed it and already
        // respawned the session, so there is nothing left to do but return —
        // exactly what the `return` inside the old read loop did.
        if (slot.stopReason === 'source-activated') {
          return;
        }

        // Turn-end fallback (#790): the turn settled without any batch boundary
        // firing — defensive against the terminal result arriving in the same
        // adapted batch the capture happened in. `return` is critical here —
        // without it we fall through to flushPending + the defensive
        // `complete` emission below, which would corrupt the auto-restart
        // contract (renderer expects `source_activated` to be the final event).
        const sourceActivationFireAtEnd = slot.sourceActivationDrain.shouldFireAtBoundary();
        if (sourceActivationFireAtEnd) {
          this.onDebug?.(`source_test activated "${sourceActivationFireAtEnd.sourceSlug}", turn ended mid-batch, restarting turn`);
          yield sourceActivationFireAtEnd;
          this.endTurnForSourceActivation(AbortReason.SourceActivated);
          return;
        }

        // Missing-UUID fallback: branch cutoff failed because resumeSessionAt target
        // no longer exists server-side. Retry once by resuming the child session
        // that was already established (without re-applying resumeSessionAt).
        if (slot.suppressedBranchCutoffError && !_isRetry && this.sessionId) {
          debug('[SESSION_DEBUG] >>> DETECTED MISSING-UUID BRANCH CUTOFF ERROR - retrying on child session without cutoff');
          // R9 — this arm nests a recovery `chat()` and returns, so the parked
          // request must die here: the `finally` runs only AFTER the nested
          // turn, which would otherwise consume it at the retry's boundary.
          this.pendingModelCompaction = null;
          yield { type: 'info', message: 'Branch point was compacted on server, retrying with nearest available context...' };
          yield* this.chat(userMessage, attachments);
          return;
        }

        // Detect empty response when resuming - SDK silently fails resume if session is invalid
        // In this case, we got a new session ID but no assistant content
        debug('[SESSION_DEBUG] Post-loop check: wasResuming=', wasResuming, 'receivedAssistantContent=', slot.receivedAssistantContent, '_isRetry=', _isRetry);
        // UB2.2 (COR-2), ported from craft-agents-oss v0.15.1's keep-alive Stop hunks
        // (Apache-2.0): a turn the user stopped — or the budget stopped — never reaches the
        // empty-response recovery. The stopped turn's result may never arrive (a wedged child
        // killed at the interrupt deadline, or a clean session end under the open slot), and
        // `lastAbortReason` is then still the stop's: recovery here would CLEAR the session id
        // and RE-SEND the very message the user stopped.
        const stopEndedTurn = this.lastAbortReason === AbortReason.UserStop || this.lastAbortReason === AbortReason.MaxBudgetUsd;
        if (wasResuming && !slot.receivedAssistantContent && !_isRetry && !stopEndedTurn) {
          debug('[SESSION_DEBUG] >>> DETECTED EMPTY RESPONSE - triggering recovery');
          // R9 — same rule as the branch-cutoff arm above: both sub-branches
          // nest a recovery turn and return before the drain point.
          this.pendingModelCompaction = null;
          const wasBranchFork = !!this.branchFromSdkSessionId;
          if (wasBranchFork) {
            // Branch-fork failure: route through the shared helper so all four
            // fork fields are persisted atomically (sdkSessionId + branchFromSdk*),
            // and the parent conversation summary is injected into the retry.
            yield* this.recoverFromStaleBranchFork(userMessage, attachments, /* isPreSpawn */ false);
            return;
          }
          // Regular resume failure (no branch fork): clear the session and retry
          // with raw recovery context. onSdkSessionIdCleared persists the
          // cleared sdkSessionId; there are no branch fields to clear here.
          this.sessionId = null;
          this.config.onSdkSessionIdCleared?.();
          this.pinnedPreferencesPrompt = null;
          this.pinnedIncludeCoAuthoredBy = null;
          this.preferencesDriftNotified = false;

          let retryMessage = userMessage;
          const recoveryContext = this.buildRecoveryContext();
          if (recoveryContext) retryMessage = recoveryContext + userMessage;

          yield { type: 'info', message: 'Restoring conversation context...' };
          yield* this.chat(retryMessage, attachments, { isRetry: true });
          return;
        }

        // Defensive: flush any pending text that wasn't emitted
        // This can happen if the SDK sends an assistant message with text but skips the
        // message_delta event that normally triggers text_complete (rare edge scenarios)
        const flushedEvent = this.eventAdapter.flushPending();
        if (flushedEvent) {
          yield flushedEvent;
        }

        // R16 — THIS REGION IS ONLY REACHED WHEN THE TURN PRODUCED NO RESULT.
        // R9's drain and R14's correction used to sit here and were dead: the
        // session returns on `complete` and unwinds this generator, so a normal
        // turn never got here at all. Both now run at the `complete` yield
        // itself, above. Nothing that must happen on a normal turn may be
        // placed below this line.
        //
        // The one case that still lands here is `!slot.receivedComplete` — a
        // turn whose slot settled without a result, which under a live session
        // means the SESSION ended under it — and the defensive `complete` just
        // below is what the session then sees. A model compaction parked by such
        // a turn is deliberately discarded rather than drained: the turn did not
        // finish, and a compaction earned by a turn that failed must not land on
        // an unrelated later one.

        // Defensive: emit complete if the turn produced no result message
        if (!slot.receivedComplete) {
          yield { type: 'complete' };
        }
      } catch (sdkError) {
        // R9 — this turn did not drain, so the model's parked `/compact` dies
        // with it. Cleared HERE and not left to the `finally` because several
        // arms below nest a recovery `chat()` INSIDE this catch: the `finally`
        // runs after that nested turn, so a request left standing would be
        // consumed at the retry's boundary instead of being discarded. A retry
        // is a fresh attempt; if the model still wants a compaction it will ask
        // again. Abort/interrupt lands here too (AbortError).
        this.pendingModelCompaction = null;
        // Debug: log inner catch trigger (stderr to avoid SDK JSON pollution)
        console.error(`[ClaudeAgent] INNER CATCH triggered: ${sdkError instanceof Error ? sdkError.message : String(sdkError)}`);

        // Handle user interruption
        if (sdkError instanceof AbortError) {
          // UB2.2 (COR-2), ported from craft-agents-oss v0.15.1: flush FIRST, so a text block
          // that finished but was waiting for its message_delta is not missing after a reload.
          // The only other flush sits in the no-result region below, which an exception never
          // reaches.
          const flushedOnAbort = this.eventAdapter.flushPending();
          if (flushedOnAbort) yield flushedOnAbort;
          const reason = this.lastAbortReason;
          this.lastAbortReason = null;  // Clear for next time

          // If interrupted before receiving any assistant content AND this was the first message,
          // clear session ID to prevent broken resume state where SDK session file is empty/invalid.
          // For later messages (messageCount > 0), keep the session ID to preserve conversation history.
          // The SDK session file should have valid previous turns we can resume from.
          if (!(slot?.receivedAssistantContent ?? false) && this.sessionId) {
            // Check if there are previous messages (completed turns) in this session
            // If yes, keep the session ID to preserve history on resume
            const hasCompletedTurns = this.config.getRecoveryMessages && this.config.getRecoveryMessages().length > 0;

            if (!hasCompletedTurns) {
              // First message was interrupted before any response - SDK session is empty/corrupt
              debug('[SESSION_DEBUG] First message interrupted before assistant content - clearing sdkSessionId:', this.sessionId);
              this.sessionId = null;
              this.config.onSdkSessionIdCleared?.();
            } else {
              // Later message interrupted - SDK session has valid history, keep it for resume
              debug('[SESSION_DEBUG] Later message interrupted - keeping sdkSessionId for history preservation:', this.sessionId);
            }
          }

          // Only emit "Interrupted" status for user-initiated stops
          // Plan submissions and redirects should be silent
          if (reason === AbortReason.UserStop) {
            yield { type: 'status', message: 'Interrupted' };
          }
          yield { type: 'complete' };
          return;
        }

        // Get error message regardless of error type
        // Note: SDK text errors like "API Error: 402..." are primarily handled in useAgent.ts
        // via text_complete event. This is a fallback for errors that don't emit text first.
        // parseError() will detect status codes (402, 401, etc.) in the raw message.
        const rawErrorMsg = sdkError instanceof Error ? sdkError.message : String(sdkError);
        const errorMsg = rawErrorMsg.toLowerCase();

        // Debug logging - always log the actual error and context
        this.onDebug?.(`Error in chat: ${rawErrorMsg}`);
        this.onDebug?.(`Context: wasResuming=${wasResuming}, isRetry=${_isRetry}`);

        // Check for auth errors - these won't be fixed by clearing session
        const isAuthError =
          errorMsg.includes('unauthorized') ||
          errorMsg.includes('401') ||
          errorMsg.includes('authentication failed') ||
          errorMsg.includes('invalid api key') ||
          errorMsg.includes('invalid x-api-key');

        if (isAuthError) {
          // Auth errors surface immediately - session manager handles retry by recreating agent
          const typedError = parseError(new Error(rawErrorMsg));
          yield { type: 'typed_error', error: typedError };
          yield { type: 'complete' };
          return;
        }

        // Rate limit errors - don't retry immediately, surface to user
        const isRateLimitError =
          errorMsg.includes('429') ||
          errorMsg.includes('rate limit') ||
          errorMsg.includes('too many requests');

        if (isRateLimitError) {
          // Parse to typed error using the captured/processed error message
          const typedError = parseError(new Error(rawErrorMsg));
          yield { type: 'typed_error', error: typedError };
          yield { type: 'complete' };
          return;
        }

        // Check for billing/payment errors (402) - don't retry these
        const isBillingError =
          errorMsg.includes('402') ||
          errorMsg.includes('payment required') ||
          errorMsg.includes('billing');

        if (isBillingError) {
          // Parse to typed error using the captured/processed error message, not the original SDK error
          // This ensures parseError sees "402 Payment required" instead of "process exited with code 1"
          const typedError = parseError(new Error(rawErrorMsg));
          yield { type: 'typed_error', error: typedError };
          yield { type: 'complete' };
          return;
        }

        // Check for .claude.json corruption — the SDK subprocess crashes if this file
        // is empty, BOM-encoded, or contains invalid JSON. Two error patterns:
        //   1. "CLI output was not valid JSON" — CLI wrote plain-text error to stdout
        //   2. "process exited with code 1" with stderr mentioning config corruption
        // See: claude-code#14442 (BOM), #2593 (empty file), #18998 (race condition)
        const stderrForConfigCheck = this.lastStderrOutput.join('\n').toLowerCase();
        const isConfigCorruption =
          (errorMsg.includes('not valid json') && (errorMsg.includes('claude') || errorMsg.includes('configuration'))) ||
          (errorMsg.includes('process exited with code') && (
            stderrForConfigCheck.includes('claude.json') ||
            stderrForConfigCheck.includes('configuration file') ||
            stderrForConfigCheck.includes('corrupted')
          ));

        if (isConfigCorruption && !_isRetry) {
          debug('[ClaudeAgent] Detected .claude.json corruption, repairing and retrying...');
          // Reset the once-per-process guard so ensureClaudeConfig() runs again
          // on the retry — it will repair the file before the next subprocess spawn
          resetClaudeConfigCheck();
          yield { type: 'info', message: 'Repairing configuration file...' };
          yield* this.chat(userMessage, attachments, { isRetry: true });
          return;
        }

        // Check for SDK process errors - these often wrap underlying billing/auth issues
        // The SDK's internal Claude Code process exits with code 1 for various API errors
        const isProcessError = errorMsg.includes('process exited with code');

        // Include captured stderr in diagnostics (used by multiple checks below)
        const stderrContext = this.lastStderrOutput.length > 0
          ? this.lastStderrOutput.join('\n')
          : undefined;

        // [SESSION_DEBUG] Comprehensive logging for session recovery investigation
        debug('[SESSION_DEBUG] === ERROR HANDLER ENTRY ===');
        debug('[SESSION_DEBUG] errorMsg:', errorMsg);
        debug('[SESSION_DEBUG] rawErrorMsg:', rawErrorMsg);
        debug('[SESSION_DEBUG] isProcessError:', isProcessError);
        debug('[SESSION_DEBUG] wasResuming:', wasResuming);
        debug('[SESSION_DEBUG] _isRetry:', _isRetry);
        debug('[SESSION_DEBUG] this.sessionId:', this.sessionId);
        debug('[SESSION_DEBUG] lastStderrOutput length:', this.lastStderrOutput.length);
        debug('[SESSION_DEBUG] lastStderrOutput:', this.lastStderrOutput.join('\n'));

        // Check for expired session error - SDK session no longer exists server-side.
        // This happens when sessions expire (TTL) or are cleaned up by Anthropic.
        // Check error message, raw error, AND stderr — the SDK may propagate the error
        // through different paths depending on version/timing.
        const SESSION_EXPIRED_MARKER = 'No conversation found with session ID';
        const isSessionExpired =
          (slot?.suppressedSessionExpiredError ?? false) ||  // stream-level suppression already detected this
          errorMsg.includes(SESSION_EXPIRED_MARKER) ||
          (rawErrorMsg || '').includes(SESSION_EXPIRED_MARKER) ||
          (stderrContext || '').includes(SESSION_EXPIRED_MARKER);
        debug('[SESSION_DEBUG] isSessionExpired:', isSessionExpired, 'suppressedSessionExpiredError:', slot?.suppressedSessionExpiredError ?? false);

        // Missing-UUID fallback may surface as a generic process-exit error in catch,
        // even after we suppressed the underlying stream error event above.
        // If branch cutoff failed but child session is established, retry once without cutoff.
        if ((slot?.suppressedBranchCutoffError ?? false) && wasResuming && !_isRetry && this.sessionId) {
          debug('[SESSION_DEBUG] >>> TAKING PATH: missing-UUID branch-cutoff fallback from catch');
          yield { type: 'info', message: 'Branch point was compacted on server, retrying with nearest available context...' };
          yield* this.chat(userMessage, attachments);
          return;
        }

        if (isSessionExpired && wasResuming && !_isRetry) {
          debug('[SESSION_DEBUG] >>> TAKING PATH: Session expired recovery');
          const wasBranchFork = !!this.branchFromSdkSessionId;
          console.error('[ClaudeAgent] SDK session expired server-side, clearing and retrying fresh');
          debug('[ClaudeAgent] SDK session expired server-side, clearing and retrying fresh');

          if (wasBranchFork) {
            // Branch-fork failure: route through the shared helper so the
            // four fork fields are persisted atomically (avoids next launch
            // reloading the dead parent and re-failing).
            yield* this.recoverFromStaleBranchFork(userMessage, attachments, /* isPreSpawn */ false);
            return;
          }

          // Regular resume failure: clear sessionId and retry with raw recovery context.
          this.sessionId = null;
          this.config.onSdkSessionIdCleared?.();
          this.pinnedPreferencesPrompt = null;
          this.pinnedIncludeCoAuthoredBy = null;
          this.preferencesDriftNotified = false;

          let retryMessage = userMessage;
          const recoveryContext = this.buildRecoveryContext();
          if (recoveryContext) retryMessage = recoveryContext + userMessage;

          yield { type: 'info', message: 'Session expired, restoring context...' };
          yield* this.chat(retryMessage, attachments, { isRetry: true });
          return;
        }

        // ─────────────────────────────────────────────────────────────────
        // ENOENT handling — runs BEFORE the `if (isProcessError)` gate
        // because the SDK throws spawn ENOENT as a `ReferenceError` with
        // message "Claude Code native binary not found at …", which does
        // not contain "process exited with code". Pre-uplift, the
        // detection lived inside `isProcessError` and never fired for the
        // case we actually care about.
        // ─────────────────────────────────────────────────────────────────
        const spawnError = sdkError as NodeJS.ErrnoException;
        const isSpawnEnoent = detectSpawnEnoent({
          errorCode: spawnError.code,
          errorSyscall: spawnError.syscall,
          rawErrorMsg,
          stderr: stderrContext,
        });

        if (isSpawnEnoent) {
          const reportedBinaryPath = extractSdkReportedBinaryPath(rawErrorMsg || '');
          const { getPathToClaudeCodeExecutable } = await import('./options.ts');
          const probedBinary = reportedBinaryPath || resolvedBinaryPath || getPathToClaudeCodeExecutable();
          const probedCwd = resolvedCwd || undefined;
          const binaryExists = probedBinary ? existsSync(probedBinary) : false;
          const cwdExists = probedCwd ? isExistingDirectory(probedCwd) : false;

          debug('[ClaudeAgent] ENOENT detected', {
            probedBinary, probedCwd, binaryExists, cwdExists,
            reportedBinaryPath,
            errorCode: spawnError.code, errorSyscall: spawnError.syscall,
          });

          // Stale cwd plus a branch parent → route to recovery (covers the
          // rare race where the pre-spawn guard didn't catch a cwd that
          // vanished between check and spawn).
          if (!cwdExists && !_isRetry && this.branchFromSdkSessionId) {
            yield* this.recoverFromStaleBranchFork(userMessage, attachments, /* isPreSpawn */ false);
            return;
          }

          // First attempt: retry once after 2s. Covers transient causes
          // (auto-update bundle-swap window, sandbox/quarantine, race)
          // regardless of which path looks missing.
          if (!_isRetry) {
            console.error('[ClaudeAgent] spawn ENOENT, retrying in 2s', {
              sessionId: this.config.session?.id,
              probedBinary, probedCwd,
              errorCode: spawnError.code, errorSyscall: spawnError.syscall,
              stderr: (stderrContext || '').slice(0, 200),
            });
            yield { type: 'info', message: 'Reconnecting after update...' };
            await new Promise(r => setTimeout(r, 2000));
            yield* this.chat(userMessage, attachments, { isRetry: true });
            return;
          }

          // Retry exhausted: surface a typed error pointed at the more-likely
          // cause. Cwd missing is more actionable when the binary is fine
          // (we can recover from a parent summary); otherwise blame the
          // binary (reinstall is the user's fix).
          const isCwdCause = !cwdExists && binaryExists;
          yield {
            type: 'typed_error',
            error: isCwdCause ? {
              code: 'sdk_cwd_missing',
              title: 'Branch source unavailable on this machine',
              message:
                "The folder this branched session was forked from doesn't exist on this machine. " +
                'This typically happens after importing a session from another workspace. ' +
                'Retrying will start a fresh fork from a summary of the parent conversation.',
              details: [
                probedCwd ? `Subprocess cwd: ${probedCwd}` : '',
                probedBinary ? `Binary: ${probedBinary} (${binaryExists ? 'exists' : 'missing'})` : '',
              ].filter(Boolean) as string[],
              actions: [{ key: 'r', label: 'Retry', action: 'retry' as const }],
              canRetry: true,
              retryDelayMs: 1000,
              originalError: rawErrorMsg,
            } : {
              code: 'sdk_binary_missing',
              title: 'Claude Code binary missing from app bundle',
              message:
                'The Claude Agent SDK binary expected on disk is not present. ' +
                'This usually means the app bundle is incomplete (interrupted download, partial update, ' +
                'or a security tool removed it). Reinstalling Nessy Desktop typically fixes this.',
              details: [
                probedBinary ? `Expected binary: ${probedBinary}` : 'Binary path: unknown',
                probedCwd ? `Subprocess cwd: ${probedCwd} (${cwdExists ? 'exists' : 'missing'})` : '',
              ].filter(Boolean) as string[],
              actions: [{ key: 'r', label: 'Retry', action: 'retry' as const }],
              canRetry: true,
              retryDelayMs: 1000,
              originalError: rawErrorMsg,
            },
          };
          yield { type: 'complete' };
          return;
        }

        if (isProcessError) {
          if (stderrContext) {
            debug('[SDK process error] Captured stderr:', stderrContext);
          }

          // Check for Windows SDK setup error (missing .claude/skills directory)
          const windowsSkillsError = buildWindowsSkillsDirError(stderrContext || rawErrorMsg);
          if (windowsSkillsError) {
            yield windowsSkillsError;
            yield { type: 'complete' };
            return;
          }

          debug('[SESSION_DEBUG] >>> TAKING PATH: Run diagnostics (not session expired)');

          // Run diagnostics to identify specific cause (2s timeout)
          // F1.1112 — authType, baseUrl and providerType from the SESSION's connection (the default only when the session names none), as D1.194's card below and F1.964's retry read it
          const { getDefaultLlmConnection, getLlmConnection } = await import('../config/storage.ts');
          const defaultConnSlug = this.config.connectionSlug ?? getDefaultLlmConnection();
          const connection = defaultConnSlug ? getLlmConnection(defaultConnSlug) : null;
          // Map connection authType to legacy AuthType format for diagnostics
          let diagnosticAuthType: AuthType | undefined;
          if (connection) {
            if (connection.authType === 'api_key' || connection.authType === 'api_key_with_endpoint' || connection.authType === 'bearer_token') {
              diagnosticAuthType = 'api_key';
            } else if (connection.authType === 'oauth') {
              diagnosticAuthType = 'oauth_token';
            }
          }
          const diagnostics = await runErrorDiagnostics({
            authType: diagnosticAuthType,
            workspaceId: this.config.workspace?.id,
            rawError: stderrContext || rawErrorMsg,
            providerType: this.config.providerType || connection?.providerType,
            baseUrl: connection?.baseUrl,
          });

          // D1.193 — before the user is told to re-enter a credential this host
          // can renew itself. ONE attempt, gated on `!_isRetry`, and only when
          // the diagnosis is credential-shaped. The two codes are read from
          // `runErrorDiagnostics`'s OWN union rather than guessed: it declares
          // `invalid_credentials`, `token_expired`, `rate_limited`,
          // `service_unavailable`, `mcp_unreachable`, `billing_error` and
          // `unknown_error`, and `expired_oauth_token` — the spelling the
          // `ErrorCode` wire union carries — is NOT one of them, which `tsc`
          // said out loud when this arm was first written with three.
          // `refreshClaudeOAuthTokenForLiveSession` answers `false` when nothing
          // moved, so a genuinely dead credential falls straight through to the
          // typed error below and cannot loop. F1.964 — the SESSION's connection (the one `postInit` resolved this child's credential from), never the default (the diagnosis above read the default until F1.1112 made it read the session's too): that handed a non-default OAuth session the default's token, and an API-key session the default's subscription token. No slug, no credential of ours to renew.
          if (
            !_isRetry
            && (diagnostics.code === 'invalid_credentials' || diagnostics.code === 'token_expired')
            && await this.refreshClaudeOAuthTokenForLiveSession(this.config.connectionSlug ? getLlmConnection(this.config.connectionSlug) : null, this.config.connectionSlug)
          ) {
            // Said out loud: a silent retry that then succeeds teaches the user
            // their session randomly failed, and one that fails again reads as
            // two unrelated errors.
            yield { type: 'info', message: 'Your Claude sign-in was renewed. Retrying...' };
            yield* this.chat(userMessage, attachments, { isRetry: true });
            return;
          }

          debug('[SESSION_DEBUG] diagnostics.code:', diagnostics.code);
          debug('[SESSION_DEBUG] diagnostics.title:', diagnostics.title);
          debug('[SESSION_DEBUG] diagnostics.message:', diagnostics.message);

          // D1.194 — AN EXPIRED SUBSCRIPTION CREDENTIAL IS ITS OWN TYPED CODE,
          // AND THE CODE ALREADY EXISTED.
          //
          // The row asks for "a typed error whose action is Update credentials
          // → `/settings`" to become the shape the corporate credential gets:
          // the reason, and ONE sign-in button. Read before invented — the
          // nearest documented solution is inside this tree. `ErrorCode`
          // (`packages/core/src/types/message.ts`) already carries
          // `expired_oauth_token`, and `errors.ts`'s `ERROR_DEFINITIONS` entry
          // for it already declares exactly that pair of actions, `reauth`
          // first: *"Your session has expired. Please try signing in again."*
          // What was missing is a PRODUCER — `runErrorDiagnostics` declares
          // seven codes and that is not one of them, which the D1.193 comment
          // above records `tsc` saying out loud — so every expired Claude
          // subscription arrived as the generic `invalid_credentials`, whose one
          // action navigates to a settings page and asks the user to find the
          // connection themselves.
          //
          // THE PREDICATE IS THE ONE ALREADY COMPUTED HERE. `diagnosticAuthType` is `'oauth_token'`
          // exactly when the failing connection — the session's since F1.1112, the default only
          // when the session names none — is OAuth-backed — the subscription cards — and `'api_key'`
          // for a BYO key, whose honest remedy really is "update the key in settings". No new
          // state, no new probe, no second reading of the connection.
          //
          // THE REASON SURVIVES: `title`, `message` and `details` stay the
          // diagnosed ones rather than being replaced by the definition's
          // generic sentence, because the diagnosis is what makes the card
          // actionable (a 401 and a 403 are different things to do about).
          // Only the CODE and the ACTIONS change.
          //
          // The renderer half is NOT here and is deliberately not faked:
          // `handleErrorMessageAction`
          // (`apps/electron/src/renderer/components/app-shell/error-message-actions.ts`)
          // handles `open_url`, `settings` and `retry`, and falls through on
          // `reauth`. Until that arm exists the button is inert rather than
          // wrong — the card still carries the settings action beside it — and
          // the code is what a renderer needs in order to tell the two cases
          // apart at all. Handed to the renderer lane with D1.194's card.
          const expiredSubscription = claudeExpiredSubscriptionPresentation({
            diagnosticCode: diagnostics.code,
            diagnosticAuthType,
          });

          // Get recovery actions based on diagnostic code
          const actions = expiredSubscription
            ? expiredSubscription.actions
            : diagnostics.code === 'token_expired' || diagnostics.code === 'mcp_unreachable'
            ? [
                // D1.283 — `/workspace` is a command this product does not have;
                // the action names the destination it does, as `errors.ts` now does.
                { key: 'w', label: 'Re-authenticate the workspace', command: '/settings', action: 'settings' as const },
                { key: 'r', label: 'Retry', action: 'retry' as const },
              ]
            : diagnostics.code === 'invalid_credentials' || diagnostics.code === 'billing_error'
            ? [
                { key: 's', label: 'Update credentials', command: '/settings', action: 'settings' as const },
              ]
            : [
                { key: 'r', label: 'Retry', action: 'retry' as const },
                { key: 's', label: 'Check settings', command: '/settings', action: 'settings' as const },
              ];

          yield {
            type: 'typed_error',
            error: {
              code: expiredSubscription ? expiredSubscription.code : diagnostics.code,
              title: diagnostics.title,
              message: diagnostics.message,
              // Include stderr in details if we captured any useful output
              details: stderrContext
                ? [...(diagnostics.details || []), `SDK stderr: ${stderrContext}`]
                : diagnostics.details,
              actions,
              canRetry: diagnostics.code !== 'billing_error' && diagnostics.code !== 'invalid_credentials',
              retryDelayMs: 1000,
              originalError: stderrContext || rawErrorMsg,
            },
          };
          yield { type: 'complete' };
          return;
        }

        // Session-related retry: only if we were resuming and haven't retried yet
        debug('[SESSION_DEBUG] isProcessError=false, checking wasResuming fallback');
        if (wasResuming && !_isRetry) {
          debug('[SESSION_DEBUG] >>> TAKING PATH: wasResuming fallback retry');
          const wasBranchFork = !!this.branchFromSdkSessionId;

          if (wasBranchFork) {
            // Generic error during a fork attempt: route through the shared
            // helper so all four fork fields are persisted atomically and
            // the parent summary is injected into the retry.
            yield* this.recoverFromStaleBranchFork(userMessage, attachments, /* isPreSpawn */ false);
            return;
          }

          // Regular resume failure (no branch fork): clear sessionId only.
          this.sessionId = null;
          this.config.onSdkSessionIdCleared?.();
          this.pinnedPreferencesPrompt = null;
          this.pinnedIncludeCoAuthoredBy = null;
          this.preferencesDriftNotified = false;

          let retryMessage = userMessage;
          const recoveryContext = this.buildRecoveryContext();
          if (recoveryContext) retryMessage = recoveryContext + userMessage;

          const statusMessage = errorMsg.includes('session') || errorMsg.includes('resume')
            ? 'Conversation sync failed, restoring context...'
            : 'Request failed, retrying with context...';

          yield { type: 'info', message: statusMessage };
          yield* this.chat(retryMessage, attachments, { isRetry: true });
          return;
        }

        debug('[SESSION_DEBUG] >>> TAKING PATH: Final fallback (show generic error)');
        // Retry also failed, or wasn't resuming - show generic error
        // (Auth, billing, and rate limit errors are handled above)
        const rawMessage = sdkError instanceof Error ? sdkError.message : String(sdkError);

        yield { type: 'error', message: rawMessage };
        yield { type: 'complete' };
        return;
      }

    } catch (error) {
      // R9 — same rule as the inner catch: a failed turn discards the model's
      // parked `/compact` rather than handing it to whatever runs next.
      this.pendingModelCompaction = null;
      // Debug: log outer catch trigger (stderr to avoid SDK JSON pollution)
      console.error(`[ClaudeAgent] OUTER CATCH triggered: ${error instanceof Error ? error.message : String(error)}`);
      console.error(`[ClaudeAgent] Error stack: ${error instanceof Error ? error.stack : 'no stack'}`);

      // UB2.2 (COR-2), upstream keep-alive Stop hunk 4 (craft-agents-oss v0.15.1, Apache-2.0):
      // an AbortError from the OUTER try — a Stop that landed while the turn was still being
      // prepared (ours: the `stopRequestedWhilePreparing` throw; upstream: the keep-alive
      // thinking update) — is an INTERRUPTION, not an error. The inner branch below gives the
      // same shape to an abort mid-turn; this gives it to an abort before the turn began.
      if (error instanceof AbortError) {
        const reason = this.lastAbortReason;
        this.lastAbortReason = null;
        if (reason === AbortReason.UserStop) {
          yield { type: 'status', message: 'Interrupted' };
        }
        yield { type: 'complete' };
        return;
      }

      const errorMessage = error instanceof Error ? error.message : String(error);

      // Check if this is a recognizable error type
      const typedError = parseError(error);
      if (typedError.code !== 'unknown_error') {
        // Known error type - show user-friendly message with recovery actions
        yield { type: 'typed_error', error: typedError };
      } else {
        // Unknown error - show raw message
        yield { type: 'error', message: errorMessage };
      }
      // emit complete even on error so application knows we're done
      yield { type: 'complete' };
    } finally {
      // L2 — `this.currentQuery = null` USED to live here, and it was correct
      // when the query was per-turn. It is per-SESSION now, so nulling it here
      // would kill the live session on the first turn and leave the shape
      // one-shot with nothing in the log to say so. The per-turn thing to
      // release is the SLOT.
      if (slot) {
        // Detach first, so nothing the reader delivers next lands on a turn that
        // has already gone. `close` is a no-op on an already-settled slot; on an
        // unsettled one (a throw before the terminal event) it stops the reader
        // feeding a queue with no drain.
        if (this.openSlot === slot) this.openSlot = null;
        slot.close('session-ended');
      }

      // R9 — discard any model-requested compaction that the drain point above
      // did not already consume. Reaching here with one still parked means the
      // turn did NOT complete cleanly (abort, SDK error, recovery retry,
      // source-activation restart), and a stale request would otherwise fire at
      // the end of whatever turn came next.
      this.pendingModelCompaction = null;

      // If a steer message was never delivered (no PreToolUse fired), notify the session
      // layer so it can re-queue the message for the next turn.
      //
      // L2 — this yield still reaches the session on the ORDINARY path, and the
      // reason is worth stating because it is not obvious: `BaseAgent.chat`
      // HOLDS BACK the reason-free `complete` and keeps pulling, so `chatImpl`
      // runs to exhaustion — this `finally` included — before the completion is
      // released to `SessionManager`. What a yield-in-a-finally cannot survive
      // is a `.return()` UNWIND, where it is discarded silently. Under the old
      // shape that unwind was also what tore down the SDK stream; now it only
      // abandons a queue, so the unwind is no longer entangled with the
      // session's life.
      //
      // F1.238 — EVERY steer still pending, in arrival order, each carrying the
      // transcript id the host gave it, so the host re-queues THAT message.
      // F1.335 — and only at THIS turn's own end (upstream `runTurn`'s `turn === this.turn`):
      // a later turn already opened has taken the leftovers, and its steers are its own.
      if (steerTurn === this.steerTurn) {
        this.pauseSteerFifo();
        yield* this.handBackPendingSteers('no tool call fired');
      }
    }
  }

  // ============================================================
  // L2 — THE LIVE SESSION: one query per agent, one reader over it
  // ============================================================

  /**
   * Wrap plain text in the exact `SDKUserMessage` a STRING prompt becomes inside
   * the SDK — `{type:'user', session_id:'', message:{role:'user',
   * content:[{type:'text', text}]}, parent_tool_use_id:null}` (verified against
   * the installed `sdk.mjs`). So the bytes the CLI receives are unchanged; only
   * who owns the channel afterwards is.
   *
   * Deliberately NOT `buildSDKUserMessage`: that one composes the per-turn
   * context blocks itself, and both text callers have already composed them
   * through `buildTextPrompt`. Routing text through it would send the context
   * twice and consume the one-shot mode-change signal twice.
   */
  /**
   * F1.96 (origin D1.410) — credit a Bash file viewer's path to the
   * read-before-write ledger, once the call has SUCCEEDED.
   *
   * The same four commands `bareFileViewerOperand` credits on Pi, from the same
   * function, so the two runtimes cannot drift to different viewer sets. What
   * moved is WHEN. This used to run inside `applyReadBeforeWriteRule`'s
   * PreToolUse hook on `existsSync(path)` alone — before the gate had decided
   * and before the child executed — so a viewer the user DENIED, or one that
   * exited non-zero (`bat` not installed, exit 127), still marked the file as
   * seen and unlocked an overwrite of a file nobody looked at. Pi credits after
   * the command on exit 0 and codex on a non-error return; claude was the
   * outlier, which is the cross-runtime divergence D1.332 exists to remove.
   *
   * NATIVE-FIRST, and the event does most of the work: `hooks.md`'s event table
   * reads *"`PostToolUse` | After a tool call succeeds"*, with
   * *"`PostToolUseFailure` | After a tool call fails"* on the next line, so a
   * failing call is routed to an event this fork credits nothing from, and a
   * DENIED call never reaches either. F1.187 MEASURED that routing on the
   * vendored binary for every non-zero viewer class and wired the twin to
   * {@link declineBashViewerCredit}. {@link readCreditingToolResultSucceeded}
   * is the defensive second half and carries the residue this cannot close.
   *
   * It no longer asks whether the file EXISTS, and that is not a loosening: the
   * old `existsSync` was standing in for "the read happened", which this seam
   * knows for real. A viewer that succeeded read something.
   */
  private creditBashViewerRead(toolName: string, toolInput: unknown, toolResponse: unknown): void {
    if (toolName !== 'Bash') return;
    if (!readCreditingToolResultSucceeded(toolResponse)) return;
    const command = (toolInput && typeof toolInput === 'object')
      ? (toolInput as Record<string, unknown>).command
      : undefined;
    const viewed = typeof command === 'string' && command ? bareFileViewerOperand(command) : undefined;
    if (!viewed) return;
    const root = this.config.session?.workingDirectory ?? this.workspaceRootPath;
    this.readBeforeWriteLedger.add(resolve(root, viewed));
  }

  /**
   * F1.187 (origin WJ-h P-WJ-h-2) — a Bash file viewer that FAILED earns no
   * read-before-write credit, decided by the event it arrived on.
   *
   * Called only from the `PostToolUseFailure` hook, whose payload carries
   * `error: string` and no `tool_response`; the page gives that string a first
   * line `Exit code N` when the command ran, and a bare message when the shell
   * could not be started. Nothing here touches the ledger at all: the whole
   * decision is that this event credits NOTHING, so a later `Write` to the same
   * file stays refused exactly as if the viewer had never been asked for.
   *
   * What it does do is say so, once per failed viewer, on the debug channel —
   * the only place a packaged build can show WHICH of the two events a real
   * non-zero viewer produced, which is the row's own live control. A command
   * that is not a bare viewer is ignored: every other failing tool call is none
   * of this rule's business, and logging them all would bury the one line.
   */
  private declineBashViewerCredit(toolName: string, toolInput: unknown, error: unknown): void {
    if (toolName !== 'Bash') return;
    const command = (toolInput && typeof toolInput === 'object')
      ? (toolInput as Record<string, unknown>).command
      : undefined;
    const viewed = typeof command === 'string' && command ? bareFileViewerOperand(command) : undefined;
    if (!viewed) return;
    const firstLine = typeof error === 'string' ? (error.split('\n')[0] ?? '').slice(0, 120) : 'no error text';
    this.debug(`[read-before-write] no credit for ${viewed}: the viewer failed (PostToolUseFailure: ${firstLine})`);
  }

  /**
   * F1.813 — the readable permission DSL's DENY half, on the one runtime that
   * evaluated none of it. See `claude-readable-permission-deny.ts` for the gap,
   * the native-first reading and what is deliberately NOT evaluated (allow, a
   * document that cannot answer).
   *
   * F1.830 — and its ASK half, which this method once left alone: a readable
   * ask was auto-approved in `bypassPermissions` (and for any call the mode let
   * through, in every mode), against `permission-modes.md#actions-no-mode-auto-approves`.
   * An ask now becomes the gate's own card (the `case 'prompt'` below raises it,
   * `origin: 'host_gate'`, and its approval is the one the SDK's ask-rule step
   * reads through `gateApprovedToolUseIds`), or a refusal in `dontAsk`; the
   * per-mode table is {@link claudeReadablePermissionAskCheckResult}'s. The mode
   * is the one the hook read for this call, so the gate and the ask agree on it.
   *
   * Runs on the gate's verdict for the input the hook pipeline settled on, so a
   * readable deny outranks every answer the gate could give — an `allow`, a
   * `modify`, the mode's card — and becomes the gate's own `block`, which the
   * PreToolUse hook's `case 'block'` already turns into the SDK's `deny` in every
   * mode, `bypassPermissions` included. A gate `block` is kept as it is: it is
   * already a refusal, and its reason (a floor, a denied path) is the more
   * specific one.
   *
   * The permissions context is the one the turn published
   * (`buildPinnedCapabilityContext`), or codex's fallback when there is none, so a
   * workspace `permissions.json` still binds a turn with no capability view. The
   * managed floor is read per call, from the same reader the SDK projection reads.
   *
   * F1.923 — `requestedInput` is the input the revalidate step RECEIVED (the one
   * the model and the trusted hooks settled on). The step itself rewrites a Read
   * of an image above `IMAGE_LIMITS.MAX_RAW_SIZE` to the host's resized copy
   * under the session's tmp, and this method used to judge only that copy — so a
   * deny over the directory holding the image let it through, and an ask raised
   * no card (measured through `__tests__/claude-readable-permission-deny.test.ts`'s
   * hook rig). Both are judged now, under the rule that already governed the
   * gate's own rewrite: a deny under ANY input refuses. The ask card shows the
   * requested path, not the copy's. And a DENY is caught before the resize too
   * ({@link readableRuleHoldingImageResize}), so no copy of a refused image
   * is ever written.
   */
  private withClaudeReadablePermissionDeny<T extends { checkResult: PreToolUseCheckResult; exactToolInput: Record<string, unknown> }>(
    validation: T,
    toolName: string,
    permissionMode: PermissionMode,
    requestedInput?: Record<string, unknown>,
  ): T {
    const { checkResult, exactToolInput } = validation;
    if (checkResult.type === 'block') return validation;
    const rewritten = checkResult.type === 'modify'
      ? checkResult.input
      : checkResult.type === 'prompt' ? checkResult.modifiedInput : undefined;
    const inputs = [exactToolInput, rewritten, requestedInput]
      .filter((candidate, index, all): candidate is Record<string, unknown> => candidate !== undefined && all.indexOf(candidate) === index);
    const verdict = this.readablePermissionVerdict(toolName, inputs);
    if (!verdict) return validation;
    if (verdict.kind === 'not-consulted') {
      this.debug(`[permissions] readable permission rules were not consulted for ${toolName}: ${verdict.reason}`);
      return validation;
    }
    if (verdict.kind === 'ask') {
      const asked = claudeReadablePermissionAskCheckResult(checkResult, verdict, { toolName, input: requestedInput ?? exactToolInput, mode: permissionMode });
      if (asked === checkResult) return validation;
      this.debug(`[permissions] ${toolName} ${asked.type === 'block' ? 'refused' : 'asked'} by readable permission ask rule "${verdict.ruleId ?? '(unnamed)'}"${verdict.scope ? ` (${verdict.scope} scope)` : ''} in ${permissionMode}`);
      return { ...validation, checkResult: asked };
    }
    this.debug(`[permissions] ${toolName} refused by readable permission rule "${verdict.ruleId}"${verdict.scope ? ` (${verdict.scope} scope)` : ''}`);
    return { ...validation, checkResult: { type: 'block', reason: verdict.reason } };
  }

  /** F1.813 — the readable policy's verdict for one call, over the same context and managed floor every caller reads. */
  private readablePermissionVerdict(toolName: string, inputs: readonly Record<string, unknown>[]) {
    return claudeReadablePermissionDeny({
      toolName,
      inputs,
      cwd: this.config.session?.workingDirectory ?? this.workspaceRootPath,
      permissionsContext: this.permissionManager.getCapabilityPermissionsContext?.() ?? {
        workspaceRootPath: this.workspaceRootPath,
        activeSourceSlugs: Array.from(this.sourceManager.getActiveSlugs()),
        projectTrusted: this.config.projectTrusted === true,
      },
      managedPolicy: resolveManagedPiPolicyFloor(),
    });
  }

  /**
   * F1.923, F1.935 — does a readable rule hold back the resize of this Read of a
   * large image, judged on the path it was asked for? Asked BEFORE the revalidate
   * step hands the file to `onImageResize`, which writes a readable copy of it
   * under the session's tmp: a refusal decided only after that copy exists would
   * leave the image's pixels at a path no rule covers.
   *
   * - A DENY (F1.923): the step skips the resize, the call keeps its original
   *   path, and {@link withClaudeReadablePermissionDeny} refuses it naming the
   *   rule, as it refuses a small image.
   * - An ASK (F1.935): the step skips the resize too, so the card — or
   *   `dontAsk`'s refusal — is decided on the original path exactly as for a
   *   small image, and the copy is made only once the card is approved
   *   ({@link resizeImageAfterApprovedAsk}). Before, the copy was written before
   *   the card and nothing removed it when the card was refused, so a later Glob
   *   + Read of the session tmp could return the refused image. Held only when
   *   the host has a resizer: without one the step refuses the image as too large
   *   before any card, as it always has.
   */
  private readableRuleHoldingImageResize(requestedInput: Record<string, unknown>, filePath: string, size: number): ClaudeImageResizeHold | undefined {
    const verdict = this.readablePermissionVerdict('Read', [requestedInput]);
    if (verdict?.kind === 'deny') return { by: 'deny' };
    return verdict?.kind === 'ask' && this.config.onImageResize
      ? { by: 'ask', filePath, sizeMB: (size / (1024 * 1024)).toFixed(1) }
      : undefined;
  }

  /**
   * F1.935 — the resize {@link readableRuleHoldingImageResize} held back for an
   * ASK, done once its card was approved. The approved input keeps every field
   * and reads the copy, as an approved ask did before. A resizer that gives no
   * copy refuses with the revalidate step's own too-large sentence, so the SDK is
   * never handed the original. The copy is judged by the readable rules once
   * more — a deny under ANY input refuses (F1.923), and before this change the
   * copy's path was among the inputs judged. It is not put through the rest of
   * the gate again: the gate judged the image itself, which is what the card
   * named and the user approved, and the copy is the host's own file of those
   * pixels.
   */
  private async resizeImageAfterApprovedAsk(held: { filePath: string; sizeMB: string }, approvedInput: Record<string, unknown>): Promise<{ input: Record<string, unknown> } | { reason: string }> {
    const resizedPath = await this.config.onImageResize?.(held.filePath, IMAGE_LIMITS.MAX_RAW_SIZE);
    if (!resizedPath) return { reason: claudeImageTooLargeReason(held.sizeMB) };
    const input = { ...approvedInput, file_path: resizedPath };
    const verdict = this.readablePermissionVerdict('Read', [input]);
    if (verdict?.kind === 'deny') return { reason: verdict.reason };
    this.onDebug?.(`Image resized after the approved ask, reading: ${resizedPath}`);
    return { input };
  }

  private wrapUserText(text: string): SDKUserMessage {
    return this.stampTurnMessageUuid({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      // Session resumption is handled by options.resume, not here.
      session_id: '',
    } as SDKUserMessage);
  }

  /**
   * Stamp a `uuid` on a message going into the live query.
   *
   * `SDKUserMessage.uuid` is OPTIONAL and nothing set it before. The interrupt
   * receipt (`still_queued`) can only ever name messages that carry one — "a
   * message enqueued without a uuid still runs but is never listed, so `[]` does
   * not mean nothing will run" — so without the stamp the receipt is not
   * evidence about our own traffic, and any future decision made from it would
   * be made from a blank.
   */
  private stampTurnMessageUuid(message: SDKUserMessage): SDKUserMessage {
    if ((message as { uuid?: string }).uuid) return message;
    return { ...message, uuid: randomUUID() } as SDKUserMessage;
  }

  /**
   * Return the live query's input channel, starting a session if there is not
   * already one this turn's options can run on.
   *
   * REUSE IS CONDITIONAL, and the condition is the honest part of this design.
   * Most of `Options` is a CONSTRUCTION option, so a live session is only
   * correct while the options it was built with are still the ones this turn
   * wants. When they are not, the session is rebuilt rather than silently
   * running the stale set.
   *
   * L4 — three of those options stopped being construction options, because the
   * SDK has a setter for each: `model`, `permissionMode` and the `mcpServers`
   * NAME SET. They are no longer hashed into the signature; instead
   * `applyLiveSettings` tells the running child about them, and a reconciliation
   * that fails falls through to the respawn the signature used to force. The
   * fallback is what makes this safe rather than optimistic: the worst case is
   * exactly the behaviour of the build before L4.
   *
   * L5 — it returns `notices` alongside the channel: per-process state the
   * adapter has to drop when a new child is spawned can owe the USER a line,
   * and this method has no way to yield one. `chatImpl` emits them.
   */
  private async ensureLiveSession(
    options: Options,
  ): Promise<{ input: ClaudeInputChannel; notices: AgentEvent[] }> {
    // F1.117 (origin WI-by) — THIS is where a memory switch flipped mid-session
    // reaches the child. The child's auto memory is closed by
    // `CLAUDE_CODE_DISABLE_AUTO_MEMORY` in its spawn environment, which no
    // running process can be told about; the turn head rebuilds `options.env`
    // from the chat's live override and the app-wide switch, `env` is hashed
    // into the signature below, and a changed answer therefore fails the reuse
    // test and respawns the child before this turn is sent. Native-first was
    // asked and measured on 2.1.251 (`claude-auto-memory-live-flip-e2e.test.ts`):
    // `applyFlagSettings({ autoMemoryEnabled })` IS read by the child, but only
    // before its first request — after that the auto-memory instructions stay in
    // its prompt for its whole life — so it cannot replace the respawn.
    // RESIDUE, declined rather than chased: a flip made while a turn is RUNNING
    // lands at the next turn head, because the only way to move the child under
    // a running turn is to kill that turn. The menu's notice is derived from the
    // same expression as this env (`resolveSessionRuntimeNotices`), so it is
    // right from the next message on; `claude-auto-memory-flip-respawn.test.ts`
    // pins both halves.
    const signature = claudeLiveSessionSignature(options);
    const requestedResume = (options as { resume?: string }).resume ?? null;
    const isForking = !!(options as { forkSession?: boolean }).forkSession;

    // THE RESUME ANCHOR IS COMPARED SEPARATELY, and getting this wrong is how a
    // "live session" quietly becomes one-shot: turn 1 runs with no `resume`, the
    // stream reports a session id, and turn 2 asks to resume it. Hashing the
    // anchor into the signature would call that a drift and respawn on turn two
    // of every session, forever, with nothing in the log to say so.
    //
    // The anchor matches when this turn asks for the conversation the live child
    // is ALREADY holding — either the id it was created with or the id its own
    // stream reported. A turn asking for NO conversation (`/clear` nulls
    // `sessionId`) matches only a child that never had one, which is exactly the
    // reset `/clear` promises.
    const heldConversation = this.liveObservedSessionId ?? this.liveResumeAnchor;
    const anchorMatches = requestedResume !== null
      ? requestedResume === this.liveObservedSessionId || requestedResume === this.liveResumeAnchor
      : heldConversation === null;

    // F1.821 + F1.1099 — an `effort`-only move (a clamp, or the user's own level change; `max` only by its clamp) is told to the child, not respawned.
    const effortClamp = claudeEffortClampDrift({ previousSignature: this.liveSignature, signature, capabilities: lookupClaudeModelCapabilities(options.model) });
    const reusable = this.currentQuery !== null
      && this.liveInput !== null
      && !this.liveInput.isEnded
      && (this.liveSignature === signature || effortClamp !== null)
      && anchorMatches
      && !isForking; // A fork is a NEW conversation by definition; no child holding another can serve it.

    if (reusable && await this.applyLiveSettings(options, effortClamp === null ? undefined : { effort: effortClamp, signature })) {
      debug('[ClaudeAgent] Reusing the live session for this turn');
      return { input: this.liveInput!, notices: [] };
    }

    if (this.currentQuery) {
      debug(`[ClaudeAgent] Live session options drifted — respawning (${describeClaudeLiveRespawn({ previousSignature: this.liveSignature, signature, anchorMatches, forking: isForking, inputEnded: this.liveInput?.isEnded !== false })})`); // F1.802 — names, never values
      this.endLiveSession(AbortReason.Redirect);
    }

    // L5 — A NEW CHILD MEANS A NEW BACKGROUND-TASK LEVEL, AND THE ADAPTER IS
    // NOT REBUILT WITH IT.
    //
    // `SDKBackgroundTasksChangedMessage` is a LEVEL signal whose contract says
    // it is per-process and that "nothing is emitted at startup, so consumers
    // must reset to the empty set whenever the session's CLI process
    // (re)starts". Before L2 that cost nothing: a turn was a process and a
    // process got a fresh `ClaudeEventAdapter`. Now the adapter outlives every
    // respawn this method performs — a drifted construction option, L4's
    // fall-through when a live setter is missing/refused/unanswered, a source
    // activation, the turn after L3's reaper — so the tracked set would carry
    // the DEAD child's task ids forward with no payload able to correct it.
    //
    // Placed at SPAWN rather than at death on purpose: this is the one line
    // through which every new child comes into existence, and between a death
    // and the next spawn nothing can read the level anyway — only a live child
    // emits the payload.
    const restartNotices = this.eventAdapter.resetBackgroundTaskLevel();
    // P2.35 — the same category, and the same line for the same reason.
    // `total_cost_usd` is scoped to one `query()` call, so the child about to be
    // built starts counting money again at zero. The adapter differences that
    // running total into each turn's own cost, so a remembered total from the
    // child that just died would swallow the new one's spend until it exceeded
    // that peak. The HOST's `sessionCostUsd` is deliberately left alone: it is
    // the sum across children, which is the only session-scoped authority there
    // is (the SDK's own ceiling restarts here too).
    this.eventAdapter.resetReportedCostTotal();
    // P2.42 — and `modelUsage` is the same running total broken down by model
    // (`sdk.d.ts:4367` repeats `:4359`'s wording verbatim), differenced the same
    // way and therefore scoped to the same child. Two calls rather than one
    // because they are two baselines; miss either and that half of the numbers
    // silently stops counting until the new child passes the dead one's peak.
    this.eventAdapter.resetReportedModelUsageTotals();

    const generation = ++this.liveGeneration;
    const input = new ClaudeInputChannel();
    const abortController = new AbortController();
    this.liveInput = input;
    this.currentQueryAbortController = abortController;
    this.liveSignature = signature;
    // The child is being BUILT with these three, so they are what it is running
    // with until a setter says otherwise. Recording them at spawn is what stops
    // the first reused turn issuing three no-op control requests.
    this.liveSettings = claudeLiveSettings(options);
    this.liveResumeAnchor = requestedResume;
    this.liveObservedSessionId = null;
    const live = query({
      // The async-iterable prompt is the whole mechanism. A STRING prompt sets
      // the SDK's `isSingleUserTurn` and its reader calls `transport.endInput()`
      // at the first result — EOF, and therefore the child's exit. That one line
      // is why this backend was one process per user message.
      prompt: input.stream(),
      options: { ...options, abortController },
    });
    this.currentQuery = live;
    // P3.268 — read back the capability self-report this child is about to
    // publish. NOT awaited: `supportedModels()` resolves off the `initialize`
    // response (`sdk.mjs` at 0.3.233:
    // `async supportedModels(){return(await this.initialization).models}`), so
    // awaiting it here would make every spawn block on the child's handshake for
    // a value this turn's options were already built without. The rows land
    // during turn 1 and the NEXT turn reads them.
    void this.captureModelCapabilities(live);
    // P3.268 — a NEW child re-reports its own window; carrying the dead one's
    // would keep the meter's denominator from a model this child may not be
    // running. Cleared here, at the one line a child comes into existence,
    // beside `resetBackgroundTaskLevel` and for the same per-CHILD reason.
    this.eventAdapter.clearSdkContextUsage();
    void this.refreshSdkContextWindow(live, 'spawn');
    // P3.375 — this was `this.liveReader = this.runLiveReader(...)`, a field
    // NOTHING ever read. Its docblock claimed "one per live session", but no
    // reader enforced that and teardown nulled the field without awaiting the
    // promise, so teardown never waited for the reader and still does not.
    // Behaviour is unchanged; what is gone is a handle that looked like a
    // control. If a future change needs teardown to WAIT for the reader, the
    // field comes back WITH an await — a held promise that is never awaited is
    // the shape that made this look wired.
    void this.runLiveReader(live, generation);
    return { input, notices: restartNotices };
  }

  /**
   * P3.268 — ask the runtime what window it is actually measuring against.
   *
   * The host derived the context meter's denominator from
   * `result.modelUsage[*].contextWindow` — the model's RAW window — while
   * `Query.getContextUsage()` publishes `rawMaxTokens`, *"the resolved
   * autocompact window … or a smaller compaction-policy window (a configured
   * value, or e.g. the 200K boundary on 1M-window models)"*. This fork opts
   * 1M-window models in by a `[1m]` suffix, so the gap between the two is a
   * factor of five on exactly the sessions that need the meter most.
   *
   * Called at SPAWN and on a live `setModel`, not per turn, because the window
   * moves only when the model or the compaction policy moves — and a per-turn
   * control request would buy nothing but latency. Best-effort throughout: every
   * failure ends at `debug` and the derived value keeps the meter running, which
   * is what shipped before this row.
   */
  /**
   * P6.264 — `/context` on a claude session, drawn from the runtime's own
   * structured report instead of from a totals fallback.
   *
   * ## The seam, and why it is this one
   *
   * `SessionManager` already asks the backend for a snapshot
   * (`agent.requestContextUsage()`) and already renders whatever categories come
   * back; `PiAgent` was the only implementer, so the optional method's absence
   * here WAS the gap. Implementing it needs no new channel, no wire change and
   * no renderer change — the overlay's category rows have been reading
   * `ContextUsageSnapshot.categories` all along.
   *
   * ## What it costs when the child is not up
   *
   * A control request needs a live child. `/context` is a user action on an open
   * session, so the child normally exists; when it does not, this throws and
   * `SessionManager`'s own catch reports the previous snapshot as `stale`, which
   * is the behaviour Pi already has when its subprocess is restarting. No child
   * is spawned to answer an accounting question.
   */
  async requestContextUsage(): Promise<ContextUsageSnapshot> {
    const live = this.currentQuery;
    if (!live || typeof live.getContextUsage !== 'function') {
      throw new Error('claude context usage unavailable: no live session');
    }
    const snapshot = claudeContextUsageSnapshot(await live.getContextUsage());
    if (!snapshot) throw new Error('claude context usage unavailable: unusable payload');
    return snapshot;
  }

  private async refreshSdkContextWindow(live: Query, occasion: string): Promise<void> {
    try {
      if (typeof live.getContextUsage !== 'function') return;
      const usage = await live.getContextUsage();
      const applied = this.eventAdapter.applySdkContextUsage(usage);
      debug( // F1.1106 — module debug(), as F1.822: `this.debug` (onDebug, electron-log) is dropped by a packaged build
        `[ClaudeAgent] context window (${occasion}): ${applied
          ? `${usage?.rawMaxTokens} for ${usage?.model} — the runtime's resolved window`
          : 'unusable payload; the derived window keeps the meter'}`,
      );
    } catch (error) {
      debug( // F1.1106 — the same sink as the line above
        `[ClaudeAgent] context window (${occasion}) unavailable`
        + ` (${error instanceof Error ? error.message : String(error)});`
        + ' the derived window keeps the meter',
      );
    }
  }

  /**
   * P3.268 — record what this child says its models can do.
   *
   * The whole method is best-effort by construction and that is deliberate: a
   * child that dies before `initialize` rejects this promise, and the correct
   * consequence is that the string-match fallback keeps deciding — never that a
   * spawn fails or a turn is delayed. So every failure ends at `debug`, and
   * `lookupClaudeModelCapabilities` simply keeps answering `undefined`.
   *
   * `informative` counts the rows that carried at least one capability field.
   * Zero rows and zero informative rows are DIFFERENT states — an older CLI
   * publishes models with none of the four fields — and only the log can tell
   * them apart, so both numbers are printed — by the module `debug()` (F1.822).
   */
  private async captureModelCapabilities(live: Query): Promise<void> {
    try {
      if (typeof live.supportedModels !== 'function') return;
      const models = await live.supportedModels();
      if (!Array.isArray(models)) return;
      const informative = recordClaudeModelCapabilities(models);
      debug( // F1.822 — `this.debug` is `onDebug`, electron-log in the desktop host: dropped by a packaged build
        `[ClaudeAgent] model capability self-report: ${models.length} model(s), ${informative} carrying capability fields`,
      );
    } catch (error) {
      debug(
        `[ClaudeAgent] model capability self-report unavailable (${error instanceof Error ? error.message : String(error)});`
        + ' the model-id heuristic keeps deciding',
      );
    }
  }

  /**
   * L4 — TELL THE RUNNING CHILD WHAT CHANGED, OR SAY THAT IT CANNOT BE TOLD.
   *
   * Returns `true` when the live child is now running the settings this turn
   * wants, `false` when it could not be brought there — in which case
   * `ensureLiveSession` respawns, which is precisely the behaviour of the build
   * before L4. **Every failure mode of this method degrades to that**, which is
   * why it may be optimistic about the happy path without being optimistic about
   * the product.
   *
   * FOUR THINGS IT REFUSES TO ASSUME, each with a reason found in the SDK or the
   * CLI rather than supposed:
   *
   * 1. **That a setter exists.** `typeof` guards, because the setter surface is
   *    version-dependent — L2 recorded three setters, and the vendored 0.3.223
   *    declares **27 methods on `Query`, 6 of them mutators** (`setPermissionMode`,
   *    `setMcpPermissionModeOverride`, `setModel`, `setMaxThinkingTokens`,
   *    `setMcpServers`, `applyFlagSettings`), counted 2026-09-02 off
   *    `sdk.d.ts`'s own `interface Query`. A count in prose is a reading with a
   *    date, not a fact; an older or patched SDK may have fewer than we read
   *    today, which is the whole reason for the guards.
   * 2. **That the CLI accepts the value.** Both setters can be REFUSED with a
   *    control-response error, which the SDK turns into a rejected promise. The
   *    CLI's own strings: *"Cannot set permission mode to bypassPermissions
   *    because the session was not launched with --dangerously-skip-permissions"*
   *    and *"Cannot set permission mode to auto: …"*, plus the unrecognized- and
   *    not-allowed-model arms of its `set_model` handler — which BYO and gateway
   *    model ids are exactly the shape to trip.
   * 3. **That an un-thrown call succeeded.** `setMcpServers` resolves with
   *    `{added, removed, errors}` — a server that failed to connect is reported
   *    in `errors`, not thrown. An absence of an exception is not evidence, so
   *    the RESULT is checked against what was asked for.
   * 4. **That the child answers at all.** The SDK's `awaitControlResponse` has
   *    NO timeout: it settles on the response, on a CLI error verdict, or when
   *    the query is cleaned up. A wedged child would therefore hang this call —
   *    and through it the turn — forever. That is L2's blocking defect exactly,
   *    so the same guarantee is restored the same way: a deadline, after which
   *    we stop waiting and respawn.
   */
  private async applyLiveSettings(options: Options, effortClamp?: { effort: string; signature: string }): Promise<boolean> {
    const live = this.currentQuery;
    const current = this.liveSettings;
    if (!live || !current) return false;

    const wanted = claudeLiveSettings(options);
    const modelDrifted = wanted.model !== current.model;
    const modeDrifted = wanted.permissionMode !== current.permissionMode;
    const serversDrifted = !sameMcpServerNames(wanted.mcpServerNames, current.mcpServerNames);
    // P6.221 — the fourth thing a running child can now be told, and the only
    // one of the three flags this fork can actually drift.
    const denyDrift = claudeDenyListDrift(current.disallowedTools, wanted.disallowedTools);
    if (!modelDrifted && !modeDrifted && !serversDrifted && denyDrift === 'same' && !effortClamp) return true;

    // THE RECORD IS COMMITTED ONCE, AT THE END, and never mid-flight. Each
    // setter is awaited, and a teardown can land during any of those awaits —
    // `endLiveSession` nulls `liveSettings`, so writing `{...this.liveSettings}`
    // after an await could hand the NEXT session a record built from the dead
    // one's values. Nothing is lost by waiting: a partial application returns
    // `false`, which respawns, and a fresh child is constructed with all three
    // values anyway.
    const generation = this.liveGeneration;
    try {
      if (modelDrifted) {
        if (typeof live.setModel !== 'function') return false;
        await this.withLiveSettingDeadline('setModel', live.setModel(wanted.model));
        // P3.268 — the window is a property of the MODEL, so the one live
        // setter that can move it re-asks. Not awaited: the reconciliation's
        // verdict must not hinge on an accounting read, and a stale window
        // simply falls back to the derived one on the next result.
        void this.refreshSdkContextWindow(live, 'setModel');
        this.debug(`Claude live session switched model to ${wanted.model ?? '(default)'}`);
      }

      if (effortClamp) { // F1.821 — the SDK's setter for this key (`effortLevel`: "Applied on the next turn"); see `claudeEffortClampDrift`
        if (typeof live.applyFlagSettings !== 'function') return false;
        await this.withLiveSettingDeadline('applyFlagSettings', live.applyFlagSettings({ effortLevel: effortClamp.effort as NonNullable<Options['effort']> }));
        debug(`[ClaudeAgent] Live session effort is now ${effortClamp.effort}: the model's reported levels clamp it, and the child had already fallen back to it`);
      }

      if (modeDrifted) {
        // `wanted.permissionMode` is already in the SDK's vocabulary — it was
        // put into `options` by `buildClaudePermissionModeOptions`, i.e. through
        // `toClaudeSdkPermissionMode`. Reading it back rather than re-deriving
        // it is the point: `explore` has no SDK member, and a second mapping on
        // the live path is how the two would drift apart.
        if (wanted.permissionMode === undefined) return false;
        if (typeof live.setPermissionMode !== 'function') return false;
        await this.withLiveSettingDeadline(
          'setPermissionMode',
          live.setPermissionMode(wanted.permissionMode as ClaudeSdkPermissionMode),
        );
        this.debug(`Claude live session switched permission mode to ${wanted.permissionMode}`);
      }

      if (serversDrifted) {
        if (typeof live.setMcpServers !== 'function') return false;
        const servers = (options.mcpServers ?? {}) as Parameters<Query['setMcpServers']>[0];
        const result = await this.withLiveSettingDeadline('setMcpServers', live.setMcpServers(servers));
        if (!this.mcpReconciliationSucceeded(result, current.mcpServerNames, wanted.mcpServerNames)) {
          return false;
        }
        this.debug(`Claude live session MCP set is now ${wanted.mcpServerNames.join(', ') || '(empty)'}`);
      }

      if (denyDrift !== 'same') {
        // A NARROWED list is not reachable from here: `disallowedTools` is spent
        // once as `--disallowedTools` in the SDK's argv builder, and the
        // flag-settings layer cannot retract a CLI flag. Respawning is the
        // honest answer and is exactly what this whole method used to do.
        if (denyDrift === 'narrowed') {
          this.debug('Claude live session deny list narrowed, which the flag layer cannot express, respawning instead');
          return false;
        }
        const flagDeny = claudeFlagLayerDeny(current.disallowedTools, wanted.disallowedTools, CLAUDE_TOOL_ALIASES);
        if (flagDeny === null || typeof live.applyFlagSettings !== 'function') return false;
        await this.withLiveSettingDeadline(
          'applyFlagSettings',
          // The whole list every time (the page: a second `{permissions}` REPLACES the
          // first) LESS the alias keys: a flag-layer `Artifact` also denies its alias
          // target (UA1.20 follow-up, `claudeFlagLayerDeny`); null respawns instead.
          live.applyFlagSettings({ permissions: { deny: flagDeny } }),
        );
        this.debug(`Claude live session deny list is now ${wanted.disallowedTools.join(', ') || '(empty)'}`);
      }
    } catch (error) {
      this.debug(`Claude live setting could not be applied, respawning instead: ${String(error)}`);
      return false;
    }

    // The session died — or was deliberately replaced — while we were waiting on
    // a control response. Whatever we just applied belongs to a child that is no
    // longer ours, so this turn must not run on it and its record must not be
    // written over the successor's.
    if (this.liveGeneration !== generation || this.currentQuery !== live) return false;
    this.liveSettings = wanted;
    if (effortClamp) this.liveSignature = effortClamp.signature; // F1.821 — the clamped level is what it now runs
    return true;
  }

  /**
   * Bound the wait on one control request.
   *
   * `awaitControlResponse` never times out on its own, so without this a child
   * that stops answering its control channel hangs the turn — the defect L2's
   * review caught on the interrupt path, arriving by a second door. The losing
   * promise is deliberately given a `catch`: it settles later (at query cleanup,
   * with "Query closed before response received") and an unhandled rejection
   * from a race we already walked away from would be reported as a crash.
   */
  private withLiveSettingDeadline<T>(what: string, work: Promise<T>): Promise<T> {
    work.catch(() => {});
    return Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Claude live ${what} did not answer within ${this.interruptDeadlineMs}ms`)),
          this.interruptDeadlineMs,
        );
        (timer as unknown as { unref?: () => void }).unref?.();
        void work.then(() => clearTimeout(timer), () => clearTimeout(timer));
      }),
    ]);
  }

  /**
   * Did `setMcpServers` actually do what we asked?
   *
   * The strictness is deliberate and it is cheap: the only cost of a false
   * "no" is one respawn, which is what every turn did before L4, while the cost
   * of a false "yes" is a turn running without the tools the user just enabled
   * and no sign of it anywhere.
   *
   * The one documented exemption we are safe from: plugin-owned servers are
   * "simply absent from the result's `removed` list" even when omitted. We pass
   * `plugins: []` and every server in the payload is one we built, so no name in
   * our diff can be plugin-owned. If plugins ever start contributing MCP servers
   * on this runtime, this check has to learn about that exemption first.
   */
  private mcpReconciliationSucceeded(
    result: { added?: string[]; removed?: string[]; errors?: Record<string, string> } | undefined,
    before: readonly string[],
    after: readonly string[],
  ): boolean {
    if (!result) return false;
    const errors = Object.keys(result.errors ?? {});
    if (errors.length > 0) {
      this.debug(`Claude live MCP reconciliation reported errors for ${errors.join(', ')}`);
      return false;
    }
    const added = new Set(result.added ?? []);
    const removed = new Set(result.removed ?? []);
    const missingAdds = after.filter(name => !before.includes(name) && !added.has(name));
    const missingRemovals = before.filter(name => !after.includes(name) && !removed.has(name));
    if (missingAdds.length > 0 || missingRemovals.length > 0) {
      this.debug(
        `Claude live MCP reconciliation incomplete — not added: ${missingAdds.join(', ') || 'none'}; `
        + `not removed: ${missingRemovals.join(', ') || 'none'}`,
      );
      return false;
    }
    return true;
  }

  /**
   * The ONE reader over the live query, for the whole session.
   *
   * It runs detached: nothing awaits it, because the thing that awaits a turn is
   * the turn's own slot. When the stream ends — session death, transport error,
   * our own teardown — it settles whatever slot is open rather than leaving a
   * turn waiting for a result that can never come. That unconditional settlement
   * is the answer to the coalescing objection: a hang is impossible not because
   * we match results to messages cleverly, but because the session's death
   * settles every waiter.
   */
  private async runLiveReader(live: Query, generation: number): Promise<void> {
    try {
      for await (const message of live) {
        if (this.liveGeneration !== generation) return;
        await this.routeLiveMessage(message);
      }
      this.settleLiveSessionEnd(generation, null);
    } catch (error) {
      this.settleLiveSessionEnd(generation, error);
    }
  }

  /**
   * The stream ended. Under the old shape this WAS the turn boundary; now it is
   * the session's death, and every open turn has to be told.
   */
  private settleLiveSessionEnd(generation: number, error: unknown): void {
    if (this.liveGeneration !== generation) return;
    const slot = this.openSlot;
    this.settleRuntimeOwnTurn(); // F1.509 — the child died under it
    this.endBetweenTurnsToolRows(); // F1.524 (3) — and so did any tool it was running in that turn
    this.currentQuery = null;
    this.liveSignature = null;
    this.liveSettings = null;
    this.liveObservedSessionId = null;
    this.liveResumeAnchor = null;
    this.liveInput?.end();
    this.liveInput = null;
    if (!slot || slot.settled) return;
    // The error path re-throws into `chatImpl`'s own `catch (sdkError)`, so every
    // recovery arm it already had — AbortError, auth, billing, resume retry,
    // branch fallback — keeps its exact shape and its exact classification.
    if (error !== null && error !== undefined) slot.fail(error);
    else slot.close('session-ended');
  }

  /**
   * A message arrived with no turn open.
   *
   * L1 established that a between-turns consumer already EXISTS
   * (`SessionManager.processEvent` runs with no turn open — the background-fork
   * path relies on it) and that what it needs is a WHITELIST rather than
   * "anything with no slot open": a stray `complete` parks terminal state that
   * `onProcessingStopped` then reads onto a turn that has not started yet.
   *
   * L2 therefore routes nothing and reports everything. Building the sink is
   * L5's job, when there is background traffic to put in it; admitting traffic
   * to a sink that does not exist yet would be the defect L1 named.
   *
   * F1.492 — THE TRAFFIC EXISTS, and it was measured before anything was built
   * (vendored `claude` 2.1.251 driven through this class, `work/wjaf/` rig): a
   * BACKGROUND subagent that ends after its turn sends `background_tasks_changed`
   * (`tasks: []`) and its terminal `task_notification`, and then the CLI opens a
   * turn OF ITS OWN (`init` … `assistant` … `result`) that hands the model a
   * `<task-notification>`. All of it was dropped here, with three results: the
   * level kept the finished task, so `backgroundWorkCount()` answered 1 for the
   * rest of the session (the reaper and the ceiling read it); no `task_completed`
   * reached the host, so the row never ended; and the model's reply sat in its
   * context and in no transcript.
   *
   * So two classes are admitted, each by MESSAGE first and then by EVENT, and
   * everything else is still reported and dropped:
   *
   * 1. **The level and a task's end** ({@link BETWEEN_TURNS_TASK_SUBTYPES}) —
   *    per-child facts, not a turn's news. Always adapted, host or no host,
   *    because the level is what the busy predicate reads; their
   *    `background_tasks_replaced` and `task_completed` cross.
   * 2. **The main thread's words and tool rows in a turn the CLI opened itself**
   *    — main-thread `stream_event`/`assistant`/`user`/`tool_progress` only (a
   *    background subagent's own messages carry `parent_tool_use_id` and stay
   *    dropped), and only `text_complete`, `tool_start` and `tool_result` cross.
   *    That turn IS the notification's delivery — the CLI's native one — so the
   *    host must not deliver it a second time (R86 skips claude for that reason,
   *    `SessionManager.processEvent`'s `task_completed` case). Its tool rows
   *    cross since F1.511, each result through the SAME large-result guard a host
   *    turn applies ({@link guardBetweenTurnsToolResult}), and a guard that fails
   *    there still ends the row rather than passing the result unguarded. Its
   *    `result` is not even adapted: a `complete` on the host's door parks
   *    terminal state onto the next turn (L1), and leaving the CLI's running cost
   *    total unread keeps that turn's spend inside the next turn's differenced
   *    figure instead of dropping it.
   *
   * The door is `BackendConfig.onBetweenTurnsEvent` — the one T30 built into
   * `SessionManager.processEvent` for Pi's detached runs, named for its first
   * user. Widened to claude rather than duplicated (a second door would have to
   * re-derive R86's gate and the row's terminal state); the rename is owed.
   * Absent (a headless or test construction), class 1 still updates the level.
   *
   * UB9.8 — a third, read before both: **a background task's activity**
   * (`task_progress`), which is when a background agent mostly works. Upstream
   * v0.15.1's `routeBackgroundMessage` (craft-agents-oss, Apache-2.0): the same
   * classifier and main-line gate as the in-turn adapter, crossing as
   * `task_activity` only. CLASSIFIED rather than adapted, because the adapter's
   * `task_progress` branch also writes the orchestration panel's roster, whose
   * `task_progress` event has no between-turns door.
   */
  private async noteBetweenTurnsMessage(message: SDKMessage): Promise<void> {
    const type = (message as { type?: string }).type ?? 'unknown';
    const subtype = (message as { subtype?: string }).subtype;
    const activity = classifyClaudeTaskProgress(message);
    if (activity) {
      const activitySink = this.config.onBetweenTurnsEvent;
      try {
        if (activitySink && this.eventAdapter.wasLaunchedByMainAgent(activity.taskId, activity.toolUseId)) {
          activitySink({ type: 'task_activity', ...activity });
        } else {
          debug(`[ClaudeAgent] between-turns task_progress ${activity.taskId} not forwarded (${activitySink ? 'not the session agent\'s own task' : 'no door'})`);
        }
      } catch (error) {
        // Fail-soft, as below: a throw here would end the session's one reader.
        this.debug(`between-turns task_progress not delivered: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    const taskFact = type === 'system' && subtype !== undefined && ClaudeAgent.BETWEEN_TURNS_TASK_SUBTYPES.has(subtype);
    // F1.511 — `user` (a tool's result) and `tool_progress` (a long tool's start) join the main thread's words.
    const mainThreadTurn = ClaudeAgent.BETWEEN_TURNS_TURN_MESSAGES.has(type)
      && (message as { parent_tool_use_id?: string | null }).parent_tool_use_id == null;
    if (!taskFact && !mainThreadTurn) {
      debug(`[ClaudeAgent] between-turns SDK message dropped: ${type}${subtype ? `/${subtype}` : ''}`);
      return;
    }
    const crossing = taskFact ? ClaudeAgent.BETWEEN_TURNS_TASK_EVENTS : ClaudeAgent.BETWEEN_TURNS_WORD_EVENTS;
    const sink = this.config.onBetweenTurnsEvent;
    try {
      for (const event of await this.eventAdapter.adapt(message)) {
        if (!sink || !crossing.has(event.type)) continue;
        // F1.524 (3) — the rows this door opened and has not ended; see endBetweenTurnsToolRows.
        if (event.type === 'tool_start') this.openBetweenTurnsToolRows.set(event.toolUseId, event.toolName);
        if (event.type === 'tool_result') this.openBetweenTurnsToolRows.delete(event.toolUseId);
        sink(event.type === 'tool_result' ? await this.guardBetweenTurnsToolResult(event) : event);
      }
    } catch (error) {
      // Fail-soft: there is no turn to report into, and a throw here would end the session's one reader.
      this.debug(`between-turns ${type}${subtype ? `/${subtype}` : ''} not delivered: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** F1.492 — the per-child task messages adapted between turns ({@link noteBetweenTurnsMessage}, class 1). */
  private static readonly BETWEEN_TURNS_TASK_SUBTYPES: ReadonlySet<string> = new Set(['background_tasks_changed', 'task_notification']);
  /** F1.492 — what class 1 hands the host: the row feed and the terminal state. */
  private static readonly BETWEEN_TURNS_TASK_EVENTS: ReadonlySet<string> = new Set(['background_tasks_replaced', 'task_completed']);
  /**
   * F1.492 — what class 2 hands the host: the words of the turn the CLI opened itself. F1.511 — and its tool rows,
   * each result through {@link guardBetweenTurnsToolResult}; still never its `complete`, status or usage.
   */
  private static readonly BETWEEN_TURNS_WORD_EVENTS: ReadonlySet<string> = new Set(['text_complete', 'tool_start', 'tool_result']);
  /** F1.492 + F1.511 — the main-thread message types class 2 adapts between turns (`parent_tool_use_id` null only). */
  private static readonly BETWEEN_TURNS_TURN_MESSAGES: ReadonlySet<string> = new Set(['stream_event', 'assistant', 'user', 'tool_progress']);

  /**
   * F1.511 (origin WJ-af P-WJ-af-3) — THE LARGE-RESULT GUARD, ONE CALL FOR BOTH DOORS.
   *
   * Extracted from {@link routeLiveMessage}'s in-turn path so the between-turns door
   * ({@link guardBetweenTurnsToolResult}) guards a result exactly as a host turn does. `null` means "show it as
   * it is"; a string replaces the result.
   *
   * An MCP result carries the documented MCP output limit (`agent-sdk/mcp.md:894`, `mcp.md:1040`), NOT the
   * local-tool threshold, and NOT the context window — `tokenLimitFor` can only lower a limit, so passing the
   * window here is precisely how the pool's raise became invisible one layer up. The guard is not skipped for
   * `mcp__` names: MCP servers configured straight into the SDK never pass through the pool and are guarded ONLY
   * here.
   */
  private async guardToolResultForHost(
    event: Extract<AgentEvent, { type: 'tool_result' }>,
    sessionPath: string,
  ): Promise<string | null> {
    const mcpProxyName = event.toolName?.startsWith('mcp__') ? event.toolName : undefined;
    const declaredResultSize = mcpProxyName
      ? this.config.mcpPool?.declaredResultSizeCharsForProxyTool(mcpProxyName, this.config.mcpLeaserId)
      : undefined;
    return guardLargeResult(event.result, {
      sessionPath,
      toolName: event.toolName || 'unknown',
      input: event.input,
      // UB3.9 (upstream v0.15.1 :2949): the raw model input still carries
      // `_intent` at this door (the SDK hands it back with the result), and a
      // source call guarded here — configured straight into the SDK, never
      // through the pool — is summarised against it too.
      intent: typeof (event.input as Record<string, unknown> | undefined)?._intent === 'string'
        ? (event.input as Record<string, unknown>)._intent as string
        : undefined,
      summarize: this.getSummarizeCallback(),
      ...(mcpProxyName
        ? { tokenLimit: mcpOutputTokenLimit() }
        : { contextWindow: this.usageTracker.getContextWindow() }),
      ...(declaredResultSize !== undefined ? { maxResultSizeChars: declaredResultSize } : {}),
    });
  }

  /** F1.511 — the session directory of the last turn this agent opened; see {@link guardBetweenTurnsToolResult}. */
  private lastTurnSessionDir: string | null = null;

  /**
   * F1.524 (3) (origin WJ-am P-WJ-am-3) — the tool rows the between-turns door opened (`tool_start` sent) and has
   * not ended (no `tool_result` yet), by tool-use id, with the tool's name.
   */
  private readonly openBetweenTurnsToolRows = new Map<string, string>();

  /**
   * F1.524 (3) — END every tool row the between-turns door left open, because the child that was running it is gone.
   *
   * F1.511 sends a turn the CLI opened itself to the host as its words AND its tool rows. A host turn's rows are
   * swept by that turn's own end; the CLI's own turn has no end the host sees but its `result`, and a child that dies
   * between a `tool_start` and its `tool_result` sends neither — so the row stayed `executing` for good. Called from
   * both death paths ({@link settleLiveSessionEnd}: the stream ended or failed; {@link endLiveSession}: the host
   * tore the session down or respawned it). Each row ends ONCE, as an ERROR result naming why, through the same door;
   * a row the child ended itself is no longer recorded, so it is never ended twice. With no door nothing is recorded.
   */
  private endBetweenTurnsToolRows(): void {
    if (this.openBetweenTurnsToolRows.size === 0) return;
    const rows = [...this.openBetweenTurnsToolRows];
    this.openBetweenTurnsToolRows.clear();
    const sink = this.config.onBetweenTurnsEvent;
    for (const [toolUseId, toolName] of rows) {
      try {
        sink?.({
          type: 'tool_result',
          toolUseId,
          toolName,
          result: 'The Claude Code session ended before this tool call finished, so it has no result.',
          isError: true,
        });
      } catch (error) {
        // Fail-soft, as the door itself is: a throw here would escape a teardown path.
        this.debug(`between-turns tool row ${toolUseId} not ended: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * F1.511 — a between-turns `tool_result` on its way to the host door, through the SAME guard a host turn applies.
   *
   * The guard needs nothing that lives only on the slot: its directory is the one the last turn used (the same
   * `getSessionDirPath` of the same session), and the rest is the agent's. What it CANNOT have between turns is a
   * caller to throw to — a throw here would end the session's one reader — so a guard that fails, or an agent that
   * has never opened a turn (no directory to write in), still ENDS the row: the result is replaced by a sentence
   * naming why it is not shown, never passed through unguarded. The model already has the real result; this only
   * decides what the transcript shows.
   */
  private async guardBetweenTurnsToolResult(event: Extract<AgentEvent, { type: 'tool_result' }>): Promise<AgentEvent> {
    if (event.isError || !event.result) return event;
    const withheld = (reason: string): AgentEvent => ({
      ...event,
      result: `[Result not shown: ${reason}. The model received it; this is the transcript's copy only.]`,
    });
    if (!this.lastTurnSessionDir) return withheld('this session has no directory yet for the large-result guard to write in');
    try {
      const guarded = await this.guardToolResultForHost(event, this.lastTurnSessionDir);
      // UB1.16 — the same password-entry lines kept at the turn door (upstream v0.15.1).
      if (guarded && isCanonicalBrowserToolName(event.toolName ?? '')) {
        return { ...event, result: keepPasswordEntryLines(event.result, guarded) };
      }
      return guarded ? { ...event, result: guarded } : event;
    } catch (error) {
      return withheld(`the large-result guard failed between turns (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  /**
   * F1.492 — this runtime hands a background task's END to the model itself: measured on the vendored 2.1.251, the
   * CLI opens a turn of its own carrying `<task-notification>` (class 2 of {@link noteBetweenTurnsMessage} is how its
   * words reach the transcript). `SessionManager`'s R86 gate reads this and does not deliver the same end a second
   * time — structural, like {@link onSubagentEnded}, because the host imports no backend class.
   */
  readonly deliversBackgroundTaskEndsItself = true;

  /**
   * F1.509 (origin WJ-af P-WJ-af-1) — THE TURN THE CHILD OPENED ITSELF, which the host could not see.
   *
   * Class 2 of {@link noteBetweenTurnsMessage}: when a background subagent ends between turns, the CLI opens a turn
   * of its own (`system/init` … `assistant` … `result`, measured on the vendored 2.1.251) to hand the model
   * `<task-notification>`. {@link isProcessing} is slot-based and answers `false` throughout it, so a host send took
   * the idle path and wrote into the live input mid-turn: the new slot received the CLI turn's reply and closed on
   * ITS `result`, and every boundary after it slipped by one (WJ-af's rig, the R86 replay).
   *
   * `null` when no such turn is running; otherwise a promise that settles when its `result` arrives — or when the
   * child dies or is torn down under it ({@link settleLiveSessionEnd}, {@link endLiveSession}), so a host waiting on
   * it never waits forever. `SessionManager.sendMessage` queues a send while it is pending and replays the queue
   * when it settles, exactly as for a running host turn — and never steers into it, because {@link redirect} with no
   * slot open is a session kill.
   *
   * F1.528 — the `result` is taken WHEREVER it is routed, not only with no slot open: a send that read this as
   * `null` before the child's own `init` still opens its slot and writes mid-turn, and WJ-ar's rig measured the CLI
   * FOLDING that write into its own turn when a tool boundary is left — ONE result, landing in the host's slot, so
   * the slot-less result this used to wait for never came and every later send queued forever. It is deliberately
   * NOT superseded when a host slot opens: a slot that closes before the own turn's result (a Stop, a source
   * activation) would then leave the child mid-turn with the marker already `null`. And the promise is BOUNDED
   * ({@link CLAUDE_RUNTIME_OWN_TURN_BOUND_MS}) for an end none of the above reports.
   *
   * The marker is the child's own `system/init` arriving with no slot open: `init` arrives once per TURN (L0), and
   * every turn the host starts opens its slot before writing, so a slot-less `init` is a turn the host did not
   * start. RESIDUE, stated rather than hidden: a CLI turn that starts in the same instant as a host write lands in
   * the host's new slot and is not seen here. The CLI's own `command_lifecycle` frames (`uuid`, `state:
   * 'started'|'completed'`, emitted for every uuid-stamped command we write and for none of its task notifications —
   * read in the vendored binary, not declared in `sdk.d.ts` at 0.3.251) could correlate a slot with its own command
   * and close that window; that is a larger change to the slot's routing and is not made here.
   *
   * F1.539 (origin WJ-ar P-WJ-ar-1) — THE CLI'S OWN BUSY SIGNAL WAS MEASURED AS A REPLACEMENT FOR THIS MARKER, AND IS
   * NOT ADOPTED. `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` (3 occurrences in the vendored binary, `grep -aoF`; in no
   * line of `env-vars.md`) switches on `system/session_state_changed`, which `sdk.d.ts` calls "authoritative
   * turn-over signal". WJ-bb's rig (`work/wjbb/`, vendored 2.1.267 / SDK 0.3.267; its control arm, the name unset,
   * emitted no such frame): around the CLI's own turn `running` came 19–73 ms after the task's `task_notification`
   * and 2–7 ms before this marker's `init` (three arms), and `idle` came 0–1 ms after the turn's `result` — once
   * already inside the next host slot — and up to 69 ms after a host turn's; it also went `idle` with a background
   * subagent still running. So it bounds the same turn this marker does, a few ms wider on each side, closes no
   * window this marker leaves (F1.524 (1)'s gap precedes both), and costs an undocumented switch in the child's env
   * plus a second signal to keep agreeing with this one. A reading, recorded here because this is where a swap would
   * be made; re-measure after a lift, and before adopting it if `env-vars.md` ever documents the name.
   */
  runtimeOwnTurnSettled(): Promise<void> | null {
    return this.runtimeOwnTurn?.settled ?? null;
  }

  /** F1.509 — the pending own turn, if any; see {@link runtimeOwnTurnSettled}. F1.528 — `bound` is its timer. */
  private runtimeOwnTurn: ClaudeRuntimeOwnTurn | null = null;

  /**
   * F1.540 — `chatImpl`'s wait on a running own turn, just before its slot would open. It ends when that turn settles
   * (its `result` wherever routed, the child's death, F1.528's bound) or when a Stop lands: {@link interruptLiveTurn}
   * wakes it, and the Stop is then honoured exactly as one that landed in `ensureLiveSession` — the turn is never
   * written. The child's own turn is not the Stop's: it is not interrupted here, and ends on its own `result`.
   *
   * If the HOST tore the session down meanwhile ({@link endLiveSession} bumps the generation: a kill, a dispose), the
   * turn does not start either — it fails with the `AbortError` an open slot gets there, rather than respawning a
   * child the host has just ended. A child that died on its OWN is not that (the reader's settlement bumps nothing):
   * the caller ensures the session again, as any next turn would.
   */
  private async waitOutRuntimeOwnTurn(ownTurn: Promise<void>): Promise<void> {
    const generation = this.liveGeneration;
    this.debug('A host turn waits for the turn the child opened itself to end before opening its slot');
    const stopped = new Promise<void>(resolve => { this.wakeRuntimeOwnTurnWait = resolve; });
    try {
      await Promise.race([ownTurn, stopped]);
    } finally {
      this.wakeRuntimeOwnTurnWait = null;
    }
    if (this.liveGeneration !== generation) {
      throw new AbortError('Claude session ended while this turn waited for the turn Claude Code had opened itself');
    }
  }

  /** F1.540 — wakes {@link waitOutRuntimeOwnTurn} for a Stop; `null` while no turn is waiting. */
  private wakeRuntimeOwnTurnWait: (() => void) | null = null;

  /**
   * F1.528 — how long a pending own turn is trusted to report its end, from its `init`. Production takes
   * {@link CLAUDE_RUNTIME_OWN_TURN_BOUND_MS}; a test shortens it, as the card deadline's `budgetMs` is shortened.
   */
  private runtimeOwnTurnBoundMs = CLAUDE_RUNTIME_OWN_TURN_BOUND_MS;

  /**
   * F1.509 — called for every message routed with no slot open: a slot-less `init` opens the own turn. (Its end — a
   * `result` anywhere — is settled above the slot guard in {@link routeLiveMessage} since F1.528.)
   *
   * F1.524 (1) (origin WJ-am P-WJ-am-1) — and a slot-less `task_notification` EXPECTS it. That message is a background
   * task's terminal one (`sdk.d.ts`, `SDKTaskNotificationMessage`: completed, failed or stopped), and the CLI opens its
   * own turn to hand it to the model some tens of milliseconds later: 61 / 17 / 17 ms on the vendored 2.1.251
   * (WJ-am's rig), 54 / 21 / 80 / 53 / 97 ms on 2.1.267 (WJ-bb's, two `completed`, three `stopped` by `Query.stopTask`)
   * — eight of eight followed by a turn. Marking only at the `init` left that gap open to F1.540's gate. The expectation is
   * the SAME promise the turn then settles, so a host already waiting on it keeps waiting, and it is BOUNDED by
   * {@link CLAUDE_RUNTIME_OWN_TURN_START_BOUND_MS}: if no `init` follows, it releases itself (and says so in the debug
   * log), so a wrong guess costs a send at most that long. F1.528's long bound starts at the `init`, as it always did.
   */
  private trackRuntimeOwnTurn(message: SDKMessage): void {
    const type = (message as { type?: string }).type;
    const subtype = (message as { subtype?: string }).subtype;
    const init = type === 'system' && subtype === 'init';
    const taskEnded = type === 'system' && subtype === 'task_notification';
    if (!init && !taskEnded) return;
    const pending = this.runtimeOwnTurn;
    if (pending) {
      if (init && !pending.started) this.startRuntimeOwnTurn(pending);
      else if (taskEnded) this.oweRuntimeOwnTurn(pending); // F1.597 — expected or running, each is owed its own turn
      return;
    }
    let settle!: () => void;
    const settled = new Promise<void>(resolve => { settle = resolve; });
    const turn: ClaudeRuntimeOwnTurn = { settled, settle, bound: null, started: false, owed: 0 };
    this.runtimeOwnTurn = turn;
    if (init) {
      this.startRuntimeOwnTurn(turn);
      return;
    }
    turn.bound = setTimeout(() => this.releaseExpectedRuntimeOwnTurn(turn), this.runtimeOwnTurnStartBoundMs);
    (turn.bound as { unref?: () => void }).unref?.();
    this.debug('A background task ended between turns; the child is expected to open a turn of its own to deliver it, and the host queues sends until that turn settles');
  }

  /** F1.524 (1) — the own turn's `init` arrived: F1.528's bound runs from here, as it always did. */
  private startRuntimeOwnTurn(turn: ClaudeRuntimeOwnTurn): void {
    turn.started = true;
    if (turn.bound) clearTimeout(turn.bound);
    turn.bound = setTimeout(() => this.expireRuntimeOwnTurn(turn), this.runtimeOwnTurnBoundMs);
    (turn.bound as { unref?: () => void }).unref?.();
    this.debug('The child opened a turn of its own (no host turn open); the host queues sends until it settles');
    this.reportRuntimeOwnTurn('running'); // F1.524 (2)
  }

  /** F1.524 (1) — no `init` followed the notification within the start bound: stop holding sends for a turn that did not come. */
  private releaseExpectedRuntimeOwnTurn(turn: ClaudeRuntimeOwnTurn): void {
    if (this.runtimeOwnTurn !== turn || turn.started) return;
    this.debug(`No turn of its own followed a background task's end within ${this.runtimeOwnTurnStartBoundMs} ms; sends are no longer held for one`);
    this.settleRuntimeOwnTurn();
  }

  /**
   * F1.597 (origin WJ-bb P-WJbb-2) — a background task that ends while the child's own turn is pending is answered in a
   * turn of its own AFTER that one: measured on 2.1.267 (WJ-bv's rig), the second turn's slot-less `init` came 0–9 ms
   * after the first turn's `result`, and the marker was `null` in between — a host turn reaching F1.540's check there
   * wrote into it, and the second own turn landed in the host's slot (the pre-F1.509 slip). That held whether the second
   * notification arrived while the first turn RAN (26–89 ms after its `init`, six arms) or before its `init`, while it
   * was only expected (arm `two-bg-gap10`: 6 ms after the first notification, and the first turn still carried one task
   * only). So every such notification is COUNTED here, and {@link endRuntimeOwnTurnAtResult} turns the first turn's
   * `result` into the SAME promise's expectation of the next.
   */
  private oweRuntimeOwnTurn(turn: ClaudeRuntimeOwnTurn): void {
    turn.owed += 1;
    this.debug('A background task ended during the turn the child opened itself; a turn of its own is expected after it');
  }

  /**
   * F1.597 — a `result` ends the own turn (F1.528: wherever routed). With a task owed ({@link oweRuntimeOwnTurn}) the
   * turn is not settled: it reports `ended` (F1.524 (2)'s seam saw one turn end) and becomes EXPECTED again under
   * F1.524 (1)'s start bound, so a host already waiting keeps waiting — and `SessionManager`'s replay, armed on this
   * promise, does not fire into the gap. RESIDUE, measured and stated: when the first turn made another request after
   * the notification (a tool call, arm `two-bg-tool`), the CLI FOLDED the task into it and no second turn followed;
   * nothing the SDK emits says so, so that case costs a queued send the start bound
   * ({@link CLAUDE_RUNTIME_OWN_TURN_START_BOUND_MS}), after which the expectation releases itself as F1.524 (1)'s does.
   */
  private endRuntimeOwnTurnAtResult(): void {
    const turn = this.runtimeOwnTurn;
    if (!turn?.started || turn.owed === 0) {
      this.settleRuntimeOwnTurn();
      return;
    }
    turn.owed -= 1;
    turn.started = false;
    if (turn.bound) clearTimeout(turn.bound);
    turn.bound = setTimeout(() => this.releaseExpectedRuntimeOwnTurn(turn), this.runtimeOwnTurnStartBoundMs);
    (turn.bound as { unref?: () => void }).unref?.();
    this.reportRuntimeOwnTurn('ended');
    this.debug('The turn the child opened itself ended with a background task still owed; the host keeps queueing sends for the next');
  }

  /** F1.524 (1) — {@link CLAUDE_RUNTIME_OWN_TURN_START_BOUND_MS}; a test shortens it, as it shortens the long bound. */
  private runtimeOwnTurnStartBoundMs = CLAUDE_RUNTIME_OWN_TURN_START_BOUND_MS;

  /**
   * F1.528 — the bound fired: the own turn reported no end within {@link CLAUDE_RUNTIME_OWN_TURN_BOUND_MS}. It is
   * settled so a host waiting on it (`SessionManager.replayQueueWhenRuntimeTurnSettles`) replays its queue. With no
   * host turn open the user is told why, at the start of the turn that now runs without waiting (the notice channel
   * defers a line raised between turns to the next turn); with one open, the host turn owns the boundary and nothing
   * waited on the own turn, so only the debug log records it.
   */
  private expireRuntimeOwnTurn(turn: ClaudeRuntimeOwnTurn): void {
    if (this.runtimeOwnTurn !== turn) return;
    const slot = this.openSlot;
    if (slot && !slot.settled) this.debug(`${RUNTIME_OWN_TURN_BOUND_NOTICE} (a host turn is open; not surfaced)`);
    else this.queueDegradationNotice(RUNTIME_OWN_TURN_BOUND_NOTICE);
    this.settleRuntimeOwnTurn();
  }

  /** F1.509 — idempotent: settles the pending own turn, if any, and forgets it (and, F1.528, its bound). */
  private settleRuntimeOwnTurn(): void {
    const turn = this.runtimeOwnTurn;
    this.runtimeOwnTurn = null;
    if (turn?.bound) clearTimeout(turn.bound);
    turn?.settle();
    if (turn?.started) this.reportRuntimeOwnTurn('ended'); // F1.524 (2) — an expected turn that never started reports nothing
  }

  /**
   * F1.524 (2) (origin WJ-am P-WJ-am-2) — THE HOST'S BUSY SEAM FOR THE CHILD'S OWN TURN. Told `running` when a turn the
   * child opened itself starts (its `init`) and `ended` when it settles — its `result`, the child's death, a teardown,
   * F1.528's bound. Structural, like {@link onSubagentEnded}: the host sets it, because it imports no backend class.
   * While that turn runs nothing else the host reads says a turn is running ({@link isProcessing} is slot-based), so
   * the session looked idle; and since F1.511 the turn's `tool_start` rows cross the between-turns door and raise the
   * renderer's busy state with nothing to lower it. `SessionManager` turns these two calls into the renderer's.
   */
  onRuntimeOwnTurn?: (phase: 'running' | 'ended') => void;

  /** F1.524 (2) — {@link onRuntimeOwnTurn}, fail-soft: it runs inside the reader and the teardown paths. */
  private reportRuntimeOwnTurn(phase: 'running' | 'ended'): void {
    try { this.onRuntimeOwnTurn?.(phase); } catch (error) {
      this.debug(`onRuntimeOwnTurn(${phase}) threw: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * F1.524 (2) — the user's Stop for a turn the child opened ITSELF. `SessionManager.cancelProcessing` returns at once
   * when no host turn runs, and {@link interruptLiveTurn} has nothing to interrupt without a slot; so a Stop pressed
   * while the CLI answers a background task's end reached nothing. This sends the SDK's turn-scoped cancel,
   * `Query.interrupt()` ("Only available in streaming input mode"), with no slot open: the turn ends on its own
   * `result`, which settles the marker and reports `ended`. Returns whether it was sent — `false` with no own turn
   * running (an EXPECTED one included: there is nothing to stop yet), and `false` while a host slot is open, because a
   * Stop there is the host turn's and takes that path.
   */
  interruptRuntimeOwnTurn(): boolean {
    const live = this.currentQuery;
    const slot = this.openSlot;
    if (!this.runtimeOwnTurn?.started || !live || (slot && !slot.settled)) return false;
    this.debug('Stop during a turn the child opened itself: interrupting it');
    void live.interrupt().catch(error => {
      this.debug(`Own-turn interrupt failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    return true;
  }

  /**
   * Adapt ONE live SDK message into the open turn's slot.
   *
   * This is the body of what used to be `chatImpl`'s inline `for await`. Nothing
   * about the per-message handling changed; what changed is where the events go
   * (`slot.push` instead of `yield`) and what the per-turn state hangs off (the
   * slot instead of the loop's locals), because the loop is now shared by every
   * turn in the session and a local would be a leak.
   */
  private async routeLiveMessage(message: SDKMessage): Promise<void> {
    // P6.263 — the child's PROTOCOL capabilities, ABOVE the slot guard because
    // this is a per-CHILD fact and not a turn's news: an `init` that arrives
    // with no slot open (a respawn between turns) is routed to
    // `noteBetweenTurnsMessage` and would otherwise be dropped, leaving the
    // session advertising the previous child's answer.
    //
    // `sdk.d.ts` (`capabilities?: string[]`): "Protocol capabilities this CLI
    // supports, so SDK consumers can feature-detect instead of version-sniffing.
    // Open set — ignore unknown values … Absent on older CLIs." Unknown names
    // are KEPT verbatim for exactly that reason: ignoring is the CONSUMER's job,
    // and filtering here would hide a name a later reader understands.
    //
    // Re-read on every init rather than latched, because a respawn can be onto a
    // different CLI build. A frame carrying NO array leaves the previous answer
    // alone: "this message had no field" is not "the child has none".
    this.captureAdvertisedProtocolCapabilities(message);
    this.captureChildApiKeySource(message);
    this.captureChildAnalyticsDisabled(message);
    this.noteSubagentEnded(message); // F1.475 — a subagent can end while no turn is open; see noteSubagentEnded
    // F1.528 — a `result` ends the turn the child was running WHEREVER it is routed: a host write the CLI FOLDED into
    // its own turn earns ONE result, and it lands in the host's slot (measured; see runtimeOwnTurnSettled).
    if ((message as { type?: string }).type === 'result') this.endRuntimeOwnTurnAtResult(); // F1.597 — or owe the next

    const slot = this.openSlot;
    if (!slot || slot.settled) {
      this.trackRuntimeOwnTurn(message); // F1.509 — a turn the child opened itself; see runtimeOwnTurnSettled
      await this.noteBetweenTurnsMessage(message);
      return;
    }
    // Track if we got any text content from assistant
    if ('type' in message && message.type === 'assistant' && 'message' in message) {
      const assistantMsg = message.message as { content?: unknown[] };
      if (assistantMsg.content && Array.isArray(assistantMsg.content) && assistantMsg.content.length > 0) {
        slot.receivedAssistantContent = true;
      }
    }
    // Also track text_delta events as assistant content (nested in stream_event)
    if ('type' in message && message.type === 'stream_event' && 'event' in message) {
      const event = (message as { event: { type: string } }).event;
      if (event.type === 'content_block_delta' || event.type === 'message_start') {
        slot.receivedAssistantContent = true;
      }
    }

    // The conversation the live child is actually holding. Read by
    // `ensureLiveSession` to decide whether the next turn's resume anchor is
    // already satisfied by the running process — without it, turn two of every
    // session would look like an option drift and respawn.
    if ('session_id' in message && typeof message.session_id === 'string' && message.session_id) {
      this.liveObservedSessionId = message.session_id;
      // T2 · the read-back arm, and the type test is the load-bearing half.
      // `session_id` rides EVERY message including the `result` of a resume
      // that failed outright, so confirming on any of them would confirm the
      // failure too; `system`/`init` is the one the child never reaches when
      // the transcript is missing. Above the assignment below because the next
      // statement overwrites the anchor we are comparing against.
      if (message.type === 'system' && (message as { subtype?: string }).subtype === 'init') {
        this.confirmRebuiltTranscriptResume(message.session_id);
      }
    }

    // P6.528 — every MCP server the CLI connected that we did not supply, named
    // on a surface a person reads. The init message is the only place the child
    // ever lists them; `queueDegradationNotice` latches per session, so a
    // respawn does not repeat the line.
    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'init') {
      for (const notice of claudeCliDiscoveredMcpNotice(
        (message as { mcp_servers?: unknown }).mcp_servers,
        this.configuredMcpServerNames,
      )) {
        this.queueDegradationNotice(notice);
      }
    }

    // Capture session ID for conversation continuity (only when it changes)
    if ('session_id' in message && message.session_id && message.session_id !== this.sessionId) {
      this.sessionId = message.session_id;
      // Notify caller of new SDK session ID (for immediate persistence)
      this.config.onSdkSessionIdUpdate?.(message.session_id);
      // Retire in-memory branch fork metadata (persistence handled by callback)
      if (this.branchFromSdkSessionId) {
        debug(`[ClaudeAgent] Branch fork established, retiring in-memory fork metadata`);
        this.branchFromSdkSessionId = null;
        this.branchFromSdkCwd = null;
        this.branchFromSdkTurnId = null;
      }
    }

    // R14 — read the compaction's own numbers off the RAW message, and
    // emit the context refresh, BEFORE the adapter on the next line turns
    // that message into the `Compacted Conversation` banner and throws
    // `compact_metadata` away.
    //
    // Why this is not derived from the turn's own `complete`: measured on
    // the real rig, the `complete` that follows a compaction carries
    // `inputTokens` = the compaction REQUEST's input — the whole
    // pre-compaction conversation that was just summarized — so it is a
    // consumption record, not a context size. `compact_metadata.post_tokens`
    // is the only place the post-compaction context size exists at all.
    //
    // Why it must precede the banner: `SessionManager`'s `info` case
    // pushes a `usage_update` to the renderer from
    // `managed.tokenUsage.inputTokens` at the moment it appends the
    // banner ("Emit usage_update so the context count badge refreshes
    // immediately after compaction"). Landing the real number first is
    // what makes that badge agree with the banner beside it instead of
    // contradicting it.
    //
    // `post_tokens` is OPTIONAL in the SDK's own type. When it is absent
    // no COUNT is emitted — a fabricated context size would be worse than
    // a stale one, because it would look authoritative.
    //
    // F1.240 — the context SNAPSHOT moves at the same boundary. Claude is a
    // `fresh-local` provider since P6.264, so the donut reads ONLY the
    // snapshot, which nothing but `/context` wrote: after a refresh it kept
    // the pre-compaction count, and the host's compaction `info` re-sent it.
    // `claudeContextAfterCompaction` counts `post_tokens` when present and
    // marks the snapshot stale (count unknown) when absent — still no number
    // invented, and the host's `usage_update` case applies it before the
    // banner's re-send reads it.
    const compaction = readPostCompactionTokens(message);
    const compactedContext = claudeContextAfterCompaction(message, this.eventAdapter.getReportedContextWindow());
    if (compaction === null && compactedContext) {
      slot.push({ type: 'usage_update', usage: { contextUsage: compactedContext } });
    }
    if (compaction !== null) {
      // THE REASSERT IS `manual`-ONLY, and the trigger is the whole
      // discriminator. An unconditional one shipped a worse number than
      // the one this row removed — measured in review on the auto shape,
      // truth 52 100 reported as 14 748, a 72% under-report.
      //
      // Why the two triggers need different treatment: on `manual` the
      // turn IS the compaction, so its `complete` reports the compaction
      // REQUEST's input — the whole pre-compaction conversation — and
      // `SessionManager` assigns that into the badge, which is the defect
      // this row exists to fix. On `auto` the boundary arrives MID-turn
      // and the turn CONTINUES, so the final result already reports the
      // compacted conversation plus whatever the model did afterwards:
      // it is the truth, it is later than the boundary, and reasserting
      // over it pins the badge to a size the session has already left.
      //
      // The immediate emission below still fires on BOTH, because it
      // describes the boundary moment and is correct there either way.
      slot.postCompactionContextTokens = compaction.trigger === 'manual'
        ? compaction.postTokens
        : null;
      slot.push({
        type: 'usage_update',
        usage: {
          inputTokens: compaction.postTokens,
          contextWindow: this.eventAdapter.getReportedContextWindow(),
          ...(compactedContext ? { contextUsage: compactedContext } : {}),
        },
      });
    }

    const events = await this.eventAdapter.adapt(message);
    for (const event of events) {
      this.releaseToolHandoffOn(event); // UB2.1 — the handing-off tool's result releases a deferred handoff interrupt

      // After source_test (or any session-scoped tool) successfully activates a
      // new source, activateSourceInSessionFn stashes a restart descriptor on the
      // agent. The drain controller captures the descriptor on the first
      // triggering tool_result and short-circuits per-event handling for any
      // sibling tool_results / synthetic background events in the same
      // adapted batch. The fire (close the slot on source_activated, then
      // interrupt-and-respawn) happens at end-of-batch below, NOT here — see
      // #790 for the symptoms when
      // siblings were dropped.
      if (slot.sourceActivationDrain.observe(event, () => this.consumePendingSourceActivationRestart())) {
        slot.push(event);
        continue;
      }

      // Check for tool-not-found errors on inactive sources and attempt auto-activation
      const inactiveSourceError = this.detectInactiveSourceToolError(event, this.eventAdapter.getToolIndex());

      if (inactiveSourceError && this.onSourceActivationRequest) {
        const { sourceSlug } = inactiveSourceError;

        this.onDebug?.(`Detected tool call to inactive source "${sourceSlug}", attempting activation...`);

        try {
          const activated = await this.onSourceActivationRequest(sourceSlug);

          if (activated) {
            this.onDebug?.(`Source "${sourceSlug}" activated successfully, interrupting turn for auto-retry`);

            // `source_activated` is the turn's LAST event by contract — the
            // renderer's auto-retry expects no `complete` after it — so it
            // rides the close rather than a push.
            slot.close('source-activated', {
              type: 'source_activated' as const,
              sourceSlug,
              originalMessage: slot.userMessage,
            });

            // End the turn and rebuild the session. L4 measured that the
            // interrupt inside this call never fires HERE — the slot was closed
            // on the line above, so `interruptLiveTurn` returns at
            // `slot.settled` — and that the stated reason for the teardown was
            // wrong; the teardown still stays, for the coalescing reason written
            // out on `endTurnForSourceActivation`.
            this.endTurnForSourceActivation(AbortReason.SourceActivated);
            return;
          } else {
            this.onDebug?.(`Source "${sourceSlug}" activation failed (may need auth)`);
            // Let the original error through, but with more context
            const toolResultEvent = event as Extract<AgentEvent, { type: 'tool_result' }>;
            slot.push({
              type: 'tool_result' as const,
              toolUseId: toolResultEvent.toolUseId,
              toolName: toolResultEvent.toolName,
              result: `Source "${sourceSlug}" could not be activated. It may require authentication. Please check the source status in the sources panel.`,
              isError: true,
              input: toolResultEvent.input,
              turnId: toolResultEvent.turnId,
              parentToolUseId: toolResultEvent.parentToolUseId,
            });
            continue;
          }
        } catch (error) {
          this.onDebug?.(`Source "${sourceSlug}" activation error: ${error}`);
          // Let original error through
        }
      }

      // Reset prerequisite state on compaction (LLM loses guide content)
      if (event.type === 'info' && event.message === 'Compacted Conversation') {
        this.resetPrerequisiteState();
      }

      // Intercept large/binary/media-rich tool results — save assets to disk,
      // preserve original JSON when needed, and/or summarize oversized text.
      // F1.511 — the call itself is `guardToolResultForHost`, shared with the
      // between-turns door (`noteBetweenTurnsMessage`) so both guard alike.
      if (event.type === 'tool_result' && !event.isError && event.result) {
        const guarded = await this.guardToolResultForHost(event, slot.metadataSessionDir);
        if (guarded) {
          // UB1.16 — the summary drops the output text; keep its password-entry lines, which the
          // host needs to redact the stored input (upstream v0.15.1).
          const result = isCanonicalBrowserToolName(event.toolName ?? '') ? keepPasswordEntryLines(event.result, guarded) : guarded;
          slot.push({ ...event, result });
          continue;
        }
      }

      // Suggest CLI tools when Read fails on convertible file types
      if (event.type === 'tool_result' && event.toolName === 'Read' && event.isError && event.result) {
        const filePath = typeof event.input?.file_path === 'string' ? event.input.file_path : undefined;
        if (filePath) {
          const ext = filePath.split('.').pop()?.toLowerCase();
          const hint = ext ? CONVERTIBLE_FILE_HINTS[ext] : undefined;
          if (hint) {
            // Split "or" alternatives into separate backtick-wrapped commands
            const commands = hint.split(' or ').map(cmd => `\`${cmd} "${filePath}"\``).join(' or ');
            slot.push({ ...event, result: `${event.result}\n\nTip: Use ${commands} to convert this file to readable text.` });
            continue;
          }
        }
      }

      // Suppress session-expired errors during resume/fork — don't push
      // them to the turn. The post-slot recovery (wasResuming check)
      // will handle the retry. Without this, the error event reaches the
      // SessionManager which shows it as a toast before recovery runs.
      if (
        slot.wasResuming && !slot.isRetry &&
        event.type === 'error' &&
        'message' in event && typeof event.message === 'string' &&
        event.message.includes('No conversation found with session ID')
      ) {
        debug('[SESSION_DEBUG] Suppressing session-expired error event for recovery:', event.message);
        slot.suppressedSessionExpiredError = true;
        continue;
      }

      // Suppress resumeSessionAt branch-cutoff failures when the requested
      // parent message UUID no longer exists server-side (e.g., compaction/TTL).
      // We'll retry once without resumeSessionAt.
      if (
        slot.attemptedBranchCutoff && slot.wasResuming && !slot.isRetry &&
        event.type === 'error' &&
        'message' in event && typeof event.message === 'string' &&
        event.message.includes('No message found with message.uuid')
      ) {
        debug('[SESSION_DEBUG] Suppressing missing-UUID branch cutoff error for fallback:', event.message);
        slot.suppressedBranchCutoffError = true;
        continue;
      }

      // Also suppress the complete event that follows a suppressed error —
      // recovery will produce its own completion flow.
      if ((slot.suppressedSessionExpiredError || slot.suppressedBranchCutoffError) && event.type === 'complete') {
        debug('[SESSION_DEBUG] Suppressing complete event after suppressed resume/fork error');
        slot.receivedComplete = true; // prevent duplicate complete emission
        // AND THE SLOT STILL CLOSES. Under the old shape the SDK stream ended on
        // its own right after this and the post-loop recovery ran; under a live
        // session the stream does not end, so a suppressed terminal that only
        // `continue`d would leave `chatImpl` waiting forever for a result that
        // already arrived. Suppression is about what the USER sees, never about
        // whether the turn ended.
        slot.close('terminal');
        return;
      }

      if (event.type === 'complete') {
        slot.receivedComplete = true;

        // THE TURN'S TERMINAL EVENT — AND THE SLOT ENDS HERE.
        //
        // Under the old shape the SDK stream itself ended right after a result,
        // so "the loop exited" and "the turn ended" were the same fact. They are
        // not any more: the stream stays open and everything after this belongs
        // to the NEXT turn. The slot is what draws the boundary.
        //
        // R9's compaction drain and R14's context-size correction used to run
        // right here, inline in the read loop. They now run in `chatImpl`, at
        // the consumer's own `complete` — because both nest a whole `chat()`,
        // and a turn started from inside this reader would deadlock: the reader
        // would be waiting on a turn whose events only the reader can deliver.
        // Precondition 3 of L1's review, stated as code.
        //
        // A USER STOP arrives here now, not as an AbortError. `interrupt()` is
        // turn-scoped: the CLI settles the interrupted turn with an ORDINARY
        // result and the session lives on. The old shape had no such event —
        // it aborted the controller, which is session death — so the status
        // banner the user expects has to be produced at this seam instead.
        const interruptedReason = this.lastAbortReason === AbortReason.UserStop
          || this.lastAbortReason === AbortReason.MaxBudgetUsd
          ? this.lastAbortReason
          : null;
        if (interruptedReason !== null) {
          this.lastAbortReason = null;
          // PRECONDITION 1, and it has to hold even if the upstream reports the
          // interrupted turn as a clean success. `BaseAgent.chat`'s pass loop
          // HOLDS BACK a `complete` that carries no `terminalReason` and
          // CONTINUES from it (`base-agent.ts:3789`) — so a reason-free
          // completion after a Stop would RESUME the very turn the user
          // stopped. The adapter already stamps a reason from the SDK's own
          // `terminal_reason`/`is_error`; this is the belt for the case where
          // the CLI says neither, because we asked for the interrupt and
          // therefore know.
          if (!event.terminalReason || (interruptedReason === AbortReason.MaxBudgetUsd && event.terminalReason === 'user_stop')) { // F1.745 — the child's aborted_* names no cause; the host's budget verdict does
            event.terminalReason = interruptedReason === AbortReason.MaxBudgetUsd
              ? 'max_budget_usd'
              : 'user_stop';
          }
          if (interruptedReason === AbortReason.UserStop) {
            slot.push({ type: 'status', message: 'Interrupted' });
          }
        }
        this.reconcileDeferredToolCall(event);
        slot.close('terminal', event);
        return;
      }
      slot.push(event);
    }

    // End-of-batch fire (#790): if the drain controller captured a
    // pending source-activation restart while iterating this adapted
    // SDK message, all sibling tool_results / interleaved synthetic
    // events have now been pushed. Emit `source_activated` and respawn.
    const sourceActivationFire = slot.sourceActivationDrain.shouldFireAtBoundary();
    if (sourceActivationFire) {
      this.onDebug?.(`source_test activated "${sourceActivationFire.sourceSlug}", drained sibling tool_results, restarting turn`);
      // `source_activated` is the turn's LAST event by contract — no `complete`
      // follows it — so it rides the close rather than a push.
      slot.close('source-activated', sourceActivationFire);
      // Rebuild the session. The old note here — "the SDK has three setters and
      // none of them is this one" — is refuted: `Query.setMcpServers` exists and
      // is what `applyLiveSettings` uses between turns. The teardown remains
      // because THIS site cannot use it safely; the reason is on
      // `endTurnForSourceActivation`.
      this.endTurnForSourceActivation(AbortReason.SourceActivated);
      return;
    }  }

  /**
   * Cancel the IN-FLIGHT TURN and keep the session.
   *
   * `abort()` is not this. Proven from the SDK's own source — the abort handler
   * is `() => this.close()`, and `close()` ends stdin then SIGTERMs — and
   * measured against a fake child: stdin ends in 20 ms, SIGTERM at ~2.4 s. Under
   * one query per agent that is SESSION DEATH, so every non-death caller had to
   * stop using it. `Query.interrupt()` is the turn-scoped cancel, documented
   * "Only available in streaming input mode", and its receipt "arrives before
   * the interrupted turn's SDKResultMessage" — so the slot settles on a NORMAL
   * terminal event and the child is untouched (the discriminating control: a
   * second turn runs on the same process afterwards).
   *
   * The UI cleanup below is precondition 2 of L1's review, and it was a real
   * hole: `forceAbort` cancels pending permission cards and the model's own
   * question, and NO turn-end or Stop path performed either. A Stop that leaves
   * a permission card on screen — with a promise nobody will ever resolve — is a
   * regression, and moving Stop off `forceAbort` would have introduced it.
   */
  private interruptLiveTurn(reason: AbortReason): void {
    const live = this.currentQuery;
    const slot = this.openSlot;

    // The UI cleanup is UNCONDITIONAL. A pending permission card or an
    // unanswered model question holds a promise the SDK may be blocked on, and a
    // Stop must release it whether or not a turn is currently open — the cost of
    // clearing nothing is nothing, and the cost of leaving one is a card on
    // screen nobody can dismiss.
    const refusedCards = [...this.pendingPermissions.keys()]; // F1.954 — read before the cancel settles them
    this.cancelTurnScopedUi('The turn was stopped before the question was answered.');
    this.reportStopRefusedCards(refusedCards);

    // A Stop during turn PREPARATION is remembered rather than dropped. There is
    // no slot yet and nothing written, so there is nothing to interrupt — but
    // `chatImpl` is about to start a turn the user has already stopped, and
    // without this it would run to completion. Checked immediately after the
    // await that opened the window.
    if (this.turnPreparing) {
      this.stopRequestedWhilePreparing = true;
      // UB2.2 — the stop's reason is recorded even though there is no live turn to
      // interrupt: the prepared turn's AbortError path reads it for the "Interrupted"
      // status. The outer AbortError arm clears it in the same turn, so it cannot
      // stamp a later completion (the D1 defect recorded below stays closed).
      this.lastAbortReason = reason;
      this.wakeRuntimeOwnTurnWait?.(); // F1.540 — a turn waiting out the child's own turn hears it now, not at its end
    }

    // EVERYTHING BELOW NEEDS A TURN, and `lastAbortReason` most of all.
    // It used to be recorded before this check, and the reader consumes it at
    // whatever completion comes NEXT — so a Stop pressed BETWEEN turns stamped
    // `terminalReason: 'user_stop'` and an "Interrupted" status onto a message
    // the user never stopped. Measured in review, and the window is not
    // theoretical: `SessionManager.cancelProcessing` gates on `isProcessing`,
    // which stays true while a completion is being processed and across the
    // skill continuation, and both of those run with no slot open.
    if (!live || !slot || slot.settled) return;

    this.lastAbortReason = reason;

    // P6.263 — read, not assumed. See `childAdvertisesInterruptReceipt`.
    // D1.362 — and said where the reader of a Stop LOOKS, not only in the host
    // log a developer tails. See `noteInterruptSeam`.
    this.noteInterruptSeam(
      `Claude turn interrupt (${reason}); child ${this.childAdvertisesInterruptReceipt() ? 'advertises' : 'does NOT advertise'} `
      + `interrupt_receipt_v1 (capabilities: ${this.advertisedProtocolCapabilities.join(', ') || 'none'})`,
    );
    // D1.361 — the receipt is READ rather than discarded. `void … .catch(…)`
    // threw away the one answer the child gives about what its Stop did, which
    // is why a live drive could report nothing about `still_queued` at all. This
    // is a READING and not a branch: nothing here decides anything on it, which
    // is exactly the line `childAdvertisesInterruptReceipt`'s docblock draws.
    void live.interrupt().then(receipt => {
      this.noteInterruptSeam(
        receipt === undefined
          ? `Claude turn interrupt receipt (${reason}): none — this child answers the older empty success`
          : `Claude turn interrupt receipt (${reason}): still_queued=[${receipt.still_queued.join(', ')}]`
            + (receipt.cancelled ? `, cancelled=[${receipt.cancelled.join(', ')}]` : ''),
      );
    }).catch(error => {
      this.noteInterruptSeam(`Claude turn interrupt failed: ${error instanceof Error ? error.message : String(error)}`);
    });

    // THE DEADLINE, and it is restoring a guarantee rather than adding caution.
    // Before one query per agent, a Stop was `abort()` → the SDK's own
    // `() => this.close()` → stdin EOF, then SIGTERM ~2 s later: a Stop ALWAYS
    // ended the turn within a bound, whatever the child was doing. `interrupt()`
    // is a control request over stdin, so a wedged child simply never answers it
    // — measured in review, a fake CLI that acks the interrupt and then emits
    // nothing left the turn unsettled past the probe's bound, while the same
    // script settled under the old abort. Without this the user's Stop can hang
    // forever, which is worse than what it replaced and is the outcome this plan
    // forbids by name.
    //
    // The escalation is session death on purpose: the child has already proven
    // it is not answering its control channel, so there is nothing gentler left.
    const deadlineMs = this.interruptDeadlineMs;
    const deadline = setTimeout(() => {
      if (this.openSlot !== slot || slot.settled) return;
      this.debug(`Claude turn did not settle ${deadlineMs}ms after interrupt — ending the session`);
      this.killLiveSession(reason);
    }, deadlineMs);
    // Never hold the process open for a timer whose only job is a backstop.
    (deadline as unknown as { unref?: () => void }).unref?.();
    slot.onSettled(() => clearTimeout(deadline));
  }

  /**
   * D1.362 — one observation about a Stop, written to BOTH places, because
   * neither alone reaches the reader who needs it.
   *
   * ## The defect, and the premise it corrects
   *
   * The line this replaces went through `this.debug(…)` alone. That is not
   * nowhere — `BaseAgent.debug` calls `onDebug`, which `SessionManager` wires (at
   * its one wiring site) to `sessionLog.info`, i.e. the platform log a packaged
   * build writes in debug mode. It is simply not where the question gets asked.
   * A reader investigating a Stop that behaved oddly opens this session's
   * RUNTIME diagnostic, and the seam line scored **0** there on both arms of
   * RS-81 (2026-09-18, packaged 1.40.0) while the file itself grew 214 → 319 and
   * 214 → 246 lines in the same window, so the reader's own control said the
   * channel was live.
   *
   * The row's stated fix — *"route it where the per-session runtime diagnostic
   * goes"* — cannot be taken literally on this runtime, and that is a measured
   * correction rather than a preference: `<config>/logs/runtime/<id>-claude.txt`
   * is host-NAMED and child-WRITTEN. `applySessionDiagnosticLog` (`options.ts`)
   * only sets `DEBUG_SDK=1` and points `CLAUDE_CODE_DEBUG_LOGS_DIR` at it; every
   * byte in it comes from the vendored binary. Appending host lines into it
   * would give one file two unsynchronised writers and destroy the one property
   * a diagnostic has — that a reader can tell who said what. So the host's half
   * goes to a `-host` sibling in the same directory under the same naming rule
   * ({@link appendSessionRuntimeHostNote}), and `this.debug` stays beside it so
   * nothing that reads the host log today loses a line.
   *
   * Same posture as the rest of that directory: written only while the host is
   * in debug mode ({@link isDebugEnabled}, the one switch `--debug`/`NESSY_DEBUG`
   * already sets), so an ordinary session writes no new file. `config.session?.id`
   * is the HOST session id — the id `applySessionDiagnosticLog` names the
   * neighbouring file with, so the two land side by side; `modeSessionId` is
   * deliberately not used, because its `temp-${Date.now()}` fallback would
   * scatter one session's notes across files.
   *
   * ## The product posture on a queued message, stated (D1.361)
   *
   * **Stop stops the running turn. A message queued behind it stays queued,
   * stays visible, and is delivered only when the user resumes the queue or
   * sends again.** That is what the host already implements and it is
   * runtime-uniform by construction: the queue is
   * `SessionManager.messageQueue`, `cancelProcessing` sets `queuePaused` on it,
   * and Pi, codex and claude all sit behind that same one. Nothing here changes
   * it.
   *
   * **`cancel_queued: true` is therefore DECLINED, deliberately, and the refusal
   * is the interesting half.** It is buildable: the vendored child advertises
   * `interrupt_cancel_queued_v1`, and although `sdk.d.ts` declares
   * `interrupt()` with NO parameter at 0.3.251 (and at 0.3.247), the shipped
   * `sdk.mjs` implements `interrupt(e)` and maps `{ cancelQueued: true }` onto
   * the wire's `cancel_queued` — the bundle leading its own typing, which
   * `claude-turn-cancel-contract.test.ts` drives against the real SDK. It is
   * refused because it would cancel nothing HERE: that flag names messages the
   * CHILD holds, and this product never gives the child one while a turn is in
   * flight. `'queue'` skips `redirect()` entirely and parks the message on the
   * host; `'steer'` on this backend queues the text on `pendingSteers`, which the
   * next PreToolUse answer carries as `additionalContext`. The only write into the live
   * input channel is `chatImpl`'s own turn-opening message. So `still_queued` is
   * structurally always empty here, and sending the flag would advertise a
   * coverage this product does not have while cancelling nothing. If a future
   * change ever writes an async user message into a live session, this is the
   * comment that becomes wrong, and the receipt logged above is what will say so.
   */
  private noteInterruptSeam(note: string): void {
    this.debug(note);
    appendSessionRuntimeHostNote('claude', this.config.session?.id, note, isDebugEnabled());
  }

  /**
   * A source just became active mid-turn, so this turn is over and the next one
   * needs tools the child does not have yet.
   *
   * ## Two corrections L4 measured here, and why the behaviour still did not change
   *
   * **The stated reason was wrong.** L2 wrote that the teardown is needed
   * "because the MCP server set is a CONSTRUCTION option with no live
   * equivalent". `Query.setMcpServers` IS that equivalent, on both halves we
   * ship. So this is no longer the ONLY way to give a session a new server set —
   * `applyLiveSettings` does it between turns, which is where the Sources panel
   * changes arrive.
   *
   * **The interrupt was already inert HERE, and is left exactly as it was.**
   * Every caller runs `slot.close('source-activated', …)` on the line above —
   * `source_activated` is the turn's last event by contract — and
   * `interruptLiveTurn` returns at `slot.settled` without sending anything.
   * Measured on the real path in `claude-live-settings.test.ts`: zero interrupts
   * reach the child. So L2's "the interrupt lets the CLI end its own turn
   * instead of being SIGTERMed mid-tool" does not happen, and this method is in
   * practice the teardown alone.
   *
   * **The teardown STAYS, deliberately.** Making this site live would mean
   * leaving a child that is still unwinding an interrupted turn and then writing
   * the renderer's auto-retry into the same channel — and a message arriving
   * while a turn is in flight is the condition L0's review reproduced
   * COALESCING under, on the first try. The teardown is the only hard bound on
   * the old turn we have, and buying one avoided respawn with a coalescing risk
   * that cannot be measured without a live rig is the wrong trade. The between-
   * turns path gets the live reconciliation; this one keeps its bound.
   */
  private endTurnForSourceActivation(reason: AbortReason): void {
    this.interruptLiveTurn(reason);
    this.endLiveSession(reason);
  }

  /**
   * End the live session.
   *
   * EOF first (`input.end()`) — that is the child's own exit signal and the
   * reaper's lever, measured in L0 to kill the child within 1.5 s in every arm.
   * The abort follows as the guarantee, because a child that ignores EOF must
   * still not outlive its agent.
   *
   * P2.347 — THE THIRD DISPOSAL PATH, and the one with the worst failure mode of
   * the three. `destroy()` (P2.333) and `disposeForRestart()` (above, on the
   * other backends) are two teardown sequences with different names; this is the
   * third, reached from `abort()`, `endTurnForSourceActivation` and every
   * non-interrupting `forceAbort` reason — and `SessionManager` calls
   * `forceAbort(AbortReason.InternalError)` at four sites. (`close()` was a
   * fourth entry until P2.362 deleted it; see `abort()` for why that one went
   * and this one could not.)
   *
   * MEASURED before the fix, with a throwing `liveInput.end()`: `forceAbort`
   * threw SYNCHRONOUSLY into its caller (so unlike `disposeForRestart` this one
   * really does take the caller down), the query controller was never aborted —
   * leaving the SDK's native child alive after EOF had failed — and the orphaned
   * slot was never failed, so `chatImpl` waited on a slot nothing would ever
   * settle. A HANG, not a leak.
   *
   * The references are captured and the fields nulled BEFORE the three foreign
   * calls, which is what makes each step's failure survivable: the agent is
   * already in its post-teardown state, so a retry or a re-entry during
   * `input.end()` cannot see a half-torn session. EOF still precedes the abort.
   */
  private endLiveSession(reason: AbortReason): void {
    // The bump comes first, so the reader's own settlement is silenced and
    // cannot race this one. That makes THIS method responsible for the open
    // turn — see the fail below, without which a `forceAbort` would leave
    // `chatImpl` waiting on a slot nothing will ever settle.
    this.liveGeneration += 1;
    this.settleRuntimeOwnTurn(); // F1.509 — its reader is silenced by the bump above, so it is settled here
    this.endBetweenTurnsToolRows(); // F1.524 (3) — the tool rows its own turn left open end with it
    const orphaned = this.openSlot;
    const endingInput = this.liveInput;
    const endingController = this.currentQueryAbortController;
    this.liveInput = null;
    this.liveSignature = null;
    this.liveSettings = null;
    this.liveResumeAnchor = null;
    this.liveObservedSessionId = null;
    this.currentQueryAbortController = null;
    this.currentQuery = null;
    this.runTeardownStep('claude live input EOF', () => endingInput?.end());
    this.runTeardownStep('claude query abort', () => endingController?.abort(reason));
    // An `AbortError` and not a plain close, because that is exactly what the
    // aborted stream used to throw into `chatImpl`'s `catch (sdkError)`. Every
    // arm there — the silent Redirect, the "Interrupted" status on a UserStop,
    // the first-message sessionId clearing — keys off that type and off
    // `lastAbortReason`, and all of it keeps working unchanged.
    if (orphaned && !orphaned.settled) {
      this.runTeardownStep('claude orphaned turn slot', () =>
        orphaned.fail(new AbortError(`Claude session ended: ${reason}`)));
    }
  }

  /**
   * Cancel every piece of UI that belongs to the turn being torn down.
   *
   * Extracted from `forceAbort` so the INTERRUPT path performs it too. A card on
   * screen belongs to the turn it was raised in, and its promise is one the SDK
   * may be blocked on; leaving it behind on a Stop is precondition 2.
   *
   * P2.347 — step-isolated for that same reason one level down: the two calls
   * settle promises the SDK and the renderer are blocked on, and if the first
   * throws the second is the one that never runs. `cancelPendingPermissions`
   * skipped is exactly the "no control_response … the tool stays blocked
   * indefinitely" case its own docstring warns about.
   */
  private cancelTurnScopedUi(questionReason: string): void {
    // F1.238 — accepted steers are NOT cleared here any more: a Stop or a kill
    // used to drop them without `steer_undelivered`, so the message stayed
    // marked delivered and was never sent. The host takes them first
    // (`takePendingSteers`); anything it did not is handed back by the turn's
    // own `finally`, or by the next turn's first statement.
    this.runTeardownStep('claude model questions cancel', () => this.modelQuestionAsk.cancelAll(questionReason));
    this.runTeardownStep('claude pending permissions cancel', () => this.cancelPendingPermissions());
  }

  // formatSourceState() and getAuthToolName() are now delegated to this.sourceManager

  // buildRecoveryContext() is now inherited from BaseAgent
  // formatWorkspaceCapabilities() is now in PromptBuilder

  /**
   * Build a simple text prompt with embedded text file contents (for text-only messages)
   * Prepends date/time context for prompt caching optimization (keeps system prompt static)
   * Injects session state (including mode state) for every message
   */
  private buildTextPrompt(text: string, attachments?: FileAttachment[]): string {
    const parts: string[] = [];

    // Add context parts using centralized PromptBuilder
    // This includes: date/time, session state (with plansFolderPath),
    // workspace capabilities, and working directory context
    const textPromptDiagnostics = getPermissionModeDiagnostics(this.modeKey)
    this.debug(
      `[ModeSnapshot] sessionId=${this.modeSessionId} buildTextPrompt mode=${textPromptDiagnostics.permissionMode} ` +
      `modeVersion=${textPromptDiagnostics.modeVersion} changedBy=${textPromptDiagnostics.lastChangedBy} changedAt=${textPromptDiagnostics.lastChangedAt}`
    )
    const contextParts = this.promptBuilder.buildContextParts(
      // P6.704 - the configured `plansDirectory` when set and contained; unset
      // is today's session path byte-for-byte.
      { plansFolderPath: resolvePlansDirectory(this.workingDirectory)
        ?? getSessionPlansDir(this.config.workspace.id, this.modeSessionId) },
      this.sourceManager.formatSourceState()
    );

    parts.push(...contextParts);

    // UB12.21 — the output-style notice, once, right after the context blocks
    // that carry the per-turn style reminder. `buildSDKUserMessage` has the twin.
    const textPromptStyleNotice = this.consumeOutputStyleSwitchNotice();
    if (textPromptStyleNotice) parts.push(textPromptStyleNotice);

    // P6.864 (YES arm) — the note the user attached to an APPROVAL, drained onto
    // the user tail exactly once. Beside `buildContextParts` and never inside
    // it: this drain is the same one-shot contract the mode-change signal has,
    // and `buildSDKUserMessage` below carries the twin. Only ONE of the two
    // composes any given message — they both consume that mode signal, which is
    // documented as once-per-turn — so the queue cannot be drained twice.
    const textPromptAnswerNotes = this.consumePermissionAnswerNotes();
    if (textPromptAnswerNotes) parts.push(textPromptAnswerNotes);

    // D1.216 — the SessionStart hook's own band, after the user's approval note
    // and before the attachments, which is codex's order: the note above is a
    // host relay of the USER's words and must not sit among bytes a hook wrote.
    const textPromptHookContext = this.consumeSessionHookContext();
    if (textPromptHookContext) parts.push(textPromptHookContext);

    // Add file attachments with stored path info (agent uses Read tool to access content)
    // Text files are NOT embedded inline to prevent context overflow from large files
    if (attachments) {
      for (const attachment of attachments) {
        if (attachment.storedPath) {
          let pathInfo = `[Attached file: ${attachment.name}]`;
          pathInfo += `\n[Stored at: ${attachment.storedPath}]`;
          if (attachment.markdownPath) {
            pathInfo += `\n[Markdown version: ${attachment.markdownPath}]`;
          }
          parts.push(pathInfo);
        }
      }
    }

    // Add user's message
    if (text) {
      parts.push(text);
    }

    return parts.join('\n\n');
  }

  /**
   * Build an SDK user message with proper content blocks for binary attachments
   * Prepends date/time context for prompt caching optimization (keeps system prompt static)
   * Injects session state (including mode state) for every message
   */
  /**
   * UB2.11 — the PDF route this session's turns take: native Anthropic Messages on every
   * provider type but `claude-runtime` (no loopback adapter), and on `claude-runtime` only
   * when the model is marked `wire: 'anthropic-messages'` (the same read
   * {@link resolveClaudeHostedWebSearchWithheld} makes from the same two fields). Fails OPEN
   * pre-`postInit` (no adapter resolved yet → native → inline), which is the behaviour a turn
   * in that state had anyway.
   */
  private currentPdfInlineRoute(): { nativeAnthropicMessages: boolean } {
    if (this.claudeRuntimeUpstreamKind === null) return { nativeAnthropicMessages: true };
    return { nativeAnthropicMessages: this.claudeRuntimeWireRouter?.(this._model) !== undefined };
  }

  private buildSDKUserMessage(text: string, attachments?: FileAttachment[]): SDKUserMessage {
    const contentBlocks: ContentBlockParam[] = [];

    // Add context parts using centralized PromptBuilder
    // This includes: date/time, session state (with plansFolderPath),
    // workspace capabilities, and working directory context
    const sdkPromptDiagnostics = getPermissionModeDiagnostics(this.modeKey)
    this.debug(
      `[ModeSnapshot] sessionId=${this.modeSessionId} buildSDKUserMessage mode=${sdkPromptDiagnostics.permissionMode} ` +
      `modeVersion=${sdkPromptDiagnostics.modeVersion} changedBy=${sdkPromptDiagnostics.lastChangedBy} changedAt=${sdkPromptDiagnostics.lastChangedAt}`
    )
    const contextParts = this.promptBuilder.buildContextParts(
      // P6.704 - the configured `plansDirectory` when set and contained; unset
      // is today's session path byte-for-byte.
      { plansFolderPath: resolvePlansDirectory(this.workingDirectory)
        ?? getSessionPlansDir(this.config.workspace.id, this.modeSessionId) },
      this.sourceManager.formatSourceState()
    );

    for (const part of contextParts) {
      contentBlocks.push({ type: 'text', text: part });
    }

    // UB12.21 — the twin of the drain in `buildTextPrompt`.
    const sdkStyleNotice = this.consumeOutputStyleSwitchNotice();
    if (sdkStyleNotice) contentBlocks.push({ type: 'text', text: sdkStyleNotice });

    // P6.864 (YES arm) — the twin of the drain in `buildTextPrompt`; see the
    // note there for why draining in both is not a double consume.
    const sdkAnswerNotes = this.consumePermissionAnswerNotes();
    if (sdkAnswerNotes) contentBlocks.push({ type: 'text', text: sdkAnswerNotes });

    // D1.216 — the twin of the drain in `buildTextPrompt`; see the note there.
    const sdkHookContext = this.consumeSessionHookContext();
    if (sdkHookContext) contentBlocks.push({ type: 'text', text: sdkHookContext });

    // Add attachments - images/PDFs are uploaded inline, text files are path-only
    // Text files are NOT embedded to prevent context overflow; agent uses Read tool
    if (attachments) {
      for (const attachment of attachments) {
        // Add path info text block so the agent knows where the file is stored
        // This enables the agent to use the Read tool to access text/office files
        if (attachment.storedPath) {
          let pathInfo = `[Attached file: ${attachment.name}]\n[Stored at: ${attachment.storedPath}]`;
          if (attachment.markdownPath) {
            pathInfo += `\n[Markdown version: ${attachment.markdownPath}]`;
          }
          contentBlocks.push({
            type: 'text',
            text: pathInfo,
          });
        }

        // Only images and PDFs are uploaded inline (agent cannot read these with Read tool)
        if (attachment.type === 'image' && attachment.base64) {
          const mediaType = this.mapImageMediaType(attachment.mimeType);
          if (mediaType) {
            contentBlocks.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: attachment.base64,
              },
            });
          }
        } else if (attachment.type === 'pdf' && attachment.base64) {
          // UB2.11 (B2 S-04, a silent v0.15.1 change; `agent/pdf-inline.ts`, Apache-2.0):
          // a PDF goes inline only under the size cap AND on a NATIVE Anthropic wire. The
          // Messages API rejects requests over 32 MB and an inline document re-sends every
          // turn; on a TRANSLATED route (the claude-runtime loopback adapter with a model not
          // marked `wire: 'anthropic-messages'`) a `document` block becomes `[document…]`
          // text — the bytes travel and are dropped — so every PDF there goes by the stored
          // path (already added above) with upstream's note.
          if (shouldInlinePdfForRoute(attachment, this.currentPdfInlineRoute())) {
            contentBlocks.push({
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: attachment.base64,
              },
            });
          } else {
            contentBlocks.push({ type: 'text', text: largePdfNote(attachment) });
          }
        }
        // Text files: path info already added above, agent uses Read tool to access content
      }
    }

    // Add user's text message
    if (text.trim()) {
      contentBlocks.push({ type: 'text', text });
    }

    return {
      type: 'user',
      message: {
        role: 'user',
        content: contentBlocks,
      },
      parent_tool_use_id: null,
      // Session resumption is handled by options.resume, not here
      // Setting session_id here with resume option causes SDK to return empty response
      session_id: '',
    } as SDKUserMessage;
  }

  /**
   * Map file MIME types to SDK-supported image types
   */
  private mapImageMediaType(mimeType?: string): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | null {
    if (!mimeType) return null;
    const supported: Record<string, 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'> = {
      'image/jpeg': 'image/jpeg',
      'image/png': 'image/png',
      'image/gif': 'image/gif',
      'image/webp': 'image/webp',
    };
    return supported[mimeType] || null;
  }

  /**
   * Parse actual API error from SDK debug log file.
   *
   * **THE QUOTED LINE NO LONGER EXISTS, measured 2026-09-04 against the shipped
   * 2.1.233 binary.** This docblock used to present
   * `[ERROR] Error in non-streaming fallback: 400 {…}` as the shape being
   * matched; `grep -ac "Error in non-streaming fallback"` over the binary's
   * strings returns **0**, with `API Error` → **13** as the positive control that
   * the probe reads the file and a fabricated string → 0 as the negative. So the
   * reader now matches only whatever OTHER `[ERROR] … {json}` lines the binary
   * still writes, and the example is kept below as history rather than as a
   * claim.
   *
   * It also DISCARDS the numeric status, which is why the 403 branch could never
   * be fed from here; P3.333 took the status from the fetch seam instead. Not
   * deleted: the regex may still match lines this measurement did not enumerate,
   * and removing it would change error mapping with no live arm to check it.
   *
   * Historical shape: `[ERROR] Error in non-streaming fallback: 400 {"type":"error",…}`.
   * These go to the child's own debug file, NOT to stderr — and WHICH file that
   * is is the whole of C3.273: see {@link claudeSessionDebugLogCandidates}. This
   * reader hard-coded the vendor's home-directory default until 2026-09-11, so on
   * every Workspace it found nothing rather than failing, because
   * `buildClaudeSubprocessEnv` gives each Workspace its own `CLAUDE_CONFIG_DIR`
   * and the binary's `configHomeDir()` follows it.
   *
   * Uses async retries with non-blocking delays to handle race condition where
   * SDK may still be writing to the debug file when the error event is received.
   */
  private async parseApiErrorFromDebugLog(): Promise<ClaudeSdkApiError | null> {
    if (!this.sessionId) return null;

    const fs = require('fs');
    // C3.273 — the files the CHILD can actually be writing, derived from the
    // environment the child was given rather than from this process's home
    // directory. `CLAUDE_CONFIG_DIR` is re-derived the way
    // `buildClaudeSubprocessEnv` derives it (from the merged env, so an ambient
    // value in the host's shell cannot put two Workspaces in one directory), and
    // the host-owned per-session file is the second candidate because it is keyed
    // by the HOST session id while this reader holds the SDK's.
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...this.config.envOverrides };
    const workspaceConfigDir = workspaceClaudeConfigDir(childEnv.NESSY_WORKSPACE_ID);
    if (workspaceConfigDir) childEnv.CLAUDE_CONFIG_DIR = workspaceConfigDir;
    const candidates = claudeSessionDebugLogCandidates(childEnv, this.sessionId);

    // Helper for non-blocking delay
    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    // Retry up to 3 times with 50ms delays to handle race condition
    // where SDK emits error event before finishing debug file write
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const debugFilePath = candidates.find((candidate: string) => fs.existsSync(candidate));
        if (!debugFilePath) {
          // No candidate exists yet, wait and retry
          if (attempt < 2) {
            await delay(50);
            continue;
          }
          return null;
        }

        // Read the file and get last 50 lines to find recent errors
        const content = fs.readFileSync(debugFilePath, 'utf-8');
        const lines = content.split('\n').slice(-50);

        // Search backwards for the most recent [ERROR] line with JSON
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i];
          // Match [ERROR] lines containing JSON with error details
          const errorMatch = line.match(/\[ERROR\].*?(\{.*\})/);
          if (errorMatch && errorMatch[1]) {
            try {
              const parsed = JSON.parse(errorMatch[1]);
              if (parsed?.error?.message) {
                return {
                  errorType: parsed.error.type || 'error',
                  message: parsed.error.message,
                  requestId: parsed.request_id,
                };
              }
            } catch {
              // Not valid JSON, continue searching
            }
          }
        }

        // File exists but no error found yet, wait and retry
        if (attempt < 2) {
          await delay(50);
        }
      } catch {
        // File read error, wait and retry
        if (attempt < 2) {
          await delay(50);
        }
      }
    }
    return null;
  }

  /**
   * Pop a recent captured API error, preferring the session-scoped file.
   * Falls back to the legacy global file for backward compatibility.
   */
  private getCapturedApiErrorForSession() {
    // P3.333 — OURS FIRST. This one was recorded by the adapter fetch of THIS
    // agent, so it needs neither a session directory nor the global fallback,
    // and it cannot be another runtime's error. Popped for the same reason the
    // file store pops: an error belongs to one turn.
    const observed = this.takeUpstreamApiError();
    if (observed) return observed;

    const sessionId = this.config.session?.id;
    if (!sessionId) {
      return getLastApiError();
    }

    const sessionDir = getSessionDirPath(this.config.workspace.id, sessionId);
    return getLastApiError(sessionDir) ?? getLastApiError();
  }

  /**
   * Wrap a `fetch` so a non-2xx upstream response leaves its status behind.
   *
   * The STATUS is recorded synchronously, because that is the field the 403
   * branch is gated on and the mapper may read it a few microtasks later. The
   * BODY is filled in best-effort off a clone: an error body is small and
   * non-streaming in practice, but reading it inline would put an await between
   * the upstream response and the SDK child on every failure, so it is not
   * awaited. The branch reads correctly either way — `upstreamReason` is
   * optional there and its absent case has its own sentence.
   *
   * Nothing here may throw or delay a successful turn: `res.ok` is checked
   * first, and every step is inside a `try`.
   */
  private observeUpstreamApiErrors(inner: typeof fetch): typeof fetch {
    const wrapped = async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      const response = await inner(input, init);
      try {
        if (!response.ok) {
          const record: LastApiError = {
            status: response.status,
            statusText: response.statusText ?? '',
            message: '',
            timestamp: Date.now(),
          };
          this.lastUpstreamApiError = record;
          void response.clone().text().then(
            (body) => {
              // Only fill the slot we opened: a later failure must not have its
              // message overwritten by an earlier body arriving late.
              if (this.lastUpstreamApiError === record) {
                record.message = body.slice(0, 2000);
              }
            },
            () => { /* an unreadable error body is not itself an error */ },
          );
        }
      } catch {
        // Observation must never fail a turn.
      }
      return response;
    };
    // Bun's `typeof fetch` carries a `preconnect` member, so a bare async
    // function is not substitutable for it. Forward the wrapped one rather than
    // dropping it: the adapter is handed this object in place of the real fetch.
    return Object.assign(wrapped, {
      preconnect: (inner as { preconnect?: unknown }).preconnect,
    }) as unknown as typeof fetch;
  }

  /** Pop {@link lastUpstreamApiError} if it is recent enough to be about this turn. */
  private takeUpstreamApiError(): LastApiError | null {
    const observed = this.lastUpstreamApiError;
    if (!observed) return null;
    this.lastUpstreamApiError = null;
    // The same five-minute window `getLastApiError` applies, for the same
    // reason: an error older than the turn is a different story.
    if (Date.now() - observed.timestamp >= 5 * 60 * 1000) return null;
    return observed;
  }

  /**
   * Map SDK assistant message error codes to typed error events with user-friendly messages.
   * Merges SDK code with parsed debug errors and interceptor-captured API statuses.
   */
  private async mapSDKErrorToTypedError(
    errorCode: SDKAssistantMessageError
  ): Promise<{ type: 'typed_error'; error: AgentError }> {
    const actualError = await this.parseApiErrorFromDebugLog();
    const capturedApiError = this.getCapturedApiErrorForSession();

    const error = mapClaudeSdkAssistantError(errorCode, {
      actualError,
      capturedApiError,
      providerType: this.config.providerType,
      claudeRuntimeUpstreamKind: this.claudeRuntimeUpstreamKind ?? undefined,
      userTurnHadAttachments: this.lastTurnHadAttachments,
    });

    return {
      type: 'typed_error',
      error,
    };
  }

  /**
   * Check if a tool result error indicates a "tool not found" for an inactive source.
   * This is used to detect when Claude tries to call a tool from a source that exists
   * but isn't currently active, so we can auto-activate and retry.
   *
   * @returns The source slug, tool name, and input if this is an inactive source error, null otherwise
   */
  private detectInactiveSourceToolError(
    event: AgentEvent,
    toolIndex: ToolIndex
  ): { sourceSlug: string; toolName: string; input: unknown } | null {
    if (event.type !== 'tool_result' || !event.isError) return null;

    const resultStr = typeof event.result === 'string' ? event.result : '';

    // Try to extract tool name from error message patterns:
    // - "No such tool available: mcp__slack__api_slack"
    // - "Error: Tool 'mcp__slack__api_slack' not found"
    let toolName: string | null = null;

    // Pattern 1: "No such tool available: {toolName}" or "No tool available: {toolName}"
    // Note: SDK wraps in XML tags like "</tool_use_error>", so we stop at '<' to avoid capturing the tag
    const noSuchToolMatch = resultStr.match(/No (?:such )?tool available:\s*([^\s<]+)/i);
    if (noSuchToolMatch?.[1]) {
      toolName = noSuchToolMatch[1];
    }

    // Pattern 2: "Tool '{toolName}' not found" or "Tool `{toolName}` not found"
    if (!toolName) {
      const toolNotFoundMatch = resultStr.match(/Tool\s+['"`]([^'"`]+)['"`]\s+not found/i);
      if (toolNotFoundMatch?.[1]) {
        toolName = toolNotFoundMatch[1];
      }
    }

    // Fallback: try toolIndex if we couldn't extract from error
    if (!toolName) {
      const name = toolIndex.getName(event.toolUseId);
      if (name) {
        toolName = name;
      }
    }

    if (!toolName) return null;

    // Check if it's an MCP tool (mcp__{slug}__{toolname})
    if (!toolName.startsWith('mcp__')) return null;

    const parts = toolName.split('__');
    if (parts.length < 3) return null;

    // parts[1] is guaranteed to exist since we checked parts.length >= 3
    const sourceSlug = parts[1]!;

    // Check if source exists but is inactive
    const sourceExists = this.sourceManager.getAllSources().some((s) => s.config.slug === sourceSlug);
    const isActive = this.sourceManager.isSourceActive(sourceSlug);

    if (sourceExists && !isActive) {
      // Get input from toolIndex
      const input = toolIndex.getInput(event.toolUseId);
      return { sourceSlug, toolName, input: input ?? {} };
    }

    return null;
  }

  clearHistory(): void {
    this.pauseSteerFifo(); // F1.335 — upstream pauses here too
    // Clear session to start fresh conversation — and (UB12.8) the branch fork anchor: only the child's first session_id retires it, so a /clear before a branch's first ask re-forked the parent and the model saw the cleared history (codex F1.1278, host F1.1290)
    this.sessionId = null; this.branchFromSdkSessionId = null; this.branchFromSdkCwd = null; this.branchFromSdkTurnId = null;
    // Clear pinned state so next chat() will capture fresh values
    this.pinnedPreferencesPrompt = null;
    this.pinnedIncludeCoAuthoredBy = null;
    this.preferencesDriftNotified = false;
    // Base resets too (usage tracker, pinned capability delivery, prerequisite
    // read state, skill invocations) — this override historically skipped them,
    // so a /clear left the shared per-conversation state behind (f074).
    super.clearHistory();
  }

  /**
   * F1.540 — `AgentBackend.redirectFallbackInterruptsTurn`, answered for the `redirect` call just made (the host reads
   * it synchronously after a `false`, in the same stretch of `sendMessage`). `false` when that refusal met a turn
   * still PREPARING, or (F1.487, P-WJqqa-5) a paused FIFO — the pause's own cause, a handoff or the turn's end, is
   * what ends that turn, not this send (a Stop never reaches `redirect`: F1.335 queues, and the Stop stamps on its
   * own); `true` only when it took the abort fallback. Before F1.540 the host read `true` for every refusal.
   */
  redirectFallbackInterruptsTurn(): boolean {
    return this.refusedSteerInterruptedTurn !== false; // unset (no refusal yet) reads as the old `true`
  }

  /** F1.540 — what {@link redirectFallbackInterruptsTurn} answers: the last refused `redirect`'s effect on its turn. */
  private refusedSteerInterruptedTurn = true;

  /**
   * Redirect mid-stream via additionalContext injection.
   * Stores the message; the next PreToolUse hook injects it into the conversation.
   * If no tool call fires before the turn ends, yields steer_undelivered so the
   * session layer can re-queue the message.
   */
  override redirect(message: string, metadata?: RedirectMetadata): boolean {
    // L2 — the gate is the open SLOT, not the live query. `currentQuery` is
    // non-null between turns now, so keying on it would accept a steer with no
    // turn in flight: the message would be parked for a PreToolUse hook that is
    // not going to fire, and `steer_undelivered` would only surface it at the
    // end of the NEXT turn.
    if (!this.openSlot || this.openSlot.settled) {
      // F1.540 — a turn still PREPARING (`ensureLiveSession`, or waiting out the child's own turn) has no slot yet but
      // IS the host's running turn: the abort below is `killLiveSession`, which would end the child — its own turn
      // with it — and fail the turn about to start. Refused without it, the host queues the message after this turn,
      // and {@link redirectFallbackInterruptsTurn} tells it nothing was interrupted.
      if (this.turnPreparing) {
        this.refusedSteerInterruptedTurn = false;
        this.debug('Steer refused: this turn is still preparing (no slot open yet); the host queues it');
        return false;
      }
      // Not actively streaming — fall back to abort + queue
      this.refusedSteerInterruptedTurn = true;
      this.forceAbort(AbortReason.Redirect);
      return false;
    }
    // F1.335 — a PAUSED FIFO accepts nothing (upstream `PendingSteers.enqueue`): its steers
    // were already handed to the host (a Stop, a handoff, the turn's `complete`), so one taken
    // now would ride a dying turn. `false` WITHOUT the abort above: the pause's own cause is
    // already ending the turn, and that abort is `killLiveSession` here (L2).
    if (this.steerFifoPaused) {
      this.refusedSteerInterruptedTurn = false; // F1.487 (P-WJqqa-5) — the handoff or the turn's end ends it, not this send
      this.debug('Steer refused: the steer FIFO is paused (Stop, handoff or take); the host queues it');
      return false;
    }
    this.debug(`Steering mid-stream: "${message.slice(0, 100)}"`);
    // F1.238 — QUEUED, not assigned: a second steer in one turn no longer
    // overwrites the first while both calls answered `true`.
    this.pendingSteers.push({ message, ...(metadata?.messageId === undefined ? {} : { messageId: metadata.messageId }), ...(metadata?.origin === undefined ? {} : { origin: metadata.origin }) });
    return true;
  }

  /**
   * UB6.13 — `AgentBackend.canSteerNow`: would {@link redirect} take a steer into the running
   * turn now, WITHOUT its abort fallback? The same two gates `redirect` passes before it accepts:
   * an open, unsettled slot (a preparing turn has none) and an unpaused steer FIFO (F1.335) —
   * upstream v0.15.1's `currentQuery && currentQueryAbortController && pendingSteers.isAccepting()
   * && !isCompactionInFlight()`, read on our inlined FIFO (upstream's `pending-steers.ts` does not
   * exist here). A bare-prototype rig (no slot) answers `false`.
   */
  canSteerNow(): boolean {
    return !!this.openSlot && !this.openSlot.settled && !this.steerFifoPaused && !this.isCompactionInFlight();
  }

  /**
   * Interrupt the current query because control is being handed to the UI.
   *
   * For Claude, handoff boundaries (auth requests, plan submission) should use
   * the SDK's cooperative interrupt path instead of aborting the underlying
   * AbortController mid-control-write.
   */
  override interruptForHandoff(reason: AbortReason): void {
    this.lastAbortReason = reason;
    this.pauseSteerFifo(); // F1.335 — retained for the host's take, never drained into this turn
    // F1.238 — accepted steers are KEPT for the host, which takes them with
    // `takePendingSteers()` right after this call; clearing them here dropped
    // the user's message with no `steer_undelivered`.

    if (!this.currentQuery) {
      return;
    }

    // UB2.1 (COR-1), ported from craft-agents-oss v0.15.1 `interruptForHandoff` (Apache-2.0).
    // Asked from inside the handing-off tool (SubmitPlan, an auth tool): interrupting before it
    // returns makes the SDK store the call as rejected ("The user doesn't want to proceed with
    // this tool use…"), which the model then takes for the user's refusal. Wait for its result
    // (`releaseToolHandoffOn`), or up to `HANDOFF_RESULT_WAIT_MS`, then interrupt anyway.
    if (this.toolHandoff) {
      this.toolHandoff.interrupt = true;
      this.toolHandoff.timer ??= setTimeout(() => this.releaseToolHandoff(), this.handoffResultWaitMs ?? HANDOFF_RESULT_WAIT_MS);
      return;
    }

    this.interruptCurrentQuery();
  }

  /** A session tool is handing the turn to the UI; its handoff interrupt waits for its result. (UB2.1) */
  private beginToolHandoff(): void {
    if (this.toolHandoff?.timer) clearTimeout(this.toolHandoff.timer);
    this.toolHandoff = { interrupt: false, timer: null };
  }

  /** The tool that handed the turn to the UI has its result in the transcript: interrupt now. (UB2.1) */
  private releaseToolHandoffOn(event: AgentEvent): void {
    if (this.toolHandoff && event.type === 'tool_result' && HANDOFF_TOOL_NAMES.has(event.toolName ?? '')) this.releaseToolHandoff();
  }

  /** Run the handoff interrupt deferred by `interruptForHandoff`, if one was asked for. (UB2.1) */
  private releaseToolHandoff(): void {
    const handoff = this.toolHandoff;
    if (!handoff) return;
    this.toolHandoff = null;
    if (handoff.timer) clearTimeout(handoff.timer);
    if (handoff.interrupt) this.interruptCurrentQuery();
  }

  /** The SDK's cooperative interrupt, logged on failure — the one path a handoff interrupt takes. (UB2.1) */
  private interruptCurrentQuery(): void {
    void this.currentQuery?.interrupt().catch((error) => {
      this.debug(`Claude handoff interrupt failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /**
   * Force-abort the live session using the SDK's AbortController.
   *
   * L2 — ABORTING THE CONTROLLER IS SESSION DEATH, and it always was: the SDK
   * registers `() => this.close()` as the abort handler, and `close()` ends
   * stdin then SIGTERMs the child (measured: stdin at 20 ms, SIGTERM at ~2.4 s).
   * Under one query per user message that was survivable by accident — a string
   * prompt made the transport end input at the first result, so the process was
   * already dying. Under one query per AGENT it kills the conversation.
   *
   * So this method now DISPATCHES ON THE REASON rather than always killing. The
   * signature is unchanged because `forceAbort` is on the frozen
   * `AgentInstance` contract and `SessionManager.cancelProcessing` calls it by
   * name for a user Stop; keeping the whole decision on this side of that
   * contract is what leaves Pi, Codex and Nestor untouched.
   *
   * - `UserStop` and `MaxBudgetUsd` are TURN-scoped: the user (or a ceiling)
   *   wanted this answer stopped, never the conversation ended. They take the
   *   SDK's own `interrupt()`, whose receipt "arrives before the interrupted
   *   turn's SDKResultMessage", so the turn settles on a normal terminal event.
   * - `SourceActivated` is interrupt-then-deliberate-respawn. Its recorded
   *   reason — "the MCP server set is a construction option with no live
   *   equivalent" — is wrong (`Query.setMcpServers` is one), but the teardown
   *   stays for a different and better reason: see
   *   `endTurnForSourceActivation`.
   * - Everything else — capability revoke, redirect fallback, internal error,
   *   `abort()`, the dispose paths — still wants the session gone.
   *
   * @param reason - Why the abort is happening (affects UI feedback)
   */
  forceAbort(reason: AbortReason = AbortReason.UserStop): void {
    this.pauseSteerFifo(); // F1.335 — retained for the host's take, never drained into this turn
    if (this.toolHandoff?.timer) clearTimeout(this.toolHandoff.timer);
    this.toolHandoff = null; // UB2.1 — the hard abort supersedes a deferred handoff interrupt
    this.runTeardownStep('claude quota abort', () => this.nessyGatewayQuota.abort());
    if (reason === AbortReason.UserStop || reason === AbortReason.MaxBudgetUsd) {
      this.interruptLiveTurn(reason);
      return;
    }
    if (reason === AbortReason.SourceActivated) {
      this.endTurnForSourceActivation(reason);
      return;
    }
    this.killLiveSession(reason);
  }

  /**
   * Session death with its UI cleanup — the shape `forceAbort` used to have
   * unconditionally, now reachable by name so the dispose paths do not have to
   * route through the reason dispatch to get it.
   */
  private killLiveSession(reason: AbortReason): void {
    this.lastAbortReason = reason;
    // A question or a permission card on screen belongs to the turn being torn
    // down. The SDK's own `canUseTool` signal usually settles it first; this
    // covers the paths that never reach that signal, so a card can never outlive
    // its turn with a promise nobody will resolve. Shared with the interrupt
    // path, which is precondition 2 of L1's review: no turn-end or Stop path
    // performed either of these before, so moving Stop onto a path that skipped
    // them would have left a permission card on screen after a Stop.
    //
    // F1.962 (origin WJ-crit-ppp P-2) — and each card it refuses leaves the host AT ONCE, as a Stop's does (F1.954).
    // This is session death with the agent kept (a capability revoke, the redirect fallback, a turn or token cap, an
    // interrupt the child never answered), never a dispose and never the app exit, which reach `destroy` instead:
    // that one reports nothing and leaves the record to the host (F1.975; R7 re-shows a MAIN-THREAD record after a
    // relaunch — since F1.961 a record a SUBAGENT raised expires on the host's re-projection instead). Before
    // this the refused card's record, count and durable copy stood until the host's orphan sweep (540 + 30 s).
    const refusedCards = [...this.pendingPermissions.keys()]; // read before the cancel settles them
    this.cancelTurnScopedUi('The turn was stopped before the question was answered.');
    this.reportStopRefusedCards(refusedCards, `the session ended (${reason})`);
    this.endLiveSession(reason);
  }

  getModel(): string {
    return this._model;
  }

  /**
   * Get the list of SDK tools (captured from init message)
   */
  getSdkTools(): string[] {
    return this.eventAdapter.sdkTools;
  }

  /**
   * D1.328 — all four `system`/`init` rosters, for the host's session read.
   *
   * The adapter has captured `tools`, `slash_commands`, `skills` and `agents`
   * since P6.1006 and nothing read three of them; `_sdkSlashCommands` is used
   * only as the baseline the `commands_changed` diff subtracts from. This is the
   * one accessor that makes all four reachable from outside, and it returns
   * `undefined` before the first `init` so the host can tell "the SDK advertised
   * nothing" from "the SDK has not spoken yet" — a distinction an empty object
   * would destroy, and the one that makes a diagnostics field worth reading.
   *
   * A delegation on purpose: the projection lives on the adapter, beside the
   * four fields it reads, so it can be driven by feeding a real `init` without
   * constructing an agent. `sdkSkills` is required in the vendored typing (empty
   * means "no skills") while `sdkAgents` is optional (absence leaves the last
   * roster standing), so the emptiness of either is a fact about the session
   * rather than about this method — see those getters' own docblocks.
   */
  getRuntimeAdvertisedRosters(): RuntimeAdvertisedRostersV1 | undefined {
    return this.eventAdapter.advertisedRosters;
  }

  setModel(model: string): void {
    super.setModel(model);
  }

  // ============================================================
  // Mini Agent Mode (uses centralized constants from BaseAgent)
  // ============================================================

  /**
   * Check if running in mini agent mode.
   * Uses the centralized `systemPromptPreset` flag from BaseAgent.
   */
  isMiniAgent(): boolean {
    return this.config.systemPromptPreset === 'mini';
  }

  /**
   * Get mini agent configuration for provider-specific application.
   * Returns centralized config from BaseAgent constants.
   */
  getMiniAgentConfig(): MiniAgentConfig {
    const enabled = this.isMiniAgent();
    return {
      enabled,
      tools: enabled ? MINI_AGENT_TOOLS : [],
      mcpServerKeys: enabled ? MINI_AGENT_MCP_KEYS : [],
      minimizeThinking: enabled,
    };
  }

  // getMiniSystemPrompt() and filterMcpServersForMiniAgent() are inherited from BaseAgent

  /**
   * P6.276 — the operator's agentic-turn ceiling, read the same way Pi reads it.
   *
   * Deliberately the SAME resolver as `PiAgent.getMaxAgentTurns`
   * (`config/max-agent-turns.ts`) rather than a bare
   * `workspaceDefaults.maxAgentTurns`: that module already carries the
   * precedence the page states — the configured value is this fork's
   * `--max-turns` and outranks the environment; `NESSY_MAX_AGENT_TURNS` and its
   * documented compat alias `CLAUDE_CODE_MAX_TURNS` fill the hole where nothing
   * was configured — and reading it here is what keeps ONE number behind ONE
   * setting name on two runtimes. Reading only the config would have left an
   * operator's `NESSY_MAX_AGENT_TURNS` binding Pi and not this backend, which is
   * the exact asymmetry P6.490's tier-1 arm closed in the other direction.
   *
   * The compat alias also reaches the child on its own (the environment is
   * spread into it and the vendored binary reads the name), so passing the
   * resolved number as `--max-turns` is not a second cap: the page says the flag
   * takes precedence, and the number is the same one.
   */
  private getMaxAgentTurns(): number {
    return resolveMaxAgentTurns(
      loadConfigDefaults().workspaceDefaults.maxAgentTurns,
      process.env,
      message => this.onDebug?.(message),
    );
  }

  getWorkspace(): Workspace {
    return this.config.workspace;
  }

  setWorkspace(workspace: Workspace): void {
    this.config.workspace = workspace;
    // Clear session when switching workspaces - caller should set session separately if needed
    this.sessionId = null;
    // Note: MCP proxy needs to be reinitialized by the caller (useAgent hook)
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  setSessionId(sessionId: string | null): void {
    this.sessionId = sessionId;
  }

  /**
   * P6.106 · claude's resumable anchor is the SDK session id — the value the
   * next query passes as `resume`, captured from `message.session_id` and
   * dropped by `clearHistory()`.
   */
  protected override runtimeSessionAnchor(): string | null {
    return this.sessionId;
  }

  protected override async adoptRuntimeSessionAnchor(sessionId: string): Promise<boolean> {
    this.sessionId = sessionId;
    // Restoring the id is the whole adoption: the next `chat` resumes it,
    // because that is what a non-null `sessionId` already means here.
    return true;
  }

  /**
   * Update the working directory for this agent's session.
   * Called when user changes the working directory in the UI.
   */
  updateWorkingDirectory(path: string): void {
    if (this.config.session) {
      this.config.session.workingDirectory = path;
    }
  }

  /**
   * Set source servers (user-defined sources)
   * These are MCP servers and API tools added via the source selector UI
   * @param mcpServers Pre-built MCP server configs with auth headers
   * @param apiServers In-process MCP servers for REST APIs
   * @param intendedSlugs Optional list of source slugs that should be considered active
   *                      (what the UI shows as active, even if build failed)
   */

  // isSourceServerActive, getActiveSourceServerNames, setAllSources, getAllSources, markSourceUnseen
  // are now inherited from BaseAgent and delegate to this.sourceManager

  // setTemporaryClarifications is now inherited from BaseAgent

  // ============================================================
  // AgentBackend Interface Methods
  // ============================================================

  /**
   * Abort the live session (async interface for AgentBackend compatibility).
   *
   * Another DISPOSE path — `abort` on this interface means "tear the backend
   * down", not "stop this answer" — so it takes session death directly. The
   * `reason` string is deliberately discarded: this path has ONE outcome, and a
   * parameter that looks consulted and is not is how the next reader concludes
   * the reason steers something.
   *
   * P2.362 ASKED WHETHER TO DELETE THIS OR BELT IT, AND THE ANSWER IS NEITHER,
   * because the row's premise is wrong in both halves. Measured at HEAD:
   *
   *   - NOT DELETABLE. `abort(reason?: string): Promise<void>` is a REQUIRED
   *     member of `AgentBackend` (`backend/types.ts`, § "Abort current query
   *     (user stop or internal abort)") and `abstract` on `BaseAgent`. Removing
   *     it does not remove a dead method, it fails to implement an abstract one.
   *   - ALREADY BELTED. The row calls this an entry point "pre-wired to
   *     reintroduce the defect the moment anyone calls" it. P2.347 belted the
   *     path it enters: `killLiveSession` is `lastAbortReason = …` (a field
   *     write), `cancelTurnScopedUi` and `endLiveSession`, and the last two are
   *     step-isolated throughout. Nothing on this path can cancel a later step.
   *
   * What IS true is that it has no production caller — checked with the same
   * search that finds `stopBackgroundTask` and `updateWorkingDirectory` on
   * `SessionManager`'s `backend.`/`managed.agent?.` holders. It stays because
   * the interface requires it, not because someone calls it.
   *
   * ITS SIBLING `close()` WAS DELETED HERE (P2.362), and that half of the row's
   * dichotomy did apply: `close()` was on no interface, was the only `close()`
   * on any of the four backends, and had zero callers of any kind. Every
   * `() => this.close()` in this file's comments is the SDK's own `Query.close`,
   * a different class — the "identically-named symbol in a sibling subsystem"
   * shape that `2026-07-29-inert-worklist.md` §4 lists as the thing an unused
   * sweep keeps mistaking. Its body was this method's body, so nothing is lost:
   * a caller that wants session death has `forceAbort(AbortReason.…)`, whose
   * reason dispatch is the documented way in.
   */
  async abort(_reason?: string): Promise<void> {
    this.runTeardownStep('claude abort quota', () => this.nessyGatewayQuota.abort());
    this.killLiveSession(AbortReason.UserStop);
  }

  /**
   * Destroy the agent and clean up resources.
   * Calls super.destroy() for base cleanup, then Claude-specific cleanup.
   */
  /**
   * P2.333 — TOTAL, like `BaseAgent.destroy()`, and this override needed the
   * treatment MORE than the base did rather than less.
   *
   * `super.destroy()` is the LAST statement here, so before this row a throw
   * anywhere in the prologue skipped the entire base cleanup: the config
   * watcher, the permission whitelists, the api-server retention, the
   * elicitation release, and the private MCP pool disconnect. And unlike
   * `PiAgent`, this class does NOT belt `debug` (measured: `pi-agent.ts` holds
   * the only `override debug` in the tree), so a host `onDebug` that throws
   * reaches every step below that logs — which is what makes the prologue a
   * realistic thrower rather than a theoretical one.
   *
   * The row that opened this said "Pi is immune; Codex and Nestor are not". It
   * is four of four, differently in each: Claude and Codex and Nestor all reach
   * `usageTracker.reset()` through an unbelted `debug`, and Pi never reaches
   * `BaseAgent.destroy()` at all because it does not chain `super`.
   */
  destroy(): void {
    // F1.335 — never let a suspended hook inject into a later turn (upstream's own words).
    this.pauseSteerFifo();
    // Claude-specific cleanup first. `endLiveSession` and not a bare
    // `abortController.abort()`: the live session owns an input channel and a
    // detached reader now, and an aborted controller alone would leave both
    // holding a dead query.
    this.runTeardownStep('claude quota abort', () => this.nessyGatewayQuota.abort());
    this.runTeardownStep('claude live session', () => this.endLiveSession(AbortReason.InternalError));
    this.runTeardownStep('claude turn slot', () => {
      this.openSlot?.close('session-ended');
      this.openSlot = null;
    });
    this.runTeardownStep('claude pending permissions', () => this.cancelPendingPermissions());
    this.runTeardownStep('claude model questions', () =>
      this.modelQuestionAsk.cancelAll('The session ended before the question was answered.'));
    // The `claude-runtime` loopback adapter is a session-lifetime resource, so
    // it is released here alongside the other backend resources.
    this.runTeardownStep('claude loopback adapter', () => this.closeLocalAdapter());
    // P6.207 — drop the process-level warning subscription with the session.
    this.runTeardownStep('claude sdk warning subscription', () => {
      this.unsubscribeSdkShadowWarning?.();
      this.unsubscribeSdkShadowWarning = null;
    });

    // Clear pinned system prompt state
    this.pinnedPreferencesPrompt = null;
    this.pinnedIncludeCoAuthoredBy = null;
    this.preferencesDriftNotified = false;

    // Clear Claude-specific callbacks (not handled by BaseAgent)
    this.onSourcesListChange = null;
    this.onUsageUpdate = null;

    // Clean up session-specific state
    this.runTeardownStep('claude session-scoped state', () => {
      const configSessionId = this.config.session?.id;
      if (configSessionId) {
        const sessionKey: SessionKey = { workspaceId: this.config.workspace.id, sessionId: configSessionId };
        clearPlanFileState(sessionKey);
        unregisterSessionScopedToolCallbacks(sessionKey);
        cleanupSessionScopedTools(sessionKey);
        this.onPermissionModeChange = null; unregisterModeCallbacks(sessionKey, this); // F1.257 / F1.397 — the host's mode entry stays; this agent's echo and callbacks go
      }
    });

    // Clear session
    this.sessionId = null;

    // Base cleanup (stops config watcher, clears whitelists, resets source trackers)
    super.destroy();
  }

  /**
   * Check if currently processing a query.
   *
   * L2 — this was `this.currentQuery !== null`, which meant "a query exists".
   * That was the same fact as "a turn is running" only because the query was
   * created and destroyed per turn. It is not any more: a live session holds a
   * query for its whole life, so the old reading would report every idle Claude
   * session as permanently busy — and `SessionManager` uses this to gate
   * runtime-config refresh, agent eviction, background-fork status and the
   * mid-stream send decision. The slot is the turn.
   */
  isProcessing(): boolean {
    return this.openSlot !== null && !this.openSlot.settled;
  }

  /**
   * Background work this session is holding BETWEEN turns.
   *
   * L5 — the counterpart to {@link isProcessing}, which is slot-based and so is
   * false the instant a turn ends. A Claude background task outlives its turn by
   * definition, and until this existed nothing downstream could see one: the
   * busy predicate's background domains are all fed by Pi-only maps. Without it
   * a session whose subagent is still working reads as completely idle, and both
   * the idle reaper and the ceiling's eviction dispose the runtime — which kills
   * the CLI child, the task, and its output.
   */
  backgroundWorkCount(): number {
    return this.eventAdapter.backgroundTaskCount;
  }

  /**
   * UA4.8 — {@link backgroundWorkCount} without the SDK's `ambient` tasks, for the Tasks Conductor's settlement gate
   * (`AgentBackend.backgroundActivityCount`; the adapter's `activityBackgroundTaskCount` carries the contract sentence).
   *
   * Follow-up 3: plus ONE while the turn the child opens itself to deliver a task's end is expected or running
   * ({@link runtimeOwnTurnSettled}'s marker, F1.509/F1.524 (1)). The level empties at the task's end, but that turn —
   * visible to the host through the between-turns door — writes the node's real answer and may edit files, so a
   * settlement re-check must not complete the node beside it. The marker is bounded (the start bound when no turn
   * follows, F1.528's bound once one runs) and settles on the child's death, so it never holds a node for good.
   * Residue, stated: the instant between the level's emptying and the task's `task_notification` reads zero.
   */
  backgroundActivityCount(): number {
    return this.eventAdapter.activityBackgroundTaskCount + (this.runtimeOwnTurn ? 1 : 0);
  }

  /**
   * L9 — STOP ONE BACKGROUND TASK THE LIVE CHILD IS HOLDING.
   *
   * `Query.stopTask(taskId)` is the SDK's own lever, and its whole doc comment is
   * *"Stop a running task. A task_notification with status 'stopped' will be
   * emitted."* — it says nothing about streaming, so the earlier version of this
   * paragraph attributed the streaming-only claim to the wrong line. The claim is
   * still true, and it is documented one level up: the `Query` interface opens
   * with *"Control Requests / The following methods are control requests, and are
   * only supported when streaming input/output is used."*, and `stopTask` is one
   * of the methods that follow. (The per-method sentence *"Only available in
   * streaming input mode"* is carried by `setPermissionMode` and its neighbours,
   * not by `stopTask` and not by `interrupt` either.) So this is reachable only
   * because L2 made the session outlive the turn — and until this method existed
   * nothing in this repo called it (every other `stopTask` in the tree is Pi's
   * `ChildSessionPort`, a different mechanism with the same name).
   *
   * WHAT THE RETURN MEANS, stated precisely because a caller removes a row from
   * the user's screen on the strength of it:
   *
   * - `stopped: true` — the CLI ACCEPTED the stop request for this id. The
   *   `task_notification` that confirms it arrives on the stream afterwards,
   *   asynchronously, so this is the CLI's acceptance and not yet its receipt.
   * - `stopped: false` with `error` — nothing was asked, or the child refused, or
   *   it did not answer inside the deadline. The caller must NOT treat it as
   *   "probably fine", and must not try a second mechanism on a half-stopped tree.
   *
   * THE `error` IS A DIAGNOSTIC, NOT THE USER'S SENTENCE — and this comment used to
   * say the opposite ("prose meant for the user"), which is why the three guards
   * below returned full English sentences. `StopAgentTaskResult.error` in `dto.ts`
   * is documented "Backend detail for logs and bug reports — never the whole
   * user-facing text", and its `reason` code exists precisely so the renderer owns
   * the wording. Two contracts disagreed and this one was wrong: `SessionManager`
   * maps any arm-1 `error` to `reason: 'failed'`, and the renderer showed the
   * string underneath the translated headline, so every one of these sentences
   * reached a Russian user in English. They are now written as log lines, and the
   * renderer logs them instead of rendering them. Keep them terse and technical;
   * if a user-visible distinction is ever wanted here, the honest way is a `reason`
   * code on this return, not prose.
   *
   * THREE THINGS IT REFUSES TO ASSUME, each the same shape as
   * {@link applyLiveSettings}' four:
   *
   * 1. **That a live child exists.** `currentQuery` is session-scoped, so a
   *    session between turns still has one — but a reaped or torn-down session
   *    does not, and a stop request against nothing must say so rather than
   *    resolve.
   * 2. **That the method exists.** `typeof` guard: the setter/control surface is
   *    version-dependent, and L2 recorded three methods on a `Query` that
   *    declares 27.
   * 3. **That the child answers.** The SDK's `awaitControlResponse` has no
   *    timeout of its own, so a wedged child would hang this call — and through
   *    it the RPC and the button the user pressed — forever. Same deadline as
   *    every other control request we send.
   *
   * AND ONE PRECONDITION IT CHECKS RATHER THAN HOPES: the session must be
   * holding at least one background task. `background_tasks_changed` is a
   * REPLACE-semantics level, so `backgroundWorkCount() === 0` is a positive
   * statement that this child has none — which is exactly the state a stale row
   * on screen is in after L5's `resetBackgroundTaskLevel` (the child restarted
   * and the tasks died with it). Without this check that press would report
   * success and remove a row for a task nothing stopped, which is the lie this
   * row exists to remove. It is a floor, not an identity check: we deliberately
   * do NOT reach into the adapter's id set, so a live session holding task A can
   * still send a stop for an unknown task B and be told "accepted" by the CLI.
   * Narrowing that needs the id set exposed and a live rig to learn whether the
   * CLI even rejects an unknown id — named as unmeasured rather than assumed.
   */
  async stopBackgroundTask(taskId: string): Promise<{ stopped: boolean; error?: string }> {
    const live = this.currentQuery;
    if (!live) {
      return { stopped: false, error: `stopTask(${taskId}): no live Claude session` };
    }
    if (typeof live.stopTask !== 'function') {
      return { stopped: false, error: `stopTask(${taskId}): not implemented by this Claude SDK build` };
    }
    // `backgroundWorkCount()` and not `this.eventAdapter.backgroundTaskCount`:
    // the paragraph above explains the guard by that name, and two names for one
    // reading is how a comment and its code drift apart.
    if (this.backgroundWorkCount() === 0) {
      return { stopped: false, error: `stopTask(${taskId}): this session holds no background task` };
    }
    try {
      await this.withLiveSettingDeadline('stopTask', live.stopTask(taskId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.debug(`Claude stopTask(${taskId}) failed: ${message}`);
      return { stopped: false, error: message };
    }
    this.debug(`Claude stopTask(${taskId}) accepted by the live session`);
    return { stopped: true };
  }

  /**
   * P6.793 — background the tool call this turn is BLOCKED on. NATIVE.
   *
   * `Query.backgroundTasks(toolUseId?)` has shipped in the vendored SDK since
   * 0.3.233 and the host read none of it (P6.308's measurement). Its own words:
   * *"Background in-flight foreground tasks (Bash commands and subagents). With
   * `toolUseId`, targets the single task started by that tool_use block; without
   * it, backgrounds all foreground tasks — equivalent to pressing Ctrl+B in the
   * terminal. Each blocking tool call returns immediately with a 'running in the
   * background' tool_result and the turn continues; the task keeps running and
   * emits a task_notification when it settles."* Nothing is built beside it.
   *
   * THE THREE CHECKS ARE {@link stopBackgroundTask}'s, and they are the same
   * three for the same reasons — a live session, a method this SDK build
   * actually has, and our own deadline because `awaitControlResponse` has none
   * of its own and a wedged child would hang the press forever.
   *
   * THE PRECONDITION IS THE OPPOSITE ONE, and copying the sibling's would have
   * inverted it: `stopBackgroundTask` refuses when `backgroundWorkCount() === 0`
   * because it acts on a task already in the background. This method acts on a
   * FOREGROUND task, of which that counter says nothing at all — a session with
   * zero background tasks is the ordinary case here. So there is no count guard,
   * and the honest answer comes from the SDK itself: it returns `false` when a
   * given `toolUseId` matched no foreground task, and that `false` is reported
   * as "nothing was blocking" rather than rounded up to success.
   *
   * The turn's own continuation is the feedback. We emit nothing here: the SDK
   * turns each blocked call into a "running in the background" tool_result and
   * then a task notification, which this session's adapter already renders as a
   * background-task row (P6.109). A message minted here would be a second voice
   * describing the same event.
   */
  async backgroundInFlightTasks(toolUseId?: string): Promise<{ backgrounded: boolean; error?: string }> {
    const target = toolUseId ?? 'all foreground tasks';
    const live = this.currentQuery;
    if (!live) {
      return { backgrounded: false, error: `backgroundTasks(${target}): no live Claude session` };
    }
    if (typeof live.backgroundTasks !== 'function') {
      return { backgrounded: false, error: `backgroundTasks(${target}): not implemented by this Claude SDK build` };
    }
    try {
      const accepted = await this.withLiveSettingDeadline(
        'backgroundTasks',
        live.backgroundTasks(toolUseId),
      );
      if (accepted === false) {
        // Not an error: the documented `false` is "you named a tool_use id and
        // no foreground task answers to it". No `error`, so the caller reads it
        // as "nothing was blocking" and says that, rather than reporting a
        // failure the user cannot act on.
        this.debug(`Claude backgroundTasks(${target}) matched no foreground task`);
        return { backgrounded: false };
      }
      this.debug(`Claude backgroundTasks(${target}) accepted by the live session`);
      return { backgrounded: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.debug(`Claude backgroundTasks(${target}) failed: ${message}`);
      return { backgrounded: false, error: message };
    }
  }

  /**
   * P3.97 — mint the audit receipt for one SDK-side `system/permission_denied`.
   *
   * The counterpart of the `PermissionDenied` hook mint in `buildSdkHooks()`,
   * and the one that is not dormant: the hook fires only for auto-mode
   * classifier denials, which our own `permissionDecision` silences, while this
   * message carries EVERY denial the binary decides for itself — `rule`,
   * `mode`, `classifier`, `safetyCheck` — none of which our `__PERMISSION_BLOCK__`
   * record can see. `claude-permission-denial-receipt.ts` carries the decision,
   * what this channel cannot record (`tool_input`), and why the two channels are
   * allowed to both fire for one classifier denial.
   *
   * Observational only, exactly like the hook: a receipt is written and nothing
   * about the denial changes.
   */
  private mintStreamPermissionDenialReceipt(denial: {
    tool_name?: unknown;
    tool_use_id?: unknown;
    decision_reason_type?: unknown;
    decision_reason?: unknown;
    message?: unknown;
  }): void {
    const receipt = buildClaudeStreamDenialReceipt({
      sessionId: this.modeSessionId,
      toolName: denial.tool_name,
      toolUseId: denial.tool_use_id,
      decisionReasonType: denial.decision_reason_type,
      decisionReason: denial.decision_reason,
      message: denial.message,
      permissionMode: this.getPermissionMode(),
    });
    // A payload naming no tool, or joined to no tool call, is not minted — the
    // same refusal the hook path makes, for the same reason.
    if (receipt) {
      this.onDebug?.(formatClaudePermissionDenialReceipt(receipt));
      // P6.209 (A42) — the channel that is NOT dormant, so this is the one the
      // denials surface will mostly render; see `getRecentAutoModeDenials`.
      this.retainAutoModeDenial(receipt);
    }
    else this.onDebug?.('[ClaudeAgent] permission_denied arrived with no tool_name/tool_use_id; no receipt minted');
  }

  /**
   * Get current permission mode.
   */
  getPermissionMode(): PermissionMode {
    return getPermissionMode(this.modeKey);
  }

  /**
   * Set permission mode.
   */
  setPermissionMode(mode: PermissionMode): void {
    setPermissionMode(this.modeKey, mode);
  }

  /**
   * Cycle to next permission mode.
   */
  cyclePermissionMode(): PermissionMode {
    return cyclePermissionMode(this.modeKey);
  }

  // getActiveSourceSlugs() is now inherited from BaseAgent

  // ============================================================
  // Branch preflight
  // ============================================================

  /**
   * Branch preflight is intentionally a no-op for Claude sessions.
   *
   * The SDK's fork mechanism (resume + forkSession) runs naturally on the
   * first user message in chat(). Attempting to pre-fork with a separate
   * SDK subprocess is unreliable — the forked session gets garbage-collected
   * by Anthropic before the user sends their first message, or the subprocess
   * crashes during initialization.
   *
   * Defense-in-depth recovery in chat() handles fork failures:
   * - wasResuming covers branchFromSdkSessionId
   * - Session-expired detection checks errorMsg, rawErrorMsg, and stderr
   * - branchFromSdkSessionId is cleared on recovery to prevent retry loops
   */
  override async ensureBranchReady(): Promise<void> {
    // No preflight needed — fork happens on first chat() call via
    // resume: branchFromSdkSessionId + forkSession: true
  }

  // ============================================================
  // Mini Completion (for title generation and other quick tasks)
  // ============================================================

  /**
   * Run a simple text completion using Claude SDK.
   * Empty system prompt - just text in → text out. Built-in tools: none, whatever the operator's whitelist
   * (F1.666 + F1.674, {@link claudeSideChildToolsOption}).
   * Uses the same auth infrastructure as the main agent.
   */
  async runMiniCompletion(prompt: string): Promise<string | null> {
    if (!this.config.miniModel) {
      throw new Error('ClaudeAgent.runMiniCompletion: config.miniModel is required');
    }
    const model = this.config.miniModel;

    const options = {
      // P6.390 - see the main option build above.
      ...claudeSideChildMemoryOff(getDefaultOptions(this.config.envOverrides, this.config.session?.memoryScopeOverride)), // F1.1109
      model,
      maxTurns: 1,
      systemPrompt: 'Reply with ONLY the requested text. No explanation.', // Minimal - no Claude Code preset
      ...(isAdaptiveThinkingAlwaysOnModel(model) ? { thinking: { type: 'adaptive' as const }, effort: 'low' as const } : { thinking: { type: 'disabled' as const } }), // F1.1214 — `disabled` is a 400 there
      // F1.674 — tool-less always: without this the child ran the CLI's 22 built-ins outside the host gate.
      ...claudeSideChildToolsOption(),
    };

    let result = '';
    for await (const msg of query({ prompt, options })) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text') {
            result += block.text;
          }
        }
      }
    }

    return result.trim() || null;
  }

  /**
   * T2 · claim this turn's handoff, because a rebuilt transcript is about to
   * deliver it.
   *
   * Two conditions, and BOTH have to hold — this is the half of the fail-safe
   * that runs before the turn:
   *
   * 1. The switch decided `native` (`planHistoryCarry`). The decision is not
   *    this agent's to make; the modal has already promised the user one of
   *    three things.
   * 2. The rebuilt transcript is on disk, at the path the SDK will look for it,
   *    and non-empty — the SDK's OWN precondition (its locator skips any
   *    candidate whose size is zero). This is what a crash mid-switch is caught
   *    by: R1's case leaves an armed handoff, a possibly-set anchor and a
   *    possibly-absent file, and answering `false` here delivers the text
   *    handoff on this very turn instead of losing the history.
   *
   * The cwd is resolved through {@link resolveSpawnCwd}, i.e. through the same
   * one function the spawn itself uses — asking a second derivation whether the
   * file exists would answer about a directory the subprocess is not going to
   * run in.
   *
   * Answering `true` does NOT mark the handoff applied. That happens only when
   * the child reaches `system`/`init` on this anchor — see
   * {@link confirmRebuiltTranscriptResume}, whose note records why `init` and
   * not the reported session id is the signal.
   */
  protected override shouldSuppressTextHandoff(handoff: RuntimeHandoffPayload): boolean {
    this.rebuiltTranscriptAnchor = null;
    if (handoff.plan !== 'native') return false;

    const anchor = this.sessionId;
    if (!anchor) return false;
    const configDir = workspaceClaudeConfigDir(this.config.workspace.id);
    if (!configDir) return false;

    const transcript = claudeTranscriptPath({
      configDir,
      // The NESSY session id, which is what `chatImpl` passes
      // (`this.config.session?.id`) — NOT the SDK anchor. The candidate it
      // feeds is `getSessionDirPath(workspaceId, sessionId)`, our own session
      // directory, and handing it an SDK session id names a directory that
      // does not exist, silently falls through to `workspaceRootPath`, and
      // derives a project key for the wrong place.
      cwd: this.resolveSpawnCwd({ isRetry: false, sessionId: this.config.session?.id ?? null }),
      sdkSessionId: anchor,
    });
    if (!claudeTranscriptIsLoadable(transcript)) {
      this.debug(`[runtime-handoff] no loadable rebuilt transcript at ${transcript}; delivering the text handoff instead`);
      return false;
    }
    this.debug(`[runtime-handoff] rebuilt transcript in force for ${anchor}; suppressing the text handoff for this turn`);
    this.rebuiltTranscriptAnchor = anchor;
    return true;
  }

  /**
   * T2 · the read-back arm's second half — did the rebuild actually take?
   *
   * Called ONLY from the `system`/`init` message, and this is the whole point.
   *
   * **The obvious detector is wrong, and it was caught by its own negative
   * control.** The first version compared the reported `session_id` against the
   * one the rebuild minted, on the strength of this file's own resume-recovery
   * comment (*"SDK silently fails resume if session is invalid. In this case,
   * we got a new session ID but no assistant content"*). Measured against the
   * shipped 0.3.223 binary in `claude-transcript-resume-e2e.test.ts`, resuming
   * an id with **no transcript at all** reports back **that same id** — so the
   * comparison passes on precisely the failure it existed to catch.
   *
   * What actually differs, measured on the same rig, is the message stream:
   *
   * | | transcript present | transcript absent |
   * | --- | --- | --- |
   * | `system`/`init` | emitted | **never emitted** |
   * | `result.subtype` | `success` | `error_during_execution` |
   * | `session_id` reported | ours | **ours** — useless as a signal |
   *
   * A resume the SDK cannot satisfy fails the child's START, before `init`. So
   * `init` arriving for the anchor we handed it IS the evidence the file was
   * opened, and it is available at the top of the turn rather than at its end.
   *
   * Deliberately NOT a re-walk of the loader's chain logic: it has a
   * timestamp-fallback arm and a cycle guard, and its unchained diagnostic
   * fires only when NO record is chained, so a re-walk would be a third
   * implementation of something we can simply observe. The chain itself is
   * verified where it is written (`writeClaudeTranscript` reads the file back),
   * which is the other half of this fail-safe.
   *
   * When `init` never arrives nothing is marked here, so `runtimeHandoffFrom`
   * stays armed — and the recovery this file already runs
   * (`wasResuming && !receivedAssistantContent`) clears `this.sessionId` and
   * re-enters `chat()`, where `shouldSuppressTextHandoff` now answers false and
   * the text handoff is composed into the SAME user turn. Never both, which is
   * R1's invariant.
   */
  private confirmRebuiltTranscriptResume(reportedSessionId: string): void {
    const anchor = this.rebuiltTranscriptAnchor;
    if (!anchor) return;
    this.rebuiltTranscriptAnchor = null;
    if (reportedSessionId !== anchor) {
      // Not the measured failure mode — the SDK keeps our id even when it
      // cannot load the file — but a different id would mean it started a
      // conversation that is not the one we built, which is the same loss.
      this.debug(`[runtime-handoff] the child reported ${reportedSessionId} where the rebuild minted ${anchor}; the text handoff stays armed`);
      this.pendingRuntimeHandoff = null;
      return;
    }
    this.pendingRuntimeHandoff = null;
    this.config.markRuntimeHandoffApplied?.('native-transcript');
    this.debug(`[runtime-handoff] rebuilt transcript resumed as ${reportedSessionId}`);
  }

  /**
   * Pick the first existing directory among the cwd candidates.
   *
   * `branchFromSdkCwd` is consulted only on the first attempt of a branched
   * session — pre-spawn detection (in `chat()`) routes stale-branch cases
   * through `recoverFromStaleBranchFork` before this method runs, so the
   * branch candidate here is only relevant in the rare race where the cwd
   * vanishes between the pre-spawn check and the actual spawn.
   */
  /**
   * C3.362 — the consequence of this answer that costs a user a mystery, stated
   * here because this is where the answer is chosen.
   *
   * `createSession` seeds `sdkCwd` from `options?.workingDirectory ?? the
   * session's own storage directory` (`sessions/storage.ts`), so **a session
   * created with NO working directory runs its claude child inside the host's
   * session store.** Ask such a session for a file "in the current working
   * directory" and the model writes into that store — and `acceptEdits` prompts
   * anyway, which reads as the mode being broken and is not.
   *
   * It is correct, twice over, and `permission-modes.md`'s acceptEdits section
   * says so inside the grant itself: *"auto-approval applies only to paths inside
   * your working directory or `additionalDirectories`. Paths outside that scope,
   * writes to protected paths … still prompt."* On a default install the target
   * carries a `.nessy-agent` segment and the protected-path floor answers first;
   * with an overridden config dir the floor is silent and the acceptEdits root
   * check answers, because the session store is not one of the roots. Both arms,
   * plus the positive control and the `plans/`+`data/` boundary, are measured in
   * `packages/shared/src/agent/__tests__/claude-accept-edits-session-cwd.test.ts`.
   *
   * Neither is widened: auto-approving the store would let a model rewrite the
   * session's own state with no card. And the cwd itself is not moved — the SDK
   * derives its transcript's project key from it, so moving it is a silently
   * empty resume, which is the failure the whole candidate list below exists to
   * avoid. This is a real product oddity with a deliberately narrow response.
   */
  private resolveSpawnCwd({
    isRetry,
    sessionId,
  }: {
    isRetry: boolean;
    sessionId: string | null;
  }): string {
    // ONE implementation, deliberately. T2 needs this same answer OUTSIDE the
    // agent — the transcript rebuild runs in `SessionManager` at the switch,
    // before any agent exists — and a second derivation of the spawn cwd is a
    // silently-empty resume waiting to happen. `claude-transcript-rebuild.test.ts`
    // drives both entry points over the same table and asserts they agree.
    return resolveClaudeTranscriptCwd({
      isRetry,
      branchFromSdkSessionId: this.branchFromSdkSessionId,
      branchFromSdkCwd: this.branchFromSdkCwd,
      sdkCwd: this.config.session?.sdkCwd,
      workspaceId: this.config.workspace.id,
      sessionId,
      workspaceRootPath: this.workspaceRootPath,
      // The two diagnostics the inlined body used to emit — the tilde skip and
      // the all-candidates-missing fall-through — still reach this agent's log.
      debug: message => this.debug(message),
    });
  }

  /**
   * F1.768 — the host's project trust, applied to the one list that decides what the claude child
   * reads from the project: `settingSources`. `project` and `local` only for a project the host
   * trusted; anything else (kept restricted, never trusted, or no project) gets the user source alone.
   *
   * WHY THE LIST, and why the host has to hold the gate: the CLI's own workspace trust never fires
   * for us. `permissions.md#project-allow-rules-and-workspace-trust`: *"Claude Code shows the trust
   * dialog in interactive sessions only. A `claude -p` run or an SDK session never shows it"*, and
   * `#what-runs-before-you-trust-a-folder` lists, for "`claude -p` or the SDK, folder never trusted",
   * settings-file hooks and the `env` block as "Used" and `.mcp.json` servers as *"Connected without
   * asking, approved or not. The SDK loads them only when `settingSources` includes project
   * settings."* The same section names this very option as the mitigation: *"set the SDK's
   * `settingSources` without project settings, so Claude Code reads neither the project's settings
   * files nor its `.mcp.json`"*. Native-first: the SDK's own option, the host chooses the list.
   *
   * MEASURED on the vendored 2.1.267 (`work/wjcritdd/f1768-probe.ts`, a loopback Messages stub, the
   * list from {@link buildClaudeTurnShapeOptions}): before this row a restricted project got
   * `['user','project','local']` like a trusted one, and the child RAN the project's `SessionStart`
   * command hook (with the project's `env` applied), STARTED its `.mcp.json` server command, and put
   * its `CLAUDE.md` and `CLAUDE.local.md` in the model's context. The project's `permissions.allow`
   * was not applied either way (the CLI's own trust gate; F1.768's proposed sibling row).
   *
   * COST, stated in the keyed fact below (read through {@link getRecentStderr}, the accessor codex's
   * `codex-project-trust` fact rides): an untrusted project also loses its `.claude/rules`, its
   * skills, commands and subagents, the `--add-dir` roots' ones (they load through `project`,
   * `permissions.md#additional-directories-grant-file-access-not-configuration`), and "don't ask
   * again" rules saved in its `.claude/settings.local.json`. The trust is the value captured at agent
   * creation, like every other reader of `projectTrusted`.
   */
  private projectTrustSettingSources(
    sources: import('../config/claude-flag-settings.ts').ClaudeSettingSource[] | undefined,
  ): import('../config/claude-flag-settings.ts').ClaudeSettingSource[] | undefined {
    const trusted = this.config.projectTrusted === true;
    const gated = claudeSettingSourcesForProjectTrust(sources, trusted);
    if (trusted) {
      this.claudeSessionFacts.delete('claude-project-trust');
    } else {
      this.claudeSessionFacts.set('claude-project-trust', '[claude] This project is not trusted in this app ("Keep restricted", '
        + `never trusted, or no project), so the claude runtime was given settingSources ${JSON.stringify(gated ?? [])}: it `
        + 'loads nothing from the project\'s .claude/settings.json, .claude/settings.local.json or .mcp.json (hooks, env, '
        + 'permission rules, MCP servers), no project CLAUDE.md, CLAUDE.local.md or .claude/rules, and no project or --add-dir '
        + 'skills, commands or subagents — the same project content this app withholds from an untrusted project. Trust the '
        + 'project to load them.');
    }
    return gated;
  }

  /** F1.768 — session FACTS, one per key, newest wins; the claude twin of codex's `sessionFacts`. */
  private readonly claudeSessionFacts = new Map<string, string>();

  /**
   * Recover from a branch-fork session whose parent cwd is no longer
   * reachable on this machine, or whose SDK fork spawn failed before
   * establishing a child session.
   *
   * `isPreSpawn` selects the user-facing status text only — the recovery
   * mechanics are identical for pre-spawn (cwd missing on disk before the
   * SDK runs) and post-failure (anything that broke the fork attempt
   * after spawn).
   */
  private async *recoverFromStaleBranchFork(
    userMessage: string,
    attachments: FileAttachment[] | undefined,
    isPreSpawn: boolean,
  ): AsyncGenerator<AgentEvent> {
    debug('[ClaudeAgent] Recovering from stale branch fork', {
      isPreSpawn,
      sessionId: this.config.session?.id,
      parent: this.branchFromSdkSessionId,
      parentCwd: this.branchFromSdkCwd,
    });

    this.sessionId = null;
    this.branchFromSdkSessionId = null;
    this.branchFromSdkCwd = null;
    this.branchFromSdkTurnId = null;
    this.pinnedPreferencesPrompt = null;
    this.pinnedIncludeCoAuthoredBy = null;
    this.preferencesDriftNotified = false;
    // Atomic on-disk persistence: clears all four fork fields at once. This
    // supersedes onSdkSessionIdCleared, which only persists sdkSessionId and
    // would leave the branchFromSdk* fields on disk to reload next launch.
    this.config.onBranchForkInvalidated?.();

    let retryMessage = userMessage;
    const summary = await this.generateBranchFallbackContext();
    if (summary) {
      // The summary is a MODEL's words about a transcript it was handed, and it
      // lands at the top of the branched session's first turn — so it is fenced
      // and defanged like every other block in this family (P2.25). The composer
      // lives beside its sibling in `conversation-summary.ts`; composing the
      // element here again is what P2.24 was about.
      retryMessage = `${buildBranchFallbackContext(summary)}\n\n${userMessage}`;
    } else {
      const recoveryContext = this.buildRecoveryContext();
      if (recoveryContext) retryMessage = recoveryContext + userMessage;
    }

    const statusMessage = isPreSpawn
      ? 'Branch source unavailable on this machine, restoring context from history...'
      : 'Branch fork failed, restoring context from history...';
    yield { type: 'info', message: statusMessage };
    yield* this.chat(retryMessage, attachments, { isRetry: true });
  }

  /**
   * Generate a mini-summarized fallback context from parent conversation messages.
   * Called when SDK-level branch fork fails and we need to inject parent context
   * into the retry without overflowing the context window with raw messages.
   */
  private async generateBranchFallbackContext(): Promise<string | null> {
    const messages = this.config.getBranchFallbackMessages?.();
    if (!messages || messages.length === 0) return null;

    try {
      return await generateConversationSummary(messages, this.runMiniCompletion.bind(this));
    } catch (error) {
      debug(`[ClaudeAgent] Branch fallback mini summary failed: ${error}`);
      return null;
    }
  }

  // ============================================================
  // queryLlm — Agent-native LLM query for call_llm tool (OAuth path)
  // ============================================================

  /**
   * F1.736 — the model a {@link queryLlm} child (`call_llm`, `advisor_consult`, `/btw`) is spawned with. On a
   * `claude-runtime` card it is {@link resolveClaudeRuntimeSideChildModel} over the card's own catalogue and its mini
   * model — the one {@link resolveLocalAdapterMiniModel} seeds the main child's `ANTHROPIC_DEFAULT_HAIKU_MODEL` with —
   * because the loopback adapter forwards the id verbatim and the gateway answers 404 for an id it does not serve.
   * Every other card gets the id as asked: a direct Anthropic connection serves the registry ids. The connection is
   * read per call from the session's own slug, as `postInit` and `describeQuota` read it.
   */
  /**
   * F1.757 — the ids a `claude-runtime` card serves (its own catalogue), for `call_llm`'s model check: the tool lets
   * them through as written and {@link claudeRuntimeSideChildModel} keeps them. Empty on every other card, whose
   * models ARE the registry's, so the tool's "Unknown model" list stands there.
   */
  private claudeRuntimeServedModelIds(): string[] {
    const slug = this.config.connectionSlug;
    const connection = slug ? getLlmConnection(slug) : null;
    if (connection?.providerType !== 'claude-runtime') return [];
    return (connection.models ?? []).map(entry => (typeof entry === 'string' ? entry : entry.id));
  }

  private claudeRuntimeSideChildModel(requested: string): string {
    const slug = this.config.connectionSlug;
    const connection = slug ? getLlmConnection(slug) : null;
    if (connection?.providerType !== 'claude-runtime') return requested;
    const model = resolveClaudeRuntimeSideChildModel({
      requested,
      servedModels: (connection.models ?? []).map(entry => (typeof entry === 'string' ? entry : entry.id)),
      miniModel: this.resolveLocalAdapterMiniModel(connection),
    });
    if (model !== requested) this.debug(`[queryLlm] ${slug} does not serve ${requested}; the side child runs on ${model}`);
    return model;
  }

  async queryLlm(request: LLMQueryRequest): Promise<LLMQueryResult> {
    // F1.736 — `call_llm` always names a model (its tool fills an absent one with the registry's Haiku id), so on a
    // claude-runtime card the id is checked against what the card serves ({@link claudeRuntimeSideChildModel}).
    const model = this.claudeRuntimeSideChildModel(request.model ?? this.config.miniModel ?? getDefaultSummarizationModel());

    const options = {
      // P6.390 - see the main option build above.
      ...claudeSideChildMemoryOff(getDefaultOptions(this.config.envOverrides, this.config.session?.memoryScopeOverride)), // F1.1109
      model,
      // Reasoning-model outputs (Opus extended thinking) can span multiple SDK-counted
      // turns even with no tools exposed. F1.674: the tool surface IS empty (`claudeSideChildToolsOption`
      // below) — before it this child carried the CLI's default built-in set, measured, with or without
      // an operator whitelist, although this comment already called it empty.
      maxTurns: 10,
      systemPrompt: request.systemPrompt ?? 'Reply with ONLY the requested text. No explanation.',
      ...(request.maxTokens ? { maxTokens: request.maxTokens } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.outputSchema ? {
        outputFormat: { type: 'json_schema' as const, schema: request.outputSchema },
      } : {}),
      // F1.674 — `call_llm`, `advisor_consult` and `/btw` all spawn this child, and none of them may give it a tool.
      ...claudeSideChildToolsOption(),
    };

    const result = await consumeLlmQueryMessages(
      query({ prompt: request.prompt, options }),
      (msg) => this.debug(msg),
    );
    // F1.736 — the backend contract (`packages/shared/AGENTS.md`, "`queryLlm` backend contract"): report the EFFECTIVE
    // model, which the advisor's outcome carries as its `modelId` — so a substitution above is visible, not silent.
    return { ...result, model };
  }

  /**
   * F1.541 (origin WJ-ar P-WJ-ar-3) — the CLI ABANDONED the call a permission card is asking about: the call's own
   * `signal` aborted. Measured on the vendored 2.1.267 (WJ-bb's rig, `work/wjbb/`): `Query.stopTask` on the background
   * subagent that raised a PreToolUse card aborts that hook call 1 ms after the stop, ends the task `stopped`, and
   * records the call as rejected. The `case 'prompt'` branch never listened to that signal, so its card waited out
   * F1.527's 540 s deadline; the `claude_native` card (`askToolApproval`) settled its promise on the abort and withdrew
   * nothing, so its card stayed until a restart. Both now come here: the pending entry is settled with a refusal (the
   * CLI reads no answer to a call it abandoned) and the card is withdrawn by F1.527's two routes — the turn in flight,
   * else the host's out-of-turn channel ({@link withdrawElicitationDialog}). A card already answered, expired or torn
   * down has no pending entry, so an abort after any of those withdraws nothing. (In `askToolApproval` the abort
   * listener sits on one line, one for one, because the docs cite this file by line: it comes here once the pending
   * entry exists — the card reached the host — and only settles the promise before that, when nothing was shown.)
   */
  private withdrawAbandonedCard(requestId: string): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return;
    this.debug(`Permission card ${requestId} withdrawn: the CLI abandoned the call it was asking about`);
    this.pendingPermissions.delete(requestId);
    pending.resolve(false);
    this.withdrawElicitationDialog(requestId);
  }

  /**
   * F1.527 — the budget of BOTH claude permission cards (F1.76's `case 'prompt'`, F1.169's `claude_native`).
   * Production takes F1.76's constant; a test shortens it, as the module's own suite shortens `budgetMs`.
   */
  private permissionCardBudgetMs = CLAUDE_PERMISSION_CARD_DEADLINE_MS;

  /**
   * F1.954 — the lifetime of this runtime's permission cards, REPORTED to the host: no claude waiter outlives it
   * (F1.527's deadline), so a host record still standing past it has no waiter and is swept there
   * (`SessionManager.armRuntimeCardOrphanSweep`). Pi and codex report none, and the host arms nothing for them.
   */
  get permissionCardLifetimeMs(): number {
    return this.permissionCardBudgetMs;
  }

  /**
   * F1.975 (origin WJ-crit-ttt P-2) — the cards whose waiter this runtime holds right now, REPORTED to the host.
   * `destroy` refuses every one of them (`cancelPendingPermissions`) and deliberately withdraws none: the runtime cannot
   * tell an app exit — whose relaunch re-shows a MAIN-THREAD record; since F1.961 a record a SUBAGENT raised
   * (`raisedBySubagent`) expires on the host's re-projection instead — from a teardown inside the app. The host can,
   * so it reads this before and after it disposes the runtime and withdraws the difference
   * (`SessionManager.withdrawStoppedRuntimeCards`). A card re-shown after a restart has no waiter here and is never listed.
   */
  get heldPermissionRequestIds(): readonly string[] {
    return [...this.pendingPermissions.keys()];
  }

  /**
   * F1.954 (origin SIT-al FAILS 2) — a Stop REFUSES every card still waiting (`cancelPendingPermissions` resolves it
   * `false`: the PreToolUse hook answers 'User denied permission', a native card denies) and, until this, told the
   * host nothing — so the host kept the record, `awaitingApprovalCount` and the persisted `pendingApproval`, with no
   * card on screen and no waiter behind it; F1.527's deadline went with the waiter, and after a restart the record came
   * back LIVE and its Allow ran the stopped command in the parent (measured on RC #3). Each refused card now leaves the
   * host as F1.541's Stop Task withdrawal does, through the host's out-of-turn channel rather than the stopped turn's
   * slot: the host may abandon that slot (its 5 s stop safety timer), and the channel reaches the same `processEvent`
   * arm at once. The INTERRUPT path reports (Stop, the budget cap, a source activation), and since F1.962 so does a
   * session death (`killLiveSession`: the child ends, the agent stays); `destroy` alone leaves the record to the host's
   * own dispose rules, which keep a durable record for a restart on purpose (R7) and withdraw the rest (F1.975); the
   * host's orphan sweep ({@link permissionCardLifetimeMs}) is the belt behind all of them.
   */
  private reportStopRefusedCards(requestIds: readonly string[], cause = 'a Stop'): void {
    for (const requestId of requestIds) {
      if (this.pendingPermissions.has(requestId)) continue; // not settled by the cancel — nothing was refused
      this.debug(`Permission card ${requestId} refused by ${cause}; withdrawn from the host`);
      super.withdrawElicitationDialog(requestId);
    }
  }

  /**
   * F1.220 — withdraw a question dialog the ask-user bridge settled without an
   * answer, on the turn in flight: `permission_request_cancelled` rides the open
   * slot; with no open slot the base hands it to the host's out-of-turn channel
   * (F1.369, `onPermissionRequestWithdrawn`), and says so only when no host is
   * wired. F1.527 — `withdrawClaudeCard`
   * (`backend/claude/permission-card-deadline.ts`) comes HERE for an expired
   * permission card whose own turn is gone (settled, or never open because a
   * background subagent raised it between turns), so both kinds of card leave
   * the host by the same two routes.
   */
  protected override withdrawElicitationDialog(requestId: string): void {
    const slot = this.openSlot;
    if (slot && !slot.settled) {
      slot.push({ type: 'permission_request_cancelled', requestId });
      return;
    }
    super.withdrawElicitationDialog(requestId);
  }

  // ============================================================

  // ============================================================
  // F1.238 — mid-turn steers: a FIFO, delivered in order, handed back by id
  // ============================================================

  /**
   * F1.238 — hand every accepted-but-undelivered steer to the host, in arrival
   * order, and forget them here.
   *
   * The host calls this where a turn is taken away from the model without a
   * tool boundary to carry the steers — a Stop, a handoff (plan submission,
   * auth request), and the turn's `complete` — and re-queues each one under its
   * own transcript id. SYNCHRONOUS on purpose: a `steer_undelivered` yielded
   * from a generator's `finally` is discarded by the `.return()` that a
   * consumer stopping at a reason-bearing `complete` performs, which is how a
   * Stop used to lose the message.
   *
   * Ported in shape from craft-agents-oss v0.13.4 `ClaudeAgent.takePendingSteers`
   * / `PendingSteers` (`backend/claude/pending-steers.ts`, Apache-2.0, #1040).
   * F1.335 — its `pause()`/generation guard is ported too (see
   * {@link pauseSteerFifo}): taking PAUSES the FIFO, so a steer sent after the
   * take is refused and queued by the host rather than ridden into a dying turn.
   *
   * F1.343 — each steer keeps the `origin` `redirect()` was given, so the host
   * can tell a plugin monitor's text from the user's own message.
   */
  takePendingSteers(): PendingSteer[] {
    this.pauseSteerFifo();
    return this.pendingSteers.splice(0);
  }

  /**
   * F1.335 — upstream's turn-scoped guard, ported from craft-agents-oss v0.13.4
   * `PendingSteers` (`backend/claude/pending-steers.ts`, Apache-2.0, #1040):
   * `active` (here `steerFifoPaused`, inverted so a bare prototype reads as
   * open), `generation` and `turn`, with its `begin()` / `pause()` split.
   *
   * A pause refuses new steers (`redirect`) and bumps the generation, which
   * invalidates every PreToolUse hook that was suspended in an await — a
   * permission card, a source activation, an automation hook — when the turn
   * was stopped or handed off: such a hook read the generation on entry
   * (`hookSteerGeneration`) and `deliverPendingSteersOn` drains nothing for a
   * stale one, so a LATER turn's steer is never injected into the answer for
   * a tool call that turn never made. Paused at: a take, a handoff, a
   * `forceAbort`, `clearHistory`, `destroy`, and the turn's own end.
   */
  private steerFifoPaused = true;
  private steerGeneration = 0;
  private steerTurn = 0;

  private pauseSteerFifo(): void {
    this.steerFifoPaused = true;
    this.steerGeneration += 1;
  }

  /**
   * F1.335 — upstream `runTurn`'s opening: pause, hand back anything left from
   * an earlier turn, then `begin()` — open, a new generation and a new turn
   * number, which the turn's own `finally` compares before it hands back.
   */
  private *openSteerTurn(): Generator<AgentEvent, number> {
    this.pauseSteerFifo();
    yield* this.handBackPendingSteers('left over from an earlier turn');
    this.steerFifoPaused = false;
    this.steerGeneration += 1;
    this.steerTurn += 1;
    return this.steerTurn;
  }

  /** F1.335 — the outer turn's FIFO state, taken out while a nested turn (a model `/compact`) runs. */
  private suspendSteerTurnForNestedTurn(): { steers: PendingSteer[]; turn: number; paused: boolean } {
    return { steers: this.pendingSteers.splice(0), turn: this.steerTurn, paused: this.steerFifoPaused };
  }

  /**
   * F1.335 — put the outer turn's FIFO back after the nested turn: its steers
   * ahead, its turn number (so its own `finally` still hands them back) and its
   * pause state, under a NEW generation so nothing of the nested turn drains.
   */
  private resumeSteerTurnAfterNestedTurn(outer: { steers: PendingSteer[]; turn: number; paused: boolean }): void {
    if (outer.steers.length > 0) this.pendingSteers.unshift(...outer.steers);
    this.steerTurn = outer.turn;
    this.steerFifoPaused = outer.paused;
    this.steerGeneration += 1;
  }

  /**
   * F1.238 — yield one `steer_undelivered` per pending steer, oldest first,
   * each under its own `messageId`. Taken ONE AT A TIME, so a consumer that
   * stops early leaves the rest queued for `takePendingSteers` or the next
   * turn instead of losing them with the discarded yield.
   */
  private *handBackPendingSteers(why: string): Generator<AgentEvent> {
    for (let steer = this.pendingSteers.shift(); steer; steer = this.pendingSteers.shift()) {
      this.debug(`Steer not delivered (${why}) — emitting steer_undelivered${steer.messageId ? ` for ${steer.messageId}` : ''}`);
      yield {
        type: 'steer_undelivered' as const,
        message: steer.message,
        ...(steer.messageId === undefined ? {} : { messageId: steer.messageId }),
        // F1.343 — a plugin monitor's text says so, and the host routes it to the
        // monitor-event queue instead of re-queuing it as a user message.
        ...(steer.origin === undefined ? {} : { origin: steer.origin }),
      };
    }
  }

  /**
   * F1.238 — wrap the PreToolUse answer so the pending steers ride it: ALL of
   * them, in arrival order, AHEAD of the hook's and the path-scoped rule's
   * context (F1.344, below), and drained only here — i.e. only when an answer that
   * carries `additionalContext` to the model is actually returned.
   *
   * A deferred call carries no companion fields at all
   * (`buildClaudePreToolUseContinue`), and a blocked or denied call never
   * reaches `continueWith`, so in all three the steers stay queued for the next
   * tool boundary or come back as `steer_undelivered` at the turn's end —
   * where the old consume-before-verdict dropped them.
   *
   * One steer keeps the exact sentence it always had; several use upstream's
   * numbered shape (craft-agents-oss v0.13.4 `PendingSteers.wrapHook`,
   * Apache-2.0: "Address them in order", "Message 1..n").
   *
   * F1.342 — and only on a MAIN-thread call. A steer is addressed to the model
   * the user is talking to; a subagent's (Agent/Task worker's) tool call fires
   * this same hook, and draining there handed the correction to a worker whose
   * transcript the main model never reads, while the host counted it
   * delivered. `agentId` is the hook input's `agent_id`, which the vendored
   * `sdk.d.ts` (`BaseHookInput`) documents as "Present only when the hook fires
   * from within a subagent … Absent for the main thread, even in --agent
   * sessions. Use this field (not agent_type) to distinguish subagent calls
   * from main-thread calls." A subagent's call leaves the steers queued for the
   * main thread's next tool boundary, or for the turn-end hand-back. Upstream
   * (v0.13.4 `wrapHook`) drains on any PreToolUse; this guard is ours.
   */
  private deliverPendingSteersOn(
    base: ReturnType<typeof buildClaudePreToolUseContinue>,
    agentId?: string,
    hookSteerGeneration?: number,
  ): ReturnType<typeof buildClaudePreToolUseContinue> {
    return (updatedInput, hookAskAlreadyApproved) => {
      const result = base(updatedInput, hookAskAlreadyApproved);
      if (agentId) return result;
      // F1.335 — a paused FIFO, or a hook that entered under an earlier generation
      // (suspended across a Stop, a handoff or a turn end), drains nothing.
      if (this.steerFifoPaused || (hookSteerGeneration !== undefined && hookSteerGeneration !== this.steerGeneration)) return result;
      const output = (result as { hookSpecificOutput?: { hookEventName?: string; permissionDecision?: string; additionalContext?: string } }).hookSpecificOutput;
      if (!output || output.hookEventName !== 'PreToolUse' || output.permissionDecision === 'defer') return result;
      if (this.pendingSteers.length === 0) return result;
      // F1.487 (P-WJqqa-3) — hooks.md: over 10,000 characters an `additionalContext` becomes "a preview of up
      // to the first 2,000 characters", and Claude Code "doesn't ask Claude to read the file". F1.344 put the
      // steers first, which keeps a short block inside that preview; a longer block would still be CUT. So a
      // block the preview cannot hold waits for a boundary whose whole answer fits the cap, or comes back whole
      // at the turn's end (`steer_undelivered`) and reaches the model as the next message.
      if (!claudeSteersFitTheirAnswer(claudeSteerContext(this.pendingSteers), output.additionalContext)) {
        this.debug(`Holding ${this.pendingSteers.length} steer(s): this answer would cut them (over the additionalContext cap)`);
        return result;
      }
      const steers = this.pendingSteers.splice(0);
      this.debug(`Injecting ${steers.length} steer(s) via additionalContext`);
      // F1.485 — only the USER's steers are worded as the user's: a plugin monitor's
      // text (origin 'monitor') arrives framed by the host as a background task
      // notification, and rides as given, after them. The user's own sentence, its
      // count and its numbering are unchanged; see {@link claudeSteerContext} at the
      // end of this file.
      const steerContext = claudeSteerContext(steers);
      return {
        ...result,
        hookSpecificOutput: {
          ...output,
          // F1.344 — the steers FIRST. hooks.md caps `additionalContext` at 10,000
          // characters and, over it, shows the model only "a preview of up to the first
          // 2,000 characters" and "doesn't ask Claude to read the file"; appended after a
          // long path-scoped rule body, the user's correction fell outside that preview.
          additionalContext: [steerContext, output.additionalContext].filter(Boolean).join('\n\n'),
        },
      } as typeof result;
    };
  }

  /**
   * F1.475 — which SUBAGENT made a tool call, by the call's tool-use id, from this agent's own PreToolUse hook.
   *
   * The host raises a card for some session tools (the Monitor ws/command prompt, `archive_session`'s) and binds
   * it to whoever raised it, so that the right END declines it. A claude subagent inherits those tools; a
   * BACKGROUND one outlives the parent turn (P6.793), so binding its card to "the turn running now" cancelled it
   * when an unrelated later turn ended. The host learns the call's tool-use id from the MCP request itself
   * (`backend/claude/session-tool-call-origin.ts`); this map joins it to the subagent. The hook input carries
   * `agent_id` "only when the hook fires from within a subagent" (`sdk.d.ts`, `BaseHookInput`), so a main-thread
   * call — and the main thread of an `--agent` session, which carries `agent_type` alone — is not recorded and
   * answers `undefined`, which leaves the host on its turn stamp (F1.401).
   *
   * Bounded: one entry per subagent tool call, the oldest dropped past {@link SUBAGENT_TOOL_USE_MEMORY}. The host
   * asks while the call is running — the hook has answered and the tool has not returned — so an entry evicted
   * later than that is never asked for.
   */
  subagentOfToolUse(toolUseId: string): string | undefined {
    return this.subagentToolUses.get(toolUseId);
  }

  /** F1.475 — true once this agent has seen `agentId`'s terminal `task_notification` ({@link noteSubagentEnded}). */
  subagentEnded(agentId: string): boolean {
    return this.endedSubagents.has(agentId);
  }

  /**
   * F1.475 — called with a subagent's id when its task ends, whether or not a turn is open. The host sets it and
   * declines the cards that subagent raised. Structural rather than an `AgentBackend` member: Pi has none the host
   * can name (its children are sessions of their own); codex's are reported since `e1ce565a7`, by `CodexAgent`'s twin.
   */
  onSubagentEnded?: (agentId: string) => void;

  private static readonly SUBAGENT_TOOL_USE_MEMORY = 256;
  private readonly subagentToolUses = new Map<string, string>();
  private readonly endedSubagents = new Set<string>();

  private rememberSubagentToolUse(toolUseId: string, agentId: string | undefined): void {
    if (!agentId) return;
    this.subagentToolUses.set(toolUseId, agentId);
    if (this.subagentToolUses.size > ClaudeAgent.SUBAGENT_TOOL_USE_MEMORY) {
      const oldest = this.subagentToolUses.keys().next().value;
      if (oldest !== undefined) this.subagentToolUses.delete(oldest);
    }
  }

  /**
   * F1.475 — a subagent's END, read ABOVE `routeLiveMessage`'s slot guard because it is not a turn's news: a
   * background subagent can be stopped (`Query.stopTask`, or an interrupt, which measured on 2.1.251 kills a
   * background subagent even with no parent turn running) or finish while no turn is open, and the guard drops
   * every such message. Its task id IS its agent id (measured: `task_started`/`task_notification` `task_id` =
   * the hook's `agent_id` = SubagentStop's), and `task_notification` is the terminal message — `completed`,
   * `failed` or `stopped` (`sdk.d.ts`, `SDKTaskNotificationMessage`). Read for every task type: the host matches
   * the id against its own cards, so a shell task's id simply matches none. The set is bounded like the map.
   */
  private noteSubagentEnded(message: SDKMessage): void {
    const notification = message as { type?: string; subtype?: string; task_id?: unknown };
    if (notification.type !== 'system' || notification.subtype !== 'task_notification') return;
    if (typeof notification.task_id !== 'string' || notification.task_id.length === 0) return;
    this.endedSubagents.add(notification.task_id);
    if (this.endedSubagents.size > ClaudeAgent.SUBAGENT_TOOL_USE_MEMORY) {
      const oldest = this.endedSubagents.values().next().value;
      if (oldest !== undefined) this.endedSubagents.delete(oldest);
    }
    try { this.onSubagentEnded?.(notification.task_id); } catch (error) {
      this.debug(`onSubagentEnded(${notification.task_id}) threw: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

// ============================================================
// Backward Compatibility Exports
// ============================================================
// These aliases allow gradual migration from NessyAgent to ClaudeAgent.
// Once all consumers are updated, these can be removed.

/** @deprecated Use ClaudeAgent instead */
export { ClaudeAgent as NessyAgent };

/** @deprecated Use ClaudeAgentConfig instead */
export type { ClaudeAgentConfig as NessyAgentConfig };

/**
 * The model policy the SDK `agents` option is built under, from the session's
 * own connection record. Non-undefined ONLY for `claude-runtime` connections
 * (gateway/BYO): there the upstream serves its own catalog and an SDK alias
 * ('opus') can never resolve, so a declared-but-unserved agent model is
 * dropped with a logged announcement and the agent inherits the session
 * model — the same posture Pi's substitution and codex's role diagnostic
 * take. An anthropic connection returns undefined: alias resolution belongs
 * to the SDK there. Exported for its focused tests.
 */
export function buildAgentModelPolicy(
  connectionSlug: string | undefined,
  sessionModel: string,
  onDiagnostic: (message: string) => void,
  /**
   * P6.154 — the bundled agents' inert-tier line. Optional and separate from
   * `onDiagnostic` because it is NOT a degradation relative to Pi; see the
   * policy field's own note.
   */
  onTierNotice?: (message: string) => void,
  /**
   * P6.160 — the aliases whose `ANTHROPIC_DEFAULT_*_MODEL` this session's child
   * was actually spawned with. Passed in rather than recomputed: an alias
   * admitted here whose variable was never written would register an agent the
   * child resolves against its own default, which on a gateway is an unserved
   * model.
   */
  aliasModels?: ClaudeRuntimeAgentAliasModelMap | null,
): ClaudeRuntimeAgentModelPolicy | undefined {
  const connection = connectionSlug ? getLlmConnection(connectionSlug) : null;
  if (connection?.providerType !== 'claude-runtime') return undefined;
  const servedModels = (connection.models ?? [])
    .map((model) => (typeof model === 'string' ? model : model.id))
    .filter((id): id is string => Boolean(id));
  if (servedModels.length === 0) return undefined;
  // P6.154 — the orchestrator tiers, resolved exactly as the host already
  // resolves them for Pi (`SessionManager`, T1:
  // `const tierModelMap = fastModelId ? { small: fastModelId } : undefined`).
  // Same function, same alias, same `undefined` for a catalogue without one —
  // so a bundled `scout` costs the same on both runtimes instead of running on
  // the flagship here and on the cheap model there.
  //
  // `medium` and `big` are deliberately absent, because they are absent on Pi:
  // copying the shape includes copying what it does NOT say.
  const fastModelId = resolveGatewayFastModelId(connection);
  return {
    servedModels,
    sessionModel,
    onDiagnostic,
    ...(onTierNotice ? { onTierNotice } : {}),
    ...(aliasModels && Object.keys(aliasModels).length ? { aliasModels } : {}),
    ...(fastModelId ? { tierModelMap: { small: fastModelId } } : {}),
  };
}

/**
 * D1.194 — the typed presentation of an expired Claude SUBSCRIPTION credential.
 *
 * AT THE END OF THIS FILE ON PURPOSE: `git grep -ahoI -E 'claude-agent\.ts:[0-9]+' -- docs`
 * answers 968 anchors over 274 distinct lines, and a helper added near its
 * siblings would move almost all of them. Function declarations hoist, so the
 * one caller reads the same.
 *
 * Returns `undefined` — "present this the way it was always presented" — for
 * every case but one, so the existing chain is untouched rather than rewritten.
 */
export function claudeExpiredSubscriptionPresentation(input: {
  /** `runErrorDiagnostics`' own code for this failure. */
  diagnosticCode: string;
  /** `'oauth_token'` for the subscription cards, `'api_key'` for a BYO key. */
  diagnosticAuthType: AuthType | undefined;
}): { code: 'expired_oauth_token'; actions: RecoveryAction[] } | undefined {
  // The BYO key's honest remedy really is "update the key in settings", so the
  // authType is the whole discriminator and there is nothing else to read.
  if (input.diagnosticAuthType !== 'oauth_token') return undefined;
  if (input.diagnosticCode !== 'invalid_credentials') return undefined;
  return {
    code: 'expired_oauth_token',
    // `errors.ts`'s own `ERROR_DEFINITIONS.expired_oauth_token.actions`, which
    // is not exported. `claude-expired-subscription-typed-code.test.ts` pins the
    // agreement through `parseError`, so an edit there reddens this rather than
    // leaving two copies to drift.
    actions: [
      { key: 'r', label: 'Re-authenticate', action: 'reauth' },
      { key: 's', label: 'Switch API setup', command: '/settings', action: 'settings' },
    ],
  };
}

/**
 * F1.253 — the vendored bundle's claude.ai cloud tools, denied on every claude card.
 *
 * `sdk-tools.d.ts` (vendored `0.3.251`, CLI `2.1.251`) declares four tools that act
 * only through a claude.ai OAuth session: `Artifact` publishes a page, `Projects`
 * reads and writes a claude.ai project's knowledge base (its `local_path` uploads a
 * file from the working directory), `ClaudeDesign` runs server-validated design
 * actions, and `RemoteTrigger` creates and runs cloud triggers. Each would move
 * session content to claude.ai services outside this product's audit trail, so the
 * controller DECIDED (2026-09-23) to deny all four on every card — gateway, BYO and
 * Pro/Max alike, since the card is not what decides whether a claude.ai session is
 * reachable. They sit inline in {@link CLAUDE_SESSION_DISALLOWED_TOOLS} (one line,
 * line-neutral) and are named here for the test that pins them against the
 * declarations. The declarations carry no gating marker, so this list is REVIEWED,
 * not parsed; a lift that ADDS a tool is caught by the renderer's complement test
 * (`runtime-switch-costs-native-claude-tools.test.ts`). `ProposeGoal` is local and
 * stays offered, as do `Agent` and `Workflow`.
 */
export const CLAUDE_AI_CLOUD_TOOLS: readonly string[] = Object.freeze([
  'Artifact', 'ClaudeDesign', 'Projects', 'RemoteTrigger',
]);

/**
 * F1.253 — `enableArtifact: false`, on the host's own `--settings` contributor.
 * The SDK documents the key (`sdk.d.ts`: "Turn the Artifact tool on or off. Off in
 * any of managed, --settings, or user settings wins"), so the runtime turns the tool
 * off as well as the host withholding it. A function declaration so the contributor
 * object far above can call it (hoisted), keeping that call site line-neutral.
 */
export function claudeAiCloudToolSettings(): { enableArtifact: false } {
  return { enableArtifact: false };
}

/**
 * F1.485 — the `additionalContext` text for the steers ONE main-thread tool boundary
 * drains ({@link ClaudeAgent}'s `deliverPendingSteersOn`), by origin.
 *
 * A USER steer keeps the exact words it always had: one reads "The user just sent a
 * new message…", several use upstream's numbered shape (craft-agents-oss v0.13.4
 * `PendingSteers.wrapHook`, Apache-2.0) — and the count and numbering are of the
 * user's steers only, so a monitor text beside one correction does not turn it into
 * "The user sent 2 new messages".
 *
 * A MONITOR steer (`origin: 'monitor'`, F1.343) is a scheduled plugin monitor's text
 * that `SessionManager.armPluginPeripherals` steers into the live turn. It is not the
 * user's message, and before this row it was put under the user's sentence all the
 * same. The host frames it BEFORE `redirect()` — `buildPluginMonitorSteer`
 * (`server-core/src/sessions/task-notification.ts`), the same background-task
 * notification framing every other monitor event rides, which names the monitor and
 * states that no human input has occurred — and it frames it once for all three
 * runtimes: Pi's `steer()` and codex's `turn/steer` both carry the text as a bare user
 * message, so a framing added here would have left them in the user's voice. So this
 * function adds no words of its own to a monitor steer; it only keeps the user's
 * sentence off it.
 *
 * Order: the user's steers FIRST, then the monitor texts, each in arrival order.
 * F1.344 put the steers ahead of the hook's context because the model may see only
 * the first 2,000 characters of a long `additionalContext`; a plugin's notification
 * must not push the user's own correction out of that preview either.
 */
function claudeSteerContext(steers: readonly PendingSteer[]): string {
  const user = steers.filter(steer => steer.origin !== 'monitor');
  const monitor = steers.filter(steer => steer.origin === 'monitor');
  const userContext = user.length === 0
    ? undefined
    : user.length === 1
      ? `The user just sent a new message while you were working. Stop what you are currently doing and address their message instead:\n\n${user[0]!.message}`
      : [
        `The user sent ${user.length} new messages while you were working. Stop what you are currently doing and address them, in order:`,
        ...user.map((steer, index) => `Message ${index + 1}:\n${steer.message}`),
      ].join('\n\n');
  return [userContext, ...monitor.map(steer => steer.message)].filter(Boolean).join('\n\n');
}

/**
 * F1.528 (origin the 1.41.0 review, C-claude-runtime-2) — the BOUND on a turn the claude child opened itself
 * (F1.509's `runtimeOwnTurn`), in milliseconds, counted from that turn's slot-less `init`.
 *
 * **What it is NOT: an estimate of how long a turn can take.** A turn is many waits and nothing bounds their sum;
 * the longest SINGLE waits the CLI itself bounds are ten minutes each (`env-vars.md#variables`: `API_TIMEOUT_MS`
 * "default: 600000, or 10 minutes", `BASH_MAX_TIMEOUT_MS` "default: 600000, or 10 minutes"; and the per-hook
 * backstop `var Li=600000` measured in `backend/claude/permission-card-deadline.ts`), plus our own 9-minute card.
 *
 * **What it IS: how long the host holds a user's message behind a turn it cannot see before it stops trusting that
 * turn to report its end.** The end is a `result` (F1.528 settles on one wherever it is routed), the child's death
 * or a teardown; this bound exists for an end none of them reports. Past it the queued message is written into the
 * live input — and WJ-ar's rig measured what that costs on the vendored 2.1.251: with a tool boundary left, the CLI
 * FOLDS the text into its running turn and answers it there; with none left, the text runs as the child's next turn
 * (the pre-F1.509 slip). Neither loses the message. 15 minutes clears every single ten-minute wait above with room
 * for the turn around it, and still ends a wedge within a quarter of an hour instead of at the next respawn. It is a
 * product posture — the one user-visible number in this change — so it lives here, named, beside its notice.
 */
export const CLAUDE_RUNTIME_OWN_TURN_BOUND_MS = 15 * 60_000;

/**
 * F1.524 (1) — how long a background task's slot-less `task_notification` holds sends for the turn the claude child
 * is expected to open next to deliver it, before the expectation releases itself. The eight measured gaps between that
 * notification and the turn's `init` were 17–97 ms (2.1.251 and 2.1.267); two seconds is 20 times the largest, and
 * short enough that a notification no turn follows (none was measured) costs a queued send two seconds, not F1.528's
 * quarter of an hour.
 */
export const CLAUDE_RUNTIME_OWN_TURN_START_BOUND_MS = 2_000;

/**
 * F1.528 — what the user reads, at the start of the next turn, when {@link CLAUDE_RUNTIME_OWN_TURN_BOUND_MS} fires:
 * true whether that turn was wedged or merely long, because in both cases the host stopped waiting for an end it was
 * never told about. Latched once per session by the notice channel, like every line it carries.
 */
const RUNTIME_OWN_TURN_BOUND_NOTICE =
  'Claude was answering a background task on its own and had not reported the end of that turn after '
  + `${CLAUDE_RUNTIME_OWN_TURN_BOUND_MS / 60_000} minutes, so the app stopped waiting for it and sent this message.`;

/**
 * F1.509 — a turn the claude child opened itself; F1.528 added its `bound` timer. See `runtimeOwnTurnSettled`.
 * F1.524 (1) — `started` is false while the turn is only EXPECTED (its task's notification arrived, its `init` not yet),
 * and `bound` is then the start bound.
 */
interface ClaudeRuntimeOwnTurn {
  settled: Promise<void>;
  settle: () => void;
  bound: ReturnType<typeof setTimeout> | null;
  started: boolean;
  /** F1.597 — background tasks that ended while this turn ran, each answered by the CLI in a turn of its own after it. */
  owed: number;
}

/** hooks.md: a hook's `additionalContext` is "capped at 10,000 characters". */
const CLAUDE_HOOK_ADDITIONAL_CONTEXT_CAP = 10_000;
/** hooks.md: over the cap, Claude sees "a preview of up to the first 2,000 characters". */
const CLAUDE_HOOK_OVERSIZE_PREVIEW_CHARS = 2_000;

/**
 * F1.487 (P-WJqqa-3) — whether a steer block rides an answer WHOLE: the joined answer fits the cap, or the block
 * (joined FIRST, F1.344) fits the preview the model sees when it does not. The answer is ONE string, and "Claude
 * Code measures each string on its own" (hooks.md), so the cap is read over the joined text.
 */
function claudeSteersFitTheirAnswer(steerContext: string, hookContext: string | undefined): boolean {
  const joined = [steerContext, hookContext].filter(Boolean).join('\n\n');
  return joined.length <= CLAUDE_HOOK_ADDITIONAL_CONTEXT_CAP || steerContext.length <= CLAUDE_HOOK_OVERSIZE_PREVIEW_CHARS;
}

/**
 * F1.596 (origin WJ-bb P-WJbb-1) — the bypass arm's notice: the documented rule, quoted. See
 * {@link formatClaudeSdkShadowWarningNotice}; every quoted sentence is `permission-modes.md`'s, word for word.
 */
const CLAUDE_BYPASS_DOCUMENTED_RULE_NOTICE =
  'Claude runtime: Claude Code reports permission mode bypassPermissions. Its documentation (permission-modes.md, '
  + '"Skip all checks with bypassPermissions mode"): "bypassPermissions mode disables permission prompts and safety '
  + 'checks so tool calls execute immediately, including writes to protected paths. The actions no mode '
  + 'auto-approves still prompt in this mode." The first of those is "Tools matched by an explicit ask rule", and '
  + '"Deny rules block in every mode, including bypassPermissions."';

/**
 * F1.596 (origin WJ-bb P-WJbb-1) — what the P6.207 notice says for each shape of the SDK's
 * `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning.
 *
 * The BYPASS arm is not relayed verbatim. Its sentence (vendored `sdk.mjs` 0.3.267: "canUseTool will not be invoked:
 * permissionMode 'bypassPermissions' auto-approves every tool call (except explicit deny rules) before the callback
 * is consulted.") is wrong about its own CLI: on 2.1.267, with a user-tier ask rule `Bash(ls:*)`, the CLI called
 * `canUseTool` for `Bash ls` in `bypassPermissions` and our card was raised with origin `claude_native` (WJ-bb's rig
 * arm `native-bypass`, re-read by WJ-bv on 2026-09-24). The vendor's own page says the same:
 * `agent-sdk/permissions.md#how-permissions-are-evaluated` — "If an ask rule matches, the call falls through to your
 * canUseTool callback for confirmation, even in bypassPermissions mode." So the notice quotes the documented rule
 * instead: the opening two paragraphs of `permission-modes.md#skip-all-checks-with-bypasspermissions-mode`, the
 * first bullet of `permission-modes.md#actions-no-mode-auto-approves` and a sentence of
 * `permission-modes.md#available-modes`, word for word as the rendered page read on 2026-09-24. It is a quotation,
 * so it is English by design under C3.331's rule, as the sentence it replaces was.
 *
 * Every other sentence — the bare-`allowedTools` arm, and any shape not recognised here — is relayed VERBATIM behind
 * the P6.207 lead-in, as before: a vendor rewording can change which branch runs, never silence the warning. The
 * recogniser is the mode's name in the sentence, the one token the bypass arm has carried since P6.207 was built.
 *
 * F1.638 — that lead-in said "the host permission gate is bypassed for the tools named below", and it was false:
 * WJ-bv's rig on 2.1.267, `default` mode with `allowedTools: ['Bash']`, saw our PreToolUse gate still raise its card
 * for `Bash ls` (origin `host_gate`), and the page says why — `agent-sdk/permissions.md#allow-and-deny-rules`: "hooks
 * run before every other step". So the lead-in now attributes the claim to Claude Code, says the host gate still runs
 * with the page's words, and relays the vendor's sentence whole. The arm has NO producer in this host any more
 * (F1.638 moved the operator's whitelist off `allowedTools`; allow rules from settings files are invisible to the
 * SDK's check, per the same page), so what can still reach it is a future producer or a vendor rewording.
 */
export function formatClaudeSdkShadowWarningNotice(message: string): string {
  if (/permissionMode '?bypassPermissions'?/.test(message)) return CLAUDE_BYPASS_DOCUMENTED_RULE_NOTICE;
  return 'Claude runtime: Claude Code warns that its permission callback is skipped for some calls. The host\'s '
    + 'PreToolUse gate is not — "hooks run before every other step" (agent-sdk/permissions.md). Claude Code\'s '
    + `words: ${message}`;
}

/**
 * F1.638 (origin WJ-bv P-WJbv-1) — the built-in tools the host keeps when an operator's whitelist NARROWS the preset:
 * `ToolSearch`, and nothing else. See {@link buildClaudeSessionToolsOption} for the measurement and what is not kept.
 */
export const CLAUDE_WHITELIST_HOST_KEPT_TOOLS: readonly string[] = Object.freeze(['ToolSearch']);

/**
 * F1.638 (origin WJ-bv P-WJbv-1) — the SDK `tools` value for one claude turn, with P6.217's `sessionAllowedTools`
 * (a WHITELIST by its own docblock in `config-defaults-schema.ts`) projected onto the option that NARROWS the tool
 * list.
 *
 * ## Why `tools` and not `allowedTools`
 *
 * P6.217 passed the whitelist as `allowedTools`, and that option pre-approves: `sdk.d.ts` (0.3.267) — "List of tool
 * names that are auto-allowed without prompting for permission. … To restrict which tools are available, use the
 * `tools` option instead."; `agent-sdk/permissions.md#allow-and-deny-rules` — "`Read` and `Grep` are auto-approved.
 * Other tools not listed here still exist". `tools` is the narrowing option: "Specify the base set of available
 * built-in tools. - `string[]` - Array of specific tool names" (`sdk.d.ts`), and its CLI twin
 * (`cli-reference.md#cli-flags`, `--tools`): "Restrict which built-in tools Claude can use."
 *
 * Measured through the real input (`config.json`, `sessionAllowedTools: ['Bash']`, vendored 2.1.267, rig
 * `work/wjcritb/`, 2026-09-25): before, 68 tools in the child's init (21 built-in + 47 MCP) and the SDK's
 * `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning for `Bash`; after, 48 (`Bash` + the same 47 MCP) and no warning. `Bash ls`
 * raised our `host_gate` card in both, so this changes what EXISTS, never who is asked. CONTROL: with the key absent
 * the child still lists 68, on the preset.
 *
 * ## What the whitelist does NOT govern, named rather than dropped
 *
 * - MCP tools. `--tools` "doesn't affect MCP tools; to deny those too, use `--disallowedTools "mcp__*"`"
 *   (`cli-reference.md#cli-flags`). Measured: 47 MCP tools before and after; an `mcp__…` name, an unknown name and a
 *   scoped rule such as `Bash(ls:*)` in `tools` are IGNORED by the child (rig arms `raw-mixed`, `raw-scoped`: a
 *   scoped entry alone does not keep `Bash`). The names are passed as written, so the child's own answer governs them;
 *   the operator's lever for MCP is `sessionDisallowedTools` with an `mcp__<server>__*` entry. Pi's whitelist does
 *   narrow MCP tools — that is a switch cost, not something `tools` can express.
 * - `ToolSearch` ({@link CLAUDE_WHITELIST_HOST_KEPT_TOOLS}) — HOST-KEPT when the preset is narrowed. It is not a
 *   capability but the loader of the MCP tools above: with tool search on and `tools: ['Bash']` the child dropped it
 *   and sent all 47 MCP definitions upfront (arm `raw-bash-ts`), defeating the host's own deferred-loading setting;
 *   with `['Bash', 'ToolSearch']` the definitions stayed deferred (arm `raw-ts-kept-on`); with tool search off the
 *   child's own gate still leaves it out (arm `raw-ts-kept-off`), so keeping the name costs nothing there.
 * - `StructuredOutput` — kept by the child itself whenever `outputFormat` is set, whatever the list (arm
 *   `raw-outfmt-bash`), so nothing is added for it. `EndConversation` — "A list that omits `EndConversation` doesn't
 *   remove it" (`cli-reference.md#cli-flags`).
 * - Every other built-in (`Agent`, `AskUserQuestion`, the Task tools, `WebFetch`, …) is a CAPABILITY, and the page's
 *   instruction for `--tools` is the operator's: "Include the tools you want alongside the other built-in tools you
 *   use" (`tools-reference.md#task-tool-availability`).
 *
 * The mini agent's own list is a host choice for config edits; the whitelist is a CEILING over it (intersected, as
 * Pi's `intersectSessionToolCeilings` intersects a pin), never a replacement, and `ToolSearch` is not added because
 * the mini list never carried it. An empty intersection is `[]` — "Disable all built-in tools" (`sdk.d.ts`).
 * An empty whitelist is ABSENT, never `[]`: the preset or the mini list, exactly as before this row.
 */
export function buildClaudeSessionToolsOption(input: {
  miniTools?: readonly string[];
  sessionAllowedTools: readonly string[];
}): string[] | { type: 'preset'; preset: 'claude_code' } {
  const { miniTools } = input, allowed = claudeToolNamesForWhitelist(input.sessionAllowedTools); // F1.669 — Pi spellings
  if (miniTools) return allowed.length > 0 ? miniTools.filter(name => allowed.includes(name)) : [...miniTools];
  if (allowed.length === 0) return { type: 'preset', preset: 'claude_code' };
  return [...allowed, ...CLAUDE_WHITELIST_HOST_KEPT_TOOLS.filter(name => !allowed.includes(name))];
}

/**
 * F1.666 + F1.674 + F1.698 + F1.792 — the spawn fragment for a claude SIDE child: a one-shot `query()` the host spawns
 * outside the main session. Always `{ tools: [] }` — "Disable all built-in tools" (`sdk.d.ts` 0.3.267) — whatever the
 * operator's `sessionAllowedTools`; `strictMcpConfig: true`, so no MCP server the CLI discovers itself joins it (F1.698);
 * and `settingSources: []`, so it loads no settings file, hook or CLAUDE.md, whatever `NESSY_CLAUDE_SETTING_SOURCES` says
 * (F1.792).
 *
 * There are two side children, and every host route reaches one of them — `ClaudeAgent.queryLlm` (`call_llm`,
 * `advisor_consult`, `/btw`) and `ClaudeAgent.runMiniCompletion` (titles, summaries, the branch fallback). The other two
 * SDK spawns in this package (`validateAnthropicConnection`, `validateMcpUrl`) already pass `tools: []`. The MAIN child
 * is not governed here: its list is {@link buildClaudeSessionToolsOption}'s (F1.638), its MCP discovery Q-den 65's.
 *
 * Why always empty:
 * - Both children are tool-less by contract: `BaseAgent.askSideQuestion` and `consultAdvisor` say so, and for `/btw`
 *   the page itself — `interactive-mode.md#side-questions-with-/btw`: "No tool access: side questions answer only from
 *   what is already in context". So the empty list sits inside every whitelist and needs no projection of one.
 * - Neither child carries `hooks`, `canUseTool` or the flag settings the main child gets, so any tool it has runs
 *   OUTSIDE the host's PreToolUse gate and the credential floor. Before this, `tools` was absent and the SDK sent no
 *   `--tools` flag, so on EVERY default install both children ran the CLI's 22 default built-ins that way, one
 *   `mcp__session__call_llm` call away from any session. A discovered MCP server's tools are tools too (F1.698).
 *
 * Measured on the vendored 2.1.267 (rig `work/wjcritl/`, 2026-09-25). Before: no `tools` key, 22 built-ins offered
 * (`Agent`, `Bash`, `Edit`, `Read`, `WebFetch`, `Write`, …) with or without `sessionAllowedTools: ['Bash']`; a `Read` the
 * `queryLlm` child asked for, of a file inside its cwd, came back with the contents and no card; and with no whitelist
 * and the child's cwd at `/` (a side child passes no `cwd`, so it runs in the host process's), a `Read` of a file
 * under `$HOME` did too. With `tools: []`: zero built-ins offered and the same `Read` answers "No such tool available";
 * with `outputFormat` one tool is left, the child's own `StructuredOutput`, and its `{ ok: true }` came back. F1.666
 * (`a1e68cff3`) emptied the list under a whitelist only; F1.674 empties it always. F1.698 (rig DN-065, 2026-09-26): a
 * `~/.claude.json` and a cwd `.mcp.json` server still connected and offered a tool; `strictMcpConfig: true` left zero.
 *
 * F1.792 (and F1.675): a side child passes no `cwd`, and `settingSources` unset is "equivalent to `["user", "project",
 * "local"]`" (`agent-sdk/claude-code-features.md#control-filesystem-settings-with-settingsources`), so each one loaded
 * all three tiers from the HOST PROCESS's cwd — the repo root under `electron:dev`, not the session's project, and past
 * F1.768's trust gate. Rig DN-075 (2026-09-26, the vendored 2.1.267 against a fake Messages endpoint, one marker per
 * tier): unset, the first request carried the user, project and local CLAUDE.md and all 12 hooks ran (SessionStart,
 * UserPromptSubmit, Stop and SessionEnd of each tier); with `[]`, zero of either and the answer still came back. `[]` is
 * the SDK's own isolation value, so `cwd` stays unset: under it the cwd selects no settings. RESIDUE, which the page
 * lists as outside the option (`#what-settingsources-does-not-control`): managed policy still applies; the auto memory
 * keyed by that cwd loaded too (measured) until F1.1109 ({@link claudeSideChildMemoryOff}).
 *
 * F1.1110 (origin DN-075): each call also wrote its own transcript, one `.jsonl` under the Claude config dir's
 * `projects/<host-cwd slug>/` (rig-observed, 2026-09-26). A side child is never resumed, so it passes the SDK's own
 * `persistSession: false` — "When false, disables session persistence to disk" (`sdk.d.ts`; `agent-sdk/typescript.md`,
 * the Options table) — the native switch, measured to write no `.jsonl` in `claude-persist-session-e2e.test.ts`.
 */
export function claudeSideChildToolsOption(): { tools: string[]; strictMcpConfig: true; settingSources: []; persistSession: false } {
  return { tools: [], strictMcpConfig: true, settingSources: [], persistSession: false };
}

/**
 * F1.1109 (origin DN-075) — a side child's auto memory is OFF: its env carries `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.
 *
 * `settingSources: []` ({@link claudeSideChildToolsOption}) does not reach auto memory, which the CLI keys by the cwd —
 * the HOST process's, since a side child passes none — and rig DN-075 measured its MEMORY.md marker in the first
 * request with `[]` set. `agent-sdk/claude-code-features.md`'s isolation warning pairs the two: *"set
 * `settingSources: []` plus `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in `env`"*. Native: the runtime's own switch, set after
 * the session's own memory answer (`getDefaultOptions`), which a side child has no use for — it answers one prompt from
 * what it is handed, and never writes a memory (it is tool-less).
 */
export function claudeSideChildMemoryOff(defaults: Partial<Options>): Partial<Options> {
  return { ...defaults, env: { ...defaults.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } };
}

/**
 * F1.736 — which model a claude SIDE child runs on, on a `claude-runtime` card (the Nessy Gateway card and every BYO
 * OpenAI-compatible card): the id asked for when the card serves it, else the card's mini model.
 *
 * Why: the per-session loopback adapter maps no model — it forwards the id the child names — and the gateway answers
 * 404 for an id it does not serve, which the CLI reports as "There's an issue with the selected model (…). It may not
 * exist or you may not have access to it." The claude session's `call_llm` always names one: `createLLMTool` fills an
 * absent `model` with `getDefaultSummarizationModel()` (`claude-haiku-4-5-20251001`), and a named `haiku`/`sonnet`
 * resolves to a registry id too. So on the gateway card every `call_llm` failed, while `/btw` and titles — which
 * reach the child with the session's own mini model — answered. Measured 2026-09-25, rig `work/wjcrity/`: the vendored
 * binary, the REAL `postInit` + loopback adapter, and a fake OpenAI-compatible gateway serving only the `coder`/`fast`
 * ids.
 *
 * DECIDED (TRANSPARENT and SIMPLE; no page covers a host-supplied side model): an unserved id becomes the card's mini
 * model — the tier `call_llm` promises by default ("Defaults to a fast model") and the one Pi's own `queryLlm` falls back
 * to when the id it was asked for does not resolve under the session's auth (`pi-agent-server` `queryLlm`, debug-logged
 * there as here). Refusing instead would leave `call_llm` unusable on the card, because its tool refuses the card's own
 * ids by a static registry check before any backend is asked (a separate row).
 *
 * Changes nothing when it knows nothing: an EMPTY catalogue (never fetched) or no mini model keeps the id as asked, and
 * the mini model itself is always kept — an explicit connection `miniModel` is the person's choice even when the
 * catalogue does not list it (`getMiniModel` honours it the same way). A `[1m]` selector is not a different model
 * ({@link stripClaudeModelSelectorSuffix}, the rule the wire router matches by).
 */
export function resolveClaudeRuntimeSideChildModel(input: {
  requested: string;
  servedModels: readonly string[];
  miniModel: string | undefined;
}): string {
  const { requested, servedModels, miniModel } = input;
  if (!miniModel || servedModels.length === 0 || requested === miniModel) return requested;
  const key = stripClaudeModelSelectorSuffix(requested);
  if (servedModels.some(id => stripClaudeModelSelectorSuffix(id) === key)) return requested;
  return miniModel;
}

/**
 * F1.768 — the pure half of {@link ClaudeAgent.projectTrustSettingSources}: the list the claude child
 * is handed, given the operator's (`--setting-sources`, `undefined` when unset) and the host's trust.
 *
 * - Trusted: returned as it came, so an install that trusted its project builds byte-identical options
 *   (`undefined` still falls through to {@link buildClaudeTurnShapeOptions}' documented triple).
 * - Anything else: `project` and `local` are dropped from whatever the operator asked for, and the
 *   default becomes `['user']`. Trust can only NARROW the operator's list, never widen it, so an
 *   operator who narrowed to `project` alone gets `[]` here — the documented empty list, not a guess.
 *
 * `local` goes with `project` although `.claude/settings.local.json` is normally the user's own file:
 * a repository can commit one (`permissions.md#when-your-local-settings-file-needs-trust` treats a
 * tracked one as repository-supplied), and its hooks and `env` would run like the project file's.
 */
export function claudeSettingSourcesForProjectTrust(
  sources: readonly import('../config/claude-flag-settings.ts').ClaudeSettingSource[] | undefined,
  projectTrusted: boolean,
): import('../config/claude-flag-settings.ts').ClaudeSettingSource[] | undefined {
  if (projectTrusted) return sources === undefined ? undefined : [...sources];
  return (sources ?? ['user']).filter(source => source === 'user');
}

/**
 * F1.935 — why the revalidate step did not resize a large image before the gate:
 * a readable DENY refuses it, or an ASK's card must be approved first. See
 * {@link ClaudeAgent.readableRuleHoldingImageResize}.
 */
type ClaudeImageResizeHold = { by: 'deny' } | { by: 'ask'; filePath: string; sizeMB: string };

/** The refusal for an image the host could not bring under the API limit — before the gate, or after an approved ask (F1.935). */
function claudeImageTooLargeReason(sizeMB: string): string {
  return `Image too large (${sizeMB}MB). The API limit is 5MB base64 (~3.5MB raw). Use a smaller or compressed version.`;
}

// F1.1041 — the operator's web-search allowlist onto WebSearch's own input (the revalidate step);
// imported at the end so no line the docs cite by number moves.
import { scopeClaudeWebSearchInput } from '../config/web-search-allowlist.ts';
// F1.789 — appended so no cited line of this file moves; imports are hoisted.
import { syncClaudeProjectTrustEntry } from './backend/claude/project-trust-entry.ts';
import { claudeToolNamesForWhitelist } from './backend/claude/pi-tool-names.ts';

/**
 * F1.759 (origin: the 1.41.0 release sitting, lane SIT-g) — whether the SDK's shadowed-callback warning belongs to THIS
 * session. The warning is a process event naming no session ({@link subscribeToClaudeSdkShadowWarning} fans it to every
 * live claude agent), and the sitting saw a plan/Manual session receive the bypass notice twice, 4–7 ms after a NEW
 * bypass session's own copy. The bypass arm can only be raised by a child launched in `bypassPermissions`, so a session
 * in another mode drops it (the vendor's sentence still reaches its debug log); any other shape still reaches every
 * session, since nothing in it says whose it is. Residue: two live bypass sessions both show the bypass notice once.
 */
function claudeShadowWarningReachesSession(message: string, mode: string): boolean {
  return !/permissionMode '?bypassPermissions'?/.test(message) || mode === 'bypassPermissions';
}
