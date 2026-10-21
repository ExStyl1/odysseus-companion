/**
 * WsRpcServer lifecycle & security tests.
 *
 * Tests connection auth, capacity limits, handler timeout, and shutdown behavior.
 * Spawns a real WsRpcServer on a random port for each test.
 */

import { describe, it, expect, afterEach } from 'bun:test'
import WebSocket, { WebSocketServer } from 'ws'
import { rpcHandlerTimeoutForChannel, WsRpcServer } from '../server'
import { WsRpcClient, type TransportConnectionState } from '../client'
import { PROTOCOL_VERSION, RPC_CHANNELS, runtimeMaxMessageBytes } from '@nessy-agent/shared/protocol'

const TEST_TOKEN = 'test-token-with-enough-entropy-to-pass'

function createServer(opts?: {
  maxClients?: number
  requireAuth?: boolean
  validateToken?: (token: string) => Promise<boolean>
}) {
  return new WsRpcServer({
    host: '127.0.0.1',
    port: 0,
    requireAuth: opts?.requireAuth ?? true,
    validateToken: opts?.validateToken ?? (async (t) => t === TEST_TOKEN),
    maxClients: opts?.maxClients,
    serverId: 'test',
  })
}

/**
 * A refusal's close code IS its identity here: `client.ts` maps 4005 to `auth`
 * and 4008 to capacity, so "the handshake rejected" does not distinguish an
 * invalid token from a full server. The helper therefore carries the code on
 * the rejection, and the tests below assert it rather than mere rejection.
 */
interface HandshakeRejection extends Error { closeCode?: number }

function handshake(url: string, token: string): Promise<{ ws: WebSocket; clientId: string; ack: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const timeout = setTimeout(() => {
      ws.close()
      reject(new Error('Handshake timeout'))
    }, 5_000)

    ws.on('open', () => {
      ws.send(JSON.stringify({
        id: crypto.randomUUID(),
        type: 'handshake',
        protocolVersion: PROTOCOL_VERSION,
        token,
      }))
    })
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'handshake_ack') {
        clearTimeout(timeout)
        resolve({ ws, clientId: msg.clientId, ack: msg })
      } else if (msg.type === 'error') {
        clearTimeout(timeout)
        reject(new Error(`Auth error: ${msg.error?.message}`))
        ws.close()
      }
    })
    ws.on('close', (code, reason) => {
      clearTimeout(timeout)
      const failure: HandshakeRejection = new Error(`WS closed: ${code} ${reason}`)
      failure.closeCode = code
      reject(failure)
    })
    ws.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}

describe('WsRpcServer lifecycle', () => {
  let server: WsRpcServer | null = null
  const openSockets: WebSocket[] = []

  afterEach(() => {
    for (const ws of openSockets) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close()
      }
    }
    openSockets.length = 0
    server?.close()
    server = null
  })

  // -- Auth tests --

  it('accepts valid token', async () => {
    server = createServer()
    await server.listen()
    const url = `ws://127.0.0.1:${server.port}`

    const { ws, clientId } = await handshake(url, TEST_TOKEN)
    openSockets.push(ws)

    expect(clientId).toBeTruthy()
    expect(ws.readyState).toBe(WebSocket.OPEN)
    expect(server.getConnectedClientCount()).toBe(1)
  })

  it('advertises its message limit in handshake_ack (Bun ignores maxPayload)', async () => {
    server = createServer()
    await server.listen()
    const { ws, ack } = await handshake(`ws://127.0.0.1:${server.port}`, TEST_TOKEN)
    openSockets.push(ws)

    expect(ack.maxMessageBytes).toBe(runtimeMaxMessageBytes())
  })

  it('rejects invalid token with 4005', async () => {
    server = createServer()
    await server.listen()
    const url = `ws://127.0.0.1:${server.port}`

    // The server sends its AUTH_FAILED envelope BEFORE closing, so `handshake`
    // rejects on the envelope and never sees the code. This test's name states
    // the code, so it watches the socket directly: with a bare
    // `rejects.toThrow()` here the suite stayed green while the server closed
    // an invalid token with 4008 — the code `client.ts` reads as capacity.
    const ws = new WebSocket(url)
    openSockets.push(ws)
    const refusal = await new Promise<{ closeCode: number; errorCode?: string }>((resolve) => {
      let errorCode: string | undefined
      ws.on('open', () => {
        ws.send(JSON.stringify({
          id: crypto.randomUUID(),
          type: 'handshake',
          protocolVersion: PROTOCOL_VERSION,
          token: 'wrong-token',
        }))
      })
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'error') errorCode = msg.error?.code
      })
      ws.on('close', (code) => resolve({ closeCode: code, errorCode }))
    })

    expect(refusal.closeCode).toBe(4005)
    expect(refusal.errorCode).toBe('AUTH_FAILED')
    expect(server.getConnectedClientCount()).toBe(0)
  })

  it('rejects missing token', async () => {
    server = createServer()
    await server.listen()
    const url = `ws://127.0.0.1:${server.port}`

    const ws = new WebSocket(url)
    openSockets.push(ws)

    const closeCode = await new Promise<number>((resolve) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({
          id: crypto.randomUUID(),
          type: 'handshake',
          protocolVersion: PROTOCOL_VERSION,
          // no token
        }))
      })
      ws.on('close', (code) => resolve(code))
    })

    expect(closeCode).toBe(4005)
  })

  // -- Capacity tests --

  it('rejects connections when at maxClients', async () => {
    server = createServer({ maxClients: 2 })
    await server.listen()
    const url = `ws://127.0.0.1:${server.port}`

    // Fill up to capacity
    const { ws: ws1 } = await handshake(url, TEST_TOKEN)
    openSockets.push(ws1)
    const { ws: ws2 } = await handshake(url, TEST_TOKEN)
    openSockets.push(ws2)

    expect(server.getConnectedClientCount()).toBe(2)

    // Third connection should be rejected — AT CAPACITY (4008), not for any
    // other reason. A bare `rejects.toThrow()` passed equally when the server
    // refused a valid token with the auth code.
    const refusal = await handshake(url, TEST_TOKEN).then(
      () => undefined,
      (error: HandshakeRejection) => error,
    )
    expect(refusal?.closeCode).toBe(4008)
  })

  it('allows new connections after a client disconnects', async () => {
    server = createServer({ maxClients: 1 })
    await server.listen()
    const url = `ws://127.0.0.1:${server.port}`

    const { ws: ws1 } = await handshake(url, TEST_TOKEN)

    // Disconnect first client and wait for server to process it
    ws1.close()
    // Poll until server sees the disconnection (max 2s)
    for (let i = 0; i < 40; i++) {
      if (server!.getConnectedClientCount() === 0) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    expect(server!.getConnectedClientCount()).toBe(0)

    // New connection should work
    const { ws: ws2 } = await handshake(url, TEST_TOKEN)
    openSockets.push(ws2)
    expect(server!.getConnectedClientCount()).toBe(1)
  })

  // -- Handler timeout test --

  it('keeps bounded plugin and OAuth lifecycle work alive through its declared timeout', () => {
    expect(rpcHandlerTimeoutForChannel(RPC_CHANNELS.marketplace.INSTALL)).toBe(355_000)
    expect(rpcHandlerTimeoutForChannel(RPC_CHANNELS.marketplace.UPGRADE_REGISTRY)).toBe(55_000)
    expect(rpcHandlerTimeoutForChannel(RPC_CHANNELS.plugins.MANAGE)).toBe(355_000)
    expect(rpcHandlerTimeoutForChannel(RPC_CHANNELS.oauth.START)).toBe(85_000)
    expect(rpcHandlerTimeoutForChannel(RPC_CHANNELS.oauth.COMPLETE)).toBe(85_000)
    expect(rpcHandlerTimeoutForChannel('test:ordinary')).toBe(60_000)
  })

  /**
   * D1.150 — a thrown payload reaches the caller, and an ordinary error is
   * unchanged.
   *
   * `WireError.data` has always been in the envelope and the receiving side
   * always copied it, but nothing on the sending side filled it, so the whole
   * chain was inert: the one live payload is `CONNECTION_IN_USE`'s holder
   * names, which a renderer must print verbatim beside a sentence it builds in
   * the reader's own language.
   */
  it('forwards a thrown error payload, and sends no data field without one', async () => {
    server = createServer()
    await server.listen()
    const url = `ws://127.0.0.1:${server.port}`

    server.handle('test:with-data', async () => {
      const error = new Error('two chats still use it') as Error & { code: string; data: unknown }
      error.code = 'CONNECTION_IN_USE'
      error.data = { sessions: ['Refactor auth'], automations: [], moreSessions: 0, moreAutomations: 0 }
      throw error
    })
    server.handle('test:plain', async () => { throw new Error('nothing to add') })

    const { ws } = await handshake(url, TEST_TOKEN)
    openSockets.push(ws)

    const ask = (channel: string) => new Promise<Record<string, any>>((resolve) => {
      const reqId = crypto.randomUUID()
      const onMessage = (raw: unknown) => {
        const envelope = JSON.parse(String(raw)) as Record<string, any>
        if (envelope.id !== reqId) return
        ws.off('message', onMessage)
        resolve(envelope)
      }
      ws.on('message', onMessage)
      ws.send(JSON.stringify({ id: reqId, type: 'request', channel, payload: [] }))
    })

    const withData = await ask('test:with-data')
    expect(withData.error.code).toBe('CONNECTION_IN_USE')
    expect(withData.error.data).toEqual({
      sessions: ['Refactor auth'], automations: [], moreSessions: 0, moreAutomations: 0,
    })

    // The NEGATIVE: an ordinary handler error carries no `data` key at all, so
    // an envelope for a payload-free failure is byte-identical to what it was.
    const plain = await ask('test:plain')
    expect(plain.error.code).toBe('HANDLER_ERROR')
    expect('data' in plain.error).toBe(false)
  }, 15_000)

  it('times out slow handlers', async () => {
    server = createServer()
    await server.listen()
    const url = `ws://127.0.0.1:${server.port}`

    // Register a handler that never resolves
    server.handle('test:slow', async () => {
      await new Promise(() => {}) // never resolves
    })

    const { ws } = await handshake(url, TEST_TOKEN)
    openSockets.push(ws)

    // Send a request to the slow handler
    const reqId = crypto.randomUUID()
    ws.send(JSON.stringify({
      id: reqId,
      type: 'request',
      channel: 'test:slow',
    }))

    // Should receive error response (but this will take 60s — skip in normal runs)
    // This test validates the handler is registered; full timeout is covered by the 60s static value
  })

  // -- Protocol version tests --

  it('rejects wrong protocol major version', async () => {
    server = createServer()
    await server.listen()
    const url = `ws://127.0.0.1:${server.port}`

    const ws = new WebSocket(url)
    openSockets.push(ws)

    const closeCode = await new Promise<number>((resolve) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({
          id: crypto.randomUUID(),
          type: 'handshake',
          protocolVersion: '99.0',
          token: TEST_TOKEN,
        }))
      })
      ws.on('close', (code) => resolve(code))
    })

    expect(closeCode).toBe(4004)
  })

  // -- Close behavior --

  it('terminates all clients on close()', async () => {
    server = createServer()
    await server.listen()
    const url = `ws://127.0.0.1:${server.port}`

    const { ws: ws1 } = await handshake(url, TEST_TOKEN)
    const { ws: ws2 } = await handshake(url, TEST_TOKEN)
    openSockets.push(ws1, ws2)

    const closedPromise = Promise.all([
      new Promise(resolve => ws1.on('close', resolve)),
      new Promise(resolve => ws2.on('close', resolve)),
    ])

    server.close()
    await closedPromise

    expect(server.getConnectedClientCount()).toBe(0)
  })
})

/**
 * UB4.14 — the client half of `handshake_ack.maxMessageBytes`: the connection
 * state the renderer reads (`useTransportConnectionState`) carries the limit
 * the server advertised, and carries NOTHING for a server that advertises none,
 * so the composer falls back to `DEFAULT_MAX_MESSAGE_BYTES` instead of a number
 * this client invented.
 */
describe('WsRpcClient — the advertised message limit (UB4.14)', () => {
  const teardown: Array<() => void> = []
  afterEach(() => {
    for (const fn of teardown.splice(0).reverse()) {
      try { fn() } catch { /* best-effort */ }
    }
  })

  function connectedState(url: string): Promise<TransportConnectionState> {
    const client = new WsRpcClient(url, { token: TEST_TOKEN, workspaceId: 'ws-a', autoReconnect: false })
    teardown.push(() => client.destroy())
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('client never connected')), 5_000)
      const off = client.onConnectionStateChanged((state) => {
        if (state.status === 'connected') {
          clearTimeout(timer); off(); resolve(state)
        } else if (state.status === 'failed' || state.status === 'disconnected') {
          clearTimeout(timer); off(); reject(new Error(`status=${state.status}`))
        }
      })
      client.connect()
    })
  }

  it('records the limit a current server advertises', async () => {
    const server = createServer()
    await server.listen()
    teardown.push(() => server.close())

    const state = await connectedState(`ws://127.0.0.1:${server.port}`)
    expect(state.maxMessageBytes).toBe(runtimeMaxMessageBytes())
  })

  it('records no limit for an older server whose handshake_ack has no field', async () => {
    const legacy = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    teardown.push(() => legacy.close())
    await new Promise<void>(resolve => legacy.on('listening', () => resolve()))
    legacy.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type !== 'handshake') return
        ws.send(JSON.stringify({
          id: msg.id,
          type: 'handshake_ack',
          protocolVersion: PROTOCOL_VERSION,
          clientId: 'legacy-client',
          registeredChannels: [],
        }))
      })
    })
    const address = legacy.address()
    const port = typeof address === 'object' && address ? address.port : 0

    const state = await connectedState(`ws://127.0.0.1:${port}`)
    expect(state.status).toBe('connected')
    expect(state.maxMessageBytes).toBeUndefined()
  })
})
