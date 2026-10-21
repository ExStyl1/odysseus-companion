import { afterEach, describe, expect, it } from 'bun:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  collectSeries,
  createUsageMetrics,
  resolveMetricsExporters,
  setOtlpExportDiagnosticSink,
} from './usage-metrics.ts';

/**
 * The collector is a loopback `node:http` server on an ephemeral port. Nothing
 * here may point at a real collector, and nothing here talks to a gateway.
 */
interface Collector {
  endpoint: string;
  requests: Array<{ path: string; body: string }>;
  waitFor(count: number, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

async function collector(): Promise<Collector> {
  const requests: Array<{ path: string; body: string }> = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push({ path: request.url ?? '', body });
      response.writeHead(200).end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    requests,
    async waitFor(count, timeoutMs = 2_000) {
      const deadline = Date.now() + timeoutMs;
      while (requests.length < count) {
        if (Date.now() > deadline) throw new Error(`collector saw ${requests.length} of ${count} exports`);
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    },
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

interface DataPoint {
  attributes: Array<{ key: string; value: { stringValue: string } }>;
  asInt?: string;
  asDouble?: number;
}

function metrics(body: string): Array<{ name: string; unit: string; sum: { aggregationTemporality: number; dataPoints: DataPoint[] } }> {
  return JSON.parse(body).resourceMetrics[0].scopeMetrics[0].metrics;
}

function metric(body: string, name: string) {
  return metrics(body).find(entry => entry.name === name);
}

function attributes(point: DataPoint): Record<string, string> {
  return Object.fromEntries(point.attributes.map(entry => [entry.key, entry.value.stringValue]));
}

const collectors: Collector[] = [];

afterEach(async () => {
  for (const open of collectors.splice(0)) await open.close();
});

async function metricsFor(env: Record<string, string>) {
  const sink = await collector();
  collectors.push(sink);
  const exporter = createUsageMetrics({
    NESSY_ENABLE_TELEMETRY: '1',
    OTEL_EXPORTER_OTLP_ENDPOINT: sink.endpoint,
    ...env,
  });
  if (!exporter) throw new Error('exporter not created');
  return { sink, exporter };
}

describe('the documented opt-in and disable', () => {
  it('makes zero export attempts off an ambient endpoint alone', async () => {
    // OTEL_EXPORTER_OTLP_ENDPOINT is ambient in many corporate shells, set for
    // other tools. Without the opt-in nothing is constructed that could post —
    // asserted at the transport seam: the collector stays silent even across a
    // would-be export interval.
    const sink = await collector();
    collectors.push(sink);
    const exporter = createUsageMetrics({
      OTEL_EXPORTER_OTLP_ENDPOINT: sink.endpoint,
      OTEL_METRIC_EXPORT_INTERVAL: '10',
    });
    expect(exporter).toBeUndefined();
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(sink.requests).toHaveLength(0);
  });

  it('accepts either opt-in spelling, and the Nessy name wins when both are set', () => {
    const endpoint = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' };
    expect(createUsageMetrics({ NESSY_ENABLE_TELEMETRY: '1', ...endpoint })).toBeDefined();
    // The documented Claude spelling is a compat alias (monitoring-usage.md:94).
    expect(createUsageMetrics({ CLAUDE_CODE_ENABLE_TELEMETRY: '1', ...endpoint })).toBeDefined();
    expect(createUsageMetrics({ NESSY_ENABLE_TELEMETRY: 'true', ...endpoint })).toBeDefined();
    // A falsy value is not an opt-in, and the Nessy name wins over the alias.
    expect(createUsageMetrics({ NESSY_ENABLE_TELEMETRY: '0', ...endpoint })).toBeUndefined();
    expect(createUsageMetrics({ NESSY_ENABLE_TELEMETRY: '0', CLAUDE_CODE_ENABLE_TELEMETRY: '1', ...endpoint })).toBeUndefined();
  });

  it('honors the standard opt-out over the opt-in, asserted at the transport', async () => {
    // `env-vars.md#variables`, `DO_NOT_TRACK`: "Set to `1` to opt out of
    // telemetry, with the same effect as `DISABLE_TELEMETRY` … honors it as the
    // cross-tool convention recognized by many developer CLIs."
    //
    // This exporter is NOT provider-gated — `SessionManager.recordUsageMetrics`
    // rides the backend name as an attribute — so this one gate covers Pi,
    // anthropic and codex turns alike.
    const sink = await collector();
    collectors.push(sink);
    const enabled = {
      NESSY_ENABLE_TELEMETRY: '1',
      OTEL_EXPORTER_OTLP_ENDPOINT: sink.endpoint,
      OTEL_METRIC_EXPORT_INTERVAL: '10',
    };
    // Positive control on the same rig: without the opt-out this environment
    // really does post, so a silent collector below is the opt-out working.
    const control = createUsageMetrics(enabled);
    expect(control).toBeDefined();
    control!.record({ backend: 'pi', model: 'control', inputTokens: 1, costReporting: 'unsupported' });
    await control!.shutdown();
    await sink.waitFor(1);

    for (const optOut of [
      { DO_NOT_TRACK: '1' },
      { DO_NOT_TRACK: 'On' },
      { DISABLE_TELEMETRY: '1' },
      { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    ]) {
      expect(createUsageMetrics({ ...enabled, ...optOut })).toBeUndefined();
    }
    // Nothing beyond the control's single export ever reached the collector,
    // even across a would-be export interval.
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(sink.requests).toHaveLength(1);
  });

  it('reads DO_NOT_TRACK as a boolean and DISABLE_TELEMETRY as set-at-all', () => {
    const enabled = {
      NESSY_ENABLE_TELEMETRY: '1',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
    };
    // "Claude Code reads this variable as a standard boolean, so `0` leaves
    // telemetry on".
    expect(createUsageMetrics({ ...enabled, DO_NOT_TRACK: '0' })).toBeDefined();
    expect(createUsageMetrics({ ...enabled, DO_NOT_TRACK: 'false' })).toBeDefined();
    // "**Setting it to `0` or `false` still opts out**, unlike most on/off
    // variables; unset the variable to turn telemetry back on." The two rules
    // are different and one predicate for both would get these wrong.
    expect(createUsageMetrics({ ...enabled, DISABLE_TELEMETRY: '0' })).toBeUndefined();
    expect(createUsageMetrics({ ...enabled, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: 'false' })).toBeUndefined();
    // An empty value is "unset" for the set-at-all rule.
    expect(createUsageMetrics({ ...enabled, DISABLE_TELEMETRY: '' })).toBeDefined();
  });

  it('honors OTEL_METRICS_EXPORTER none as a hard disable even with the opt-in set', () => {
    const enabled = {
      NESSY_ENABLE_TELEMETRY: '1',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
    };
    // monitoring-usage.md:95 — comma-separated exporter types, "Use `none` to disable".
    for (const value of ['none', 'otlp,none', ' None ']) {
      expect(createUsageMetrics({ ...enabled, OTEL_METRICS_EXPORTER: value })).toBeUndefined();
    }
    expect(createUsageMetrics({ ...enabled, OTEL_METRICS_EXPORTER: 'otlp' })).toBeDefined();
  });
});

/**
 * P6.524 — the selector's other three values. Before this row the predicate
 * read the variable as a hard disable and nothing else, so `console` did
 * nothing and `prometheus` — a value the page lists — meant silence.
 */
describe('OTEL_METRICS_EXPORTER, the values that are not `none`', () => {
  const warnings: string[] = [];
  let restoreWarn: (() => void) | undefined;
  let restoreLog: (() => void) | undefined;
  const logs: string[] = [];

  function captureConsole(): void {
    const warn = console.warn;
    const log = console.log;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    restoreWarn = () => { console.warn = warn; };
    restoreLog = () => { console.log = log; };
  }

  afterEach(() => {
    restoreWarn?.();
    restoreLog?.();
    restoreWarn = undefined;
    restoreLog = undefined;
    warnings.length = 0;
    logs.length = 0;
    // The refusal is announced once per process, through the same dedupe the
    // export failures use — clear it so each test sees its own line.
    setOtlpExportDiagnosticSink(undefined);
  });

  it('resolves the documented values, and `none` still beats everything', () => {
    // monitoring-usage.md#common-configuration-variables — "Metrics exporter
    // types, comma-separated. Use `none` to disable"; values `console`, `otlp`,
    // `prometheus`, `none`.
    expect(resolveMetricsExporters({})).toMatchObject({ disabled: false, otlp: true, console: false });
    expect(resolveMetricsExporters({ OTEL_METRICS_EXPORTER: 'console' }))
      .toMatchObject({ disabled: false, otlp: false, console: true });
    expect(resolveMetricsExporters({ OTEL_METRICS_EXPORTER: 'console,otlp' }))
      .toMatchObject({ disabled: false, otlp: true, console: true });
    expect(resolveMetricsExporters({ OTEL_METRICS_EXPORTER: 'console,none' }).disabled).toBe(true);
    expect(resolveMetricsExporters({ OTEL_METRICS_EXPORTER: 'Prometheus' }).refused)
      .toEqual([{ value: 'prometheus', reason: expect.stringContaining('scrape') }]);
    expect(resolveMetricsExporters({ OTEL_METRICS_EXPORTER: 'zipkin' }).unknown).toEqual(['zipkin']);
  });

  it('`console` alone builds an exporter with NO endpoint, and writes the batch', async () => {
    captureConsole();
    const exporter = createUsageMetrics({
      NESSY_ENABLE_TELEMETRY: '1',
      OTEL_METRICS_EXPORTER: 'console',
    });
    expect(exporter).toBeDefined();
    exporter!.record({ backend: 'pi', model: 'm', inputTokens: 7, outputTokens: 1 });
    await exporter!.shutdown();
    const line = logs.find(entry => entry.startsWith('[telemetry] metrics '));
    expect(line).toBeDefined();
    // The OTLP body verbatim: an operator debugging a collector needs to see
    // what the collector is being sent, not a prettier summary.
    expect(line).toContain('nessy.token.usage');
    expect(line).toContain('"asInt":"7"');
  });

  it('`prometheus` is refused BY NAME rather than silently ignored', async () => {
    captureConsole();
    const exporter = createUsageMetrics({
      NESSY_ENABLE_TELEMETRY: '1',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
      OTEL_METRICS_EXPORTER: 'prometheus',
    });
    // Nothing exports through it, and no socket is opened for it...
    expect(exporter).toBeUndefined();
    // ...but the operator is TOLD, which is the whole difference from before.
    const refusal = warnings.find(entry => entry.includes('OTEL_METRICS_EXPORTER=prometheus'));
    expect(refusal).toBeDefined();
    expect(refusal).toContain('scrape');
    expect(refusal).toContain('inbound listening socket');
  });

  it('a refused value alongside a supported one keeps the supported one working', async () => {
    captureConsole();
    const { sink, exporter } = await metricsFor({
      OTEL_METRIC_EXPORT_INTERVAL: '25',
      OTEL_METRICS_EXPORTER: 'otlp,prometheus',
    });
    exporter.record({ backend: 'pi', model: 'm', inputTokens: 3, outputTokens: 1 });
    await sink.waitFor(1);
    expect(sink.requests).toHaveLength(1);
    expect(warnings.some(entry => entry.includes('OTEL_METRICS_EXPORTER=prometheus'))).toBe(true);
    await exporter.shutdown();
  });
});

describe('usage metrics exporter', () => {
  it('is absent unless an endpoint is configured, opt-in notwithstanding', () => {
    expect(createUsageMetrics({ NESSY_ENABLE_TELEMETRY: '1' })).toBeUndefined();
    expect(createUsageMetrics({
      NESSY_ENABLE_TELEMETRY: '1',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'ftp://collector',
    })).toBeUndefined();
    expect(createUsageMetrics({
      NESSY_ENABLE_TELEMETRY: '1',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector',
      OTEL_EXPORTER_OTLP_HEADERS: 'no-equals-sign',
    })).toBeUndefined();
  });

  it('exports token and cost counters on the interval', async () => {
    const { sink, exporter } = await metricsFor({
      OTEL_METRIC_EXPORT_INTERVAL: '25',
      OTEL_EXPORTER_OTLP_HEADERS: 'X-Collector=one%20two',
    });

    exporter.record({
      backend: 'pi',
      model: 'tgpt/qwen35-397b-a17b-fp8',
      inputTokens: 1_000,
      outputTokens: 200,
      cacheReadTokens: 300,
      cacheCreationTokens: 100,
      costUsd: 0.5,
      costReporting: 'reported',
    });

    await sink.waitFor(1);
    await exporter.shutdown();

    const [request] = sink.requests;
    expect(request?.path).toBe('/v1/metrics');

    const tokens = metric(request!.body, 'nessy.token.usage');
    expect(tokens?.unit).toBe('tokens');
    // DELTA: each export carries only what accrued since the last one, which is
    // what makes the shutdown drain load-bearing.
    expect(tokens?.sum.aggregationTemporality).toBe(1);
    const byType = Object.fromEntries(
      tokens!.sum.dataPoints.map(point => [attributes(point).type, point.asInt]),
    );
    // inputTokens folds the cache buckets in, so `input` is the remainder: the
    // four documented buckets are disjoint and must not double-count.
    expect(byType).toEqual({ input: '600', output: '200', cacheRead: '300', cacheCreation: '100' });
    expect(attributes(tokens!.sum.dataPoints[0]!)).toMatchObject({
      backend: 'pi',
      model: 'tgpt/qwen35-397b-a17b-fp8',
      cost_reporting: 'reported',
    });

    const cost = metric(request!.body, 'nessy.cost.usage');
    expect(cost?.unit).toBe('USD');
    expect(cost?.sum.dataPoints[0]?.asDouble).toBe(0.5);
  });

  it('drains the final batch on shutdown', async () => {
    // A one-hour interval: nothing can flush this batch except the drain.
    const { sink, exporter } = await metricsFor({ OTEL_METRIC_EXPORT_INTERVAL: '3600000' });

    exporter.record({ backend: 'anthropic', model: 'claude-sonnet-4-6', outputTokens: 42, costUsd: 0.1, costReporting: 'reported' });
    expect(sink.requests).toHaveLength(0);

    await exporter.shutdown();

    expect(sink.requests).toHaveLength(1);
    expect(metric(sink.requests[0]!.body, 'nessy.token.usage')!.sum.dataPoints[0]?.asInt).toBe('42');
    expect(metric(sink.requests[0]!.body, 'nessy.cost.usage')!.sum.dataPoints[0]?.asDouble).toBe(0.1);
  });

  it('exports no cost data point for a backend that reports no cost', async () => {
    const { sink, exporter } = await metricsFor({ OTEL_METRIC_EXPORT_INTERVAL: '3600000' });

    exporter.record({ backend: 'codex', model: 'gpt-5-codex', inputTokens: 900, outputTokens: 40, costReporting: 'unsupported' });
    await exporter.shutdown();

    const body = sink.requests[0]!.body;
    // A zero cost point would be the exported form of "this turn was free".
    expect(metric(body, 'nessy.cost.usage')).toBeUndefined();
    expect(attributes(metric(body, 'nessy.token.usage')!.sum.dataPoints[0]!).cost_reporting).toBe('unsupported');
  });

  it('accumulates repeated turns into one series and stops recording after shutdown', async () => {
    const { sink, exporter } = await metricsFor({ OTEL_METRIC_EXPORT_INTERVAL: '3600000' });

    exporter.record({ backend: 'pi', model: 'm', outputTokens: 10, costUsd: 1, costReporting: 'reported' });
    exporter.record({ backend: 'pi', model: 'm', outputTokens: 5, costUsd: 2, costReporting: 'reported' });
    await exporter.shutdown();
    exporter.record({ backend: 'pi', model: 'm', outputTokens: 99, costReporting: 'reported' });
    await exporter.flush();

    expect(sink.requests).toHaveLength(1);
    const body = sink.requests[0]!.body;
    expect(metric(body, 'nessy.token.usage')!.sum.dataPoints[0]?.asInt).toBe('15');
    expect(metric(body, 'nessy.cost.usage')!.sum.dataPoints[0]?.asDouble).toBe(3);
  });

  it('prefers the per-signal metrics endpoint and uses its path as given', async () => {
    const sink = await collector();
    collectors.push(sink);
    const exporter = createUsageMetrics({
      NESSY_ENABLE_TELEMETRY: '1',
      // Loopback and never contacted: the per-signal override must win.
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9',
      // monitoring-usage.md:100 — the documented example value carries its own
      // path, so nothing may be appended to it.
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${sink.endpoint}/custom/v1/metrics`,
      OTEL_METRIC_EXPORT_INTERVAL: '3600000',
    });
    if (!exporter) throw new Error('exporter not created');

    exporter.record({ backend: 'pi', model: 'm', outputTokens: 1, costReporting: 'unsupported' });
    await exporter.shutdown();

    expect(sink.requests).toHaveLength(1);
    expect(sink.requests[0]!.path).toBe('/custom/v1/metrics');
  });

  it('cumulative temporality flips the enum and reports running totals, not deltas', async () => {
    const { sink, exporter } = await metricsFor({
      OTEL_METRIC_EXPORT_INTERVAL: '3600000',
      OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'cumulative',
    });

    exporter.record({ backend: 'pi', model: 'm', outputTokens: 10, costReporting: 'unsupported' });
    await exporter.flush();
    exporter.record({ backend: 'pi', model: 'm', outputTokens: 5, costReporting: 'unsupported' });
    await exporter.shutdown();

    expect(sink.requests).toHaveLength(2);
    const first = metric(sink.requests[0]!.body, 'nessy.token.usage')!;
    expect(first.sum.aggregationTemporality).toBe(2);
    expect(first.sum.dataPoints[0]?.asInt).toBe('10');
    // The running total since process start — a 5 here would be a delta wearing
    // a cumulative label, which a backend reads as the count going DOWN.
    const second = metric(sink.requests[1]!.body, 'nessy.token.usage')!;
    expect(second.sum.aggregationTemporality).toBe(2);
    expect(second.sum.dataPoints[0]?.asInt).toBe('15');
  });

  it('exports nothing whatsoever beyond counts and identifiers', async () => {
    const { sink, exporter } = await metricsFor({ OTEL_METRIC_EXPORT_INTERVAL: '3600000' });

    exporter.record({ backend: 'pi', model: 'm', outputTokens: 1, costReporting: 'unsupported' });
    await exporter.shutdown();

    const keys = new Set(
      metrics(sink.requests[0]!.body)
        .flatMap(entry => entry.sum.dataPoints)
        .flatMap(point => point.attributes.map(attribute => attribute.key)),
    );
    expect([...keys].sort()).toEqual(['backend', 'cost_reporting', 'model', 'type']);
    // No session, workspace, account, prompt or tool attribute exists to leak.
    for (const forbidden of ['session', 'workspace', 'user', 'prompt', 'tool', 'account']) {
      expect(sink.requests[0]!.body).not.toContain(forbidden);
    }
  });
});

describe('collectSeries', () => {
  it('uses the per-model map as the sole source when a turn reports one', () => {
    const entries = collectSeries({
      backend: 'anthropic',
      model: 'session-model-ignored',
      inputTokens: 999_999,
      costUsd: 999,
      costReporting: 'reported',
      modelUsage: {
        'claude-sonnet-4-6': {
          inputTokens: 100, outputTokens: 10, cacheReadTokens: 5,
          cacheCreationTokens: 1, costUsd: 0.3, costReporting: 'reported',
        },
        'claude-haiku-4-5': {
          inputTokens: 20, outputTokens: 2, cacheReadTokens: 0,
          cacheCreationTokens: 0, costUsd: 0, costReporting: 'unsupported',
        },
      },
    });

    expect(entries.map(([, series]) => series.model).sort())
      .toEqual(['claude-haiku-4-5', 'claude-sonnet-4-6']);
    const sonnet = entries.find(([, series]) => series.model === 'claude-sonnet-4-6')![1];
    // No subtraction: the map's buckets are already disjoint.
    expect(sonnet.tokens).toEqual({ input: 100, output: 10, cacheRead: 5, cacheCreation: 1 });
    expect(sonnet.costUsd).toBe(0.3);
    // The flat 999/999_999 never appear — the map is authoritative or absent.
    const haiku = entries.find(([, series]) => series.model === 'claude-haiku-4-5')![1];
    expect(haiku.costUsd).toBe(0);
    expect(haiku.costReported).toBe(false);
  });

  it('labels a model-less turn rather than dropping it', () => {
    const entries = collectSeries({ backend: 'nestor-cloud-agent', outputTokens: 3 });
    expect(entries).toHaveLength(1);
    expect(entries[0]![1].model).toBe('unknown');
    expect(entries[0]![1].costReporting).toBe('unsupported');
  });
});

/**
 * P3.98 + P3.122 — the host-overhead line. Owner-delegated controller decision
 * 2026-09-02 (§E1): a separate line, never folded into per-turn model usage, so
 * an operator never sees less than they are charged.
 *
 * The two properties that make it a LINE rather than a relabelling:
 *   1. an overhead point never merges into a model's own series, even at the
 *      same backend and model — the classifier's fallback means those two ARE
 *      usually the same id (P3.121);
 *   2. a conversation point is byte-identical to what it was, so nothing an
 *      operator already graphs moves. The privacy test above is the other half
 *      of that guard: it enumerates the attribute keys of a conversation point
 *      and would redden if this leaked into one.
 */
describe('the host-overhead usage line', () => {
  it('keeps overhead in its own series at the same backend and model', () => {
    const conversation = collectSeries({ backend: 'anthropic', model: 'm', inputTokens: 100 });
    const overhead = collectSeries({
      backend: 'anthropic', model: 'm', inputTokens: 24_200,
      scope: 'host-overhead', overheadSource: 'auto-mode-classifier',
    });
    expect(conversation[0]![0]).not.toBe(overhead[0]![0]);
    expect(conversation[0]![1].scope).toBe('conversation');
    expect(overhead[0]![1].scope).toBe('host-overhead');
    expect(overhead[0]![1].overheadSource).toBe('auto-mode-classifier');
  });

  it('drops an overheadSource set on a conversation turn instead of splitting the series', () => {
    // A stray source on a conversation turn is a caller mistake; letting it into
    // the key would quietly split one model's series in two.
    const [key, series] = collectSeries({
      backend: 'pi', model: 'm', inputTokens: 1, overheadSource: 'auto-mode-classifier',
    })[0]!;
    expect(series.overheadSource).toBeUndefined();
    expect(key).toBe(collectSeries({ backend: 'pi', model: 'm', inputTokens: 1 })[0]![0]);
  });

  it('exports usage_scope and overhead_source on the overhead point ONLY', async () => {
    const { sink, exporter } = await metricsFor({ OTEL_METRIC_EXPORT_INTERVAL: '3600000' });

    exporter.record({ backend: 'anthropic', model: 'm', inputTokens: 1_000, costReporting: 'unsupported' });
    exporter.record({
      backend: 'anthropic', model: 'm', inputTokens: 24_200,
      scope: 'host-overhead', overheadSource: 'auto-mode-classifier',
      costReporting: 'unsupported',
    });
    await exporter.shutdown();

    const points = metric(sink.requests[0]!.body, 'nessy.token.usage')!.sum.dataPoints;
    const conversation = points.find(point => attributes(point).usage_scope === undefined)!;
    const overhead = points.find(point => attributes(point).usage_scope !== undefined)!;

    // The conversation point's attribute set is untouched — an operator's
    // existing dashboards keep the series identity they were built on.
    expect(Object.keys(attributes(conversation)).sort())
      .toEqual(['backend', 'cost_reporting', 'model', 'type']);
    expect(attributes(overhead)).toMatchObject({
      usage_scope: 'host-overhead',
      overhead_source: 'auto-mode-classifier',
    });

    // …and the naive total still contains the overhead, which is the whole row:
    // an operator must never see less than they are charged.
    const total = points.reduce((sum, point) => sum + Number(point.asInt), 0);
    expect(total).toBe(25_200);
  });
});
