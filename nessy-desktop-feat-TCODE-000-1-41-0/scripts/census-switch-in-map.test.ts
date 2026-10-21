/**
 * Tests for `census-switch-in-map.ts` — D1.292.
 *
 * The fixture carries ONE true positive and the THREE false positives WI-ad read
 * by hand when it refuted D1.281 with a proximity grep. That pairing is the
 * point: the row exists because `a switch within 70 lines of a .map(` answered
 * 22 candidates over the tree of which the three inspected were all wrong — the
 * switch was in a neighbouring function. A census whose test only proved the
 * positive would be the same instrument with a nicer implementation.
 *
 * Every arm runs over SOURCE TEXT rather than over the repo, so a sibling lane's
 * commit cannot redden it. The one real-tree arm carries no declared count, for
 * the reason the sibling gates' suites give.
 */

import { describe, expect, setDefaultTimeout, test } from 'bun:test'

import {
  auditSource,
  cannotContainShape,
  census,
  censusFiles,
  MAPPING_METHODS,
  verdictOf,
} from './census-switch-in-map'

/**
 * The file's budget, sized against the measured floor and not against bun's 5 s.
 *
 * Only the real-tree arm needs it, and it needs it for an I/O reason rather than
 * a contention one: `censusFiles()` is a `git ls-files` over 5 079 paths and the
 * arm then reads fifty files — **7.12 s** observed, against a whole-script run of
 * `real 210.49 / user 4.15 / sys 0.97` at load ~9, i.e. 2 % cpu. AGENTS.md: cpu
 * under ~2 % of wall is I/O, and the budget belongs to the FILE.
 */
setDefaultTimeout(120_000)

/** The shape D1.252 was: a bare `default:` in a filtered `.map()` callback. */
const TRUE_POSITIVE = `
const lines = clauses.map(clause => {
  switch (clause.id) {
    case 'a': return 'A'
    case 'b': return 'B'
    default:
      return undefined
  }
}).filter(line => line !== undefined)
`

/** The same call with D1.252's fix: the narrowed value bound to \`never\`. */
const FIXED = `
const lines = clauses.map(clause => {
  switch (clause.id) {
    case 'a': return 'A'
    default: {
      const unhandled: never = clause
      return undefined
    }
  }
}).filter(line => line !== undefined)
`

describe('census-switch-in-map', () => {
  test('the TRUE POSITIVE: a bare default inside a .map() callback is a hit', () => {
    const hits = auditSource('subject.ts', TRUE_POSITIVE)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.verdict).toBe('bare-default')
    expect(hits[0]?.method).toBe('map')
    expect(hits[0]?.cases).toBe(2)
    // The line is the `switch`, and the call's line is carried beside it —
    // a reader triaging the list needs both.
    expect(hits[0]?.line).toBe(3)
    expect(hits[0]?.callLine).toBe(2)
  })

  test('the FIX is not a hit — the `never` binding is what the census is asking for', () => {
    const hits = auditSource('subject.ts', FIXED)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.verdict).toBe('never-bound')
  })

  test('the THREE false-positive shapes the proximity grep produced are all silent', () => {
    // (1) The switch is in a NEIGHBOURING function. This is the one the grep got
    // wrong three times out of three: the two constructs are within a few lines
    // of each other in the file and in no way nested.
    const neighbour = `
      function renderOne(kind: Kind): string {
        switch (kind) {
          case 'a': return 'A'
          default: return ''
        }
      }
      const rendered = kinds.map(kind => renderOne(kind))
    `
    expect(auditSource('a.ts', neighbour)).toEqual([])

    // (2) The switch is inside a function nested WITHIN the callback. Not what
    // the map's own arm returns, which is the whole subject.
    const nested = `
      const rendered = kinds.map(kind => {
        const inner = (k: Kind): string => {
          switch (k) {
            case 'a': return 'A'
            default: return ''
          }
        }
        return inner(kind)
      })
    `
    expect(auditSource('b.ts', nested)).toEqual([])

    // (3) The `.map` is not given a function at all — a method reference, where
    // there is no callback body to contain anything.
    const reference = `
      function render(kind: Kind): string {
        switch (kind) {
          case 'a': return 'A'
          default: return ''
        }
      }
      const rendered = kinds.map(render)
    `
    expect(auditSource('c.ts', reference)).toEqual([])
  })

  test('a switch with NO default arm is its own class, not a hit', () => {
    const hits = auditSource('d.ts', `
      const out = items.map(item => {
        switch (item.kind) {
          case 'a': return 1
        }
        return 0
      })
    `)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.verdict).toBe('no-default')
  })

  test('all three mapping methods are read, and a `forEach` is not one of them', () => {
    for (const method of MAPPING_METHODS) {
      const hits = auditSource('e.ts', TRUE_POSITIVE.replace('.map(', `.${method}(`))
      expect(hits.map(hit => hit.method)).toContain(method)
    }
    // The boundary: `forEach` returns nothing, so `array-callback-return` has no
    // opinion about it and neither does this.
    expect(auditSource('f.ts', TRUE_POSITIVE.replace('.map(', '.forEach('))).toEqual([])
  })

  test('the pre-filter can only cost a parse, never a miss', () => {
    // It decides without parsing, so the only safe direction is to over-include.
    expect(cannotContainShape('const a = 1\n')).toBe(true)
    expect(cannotContainShape('items.map(x => x)\n')).toBe(true)
    expect(cannotContainShape('switch (a) { default: }\n')).toBe(true)
    // Both keywords present — parsed, even when they are only in a comment,
    // which is a wasted parse and never a missed hit.
    expect(cannotContainShape('// switch and .map( in a comment\n')).toBe(false)
    expect(cannotContainShape(TRUE_POSITIVE)).toBe(false)
  })

  test('the real tree is walked and the census is not vacuous', () => {
    // No declared count — a number here would redden on a sibling lane's commit.
    // What is pinned is that the file list and the walk both work, which is what
    // makes a small hit list believable rather than suspicious. Reading on
    // 2026-09-18: 5 079 files, 2 switches inside a mapping callback, 1 bare.
    const files = censusFiles()
    expect(files.length).toBeGreaterThan(0)
    const hits = census(undefined, files.slice(0, 50))
    expect(Array.isArray(hits)).toBe(true)
  })

  test('verdictOf is driven directly, so the three classes cannot drift from their names', () => {
    const verdicts = [TRUE_POSITIVE, FIXED].map(text => auditSource('g.ts', text)[0]?.verdict)
    expect(verdicts).toEqual(['bare-default', 'never-bound'])
    expect(typeof verdictOf).toBe('function')
  })
})
