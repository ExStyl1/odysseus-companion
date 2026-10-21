/**
 * P6.452 M21 and M38 — the two OTLP controls that act on the claude CHILD's
 * environment rather than on our own exporters.
 *
 * M21 is a decision made where the documentation runs out: `console` is a
 * documented value of all three exporter selectors, and on a terminal it is a
 * debugging affordance — but this child is spawned headless and its stdout is
 * the transport the SDK reads. The corruption is PREDICTED, not observed, so the
 * change is the smallest one that can be true: drop the one colliding value,
 * pass everything else through, say so.
 *
 * M38 is the opposite kind: three rules quoted verbatim from
 * `monitoring-usage.md#how-managed-settings-lock-the-otlp-destination`, plus the
 * exception in the same section. What makes them implementable at all is
 * PROVENANCE — `isManagedOriginEnvVar` — because without it "developer-set" and
 * "administrator-set" are indistinguishable and the rule would delete the
 * administrator's own per-signal routing. The last test here is that exception.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { buildClaudeSubprocessEnv } from '../options.ts'
import { applyManagedEnv, clearManagedOriginEnvVars } from '../../config/managed-env.ts'

const TOUCHED = [
  'NESSY_ENABLE_TELEMETRY',
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'DO_NOT_TRACK',
  'DISABLE_TELEMETRY',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_PROPAGATE_TRACEPARENT',
  'OTEL_METRICS_INCLUDE_SESSION_ID',
  'OTEL_METRICS_INCLUDE_ACCOUNT_UUID',
  'OTEL_METRICS_EXPORTER',
  'OTEL_LOGS_EXPORTER',
  'OTEL_TRACES_EXPORTER',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_OTLP_CLIENT_KEY',
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_PROTOCOL',
  'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
  'OTEL_EXPORTER_OTLP_LOGS_HEADERS',
]

const prior = new Map(TOUCHED.map(name => [name, process.env[name]]))

function setEnv(name: string, value: string | undefined): void {
  delete process.env[name]
  if (value !== undefined) process.env[name] = value
}

/**
 * Write a variable the way a managed source does, so its ORIGIN is recorded.
 *
 * NO explicit `target`. `writeResolution` registers managed origin only when it
 * writes the REAL `process.env` — "a caller passing its own target is
 * projecting an environment for something else and must not claim managed
 * origin here" — so passing `target: process.env` looks identical and records
 * nothing, and every assertion below would pass vacuously.
 */
function setManaged(values: Record<string, string>): void {
  applyManagedEnv(values, { source: 'managed-file', confirmed: true })
}

beforeEach(() => {
  clearManagedOriginEnvVars()
  for (const name of TOUCHED) setEnv(name, undefined)
})

afterEach(() => {
  clearManagedOriginEnvVars()
  for (const name of TOUCHED) setEnv(name, prior.get(name))
})

describe('P6.452 M21 — a `console` exporter cannot reach the child', () => {
  it('drops it from all three selectors, not the two the row named', () => {
    for (const name of ['OTEL_METRICS_EXPORTER', 'OTEL_LOGS_EXPORTER', 'OTEL_TRACES_EXPORTER']) {
      setEnv(name, 'console')
    }
    const env = buildClaudeSubprocessEnv()
    expect(env.OTEL_METRICS_EXPORTER).toBeUndefined()
    expect(env.OTEL_LOGS_EXPORTER).toBeUndefined()
    expect(env.OTEL_TRACES_EXPORTER).toBeUndefined()
  })

  it('keeps the rest of a comma-separated list', () => {
    // `monitoring-usage.md`'s own example is `console,otlp`. Dropping the whole
    // variable there would silently turn the operator's real exporter off.
    setEnv('OTEL_METRICS_EXPORTER', 'console,otlp')
    expect(buildClaudeSubprocessEnv().OTEL_METRICS_EXPORTER).toBe('otlp')
  })

  it('leaves every other value alone, `none` included', () => {
    // `none` is our own `otelExporterDisabled`'s only recognised spelling and an
    // operator's way to turn a signal off — narrowing it would be a new defect.
    setEnv('OTEL_LOGS_EXPORTER', 'none')
    setEnv('OTEL_METRICS_EXPORTER', 'prometheus')
    const env = buildClaudeSubprocessEnv()
    expect(env.OTEL_LOGS_EXPORTER).toBe('none')
    expect(env.OTEL_METRICS_EXPORTER).toBe('prometheus')
  })

  it('is case- and space-insensitive about the value it drops', () => {
    setEnv('OTEL_LOGS_EXPORTER', ' Console , otlp ')
    expect(buildClaudeSubprocessEnv().OTEL_LOGS_EXPORTER).toBe('otlp')
  })
})

describe('P6.452 M38 — managed settings lock the OTLP destination', () => {
  it('a managed generic ENDPOINT removes every developer-set per-signal endpoint', () => {
    setEnv('OTEL_EXPORTER_OTLP_METRICS_ENDPOINT', 'https://developer.example/metrics')
    setManaged({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://managed.example' })
    const env = buildClaudeSubprocessEnv()
    expect(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT).toBeUndefined()
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://managed.example')
  })

  it('a managed generic PROTOCOL removes every developer-set per-signal protocol', () => {
    setEnv('OTEL_EXPORTER_OTLP_METRICS_PROTOCOL', 'grpc')
    setManaged({ OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json' })
    expect(buildClaudeSubprocessEnv().OTEL_EXPORTER_OTLP_METRICS_PROTOCOL).toBeUndefined()
  })

  it('a managed credential removes the GENERIC developer endpoint too, not only per-signal', () => {
    // The clause a per-signal-only reading misses, and the one that actually
    // lets an administrator's credential reach an unapproved collector.
    setEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'https://developer.example')
    setEnv('OTEL_EXPORTER_OTLP_METRICS_ENDPOINT', 'https://developer.example/metrics')
    setEnv('OTEL_EXPORTER_OTLP_METRICS_HEADERS', 'x-dev=1')
    setManaged({ OTEL_EXPORTER_OTLP_HEADERS: 'authorization=managed' })
    const env = buildClaudeSubprocessEnv()
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined()
    expect(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT).toBeUndefined()
    expect(env.OTEL_EXPORTER_OTLP_METRICS_HEADERS).toBeUndefined()
    expect(env.OTEL_EXPORTER_OTLP_HEADERS).toBe('authorization=managed')
  })

  it('does NOT remove a per-signal variable the administrator set themselves', () => {
    // The page's own exception: "Claude Code doesn't remove per-signal variables
    // that you set in managed settings itself". Without provenance this test is
    // the one that fails, and it fails by deleting the administrator's routing.
    setManaged({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://managed.example',
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://managed.example/siem',
    })
    expect(buildClaudeSubprocessEnv().OTEL_EXPORTER_OTLP_LOGS_ENDPOINT)
      .toBe('https://managed.example/siem')
  })

  it('a managed PER-SIGNAL credential removes the developer endpoint for that signal only', () => {
    setEnv('OTEL_EXPORTER_OTLP_LOGS_ENDPOINT', 'https://developer.example/logs')
    setEnv('OTEL_EXPORTER_OTLP_METRICS_ENDPOINT', 'https://developer.example/metrics')
    setManaged({ OTEL_EXPORTER_OTLP_LOGS_HEADERS: 'authorization=managed' })
    const env = buildClaudeSubprocessEnv()
    expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBeUndefined()
    // Untouched: the rule is scoped to that signal.
    expect(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT).toBe('https://developer.example/metrics')
  })

  it('with no managed telemetry variable at all, a developer environment is untouched', () => {
    // The control. Every removal above must be caused by the managed source and
    // by nothing else.
    setEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'https://developer.example')
    setEnv('OTEL_EXPORTER_OTLP_METRICS_ENDPOINT', 'https://developer.example/metrics')
    const env = buildClaudeSubprocessEnv()
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://developer.example')
    expect(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT).toBe('https://developer.example/metrics')
  })
})

/**
 * P6.459 M30 — the propagation switch the host has to name, because the
 * documented one is stripped from this child for unrelated reasons.
 */
describe('P6.459 M30 — CLAUDE_CODE_PROPAGATE_TRACEPARENT', () => {
  it('is set when telemetry is opted in AND a traces exporter is selected', () => {
    setEnv('NESSY_ENABLE_TELEMETRY', '1')
    setEnv('OTEL_TRACES_EXPORTER', 'otlp')
    expect(buildClaudeSubprocessEnv().CLAUDE_CODE_PROPAGATE_TRACEPARENT).toBe('1')
    // And it survives the spread that actually builds the child's environment —
    // the Bun slot trap makes "readable by property" and "present in a spread"
    // two different questions.
    expect({ ...buildClaudeSubprocessEnv() }.CLAUDE_CODE_PROPAGATE_TRACEPARENT).toBe('1')
  })

  it('is NOT set when nobody is collecting traces', () => {
    // The whole negative surface, one case each. A trace id pushed into every
    // shell command of an untraced session is an identifier leaving this
    // process for no collector to read.
    setEnv('NESSY_ENABLE_TELEMETRY', '1')
    // (a) no traces selector at all — traces are opt-in per signal.
    expect(buildClaudeSubprocessEnv().CLAUDE_CODE_PROPAGATE_TRACEPARENT).toBeUndefined()
    // (b) the signal turned off by name.
    setEnv('OTEL_TRACES_EXPORTER', 'none')
    expect(buildClaudeSubprocessEnv().CLAUDE_CODE_PROPAGATE_TRACEPARENT).toBeUndefined()
    // (c) selected, but telemetry itself never opted in.
    setEnv('OTEL_TRACES_EXPORTER', 'otlp')
    setEnv('NESSY_ENABLE_TELEMETRY', undefined)
    expect(buildClaudeSubprocessEnv().CLAUDE_CODE_PROPAGATE_TRACEPARENT).toBeUndefined()
    // (d) the standard opt-out beats the opt-in, here as everywhere else.
    setEnv('NESSY_ENABLE_TELEMETRY', '1')
    setEnv('DO_NOT_TRACK', '1')
    expect(buildClaudeSubprocessEnv().CLAUDE_CODE_PROPAGATE_TRACEPARENT).toBeUndefined()
  })

  it('a `console`-only traces selector does not turn propagation on', () => {
    // M21 deletes that variable one line earlier, so there is no trace stream
    // for a propagated context to join. The ORDER of the two rules is the
    // assertion.
    setEnv('NESSY_ENABLE_TELEMETRY', '1')
    setEnv('OTEL_TRACES_EXPORTER', 'console')
    const env = buildClaudeSubprocessEnv()
    expect(env.OTEL_TRACES_EXPORTER).toBeUndefined()
    expect(env.CLAUDE_CODE_PROPAGATE_TRACEPARENT).toBeUndefined()
  })

  it('never overrules an operator who set the name themselves', () => {
    setEnv('NESSY_ENABLE_TELEMETRY', '1')
    setEnv('OTEL_TRACES_EXPORTER', 'otlp')
    setEnv('CLAUDE_CODE_PROPAGATE_TRACEPARENT', '0')
    // This fills a hole; it does not decide for someone who already decided.
    expect(buildClaudeSubprocessEnv().CLAUDE_CODE_PROPAGATE_TRACEPARENT).toBe('0')
  })
})

/**
 * P6.538 — the child's identity attributes are the HOST's answer, and the
 * default is the opposite of the vendor's.
 */
describe('P6.538 — OTEL_METRICS_INCLUDE_SESSION_ID / _ACCOUNT_UUID on the child', () => {
  it('pins BOTH to false by default, inverting the documented default: true', () => {
    // `monitoring-usage.md#standard-attributes` gives both as "(default: true)",
    // and this file spreads `process.env` unfiltered — so before this row, an
    // operator with telemetry on was exporting `session.id`,
    // `user.account_uuid` and `user.account_id` from every claude session while
    // `usage-metrics.ts`'s header said nothing personal left the machine.
    const env = buildClaudeSubprocessEnv()
    expect(env.OTEL_METRICS_INCLUDE_SESSION_ID).toBe('false')
    expect(env.OTEL_METRICS_INCLUDE_ACCOUNT_UUID).toBe('false')
  })

  it('is written EXPLICITLY rather than deleted, so an upstream default flip cannot leak', () => {
    // The same shape `config-writer.ts` uses for codex's `log_user_prompt`: a
    // missing variable inherits whatever the vendor decides next.
    const spread = { ...buildClaudeSubprocessEnv() }
    expect('OTEL_METRICS_INCLUDE_SESSION_ID' in spread).toBe(true)
    expect('OTEL_METRICS_INCLUDE_ACCOUNT_UUID' in spread).toBe(true)
  })

  it('follows the operator through, per switch, when they turn one on', () => {
    setEnv('OTEL_METRICS_INCLUDE_SESSION_ID', 'true')
    const env = buildClaudeSubprocessEnv()
    expect(env.OTEL_METRICS_INCLUDE_SESSION_ID).toBe('true')
    // The other switch is independent — turning one on must not turn the other on.
    expect(env.OTEL_METRICS_INCLUDE_ACCOUNT_UUID).toBe('false')
  })

  it('resolves an unreadable value toward OFF, never toward disclosure', () => {
    setEnv('OTEL_METRICS_INCLUDE_ACCOUNT_UUID', 'sometimes')
    expect(buildClaudeSubprocessEnv().OTEL_METRICS_INCLUDE_ACCOUNT_UUID).toBe('false')
  })
})
