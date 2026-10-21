/**
 * F1.517 — the child half of
 * `unified-network-interceptor.headless-operator-headers.test.ts`: one process
 * shaped like the HEADLESS server, or like the Pi subprocess, making the
 * upstream model requests a codex / claude-runtime turn makes.
 *
 * The test runs this as `bun run --preload <unified-network-interceptor.ts> <this>`
 * from a directory with no `bunfig.toml`, which is what `bin/nessy-server` does
 * (`bun run --preload <interceptor bundle> packages/server/src/index.ts`). Then,
 * in the server's own order:
 *
 * 1. `applyProcessNetworkTrustChain()` — what the server's `index.ts` runs before
 *    anything makes a request;
 * 2. one POST per URL in `F1517_HOPS`, through `gatewaySessionFetch(<session id>)`
 *    — the loopback adapter's `fetchImpl`, whose `inner` is this process's
 *    global (intercepted) fetch — or, with `F1517_VIA=global`, through the global
 *    fetch directly, which is how Pi's SDK reaches its provider.
 *
 * Every request carries an EXPLICIT per-request `proxy` (`F1517_PROXY`, the
 * test's TLS tunnel), which both the trust-chain wrapper and the interceptor
 * honour ahead of anything else: one of the hops names the real gateway host,
 * and an explicit route is what guarantees it never leaves the rig. The
 * question this fixture answers is WHICH HEADERS a hop carries, and the route
 * is orthogonal to that.
 *
 * Relative imports on purpose, so a copy placed in a scratch export of an older
 * `packages/shared` measures THAT tree — how the failing arm is taken without
 * touching the working tree. Everything runs behind `import.meta.main`
 * (AGENTS.md: a fixture whose module body exits kills a runner that imports it).
 */
import { applyProcessNetworkTrustChain } from '../../config/network-runtime.ts'
import { gatewaySessionFetch } from '../../telemetry/gateway-headers.ts'

/** A body each adapter accepts, so the Pi-shaped rewrite path runs to the wire. */
function bodyFor(url: string): string {
  if (url.includes('/messages')) {
    return JSON.stringify({ model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] })
  }
  return JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
}

async function main(): Promise<void> {
  const silent = { info: () => {}, warn: () => {}, error: (message: string) => { process.stderr.write(`${message}\n`) } }
  applyProcessNetworkTrustChain({ log: silent })

  const hops = JSON.parse(process.env.F1517_HOPS ?? '[]') as string[]
  const proxy = process.env.F1517_PROXY
  if (!proxy || !proxy.startsWith('http://127.0.0.1:')) {
    throw new Error('F1517_PROXY must name the rig\'s loopback tunnel; refusing to send a request that could leave the machine')
  }
  const send: typeof fetch = process.env.F1517_VIA === 'global' ? fetch : gatewaySessionFetch('f1517-session')

  const outcomes: Array<{ url: string; status?: number; error?: string }> = []
  for (const url of hops) {
    try {
      const response = await send(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: bodyFor(url),
        proxy,
      } as RequestInit)
      await response.arrayBuffer().catch(() => undefined)
      outcomes.push({ url, status: response.status })
    } catch (error) {
      outcomes.push({ url, error: String((error as { code?: string }).code ?? (error as Error).message) })
    }
  }
  process.stdout.write(`${JSON.stringify(outcomes)}\n`)
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
