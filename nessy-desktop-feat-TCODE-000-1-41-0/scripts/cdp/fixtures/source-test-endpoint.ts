/**
 * A credential-aware loopback REST endpoint for the source_test sitting arms —
 * the instrument RS-123 (UB3.8 arm B) names.
 *
 * ## Why a second upstream fixture when stub-upstream exists
 *
 * `stub-upstream.ts` accepts ANY Authorization and records only its length,
 * which is exactly right for RS-122's "did the stored key travel" question and
 * exactly wrong for RS-123's: the defect that row measures is a source test
 * that answers 401 with `success = true` — "endpoint is reachable" — after the
 * credential was removed (`source-test.ts` fell through to the unauthenticated
 * probe at 64b944e8a, lines 498/535/720). To make that verdict measurable, the
 * endpoint under the source must REFUSE a wrong or missing credential and
 * ANSWER the right one; a server that accepts anything turns both arms green
 * and the row unmeasurable.
 *
 * ## The wire
 *
 * Every `GET` answers by the credential check alone:
 *
 * - `Authorization: Bearer <key>` where `<key>` is the fixture key → `200` with
 *   an OpenAI-catalog-shaped body (`{"object":"list","data":[…]}`), so a source
 *   whose `testEndpoint` points here reads as working when its credential is
 *   stored and valid.
 * - anything else — no header, a wrong value, a stale one → `401` with a JSON
 *   error body (`{"error":{"message":"invalid credential",…}}`). UB3.2's second
 *   half (show the API error body on 401) needs a REAL body from a REAL 401 to
 *   show, so the body is part of the instrument and pinned by the fixture's
 *   own test.
 *
 * Non-GET methods answer 405; a wrong path answers 404. Nothing else exists —
 * this is a test endpoint, not a service.
 *
 * ## It logs SHAPES, never the key
 *
 * One JSONL record per request — method, path, whether an Authorization header
 * was present and its LENGTH — the same discipline as stub-upstream (lengths
 * only, never values) applied to the header's presence too. The verdict a case
 * needs is "did the request carry the stored credential's SHAPE", and the
 * operator already holds the fixture key it typed, so the length comparison is
 * the discriminator and no value can leak into a run narrative.
 *
 * ## The fixture key is PUBLIC and that is load-bearing
 *
 * The default key is a fixture string checked into this file. It guards a
 * 127.0.0.1-only server that exists while a sitting drives it; a secret here
 * would be a real credential shipped in the tree, which AGENTS.md forbids.
 * `NESSY_CDP_SOURCE_ENDPOINT_KEY` overrides it when a drive wants a value
 * whose length differs from every other string on the wire.
 */

import { appendFileSync } from 'node:fs'

/** The public fixture credential — a fixture, never a secret (see the header). */
export const FIXTURE_KEY = 'rs123-fixture-key'

/** The 401 body shape the 401 arm of RS-123 reads. Pinned by the fixture test. */
export const UNAUTHORIZED_BODY = {
  error: {
    message: 'invalid credential',
    type: 'authentication_error',
    code: 'invalid_api_key',
  },
}

/** The 200 body shape: an OpenAI-catalog-shaped list with one fixture model. */
export const MODELS_BODY = {
  object: 'list',
  data: [{ id: 'rs123-fixture-model', object: 'model', owned_by: 'nessy-cdp' }],
}

/** One JSONL record — shapes only, never a credential value (see the header). */
export interface SourceEndpointRecord {
  readonly method: string
  readonly path: string
  readonly authorizationPresent: boolean
  readonly authorizationLength: number
  readonly status: number
}

export interface SourceTestEndpoint {
  /** `http://127.0.0.1:<port>` — the base URL a source's `api.baseUrl` takes. */
  readonly url: string
  readonly port: number
  readonly logPath?: string
  /** The records so far, for a drive that reads them in-process. */
  readonly requests: () => readonly SourceEndpointRecord[]
  readonly stop: () => void
}

export function startSourceTestEndpoint(options: { port?: number; logPath?: string; key?: string } = {}): SourceTestEndpoint {
  const key = options.key ?? process.env.NESSY_CDP_SOURCE_ENDPOINT_KEY ?? FIXTURE_KEY
  const seen: SourceEndpointRecord[] = []
  const record = (entry: SourceEndpointRecord): void => {
    seen.push(entry)
    if (options.logPath !== undefined) {
      appendFileSync(options.logPath, `${JSON.stringify(entry)}\n`)
    }
  }

  // 127.0.0.1 ONLY, and `port: 0` asks the OS for a free one — the same two
  // decisions as the sibling fixtures (stub-upstream.ts documents the measured
  // flake and the off-host reachability that decided both).
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: options.port ?? 0,
    fetch(request) {
      const url = new URL(request.url)
      const authorization = request.headers.get('authorization') ?? ''
      const authorized = authorization === `Bearer ${key}`
      const status = request.method !== 'GET' ? 405 : url.pathname === '/favicon.ico' ? 404 : authorized ? 200 : 401
      record({
        method: request.method,
        path: url.pathname,
        authorizationPresent: authorization.length > 0,
        authorizationLength: authorization.length,
        status,
      })
      if (status === 200) return Response.json(MODELS_BODY)
      if (status === 401) return Response.json(UNAUTHORIZED_BODY, { status: 401 })
      return new Response(status === 405 ? 'method not allowed' : 'not found', { status })
    },
  })
  const port = server.port
  if (port === undefined) throw new Error('source-test-endpoint: the server reported no port')
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    ...(options.logPath === undefined ? {} : { logPath: options.logPath }),
    requests: () => [...seen],
    stop: () => { server.stop(true) },
  }
}

if (import.meta.main) {
  const portArgument = process.argv.indexOf('--port')
  const asked = portArgument >= 0 ? process.argv[portArgument + 1] : process.env.PORT
  const logArgument = process.argv.indexOf('--log')
  const logPath = logArgument >= 0 ? process.argv[logArgument + 1] : process.env.NESSY_CDP_SOURCE_ENDPOINT_LOG
  const endpoint = startSourceTestEndpoint({ port: Number(asked ?? 0) || 0, ...(logPath ? { logPath: logPath } : {}) })
  console.error(`source-test-endpoint listening on ${endpoint.url}`)
  console.error(`it answers 200 only to "Authorization: Bearer <the fixture key>" and 401 with a JSON body to everything else`)
  console.error('the fixture key is the public FIXTURE_KEY export — never a real credential')
  if (endpoint.logPath) console.error(`one JSONL record per request at ${endpoint.logPath} — header SHAPES only, never a value`)
  else console.error('pass --log <path> (or NESSY_CDP_SOURCE_ENDPOINT_LOG) to mirror the records where a SITTING can read them')
}
