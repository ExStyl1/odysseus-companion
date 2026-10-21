#!/usr/bin/env node
/**
 * The credential-free MCP server the MCP-W wave calls for real.
 *
 * The brief for G6 is explicit about why this exists: every server in the
 * bundles F1 used was OAuth-gated, so "the tool call reached the server" was
 * never once measured. An OAuth wall proves nothing; a local server proves the
 * runtime path. Nothing here needs a credential, a network, or the gateway.
 *
 * Newline-delimited JSON-RPC over stdio — that IS the MCP stdio framing (the
 * `Content-Length` header belongs to LSP, not to MCP), so this speaks the wire
 * format the pool's own client speaks with no SDK dependency to install into a
 * fixture tree.
 *
 * ## The ground truth this file exists to write
 *
 * AGENTS.md: "before filing 'feature X never happens', confirm the negative
 * against a source the feature writes itself". The app's transcript is the
 * app's own account of a tool call; `G6_LOG` is the SERVER's. Every request is
 * appended there as one JSON line before the reply goes out, so a case can
 * answer "did the call actually arrive" without asking the thing under test.
 *
 * ## Why the identity is BAKED IN and not passed as env
 *
 * It was env at first, and the app redacted it — correctly. A value declared in
 * an MCP server's `env` block is a credential as far as the runtime is
 * concerned, and it scrubs such values out of tool OUTPUT: the first live Pi
 * turn returned `[REDACTED] [REDACTED]` where the probe had answered
 * `plugin-echo G6PLUGIN-…`. That is the product behaving properly and a
 * detector destroying itself, so the fixture builder writes the identity into
 * a copy of this file instead (`globalThis.G6_BAKED`). Env is kept only as the
 * fallback for a hand-run self-test.
 *
 * Env fallback (self-test only):
 *   G6_LOG / G6_LABEL / G6_TOKEN — same three values as the baked ones.
 */

import { appendFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const BAKED = globalThis.G6_BAKED ?? {}
const LABEL = BAKED.label ?? process.env.G6_LABEL ?? 'unlabelled'
const TOKEN = BAKED.token ?? process.env.G6_TOKEN ?? 'NO-TOKEN'
const LOG = BAKED.log ?? process.env.G6_LOG

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
      + 'Takes no arguments. The token cannot be guessed or derived — it is generated per run.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function handle(message) {
  const { id, method, params } = message
  if (method !== 'tools/call') log({ method })

  // A notification (no `id`) is never answered — replying to one is a protocol
  // error that some clients treat as fatal.
  if (id === undefined || id === null) return

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        // Echo the client's version rather than pinning one: the pool has
        // negotiated more than one over this repo's life and a fixture that
        // pins the wrong one fails as "the server is broken".
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: `g6-${LABEL}`, version: '1.0.0' },
      },
    })
    return
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    return
  }
  if (method === 'tools/call') {
    if (params?.name !== 'whoami') {
      send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } })
      return
    }
    // The nonce is minted HERE, per call, and exists in no file. A model that
    // read the token off disk instead of calling the tool cannot produce one,
    // and the same nonce in the transcript's tool RESULT and in the model's
    // reply is what ties "a server answered" to "the answer reached the turn".
    const nonce = randomBytes(6).toString('hex')
    log({ method, tool: params?.name, nonce })
    send({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: `${LABEL} ${TOKEN} nonce=${nonce}` }], isError: false },
    })
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
    try {
      handle(JSON.parse(line))
    } catch (error) {
      log({ method: 'parse-error', error: String(error) })
    }
  }
})
process.stdin.on('end', () => process.exit(0))
log({ method: 'process-start', pid: process.pid })
