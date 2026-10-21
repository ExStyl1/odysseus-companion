/**
 * The headless server applies the configured trust chain to its OWN requests.
 *
 * `applyConfiguredProxySettings` (the Electron main's undici path) is imported
 * exactly once, by apps/electron/src/main/index.ts — nothing installed anything
 * here, so the server's own outbound calls (model fetchers reached through
 * server-core's llm-connections handler and SessionManager) ran with no proxy,
 * no composed CA and no client certificate. Its subprocesses were fine; the
 * server's own process was not.
 *
 * Asserted against the entry source because the alternative — booting the
 * server — costs two minutes and proves less: what matters is that the calls
 * are there, before bootstrap, and that the watcher is torn down.
 */
import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ENTRY = join(import.meta.dir, '..', 'index.ts')
const source = readFileSync(ENTRY, 'utf8')

describe('headless server trust chain', () => {
  it('applies the trust chain at startup, before the server bootstraps', () => {
    const applyAt = source.indexOf('applyProcessNetworkTrustChain()')
    const bootstrapAt = source.indexOf('bootstrapServer<')

    expect(applyAt).toBeGreaterThan(-1)
    expect(bootstrapAt).toBeGreaterThan(-1)
    // Model refresh and credential calls start inside bootstrap.
    expect(applyAt).toBeLessThan(bootstrapAt)
  })

  it('re-applies on settings change and stops watching on shutdown', () => {
    // The headless server has no settings RPC — settings:setNetworkProxy is a
    // LOCAL_ONLY channel — so config.json is the only way an operator rotates a
    // proxy or an mTLS credential without a restart.
    expect(source).toContain('watchNetworkTrustChain()')
    expect(source).toContain('networkTrustWatcher.dispose()')
  })

  it('does not install an undici dispatcher, which this runtime ignores', () => {
    // bin/nessy-server execs `vendor/bun/bun run packages/server/src/index.ts`.
    // Bun's native fetch does not consult undici's global dispatcher, and its
    // undici shim has no Agent.close(), so a dispatcher here would be a placebo
    // that throws on the second apply.
    expect(source).not.toContain('setGlobalDispatcher')
    expect(source).not.toContain("from 'undici'")
  })
})
