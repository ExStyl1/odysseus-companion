import { describe, expect, it } from 'bun:test'
import { selectReattachedSkills } from './skill-reattach-budget.ts'

const body = (tokens: number, marker: string) =>
  `${marker}${'x'.repeat(tokens * 4 - marker.length)}`

describe('selectReattachedSkills', () => {
  const cases = [
    {
      name: 'keeps one skill under 5k whole',
      invocations: [{ skillId: 'review', invokedAt: 1, body: 'Review the diff.' }],
      expected: [{ skillId: 'review', body: 'Review the diff.' }],
    },
    {
      name: 'keeps only the start of a skill over 5k',
      invocations: [{ skillId: 'large', invokedAt: 1, body: `${body(5000, 'START')}TAIL` }],
      expected: [{ skillId: 'large', body: body(5000, 'START') }],
    },
    {
      name: 'fills newest-first and drops the oldest skill entirely past 25k',
      invocations: Array.from({ length: 6 }, (_, index) => ({
        skillId: `skill-${index + 1}`,
        invokedAt: index + 1,
        body: body(5000, `SKILL_${index + 1}`),
      })),
      expected: [6, 5, 4, 3, 2].map(index => ({
        skillId: `skill-${index}`,
        body: body(5000, `SKILL_${index}`),
      })),
    },
    {
      name: 'keeps the most recent invocation of a repeated skill',
      invocations: [
        { skillId: 'review', invokedAt: 1, body: 'old review' },
        { skillId: 'test', invokedAt: 2, body: 'test body' },
        { skillId: 'review', invokedAt: 3, body: 'new review' },
      ],
      expected: [
        { skillId: 'review', body: 'new review' },
        { skillId: 'test', body: 'test body' },
      ],
    },
    {
      name: 'uses later input order as the deterministic tie-breaker',
      invocations: [
        { skillId: 'first', invokedAt: 1, body: 'first body' },
        { skillId: 'second', invokedAt: 1, body: 'second body' },
      ],
      expected: [
        { skillId: 'second', body: 'second body' },
        { skillId: 'first', body: 'first body' },
      ],
    },
    {
      name: 'returns empty without throwing',
      invocations: [],
      expected: [],
    },
  ]

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(selectReattachedSkills(testCase.invocations)).toEqual(testCase.expected)
    })
  }
})
