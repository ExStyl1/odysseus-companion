import { describe, expect, it } from 'bun:test'
import http from 'http'
import { NessyOAuth } from '../oauth.ts'

/**
 * F1.1101 (origin DN-067) — the MCP OAuth callback page (`NessyOAuth.startCallbackServer`) names its charset in the
 * Content-Type header, as `callback-server.ts` and server-core's web UI callback already do. The page also declares
 * UTF-8 in a meta tag, so it rendered correctly before; the header makes the encoding the transport's statement too.
 *
 * Each of the four branches that answer the page (provider error, state mismatch, no code, success) is driven over
 * loopback against the real server, with fabricated query values; the 404 branch answers plain text and is the control.
 */

type Reply = { status: number; contentType: string | undefined }

function get(url: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode ?? 0, contentType: res.headers['content-type'] }))
      res.on('error', reject)
    })
    req.on('error', reject)
  })
}

type Start = (this: NessyOAuth, state: string) => Promise<{ port: number; codePromise: Promise<string> }>
const start = (NessyOAuth.prototype as unknown as { startCallbackServer: Start }).startCallbackServer

async function answer(query: string): Promise<Reply> {
  const oauth = new NessyOAuth({ mcpUrl: 'https://mcp.example.invalid/mcp' }, { onStatus: () => {}, onError: () => {} })
  const { port, codePromise } = await start.call(oauth, 'expected-state')
  codePromise.catch(() => undefined)
  try {
    return await get(`http://localhost:${port}${query}`)
  } finally {
    oauth.cancel()
  }
}

describe('F1.1101 — the OAuth callback page states charset=utf-8', () => {
  const UTF8_HTML = 'text/html; charset=utf-8'

  it('the provider-error, state-mismatch and no-code pages', async () => {
    expect(await answer('/oauth/callback?error=access_denied')).toEqual({ status: 400, contentType: UTF8_HTML })
    expect(await answer('/oauth/callback?code=c&state=forged')).toEqual({ status: 400, contentType: UTF8_HTML })
    expect(await answer('/oauth/callback?state=expected-state')).toEqual({ status: 400, contentType: UTF8_HTML })
  })

  it('the success page', async () => {
    expect(await answer('/oauth/callback?code=c&state=expected-state')).toEqual({ status: 200, contentType: UTF8_HTML })
  })

  it('CONTROL — a path off the callback answers 404 with no HTML type', async () => {
    const reply = await answer('/elsewhere')
    expect(reply.status).toBe(404)
    expect(reply.contentType ?? '').not.toContain('text/html')
  })
})
