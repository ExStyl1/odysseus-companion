import { describe, expect, it } from 'bun:test';
import type { PersistedModelUsage } from '@nessy-agent/core/types';
import {
  foldModelUsageKeys,
  mergeCostReporting,
  mergeModelUsage,
  resolveCostDisplay,
  toTurnCostReporting,
} from './cost-reporting.ts';

function modelUsage(overrides: Partial<PersistedModelUsage> = {}): PersistedModelUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    webSearchRequests: 0,
    costUsd: 0,
    costReporting: 'reported',
    ...overrides,
  };
}

describe('toTurnCostReporting (P2.239)', () => {
  it('keeps only `reported`, and folds every other value to `unsupported`', () => {
    expect(toTurnCostReporting('reported')).toBe('reported');
    expect(toTurnCostReporting('unsupported')).toBe('unsupported');
    // `partial` is an ACCUMULATION's verdict and cannot describe one turn, so a
    // backend that stamps it on a turn is saying nothing this module can use.
    expect(toTurnCostReporting('partial')).toBe('unsupported');
  });

  it('reads an untrusted wire value without narrowing it first', () => {
    // The reason the parameter is `unknown`: two of the three call sites take
    // this off a wire-shaped object, where the value is only as good as the
    // backend that stamped it. Every one of these used to reach the same
    // hand-written ternary at three different sites.
    for (const value of [undefined, null, '', 'REPORTED', 0, 1, {}, []]) {
      expect(toTurnCostReporting(value)).toBe('unsupported');
    }
  });

  it('composes with mergeCostReporting the way the merge site uses it', () => {
    // The one arm that is not a pure fold: a turn whose verdict disagrees with
    // the accumulation still produces `partial` — the collapse narrows the TURN,
    // never the total.
    expect(mergeCostReporting('reported', toTurnCostReporting('unsupported'))).toBe('partial');
    expect(mergeCostReporting('reported', toTurnCostReporting('reported'))).toBe('reported');
  });
});

describe('mergeCostReporting', () => {
  it('keeps a verdict two turns agree on', () => {
    expect(mergeCostReporting(undefined, 'unsupported')).toBe('unsupported');
    expect(mergeCostReporting('unsupported', 'unsupported')).toBe('unsupported');
    expect(mergeCostReporting('reported', 'reported')).toBe('reported');
  });

  it('becomes partial when turns disagree, and stays partial after', () => {
    expect(mergeCostReporting('reported', 'unsupported')).toBe('partial');
    expect(mergeCostReporting('unsupported', 'reported')).toBe('partial');
    expect(mergeCostReporting('partial', 'reported')).toBe('partial');
    expect(mergeCostReporting('partial', 'unsupported')).toBe('partial');
  });
});

describe('mergeModelUsage', () => {
  it('sums the map per model across turns', () => {
    const first = mergeModelUsage(undefined, {
      'claude-sonnet-4-6': modelUsage({ inputTokens: 10, outputTokens: 2, costUsd: 0.5 }),
      'claude-haiku-4-5': modelUsage({ inputTokens: 4, webSearchRequests: 1 }),
    });
    const second = mergeModelUsage(first, {
      'claude-sonnet-4-6': modelUsage({ inputTokens: 5, outputTokens: 1, costUsd: 0.25 }),
    });

    expect(second?.['claude-sonnet-4-6']).toEqual(modelUsage({
      inputTokens: 15,
      outputTokens: 3,
      costUsd: 0.75,
    }));
    expect(second?.['claude-haiku-4-5']?.webSearchRequests).toBe(1);
  });

  it('never lets a mapless turn erase a map another turn produced', () => {
    const existing = { 'claude-sonnet-4-6': modelUsage({ inputTokens: 10 }) };
    expect(mergeModelUsage(existing, undefined)).toBe(existing);
    expect(mergeModelUsage(existing, {})).toBe(existing);
  });

  it('merges the per-model verdict and rejects non-finite figures', () => {
    const merged = mergeModelUsage(
      { m: modelUsage({ costReporting: 'reported', costUsd: 1 }) },
      { m: modelUsage({ costReporting: 'unsupported', costUsd: Number.NaN, inputTokens: -3 }) },
    );

    expect(merged?.m?.costReporting).toBe('partial');
    expect(merged?.m?.costUsd).toBe(1);
    expect(merged?.m?.inputTokens).toBe(0);
  });

  // F1.1279 — the `[1m]` selector is an adapter detail (owner, F1.1241); the
  // stored breakdown is keyed by the model's own id.
  it('stores a claude model under its bare id, merging the [1m] spelling into it', () => {
    const merged = mergeModelUsage(
      { 'claude-opus-4-8[1m]': modelUsage({ inputTokens: 10, costUsd: 1 }) },
      {
        'claude-opus-4-8': modelUsage({ inputTokens: 5, costUsd: 0.5 }),
        'claude-fable-5-1[1m]': modelUsage({ outputTokens: 7 }),
      },
    );

    expect(Object.keys(merged ?? {}).sort()).toEqual(['claude-fable-5-1', 'claude-opus-4-8']);
    expect(merged?.['claude-opus-4-8']).toEqual(modelUsage({ inputTokens: 15, costUsd: 1.5 }));
    expect(merged?.['claude-fable-5-1']?.outputTokens).toBe(7);
  });

  it('leaves a non-claude id with brackets exactly as written', () => {
    const merged = mergeModelUsage(undefined, {
      'tgpt/qwen3[1m]': modelUsage({ inputTokens: 1 }),
      'Qwen/Qwen3-Coder[beta]': modelUsage({ inputTokens: 2 }),
    });

    expect(Object.keys(merged ?? {}).sort()).toEqual(['Qwen/Qwen3-Coder[beta]', 'tgpt/qwen3[1m]']);
  });
});

describe('foldModelUsageKeys (F1.1279)', () => {
  it('reads an old record with a suffixed key under the bare id, both spellings summed', () => {
    const folded = foldModelUsageKeys({
      'claude-opus-4-8[1m]': modelUsage({ inputTokens: 10, costReporting: 'reported', costUsd: 1 }),
      'claude-opus-4-8': modelUsage({ inputTokens: 4, costReporting: 'unsupported' }),
      'claude-sonnet-4-6': modelUsage({ inputTokens: 3 }),
    });

    expect(folded).toEqual({
      'claude-opus-4-8': modelUsage({ inputTokens: 14, costUsd: 1, costReporting: 'partial' }),
      'claude-sonnet-4-6': modelUsage({ inputTokens: 3 }),
    });
  });
});

describe('resolveCostDisplay', () => {
  it('never resolves an unsupported record to an amount', () => {
    // The defect this whole task exists for: a Nestor/Codex turn persists
    // costUsd: 0, and 0 renders as "$0.00" — free.
    expect(resolveCostDisplay({ costUsd: 0, costReporting: 'unsupported' }))
      .toEqual({ kind: 'unsupported' });
  });

  it('shows a reported amount, including a genuine zero', () => {
    expect(resolveCostDisplay({ costUsd: 1.25, costReporting: 'reported' }))
      .toEqual({ kind: 'amount', costUsd: 1.25, partial: false });
    expect(resolveCostDisplay({ costUsd: 0, costReporting: 'reported' }))
      .toEqual({ kind: 'amount', costUsd: 0, partial: false });
  });

  it('flags a partial total rather than presenting it as complete', () => {
    expect(resolveCostDisplay({ costUsd: 2, costReporting: 'partial' }))
      .toEqual({ kind: 'amount', costUsd: 2, partial: true });
  });

  it('leaves a pre-marker record alone rather than inventing a verdict', () => {
    expect(resolveCostDisplay({ costUsd: 0 })).toEqual({ kind: 'hidden' });
    expect(resolveCostDisplay(undefined)).toEqual({ kind: 'hidden' });
    expect(resolveCostDisplay({ costUsd: 3 }))
      .toEqual({ kind: 'amount', costUsd: 3, partial: false });
  });
});
