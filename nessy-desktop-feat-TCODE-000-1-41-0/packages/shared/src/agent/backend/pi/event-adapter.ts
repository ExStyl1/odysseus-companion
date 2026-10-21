/**
 * Pi SDK Event Adapter
 *
 * Maps Pi Agent Core events (AgentEvent / AgentSessionEvent) to
 * Nessy Desktop's AgentEvent format for UI compatibility.
 *
 * Pi emits fine-grained lifecycle events. We translate them into
 * the same event vocabulary the renderer already understands from
 * Claude / Codex / Copilot backends.
 */

import {
  isOrchestrationProgress,
  isOrchestrationResultPayload,
  type OrchestrationProgress,
  type OrchestrationResultPayload,
} from '@nessy-agent/core';
import type {
  AgentEvent as NessyAgentEvent,
  AgentTerminalReason,
  ContextUsageSnapshot,
  PermissionRequest,
} from '@nessy-agent/core/types';
import { retryStatusEvent } from '@nessy-agent/core/types';
import type {
  AgentEvent as PiAgentEvent,
} from '@earendil-works/pi-agent-core';
import type {
  AgentSessionEvent,
} from '@earendil-works/pi-coding-agent';
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai';
import { isContextOverflow, isRetryableAssistantError } from '@earendil-works/pi-ai';
import { BaseEventAdapter } from '../base-event-adapter.ts';
import {
  PARTIAL_TOOL_INPUT_FLOOR_CHARS,
  nextPartialToolInputThreshold,
  parsePartialToolInput,
} from '../partial-tool-input.ts';
import type { PiExecutionManifestV2, ResolvedHarnessTool } from '../../pi-harness/harness-manifest.ts';
import { findPiToolBinding, getHarnessToolDescriptor, getPiToolBindingByBindingName } from '../../pi-harness/harness-tool-descriptor.ts';
import { readToolCallHeartbeatElapsedSeconds } from '../../pi-harness/execution-receipt.ts';
import { toolMetadataStore } from '../../../interceptor-common.ts';
import { createAgentError, parseError } from '../../errors.ts';
import { scrubToolResultPayload } from '../../tool-result-secret-scan.ts';
import { i18n, setupI18n } from '../../../i18n/index.ts';

/**
 * The Pi runtime version whose `AgentSessionEvent` union this switch is
 * enumerated against — it must track `SUPPORTED_PI_RUNTIME_VERSION` in
 * `packages/pi-agent-server/src/compat/pi-runtime-adapter.ts`. Named here
 * because the `default` arm's message is how an unenumerated variant is
 * reported, and that report is useless without the version it was measured on.
 *
 * Moved 0.84.0 → 0.84.2 by S0-3 (2026-09-03) only after diffing the union, not
 * on the package version: `pi-coding-agent`'s `dist/core/agent-session.d.ts`
 * declares the SAME string-literal arms in both releases, so no variant this
 * switch enumerates was added, removed or renamed. Bumping this constant
 * without that diff would have widened the claim the `default` arm makes on
 * every unknown event — the message names this version as the one the union was
 * read from, and a version nobody read is worse than a stale one.
 *
 * Moved 0.84.2 → 0.84.3 by W11-pi (P7.3, 2026-09-11) and 0.84.3 → 0.84.4 by
 * C3.380 lift 2 (W19-z2, 2026-09-13) under the same rule. QUOTE THE METHOD BESIDE
 * THE NUMBER, because the count is a reading and not a fact — the line above said
 * 27 for a method nobody recorded, and this one says 23 for one written down:
 * the DISTINCT `type: "…"` literals of `AgentSessionEvent`'s own slice of
 * `agent-session.d.ts` unioned with `AgentEvent`'s slice of `pi-agent-core`'s
 * `dist/types.d.ts` — 14 and 10 with `agent_end` shared — is 23 at 0.84.3, and
 * W10-g's read-only rig measured 23 arm-for-arm identical across 0.84.2 and
 * 0.84.3 with the baseline test's own extractor, zero added and zero removed.
 *
 * Re-run by that same extractor on the INSTALLED 0.84.4, again on 0.85.1
 * (F1.255, 2026-09-24) and on 0.87.1 (UA12.211, 2026-10-10), before this constant
 * moved: union 23 each time, the 23 names compared ARM-FOR-ARM against the pinned
 * list in `runtime-behavior.json` (`h1bRuntimeProtocol.selectedEvents`) — **zero
 * added, zero removed** every time (0.85 dropped a DUPLICATE `auto_retry_end`; at
 * 0.87.1 the slices read 10 and 16 where 0.84.3 read 14 and 10 — the boundary
 * moved, the names did not). So the `default` arm's claim is as wide at 0.87.1 as
 * at 0.84.3, which licenses the bump; `pi-harness-baseline.test.ts` re-derives it.
 *
 * 0.84.4, 0.85.1 and 0.87.1 added NO event (the arm-for-arm comparison above). 0.84.3 DID
 * add a compaction-failure event — `session_compact_failed` — and it
 * is not in this union: it reaches extension handlers only
 * (`_emitSessionCompactFailed` → `extensionRunner.emit`), and every one of its
 * five emit sites fires beside a `compaction_end` carrying the same `reason`,
 * `errorMessage`, `aborted` and `willRetry`. See the `compaction_end` arm below.
 */
// Exported for `pi-agent-max-turns.test.ts`, which pins the unsupported-event message and used to spell the
// version by hand — the 0.84.4 lift (C3.380) left it saying 0.84.3, which the 1.38.0 close-out run caught.
export const SUPPORTED_PI_EVENT_VERSION = '0.87.1';

/**
 * REMOVED HERE (TFP1, 2026-10-10): `SDK_AUTOCOMPACT_RACE_SIGNATURE` — the
 * `/_autoCompactionAbortController\.signal/` regex that used to live on this
 * spot. It matched the raw stack of the Pi SDK auto-compaction race (two
 * overlapping `_runAutoCompaction` calls: one's `finally` cleared the shared
 * `_autoCompactionAbortController` field while the other was still suspended on
 * an await, and the next `.signal` read crashed) and rewrote that
 * `compaction_end.errorMessage` into a friendly "Try /compact manually" hint,
 * on the row P7.9's theory that the crash was still reachable at 0.84.3 — see
 * plans/fix-pi-gpt-compaction.md. The fix landed in 0.87.1: the `finally`
 * clears the field only while it still holds THAT call's controller, and the
 * body reads `.signal` through its local `abortController`, never off the
 * field, so the crash-shaped stack can no longer be produced by any runtime
 * this adapter supports. `compaction-failure-surface.test.ts` pins the fixed
 * shape, and `pi-event-adapter.test.ts` pins the generic line a race-shaped
 * error now rides. This tombstone keeps the docs-cited lines below at their
 * addresses.
 */

/** How long to wait after a held overflow `agent_end` for a `compaction_start`
 *  before giving up and surfacing the original error. The SDK fires
 *  `_checkCompaction` on the same event-queue tick, so the only delay is event
 *  serialization — 5 s is well above any plausible jitter. */
const OVERFLOW_FALLBACK_TIMEOUT_MS = 5_000;

/**
 * The throttle subset of pi-ai's `RETRYABLE_PROVIDER_ERROR_PATTERN`
 * (`@earendil-works/pi-ai/dist/utils/retry.js`). That pattern also matches
 * timeouts, 5xx and socket drops, which `auto_retry_start` reports through the
 * same event — so the retry status line classifies off the error message rather
 * than claiming a rate limit for every retry.
 */
const RATE_LIMIT_ERROR_PATTERN = /429|rate.?limit|too many requests/i;

type PiToolIdentity = Pick<PermissionRequest,
  'semanticId' | 'piName' | 'surfaceVersion' | 'originalName'
  | 'manifestGeneration' | 'manifestHash' | 'manifestProvenance'>;

function extractOrchestrationProgress(details: unknown): OrchestrationProgress | null {
  if (isOrchestrationProgress(details)) {
    return details;
  }

  if (typeof details !== 'object' || details === null || !('progress' in details)) {
    return null;
  }

  const progress = (details as { progress?: unknown }).progress;
  return isOrchestrationProgress(progress) ? progress : null;
}

function extractOrchestrationResult(value: unknown): OrchestrationResultPayload | null {
  if (isOrchestrationResultPayload(value)) {
    return value;
  }

  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const record = value as { details?: unknown; result?: unknown };
  if (isOrchestrationResultPayload(record.result)) {
    return record.result;
  }

  if (record.details && typeof record.details === 'object') {
    const details = record.details as { result?: unknown };
    if (isOrchestrationResultPayload(details.result)) {
      return details.result;
    }
  }

  return null;
}

function extractStructuredContent(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const details = (value as { details?: unknown }).details;
  if (typeof details !== 'object' || details === null) {
    return undefined;
  }

  const structuredContent = (details as { structuredContent?: unknown }).structuredContent;
  if (
    typeof structuredContent !== 'object'
    || structuredContent === null
    || Array.isArray(structuredContent)
    || Object.keys(structuredContent).length === 0
  ) {
    return undefined;
  }

  return structuredContent as Record<string, unknown>;
}

function orchestrationStatusToTaskStatus(
  status: OrchestrationResultPayload['status'],
): Extract<NessyAgentEvent, { type: 'task_completed' }>['status'] {
  switch (status) {
    case 'done':
      return 'completed';
    case 'aborted':
      return 'stopped';
    case 'error':
      return 'failed';
  }
}

/**
 * Combined event type the adapter can handle.
 * AgentSessionEvent is a superset of PiAgentEvent (adds compaction_*, auto_retry_*, queue_update).
 */
type PiEvent = PiAgentEvent | AgentSessionEvent;
type ContextUsageUpdateEvent = { type: 'context_usage_update'; usage: ContextUsageSnapshot };

/**
 * Maps Pi SDK events to Nessy Desktop AgentEvents for UI compatibility.
 *
 * Event mapping:
 * - message_update (text_delta in assistantMessageEvent) → text_delta
 * - message_update (thinking_delta/thinking_end) → intermediate text_delta/text_complete
 * - message_end → text_complete
 * - tool_execution_start → tool_start
 * - tool_execution_end → tool_result
 * - agent_end → complete (held while overflow recovery or an SDK auto-retry is in flight — F1.235)
 * - compaction_start → status (with "Compacting" keyword)
 * - compaction_end → info/error
 * - auto_retry_start → status carrying its facts in `retry` (P6.916)
 * - auto_retry_end → status carrying `retry.kind: 'succeeded'`, error on failure
 * - queue_update → status with counts only (never queued prompt contents)
 * - session_info_changed / thinking_level_changed → safe info diagnostics
 */
/**
 * P6.158 — the id and name of the tool call at `contentIndex`, read from the
 * accumulating assistant message that rides beside every `toolcall_delta`.
 * Pi's `toolcall_start` carries neither, so this is the only source before
 * `toolcall_end`. Returns `null` when the block is not there yet, or is not a
 * tool call, or has no id: the caller then emits nothing, because an invented
 * id would draw a second card that `tool_execution_start` never closes.
 */
function readPiToolCallIdentity(
  message: unknown,
  contentIndex: number,
): { id: string; name: string } | null {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return null;
  const block = content[contentIndex] as { type?: string; id?: unknown; name?: unknown } | undefined;
  if (!block || block.type !== 'toolCall') return null;
  if (typeof block.id !== 'string' || block.id.length === 0) return null;
  if (typeof block.name !== 'string' || block.name.length === 0) return null;
  return { id: block.id, name: block.name };
}

export class PiEventAdapter extends BaseEventAdapter {
  // Track tool names from execution_start for proper tool_result correlation
  private toolNames: Map<string, { toolName: string; identity: PiToolIdentity; wholeToolDenyRefusal?: string }> = new Map();
  private executionManifest: PiExecutionManifestV2 | null = null;

  // Track whether streaming deltas have been received for the current message
  private hasStreamedDeltas: boolean = false;

  // Track whether a final (non-intermediate) text_complete has been emitted this turn
  private hasEmittedFinalText: boolean = false;

  // Sub-turnId isolation for tool calls within a single Pi turn
  private subTurnCounter: number = 0;
  private messageSubTurnId: string | null = null;
  private thinkingSubTurnId: string | null = null;
  private thinkingBuffer: string = '';

  /**
   * P6.158 — tool input arriving live, keyed by the SDK's `contentIndex`.
   * Pi's own `toolcall_start`/`toolcall_delta`/`toolcall_end` have always been
   * on this channel — the same channel `thinking_delta` below already reads —
   * and this adapter had no branch for them, so a tool call's arguments
   * appeared in one block at `tool_execution_start`. See
   * `../partial-tool-input.ts` for the two rules these entries keep.
   */
  private partialToolInputs = new Map<number, { buffer: string; nextEmitAt: number; emitted: boolean }>();

  // Model context window for usage_update events
  private contextWindow: number | undefined;
  private lastContextUsage: ContextUsageSnapshot | undefined;

  // Mini model ID for call_llm display default (#596).
  // Used when the caller didn't specify an explicit model — we fill args.model
  // on the tool_start event so the UI shows the effective default instead of
  // leaving the badge blank.
  private miniModel: string | undefined;

  // F1.1073 — this turn's model calls, summed for its `complete` (the context size stays the latest call's): `addTurnUsage`
  private turnUsage: PiTurnUsage | undefined;

  // ============================================================
  // Overflow-recovery state machine
  // ============================================================
  //
  // When a Pi-routed assistant message returns a context_length_exceeded
  // error, the Pi SDK's `_checkCompaction` fires `_runAutoCompaction("overflow",
  // true)` and, on success, calls `agent.continue()` to retry. That recovered
  // turn arrives AFTER the original `agent_end`. If we yield `complete` and
  // call `eventQueue.complete()` on the original `agent_end` (the historic
  // behavior), the recovered turn lands in a closed iterator. The state
  // machine below holds the queue open across the SDK's recovery flow so the
  // recovered response reaches the UI.
  private overflowState: 'none' | 'held' | 'awaiting' | 'compacting' | 'recovering' = 'none';
  private heldOverflowError: string | null = null;
  private fallbackTimerId: ReturnType<typeof setTimeout> | null = null;
  /** Set when the adapter wants the caller to call `eventQueue.complete()`
   *  on a non-`agent_end` event (e.g. `compaction_end` failure). Consumed by
   *  `shouldCompleteQueue()`. */
  private pendingQueueComplete: boolean = false;
  /** Caller-supplied callbacks for the asynchronous fallback timer path —
   *  the timer fires outside `adaptEvent()` so we can't yield through the
   *  generator. */
  private onFallbackEvent: ((event: NessyAgentEvent) => void) | null = null;
  private onFallbackComplete: (() => void) | null = null;

  constructor() {
    super('pi-event');
  }
  setExecutionManifest(manifest: PiExecutionManifestV2 | null, wholeToolDenyRefusals?: PiWholeToolDenyRefusals): void {
    this.executionManifest = manifest;
    this.wholeToolDenyRefusals = manifest ? wholeToolDenyRefusals : undefined; // F1.756 — see the end of this class
    this.toolNames.clear();
  }

  /**
   * Set the model's context window size for usage reporting.
   */
  setContextWindow(cw: number): void {
    this.contextWindow = cw;
  }

  setContextUsageSnapshot(snapshot: ContextUsageSnapshot | undefined): void {
    this.lastContextUsage = snapshot;
    if (snapshot?.contextWindow && snapshot.contextWindow > 0) {
      this.contextWindow = snapshot.contextWindow;
    }
  }

  /**
   * Register handlers invoked when the overflow-recovery fallback timer fires
   * (the SDK didn't emit a `compaction_start` after a held overflow `agent_end`
   * within `OVERFLOW_FALLBACK_TIMEOUT_MS`). Adapter calls `onEvent` to enqueue
   * the buffered original error, then `onComplete` to terminate the iterator.
   */
  setOverflowFallbackHandlers(
    onEvent: (event: NessyAgentEvent) => void,
    onComplete: () => void,
  ): void {
    this.onFallbackEvent = onEvent;
    this.onFallbackComplete = onComplete;
  }

  /**
   * Decide whether the caller should call `eventQueue.complete()` after
   * processing this SDK event. The historical rule was "always on
   * `agent_end`"; with overflow recovery and the SDK auto-retry (F1.235) we defer
   * completion until the recovered or retried turn finishes (or it fails / times out).
   */
  shouldCompleteQueue(isAgentEnd: boolean): boolean {
    if (this.pendingQueueComplete) {
      this.pendingQueueComplete = false;
      return true;
    }
    return isAgentEnd && this.overflowState === 'none' && this.retryState === 'none';
  }

  /**
   * Reset overflow-recovery AND auto-retry state (F1.235), so no stale fallback timer fires on a torn-down adapter.
   */
  resetOverflowState(): void {
    this.cancelOverflowFallbackTimer();
    this.overflowState = 'none';
    this.heldOverflowError = null;
    this.pendingQueueComplete = false;
    this.resetRetryState();
  }

  private armOverflowFallbackTimer(): void {
    this.cancelOverflowFallbackTimer();
    this.fallbackTimerId = setTimeout(() => {
      this.fallbackTimerId = null;
      // Re-check state at fire time — a late `compaction_start` may have
      // already transitioned us to `compacting`.
      if (this.overflowState !== 'awaiting') return;
      const errorMessage = this.heldOverflowError ?? 'Context overflow';
      this.heldOverflowError = null;
      this.overflowState = 'none';
      this.log.warn('Overflow recovery fallback fired — SDK emitted no compaction events', {
        timeoutMs: OVERFLOW_FALLBACK_TIMEOUT_MS,
      });
      this.onFallbackEvent?.({ type: 'error', message: errorMessage });
      this.onFallbackComplete?.();
    }, OVERFLOW_FALLBACK_TIMEOUT_MS);
  }

  private cancelOverflowFallbackTimer(): void {
    if (this.fallbackTimerId !== null) {
      clearTimeout(this.fallbackTimerId);
      this.fallbackTimerId = null;
    }
  }

  /**
   * Set the mini model ID for call_llm badge default.
   * When the agent's call_llm invocation omits `args.model`, we fill it with
   * this so the UI badge shows the effective default instead of nothing.
   * Explicit `args.model` values from the agent are always preserved.
   */
  setMiniModel(model: string | undefined): void {
    this.miniModel = model;
  }

  /**
   * Generate a unique sub-turnId for a text block within the current turn.
   */
  private nextSubTurnId(prefix: string): string {
    const base = this.currentTurnId || 'unknown';
    return `${base}__${prefix}${this.subTurnCounter++}`;
  }

  private flushThinking(contentOverride?: string): NessyAgentEvent | null {
    const text = contentOverride ?? this.thinkingBuffer;
    if (!text) {
      this.thinkingSubTurnId = null;
      this.thinkingBuffer = '';
      return null;
    }

    const turnId = this.thinkingSubTurnId || this.nextSubTurnId('thinking');
    this.thinkingSubTurnId = null;
    this.thinkingBuffer = '';
    return {
      type: 'text_complete',
      text,
      isIntermediate: true,
      // P4.4 · Pi's runtime has surfaced reasoning since long before this row —
      // `thinking_start`/`thinking_delta`/`thinking_end` below — and we already
      // read it. What was missing was the LABEL: the renderer received it as
      // ordinary commentary, so reasoning and the model's user-facing asides
      // drew the same row and reasoning was eligible for promotion into the
      // response bubble. Nothing to enable on the runtime; only to say what
      // this text is.
      isThinking: true,
      turnId,
    };
  }

  protected onTurnStart(): void {
    this.toolNames.clear();
    this.partialToolInputs.clear();
    this.hasStreamedDeltas = false;
    this.hasEmittedFinalText = false;
    this.subTurnCounter = 0;
    this.messageSubTurnId = null;
    this.thinkingSubTurnId = null;
    this.thinkingBuffer = '';
    this.log.debug('Turn started', { turnIndex: this.turnIndex });
  }

  /**
   * Adapt a Pi SDK event to zero or more Nessy Desktop AgentEvents.
   */
  *adaptEvent(event: PiEvent): Generator<NessyAgentEvent> {
    if ((event as { type?: string }).type === 'context_usage_update') {
      const e = event as unknown as ContextUsageUpdateEvent;
      this.setContextUsageSnapshot(e.usage);
      yield {
        type: 'usage_update',
        usage: {
          inputTokens: e.usage.inputTokens,
          contextWindow: e.usage.contextWindow,
          contextUsage: e.usage,
        },
      };
      return;
    }
    // Nessy-injected event from pi-agent-server (not part of the Pi SDK).
    // The subprocess emits this immediately after each `message_end` to deliver
    // the correct `sdkTurnAnchor` (the leaf id AFTER the SDK has appended the
    // assistant entry). We forward it through as-is — SessionManager correlates
    // it to a Nessy assistant message via `sdkMessageId`.
    if ((event as { type?: string }).type === 'pi_turn_anchor') {
      const e = event as unknown as { sdkMessageId?: string; sdkTurnAnchor?: string };
      if (e.sdkMessageId && e.sdkTurnAnchor) {
        yield {
          type: 'pi_turn_anchor',
          sdkMessageId: e.sdkMessageId,
          sdkTurnAnchor: e.sdkTurnAnchor,
        };
      }
      return;
    }
    if ((event as { type?: string }).type === 'shell_backgrounded') {
      const e = event as unknown as { toolUseId?: string; shellId?: string; command?: string };
      if (e.toolUseId && e.shellId) {
        yield {
          type: 'shell_backgrounded',
          toolUseId: e.toolUseId,
          shellId: e.shellId,
          ...(e.command ? { command: e.command } : {}),
        };
      }
      return;
    }
    if ((event as { type?: string }).type === 'task_backgrounded') {
      const e = event as unknown as {
        toolUseId?: string;
        taskId?: string;
        kind?: 'workflow' | 'subagent' | 'mcp';
      };
      if (e.toolUseId && e.taskId) {
        yield {
          type: 'task_backgrounded',
          toolUseId: e.toolUseId,
          taskId: e.taskId,
          ...(e.kind ? { kind: e.kind } : {}),
        };
      }
      return;
    }
    if ((event as { type?: string }).type === 'task_notification') {
      // R10: the settled result of a detached MCP call. Passed through to the
      // host, which routes it into the R3 task-notification delivery.
      const e = event as unknown as { taskId?: string; text?: string };
      if (typeof e.taskId === 'string' && e.taskId && typeof e.text === 'string' && e.text) {
        yield { type: 'task_notification', taskId: e.taskId, text: e.text };
      }
      return;
    }
    if ((event as { type?: string }).type === 'task_completed') {
      const e = event as unknown as {
        taskId?: string;
        status?: 'completed' | 'failed' | 'stopped';
        summary?: string;
      };
      if (e.taskId && (e.status === 'completed' || e.status === 'failed' || e.status === 'stopped')) {
        yield {
          type: 'task_completed',
          taskId: e.taskId,
          status: e.status,
          ...(e.summary ? { summary: e.summary } : {}),
        };
      }
      return;
    }

    switch (event.type) {
      // ============================================================
      // Agent lifecycle events
      // ============================================================

      case 'agent_start':
        this.onRetriedAgentStart(); // F1.235 — the retried run after a backoff; otherwise internal
        break;

      case 'agent_end': {
        const terminalReason = (event as { terminalReason?: AgentTerminalReason }).terminalReason;
        // R18: structured-output result fields enriched onto agent_end by the
        // subprocess turn loop ride the complete event unchanged.
        const structured = event as {
          structuredOutput?: unknown;
          structuredOutputSubtype?: 'success' | 'error_max_structured_output_retries';
          structuredOutputErrors?: string[];
        };
        const structuredFields = {
          ...(structured.structuredOutputSubtype !== undefined
            ? { structuredOutputSubtype: structured.structuredOutputSubtype }
            : {}),
          ...('structuredOutput' in structured && structured.structuredOutput !== undefined
            ? { structuredOutput: structured.structuredOutput }
            : {}),
          ...(structured.structuredOutputErrors !== undefined
            ? { structuredOutputErrors: structured.structuredOutputErrors }
            : {}),
        };
        // F1.235 — the SDK's auto-retry holds the turn open; see `agentEndRetryStep`.
        if (yield* this.agentEndRetryStep(event as { willRetry?: boolean }, terminalReason)) break;
        if (terminalReason) this.resetOverflowState();
        // Overflow recovery: hold the queue open while the SDK runs
        // _runAutoCompaction("overflow") + agent.continue(). The recovered
        // turn will arrive as a fresh agent_start … agent_end pair.
        if (!terminalReason && this.overflowState === 'held') {
          this.overflowState = 'awaiting';
          this.armOverflowFallbackTimer();
          break;
        }
        if (!terminalReason && (
          this.overflowState === 'awaiting' || this.overflowState === 'compacting'
        )) {
          // Defensive: an agent_end while still mid-recovery shouldn't happen
          // in the SDK's normal flow. Keep the queue open and wait for
          // compaction_end (success → recovering, error → drain).
          break;
        }
        if (!terminalReason && this.overflowState === 'recovering') {
          // Recovered turn just finished — fall through to normal completion.
          this.overflowState = 'none';
        }
        // F1.1073 — the usage of EVERY model call this turn made, summed.
        // pi-ai puts one `Usage` on each assistant message (one per
        // response), so a tool-using turn reports two or more; this used to
        // keep only the latest (`lastUsage`) and report it here, which
        // charged the session totals, the goal record and the budget cap for
        // the LAST call alone (two calls of 5 / 0.50 and 7 / 0.25 totalled
        // 7 / 0.25). Output and cost add up, as Pi's own `getSessionStats`
        // adds them (`addUsageToTotals`); the context size (`inputTokens`)
        // and the cache counters stay the latest call's, which is what the
        // host reads them as. See {@link takeTurnUsage}, which also decides
        // `costReporting` and clears the sum, so a later `complete` of the
        // same turn (a handoff's or a Stop's, F1.628 / F1.1162) cannot report it
        // twice. A turn whose every call failed carries no usage at all, not
        // the previous turn's (the old `lastUsage` was never reset per turn).
        const usage = this.takeTurnUsage();
        yield {
          type: 'complete',
          ...(usage ? { usage } : {}),
          ...(terminalReason ? { terminalReason } : {}),
          ...structuredFields,
        };
        // Residue, by reading: a fallback-model retry re-enters `chatImpl`,
        // whose `startTurn` resets the sum, so a call that succeeded before
        // the typed error that started the retry is not in the retried
        // turn's `complete` (nor was it before: the retried call overwrote
        // `lastUsage`). A call that FAILED is never counted: the error arm of
        // `message_end` breaks before `addTurnUsage`, as it broke before the
        // old assignment. The two arms this replaced (with usage, without)
        // differed only in that field, so they are one yield now.
        break;
      }

      // ============================================================
      // Turn events
      // ============================================================

      case 'turn_start':
        // Pi SDK turn_start has no ID, so generate one for event correlation
        this.currentTurnId = `pi-turn-${this.turnIndex}`;
        break;

      case 'turn_end':
        // Don't emit 'complete' here — agent_end handles it.
        // Emitting from both causes duplicate messages in session persistence.
        this.currentTurnId = null;
        this.hasStreamedDeltas = false;
        this.hasEmittedFinalText = false;
        this.subTurnCounter = 0;
        this.messageSubTurnId = null;
        this.thinkingSubTurnId = null;
        this.thinkingBuffer = '';
        this.partialToolInputs.clear();
        break;

      // ============================================================
      // Message events (text streaming)
      // ============================================================

      case 'message_start':
        // Pi SDK emits message_start for user messages too — skip non-assistant
        break;

      case 'message_update': {
        // Pi SDK emits message_update only for assistant messages (streaming deltas)
        const amEvent: AssistantMessageEvent = event.assistantMessageEvent;
        if (amEvent.type === 'thinking_start') {
          this.thinkingSubTurnId = this.nextSubTurnId('thinking');
          this.thinkingBuffer = '';
          break;
        }
        if (amEvent.type === 'thinking_delta' && amEvent.delta) {
          if (!this.thinkingSubTurnId) {
            this.thinkingSubTurnId = this.nextSubTurnId('thinking');
          }
          this.thinkingBuffer += amEvent.delta;
          yield {
            type: 'text_delta',
            text: amEvent.delta,
            turnId: this.thinkingSubTurnId,
          };
          break;
        }
        if (amEvent.type === 'thinking_end') {
          const thinking = this.flushThinking(amEvent.content);
          if (thinking) yield thinking;
          break;
        }
        // P6.158 — a tool call's arguments arriving live. Pi's SDK has always
        // declared these three; nothing needed enabling, only reading. Emitted
        // as a `tool_start` re-emission (the path `tool-matching.ts`'s
        // `hasNewInput` branch already uses) and never registered in
        // `ToolIndex`, whose `register` overwrites only an EMPTY input — a
        // partial stored there would be frozen for the rest of the session.
        if (amEvent.type === 'toolcall_start') {
          this.partialToolInputs.set(amEvent.contentIndex, {
            buffer: '',
            nextEmitAt: PARTIAL_TOOL_INPUT_FLOOR_CHARS,
            emitted: false,
          });
          break;
        }
        if (amEvent.type === 'toolcall_delta' && amEvent.delta) {
          const entry = this.partialToolInputs.get(amEvent.contentIndex);
          if (!entry) break;
          entry.buffer += amEvent.delta;
          if (entry.buffer.length < entry.nextEmitAt) break;
          entry.nextEmitAt = nextPartialToolInputThreshold(entry.buffer.length);
          // `toolcall_start` carries no id or name — only `contentIndex` — so
          // both are read from the accumulating message the SDK ships beside
          // the delta. When neither carries the block yet there is nothing
          // honest to name, and we emit nothing rather than guess an id that
          // would draw a second card.
          const call = readPiToolCallIdentity(
            amEvent.partial ?? (event as { message?: unknown }).message,
            amEvent.contentIndex,
          );
          if (!call) break;
          const partial = parsePartialToolInput(entry.buffer);
          if (!partial || Object.keys(partial).length === 0) break;
          const resolved = this.resolveToolIdentity(call.name);
          entry.emitted = true;
          yield {
            type: 'tool_start',
            toolName: resolved.toolName,
            toolUseId: call.id,
            input: this.normalizeToolInput(resolved.toolName, partial),
            turnId: this.currentTurnId || undefined,
            ...resolved.identity,
          };
          break;
        }
        if (amEvent.type === 'toolcall_end') {
          // Complete the card we started drawing, from the SDK's own parsed
          // arguments. ONLY when an incremental view was actually emitted: a
          // small input never drew one, and `tool_execution_start` below is the
          // right and only event for it.
          const ending = this.partialToolInputs.get(amEvent.contentIndex);
          this.partialToolInputs.delete(amEvent.contentIndex);
          const call = amEvent.toolCall;
          if (ending?.emitted && call && typeof call.id === 'string' && typeof call.name === 'string') {
            const resolved = this.resolveToolIdentity(call.name);
            const args = (call.arguments ?? parsePartialToolInput(ending.buffer) ?? {}) as Record<string, unknown>;
            if (Object.keys(args).length > 0) {
              yield {
                type: 'tool_start',
                toolName: resolved.toolName,
                toolUseId: call.id,
                input: this.normalizeToolInput(resolved.toolName, args),
                turnId: this.currentTurnId || undefined,
                ...resolved.identity,
              };
            }
          }
          break;
        }
        if (amEvent.type === 'text_delta' && amEvent.delta) {
          this.hasStreamedDeltas = true;
          if (!this.messageSubTurnId) {
            this.messageSubTurnId = this.nextSubTurnId('m');
          }
          yield {
            type: 'text_delta',
            text: amEvent.delta,
            turnId: this.messageSubTurnId,
          };
        }
        break;
      }

      case 'message_end': {
        // Pi SDK emits message_end for ALL messages (user, assistant, toolResult).
        // Only process assistant messages — skip user prompts and tool results.
        const msg = event.message as { role?: string; stopReason?: string; errorMessage?: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: { total: number } }; id?: string } | undefined;
        // SDK message id, set by pi-agent-server when forwarding the event.
        // SessionManager uses this to correlate the follow-up `pi_turn_anchor`
        // event to the Nessy assistant message created here (#782).
        const sdkMessageId = (event as { sdkMessageId?: string }).sdkMessageId ?? msg?.id;
        if (msg?.role !== 'assistant') break;

        // Surface API errors — Pi SDK sets stopReason: 'error' and errorMessage on failures
        if (msg.stopReason === 'error' && msg.errorMessage) {
          yield* this.discardFailedPartial(); // F1.298 — a failed stream never completes
          // Context overflow: hand recovery to the SDK's _runAutoCompaction and keep the
          // UI quiet until the outcome is known (recovered turn, or compaction fails).
          if (
            (this.overflowState === 'none' || this.overflowState === 'recovering') &&
            isContextOverflow(event.message as AssistantMessage, this.contextWindow)
          ) {
            this.overflowState = 'held';
            this.heldOverflowError = msg.errorMessage;
            break;
          }

          // Classify the error — auth/billing errors are typed so SessionManager can run
          // its auth-retry pipeline (refresh token + resend). F1.350 — a transient failure
          // pi-ai itself retries ('terminated', 'socket hang up', …) is a typed
          // network_error / service_error with Retry, parked or shown, never the raw text
          // (`classifyAssistantError`, appended at the end of this class).
          const errorEvent = this.classifyAssistantError(event.message as AssistantMessage, msg.errorMessage);
          // F1.235 — a retryable error is PARKED: the next agent_end's `willRetry` decides.
          if (this.parkRetryableError(event.message as AssistantMessage, errorEvent)) break;
          yield errorEvent;
          break;
        }

        const thinking = this.flushThinking();
        if (thinking) yield thinking;

        // Extract text content from the final assistant message
        const textContent = this.extractTextFromMessage(event.message);
        // Pi SDK stopReason: 'toolUse' means the model will call tools next (intermediate commentary),
        // 'stop'/'end_turn' means final response. Same logic as Claude's stop_reason === 'tool_use'.
        const isIntermediate = msg.stopReason === 'toolUse';
        if (textContent && (isIntermediate || !this.hasEmittedFinalText)) {
          if (!isIntermediate) this.hasEmittedFinalText = true;

          const mTurnId = this.messageSubTurnId || this.nextSubTurnId('m');
          this.messageSubTurnId = null;

          yield {
            type: 'text_complete',
            text: textContent,
            isIntermediate,
            turnId: mTurnId,
            sdkMessageId,
          };
          this.hasStreamedDeltas = false;
        } else if (!textContent && !isIntermediate && !this.hasEmittedFinalText && msg.usage && (msg.usage as { output?: number }).output) {
          // UB2.5 (R14-24), ported from craft-agents-oss v0.15.1's pi event-adapter
          // (Apache-2.0) as a USER-VISIBLE info, not upstream's console.warn: the model
          // used output tokens but produced no text — reasoning consumed the entire
          // output budget (observed with DeepSeek models when context is large and no
          // budget_tokens cap is set). Without this the turn silently completes and the
          // user sees no reply with no error. Final non-intermediate message only, once
          // per turn (`hasEmittedFinalText` guards both arms).
          //
          // UB12.24 — the sentence is READ from `chat.reasoningAteBudget` (en+ru) and the
          // count from `chat.tokensUsed`, in the host's language at emit time — the way
          // `pi-agent.ts`'s guardian markers and `codex-agent.ts`'s operator notices are.
          // This used to be the key's en text as a literal, which left the key with no
          // reader (lint:i18n:reachable red) and showed a Russian user English. The
          // adapters' "nothing here is translated" rule (backend/claude/event-adapter.ts
          // header) does not bite this line: that rule protects info/status strings a
          // layer up MATCHES BY WORDS (`Compacting`, `Compacted`, `Compaction failed`, the
          // retry prefixes), and nothing matches this one — it is persisted and shown as
          // written (level warning). The guard is the one every host-side i18n site
          // carries: an uninitialised i18next answers `undefined`, and the headless
          // `nessy-server` entry never calls `setupI18n()`.
          const outputTokens = (msg.usage as { output?: number }).output;
          if (!i18n.isInitialized) setupI18n();
          yield {
            type: 'info',
            level: 'warning',
            message: `${i18n.t('chat.reasoningAteBudget')} (${i18n.t('chat.tokensUsed', { displayCount: outputTokens })})`,
          };
        }

        // Emit usage_update if the assistant message includes token usage
        if (msg.usage && typeof msg.usage.input === 'number') {
          this.addTurnUsage(msg.usage); // F1.1073 — summed over the turn, reported by `agent_end`'s `complete`
          const inputTokens = msg.usage.input + (msg.usage.cacheRead || 0);
          yield {
            type: 'usage_update',
            usage: {
              inputTokens,
              contextWindow: this.contextWindow,
              contextUsage: this.lastContextUsage
                ? { ...this.lastContextUsage, inputTokens, source: 'sdk_usage' }
                : undefined,
            },
          };
        }
        break;
      }

      // ============================================================
      // Tool events
      // ============================================================

      case 'tool_execution_start': {
        const toolCallId = event.toolCallId;
        const resolvedTool = this.resolveToolIdentity(event.toolName);
        const { toolName, identity } = resolvedTool;
        this.toolNames.set(toolCallId, resolvedTool);

        // Normalize Pi field names to Claude Code format for UI compatibility
        // (diff stats, diff overlay, document routing all expect Claude Code format)
        const args = this.normalizeToolInput(toolName, (event.args ?? {}) as Record<string, unknown>);

        // For call_llm, fill in the default display model when the caller didn't
        // specify one — Pi's call_llm defaults to miniModel. We only fill the gap;
        // we never overwrite an explicit agent-provided model (that was the #596 bug).
        if (toolName.includes('call_llm') && this.miniModel && !args.model) {
          args.model = this.miniModel;
        }

        // Canonical metadata from subprocess event payload (interceptor/bridge-authoritative path).
        const eventMeta = this.extractToolMetadataFromEvent(event);

        // Backward-compatibility fallback: shared store (legacy side-channel),
        // with id canonicalization fallback for mixed call-id formats.
        const { meta: storedMeta, keyTried } = this.resolveStoredMetadata(toolCallId);

        // Last-resort fallback: args metadata if present.
        const argsIntent = typeof args._intent === 'string' ? args._intent : undefined;
        const argsDisplayName = typeof args._displayName === 'string' ? args._displayName : undefined;

        const intent = eventMeta?.intent
          || storedMeta?.intent
          || argsIntent
          || (typeof args.description === 'string' ? args.description : undefined);

        const displayName = eventMeta?.displayName
          || storedMeta?.displayName
          || argsDisplayName
          || this.getToolDisplayName(toolName);

        const metadataSource = eventMeta
          ? 'event'
          : storedMeta
            ? `store(${keyTried})`
            : (argsIntent || argsDisplayName)
              ? 'args'
              : (typeof args.description === 'string')
                ? 'description'
                : 'fallback';

        this.log.debug('Tool metadata resolution', {
          toolName,
          toolCallId,
          metadataSource,
          hasIntent: !!intent,
          hasDisplayName: !!displayName,
        });

        // Classify bash commands that are actually file reads
        if (toolName === 'Bash' && typeof args.command === 'string') {
          const readInfo = this.classifyReadCommand(toolCallId, args.command);
          if (readInfo) {
            yield {
              ...this.createReadToolStart(
              toolCallId,
              readInfo,
              intent,
              'Read File',
              ),
              ...identity,
            };
            break;
          }
        }

        yield {
          ...this.createToolStart(toolCallId, toolName, args, intent, displayName),
          ...identity,
        };
        break;
      }

      case 'tool_execution_update': {
        // Accumulate genuine streaming output, but never the human-facing
        // status text attached to structured orchestration progress. The
        // latter is transient UI state; treating it as output would replace
        // the terminal subagent/workflow result at tool_execution_end.
        const partialResult = event.partialResult;
        if (partialResult && typeof partialResult === 'object') {
          const details = (partialResult as { details?: unknown }).details;
          // The executor's own silence heartbeat (tool-executor.ts,
          // `TOOL_CALL_HEARTBEAT_INTERVAL_MS`) rides the same push channel. It
          // is liveness, not output: it updates the elapsed display the
          // renderer already has and its text is dropped, exactly as
          // orchestration status text is.
          const heartbeatElapsedSeconds = readToolCallHeartbeatElapsedSeconds(details);
          if (heartbeatElapsedSeconds !== null) {
            yield {
              type: 'task_progress',
              toolUseId: event.toolCallId,
              elapsedSeconds: heartbeatElapsedSeconds,
              turnId: this.currentTurnId || undefined,
            };
            break;
          }
          const orchestrationProgress = extractOrchestrationProgress(details);
          const content = (partialResult as { content?: Array<{ type: string; text?: string }> }).content;
          if (!orchestrationProgress && Array.isArray(content)) {
            for (const part of content) {
              if (part.type === 'text' && part.text) {
                this.accumulateOutput(event.toolCallId, part.text);
              }
            }
          }

          if (orchestrationProgress) {
            yield {
              type: 'task_progress',
              toolUseId: event.toolCallId,
              orchestrationProgress,
              turnId: this.currentTurnId || undefined,
            };
          }
        }
        break;
      }

      case 'tool_execution_end': {
        const toolCallId = event.toolCallId;
        const resolvedTool = this.toolNames.get(toolCallId);
        const resolvedToolName = resolvedTool?.toolName || 'tool';
        const identity = resolvedTool?.identity ?? {};
        this.toolNames.delete(toolCallId);
        const orchestrationResult = extractOrchestrationResult(event.result);
        const structuredContent = extractStructuredContent(event.result);

        // Check for block reason (F1.756 — a whole-tool-denied call's refusal is one)
        const blockReason = this.consumeBlockReason(toolCallId, resolvedToolName) ?? this.wholeToolDenyResult(resolvedTool, event.result, event.isError);

        // Use accumulated output from partial results if available
        const accumulatedOutput = this.consumeOutput(toolCallId);

        const isError = event.isError;
        let result: string;

        if (accumulatedOutput) {
          result = accumulatedOutput;
        } else if (blockReason) {
          result = blockReason;
        } else {
          result = this.extractToolResult(event.result, isError);
        }

        // P6.753 — the Pi arm of the host secret scan, and the ONLY one Pi has
        // for these two payloads.
        //
        // `createPiToolResultTransformer` (P6.574) scans in the subprocess, and
        // it is wired on `createToolExecutor` — the LOCAL tool path. An MCP
        // result reaches Pi through the SDK's own client and never meets that
        // transformer, and `structuredContent` was not scanned on any arm. Both
        // arrive here, on the one seam every Pi tool result crosses.
        //
        // Scanning text that the subprocess already scrubbed costs nothing and
        // cannot double-report: a marker carries no token prefix, so the second
        // pass finds nothing and the result comes back by identity. A clean
        // result is therefore byte-for-byte what it was before this line.
        const scrubbed = scrubToolResultPayload(result, structuredContent);

        // After tool completion, the assistant may generate new text
        this.hasEmittedFinalText = false;
        this.messageSubTurnId = null;

        // Check if this was classified as a file read
        const readInfo = this.consumeReadCommand(toolCallId);
        if (readInfo) {
          yield {
            ...this.createToolResult(toolCallId, 'Read', scrubbed.text, isError, undefined, scrubbed.structuredContent),
            ...identity,
          };
          break;
        }

        yield {
          ...this.createToolResult(toolCallId, resolvedToolName, scrubbed.text, isError, undefined, scrubbed.structuredContent),
          ...identity,
        };
        if (orchestrationResult) {
          yield {
            type: 'task_completed',
            taskId: orchestrationResult.runId,
            status: orchestrationStatusToTaskStatus(orchestrationResult.status),
            summary: scrubbed.text,
            turnId: this.currentTurnId || undefined,
          };
        }
        break;
      }

      // ============================================================
      // Session-level events (AgentSessionEvent extensions)
      // ============================================================

      case 'compaction_start':
        // Cancel the overflow fallback timer — the SDK is now actively
        // recovering, so we no longer need the "no compaction event arrived"
        // safety net. State transitions: held|awaiting → compacting.
        if (this.overflowState === 'held' || this.overflowState === 'awaiting') {
          this.cancelOverflowFallbackTimer();
          this.overflowState = 'compacting';
        }
        // Use "Compacting" keyword so session handler detects statusType: 'compacting'
        yield { type: 'status', message: 'Compacting context...' };
        break;

      case 'compaction_end': {
        // P7.9 — `session_compact_failed` was going to replace an INFERENCE here,
        // and the premise does not survive being read. Measured against the
        // installed 0.84.3 (`@earendil-works/pi-coding-agent`):
        //
        //  - Nothing here is inferred. `compaction_end` carries `result`,
        //    `aborted` and `errorMessage` as first-class fields, and the three
        //    branches below read exactly those. The only INFERENCE in this arm is
        //    the auto-compaction RACE signature, which the new event does not
        //    report either — it carries the same `errorMessage` string.
        //  - The new event cannot reach this adapter at all. It is on the
        //    EXTENSION `SessionEvent` union, emitted through
        //    `_emitSessionCompactFailed` → `extensionRunner.emit`, and it is
        //    absent from `AgentSessionEvent` — which is the union this switch
        //    consumes and which `pi-agent-server` forwards over the wire.
        //  - Every one of its five emit sites fires BESIDE a `compaction_end`
        //    carrying the same `reason`, `errorMessage`, `aborted` and
        //    `willRetry`. The single field it adds is `fromExtension`, which says
        //    whether the failing content came from a `session_before_compact`
        //    handler, and nothing on this path asks that question.
        //
        // So adopting it would mean registering an extension handler in
        // `pi-agent-server` and inventing a wire event to carry one boolean we do
        // not read — more code for less than nothing. The native mechanism for
        // "compaction failed" that reaches the host IS `compaction_end`, and it
        // is what is consumed below. `compaction-failure-surface.test.ts` pins
        // both halves against the installed `.d.ts`, so the day upstream promotes
        // the event into `AgentSessionEvent` this decision is re-opened by a red
        // rather than by someone re-reading the changelog.
        const compactionEvent = event as Extract<AgentSessionEvent, { type: 'compaction_end' }>;
        if (compactionEvent.result && !compactionEvent.aborted) {
          // Success: stay open and wait for the recovered agent_end. State
          // transitions: compacting → recovering. Threshold-only compactions
          // (state was 'none') just emit the info and continue normally.
          if (this.overflowState === 'compacting') {
            this.overflowState = 'recovering';
            this.heldOverflowError = null;
          }
          // Use "Compacted" keyword so session handler detects statusType: 'compaction_complete'
          yield { type: 'info', message: 'Compacted context to fit within limits', compactionTrigger: compactionEvent.reason === 'manual' ? 'manual' : 'auto' };
        } else if (compactionEvent.errorMessage) {
          // The old defensive branch for the Pi SDK auto-compaction race
          // (cause A in plans/fix-pi-gpt-compaction.md) is gone: the upstream
          // fix shipped in 0.87.1 — the `finally` clears
          // `_autoCompactionAbortController` only while it still holds this
          // call's controller, and nothing reads `.signal` off the field — so
          // the crash-shaped stack the old regex matched can no longer be
          // produced by any runtime this adapter supports, and the friendly
          // "Try /compact manually" rewrite had nothing left to match. Every
          // failure now surfaces as itself, which is the honest line: a
          // compaction failure at 0.87.1 is a real failure to report, not a
          // known transient the host should soften. The overflow state
          // machine below keeps the queue handling identical to what the old
          // branch did after its message: the held turn is still finalized
          // here, with no recovered `agent_end` to wait for. The tombstone
          // where `SDK_AUTOCOMPACT_RACE_SIGNATURE` was records the premise.
          yield {
            type: 'error',
            message: `Context compaction failed: ${compactionEvent.errorMessage}`,
          };
          // If we were holding the queue open for overflow recovery, finalize
          // the turn now — no recovered agent_end will arrive on the failure
          // path. pendingQueueComplete signals the caller to terminate the
          // iterator since this is a non-agent_end event.
          if (
            this.overflowState === 'compacting' ||
            this.overflowState === 'awaiting' ||
            this.overflowState === 'held'
          ) {
            yield { type: 'complete' };
            this.pendingQueueComplete = true;
            this.overflowState = 'none';
            this.heldOverflowError = null;
            this.cancelOverflowFallbackTimer();
          }
        }
        break;
      }

      case 'auto_retry_start': {
        const retryEvent = event as Extract<AgentSessionEvent, { type: 'auto_retry_start' }>;
        // The gateway retry ladder (`GATEWAY_RETRY_SETTINGS`, each wait capped at
        // Pi's 60 s `maxAgentDelayMs`) is 15/30/60/60/60s, so the attempt counter
        // on its own leaves the user watching a spinner for minutes with no idea
        // whether anything is still alive. The wait is the point of the line.
        //
        // P6.916 — the facts are FIELDS: `retryStatusEvent` mints the `retry` payload
        // SessionManager reads to stamp `statusType: 'retrying'` and the sentence, from
        // one vocabulary in `core/types/message.ts`. The line the user sees is unchanged.
        this.onAutoRetryStart(retryEvent.delayMs); // F1.235 — hold the turn for the retried run
        const seconds = Math.max(1, Math.round(retryEvent.delayMs / 1000));
        // `auto_retry_start` fires for EVERY error pi-ai classifies retryable —
        // timeouts, 5xx, socket drops (`pi-ai/dist/utils/retry.js`
        // RETRYABLE_PROVIDER_ERROR_PATTERN). Naming a rate limit unconditionally
        // would state a false cause on most retries, so classify off the error.
        // P6.274 (b) — and WHICH provider error, in the provider's own words.
        // pi-ai hands us only free text, so the cause is the first clause of
        // that text rather than a classification of ours: naming a category we
        // invented would be a confident answer the user cannot check. Bounded
        // to one short line because it renders inside the spinner label; the
        // full text reaches the transcript if the ladder runs out, as the parked
        // error `agentEndRetryStep` releases (F1.301). The parenthesis is
        // read back by `renderer/event-processor/retry-status.ts`.
        const cause = (retryEvent.errorMessage ?? '')
          .replace(/\s+/g, ' ')
          .trim()
          .split(/[:.]\s/)[0]
          ?.slice(0, 60)
          .trim();
        const isRateLimit = RATE_LIMIT_ERROR_PATTERN.test(retryEvent.errorMessage ?? '');
        yield retryStatusEvent({
          kind: isRateLimit ? 'rate_limit' : 'provider_error',
          ...(!isRateLimit && cause ? { cause } : {}),
          attempt: retryEvent.attempt,
          maxAttempts: retryEvent.maxAttempts,
          delaySeconds: seconds,
        });
        break;
      }

      case 'auto_retry_end': {
        const retryEndEvent = event as Extract<AgentSessionEvent, { type: 'auto_retry_end' }>;
        if (retryEndEvent.success) {
          // Without this the last thing the user saw stays "… in 60s" for the
          // rest of the turn, which reads as still-waiting.
          yield retryStatusEvent({ kind: 'succeeded' });
        } else if (this.retryHoldsTurn()) {
          // F1.235 — cancelled during the backoff (or it never ran) while the turn
          // was held for it: no agent_end follows, so the turn ends here.
          yield* this.finishCancelledRetry(retryEndEvent.finalError);
        }
        // F1.299 — otherwise stay quiet. After an exhausted ladder the SDK emits this
        // from `_handlePostAgentRun`, i.e. AFTER the run's final `agent_end
        // { willRetry: false }` (pi-coding-agent 0.84.4 `dist/core/agent-session.js`),
        // which already released the parked error and ended the turn — so this is
        // the same failure told twice, and when the host had re-opened a turn by
        // then (the fallback-model hop) the old "Retry failed: <error>" landed in
        // the NEW turn. Upstream (craft-agents-oss v0.13.4, Apache-2.0) stays quiet
        // here for the same reason: one failure, one error.
        break;
      }

      case 'queue_update': {
        const queueEvent = event as Extract<AgentSessionEvent, { type: 'queue_update' }>;
        yield {
          type: 'status',
          message: `Pi queue updated: ${queueEvent.steering.length} steering, ${queueEvent.followUp.length} follow-up`,
        };
        break;
      }

      case 'session_info_changed':
        yield { type: 'info', message: 'Pi session info changed' };
        break;

      case 'thinking_level_changed': {
        const thinkingEvent = event as Extract<AgentSessionEvent, { type: 'thinking_level_changed' }>;
        yield { type: 'info', message: `Pi thinking level changed: ${thinkingEvent.level}` };
        break;
      }

      // ============================================================
      // Pi 0.83/0.84 additions to AgentSessionEvent
      //
      // The subprocess forwards every session event unfiltered and the
      // `default` arm below yields `{type:'error'}`, so an unlisted variant
      // becomes an error banner. Each of these six is enumerated from the
      // INSTALLED `AgentSessionEvent` union
      // (`dist/core/agent-session.d.ts`) and handled the way the other
      // informational events above are: no user-visible output, because the
      // events carry none that the transcript does not already show.
      // ============================================================

      case 'agent_settled':
        // Pi's first-class "the loop has gone idle" signal. Nessy derives turn
        // completion from `agent_end` plus its own pending list, so this is
        // internal — emitting anything here would double-report the turn.
        break;

      case 'entry_appended':
        // Fires once per appended session-JSONL entry, i.e. several times per
        // turn. The entry's content already reaches the user through the
        // message/tool events above; this is the persistence echo.
        break;

      case 'bash_execution_update':
        // Streaming stdout/stderr delta for a running bash tool call. Tool
        // output is already streamed through `tool_execution_update`, so
        // forwarding this too would duplicate every line.
        break;

      case 'summarization_retry_scheduled': {
        // The summarizer behind compaction / branch summaries is retrying.
        // `compaction_start` has already put "Compacting context..." on screen
        // and `compaction_end` reports the outcome, so the retry stays a
        // diagnostic rather than a second status line.
        const retry = event as Extract<AgentSessionEvent, { type: 'summarization_retry_scheduled' }>;
        this.log.warn('Pi summarization retry scheduled', {
          attempt: retry.attempt,
          maxAttempts: retry.maxAttempts,
          delayMs: retry.delayMs,
          errorMessage: retry.errorMessage,
        });
        break;
      }

      case 'summarization_retry_attempt_start':
      case 'summarization_retry_finished':
        // Bookends of the retry above — internal for the same reason.
        break;

      default: {
        const eventType = String((event as { type?: unknown }).type ?? '(missing)');
        this.log.warn(`Unsupported Pi ${SUPPORTED_PI_EVENT_VERSION} event: ${eventType}`);
        yield { type: 'error', message: `Unsupported Pi ${SUPPORTED_PI_EVENT_VERSION} event: ${eventType}` };
        this.pendingQueueComplete = true;
        break;
      }
    }
  }

  // ============================================================
  // Helpers
  // ============================================================

  /**
   * Extract canonical tool metadata from enriched tool_execution_start events.
   * This is the interceptor-authoritative path emitted by pi-agent-server.
   */
  private extractToolMetadataFromEvent(event: PiEvent): { intent?: string; displayName?: string } | undefined {
    const metadata = (event as {
      toolMetadata?: { intent?: unknown; displayName?: unknown };
    }).toolMetadata;

    if (!metadata) return undefined;

    const intent = typeof metadata.intent === 'string' ? metadata.intent : undefined;
    const displayName = typeof metadata.displayName === 'string' ? metadata.displayName : undefined;

    if (!intent && !displayName) return undefined;
    return { intent, displayName };
  }

  /**
   * Resolve stored metadata by tool call id with fallback variants.
   * Handles mixed id forms like `call_xxx|fc_yyy` by trying the base id.
   */
  private resolveStoredMetadata(toolCallId: string): { meta?: { intent?: string; displayName?: string }; keyTried?: string } {
    const candidates = new Set<string>([toolCallId]);
    if (toolCallId.includes('|')) {
      const [base] = toolCallId.split('|');
      if (base) candidates.add(base);
    }

    for (const candidate of candidates) {
      const meta = toolMetadataStore.get(candidate, this.sessionDir);
      if (meta) return { meta, keyTried: candidate };
    }

    return { meta: undefined, keyTried: Array.from(candidates).join(' -> ') };
  }

  /**
   * Normalize Pi SDK tool input field names to Claude Code format.
   * Pi uses camelCase (oldText, newText, path) while Claude Code uses
   * snake_case (old_string, new_string, file_path). The UI pipeline expects
   * Claude Code format for diff computation, overlay rendering, and
   * document type detection.
   */
  private normalizeToolInput(
    toolName: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    if (toolName === 'Edit') {
      const normalized = { ...args };
      if ('path' in normalized && !('file_path' in normalized)) {
        normalized.file_path = normalized.path;
        delete normalized.path;
      }

      // Pi SDK >= 0.63.2 uses edits[] array instead of top-level oldText/newText.
      // Preserve the full edits[] payload so the renderer can expand and display
      // every replacement block. Also derive the first edit into flat old/new
      // fields as a compatibility bridge for UI paths that still expect them.
      const edits = normalized.edits as Array<{ oldText?: string; newText?: string }> | undefined;
      if (Array.isArray(edits) && edits.length > 0 && edits[0]) {
        const first = edits[0];
        if (first.oldText != null && !('old_string' in normalized)) {
          normalized.old_string = first.oldText;
        }
        if (first.newText != null && !('new_string' in normalized)) {
          normalized.new_string = first.newText;
        }
      }

      // Legacy path: top-level oldText/newText (Pi SDK < 0.63.2 or resumed sessions)
      if ('oldText' in normalized && !('old_string' in normalized)) {
        normalized.old_string = normalized.oldText;
        delete normalized.oldText;
      }
      if ('newText' in normalized && !('new_string' in normalized)) {
        normalized.new_string = normalized.newText;
        delete normalized.newText;
      }
      return normalized;
    }

    if (toolName === 'Write') {
      const normalized = { ...args };
      if ('path' in normalized && !('file_path' in normalized)) {
        normalized.file_path = normalized.path;
        delete normalized.path;
      }
      return normalized;
    }

    if (toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep') {
      const normalized = { ...args };
      if ('path' in normalized && !('file_path' in normalized)) {
        normalized.file_path = normalized.path;
        delete normalized.path;
      }
      return normalized;
    }

    return args;
  }

  private resolveToolIdentity(rawName: string): { toolName: string; identity: PiToolIdentity; wholeToolDenyRefusal?: string } {
    const manifestTool = this.executionManifest?.tools.find(tool => tool.binding.piName === rawName);
    if (this.executionManifest && !manifestTool) {
      return this.resolveUnadvertisedTool(rawName); // F1.756 — still throws unless a whole-tool deny removed it
    }
    const tool = manifestTool ?? this.resolveLegacyTool(rawName);
    if (!tool) return { toolName: rawName, identity: {} };
    return {
      toolName: tool.binding.permissionName,
      identity: {
        semanticId: tool.descriptor.id,
        piName: tool.binding.piName,
        surfaceVersion: tool.binding.surfaceVersion,
        ...(this.executionManifest ? {
          manifestGeneration: this.executionManifest.snapshotGeneration,
          manifestHash: this.executionManifest.manifestHash,
          manifestProvenance: this.executionManifest.provenance.map(value => `${value.capabilityKey}@${value.generation}`),
        } : {}),
      },
    };
  }

  private resolveLegacyTool(rawName: string): ResolvedHarnessTool | undefined {
    const binding = findPiToolBinding(rawName) ?? getPiToolBindingByBindingName(rawName);
    if (!binding) return undefined;
    return {
      binding,
      descriptor: getHarnessToolDescriptor(binding.descriptorId),
      source: { kind: 'piBuiltin', bindingId: binding.bindingName },
    };
  }

  /**
   * Extract text content from a Pi AgentMessage.
   * Pi messages use the pi-ai Message format with content arrays.
   */
  private extractTextFromMessage(message: unknown): string | null {
    if (!message || typeof message !== 'object') return null;

    const msg = message as {
      role?: string;
      content?: string | Array<{ type: string; text?: string }>;
    };

    if (typeof msg.content === 'string') {
      return msg.content || null;
    }

    if (Array.isArray(msg.content)) {
      const textParts = msg.content
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text!);
      return textParts.length > 0 ? textParts.join('') : null;
    }

    return null;
  }

  /**
   * Extract a string result from Pi tool execution result.
   */
  private extractToolResult(result: unknown, isError: boolean): string {
    if (!result) {
      return isError ? 'Tool execution failed' : 'Success';
    }

    if (typeof result === 'string') return result;

    // Pi tool results follow the AgentToolResult shape: { content: [...], details: ... }
    const typed = result as {
      content?: Array<{ type: string; text?: string }>;
      details?: unknown;
    };

    if (Array.isArray(typed.content)) {
      const texts = typed.content
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text!);
      if (texts.length > 0) return texts.join('\n');
    }

    // Fall back to JSON
    try {
      return JSON.stringify(result);
    } catch {
      return String(result);
    }
  }

  /**
   * Get a human-readable display name for a tool.
   */
  private getToolDisplayName(toolName: string): string | undefined {
    switch (toolName) {
      case 'Bash':
        return 'Run Command';
      case 'Read':
        return 'Read File';
      case 'Write':
        return 'Write File';
      case 'Edit':
        return 'Edit File';
      case 'Glob':
      case 'Find':
        return 'Search Files';
      case 'Grep':
        return 'Search Content';
      case 'Ls':
        return 'List Directory';
      default:
        return undefined;
    }
  }

  // ============================================================
  // Auto-retry state machine (F1.235)
  // ============================================================
  //
  // The Pi SDK retries a transient provider/transport error itself
  // (`isRetryableAssistantError`: 429/5xx/overloaded, "fetch failed", …) with
  // the backoff the host configured (`GATEWAY_RETRY_SETTINGS` on the gateway:
  // five attempts, 15 s doubling capped at Pi's 60 s `maxAgentDelayMs`, so
  // 15/30/60/60/60s). Since UB2.15 that agent ladder is the SECOND layer: the
  // provider block (`PI_PROVIDER_RETRY_SETTINGS`) first retries the request
  // itself, sleeping a 429's `retry-after` of 60 s or less, and emits no event
  // this machine sees. A 429 reaches `held` only after that block has spent
  // its retries or refused a longer wait. The ladder's wire order, read from
  // the vendored `pi-coding-agent` 0.84.4 `agent-session.js`: `message_end(error)` →
  // `agent_end { willRetry: true }` (stamped by `_willRetryAfterAgentEnd`) →
  // `auto_retry_start` (from `_prepareRetry`, after the loop returns) → backoff →
  // `agent.continue()`, a fresh `agent_start … agent_end`. Exactly like overflow
  // recovery, the retried run arrives AFTER an `agent_end`, so that `agent_end`
  // must not complete the turn; and the first attempt's error is PARKED instead
  // of shown, so the user sees the retry status and then either the answer or
  // one error at the end. Ported from craft-agents-oss 0.13.4's
  // `PiEventAdapter` (read-only under `.references/`, Apache-2.0): the five
  // states, the transitions and both fallback timers are theirs; what is ours:
  //
  // - `text_discard` arrived with F1.298 (see `discardFailedPartial`): a failed
  //   attempt's partial is dropped at its `message_end`, before the retry status,
  //   so the retried answer — which mints the same sub-turn id, `turn_end` having
  //   reset the counter — streams into a fresh bubble instead of being appended
  //   to the failed one.
  // - No `retry` backoff/active/end events: the P6.916 status (`retryStatusEvent`)
  //   stays the only retry surface, and it now reaches a live turn.
  // - A terminal verdict from our own side on `agent_end` (`terminalReason`) wins
  //   over `willRetry`, releasing a parked error first, as before this change.
  //
  //   none ──message_end(retryable)──► held
  //   held ──agent_end{willRetry:false}──► none         (release error, complete)
  //   held ──agent_end{willRetry:true}───► awaitingRetry (5 s fallback)
  //   awaitingRetry ──auto_retry_start──► backoff       (delayMs + 15 s fallback)
  //   backoff ──agent_start────────────► recovering
  //   recovering ──agent_end───────────► none           (normal complete)
  //   held|awaitingRetry|backoff ──auto_retry_end{success:false}──► none (release, complete)
  //
  // The fallback timers reuse the overflow machine's handlers
  // (`setOverflowFallbackHandlers`): they enqueue the parked error and close the
  // queue, because they fire outside `adaptEvent()`.
  private retryState: 'none' | 'held' | 'awaitingRetry' | 'backoff' | 'recovering' = 'none';
  private heldRetryError: NessyAgentEvent | null = null;
  private retryFallbackTimerId: ReturnType<typeof setTimeout> | null = null;
  /** F1.300 — the next `turn_start` re-makes the failed attempt's call (a retried run's first). */
  private retriedRunReplacesTurn = false;

  /** How long an `agent_end { willRetry: true }` waits for `auto_retry_start`, which `_prepareRetry` emits right after the loop returns. */
  private static readonly RETRY_START_FALLBACK_TIMEOUT_MS = 5_000;
  /** Grace past the backoff `auto_retry_start` announced before the retried run's `agent_start` is given up on. */
  private static readonly RETRY_RUN_GRACE_MS = 15_000;

  /**
   * F1.235 — a turn starts with no retry in flight. An abort mid-backoff latches
   * the old turn's queue and leaves this machine where it was; without this the
   * NEXT turn's `agent_end` would be held, and the stale timer would close it.
   */
  override startTurn(turnId?: string): void {
    this.resetRetryState();
    this.turnUsage = undefined; // F1.1073 — a turn is charged its own model calls only
    super.startTurn(turnId);
  }

  private resetRetryState(): void {
    this.cancelRetryFallbackTimer();
    this.retryState = 'none';
    this.heldRetryError = null;
    this.retriedRunReplacesTurn = false;
  }

  /** Park a failed attempt's error when the SDK's own classifier says it will be retried. */
  private parkRetryableError(message: AssistantMessage, errorEvent: NessyAgentEvent): boolean {
    if (this.retryState !== 'none' && this.retryState !== 'recovering') return false;
    if (!isRetryableAssistantError(message)) return false;
    this.retryState = 'held';
    this.heldRetryError = errorEvent;
    return true;
  }

  /** The `agent_start` after a backoff is the retried run: stop waiting for it. */
  private onRetriedAgentStart(): void {
    if (this.retryState !== 'backoff') return;
    this.cancelRetryFallbackTimer();
    this.retryState = 'recovering';
    this.heldRetryError = null;
    this.retriedRunReplacesTurn = true; // F1.300 — see `consumeRetriedRunTurnStart`
  }

  /**
   * F1.300 (DECIDED by the controller, 2026-09-23) — SDK retries do not count
   * toward `maxAgentTurns`. The cap bounds the AGENT's work, not the provider's
   * failures: the retried run's first `turn_start` re-makes the model call the
   * failed attempt already counted, and before F1.235 that retry was invisible
   * and uncounted. So `PiAgent`'s model-turn counter asks this once per
   * `turn_start` — true for exactly the first one after a retried `agent_start`
   * (driven by the SDK's own `agent_start` after `auto_retry_start`, so it follows
   * the SDK across a lift) and false for every later one: a genuine second model
   * call inside the retried run still counts.
   */
  consumeRetriedRunTurnStart(): boolean {
    const replaces = this.retriedRunReplacesTurn;
    this.retriedRunReplacesTurn = false;
    return replaces;
  }

  /**
   * The retry half of `agent_end`. Returns true when the turn is HELD open (the
   * caller `break`s before completing); may yield the released parked error.
   */
  private *agentEndRetryStep(
    event: { willRetry?: boolean },
    terminalReason: AgentTerminalReason | undefined,
  ): Generator<NessyAgentEvent, boolean> {
    if (terminalReason) {
      yield* this.releaseHeldRetryError();
      return false;
    }
    // F1.235 residue (WJ-pp, found gating F1.297): while the OVERFLOW machine holds
    // the turn (held / awaiting / compacting) this agent_end is its to answer —
    // craft-agents-oss v0.13.4 runs that block FIRST (Apache-2.0), and the SDK never
    // retries an overflow (`_isRetryableError` excludes `isContextOverflow`). Taking
    // a `willRetry: true` here parked the turn in `awaitingRetry` for an
    // `auto_retry_start` that never comes, and the recovered run's agent_end was then
    // held as "unexpected" (pi-auto-compaction-thrashing.test.ts, red since d7bb7b586).
    if (this.overflowState === 'held' || this.overflowState === 'awaiting' || this.overflowState === 'compacting') return false;
    if (event.willRetry === true && this.retryState !== 'awaitingRetry' && this.retryState !== 'backoff') {
      this.retryState = 'awaitingRetry';
      this.armRetryFallbackTimer(
        PiEventAdapter.RETRY_START_FALLBACK_TIMEOUT_MS,
        'no auto_retry_start followed agent_end { willRetry: true }',
      );
      return true;
    }
    // Defensive: no run is active in these states, so an agent_end is unexpected; the timer drains it.
    if (this.retryState === 'awaitingRetry' || this.retryState === 'backoff') return true;
    if (this.retryState === 'held') {
      // Retries disabled or exhausted: surface the parked error, then complete normally.
      yield* this.releaseHeldRetryError();
    } else if (this.retryState === 'recovering') {
      this.retryState = 'none';
    }
    return false;
  }

  private *releaseHeldRetryError(): Generator<NessyAgentEvent> {
    const held = this.heldRetryError;
    this.resetRetryState();
    if (held) yield held;
  }

  /**
   * `auto_retry_start`: the SDK is sleeping `delayMs`, then re-runs the turn.
   * Only a turn this machine is holding moves to `backoff` (ours, not upstream's
   * unconditional move): on the live path an `auto_retry_start` always follows
   * the `agent_end { willRetry: true }` that set `awaitingRetry`, and one met in
   * any other state arms no timer that nothing would ever cancel.
   */
  private onAutoRetryStart(delayMs: number | undefined): void {
    if (this.retryState !== 'held' && this.retryState !== 'awaitingRetry' && this.retryState !== 'backoff') return;
    const delay = typeof delayMs === 'number' && delayMs > 0 ? delayMs : 0;
    this.cancelRetryFallbackTimer();
    this.retryState = 'backoff';
    this.armRetryFallbackTimer(
      delay + PiEventAdapter.RETRY_RUN_GRACE_MS,
      'the retried run did not start after the announced backoff',
    );
  }

  private retryHoldsTurn(): boolean {
    return this.retryState === 'held' || this.retryState === 'awaitingRetry' || this.retryState === 'backoff';
  }

  /**
   * A retry cancelled (or never run) while the turn was held for it: one error,
   * then the turn ends.
   *
   * F1.301 — DEFENSIVE: it has no live producer today. The SDK's cancel signal is
   * `auto_retry_end { finalError: 'Retry cancelled' }`, emitted when `abortRetry()`
   * wakes the backoff sleep, and both host sites that send `abort`
   * (`PiAgent.abort` and `PiAgent.forceAbort`) latch `rawEventAttemptTerminal` in
   * the same synchronous run, so `PiAgent.handleSubprocessEvent` drops that reply
   * before it reaches this adapter. Kept for a producer that cancels a retry
   * without the host's latch.
   */
  private *finishCancelledRetry(finalError: string | undefined): Generator<NessyAgentEvent> {
    const held = this.heldRetryError;
    this.resetRetryState();
    if (held) yield held;
    else if (finalError) yield { type: 'error', message: `Retry failed: ${finalError}` };
    yield { type: 'complete' };
    this.pendingQueueComplete = true;
  }

  private armRetryFallbackTimer(timeoutMs: number, reason: string): void {
    this.cancelRetryFallbackTimer();
    const armedState = this.retryState;
    this.retryFallbackTimerId = setTimeout(() => {
      this.retryFallbackTimerId = null;
      // A late event may already have moved the machine on.
      if (this.retryState !== armedState) return;
      this.log.warn(`Auto-retry fallback fired — ${reason}`, { timeoutMs, state: armedState });
      const held: NessyAgentEvent = this.heldRetryError ?? {
        type: 'error',
        message: 'The model request failed and the automatic retry did not start. Please try again.',
      };
      this.retryState = 'none';
      this.heldRetryError = null;
      this.onFallbackEvent?.(held);
      this.onFallbackComplete?.();
    }, timeoutMs);
  }

  private cancelRetryFallbackTimer(): void {
    if (this.retryFallbackTimerId !== null) {
      clearTimeout(this.retryFallbackTimerId);
      this.retryFallbackTimerId = null;
    }
  }

  // ============================================================
  // Failed-attempt classification (F1.350)
  // ============================================================

  /**
   * Retryable provider errors that `parseError` cannot classify are split into
   * provider-side incidents (`service_error`) and transport failures
   * (`network_error`). The alternatives mirror the provider-side group of
   * pi-ai's own `RETRYABLE_PROVIDER_ERROR_PATTERN` (`@earendil-works/pi-ai`
   * `dist/utils/retry.js`, read at 0.84.4). Ported verbatim from
   * craft-agents-oss v0.13.3 (`PiEventAdapter`, Apache-2.0).
   */
  private static readonly RETRYABLE_PROVIDER_SIDE_PATTERN =
    /overloaded|provider.?returned.?error|retry your request|request again|resource.?exhausted|retry delay|server.?error|internal.?error|service.?unavailable|exceeded request buffer limit/i;

  /**
   * F1.350 — classify a failed assistant message for the UI. Auth / billing /
   * rate-limit / 5xx / 529 / overloaded go through the shared `parseError` (so
   * SessionManager's auth-retry pipeline still sees them). A transient failure
   * `parseError` does not know but the SDK retries — its gate is pi-ai's own
   * `isRetryableAssistantError`, so this follows the SDK across a lift — becomes a
   * typed error whose definition carries Retry, instead of the raw provider text
   * that F1.235's parked-then-released error used to show once the ladder ran out.
   * Anything else stays a raw `error`, as before. Ported from craft-agents-oss
   * v0.13.3's `classifyAssistantError` (Apache-2.0).
   */
  private classifyAssistantError(message: AssistantMessage, errorMessage: string): NessyAgentEvent {
    const parsed = parseError(new Error(errorMessage));
    if (parsed.code !== 'unknown_error') return { type: 'typed_error', error: parsed };
    if (isRetryableAssistantError(message)) {
      const code = PiEventAdapter.RETRYABLE_PROVIDER_SIDE_PATTERN.test(errorMessage) ? 'service_error' : 'network_error';
      return { type: 'typed_error', error: createAgentError(code, errorMessage) };
    }
    return { type: 'error', message: errorMessage };
  }

  /**
   * F1.298 — a failed assistant stream never becomes `text_complete`, so its
   * streamed partial is void: say so before anything else is shown. Both of the
   * SDK's attempts at one call stream into the same sub-turn id (`turn_end` resets
   * the counter), so without this the renderer APPENDED the retried answer to the
   * failed partial ("Partial ansFull answer", the WJ-dd verifier's probe P4) until
   * `text_complete` replaced it. The host cancels that turn's pending delta batch
   * and the renderer removes the still-streaming message; completed messages are
   * never touched. Ported from craft-agents-oss v0.13.4 (`text_discard`,
   * Apache-2.0), including its rule that EVERY failed partial goes — a failure the
   * SDK does not retry too: the transcript never held that text (the host keeps
   * assistant text only on `text_complete`), so a reload already showed it gone.
   * Ours also drops an UNFINISHED reasoning partial, which this adapter streams
   * the same way under its own sub-turn id (upstream streams no reasoning).
   */
  private *discardFailedPartial(): Generator<NessyAgentEvent> {
    if (this.thinkingSubTurnId && this.thinkingBuffer) {
      yield { type: 'text_discard', turnId: this.thinkingSubTurnId };
    }
    this.thinkingSubTurnId = null;
    this.thinkingBuffer = '';
    if (this.messageSubTurnId) {
      yield { type: 'text_discard', turnId: this.messageSubTurnId };
      this.messageSubTurnId = null;
    }
    this.hasStreamedDeltas = false;
  }

  // ============================================================
  // Whole-tool deny (F1.756)
  // ============================================================

  /**
   * The tools a whole-tool deny rule removed from the ACTIVE manifest, each with
   * the refusal naming its rule (`piWholeToolDenyRefusals`,
   * `pi-harness/session-tool-rule-alias.ts`). Set with the manifest, cleared
   * with it.
   */
  private wholeToolDenyRefusals: PiWholeToolDenyRefusals | undefined;

  /**
   * A tool event whose name the active manifest does not advertise. The Pi SDK
   * emits `tool_execution_start` for every call BEFORE it looks the tool up, and
   * answers a name it does not hold with its own "Tool <name> not found". So a
   * model calling a tool a whole-tool deny removed (one it saw before the rule
   * landed, release sitting SIT-j) reached the throw below, and the user got an
   * internal-error row instead of a refusal. A name the deny removed now draws a
   * card whose result names the rule ({@link wholeToolDenyResult}); any other
   * unadvertised name is a fault and still throws, as before.
   *
   * The identity is left empty: the manifest holds no entry for this tool, and
   * the card must not claim one.
   */
  private resolveUnadvertisedTool(rawName: string): { toolName: string; identity: PiToolIdentity; wholeToolDenyRefusal: string } {
    const denied = this.wholeToolDenyRefusals?.get(rawName);
    if (!denied) throw new Error(`Pi tool event is not advertised by the active manifest: ${rawName}`);
    return { toolName: denied.toolName, identity: {}, wholeToolDenyRefusal: denied.refusal };
  }

  /**
   * The result text for a whole-tool-denied call: the rule's refusal, then what
   * the Pi SDK answered the model, so the user can see both why the call did not
   * run and why the model says what it says. Only for an ERROR result; if the
   * SDK somehow ran the tool, its real output is shown unchanged rather than a
   * refusal that would claim the call did not run.
   */
  private wholeToolDenyResult(
    resolved: { wholeToolDenyRefusal?: string } | undefined,
    sdkResult: unknown,
    isError: boolean,
  ): string | undefined {
    if (!resolved?.wholeToolDenyRefusal || !isError) return undefined;
    return `${resolved.wholeToolDenyRefusal} A deny rule that names the whole tool removes it from the session, `
      + `so this call did not run (the Pi runtime answered the model: ${this.extractToolResult(sdkResult, true)}).`;
  }

  // ============================================================
  // Turn usage (F1.1073)
  // ============================================================

  /**
   * One model call's `Usage` into this turn's sum. Output and cost ADD, the way
   * Pi's own `AgentSession.getSessionStats` adds every assistant message's usage
   * (`@earendil-works/pi-coding-agent` 0.85.1, `dist/core/usage-totals.js`
   * `addUsageToTotals`). The input and cache counters are REPLACED: each call
   * re-sends the whole conversation, so the latest call's input is the context
   * the session holds, and that is what the host reads `inputTokens` as (its
   * `complete` case keeps it as the context size and accumulates only output and
   * cost). A cost that is not a finite number adds nothing.
   */
  private addTurnUsage(usage: PiCallUsage): void {
    const cost = typeof usage.cost?.total === 'number' && Number.isFinite(usage.cost.total) ? usage.cost.total : 0;
    const previous = this.turnUsage;
    this.turnUsage = {
      latestInput: usage.input,
      latestCacheRead: usage.cacheRead || 0,
      latestCacheWrite: usage.cacheWrite || 0,
      output: (previous?.output ?? 0) + (usage.output || 0),
      costUsd: (previous?.costUsd ?? 0) + cost,
    };
  }

  /**
   * This turn's usage as a `complete` carries it, and the sum CLEARED, so each
   * model call is reported once: by `agent_end`'s `complete`, or — when a plan or
   * sign-in handoff (F1.628) or a user Stop (F1.1162) latched the turn before its
   * `agent_end` could arrive — by the one `PiAgent` yields at that exit.
   * `undefined` when no call of this turn carried usage.
   */
  takeTurnUsage(): PiTurnCompleteUsage | undefined {
    const turn = this.turnUsage;
    this.turnUsage = undefined;
    if (!turn) return undefined;
    return {
      inputTokens: turn.latestInput + turn.latestCacheRead,
      outputTokens: turn.output,
      cacheReadTokens: turn.latestCacheRead,
      cacheCreationTokens: turn.latestCacheWrite,
      costUsd: turn.costUsd,
      contextWindow: this.contextWindow,
      contextUsage: this.lastContextUsage,
      // pi-ai derives cost from its own pricing table, so a figure is real when
      // it is one. A zero is NOT: it is what the table returns for a model it has
      // no price for, which is every Nessy Gateway model and every local
      // endpoint. We cannot tell that apart from a genuinely free turn, so we
      // decline to call it free.
      costReporting: turn.costUsd > 0 ? 'reported' : 'unsupported',
    };
  }
}

/** F1.1073 — one assistant message's pi-ai `Usage`, as the subprocess forwards it on `message_end`. */
type PiCallUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: { total: number } };

/** F1.1073 — the running sum of a turn's model calls (see `PiEventAdapter.addTurnUsage`). */
type PiTurnUsage = { latestInput: number; latestCacheRead: number; latestCacheWrite: number; output: number; costUsd: number };

type PiTurnCompleteUsage = import('@nessy-agent/core/types').AgentEventUsage;

/** F1.756 — keyed by the tool's `piName`, the name the Pi SDK reports on its tool events. */
type PiWholeToolDenyRefusals = ReadonlyMap<string, import('../../pi-harness/session-tool-rule-alias.ts').PiWholeToolDenyRefusal>;
