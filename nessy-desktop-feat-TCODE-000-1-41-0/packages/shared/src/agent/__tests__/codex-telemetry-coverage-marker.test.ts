/**
 * P2.450 — codex's own event stream, and the marker that says what it covers.
 *
 * ## The two halves this file pins, and why they are one row
 *
 * codex has no telemetry ENV of its own — its exporter lives in `config.toml`,
 * and `CODEX_HOME` is a directory this process creates, writes whole and
 * deletes, so an operator has no file to put `[otel]` in. The only place their
 * intent can enter is the env the other two runtimes already answer to. So the
 * gate here is deliberately NOT a new one: `telemetryOptedIn`,
 * `telemetryOptedOut` and `otelExporterDisabled` are imported by
 * `resolveCodexOtelExport` for the reason their own docblocks give — one
 * predicate, so three runtimes can never disagree about what an operator's
 * opt-out meant.
 *
 * The second half is the marker, and it exists because the three streams speak
 * DISJOINT vocabularies: 4 host-minted `session.*`/`permission.*`/`tool.*` names
 * on Pi, 25 `claude_code.*` from the SDK, 14 `codex.*` from the app-server. No
 * name is in two sets, so a SIEM query written against one returns silence for
 * the other two — and a silence that cannot explain itself reads as "nothing
 * happened", which is worse than an absent stream.
 *
 * ## Measured, not assumed
 *
 * The marker rides `OTEL_RESOURCE_ATTRIBUTES` rather than
 * `[otel].span_attributes` because that table is applied by codex's
 * `SpanAttributesProcessor::on_start` — to TRACE SPANS only — and would be
 * invisible on the log signal we project. That the env channel WORKS was
 * measured end to end against the bundled `codex-app-server` 0.148.0: with the
 * value on the child env and a loopback collector configured, two OTLP/HTTP JSON
 * batches arrived at `/v1/logs` whose resource read
 * `service.name=codex-app-server, service.version=0.148.0, env=dev,
 * nessy.telemetry.coverage=codex-events-only`, carrying
 * `codex.conversation_starts` and `codex.startup_phase`.
 */
import { describe, expect, test } from 'bun:test';
import { codexTelemetryResourceAttributes, resolveCodexOtelExport } from '../codex-agent.ts';
import {
  CLAUDE_SDK_TELEMETRY_COVERAGE,
  CODEX_TELEMETRY_COVERAGE,
  NESSY_TELEMETRY_COVERAGE_KEY,
  withTelemetryCoverage,
} from '../telemetry-coverage.ts';

const ON = { NESSY_ENABLE_TELEMETRY: '1' } as const;
const COLLECTOR = 'https://collector.example.invalid';

describe('P2.450 · the host gate, shared with Pi and claude', () => {
  /**
   * KILLS: keying on the endpoint alone. `OTEL_EXPORTER_OTLP_ENDPOINT` is
   * ambient in many corporate shells for other tools, and that is the exact bug
   * the Pi exporter shipped with — a machine that never opted in exporting
   * anyway.
   */
  test('an ambient endpoint alone starts nothing', () => {
    expect(resolveCodexOtelExport({ OTEL_EXPORTER_OTLP_ENDPOINT: COLLECTOR })).toEqual({});
  });

  /** POSITIVE CONTROL for the row above: the same endpoint WITH the opt-in. */
  test('the opt-in plus an endpoint is what turns it on', () => {
    expect(resolveCodexOtelExport({ ...ON, OTEL_EXPORTER_OTLP_ENDPOINT: COLLECTOR }))
      .toEqual({ logsEndpoint: `${COLLECTOR}/v1/logs` });
  });

  /** KILLS: an opt-out that does not beat an explicit opt-in. */
  test.each(['DO_NOT_TRACK', 'DISABLE_TELEMETRY', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'])(
    '%s beats the opt-in',
    (name) => {
      expect(resolveCodexOtelExport({ ...ON, OTEL_EXPORTER_OTLP_ENDPOINT: COLLECTOR, [name]: '1' }))
        .toEqual({});
    },
  );

  /** KILLS: ignoring the logs signal's own documented off-switch. */
  test('OTEL_LOGS_EXPORTER=none silences it even with the opt-in set', () => {
    expect(resolveCodexOtelExport({ ...ON, OTEL_EXPORTER_OTLP_ENDPOINT: COLLECTOR, OTEL_LOGS_EXPORTER: 'none' }))
      .toEqual({});
  });

  /**
   * KILLS: appending `/v1/logs` to a per-signal endpoint. `monitoring-usage.md`
   * says the per-signal name "overrides general setting", and its documented
   * example value already carries the path — so appending would produce
   * `/v1/logs/v1/logs`.
   */
  test('a per-signal endpoint is used with its path exactly as given', () => {
    expect(resolveCodexOtelExport({
      ...ON,
      OTEL_EXPORTER_OTLP_ENDPOINT: `${COLLECTOR}/general`,
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${COLLECTOR}/otlp/v1/logs`,
    })).toEqual({ logsEndpoint: `${COLLECTOR}/otlp/v1/logs` });
  });

  /** KILLS: doubling the slash when the general endpoint carries a trailing one. */
  test('a trailing slash on the general endpoint does not double up', () => {
    expect(resolveCodexOtelExport({ ...ON, OTEL_EXPORTER_OTLP_ENDPOINT: `${COLLECTOR}/otlp//` }))
      .toEqual({ logsEndpoint: `${COLLECTOR}/otlp/v1/logs` });
  });
});

describe('P2.450 · what is refused, and refused OUT LOUD', () => {
  /**
   * KILLS: honouring `OTEL_EXPORTER_OTLP_HEADERS`. codex's `OtlpHttp.headers` is
   * a literal map in the config file with no env indirection anywhere in
   * `OtelExporterKind`, so honouring it means writing a collector credential to
   * disk — in a writer whose every other credential is an env var NAME.
   *
   * And KILLS the silent version of the same refusal: an operator who set a
   * header and got no telemetry would read the silence as "nothing happened".
   */
  test('a header-bearing collector is declined, with a line that says why', () => {
    const plan = resolveCodexOtelExport({
      ...ON,
      OTEL_EXPORTER_OTLP_ENDPOINT: COLLECTOR,
      OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer sekret',
    });
    expect(plan.logsEndpoint).toBeUndefined();
    expect(plan.notice).toContain('OTEL_EXPORTER_OTLP_HEADERS');
    // The credential must never travel in the diagnostic either.
    expect(plan.notice).not.toContain('sekret');
  });

  /** KILLS: accepting credentials in the URL, or a non-HTTP scheme. */
  test.each([
    ['credentials in the URL', 'https://user:pw@collector.example.invalid'],
    ['a non-http scheme', 'file:///etc/passwd'],
  ])('%s is declined with a notice', (_label, endpoint) => {
    const plan = resolveCodexOtelExport({ ...ON, OTEL_EXPORTER_OTLP_ENDPOINT: endpoint });
    expect(plan.logsEndpoint).toBeUndefined();
    expect(plan.notice).toBeTruthy();
  });

  /** KILLS: throwing on a value the operator fat-fingered. */
  test('an unparseable endpoint is a notice, not a crash', () => {
    const plan = resolveCodexOtelExport({ ...ON, OTEL_EXPORTER_OTLP_ENDPOINT: 'not a url' });
    expect(plan.logsEndpoint).toBeUndefined();
    expect(plan.notice).toBeTruthy();
  });
});

/**
 * C4.25 (QM2, owner answer C, 2026-09-11) — `session.id` on codex's exported
 * records, through the child's `OTEL_RESOURCE_ATTRIBUTES`.
 *
 * Owner decision D13 = option B: identity behind the documented toggles, DEFAULT
 * OFF, using the vendor's own switch names — and codex has no identity switch of
 * its own, so the HOST supplies the value on the channel P2.450 already measured
 * end to end.
 *
 * WHAT EACH TEST KILLS:
 *  - the DEFAULT-OFF case is the whole of D13's inversion: the documented
 *    upstream default for `OTEL_METRICS_INCLUDE_SESSION_ID` is TRUE, and this
 *    host answers FALSE unless an operator says otherwise;
 *  - the on-case dies if the id stops reaching the resource, which is the only
 *    signal-agnostic place it can ride (`span_attributes` is trace-only);
 *  - the no-exporter case dies if identity starts stamping a child that exports
 *    nothing — worse than noise, it is a claim that a stream exists;
 *  - the operator-value case dies if we overwrite a `session.id` they set;
 *  - the composition case is the one a reader gets wrong: an operator's own
 *    `nessy.telemetry.coverage` declines OUR COVERAGE MARKER and says nothing
 *    about identity, which they enabled by name;
 *  - the account case is the RESIDUE, asserted so it cannot be added quietly:
 *    codex has no account of its own, and the only person-naming id this host
 *    could put there is the gateway directory subject — a stronger disclosure
 *    than the one D13 approved.
 */
describe('C4.25 · codex session identity on the OTLP resource', () => {
  const LOGS = 'https://x.invalid/v1/logs';
  const ON = { OTEL_METRICS_INCLUDE_SESSION_ID: 'true' };

  test('is OFF by default, where the documented upstream default is ON', () => {
    expect(codexTelemetryResourceAttributes({}, LOGS, 'session-42'))
      .toBe(`${NESSY_TELEMETRY_COVERAGE_KEY}=${CODEX_TELEMETRY_COVERAGE}`);
  });

  test('rides the resource when the documented switch is set', () => {
    const attributes = codexTelemetryResourceAttributes(ON, LOGS, 'session-42');
    expect(attributes).toContain('session.id=session-42');
    // …beside the coverage marker, not instead of it.
    expect(attributes).toContain(`${NESSY_TELEMETRY_COVERAGE_KEY}=${CODEX_TELEMETRY_COVERAGE}`);
  });

  test('stamps nothing on a child that exports nothing', () => {
    expect(codexTelemetryResourceAttributes(ON, undefined, 'session-42')).toBeUndefined();
  });

  test('needs a session id to name — no id, no attribute', () => {
    expect(codexTelemetryResourceAttributes(ON, LOGS, undefined))
      .toBe(`${NESSY_TELEMETRY_COVERAGE_KEY}=${CODEX_TELEMETRY_COVERAGE}`);
  });

  test('never overwrites an operator\'s own session.id', () => {
    const attributes = codexTelemetryResourceAttributes(
      { ...ON, OTEL_RESOURCE_ATTRIBUTES: 'session.id=theirs' }, LOGS, 'session-42',
    );
    expect(attributes).toContain('session.id=theirs');
    expect(attributes).not.toContain('session-42');
  });

  test('their own coverage declaration declines the MARKER, not the identity', () => {
    const attributes = codexTelemetryResourceAttributes(
      { ...ON, OTEL_RESOURCE_ATTRIBUTES: `${NESSY_TELEMETRY_COVERAGE_KEY}=mine` }, LOGS, 'session-42',
    );
    expect(attributes).toBe(`${NESSY_TELEMETRY_COVERAGE_KEY}=mine,session.id=session-42`);
  });

  test('exports NO account identifier — the residue, pinned', () => {
    const attributes = codexTelemetryResourceAttributes(
      { ...ON, OTEL_METRICS_INCLUDE_ACCOUNT_UUID: 'true' }, LOGS, 'session-42',
    ) ?? '';
    expect(attributes).not.toContain('user.account_uuid');
    expect(attributes).not.toContain('user.account_id');
    // The positive control on the same string: the switch that IS served did.
    expect(attributes).toContain('session.id=session-42');
  });
});

describe('P2.450 · the coverage marker', () => {
  /**
   * KILLS: stamping a session that exports nothing. That marker would be noise,
   * and worse, a claim that a stream exists.
   */
  test('no exporter means no marker', () => {
    expect(codexTelemetryResourceAttributes({}, undefined)).toBeUndefined();
    expect(codexTelemetryResourceAttributes({ OTEL_RESOURCE_ATTRIBUTES: 'a=b' }, undefined)).toBeUndefined();
  });

  /** KILLS: dropping the marker on an exporting child. */
  test('an exporting child carries this stream\'s coverage', () => {
    expect(codexTelemetryResourceAttributes({}, 'https://x.invalid/v1/logs'))
      .toBe(`${NESSY_TELEMETRY_COVERAGE_KEY}=${CODEX_TELEMETRY_COVERAGE}`);
  });

  /**
   * KILLS: overwriting an operator's own declaration. If they have already said
   * what their coverage is, they outrank us — we describe their pipeline, we do
   * not own it.
   */
  test('an operator\'s own value for the key is never overwritten', () => {
    expect(codexTelemetryResourceAttributes(
      { OTEL_RESOURCE_ATTRIBUTES: `team=core,${NESSY_TELEMETRY_COVERAGE_KEY}=mine` },
      'https://x.invalid/v1/logs',
    )).toBeUndefined();
  });

  /** KILLS: clobbering their OTHER attributes while appending ours. */
  test('their other attributes survive, and a trailing comma makes no empty pair', () => {
    expect(codexTelemetryResourceAttributes(
      { OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment=prod,' },
      'https://x.invalid/v1/logs',
    )).toBe(`deployment.environment=prod,${NESSY_TELEMETRY_COVERAGE_KEY}=${CODEX_TELEMETRY_COVERAGE}`);
  });

  /**
   * KILLS: two streams stamping the same value, which would make the marker
   * unable to answer the only question it exists for. The values must differ and
   * the KEY must not — Pi's `pi-sessions-only` is the third, and it lives in
   * `server-core`, outside this package.
   */
  test('the runtimes this package owns carry different values under one key', () => {
    expect(CODEX_TELEMETRY_COVERAGE).not.toBe(CLAUDE_SDK_TELEMETRY_COVERAGE);
    expect(CODEX_TELEMETRY_COVERAGE).not.toBe('pi-sessions-only');
    expect(withTelemetryCoverage('', CODEX_TELEMETRY_COVERAGE))
      .toBe(`${NESSY_TELEMETRY_COVERAGE_KEY}=${CODEX_TELEMETRY_COVERAGE}`);
    expect(withTelemetryCoverage('', CLAUDE_SDK_TELEMETRY_COVERAGE))
      .toBe(`${NESSY_TELEMETRY_COVERAGE_KEY}=${CLAUDE_SDK_TELEMETRY_COVERAGE}`);
  });
});

/**
 * P6.459 arm (1) — the traces half of the same resolver.
 *
 * Native mechanism: codex's own `[otel] trace_exporter`, deliberately unwritten
 * until this row. The gate is `tracingOptedIn`, exported from
 * `telemetry/usage-metrics.ts`, so claude, Pi and codex read ONE rule and an
 * operator gets one answer to "is tracing on".
 */
describe('P6.459 · the codex trace exporter is resolved under the shared tracing gate', () => {
  const TRACING_ON = { ...ON, OTEL_TRACES_EXPORTER: 'otlp' } as const;

  test('the opt-in alone does not start it — the traces selector must be set', () => {
    expect(resolveCodexOtelExport({ ...ON, OTEL_EXPORTER_OTLP_ENDPOINT: COLLECTOR }).tracesEndpoint)
      .toBeUndefined();
  });

  test('the selector plus an endpoint writes the traces URL', () => {
    expect(resolveCodexOtelExport({ ...TRACING_ON, OTEL_EXPORTER_OTLP_ENDPOINT: COLLECTOR }))
      .toEqual({ logsEndpoint: `${COLLECTOR}/v1/logs`, tracesEndpoint: `${COLLECTOR}/v1/traces` });
  });

  test('the two signals are independent in BOTH directions', () => {
    // Spans without events: the logs selector is off, the traces selector is on.
    expect(resolveCodexOtelExport({
      ...TRACING_ON,
      OTEL_EXPORTER_OTLP_ENDPOINT: COLLECTOR,
      OTEL_LOGS_EXPORTER: 'none',
    })).toEqual({ tracesEndpoint: `${COLLECTOR}/v1/traces` });
    // Events without spans is the pre-existing case, unchanged.
    expect(resolveCodexOtelExport({
      ...TRACING_ON,
      OTEL_EXPORTER_OTLP_ENDPOINT: COLLECTOR,
      OTEL_TRACES_EXPORTER: 'none',
    })).toEqual({ logsEndpoint: `${COLLECTOR}/v1/logs` });
  });

  test('a per-signal traces endpoint is used with its path exactly as given', () => {
    expect(resolveCodexOtelExport({
      ...TRACING_ON,
      OTEL_EXPORTER_OTLP_ENDPOINT: `${COLLECTOR}/general`,
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${COLLECTOR}/otlp/v1/traces`,
    }).tracesEndpoint).toBe(`${COLLECTOR}/otlp/v1/traces`);
  });

  test('an opt-out still beats it, and a bad URL is declined by name', () => {
    expect(resolveCodexOtelExport({ ...TRACING_ON, OTEL_EXPORTER_OTLP_ENDPOINT: COLLECTOR, DO_NOT_TRACK: '1' }))
      .toEqual({});
    const declined = resolveCodexOtelExport({
      ...TRACING_ON,
      OTEL_LOGS_EXPORTER: 'none',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'not-a-url',
    });
    expect(declined.tracesEndpoint).toBeUndefined();
    expect(declined.notice).toContain('TRACING DECLINED');
  });
});
