/**
 * D1.280 — the gate can SEE both defects it exists for, driven on synthetic
 * sources rather than on the tree, so the cases cannot go quiet the day the
 * tree is clean (which it is).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { admittedKeys, declaredNames, measure, UNPARSED_BY_DESIGN } from './check-wire-exact-lists.ts'

describe('D1.280 · the wire/exact census', () => {
  test('reads a field name out of an interface AND out of a type alias', () => {
    const names = declaredNames([
      'export interface A { readonly alpha: string; beta?: number }',
      "export type B = { gamma: string } | { delta: number; epsilon?: boolean }",
    ].join('\n'))
    expect([...names].sort()).toEqual(['alpha', 'beta', 'delta', 'epsilon', 'gamma'])
  })

  test('reads every exact() list, including one broken across lines', () => {
    const { keys, lists } = admittedKeys([
      "exact(value, ['one', 'two'])",
      'exact(other, [',
      "  'three',",
      "  'four',",
      '])',
    ].join('\n'))
    expect(lists).toBe(2)
    expect([...keys].sort()).toEqual(['four', 'one', 'three', 'two'])
  })

  test('the tree is clean in BOTH directions, and the instrument is reading it', () => {
    const result = measure()
    expect(result.admittedButUndeclared).toEqual([])
    expect(result.declaredButUnparsed).toEqual([])
    // The positive control: numbers, not silence. A census that read nothing
    // would satisfy the two assertions above forever.
    expect(result.listCount).toBeGreaterThan(40)
    expect(result.keyCount).toBeGreaterThan(100)
    expect(result.declaredCount).toBeGreaterThan(300)
  })

  test('every allowance carries a reason, and D1.264\'s two fields are NOT allowances', () => {
    for (const [name, reason] of Object.entries(UNPARSED_BY_DESIGN)) {
      expect(reason.length, name).toBeGreaterThan(20)
    }
    // The two fields the row was born from must be ADMITTED by the parser, not
    // excused here — an allowance for either would re-open D1.264 silently, and
    // the gate would go green on the very payload that threw.
    expect(UNPARSED_BY_DESIGN).not.toHaveProperty('questions')
    expect(UNPARSED_BY_DESIGN).not.toHaveProperty('failureReasons')
    const { keys } = admittedKeys(
      readFileSync('packages/shared/src/protocol/pi-harness-runtime.ts', 'utf8'),
    )
    expect(keys.has('questions')).toBe(true)
    // `failureReasons` is the other direction: the PRODUCER was bounded rather
    // than the parser widened, so it must be admitted NOWHERE.
    expect(keys.has('failureReasons')).toBe(false)
  })
})
