import { describe, expect, it } from 'bun:test';
import { buildContextUsageSnapshot } from './context-usage.ts';

function session(overrides: Record<string, unknown> = {}) {
  return {
    model: { id: 'pi/test', contextWindow: 200_000 },
    agent: { state: { model: { contextWindow: 200_000 } } },
    autoCompactionEnabled: true,
    isCompacting: false,
    settingsManager: {
      getCompactionSettings: () => ({ enabled: true, reserveTokens: 16_384 }),
    },
    ...overrides,
  } as any;
}

describe('buildContextUsageSnapshot', () => {
  it('uses SDK context usage with runtime context window and backend threshold', () => {
    const snapshot = buildContextUsageSnapshot(session({
      getContextUsage: () => ({ tokens: 78_000, contextWindow: 200_000, percent: 39 }),
    }));

    expect(snapshot).toMatchObject({
      modelId: 'pi/test',
      inputTokens: 78_000,
      contextWindow: 200_000,
      contextWindowSource: 'runtime',
      percent: 39,
      remainingWindow: 122_000,
      autoCompactionEnabled: true,
      autoCompactionThreshold: 183_616,
      remainingBeforeAutoCompact: 105_616,
      reserveTokens: 16_384,
      isCompacting: false,
      source: 'sdk_usage',
    });
  });

  it('returns unavailable input tokens when SDK usage is not ready', () => {
    const snapshot = buildContextUsageSnapshot(session({
      getContextUsage: () => ({ tokens: null, contextWindow: 200_000, percent: null }),
    }));

    expect(snapshot).toMatchObject({
      inputTokens: null,
      contextWindow: 200_000,
      source: 'unavailable',
      stale: true,
    });
  });

  it('uses estimated after-compact tokens when provided', () => {
    const snapshot = buildContextUsageSnapshot(session({
      getContextUsage: () => ({ tokens: null, contextWindow: 200_000, percent: null }),
    }), {
      tokensBefore: 180_000,
      estimatedTokensAfter: 42_000,
      firstKeptEntryId: 'entry-1',
    });

    expect(snapshot).toMatchObject({
      inputTokens: 42_000,
      source: 'estimated_after_compact',
      lastCompaction: {
        tokensBefore: 180_000,
        estimatedTokensAfter: 42_000,
        firstKeptEntryId: 'entry-1',
      },
    });
  });

  describe('a fabricated window is labelled, never called runtime', () => {
    const usage = { getContextUsage: () => ({ tokens: 70_000, contextWindow: 131_072, percent: 53 }) };

    it('labels a model registered with the fallback window', () => {
      // The id arrives `pi/`-prefixed here and bare in the registry's set, which
      // is exactly the mismatch that would have made this silently never match.
      const snapshot = buildContextUsageSnapshot(
        session(usage), undefined, undefined, new Set(['test']),
      );
      expect(snapshot.contextWindow).toBe(131_072);
      expect(snapshot.contextWindowSource).toBe('fallback');
    });

    it('leaves every other model on runtime', () => {
      expect(buildContextUsageSnapshot(
        session(usage), undefined, undefined, new Set(['some-other-model']),
      ).contextWindowSource).toBe('runtime');

      // No set at all — every non-custom-endpoint caller, unchanged.
      expect(buildContextUsageSnapshot(session(usage)).contextWindowSource).toBe('runtime');
    });

    it('still reports unavailable when there is no window at all', () => {
      // `fallback` must not outrank `unavailable`: a session with no window has
      // nothing to label, fabricated or otherwise.
      const snapshot = buildContextUsageSnapshot(
        session({ model: { id: 'pi/test' }, agent: { state: { model: {} } } }),
        undefined,
        undefined,
        new Set(['test']),
      );
      expect(snapshot.contextWindow).toBeNull();
      expect(snapshot.contextWindowSource).toBe('unavailable');
    });
  });
});
