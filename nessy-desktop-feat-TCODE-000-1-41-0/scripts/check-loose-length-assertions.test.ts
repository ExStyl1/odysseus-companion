/**
 * The reader for `check-loose-length-assertions.ts`.
 *
 * It asserts the RULE over inline fixtures and never runs the repo-wide census:
 * that scan reads every test file in the tree and belongs on a prompt, not in
 * `bun test`. What this stops is the census rotting into a scanner that matches
 * nothing — the failure mode this plan has shipped once already — without paying
 * a whole-tree walk on every run.
 */
import { describe, expect, it } from 'bun:test'

import { censusFile } from './check-loose-length-assertions.ts'

const fixture = (body: string): string => `import { expect, it } from 'bun:test'\n${body}\n`

describe('the loose-length census', () => {
  it('flags a length assertion under a name that promises WHICH', () => {
    const found = censusFile('f.test.ts', fixture(`
      it('returns only the two enabled sources', () => {
        const sources = resolve()
        expect(sources).toHaveLength(2)
      })
    `))
    expect(found.map(entry => [entry.subject, entry.length, entry.identityRanked]))
      .toEqual([['sources', 2, true]])
  })

  it('does not flag one whose block also asserts the CONTENT of the same subject', () => {
    // The discriminator, and the reason a naive sweep drowns: length is very
    // often the right matcher, and it is right whenever identity is established
    // somewhere else in the same block.
    expect(censusFile('f.test.ts', fixture(`
      it('returns only the two enabled sources', () => {
        const sources = resolve()
        expect(sources).toHaveLength(2)
        expect(sources.map(s => s.id)).toEqual(['a', 'b'])
      })
    `))).toEqual([])
  })

  it('ranks a length assertion under a neutral name lower, and ignores toHaveLength(0)', () => {
    const neutral = censusFile('f.test.ts', fixture(`
      it('collects something', () => {
        expect(collected).toHaveLength(3)
      })
    `))
    expect(neutral.map(entry => entry.identityRanked)).toEqual([false])

    // Emptiness is not an identity claim: there is nothing the assertion could
    // be failing to look at.
    expect(censusFile('f.test.ts', fixture(`
      it('returns exactly the empty set', () => {
        expect(collected).toHaveLength(0)
      })
    `))).toEqual([])
  })
})
