/**
 * DA3.11 + DA3.10 — the two request-layer controls that have no sub-decisions.
 *
 * ## DA3.11 — where the health probe binds, and who may read it
 *
 * `startHealthHttpServer` called `Bun.serve` with a port and NO hostname, so the
 * health port bound every interface and `/health` was unauthenticated on all of
 * them; the function's own log line printed the `0.0.0.0` form, which was the one
 * honest part. The donor this server's posture is audited against exempts
 * `/health` from bearer auth on LOOPBACK ONLY (`packages/server/src/index.ts`,
 * the DA3.4 audit docblock, item 7).
 *
 * ## DA3.10's first half — a constant-time bearer compare
 *
 * `bootstrapServer` validated the handshake with `t === serverToken`, which
 * returns as soon as two bytes differ. `tokensMatch` hashes both sides and
 * compares the digests, and hashing BOTH is load-bearing: `timingSafeEqual`
 * throws on a length mismatch, so a wrong-length guess would otherwise be an
 * exception rather than a `false`.
 *
 * DA3.10's other two halves are NOT here, on purpose. The Origin deny is refuted
 * as sub-decision-free — this product's own desktop preload client and its webui
 * are browsers on the same `WsRpcServer`, and a browser always sends `Origin`;
 * the measurement is in that same audit docblock, item 6. The port-keyed Host
 * allowlist changes what a deployment behind a proxy accepts, which is the
 * owner's call.
 *
 * Every arm below drives the REAL `Bun.serve` listener over a real HTTP request,
 * rather than reading the options object: the question is what a probe receives.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import {
  bearerCredential,
  isLoopbackBindHost,
  startHealthHttpServer,
  tokensMatch,
} from '../headless-start.ts'

/** Never a real token. */
const TOKEN = 'da311-fabricated-server-token-0000'

const deps = { sessionManager: { getWorkspaces: () => [] } }
const platform = { logger: { info() {}, warn() {}, error() {}, debug() {} } } as never

/** A port nothing is listening on: bind one, read it, release it. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
  const port = probe.port
  probe.stop(true)
  if (port === undefined) throw new Error('the probe server bound no port')
  return port
}

const started: Array<{ stop: () => void }> = []
afterEach(() => {
  while (started.length) started.pop()!.stop()
})

async function start(hostname: string | undefined): Promise<{ base: string; hostname: string }> {
  const server = await startHealthHttpServer({
    port: freePort(),
    ...(hostname === undefined ? {} : { hostname }),
    token: TOKEN,
    deps,
    wsServer: undefined as never,
    platform,
  })
  expect(server).not.toBeNull()
  started.push(server!)
  return { base: `http://127.0.0.1:${server!.port}`, hostname: server!.hostname }
}

describe('DA3.11 · the health probe binds the RPC bind and is open only on loopback', () => {
  it('on a loopback bind: /health answers without a bearer, and binds 127.0.0.1', async () => {
    const { base, hostname } = await start('127.0.0.1')

    // The bind itself, read off the listener rather than off the options.
    expect(hostname).toBe('127.0.0.1')

    const response = await fetch(`${base}/health`)
    expect(response.status).toBe(200)
    expect((await response.json() as { status: string }).status).toBe('ok')

    // Control that the server is up and routing rather than answering 200 to
    // everything: an unknown path is still a 404, exactly as before this row.
    expect((await fetch(`${base}/nope`)).status).toBe(404)
  })

  it('on a NON-loopback bind: /health is 401 without a bearer and 401 with the wrong one', async () => {
    const { base } = await start('0.0.0.0')

    expect((await fetch(`${base}/health`)).status).toBe(401)
    expect((await fetch(`${base}/health`, {
      headers: { authorization: `Bearer ${TOKEN}-not` },
    })).status).toBe(401)
  })

  it('on a NON-loopback bind: the right bearer still gets the reading (positive control)', async () => {
    // Without this the two 401s above are equally true of a gate nothing can pass.
    const { base } = await start('0.0.0.0')

    const response = await fetch(`${base}/health`, { headers: { authorization: `Bearer ${TOKEN}` } })
    expect(response.status).toBe(200)
    expect((await response.json() as { status: string }).status).toBe('ok')
  })

  it('BOUNDARY: a caller that names no hostname is treated as NOT loopback', async () => {
    // Fail closed on the unknown: an omitted hostname keeps the old
    // every-interface bind, so it must not also keep the open probe.
    const { base } = await start(undefined)

    expect((await fetch(`${base}/health`)).status).toBe(401)
    expect((await fetch(`${base}/health`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200)
  })
})

describe('DA3.10 · the constant-time compare, and the one header this server parses', () => {
  it('matches the exact token and refuses every near miss', () => {
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true)
    // A wrong-LENGTH guess is the arm that would THROW if only one side were
    // hashed — the reason `tokensMatch` digests both.
    expect(tokensMatch(`${TOKEN}x`, TOKEN)).toBe(false)
    expect(tokensMatch(TOKEN.slice(0, -1), TOKEN)).toBe(false)
    // A guess sharing every leading byte but one: the case the old `===`
    // answered fastest.
    expect(tokensMatch(`${TOKEN.slice(0, -1)}1`, TOKEN)).toBe(false)
    expect(tokensMatch('', TOKEN)).toBe(false)
    expect(tokensMatch(null, TOKEN)).toBe(false)
    expect(tokensMatch(undefined, TOKEN)).toBe(false)
  })

  it('reads an Authorization header the way RFC 7235 spells it, and nothing else', () => {
    expect(bearerCredential(`Bearer ${TOKEN}`)).toBe(TOKEN)
    // The scheme token is case-insensitive, and the separator may be more than
    // one space.
    expect(bearerCredential(`bearer   ${TOKEN}`)).toBe(TOKEN)
    // Not a bearer, not a credential.
    expect(bearerCredential(`Basic ${TOKEN}`)).toBeNull()
    expect(bearerCredential(TOKEN)).toBeNull()
    expect(bearerCredential('Bearer')).toBeNull()
    expect(bearerCredential('')).toBeNull()
    expect(bearerCredential(null)).toBeNull()
  })

  it('isLoopbackBindHost answers for the three spellings, and refuses the rest', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) expect(isLoopbackBindHost(host)).toBe(true)
    for (const host of ['0.0.0.0', '10.0.0.5', 'example.com', '', undefined]) {
      expect(isLoopbackBindHost(host)).toBe(false)
    }
    // STATED RESIDUE, asserted so it cannot change unnoticed: the bracketed IPv6
    // form is not in the set, so it takes TLS and a bearer it does not need.
    // Fail-closed, and widening it would move the TLS gate, which is not DA3.11.
    expect(isLoopbackBindHost('[::1]')).toBe(false)
  })
})
