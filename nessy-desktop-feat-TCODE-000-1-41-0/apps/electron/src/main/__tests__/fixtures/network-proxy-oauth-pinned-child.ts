/**
 * UA12.185 — the child half of `network-proxy-oauth-pinned-ca.test.ts`: the desktop main process's MCP OAuth
 * pinned request, reduced to the two product calls it is made of, run in a NODE process (Electron-as-Node when the
 * binary is present) — the runtime the packaged main process is.
 *
 * 1. `applyConfiguredProxySettings()` — what `main/index.ts` runs at `whenReady`: it composes the CA trust set
 *    (`configureNodeProxy`) and installs the global undici dispatcher.
 * 2. Optionally, a managed `env` block written AFTER that, through the product's own `applyManagedEnv` — the order
 *    the host reaches it in (`bootstrapServer` applies the managed env after the network setup ran).
 * 3. `fetchOAuthUrlPinned(<target>, …, [127.0.0.1])` — the MCP OAuth production network: `node:https` to the
 *    already-validated address, the URL's host as SNI and Host. It never goes through the dispatcher.
 *
 * It prints ONE JSON line: the status, or the error code the request died with.
 *
 * Bundled by the test (the F1.498 rig's flags and stubs), never run from source.
 */
import { applyConfiguredProxySettings } from '../../network-proxy'
import { fetchOAuthUrlPinned } from '@nessy-agent/shared/auth'
import { applyManagedEnv } from '@nessy-agent/shared/config/managed-env'

async function main(): Promise<void> {
  await applyConfiguredProxySettings()

  const managed = process.env.UA12185_MANAGED_ENV
  if (managed) {
    applyManagedEnv(JSON.parse(managed) as Record<string, string>, { source: 'managed-file', confirmed: true })
  }

  const target = process.env.UA12185_TARGET
  if (!target) throw new Error('UA12185_TARGET is required')
  let outcome: { status?: number; error?: string }
  try {
    const response = await fetchOAuthUrlPinned(target, { method: 'GET' }, [{ address: '127.0.0.1', family: 4 }])
    outcome = { status: response.status }
    await response.arrayBuffer().catch(() => undefined)
  } catch (error) {
    outcome = { error: String((error as { code?: string }).code ?? (error as Error).message) }
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
