import { describe, expect, it } from 'bun:test';
import {
  managedModelPricing,
  managedRatesFor,
  parseManagedModelPricing,
  priceUsageWithManagedTable,
  setManagedModelPricing,
} from '../managed-model-prices.ts';

/**
 * P6.537 — the operator's price table.
 *
 * The example table is `settings-reference.md#modelpricing`'s own, verbatim:
 * a 0.85 multiplier over a per-model override for one model. Using the page's
 * numbers rather than invented ones is the point — the vendored bundle reads
 * this key itself since the lift to `0.3.247` (P7.16), so the fixture is already
 * the shape that bundle parses, whatever seam eventually carries it.
 */
const PAGE_EXAMPLE = {
  multiplier: 0.85,
  overrides: {
    'claude-sonnet-4-6': { input: 2.4, output: 12, cacheRead: 0.24, cacheWrite: 3 },
  },
};

describe('parseManagedModelPricing', () => {
  it('accepts the documented shape', () => {
    const { pricing, rejected } = parseManagedModelPricing(PAGE_EXAMPLE);
    expect(rejected).toEqual([]);
    expect(pricing?.multiplier).toBe(0.85);
    expect(pricing?.overrides?.['claude-sonnet-4-6']?.input).toBe(2.4);
  });

  it('accepts each half alone — "Set `multiplier` alone … `overrides` alone … or both"', () => {
    expect(parseManagedModelPricing({ multiplier: 0.5 }).pricing).toEqual({ multiplier: 0.5 });
    expect(parseManagedModelPricing({ overrides: { m: { input: 1 } } }).pricing)
      .toEqual({ overrides: { m: { input: 1 } } });
  });

  it('drops what it cannot use and SAYS SO, rather than throwing at an administrator', () => {
    const { pricing, rejected } = parseManagedModelPricing({
      multiplier: 'cheap',
      overrides: {
        good: { input: 1 },
        negative: { input: -2 },
        notAnObject: 7,
        emptyAfterRejection: { output: Number.NaN },
      },
    });
    expect(pricing?.overrides && Object.keys(pricing.overrides)).toEqual(['good']);
    expect(rejected.map(r => `${r.path}:${r.reason}`).sort()).toEqual([
      'modelPricing.multiplier:not-a-finite-number',
      'modelPricing.overrides.emptyAfterRejection.output:not-a-finite-number',
      'modelPricing.overrides.negative.input:negative',
      'modelPricing.overrides.notAnObject:not-an-object',
    ]);
  });

  it('negative — nothing deployed means no table at all, never an empty one', () => {
    expect(parseManagedModelPricing(undefined).pricing).toBeUndefined();
    expect(parseManagedModelPricing(null).pricing).toBeUndefined();
    expect(parseManagedModelPricing({}).pricing).toBeUndefined();
    expect(parseManagedModelPricing([1, 2]).pricing).toBeUndefined();
    expect(parseManagedModelPricing('x').rejected[0]?.reason).toBe('not-an-object');
  });
});

describe('priceUsageWithManagedTable', () => {
  const { pricing } = parseManagedModelPricing(PAGE_EXAMPLE);

  it('prices an override from tokens, in dollars per million, times the multiplier', () => {
    // 1M in at 2.4 + 0.5M out at 12 = 8.4, then the documented 15% reduction.
    const cost = priceUsageWithManagedTable(pricing, 'claude-sonnet-4-6', {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
    });
    expect(cost).toBeCloseTo(8.4 * 0.85, 10);
  });

  it('re-bases a runtime figure when the multiplier stands alone — "every figure, the Sonnet row included"', () => {
    expect(priceUsageWithManagedTable(pricing, 'some-other-model', { inputTokens: 10 }, 2))
      .toBeCloseTo(1.7, 10);
  });

  it('negative — an unlisted model with no multiplier stays UNPRICED, never free', () => {
    const { pricing: overridesOnly } = parseManagedModelPricing({ overrides: { a: { input: 1 } } });
    expect(priceUsageWithManagedTable(overridesOnly, 'b', { inputTokens: 1_000_000 }, 5))
      .toBeUndefined();
    expect(priceUsageWithManagedTable(undefined, 'a', { inputTokens: 1_000_000 }, 5))
      .toBeUndefined();
  });

  it('matches the id the provider documents, stripping our own `pi/` routing prefix', () => {
    const { pricing: p } = parseManagedModelPricing({ overrides: { 'qwen3-coder': { input: 1 } } });
    expect(managedRatesFor(p, 'pi/qwen3-coder')?.input).toBe(1);
    // A prefix or family match is deliberately NOT implemented: it would price
    // a model the operator never named.
    expect(managedRatesFor(p, 'qwen3-coder-plus')).toBeUndefined();
  });
});

describe('the process registry', () => {
  it('holds nothing until an operator table is composed at bootstrap', () => {
    expect(managedModelPricing()).toBeUndefined();
    setManagedModelPricing({ multiplier: 2 });
    expect(managedModelPricing()?.multiplier).toBe(2);
    setManagedModelPricing(undefined);
    expect(managedModelPricing()).toBeUndefined();
  });
});
