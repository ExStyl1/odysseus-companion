import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createPiOtlpTelemetry, parseConfig } from './otlp-telemetry.ts'

const ENV_KEYS = [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_OTLP_TIMEOUT',
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
  'OTEL_LOGS_EXPORTER',
  'OTEL_METRICS_EXPORTER',
  'NESSY_ENABLE_TELEMETRY',
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'DO_NOT_TRACK',
  'DISABLE_TELEMETRY',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
] as const
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]])) as Record<(typeof ENV_KEYS)[number], string | undefined>
const session = { workspaceId: 'workspace-private', sessionId: 'session-private' }

interface CapturedRequest {
  path: string
  headers: IncomingHttpHeaders
  body: string
}

interface TestCredentials {
  readonly manager: Parameters<typeof createPiOtlpTelemetry>[0]
  readonly gets: () => number
  readonly sets: () => number
  readonly salt: () => string | undefined
}

function credentials(initial?: string): TestCredentials {
  let value = initial
  let getCount = 0
  let setCount = 0
  return {
    manager: {
      get: async () => {
        getCount += 1
        return value ? { value } : null
      },
      set: async (_id, credential) => {
        setCount += 1
        value = credential.value
      },
    },
    gets: () => getCount,
    sets: () => setCount,
    salt: () => value,
  }
}

/**
 * A handler returning `'defer'` takes ownership of the response: the auto-200
 * below is skipped and the case answers, or never answers, on its own.
 *
 * P2.424 — this exists because the fallback is EAGER. It runs synchronously
 * right after the handler returns, so a handler that only *schedules* a reply
 * (`setTimeout(() => response.end(), 30)`, which is what the timeout case did
 * until now) never delays anything: the 200 is already on the wire and the
 * handler's timer later fires against an already-ended response. A case that
 * needs the client to be cut off by its own timeout cannot get there by
 * delaying — it has to hold the response.
 */
type CollectorHandler = (request: CapturedRequest, response: ServerResponse) => void | 'defer'

async function collector(handler?: CollectorHandler): Promise<{
  endpoint: string
  requests: CapturedRequest[]
  close(): Promise<void>
}> {
  const requests: CapturedRequest[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const captured = { path: request.url ?? '', headers: request.headers, body }
      requests.push(captured)
      const deferred = handler?.(captured, response) === 'defer'
      if (!deferred && !response.writableEnded) response.writeHead(200).end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}

function event(semanticId = 'tool-1') {
  return {
    schemaVersion: 1 as const,
    name: 'tool.completed' as const,
    timestamp: 1234,
    outcome: 'success' as const,
    durationMs: 4,
    semanticId,
  }
}

function hmac(salt: string, value: string): string {
  return createHmac('sha256', Buffer.from(salt, 'hex')).update(value).digest('hex')
}

function records(request: CapturedRequest): Array<Record<string, unknown>> {
  const payload = JSON.parse(request.body)
  return payload.resourceLogs[0].scopeLogs[0].logRecords
}

function resource(request: CapturedRequest): { attributes: Array<{ key: string; value: { stringValue: string } }> } {
  return JSON.parse(request.body).resourceLogs[0].resource
}

function attribute(record: Record<string, unknown>, key: string): string | undefined {
  const values = record.attributes as Array<{ key: string; value: { stringValue: string } }>
  return values.find(value => value.key === key)?.value.stringValue
}

// Every behaviour test below is about what a CONFIGURED exporter does, so they
// all run opted in. The gate itself is the suite at the bottom, which clears
// this. `monitoring-usage.md:94` makes the opt-in required, so without it none of
// these would build an exporter at all.
beforeEach(() => {
  process.env.NESSY_ENABLE_TELEMETRY = '1'
  // And opted IN: the standard opt-out is now a hard disable, so an ambient
  // `DO_NOT_TRACK` in the runner's own shell would otherwise silently turn every
  // behaviour test below into a no-exporter test that still passed its
  // `toBeUndefined` neighbours. Cleared here, asserted deliberately in the gate
  // suite at the bottom.
  delete process.env.DO_NOT_TRACK
  delete process.env.DISABLE_TELEMETRY
  delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('Pi OTLP telemetry', () => {
  test('does nothing without an endpoint or with invalid configuration before salt creation', async () => {
    const disabled = credentials()
    expect(await createPiOtlpTelemetry(disabled.manager)).toBeUndefined()
    expect(disabled.gets()).toBe(0)
    expect(disabled.sets()).toBe(0)

    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'ftp://collector'
    const invalidEndpoint = credentials()
    expect(await createPiOtlpTelemetry(invalidEndpoint.manager)).toBeUndefined()
    expect(invalidEndpoint.gets()).toBe(0)
    expect(invalidEndpoint.sets()).toBe(0)

    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://collector'
    process.env.OTEL_EXPORTER_OTLP_HEADERS = 'invalid-header'
    const invalidHeaders = credentials()
    expect(await createPiOtlpTelemetry(invalidHeaders.manager)).toBeUndefined()
    expect(invalidHeaders.gets()).toBe(0)
    expect(invalidHeaders.sets()).toBe(0)
  })

  test('posts exact OTLP JSON to a base-preserving logs URL with HMAC identities only', async () => {
    const sink = await collector()
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `${sink.endpoint}/base/?ignored=true#fragment`
    process.env.OTEL_EXPORTER_OTLP_HEADERS = 'X-Collector=one%20two'
    const store = credentials()
    const telemetry = await createPiOtlpTelemetry(store.manager)
    telemetry!.emit(session, event())
    await telemetry!.shutdown()

    expect(sink.requests).toHaveLength(1)
    expect(sink.requests[0]!.path).toBe('/base/v1/logs')
    expect(sink.requests[0]!.headers['content-type']).toBe('application/json')
    expect(sink.requests[0]!.headers['x-collector']).toBe('one two')
    const payload = JSON.parse(sink.requests[0]!.body)
    expect(payload.resourceLogs[0].resource.attributes).toEqual([
      { key: 'service.name', value: { stringValue: 'nessy-desktop' } },
      { key: 'nessy.metric.namespace.upstream', value: { stringValue: 'claude_code' } },
      { key: 'nessy.telemetry.coverage', value: { stringValue: 'pi-sessions-only' } },
    ])
    expect(payload.resourceLogs[0].scopeLogs[0].scope).toEqual({ name: 'nessy.pi-harness' })
    const record = records(sink.requests[0]!)[0]!
    expect(record.timeUnixNano).toBe('1234000000')
    expect(record.body).toEqual({ stringValue: 'tool.completed' })
    expect(attribute(record, 'schemaVersion')).toBe('1')
    expect(attribute(record, 'workspaceHash')).toBe(hmac(store.salt()!, 'nessy.telemetry.workspace.v1\0workspace-private'))
    expect(attribute(record, 'sessionHash')).toBe(hmac(store.salt()!, 'nessy.telemetry.session.v1\0workspace-private\0session-private'))
    expect(attribute(record, 'outcome')).toBe('success')
    expect(attribute(record, 'durationMs')).toBe('4')
    expect(attribute(record, 'semanticId')).toBe('tool-1')
    for (const canary of ['workspace-private', 'session-private', store.salt()!, 'prompt', 'input', 'output', 'header', 'environment', 'secret']) {
      expect(sink.requests[0]!.body).not.toContain(canary)
    }
    await sink.close()
  })

  /**
   * C3.292 — `prompt.id` on the events stream.
   *
   * `monitoring-usage.md#event-correlation-attributes`: *"UUID v4 identifier
   * linking all events produced while processing a single user prompt"*, and
   * `hooks.md`'s `prompt_id` field says the two must match — *"Matches the
   * `prompt.id` attribute on OpenTelemetry events, so you can correlate hook
   * output with telemetry for a single prompt."* C3.197 filled the hook half;
   * this is the exporter half, and the two together are what makes that sentence
   * true in this product.
   *
   * Three arms, because each can fail on its own: the attribute is stamped under
   * the PAGE's spelling; it is ABSENT with no prompt (the page's *"Absent until
   * the first user input"*, which is by construction — the id is minted at the
   * top of `BaseAgent.chat`); and the SAME id rides every record of the turn,
   * which is the whole of what "correlating" means.
   */
  test('C3.292: prompt.id rides every record of a turn, under the page\'s own spelling', async () => {
    const sink = await collector()
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = sink.endpoint
    const telemetry = await createPiOtlpTelemetry(credentials().manager)
    const promptId = '3f0a1d2e-4b5c-4d6e-8f90-a1b2c3d4e5f6'
    telemetry!.emit({ ...session, promptId }, event('tool-a'))
    telemetry!.emit({ ...session, promptId }, event('tool-b'))
    // The cold-session record: no prompt has been submitted yet.
    telemetry!.emit(session, event('session-start'))
    await telemetry!.shutdown()

    const emitted = records(sink.requests[0]!)
    expect(emitted).toHaveLength(3)
    expect(emitted.map(record => attribute(record, 'prompt.id')))
      .toEqual([promptId, promptId, undefined])
    // Ours is never spelled beside it: the page's name is the whole point.
    expect(attribute(emitted[0]!, 'promptId')).toBeUndefined()
    await sink.close()
  })

  test('C3.292 CONTROL: a prompt id that is not SAFE_ID-shaped drops the whole record', async () => {
    const sink = await collector()
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = sink.endpoint
    const telemetry = await createPiOtlpTelemetry(credentials().manager)
    // The same guard `sessionId` and `semanticId` have, and the reason it
    // exists: no filesystem path can satisfy `SAFE_ID`, so nothing can arrive
    // here as an "id" that is really a path.
    telemetry!.emit({ ...session, promptId: '/Users/private/prompt' }, event('dropped'))
    telemetry!.emit({ ...session, promptId: 'safe-prompt-id' }, event('kept'))
    await telemetry!.shutdown()

    const emitted = records(sink.requests[0]!)
    expect(emitted).toHaveLength(1)
    expect(attribute(emitted[0]!, 'semanticId')).toBe('kept')
    expect(sink.requests[0]!.body).not.toContain('/Users/private')
    await sink.close()
  })

  test('rejects unsafe IDs and extra raw fields before enqueueing', async () => {
    const sink = await collector()
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = sink.endpoint
    const telemetry = await createPiOtlpTelemetry(credentials().manager)
    telemetry!.emit(session, event('safe-id'))
    telemetry!.emit(session, event('/Users/private') as never)
    telemetry!.emit(session, {
      ...event('unsafe'),
      prompt: 'secret prompt',
      input: { token: 'secret' },
      output: 'secret output',
      url: 'https://private.example',
      headers: { authorization: 'secret' },
      environment: { TOKEN: 'secret' },
      password: 'secret',
    } as never)
    await telemetry!.shutdown()

    expect(sink.requests).toHaveLength(1)
    expect(records(sink.requests[0]!)).toHaveLength(1)
    expect(attribute(records(sink.requests[0]!)[0]!, 'semanticId')).toBe('safe-id')
    expect(sink.requests[0]!.body).not.toContain('secret')
    await sink.close()
  })

  // P6.42. The Pi gate lives in `SessionManager.emitPiTelemetry`, one file away
  // and out of this suite's reach, so what is pinned here is the thing that keeps
  // the gate's residue HONEST rather than merely commented: the coverage the
  // stream claims travels on the wire, on EVERY batch, not just the first.
  //
  // Without it a SIEM cannot distinguish "no claude session did anything" from
  // "claude sessions are not on this stream at all" — the absence-reads-as-
  // nothing-happened failure that makes a partial audit stream worse than none.
  // Delete the attribute from `otlpPayload` and this goes red on batch 1 of 3.
  test('every batch states the stream coverage on its OTLP resource', async () => {
    const sink = await collector()
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = sink.endpoint
    const telemetry = await createPiOtlpTelemetry(credentials().manager)
    for (let index = 1; index <= 250; index += 1) telemetry!.emit(session, event(`event-${index}`))
    await telemetry!.shutdown()

    expect(sink.requests).toHaveLength(3)
    expect(sink.requests.map(request => resource(request).attributes)).toEqual(Array(3).fill([
      { key: 'service.name', value: { stringValue: 'nessy-desktop' } },
      // P6.461 — the namespace mapping rides every resource, in the position
      // `otlpResourceAttributes` appends it: after the operator's own pairs and
      // before the coverage marker.
      { key: 'nessy.metric.namespace.upstream', value: { stringValue: 'claude_code' } },
      { key: 'nessy.telemetry.coverage', value: { stringValue: 'pi-sessions-only' } },
    ]))
    await sink.close()
  })

  test('batches at 100 and drops the oldest queue record over 1,000', async () => {
    const sink = await collector()
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = sink.endpoint
    const telemetry = await createPiOtlpTelemetry(credentials().manager)
    for (let index = 1; index <= 1001; index += 1) telemetry!.emit(session, event(`event-${index}`))
    await telemetry!.shutdown()

    expect(sink.requests).toHaveLength(10)
    expect(sink.requests.map(request => records(request).length)).toEqual(Array(10).fill(100))
    const ids = sink.requests.flatMap(request => records(request).map(record => attribute(record, 'semanticId')))
    expect(ids[0]).toBe('event-2')
    expect(ids.at(-1)).toBe('event-1001')
    expect(ids).not.toContain('event-1')
    await sink.close()
  })

  test('retries only one 429 or 5xx response and never throws for 4xx or fetch failure', async () => {
    const statuses = [429, 200, 500, 200, 400]
    const sink = await collector((_request, response) => {
      const status = statuses.shift() ?? 200
      response.writeHead(status).end()
    })
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = sink.endpoint

    for (const semanticId of ['retry-429', 'retry-500', 'no-retry-400']) {
      const telemetry = await createPiOtlpTelemetry(credentials().manager)
      telemetry!.emit(session, event(semanticId))
      await telemetry!.shutdown()
    }
    expect(sink.requests).toHaveLength(5)
    expect(sink.requests.map(request => attribute(records(request)[0]!, 'semanticId'))).toEqual([
      'retry-429',
      'retry-429',
      'retry-500',
      'retry-500',
      'no-retry-400',
    ])

    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:1'
    const failed = await createPiOtlpTelemetry(credentials().manager)
    failed!.emit(session, event('fetch-failure'))
    await expect(failed!.shutdown()).resolves.toBeUndefined()
    await sink.close()
  })

  /**
   * P2.424 — this case used to set `OTEL_EXPORTER_OTLP_TIMEOUT = '1'`, one
   * millisecond, and then assert the request had been delivered. **Measured on
   * this rig with a fleet running (load average 15 on 8 CPUs), one loopback
   * POST costs p50 1.46 ms / p90 1.80 ms / max 3.47 ms from the moment
   * `AbortSignal.timeout` starts ticking to the moment the server has the
   * body** — so a 1 ms budget sat BELOW the median cost of the very thing it
   * was timing, and dropped the delivery outright in 2 of 25 and 9 of 40
   * sampled attempts. That is this repo's own recorded trap: a narrowing knob
   * sized against zero rather than against the system's resting state
   * manufactures its own failure.
   *
   * Two things were wrong and both are fixed here rather than by enlarging a
   * number. The collector now **holds** the response (see `CollectorHandler`),
   * so the export can only ever end by the configured timeout — where before,
   * whether the abort or the eager auto-200 won was a coin flip, which is why
   * the case's own name was not being tested. And the budget is 250 ms:
   * ~70× the worst delivery measured under load, still two orders of magnitude
   * below `DEFAULT_TIMEOUT_MS`, so it can only have come from the env var.
   */
  test('uses the configured timeout and awaits a partial shutdown flush', async () => {
    const held: ServerResponse[] = []
    const sink = await collector((_request, response) => {
      held.push(response)
      return 'defer'
    })
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = sink.endpoint
    process.env.OTEL_EXPORTER_OTLP_TIMEOUT = '250'
    const telemetry = await createPiOtlpTelemetry(credentials().manager)
    telemetry!.emit(session, event('timeout'))
    await expect(telemetry!.shutdown()).resolves.toBeUndefined()
    // The partial flush: the batch reached the collector even though the export
    // was cut off, and it was NOT retried — an aborted send returns rather than
    // falling through to the one retry a 429/5xx gets.
    expect(sink.requests).toHaveLength(1)
    // …and it was cut off, asserted without a clock: nothing ever answered this
    // request, so the configured timeout is the only thing that could have
    // ended it. A starved run makes this later, never differently.
    expect(held).toHaveLength(1)
    expect(held[0]!.writableEnded).toBe(false)
    for (const response of held) response.end()
    await sink.close()
  })
})

/**
 * The opt-in gate, asserted at the transport seam.
 *
 * The collector here is a loopback HTTP server this test owns; nothing in this
 * file ever addresses a real collector, and the env vars are restored after every
 * case so no exporter variable outlives the run.
 */
describe('Pi OTLP telemetry opt-in gate', () => {
  test('an ambient endpoint with no opt-in exports nothing', async () => {
    const sink = await collector()
    delete process.env.NESSY_ENABLE_TELEMETRY
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = sink.endpoint
    const store = credentials()

    // `monitoring-usage.md:94` — "Enables telemetry collection (required)". The
    // endpoint variable is ambient in many corporate shells, set for other tools.
    expect(await createPiOtlpTelemetry(store.manager)).toBeUndefined()
    // Nothing reached the transport, and no salt was even minted.
    expect(sink.requests).toEqual([])
    expect(store.gets()).toBe(0)
    expect(store.sets()).toBe(0)
    await sink.close()
  })

  test('the documented logs off-switch beats an explicit opt-in', async () => {
    const sink = await collector()
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = sink.endpoint
    // `:96` — "Logs/events exporter types, comma-separated. Use `none` to
    // disable". `none` anywhere in the list disables.
    for (const selector of ['none', 'otlp,none', ' NONE ']) {
      process.env.OTEL_LOGS_EXPORTER = selector
      expect(await createPiOtlpTelemetry(credentials().manager)).toBeUndefined()
    }
    expect(sink.requests).toEqual([])
    await sink.close()
  })

  test('the metrics selector does not silence the logs signal', async () => {
    const sink = await collector()
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = sink.endpoint
    // `:78` — the exporter selectors "follow normal per-key precedence". Each
    // signal has its own; turning metrics off says nothing about logs.
    process.env.OTEL_METRICS_EXPORTER = 'none'
    const telemetry = await createPiOtlpTelemetry(credentials().manager)
    telemetry!.emit(session, event('metrics-off'))
    await telemetry!.shutdown()
    expect(sink.requests).toHaveLength(1)
    await sink.close()
  })

  test('an opt-in with an endpoint exports, and the compat spelling counts', async () => {
    const sink = await collector()
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = sink.endpoint
    delete process.env.NESSY_ENABLE_TELEMETRY
    process.env.CLAUDE_CODE_ENABLE_TELEMETRY = '1'
    const telemetry = await createPiOtlpTelemetry(credentials().manager)
    telemetry!.emit(session, event('opted-in'))
    await telemetry!.shutdown()
    expect(sink.requests).toHaveLength(1)
    expect(sink.requests[0]!.path).toBe('/v1/logs')

    // The Nessy spelling wins when both are set, so an explicit local off is not
    // overridden by an inherited Claude opt-in.
    process.env.NESSY_ENABLE_TELEMETRY = '0'
    expect(await createPiOtlpTelemetry(credentials().manager)).toBeUndefined()
    expect(sink.requests).toHaveLength(1)
    await sink.close()
  })

  test('the standard opt-out beats the opt-in, asserted at the transport', async () => {
    // `env-vars.md#variables`, `DO_NOT_TRACK`: "Set to `1` to opt out of
    // telemetry, with the same effect as `DISABLE_TELEMETRY` … honors it as the
    // cross-tool convention recognized by many developer CLIs."
    //
    // This is the Pi signal, so it is the proof that the opt-out is NOT a
    // claude-runtime concern: before this gate existed, a Pi user who had opted
    // out machine-wide still shipped harness events off the box.
    const sink = await collector()
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = sink.endpoint

    // Positive control first — the same environment minus the opt-out DOES
    // export, so a later `toBeUndefined` is the opt-out and not a broken rig.
    const control = await createPiOtlpTelemetry(credentials().manager)
    control!.emit(session, event('control'))
    await control!.shutdown()
    expect(sink.requests).toHaveLength(1)

    for (const optOut of [
      { DO_NOT_TRACK: '1' },
      { DO_NOT_TRACK: 'TRUE' },
      { DISABLE_TELEMETRY: '1' },
      { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    ]) {
      for (const [key, value] of Object.entries(optOut)) process.env[key] = value
      const store = credentials()
      expect(await createPiOtlpTelemetry(store.manager)).toBeUndefined()
      // No salt is minted either: an opted-out machine writes nothing at all.
      expect(store.gets()).toBe(0)
      expect(store.sets()).toBe(0)
      for (const key of Object.keys(optOut)) delete process.env[key]
    }
    expect(sink.requests).toHaveLength(1)
    await sink.close()
  })

  test('the two value rules differ, and this is the boundary between them', () => {
    const enabled = { NESSY_ENABLE_TELEMETRY: '1', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' }
    // `DO_NOT_TRACK` is "a standard boolean, so `0` leaves telemetry on".
    expect(parseConfig({ ...enabled, DO_NOT_TRACK: '0' })).toBeDefined()
    expect(parseConfig({ ...enabled, DO_NOT_TRACK: '' })).toBeDefined()
    expect(parseConfig({ ...enabled, DO_NOT_TRACK: 'false' })).toBeDefined()
    // `DISABLE_TELEMETRY` is not: "**Setting it to `0` or `false` still opts
    // out** … unset the variable to turn telemetry back on." Same rule for
    // `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. Collapsing the two into one
    // predicate gets exactly these four assertions wrong.
    expect(parseConfig({ ...enabled, DISABLE_TELEMETRY: '0' })).toBeUndefined()
    expect(parseConfig({ ...enabled, DISABLE_TELEMETRY: 'false' })).toBeUndefined()
    expect(parseConfig({ ...enabled, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '0' })).toBeUndefined()
    // An empty value is "unset" for the set-at-all rule.
    expect(parseConfig({ ...enabled, DISABLE_TELEMETRY: '' })).toBeDefined()
  })

  test('the per-signal logs endpoint overrides the general one and keeps its path', () => {
    // `:102` — "OTLP logs endpoint, overrides general setting", documented with
    // the example `http://localhost:4318/v1/logs`: the path is already there.
    expect(parseConfig({
      NESSY_ENABLE_TELEMETRY: '1',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318/general',
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://127.0.0.1:4318/v1/logs',
    })?.url).toBe('http://127.0.0.1:4318/v1/logs')
    // The general endpoint still gets the signal path appended.
    expect(parseConfig({
      NESSY_ENABLE_TELEMETRY: '1',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318/general',
    })?.url).toBe('http://127.0.0.1:4318/general/v1/logs')
    // And neither endpoint form escapes the opt-in.
    expect(parseConfig({
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://127.0.0.1:4318/v1/logs',
    })).toBeUndefined()
  })
})
