import { describe, expect, it } from 'bun:test'
import {
  buildCompoundRoute,
  buildRouteFromNavigationState,
  parseCompoundRoute,
  parseRouteToNavigationState,
} from '../route-parser'
import { routes } from '../routes'

describe('route-parser: skill marketplace routes', () => {
  it('parses skillMarketplace as the skill marketplace navigator', () => {
    const result = parseCompoundRoute('skillMarketplace')
    expect(result).not.toBeNull()
    expect(result!.navigator).toBe('skillMarketplace')
    expect(result!.details).toBeNull()
  })

  it('converts skillMarketplace to navigation state', () => {
    expect(parseRouteToNavigationState('skillMarketplace')).toEqual({
      navigator: 'skillMarketplace',
      details: null,
    })
  })

  it('roundtrips skillMarketplace', () => {
    const parsed = parseCompoundRoute('skillMarketplace')!
    expect(buildCompoundRoute(parsed)).toBe('skillMarketplace')
    expect(
      buildRouteFromNavigationState({
        navigator: 'skillMarketplace',
        details: null,
      }),
    ).toBe('skillMarketplace')
  })

  it('roundtrips a selected marketplace skill', () => {
    const parsed = parseCompoundRoute('skillMarketplace/skill/pptx')
    expect(parsed).toEqual({
      navigator: 'skillMarketplace',
      details: { type: 'marketplaceSkill', id: 'pptx' },
    })
    expect(parseRouteToNavigationState('skillMarketplace/skill/pptx')).toEqual({
      navigator: 'skillMarketplace',
      details: { type: 'marketplaceSkill', skillId: 'pptx' },
    })
    expect(
      buildRouteFromNavigationState({
        navigator: 'skillMarketplace',
        details: { type: 'marketplaceSkill', skillId: 'pptx' },
      }),
    ).toBe('skillMarketplace/skill/pptx')
  })

  it('roundtrips a selected marketplace skill with a URL id', () => {
    const skillId =
      'https://gitlab.tcsbank.ru/system-analysis/docforge/-/blob/master/skills/plantuml/SKILL.md'
    const route = routes.view.skillMarketplace(skillId)

    expect(route).toBe(
      `skillMarketplace/skill/${encodeURIComponent(skillId)}`,
    )
    expect(parseCompoundRoute(route)).toEqual({
      navigator: 'skillMarketplace',
      details: { type: 'marketplaceSkill', id: skillId },
    })
    expect(parseRouteToNavigationState(route)).toEqual({
      navigator: 'skillMarketplace',
      details: { type: 'marketplaceSkill', skillId },
    })
    expect(
      buildRouteFromNavigationState({
        navigator: 'skillMarketplace',
        details: { type: 'marketplaceSkill', skillId },
      }),
    ).toBe(route)
  })
})
