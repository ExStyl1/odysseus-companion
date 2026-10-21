/**
 * P2.450 — codex ships two telemetry sections and this writer wrote neither.
 *
 * ## What the live binary said, control first, one run
 *
 * Bundled `codex-app-server` 0.148.0 (darwin-arm64), four arms plus a pair:
 *
 * | arm | config | result |
 * | --- | --- | --- |
 * | 1 CONTROL | `[otel] log_user_prompt = 42` | `configWarning` *"Invalid configuration; using defaults."*, `config.toml:18:19: invalid type: integer 42, expected a boolean` |
 * | 2 CLEAN | the block this file pins | **0** warnings |
 * | 3 EXPORT | + a loopback `otlp-http` exporter | **0** warnings, 2 OTLP/HTTP JSON POSTs to `/v1/logs` |
 * | 4 RENAME | `[otelx]` instead of `[otel]` | **0** warnings — an unknown top-level table is dropped in SILENCE |
 * | 5a/5b/5c | `[analytics] enabled = 42` / `enabledx = 42` / `enabled = false` | rejects whole file at `config.toml:13:11` / silent / accepted |
 *
 * Arm 1 is why the escaping rows exist: the fail-open is WHOLE-FILE, so one bad
 * character in an endpoint takes the provider block and every deny floor with
 * it. Arm 4 is why the schema-drift rows exist: a rename announces itself
 * NOWHERE, so `validateConfigAgainstSchema` is the only detector. Arm 5 is why
 * arm 2's silence is not self-supporting — the 5a/5b pair proves the binary
 * genuinely READS `[analytics] enabled` rather than ignoring a table it does not
 * know.
 *
 * The live arm itself cannot live in this package: it needs
 * `@nessy-agent/codex-agent-server`, which depends on this one.
 */
import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { buildCodexConfigToml, validateConfigAgainstSchema, CODEX_PERMISSION_MODE_ORDER } from '../config-writer.ts';
import type { CodexConfigOptions } from '../config-writer.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = join(HERE, '..', '..', '..', 'codex-protocol', 'schema', 'config-schema.json');

const BASE: CodexConfigOptions = {
  codexHome: '/tmp/p2450',
  model: 'tgpt/qwen35-397b-a17b-fp8',
  adapterPort: 54321,
};

const ENDPOINT = 'https://collector.example.invalid/v1/logs';

/**
 * The bare `key = value` lines under `[<name>]`, stopping at the next table
 * header. Parsed rather than substring-matched, because arm 1's fail-open makes
 * "the line is somewhere in the file" the wrong question — what matters is which
 * table it lands in.
 */
function tableBody(toml: string, name: string): string[] {
  const lines = toml.split('\n');
  const start = lines.indexOf(`[${name}]`);
  if (start === -1) return [];
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trimStart().startsWith('[')) break;
    if (line.trim()) body.push(line.trim());
  }
  return body;
}

describe('P2.450 · the [otel] privacy pin', () => {
  /**
   * KILLS: dropping the key, or ever emitting it as `true`. `log_user_prompt`
   * defaults to false upstream (`core/src/config/otel.rs`,
   * `config.log_user_prompt.unwrap_or(false)`), so this line changes nothing
   * TODAY — it exists so an upstream default flip cannot start shipping prompt
   * text out of every codex session with nothing failing anywhere.
   */
  test('is written on every session, and always false', () => {
    expect(tableBody(buildCodexConfigToml(BASE), 'otel')).toContain('log_user_prompt = false');
  });

  /**
   * The tripwire, in the same shape as P2.384's. `log_user_prompt = true` is
   * schema-VALID, so nothing but this can catch a lane that adds it.
   *
   * POSITIVE CONTROL on the same rig: the false spelling must be found in every
   * one of these configs, or a search scoring 0 for both is an instrument
   * failure rather than a finding.
   */
  test('no mode, and no exporter state, ever emits the true spelling', () => {
    for (const mode of CODEX_PERMISSION_MODE_ORDER) {
      for (const otelLogsEndpoint of [undefined, ENDPOINT]) {
        const toml = buildCodexConfigToml({ ...BASE, mode, ...(otelLogsEndpoint ? { otelLogsEndpoint } : {}) });
        expect(toml).toContain('log_user_prompt = false');
        expect(toml).not.toContain('log_user_prompt = true');
      }
    }
  });
});

describe('P2.450 · the analytics off-switch', () => {
  /**
   * KILLS: dropping the key. Two independent readers use it and they disagree
   * about the default — `otel_init.rs` gates the Statsig METRICS exporter on
   * `analytics_enabled.unwrap_or(<caller default>)` (false in the app-server),
   * while `analytics/src/client.rs` reads `!= Some(false)`, i.e. UNSET IS ON, and
   * posts to `{chatgpt_base_url}/codex/analytics-events/events`. `Some(false)`
   * is the one value that closes both.
   */
  test('[analytics] enabled = false is written on every session', () => {
    expect(tableBody(buildCodexConfigToml(BASE), 'analytics')).toEqual(['enabled = false']);
  });

  /**
   * KILLS: adding `metrics_exporter = "none"` beside it. With
   * `enabled = false` the `unwrap_or` can never run, so that key would be a
   * guard that cannot fire — protection that is not there, which is exactly what
   * P2.414's lane deleted rather than kept.
   */
  test('no redundant metrics_exporter is written', () => {
    expect(buildCodexConfigToml({ ...BASE, otelLogsEndpoint: ENDPOINT })).not.toContain('metrics_exporter');
  });
});

describe('P2.450 · the log exporter', () => {
  /**
   * KILLS: emitting an exporter nobody asked for. Absent is codex's own default
   * (`OtelExporterKind::None`), and an exporter pointed nowhere is worse than
   * none — it would claim a stream exists.
   */
  test('nothing is exported until an endpoint is handed in', () => {
    expect(tableBody(buildCodexConfigToml(BASE), 'otel')).toEqual(['log_user_prompt = false']);
  });

  /**
   * KILLS: the wrong variant key, the wrong protocol, a missing `protocol` (the
   * schema marks it REQUIRED, so its absence is arm 1's whole-file fail-open).
   * `json` rather than `binary` matches what the host's own Pi exporter posts,
   * so one collector sees one wire format whichever runtime is speaking.
   */
  test('an endpoint becomes codex\'s own otlp-http log exporter', () => {
    const body = tableBody(buildCodexConfigToml({ ...BASE, otelLogsEndpoint: ENDPOINT }), 'otel');
    expect(body).toContain(
      `exporter = { otlp-http = { endpoint = "${ENDPOINT}", protocol = "json" } }`,
    );
  });

  /**
   * KILLS: interpolating the endpoint raw. A quote in the value terminates the
   * TOML string, and arm 1 measured what that costs: the WHOLE file, including
   * the model provider and every deny floor.
   */
  test('the endpoint goes through the TOML escaper', () => {
    const nasty = 'https://host.invalid/a"b\\c';
    const toml = buildCodexConfigToml({ ...BASE, otelLogsEndpoint: nasty });
    expect(toml).toContain('endpoint = "https://host.invalid/a\\"b\\\\c"');
    expect(toml).not.toContain('endpoint = "https://host.invalid/a"b');
  });

  /** KILLS: a whitespace-only endpoint becoming an exporter pointed at nothing. */
  test('a blank endpoint is not an endpoint', () => {
    expect(tableBody(buildCodexConfigToml({ ...BASE, otelLogsEndpoint: '   ' }), 'otel'))
      .toEqual(['log_user_prompt = false']);
  });
});

describe('P2.450 · placement, the trap this file keeps warning about', () => {
  /**
   * KILLS: emitting the tables anywhere a later bare assignment could be
   * swallowed by them, and emitting a bare line into `[otel]` from a future edit.
   * Both tables must contain ONLY the keys named here.
   */
  test('nothing lands in either table except what it is for', () => {
    for (const otelLogsEndpoint of [undefined, ENDPOINT]) {
      const opts = { ...BASE, ...(otelLogsEndpoint ? { otelLogsEndpoint } : {}) };
      const toml = buildCodexConfigToml(opts);
      for (const line of tableBody(toml, 'otel')) {
        expect(['log_user_prompt', 'exporter']).toContain(line.slice(0, line.indexOf(' ')));
      }
      expect(tableBody(toml, 'analytics')).toEqual(['enabled = false']);
      // And the block is followed by a TABLE header, never by a bare key that
      // `[analytics]` would silently adopt.
      const lines = toml.split('\n');
      const after = lines.slice(lines.indexOf('enabled = false') + 1).filter(Boolean);
      expect(after[0]?.trimStart().startsWith('[')).toBe(true);
    }
  });
});

describe('P2.450 · the schema drift guard, which arm 4 made the only detector', () => {
  const schema = JSON.parse(readFileSync(SCHEMA, 'utf8'));
  /** The real thing, both exporter states, against the pinned release schema. */
  test('the options we actually emit validate', () => {
    expect(() => validateConfigAgainstSchema(BASE, SCHEMA)).not.toThrow();
    expect(() => validateConfigAgainstSchema({ ...BASE, otelLogsEndpoint: ENDPOINT }, SCHEMA)).not.toThrow();
  });

  /**
   * KILLS: a guard that does not actually read the schema. Each row removes ONE
   * thing an upstream rename would remove and asserts the failure names it —
   * which is the only signal that would ever exist, since the binary itself says
   * nothing (arm 4).
   */
  test.each([
    ['top-level otel', (s: any) => { delete s.properties.otel; }, /no top-level property "otel"/, false],
    ['top-level analytics', (s: any) => { delete s.properties.analytics; }, /no top-level property "analytics"/, false],
    ['OtelConfigToml.log_user_prompt', (s: any) => { delete s.definitions.OtelConfigToml.properties.log_user_prompt; }, /OtelConfigToml has no property "log_user_prompt"/, false],
    ['AnalyticsConfigToml.enabled', (s: any) => { delete s.definitions.AnalyticsConfigToml.properties.enabled; }, /AnalyticsConfigToml has no property "enabled"/, false],
    ['OtelConfigToml.exporter', (s: any) => { delete s.definitions.OtelConfigToml.properties.exporter; }, /OtelConfigToml has no property "exporter"/, true],
    ['the otlp-http variant key', (s: any) => { s.definitions.OtelExporterKind.oneOf = s.definitions.OtelExporterKind.oneOf.filter((v: any) => !('otlp-http' in (v.properties ?? {}))); }, /otlp-http variant has no property "endpoint"/, true],
    ['otlp-http.protocol', (s: any) => { delete s.definitions.OtelExporterKind.oneOf.find((v: any) => 'otlp-http' in (v.properties ?? {})).properties['otlp-http'].properties.protocol; }, /otlp-http variant has no property "protocol"/, true],
    ['the json protocol member', (s: any) => { s.definitions.OtelHttpProtocol.oneOf = s.definitions.OtelHttpProtocol.oneOf.filter((v: any) => !v.enum?.includes('json')); }, /OtelHttpProtocol "json" not in schema enum/, true],
  ])('a schema missing %s is refused', (_label, mutate, pattern, needsEndpoint) => {
    const drifted = JSON.parse(JSON.stringify(schema));
    mutate(drifted);
    const path = join(tmpdir(), `p2450-drift-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(path, JSON.stringify(drifted), 'utf8');
    const opts = needsEndpoint ? { ...BASE, otelLogsEndpoint: ENDPOINT } : BASE;
    try {
      expect(() => validateConfigAgainstSchema(opts, path)).toThrow(pattern);
    } finally {
      rmSync(path, { force: true });
    }
  });

  /**
   * KILLS: hoisting the exporter guard out of its gate. A session with no
   * endpoint writes no `exporter` key, so a schema that lost it must still pass —
   * otherwise every session would refuse to start over a key it does not use.
   */
  test('the exporter guard fires only when an exporter is written', () => {
    const drifted = JSON.parse(JSON.stringify(schema));
    delete drifted.definitions.OtelConfigToml.properties.exporter;
    const path = join(tmpdir(), `p2450-drift-gate-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(path, JSON.stringify(drifted), 'utf8');
    try {
      expect(() => validateConfigAgainstSchema(BASE, path)).not.toThrow();
    } finally {
      rmSync(path, { force: true });
    }
  });
});

/**
 * P6.488 — the OTLP headers, as literals, behind the caller's named opt-in.
 *
 * The gate is the CALLER's (`resolveCodexOtelExport` +
 * `NESSY_CODEX_OTLP_HEADERS_ON_DISK`, pinned in
 * `shared/agent/__tests__/codex-telemetry-refusal-notice.test.ts`); this leaf
 * emits what it is handed. What is pinned here is the SHAPE, and the shape is
 * where a silent failure would live: codex's fail-open is whole-file, so a
 * `headers = …` line landing outside the `otlp-http` inline table would take the
 * provider block and every deny floor with it.
 */
describe('P6.488 · the OTLP headers ride the exporter inline table', () => {
  const withHeaders = (headers: Record<string, string>): string => buildCodexConfigToml({
    ...BASE,
    otelLogsEndpoint: ENDPOINT,
    otelLogsHeaders: headers,
  });

  test('writes no headers member at all when the caller hands none — the default', () => {
    const body = tableBody(buildCodexConfigToml({ ...BASE, otelLogsEndpoint: ENDPOINT }), 'otel');
    const exporter = body.find(line => line.startsWith('exporter'))!;
    expect(exporter).toContain('otlp-http');
    expect(exporter).not.toContain('headers');
  });

  test('nests headers INSIDE the otlp-http table, so nothing bare can escape it', () => {
    const toml = withHeaders({ authorization: 'Bearer sekret' });
    const exporter = tableBody(toml, 'otel').find(line => line.startsWith('exporter'))!;
    expect(exporter).toBe(
      `exporter = { otlp-http = { endpoint = "${ENDPOINT}", protocol = "json", `
      + 'headers = { "authorization" = "Bearer sekret" } } }',
    );
    // The whole file still parses — arm 1's fail-open is whole-file.
    const parsed = Bun.TOML.parse(toml) as Record<string, any>;
    expect(parsed.otel.exporter['otlp-http'].headers.authorization).toBe('Bearer sekret');
    expect(parsed.model_provider).toBe('nessy_gateway');
  });

  test('sorts the headers, so one header map always produces the same bytes', () => {
    // `codexThreadConfigSignature` hashes this file's output; a key-order
    // dependent hash respawns the runtime for no reason.
    const a = withHeaders({ b: '2', a: '1' });
    const b = withHeaders({ a: '1', b: '2' });
    expect(a).toBe(b);
  });

  test('escapes a value through the same tomlString every other credential-adjacent field uses', () => {
    const toml = withHeaders({ authorization: 'Bearer "quoted\\slash"' });
    const parsed = Bun.TOML.parse(toml) as Record<string, any>;
    expect(parsed.otel.exporter['otlp-http'].headers.authorization).toBe('Bearer "quoted\\slash"');
  });
});

/**
 * P6.459 arm (1) — codex's OWN spans, exported through codex's own
 * `[otel] trace_exporter`.
 *
 * What arm (1) does NOT do is fill the per-request `trace` field: without a host
 * span source, any value there would be a freshly minted unparented context —
 * orphan traces in the collector, which is the invented-answer shape. Codex's
 * own spans are genuine roots, so exporting them is honest today and gains a
 * parent the moment P6.732 lands.
 */
describe('P6.459 · the trace exporter', () => {
  const TRACES = 'https://collector.example.invalid/v1/traces';

  test('is absent by default — codex\'s own default is OtelExporterKind::None', () => {
    const body = tableBody(buildCodexConfigToml(BASE), 'otel');

    expect(body.some(line => line.startsWith('trace_exporter'))).toBe(false);
    // And writing `"none"` explicitly would be a key that changes nothing.
    expect(body.join('\n')).not.toContain('none');
  });

  test('is written in the logs exporter\'s own shape when the caller resolved one', () => {
    const toml = buildCodexConfigToml({ ...BASE, otelTracesEndpoint: TRACES });
    const line = tableBody(toml, 'otel').find(entry => entry.startsWith('trace_exporter'));

    expect(line).toBe(`trace_exporter = { otlp-http = { endpoint = "${TRACES}", protocol = "json" } }`);
    const parsed = Bun.TOML.parse(toml) as Record<string, any>;
    expect(parsed.otel.trace_exporter['otlp-http'].endpoint).toBe(TRACES);
    expect(() => validateConfigAgainstSchema({ ...BASE, otelTracesEndpoint: TRACES }, SCHEMA)).not.toThrow();
  });

  test('the two signals are independent — spans without events, and the reverse', () => {
    // codex's own field comment is the reason: "enabling log export must not
    // implicitly send spans to a /v1/logs endpoint".
    const spansOnly = Bun.TOML.parse(
      buildCodexConfigToml({ ...BASE, otelTracesEndpoint: TRACES }),
    ) as Record<string, any>;
    expect(spansOnly.otel.exporter).toBeUndefined();
    expect(spansOnly.otel.trace_exporter).toBeDefined();

    const eventsOnly = Bun.TOML.parse(
      buildCodexConfigToml({ ...BASE, otelLogsEndpoint: ENDPOINT }),
    ) as Record<string, any>;
    expect(eventsOnly.otel.trace_exporter).toBeUndefined();
    expect(eventsOnly.otel.exporter).toBeDefined();
  });

  test('carries the same opted-in headers as the logs exporter', () => {
    const toml = buildCodexConfigToml({
      ...BASE,
      otelTracesEndpoint: TRACES,
      otelLogsHeaders: { authorization: 'Bearer sekret' },
    });
    const parsed = Bun.TOML.parse(toml) as Record<string, any>;

    expect(parsed.otel.trace_exporter['otlp-http'].headers.authorization).toBe('Bearer sekret');
  });
});
