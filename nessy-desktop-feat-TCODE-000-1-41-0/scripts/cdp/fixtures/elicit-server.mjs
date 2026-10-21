#!/usr/bin/env node
/**
 * An MCP server that ASKS THE USER — the live half of `036d30536`.
 *
 * That commit fixed a defect no offline check could have found, and the offline
 * suite it shipped with (`mcp/__tests__/mcp-pool-elicitation-routing.test.ts`)
 * drives a real eliciting server through the pool with a fake user. This file
 * is the same server with a REAL user on the other end: the app's own `ask_user`
 * card, answered by a mouse click, on all three runtimes.
 *
 * ## The two things only a server can witness
 *
 * AGENTS.md: "before filing 'feature X never happens', confirm the negative
 * against a source the feature writes itself". Both of this fixture's detectors
 * are written from the SERVER's side of the wire, because the app's account of
 * itself cannot answer either question:
 *
 * 1. **What capabilities did the client declare at `initialize`?** Elicitation
 *    is frozen at the handshake — the vendored SDK refuses to send
 *    `elicitation/create` at all when the client did not declare it
 *    (`client/index.js`), which is why the fix had to move to the pool's client
 *    FACTORY rather than to a session's start-up order. Every `initialize` is
 *    logged with `params.capabilities` verbatim, so a case can assert
 *    `elicitation: {form, url}` reached the wire rather than trusting that the
 *    code path exists.
 * 2. **What came back for an `elicitation/create`?** The tool RESULT carries the
 *    outcome, so an assertion on the transcript's tool row is an assertion on
 *    what the server experienced: `accept` / `decline` / `cancel`, or
 *    `refused:-32601` — the JSON-RPC "Method not found" this whole fix exists to
 *    stop, measured on Codex on the packaged 1.25.1 (Q13-D1).
 *
 * ## Why the outcome carries a per-call nonce
 *
 * Same reason `echo-server.mjs` mints one: a model that invents a plausible
 * answer must not be able to score a call it never made. The nonce is minted
 * inside this process at call time and exists in no file, so the same value in
 * the transcript's `toolResult` and in the model's reply is what ties "a server
 * answered" to "the answer reached the turn". The `whoami` tool exists purely as
 * that: an elicitation-free positive control, and the unfakeable result
 * `CDX-147` uses for the Codex wire-name half.
 *
 * ## Why the identity is BAKED IN and not passed as env
 *
 * Inherited verbatim from `echo-server.mjs`, where it was measured: a value
 * declared in an MCP server's `env` block is a credential as far as the runtime
 * is concerned, and it is scrubbed out of tool OUTPUT — the first live Pi turn
 * of the MCP-W wave came back `[REDACTED] [REDACTED]`. Correct product
 * behaviour, fatal to a detector that reads the token out of the reply.
 *
 * Env fallback (hand-run self-test only):
 *   ELC_LOG / ELC_LABEL / ELC_TOKEN — the same three values as the baked ones.
 */

import { appendFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const BAKED = globalThis.ELC_BAKED ?? {}
const LABEL = BAKED.label ?? process.env.ELC_LABEL ?? 'unlabelled'
const TOKEN = BAKED.token ?? process.env.ELC_TOKEN ?? 'NO-TOKEN'
const LOG = BAKED.log ?? process.env.ELC_LOG

/**
 * How long this server waits for a user before giving up on one dialog.
 *
 * Long, on purpose: a case answers within seconds, and a server that gave up
 * first would manufacture a `cancel` that looks exactly like the pre-fix silent
 * drop this fixture exists to tell apart. Shorter than any plausible harness
 * timeout so a genuinely unanswered dialog still ends the tool call with a
 * reason instead of hanging the turn forever.
 */
const ELICIT_TIMEOUT_MS = 240_000

/** The URL `ask_bad_url` sends. NOT http(s) — that is the whole point. */
const REFUSED_URL = 'file:///etc/passwd'

function log(entry) {
  if (!LOG) return
  try {
    appendFileSync(LOG, `${JSON.stringify({ at: Date.now(), label: LABEL, ...entry })}\n`)
  } catch {
    // A fixture that dies because its log directory vanished would look like a
    // product failure. The reply matters more than the record.
  }
}

const TOOLS = [
  {
    name: 'whoami',
    description:
      `Return the secret probe token of the "${LABEL}" fixture MCP server. `
      + 'Takes no arguments, asks the user nothing. The token cannot be guessed or derived — it is generated per run.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'ask_confirm',
    description:
      'Ask the user to confirm before continuing, then report what they answered. '
      + 'Takes no arguments. This tool CANNOT answer without the user.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'ask_bad_url',
    description:
      'Ask the user to open a sign-in URL, then report what they answered. '
      + 'Takes no arguments. This tool CANNOT answer without the user.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

// ---------------------------------------------------------------------------
// Server -> client requests
// ---------------------------------------------------------------------------

/**
 * MCP is bidirectional over the one stream, so an `elicitation/create` is an
 * ordinary JSON-RPC request travelling the other way. Ids are STRINGS with this
 * server's label in them: the client numbers its own requests from 1, and a
 * collision would have this server answering its own question.
 */
const pendingClientRequests = new Map()
let clientRequestSeq = 0

function callClient(method, params) {
  const id = `${LABEL}-${++clientRequestSeq}`
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      pendingClientRequests.delete(id)
      resolve({ error: { code: -32000, message: `no answer in ${ELICIT_TIMEOUT_MS}ms` } })
    }, ELICIT_TIMEOUT_MS)
    pendingClientRequests.set(id, message => {
      clearTimeout(timer)
      resolve(message)
    })
    send({ jsonrpc: '2.0', id, method, params })
  })
}

/**
 * One elicitation, reduced to a single reportable string.
 *
 * Three outcomes are deliberately distinguishable in the text, because they mean
 * three different things and the pre-fix failure is one of them:
 *
 *   - `accept` / `decline` / `cancel` — the client answered; a user decided.
 *   - `refused:-32601` — the client rejected the METHOD. This is Q13-D1's exact
 *     symptom on the Codex runtime and the reason this fixture exists.
 *   - `refused:<other>` — anything else the client said, verbatim.
 */
async function elicit(params) {
  const response = await callClient('elicitation/create', params)
  if (response.error) {
    const code = response.error.code
    log({ method: 'elicitation/create', outcome: `refused:${code}`, error: response.error })
    return { outcome: `refused:${code}`, detail: String(response.error.message ?? '') }
  }
  const result = response.result ?? {}
  log({ method: 'elicitation/create', outcome: result.action, content: result.content })
  return { outcome: String(result.action ?? 'no-action'), content: result.content }
}

function contentLine(tool, nonce, parts) {
  return `elc ${LABEL} tool=${tool} ${parts.join(' ')} nonce=${nonce}`
}

async function runTool(name) {
  // Minted here, per call, present in no file — see the header.
  const nonce = randomBytes(6).toString('hex')

  if (name === 'whoami') {
    log({ method: 'tools/call', tool: name, nonce })
    return contentLine(name, nonce, [TOKEN])
  }

  if (name === 'ask_confirm') {
    log({ method: 'tools/call', tool: name, nonce, mode: 'form' })
    // A single boolean property, which `mcp/elicitation.ts` `planSingleField`
    // renders as one two-option card (`Yes` / `No`) — the smallest shape that
    // puts a REAL question on screen and carries a real value back.
    const answer = await elicit({
      message: `Nessy CDP elicitation probe (${LABEL}): may I continue?`,
      requestedSchema: {
        type: 'object',
        properties: {
          confirm: { type: 'boolean', title: 'Continue?', description: 'Answered by the CDP harness.' },
        },
        required: ['confirm'],
      },
    })
    const confirm = answer.content && typeof answer.content.confirm !== 'undefined'
      ? String(answer.content.confirm)
      : 'absent'
    return contentLine(name, nonce, [`outcome=${answer.outcome}`, `confirm=${confirm}`])
  }

  if (name === 'ask_bad_url') {
    log({ method: 'tools/call', tool: name, nonce, mode: 'url', url: REFUSED_URL })
    // URL mode with a NON-http(s) url. `safeHttpUrl` must refuse it and
    // `declineVisibly` must still put a single-option card on screen before
    // declining — "tell the user why, then decline it, never silently".
    const answer = await elicit({
      mode: 'url',
      elicitationId: `elc-bad-url-${nonce}`,
      url: REFUSED_URL,
      message: `Nessy CDP elicitation probe (${LABEL}): finish signing in.`,
    })
    return contentLine(name, nonce, [`outcome=${answer.outcome}`])
  }

  return null
}

async function handle(message) {
  const { id, method, params } = message

  // A message with no `method` is a RESPONSE to something THIS server asked.
  // Checked before anything else, and it returns UNCONDITIONALLY — including
  // for an id no longer pending.
  //
  // Measured while smoke-testing this file: a late response (one whose dialog
  // had already been settled by the timeout, or a duplicate) fell through to the
  // "unknown method" arm at the bottom and the server replied
  // `-32601 Method not found: undefined` — an ERROR REPLY TO A REPLY, carrying
  // the client's own id back at it. Replying to a response is a protocol error
  // that some clients treat as fatal, and the id collision would have made it
  // look like the client's own request had failed.
  if (method === undefined) {
    const settle = id === undefined || id === null ? undefined : pendingClientRequests.get(id)
    if (settle) {
      pendingClientRequests.delete(id)
      settle(message)
    } else {
      log({ method: 'late-response', responseId: id ?? null })
    }
    return
  }

  // `tools/call` and `initialize` log their own richer line below. Logging the
  // bare method here as well would put TWO `initialize` entries in the file per
  // handshake — one of them without the capabilities — and `elicitHandshakes()`
  // reads the newest, which is an ordering nobody should have to rely on.
  if (method !== 'tools/call' && method !== 'initialize') log({ method })

  // A notification (no `id`) is never answered — replying to one is a protocol
  // error that some clients treat as fatal.
  if (id === undefined || id === null) return

  if (method === 'initialize') {
    // THE handshake read. `capabilities.elicitation` here is the client's
    // declaration on the wire, and its absence is what made every
    // `elicitation/create` a `-32601` before `036d30536`.
    log({ method: 'initialize', clientCapabilities: params?.capabilities ?? null, clientInfo: params?.clientInfo ?? null })
    send({
      jsonrpc: '2.0',
      id,
      result: {
        // Echo the client's version rather than pinning one: the pool has
        // negotiated more than one over this repo's life and a fixture that
        // pins the wrong one fails as "the server is broken".
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: `elc-${LABEL}`, version: '1.0.0' },
      },
    })
    return
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    return
  }
  if (method === 'tools/call') {
    const text = await runTool(params?.name)
    if (text === null) {
      send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } })
      return
    }
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: false } })
    return
  }
  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} })
    return
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  for (;;) {
    const newline = buffer.indexOf('\n')
    if (newline < 0) break
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (!line) continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      log({ method: 'parse-error', error: String(error) })
      continue
    }
    // NOT awaited: a `tools/call` that elicits is held open for as long as the
    // user takes, and awaiting it here would stop this server from ever reading
    // the answer it is waiting for — a deadlock that looks exactly like a
    // client that never replied.
    void handle(parsed).catch(error => log({ method: 'handler-error', error: String(error) }))
  }
})
process.stdin.on('end', () => process.exit(0))
log({ method: 'process-start', pid: process.pid })
