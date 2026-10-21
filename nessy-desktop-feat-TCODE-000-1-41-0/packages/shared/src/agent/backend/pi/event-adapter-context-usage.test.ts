/**
 * Wire back-compat for `context_usage_update` (R11): a NEW snapshot carries the
 * optional `categories`/`loadedFiles` fields through the adapter unchanged, and
 * a LEGACY snapshot (no category fields) still parses into the same
 * `usage_update` event — the overlay then renders exactly today's totals view.
 * No schema-version bump.
 */
import { describe, expect, it } from 'bun:test';
import { PiEventAdapter } from './event-adapter.ts';

function adapt(usage: Record<string, unknown>) {
  const adapter = new PiEventAdapter();
  adapter.startTurn();
  return [...adapter.adaptEvent({ type: 'context_usage_update', usage } as never)];
}

const legacySnapshot = {
  inputTokens: 1200,
  contextWindow: 200_000,
  contextWindowSource: 'runtime',
  percent: 0.6,
  remainingWindow: 198_800,
  source: 'sdk_usage',
};

describe('PiEventAdapter context_usage_update wire compatibility', () => {
  it('passes a categories-bearing snapshot through unchanged', () => {
    const snapshot = {
      ...legacySnapshot,
      categories: [
        { id: 'system_prompt', tokens: 500 },
        { id: 'custom_subagents', tokens: 40, items: [{ name: 'scout', tokens: 40, source: 'plugin://x@gen' }] },
      ],
      unattributedTokens: 660,
      loadedFiles: [{ name: 'project:AGENTS.md', kind: 'instruction', tokens: 120 }],
    };

    const events = adapt(snapshot);
    expect(events).toHaveLength(1);
    const usage = (events[0] as unknown as { usage: { contextUsage: typeof snapshot } }).usage.contextUsage;
    expect(usage.categories).toEqual(snapshot.categories);
    expect(usage.unattributedTokens).toBe(660);
    expect(usage.loadedFiles).toEqual(snapshot.loadedFiles);
  });

  it('still parses a legacy snapshot with no category fields', () => {
    const events = adapt(legacySnapshot);
    expect(events).toHaveLength(1);
    const usage = (events[0] as unknown as { usage: { contextUsage: Record<string, unknown> } }).usage.contextUsage;
    expect(usage.inputTokens).toBe(1200);
    expect(usage.categories).toBeUndefined();
    expect(usage.loadedFiles).toBeUndefined();
  });
});
