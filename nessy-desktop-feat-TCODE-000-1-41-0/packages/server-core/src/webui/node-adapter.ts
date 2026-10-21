/**
 * Node HTTP ↔ Web Standard adapter.
 *
 * Bridges Node.js `(IncomingMessage, ServerResponse)` callbacks to
 * the web-standard `(Request) => Response` handler used by the WebUI.
 * This lets us serve the WebUI from the same HTTPS server that the
 * WsRpcServer creates for WebSocket connections.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

type WebHandler = (req: Request) => Promise<Response> | Response

/**
 * Wrap a web-standard fetch handler as a Node HTTP request listener.
 * WebSocket upgrade requests are NOT routed through this adapter —
 * the `ws` library intercepts them at the 'upgrade' event level.
 */
export function nodeHttpAdapter(
  handler: WebHandler,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (nodeReq, nodeRes) => {
    handleRequest(handler, nodeReq, nodeRes).catch((err) => {
      console.error('[webui-adapter] Unhandled error:', err)
      if (!nodeRes.headersSent) {
        nodeRes.writeHead(500, { 'Content-Type': 'text/plain' })
      }
      nodeRes.end('Internal Server Error')
    })
  }
}

async function handleRequest(
  handler: WebHandler,
  nodeReq: IncomingMessage,
  nodeRes: ServerResponse,
): Promise<void> {
  // Build web-standard Request from Node IncomingMessage
  const encrypted = !!(nodeReq.socket as any).encrypted
  const protocol = encrypted ? 'https' : 'http'
  const host = nodeReq.headers.host ?? 'localhost'
  const url = `${protocol}://${host}${nodeReq.url ?? '/'}`

  const headers = new Headers()
  // `rawHeaders` is a FLAT array of alternating name/value, so the value of the
  // last pair is the one entry that can be missing. Reading it unchecked is the
  // repo's single production `noUncheckedIndexedAccess` error (P2.369), and it is
  // not merely a type complaint: `Headers.append(name, undefined)` stringifies,
  // so an odd-length array would have shipped a header whose value is the literal
  // text "undefined" rather than dropping the malformed pair.
  const raw = nodeReq.rawHeaders
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i]
    const value = raw[i + 1]
    if (name === undefined || value === undefined) continue
    headers.append(name, value)
  }

  let body: Buffer | null = null
  if (nodeReq.method !== 'GET' && nodeReq.method !== 'HEAD') {
    const chunks: Buffer[] = []
    for await (const chunk of nodeReq) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    }
    body = Buffer.concat(chunks)
  }

  const request = new Request(url, {
    method: nodeReq.method,
    headers,
    body,
  })

  const response = await handler(request)

  // Write web-standard Response back to Node ServerResponse.
  // Headers.forEach iterates each value separately, which correctly
  // handles multi-value headers like Set-Cookie.
  const resHeaders: Record<string, string | string[]> = {}
  response.headers.forEach((value, key) => {
    const existing = resHeaders[key]
    if (existing) {
      resHeaders[key] = Array.isArray(existing)
        ? [...existing, value]
        : [existing, value]
    } else {
      resHeaders[key] = value
    }
  })

  nodeRes.writeHead(response.status, resHeaders)

  if (response.body) {
    const buffer = Buffer.from(await response.arrayBuffer())
    nodeRes.end(buffer)
  } else {
    nodeRes.end()
  }
}
