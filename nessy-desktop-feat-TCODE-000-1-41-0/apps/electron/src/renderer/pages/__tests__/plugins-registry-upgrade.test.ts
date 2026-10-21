/**
 * A6 — an upgrade that did not happen must not toast success.
 *
 * `PluginRegistrySource.upgrade` never rejects on a failed re-clone: a refused
 * clone, a timeout or a missing manifest all resolve as `{upgraded:false}` with
 * the previous catalog deliberately left in place (`registry-source.ts`,
 * `!entry.persistable`). The renderer used to `await mutateAsync(...)` and then
 * `toast.success(...)` unconditionally, so the one case the server goes out of
 * its way to report reached the user as "Marketplace upgraded" — over a browse
 * list that was still the pre-upgrade one.
 *
 * `applyRegistryUpgrade` is the production decision, driven here with the
 * surface `PluginsPage` injects into it. The wiring is pinned separately below,
 * because a helper the page does not call proves nothing.
 */

import { describe, expect, it, mock } from 'bun:test'
import { readFileSync } from 'node:fs'

mock.module('@/context/ThemeContext', () => ({
  useTheme: () => ({ theme: 'dark', resolvedTheme: 'dark', setTheme: () => {} }),
  ThemeProvider: ({ children }: { children: unknown }) => children,
}))
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))
if (typeof (globalThis as { DOMMatrix?: unknown }).DOMMatrix === 'undefined') {
  ;(globalThis as { DOMMatrix?: unknown }).DOMMatrix = class DOMMatrix {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0
    is2D = true
  }
}

const t = (key: string): string => key

interface Recorded {
  successes: string[]
  errors: { title: string; description: string }[]
  actionErrors: (string | null)[]
  refreshes: number
}

function surfaceFor(
  upgrade: (ref: { marketplaceId: string }) => Promise<
    import('../PluginsPage').RegistryUpgradeReport & { marketplaceId?: string }
  >,
): { recorded: Recorded; surface: Parameters<typeof import('../PluginsPage')['applyRegistryUpgrade']>[1] } {
  const recorded: Recorded = { successes: [], errors: [], actionErrors: [], refreshes: 0 }
  return {
    recorded,
    surface: {
      upgrade,
      toastSuccess: title => { recorded.successes.push(title) },
      toastError: (title, description) => { recorded.errors.push({ title, description }) },
      setActionError: message => { recorded.actionErrors.push(message) },
      refresh: async () => { recorded.refreshes += 1 },
    },
  }
}

describe('A6 — the upgrade surface reports what actually happened', () => {
  it('a clone that produced no catalog (upgraded:false) fails loudly, never toasts success', async () => {
    const { applyRegistryUpgrade } = await import('@/pages/PluginsPage')
    const { recorded, surface } = surfaceFor(async () => ({ marketplaceId: 'registry-a', upgraded: false }))

    await applyRegistryUpgrade('registry-a', surface, t)

    expect(recorded.successes).toEqual([])
    expect(recorded.errors).toHaveLength(1)
    expect(recorded.errors[0]!.title).toBe('plugins.errorUpgradeMarketplace')
    // No `reason` on the wire → the generic sentence, never a raw enum or the
    // opaque registry id.
    expect(recorded.errors[0]!.description).toBe('plugins.upgradeReasonUnknown')
    // The inline banner is set, so the failure survives the toast timing out.
    expect(recorded.actionErrors).toEqual([null, 'plugins.upgradeReasonUnknown'])
    // Nothing fresh arrived, so there is nothing to refetch — refetching here is
    // what made the pre-upgrade list look like the upgrade's result.
    expect(recorded.refreshes).toBe(0)
  })

  /**
   * The description used to be the bare `marketplaceId` — an opaque
   * `registry-<uuid>`. `0268e8f5` recorded that `reason` stopped at the RPC;
   * it now crosses, so each case gets its own sentence.
   */
  it('names the reason the server gave, never the opaque registry id', async () => {
    const { applyRegistryUpgrade } = await import('@/pages/PluginsPage')
    const cases = [
      ['not-git', 'plugins.upgradeReasonNotGit'],
      ['not-found', 'plugins.upgradeReasonNotFound'],
      ['fetch-failed', 'plugins.upgradeReasonFetchFailed'],
      ['fetch-timeout', 'plugins.upgradeReasonFetchTimeout'],
    ] as const

    for (const [reason, key] of cases) {
      const { recorded, surface } = surfaceFor(async () => ({ upgraded: false, reason }))
      await applyRegistryUpgrade('registry-a', surface, t)

      expect(recorded.errors).toHaveLength(1)
      expect(recorded.errors[0]!.description).toBe(key)
      expect(recorded.actionErrors).toEqual([null, key])
      // The id must not be what the user is shown.
      expect(recorded.errors[0]!.description).not.toContain('registry-a')
      expect(recorded.successes).toEqual([])
    }
  })

  it('every reason the wire can carry has a locale sentence', async () => {
    // The two i18n lints compare locales against each other and are blind to a
    // key that is missing from BOTH, so the resolution is asserted here against
    // the real bundles.
    const { registryUpgradeFailureDescription } = await import('@/pages/PluginsPage')
    const en = JSON.parse(readFileSync(
      new URL('../../../../../../packages/shared/src/i18n/locales/en.json', import.meta.url), 'utf8',
    )) as Record<string, string>
    const ru = JSON.parse(readFileSync(
      new URL('../../../../../../packages/shared/src/i18n/locales/ru.json', import.meta.url), 'utf8',
    )) as Record<string, string>

    const reasons = ['not-git', 'not-found', 'fetch-failed', 'fetch-timeout', undefined] as const
    for (const reason of reasons) {
      const key = registryUpgradeFailureDescription(reason, k => k)
      expect(typeof en[key]).toBe('string')
      expect(typeof ru[key]).toBe('string')
      expect(en[key]!.length).toBeGreaterThan(0)
      expect(ru[key]!.length).toBeGreaterThan(0)
    }
  })

  it('a thrown upgrade keeps the existing failure surface', async () => {
    const { applyRegistryUpgrade } = await import('@/pages/PluginsPage')
    const { recorded, surface } = surfaceFor(async () => { throw new Error('clone refused by host') })

    await applyRegistryUpgrade('registry-a', surface, t)

    expect(recorded.successes).toEqual([])
    expect(recorded.errors).toEqual([
      { title: 'plugins.errorUpgradeMarketplace', description: 'clone refused by host' },
    ])
    expect(recorded.refreshes).toBe(0)
  })

  it('a real upgrade still toasts success and refetches the catalog once', async () => {
    const { applyRegistryUpgrade } = await import('@/pages/PluginsPage')
    const { recorded, surface } = surfaceFor(async () => ({ marketplaceId: 'registry-a', upgraded: true }))

    await applyRegistryUpgrade('registry-a', surface, t)

    expect(recorded.successes).toEqual(['plugins.toastMarketplaceUpgraded'])
    expect(recorded.errors).toEqual([])
    expect(recorded.refreshes).toBe(1)
  })

  it('the Upgrade button routes through applyRegistryUpgrade, not a bare mutateAsync', () => {
    const source = readFileSync(new URL('../PluginsPage.tsx', import.meta.url), 'utf8')
    const start = source.indexOf('const onUpgradeRegistry = useCallback')
    const end = source.indexOf('const onConfirmRemoveRegistry', start)
    expect(start).toBeGreaterThan(-1)
    const handler = source.slice(start, end)
    expect(handler).toContain('applyRegistryUpgrade(marketplaceId, {')
    expect(handler).toContain('upgrade: ref => upgradeRegistryMutation.mutateAsync(ref)')
    // The regression this row exists for: awaiting the mutation in the handler
    // and toasting success straight after it, with `upgraded` never read. The
    // success toast may only be reached through the injected surface, which
    // `applyRegistryUpgrade` calls behind the `upgraded` guard.
    expect(handler).not.toMatch(/await\s+upgradeRegistryMutation\.mutateAsync/)
    expect(handler).toMatch(/toastSuccess:\s*title\s*=>\s*toast\.success\(title\)/)
  })
})
