/**
 * F1.518 — the child half of `server-launcher-loopback-no-proxy.test.ts`: the
 * HEADLESS server's own requests, in the server's own order, from a process
 * launched with `HTTP(S)_PROXY` in its environment.
 *
 * The test runs this under `bun run --preload <unified-network-interceptor.ts>`
 * from a directory with no `bunfig.toml` — either through a launcher carrying
 * `bin/nessy-server`'s loopback `NO_PROXY` lines, or without one. Then:
 *
 * 1. `applyProcessNetworkTrustChain()` — what the server's `index.ts` runs before
 *    anything makes a request;
 * 2. one POST per URL in `F1518_TARGETS` through `gatewaySessionFetch(<session>)`,
 *    the loopback adapter's `fetchImpl` — the request a codex or claude-runtime
 *    turn's upstream hop makes, here to a loopback BYO endpoint (a local model),
 *    an external host, and a host the operator's own `NO_PROXY` names;
 * 3. the interceptor's own proxy decision for every loopback spelling the host
 *    exempts (`LOOPBACK_NO_PROXY_HOSTS`) and for an external host, so the inline
 *    twin is pinned against the one list rather than a copy of it.
 *
 * Relative imports on purpose, so a copy placed in a scratch export of an older
 * `packages/shared` measures THAT tree. Everything runs behind
 * `import.meta.main` (AGENTS.md: a fixture whose module body exits kills a
 * runner that imports it).
 */
import { applyProcessNetworkTrustChain } from '../../config/network-runtime.ts'
import { LOOPBACK_NO_PROXY_HOSTS } from '../../config/network-proxy-utils.ts'
import { gatewaySessionFetch } from '../../telemetry/gateway-headers.ts'
import { getProxyForUrl } from '../../unified-network-interceptor.ts'

/** `::1` needs brackets in a URL; `[::1]` already has them. */
function loopbackUrl(host: string): string {
  const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `http://${bracketed}:1/f1518`
}

async function main(): Promise<void> {
  const silent = { info: () => {}, warn: () => {}, error: (message: string) => { process.stderr.write(`${message}\n`) } }
  applyProcessNetworkTrustChain({ log: silent })

  const targets = JSON.parse(process.env.F1518_TARGETS ?? '[]') as string[]
  const outcomes: Array<{ url: string; status?: number; body?: string; error?: string }> = []
  for (const url of targets) {
    try {
      const response = await gatewaySessionFetch('f1518-session')(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      outcomes.push({ url, status: response.status, body: await response.text() })
    } catch (error) {
      outcomes.push({ url, error: String((error as { code?: string }).code ?? (error as Error).message) })
    }
  }

  process.stdout.write(`${JSON.stringify({
    outcomes,
    // The launch environment as this process received it, after any launcher.
    noProxy: { NO_PROXY: process.env.NO_PROXY ?? null, no_proxy: process.env.no_proxy ?? null },
    interceptorLoopback: Object.fromEntries(
      LOOPBACK_NO_PROXY_HOSTS.map(host => [host, getProxyForUrl(loopbackUrl(host)) ?? null]),
    ),
    interceptorExternal: getProxyForUrl('http://f1518-external.invalid/f1518') ?? null,
  })}\n`)
}

if (import.meta.main) {
  main().then(
    () => process.exit(0),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
      process.exit(1)
    },
  )
}
