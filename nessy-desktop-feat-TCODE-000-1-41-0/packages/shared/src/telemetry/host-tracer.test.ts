/**
 * P6.732 — the host span source, measured AT THE WIRE.
 *
 * The subject is what LANDS. An accumulator test would pass with the payload
 * builder never having been taught the shape, which is the failure mode this
 * row exists to close: a traced run needs a span SOURCE, and a source whose
 * spans reach no sink is the same absence with more code.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHostTracer, resolveTraceExportIntervalMs, resolveTraceSinks } from './host-tracer.ts';

interface WireSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{ key: string; value: Record<string, unknown> }>;
  events?: Array<{ name: string }>;
  status: { code: number; message?: string };
}

const ON = {
  NESSY_ENABLE_TELEMETRY: '1',
  OTEL_TRACES_EXPORTER: 'otlp',
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

/** Every span in every posted payload, flattened. */
function wireSpans(): WireSpan[] {
  return posted.flatMap(body => {
    const payload = JSON.parse(body) as {
      resourceSpans: Array<{
        resource: { attributes: Array<{ key: string; value: { stringValue: string } }> };
        scopeSpans: Array<{ spans: WireSpan[] }>;
      }>;
    };
    return payload.resourceSpans.flatMap(rs => rs.scopeSpans.flatMap(ss => ss.spans));
  });
}

describe('P6.732 · the host tracer is off unless the operator turned it on', () => {
  it('needs BOTH the opt-in and a traces exporter this host implements', () => {
    // The row's control, and the reason it is first: with tracing off there is
    // no tracer, so nothing can be emitted and no `traceparent` can be minted
    // for a codex request to carry — the orphan-trace failure this row names.
    expect(createHostTracer({ OTEL_TRACES_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' }))
      .toBeUndefined();
    expect(createHostTracer({ NESSY_ENABLE_TELEMETRY: '1', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' }))
      .toBeUndefined();
    expect(createHostTracer({ ...ON, OTEL_TRACES_EXPORTER: 'none' })).toBeUndefined();
    // An `otlp` selector with nowhere to post is a tracer with no sink, which is
    // not a tracer: a buffer nothing drains would grow for the life of the app.
    expect(createHostTracer({ NESSY_ENABLE_TELEMETRY: '1', OTEL_TRACES_EXPORTER: 'otlp' })).toBeUndefined();
    // The standard opt-out beats the opt-in, as it does for every other signal.
    expect(createHostTracer({ ...ON, DO_NOT_TRACK: '1' })).toBeUndefined();
    // Positive control: the same environment minus the negations DOES build one.
    expect(createHostTracer(ON)).toBeDefined();
  });

  it('the console sink needs no endpoint at all', () => {
    // `console` is first-class (controller decision): it is what an operator
    // with no collector can turn on, and what separates "the exporter is on and
    // nothing arrives" from "the exporter is off".
    expect(createHostTracer({ NESSY_ENABLE_TELEMETRY: '1', OTEL_TRACES_EXPORTER: 'console' })).toBeDefined();
    expect(resolveTraceSinks({ OTEL_TRACES_EXPORTER: 'console' }).map(sink => sink.kind)).toEqual(['console']);
    // An unrecognised value yields no sink, the same answer `none` gives: a name
    // this host cannot read must not be resolved toward exporting.
    expect(resolveTraceSinks({ OTEL_TRACES_EXPORTER: 'jaeger' })).toEqual([]);
  });
});

describe('P6.732 · spans reach the wire', () => {
  it('a host turn span lands with its runtime attribute and an ok status', async () => {
    const tracer = createHostTracer(ON)!;

    tracer.beginTurnSpan('ws:sess', {
      name: 'nessy.session.turn',
      attributes: { 'nessy.runtime': 'codex-runtime' },
    });
    tracer.endTurnSpan('ws:sess');
    await tracer.shutdown();

    // Read the span into a local FIRST, then assert on it (AGENTS.md: a shape
    // asserted with an asymmetric matcher is overwritten by the matcher).
    const spans = wireSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.name).toBe('nessy.session.turn');
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(span.parentSpanId).toBeUndefined();
    expect(span.status.code).toBe(1);
    expect(span.attributes).toEqual([{ key: 'nessy.runtime', value: { stringValue: 'codex-runtime' } }]);
    // The duration is derived from the monotonic clock, so it can be zero on a
    // fast machine but never negative and never before the start.
    expect(BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano)).toBe(true);
  });

  it('a traceparent names the OPEN turn span and nothing once it closed', async () => {
    // This is what codex's per-request `trace` field carries. Absent outside a
    // span on purpose: a `traceparent` naming a trace nothing will export makes
    // a backend show a request whose parent never arrives.
    const tracer = createHostTracer(ON)!;

    expect(tracer.currentTraceparent('ws:sess')).toBeUndefined();
    tracer.beginTurnSpan('ws:sess', { name: 'nessy.session.turn' });
    const traceparent = tracer.currentTraceparent('ws:sess')!;
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    // A DIFFERENT session has nothing open, so the key is load-bearing rather
    // than decorative: without it one session's requests would join another's
    // trace.
    expect(tracer.currentTraceparent('ws:other')).toBeUndefined();

    tracer.endTurnSpan('ws:sess');
    expect(tracer.currentTraceparent('ws:sess')).toBeUndefined();

    await tracer.shutdown();
    const span = wireSpans()[0]!;
    expect(traceparent).toBe(`00-${span.traceId}-${span.spanId}-01`);
  });

  it('nested startSpan children carry the parent trace id and its span as parent', async () => {
    // The vendored contract: `TelemetrySpan extends TelemetryContext`, so a
    // child is started off the span rather than off an ambient stack.
    const tracer = createHostTracer(ON)!;

    await tracer.startSpan({ name: 'pi.harness.turn' }, async parent => {
      parent.setAttributes({ 'pi.turn.index': 3, 'pi.turn.streaming': true });
      parent.addEvent('compaction');
      await parent.startSpan({ name: 'pi.ai.request' }, async () => undefined);
    });
    await tracer.shutdown();

    const spans = wireSpans();
    const root = spans.find(span => span.name === 'pi.harness.turn')!;
    const child = spans.find(span => span.name === 'pi.ai.request')!;
    expect(child.traceId).toBe(root.traceId);
    expect(child.parentSpanId).toBe(root.spanId);
    expect(root.parentSpanId).toBeUndefined();
    expect(root.events?.map(event => event.name)).toEqual(['compaction']);
    // An integer goes out as OTLP/JSON's string-encoded `intValue`, a boolean as
    // `boolValue` — a collector rejects the whole batch on a bad value, not the
    // one attribute.
    expect(root.attributes).toEqual([
      { key: 'pi.turn.index', value: { intValue: '3' } },
      { key: 'pi.turn.streaming', value: { boolValue: true } },
    ]);
  });

  it('a throwing span is an ERROR span carrying only the error name and message', async () => {
    // NEGATIVE. The status must not need `setStatus` to be right, and the
    // message must never carry a stack — a stack can carry a filesystem path,
    // which this stream is not allowed to export.
    const tracer = createHostTracer(ON)!;

    await expect(tracer.startSpan({ name: 'pi.harness.tool' }, async () => {
      throw new Error('tool blew up');
    })).rejects.toThrow('tool blew up');
    await tracer.shutdown();

    const span = wireSpans()[0]!;
    expect(span.status.code).toBe(2);
    expect(span.status.message).toBe('Error: tool blew up');
    expect(span.status.message).not.toContain('/');
  });

  it('a second begin on one key closes the first rather than leaking it', async () => {
    // NEGATIVE/BOUNDARY. A turn boundary the host missed must not leave a span
    // that never ends: a backend shows that trace as running for ever.
    const tracer = createHostTracer(ON)!;

    tracer.beginTurnSpan('ws:sess', { name: 'nessy.session.turn' });
    tracer.beginTurnSpan('ws:sess', { name: 'nessy.session.turn' });
    // An end with nothing open is a no-op, so a reconstructed processing state
    // cannot export a span that was never opened.
    tracer.endTurnSpan('ws:never-opened');
    await tracer.shutdown();

    // Two spans: the one the second `begin` closed, and the one `shutdown`
    // closed. Neither is missing and neither is duplicated.
    expect(wireSpans()).toHaveLength(2);
  });

  it('posts nothing at all when no span was ever opened', async () => {
    const tracer = createHostTracer(ON)!;
    await tracer.shutdown();
    expect(posted).toEqual([]);
  });
});

/**
 * C3.195 (QM1 = A, owner 2026-09-11) — M41 read `covered` on the premise that
 * nothing here batches. A span stream does, so this re-checks the two things a
 * batch has: an interval, and what happens to the last one at exit.
 */
describe('C3.195 · the span stream exports on the interval the page gives it', () => {
  it('reads OTEL_TRACES_EXPORT_INTERVAL, and defaults to the documented 5000ms', () => {
    // monitoring-usage.md#traces-beta: "`OTEL_TRACES_EXPORT_INTERVAL` | Span
    // batch export interval in milliseconds (default: 5000)".
    expect(resolveTraceExportIntervalMs({ OTEL_TRACES_EXPORT_INTERVAL: '1000' })).toBe(1000);
    expect(resolveTraceExportIntervalMs({})).toBe(5000);
    // The NEGATIVE control, and the defect this row found: the metrics key used
    // to be what governed this stream, with a 60000ms default — twelve times the
    // documented one — so an operator setting the documented key changed nothing
    // and an operator tuning metrics silently retuned traces.
    expect(resolveTraceExportIntervalMs({ OTEL_METRIC_EXPORT_INTERVAL: '250' })).toBe(5000);
    // A value that is not a positive number falls back rather than disabling the
    // timer, the same rule the metrics parser applies.
    expect(resolveTraceExportIntervalMs({ OTEL_TRACES_EXPORT_INTERVAL: '0' })).toBe(5000);
    expect(resolveTraceExportIntervalMs({ OTEL_TRACES_EXPORT_INTERVAL: 'soon' })).toBe(5000);
  });

  it('drains the last batch at shutdown rather than losing it to the interval', async () => {
    // The half of M41's premise that HOLDS, pinned rather than assumed: with a
    // long interval nothing can have been exported by the timer, so whatever
    // lands was drained by `shutdown` itself.
    const tracer = createHostTracer({ ...ON, OTEL_TRACES_EXPORT_INTERVAL: '600000' })!;

    tracer.beginTurnSpan('ws:sess', { name: 'nessy.session.turn' });
    expect(posted).toEqual([]);
    await tracer.shutdown();

    expect(wireSpans()).toHaveLength(1);
  });
});

describe('P6.882 · what a re-arm does to a span that is open', () => {
  it('closeOpenTurnSpans ends every open turn, stamped, and exports it', async () => {
    const tracer = createHostTracer(ON)!;
    tracer.beginTurnSpan('ws:a', { name: 'nessy.session.turn', attributes: { 'nessy.runtime': 'codex-runtime' } });
    tracer.beginTurnSpan('ws:b', { name: 'nessy.session.turn' });

    // What `RearmingHostTracer.replace` calls on the OUTGOING delegate.
    tracer.closeOpenTurnSpans({ 'nessy.telemetry.rearmed': true });
    await tracer.flush();

    const spans = wireSpans();
    expect(spans).toHaveLength(2);
    for (const span of spans) {
      const attributes = Object.fromEntries(span.attributes.map(entry => [entry.key, entry.value]));
      // The attribute is what tells a reader the duration is a FRAGMENT of a
      // turn rather than the turn: without it the span is indistinguishable
      // from one that ended because the turn did.
      expect(attributes['nessy.telemetry.rearmed']).toEqual({ boolValue: true });
      // Ended `ok`, deliberately: an administrator changing an endpoint is not
      // a failed turn, and an error status here would page someone.
      expect(span.status.code).toBe(1);
    }
    // The turn's own attribute survives the stamp rather than being replaced.
    const runtimes = spans.flatMap(span => span.attributes.filter(entry => entry.key === 'nessy.runtime'));
    expect(runtimes).toHaveLength(1);

    // …and the tracer now holds nothing: a later end is the documented no-op,
    // so the span cannot be exported twice.
    posted = [];
    tracer.endTurnSpan('ws:a');
    await tracer.shutdown();
    expect(posted).toEqual([]);
  });

  it('NEGATIVE: with no turn open it exports nothing and stamps nothing', async () => {
    const tracer = createHostTracer(ON)!;
    // The common case by far — a delivery arrives between turns. A re-arm must
    // not manufacture a span to carry its own marker.
    tracer.closeOpenTurnSpans({ 'nessy.telemetry.rearmed': true });
    await tracer.flush();
    expect(posted).toEqual([]);
    await tracer.shutdown();
  });
});
