/**
 * UsageTracker
 *
 * Tracks token usage and context window consumption for agent sessions.
 * Provides accurate per-message tracking (not cumulative billing totals)
 * for real-time context window display.
 *
 * Used by both ClaudeAgent and PiAgent to:
 * - Track input/output tokens per message
 * - Calculate cache hit/miss rates
 * - Emit usage_update events for UI display
 * - Track cumulative session usage (for billing display)
 */

import { describeCacheUsage, type CacheUsageSnapshot } from '@nessy-agent/core/types';

import { resolvePromptCacheTtl } from '../../interceptor-common.ts';

// ============================================================
// Types
// ============================================================

/**
 * Token usage for a single message.
 */
export interface MessageUsage {
  /** Total input tokens (includes cache tokens) */
  inputTokens: number;

  /** Output tokens generated */
  outputTokens: number;

  /** Tokens read from cache */
  cacheReadTokens: number;

  /** Tokens written to cache */
  cacheCreationTokens: number;

  /** Timestamp of this usage record */
  timestamp: number;
}

/**
 * Cumulative session usage (for billing/totals).
 */
export interface SessionUsage {
  /** Total input tokens across all messages */
  totalInputTokens: number;

  /** Total output tokens across all messages */
  totalOutputTokens: number;

  /** Total cache read tokens */
  totalCacheReadTokens: number;

  /** Total cache creation tokens */
  totalCacheCreationTokens: number;

  /** Number of messages/turns */
  messageCount: number;

  /** Session start timestamp */
  startedAt: number;
}

/**
 * Usage update event data (for UI display).
 */
export interface UsageUpdate {
  /** Current context size (input tokens for last message) */
  inputTokens: number;

  /** Context window size (model's maximum) */
  contextWindow?: number;

  /** Cache hit rate (0-1) */
  cacheHitRate?: number;
}

/**
 * P6.446 — what a `/usage` readout can honestly say about the cache.
 *
 * `warmth` has three values and the third is not a placeholder: `'unknown'`
 * means no cache counter has been non-zero on this session, which on a runtime
 * whose adapter does not yet report them is the truth, while `'cold'` would be
 * a claim about the provider.
 *
 * P6.616 — now an ALIAS of the wire type rather than a second declaration of
 * the same five fields. The renderer had no way to see this shape, so the
 * shape moved to `@nessy-agent/core/types` and this name follows it: one
 * declaration, and a field added on one side cannot go missing on the other.
 */
export type CachePerformance = CacheUsageSnapshot;

/**
 * P6.616 — re-exported so a reader of this file finds the rule beside the
 * tracker that uses it. The function itself lives in `@nessy-agent/core/types`
 * because the RENDERER needs it too, and this module imports `node:fs`
 * transitively (`interceptor-common.ts` → `config/paths.ts`), which the
 * renderer cannot load.
 */
export { describeCacheUsage };

/**
 * Configuration for UsageTracker.
 */
export interface UsageTrackerConfig {
  /** Context window size for the model being used */
  contextWindow?: number;

  /** Callback when usage is updated */
  onUsageUpdate?: (update: UsageUpdate) => void;

  /** Debug callback */
  onDebug?: (message: string) => void;
}

// ============================================================
// UsageTracker Class
// ============================================================

/**
 * Tracks token usage for an agent session.
 *
 * Provides:
 * - Per-message usage tracking (for accurate context window display)
 * - Cumulative session usage (for billing totals)
 * - Cache efficiency metrics
 * - Real-time usage update events
 */
export class UsageTracker {
  private config: UsageTrackerConfig;
  private sessionUsage: SessionUsage;
  private lastMessageUsage: MessageUsage | null = null;
  private cachedContextWindow?: number;

  constructor(config: UsageTrackerConfig = {}) {
    this.config = config;
    this.cachedContextWindow = config.contextWindow;
    this.sessionUsage = {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      messageCount: 0,
      startedAt: Date.now(),
    };
  }

  /**
   * Record usage from an assistant message.
   * This is called during message processing to track real-time usage.
   */
  recordMessageUsage(usage: {
    inputTokens: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  }): void {
    const now = Date.now();

    // Calculate total input including cache
    const cacheRead = usage.cacheReadTokens ?? 0;
    const cacheCreation = usage.cacheCreationTokens ?? 0;
    const totalInput = usage.inputTokens + cacheRead + cacheCreation;

    // Update last message usage (for per-message display)
    this.lastMessageUsage = {
      inputTokens: totalInput,
      outputTokens: usage.outputTokens ?? 0,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheCreation,
      timestamp: now,
    };

    this.debug(`Message usage: ${totalInput} input, ${usage.outputTokens ?? 0} output, ${cacheRead} cache read`);

    // Emit usage update
    this.emitUsageUpdate();
  }

  /**
   * Record final usage when a turn completes.
   * Updates cumulative session totals.
   */
  recordTurnComplete(usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  }): void {
    // Use provided usage or last tracked message usage
    const finalUsage = usage ?? this.lastMessageUsage;

    if (finalUsage) {
      this.sessionUsage.totalInputTokens += finalUsage.inputTokens;
      this.sessionUsage.totalOutputTokens += finalUsage.outputTokens;
      this.sessionUsage.totalCacheReadTokens += finalUsage.cacheReadTokens ?? 0;
      this.sessionUsage.totalCacheCreationTokens += finalUsage.cacheCreationTokens ?? 0;
      this.sessionUsage.messageCount++;
    }

    this.debug(`Turn complete: ${this.sessionUsage.messageCount} messages, ${this.sessionUsage.totalInputTokens} total input`);
  }

  /**
   * Set/update the context window size.
   * This can be updated dynamically as model info becomes available.
   */
  setContextWindow(contextWindow: number): void {
    this.cachedContextWindow = contextWindow;
    this.debug(`Context window set: ${contextWindow}`);
  }

  /**
   * Get the current context window size.
   */
  getContextWindow(): number | undefined {
    return this.cachedContextWindow;
  }

  /**
   * Get the last message's usage (for per-message display).
   */
  getLastMessageUsage(): MessageUsage | null {
    return this.lastMessageUsage ? { ...this.lastMessageUsage } : null;
  }

  /**
   * Get cumulative session usage (for billing/totals).
   */
  getSessionUsage(): SessionUsage {
    return { ...this.sessionUsage };
  }

  /**
   * Get the current input tokens (from last message).
   * This represents the actual context size sent to the API.
   */
  getCurrentInputTokens(): number {
    return this.lastMessageUsage?.inputTokens ?? 0;
  }

  /**
   * Calculate cache hit rate (0-1).
   * Higher is better - more tokens served from cache.
   */
  getCacheHitRate(): number {
    const total = this.sessionUsage.totalInputTokens;
    if (total === 0) return 0;

    const cacheRead = this.sessionUsage.totalCacheReadTokens;
    return cacheRead / total;
  }

  /**
   * P6.446 — the derivable half of "is caching working", with no USD figure.
   *
   * `getCacheHitRate` has existed and nothing printed it. What was missing is
   * the WARMTH — whether this session is reading a cache at all — which is the
   * one question a user asks and the counters can answer without a price list.
   *
   * Deliberately no cost field. The two shipped comments recording "no honest
   * value" for the five COST fields stay true: a cache-write is billed at a
   * different rate from a cache-read on every provider, this fork ships no
   * price table, and inventing one would produce a confidently wrong number.
   * `ttl` is the resolved prompt-cache TTL when the host resolved one
   * (`interceptor-common.ts:resolvePromptCacheTtl`) and is otherwise absent —
   * absent means "the runtime's own default", never a guess.
   *
   * ## The codex arm, and the trap it must clear FIRST
   *
   * This readout is only true if every runtime's counters mean the same thing,
   * and codex's do NOT arrive in the Anthropic convention. Read from
   * `github.com/openai/codex` at `rust-v0.148.0`,
   * `codex-rs/protocol/src/protocol.rs`, `impl TokenUsage`:
   *
   *     pub fn non_cached_input(&self) -> i64 {
   *         (self.input_tokens - self.cached_input()).max(0)
   *     }
   *
   * So codex's `inputTokens` ALREADY CONTAINS `cachedInputTokens` — codex
   * subtracts to get the fresh part, and `blended_total()` bills
   * `non_cached_input + output`. This tracker uses the Anthropic convention,
   * where `recordMessageUsage` computes
   * `totalInput = inputTokens + cacheRead + cacheCreation`. Assigning codex's
   * cache fields WITHOUT also reducing `inputTokens` therefore double-counts
   * the cached half — exactly the failure the row warned about. The correct
   * mapping, which leaves the total identical to today's, is
   * `inputTokens - cachedInputTokens - cacheWriteInputTokens` for the input
   * field, with the two cache fields carried across as they are. That belongs
   * in `agent/backend/codex/event-adapter.ts`, which another lane holds this
   * wave; until it lands, a codex session reports `warmth: 'unknown'` here
   * rather than a false `'cold'`.
   */
  describeCachePerformance(): CachePerformance {
    // The TTL is the host's own resolution (P6.378), not a reading off the
    // wire: `undefined` means the host resolved none and the runtime's default
    // applies. Assigned rather than declared-and-never-written — a field that
    // only a type knows about is the defect this plan keeps finding.
    //
    // P6.616 — the arithmetic itself is `describeCacheUsage`, so the session
    // layer's per-turn breakdown and this session-total one cannot state two
    // different rules. `totalInputTokens` already includes both cache halves
    // (`recordMessageUsage` sums them into `lastMessageUsage.inputTokens`),
    // which is the denominator that function requires.
    return describeCacheUsage(
      {
        totalInputTokens: this.sessionUsage.totalInputTokens,
        cacheReadTokens: this.sessionUsage.totalCacheReadTokens,
        cacheCreationTokens: this.sessionUsage.totalCacheCreationTokens,
      },
      resolvePromptCacheTtl('conversation'),
    );
  }

  /**
   * Get context usage as a percentage (0-100).
   * Returns undefined if context window is not set.
   */
  getContextUsagePercent(): number | undefined {
    if (!this.cachedContextWindow || !this.lastMessageUsage) {
      return undefined;
    }

    return (this.lastMessageUsage.inputTokens / this.cachedContextWindow) * 100;
  }

  /**
   * Check if context is getting full (> 80% used).
   */
  isContextFilling(): boolean {
    const percent = this.getContextUsagePercent();
    return percent !== undefined && percent > 80;
  }

  /**
   * Check if context is critically full (> 95% used).
   */
  isContextCritical(): boolean {
    const percent = this.getContextUsagePercent();
    return percent !== undefined && percent > 95;
  }

  /**
   * Reset all tracking (for new session).
   */
  reset(): void {
    this.sessionUsage = {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      messageCount: 0,
      startedAt: Date.now(),
    };
    this.lastMessageUsage = null;
    this.debug('Usage tracker reset');
  }

  /**
   * Build a UsageUpdate object for emitting events.
   */
  buildUsageUpdate(): UsageUpdate {
    return {
      inputTokens: this.getCurrentInputTokens(),
      contextWindow: this.cachedContextWindow,
      cacheHitRate: this.getCacheHitRate(),
    };
  }

  private emitUsageUpdate(): void {
    this.config.onUsageUpdate?.(this.buildUsageUpdate());
  }

  /**
   * P2.333 — belted, because `onDebug` is a HOST-supplied callback this class
   * does not own and every caller of this method is on a path where a log line
   * is the least important thing happening.
   *
   * The measurement that forced it: `reset()` is called by `BaseAgent.destroy()`,
   * and a throwing host sink propagated synchronously out of teardown, skipping
   * every remaining step (the elicitation release, the private MCP pool
   * disconnect) — a broken logger silently became a connection leak. The base
   * class now also isolates each teardown step, but that fix alone would leave
   * the other three callers here unprotected, and they are worse: `recordMessageUsage`
   * and `recordTurnComplete` run on the per-message hot path, so the same sink
   * would take down message accounting rather than only teardown.
   *
   * Swallowing is right rather than merely convenient: the only thing lost is a
   * diagnostic line, and the only channel available to report the loss is the
   * channel that just failed.
   */
  private debug(message: string): void {
    try {
      this.config.onDebug?.(`[UsageTracker] ${message}`);
    } catch {
      // A broken host log sink must not become the failure it was called to report.
    }
  }
}

/**
 * Create a new UsageTracker.
 */
export function createUsageTracker(config?: UsageTrackerConfig): UsageTracker {
  return new UsageTracker(config);
}
