/**
 * P6.461 — the two adoption counters this host now emits, measured at the wire.
 *
 * The fleet saw cost and tokens and none of the six documented adoption
 * metrics. `session.count` is the page's OWN verification signal — *"check your
 * backend for the `claude_code.session.count` metric, which Claude Code emits
 * when a session starts"* — so a counter that accumulates but never reaches the
 * payload would leave the exporter unverifiable by the route the page tells an
 * operator to use.
 *
 * Driven through the real exporter with a stub `fetch`, because the subject is
 * what LANDS: an accumulator test would pass with the payload builder never
 * having been taught the metric.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { codeEditLanguage, createUsageMetrics, counterSeriesKey } from './usage-metrics.ts';

interface Metric {
  name: string;
  unit?: string;
  sum?: { dataPoints: Array<{ attributes: Array<{ key: string; value: { stringValue: string } }>; asInt?: string; asDouble?: number }> };
}

const ENV = {
  NESSY_ENABLE_TELEMETRY: '1',
  OTEL_METRICS_EXPORTER: 'otlp',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
};

let posted: string[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  posted = [];
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    if (init?.body) posted.push(init.body);
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
});

afterEach(() => { globalThis.fetch = realFetch; });

/** Every metric in every posted payload, flattened. */
function wireMetrics(): Metric[] {
  return posted.flatMap(body => {
    const payload = JSON.parse(body) as {
      resourceMetrics: Array<{ scopeMetrics: Array<{ metrics: Metric[] }> }>;
    };
    return payload.resourceMetrics.flatMap(rm => rm.scopeMetrics.flatMap(sm => sm.metrics));
  });
}

function metricNamed(name: string): Metric | undefined {
  return wireMetrics().find(metric => metric.name === name);
}

describe('P6.461 · the adoption counters reach the wire', () => {
  it('session.count lands with its documented start_type, and two starts of one kind add', async () => {
    const metrics = createUsageMetrics(ENV)!;
    expect(metrics).toBeDefined();

    metrics.count({ metric: 'session.count', startType: 'fresh' });
    metrics.count({ metric: 'session.count', startType: 'fresh' });
    metrics.count({ metric: 'session.count', startType: 'resume' });
    await metrics.shutdown();

    // Read the metric into a local FIRST, then assert on it (AGENTS.md: a shape
    // asserted with an asymmetric matcher is overwritten by it).
    const session = metricNamed('nessy.session.count');
    expect(session).toBeDefined();
    // `monitoring-usage.md#metrics` gives this metric no unit, so the field is
    // OMITTED rather than written empty: a unit of `""` is still a unit, and a
    // Prometheus renderer would emit a name with a trailing separator.
    expect(session!.unit).toBeUndefined();

    const points = (session!.sum?.dataPoints ?? []).map(point => ({
      startType: point.attributes.find(a => a.key === 'start_type')?.value.stringValue,
      value: point.asInt,
    })).sort((a, b) => (a.startType ?? '').localeCompare(b.startType ?? ''));
    expect(points).toEqual([
      { startType: 'fresh', value: '2' },
      { startType: 'resume', value: '1' },
    ]);
  });

  it('active_time.total lands in SECONDS under its documented type attribute', async () => {
    const metrics = createUsageMetrics(ENV)!;

    metrics.count({ metric: 'active_time.total', type: 'cli', seconds: 1.5 });
    metrics.count({ metric: 'active_time.total', type: 'cli', seconds: 0.25 });
    await metrics.shutdown();

    const active = metricNamed('nessy.active_time.total');
    expect(active).toBeDefined();
    expect(active!.unit).toBe('s');
    const points = active!.sum?.dataPoints ?? [];
    expect(points).toHaveLength(1);
    expect(points[0]!.attributes.find(a => a.key === 'type')?.value.stringValue).toBe('cli');
    // `asDouble`, not `asInt`: a turn shorter than a second is the ordinary
    // case and rounding it to zero would report an idle fleet.
    expect(points[0]!.asDouble).toBeCloseTo(1.75, 6);
  });

  it('a negative or non-finite duration is DROPPED, not clamped, and posts nothing on its own', async () => {
    // NEGATIVE. A clock that went backwards is not zero active time — it is no
    // measurement — and clamping it to zero would put a point on the wire
    // asserting the session was idle.
    const metrics = createUsageMetrics(ENV)!;

    metrics.count({ metric: 'active_time.total', type: 'cli', seconds: -5 });
    metrics.count({ metric: 'active_time.total', type: 'cli', seconds: Number.NaN });
    await metrics.shutdown();

    expect(metricNamed('nessy.active_time.total')).toBeUndefined();
    // …and with nothing else recorded, the exporter posts no payload at all
    // rather than an empty one.
    expect(posted).toEqual([]);
  });

  it('the accumulator key separates the metrics and their attributes', () => {
    expect(counterSeriesKey({ metric: 'session.count', startType: 'fresh' }))
      .not.toBe(counterSeriesKey({ metric: 'session.count', startType: 'resume' }));
    expect(counterSeriesKey({ metric: 'active_time.total', type: 'cli', seconds: 1 }))
      .toBe(counterSeriesKey({ metric: 'active_time.total', type: 'cli', seconds: 99 }));
    // P6.461's third metric declares FOUR attributes, and a key that dropped any
    // one of them would silently add two different decisions into one series.
    const base = {
      metric: 'code_edit_tool.decision' as const,
      toolName: 'Edit', decision: 'accept' as const,
      source: 'user_temporary' as const, language: 'TypeScript',
    };
    for (const differing of [
      { ...base, toolName: 'Write' },
      { ...base, decision: 'reject' as const },
      { ...base, source: 'user_permanent' as const },
      { ...base, language: 'Python' },
    ]) {
      expect(counterSeriesKey(differing)).not.toBe(counterSeriesKey(base));
    }
    // …and the same four values are the same series, or nothing would ever add.
    expect(counterSeriesKey({ ...base })).toBe(counterSeriesKey(base));
  });
});

describe("P6.461 · code_edit_tool.decision, the row's third metric", () => {
  it('lands as an INTEGRAL count under all four documented attributes', async () => {
    const metrics = createUsageMetrics(ENV)!;

    metrics.count({
      metric: 'code_edit_tool.decision',
      toolName: 'Edit', decision: 'accept', source: 'user_temporary', language: 'TypeScript',
    });
    metrics.count({
      metric: 'code_edit_tool.decision',
      toolName: 'Edit', decision: 'accept', source: 'user_temporary', language: 'TypeScript',
    });
    metrics.count({
      metric: 'code_edit_tool.decision',
      toolName: 'Write', decision: 'reject', source: 'user_reject', language: 'unknown',
    });
    await metrics.shutdown();

    const decision = metricNamed('nessy.code_edit_tool.decision');
    expect(decision).toBeDefined();
    // No unit on the page's own table, so the field is omitted — same rule as
    // `session.count` above.
    expect(decision!.unit).toBeUndefined();

    const points = (decision!.sum?.dataPoints ?? []).map(point => ({
      toolName: point.attributes.find(a => a.key === 'tool_name')?.value.stringValue,
      decision: point.attributes.find(a => a.key === 'decision')?.value.stringValue,
      source: point.attributes.find(a => a.key === 'source')?.value.stringValue,
      language: point.attributes.find(a => a.key === 'language')?.value.stringValue,
      value: point.asInt,
    })).sort((a, b) => (a.toolName ?? '').localeCompare(b.toolName ?? ''));
    expect(points).toEqual([
      { toolName: 'Edit', decision: 'accept', source: 'user_temporary', language: 'TypeScript', value: '2' },
      { toolName: 'Write', decision: 'reject', source: 'user_reject', language: 'unknown', value: '1' },
    ]);
  });

  it("names the page's four languages exactly, and says unknown rather than guessing", () => {
    // The four the page spells out, spelled its way.
    expect(codeEditLanguage('/a/b/c.ts')).toBe('TypeScript');
    expect(codeEditLanguage('src/main.py')).toBe('Python');
    expect(codeEditLanguage('C:\\repo\\index.mjs')).toBe('JavaScript');
    expect(codeEditLanguage('README.md')).toBe('Markdown');

    // THE NEGATIVES, and each is a way a naive split gets it wrong.
    // An extension nobody mapped is the page's own `unknown`.
    expect(codeEditLanguage('notes.qqq')).toBe('unknown');
    // A DOTFILE is not an extension: `.gitignore` must not read as `gitignore`
    // and then as some language a future table entry happens to spell.
    expect(codeEditLanguage('.gitignore')).toBe('unknown');
    // A directory carrying a dot must not lend its suffix to an extensionless
    // file — this is why the basename is taken before the last dot is found.
    expect(codeEditLanguage('/repo/v1.2/Makefile')).toBe('unknown');
    // No path at all — a card that carried none is not a language we failed to
    // detect, and `unknown` is the page's word for exactly this cell.
    expect(codeEditLanguage(undefined)).toBe('unknown');
    expect(codeEditLanguage('   ')).toBe('unknown');
  });
});
