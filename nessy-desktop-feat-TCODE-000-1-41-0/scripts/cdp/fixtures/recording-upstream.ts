/**
 * A loopback OpenAI-compatible upstream that ANSWERS every turn and RECORDS
 * the request bodies — the readable surface F1.61 names and this rig did not
 * have (Origin D1.58, carried P6.369: *does the shipped claude binary honour
 * `ultrathink` through our composition path, or only carry the word*).
 *
 * ## The measured blocker this file removes
 *
 * SIT-5c (2026-09-18, packaged 1.40.0): "the thinking budget sent is only
 * visible off the loopback adapter, which this rig does not capture" — the
 * claude per-session diagnostic scores 0 for `thinking`, `budget_tokens`,
 * `ultrathink`, `maxThinkingTokens` and `interleaved`, and the app's own
 * `interceptor.log` carries only the Pi subprocess's bodies (SIT-r,
 * 2026-09-25), never the claude-runtime loopback adapter's upstream. A BYO
 * `claude-runtime` card whose endpoint is THIS server puts the recorder at
 * exactly the hop the row reads: the adapter composes an OpenAI-shaped request
 * and posts it here (the driver decides that shape —
 * `buildClaudeRuntimeUpstream`, `drivers/anthropic.ts:27`, returns
 * `kind: 'openai-compatible'` for every BYO endpoint that is not the gateway).
 *
 * ## What is recorded, and what deliberately is not
 *
 * Per chat-completions request, one record (in memory plus a JSONL mirror when
 * `logPath` was asked for): `authorizationLength` — the LENGTH of the
 * Authorization header, NEVER its value, the same rule as
 * `stub-upstream.ts`/`drop-upstream.ts` — plus `model`, `streamed`, the sorted
 * top-level `bodyKeys`, the body SIZE in bytes, and the row's three
 * budget fields READ BY THEIR OWN SPELLING:
 * `reasoning_effort`, `max_completion_tokens`, `thinking`. Each is recorded as
 * `{ present: false }` when the KEY is not in the body and
 * `{ present: true, value }` when it is — value `null`, `0` and `false`
 * included, because D1.58's verdict is an absence claim and an absence that
 * reads as a zero is a lie (recording-upstream.test.ts pins the three-way
 * distinction). **The prompt text itself is NOT recorded by default**: the
 * full parsed body rides the record only when the server was started with
 * `fullBody` (CLI `--full-body`), which is the diff-a-turn run's opt-in — a
 * default-on recorder would paste every user prompt of a sitting into a log
 * file nobody asked for.
 *
 * ## It answers, and that is load-bearing
 *
 * Both of the row's arms are COMPLETE turns (the ultrathink turn and the
 * identical control turn), so the recorder answers `/models` for the card-save
 * flow and every chat-completions request with a minimal valid completion —
 * whole-body for `stream:false`, well-formed SSE ending in `[DONE]` for
 * `stream:true`. A recorder that refused or dropped would turn the drive into
 * a failure-mode reading; this is the plain-pipe instrument.
 *
 * The wire layer is `node:http` for the same reason as `drop-upstream.ts`
 * (bound to 127.0.0.1 — F1.185's measured shadow-bind rule — and the sibling
 * fixtures' stack), though nothing here needs to drop anything.
 */

import { appendFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'

/** The server's model id, in the `/models` list a BYO card save probes. */
export const MODEL_ID = 'nessy-cdp-recorder'

/** One budget field as the record carries it: absent, or present with its value. */
export interface RecordedField {
  present: boolean
  value?: unknown
}

/** What the server saw, reduced to what is safe to record. */
export interface RecorderRequestRecord {
  /** ISO timestamp, so a JSONL log can be sliced to one arm's own window. */
  t?: string
  path: string
  /** The LENGTH of the Authorization header, never its value. `0` when absent. */
  authorizationLength: number
  model: string | null
  streamed: boolean
  /** Sorted top-level body keys — the cheap shape of "what the client sent". */
  bodyKeys: string[]
  /** Body size in bytes — distinguishes an empty body from a missing read. */
  bodyBytes: number
  /** D1.58's fields, by their own spelling. Absent keys read `present: false`. */
  reasoningEffort: RecordedField
  maxCompletionTokens: RecordedField
  thinking: RecordedField
  /** The full parsed body — ONLY when the server was started with `fullBody`. */
  body?: Record<string, unknown>
}

export interface RecordingUpstream {
  /** The base URL a BYO card is pointed at, `/v1` included. */
  url: string
  port: number
  requests: () => RecorderRequestRecord[]
  /** Where the JSONL mirror of {@link RecordingUpstream.requests} is written, when one was asked for. */
  logPath?: string
  stop: () => void
}

function recordedField(body: Record<string, unknown>, key: string): RecordedField {
  return key in body ? { present: true, value: body[key] } : { present: false }
}

function sseCompletion(model: string | null): string {
  const base = {
    id: `chatcmpl-rec-${Date.now().toString(36)}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model ?? MODEL_ID,
  }
  return [
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'recorder ok' }, finish_reason: null }] })}`,
    '',
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}`,
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n')
}

/**
 * Start it. `port: 0` asks the OS for a free one, which is what a test should
 * use; a sitting names the port it put in the card. `fullBody` turns on
 * recording the full parsed body per request — the diff-a-turn opt-in, never
 * the default (see the header, "what is recorded").
 */
export function startRecordingUpstream(options: { port?: number; logPath?: string; fullBody?: boolean } = {}): RecordingUpstream {
  const seen: RecorderRequestRecord[] = []
  const sockets = new Set<Socket>()
  const record = (entry: RecorderRequestRecord): void => {
    const stamped: RecorderRequestRecord = { t: new Date().toISOString(), ...entry }
    seen.push(stamped)
    if (options.logPath === undefined) return
    try {
      appendFileSync(options.logPath, `${JSON.stringify(stamped)}\n`)
    } catch {
      // A log that cannot be written must not take the upstream down with it —
      // the in-memory list is still a reading for an in-process caller.
    }
  }

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const authorizationLength = (request.headers.authorization ?? '').length
    if (request.method === 'GET' && url.pathname.endsWith('/models')) {
      record({
        path: url.pathname,
        authorizationLength,
        model: null,
        streamed: false,
        bodyKeys: [],
        bodyBytes: 0,
        reasoningEffort: { present: false },
        maxCompletionTokens: { present: false },
        thinking: { present: false },
      })
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
        // An unparseable body is still a record — the recorder is a witness,
        // not a validator; the client asked for a completion and gets one.
      }
      record({
        path: url.pathname,
        authorizationLength,
        model: typeof parsed.model === 'string' ? parsed.model : null,
        streamed: parsed.stream === true,
        bodyKeys: Object.keys(parsed).sort(),
        bodyBytes: raw.length,
        reasoningEffort: recordedField(parsed, 'reasoning_effort'),
        maxCompletionTokens: recordedField(parsed, 'max_completion_tokens'),
        thinking: recordedField(parsed, 'thinking'),
        ...(options.fullBody ? { body: parsed } : {}),
      })
      if (parsed.stream === true) {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        response.end(sseCompletion(typeof parsed.model === 'string' ? parsed.model : null))
      } else {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          id: `chatcmpl-rec-${Date.now().toString(36)}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: typeof parsed.model === 'string' ? parsed.model : MODEL_ID,
          choices: [{ index: 0, message: { role: 'assistant', content: 'recorder ok' }, finish_reason: 'stop' }],
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
  if (address === null || typeof address === 'string') throw new Error('recording-upstream: the server reported no port')
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    port: address.port,
    requests: () => [...seen],
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
  const portArgument = flag('--port', 'NESSY_CDP_RECORDER_PORT')
  const logPath = flag('--log', 'NESSY_CDP_RECORDER_LOG')
  const portFile = flag('--port-file', 'NESSY_CDP_RECORDER_PORT_FILE')
  const fullBody = process.argv.includes('--full-body') || process.env.NESSY_CDP_RECORDER_FULL_BODY === '1'
  const stub = startRecordingUpstream({
    port: Number(portArgument ?? 0) || 0,
    ...(logPath ? { logPath } : {}),
    ...(fullBody ? { fullBody: true } : {}),
  })
  if (portFile) writeFileSync(portFile, String(stub.port))
  console.log(`recording-upstream${fullBody ? ' (--full-body)' : ''} on ${stub.url} pid=${process.pid}`)
  console.log('point a BYO claude-runtime card at that base URL with ANY string as the key — this server never reads it')
  console.log('one JSONL record per request: authorizationLength, model, streamed, bodyKeys, bodyBytes, reasoning_effort / max_completion_tokens / thinking as present-or-absent')
  if (!fullBody) console.log('pass --full-body to also record each request body (the diff-a-turn opt-in; off by default so prompts stay out of the log)')
  if (stub.logPath) console.log(`records mirror to ${stub.logPath}`)
  else console.log('pass --log <path> (or NESSY_CDP_RECORDER_LOG) to mirror the records where a SITTING can read them')
}
