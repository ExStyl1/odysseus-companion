/**
 * P2.7 clause (c) — the managed update gate is registered BEFORE the launch
 * check runs.
 *
 * `checkForUpdatesOnLaunch()` is the one update entry point with no user behind
 * it, and `autoUpdater.autoDownload` is `true`: a policy registration that lands
 * after it has already let an unmanaged check contact the feed and stage a
 * download the organization forbade. P2.10's gate cannot help — it asks
 * `areInAppUpdatesManagedDisabled()` at the moment of the check, and at that
 * moment the answer would still be "nothing registered".
 *
 * Asserted against this file's SOURCE, in the shape
 * `storage-readiness-order.test.ts` established for the same file, because
 * there is nothing at runtime to catch a future edit that moves one of the two
 * lines past the other: both calls succeed in either order, and only the feed
 * traffic differs.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')

function position(needle: string): number {
  const index = source.indexOf(needle)
  expect(index, `missing source anchor: ${needle}`).toBeGreaterThanOrEqual(0)
  return index
}

describe('the managed in-app-update gate is armed before anything can check', () => {
  it('registers the provider ahead of the launch check', () => {
    const registration = position('registerEnforcedManagedInAppUpdatesProvider()')
    const launchCheck = position('checkForUpdatesOnLaunch().catch(err => {')
    expect(registration).toBeLessThan(launchCheck)
  })

  /**
   * P3.261 — the CODEX tier had no such guarantee at all, and that is the half
   * this file could not see.
   *
   * `recordCodexInAppUpdatesRequirement` writes a module-scope value that only
   * exists once the first codex runtime of the process has started, which is
   * long after this handler. So on a fleet running codex ALONE the launch check
   * ran UNGATED at every boot — a weaker guarantee than a mixed fleet gets,
   * which inverts what an operator would assume. The last ANSWERED requirement
   * is cached by `codex-agent.ts` and restored here.
   *
   * A SOURCE assertion for the same reason the two around it are: both calls
   * succeed in either order and only the feed traffic differs, so nothing at
   * runtime catches an edit that moves one line past the other.
   *
   * KILLS: deleting the restore, or letting it drift after the launch check —
   * either one puts the codex-only fleet back where it started, silently.
   */
  it('restores the codex tier from the cache before the launch check', () => {
    const restore = position('restoreCodexInAppUpdatesRequirement()')
    const launchCheck = position('checkForUpdatesOnLaunch().catch(err => {')
    expect(restore).toBeLessThan(launchCheck)
    // Beside its host twin rather than anywhere earlier that merely happens to
    // work: the two tiers compose (tightest wins) and a reader that found one
    // armed and the other not would be reading a half-resolved policy.
    const hostTier = position('registerEnforcedManagedInAppUpdatesProvider()')
    expect(restore).toBeLessThan(hostTier)
    const sandbox = position('registerEnforcedManagedSandboxEnabledProvider()')
    expect(sandbox).toBeLessThan(restore)
  })

  it('registers it inside the ready handler, beside the other managed bridges', () => {
    // Not at module scope: the composition it reads needs the config dir, and
    // the three siblings all resolve the same enforced policy from the same
    // place. A registration that drifts out of this cluster is a registration
    // that will drift out of the ordering too.
    const whenReady = position('app.whenReady().then(async () => {')
    const retention = position('registerEnforcedManagedRetentionProvider()')
    const sandbox = position('registerEnforcedManagedSandboxEnabledProvider()')
    const updates = position('registerEnforcedManagedInAppUpdatesProvider()')
    expect(whenReady).toBeLessThan(retention)
    expect(retention).toBeLessThan(sandbox)
    expect(sandbox).toBeLessThan(updates)
  })

  it('registers the whole-policy provider before the server bootstrap that spawns agents', () => {
    // The Claude spawn reads it through `resolveManagedPiPolicyFloor()`, so it
    // has to be in place before a session can exist.
    const policyProvider = position('registerEnforcedManagedPolicyProvider()')
    const bootstrap = position('const instance = await bootstrapServer<SessionManager, HandlerDeps>({')
    expect(policyProvider).toBeLessThan(bootstrap)
  })
})
