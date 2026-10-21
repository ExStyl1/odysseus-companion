/**
 * F1.498 — the child half of `network-runtime-host-hop.test.ts`: the HEADLESS
 * server's codex / claude host hop, in the server's own order.
 *
 * The test runs this as `bun run --preload <unified-network-interceptor.ts> <this>`
 * from a directory with no `bunfig.toml`, which is what `bin/nessy-server` does
 * (`bun run --preload <interceptor bundle> packages/server/src/index.ts`). Then:
 *
 * 1. `applyProcessNetworkTrustChain()` — what the server's `index.ts` runs before
 *    anything makes a request;
 * 2. optionally a managed `env` block, through the product's `applyManagedEnv`,
 *    AFTER that — `bootstrapServer` applies it later in the same order;
 * 3. `gatewaySessionFetch(<session id>)` — the loopback adapter's `fetchImpl` —
 *    on the target the test names.
 *
 * Relative imports on purpose: a copy of this file placed in a scratch export of
 * an older `packages/shared` measures THAT tree, which is how the failing arm
 * was taken against HEAD without touching the working tree.
 *
 * Everything runs behind `import.meta.main` (AGENTS.md: a fixture whose module
 * body exits kills a runner that imports it).
 */
import { applyProcessNetworkTrustChain } from '../../network-runtime.ts'
import { applyManagedEnv } from '../../managed-env.ts'
import { gatewaySessionFetch } from '../../../telemetry/gateway-headers.ts'

async function main(): Promise<void> {
  const silent = { info: () => {}, warn: () => {}, error: (message: string) => { process.stderr.write(`${message}\n`) } }
  applyProcessNetworkTrustChain({ log: silent })

  const managed = process.env.F1498_MANAGED_ENV
  if (managed) {
    applyManagedEnv(JSON.parse(managed) as Record<string, string>, { source: 'managed-file', confirmed: true })
  }

  const target = process.env.F1498_TARGET
  if (!target) throw new Error('F1498_TARGET is required')
  let outcome: { status?: number; error?: string }
  try {
    const response = await gatewaySessionFetch('f1498-session')(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    outcome = { status: response.status }
    await response.arrayBuffer().catch(() => undefined)
  } catch (error) {
    outcome = { error: String((error as { code?: string }).code ?? (error as Error).message) }
  }
  process.stdout.write(`${JSON.stringify(outcome)}\n`)
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
