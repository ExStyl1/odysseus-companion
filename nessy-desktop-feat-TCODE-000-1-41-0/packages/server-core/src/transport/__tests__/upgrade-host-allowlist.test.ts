/**
 * DA3.14 — the port-keyed loopback `Host` allowlist on `WsRpcServer`.
 *
 * WHAT THIS PRICES, and why the negative arms matter more than the positive:
 * the gate exists for DNS rebinding, where a page on any origin makes the
 * victim's own browser open `ws://attacker.invalid:<our port>` after that name
 * has been made to resolve to 127.0.0.1. The connection then arrives FROM
 * loopback, so every peer-address check passes; the only thing that names the
 * attacker is the `Host` header the browser is obliged to send.
 *
 * EVERY ARM IS OVER A REAL LISTENER — `WsRpcServer.listen()` with the real `ws`
 * client, no `verifyClient` stub — because the thing under test IS the upgrade,
 * and a stub of the hook would measure this file's own arithmetic. The rebinding
 * arms send the header with the `ws` client's own `headers` option, which is how
 * the shape is reproduced without a DNS entry: the socket really connects to
 * 127.0.0.1 and really presents another authority, which is exactly the
 * rebinding request as the server sees it.
 *
 * `verifyClient` aborts BEFORE the handshake, so a refusal surfaces as an
 * `error` on the client rather than as a close code — the two auth refusals in
 * `server-lifecycle.test.ts` are close codes because they happen after the
 * socket is open, and this one cannot be. THE STATUS CODE IS READ WITH A RAW
 * REQUEST, not off that error: measured 2026-09-17, the client's message here
 * is Bun's (`Expected 101 status code`) and carries no number at all, so an
 * assertion on it would have passed for 401 and for 403 alike — and the whole
 * reason the callback form of `verifyClient` was chosen is that `401` would
 * tell an operator reading a proxy log that their credentials were wrong.
 *
 * ONE TRAP THIS FILE WOULD OTHERWISE HIDE: under Bun, `import WebSocket from
 * 'ws'` is NOT the `ws` package — it resolves to Bun's own `BunWebSocket` shim.
 * That is fine here (it is the shape `apps/cli` runs), but it means these arms
 * measure the Bun client, and the `ws` package's own behaviour was measured
 * separately under node.
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { request as httpRequest } from 'node:http'
import WebSocket from 'ws'
import { WsRpcServer } from '../server'

const servers: WsRpcServer[] = []

function startServer(opts: {
  allowLoopbackHostsOnly?: boolean
  extraAllowedUpgradeHosts?: readonly string[]
  host?: string
}): Promise<WsRpcServer> {
  const server = new WsRpcServer({
    host: opts.host ?? '127.0.0.1',
    port: 0,
    serverId: 'test',
    ...(opts.allowLoopbackHostsOnly === undefined
      ? {}
      : { allowLoopbackHostsOnly: opts.allowLoopbackHostsOnly }),
    ...(opts.extraAllowedUpgradeHosts ? { extraAllowedUpgradeHosts: opts.extraAllowedUpgradeHosts } : {}),
  })
  servers.push(server)
  return server.listen().then(() => server)
}

/**
 * Open a socket and report only whether the UPGRADE was accepted. `hostHeader`
 * overrides the authority the client would derive from the url, which is the
 * whole instrument: the tcp peer stays 127.0.0.1.
 */
function tryUpgrade(url: string, hostHeader?: string): Promise<{ opened: boolean; error: string }> {
  return new Promise(resolve => {
    const ws = new WebSocket(url, hostHeader ? { headers: { host: hostHeader } } : {})
    const settle = (result: { opened: boolean; error: string }) => {
      clearTimeout(timer)
      try { ws.close() } catch { /* already closed */ }
      resolve(result)
    }
    const timer = setTimeout(() => settle({ opened: false, error: 'timeout' }), 5_000)
    ws.on('open', () => settle({ opened: true, error: '' }))
    ws.on('error', (err: Error) => settle({ opened: false, error: err.message }))
  })
}

/**
 * The upgrade as an HTTP request, so the REFUSAL'S STATUS CODE can be read.
 * Resolves with the status of whatever the server answers — `101` when the
 * upgrade is accepted, the refusal's own code when it is not.
 */
function upgradeStatus(port: number, hostHeader: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/',
      headers: {
        host: hostHeader,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    })
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode ?? 101) })
    req.on('response', res => { res.resume(); resolve(res.statusCode ?? 0) })
    req.on('error', reject)
    req.end()
  })
}

afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

describe('DA3.14 — the loopback Host allowlist', () => {
  it('accepts the authority every shipped client presents, and refuses a rebinding one', async () => {
    const server = await startServer({ allowLoopbackHostsOnly: true })
    const url = `ws://127.0.0.1:${server.port}`

    // The positive: this is byte-for-byte what the CLI, the `ws` client and
    // Chromium at `http://127.0.0.1:<port>` were measured to send.
    expect(await tryUpgrade(url)).toEqual({ opened: true, error: '' })
    // The webui as a user opens it — a loopback NAME rather than the literal.
    expect((await tryUpgrade(url, `localhost:${server.port}`)).opened).toBe(true)

    // The negative, same port, same peer, different authority.
    const rebind = await tryUpgrade(url, `attacker.invalid:${server.port}`)
    expect(rebind.opened).toBe(false)
  })

  it('refuses with 403 and not 401, so a proxy log does not read as bad credentials', async () => {
    const server = await startServer({ allowLoopbackHostsOnly: true })

    expect(await upgradeStatus(server.port, `attacker.invalid:${server.port}`)).toBe(403)
    // The control that 403 is this gate's answer and not the listener's answer
    // to every raw upgrade: the same request with our own authority is accepted.
    expect(await upgradeStatus(server.port, `127.0.0.1:${server.port}`)).toBe(101)
  })

  it('is PORT-keyed whenever a port is presented, and portless falls back to the name', async () => {
    const server = await startServer({ allowLoopbackHostsOnly: true })
    const url = `ws://127.0.0.1:${server.port}`

    // A caller that guessed the name and not the number.
    expect((await tryUpgrade(url, `127.0.0.1:${server.port + 1}`)).opened).toBe(false)

    // A `Host` with NO port is decided by the hostname alone — measured, not
    // conceded: Bun's client omits the port from an IPv6 `Host`, and `apps/cli`
    // runs on Bun, so refusing the portless form would refuse our own CLI on an
    // `::1` bind. A portless header cannot claim a different port, and the
    // rebinding shape always names a non-loopback host, which the next line
    // pins: portless does NOT mean unchecked.
    expect((await tryUpgrade(url, '127.0.0.1')).opened).toBe(true)
    expect((await tryUpgrade(url, 'attacker.invalid')).opened).toBe(false)
  })

  it('admits exactly the authorities the operator listed, and nothing near them', async () => {
    const server = await startServer({
      allowLoopbackHostsOnly: true,
      extraAllowedUpgradeHosts: ['agent.corp.example'],
    })
    const url = `ws://127.0.0.1:${server.port}`

    // The reverse-proxy deployment: `Host` is the public name the proxy
    // forwarded, with no port, and the allowlist matches the header as
    // presented rather than re-deriving a port for it.
    expect((await tryUpgrade(url, 'agent.corp.example')).opened).toBe(true)
    // Case folding, because a proxy's spelling is not the operator's.
    expect((await tryUpgrade(url, 'Agent.Corp.Example')).opened).toBe(true)
    // The boundary: a neighbouring name is NOT admitted by a prefix or suffix,
    // and the listed entry is matched as presented — the operator writes the
    // authority their proxy actually forwards, port and all.
    expect((await tryUpgrade(url, 'evil-agent.corp.example')).opened).toBe(false)
    expect((await tryUpgrade(url, `agent.corp.example:${server.port}`)).opened).toBe(false)
  })

  it('is OFF unless asked, so a LAN or remote bind is untouched', async () => {
    // The control for every refusal above: the same rebinding header on a
    // server built the way `apps/electron` builds its own in tests — no option
    // at all — opens. So what refuses is this gate and not the transport.
    const server = await startServer({})
    const rebind = await tryUpgrade(`ws://127.0.0.1:${server.port}`, `attacker.invalid:${server.port}`)
    expect(rebind).toEqual({ opened: true, error: '' })
  })

  it('recognises its own clients on an ::1 bind, where the header is bracketed', async () => {
    // `isLoopbackBindHost` calls `::1` a loopback bind, so the gate turns ON
    // there; a `Host` header spells IPv6 bracketed by definition. If the set
    // were the bind predicate's three values verbatim, this server would refuse
    // every one of its own clients. This arm is also where the portless rule
    // earns its keep — the client below is Bun's, and it sends `Host: [::1]`.
    const server = await startServer({ allowLoopbackHostsOnly: true, host: '::1' })
    expect((await tryUpgrade(`ws://[::1]:${server.port}`)).opened).toBe(true)
    // The `ws` package's spelling of the same authority, which carries the port.
    expect((await tryUpgrade(`ws://[::1]:${server.port}`, `[::1]:${server.port}`)).opened).toBe(true)
    expect((await tryUpgrade(`ws://[::1]:${server.port}`, `attacker.invalid:${server.port}`)).opened).toBe(false)
  })
})
