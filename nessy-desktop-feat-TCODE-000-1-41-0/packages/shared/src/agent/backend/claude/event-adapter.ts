/**
 * Claude Event Adapter
 *
 * Maps Claude SDK messages (SDKMessage) to Nessy Desktop's AgentEvent format.
 * Extracted from ClaudeAgent.convertSDKMessage() for testability and to share
 * lifecycle scaffolding with PiEventAdapter via BaseEventAdapter.
 *
 * Key Claude-specific behavior:
 * - Uses extractToolStarts/extractToolResults from tool-matching.ts (stateless, ID-based)
 * - Handles stream_event for real-time text and reasoning deltas and tool start detection
 * - Manages pendingText for deferred text_complete (waits for stop_reason from message_delta)
 * - Tracks usage per-message (not cumulative) for accurate context window display
 *
 * R8 — COVERAGE OF THE SDK MESSAGE UNION.
 *
 * `SDKMessage` in @anthropic-ai/claude-agent-sdk 0.3.218 is a union of 39 named
 * members over 11 top-level `type` values, 28 of which are `system` subtypes.
 * Before R8 this file reached a handler for 12 of the 39 and the other 27 fell
 * through to a debug line — measured, not estimated: one representative message
 * of each of 31 previously-unhandled shapes produced exactly ZERO AgentEvents.
 *
 * Every member now has an explicit branch. A branch is one of two things and the
 * comment says which:
 *   - SURFACED — it maps onto an existing AgentEvent (`status` for transient
 *     lines, `info`/`info+warning` for transcript banners, `task_progress`).
 *   - DELIBERATE DROP — there is no honest destination in our event model, the
 *     comment says why, and a debug trace records the arrival. Seven members are
 *     drops: hook_progress, thinking_tokens, session_state_changed,
 *     elicitation_complete, mirror_error, tool_use_summary, prompt_suggestion.
 *
 * NOTHING here is translated. Compaction is still matched by keyword one layer
 * up — SessionManager stamps `statusType: 'compacting'` by sniffing 'Compacting'
 * and persists a compaction banner by `startsWith('Compacted')`, because the
 * internal `info` AgentEvent shape is a frozen contract with no type field.
 * Retries no longer are: since P6.916 the `status` branch carries `retry`, so
 * the chip is stamped off a FIELD and the sentence is derived from the same
 * facts by `core/types/message.ts`'s `retryStatusEvent`. Running any of it
 * through i18n would break the renderer chips silently.
 */

import type {
  SDKMessage,
  SDKAPIRetryMessage,
  SDKAssistantMessageError,
  SDKBackgroundTasksChangedMessage,
  SDKCommandsChangedMessage,
  SDKControlRequestProgressMessage,
  SDKFilesPersistedEvent,
  SDKHookResponseMessage,
  SDKHookStartedMessage,
  SDKInformationalMessage,
  SDKLocalCommandOutputMessage,
  SDKMemoryRecallMessage,
  SDKModelRefusalFallbackMessage,
  SDKModelRefusalNoFallbackMessage,
  SDKNotificationMessage,
  SDKPermissionDeniedMessage,
  SDKPluginInstallMessage,
  SDKRateLimitEvent,
  SDKResultError,
  SDKResultMessage,
  SDKStatusMessage,
  SDKTaskProgressMessage,
  SDKTaskStartedMessage,
  SDKTaskUpdatedMessage,
  SDKWorkerShuttingDownMessage,
  ModelUsage,
} from '@anthropic-ai/claude-agent-sdk';
import { retryStatusEvent, type AgentEvent, type AgentRetryFacts, type AgentTerminalReason, type PersistedModelUsage, type TurnCostReporting } from '@nessy-agent/core/types';
import { foldModelUsageKeys } from '../../../telemetry/cost-reporting.ts';
import type { OrchestrationProgress, OrchestrationProgressAgent } from '@nessy-agent/core';
import type { AgentError } from '../../errors.ts';
import type { RuntimeAdvertisedRostersV1 } from '../types.ts';
import { BaseEventAdapter } from '../base-event-adapter.ts';
import { ToolIndex, extractToolStarts, extractToolResults, isParentTaskTool, type ContentBlock } from '../../tool-matching.ts';
import { classifyClaudeTaskProgress } from './task-notification.ts';
import {
  PARTIAL_TOOL_INPUT_FLOOR_CHARS,
  nextPartialToolInputThreshold,
  parsePartialToolInput,
} from '../partial-tool-input.ts';
import { formatClaudeDenialTypeLabel } from '../../claude-permission-denial-receipt.ts';
import { reportHookRun, type HookRunObservation, type HookRunOutcome } from '../../hook-run-report.ts';
import { scrubToolResultText } from '../../tool-result-secret-scan.ts';
import {
  decideUsageLimitContinuation,
  describeUsageLimitContinuation,
  describeUsageLimitReset,
  readPublishedUsageLimitReset,
} from '../../usage-limit-reset.ts';

/**
 * Callbacks injected by ClaudeAgent for operations that depend on agent state.
 */
/**
 * One entry of the SDK's `system/commands_changed` push, with the fields the
 * host roster used to narrow away — P6.406.
 *
 * Shaped as the OPTIONAL half of the SDK's own `SlashCommand`: it types
 * `description` and `argumentHint` as required strings and sends `''` when a
 * command has neither, and `''` is not a hint. Dropping the empties here is
 * what lets a surface distinguish "no hint" from a hint that is blank.
 */
export interface ClaudeSdkSlashCommandDetail {
  name: string;
  description?: string;
  argumentHint?: string;
  aliases?: readonly string[];
}

export interface ClaudeAdapterCallbacks {
  /** Debug logger — wired to ClaudeAgent.onDebug */
  onDebug?: (msg: string) => void;
  /**
   * P6.643 - one runtime-native hook run, handed to the session's run store.
   *
   * OPTIONAL and inert when absent, deliberately: the adapter already builds
   * this observation for the transcript line, so recording it costs nothing,
   * and the agent that owns the store is the only thing that can supply the
   * sink. `BaseAgent.recordHookRun` is what a caller passes.
   */
  onHookRun?: (observation: HookRunObservation) => void;
  /** Maps SDK error codes to typed AgentErrors (depends on debug log parsing) */
  mapSDKError: (errorCode: SDKAssistantMessageError) => Promise<{ type: 'typed_error'; error: AgentError }>;
  /** Session directory for tool metadata (prevents cross-session race condition) */
  sessionDir?: string;
  /**
   * P3.97 — one SDK-side permission denial, handed on for an audit receipt.
   *
   * The adapter renders the transcript line and knows nothing about session
   * identity or the active permission mode, both of which the receipt needs, so
   * the mint itself belongs to `ClaudeAgent`. This callback is the seam. It is
   * `permission_denied` ONLY: our own gate's blocks never reach this message
   * (`claude-permission-denial-receipt.ts` header, point 3) and are recorded by
   * `__PERMISSION_BLOCK__` instead.
   */
  onPermissionDenied?: (denial: SDKPermissionDeniedMessage) => void;
}

/**
 * Claude SDK result error subtypes → our terminal-reason vocabulary.
 *
 * The keys are the four `SDKResultError['subtype']` values in the installed
 * typings (`agent-sdk/agent-loop.md`, "Handle the result", confirms the same set).
 * Anything unrecognized falls back to `provider_error`, which is also the only
 * reason that still surfaces an `error` event — a cap is a stop, not a crash.
 *
 * Refusal is deliberately absent: it is `stop_reason === 'refusal'`, a sibling of
 * `subtype`, and it can ride on a `success` result.
 */
const CLAUDE_RESULT_SUBTYPE_REASON: Record<SDKResultError['subtype'], AgentTerminalReason> = {
  error_max_turns: 'max_agent_turns',
  error_max_budget_usd: 'max_budget_usd',
  // The documented terminal_reason value for this subtype (doc-verification
  // § R18): the subtype and the terminal reason are distinct identifiers.
  error_max_structured_output_retries: 'structured_output_retry_exhausted',
  error_during_execution: 'provider_error', // F1.731 — unless `terminal_reason` says aborted: then `user_stop`
};

/**
 * Pure function: build a typed_error event for Windows SDK setup issues.
 * Returns null if the error doesn't match the pattern.
 */
export function buildWindowsSkillsDirError(errorText: string): { type: 'typed_error'; error: AgentError } | null {
  if (!errorText.includes('ENOENT') || !errorText.includes('skills')) {
    return null;
  }

  const pathMatch = errorText.match(/scandir\s+'([^']+)'/);
  const missingPath = pathMatch?.[1] || 'C:\\ProgramData\\ClaudeCode\\.claude\\skills';

  return {
    type: 'typed_error',
    error: {
      code: 'unknown_error',
      title: 'Windows Setup Required',
      message: `The SDK requires a directory that doesn't exist: ${missingPath} — Create this folder in File Explorer, then restart the app.`,
      details: [
        `PowerShell (run as Administrator):`,
        `New-Item -ItemType Directory -Force -Path "${missingPath}"`,
      ],
      actions: [],
      canRetry: true,
      originalError: errorText,
    },
  };
}

/**
 * One model's running totals as the CURRENT child last reported them.
 *
 * Derived from the persisted record minus its verdict, so a seventh consumption
 * field added to `PersistedModelUsage` stops compiling here until it is
 * differenced too — the drift this file has to survive is a new field silently
 * keeping the old summing behaviour.
 */
type ModelUsageTotals = Omit<PersistedModelUsage, 'costReporting'>;

function emptyModelUsageTotals(): ModelUsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    webSearchRequests: 0,
    costUsd: 0,
  };
}

/**
 * One field's own delta: how much of `running` is NEW since the last result,
 * advancing the baseline in place.
 *
 * The rule is `takeReportedCostDelta`'s, field for field, deliberately — see
 * that method for why the backwards case is TWO cases and not one (P2.46). Both
 * guards move together or they disagree about a restart, which is the
 * contradiction P2.42 exists to end.
 *
 * The signal that a child really did start over is still explicit and separate
 * ({@link ClaudeEventAdapter.resetReportedModelUsageTotals}); the restart branch
 * below is the fallback for a reset that never arrives, not a replacement for it.
 */
function advanceTotal(
  baseline: ModelUsageTotals,
  field: keyof ModelUsageTotals,
  running: number,
): number {
  const previous = baseline[field];
  // A zeroed crash entry: contribute nothing and KEEP the baseline, or the next
  // result re-counts everything already counted.
  if (running === 0) return 0;
  // A smaller NON-ZERO total is a counter that started over, so all of it is new.
  if (running < previous) {
    baseline[field] = running;
    return running;
  }
  if (running === previous) return 0;
  baseline[field] = running;
  return running - previous;
}

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * P2.36 — the one rule for "did the CLI actually price this?", used by both the
 * top-line verdict and the per-model one so the two can never disagree.
 *
 * A figure is real when it is one; a zero is not. The full reasoning is at the
 * top-line call site (`costReporting: claudeCostReporting(msg.total_cost_usd)`).
 */
/**
 * P6.55 · the shared wire value, spelled once and pinned by `satisfies` so a
 * rename in `core` fails this file rather than shipping a reason the renderer
 * and the session store do not recognise — the same guard
 * `backend/codex/event-adapter.ts` puts on its own copy.
 */
const CLAUDE_AUTO_COMPACTION_THRASHING_REASON = 'auto_compaction_thrashing' satisfies AgentTerminalReason;

/**
 * What the user is told when the SDK's own breaker trips.
 *
 * Deliberately the SAME SHAPE and the same three recovery steps as
 * `backend/codex/event-adapter.ts:autoCompactionThrashingNotice` — an `info` at
 * `warning` level — because the point of the row is that the two runtimes stop
 * differing on this failure. It carries no refill COUNT: codex's guard counts
 * its own refills and can name the number, while here the count lives inside
 * the SDK (`consecutiveRapidRefills`, threshold 3) and is not published on the
 * result, so naming one would be inventing it.
 */
function claudeAutoCompactionThrashingNotice(): AgentEvent {
  return {
    type: 'info',
    level: 'warning',
    message: 'Auto-compaction is thrashing: the context refilled to the limit immediately after each of the'
      + ' last few compactions, so this turn stops instead of looping. Read the oversized file in smaller'
      + ' ranges, run /compact with a focus that drops the large output, or run /clear.',
  };
}

function claudeCostReporting(total: unknown): TurnCostReporting {
  return finite(total) > 0 ? 'reported' : 'unsupported';
}

/**
 * Per-message usage snapshot for accurate context window display.
 *
 * `result.modelUsage` is cumulative across the steps of one result — which is
 * what the per-model map wants and what the context-window display does not, so
 * the display keeps its own per-message snapshot below.
 */
interface AssistantUsage {
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/**
 * Shape of the SDK's `task_notification` system message.
 * The SDK doesn't export a type for this, so we define it locally
 * and validate fields before use to catch silent breakage.
 */
interface TaskNotificationMessage {
  type: 'system';
  subtype: 'task_notification';
  task_id: string;
  status?: string;
  output_file?: string;
  summary?: string;
  session_id?: string;
}

/** Valid terminal statuses for background tasks */
const VALID_TASK_STATUSES = ['completed', 'failed', 'stopped'] as const;
type TaskStatus = typeof VALID_TASK_STATUSES[number];

/**
 * Read Claude's `api_retry` into the shared retry FACTS.
 *
 * P6.916 — this used to assemble the sentence itself, in the exact vocabulary
 * `SessionManager` sniffed, because the internal AgentEvent `status` shape
 * carried only `message`. The branch now has an optional `retry` field, so this
 * site names the facts and `retryStatusEvent` (`core/types/message.ts`) mints
 * both the payload and the sentence — one vocabulary, three producers, and the
 * chip is stamped off a field instead of a prefix that could be reworded.
 *
 * The cause is classified off the SDK's own `error` code rather than off the
 * HTTP status: `api_retry` fires for overload and 5xx as well, so naming a rate
 * limit unconditionally would state a false cause on most retries. `error_status
 * === 429` is the fallback for a retry whose error code is `unknown`.
 */
function buildRetryFacts(input: {
  attempt?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  errorCode?: string;
  errorStatus?: number | null;
}): AgentRetryFacts {
  const isRateLimit = input.errorCode === 'rate_limit' || input.errorStatus === 429;
  // P6.274 (b) — the SPECIFIC reason, and it is the SDK's own word for it, not
  // a taxonomy of ours. `api_retry` fires for overload, 5xx and connection
  // failures alike and `Provider error` alone cannot tell a user which one is
  // costing them the wait. `unknown` is the SDK's own placeholder, so it is
  // dropped in favour of the HTTP status when there is one; when neither says
  // anything the line stays exactly what it was.
  const code = typeof input.errorCode === 'string' ? input.errorCode.trim() : '';
  const cause = isRateLimit
    ? ''
    : (code && code !== 'unknown'
      ? code
      : (typeof input.errorStatus === 'number' ? `HTTP ${input.errorStatus}` : ''));
  const delaySeconds = typeof input.retryDelayMs === 'number' && input.retryDelayMs > 0
    ? Math.max(1, Math.round(input.retryDelayMs / 1000))
    : undefined;
  return {
    kind: isRateLimit ? 'rate_limit' : 'provider_error',
    ...(cause ? { cause } : {}),
    ...(typeof input.attempt === 'number' ? { attempt: input.attempt } : {}),
    // A denominator only rides WITH a numerator: `retry /5` is not a sentence,
    // and the SDK can publish `max_retries` on a frame that names no attempt.
    ...(typeof input.attempt === 'number' && typeof input.maxRetries === 'number'
      ? { maxAttempts: input.maxRetries }
      : {}),
    ...(delaySeconds !== undefined ? { delaySeconds } : {}),
  };
}

/**
 * P3.268 — one spelling for "is this the same model", used on both sides of the
 * context-window comparison.
 *
 * `options.model` may carry the `[1m]` selector while `modelUsage` is keyed by
 * the wire id and `getContextUsage().model` reports the main-loop model. Three
 * spellings of one model would otherwise make the SDK's window look like it
 * belonged to a different one and be discarded every time.
 */
function normalizeContextModelKey(model: string): string {
  const trimmed = model.trim();
  const suffix = trimmed.indexOf('[');
  return (suffix > 0 ? trimmed.slice(0, suffix) : trimmed).toLowerCase();
}

export class ClaudeEventAdapter extends BaseEventAdapter {
  // Per-turn state (reset on each startTurn)
  private toolIndex = new ToolIndex();
  private emittedToolStarts = new Set<string>();
  private activeParentTools = new Set<string>();
  private pendingText: string | null = null;

  /**
   * P6.917 — a retry chip is standing and nothing has cleared it.
   *
   * MEASURED BEFORE BUILDING, because the bundle is the denominator: the
   * vendored SDK publishes NO retry-resolution event. `api_retry` is documented
   * *"Emitted when an API request fails with a retryable error and will be
   * retried after a delay"* — a START only — and the only other retry spelling
   * in `sdk.d.ts` is `structured_output_retry_exhausted`, a `TerminalReason` for
   * a different mechanism. So there is nothing native to adopt and the fallback
   * the row names applies: the retry is over when the model speaks again.
   *
   * PER TURN, reset in {@link onTurnStart}, so a chip cannot survive into a turn
   * whose retry it was never about. The clear is emitted at most ONCE per retry
   * — a second `Retry succeeded` on the next delta of the same reply would
   * republish the line and re-anchor the renderer's countdown.
   */
  private retryChipStanding = false;

  /**
   * P6.158 — tool input arriving live, keyed by the stream's content-block
   * index. `includePartialMessages: true` has always made the SDK send
   * `input_json_delta` frames and this adapter had no branch for them, so a
   * tool call's arguments appeared in one block when the assistant message
   * landed. See `../partial-tool-input.ts` for the two rules these entries
   * keep — never registered in `ToolIndex`, re-emitted on a doubling schedule.
   */
  private partialToolInputs = new Map<
    number,
    { id: string; name: string; parentToolUseId?: string; buffer: string; nextEmitAt: number; emitted: boolean }
  >();

  // Session-persistent state (survives across turns)
  private lastAssistantUsage: AssistantUsage | null = null;
  private cachedContextWindow?: number;

  /**
   * The context window the SDK itself reported, or `undefined` before the first
   * result carries one.
   *
   * Exposed because R14 emits a `usage_update` from OUTSIDE this adapter — off
   * the raw `compact_boundary` message — and every other producer on this path
   * uses this figure. The alternative, `UsageTracker.getContextWindow()`, is the
   * STATIC model-registry value seeded once at construction; nothing on the
   * Claude path ever calls `setContextWindow`. On the gateway configuration the
   * model ids are absent from that registry, so it reads a 200 000 fallback —
   * and an event carrying it would silently re-size the context meter's
   * denominator on every compaction. Measured in review: a stream reporting a
   * 240 000 window produced `usage_update{200000} → complete{240000} →
   * usage_update{200000}`.
   */
  getReportedContextWindow(): number | undefined {
    return this.cachedContextWindow;
  }

  /**
   * P3.268 — THE DENOMINATOR, TAKEN FROM THE RUNTIME'S OWN ACCOUNTING.
   *
   * `cachedContextWindow` above is derived from `modelUsage[*].contextWindow`,
   * which is the model's RAW window. The SDK computes a different and more
   * honest number and has always been willing to hand it over:
   * `Query.getContextUsage().rawMaxTokens` is, in its own words, *"The window
   * usage is measured against: the resolved autocompact window — the model's
   * believed limit, or a smaller compaction-policy window (a configured value,
   * or e.g. the 200K boundary on 1M-window models)."*
   *
   * The two disagree exactly where it matters most to this fork. A `[1m]`
   * session under a compaction policy has a raw window of 1 000 000 and a
   * resolved window of 200 000 — a meter reading 20% where the truth is 100%,
   * with no reporter on either side. `getContextUsage()` is a control request
   * with no model call, and the window only moves when the model or the
   * compaction policy moves, so `ClaudeAgent` refreshes it at spawn and on a
   * live `setModel` rather than per turn.
   *
   * MODEL-SCOPED, and that is the whole safety of it. A window recorded for one
   * model must not survive a switch to another, so {@link adaptResult} keeps
   * deriving from `modelUsage` and only DEFERS to this value while the model
   * matches. A mismatch silently falls back to the behaviour that shipped.
   */
  applySdkContextUsage(usage: { model?: unknown; rawMaxTokens?: unknown } | null | undefined): boolean {
    const model = typeof usage?.model === 'string' ? usage.model : null;
    const raw = typeof usage?.rawMaxTokens === 'number' && Number.isFinite(usage.rawMaxTokens) && usage.rawMaxTokens > 0
      ? usage.rawMaxTokens
      : null;
    if (!model || raw === null) return false;
    this.sdkContextWindow = { model: normalizeContextModelKey(model), rawMaxTokens: raw };
    this.cachedContextWindow = raw;
    return true;
  }

  /** Per-CHILD, like the background-task level: a new child re-reports its own. */
  clearSdkContextUsage(): void {
    this.sdkContextWindow = null;
  }

  /**
   * The SDK-reported window, kept beside the derived one rather than replacing
   * it — see {@link applySdkContextUsage} for why the model key is load-bearing.
   */
  private sdkContextWindow: { model: string; rawMaxTokens: number } | null = null;
  private _sdkTools: string[] = [];
  /**
   * Slash commands the SDK reports — the `init` snapshot, then every
   * `commands_changed` replacement. Deliberately NOT reset per turn: a plugin
   * installed mid-session changes this set and it stays changed.
   */
  private _sdkSlashCommands: string[] = [];
  /**
   * The SAME commands, with the three fields beside the name that the SDK
   * sends and the roster used to drop — P6.406.
   *
   * Kept beside {@link _sdkSlashCommands} rather than replacing it: that array
   * is the baseline the `commands_changed` diff subtracts from and P3.269
   * measured that replacing it with a re-fetch deletes the "New commands
   * available" notice. This is a second view of one push, never a second
   * source — {@link adaptCommandsChanged} writes both from the same payload in
   * the same statement, so they cannot describe different sets.
   *
   * Empty until the first `commands_changed`: `system/init` sends
   * `slash_commands` as bare NAMES (`msg.slash_commands: string[]`), so there
   * is nothing richer to record at that point and inventing empty details for
   * it would make "no hint" indistinguishable from "not told yet".
   */
  private _sdkSlashCommandDetails: readonly ClaudeSdkSlashCommandDetail[] = [];
  /**
   * P6.1006 — the OTHER two rosters `system/init` carries beside
   * `slash_commands`, which this adapter used to drop on the floor.
   *
   * The vendored `sdk.d.ts` (`SDKSystemMessage`, bundle self-report `2.1.247`;
   * re-read 2026-09-12, C3.252, and unchanged from the `2.1.233` reading this
   * paragraph was written against — the object has since also gained
   * `terminal_slash_commands?: string[]`, which is a different roster and not
   * this adapter's subject)
   * declares `skills: string[]` and `agents?: string[]` in the same object as
   * `slash_commands`, both as bare NAMES — so the capture below is the same
   * statement three times, not a new source. Kept as ARRAYS rather than folded
   * into the command roster because they are different kinds: a skill is not
   * invocable as `/name` and an agent is not invocable at all.
   *
   * Not reset per turn, for {@link _sdkSlashCommands}'s reason — `system/init`
   * arrives per turn and re-seeds them, and a plugin installed mid-session
   * changes the sets for good. There is no `skills_changed` / `agents_changed`
   * push in the bundle's message union, so `init` is the only writer.
   *
   * Once this ships, the RS-23 sitting case no longer needs its
   * walk-the-SDK's-own-`.jsonl` fallback for the claude skills roster: the
   * roster is readable from the adapter, in process, at the same instant the
   * command roster is.
   */
  private _sdkSkills: string[] = [];
  private _sdkAgents: string[] = [];
  /**
   * Task ids from the last `background_tasks_changed` payload, so a repeated
   * REPLACE payload does not re-announce tasks the user was already told about.
   *
   * Outlives a TURN but is per-CHILD, not per-session — see
   * {@link resetBackgroundTaskLevel}, which exists because reading this as
   * session-persistent (the belief this comment used to state) made the adapter
   * carry a dead child's ids into a new one. Read as a liveness signal through
   * {@link backgroundTaskCount}.
   */
  /**
   * P6.642 — one orchestration run per SUBAGENT TOOL CALL, so the AgentPanel's
   * card has something to render on claude.
   *
   * Keyed by `tool_use_id` because that is what `OrchestrationProgress` is
   * addressed by everywhere else in this product: the renderer writes the
   * snapshot onto the activity row for that tool use. A `task_id` names the
   * AGENT inside the run and has no transcript row of its own, which is the same
   * reason the `task_progress` branch below refuses to surface a task without a
   * `tool_use_id`.
   *
   * Per-CHILD state, so it is cleared on respawn beside `resetBackgroundTaskLevel`
   * for the reason `packages/shared/AGENTS.md` states about this adapter: it is
   * an agent field and survives every `ensureLiveSession` rebuild, and a run
   * whose child is gone can never be completed.
   */
  private orchestrationRuns = new Map<string, { runId: string; agents: Map<string, OrchestrationProgressAgent> }>();

  /**
   * P6.642 — `task_id` → the `tool_use_id` its run is keyed by.
   *
   * Needed because `SDKTaskUpdatedMessage` carries NO `tool_use_id` (only
   * `task_started` and `task_progress` do), so a terminal status has no other
   * way back to the row it belongs to. A task never seen with a `tool_use_id`
   * simply has no entry and its update changes nothing, which is the same
   * silence the `task_progress` branch already gives such a task.
   */
  private orchestrationRunByTask = new Map<string, string>();

  private knownBackgroundTasks = new Map<string, { description?: string; taskType?: string; ambient?: boolean }>();

  /**
   * P2.35 — the running cost total the CURRENT child last reported.
   *
   * Per-CHILD, like {@link knownBackgroundTasks} above and for the same
   * reason, so it is cleared by {@link resetReportedCostTotal} from the one line
   * that spawns a child. See {@link takeReportedCostDelta} for why it exists at
   * all.
   */
  private reportedCostTotalUsd = 0;

  /**
   * P2.42 — the running per-model totals the CURRENT child last reported, keyed
   * by the model string the SDK used.
   *
   * The map form of {@link reportedCostTotalUsd}, per CHILD for the same reason
   * and cleared on the same spawn line by
   * {@link resetReportedModelUsageTotals}. See
   * {@link takeReportedModelUsageDelta}.
   */
  private reportedModelUsageTotals = new Map<string, ModelUsageTotals>();

  private callbacks: ClaudeAdapterCallbacks;

  constructor(callbacks: ClaudeAdapterCallbacks) {
    super('claude-adapter');
    this.callbacks = callbacks;
  }

  // ============================================================
  // Turn Lifecycle
  // ============================================================

  protected onTurnStart(): void {
    this.toolIndex = new ToolIndex();
    this.emittedToolStarts = new Set();
    this.activeParentTools = new Set();
    this.pendingText = null;
    this.lastAssistantUsage = null;
    this.partialToolInputs.clear();
    // P6.917 — see the field. A chip from the previous turn is not this turn's.
    this.retryChipStanding = false;
  }

  // ============================================================
  // Public API
  // ============================================================

  /**
   * Convert an SDK message to AgentEvents.
   * Main entry point called from ClaudeAgent's for-await loop.
   */
  async adapt(message: SDKMessage): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];

    // Debug: log non-streaming SDK message types (stream_event is too frequent)
    if (this.callbacks.onDebug && message.type !== 'stream_event') {
      const msgInfo = message.type === 'user' && 'tool_use_result' in message
        ? `user (tool_result for ${(message as any).parent_tool_use_id})`
        : message.type;
      this.callbacks.onDebug(`SDK message: ${msgInfo}`);
    }

    switch (message.type) {
      case 'assistant':
        await this.adaptAssistant(message, events);
        break;

      case 'stream_event':
        this.adaptStreamEvent(message, events);
        break;

      case 'user':
        this.adaptUser(message, events);
        break;

      case 'tool_progress':
        this.adaptToolProgress(message, events);
        break;

      case 'result':
        this.adaptResult(message, events);
        break;

      case 'system':
        this.adaptSystem(message, events);
        break;

      case 'auth_status':
        this.adaptAuthStatus(message, events);
        break;

      case 'rate_limit_event':
        this.adaptRateLimit(message as SDKRateLimitEvent, events);
        break;

      case 'conversation_reset':
        // The SDK started a fresh conversation id under us. `claude-agent.ts`
        // already re-pins `this.sessionId` off `session_id`, so nothing is
        // broken — but the user's transcript now belongs to a different
        // conversation and that is worth one line rather than zero.
        events.push({ type: 'info', message: 'Conversation was reset.' });
        break;

      case 'tool_use_summary':
        // DELIBERATE DROP. The SDK condenses a run of tool calls into one prose
        // summary keyed by `preceding_tool_use_ids`. Our transcript renders every
        // tool call individually and has no "collapse this group" affordance, so
        // the summary would be a second, redundant description of rows the user
        // is already looking at. Revisit if the transcript ever grows tool-group
        // collapsing.
        this.callbacks.onDebug?.(
          `[EventAdapter] tool_use_summary dropped (no group-collapse surface): ${(message as any).summary ?? ''}`,
        );
        break;

      case 'prompt_suggestion':
        // DELIBERATE DROP. This is a suggested NEXT prompt, whose only sensible
        // destination is a clickable composer chip. Rendering it as a transcript
        // banner would show the user text they cannot act on and would read as
        // the assistant talking to itself. Needs a composer surface, not an
        // AgentEvent.
        //
        // P6.475 — the drop was recorded here and the SWITCH VERDICT was not,
        // which is the silent-divergence shape native-first warns about. The
        // verdict now has a row of its own in
        // `docs/architecture/runtime-capability-gaps.md` (Claude section),
        // marked `[switch: none]` with the reason: Pi has no producer and codex
        // has no equivalent event, so the user-visible capability is absent on
        // all three and only the PRODUCER differs. Enabling it on claude alone
        // would MANUFACTURE a runtime difference for a cosmetic feature rather
        // than close one. The day a composer chip exists this becomes a switch
        // question, and that row is where it will be answered.
        this.callbacks.onDebug?.(
          `[EventAdapter] prompt_suggestion dropped (no composer chip surface): ${(message as any).suggestion ?? ''}`,
        );
        break;

      default:
        if (this.callbacks.onDebug) {
          this.callbacks.onDebug(`Unhandled SDK message type: ${(message as any).type}`);
        }
        break;
    }

    return events;
  }

  /**
   * Flush any pending text that hasn't been emitted.
   * Called after the for-await loop exits to handle edge cases
   * (e.g., SDK sends assistant message with text but skips message_delta).
   */
  flushPending(): AgentEvent | null {
    if (this.pendingText) {
      const event: AgentEvent = {
        type: 'text_complete',
        text: this.pendingText,
        isIntermediate: false,
        turnId: this.currentTurnId || undefined,
      };
      this.pendingText = null;
      return event;
    }
    return null;
  }

  /**
   * Get SDK tools captured from init message.
   */
  get sdkTools(): string[] {
    return this._sdkTools;
  }

  /**
   * Slash commands the SDK currently offers — `init`'s `slash_commands`, kept
   * current by `commands_changed`. Read by the `commands_changed` diff itself
   * (which is what makes a mid-session change announceable at all); R9 can read
   * the same list when the model-facing command dispatcher is ported to Claude.
   */
  get sdkSlashCommands(): string[] {
    return this._sdkSlashCommands;
  }

  /**
   * The last `commands_changed` push with its `description`, `argumentHint`
   * and `aliases` intact — P6.406.
   *
   * Empty before the first push, and never a subset of
   * {@link sdkSlashCommands} out of step with it.
   */
  get sdkSlashCommandDetails(): readonly ClaudeSdkSlashCommandDetail[] {
    return this._sdkSlashCommandDetails;
  }

  /**
   * Skill names the SDK reports on `system/init` — P6.1006.
   *
   * Empty until the first `init`, and empty on a CLI that sends no `skills`
   * (the field is required in the vendored typing, so an empty array there
   * means "this session has no skills", not "not told yet").
   */
  get sdkSkills(): string[] {
    return this._sdkSkills;
  }

  /**
   * Agent names the SDK reports on `system/init` — P6.1006.
   *
   * `agents` is OPTIONAL in the vendored typing, so absence is the ordinary
   * case on a CLI that predates the field and leaves the last roster standing
   * rather than clearing it.
   */
  get sdkAgents(): string[] {
    return this._sdkAgents;
  }

  /**
   * D1.328 — all four `system`/`init` rosters as one reading, for the host's
   * session read.
   *
   * `undefined` before the first `init`, so the host can tell *"the SDK
   * advertised nothing"* from *"the SDK has not spoken yet"* — a distinction an
   * always-present empty object would destroy, and the one that makes a
   * diagnostics field worth reading at all.
   *
   * It lives HERE rather than in `ClaudeAgent` because the rosters do: the agent
   * method that carries it to `AgentBackend` is a one-line delegation, and a
   * projection defined beside the fields it reads can be driven by feeding this
   * adapter a real `init`, which is the only instrument that proves the four
   * captures and the one reading agree.
   *
   * Copies rather than the live arrays: `commands_changed` mutates
   * {@link sdkSlashCommands} in place, and a DTO holding that array would change
   * under a client that had already received it.
   */
  get advertisedRosters(): RuntimeAdvertisedRostersV1 | undefined {
    if (!this._sdkTools.length && !this._sdkSlashCommands.length
      && !this._sdkSkills.length && !this._sdkAgents.length) return undefined;
    return {
      tools: [...this._sdkTools],
      slashCommands: [...this._sdkSlashCommands],
      skills: [...this._sdkSkills],
      agents: [...this._sdkAgents],
    };
  }

  /**
   * Get the tool index (for agent-level operations like inactive source detection).
   */
  getToolIndex(): ToolIndex {
    return this.toolIndex;
  }

  /**
   * Get the set of active parent tools (exposed for source activation detection).
   */
  getActiveParentTools(): Set<string> {
    return this.activeParentTools;
  }

  /**
   * Update the session directory for tool metadata lookups.
   */
  updateSessionDir(sessionDir: string): void {
    this.callbacks.sessionDir = sessionDir;
  }

  // ============================================================
  // Per-message-type Handlers
  // ============================================================

  /**
   * P4.4 · surface the reasoning blocks the SDK has always sent and this
   * adapter has always dropped.
   *
   * NATIVE-FIRST, asked before building: nothing needed enabling. The blocks
   * are already on the wire — `@anthropic-ai/sdk`'s `ContentBlock` union
   * (`resources/messages/messages.d.ts:551`) is
   * `TextBlock | ThinkingBlock | RedactedThinkingBlock | ToolUseBlock | …`, and
   * this method's caller read only `block.type === 'text'` and, through
   * `extractToolStarts`, `tool_use`. The user's existing `thinkingLevel: 'off'`
   * control (→ `thinking: { type: 'disabled' }`) still means no blocks are
   * produced at all, so there is no new switch to add.
   *
   * REDACTION — three rules, and the first is the one that matters:
   *
   * 1. `redacted_thinking` is DROPPED, never rendered. Its shape is
   *    `{ data: string; type: 'redacted_thinking' }` — `data` is opaque
   *    ciphertext and there is no readable field. Emitting it would paint a
   *    reasoning row full of base64, which is worse than painting none: it
   *    looks like corruption and it tells the user nothing. Dropping it is not
   *    silent either — the reasoning that WAS legible in the same message still
   *    renders, so the row count tells the honest story.
   * 2. `signature` IS carried, as `thinkingSignature` (P6.481 — the loop below
   *    says why it was once dropped). It is a cryptographic attestation over
   *    the reasoning, not content, so nothing renders it; the claude → claude
   *    replay reads it: `SessionManager.processEvent` persists it on the
   *    message, `buildRuntimeHandoffHistory` (server-core's
   *    `sessions/runtime-handoff.ts`) maps `row.thinkingSignature` onto the
   *    `reasoning` item's `signature`, and `buildClaudeTranscriptRecords`
   *    (`agent/claude-transcript-rebuild.ts`) replays the block with it — or
   *    strips one without it, which `ThinkingBlockParam` cannot express.
   * 3. Empty/whitespace-only reasoning yields no event, so a redaction that
   *    leaves an empty `thinking` string cannot produce a blank row.
   *
   * The turnId is `<message turn>__thinking<block index>`, matching Pi's
   * `<turn>__thinking<N>` shape (`backend/pi/event-adapter.ts`). It MUST differ
   * from the message's own turnId: the renderer looks a `text_complete` up by
   * turnId across the whole transcript, so sharing one id would let the final
   * assistant text overwrite the reasoning row. The block index makes it
   * unique without keeping any state.
   *
   * C3.348 — that scheme now has a SECOND writer and is therefore a contract
   * between two sites rather than a local convention: `adaptStreamEvent`'s
   * `thinking_delta` branch streams the same block under the same id (a stream
   * frame's `event.index` is this `index`), so the live row and the finished row
   * are one row. Changing the shape here without changing it there splits every
   * reasoning block into two rows on screen.
   */
  private extractThinkingEvents(content: unknown[], message: SDKMessage): AgentEvent[] {
    const events: AgentEvent[] = [];
    const base = this.currentTurnId || (message as any).message?.id;
    if (!base) return events;

    content.forEach((raw, index) => {
      const block = raw as { type?: string; thinking?: unknown; signature?: unknown };
      if (block?.type !== 'thinking') return;
      const text = typeof block.thinking === 'string' ? block.thinking : '';
      if (!text.trim()) return;
      // P6.481 · the ATTESTATION, kept rather than dropped.
      //
      // This block used to read `{ type, thinking }` and the signature went in
      // the bin with the rest of the block. That was the whole reason reasoning
      // could not cross a claude → claude switch: `ThinkingBlockParam` in
      // `@anthropic-ai/sdk` declares `signature: string` as REQUIRED, so a
      // replayed thinking block without one is not expressible, let alone
      // accepted — and what we never captured we could never replay.
      //
      // Read defensively: it is required on `ThinkingBlock`, but this adapter
      // reads an `unknown[]`, and a `redacted_thinking` block (dropped above by
      // the `type` test) carries no readable text at all.
      const signature = typeof block.signature === 'string' && block.signature !== ''
        ? block.signature
        : undefined;
      events.push({
        type: 'text_complete',
        text,
        isIntermediate: true,
        isThinking: true,
        ...(signature ? { thinkingSignature: signature } : {}),
        turnId: `${base}__thinking${index}`,
        parentToolUseId: (message as any).parent_tool_use_id || undefined,
      });
    });

    return events;
  }

  private async adaptAssistant(message: SDKMessage, events: AgentEvent[]): Promise<void> {
    // Check for SDK-level errors FIRST (auth, network, rate limits, etc.)
    if ('error' in message && message.error) {
      const errorEvent = await this.callbacks.mapSDKError(
        message.error as SDKAssistantMessageError,
      );
      events.push(errorEvent);
      return;
    }

    // Skip replayed messages when resuming a session
    if ('isReplay' in message && message.isReplay) {
      return;
    }

    // Track usage from non-sidechain assistant messages. On the first-party
    // wire this is the whole story; on the gateway wire it is empty and the
    // `message_delta` stream event carries the numbers instead (see F6 below).
    this.recordAssistantUsage(message, (message as any).message?.usage, events);

    // Full assistant message with content blocks
    const content = (message as any).message?.content ?? [];

    // Extract text from content blocks
    let textContent = '';
    for (const block of content) {
      if (block.type === 'text') {
        textContent += block.text;
      }
    }

    events.push(...this.extractThinkingEvents(content, message));

    // Stateless tool start extraction
    const sdkParentId = (message as any).parent_tool_use_id;
    const toolStartEvents = extractToolStarts(
      content as ContentBlock[],
      sdkParentId,
      this.toolIndex,
      this.emittedToolStarts,
      this.currentTurnId || undefined,
      this.activeParentTools,
      this.callbacks.sessionDir,
    );

    // Track active Task tools for fallback parent assignment
    for (const event of toolStartEvents) {
      if (event.type === 'tool_start' && isParentTaskTool(event.toolName)) {
        this.activeParentTools.add(event.toolUseId);
      }
    }

    events.push(...toolStartEvents); if (sdkParentId == null) this.rememberMainLineToolUses(content as ContentBlock[]); // UA12.192

    if (textContent) {
      // Don't emit text_complete yet — wait for message_delta to get stop_reason
      this.pendingText = textContent;
    }
  }

  /**
   * Record the per-message context snapshot and announce it, from whichever
   * frame of the turn actually carries one.
   *
   * F6 — why this reads TWO frames instead of the assistant message alone.
   * The assistant message's `message.usage` is the `message_start` snapshot
   * verbatim, and a `claude-runtime` turn does not know its input count at
   * `message_start`: the gateway reports usage only in its trailing chunk, so
   * `anthropic/outbound.ts` opens the stream with `{input_tokens: 0,
   * output_tokens: 0}` and settles the real figures in `message_delta`.
   * Measured against the shipped SDK binary through the real adapter:
   * `assistant.message.usage` = `{input_tokens: 0, output_tokens: 0}` while the
   * same turn's `message_delta.usage` = `{input_tokens: 58392, output_tokens:
   * 38}` — so the display's snapshot was a zero, and `adaptResult` preferred
   * that zero over the result's own correct `usage`. Every claude-runtime
   * session on disk (15 of 15) reported `inputTokens: 0` because of it.
   *
   * The result's `usage` is NOT the substitute: it is cumulative over the
   * steps of one turn, so a tool-using turn would report the sum of every
   * request's prompt instead of the context the next request will carry.
   * `message_delta` is per-request, which is exactly the display's question.
   *
   * A zero total is treated as "no observation" rather than "no context": it
   * neither overwrites a real snapshot nor announces a drop that did not
   * happen. A genuinely-cached turn still lands here — `input_tokens: 0` with a
   * large `cache_read_input_tokens` totals above zero.
   */
  private recordAssistantUsage(message: SDKMessage, rawUsage: unknown, events: AgentEvent[]): void {
    // An ABSENT `parent_tool_use_id` is main-line, not a sidechain. The shipped
    // binary sends the field explicitly (`parent_tool_use_id: null`) on every
    // main-line assistant and stream_event wrapper — measured, not assumed, so
    // `!= null` changes nothing today — but the older `!== null` would have
    // read a missing field as a sidechain and dropped every usage event.
    if ((message as any).parent_tool_use_id != null) return;
    if (!rawUsage || typeof rawUsage !== 'object') return;

    const usage = rawUsage as Record<string, unknown>;
    const count = (value: unknown): number =>
      typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

    const snapshot: AssistantUsage = {
      input_tokens: count(usage.input_tokens),
      cache_read_input_tokens: count(usage.cache_read_input_tokens),
      cache_creation_input_tokens: count(usage.cache_creation_input_tokens),
    };
    const currentInputTokens =
      snapshot.input_tokens +
      snapshot.cache_read_input_tokens +
      snapshot.cache_creation_input_tokens;
    if (currentInputTokens <= 0) return;

    this.lastAssistantUsage = snapshot; this.lastMainLineModel = claudeMainLineModelOf(message) ?? this.lastMainLineModel; // F1.1283
    events.push({
      type: 'usage_update',
      usage: {
        inputTokens: currentInputTokens,
        contextWindow: this.cachedContextWindow,
      },
    });
  }

  private adaptStreamEvent(message: SDKMessage, events: AgentEvent[]): void {
    const event = (message as any).event;

    // Debug: log key stream events only (skip per-chunk deltas and frequent pings)
    if (this.callbacks.onDebug && (event.type === 'message_start' || event.type === 'message_stop')) {
      this.callbacks.onDebug(
        `stream_event: ${event.type}`,
      );
    }

    // Capture turn ID from message_start
    if (event.type === 'message_start') {
      const messageId = event.message?.id;
      if (messageId) {
        this.currentTurnId = messageId;
      }
    }

    // message_delta contains the actual stop_reason — emit pending text now
    if (event.type === 'message_delta') {
      // ...and the settled per-request usage, which is the only frame that has
      // it on the gateway wire. See `recordAssistantUsage` (F6).
      this.recordAssistantUsage(message, event.usage, events);
      const stopReason = event.delta?.stop_reason;
      if (this.pendingText) {
        const isIntermediate = stopReason === 'tool_use';
        events.push({
          type: 'text_complete',
          text: this.pendingText,
          isIntermediate,
          turnId: this.currentTurnId || undefined,
          parentToolUseId: (message as any).parent_tool_use_id || undefined,
        });
        this.pendingText = null;
      }
    }

    // P6.917 — the retry chip's CLEAR, and it is an inference we say out loud.
    // The SDK announces no retry resolution (see `retryChipStanding`), so the
    // honest signal is the model speaking again: the request that was being
    // retried has succeeded, because its answer is arriving. Emitted BEFORE the
    // delta so the chip is gone by the time the first characters land, and in
    // the same words Pi's `auto_retry_end` uses, because `SessionManager` stamps
    // `statusType: 'retrying'` by matching that prefix and a second spelling
    // would be a silent divergence between two runtimes.
    //
    // D1.140 — it fires on ANY `content_block_delta`, and until this row it
    // fired only inside the `text_delta` branch below. Since C3.348 streamed
    // reasoning the first frames of an answer are often `thinking_delta`, so a
    // chip cleared by prose alone survived visibly longer than the condition it
    // reports. Two judgements, made rather than inherited:
    //
    //  - ON THE FRAME, not on the emitted row. The thinking branch drops a frame
    //    with no `currentTurnId` or an empty fragment, and the tool-input branch
    //    drops one for an unregistered block; the retry condition is *the model
    //    is speaking again*, which the frame proves whether or not the host can
    //    attribute it to a row. Gating the clear on what we managed to emit
    //    would leave the chip standing on exactly the frames we understand least.
    //  - EVERY delta kind, not an enumeration of two. `RawContentBlockDelta`'s
    //    five members (`text`, `thinking`, `input_json`, `citations`,
    //    `signature`) are all content of the assistant's own message, so each
    //    one is the same proof; a turn that resumes after a retry with a tool
    //    call rather than prose is the concrete case. The kind-agnostic test is
    //    also strictly less code than naming the kinds, and cannot go stale when
    //    the SDK adds a sixth.
    //
    // Hoisted ABOVE the branch chain rather than copied into each branch: one
    // clear, so the "at most ONCE per retry" contract on `retryChipStanding`
    // holds by construction and the "emitted before the delta" ordering is the
    // same for every kind.
    if (event.type === 'content_block_delta' && this.retryChipStanding) {
      this.retryChipStanding = false;
      events.push(retryStatusEvent({ kind: 'succeeded' }));
    }

    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      events.push({
        type: 'text_delta',
        text: event.delta.text,
        turnId: this.currentTurnId || undefined,
        parentToolUseId: (message as any).parent_tool_use_id || undefined,
      });
    } else if (event.type === 'content_block_delta' && event.delta.type === 'thinking_delta') {
      // C3.348 — reasoning arriving live, instead of landing as one finished row
      // when the whole assistant message does.
      //
      // NATIVE-FIRST, asked before building: nothing needed enabling. The frames
      // were always on the wire — the vendored `@anthropic-ai/sdk` declares
      // `RawContentBlockDelta = TextDelta | InputJSONDelta | CitationsDelta |
      // ThinkingDelta | SignatureDelta` and `ThinkingDelta` as
      // `{ thinking: string; type: 'thinking_delta' }`, and `claude-agent.ts`
      // has set `includePartialMessages: true` all along. This adapter branched
      // two of those five and dropped this one, so the frames were received and
      // discarded (C3.173 measured both halves against the packaged app's own
      // vendored SDK: 2 `thinking_delta` and 1 `signature_delta` arrived, with a
      // `text_delta` in the same run as the positive control).
      //
      // THE TURN ID IS THE WHOLE DESIGN, and it needs no state to get right.
      // `extractThinkingEvents` closes the row with a `text_complete` whose id
      // is `<turn>__thinking<block index in the assistant message's content>`;
      // a stream frame's `event.index` IS that content-block index, so spelling
      // the id the same way here makes the streamed row and the finished row
      // ONE row rather than two. That mirrors Pi, the in-repo reference for the
      // same shape (`backend/pi/event-adapter.ts` streams `text_delta` under
      // `<turn>__thinking<N>` and closes it with the labelled `text_complete`),
      // which is what keeps the two runtimes from rendering reasoning
      // differently.
      //
      // Two things deliberately NOT read here, each for a reason already settled
      // on `extractThinkingEvents`:
      //
      //  - `signature_delta`. The attestation is kept (P6.481) but it is read
      //    off the FINAL block, where it is whole; a half-streamed signature is
      //    not expressible as `ThinkingBlockParam` and has no reader.
      //  - `redacted_thinking`. It cannot reach this branch at all — a redacted
      //    block arrives whole in `content_block_start` and streams no
      //    `thinking_delta` — so rule 1 of the redaction contract (drop it,
      //    never paint a row of ciphertext) holds here by construction rather
      //    than by a second test.
      //
      // The empty-string guard is the same one Pi applies. Rule 3 there (no
      // blank row from a redaction that left an empty `thinking`) is about the
      // FINAL block and is unreachable from this path, so it is not re-litigated
      // with per-block state the frames do not need.
      // With NO turn id there is no reasoning row to stream into, and a bare
      // `undefined` would merge these fragments into the assistant's ANSWER row
      // — reasoning rendered as the reply. Falling silent leaves exactly today's
      // behaviour (the block still lands whole through `extractThinkingEvents`,
      // which has its own `message.id` fallback), so the degraded case is the
      // old one rather than a wrong one.
      const fragment = (event.delta as { thinking?: unknown }).thinking;
      if (this.currentTurnId && typeof fragment === 'string' && fragment.length > 0) {
        events.push({
          type: 'text_delta',
          text: fragment,
          turnId: `${this.currentTurnId}__thinking${event.index}`,
          parentToolUseId: (message as any).parent_tool_use_id || undefined,
        });
      }
    } else if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
      // P6.158 — a tool call's arguments arriving live. `includePartialMessages`
      // is already on, so these frames were always here and this branch was the
      // only thing missing; without it the input appears in one block when the
      // assistant message lands, through `extractToolStarts`' `hasNewInput`
      // re-emission. Emitted DIRECTLY rather than through `extractToolStarts`,
      // because `ToolIndex.register` overwrites only an EMPTY input — a partial
      // registered there would be frozen for the rest of the session.
      const entry = this.partialToolInputs.get(event.index);
      const fragment = event.delta.partial_json;
      if (entry && typeof fragment === 'string' && fragment.length > 0) {
        entry.buffer += fragment;
        if (entry.buffer.length >= entry.nextEmitAt) {
          entry.nextEmitAt = nextPartialToolInputThreshold(entry.buffer.length);
          const partial = parsePartialToolInput(entry.buffer);
          if (partial && Object.keys(partial).length > 0) {
            entry.emitted = true;
            events.push({
              type: 'tool_start',
              toolName: entry.name,
              toolUseId: entry.id,
              input: partial,
              turnId: this.currentTurnId || undefined,
              parentToolUseId: entry.parentToolUseId,
            });
          }
        }
      }
    } else if (event.type === 'content_block_stop') {
      // Complete the card we started drawing. ONLY when an incremental view was
      // actually emitted: a small input never drew one, and the assistant
      // message's own re-emission (with intent and display name) is the right
      // and only event for it. Here the buffer is whole, so this parse is the
      // exact input — the incremental views before it were prefixes.
      const entry = this.partialToolInputs.get(event.index);
      if (entry?.emitted) {
        const complete = parsePartialToolInput(entry.buffer);
        if (complete && Object.keys(complete).length > 0) {
          events.push({
            type: 'tool_start',
            toolName: entry.name,
            toolUseId: entry.id,
            input: complete,
            turnId: this.currentTurnId || undefined,
            parentToolUseId: entry.parentToolUseId,
          });
        }
      }
      this.partialToolInputs.delete(event.index);
    } else if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
      // Stream events arrive with empty input — the full input comes later
      const toolBlock = event.content_block;
      const sdkParentId = (message as any).parent_tool_use_id;
      // P6.158 — open the live-input accumulator for this content block. The
      // id and name are final here; only the arguments stream.
      if (typeof toolBlock.id === 'string' && typeof toolBlock.name === 'string') {
        this.partialToolInputs.set(event.index, {
          id: toolBlock.id,
          name: toolBlock.name,
          parentToolUseId: sdkParentId || undefined,
          buffer: '',
          nextEmitAt: PARTIAL_TOOL_INPUT_FLOOR_CHARS,
          emitted: false,
        });
      }
      const streamBlocks: ContentBlock[] = [{
        type: 'tool_use' as const,
        id: toolBlock.id,
        name: toolBlock.name,
        input: (toolBlock.input ?? {}) as Record<string, unknown>,
      }];
      const streamEvents = extractToolStarts(
        streamBlocks,
        sdkParentId,
        this.toolIndex,
        this.emittedToolStarts,
        this.currentTurnId || undefined,
        this.activeParentTools,
        this.callbacks.sessionDir,
      );

      // Track active Task/Agent tools for fallback parent assignment
      for (const evt of streamEvents) {
        if (evt.type === 'tool_start' && isParentTaskTool(evt.toolName)) {
          this.activeParentTools.add(evt.toolUseId);
        }
      }

      events.push(...streamEvents);
    }
  }

  private adaptUser(message: SDKMessage, events: AgentEvent[]): void {
    // Skip replayed messages when resuming
    if ('isReplay' in message && message.isReplay) {
      return;
    }

    // Tool result matching
    if ((message as any).tool_use_result !== undefined || ('message' in message && (message as any).message)) {
      const msgContent = ('message' in message && (message as any).message)
        ? (((message as any).message as { content?: unknown[] }).content ?? [])
        : [];
      const contentBlocks = (Array.isArray(msgContent) ? msgContent : []) as ContentBlock[];

      const sdkParentId = (message as any).parent_tool_use_id;
      const toolUseResultValue = (message as any).tool_use_result;

      const resultEvents = extractToolResults(
        contentBlocks,
        sdkParentId,
        toolUseResultValue,
        this.toolIndex,
        this.currentTurnId || undefined,
      );

      // Remove completed Task/Agent tools from activeParentTools
      for (const event of resultEvents) {
        if (event.type === 'tool_result' && isParentTaskTool(event.toolName ?? '')) {
          this.activeParentTools.delete(event.toolUseId);
        }
      }

      // P6.574 · the claude arm of the host secret scan, on the ONE path a
      // claude tool result takes into this host: the SDK reports it inside a
      // `user` message and `extractToolResults` turns it into our events, so
      // there is no second entry point to keep in step.
      //
      // Native asked (step 1): the vendored binary DOES carry a gitleaks-shaped
      // named ruleset — probed, 56 rules — and no documented setting or env
      // spelling reaches it, so it cannot be enabled and could not serve the
      // other two runtimes even if it could. Step 2, the host's one scanner, is
      // what is wired here.
      //
      // Applied to the events rather than to the blocks so it sits AFTER the
      // matching (a scrubbed text can never change which tool a result belongs
      // to) and BEFORE anything downstream reads `result`. A clean result is the
      // very same object — `scrubToolResultText` returns the input identically
      // when nothing fired — so a turn with no credential in it is byte-for-byte
      // what it was before this line.
      //
      // P6.753 asked the same question of `structuredContent`, which the codex
      // and Pi arms now scan. The claude arm needs no such call and the absence
      // is MEASURED, not assumed: `extractToolResults` builds every claude
      // `tool_result` event by hand and sets no `structuredContent` on either of
      // its two branches (the content-block path and the `tool_use_result`
      // fallback), so a claude result has no machine payload for a credential to
      // hide in. `structuredContent` does not occur in this file. Pinned by a
      // test rather than left to a reader, so the day the SDK starts reporting
      // one, this comment goes red instead of quietly becoming false.
      events.push(...resultEvents.map(event => (
        event.type === 'tool_result' && typeof event.result === 'string'
          ? { ...event, result: scrubToolResultText(claudeMcpTextBlocksResult(event, contentBlocks, toolUseResultValue) ?? event.result) }
          : event
      )));
    }
  }

  private adaptToolProgress(message: SDKMessage, events: AgentEvent[]): void {
    const progress = message as unknown as {
      tool_use_id: string;
      tool_name: string;
      parent_tool_use_id: string | null;
      elapsed_time_seconds?: number;
    };

    // Forward elapsed time for live progress updates
    if (progress.elapsed_time_seconds !== undefined) {
      events.push({
        type: 'task_progress',
        toolUseId: progress.parent_tool_use_id || progress.tool_use_id,
        elapsedSeconds: progress.elapsed_time_seconds,
        turnId: this.currentTurnId || undefined,
      });
    }

    // Emit tool_start for tools discovered through progress events
    if (!this.emittedToolStarts.has(progress.tool_use_id) && !isToolHeartbeat(progress)) {
      const progressBlocks: ContentBlock[] = [{
        type: 'tool_use' as const,
        id: progress.tool_use_id,
        name: progress.tool_name,
        input: {},
      }];
      const progressEvents = extractToolStarts(
        progressBlocks,
        progress.parent_tool_use_id,
        this.toolIndex,
        this.emittedToolStarts,
        this.currentTurnId || undefined,
        this.activeParentTools,
        this.callbacks.sessionDir,
      );

      // Track active Task/Agent tools discovered via progress events
      for (const evt of progressEvents) {
        if (evt.type === 'tool_start' && isParentTaskTool(evt.toolName)) {
          this.activeParentTools.add(evt.toolUseId);
        }
      }

      events.push(...progressEvents);
    }
  }

  private adaptResult(message: SDKMessage, events: AgentEvent[]): void {
    // Narrowed deliberately: the previous `as any` defeated SDKResultMessage, so
    // every non-success subtype collapsed into one error string and a turn cap was
    // indistinguishable from a crash.
    const msg = message as SDKResultMessage;

    this.callbacks.onDebug?.(
      `[ClaudeAdapter] result message: subtype=${msg.subtype}, stop_reason=${msg.stop_reason ?? 'none'}, errors=${'errors' in msg ? JSON.stringify(msg.errors) : 'none'}`,
    );

    // I2.8 — `queued_turn_count` and `user_message_uuid` are the queue depth and
    // the join key this host cannot use, and one of them is worth a TRIPWIRE for
    // exactly that reason.
    //
    // The vendor's gloss for the count: "User-initiated sends still waiting in
    // the command queue when this result was produced. Greater than 0 means at
    // least one more user turn (and result) follows without further input,
    // barring cancellation; 0 means none is." And for the uuid: "Client uuid of
    // the user message that triggered this turn (submitMessage options.uuid),
    // echoed back so a consumer can link this error result to the send it
    // answers."
    //
    // Neither answers a question this host's turn model can ask. `turn-slot.ts`
    // is "ONE `query()` per agent", one open slot, and the passes are strictly
    // sequential — so there is never a second send of ours in flight for the
    // uuid to disambiguate, and `ClaudeAgent.stampTurnMessageUuid` mints the
    // uuid for the INTERRUPT receipt (P6.263) rather than for a join. Wiring the
    // join key would be a correlation between one thing and itself.
    //
    // The count is different, and the difference is the whole point of reading
    // it: because this host sends one at a time, a NON-ZERO value cannot be ours.
    // It means the child has user-initiated sends we did not make — something
    // else writing to its input channel — and that is worth a line naming it
    // rather than a number nobody reads. Debug rather than a user-visible
    // notice: a user cannot act on it, and a support thread can ask for it.
    const queuedTurns = (msg as { queued_turn_count?: unknown }).queued_turn_count;
    if (typeof queuedTurns === 'number' && queuedTurns > 0) {
      this.callbacks.onDebug?.(
        `[ClaudeAdapter] I2.8 — the child reports queued_turn_count=${queuedTurns} on a result. `
        + 'This host opens one turn slot per agent and sends strictly sequentially, so a non-zero '
        + 'queue is not ours: something else has written user-initiated sends to the child.',
      );
    }

    // Get contextWindow from modelUsage
    const primaryModelKey = claudePrimaryModelUsageKey(msg.modelUsage, this.sdkContextWindow?.model ?? null, this.lastMainLineModel); // F1.1283
    const primaryModelUsage = (primaryModelKey === undefined ? undefined : msg.modelUsage?.[primaryModelKey]) as ModelUsage | undefined;

    // P3.268 — the SDK's resolved window wins while it is about THIS model.
    // `modelUsage`'s figure is the model's RAW window; the SDK's is the window
    // usage is actually measured against, which on a `[1m]` session under a
    // compaction policy is five times smaller. A model the SDK never reported on
    // (a switch, or a child whose `getContextUsage` never answered) falls back
    // to the derived value, which is exactly the behaviour that shipped.
    // F1.1283 — `primaryModelKey` (above) is the MAIN model's entry, not the first key: a background call can come first.
    const sdkWindowApplies = this.sdkContextWindow !== null
      && typeof primaryModelKey === 'string'
      && normalizeContextModelKey(primaryModelKey) === this.sdkContextWindow.model;
    if (sdkWindowApplies) {
      this.cachedContextWindow = this.sdkContextWindow!.rawMaxTokens;
    } else if (primaryModelUsage?.contextWindow) {
      this.cachedContextWindow = primaryModelUsage.contextWindow;
    }

    // Use lastAssistantUsage for per-message context display (not cumulative)
    let inputTokens: number;
    let cacheRead: number;
    let cacheCreation: number;

    if (this.lastAssistantUsage) {
      inputTokens = this.lastAssistantUsage.input_tokens +
                    this.lastAssistantUsage.cache_read_input_tokens +
                    this.lastAssistantUsage.cache_creation_input_tokens;
      cacheRead = this.lastAssistantUsage.cache_read_input_tokens;
      cacheCreation = this.lastAssistantUsage.cache_creation_input_tokens;
    } else {
      cacheRead = msg.usage.cache_read_input_tokens ?? 0;
      cacheCreation = msg.usage.cache_creation_input_tokens ?? 0;
      inputTokens = msg.usage.input_tokens + cacheRead + cacheCreation;
    }

    const usage = {
      inputTokens,
      outputTokens: msg.usage.output_tokens,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheCreation,
      // This turn's own cost, not the child's running total — see
      // `takeReportedCostDelta`. `usage.costUsd` is added by every consumer.
      costUsd: this.takeReportedCostDelta(msg.total_cost_usd),
      contextWindow: sdkWindowApplies ? this.sdkContextWindow!.rawMaxTokens : primaryModelUsage?.contextWindow,
      // The whole map, not the first entry's contextWindow. `modelUsage` is the
      // only field that counts subagent requests broken down by model
      // (`agent-sdk/cost-tracking.md:64`), so flattening it loses exactly the
      // attribution a multi-model session needs.
      //
      // Differenced, not forwarded: this map is a running total per model the
      // same way `total_cost_usd` is one for the session, and both of its
      // readers add. See `takeReportedModelUsageDelta`.
      ...(Object.keys(msg.modelUsage ?? {}).length > 0
        ? { modelUsage: this.takeReportedModelUsageDelta(msg.modelUsage) }
        : {}),
      // P2.36 — THIS USED TO BE AN UNCONDITIONAL `'reported'`, AND THAT WAS THE
      // WHOLE OF THE GATEWAY GAP.
      //
      // The sentence it carried — "the SDK carries `total_cost_usd` on every
      // result subtype, so this backend has a real figure whenever it has a
      // result at all" — confuses a PRESENT field with a PRICED one. The field
      // is always there; on an upstream the CLI cannot price (the Nessy Gateway
      // card, a subscription, any `claude-runtime` BYO endpoint) its value is 0
      // on every result, so `takeReportedCostDelta` differences 0 from 0 forever
      // and `sessionCostUsd` never moves. Claiming `'reported'` over that made a
      // cap with no input read as a satisfied budget check — and it defeated the
      // shared classifier in `BaseAgent.classifyEventCost`, whose whole job is
      // to tell "0 because the turn was free" from "0 because nothing priced
      // it". Those are different facts and this field is where they part.
      //
      // The rule is Pi's, deliberately word for word (`backend/pi/event-adapter.ts`):
      // a figure is real when it is one, and a zero is not, because we cannot
      // tell a zero from an unpriced upstream apart from a genuinely free turn —
      // so we decline to call it free. Read off the CUMULATIVE total rather than
      // this turn's delta, for a reason the delta cannot express: once the CLI
      // has priced ANYTHING in this child, cost reporting demonstrably works
      // here, and a later turn whose own delta rounds to 0 is a free turn under
      // a working meter rather than a broken meter. Order-independent too — it
      // reads `msg.total_cost_usd`, not the baseline `takeReportedCostDelta`
      // just advanced.
      //
      // A crash/startup-error result carrying a zeroed total (`sdk.d.ts:4359`)
      // therefore reports `unsupported` for that turn, which `mergeCostReporting`
      // folds to `partial` — "a total that was ever incomplete stays
      // incomplete", which is exactly what such a session's total is.
      costReporting: claudeCostReporting(msg.total_cost_usd),
    };

    // stop_reason is resolved BEFORE the subtype, because refusal has no subtype
    // of its own: a `success` result can carry stop_reason === 'refusal', and an
    // early return on `success` would report that as a clean completion.
    //
    // L2 — `subtype` is resolved LAST, for the same reason and one more. Under a
    // live session the SDK's own turn-scoped cancel (`Query.interrupt()`) settles
    // the turn with an ORDINARY result, and an errored turn does the same: both
    // arrive as `subtype: 'success'` with `is_error: true`, because
    // `SDKResultError` is a different union member reserved for the four
    // agent-loop failure classes. So `subtype` alone can never say "this turn
    // failed", and a `complete` with no `terminalReason` is precisely what
    // `BaseAgent.chat`'s pass loop HOLDS BACK and CONTINUES from
    // (`base-agent.ts:3789`) — i.e. an interrupted turn would be RESUMED after
    // the user pressed Stop. The stamp below is what stops that.
    //
    // `terminal_reason` is read first because it is the SDK's own name for the ending, on EVERY subtype since F1.731
    // (the 2.1.267 builder emits `error_during_execution` only when it is `aborted_*`); `is_error` is the fallback
    // for a result that carries no `terminal_reason` at all (the field is optional).
    const abortedTerminalReason =
      msg.terminal_reason === 'aborted_streaming' || msg.terminal_reason === 'aborted_tools';
    // P2.525 — THE DEFERRAL THE HOST COULD NOT RECEIVE.
    //
    // `hooks.md#defer-a-tool-call-for-later` describes the whole round trip in
    // the SDK's own vocabulary: "The hook returns `permissionDecision:
    // "defer"`. The tool doesn't execute. The process exits with `stop_reason:
    // "tool_deferred"` and the pending tool call preserved in the transcript",
    // and "If the deferred tool is no longer available when you resume, the
    // process exits with `stop_reason: "tool_deferred_unavailable"` and
    // `is_error: true` before the hook fires. … The `deferred_tool_use` payload
    // is still included so you can identify which tool went missing."
    //
    // Both endings ride the `terminal_reason` field the two lines above already
    // read, and BOTH were falling off the end of the chain below: `tool_deferred`
    // (a success result with `is_error: false`) produced NO reason at all — the
    // shape `BaseAgent.chat`'s pass loop holds back and CONTINUES from, so the
    // turn would resume with the tool still unrun — and `tool_deferred_unavailable`
    // (`is_error: true`) was reported as `provider_error`, which additionally
    // pushed an `error` event blaming the provider for a hook's decision.
    //
    // Read BEFORE the abort/`is_error` chain and AFTER `stop_reason: 'refusal'`,
    // matching the precedence already written there: a refusal is a verdict on
    // the CONTENT and rides a success result, while these two name the ending.
    //
    // `terminalIsError` is not special-cased: the spread below already mirrors
    // the SDK's own `is_error`, which the page says is `true` on the unavailable
    // exit and unset on the ordinary one — the same two values `pi-agent.ts`
    // writes by hand for its own defer path.
    //
    // WHAT THIS ROW DOES NOT DO, stated because the difference is a posture and
    // not an oversight: it makes a deferral RECEIVABLE, not reachable. The
    // claude gate still REFUSES to defer (`buildClaudePreToolUseContinue`
    // degrades the decision one rank to `ask`), so nothing can produce these two
    // values on this backend today. Emitting them additionally needs the resume
    // port — `onToolCallDeferred` / `getDeferredToolCall`, which exist and are
    // gated to `provider === 'pi'` in `SessionManager` — and the degrade removed
    // in the same commit. This half is the prerequisite the refusal named.
    // P2.525 (second pass, W2-l) — `stop_reason` IS READ HERE AND `terminal_reason`
    // ALONE IS NOT ENOUGH, measured in the shipped bundle rather than assumed.
    //
    // `terminal_reason` is optional on both result members (`sdk.d.ts`:
    // `terminal_reason?: TerminalReason`), and the 0.3.233 native binary has TWO
    // emit sites for an ordinary deferral. The first, inside the turn loop,
    // fills it from its own computed reason. The SECOND — the one that fires
    // when a RESUMED session's hook defers the same call again, which is the
    // documented loop (`hooks.md#defer-a-tool-call-for-later`: "If the answer is
    // not ready when you resume, the hook can return `defer` again and the
    // process exits the same way") — builds its result with
    // `stop_reason: "tool_deferred"` and NO `terminal_reason` key at all, and
    // the result assembler is a plain spread that synthesises nothing.
    //
    // So reading `terminal_reason` alone made the FIRST deferral legible and the
    // SECOND one a reason-free `complete` — the exact shape `BaseAgent.chat`'s
    // pass loop holds back and CONTINUES from, i.e. the stranded/looping turn
    // this row exists to prevent, reachable only on the second defer of one
    // call. `stop_reason` is `string | null` and always present, so it is the
    // reliable side; both are read, `terminal_reason` first because it is the
    // SDK's own name for the ending.
    //
    // The unavailable exit carries BOTH fields in the binary, so this widening
    // changes nothing for it — which is also why the bug was invisible: the
    // failure ending was legible and the success ending was not.
    const deferredStopReason = msg.terminal_reason ?? msg.stop_reason;
    const deferredTerminalReason: AgentTerminalReason | undefined =
      deferredStopReason === 'tool_deferred' || deferredStopReason === 'tool_deferred_unavailable'
        ? deferredStopReason
        : undefined;
    // The payload is declared on the SUCCESS member only, so it is read through
    // the `in` guard the sibling `api_error_status` read already uses rather
    // than through a cast that would compile past a future rename.
    const deferredToolUse = 'deferred_tool_use' in msg && msg.deferred_tool_use
      ? msg.deferred_tool_use
      : undefined;
    // P6.55 — THE NATIVE THRASHING BREAKER'S VERDICT, which had no switch verdict.
    //
    // Measured by the compaction lane in the vendored 2.1.223 binary and written
    // out in full at `claude-agent.ts`'s P6.55 block: `n1_`/`CEo` trip after 3
    // consecutive rapid refills — the SAME threshold as the shared
    // `AUTO_COMPACTION_THRASHING_REFILL_LIMIT` the Pi and codex host guards use —
    // and end the turn with `{reason:"rapid_refill_breaker"}`. So the SDK
    // already has the mechanism and no third host guard is wanted; what was
    // missing is that its verdict never reached OUR vocabulary. The identical
    // failure ended as `auto_compaction_thrashing` on Pi and codex and as
    // `provider_error` here — a native mechanism adopted without a switch
    // verdict, which is the silent divergence native-first exists to prevent.
    //
    // Mapped onto the shared reason AND paired with the same `info` warning
    // codex emits, because "the same outcome" is both halves: without the notice
    // this arm would REMOVE the only thing the user sees today (the
    // `provider_error` bubble) and replace it with a reason that renders nothing
    // — `auto_compaction_thrashing` is deliberately absent from
    // `TERMINAL_REASON_NOTICE_VALUES`, on the grounds that these endings "reach
    // the transcript as their own error or info notices". This is that notice.
    //
    // Residue, named rather than hidden: the SDK ALSO emits its own thrashing
    // sentence as an `invalid_request` assistant message, which reaches
    // `mapSDKError` as a bare code with the text dropped. So a tripped breaker
    // can surface twice on this runtime — once as a generic invalid-request
    // card, once as the actionable notice below. Carrying the vendor's sentence
    // through instead would mean parsing an error string, and a stop the user
    // cannot act on is the worse failure.
    const thrashingBreakerTripped = msg.terminal_reason === 'rapid_refill_breaker';
    if (thrashingBreakerTripped) events.push(claudeAutoCompactionThrashingNotice());
    const terminalReason: AgentTerminalReason | undefined = msg.stop_reason === 'refusal'
      ? 'provider_refusal'
      : deferredTerminalReason
      ?? (thrashingBreakerTripped ? CLAUDE_AUTO_COMPACTION_THRASHING_REASON : undefined)
      ?? (abortedTerminalReason // F1.731 — on EVERY subtype: a Stop that lands before the model's text (after a steer,
        ? 'user_stop' // or mid-tool) settles as `error_during_execution` + a `[ede_diagnostic]` line, which is not an error
        : msg.subtype === 'success'
          ? msg.is_error
            ? 'provider_error'
            : undefined
          : CLAUDE_RESULT_SUBTYPE_REASON[msg.subtype] ?? 'provider_error');

    // A cap or a refusal is a stop, not a failure: no error event, so the turn's
    // assistant text survives and the UI can say why it ended. Only a genuine
    // execution error still produces one.
    if (terminalReason === 'provider_error') {
      // The ERROR member carries `errors`; the SUCCESS-with-`is_error` member
      // does not — it carries the failure as the result text plus an optional
      // `api_error_status`. Reading both is what keeps the new arm from
      // reporting every network failure as the bare string "Query failed".
      const apiStatus = 'api_error_status' in msg && typeof msg.api_error_status === 'number'
        ? msg.api_error_status
        : undefined;
      const resultText = 'result' in msg && typeof msg.result === 'string' ? msg.result.trim() : '';
      const errorMsg = 'errors' in msg && Array.isArray(msg.errors) && msg.errors.some(isClaudeResultErrorShown) // F1.745
        ? msg.errors.filter(isClaudeResultErrorShown).join(', ')
        : resultText || (apiStatus ? `Query failed (API status ${apiStatus})` : 'Query failed');

      const windowsError = buildWindowsSkillsDirError(errorMsg);
      if (windowsError) {
        events.push(windowsError);
      } else {
        events.push({ type: 'error', message: errorMsg });
      }
    }

    // R18: structured-output result fields ride the complete event. Only a
    // schema-bearing turn produces either arm — a success result carrying
    // `structured_output`, or the dedicated retry-exhaustion subtype with its
    // `errors` list — so a schema-less turn stays byte-identical below.
    const structuredOutput = (msg as { structured_output?: unknown }).structured_output;
    const structuredFields = msg.subtype === 'error_max_structured_output_retries'
      ? {
          structuredOutputSubtype: 'error_max_structured_output_retries' as const,
          structuredOutputErrors: 'errors' in msg && Array.isArray(msg.errors) ? msg.errors as string[] : [],
        }
      : structuredOutput !== undefined
        ? { structuredOutputSubtype: 'success' as const, structuredOutput }
        : {};

    // The spread keeps the success payload byte-identical to today's: the field is
    // absent, not `undefined`. `terminalIsError` mirrors the SDK's own required
    // `is_error` — it is the field `SessionManager` already forwards
    // (`turn-terminal-reason.test.ts`), so nothing new rides the wire.
    events.push({
      type: 'complete',
      usage,
      ...(terminalReason ? { terminalReason } : {}),
      ...(msg.is_error ? { terminalIsError: true } : {}),
      // Carried only alongside one of the two deferral reasons, because that is
      // the only ending the page attaches it to — a stray payload on an
      // ordinary completion would tell `SessionManager` to persist a held call
      // that nothing is holding.
      ...(deferredTerminalReason && deferredToolUse ? { deferredToolUse } : {}),
      ...structuredFields,
    });
  }

  private adaptSystem(message: SDKMessage, events: AgentEvent[]): void {
    const msg = message as any;

    if (msg.subtype === 'init') {
      // I2.10 — the five smaller 0.3.251 arrivals, and which of them is read.
      // Byte-identical to 0.3.247 in `sdk.d.ts`, so this is a HOST verdict and
      // not a version wait. Each is named with where it would be read, so the
      // next reader does not have to re-derive that it is deliberate:
      //
      //  * `account_on_hold` on `SDKAssistantMessageError` is WIRED, in
      //    `agent/claude-sdk-error-mapper.ts` — the only one of the five with a
      //    user-visible consequence today, because without an arm it fell to a
      //    default that blamed the network for a suspended account.
      //  * `effort` on THIS message ("The effort level the session will send on
      //    its next request — after env overrides, session state, org caps and
      //    model-support downgrades") is DELIBERATELY UNREAD, and the reason is
      //    that the host already computes the same answer one layer up and can
      //    SAY it: `claude-agent.ts`'s thinking-to-effort clamp logs the
      //    requested level, the model's reported `supportedEffortLevels` and the
      //    clamped result. Reading the child's echo would give a second producer
      //    for one fact, and the composer displays the host's. It becomes worth
      //    reading the day the two can disagree for a reason the host cannot
      //    see — an ORG CAP is the one the gloss names, and this fork has no way
      //    to learn about one otherwise.
      //  * `hooks_applied` on the initialize RESPONSE says whether a REPEATED
      //    initialize registered its hooks. This host initializes once per
      //    child and respawns rather than re-initializing, so the field can only
      //    ever report the first answer.
      //  * `suppressOriginalPrompt` (prompt-expansion hook output) and a sixth
      //    `source` value `'poll_event'` (`UserPromptSubmitHookInput`) are hook
      //    surfaces: the first reaches only hooks the host answers (never a native
      //    exit-2 hook), so the informational arm cuts the banner uniformly (F1.1247); the
      //    second an INPUT whose other five values are already carried. Recorded, not wired.
      //
      // Counted from the unions in `sdk.d.ts`, not from prose: eleven
      // `SDKAssistantMessageError` values, six `UserPromptSubmitHookInput`
      // sources.

      // Capture tools list from SDK init message
      if ('tools' in msg && Array.isArray(msg.tools)) {
        this._sdkTools = msg.tools;
        this.callbacks.onDebug?.(`SDK init: captured ${this._sdkTools.length} tools`);
      }
      // The init snapshot is the BASELINE the `commands_changed` diff subtracts
      // from. Without it the first replacement payload reads as "every command
      // is new" and announces the entire built-in list.
      if (Array.isArray(msg.slash_commands)) {
        this._sdkSlashCommands = msg.slash_commands as string[];
      }
      // P6.1006 — the same snapshot carries `skills` and `agents`. Guarded the
      // same way `slash_commands` is: a payload that omits one leaves the last
      // roster standing, so a CLI that predates a field cannot empty it.
      if (Array.isArray(msg.skills)) {
        this._sdkSkills = msg.skills as string[];
      }
      if (Array.isArray(msg.agents)) {
        this._sdkAgents = msg.agents as string[];
      }
    } else if (msg.subtype === 'compact_boundary') {
      events.push({
        type: 'info',
        message: 'Compacted Conversation', ...compactBoundaryTrigger(msg), // F1.241 — `compact_metadata.trigger`, when it says
      });
    } else if (msg.subtype === 'status') {
      this.adaptStatusMessage(msg as SDKStatusMessage, events);
    } else if (msg.subtype === 'task_notification') {
      const notification = msg as TaskNotificationMessage;
      if (!notification.task_id) {
        this.callbacks.onDebug?.('[EventAdapter] task_notification missing task_id, skipping');
        return;
      }
      const status: TaskStatus = VALID_TASK_STATUSES.includes(notification.status as TaskStatus)
        ? (notification.status as TaskStatus)
        : 'completed';
      this.mainLineTasks.delete(notification.task_id); events.push({ // UA12.192 — an ended task is never retired again
        type: 'task_completed',
        taskId: notification.task_id,
        status,
        outputFile: notification.output_file,
        summary: notification.summary,
        turnId: this.currentTurnId || undefined,
      });
    } else if (msg.subtype === 'api_retry') {
      const retry = msg as SDKAPIRetryMessage;
      // P6.917 — armed here and disarmed by the next assistant delta.
      this.retryChipStanding = true;
      events.push(retryStatusEvent(buildRetryFacts({
        attempt: retry.attempt,
        maxRetries: retry.max_retries,
        retryDelayMs: retry.retry_delay_ms,
        errorCode: retry.error,
        errorStatus: retry.error_status,
      })));
    } else if (msg.subtype === 'control_request_progress') {
      const progress = msg as SDKControlRequestProgressMessage;
      // Only the retry arm is news. `started` fires for every control request we
      // ourselves issue (interrupt, setModel, canUseTool round trips) and would
      // be a status line per permission prompt.
      if (progress.status === 'api_retry') {
        events.push(retryStatusEvent(buildRetryFacts({
          attempt: progress.attempt,
          maxRetries: progress.max_retries,
          retryDelayMs: progress.retry_delay_ms,
          errorStatus: progress.error_status,
        })));
      } else {
        this.callbacks.onDebug?.(
          `[EventAdapter] control_request_progress ${progress.status} for ${progress.request_id}`,
        );
      }
    } else if (msg.subtype === 'model_refusal_fallback') {
      // A refusal silently swapped the model. `content` is the SDK's own banner
      // prose; the model pair is appended because the banner does not always
      // name both, and which model answered is the user's question afterwards.
      const refusal = msg as SDKModelRefusalFallbackMessage;
      const detail = refusal.original_model && refusal.fallback_model
        ? ` (${refusal.original_model} → ${refusal.fallback_model})`
        : '';
      events.push({
        type: 'info',
        message: `${refusal.content || 'The model refused this request; a fallback model was used.'}${detail}`,
        level: 'warning',
      });
    } else if (msg.subtype === 'model_refusal_no_fallback') {
      const refusal = msg as SDKModelRefusalNoFallbackMessage;
      events.push({
        type: 'info',
        message: refusal.content || 'The model refused this request and no fallback was available.',
        level: 'warning',
      });
    } else if (msg.subtype === 'local_command_output') {
      // The rendered output of a locally-executed slash command (`/cost`,
      // `/usage`, …). Plain info: it is the command's answer, not a warning.
      const output = msg as SDKLocalCommandOutputMessage;
      if (typeof output.content === 'string' && output.content.length > 0) {
        events.push({ type: 'info', message: output.content });
      }
    } else if (msg.subtype === 'hook_started') {
      // A hook can block a tool for seconds with nothing on screen. Status is
      // the right channel: transient, no transcript row per tool call.
      const hook = msg as SDKHookStartedMessage;
      events.push({
        type: 'status',
        message: `Running ${hook.hook_event} hook${hook.hook_name ? ` ${hook.hook_name}` : ''}...`,
      });
    } else if (msg.subtype === 'hook_progress') {
      // DELIBERATE DROP (debug only). This is an unbounded per-chunk stdout/stderr
      // stream with no dedupe key, and the SDK sends `hook_response` with the
      // settled output right after. Surfacing both means every hook prints twice,
      // once in fragments.
      const hook = msg as { hook_name?: string; hook_event?: string };
      this.callbacks.onDebug?.(
        `[EventAdapter] hook_progress ${hook.hook_event ?? '?'}/${hook.hook_name ?? '?'} (streamed, not surfaced)`,
      );
    } else if (msg.subtype === 'hook_response') {
      const hook = msg as SDKHookResponseMessage;
      // P6.449 — one reading of a hook run for all three runtimes, in
      // `agent/hook-run-report.ts`. The reason a failing hook is worth a
      // PERSISTED warning is unchanged: it fails invisibly, and the user
      // experiences it as the agent refusing to run a tool for no reason.
      // `warning` is the only info level SessionManager writes into the
      // transcript, so it survives a reload.
      //
      // THREE THINGS THIS CALL FIXES, each measured against the SDK's own type
      // (`sdk.d.ts:4168`) rather than against the page:
      //  1. `stdout` is a REQUIRED field there and was never read here — the old
      //     line took `stderr || output`, so a hook that failed while writing
      //     only to stdout produced `Hook X failed (exit 2)` and no text at all.
      //  2. `outcome: 'cancelled'` went to the debug channel, so a PreToolUse
      //     hook cancelled mid-turn was the silent reason a tool did not run.
      //  3. The detail was interpolated into a PERSISTED line with no bound. A
      //     hook is an arbitrary user program; one runaway hook could write
      //     megabytes into a session's history.
      //
      // `report.detail` on a SUCCESSFUL run is deliberately not surfaced here:
      // `hooks.md#exit-code-0` says stderr from a hook that exits 0 "goes to the
      // debug log only, never the transcript". It travels so a hook-run view can
      // render it; this arm keeps the page's posture and logs it.
      // P6.643 - the observation is built once and used twice: the transcript
      // line below, and the session's hook-run store, which is the only place a
      // SUCCESSFUL run is legible at all (this arm keeps the page's posture of
      // saying nothing about one in the transcript).
      const observation: HookRunObservation = {
        runtime: 'claude',
        event: hook.hook_event,
        ...(hook.hook_name ? { name: hook.hook_name } : {}),
        outcome: claudeHookRunOutcome(hook), // F1.516 (2) — a refusal reads 'blocked'
        ...(typeof hook.exit_code === 'number' ? { exitCode: hook.exit_code } : {}),
        ...(hook.stdout ? { stdout: hook.stdout } : {}),
        ...(hook.stderr ? { stderr: hook.stderr } : {}),
        ...(hook.output ? { output: hook.output } : {}),
      };
      this.callbacks.onHookRun?.(observation);
      const report = reportHookRun(observation);
      if (report.message) {
        events.push({ type: 'info', message: report.message, level: report.level });
      } else {
        this.callbacks.onDebug?.(
          `[EventAdapter] hook_response ${hook.hook_event}/${hook.hook_name} → ${hook.outcome}`
          + (report.detail ? `: ${report.detail}` : ''),
        );
      }
    } else if (msg.subtype === 'plugin_install') {
      const install = msg as SDKPluginInstallMessage;
      const name = install.name || 'plugin';
      if (install.status === 'failed') {
        events.push({
          type: 'info',
          message: `Plugin ${name} failed to install${install.error ? `: ${install.error}` : ''}`,
          level: 'warning',
        });
      } else if (install.status === 'installed' || install.status === 'completed') {
        events.push({ type: 'info', message: `Plugin ${name} installed.` });
      } else {
        this.callbacks.onDebug?.(`[EventAdapter] plugin_install ${install.status} for ${name}`);
      }
    } else if (msg.subtype === 'task_started') {
      const task = msg as SDKTaskStartedMessage;
      // `skip_transcript` is the SDK's own instruction — "Ambient/housekeeping
      // task. Consumers should hide this from the inline transcript" — so an
      // ambient task stays out of the transcript rather than being renamed.
      //
      // I2.9 — `ambient` is a SECOND field, and it is a strict SUPERSET of
      // `skip_transcript` rather than a rename of it. Its own gloss at the
      // vendored 0.3.251: "True for housekeeping tasks the CLI does not surface
      // as user work (every skip_transcript task, plus auto-started live-update
      // watchers); hosts should exclude them from activity indicators."
      //
      // So the set this branch could not see is `ambient && !skip_transcript` —
      // the auto-started watchers — and until now each of those announced
      // "Started task — …" in the transcript, which is surfacing as user work
      // the very thing the CLI does not surface as user work.
      //
      // The PANEL is deliberately not gated on it. The two sentences differ on
      // that consumer and only on that consumer: `skip_transcript` says such a
      // task "may still appear in a tasks panel", which is what the
      // orchestration card below is, while `ambient` speaks about activity
      // INDICATORS. Suppressing the card as well would take the permissive
      // sentence away on the strength of the directive one, so the narrow
      // reading is the one built: the transcript line goes, the card stays.
      if (task.skip_transcript || task.ambient) {
        this.callbacks.onDebug?.(
          `[EventAdapter] task_started ${task.task_id} hidden `
          + `(${task.skip_transcript ? 'skip_transcript' : 'ambient'})`,
        );
      } else {
        const label = task.subagent_type ? `${task.subagent_type}: ` : '';
        events.push({
          type: 'info',
          message: `Started task — ${label}${task.description || task.task_id}`,
        });
      }
      // P6.642 — open the run here rather than on the first progress: a subagent
      // that has started but not yet reported should show as RUNNING, which is
      // exactly the state the panel could not display on claude before.
      if (task.tool_use_id) {
        const agent = this.ensureOrchestrationAgent(task.tool_use_id, task.task_id, {
          label: task.description || task.task_id,
          agentType: task.subagent_type,
        });
        agent.status = 'running';
        agent.startedAt ??= new Date().toISOString();
        agent.lastActivity = 'started';
        // I2.9 — the two nesting facts, carried only when the SDK states them.
        //
        // `is_backgrounded` decides whether the spawning tool call is BLOCKING
        // on this child, which is the difference between a row the turn is
        // waiting on and one it is not; the panel could not tell them apart.
        // `spawn_depth` is set on `local_agent` tasks only, by the SDK's own
        // gloss, so it is absent on plenty of rows here and a default would
        // invent a depth for a `local_bash` task that has none.
        //
        // Neither is defaulted for the reason the field docs give: absent means
        // the runtime did not say, and `false`/`0` would assert on Pi and codex
        // a distinction they never reported.
        if (typeof task.is_backgrounded === 'boolean') agent.isBackgrounded = task.is_backgrounded;
        if (typeof task.spawn_depth === 'number') agent.spawnDepth = task.spawn_depth;
        events.push(this.orchestrationProgressEvent(task.tool_use_id));
        // UA12.18 follow-up — the SDK documents the level arriving BEFORE this bookend ("in practice the level
        // precedes them", `SDKBackgroundTasksChangedMessage`), so the feed it built could not name this call yet.
        // Re-state the set now that it can; a task the level has not named stays out (the level owns membership).
        // UA12.192 — v0.14.0's `local_bash` arm, BEFORE the re-stated feed so the renderer turns the level's row into
        // a Shell chip instead of meeting a row that already carries this call id.
        this.noteMainLineTaskStarted(task, events);
        if (this.knownBackgroundTasks.has(task.task_id)) events.push(this.backgroundTasksReplacedEvent());
      }
    } else if (msg.subtype === 'task_updated') {
      const update = msg as SDKTaskUpdatedMessage;
      const patch = update.patch ?? {};
      if (patch.is_backgrounded === true) this.announceMainLineShell(update.task_id, events); // UA12.192 — a later move
      // NOT mapped to our `task_completed`: that event is the Pi background-task
      // bookkeeping seam in SessionManager — it writes `backgroundTaskOutputs`,
      // clears `piBackgroundTaskKinds`, and can call `deliverMonitorEvent`,
      // which STARTS A TURN. A status patch is not a settled result, and the SDK
      // sends `task_notification` (already handled above) when one really lands.
      // P6.642 — the run's terminal state. A card that opens on `task_started`
      // and never closes is worse than no card, and this is the only message
      // that carries the outcome; `task_updated` has no `tool_use_id`, which is
      // what `orchestrationRunByTask` exists for.
      const updatedRunId = this.orchestrationRunByTask.get(update.task_id);
      const updatedAgent = updatedRunId
        ? this.orchestrationRuns.get(updatedRunId)?.agents.get(update.task_id)
        : undefined;
      if (updatedAgent && updatedRunId) {
        // I2.9 — the move to the background is a PATCH, and this is the only
        // message that carries it: `is_backgrounded`'s own gloss says "A later
        // move to the background arrives as `task_updated` patch.is_backgrounded".
        // Without this the panel would pin whatever `task_started` said and be
        // wrong for the rest of a run that backgrounded itself. Emitted even
        // when the status did not move, because the fact did.
        if (typeof patch.is_backgrounded === 'boolean'
          && updatedAgent.isBackgrounded !== patch.is_backgrounded) {
          updatedAgent.isBackgrounded = patch.is_backgrounded;
          events.push(this.orchestrationProgressEvent(updatedRunId));
        }
        // `pending`/`paused` are deliberately unmapped: neither is a terminal
        // state and neither has a row in the status vocabulary, so the agent
        // keeps the state it had rather than being invented into one.
        const mapped = patch.status === 'completed' ? 'done'
          : patch.status === 'failed' ? 'error'
          : patch.status === 'killed' ? 'aborted'
          : patch.status === 'running' ? 'running'
          : undefined;
        if (mapped) {
          updatedAgent.status = mapped;
          if (mapped !== 'running') updatedAgent.endedAt = new Date().toISOString();
          updatedAgent.lastActivity = mapped;
          events.push(this.orchestrationProgressEvent(updatedRunId));
        }
      }
      if (patch.status === 'failed') {
        events.push({
          type: 'info',
          message: `Task ${update.task_id} failed${patch.error ? `: ${patch.error}` : ''}`,
          level: 'warning',
        });
      } else {
        this.callbacks.onDebug?.(
          `[EventAdapter] task_updated ${update.task_id}: ${JSON.stringify(patch)}`,
        );
      }
    } else if (msg.subtype === 'task_progress') {
      const progress = msg as SDKTaskProgressMessage;
      // UB9.8 — craft-agents-oss v0.15.1 `event-adapter.ts` (Apache-2.0): what one of the session's OWN tasks is doing
      // (a subagent's nested tasks have no chip), as `task_activity`. The host forwards it only for a task it
      // registered (`SessionManager.processEvent`), so a foreground main-line subagent's progress stops there.
      // Pushed AFTER the orchestration `task_progress` below, which keeps that event's existing position.
      const activity = classifyClaudeTaskProgress(message);
      const activityEvent: AgentEvent | null = activity && this.wasLaunchedByMainAgent(activity.taskId, activity.toolUseId)
        ? { type: 'task_activity', ...activity, ...(this.currentTurnId ? { turnId: this.currentTurnId } : {}) }
        : null;
      // Only keyable when the SDK names the tool_use it belongs to — our
      // `task_progress` is addressed by `toolUseId`, and a task id has no row in
      // the transcript to attach to.
      if (progress.tool_use_id && typeof progress.usage?.duration_ms === 'number') {
        // P6.642 — the child-state producer. `SDKTaskProgressMessage` carries
        // everything `OrchestrationProgressAgent` needs except one thing, and
        // that one thing is P6.641.
        const agent = this.ensureOrchestrationAgent(progress.tool_use_id, progress.task_id, {
          label: progress.description || progress.task_id,
          agentType: progress.subagent_type,
        });
        agent.status = 'running';
        agent.startedAt ??= new Date().toISOString();
        // P6.641 — THE SPLIT IS HONESTLY ABSENT, never `0`.
        //
        // `SDKTaskProgressMessage.usage` is `{ total_tokens, tool_uses,
        // duration_ms }` — agent-sdk 0.3.233, `sdk.d.ts:4768` — and the split
        // exists nowhere on the message. `tokensIn`/`tokensOut` are therefore
        // left unset rather than filled with zeros: a card reading "0 in / 0
        // out" beside a real total states a fact the runtime never reported,
        // which is worse than a card that says only what it knows. The SDK's own
        // type is the ceiling here; inventing a split would be the invented
        // answer this plan refuses.
        agent.tokensTotal = typeof progress.usage.total_tokens === 'number'
          ? progress.usage.total_tokens
          : agent.tokensTotal;
        if (typeof progress.usage.tool_uses === 'number') agent.toolCalls = progress.usage.tool_uses;
        // `summary` is the model-written phrase `Options.agentProgressSummaries`
        // asks for (OFF since F1.919, see `claude-agent.ts`) or an MCP task's own
        // status; `last_tool_name` needs no option and is the usual line. Both land
        // on the one field both cards render through `orchestrationActivityLabel`.
        agent.lastActivity = progress.summary || progress.last_tool_name || agent.lastActivity;
        events.push({
          type: 'task_progress',
          toolUseId: progress.tool_use_id,
          elapsedSeconds: Math.round(progress.usage.duration_ms / 1000),
          orchestrationProgress: this.orchestrationSnapshot(progress.tool_use_id),
          turnId: this.currentTurnId || undefined,
        });
      } else {
        this.callbacks.onDebug?.(
          `[EventAdapter] task_progress ${progress.task_id} without tool_use_id, not surfaced`,
        );
      }
      if (activityEvent) events.push(activityEvent);
    } else if (msg.subtype === 'background_tasks_changed') {
      this.adaptBackgroundTasksChanged(msg as SDKBackgroundTasksChangedMessage, events);
    } else if (msg.subtype === 'thinking_tokens') {
      // DELIBERATE DROP (debug only). `AgentEventUsage`/`AgentEventUsageUpdate`
      // have no thinking-token field, and the two numeric fields they DO have
      // are the context-window display's input count — folding an ESTIMATED
      // thinking count into `inputTokens` would inflate the badge the F6 work
      // spent a release getting right. Surfacing it needs a new usage field,
      // which is a shared-wire change in `packages/core`, not an adapter change.
      this.callbacks.onDebug?.(
        `[EventAdapter] thinking_tokens ~${msg.estimated_tokens} (+${msg.estimated_tokens_delta}), no usage field to carry it`,
      );
    } else if (msg.subtype === 'session_state_changed') {
      // DELIBERATE DROP (debug only). Our turn lifecycle is driven by `result`
      // and by `permission_request`; a second, independent idle/running signal
      // arriving from the SDK would race the one the session layer already
      // trusts. It becomes load-bearing only under R7 step 2, where the session
      // outlives the turn and "idle" stops being implied by the process exiting.
      this.callbacks.onDebug?.(`[EventAdapter] session_state_changed → ${msg.state}`);
    } else if (msg.subtype === 'worker_shutting_down') {
      const shutdown = msg as SDKWorkerShuttingDownMessage;
      events.push({
        type: 'info',
        message: `Claude worker is shutting down (${shutdown.reason || 'no reason given'}).`,
        level: 'warning',
      });
    } else if (msg.subtype === 'commands_changed') {
      this.adaptCommandsChanged(msg as SDKCommandsChangedMessage, events);
    } else if (msg.subtype === 'notification') {
      const notification = msg as SDKNotificationMessage;
      if (typeof notification.text === 'string' && notification.text.length > 0) {
        events.push({
          type: 'info',
          message: notification.text,
          // Only the two loud priorities earn a persisted warning; `low`/`medium`
          // ride as transient info so a routine notice does not accumulate in the
          // saved transcript.
          level: notification.priority === 'high' || notification.priority === 'immediate'
            ? 'warning'
            : 'info',
        });
      }
    } else if (msg.subtype === 'files_persisted') {
      const persisted = msg as SDKFilesPersistedEvent;
      const failed = Array.isArray(persisted.failed) ? persisted.failed : [];
      if (failed.length > 0) {
        events.push({
          type: 'info',
          message: `Failed to persist ${failed.length} file(s): ${failed
            .map(entry => `${entry.filename}${entry.error ? ` (${entry.error})` : ''}`)
            .join(', ')}`,
          level: 'warning',
        });
      } else {
        this.callbacks.onDebug?.(
          `[EventAdapter] files_persisted: ${Array.isArray(persisted.files) ? persisted.files.length : 0} ok`,
        );
      }
    } else if (msg.subtype === 'memory_recall') {
      const recall = msg as SDKMemoryRecallMessage;
      const count = Array.isArray(recall.memories) ? recall.memories.length : 0;
      if (count > 0) {
        events.push({
          type: 'info',
          message: `Recalled ${count} ${count === 1 ? 'memory' : 'memories'} (${recall.mode}).`,
        });
      }
    } else if (msg.subtype === 'elicitation_complete') {
      // DELIBERATE DROP (debug only). This is the CLOSE of an MCP elicitation
      // whose open we never surfaced either — the SDK handles the round trip
      // itself and we have no elicitation UI. Announcing only the completion
      // would describe the end of something the user never saw begin.
      this.callbacks.onDebug?.(
        `[EventAdapter] elicitation_complete ${msg.elicitation_id} (${msg.mcp_server_name})`,
      );
    } else if (msg.subtype === 'permission_denied') {
      const denial = msg as SDKPermissionDeniedMessage;
      const reason = denial.decision_reason || denial.message;
      // P3.97 — the discriminator this line used to drop. Without it a
      // classifier denial and a `permissions.deny` denial read identically, and
      // the two are not the same event to review: one is a model's judgement of
      // this deployment, the other is our own rule firing. Worse, the fallback
      // above HIDES the difference by construction — the binary's own reason
      // formatter returns `undefined` for `rule`, `mode`, `subcommandResults`
      // and `permissionPromptTool`, so those denials always fall through to
      // `message` while a `classifier` denial always carries its own words.
      const denialType = formatClaudeDenialTypeLabel(denial.decision_reason_type);
      // P3.97 (decided W4-g) — the SAME message also mints the audit receipt.
      // Reading it for a transcript label and nothing else is what left the
      // audit record dormant: the hook that used to be the only mint fires only
      // for auto-mode classifier denials, which our gate silences. This is the
      // live channel, so it is the one that has to record.
      this.callbacks.onPermissionDenied?.(denial);
      events.push({
        type: 'info',
        // Persisted (warning): a silently auto-denied tool is the single most
        // confusing thing the runtime does today — the model announces an action,
        // nothing happens, and the transcript shows no cause.
        message: `Permission denied for ${denial.tool_name}${denialType}${reason ? `: ${reason}` : ''}`,
        level: 'warning',
      });
    } else if (msg.subtype === 'mirror_error') {
      // DELIBERATE DROP (debug only). Transcript mirroring is an internal
      // persistence path of the SDK's own; the user cannot act on its failure
      // and it does not affect the answer they are reading.
      this.callbacks.onDebug?.(`[EventAdapter] mirror_error: ${msg.error}`);
    } else if (msg.subtype === 'informational') {
      // f081 (agent-sdk/typescript.md `SDKInformationalMessage`): "Generic text
      // banner emitted by the loop. Carries non-error status lines, hook
      // feedback such as a `UserPromptSubmit` hook's block reason, and command
      // output. Render `content` as plaintext at the given `level`." Non-error
      // by contract, so this maps to `info` — never `error`. The SDK's four
      // levels (info | notice | suggestion | warning) collapse onto our
      // Message.infoLevel vocabulary: only `warning` stays prominent,
      // everything else (including future unknown levels) renders as 'info'.
      const informational = msg as SDKInformationalMessage;
      if (informational.prevent_continuation) {
        // No terminal handling needed — the SDK still emits a `result` — but
        // leave a trace instead of dropping the flag silently.
        this.callbacks.onDebug?.('[EventAdapter] informational message carries prevent_continuation');
      }
      if (typeof informational.content === 'string' && informational.content.length > 0) {
        events.push({
          type: 'info',
          message: withoutBlockedPromptText(informational.content), // F1.1247
          level: informational.level === 'warning' ? 'warning' : 'info',
        });
      }
    } else {
      // Trailing trace for a system subtype the SDK adds AFTER this file was
      // written. As of @anthropic-ai/claude-agent-sdk 0.3.218 every one of the
      // 28 declared `system` subtypes has a branch above — either a surfaced
      // event or a documented deliberate drop — so reaching here means the SDK
      // grew a subtype and the enumeration needs re-running against the new
      // `SDKMessage` union rather than a new `else if` guessed from the name.
      this.callbacks.onDebug?.(`Unhandled system subtype: ${msg.subtype}`);
    }
  }

  /**
   * `system/status` — three things ride one subtype.
   *
   * `status: 'compacting'` keeps its existing status line verbatim (the word
   * "Compacting" is what SessionManager sniffs to stamp `statusType`).
   * `compact_result` is the part that was dropped entirely: a FAILED compaction
   * arrives here and nowhere else, and the previous chain fell through to the
   * unhandled-subtype trace, so a session that could not compact said nothing.
   * A successful one is deliberately silent — `compact_boundary` already emits
   * "Compacted Conversation" and two lines for one event reads as two events.
   */
  private adaptStatusMessage(msg: SDKStatusMessage, events: AgentEvent[]): void {
    if (msg.status === 'compacting') {
      events.push({ type: 'status', message: 'Compacting conversation...' });
    }

    if (msg.compact_result === 'failed') {
      events.push({
        type: 'info',
        message: `Compaction failed${msg.compact_error ? `: ${msg.compact_error}` : ''}`,
        level: 'warning',
      });
    } else if (msg.compact_result === 'success') {
      this.callbacks.onDebug?.('[EventAdapter] compact_result success (announced by compact_boundary)');
    }

    if (msg.status !== 'compacting') {
      this.callbacks.onDebug?.(
        `[EventAdapter] status message: status=${msg.status ?? 'null'}, mode=${msg.permissionMode ?? 'unchanged'}`,
      );
    }
  }

  /**
   * `background_tasks_changed` — REPLACE semantics ("swap your set for this
   * payload"), which our event model has no shape for.
   *
   * Mapping it onto `task_backgrounded` was rejected: that event is the Pi
   * background-task registration seam and SessionManager reacts to it by writing
   * `piBackgroundTaskKinds` and retaining a child authority, which would then
   * make the matching `task_completed` deliver a monitor event and start a turn.
   * So the set is diffed here and only the TRANSITIONS are announced, as plain
   * (non-persisted) info. A repeated identical payload emits nothing, which is
   * what makes a replace-semantics feed usable as a transcript at all.
   */
  private adaptBackgroundTasksChanged(
    msg: SDKBackgroundTasksChangedMessage,
    events: AgentEvent[],
  ): void {
    const tasks = Array.isArray(msg.tasks) ? msg.tasks : [];
    const current = new Map<string, { description?: string; taskType?: string; ambient?: boolean }>();
    for (const task of tasks) {
      if (!task?.task_id) continue;
      current.set(task.task_id, {
        ...(task.description ? { description: task.description } : {}),
        ...(task.task_type ? { taskType: task.task_type } : {}), ...(task.ambient ? { ambient: true } : {}), // UA4.8
      });
    }

    for (const [taskId, meta] of current) {
      if (!this.knownBackgroundTasks.has(taskId)) {
        events.push({
          type: 'info',
          message: `Background task started — ${meta.description || meta.taskType || taskId}`,
        });
      }
    }

    const hadTasks = this.knownBackgroundTasks.size > 0;
    if (hadTasks && current.size === 0) {
      events.push({ type: 'info', message: 'Background tasks finished.' });
    }

    // UA12.192 — a task the level stops naming has ended (its `task_notification` follows): never retire it at a restart.
    for (const taskId of this.knownBackgroundTasks.keys()) if (!current.has(taskId)) this.mainLineTasks.delete(taskId);
    this.knownBackgroundTasks = current;
    // P6.109 — the ROW, beside the info lines rather than instead of them.
    //
    // The info lines above are non-persisted transcript chatter: they say a task
    // STARTED, and once it is gone they are the only trace. What was missing is
    // the live affordance — an `ActiveTasksBar` row the user can see and stop —
    // and it needs the whole set, not a transition, because that is what the
    // payload's REPLACE semantics can honestly express. So the set goes out
    // verbatim, EVERY time (a repeated identical payload still emits no info
    // line, and still re-states the same rows, which is idempotent by
    // construction).
    //
    // Deliberately NOT `task_backgrounded`: that name is the Pi registration
    // seam and `SessionManager` reacts to it by writing `piBackgroundTaskKinds`
    // and retaining a child authority, which would make the matching
    // `task_completed` deliver a monitor event and start a turn. This event has
    // no server-side effect at all beyond being forwarded.
    //
    // The names are carried, and that is the second half of the row: the ids
    // alone would give the user a bar of opaque handles. `description` is the
    // SDK's own, `task_type` its fallback.
    events.push(this.backgroundTasksReplacedEvent());
  }

  /**
   * The current set as the renderer's row feed. See {@link adaptBackgroundTasksChanged}.
   *
   * UA12.18 — each entry also names the call that started it, read from {@link orchestrationRunByTask} (filled at
   * `task_started`, which is the only message that carries both ids, and cleared with the child at
   * `resetBackgroundTaskLevel`). `task_progress` is addressed by that `tool_use_id`, so without it a row rebuilt
   * from this feed could only be keyed by the task id, no progress ever matched it, and its elapsed time and
   * liveness never moved. A task never seen with a `tool_use_id` carries none — never a guessed one.
   */
  private backgroundTasksReplacedEvent(): AgentEvent {
    return {
      type: 'background_tasks_replaced',
      tasks: [...this.knownBackgroundTasks].map(([taskId, meta]) => {
        const toolUseId = this.orchestrationRunByTask.get(taskId);
        return {
          taskId,
          ...(meta.description ? { description: meta.description } : {}),
          ...(meta.taskType ? { taskType: meta.taskType } : {}),
          ...(toolUseId ? { toolUseId } : {}),
        };
      }),
    };
  }

  /**
   * L5 — THE BACKGROUND-TASK LEVEL IS PER-PROCESS, AND THE PROCESS NOW RESTARTS
   * UNDER A SESSION THIS ADAPTER OUTLIVES.
   *
   * `SDKBackgroundTasksChangedMessage`'s own contract ends with the instruction
   * this implements: *"The level is per-process: nothing is emitted at startup,
   * so consumers must reset to the empty set whenever the session's CLI process
   * (re)starts and let the next membership change repopulate it."*
   *
   * That sentence was harmless before L2 — a Claude turn WAS a process, and a
   * fresh process got a fresh adapter. It stopped being harmless the moment one
   * `query()` began outliving the turn, because the child is now respawned
   * MID-SESSION on several paths (an option drift in
   * `claudeLiveSessionSignature`, L4's fall-through when a live setter is
   * missing/refused/unanswered, source activation, and a turn that follows L3's
   * reaper) — and none of them rebuilds `ClaudeEventAdapter`. So
   * {@link knownBackgroundTasks} carries the DEAD process's ids into the new
   * one, and because the new process emits nothing at startup there is no
   * payload to correct it.
   *
   * Two lies came out of that, in opposite directions. The set still names a
   * task that died with the old child, so the next payload naming a genuinely
   * new task overwrites it and the user is never told the first one ended —
   * they were told it started. And `hadTasks` stays true across the restart, so
   * the first empty payload from the NEW child announces "Background tasks
   * finished." for a process that never ran any.
   *
   * The reset is not silent, for the reason L3 wrote down when it refused to
   * assert that an evicted holding was safe: the tasks did not FINISH, they
   * were lost with the child, and a "started" line the user has already read
   * must not simply dangle. The announcement says which, and is emitted only
   * when there was something to lose.
   *
   * @returns the events to surface, empty when no task was being tracked.
   */
  /**
   * How many background tasks this session's CLI child is currently running.
   *
   * A LIVENESS signal, and the only one Claude has. `SessionManager`'s busy
   * predicate could see Pi's background work through `piBackgroundTaskKinds`
   * and Claude's through nothing at all — the adapter deliberately refuses to
   * emit `task_backgrounded` (see {@link adaptBackgroundTasksChanged}), so the
   * one map that fed the predicate was never written on this path. A Claude
   * subagent, which the SDK's own Agent tool documents as running in the
   * background BY DEFAULT, therefore left every busy domain at zero and its
   * session was reapable — and a dispose kills the child and the work with it.
   *
   * Safe to read as a level, unlike `backgroundShellCommands`: the payload has
   * REPLACE semantics and the CLI emits one on every membership change, so this
   * SHRINKS when tasks end instead of latching. `resetBackgroundTaskLevel`
   * covers the one case a level cannot signal itself — the child dying.
   */
  get backgroundTaskCount(): number {
    return this.knownBackgroundTasks.size;
  }

  /**
   * UA4.8 — the same level WITHOUT the SDK's `ambient` tasks: "True for tasks that are not activity (every
   * skip_transcript task, plus every live-update watcher, requested or auto-started); hosts should exclude them from
   * activity indicators" (`SDKBackgroundTasksChangedMessage`, vendored `sdk.d.ts`). The Tasks Conductor's settlement
   * gate reads this one through `ClaudeAgent.backgroundActivityCount`; the busy predicate keeps
   * {@link backgroundTaskCount}, because a dispose kills an ambient task too.
   */
  get activityBackgroundTaskCount(): number {
    let count = 0;
    for (const meta of this.knownBackgroundTasks.values()) if (!meta.ambient) count += 1;
    return count;
  }

  /**
   * P2.35 — THE SDK REPORTS A RUNNING TOTAL; `usage.costUsd` MEANS A TURN'S OWN
   * COST. THIS IS WHERE THE TWO ARE RECONCILED.
   *
   * `sdk.d.ts:4359` documents `total_cost_usd` as *"Cumulative estimated cost in
   * USD for this query() call … cumulative across turns in streaming-input
   * sessions — each result carries the running total so far, so read the latest
   * result rather than summing across results. Crash/startup-error results may
   * carry zeroed values, resumed sessions start fresh, and a mid-session /clear
   * resets the running total."*
   *
   * This adapter used to forward that number verbatim. **Every consumer of
   * `usage.costUsd` in this repo adds it**: the ceiling in
   * `BaseAgent.exceedsMaxBudgetUsd`, the session's own total in
   * `SessionManager` (`tokenUsage.costUsd += …`, which is the figure the cost
   * surface renders), the OTLP export in `recordUsageMetrics`, and the goal
   * service's per-turn record. So N equal-cost turns of one child were counted
   * as N(N+1)/2·c against a true N·c, and from turn TWO the session was capped —
   * and billed on screen — at roughly half its real spend. That was a defect of
   * the EMITTER, not of any one reader: differencing here fixes all four at once,
   * and leaves Pi (whose backend already emits per-turn amounts) untouched.
   *
   * Three properties this deliberately has:
   *
   * - **A ZEROED total never becomes the baseline.** A crash result carrying one
   *   would otherwise make the next result re-count every dollar already counted —
   *   the original defect, restored by the guard meant to remove it. So a zero
   *   reports 0 and is forgotten.
   *
   *   **P2.46 SPLIT THIS FROM ITS TWIN, because the sentence above names THREE
   *   conditions and this guard folded two of them into one.**
   *   *"Crash/startup-error results may carry zeroed usage, resumed sessions
   *   start fresh, and a mid-session /clear resets the running total"* — a crash
   *   is a ZERO, a restart is a SMALLER NON-ZERO number, and they need opposite
   *   handling. Treating a restart as a crash keeps a baseline the child no
   *   longer has, so every dollar between the new running total and the dead peak
   *   is never reported: a silent, permanent UNDERCOUNT, in the one direction
   *   nothing downstream can detect. The restart branch takes the running total
   *   as both the delta and the new baseline, which is what "started over" means.
   *
   *   **Unreachable today, and landed anyway.** `/clear` always respawns (P2.35
   *   verified it three ways) and a respawn calls {@link resetReportedCostTotal},
   *   so the explicit signal always arrives first and the restart branch never
   *   runs. It is the fallback for the day that stops being true — a guard for a
   *   documented condition, not an inference standing in for the reset. That is
   *   also why P2.35's respawn control had to be REBUILT in the same commit: on
   *   its old `[3, 1, 2]` series the split infers what the reset used to say, so
   *   the control produced `[3, 1, 1]` with AND without the reset and stopped
   *   discriminating.
   * - **A delta of 0 stays 0 rather than becoming absent.** The cap's classifier
   *   contributes nothing for it, so an unpriced upstream reads exactly as it
   *   always did and P2.36's gap (nobody caps a session whose upstream reports no
   *   cost) was neither closed nor widened by this row. P2.36 closed the HONESTY
   *   half of it at the `costReporting` line above; the enforcement half cannot
   *   be closed, because there is no number.
   * - **It is per CHILD, not per session.** See {@link resetReportedCostTotal}.
   *
   * A differenced series re-sums to the running total only up to float error,
   * where forwarding the total did not. Irrelevant at this scale — the figure is
   * documented as "an estimate, not a billing statement", every consumer already
   * accumulated floats, and the error is ~1e-16 relative against a ceiling
   * denominated in dollars.
   *
   * `msg.modelUsage` carries the SAME cumulative-per-query semantics
   * (`sdk.d.ts:4367`, same wording) across all six of its consumption fields,
   * and was inflated in exactly this way for one row's length. P2.42 closed it
   * with the same shape one layer over — see
   * {@link takeReportedModelUsageDelta}, which follows this method's rules field
   * for field so the top line and the breakdown can never disagree again.
   */
  private takeReportedCostDelta(total: unknown): number {
    const running = typeof total === 'number' && Number.isFinite(total) && total > 0 ? total : 0;
    // P2.46 — the two SDK conditions this branch used to fold into one.
    //
    // `running === 0` is the documented CRASH result: report 0 and KEEP the
    // baseline, or the next result re-counts every dollar already counted.
    if (running === 0) return 0;
    // `0 < running < baseline` is the documented mid-session RESTART: the child
    // began a NEW running total, so all of it is new spend and it becomes the
    // baseline. Folding this into the crash case UNDERCOUNTS, silently and
    // permanently — every dollar between the new total and the dead peak is
    // never reported at all.
    if (running < this.reportedCostTotalUsd) {
      this.reportedCostTotalUsd = running;
      return running;
    }
    if (running === this.reportedCostTotalUsd) return 0;
    const delta = running - this.reportedCostTotalUsd;
    this.reportedCostTotalUsd = running;
    return delta;
  }

  /**
   * A new CLI child is starting, so its cost total starts again at zero.
   *
   * Called from the same spawn line as {@link resetBackgroundTaskLevel}, for the
   * same reason: `total_cost_usd` is scoped to one `query()` call, this adapter
   * is an agent field that outlives every respawn `ensureLiveSession` performs,
   * and a remembered total from a dead child would swallow the new child's spend
   * until it happened to exceed that peak.
   *
   * The host's `BaseAgent.sessionCostUsd` is deliberately NOT reset with it: the
   * session's total is the sum over children, which is the whole reason the
   * host-side ceiling exists beside the SDK's own per-child one — without a
   * session-scoped authority a session could respawn its way past any ceiling.
   * A `/clear` reaches this line too (`clearHistory()` nulls `sessionId`, the
   * resume anchor stops matching, the child is rebuilt), which matches the SDK
   * resetting its own total there — while the money already spent stays spent.
   */
  resetReportedCostTotal(): void {
    this.reportedCostTotalUsd = 0;
  }

  /**
   * P2.42 — THE SAME RECONCILIATION, ONE LAYER OVER: `modelUsage` IS A RUNNING
   * TOTAL PER MODEL, AND `AgentEventUsage.modelUsage` MEANS *"THIS TURN'S
   * PER-MODEL BREAKDOWN"*.
   *
   * `sdk.d.ts:4367` gives the map the identical wording `total_cost_usd` carries
   * at `:4359`: *"Cumulative across turns in streaming-input sessions: each
   * result carries the running total so far, so read the latest result rather
   * than summing across results … crash/startup-error results may carry zeroed
   * usage, resumed sessions start fresh, and a mid-session /clear resets the
   * running total."* It applies to ALL SIX consumption fields, not just
   * `costUSD`, and both readers of the projected map ADD: `mergeModelUsage`
   * (`before.<field> + turn.<field>`, per key, which is the session breakdown a
   * cost surface renders) and `recordUsageMetrics`' OTLP counters. So the map
   * this adapter forwarded verbatim carried the same triangular N(N+1)/2
   * inflation P2.35 took off the top line — measured before this fix, three
   * results of 1/2/3 merged to 6 against a true 3, in every field at once.
   *
   * Rules, each mirroring {@link takeReportedCostDelta} so the two counters
   * cannot drift apart again:
   *
   * - **Per FIELD, per KEY.** Every field advances on its own baseline via
   *   {@link advanceTotal}; a counter that did not move contributes 0, a ZEROED
   *   one contributes 0 without lowering the baseline, and a SMALLER NON-ZERO
   *   one is a restart that contributes all of itself and becomes the new
   *   baseline (P2.46 — the same split, in the same commit, as the top line;
   *   the two guards disagreeing about a restart is the contradiction this row
   *   exists to end). It also closes the residual P2.42 could only record: a key
   *   evicted and restarted outside a respawn (opus 5 → absent → 2 → 4) merges
   *   to 9 rather than to 5.
   * - **AN ABSENT KEY MEANS "NO NEW CONSUMPTION REPORTED FOR IT", NOT "RESET TO
   *   ZERO".** This is the boundary the map has and the scalar does not: a model
   *   present in one result, missing from the next and present again in a third.
   *   Its baseline is kept untouched across the gap, so the reappearance
   *   differences against what was already counted rather than re-counting it
   *   whole; and nothing at all is emitted for a model the result did not
   *   mention, so the emitted keys are the result's (bare ids, F1.1279) and
   *   `mergeModelUsage` adds zero for the models that stayed silent. The other
   *   reading — absence as a reset — is the same defect this row removes, in the
   *   one shape a per-key baseline can still reintroduce it.
   * - **A zeroed entry behaves like a zeroed total.** A crash result's zeros
   *   report nothing and lower nothing; the empty map the SDK sends instead
   *   never reaches here at all (the caller's `length > 0` guard), and
   *   `mergeModelUsage` returns the previous breakdown unchanged for it.
   * - **It is per CHILD.** See {@link resetReportedModelUsageTotals}.
   */
  private takeReportedModelUsageDelta(
    modelUsage: Record<string, ModelUsage>,
  ): Record<string, PersistedModelUsage> {
    const deltas: Record<string, PersistedModelUsage> = {};
    for (const [model, entry] of Object.entries(modelUsage)) {
      const baseline = this.reportedModelUsageTotals.get(model) ?? emptyModelUsageTotals();
      this.reportedModelUsageTotals.set(model, baseline);
      // The rename is field-for-field (`agent-sdk/typescript.md:4102`):
      // `cacheReadInputTokens`/`cacheCreationInputTokens`/`costUSD` there are
      // `cacheReadTokens`/`cacheCreationTokens`/`costUsd` here. `contextWindow`
      // and `maxOutputTokens` are dropped on purpose — capacity, not
      // consumption, and capacity already rides `usage.contextWindow`.
      // Non-finite values become 0 rather than propagating NaN into a total.
      deltas[model] = {
        inputTokens: advanceTotal(baseline, 'inputTokens', finite(entry?.inputTokens)),
        outputTokens: advanceTotal(baseline, 'outputTokens', finite(entry?.outputTokens)),
        cacheReadTokens: advanceTotal(baseline, 'cacheReadTokens', finite(entry?.cacheReadInputTokens)),
        cacheCreationTokens: advanceTotal(baseline, 'cacheCreationTokens', finite(entry?.cacheCreationInputTokens)),
        webSearchRequests: advanceTotal(baseline, 'webSearchRequests', finite(entry?.webSearchRequests)),
        costUsd: advanceTotal(baseline, 'costUsd', finite(entry?.costUSD)),
        // P2.36 — the same rule the top line uses, per model, off this model's
        // own CUMULATIVE `costUSD` rather than the delta `advanceTotal` just
        // returned. Was an unconditional `'reported'`; on an upstream the CLI
        // cannot price, every entry's `costUSD` is 0 and claiming otherwise made
        // the breakdown assert what the top line no longer does. The two must
        // agree — a breakdown that says "priced" over a total that says
        // "unsupported" is the disagreement P2.42 already paid for once.
        costReporting: claudeCostReporting(entry?.costUSD),
      };
    }
    return foldModelUsageKeys(deltas); // F1.1279: differenced per wire key, emitted under the bare id
  }

  /**
   * A new CLI child is starting, so its per-model totals start again at zero.
   *
   * Called from the spawn line beside {@link resetReportedCostTotal}, for the
   * reason written out there: `modelUsage` is scoped to one `query()` call
   * exactly as `total_cost_usd` is, and a dead child's remembered totals would
   * swallow the new child's consumption until it passed that peak. Clearing the
   * whole map is deliberate — a model the new child never uses has no baseline
   * to keep, and one it does use starts from zero like everything else.
   */
  resetReportedModelUsageTotals(): void {
    this.reportedModelUsageTotals.clear();
  }

  /**
   * P6.642 — the run's agent row, created on first sight.
   *
   * `agentType` defaults to `'agent'` rather than to the empty string: the cards
   * render it as a badge beside the label, and an empty badge is a rendering
   * artefact where "agent" is the honest generic. `SDKTaskStartedMessage`
   * documents `subagent_type` as present only "for Task tool subagents".
   */
  private ensureOrchestrationAgent(
    toolUseId: string,
    taskId: string,
    seed: { label: string; agentType?: string },
  ): OrchestrationProgressAgent {
    let run = this.orchestrationRuns.get(toolUseId);
    if (!run) {
      run = { runId: toolUseId, agents: new Map() };
      this.orchestrationRuns.set(toolUseId, run);
    }
    this.orchestrationRunByTask.set(taskId, toolUseId);
    let agent = run.agents.get(taskId);
    if (!agent) {
      agent = {
        id: taskId,
        label: seed.label,
        agentType: seed.agentType || 'agent',
        status: 'queued',
      };
      run.agents.set(taskId, agent);
    }
    return agent;
  }

  /** P6.642 — the snapshot both cards read, in insertion order. */
  private orchestrationSnapshot(toolUseId: string): OrchestrationProgress {
    const run = this.orchestrationRuns.get(toolUseId);
    return {
      kind: 'subagent',
      runId: toolUseId,
      agents: [...(run?.agents.values() ?? [])].map(agent => ({ ...agent })),
    };
  }

  /** P6.642 — a progress event carrying only the roster, for a state change with no usage of its own. */
  private orchestrationProgressEvent(toolUseId: string): AgentEvent {
    return {
      type: 'task_progress',
      toolUseId,
      orchestrationProgress: this.orchestrationSnapshot(toolUseId),
      turnId: this.currentTurnId || undefined,
    };
  }

  resetBackgroundTaskLevel(): AgentEvent[] {
    // P6.642 — per-CHILD state, dropped on the same line and for the same
    // reason: a run whose child is gone can never be completed, and a stale
    // roster would show agents that stopped existing.
    this.orchestrationRuns.clear();
    this.orchestrationRunByTask.clear();
    const retired = this.retireAnnouncedShells(); // UA12.192
    if (this.knownBackgroundTasks.size === 0) return retired;
    const count = this.knownBackgroundTasks.size;
    this.knownBackgroundTasks = new Map();
    return [{
      type: 'info',
      message: count === 1
        ? 'A background task did not survive the Claude session restart.'
        : `${count} background tasks did not survive the Claude session restart.`,
      level: 'warning',
    // P6.109 · the rows must go with the announcement. The new child emits
    // nothing at startup, so without an explicit empty set the bar would keep
    // offering a Stop for work that died with the old process — a row whose
    // press could only ever be refused.
    }, this.backgroundTasksReplacedEvent(), ...retired];
  }

  /**
   * `commands_changed` — a full replacement list, of which only the DELTA is
   * news. The whole set arrives on `init` too, so announcing the payload would
   * print every built-in command the first time a plugin loads.
   */
  private adaptCommandsChanged(msg: SDKCommandsChangedMessage, events: AgentEvent[]): void {
    const commands = Array.isArray(msg.commands) ? msg.commands : [];
    const named = commands.filter((command): command is typeof command & { name: string } => !!command?.name);
    const names = named.map(command => command.name);
    const previous = new Set(this._sdkSlashCommands);
    const added = names.filter(name => !previous.has(name));
    const removed = this._sdkSlashCommands.filter(name => !names.includes(name));

    this._sdkSlashCommands = names;
    // Written from the same payload in the same statement as the names above,
    // so the two views cannot drift. Empty strings are dropped rather than
    // carried: the SDK types `description` and `argumentHint` as REQUIRED
    // strings, so a command with neither arrives as two `''` values, and a
    // surface that renders `''` as a hint shows an empty bracket.
    this._sdkSlashCommandDetails = Object.freeze(named.map(command => Object.freeze({
      name: command.name,
      ...(command.description ? { description: command.description } : {}),
      ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
      ...(Array.isArray(command.aliases) && command.aliases.length > 0
        ? { aliases: Object.freeze([...command.aliases]) }
        : {}),
    })));

    if (added.length > 0) {
      events.push({
        type: 'info',
        message: `New commands available: ${added.map(name => `/${name}`).join(', ')}`,
      });
    }
    if (removed.length > 0) {
      this.callbacks.onDebug?.(`[EventAdapter] commands removed: ${removed.join(', ')}`);
    }
    if (added.length === 0 && removed.length === 0) {
      this.callbacks.onDebug?.(`[EventAdapter] commands_changed with no delta (${names.length} commands)`);
    }
  }

  /**
   * `rate_limit_event` — the subscription quota state.
   *
   * `allowed` is the normal case on every turn and must stay silent or it is
   * pure noise. The two loud states are persisted warnings, because "why did it
   * stop" is exactly the question a user asks after a reload.
   */
  private adaptRateLimit(msg: SDKRateLimitEvent, events: AgentEvent[]): void {
    const info = msg.rate_limit_info;
    if (!info || info.status === 'allowed') {
      this.callbacks.onDebug?.(`[EventAdapter] rate_limit_event: ${info?.status ?? 'no payload'}`);
      return;
    }

    const window = info.rateLimitType ? ` (${info.rateLimitType.replace(/_/g, ' ')})` : '';
    // P6.503 · Q-den 20 = A. The published case is unchanged; the ABSENT case
    // used to append `''`, so "no reset was published" and "we chose not to
    // print one" looked identical to the user. One wording for all three arms,
    // from `agent/usage-limit-reset.ts`, so the switch report carries no
    // divergence here — the seconds/milliseconds sniff that used to live in a
    // local helper here moved into that module with its reasoning intact, and
    // this was its only reader.
    //
    // GATED ON `rejected`, and the gate is read from the SDK's own type rather
    // than assumed. `SDKRateLimitInfo` declares `resetsAt?: number` — optional
    // on ALL THREE statuses, `allowed_warning` included — so the approaching
    // warning really can arrive with no reset. Its absence there is not why
    // anything stopped, because nothing has: printing "the turn stops here
    // rather than waiting" beside "Approaching your usage limit" would state a
    // false consequence, which is worse than the silence it replaced. So the
    // warning arm gains a sentence only when the server named a time, and the
    // stopping arm always says which of the two happened.
    //
    // P6.373 · and on the STOPPING arm the sentence now says resume-vs-stop and
    // NAMES the setting that decided it. `decideUsageLimitContinuation` is the
    // ordered gate: an unpublished reset stops the turn whatever the setting
    // says (there is no instant to wait for, and inventing one is exactly what
    // Q-den 20 refused), and only a published instant reaches the switch.
    //
    // The `no-reset-published` sentence is byte-identical to the one this line
    // printed before, so the absent case does not move. The warning arm is
    // deliberately NOT routed through the gate: nothing has stopped there, so
    // "the turn stops here rather than waiting" would state a false
    // consequence — the same reason the `rejected` gate exists at all.
    const reset = readPublishedUsageLimitReset(info.resetsAt);
    //
    // P7.13 · the third argument is GONE, and its absence is the change. It was
    // `{ waitIsWired: false }`, because `awaitUsageLimitReset` had no in-tree
    // caller and promising "then continuing automatically" would have been the
    // most convincing false sentence in the module. The vendored `0.3.247`
    // runtime performs the wait itself — `Settings.autoContinueAtUsageLimit`,
    // 18 occurrences in the native binary against 0 at `0.3.233` — and
    // `buildClaudeFlagSettingsOptions` now hands it the host's answer on every
    // spawn, so the sentence is true on this arm for the first time. Nothing was
    // built beside it: `awaitUsageLimitReset` still has no claude caller, which
    // is the point rather than an omission.
    //
    // The runtime's own eligibility predicate is `status==="rejected"` with a
    // finite `resetsAt` and no overage — this gate plus a clause we cannot see —
    // so it is STRICTER than ours and never looser. The residue that stays: a
    // limit the runtime declines to wait through for the overage reason would
    // print this sentence and stop anyway. That needs a live claude.ai limit to
    // observe and is P6.373's sitting case.
    const resets = info.status === 'rejected'
      ? describeUsageLimitContinuation(decideUsageLimitContinuation(reset))
      : reset.published ? describeUsageLimitReset(reset) : '';

    events.push({
      type: 'info',
      message: info.status === 'rejected'
        ? `Usage limit reached${window}.${resets}`
        : `Approaching your usage limit${window}.${resets}`,
      level: 'warning',
    });
  }

  private adaptAuthStatus(message: SDKMessage, events: AgentEvent[]): void {
    const msg = message as any;
    if (msg.error) {
      events.push({
        type: 'error',
        message: `Auth error: ${msg.error}. Try running /auth to re-authenticate.`,
      });
    }
  }

  // ============================================================
  // UA12.192 — a Claude background Bash is a SHELL (upstream v0.14.0's `local_bash` arm)
  // ============================================================
  //
  // Ported from craft-agents-oss `v0.14.0:packages/shared/src/agent/backend/claude/event-adapter.ts`
  // (`topLevelToolUseIds`, `mainAgentTasks`, `pushBackgroundedTask`; Apache-2.0), the `local_bash` arm ONLY: UA12.18
  // decided Claude stays off `task_backgrounded` (the Pi registration seam), and that stands for Monitor, MCP and every
  // other task type. A main-line background Bash becomes `shell_backgrounded` (id = the task id), so the host records
  // it in `backgroundShellCommands` — the Stop hook's `background_tasks`, `/tasks`, `killShell` (claude's
  // `Query.stopTask` through `stopBackgroundTask`) — and its chip reads Shell. Its end needs nothing new: the CLI's
  // `task_notification` is our `task_completed`, keyed on the same id, which retires the entry (UA12.101) and the row.
  // Two ends it cannot report are covered here and in SessionManager: a CLI restart (below, `retireAnnouncedShells`)
  // and a runtime disposal (`SessionManager.retireRuntimeMintedShells`) — the CLI cleans its background tasks up when
  // it exits (interactive-mode.md#how-backgrounding-works).

  /** Calls the session's OWN agent made (no parent tool use). Session-persistent and bounded, as upstream. */
  private mainLineToolUseIds = new Set<string>();
  /** Tasks those calls started: the starting call, the task type and description, and whether it was announced. */
  private mainLineTasks = new Map<string, { toolUseId: string; taskType?: string; description?: string; announced?: boolean }>();

  /**
   * UB9.8 — upstream v0.15.1's `wasLaunchedByMainAgent` (Apache-2.0) over this port's two maps: did the session's
   * OWN agent start this task? By the starting call when the message names one (a main-line call, bounded at 2000),
   * else by the task (bounded at 500, dropped when the task ends or the CLI restarts). Public for the between-turns
   * door (`ClaudeAgent.noteBetweenTurnsMessage`), which reads the same `task_progress` through the same gate.
   */
  wasLaunchedByMainAgent(taskId: string, toolUseId?: string): boolean {
    if (toolUseId) return this.mainLineToolUseIds.has(toolUseId);
    return this.mainLineTasks.has(taskId);
  }

  /** Remember a main-line assistant message's tool calls (an ABSENT `parent_tool_use_id` is main-line: `== null`). */
  private rememberMainLineToolUses(content: readonly ContentBlock[]): void {
    for (const block of content) {
      if (block.type === 'tool_use' && typeof (block as { id?: unknown }).id === 'string') {
        this.mainLineToolUseIds.add((block as { id: string }).id);
      }
    }
    trimOldestEntries(this.mainLineToolUseIds, 2000);
  }

  /** Remember a task the session's own agent started, and announce it at once when it starts in the background. */
  private noteMainLineTaskStarted(task: SDKTaskStartedMessage, events: AgentEvent[]): void {
    if (!task.tool_use_id || !this.mainLineToolUseIds.has(task.tool_use_id)) return;
    this.mainLineTasks.set(task.task_id, {
      toolUseId: task.tool_use_id,
      ...(typeof task.task_type === 'string' ? { taskType: task.task_type } : {}),
      ...(typeof task.description === 'string' && task.description ? { description: task.description } : {}),
    });
    trimOldestEntries(this.mainLineTasks, 500);
    if (task.is_backgrounded === true) this.announceMainLineShell(task.task_id, events);
  }

  /** Announce one of the session's own `local_bash` tasks as a background shell, once. Any other type: nothing. */
  private announceMainLineShell(taskId: string, events: AgentEvent[]): void {
    const task = this.mainLineTasks.get(taskId);
    if (!task || task.announced || task.taskType !== 'local_bash') return;
    task.announced = true;
    const input = this.toolIndex.getInput(task.toolUseId);
    const intent = task.description
      ?? (typeof input?._intent === 'string' && input._intent ? input._intent : undefined)
      ?? (typeof input?.description === 'string' && input.description ? input.description : undefined);
    events.push({
      type: 'shell_backgrounded',
      toolUseId: task.toolUseId,
      shellId: taskId,
      ...(this.currentTurnId ? { turnId: this.currentTurnId } : {}),
      ...(intent ? { intent } : {}),
      ...(typeof input?.command === 'string' ? { command: input.command } : {}),
    });
  }

  /**
   * At a CLI restart, end every announced shell whose end was never reported: the dead child took it with it
   * (interactive-mode.md#how-backgrounding-works: "Background tasks are automatically cleaned up when Claude Code
   * exits"). `stopped`, the status a stop at exit is; the host retires the map entry on it (UA12.101) and the chip
   * shows stopped. A task the level stopped naming, or whose `task_notification` arrived, is not here any more.
   */
  private retireAnnouncedShells(): AgentEvent[] {
    const retired: AgentEvent[] = [];
    for (const [taskId, task] of this.mainLineTasks) {
      if (task.announced && task.taskType === 'local_bash') retired.push({ type: 'task_completed', taskId, status: 'stopped' });
    }
    this.mainLineTasks.clear();
    return retired;
  }

  /** F1.1283 — the model of the latest MAIN-LINE assistant usage, which names the result's own `modelUsage` entry. */
  private lastMainLineModel: string | null = null;
}

/** UA12.192 — drop the oldest entries (insertion order) beyond `max` (upstream v0.14.0's `trimOldest`). */
function trimOldestEntries(collection: Set<string> | Map<string, unknown>, max: number): void {
  for (const key of collection.keys()) {
    if (collection.size <= max) return;
    collection.delete(key);
  }
}

/**
 * F1.241 — the trigger of a `compact_boundary`, read off the SDK's own
 * `compact_metadata.trigger` (`'manual' | 'auto'` in `sdk.d.ts`). A boundary that does not say
 * stays unstamped rather than guessed: `SessionManager` treats an unstamped compaction as it
 * treated every compaction before the field existed, and only a stamped `auto` is refused.
 */
function compactBoundaryTrigger(msg: unknown): { compactionTrigger?: 'manual' | 'auto' } {
  const trigger = (msg as { compact_metadata?: { trigger?: unknown } }).compact_metadata?.trigger
  return trigger === 'manual' || trigger === 'auto' ? { compactionTrigger: trigger } : {}
}

/**
 * F1.516 (2) (origin WJ-an P-WJ-an-2) — claude's hook outcome, mapped into {@link HookRunOutcome} "at its own
 * adapter", as that union asks, so a hook that REFUSED reads "blocked the action" and not "failed" (codex's has
 * since F1.515).
 *
 * `hooks.md#exit-code-2`, verbatim: "Exit 2 means a blocking error. On events that can block, exit 2 blocks whether
 * or not you print JSON". The SDK's own `hook_response.outcome` is only `'success' | 'error' | 'cancelled'`
 * (`sdk.d.ts`), and the shipped binary emits every blocking run as `exit_code: 2, outcome: 'error'` (read at
 * 2.1.267, `grep -aobF 'qy({'`: each `outcome:"blocking"` yield is preceded by a `hook_response` carrying
 * `exitCode:2,outcome:"error"`). So `error` + exit 2 is `blocked`, on an event the page's table
 * (`#exit-code-2-behavior-per-event`) marks "Can block? Yes" — {@link CLAUDE_EXIT_2_BLOCKING_EVENTS}. On every other
 * event exit 2 is not a block ("the permission flow proceeds unchanged", "the tool already ran", "Shows stderr to
 * user only"), and "failed" stays the honest word.
 *
 * One measured exception, read in the same binary (`function Cvn(`): a `Stop`, `SubagentStop`, `TaskCompleted` or
 * `TeammateIdle` hook (or a plugin's `UserPromptSubmit`) that exits 2 with EMPTY stdout and a stderr matching
 * `no such file|can't open` is treated as a missing script — a non-blocking error the CLI reports as "Hook script
 * appears to be missing". The message cannot say whether a `UserPromptSubmit` hook is a plugin's, so that event
 * takes the non-blocking reading too, which is what this line said before.
 */
export function claudeHookRunOutcome(
  hook: Pick<SDKHookResponseMessage, 'hook_event' | 'outcome' | 'exit_code' | 'stdout' | 'stderr'>,
): HookRunOutcome {
  if (hook.outcome !== 'error' || hook.exit_code !== 2 || !CLAUDE_EXIT_2_BLOCKING_EVENTS.has(hook.hook_event)) return hook.outcome;
  const missingScript = CLAUDE_MISSING_SCRIPT_EVENTS.has(hook.hook_event)
    && !(hook.stdout ?? '').trim()
    && /no such file|can't open/i.test(hook.stderr ?? '');
  return missingScript ? 'error' : 'blocked';
}

/** `hooks.md#exit-code-2-behavior-per-event`, the rows whose "Can block?" is Yes (read 2026-09-24). */
export const CLAUDE_EXIT_2_BLOCKING_EVENTS: ReadonlySet<string> = new Set([
  'PreToolUse', 'UserPromptSubmit', 'UserPromptExpansion', 'Stop', 'SubagentStop', 'TeammateIdle', 'TaskCreated',
  'TaskCompleted', 'ConfigChange', 'PostToolBatch', 'PreCompact', 'PreModelSwitch', 'Elicitation', 'ElicitationResult',
  'WorktreeCreate', 'WorktreeRemove',
]);

/** The events the binary's missing-script reading covers (`function Cvn(`, 2.1.267); see {@link claudeHookRunOutcome}. */
const CLAUDE_MISSING_SCRIPT_EVENTS: ReadonlySet<string> = new Set(['Stop', 'SubagentStop', 'TaskCompleted', 'TeammateIdle', 'UserPromptSubmit']);

/**
 * F1.909 — an MCP tool's result on claude arrives as a CONTENT ARRAY, and the row showed that array's JSON.
 *
 * SIT-aa (2026-09-25, RC `69a6d33da`) read claude's `remember` result as `[{"type":"text","text":"Saved memory…"}]`
 * where codex and Pi show the sentence. The shape is the SDK's own contract, not a quirk of one tool: the Agent SDK's
 * `McpOutput` (`sdk-tools.d.ts`, "MCP tool execution result") is a string, an array of `{ type, … }` blocks or an
 * object, and `ToolResultBlockParam.content` (`@anthropic-ai/sdk`, `messages.d.ts`) is a string or an array of text,
 * image, search-result, document and tool-reference blocks. `extractToolResults` hands either to `serializeResult`,
 * whose `JSON.stringify(value, null, 2)` is right for an object and wrong for a list of text blocks: the model reads
 * the texts, the user read their JSON.
 *
 * So, for an `mcp__` tool only, a result whose raw content is a NON-EMPTY array of `{ type: 'text', text: string }`
 * blocks becomes those texts joined by a newline — the join Pi's adapter already applies (`extractToolResult`).
 * Everything else returns `undefined` and keeps today's serialisation, deliberately:
 * - an array with ANY other block (an image, a resource link) — dropping it would hide that it was there, and the
 *   large-result guard's structured-JSON branch reads exactly that JSON to save the blob;
 * - a string or an object result — unchanged;
 * - other built-in tools (`Bash`, `Read`, …) — unchanged; their rows are not what SIT-aa read.
 *
 * F1.1146 (origin DN-216) — the parent-task tools (`Agent`, `Task`: `isParentTaskTool`) take the same join: their
 * result is the subagent's answer plus the `agentId: … (for resuming …)` footer as text blocks, and the row showed the
 * blocks' JSON. Safe for the background chips: `detectBackgroundEvents` runs its `agentId:` regex inside
 * `extractToolResults`, BEFORE this join, and the renderer's receipt patterns (`background-task-rows.ts`
 * `BACKGROUNDING_RESULT_PATTERNS`) read the same `agentId:` wording in the joined text (both pinned in
 * `claude-mcp-text-blocks-result.test.ts`).
 * The raw content is the matching `tool_result` block's (by `tool_use_id`) or, on the SDK's no-block fallback, its
 * `tool_use_result`. `isError` is untouched; the secret scan runs on the returned text.
 */
export function claudeMcpTextBlocksResult(
  event: AgentEvent,
  contentBlocks: readonly ContentBlock[],
  toolUseResult: unknown,
): string | undefined {
  if (event.type !== 'tool_result' || !(event.toolName?.startsWith('mcp__') || isParentTaskTool(event.toolName ?? ''))) return undefined;
  const hasBlocks = contentBlocks.some(block => block.type === 'tool_result');
  const raw = hasBlocks
    ? (contentBlocks.find(block => block.type === 'tool_result'
      && (block as { tool_use_id?: unknown }).tool_use_id === event.toolUseId) as { content?: unknown } | undefined)?.content
    : toolUseResult;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const texts: string[] = [];
  for (const part of raw as unknown[]) {
    const block = part as { type?: unknown; text?: unknown } | null;
    if (!block || typeof block !== 'object' || block.type !== 'text' || typeof block.text !== 'string') return undefined;
    texts.push(block.text);
  }
  return texts.join('\n');
}

/**
 * F1.1247 — the SDK's prompt-block banner without its `Original prompt:` section.
 *
 * Read in the vendored 2.1.274 binary: a blocked UserPromptSubmit (or
 * UserPromptExpansion) prompt yields the informational banner
 * `<Event> operation blocked by hook:\n<reason>\n\nOriginal prompt: <prompt>`
 * unless the hook set `suppressOriginalPrompt` (hooks.md#what-a-blocked-prompt-leaves-behind:
 * "By default the block message shown to the user ends with `Original prompt:`
 * followed by the submitted text"). The submitted text here is the HOST-DECORATED
 * prompt — the date preamble, `<session_state>`, the skills catalogue — which the
 * user never typed (release sitting SIT2-b: a 2613 px row). The native field
 * reaches only hooks the host answers; a user's native exit-2 hook with no JSON
 * "always gets the prompt text", so the cut is made here, for every hook source.
 * The user's own words stay in their own message row; the block reason is kept.
 * Any other informational is passed through untouched.
 */
function withoutBlockedPromptText(content: string): string {
  if (!/^(?:UserPromptSubmit|UserPromptExpansion) operation blocked by hook:\n/u.test(content)) return content
  const cut = content.indexOf('\n\nOriginal prompt:')
  return cut === -1 ? content : content.slice(0, cut).trimEnd()
}

/**
 * SDK keep-alive progress for a long-running tool: `<tool_use_id>-heartbeat-<n>`
 * under that tool (UA12.39; upstream #1008, predicate verbatim from
 * v0.14.0:packages/shared/src/agent/backend/claude/event-adapter.ts). Measured in
 * the vendored CLI 2.1.274 on 2026-10-04: the CLI emits one `progress` frame with
 * `toolUseID: `${id}-heartbeat-${n}`` (data type `tool_heartbeat`) every 30 s and
 * its bridge yields it to this adapter as a plain `tool_progress` whose
 * parent_tool_use_id is the running tool (the frame also carries a literal
 * `heartbeat: true`, which upstream's predicate deliberately does not read).
 * Without this check adaptToolProgress read an unseen id and opened a fresh
 * "Running …" row per heartbeat; the heartbeats only update elapsed time.
 */
export function isToolHeartbeat(progress: { tool_use_id: string; parent_tool_use_id: string | null }): boolean {
  return /-heartbeat-\d+$/.test(progress.tool_use_id)
    && (!progress.parent_tool_use_id || progress.tool_use_id.startsWith(`${progress.parent_tool_use_id}-heartbeat-`));
}

/**
 * F1.745 (origin WJ-crit-x) — whether a result's `errors` entry belongs in the Error box. Claude Code's own UI filters
 * every `[ede_diagnostic]` and `[session_crash]` entry out before it shows a result's errors (read in the vendored
 * 2.1.267 binary by WJ-crit-x): they are diagnostics, not errors. F1.731 kept them out of an ABORTED result by reading
 * it as a Stop; this keeps them out of a genuine error's text too. A result whose every entry is a diagnostic falls
 * back to the result text or the generic message, so a provider error never shows an empty box.
 */
function isClaudeResultErrorShown(entry: unknown): boolean {
  return typeof entry === 'string' && !/^\[(?:ede_diagnostic|session_crash)\]/.test(entry.trimStart());
}

/** F1.1283 — the model a main-line assistant message (or its stream's `message_start`) names, normalized, or null. */
function claudeMainLineModelOf(message: unknown): string | null {
  const raw = message as { message?: { model?: unknown }; event?: { message?: { model?: unknown } } } | null;
  const model = raw?.message?.model ?? raw?.event?.message?.model;
  return typeof model === 'string' && model.trim() ? normalizeContextModelKey(model) : null;
}

/**
 * F1.1283 — which `modelUsage` entry is the MAIN model's: the one the SDK's own `getContextUsage` reported on, else the
 * one the turn's main-line assistant named, else the first (the behaviour that shipped). A turn's `modelUsage` carries
 * every model the child called, so a background request on another model can be listed first, and its window is not
 * this session's.
 */
function claudePrimaryModelUsageKey(
  modelUsage: Record<string, unknown> | undefined,
  sdkModel: string | null,
  mainLineModel: string | null,
): string | undefined {
  const keys = Object.keys(modelUsage ?? {});
  for (const wanted of [sdkModel, mainLineModel]) {
    const match = wanted === null ? undefined : keys.find(key => normalizeContextModelKey(key) === wanted);
    if (match !== undefined) return match;
  }
  return keys[0];
}
