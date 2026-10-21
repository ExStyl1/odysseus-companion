import { describe, it, expect } from 'bun:test'
import { getRecentProjectsForScenario } from '../recent-working-dirs'

describe('playground recent working dirs fixtures', () => {
  it('returns empty list for none scenario', () => {
    expect(getRecentProjectsForScenario('none')).toEqual([])
  })

  it('returns populated list for few scenario', () => {
    const few = getRecentProjectsForScenario('few')
    expect(few.length).toBeGreaterThan(0)
    expect(new Set(few.map(project => project.id)).size).toBe(few.length)
    expect(few.every(project => project.id.startsWith('recent-project-'))).toBe(true)
  })

  it('returns >5 entries for many scenario (enables filter UI path)', () => {
    const many = getRecentProjectsForScenario('many')
    expect(many.length).toBeGreaterThan(5)
    expect(new Set(many.map(project => project.id)).size).toBe(many.length)
  })
})
