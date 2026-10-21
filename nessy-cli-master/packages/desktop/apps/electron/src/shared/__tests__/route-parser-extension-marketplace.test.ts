import { describe, expect, it } from 'bun:test'
import {
  buildCompoundRoute,
  buildRouteFromNavigationState,
  parseCompoundRoute,
  parseRouteToNavigationState,
} from '../route-parser'

describe('route-parser: extension marketplace routes', () => {
  it('parses extensionMarketplace as the extension marketplace navigator', () => {
    const result = parseCompoundRoute('extensionMarketplace')
    expect(result).not.toBeNull()
    expect(result!.navigator).toBe('extensionMarketplace')
    expect(result!.details).toBeNull()
  })

  it('roundtrips extensionMarketplace', () => {
    const parsed = parseCompoundRoute('extensionMarketplace')!
    expect(buildCompoundRoute(parsed)).toBe('extensionMarketplace')
    expect(
      buildRouteFromNavigationState({
        navigator: 'extensionMarketplace',
        details: null,
      }),
    ).toBe('extensionMarketplace')
  })

  it('roundtrips a selected marketplace extension', () => {
    const parsed = parseCompoundRoute('extensionMarketplace/extension/office')
    expect(parsed).toEqual({
      navigator: 'extensionMarketplace',
      details: { type: 'marketplaceExtension', id: 'office' },
    })
    expect(
      parseRouteToNavigationState('extensionMarketplace/extension/office'),
    ).toEqual({
      navigator: 'extensionMarketplace',
      details: { type: 'marketplaceExtension', extensionId: 'office' },
    })
    expect(
      buildRouteFromNavigationState({
        navigator: 'extensionMarketplace',
        details: { type: 'marketplaceExtension', extensionId: 'office' },
      }),
    ).toBe('extensionMarketplace/extension/office')
  })
})
