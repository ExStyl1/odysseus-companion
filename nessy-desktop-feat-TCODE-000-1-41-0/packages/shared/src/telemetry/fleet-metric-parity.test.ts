import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { FLEET_METRIC_PARITY } from './usage-metrics.ts';

/**
 * P6.461 — the fleet sees cost and tokens and none of the six documented
 * adoption metrics, and our two are renamed out of the page's namespace.
 *
 * `monitoring-usage.md#metrics` publishes EIGHT metric names. This pins
 * {@link FLEET_METRIC_PARITY} against two things it could otherwise drift
 * from: the page (totality) and the wire (truthfulness). Without the second the
 * record would be a comment that can lie; without the first a page refresh
 * would widen the gap in silence, which is the failure this row exists to end.
 */
const PAGE_METRICS = [
  'session.count',
  'lines_of_code.count',
  'pull_request.count',
  'commit.count',
  'cost.usage',
  'token.usage',
  'code_edit_tool.decision',
  'active_time.total',
] as const;

const MODULE_SOURCE = fileURLToPath(new URL('./usage-metrics.ts', import.meta.url));

/** The metric names this module actually puts inside its `metrics: [...]` array. */
function wireMetricNames(): string[] {
  const source = readFileSync(MODULE_SOURCE, 'utf8');
  // `scope: { name: 'nessy.usage' }` is the SCOPE, one level up, and must not
  // be counted as a metric — hence the match is anchored to the
  // `nessy.<something>.<something>` shape the metric entries use.
  // P6.461 — TWO spellings, because the payload builder has two shapes: the
  // usage series write `name: 'nessy.…'` inline, and the adoption counters
  // carry theirs as an `emittedAs:` entry in `counterMetrics`' name table,
  // which is what the metric is finally called on the wire. Underscores are in
  // the character class for `active_time.total`; without them that name is
  // invisible to this instrument and the row reads as claiming a series the
  // module does not emit.
  const NAME = String.raw`nessy\.[a-z_]+\.[a-z_]+`;
  return [
    ...[...source.matchAll(new RegExp(String.raw`^\s+name: '(${NAME})',$`, 'gm'))],
    // Anchored on `metric:` so this reads `counterMetrics`' own name table and
    // NOT `FLEET_METRIC_PARITY`'s `emittedAs` column, which would make the
    // comparison circular — every row would prove itself.
    ...[...source.matchAll(new RegExp(String.raw`metric: '[a-z_.]+', emittedAs: '(${NAME})'`, 'g'))],
  ].map(match => match[1]!);
}

describe('P6.461 — fleet metric parity', () => {
  it('is TOTAL over the page: every documented metric has a row, and no row invents one', () => {
    expect([...FLEET_METRIC_PARITY].map(row => row.documented).sort())
      .toEqual([...PAGE_METRICS].sort());
  });

  it('every emitted row names a series this module really puts on the wire', () => {
    const onWire = wireMetricNames();
    // Guard the instrument first: a regex that matched nothing would make the
    // comparison below vacuously true.
    expect(onWire.length).toBeGreaterThan(0);

    const claimed = FLEET_METRIC_PARITY
      .filter(row => row.status === 'emitted')
      .map(row => row.emittedAs);
    expect(claimed.sort()).toEqual([...onWire].sort());
  });

  it('a non-emitted row claims no series, and an emitted row always names one', () => {
    for (const row of FLEET_METRIC_PARITY) {
      if (row.status === 'emitted') expect(row.emittedAs, row.documented).toBeString();
      else expect(row.emittedAs, row.documented).toBeNull();
    }
  });

  it('never re-exports the `claude_code.` namespace the fork renamed away from', () => {
    // The whole reason a dashboard built from the page finds nothing. Writing
    // the prefix here would invite someone to paste it into a query.
    for (const row of FLEET_METRIC_PARITY) {
      expect(row.documented.startsWith('claude_code.'), row.documented).toBe(false);
      expect(row.emittedAs?.startsWith('claude_code.') ?? false, row.documented).toBe(false);
    }
  });

  it('every refused and owed row carries a reason an operator can act on', () => {
    // A blank note would restore the exact ambiguity this record exists to end:
    // "will never happen" and "nobody wrote it yet" are different actions.
    const missing = FLEET_METRIC_PARITY.filter(row => row.status !== 'emitted');
    // `refused` must actually occur, or a table of all-`owed` rows would pass
    // while telling an operator nothing is ever permanently declined.
    expect(missing.some(row => row.status === 'refused')).toBe(true);
    // The mirror clause — that `owed` must also occur — was here until
    // 2026-09-11 and is DELETED rather than inverted. `23a847d22` emitted the
    // last owed counter (`code_edit_tool.decision`), so the clause had become a
    // demand that some metric stay unimplemented, and asserting the opposite
    // (that none is owed) would go red on the first honestly-added owed row.
    // What survives is the property the clause was protecting: every status is
    // one of the three vocabulary values, so a relabel cannot hide as a typo.
    for (const row of FLEET_METRIC_PARITY) {
      expect(['emitted', 'owed', 'refused'], row.documented).toContain(row.status);
    }
    for (const row of missing) {
      expect(row.note.length, row.documented).toBeGreaterThan(40);
    }
  });
});
