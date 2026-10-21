/**
 * A loopback OpenAI-compatible upstream that can DROP a connection
 * mid-response — the fixture F1.16 names as the one Phase 5 blocker it could
 * remove ("needs a stub upstream that streams a partial response and then
 * drops, plus two controls"), with its Origin row D1.178 (carried C5.15):
 * *what a runtime keeps when the connection drops mid-response — the text, the
 * tool calls, and whether anyone is told it may be incomplete*.
 *
 * ## The wire shapes, and the measurement that chose them
 *
 * Three arms, selected per SERVER (a sitting starts one per arm; a test starts
 * one per assertion), on `http://127.0.0.1:<port>/v1`:
 *
 * - `clean` — control (a): a full streamed completion, `finish_reason` chunk
 *   and `[DONE]` included. The same server, closing normally; the turn must
 *   complete.
 * - `drop-after-partial` — the treatment: status + SSE headers, then a partial
 *   body — a text delta chunk carrying {@link PARTIAL_TEXT} plus, when the
 *   request scripts a shell call, a COMPLETE tool-call chunk — and then the
 *   socket closes with NO finish chunk, NO `[DONE]` and NO chunked terminator.
 * - `drop-before-output` — control (b): the request is read and the socket
 *   closes before ANY byte is written, so there is nothing a runtime could
 *   manufacture a partial from. Zero body bytes.
 *
 * **Why `node:http` and not `stub-upstream.ts`'s `Bun.serve`:** measured on
 * Bun 1.3.14 / macOS arm64, 2026-10-11 (probes under `work/l5e/drop-probe*.ts`
 * of that date): a `Bun.serve` response stream that `controller.error()`s
 * after enqueueing partial bytes ends the body CLEANLY for the client — fetch
 * resolves and the reader reports `done` — a graceful truncation, not a drop.
 * Seven further close primitives were probed for a hard reset (node:http
 * `destroy`/`end`/`resetAndDestroy`, Bun socket `end`/`terminate`/`close`/
 * `shutdown`; `setLinger` does not exist on the runtime's inbound sockets) and
 * none produces an RST. The strongest honest drop this runtime offers is a
 * FLUSHED partial followed by an unterminated chunked body, which is what
 * this file writes; at TCP level the close is a FIN, at the HTTP framing level
 * the response is cut mid-body, and that is what an HTTP client surfaces as a
 * connection failure — Bun's own fetch reads the treatment arm as
 * `Error: The socket connection was closed unexpectedly` after the partial
 * bytes, against the clean arm's `[DONE]` (drop-upstream.test.ts pins both).
 *
 * **Why the drop is armed on a timer:** response write callbacks are inert on
 * this runtime's `node:http` (same probe set), so there is no flush signal to
 * hook; {@link DROP_FLUSH_MS} is the measured delay after which the partial
 * bytes have been handed to the socket when the close fires. The test asserts
 * the bytes DID arrive before the error — if a future runtime change makes the
 * timer lose the race, that assertion goes red rather than the instrument
 * quietly degrading into a second `drop-before-output`.
 *
 * ## The scripting brain is stub-upstream's, not a second one
 *
 * The answer is built by `buildAnswer` from `fixtures/stub-upstream.ts` — the
 * same recognised `for n in …; done` probe command (RS-16's shape, exported
 * here as {@link PROBE_COMMAND}), the same tool picking, and the same
 * argument-name-from-the-offered-schema rule that DA2.10 measured the codex
 * `cmd` failure into. A sitting drives this upstream with the same probe
 * prompt stub-upstream's cases use; only the wire layer differs, because the
 * wire behaviour is the whole point.
 *
 * ## The record is the arm's positive control
 *
 * Every chat-completions request is recorded (JSONL mirror via `logPath`,
 * same rule as stub-upstream) with `mode`, `wire` — what the arm actually did
 * on the wire: `completed`, `after-partial` or `before-headers` —
 * `partialBytes`, and `toolCallIncluded`. A drive whose partial lacked the
 * complete tool call the rig spec asks for must not be scored: the record says
 * so. `Authorization` is accepted whatever it says and NEVER stored, logged or
 * returned — only its LENGTH, which cannot be pasted into a client.
 *
 * A drop mode is uniform: non-streamed chat-completions requests are dropped
 * by the same rules (the partial bytes are the same SSE bytes; the record's
 * `streamed` field says what the client asked for), because a drop arm that
 * silently answered would read as a control and lie to a sitting.
 */

import { appendFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'

import { buildAnswer } from './stub-upstream.ts'

/**
 * The message shape `buildAnswer` reads, declared locally so this fixture does
 * not edit the file it borrows the scripting brain from (stub-upstream keeps
 * its own `ChatMessage` private). Structural, and read-only here.
 */
interface ChatMessage {
  role?: string
  content?: unknown
  tool_call_id?: string
}

/** The server's model id, in the `/models` list a BYO card save probes. */
export const MODEL_ID = 'nessy-cdp-drop'

/**
 * The text the treatment arm's partial carries, so a drive can answer D1.178's
 * first question ("is the already-produced text kept?") by searching the
 * runtime's transcript for this marker alone.
 */
export const PARTIAL_TEXT = 'F1.16-PARTIAL-TEXT-KEPT-PROBE'

/**
 * The shell command the rig's probe prompt asks for — the shape stub-upstream's
 * {@link buildAnswer} recognises. Exported so a drive names ONE command in both
 * its prompt and its assertion.
 */
export const PROBE_COMMAND = 'for n in OPENAI_API_KEY; do v=$(printenv "$n"); printf \'%s=%s\' "$n" "1"; done'

/** The measured flush delay before a drop fires — see the header, "why a timer". */
export const DROP_FLUSH_MS = 25

/** The three arms a server starts in. */
export type DropMode = 'clean' | 'drop-after-partial' | 'drop-before-output'

/** What the arm actually did on the wire — the record's positive control. */
export type DropWire = 'completed' | 'after-partial' | 'before-headers'

/** What the server saw, reduced to what is safe to record. */
export interface DropRequestRecord {
  /** ISO timestamp, so a JSONL log can be sliced to one arm's own window. */
  t?: string
  path: string
  /** The LENGTH of the Authorization header, never its value. `0` when absent. */
  authorizationLength: number
  model: string | null
  toolNames: string[]
  streamed: boolean
  /** Whether this request carried a `role: "tool"` message — i.e. the second leg. */
  carriedToolResult: boolean
  /** The mode this server was started in. */
  mode: DropMode
  /** What the arm did: completed, cut after the partial bytes, or cut before any byte. */
  wire: DropWire
  /** Body bytes written before the drop — `0` for `before-headers`. */
  partialBytes: number
  /** Whether the partial stream carried a COMPLETE tool call (the rig spec's other half). */
  toolCallIncluded: boolean
}

export interface DropUpstream {
  /** The base URL a BYO card is pointed at, `/v1` included. */
  url: string
  port: number
  requests: () => DropRequestRecord[]
  /** Where the JSONL mirror of {@link DropUpstream.requests} is written, when one was asked for. */
  logPath?: string
  stop: () => void
}

function toolNamesOf(tools: unknown): string[] {
  if (!Array.isArray(tools)) return []
  return tools.map(tool => {
    const record = tool as { function?: { name?: unknown }; name?: unknown }
    const name = record.function?.name ?? record.name
    return typeof name === 'string' ? name : ''
  }).filter(Boolean)
}

function chatCompletionChunks(messages: readonly ChatMessage[], toolNames: readonly string[], tools: unknown): {
  /** The partial body: text plus, when scripted, one complete tool call. */
  partial: string
  /** Whether `partial` carries a complete tool call. */
  toolCallIncluded: boolean
  /** The full body control (a) answers with: the same scripted answer, completed. */
  full: string
} {
  const answer = buildAnswer(messages, toolNames, tools)
  const base = {
    id: `chatcmpl-drop-${Date.now().toString(36)}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: MODEL_ID,
  }
  const data = (payload: Record<string, unknown>): string => `data: ${JSON.stringify(payload)}\n\n`
  const textDelta = data({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: PARTIAL_TEXT }, finish_reason: null }] })
  const call = answer.kind === 'tool-call'
    ? {
      index: 0,
      id: `call_drop_${Date.now().toString(36)}`,
      type: 'function',
      function: {
        name: answer.toolName,
        arguments: JSON.stringify({ [answer.argumentName ?? 'command']: answer.command }),
      },
    }
    : undefined
  const callDelta = call
    ? data({ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [call] }, finish_reason: null }] })
    : ''
  const partial = textDelta + callDelta
  const finishReason = call ? 'tool_calls' : 'stop'
  const finishDelta = data({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })
  const full = call
    ? callDelta + finishDelta + 'data: [DONE]\n\n'
    : textDelta + finishDelta + 'data: [DONE]\n\n'
  return { partial, toolCallIncluded: call !== undefined, full }
}

const SSE_HEADERS = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } as const

/**
 * Start it. `port: 0` asks the OS for a free one, which is what a test should
 * use; a sitting names the port it put in the card. Bound to 127.0.0.1 for the
 * same measured reason as `stub-upstream.ts` (F1.185: a wildcard bind lets a
 * second process shadow the port) — and so the stub is unreachable off-host.
 */
export function startDropUpstream(options: { port?: number; mode?: DropMode; logPath?: string } = {}): DropUpstream {
  const mode: DropMode = options.mode ?? 'clean'
  const seen: DropRequestRecord[] = []
  const sockets = new Set<Socket>()
  const record = (entry: DropRequestRecord): void => {
    const stamped: DropRequestRecord = { t: new Date().toISOString(), ...entry }
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
        toolNames: [],
        streamed: false,
        carriedToolResult: false,
        mode,
        wire: 'completed',
        partialBytes: 0,
        toolCallIncluded: false,
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

    const bodyChunks: Buffer[] = []
    request.on('data', chunk => { bodyChunks.push(chunk as Buffer) })
    request.on('end', () => {
      const parsed = JSON.parse(Buffer.concat(bodyChunks).toString('utf8') || '{}') as Record<string, unknown>
      const messages = Array.isArray(parsed.messages) ? parsed.messages as ChatMessage[] : []
      const toolNames = toolNamesOf(parsed.tools)
      const streamed = parsed.stream === true
      const { partial, toolCallIncluded, full } = chatCompletionChunks(messages, toolNames, parsed.tools)

      if (mode === 'drop-before-output') {
        // Control (b): close before ANY byte — no status line, no headers, no
        // body. There is nothing here a runtime could manufacture a partial
        // from, which is the control's whole claim.
        record({ path: url.pathname, authorizationLength, model: typeof parsed.model === 'string' ? parsed.model : null, toolNames, streamed, carriedToolResult: messages.some(message => message.role === 'tool'), mode, wire: 'before-headers', partialBytes: 0, toolCallIncluded: false })
        response.socket?.end()
        return
      }
      if (mode === 'drop-after-partial') {
        // The treatment: flush the partial bytes, then cut the body mid-chunked-
        // encoding — no finish chunk, no [DONE], no chunked terminator.
        record({ path: url.pathname, authorizationLength, model: typeof parsed.model === 'string' ? parsed.model : null, toolNames, streamed, carriedToolResult: messages.some(message => message.role === 'tool'), mode, wire: 'after-partial', partialBytes: Buffer.byteLength(partial), toolCallIncluded })
        response.writeHead(200, SSE_HEADERS)
        response.write(partial)
        setTimeout(() => response.socket?.end(), DROP_FLUSH_MS)
        return
      }
      // Control (a): the same server, closing normally.
      record({ path: url.pathname, authorizationLength, model: typeof parsed.model === 'string' ? parsed.model : null, toolNames, streamed, carriedToolResult: messages.some(message => message.role === 'tool'), mode, wire: 'completed', partialBytes: 0, toolCallIncluded })
      response.writeHead(200, SSE_HEADERS)
      response.end(full)
    })
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => { sockets.delete(socket) })
  })
  server.listen(options.port ?? 0, '127.0.0.1')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('drop-upstream: the server reported no port')
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    port: address.port,
    requests: () => [...seen],
    ...(options.logPath === undefined ? {} : { logPath: options.logPath }),
    // A drop arm leaves sockets the client may not have finished reading; a
    // stop that only calls close() would wait on them. Destroy what is open.
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
  const portArgument = flag('--port', 'NESSY_CDP_DROP_PORT')
  const modeArgument = flag('--mode', 'NESSY_CDP_DROP_MODE')
  const logPath = flag('--log', 'NESSY_CDP_DROP_LOG')
  const portFile = flag('--port-file', 'NESSY_CDP_DROP_PORT_FILE')
  const mode = modeArgument as DropMode | undefined
  if (mode !== undefined && !['clean', 'drop-after-partial', 'drop-before-output'].includes(mode)) {
    console.error(`drop-upstream: unknown mode ${modeArgument} — clean | drop-after-partial | drop-before-output`)
    process.exit(2)
  }
  const stub = startDropUpstream({
    port: Number(portArgument ?? 0) || 0,
    ...(mode === undefined ? {} : { mode }),
    ...(logPath ? { logPath } : {}),
  })
  if (portFile) writeFileSync(portFile, String(stub.port))
  console.log(`drop-upstream (${mode ?? 'clean'}) on ${stub.url} pid=${process.pid}`)
  console.log('point a BYO card at that base URL with ANY string as the key — this server never reads it')
  console.log(`the treatment prompt must carry: ${PROBE_COMMAND}`)
  console.log('per-runtime questions (D1.178): is the PARTIAL text kept; is the complete tool call kept and continuable; is the user told the response may be incomplete')
  if (stub.logPath) console.log(`one JSONL record per request at ${stub.logPath} — header LENGTHS only, never a value`)
  else console.log('pass --log <path> (or NESSY_CDP_DROP_LOG) to mirror the records where a SITTING can read them')
}
