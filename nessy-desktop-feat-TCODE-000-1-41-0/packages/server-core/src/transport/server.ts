/**
 * WsRpcServer — WebSocket-based RPC server.
 *
 * Owns ALL transport concerns: connection lifecycle, handshake, heartbeat,
 * optional auth, request dispatching, and push routing.
 *
 * Same class used locally (127.0.0.1, no auth) and remotely (0.0.0.0, auth).
 */

import { WebSocketServer, type WebSocket, type VerifyClientCallbackAsync } from 'ws'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { randomUUID } from 'node:crypto'
import {
  PROTOCOL_VERSION,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MAX_MISSED,
  EVENT_BUFFER_MAX_SIZE,
  EVENT_BUFFER_TTL_MS,
  DISCONNECTED_CLIENT_TTL_MS,
  NODE_WS_MAX_MESSAGE_BYTES,
  RPC_REQUEST_TIMEOUT_BY_CHANNEL,
  runtimeMaxMessageBytes,
  isErrorCode,
  type MessageEnvelope,
  type PushTarget,
  type ErrorCode,
} from '@nessy-agent/shared/protocol'
import type { RpcServer, HandlerFn, RequestContext } from './types'
import { USER_PACED_CLIENT_CHANNELS, USER_PACED_CLIENT_INVOKE_TIMEOUT_MS } from './capabilities'
import { serializeEnvelope, deserializeEnvelope } from './codec'
import { createLogger } from '@nessy-agent/shared/utils'

// ---------------------------------------------------------------------------
// Client connection state
// ---------------------------------------------------------------------------

interface BufferedEvent {
  seq: number
  /** Shared serialized envelope — one allocation referenced by all client buffers. */
  data: string
  timestamp: number
}

interface ClientConnection {
  id: string
  ws: WebSocket
  workspaceId: string | null
  webContentsId: number | null
  capabilities: Set<string>
  missedPongs: number
  alive: boolean
  /** Ring buffer of recent events for replay on reconnect. */
  eventBuffer: BufferedEvent[]
  /** Highest per-client seq the client has acknowledged. */
  lastAckedSeq: number
  /** Highest per-client seq assigned to this client. */
  lastSentSeq: number
}

interface PendingInvoke {
  clientId: string
  resolve: (value: any) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

// ---------------------------------------------------------------------------
// Server options
// ---------------------------------------------------------------------------

export interface WsRpcTlsOptions {
  /** PEM-encoded certificate (or Buffer). */
  cert: string | Buffer
  /** PEM-encoded private key (or Buffer). */
  key: string | Buffer
  /** Optional PEM-encoded CA chain for client certificate verification. */
  ca?: string | Buffer
  /** Optional passphrase for encrypted private keys. */
  passphrase?: string
}

export interface WsRpcServerOptions {
  /** Host to bind to. Default: '127.0.0.1' */
  host?: string
  /** Port to bind to. 0 = random available port. Default: 0 */
  port?: number
  /** Whether to require a bearer token on handshake. Default: false */
  requireAuth?: boolean
  /** Token validator. Called when requireAuth is true. */
  validateToken?: (token: string) => Promise<boolean>
  /**
   * Optional cookie-based session validator (for web UI auth).
   * Called with the Cookie header from the HTTP upgrade request.
   * If provided, a valid session cookie is accepted as an alternative to a bearer token.
   */
  validateSessionCookie?: (cookieHeader: string | null) => Promise<boolean>
  /** Server identity stamp on outgoing events. Default: 'local' */
  serverId?: string
  /** TLS configuration. When provided, the server listens on wss:// instead of ws://. */
  tls?: WsRpcTlsOptions
  /** App version string, included in handshake_ack for client compatibility checks. */
  serverVersion?: string
  /** Maximum concurrent clients. 0 = unlimited. Default: 50 */
  maxClients?: number
  /** Called when a client completes handshake. */
  onClientConnected?: (info: { clientId: string; webContentsId: number | null; workspaceId: string | null; capabilities: string[] }) => void
  /** Called when a client disconnects. */
  onClientDisconnected?: (clientId: string) => void
  /**
   * Optional HTTP request handler for non-WebSocket requests.
   * When provided, regular HTTP requests to the server's port are
   * routed here instead of being rejected. This enables serving the
   * WebUI from the same port as the WebSocket server.
   * Must use Node.js HTTP callback signature (IncomingMessage, ServerResponse).
   */
  httpHandler?: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void
  /**
   * DA3.14 — refuse an upgrade whose `Host` is not this server's OWN loopback
   * authority. The control DNS rebinding needs: a page on any origin can make a
   * browser open `ws://attacker.invalid:<our port>` once that name resolves to
   * 127.0.0.1, and every other gate on this listener (the bearer, the cookie,
   * the capacity cap) is downstream of the handshake the browser would then
   * complete.
   *
   * DEFAULT `false`, deliberately: this class is the same one a LAN or remote
   * deployment listens with, where the browser legitimately names a public
   * host. {@link bootstrapServer} turns it on when — and only when — the bind
   * itself is loopback, which it decides with `isLoopbackBindHost`, the one
   * spelling DA3.11 left in `bootstrap/headless-start.ts`. Deriving it here
   * would have been a second copy of that predicate, and a build where the two
   * disagreed is the failure DA3.11 exists to prevent.
   *
   * WHAT THE THREE SHIPPED CLIENTS SEND, measured 2026-09-17 over a real
   * `node:http` + `ws` listener on a loopback bind — the same pair
   * {@link WsRpcServer.listen} builds, not a `Bun.serve` stand-in:
   *
   * | client | `Host` | `Origin` |
   * | --- | --- | --- |
   * | Bun's global `WebSocket` (`apps/cli`) | `127.0.0.1:<port>` | absent |
   * | the `ws` package (the `wss://` branch of `transport/client.ts`) | `127.0.0.1:<port>` | absent |
   * | Chromium at `http://127.0.0.1:<port>` (the desktop preload's shape) | `127.0.0.1:<port>` | `http://127.0.0.1:<port>` |
   * | Chromium at `http://localhost:<port>` (the webui as a user opens it) | `localhost:<port>` | `http://localhost:<port>` |
   * | a client naming a rebinding host | `attacker.invalid:<port>` | absent |
   *
   * So all three carry a loopback authority and the gate is free for them —
   * which is the owner's stated condition for defaulting it on — while the
   * rebinding shape is refused. That last row is also the CONTROL that this
   * header is the URL's authority and not the socket's peer address: the
   * connection came from 127.0.0.1 and still presented `attacker.invalid`.
   *
   * WHICH RUNTIME TOOK EACH ROW MATTERS, because the specifier lies: under Bun,
   * `import WebSocket from 'ws'` resolves to Bun's own `BunWebSocket` shim and
   * not to the package (printed from the import to check). The `ws` row above
   * was therefore taken under NODE, with `require.resolve('ws')` printed as its
   * provenance; the Bun rows under Bun. A single-runtime reading would have
   * recorded one client twice and called it two.
   */
  allowLoopbackHostsOnly?: boolean
  /**
   * Extra `Host` authorities accepted alongside the loopback set when
   * {@link WsRpcServerOptions.allowLoopbackHostsOnly} is on, matched
   * case-insensitively against the header as presented.
   *
   * THE DEPLOYMENT THIS EXISTS FOR IS REAL AND IS OURS: the webui does not
   * hard-code its WebSocket authority, it is TOLD one —
   * `webui/http-server.ts` symbol `resolveWebSocketUrl` answers `/api/config`
   * with `publicWsUrl` if the operator set one, else with the host of the page
   * request itself (`x-forwarded-host` first). Behind a reverse proxy on the
   * same machine the bind stays loopback while the browser is handed a public
   * name, and whether the proxy then forwards that name depends on its own
   * config (nginx's `$proxy_host` default would pass this gate; the equally
   * common `proxy_set_header Host $host` would not). One operator-visible
   * escape rather than a guess about proxies.
   */
  extraAllowedUpgradeHosts?: readonly string[]
}

const transportLog = createLogger('ws-rpc-server')
const DEFAULT_HANDLER_TIMEOUT_MS = 60_000

export function rpcHandlerTimeoutForChannel(channel: string): number {
  const requestTimeout = RPC_REQUEST_TIMEOUT_BY_CHANNEL[channel]
  return requestTimeout === undefined ? DEFAULT_HANDLER_TIMEOUT_MS : requestTimeout - 5_000
}

/** What a server→client invoke gets when nobody is waiting on a person. */
const DEFAULT_CLIENT_INVOKE_TIMEOUT_MS = 30_000

/**
 * D1.224 — the budget for one server→client invoke.
 *
 * Extracted from `invokeClient`'s body, where it was
 * `channel === CLIENT_PROPOSE_MCPB ? 10 * 60 * 1000 : 30_000`, for two reasons:
 * the three SIBLING capabilities that also block on a person (a native file
 * picker, a folder picker, a confirmation dialog) were aborted after 30 s with
 * the user's eventual answer discarded, and the rule itself was unreachable
 * from a test without driving a socket for half a minute. It is exported for
 * the same reason {@link rpcHandlerTimeoutForChannel} is: this is the third of
 * three timeouts that must agree, and the other two are already readable.
 */
export function clientInvokeTimeoutForChannel(channel: string): number {
  return USER_PACED_CLIENT_CHANNELS.has(channel)
    ? USER_PACED_CLIENT_INVOKE_TIMEOUT_MS
    : DEFAULT_CLIENT_INVOKE_TIMEOUT_MS
}

// ---------------------------------------------------------------------------
// WsRpcServer
// ---------------------------------------------------------------------------

export class WsRpcServer implements RpcServer {
  private wss: WebSocketServer | null = null
  private httpServer: HttpServer | null = null
  private httpsServer: HttpsServer | null = null
  private clients = new Map<string, ClientConnection>()
  private handlers = new Map<string, HandlerFn>()
  private pendingInvokes = new Map<string, PendingInvoke>()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private _port = 0
  private _protocol: 'ws' | 'wss' = 'ws'

  /** Recently disconnected clients retained for reconnect replay. */
  private disconnectedClients = new Map<string, { client: ClientConnection; timer: ReturnType<typeof setTimeout> }>()

  private readonly host: string
  private readonly requestedPort: number
  private readonly requireAuth: boolean
  private readonly validateToken: ((token: string) => Promise<boolean>) | null
  private readonly validateSessionCookie: ((cookieHeader: string | null) => Promise<boolean>) | null
  private readonly serverId: string
  private readonly tlsOptions: WsRpcTlsOptions | null
  private readonly serverVersion: string
  /** Largest message this server accepts, advertised in handshake_ack (Bun ignores `maxPayload`). UB4.14, v0.15.1. */
  private readonly maxMessageBytes = runtimeMaxMessageBytes()
  private readonly maxClients: number
  private readonly onClientConnected: WsRpcServerOptions['onClientConnected']
  private readonly onClientDisconnected: WsRpcServerOptions['onClientDisconnected']
  private readonly httpHandler: WsRpcServerOptions['httpHandler']
  private readonly allowLoopbackHostsOnly: boolean
  private readonly extraAllowedUpgradeHosts: readonly string[]

  constructor(opts?: WsRpcServerOptions) {
    this.host = opts?.host ?? '127.0.0.1'
    this.requestedPort = opts?.port ?? 0
    this.requireAuth = opts?.requireAuth ?? false
    this.validateToken = opts?.validateToken ?? null
    this.validateSessionCookie = opts?.validateSessionCookie ?? null
    this.serverId = opts?.serverId ?? 'local'
    this.serverVersion = opts?.serverVersion ?? ''
    this.tlsOptions = opts?.tls ?? null
    this.maxClients = opts?.maxClients ?? 50
    this.onClientConnected = opts?.onClientConnected
    this.onClientDisconnected = opts?.onClientDisconnected
    this.httpHandler = opts?.httpHandler
    this.allowLoopbackHostsOnly = opts?.allowLoopbackHostsOnly ?? false
    this.extraAllowedUpgradeHosts = (opts?.extraAllowedUpgradeHosts ?? []).map(entry => entry.toLowerCase())
  }

  /**
   * DA3.14 — is this upgrade's `Host` an authority this server answers to?
   *
   * FAIL CLOSED on both unknowns: a request carrying no `Host` at all, and one
   * whose `Host` will not parse. HTTP/1.1 makes the header mandatory and every
   * client measured for this row sends it, so an absence is a hand-rolled
   * caller rather than one of ours.
   *
   * THE SET IS THE THREE VALUES OF `isLoopbackBindHost` PLUS THE BRACKETED IPv6
   * FORM, and that difference is required rather than generous. That predicate
   * deliberately excludes `[::1]` because it names a BIND, where the bare `::1`
   * is what a listener is given; a `Host` HEADER spells IPv6 bracketed by
   * definition (`[::1]:9100`), so a server bound to `::1` — which that
   * predicate calls loopback, turning this gate on — would otherwise refuse
   * every one of its own clients.
   *
   * WHEN A PORT IS PRESENT IT MUST BE OURS; WHEN THERE IS NONE, THE HOSTNAME
   * CARRIES THE DECISION ALONE — and the asymmetry is measured, not a
   * concession. Bun's WebSocket client OMITS the port from `Host` for an IPv6
   * url: measured 2026-09-17 over a real `node:http` + `ws` listener bound to
   * `::1`, Bun sends `Host: [::1]` for `ws://[::1]:<port>` where the `ws`
   * package sends `[::1]:<port>`, and for an IPv4 url Bun sends the port like
   * everyone else. `apps/cli` runs on Bun, so a port-keyed rule with no
   * portless branch would have refused this product's own CLI on any `::1`
   * bind — a regression introduced by the control itself.
   *
   * It costs nothing, because a portless `Host` cannot be an authority claim
   * about a DIFFERENT port, and the hostname must still be one of the three.
   * The attack this gate exists for always presents a non-loopback NAME: a
   * rebinding page must name OUR port in its url for the connection to reach us
   * at all, and the browser then puts that port in the header beside the
   * attacker's own hostname.
   */
  private isAllowedUpgradeHost(presented: string | undefined): boolean {
    if (!presented) return false
    if (this.extraAllowedUpgradeHosts.includes(presented.toLowerCase())) return true

    let hostname: string
    let port: string
    try {
      const parsed = new URL(`http://${presented}`)
      hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
      port = parsed.port
    } catch {
      return false
    }

    if (port && Number(port) !== this._port) return false
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
  }

  /**
   * The `ws` option that enforces {@link isAllowedUpgradeHost}, or nothing at
   * all when the gate is off — spread into all three `WebSocketServer`
   * constructions below so no branch can be the one that forgets it.
   *
   * `verifyClient`'s CALLBACK form is used rather than its one-argument form
   * because that one aborts with `401`, which would tell an operator reading a
   * proxy log that their credentials were wrong. This is not an auth failure:
   * the request never named this server.
   */
  private upgradeHostGuard(): { verifyClient?: VerifyClientCallbackAsync } {
    if (!this.allowLoopbackHostsOnly) return {}
    return {
      verifyClient: (info, done) => {
        const presented = info.req.headers.host
        if (this.isAllowedUpgradeHost(presented)) {
          done(true)
          return
        }
        // Names the escape hatch, because the one legitimate way to meet this
        // refusal is a reverse proxy that rewrites Host (see the option's
        // docblock), and an operator who cannot see the way out reads a
        // deliberate control as a broken build.
        transportLog.warn(
          'Upgrade refused: Host is not this server\'s own loopback authority. '
          + 'Set NESSY_RPC_ALLOWED_UPGRADE_HOSTS to the authority your proxy forwards.',
          { presented: presented ?? null, expectedPort: this._port },
        )
        done(false, 403, 'Forbidden: unexpected Host header')
      },
    }
  }

  /** The actual port the server is listening on (available after listen()). */
  get port(): number {
    return this._port
  }

  /** The protocol the server is using: 'wss' when TLS is configured, 'ws' otherwise. */
  get protocol(): 'ws' | 'wss' {
    return this._protocol
  }

  /** Number of currently connected (handshake-completed) clients. */
  getConnectedClientCount(): number {
    return this.clients.size
  }

  // -------------------------------------------------------------------------
  // RpcServer interface
  // -------------------------------------------------------------------------

  handle(channel: string, handler: HandlerFn): void {
    if (this.handlers.has(channel)) {
      throw new Error(`Handler already registered for channel: ${channel}`)
    }
    this.handlers.set(channel, handler)
  }

  push(channel: string, target: PushTarget, ...args: any[]): void {
    const timestamp = Date.now()

    for (const client of this.clients.values()) {
      if (!this.matchesTarget(client, target)) continue
      this.bufferAndMaybeSendEvent(client, channel, args, timestamp, true)
    }

    for (const { client } of this.disconnectedClients.values()) {
      if (!this.matchesTarget(client, target)) continue
      this.bufferAndMaybeSendEvent(client, channel, args, timestamp, false)
    }
  }

  hasClientCapability(clientId: string, capability: string): boolean {
    const client = this.clients.get(clientId)
    return !!client && client.capabilities.has(capability)
  }

  findClientsWithCapability(capability: string, opts?: { workspaceId?: string }): string[] {
    const results: string[] = []
    for (const [clientId, client] of this.clients) {
      if (!client.capabilities.has(capability)) continue
      if (opts?.workspaceId !== undefined && client.workspaceId !== opts.workspaceId) continue
      results.push(clientId)
    }
    return results
  }

  getClientLastSentSeq(clientId: string): number | undefined {
    return this.clients.get(clientId)?.lastSentSeq
  }

  invokeClient(clientId: string, channel: string, ...args: any[]): Promise<any> {
    return new Promise((resolve, reject) => {
      const client = this.clients.get(clientId)

      // Check connection
      if (!client) {
        const err = new Error(`Client not connected: ${clientId}`)
        ;(err as any).code = 'CLIENT_DISCONNECTED'
        reject(err)
        return
      }

      // Check capability
      if (!client.capabilities.has(channel)) {
        const err = new Error(`Client lacks capability: ${channel}`)
        ;(err as any).code = 'CAPABILITY_UNAVAILABLE'
        reject(err)
        return
      }

      const id = randomUUID()
      const timeoutMs = clientInvokeTimeoutForChannel(channel)
      const timeout = setTimeout(() => {
        this.pendingInvokes.delete(id)
        const err = new Error(`Client request timeout: ${channel} (${timeoutMs}ms)`)
        ;(err as any).code = 'CLIENT_REQUEST_TIMEOUT'
        reject(err)
      }, timeoutMs)

      this.pendingInvokes.set(id, { clientId, resolve, reject, timeout })

      const envelope: MessageEnvelope = {
        id,
        type: 'request',
        channel,
        args,
        serverId: this.serverId,
      }
      this.safeSend(client.ws, serializeEnvelope(envelope))
    })
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.tlsOptions) {
        // TLS mode: create HTTPS server, attach WebSocketServer to it.
        // When httpHandler is set, regular HTTP requests are served by it
        // (e.g. WebUI), while ws intercepts WebSocket upgrade requests.
        this._protocol = 'wss'
        this.httpsServer = createHttpsServer(
          {
            cert: this.tlsOptions.cert,
            key: this.tlsOptions.key,
            ca: this.tlsOptions.ca,
            passphrase: this.tlsOptions.passphrase,
          },
          this.httpHandler,
        )

        this.wss = new WebSocketServer({ server: this.httpsServer, maxPayload: NODE_WS_MAX_MESSAGE_BYTES, ...this.upgradeHostGuard() })

        this.httpsServer.on('error', (err) => reject(err))

        this.httpsServer.listen(this.requestedPort, this.host, () => {
          const addr = this.httpsServer!.address()
          if (typeof addr === 'object' && addr) {
            this._port = addr.port
          }
          this.startHeartbeat()
          resolve()
        })
      } else if (this.httpHandler) {
        // Plain WS + HTTP handler: create an HTTP server for both.
        this._protocol = 'ws'
        this.httpServer = createHttpServer(this.httpHandler)
        this.wss = new WebSocketServer({ server: this.httpServer, maxPayload: NODE_WS_MAX_MESSAGE_BYTES, ...this.upgradeHostGuard() })

        this.httpServer.on('error', (err) => reject(err))

        this.httpServer.listen(this.requestedPort, this.host, () => {
          const addr = this.httpServer!.address()
          if (typeof addr === 'object' && addr) {
            this._port = addr.port
          }
          this.startHeartbeat()
          resolve()
        })
      } else {
        // Plain WS mode, no HTTP handler
        this._protocol = 'ws'
        this.wss = new WebSocketServer({
          host: this.host,
          port: this.requestedPort,
          maxPayload: NODE_WS_MAX_MESSAGE_BYTES,
          ...this.upgradeHostGuard(),
        })

        this.wss.on('listening', () => {
          const addr = this.wss!.address()
          if (typeof addr === 'object' && addr) {
            this._port = addr.port
          }
          this.startHeartbeat()
          resolve()
        })

        this.wss.on('error', (err) => {
          reject(err)
        })
      }

      this.wss.on('connection', (ws, req) => {
        this.onConnection(ws, req.headers.cookie ?? null)
      })
    })
  }

  close(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    // Reject all pending invokes before tearing down connections
    for (const [id, pending] of this.pendingInvokes) {
      clearTimeout(pending.timeout)
      const err = new Error('Server shutting down')
      ;(err as any).code = 'CLIENT_DISCONNECTED'
      pending.reject(err)
      this.pendingInvokes.delete(id)
    }
    for (const client of this.clients.values()) {
      client.ws.terminate()
    }
    this.clients.clear()
    // Clean up disconnected client timers
    for (const entry of this.disconnectedClients.values()) {
      clearTimeout(entry.timer)
    }
    this.disconnectedClients.clear()
    this.wss?.close()
    this.wss = null
    this.httpServer?.close()
    this.httpServer = null
    this.httpsServer?.close()
    this.httpsServer = null
  }

  // -------------------------------------------------------------------------
  // Connection handling
  // -------------------------------------------------------------------------

  private onConnection(ws: WebSocket, upgradeRequestCookie: string | null): void {
    // Reject if at capacity
    if (this.maxClients > 0 && this.clients.size >= this.maxClients) {
      transportLog.warn('Connection rejected: at capacity', {
        maxClients: this.maxClients,
        current: this.clients.size,
      })
      ws.close(4008, 'Server at capacity')
      return
    }

    let handshakeCompleted = false
    let handshakeTimeout: ReturnType<typeof setTimeout> | null = null

    // Give the client 5 seconds to send a handshake
    handshakeTimeout = setTimeout(() => {
      if (!handshakeCompleted) {
        ws.close(4001, 'Handshake timeout')
      }
    }, 5_000)

    ws.on('message', async (raw) => {
      let envelope: MessageEnvelope
      try {
        envelope = deserializeEnvelope(raw.toString())
      } catch {
        ws.close(4002, 'Invalid JSON')
        return
      }

      if (!handshakeCompleted) {
        if (envelope.type !== 'handshake') {
          ws.close(4003, 'Expected handshake')
          return
        }

        if (handshakeTimeout) {
          clearTimeout(handshakeTimeout)
          handshakeTimeout = null
        }

        // Protocol version check (required)
        if (!envelope.protocolVersion || typeof envelope.protocolVersion !== 'string') {
          this.sendError(ws, envelope.id, 'PROTOCOL_VERSION_UNSUPPORTED',
            `Missing protocolVersion. Server protocol ${PROTOCOL_VERSION}`)
          ws.close(4004, 'Protocol version unsupported')
          return
        }

        const clientMajor = parseInt(envelope.protocolVersion.split('.')[0] ?? '0', 10)
        const serverMajor = parseInt(PROTOCOL_VERSION.split('.')[0] ?? '0', 10)
        if (clientMajor !== serverMajor) {
          this.sendError(ws, envelope.id, 'PROTOCOL_VERSION_UNSUPPORTED',
            `Server protocol ${PROTOCOL_VERSION}, client ${envelope.protocolVersion}`)
          ws.close(4004, 'Protocol version unsupported')
          return
        }

        // Auth check — bearer token OR session cookie (web UI)
        if (this.requireAuth) {
          let authenticated = false

          // 1. Try bearer token (standard path)
          if (envelope.token && this.validateToken) {
            authenticated = await this.validateToken(envelope.token)
          }

          // 2. Fallback: try session cookie from HTTP upgrade request (web UI path)
          if (!authenticated && this.validateSessionCookie && upgradeRequestCookie) {
            authenticated = await this.validateSessionCookie(upgradeRequestCookie)
          }

          if (!authenticated) {
            const reason = envelope.token ? 'Invalid token' : 'Token required'
            this.sendError(ws, envelope.id, 'AUTH_FAILED', reason)
            ws.close(4005, 'Auth failed')
            return
          }
        }

        // ── Reconnect attempt ──
        if (envelope.reconnectClientId && envelope.lastSeq != null) {
          const entry = this.disconnectedClients.get(envelope.reconnectClientId)
          if (entry) {
            const prevClient = entry.client

            // Identity must match (workspace + webContentsId)
            const identityMatch =
              prevClient.workspaceId === (envelope.workspaceId ?? null) &&
              prevClient.webContentsId === (envelope.webContentsId ?? null)

            if (identityMatch) {
              // Valid reconnect — prepare client state but do NOT add to
              // this.clients yet. The client stays in disconnectedClients
              // during replay so that push() can't interleave new events
              // between replayed ones. (Currently safe due to Node.js
              // single-threading, but this ordering makes the invariant
              // explicit and future-proof.)
              clearTimeout(entry.timer)

              prevClient.ws = ws
              prevClient.alive = true
              prevClient.missedPongs = 0
              handshakeCompleted = true

              // Determine replay vs stale using the per-client delivery sequence.
              // Retained buffers continue collecting events while the client is disconnected,
              // but TTL eviction still applies during the reconnect window.
              this.evictBuffer(prevClient)

              const lastSeq = envelope.lastSeq as number
              const hasMissedEvents = lastSeq < prevClient.lastSentSeq
              const firstBufferedSeq = prevClient.eventBuffer[0]?.seq
              const canReplay = !hasMissedEvents
                ? true
                : firstBufferedSeq != null && lastSeq >= firstBufferedSeq - 1

              if (canReplay) {
                const replayEvents = prevClient.eventBuffer.filter(e => e.seq > lastSeq)

                const ack: MessageEnvelope = {
                  id: envelope.id,
                  type: 'handshake_ack',
                  protocolVersion: PROTOCOL_VERSION,
                  serverVersion: this.serverVersion || undefined,
                  maxMessageBytes: this.maxMessageBytes,
                  clientId: prevClient.id,
                  registeredChannels: [...this.handlers.keys()],
                  reconnected: true,
                }
                this.safeSend(ws, serializeEnvelope(ack))

                // Replay missed events in order
                for (const event of replayEvents) {
                  this.safeSend(ws, event.data)
                }

                transportLog.info('Client reconnected with replay', {
                  clientId: prevClient.id,
                  replayedCount: replayEvents.length,
                  lastSeq,
                })
              } else {
                // Buffer evicted — client must full-refresh
                const ack: MessageEnvelope = {
                  id: envelope.id,
                  type: 'handshake_ack',
                  protocolVersion: PROTOCOL_VERSION,
                  serverVersion: this.serverVersion || undefined,
                  maxMessageBytes: this.maxMessageBytes,
                  clientId: prevClient.id,
                  registeredChannels: [...this.handlers.keys()],
                  reconnected: true,
                  stale: true,
                }
                this.safeSend(ws, serializeEnvelope(ack))

                transportLog.info('Client reconnected as stale', {
                  clientId: prevClient.id,
                  lastSeq,
                  firstBufferedSeq,
                  lastSentSeq: prevClient.lastSentSeq,
                })
              }

              // Atomic state transition: move from disconnected → active
              // AFTER replay is complete so push() can't target this client mid-replay.
              this.disconnectedClients.delete(envelope.reconnectClientId)
              this.clients.set(prevClient.id, prevClient)

              this.setupClientHandlers(ws, prevClient)
              this.onClientConnected?.({
                clientId: prevClient.id,
                webContentsId: prevClient.webContentsId,
                workspaceId: prevClient.workspaceId,
                capabilities: [...prevClient.capabilities],
              })
              return
            }

            // Identity mismatch — fall through to fresh connect
            transportLog.warn('Reconnect identity mismatch', {
              reconnectClientId: envelope.reconnectClientId,
            })
          }
          // reconnectClientId not found — fall through to fresh connect
        }

        // ── Normal fresh connect ──
        const clientId = randomUUID()
        const client: ClientConnection = {
          id: clientId,
          ws,
          workspaceId: envelope.workspaceId ?? null,
          webContentsId: envelope.webContentsId ?? null,
          capabilities: new Set(envelope.clientCapabilities ?? []),
          missedPongs: 0,
          alive: true,
          eventBuffer: [],
          lastAckedSeq: 0,
          lastSentSeq: 0,
        }
        this.clients.set(clientId, client)
        handshakeCompleted = true

        // Send handshake_ack
        const ack: MessageEnvelope = {
          id: envelope.id,
          type: 'handshake_ack',
          protocolVersion: PROTOCOL_VERSION,
          serverVersion: this.serverVersion || undefined,
          maxMessageBytes: this.maxMessageBytes,
          clientId,
          registeredChannels: [...this.handlers.keys()],
        }
        this.safeSend(ws, serializeEnvelope(ack))

        // Notify lifecycle listener
        transportLog.info('Client connected', {
          clientId,
          webContentsId: client.webContentsId,
          workspaceId: client.workspaceId,
        })
        this.onClientConnected?.({
          clientId,
          webContentsId: client.webContentsId,
          workspaceId: client.workspaceId,
          capabilities: [...client.capabilities],
        })

        this.setupClientHandlers(ws, client)
        return
      }

      // Post-handshake: find the client for this ws
      const client = this.findClientByWs(ws)
      if (!client) {
        ws.close(4006, 'Unknown client')
        return
      }

      if (envelope.type === 'request') {
        await this.onRequest(client, envelope)
      } else if (envelope.type === 'response') {
        this.onClientResponse(envelope)
      } else if (envelope.type === 'sequence_ack') {
        const ackSeq = envelope.lastSeq
        if (typeof ackSeq === 'number' && ackSeq > client.lastAckedSeq) {
          client.lastAckedSeq = ackSeq
          // Evict acknowledged events
          const buf = client.eventBuffer
          let removeCount = 0
          while (removeCount < buf.length && buf[removeCount]!.seq <= ackSeq) {
            removeCount++
          }
          if (removeCount > 0) {
            buf.splice(0, removeCount)
          }
        }
      }
    })

    ws.on('error', () => {
      // Connection errors are handled by the close event
    })
  }

  // -------------------------------------------------------------------------
  // Request dispatching
  // -------------------------------------------------------------------------

  private async onRequest(client: ClientConnection, envelope: MessageEnvelope): Promise<void> {
    const { channel, id, args } = envelope

    if (!channel) {
      this.sendResponseError(client.ws, id, undefined, 'CHANNEL_NOT_FOUND', 'Missing channel')
      return
    }

    const handler = this.handlers.get(channel)
    if (!handler) {
      this.sendResponseError(client.ws, id, channel, 'CHANNEL_NOT_FOUND', `No handler for: ${channel}`)
      return
    }

    const ctx: RequestContext = {
      clientId: client.id,
      workspaceId: client.workspaceId,
      webContentsId: client.webContentsId,
    }

    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const timeoutMs = rpcHandlerTimeoutForChannel(channel)
      const result = await Promise.race([
        handler(ctx, ...(args ?? [])),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`Handler timeout: ${channel} (${timeoutMs}ms)`)), timeoutMs)
        }),
      ])
      const response: MessageEnvelope = {
        id,
        type: 'response',
        channel,
        result,
      }
      this.safeSend(client.ws, serializeEnvelope(response))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const rawCode = (err as { code?: unknown } | null)?.code
      const code: ErrorCode = isErrorCode(rawCode) ? rawCode : 'HANDLER_ERROR'
      // D1.150 — a thrown `CodedError`'s payload, forwarded rather than dropped.
      // Read off the caught value like the code beside it, because class
      // identity is already gone by the time a handler's rejection arrives here.
      this.sendResponseError(client.ws, id, channel, code, message, (err as { data?: unknown } | null)?.data)
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  // -------------------------------------------------------------------------
  // Heartbeat
  // -------------------------------------------------------------------------

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const [, client] of this.clients) {
        // Skip sockets that are already closing/closed (e.g. terminated on a previous tick)
        if (client.ws.readyState !== client.ws.OPEN) continue

        if (!client.alive) {
          client.missedPongs++
          if (client.missedPongs >= HEARTBEAT_MAX_MISSED) {
            // Let the close handler (setupClientHandlers) handle all cleanup:
            // clients.delete, buffer retention for reconnect, onClientDisconnected.
            client.ws.terminate()
            continue
          }
        }
        client.alive = false
        client.ws.ping()
      }
    }, HEARTBEAT_INTERVAL_MS)
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Wire up close + pong handlers for a WebSocket ↔ ClientConnection pair. */
  private setupClientHandlers(ws: WebSocket, client: ClientConnection): void {
    ws.on('close', () => {
      transportLog.info('Client disconnected', { clientId: client.id })
      this.clients.delete(client.id)

      // Retain buffer for potential reconnect
      const timer = setTimeout(() => {
        this.disconnectedClients.delete(client.id)
      }, DISCONNECTED_CLIENT_TTL_MS)
      this.disconnectedClients.set(client.id, { client, timer })

      // Cap disconnectedClients to prevent unbounded growth
      if (this.disconnectedClients.size > 50) {
        const oldestKey = this.disconnectedClients.keys().next().value
        if (oldestKey) {
          const oldest = this.disconnectedClients.get(oldestKey)
          if (oldest) clearTimeout(oldest.timer)
          this.disconnectedClients.delete(oldestKey)
        }
      }

      this.rejectPendingInvokesForClient(client.id)
      this.onClientDisconnected?.(client.id)
    })

    ws.on('pong', () => {
      client.alive = true
      client.missedPongs = 0
    })
  }

  /** Assign a per-client seq, retain the event for replay, and optionally send it immediately. */
  private bufferAndMaybeSendEvent(
    client: ClientConnection,
    channel: string,
    args: any[],
    timestamp: number,
    shouldSend: boolean,
  ): void {
    client.lastSentSeq += 1
    const seq = client.lastSentSeq

    const envelope: MessageEnvelope = {
      id: randomUUID(),
      type: 'event',
      channel,
      args,
      serverId: this.serverId,
      seq,
    }

    const data = serializeEnvelope(envelope)
    client.eventBuffer.push({ seq, data, timestamp })
    this.evictBuffer(client)

    if (shouldSend) {
      this.safeSend(client.ws, data)
    }
  }

  /** Evict stale/oversized entries from a client's event buffer via batch splice. */
  private evictBuffer(client: ClientConnection): void {
    const buf = client.eventBuffer
    if (buf.length === 0) return

    const now = Date.now()
    let removeCount = 0

    // Evict by TTL
    while (removeCount < buf.length &&
           now - buf[removeCount]!.timestamp > EVENT_BUFFER_TTL_MS) {
      removeCount++
    }

    // Evict by size (keep at most EVENT_BUFFER_MAX_SIZE after TTL eviction)
    const remaining = buf.length - removeCount
    if (remaining > EVENT_BUFFER_MAX_SIZE) {
      removeCount += remaining - EVENT_BUFFER_MAX_SIZE
    }

    // Single splice instead of O(n) shift loop
    if (removeCount > 0) {
      buf.splice(0, removeCount)
    }
  }

  private matchesTarget(client: ClientConnection, target: PushTarget): boolean {
    switch (target.to) {
      case 'all':
        return target.exclude ? client.id !== target.exclude : true
      case 'workspace':
        if (target.exclude && client.id === target.exclude) return false
        return client.workspaceId === target.workspaceId
      case 'client':
        return client.id === target.clientId
      default:
        return false
    }
  }

  /** Update a client's workspaceId (called after SWITCH_WORKSPACE so push routing stays correct). */
  updateClientWorkspace(clientId: string, workspaceId: string): void {
    const client = this.clients.get(clientId)
    if (client) {
      client.workspaceId = workspaceId
    }
  }

  private findClientByWs(ws: WebSocket): ClientConnection | undefined {
    for (const client of this.clients.values()) {
      if (client.ws === ws) return client
    }
    return undefined
  }

  /**
   * Handler/request errors — sent as type:'response' with error field.
   *
   * D1.150 — `data` is the OPTIONAL fifth argument and it completes a chain that
   * was inert without it: `WireError.data` has always been part of the envelope
   * and {@link WsRpcClient}'s response branch already copies it onto the rebuilt
   * error, but nothing on this side ever filled it, so a `CodedError` carrying a
   * payload lost it here. The one live payload is `CONNECTION_IN_USE`'s holder
   * names — user-authored text a renderer must print verbatim beside a sentence
   * it builds in the reader's own language.
   *
   * Optional, so the three call sites that have nothing to add are unchanged and
   * an error with no payload sends a byte-identical envelope.
   */
  private sendResponseError(
    ws: WebSocket, id: string, channel: string | undefined,
    code: ErrorCode, message: string, data?: unknown,
  ): void {
    const envelope: MessageEnvelope = {
      id,
      type: 'response',
      channel,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    }
    this.safeSend(ws, serializeEnvelope(envelope))
  }

  /** Protocol-level errors only (handshake rejection, version mismatch). May close connection. */
  private sendError(ws: WebSocket, id: string, code: ErrorCode, message: string): void {
    const envelope: MessageEnvelope = {
      id,
      type: 'error',
      error: { code, message },
    }
    this.safeSend(ws, serializeEnvelope(envelope))
  }

  private onClientResponse(envelope: MessageEnvelope): void {
    const pending = this.pendingInvokes.get(envelope.id)
    if (!pending) return

    this.pendingInvokes.delete(envelope.id)
    clearTimeout(pending.timeout)

    if (envelope.error) {
      const err = new Error(envelope.error.message)
      ;(err as any).code = envelope.error.code
      ;(err as any).data = envelope.error.data
      pending.reject(err)
    } else {
      pending.resolve(envelope.result)
    }
  }

  private rejectPendingInvokesForClient(clientId: string): void {
    for (const [id, pending] of this.pendingInvokes) {
      if (pending.clientId !== clientId) continue
      clearTimeout(pending.timeout)
      const err = new Error(`Client disconnected: ${clientId}`)
      ;(err as any).code = 'CLIENT_DISCONNECTED'
      pending.reject(err)
      this.pendingInvokes.delete(id)
    }
  }

  private safeSend(ws: WebSocket, data: string): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(data)
    }
  }
}
