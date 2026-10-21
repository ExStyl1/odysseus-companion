/**
 * P3.268 — the context meter's DENOMINATOR comes from the runtime's own
 * accounting instead of being derived from `modelUsage[*].contextWindow`.
 *
 * The two numbers are not the same number. `ModelUsage.contextWindow` is the
 * model's RAW window; `Query.getContextUsage().rawMaxTokens` is, in the SDK's
 * own words, *"The window usage is measured against: the resolved autocompact
 * window — the model's believed limit, or a smaller compaction-policy window (a
 * configured value, or e.g. the 200K boundary on 1M-window models)."*
 *
 * This fork opts 1M-window models in with a `[1m]` model suffix, so the gap is a
 * factor of five on exactly the sessions where the meter matters — a bar reading
 * 20% where the truth is 100%, with no reporter on either side.
 *
 * Four claims, each failing differently:
 *  - the SDK figure is taken and used as the window on both producers;
 *  - it is MODEL-SCOPED, so it cannot survive a switch to another model;
 *  - an unusable payload changes nothing (the shipped derivation still runs);
 *  - a new child clears it, because a window is per-CHILD like the background
 *    task level beside it.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ClaudeEventAdapter, type ClaudeAdapterCallbacks } from '../backend/claude/event-adapter.ts';
import type { AgentEvent } from '@nessy-agent/core/types';

function callbacks(): ClaudeAdapterCallbacks {
  return {
    onDebug: undefined,
    mapSDKError: async () => ({
      type: 'typed_error' as const,
      error: { code: 'unknown_error', title: 't', message: 'm', details: [], actions: [], canRetry: false },
    }),
  } as ClaudeAdapterCallbacks;
}

/** A result whose `modelUsage` reports the model's RAW window. */
function resultFor(model: string, rawWindow: number): any {
  return {
    type: 'result',
    subtype: 'success',
    usage: { input_tokens: 1_000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    total_cost_usd: 0,
    modelUsage: {
      [model]: {
        inputTokens: 1_000, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
        contextWindow: rawWindow,
      },
    },
    session_id: 'sess-1',
  };
}

function completeWindow(events: AgentEvent[]): number | undefined {
  const complete = events.find(event => event.type === 'complete') as
    { usage?: { contextWindow?: number } } | undefined;
  return complete?.usage?.contextWindow;
}

describe('P3.268 — the SDK-reported context window', () => {
  it('replaces the derived window on both producers', async () => {
    const adapter = new ClaudeEventAdapter(callbacks());
    adapter.startTurn();
    // A 1M-window model under a 200K compaction policy: `modelUsage` says
    // 1 000 000, the runtime says it is measuring against 200 000.
    expect(adapter.applySdkContextUsage({ model: 'claude-sonnet-5', rawMaxTokens: 200_000 })).toBe(true);
    // Producer 1 — the cached figure R14's out-of-adapter `usage_update` reads.
    expect(adapter.getReportedContextWindow()).toBe(200_000);
    // Producer 2 — the terminal `complete`.
    const events = await adapter.adapt(resultFor('claude-sonnet-5', 1_000_000));
    expect(completeWindow(events)).toBe(200_000);
    expect(adapter.getReportedContextWindow()).toBe(200_000);
  });

  it('matches across the `[1m]` selector, which is the case it exists for', async () => {
    const adapter = new ClaudeEventAdapter(callbacks());
    adapter.startTurn();
    // `getContextUsage()` reports the main-loop model; `options.model` carried
    // the suffix. Three spellings of one model must resolve to one key or the
    // SDK figure is discarded exactly where it is most needed.
    adapter.applySdkContextUsage({ model: 'claude-sonnet-5[1m]', rawMaxTokens: 200_000 });
    const events = await adapter.adapt(resultFor('claude-sonnet-5', 1_000_000));
    expect(completeWindow(events)).toBe(200_000);
  });

  it('is MODEL-SCOPED — a different model falls back to the derived window', async () => {
    const adapter = new ClaudeEventAdapter(callbacks());
    adapter.startTurn();
    adapter.applySdkContextUsage({ model: 'claude-sonnet-5', rawMaxTokens: 200_000 });
    // A window recorded for one model must never be reported for another; the
    // meter would then be measuring against a limit that is not in force.
    const events = await adapter.adapt(resultFor('tgpt/qwen35-397b-a17b-fp8', 240_000));
    expect(completeWindow(events)).toBe(240_000);
    expect(adapter.getReportedContextWindow()).toBe(240_000);
  });

  it('BOUNDARY — an unusable payload changes nothing', async () => {
    const adapter = new ClaudeEventAdapter(callbacks());
    adapter.startTurn();
    for (const payload of [
      null, undefined, {},
      { model: 'claude-sonnet-5' },
      { rawMaxTokens: 200_000 },
      { model: 'claude-sonnet-5', rawMaxTokens: 0 },
      { model: 'claude-sonnet-5', rawMaxTokens: Number.NaN },
      { model: '', rawMaxTokens: 200_000 },
    ]) {
      expect(adapter.applySdkContextUsage(payload as never)).toBe(false);
    }
    // The shipped derivation is untouched — this is the arm every gateway
    // session takes if `getContextUsage` never answers.
    const events = await adapter.adapt(resultFor('tgpt/qwen35-397b-a17b-fp8', 240_000));
    expect(completeWindow(events)).toBe(240_000);
  });

  it('is per-CHILD — a respawn clears it', async () => {
    const adapter = new ClaudeEventAdapter(callbacks());
    adapter.startTurn();
    adapter.applySdkContextUsage({ model: 'claude-sonnet-5', rawMaxTokens: 200_000 });
    // The adapter outlives every respawn `ensureLiveSession` performs, so a
    // window read off the DEAD child would keep overriding the new one's.
    adapter.clearSdkContextUsage();
    const events = await adapter.adapt(resultFor('claude-sonnet-5', 1_000_000));
    expect(completeWindow(events)).toBe(1_000_000);
  });

  it('is wired to spawn and to the one live setter that can move the window', () => {
    const source = readFileSync(new URL('../claude-agent.ts', import.meta.url), 'utf8');
    // A reader with no caller is the defect class this whole row belongs to.
    expect(source).toContain('this.eventAdapter.clearSdkContextUsage();');
    expect(source).toContain("void this.refreshSdkContextWindow(live, 'spawn');");
    expect(source).toContain("void this.refreshSdkContextWindow(live, 'setModel');");
    expect(source).toContain('this.eventAdapter.applySdkContextUsage(usage)');
  });

  it('THE NATIVE MECHANISM, measured on the shipped typings rather than quoted', () => {
    // `getContextUsage` is a control request minted by the CLI, so the fields
    // live in the typings; the bundle carries the request subtype. Both halves
    // are asserted, with each other as the control.
    const resolved = require.resolve('@anthropic-ai/claude-agent-sdk');
    const bundle = readFileSync(resolved, 'utf8');
    const typings = readFileSync(resolved.replace(/sdk\.mjs$/, 'sdk.d.ts'), 'utf8');
    expect(bundle).toContain('get_context_usage');
    // The method, not its arity: 0.3.267 gave it `opts?: { detail?: 'summary' | 'full' }` (F1.255).
    expect(typings).toMatch(/getContextUsage\((?:opts\?: \{[^}]*\})?\): Promise<SDKControlGetContextUsageResponse>/);
    expect(typings).toContain('rawMaxTokens');
  });
});
