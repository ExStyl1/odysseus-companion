import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import http from 'http'
import { createCallbackServer, type CallbackServer } from '../callback-server.ts'

/**
 * F1.871 — `requestHandler`'s catch must not write a second status line once
 * the try has already sent the 200 page. A throw after `res.end(html)` (from
 * `server.close()` or `resolveCallback`) used to reach `res.writeHead(500)`,
 * which throws ERR_HTTP_HEADERS_SENT out of the async handler: an unhandled
 * rejection, and `rejectCallback` never ran, so the sign-in waited forever.
 * Same shape as F1.854 in the Nestor reasoning proxy.
 *
 * Loopback only, fabricated query values; faults are injected by a one-shot
 * spy on the http prototypes (restored after each test).
 */

type Reply = { status: number; body: string }

function get(url: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      res.on('error', reject)
    })
    req.on('error', reject)
  })
}

/** Settle `promise` or report it still pending after `ms`. */
function settleWithin<T>(promise: Promise<T>, ms: number): Promise<{ state: 'resolved'; value: T } | { state: 'rejected'; error: unknown } | { state: 'pending' }> {
  return Promise.race([
    promise.then(
      (value) => ({ state: 'resolved' as const, value }),
      (error: unknown) => ({ state: 'rejected' as const, error }),
    ),
    new Promise<{ state: 'pending' }>((resolve) => setTimeout(() => resolve({ state: 'pending' }), ms)),
  ])
}

const restorers: Array<() => void> = []
let open: CallbackServer | null = null

afterEach(async () => {
  while (restorers.length > 0) restorers.pop()!()
  await open?.close()
  open = null
})

function captureUnhandledRejections(): unknown[] {
  const seen: unknown[] = []
  const onRejection = (reason: unknown) => { seen.push(reason) }
  process.on('unhandledRejection', onRejection)
  restorers.push(() => { process.off('unhandledRejection', onRejection) })
  return seen
}

describe('createCallbackServer request handler failures (F1.871)', () => {
  it('a failure after the 200 page was sent keeps that page and rejects the callback, with no second writeHead', async () => {
    open = await createCallbackServer()
    const callbackPromise = open.promise
    callbackPromise.catch(() => {})
    const unhandled = captureUnhandledRejections()

    // Installed only after the bind, so the port scan's own close() calls are untouched.
    const closeSpy = spyOn(http.Server.prototype, 'close').mockImplementationOnce(() => {
      throw new Error('injected close failure')
    })
    restorers.push(() => closeSpy.mockRestore())

    const reply = await get(`${open.url}/callback?code=fabricated-code&state=fabricated-state`)
    expect(reply.status).toBe(200)
    expect(reply.body).toContain('Authorization Complete')

    const settled = await settleWithin(callbackPromise, 1000)
    expect(settled.state).toBe('rejected')
    if (settled.state === 'rejected') {
      expect(settled.error).toBeInstanceOf(Error)
      expect((settled.error as Error).message).toBe('injected close failure')
    }

    // Let a rejection from the async handler surface before reading the capture.
    await new Promise((resolve) => setTimeout(resolve, 50))
    const messages = unhandled.map((r) => (r instanceof Error ? `${(r as NodeJS.ErrnoException).code ?? ''} ${r.message}` : String(r)))
    expect(messages).toEqual([])
  })

  it('control: a failure before the headers still answers the 500 error page and rejects the callback', async () => {
    open = await createCallbackServer()
    const callbackPromise = open.promise
    callbackPromise.catch(() => {})

    const writeHeadSpy = spyOn(http.ServerResponse.prototype, 'writeHead').mockImplementationOnce(() => {
      throw new Error('injected header failure')
    })
    restorers.push(() => writeHeadSpy.mockRestore())

    const reply = await get(`${open.url}/callback?code=fabricated-code&state=fabricated-state`)
    expect(reply.status).toBe(500)
    expect(reply.body).toContain('Nessy Desktop - Error')
    expect(reply.body).toContain('injected header failure')

    const settled = await settleWithin(callbackPromise, 1000)
    expect(settled.state).toBe('rejected')
    if (settled.state === 'rejected') {
      expect((settled.error as Error).message).toBe('injected header failure')
    }
  })
})
