/**
 * F1.329 — the STRICT BYO endpoint the row's measurement names, as a committed
 * instrument: an OpenAI-compatible loopback that REFUSES the payload keys it is
 * told to refuse, in OpenAI's own error shape, and records every refusal.
 *
 * ## The measurement this reproduces
 *
 * SIT2-e (2026-10-01, packaged; `work/sitting2/SIT2-e-verdicts.md`): a strict
 * stub "400 on non-classic keys" made a real pi turn answer the user with
 * `Request Error: Unrecognized request argument supplied: stream_options,
 * max_completion_tokens`, one request, no retry or fallback. The refusal shape
 * is OpenAI's own (`invalid_request_error` naming the keys), and the default
 * refusal list here is EXACTLY that measured pair — `stream_options` and
 * `max_completion_tokens` — so the default arm reproduces the one strict
 * reading this row has, rather than an opinion about what "strict" means.
 * Everything else is a knob, because real endpoints differ: `--refuse <key>`
 * adds a key to the refusal list, `--allow <key>` removes one, `--refuse-role
 * <role>` also refuses a message role (off by default — SIT2-e measured the
 * `developer` role only at the GATEWAY, which accepted it), and `--accept-all`
 * is the positive control that answers everything.
 *
 * ## Why this is the row's rig and not its answer
 *
 * The row's open question — which of pi-ai's pinned payload fields a REAL
 * endpoint refuses — has two legs. The gateway leg needs the gateway and its
 * credential: not drivable from a lane rig, it stays the sitting's ASK (and
 * part of it is already measured: SIT2-e saw the gateway accept
 * `max_completion_tokens` + `stream_options` across 230 bodies, accept
 * `reasoning_effort` with the `developer` role on the coder row, and — before
 * pi 0.85.1 added them — carry `prompt_cache_key`/`prompt_cache_retention` in
 * 0 of 230 bodies). The strict-BYO leg is THIS instrument plus a real pi turn:
 * the payload that reaches it is pi-ai's own (the production composition is
 * pinned key for key by
 * `packages/pi-agent-server/src/custom-endpoint-models.test.ts` — since
 * F1.1263 a BYO endpoint gets `max_tokens` and NO `stream_options`, but
 * `prompt_cache_key`, `prompt_cache_retention` and, for a reasoning model,
 * `reasoning_effort` with the system prompt as role `developer` still go to
 * every custom endpoint). Only a field MEASURED red earns its compat sibling
 * beside `supportsStore: false` — this fixture is how a field gets measured
 * without the packaged app, and `pi-runtime-adapter.ts` docblock item 9 stays
 * untouched until one does.
 *
 * ## What is recorded
 *
 * Per chat-completions request: `accepted` or the refused keys/roles, the
 * body's sorted top-level keys, its byte size, and the Authorization header's
 * LENGTH (never its value — the stub-upstream rule). Message CONTENT is never
 * recorded: the refusal verdict travels by KEY and ROLE name, and a log that
 * held prompts would be the one thing a sitting cannot paste.
 *
 * Accepted requests get a minimal valid completion (whole-body or SSE ending
 * in `[DONE]`), so an accepted turn COMPLETES and the arm's verdict is the
 * refusal, not a hang. Same wire layer and 127.0.0.1 bind as the sibling
 * fixtures (F1.185's measured shadow-bind rule).
 */

import { appendFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'

/** The server's model id, in the `/models` list a BYO card save probes. */
export const MODEL_ID = 'nessy-cdp-strict'

/**
 * The MEASURED refusal list (SIT2-e, 2026-10-01): the two fields pi-ai's own
 * detection sent to a custom endpoint before F1.1263's compat, which the real
 * strict stub refused in one 400.
 */
export const MEASURED_REFUSED_KEYS = ['stream_options', 'max_completion_tokens'] as const

/** What one chat-completions request met, as the JSONL record carries it. */
export interface StrictRefusalRecord {
  /** ISO timestamp, so a JSONL log can be sliced to one arm's own window. */
  t?: string
  path: string
  /** The LENGTH of the Authorization header, never its value. `0` when absent. */
  authorizationLength: number
  model: string | null
  /** Sorted top-level body keys — what the client actually sent. */
  bodyKeys: string[]
  /** Message roles in arrival order, deduplicated — `developer` is the one D1.58-era field to watch. */
  roles: string[]
  /** Body size in bytes. */
  bodyBytes: number
  /** false = 400 naming {@link refusedKeys}/{@link refusedRoles}; true = a completion was served. */
  accepted: boolean
  /** The payload keys this request was refused for (empty when accepted). */
  refusedKeys: string[]
  /** The message roles this request was refused for (empty unless --refuse-role armed them). */
  refusedRoles: string[]
}

export interface StrictUpstream {
  /** The base URL a BYO card is pointed at, `/v1` included. */
  url: string
  port: number
  requests: () => StrictRefusalRecord[]
  /** The refusal list in force — what the record's verdicts were judged against. */
  refusedKeys: () => string[]
  refusedRoles: () => string[]
  /** Where the JSONL mirror of {@link StrictUpstream.requests} is written, when one was asked for. */
  logPath?: string
  stop: () => void
}

export interface StrictUpstreamOptions {
  port?: number
  logPath?: string
  /** Payload keys to refuse; DEFAULTS to the measured pair — pass `[]` to refuse none. */
  refuseKeys?: readonly string[]
  /** Message roles to refuse; DEFAULT empty (role strictness is a knob, not a measurement). */
  refuseRoles?: readonly string[]
  /** The positive control: answer everything, refuse nothing. */
  acceptAll?: boolean
}

export function startStrictUpstream(options: StrictUpstreamOptions = {}): StrictUpstream {
  const refusedKeySet = new Set<string>(
    options.acceptAll ? [] : options.refuseKeys ?? MEASURED_REFUSED_KEYS,
  )
  const refusedRoleSet = new Set<string>(options.acceptAll ? [] : options.refuseRoles ?? [])
  const seen: StrictRefusalRecord[] = []
  const sockets = new Set<Socket>()
  const record = (entry: StrictRefusalRecord): void => {
    const stamped: StrictRefusalRecord = { t: new Date().toISOString(), ...entry }
    seen.push(stamped)
    if (options.logPath === undefined) return
    try {
      appendFileSync(options.logPath, `${JSON.stringify(stamped)}\n`)
    } catch {
      // A log that cannot be written must not take the upstream down with it.
    }
  }

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const authorizationLength = (request.headers.authorization ?? '').length
    if (request.method === 'GET' && url.pathname.endsWith('/models')) {
      record({ path: url.pathname, authorizationLength, model: null, bodyKeys: [], roles: [], bodyBytes: 0, accepted: true, refusedKeys: [], refusedRoles: [] })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ object: 'list', data: [{ id: MODEL_ID, object: 'model', owned_by: 'nessy-cdp' }] }))
      return
    }
    if (request.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('not found')
      return
    }

    const chunks: Buffer[] = []
    request.on('data', chunk => { chunks.push(chunk as Buffer) })
    request.on('end', () => {
      const raw = Buffer.concat(chunks)
      let parsed: Record<string, unknown> = {}
      try {
        const parsedUnknown: unknown = JSON.parse(raw.toString('utf8') || '{}')
        if (parsedUnknown !== null && typeof parsedUnknown === 'object') parsed = parsedUnknown as Record<string, unknown>
      } catch {
        // An unparseable body is judged on its keys (none) — the endpoint is a
        // witness, not a validator; the refusal list is the measurement.
      }
      const bodyKeys = Object.keys(parsed).sort()
      const roles = [...new Set((Array.isArray(parsed.messages) ? parsed.messages as Array<{ role?: unknown }> : [])
        .map(message => typeof message.role === 'string' ? message.role : '')
        .filter(Boolean))]
      const refusedKeys = [...refusedKeySet].filter(key => key in parsed).sort()
      const refusedRoles = [...refusedRoleSet].filter(role => roles.includes(role)).sort()
      const accepted = refusedKeys.length === 0 && refusedRoles.length === 0
      record({
        path: url.pathname,
        authorizationLength,
        model: typeof parsed.model === 'string' ? parsed.model : null,
        bodyKeys,
        roles,
        bodyBytes: raw.length,
        accepted,
        refusedKeys,
        refusedRoles,
      })

      if (!accepted) {
        // OpenAI's own refusal shape, naming the keys the way SIT2-e measured
        // it ("Unrecognized request argument supplied: stream_options,
        // max_completion_tokens"), roles named as unknown values.
        const parts = [
          ...(refusedKeys.length ? [`Unrecognized request argument supplied: ${refusedKeys.join(', ')}`] : []),
          ...refusedRoles.map(role => `Unrecognized message role supplied: ${role}`),
        ]
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          error: {
            message: parts.join('; '),
            type: 'invalid_request_error',
            param: refusedKeys[0] ?? null,
            code: 'unrecognized_argument',
          },
        }))
        return
      }
      if (parsed.stream === true) {
        const base = {
          id: `chatcmpl-strict-${Date.now().toString(36)}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: typeof parsed.model === 'string' ? parsed.model : MODEL_ID,
        }
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        response.end([
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'strict ok' }, finish_reason: null }] })}`,
          '',
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}`,
          '',
          'data: [DONE]',
          '',
          '',
        ].join('\n'))
      } else {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          id: `chatcmpl-strict-${Date.now().toString(36)}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: typeof parsed.model === 'string' ? parsed.model : MODEL_ID,
          choices: [{ index: 0, message: { role: 'assistant', content: 'strict ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }))
      }
    })
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => { sockets.delete(socket) })
  })
  server.listen(options.port ?? 0, '127.0.0.1')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('strict-upstream: the server reported no port')
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    port: address.port,
    requests: () => [...seen],
    refusedKeys: () => [...refusedKeySet],
    refusedRoles: () => [...refusedRoleSet],
    ...(options.logPath === undefined ? {} : { logPath: options.logPath }),
    stop: () => {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      server.close()
    },
  }
}

if (import.meta.main) {
  const flag = (name: string, env: string): string | undefined => {
    const index = process.argv.indexOf(name)
    return index >= 0 ? process.argv[index + 1] : process.env[env]
  }
  const repeated = (name: string, env: string): string[] => {
    const values: string[] = []
    for (let index = process.argv.indexOf(name); index >= 0; index = process.argv.indexOf(name, index + 1)) {
      const value = process.argv[index + 1]
      if (value) values.push(value)
    }
    const envValue = process.env[env]
    if (envValue) values.push(...envValue.split(',').map(value => value.trim()).filter(Boolean))
    return values
  }
  const portArgument = flag('--port', 'NESSY_CDP_STRICT_PORT')
  const logPath = flag('--log', 'NESSY_CDP_STRICT_LOG')
  const portFile = flag('--port-file', 'NESSY_CDP_STRICT_PORT_FILE')
  const allowAll = process.argv.includes('--accept-all') || process.env.NESSY_CDP_STRICT_ACCEPT_ALL === '1'
  const extraRefuse = repeated('--refuse', 'NESSY_CDP_STRICT_REFUSE')
  const allows = repeated('--allow', 'NESSY_CDP_STRICT_ALLOW')
  const refuseRoles = repeated('--refuse-role', 'NESSY_CDP_STRICT_REFUSE_ROLES')
  // Default: the measured pair. --allow removes from it; --refuse adds;
  // --accept-all empties it (the fixture's own acceptAll already does).
  const refuseKeys = [...new Set([...MEASURED_REFUSED_KEYS, ...extraRefuse])].filter(key => !allows.includes(key))
  const stub = startStrictUpstream({
    port: Number(portArgument ?? 0) || 0,
    ...(logPath ? { logPath } : {}),
    ...(allowAll ? { acceptAll: true } : {}),
    refuseKeys,
    ...(refuseRoles.length ? { refuseRoles } : {}),
  })
  if (portFile) writeFileSync(portFile, String(stub.port))
  console.log(`strict-upstream${allowAll ? ' (--accept-all)' : ''} on ${stub.url} pid=${process.pid}`)
  console.log(`refusing keys: ${stub.refusedKeys().join(', ') || '(none)'}`)
  console.log(`refusing roles: ${stub.refusedRoles().join(', ') || '(none)'}`)
  console.log('point a BYO pi card at that base URL with ANY string as the key — this server never reads it')
  console.log('one JSONL record per request: accepted, refusedKeys, refusedRoles, bodyKeys, roles, bodyBytes — never a message body')
  if (stub.logPath) console.log(`records mirror to ${stub.logPath}`)
  else console.log('pass --log <path> (or NESSY_CDP_STRICT_LOG) to mirror the records where a SITTING can read them')
}
