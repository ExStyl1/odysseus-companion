/**
 * P6.446 — the derivable cache readout, and the codex convention trap.
 *
 * The tracker was already "ready" (the row says so): it has carried
 * `getCacheHitRate` and both cache totals since before this row, and nothing
 * printed them. What is added is the WARMTH, the one question a user asks that
 * the counters can answer without a price list — plus a third value,
 * `'unknown'`, so a runtime whose adapter does not report cache counters is
 * not described as running cold.
 *
 * The last case is the trap, transcribed from codex's own source rather than
 * assumed: `input_tokens` there already contains `cached_input_tokens`, so a
 * reader that carries the cache fields across without reducing the input field
 * makes this tracker double-count. It is asserted here as arithmetic on the
 * tracker, which is where the double count would appear.
 */
import { describe, expect, it } from 'bun:test'
import { createUsageTracker } from '../usage-tracker'

describe('P6.446 — warm, cold and honestly unknown', () => {
  it('a turn that read from cache is warm', () => {
    const tracker = createUsageTracker()
    tracker.recordTurnComplete({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheCreationTokens: 0 })
    const perf = tracker.describeCachePerformance()
    expect(perf.warmth).toBe('warm')
    expect(perf.cacheReadTokens).toBe(900)
    expect(perf.hitRate).toBeGreaterThan(0)
  })

  it('a turn that only wrote the cache is cold', () => {
    const tracker = createUsageTracker()
    tracker.recordTurnComplete({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 900 })
    expect(tracker.describeCachePerformance().warmth).toBe('cold')
  })

  it('no cache counter at all is UNKNOWN, not cold', () => {
    // This is the codex arm today: its adapter declares neither cache field, so
    // both totals stay zero. Reporting `cold` there would be a claim about the
    // provider rather than a reading.
    const tracker = createUsageTracker()
    tracker.recordTurnComplete({ inputTokens: 1000, outputTokens: 20 })
    const perf = tracker.describeCachePerformance()
    expect(perf.warmth).toBe('unknown')
    expect(perf.hitRate).toBe(0)
  })

  it('carries no cost field — the fork ships no price table for cache rates', () => {
    const tracker = createUsageTracker()
    tracker.recordTurnComplete({ inputTokens: 10, outputTokens: 1, cacheReadTokens: 5 })
    const keys = Object.keys(tracker.describeCachePerformance())
    // The invariant is the ABSENCE of a price, not a frozen key list: `ttl` is
    // present exactly when the host resolved one, so asserting the whole set
    // would make this test depend on the rig's environment.
    expect(keys.filter(k => /cost|usd|price|dollar/i.test(k))).toEqual([])
    expect(keys).toContain('warmth')
    expect(keys).toContain('hitRate')
  })

  it('the TTL is the one the host resolved, and absent when it resolved none', () => {
    // `FORCE_PROMPT_CACHING_5M` is step 1 of the page's precedence chain, so it
    // needs no config file to be the answer. `delete` before assigning: Bun
    // 1.3.14 leaves an assigned-into pre-created slot invisible to a spread.
    const before = process.env.FORCE_PROMPT_CACHING_5M
    const tracker = createUsageTracker()
    tracker.recordTurnComplete({ inputTokens: 10, outputTokens: 1, cacheReadTokens: 5 })
    try {
      delete process.env.FORCE_PROMPT_CACHING_5M
      process.env.FORCE_PROMPT_CACHING_5M = '1'
      expect(tracker.describeCachePerformance().ttl).toBe('5m')
    } finally {
      delete process.env.FORCE_PROMPT_CACHING_5M
      if (before !== undefined) process.env.FORCE_PROMPT_CACHING_5M = before
    }
  })
})

describe('P6.446 — the codex convention, mapped the way its source defines it', () => {
  /**
   * `codex-rs/protocol/src/protocol.rs`, `rust-v0.150.1`:
   *   pub fn non_cached_input(&self) -> i64 {
   *       (self.input_tokens - self.cached_input()).max(0)
   *   }
   * So `inputTokens` is the WHOLE input including the cached part.
   */
  const codexTurn = { inputTokens: 1000, cachedInputTokens: 700, cacheWriteInputTokens: 100, outputTokens: 50 }

  it('the naive carry-across double-counts, which is why the row warns', () => {
    const naive = createUsageTracker()
    naive.recordMessageUsage({
      inputTokens: codexTurn.inputTokens,
      outputTokens: codexTurn.outputTokens,
      cacheReadTokens: codexTurn.cachedInputTokens,
      cacheCreationTokens: codexTurn.cacheWriteInputTokens,
    })
    // 1000 + 700 + 100 — the cached half counted twice, against codex's own 1000.
    expect(naive.getLastMessageUsage()?.inputTokens).toBe(1800)
  })

  it('subtracting both cache halves leaves the total codex itself reports', () => {
    const correct = createUsageTracker()
    correct.recordMessageUsage({
      inputTokens: codexTurn.inputTokens - codexTurn.cachedInputTokens - codexTurn.cacheWriteInputTokens,
      outputTokens: codexTurn.outputTokens,
      cacheReadTokens: codexTurn.cachedInputTokens,
      cacheCreationTokens: codexTurn.cacheWriteInputTokens,
    })
    expect(correct.getLastMessageUsage()?.inputTokens).toBe(codexTurn.inputTokens)
    expect(correct.getLastMessageUsage()?.cacheReadTokens).toBe(700)
  })

  it('and the pre-fix control reports the same total, so the fix is decomposition not inflation', () => {
    const before = createUsageTracker()
    before.recordMessageUsage({ inputTokens: codexTurn.inputTokens, outputTokens: codexTurn.outputTokens })
    expect(before.getLastMessageUsage()?.inputTokens).toBe(codexTurn.inputTokens)
  })
})
