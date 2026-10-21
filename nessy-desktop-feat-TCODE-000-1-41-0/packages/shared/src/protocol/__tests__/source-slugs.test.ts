/**
 * P2.203 — the wire's own definition of a usable source slug.
 *
 * The rule this file pins is a CONTAINMENT rule, not a spelling rule: an
 * accepted slug can only ever name a direct child of the sources directory.
 * So the property below is measured against `join` itself rather than restated
 * as a second regex — a spelling assertion beside a spelling implementation
 * agrees with it by construction and proves nothing about the path.
 */
import { describe, it, expect } from 'bun:test'
import { posix, win32 } from 'node:path'
import {
  classifySourceSlug,
  partitionSourceSlugs,
  type SourceSlugRejectionReason,
} from '../source-slugs'

/**
 * Every entry is a slug a real installed source can carry.
 * `generateSourceSlug` mints lowercase-hyphen names, but `loadWorkspaceSources`
 * enumerates DIRECTORY NAMES, so an externally-authored folder brings its own.
 */
const USABLE = ['real', 'linear-triage', 'session', 'Linear_Triage', 'a.b', '..foo', '-lead', '1', '  padded  ']

/** C0 controls, NUL included, plus DEL — the same set the module refuses. */
const CTRL = /[\u0000-\u001f\u007f]/

const UNUSABLE: ReadonlyArray<readonly [string, SourceSlugRejectionReason]> = [
  ['', 'blank'],
  ['   ', 'blank'],
  ['\t', 'blank'],
  ['a/b', 'not-contained'],
  ['/abs', 'not-contained'],
  ['../escape', 'not-contained'],
  ['..', 'not-contained'],
  ['.', 'not-contained'],
  ['a\\b', 'not-contained'],
  ['nul\u0000byte', 'control-character'],
  ['nl\nline', 'control-character'],
]

describe('classifySourceSlug', () => {
  it('the sample is not empty, and the two halves do not overlap', () => {
    // Without this the two loops below are vacuous — the failure shape that let a
    // sibling's first mutant survive: a case that never puts a value under test.
    expect(USABLE.length).toBeGreaterThan(5)
    expect(UNUSABLE.length).toBeGreaterThan(5)
    expect(USABLE.filter(slug => UNUSABLE.some(([bad]) => bad === slug))).toEqual([])
  })

  for (const slug of USABLE) {
    it(`accepts ${JSON.stringify(slug)}`, () => {
      expect(classifySourceSlug(slug)).toBeUndefined()
    })
  }

  for (const [slug, reason] of UNUSABLE) {
    it(`refuses ${JSON.stringify(slug)} as ${reason}`, () => {
      expect(classifySourceSlug(slug)).toBe(reason)
    })
  }

  /**
   * "Names a direct child of the sources directory, BY THAT NAME", asked of the
   * very call `getSourcePath` makes. Both halves are needed: `join(dir, 'a/b')`
   * fails the first, and `join(dir, '/abs')` passes the first while silently
   * naming `abs` — an alias for a different slug, and a second cache key for one
   * directory.
   */
  function namesDirectChild(p: typeof posix | typeof win32, slug: string): boolean {
    const sources = p.join(p.sep, 'ws', 'sources')
    const resolved = p.join(sources, slug)
    return p.dirname(resolved) === sources && resolved === `${sources}${p.sep}${slug}`
  }

  it('an accepted slug can only name a DIRECT CHILD of the sources directory', () => {
    for (const slug of USABLE) {
      expect([slug, namesDirectChild(posix, slug), namesDirectChild(win32, slug)])
        .toEqual([slug, true, true])
    }
  })

  /**
   * What each REASON owes, so the rule cannot pass by refusing harmless strings.
   * Containment is what `not-contained` owes; the other two owe something else —
   * a blank names the sources directory itself rather than a child of it, and a
   * control character is not usable as a path segment at all.
   *
   * A lookup rather than a chain of `if`s inside the loop: an `expect` guarded by
   * a condition nobody asserts is DELETED by a regression that flips the
   * condition instead of failing on it (`scripts/check-conditional-expect.ts`).
   */
  const JUSTIFIED: Record<SourceSlugRejectionReason, (slug: string) => boolean> = {
    blank: slug => slug.trim() === '',
    'control-character': slug => CTRL.test(slug),
    // A backslash is a legal POSIX file-name character and a separator on
    // Windows, so the claim is deliberately "on at least one host".
    'not-contained': slug => !(namesDirectChild(posix, slug) && namesDirectChild(win32, slug)),
    // `classifySourceSlug` never returns this one — only `partitionSourceSlugs`
    // does, from list position. An entry claiming it here is a table error.
    duplicate: () => false,
  }

  it('and every refused one is refused because it would NOT', () => {
    for (const [slug, reason] of UNUSABLE) {
      expect([slug, reason, JUSTIFIED[reason](slug)]).toEqual([slug, reason, true])
    }
  })
})

describe('partitionSourceSlugs', () => {
  it('keeps the usable entries in declared order and reports the rest by index', () => {
    // The well-formed slug and the malformed ones travel the SAME call in the
    // SAME assertion: an implementation that refuses everything fails on
    // `accepted`, one that refuses nothing fails on `rejected`.
    const { accepted, rejected } = partitionSourceSlugs(['zeta', '', 'alpha', '../escape', 'zeta'])

    expect(accepted).toEqual(['zeta', 'alpha'])
    expect(rejected).toEqual([
      { index: 1, reason: 'blank' },
      { index: 3, reason: 'not-contained' },
      { index: 4, reason: 'duplicate' },
    ])
  })

  it('a clean list is reported clean, and untouched', () => {
    const slugs = ['alpha', 'zeta']
    const { accepted, rejected } = partitionSourceSlugs(slugs)

    expect(accepted).toEqual(['alpha', 'zeta'])
    expect(rejected).toEqual([])
    expect(slugs).toEqual(['alpha', 'zeta'])
  })

  it('an absent list and an empty one both partition to nothing', () => {
    expect(partitionSourceSlugs(undefined)).toEqual({ accepted: [], rejected: [] })
    expect(partitionSourceSlugs([])).toEqual({ accepted: [], rejected: [] })
  })

  it('nothing is rewritten on the way through', () => {
    // Trimming `'  padded  '` into `'padded'` would be P2.190's own mistake one
    // layer up: normalising distinct inputs onto each other at a boundary.
    expect(partitionSourceSlugs(['  padded  ']).accepted).toEqual(['  padded  '])
  })

  it('the FIRST occurrence survives a duplicate, not the last', () => {
    // Order is a policy input downstream — the permissions merge composes source
    // layers in visit order — so which copy is dropped is not arbitrary.
    const { accepted, rejected } = partitionSourceSlugs(['a', 'b', 'a'])
    expect(accepted).toEqual(['a', 'b'])
    expect(rejected).toEqual([{ index: 2, reason: 'duplicate' }])
  })
})
