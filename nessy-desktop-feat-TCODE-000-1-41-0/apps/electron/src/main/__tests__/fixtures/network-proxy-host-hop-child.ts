/**
 * F1.498 — the child half of `network-proxy-host-hop.test.ts`: the desktop main
 * process's codex / claude HOST HOP, reduced to the two product calls it is made
 * of, run in a NODE process (Electron-as-Node when the binary is present).
 *
 * 0. Optionally, a login-shell export written into `process.env` first, the way
 *    `loadShellEnv` does it at the top of `main/index.ts`.
 * 1. `applyConfiguredProxySettings()` — what `main/index.ts` runs at `whenReady`:
 *    it installs the global undici dispatcher the main process's `fetch` uses.
 * 2. Optionally, a managed `env` block written AFTER that, through the product's
 *    own `applyManagedEnv` — the order both hosts reach it in, since
 *    `bootstrapServer` applies the managed env after the network setup ran.
 * 3. `gatewaySessionFetch(<session id>)` — the `fetchImpl` `codex-agent.ts` and
 *    `claude-agent.ts` hand the loopback adapter, i.e. the function that makes
 *    the upstream request — called on the target the test names.
 *
 * It prints ONE JSON line: the status, or the error code the request died with.
 * The verdict is read from the test's recording proxy, not from this line.
 *
 * Bundled by the test, never run from source: the main process is a Node bundle
 * built with `--platform=node --format=cjs`, and so is this.
 */
import { applyConfiguredProxySettings } from '../../network-proxy'
import { gatewaySessionFetch } from '@nessy-agent/shared/telemetry/gateway-headers'
import { applyManagedEnv } from '@nessy-agent/shared/config/managed-env'

async function main(): Promise<void> {
  // The macOS login-shell channel: `loadShellEnv`'s write loop, which runs before
  // anything else in the main process — after Node's own startup read of
  // `NODE_EXTRA_CA_CERTS`, before `applyConfiguredProxySettings`.
  const shell = process.env.F1498_SHELL_ENV
  if (shell) {
    for (const [key, value] of Object.entries(JSON.parse(shell) as Record<string, string>)) process.env[key] = value
  }

  await applyConfiguredProxySettings()

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
    const cause = (error as { cause?: { code?: string } }).cause
    outcome = { error: String(cause?.code ?? (error as Error).message) }
  }
  process.stdout.write(`${JSON.stringify(outcome)}\n`)
}

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exit(1)
  },
)
