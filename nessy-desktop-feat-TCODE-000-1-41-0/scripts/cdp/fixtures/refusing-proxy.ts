/**
 * A forward proxy on `127.0.0.1` that REFUSES everything and writes down what it
 * refused — the instrument RS-33's recipe names and does not ship.
 *
 * ## Why it is a repo file rather than a lane's throwaway
 *
 * RS-33 step 1 reads *"Start the lane's OWN forward proxy on 127.0.0.1 in
 * refusing mode, logging one JSONL line per request with the host and the
 * verdict"*, and nothing in the harness does that. So the rig day's lane R2
 * wrote one, lane R7 wrote another, and the next lane to drive the row writes a
 * third — each outside the repo, each unreviewed, each slightly different. Three
 * readings that matter were taken through those three servers (RS-33's
 * fail-closed verdicts, and the `sessions:command` ceiling this file was added
 * for), and no reader can check what they were taken through.
 *
 * ## It forwards NOTHING, and that is deliberate rather than unfinished
 *
 * A forwarding mode would make this an egress path shipped in the tree, and it
 * would buy nothing: a host that must reach the network is exempted through the
 * PRODUCT'S OWN `noProxy` setting, which is the operator surface the rig is
 * measuring anyway. The consequence is worth stating because it shapes how the
 * log reads: an exempted host never reaches this server, so it never appears
 * here. **This is a log of refusals, not a log of traffic** — an absent host
 * either was exempted or was never asked for, and only the app's own behaviour
 * separates those two.
 *
 * ## Both shapes a client speaks to a proxy
 *
 * - `CONNECT host:port HTTP/1.1` — what every https client sends, and the shape
 *   the app's own traffic takes. Answered `403`, never tunnelled.
 * - an absolute-URI request line (`GET http://host/path HTTP/1.1`) — plain http
 *   through a proxy. Answered `403` with a body, so a client that prints the
 *   body has something to print.
 *
 * Anything else (a bare origin-form request line, which is what a client that
 * thinks it is talking to an ordinary server sends) is logged as `malformed`
 * and refused too, because silently dropping it would read downstream as a
 * hang rather than a refusal.
 *
 * ## It never reads a credential
 *
 * The request line carries the HOST; the headers carry `Proxy-Authorization`
 * and, on an absolute-URI request, `Authorization`. This server parses the
 * request LINE and nothing else — it never reads, stores, logs or answers a
 * header — so no credential can reach the log this rig then pastes into a run
 * narrative. Same argument as `scripts/cdp/fixtures/stub-upstream.ts`, which
 * keeps only the LENGTH of an `Authorization` header, applied one step harder:
 * here not even the length is worth the risk, because nothing needs it.
 *
 * **And the request LINE is reduced too — the paragraph above argues about
 * HEADERS and concludes about the LOG, which is one step too far.** A
 * `malformed` classification is the one shape whose target is not a host:
 * origin-form is exactly what §"Both shapes" says is logged, it carries a PATH
 * and a QUERY, and its length is bounded only by whatever arrived in the first
 * chunk. No query-string credential exists in this product, so this is a
 * posture rather than a repair of a measured leak — but a log a run narrative
 * quotes should not be able to grow one later, and an unbounded echo is its own
 * problem. Every `malformed` host therefore goes through {@link reduceTarget};
 * `connect` and `request` hosts are parsed already and are untouched.
 */

import { appendFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'

/** One refusal, as the JSONL log writes it. */
export interface RefusingProxyLine {
  /** ISO timestamp — the window a case slices by. */
  t: string
  /** `connect` for the https shape, `request` for absolute-URI, `malformed` otherwise. */
  kind: 'connect' | 'request' | 'malformed'
  /**
   * The host asked for, or — when the target could not be parsed into one —
   * that target REDUCED by {@link reduceTarget}: query dropped, length bounded.
   */
  host: string
  /** Always `deny-all` today; a named verdict so a future allow-list reads the same log. */
  verdict: string
}

export interface RefusingProxy {
  /** What goes into `httpProxy` / `httpsProxy`. */
  url: string
  port: number
  /** The JSONL log path — the detector a case reads. */
  logPath: string
  /** Everything refused so far, parsed. */
  lines: () => RefusingProxyLine[]
  stop: () => Promise<void>
}

/** How much of an unparseable request target is worth writing down. */
const MALFORMED_TARGET_MAX = 256

/**
 * Reduce a request target that could NOT be parsed into a host, before it can
 * reach the JSONL log — see §"It never reads a credential".
 *
 * Two reductions, each with its own visible marker so the log stays honest
 * about what it dropped: a query string is removed and the remainder ends `?…`,
 * and anything still longer than {@link MALFORMED_TARGET_MAX} is cut and ends
 * `…`. What survives is the path, which is what a reader needs to tell a
 * misdirected client from a scanner.
 */
function reduceTarget(target: string): string {
  const queryAt = target.indexOf('?')
  const withoutQuery = queryAt >= 0 ? `${target.slice(0, queryAt)}?…` : target
  return withoutQuery.length > MALFORMED_TARGET_MAX
    ? `${withoutQuery.slice(0, MALFORMED_TARGET_MAX)}…`
    : withoutQuery
}

/**
 * The host out of a request line, for both shapes.
 *
 * `CONNECT` targets are `host:port`, and a bracketed IPv6 literal keeps its
 * brackets so it is still a host and not four numbers. An absolute URI is
 * parsed by `URL`, which is the only parser that agrees with what the client
 * meant; anything it refuses is classified `malformed` and never guessed at —
 * and the target is handed back REDUCED rather than verbatim, because a
 * `malformed` target is the one that is not a host and is the one that reaches
 * the log (see {@link reduceTarget}).
 */
export function hostOfRequestLine(method: string, target: string): { kind: RefusingProxyLine['kind']; host: string } {
  if (method === 'CONNECT') {
    const bracketed = /^(\[[^\]]+\])(?::\d+)?$/.exec(target)
    if (bracketed) return { kind: 'connect', host: bracketed[1]! }
    const host = target.split(':')[0]
    return host ? { kind: 'connect', host } : { kind: 'malformed', host: reduceTarget(target) }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
    try {
      return { kind: 'request', host: new URL(target).hostname }
    } catch {
      return { kind: 'malformed', host: reduceTarget(target) }
    }
  }
  return { kind: 'malformed', host: reduceTarget(target) }
}

const REFUSAL_BODY = 'refusing-proxy: this rig proxy forwards nothing\n'

function refusalFor(kind: RefusingProxyLine['kind']): string {
  if (kind === 'connect') return 'HTTP/1.1 403 Forbidden\r\nProxy-Connection: close\r\nConnection: close\r\n\r\n'
  return 'HTTP/1.1 403 Forbidden\r\n'
    + 'Content-Type: text/plain\r\n'
    + `Content-Length: ${Buffer.byteLength(REFUSAL_BODY)}\r\n`
    + 'Proxy-Connection: close\r\nConnection: close\r\n\r\n'
    + REFUSAL_BODY
}

/**
 * Start it. `port: 0` asks the OS for a free one; a sitting names the port it
 * wrote into the app's `networkProxy`, and the URL this returns is the server's
 * own answer rather than the number that was asked for.
 */
export function startRefusingProxy(options: { port?: number; logPath: string }): RefusingProxy {
  const seen: RefusingProxyLine[] = []
  const sockets = new Set<Socket>()

  const record = (line: RefusingProxyLine): void => {
    seen.push(line)
    try {
      appendFileSync(options.logPath, `${JSON.stringify(line)}\n`)
    } catch {
      // A log that cannot be written must not take the proxy down with it: the
      // in-memory list is still a reading, and a case that finds an empty file
      // blocks on its own positive control rather than scoring a silence.
    }
  }

  const server: Server = createServer(socket => {
    sockets.add(socket)
    socket.on('error', () => undefined)
    socket.on('close', () => sockets.delete(socket))
    socket.once('data', chunk => {
      // The FIRST line only. Everything after it is headers, and this server
      // reads no header — see the docblock.
      const firstLine = chunk.toString('latin1').split('\r\n', 1)[0] ?? ''
      const [method = '', target = ''] = firstLine.split(' ')
      const { kind, host } = hostOfRequestLine(method.toUpperCase(), target)
      record({ t: new Date().toISOString(), kind, host, verdict: 'deny-all' })
      socket.end(refusalFor(kind))
    })
  })
  // A listen that fails (the port is taken by a previous run's proxy — the
  // common case on a rig) otherwise surfaces as an unhandled `Failed to listen`
  // stack, which reads like a defect in this file rather than an occupied port.
  server.on('error', error => {
    console.error(`refusing-proxy: ${(error as Error).message} — is a previous run still listening on that port?`)
    process.exitCode = 2
  })
  server.listen(options.port ?? 0, '127.0.0.1')

  const addressPort = (): number => {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('refusing-proxy: the server reported no port')
    return address.port
  }

  return {
    get url() { return `http://127.0.0.1:${addressPort()}` },
    get port() { return addressPort() },
    logPath: options.logPath,
    lines: () => [...seen],
    stop: () => new Promise<void>(resolve => {
      for (const socket of sockets) socket.destroy()
      server.close(() => resolve())
    }),
  }
}

if (import.meta.main) {
  const portArgument = process.argv.indexOf('--port')
  const asked = portArgument >= 0 ? process.argv[portArgument + 1] : process.env.PORT
  const logArgument = process.argv.indexOf('--log')
  const logPath = logArgument >= 0 ? process.argv[logArgument + 1] : process.env.NESSY_CDP_PROXY_LOG
  if (!logPath) {
    console.error('refusing-proxy: pass --log <path> (or NESSY_CDP_PROXY_LOG) — the log IS the detector')
    process.exit(2)
  }
  const proxy = startRefusingProxy({ port: Number(asked ?? 0) || 0, logPath })
  // The listen is asynchronous; report only once the port is real.
  setTimeout(() => {
    console.error(`refusing-proxy listening on ${proxy.url}, refusing everything, log ${proxy.logPath}`)
    console.error('exempt a host through the APP’s own noProxy — this server forwards nothing and so logs nothing it never saw')
  }, 50)
}
