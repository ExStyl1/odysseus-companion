/**
 * F1.81 (origin D1.387) — after adding a marketplace, the page shows the added
 * marketplace, whose section is the one surface that renders its catalogue
 * failure.
 *
 * ## The defect, as it stands after the premise was measured
 *
 * RS-99 (SIT-6b) read the add as SUCCESS while every catalogue fetch failed,
 * with "the only account" a log line. Measured on the real registry source and
 * the real list merge
 * (`packages/shared/src/marketplace/__tests__/add-registry-fetch-failure-surface.test.ts`),
 * the wire already carries the failure: the next list names the registry
 * `fetch_pending` and then with the fetch's own codes on `registryLoadErrors`,
 * and this page renders that as the note of the registry's OWN section
 * (`registryLoadErrorMessageKey`). The silence was where the user stands: the
 * add toasted "Marketplace added" and left the browse view on whatever chip was
 * selected — the built-in Skills Market, for a first add — so the one section
 * that says "loading", then "could not be loaded", was a chip the user had no
 * reason to click. That is the reading RS-99 took from the product side too.
 *
 * ## The instrument
 *
 * `PluginsPage` has no DOM harness in this tree (the page's other suites read
 * pure helpers or its source for the same reason). So this reads the page's
 * source for the ORDER that makes the landing hold: `mutateAsync` resolves
 * after `onSuccess` has awaited `invalidateMarketplaceQueries`, which refetches
 * the registries query (its key sits under `marketplaceQueryKeys.all`); the
 * chip list therefore already holds the new registry when the filter moves, so
 * the page's own fallback effect — a selected id that is not in the chip list
 * falls back to the Skills Market — does not bounce it back.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import { bracedRegion } from '@nessy-agent/shared/testing/source-regions'
import { marketplaceQueryKeys } from '../../hooks/useMarketplaceItems'

const PLUGINS_PAGE = fileURLToPath(new URL('../PluginsPage.tsx', import.meta.url))

describe('F1.81 · the add lands on the added marketplace', () => {
  const src = readFileSync(PLUGINS_PAGE, 'utf-8')
  const onAdd = bracedRegion(src, src.indexOf('const onAddRegistry = useCallback('))

  it('moves the browse filter to the registry the add answered with, after the refresh', () => {
    // BOUNDARY CONTROL: the next handler is declared BELOW this one, so a brace
    // scan that ran away would swallow it and fail here.
    expect(onAdd).not.toContain('const onUpgradeRegistry = useCallback(')
    expect(onAdd).toContain('const result = await addRegistryMutation.mutateAsync(addRegistryPayload(value))')
    const refresh = onAdd.indexOf('await refreshAfterMarketplaceMutation(')
    const land = onAdd.indexOf('setMarketplaceFilter(result.marketplaceId)')
    expect(refresh).toBeGreaterThan(0)
    expect(land, 'the add must select the marketplace it added').toBeGreaterThan(0)
    // After the refresh, never before it: the chip list must already hold the id.
    expect(land).toBeGreaterThan(refresh)
  })

  it('the chip list is refetched by the invalidation the add awaits', () => {
    // `useMarketplaceAddRegistry`'s `onSuccess` returns
    // `invalidateMarketplaceQueries`, which invalidates `marketplaceQueryKeys.all`.
    // The registries query is only covered if its key starts with that prefix.
    expect(marketplaceQueryKeys.registries().slice(0, marketplaceQueryKeys.all.length))
      .toEqual([...marketplaceQueryKeys.all])
  })

  it('CONTROL: the section of the selected registry is the one that renders its load error', () => {
    // The surface the landing exists to reach. If it moved, landing on the
    // registry would reach nothing, and this row would have to be re-decided.
    expect(src).toContain('const loadError = marketplace.registryLoadErrors.find(error => error.marketplaceId === marketplaceFilter)')
    expect(src).toContain('note: t(registryLoadErrorMessageKey(loadError.diagnosticCodes))')
    // ...and the fallback that WOULD bounce an id the chip list lacks.
    expect(src).toContain('setMarketplaceFilter(BUILT_IN_MARKETPLACE_FILTER_ID)')
  })
})
