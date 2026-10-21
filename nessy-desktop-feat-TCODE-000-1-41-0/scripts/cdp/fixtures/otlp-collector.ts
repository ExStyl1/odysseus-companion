/**
 * A loopback OTLP/HTTP collector that records WHICH signals arrived and WHOSE
 * they say they are — the instrument D1.207 names and the harness did not ship.
 *
 * ## Why a repo file rather than a lane's throwaway
 *
 * The same argument `fixtures/refusing-proxy.ts` makes for itself. P2.450 drove
 * codex's `/v1/logs` stream through a collector written outside the tree; D1.207
 * asks for the same reading on `/v1/traces`, and the next row will ask for
 * metrics. Three readings through three unreviewable servers is three readings
 * nobody can check. This one is reviewable and its log is a fixed shape.
 *
 * ## It records the RESOURCE and never a body
 *
 * An OTLP payload carries the telemetry itself: span names, log records, and —
 * on a runtime configured to do so — prompt text. Codex's `log_user_prompt`
 * defaults off and this fixture does not depend on that: it walks only
 * `resourceSpans[].resource.attributes` / `resourceLogs[].resource.attributes` /
 * `resourceMetrics[].resource.attributes`, keeps every attribute KEY, and keeps a
 * VALUE only for the keys in {@link RECORDED_VALUE_KEYS} — identity attributes
 * that name the emitter, never its content. Everything else is counted.
 *
 * So the log answers "a trace arrived, its resource says `session.id = X`" and
 * cannot answer "and the user asked it about Y". That is exactly the question
 * D1.207 puts, and it is the whole of what a run narrative should be able to
 * quote.
 *
 * ## It answers 200 with an empty JSON object
 *
 * OTLP/HTTP's success shape for a JSON request. A collector that refused would
 * make every reading below a reading about a retry loop.
 *
 * ## Both encodings, and only one is parsed
 *
 * `otel/src/config.rs` resolves to OTLP/HTTP **JSON** in a release build, which
 * is what the parser here expects. A protobuf body is still RECORDED — the path,
 * the byte count and `parsed: false` — because "a request arrived and I could not
 * read it" and "no request arrived" are different findings and the second is the
 * one a case would otherwise bank.
 */

import { appendFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'

/**
 * Attribute keys whose VALUE is written down.
 *
 * Identity only. `session.id` is D1.207's whole subject; the other three are what
 * a reader needs to tell one emitter from another when two runtimes are pointed
 * at one collector.
 */
export const RECORDED_VALUE_KEYS: ReadonlySet<string> = new Set([
  'session.id',
  'service.name',
  'service.version',
  'terminal.type',
])

/** One request, as the JSONL log writes it. */
export interface OtlpCollectorLine {
  /** ISO timestamp — the window a case slices by. */
  t: string
  /** `traces` | `logs` | `metrics` | the raw path for anything else. */
  signal: string
  /** Bytes received, so an empty POST is distinguishable from a full one. */
  bytes: number
  /** False when the body was not JSON this fixture could walk (e.g. protobuf). */
  parsed: boolean
  /** Every resource attribute KEY seen, deduplicated and sorted. */
  resourceKeys: string[]
  /** The values of {@link RECORDED_VALUE_KEYS} only. */
  identity: Record<string, string>
  /** How many resource blocks the payload carried. */
  resources: number
}

export interface OtlpCollector {
  /** What goes into `OTEL_EXPORTER_OTLP_ENDPOINT`. */
  url: string
  port: number
  /** The JSONL log path — the detector a case reads. */
  logPath: string
  /** Everything recorded so far, parsed. */
  lines: () => OtlpCollectorLine[]
  stop: () => Promise<void>
}

function signalOf(path: string): string {
  if (path.endsWith('/v1/traces')) return 'traces'
  if (path.endsWith('/v1/logs')) return 'logs'
  if (path.endsWith('/v1/metrics')) return 'metrics'
  return path
}

/** An OTLP `AnyValue`, reduced to a string, without walking into arrays or maps. */
function scalar(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  for (const key of ['stringValue', 'intValue', 'doubleValue', 'boolValue']) {
    if (v[key] !== undefined) return String(v[key])
  }
  return undefined
}

interface Walked { resourceKeys: string[]; identity: Record<string, string>; resources: number }

/**
 * Walk the three `resource*` envelopes and nothing else.
 *
 * Deliberately not generic: a recursive walk over an OTLP payload would reach the
 * records, which is what this fixture exists not to read.
 */
export function walkResources(payload: unknown): Walked {
  const keys = new Set<string>()
  const identity: Record<string, string> = {}
  let resources = 0
  const root = (payload ?? {}) as Record<string, unknown>
  for (const envelope of ['resourceSpans', 'resourceLogs', 'resourceMetrics']) {
    const blocks = root[envelope]
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      const resource = (block as Record<string, unknown>)?.resource as Record<string, unknown> | undefined
      if (!resource) continue
      resources += 1
      const attributes = resource.attributes
      if (!Array.isArray(attributes)) continue
      for (const attribute of attributes) {
        const a = attribute as Record<string, unknown>
        const key = typeof a?.key === 'string' ? a.key : undefined
        if (!key) continue
        keys.add(key)
        if (!RECORDED_VALUE_KEYS.has(key)) continue
        const value = scalar(a.value)
        if (value !== undefined) identity[key] = value
      }
    }
  }
  return { resourceKeys: [...keys].sort(), identity, resources }
}

export interface OtlpCollectorOptions {
  port?: number
  /** Required: the log IS the detector. */
  logPath: string
}

export function startOtlpCollector(options: OtlpCollectorOptions): OtlpCollector {
  const seen: OtlpCollectorLine[] = []
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      const body = Buffer.concat(chunks)
      let walked: Walked = { resourceKeys: [], identity: {}, resources: 0 }
      let parsed = false
      try {
        walked = walkResources(JSON.parse(body.toString('utf8')))
        parsed = true
      } catch {
        parsed = false
      }
      const line: OtlpCollectorLine = {
        t: new Date().toISOString(),
        signal: signalOf(request.url ?? ''),
        bytes: body.byteLength,
        parsed,
        resourceKeys: walked.resourceKeys,
        identity: walked.identity,
        resources: walked.resources,
      }
      seen.push(line)
      try {
        appendFileSync(options.logPath, `${JSON.stringify(line)}\n`)
      } catch {
        // A log that cannot be written is the case's problem to notice through an
        // empty file, not this server's to crash on mid-request.
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{}')
    })
  })
  server.on('error', error => {
    console.error(`otlp-collector: ${(error as Error).message} — is a previous run still listening on that port?`)
    process.exitCode = 2
  })
  server.listen(options.port ?? 0, '127.0.0.1')

  const addressPort = (): number => {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('otlp-collector: the server reported no port')
    return address.port
  }

  return {
    get url() { return `http://127.0.0.1:${addressPort()}` },
    get port() { return addressPort() },
    logPath: options.logPath,
    lines: () => [...seen],
    stop: () => new Promise<void>(resolve => { server.close(() => resolve()) }),
  }
}

if (import.meta.main) {
  const portArgument = process.argv.indexOf('--port')
  const asked = portArgument >= 0 ? process.argv[portArgument + 1] : process.env.PORT
  const logArgument = process.argv.indexOf('--log')
  const logPath = logArgument >= 0 ? process.argv[logArgument + 1] : process.env.NESSY_CDP_OTLP_LOG
  if (!logPath) {
    console.error('otlp-collector: pass --log <path> (or NESSY_CDP_OTLP_LOG) — the log IS the detector')
    process.exit(2)
  }
  const collector = startOtlpCollector({ port: Number(asked ?? 0) || 0, logPath })
  setTimeout(() => {
    console.error(`otlp-collector listening on ${collector.url}, log ${collector.logPath}`)
    console.error('it records resource ATTRIBUTES only — never a span, a log record or a prompt')
  }, 50)
}
