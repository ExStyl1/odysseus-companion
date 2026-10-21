/**
 * P6.452 — what the two host OTLP exporters owe an administrator.
 *
 * Three of the row's five units are built here (M28, M32, M39). M21 and M38
 * edit `buildClaudeSubprocessEnv` in `packages/shared/src/agent/options.ts`,
 * which another lane holds this wave; they are handed off, not half-built.
 *
 * The exporter under test is the Pi logs one, driven against a real local
 * collector, because that is where a payload and a status code can both be
 * observed. The helpers it calls are shared with the metrics exporter
 * (`shared/telemetry/usage-metrics.ts`), so a fix to one cannot leave the other
 * behind — the two lines of `otlpResourceAttributes` and
 * `reportOtlpExportFailure` are the same lines on both sides.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import {
  METRIC_NAMESPACE_UPSTREAM_ATTRIBUTE,
  otlpResourceAttributes,
  readOtlpDroppedBatches,
  resolveOtlpClientTls,
  setOtlpExportDiagnosticSink,
  type OtlpExportFailure,
} from '@nessy-agent/shared/telemetry/usage-metrics'
import { createPiOtlpTelemetry } from './otlp-telemetry.ts'

const ENV_KEYS = [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
  'OTEL_LOGS_EXPORTER',
  'OTEL_SERVICE_NAME',
  'OTEL_RESOURCE_ATTRIBUTES',
  'NESSY_ENABLE_TELEMETRY',
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'CLAUDE_CODE_CLIENT_CERT',
  'CLAUDE_CODE_CLIENT_KEY',
  'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
  'DO_NOT_TRACK',
  'DISABLE_TELEMETRY',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'OTEL_METRICS_INCLUDE_SESSION_ID',
  'OTEL_METRICS_INCLUDE_ACCOUNT_UUID',
] as const
const ORIGINAL = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]])) as Record<string, string | undefined>

/** `delete` before writing, and on the restore path — Bun 1.3.14 env-slot trap. */
function setEnv(name: string, value: string | undefined): void {
  delete process.env[name]
  if (value !== undefined) process.env[name] = value
}

const session = { workspaceId: 'w', sessionId: 's' }
const credentials = { get: async () => null, set: async () => {} }

function event() {
  return {
    schemaVersion: 1 as const,
    name: 'tool.completed' as const,
    timestamp: 1234,
    outcome: 'success' as const,
    durationMs: 4,
    semanticId: 'tool-1',
  }
}

async function collector(status = 200): Promise<{ endpoint: string; bodies: string[]; close(): Promise<void> }> {
  const bodies: string[] = []
  const server = createServer((request, response: ServerResponse) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', c => { body += c })
    request.on('end', () => {
      bodies.push(body)
      response.writeHead(status).end()
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const address = server.address() as AddressInfo
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    bodies,
    close: () => new Promise((res, rej) => server.close(e => e ? rej(e) : res())),
  }
}

function resourceAttributes(body: string): Record<string, string> {
  const attrs = JSON.parse(body).resourceLogs[0].resource.attributes as Array<{ key: string; value: { stringValue: string } }>
  return Object.fromEntries(attrs.map(a => [a.key, a.value.stringValue]))
}

beforeEach(() => {
  for (const key of ENV_KEYS) setEnv(key, undefined)
  setEnv('NESSY_ENABLE_TELEMETRY', '1')
  setOtlpExportDiagnosticSink(undefined)
})

afterEach(() => {
  for (const key of ENV_KEYS) setEnv(key, ORIGINAL[key])
  setOtlpExportDiagnosticSink(undefined)
})

describe('M28 — a refusing collector is no longer indistinguishable from a working one', () => {
  test('a 401 produces one diagnostic and a dropped-batch count', async () => {
    const seen: OtlpExportFailure[] = []
    setOtlpExportDiagnosticSink(f => { seen.push(f) })
    const sink = await collector(401)
    setEnv('OTEL_EXPORTER_OTLP_ENDPOINT', sink.endpoint)
    const exporter = await createPiOtlpTelemetry(credentials)
    expect(exporter).toBeDefined()
    exporter!.emit(session, event())
    await exporter!.shutdown()
    await sink.close()

    expect(seen).toHaveLength(1)
    expect(seen[0]?.signal).toBe('logs')
    expect(seen[0]?.status).toBe(401)
    expect(seen[0]?.reason).toBe('unauthorized')
    expect(readOtlpDroppedBatches('logs')).toBe(1)
    // The endpoint is safe to name; a header value never appears in the shape.
    expect(Object.keys(seen[0] ?? {})).toEqual(['signal', 'status', 'endpoint', 'reason'])
  })

  test('a 404 is categorised as not-found rather than counted as delivery', async () => {
    const seen: OtlpExportFailure[] = []
    setOtlpExportDiagnosticSink(f => { seen.push(f) })
    const sink = await collector(404)
    setEnv('OTEL_EXPORTER_OTLP_ENDPOINT', sink.endpoint)
    const exporter = await createPiOtlpTelemetry(credentials)
    exporter!.emit(session, event())
    await exporter!.shutdown()
    await sink.close()
    expect(seen.map(f => f.reason)).toEqual(['not-found'])
  })

  test('control — a 200 produces no diagnostic and no dropped batch', async () => {
    const seen: OtlpExportFailure[] = []
    setOtlpExportDiagnosticSink(f => { seen.push(f) })
    const sink = await collector(200)
    setEnv('OTEL_EXPORTER_OTLP_ENDPOINT', sink.endpoint)
    const exporter = await createPiOtlpTelemetry(credentials)
    exporter!.emit(session, event())
    await exporter!.shutdown()
    await sink.close()
    expect(seen).toEqual([])
    expect(readOtlpDroppedBatches('logs')).toBe(0)
  })
})

describe('M32 — the operator\'s service name and resource attributes reach the wire', () => {
  test('OTEL_SERVICE_NAME replaces the hardcoded literal', async () => {
    const sink = await collector()
    setEnv('OTEL_EXPORTER_OTLP_ENDPOINT', sink.endpoint)
    setEnv('OTEL_SERVICE_NAME', 'nessy-desktop-eu')
    const exporter = await createPiOtlpTelemetry(credentials)
    exporter!.emit(session, event())
    await exporter!.shutdown()
    await sink.close()
    expect(resourceAttributes(sink.bodies[0]!)['service.name']).toBe('nessy-desktop-eu')
  })

  test('the page\'s own example is queryable on the record', async () => {
    const sink = await collector()
    setEnv('OTEL_EXPORTER_OTLP_ENDPOINT', sink.endpoint)
    setEnv('OTEL_RESOURCE_ATTRIBUTES', 'department=engineering,team.id=platform,cost_center=eng-123')
    const exporter = await createPiOtlpTelemetry(credentials)
    exporter!.emit(session, event())
    await exporter!.shutdown()
    await sink.close()
    const attrs = resourceAttributes(sink.bodies[0]!)
    expect(attrs['team.id']).toBe('platform')
    expect(attrs['department']).toBe('engineering')
    expect(attrs['cost_center']).toBe('eng-123')
    // Default service name survives when only the attributes are set.
    expect(attrs['service.name']).toBe('nessy-desktop')
  })

  test('the coverage marker is NOT overridable by an operator pair', async () => {
    const sink = await collector()
    setEnv('OTEL_EXPORTER_OTLP_ENDPOINT', sink.endpoint)
    setEnv('OTEL_RESOURCE_ATTRIBUTES', 'nessy.telemetry.coverage=everything,team.id=platform')
    const exporter = await createPiOtlpTelemetry(credentials)
    exporter!.emit(session, event())
    await exporter!.shutdown()
    await sink.close()
    const attrs = resourceAttributes(sink.bodies[0]!)
    // Ours wins: this attribute describes OUR stream's residue, and a false
    // claim here would misdescribe exactly what P6.42 added it to keep honest.
    expect(attrs['nessy.telemetry.coverage']).toBe('pi-sessions-only')
    expect(attrs['team.id']).toBe('platform')
  })

  test('unit — service.name cannot be shadowed through the attribute list either', () => {
    const attrs = otlpResourceAttributes({
      OTEL_SERVICE_NAME: 'chosen',
      OTEL_RESOURCE_ATTRIBUTES: 'service.name=sneaky,ok=1,,malformed',
    })
    const byKey = Object.fromEntries(attrs.map(a => [a.key, a.value.stringValue]))
    expect(byKey['service.name']).toBe('chosen')
    expect(byKey['ok']).toBe('1')
    // P6.461's namespace mapping rides every resource, so the count is 3, not 2.
    expect(byKey[METRIC_NAMESPACE_UPSTREAM_ATTRIBUTE]).toBe('claude_code')
    expect(attrs).toHaveLength(3)
  })

  test('P6.461 — the namespace mapping cannot be shadowed by an operator pair either', () => {
    // The attribute describes OUR stream: an operator who spelled it would be
    // asserting which upstream namespace we replaced, which is not theirs to say.
    const attrs = otlpResourceAttributes({
      OTEL_RESOURCE_ATTRIBUTES: `${METRIC_NAMESPACE_UPSTREAM_ATTRIBUTE}=something-else,team.id=platform`,
    })
    const byKey = Object.fromEntries(attrs.map(a => [a.key, a.value.stringValue]))
    expect(byKey[METRIC_NAMESPACE_UPSTREAM_ATTRIBUTE]).toBe('claude_code')
    expect(byKey['team.id']).toBe('platform')
  })
})

describe('M39 — a client certificate, read from the names the page gives THIS protocol', () => {
  test('both halves present are read off disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'otlp-mtls-'))
    try {
      writeFileSync(join(dir, 'c.pem'), 'CERT-BODY')
      writeFileSync(join(dir, 'k.pem'), 'KEY-BODY')
      const tls = resolveOtlpClientTls(
        {
          CLAUDE_CODE_CLIENT_CERT: join(dir, 'c.pem'),
          CLAUDE_CODE_CLIENT_KEY: join(dir, 'k.pem'),
          CLAUDE_CODE_CLIENT_KEY_PASSPHRASE: 'secret',
        },
        p => readFileSync(p, 'utf8'),
      )
      expect(tls).toEqual({ cert: 'CERT-BODY', key: 'KEY-BODY', passphrase: 'secret' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('one half alone is a named refusal, never a silent plaintext fallback', () => {
    const reasons: string[] = []
    const tls = resolveOtlpClientTls(
      { CLAUDE_CODE_CLIENT_CERT: '/nope/c.pem' },
      () => 'unused',
      r => reasons.push(r),
    )
    expect(tls).toBeUndefined()
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain('CLAUDE_CODE_CLIENT_KEY')
  })

  test('an unreadable pair is reported by PATH and never by content', () => {
    const reasons: string[] = []
    const tls = resolveOtlpClientTls(
      { CLAUDE_CODE_CLIENT_CERT: '/nope/c.pem', CLAUDE_CODE_CLIENT_KEY: '/nope/k.pem' },
      () => { throw new Error('ENOENT') },
      r => reasons.push(r),
    )
    expect(tls).toBeUndefined()
    expect(reasons[0]).toContain('/nope/c.pem')
  })

  test('the grpc-protocol names are deliberately NOT read here', () => {
    // `monitoring-usage.md#mtls-authentication` assigns
    // OTEL_EXPORTER_OTLP_CLIENT_KEY/_CLIENT_CERTIFICATE to the grpc row; both
    // host exporters speak OTLP/HTTP JSON. Reading them would claim support for
    // a protocol these exporters do not speak.
    const tls = resolveOtlpClientTls(
      { OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE: '/c.pem', OTEL_EXPORTER_OTLP_CLIENT_KEY: '/k.pem' },
      () => 'unused',
    )
    expect(tls).toBeUndefined()
  })

  test('control — nothing configured is not a failure', () => {
    const reasons: string[] = []
    expect(resolveOtlpClientTls({}, () => 'unused', r => reasons.push(r))).toBeUndefined()
    expect(reasons).toEqual([])
  })
})

/**
 * P6.538 — owner D13 = option B: identity behind the documented toggles,
 * DEFAULT OFF, under the vendor's own switch name.
 */
describe('P6.538 — a Pi record may name its session, and only behind the switch', () => {
  function logAttributes(body: string): Record<string, string> {
    const attrs = JSON.parse(body).resourceLogs[0].scopeLogs[0].logRecords[0].attributes as
      Array<{ key: string; value: { stringValue: string } }>
    return Object.fromEntries(attrs.map(a => [a.key, a.value.stringValue]))
  }

  test('off by default: the record carries the digest and no id', async () => {
    const sink = await collector()
    try {
      setEnv('OTEL_EXPORTER_OTLP_ENDPOINT', sink.endpoint)
      const telemetry = await createPiOtlpTelemetry(credentials)
      telemetry!.emit(session, event())
      await telemetry!.shutdown()
      const attributes = logAttributes(sink.bodies[0]!)
      expect(attributes.sessionHash).toMatch(/^[0-9a-f]{64}$/)
      expect(attributes['session.id']).toBeUndefined()
      // The whole point of "default off": the session id must not be anywhere
      // in the payload, under any key.
      expect(sink.bodies[0]).not.toContain('"s"')
    } finally {
      await sink.close()
    }
  })

  test('on: the id rides under the PAGE\'s own attribute name, BESIDE the digest', async () => {
    const sink = await collector()
    try {
      setEnv('OTEL_EXPORTER_OTLP_ENDPOINT', sink.endpoint)
      setEnv('OTEL_METRICS_INCLUDE_SESSION_ID', 'true')
      const telemetry = await createPiOtlpTelemetry(credentials)
      telemetry!.emit(session, event())
      await telemetry!.shutdown()
      const attributes = logAttributes(sink.bodies[0]!)
      // `monitoring-usage.md#standard-attributes` calls it `session.id`, so a
      // backend already grouping claude exports by that key groups these too.
      expect(attributes['session.id']).toBe('s')
      // ADDITIVE: nothing an existing dashboard groups by moved.
      expect(attributes.sessionHash).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      await sink.close()
    }
  })

  test('the standard opt-out still beats it, and an unreadable value is OFF', async () => {
    // A value we cannot read must never resolve toward disclosure.
    const sink = await collector()
    try {
      setEnv('OTEL_EXPORTER_OTLP_ENDPOINT', sink.endpoint)
      setEnv('OTEL_METRICS_INCLUDE_SESSION_ID', 'sometimes')
      const telemetry = await createPiOtlpTelemetry(credentials)
      telemetry!.emit(session, event())
      await telemetry!.shutdown()
      expect(logAttributes(sink.bodies[0]!)['session.id']).toBeUndefined()
    } finally {
      await sink.close()
    }
  })

  test('the widened key set is what keeps the stream alive when the switch flips', async () => {
    // The sequencing hazard this row carries: `validEvent` runs
    // `exact(input, EVENT_KEYS)` and DROPS an unexpected key SILENTLY. Had
    // `sessionId` been emitted without widening that set, turning the toggle on
    // would have turned the whole Pi stream OFF and looked like a quiet week.
    const sink = await collector()
    try {
      setEnv('OTEL_EXPORTER_OTLP_ENDPOINT', sink.endpoint)
      setEnv('OTEL_METRICS_INCLUDE_SESSION_ID', '1')
      const telemetry = await createPiOtlpTelemetry(credentials)
      telemetry!.emit(session, event())
      await telemetry!.shutdown()
      expect(sink.bodies).toHaveLength(1)
    } finally {
      await sink.close()
    }
  })
})
