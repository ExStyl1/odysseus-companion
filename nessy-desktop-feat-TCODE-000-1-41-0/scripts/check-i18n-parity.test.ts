/**
 * Tests for `check-i18n-parity.ts`'s plural-family completeness pass — P6.973.
 *
 * The case that pays for this gate is the one the key-set comparison beside it
 * structurally cannot see: `settings.provenance.codexStateSupplies` carried
 * `_other` and no `_one` in BOTH locales, so the two key sets agreed, `en.json`
 * is the reference and is never faulted, and the script exited 0 while
 * `locale-parity.test.ts` — the only reader that looked — was red on three
 * assertions.
 *
 * That this file exists at all is the second half of the row: the gate's body
 * now sits behind `import.meta.main`, so importing it here runs no check and
 * cannot reach its `process.exit`. A module body that exits kills the runner at
 * import time and reports exit 0 with ZERO tests executed.
 */

import { describe, expect, test } from 'bun:test'

import { findPluralOrphans, isExcusedExtraKey, main } from './check-i18n-parity'

describe('findPluralOrphans', () => {
  test('the defect itself — `_other` with no `_one`, identical in both locales', () => {
    // en's half of it, and ru's, which also carries the `_few`/`_many` that a
    // Russian family needs. Both key sets are self-consistent and they agree
    // with each other on every base; only completeness sees the hole.
    expect(findPluralOrphans('en', ['a.b', 'a.b_other'])).toEqual([
      'en.json: a.b_other exists but a.b_one is missing',
    ])
    expect(findPluralOrphans('ru', ['a.b', 'a.b_few', 'a.b_many', 'a.b_other'])).toEqual([
      'ru.json: a.b_other exists but a.b_one is missing',
    ])
  })

  test('the mirror — `_one` with no `_other`', () => {
    expect(findPluralOrphans('en', ['a.b_one'])).toEqual([
      'en.json: a.b_one exists but a.b_other is missing',
    ])
  })

  test('a complete family is silent, extra per-language forms and all', () => {
    expect(findPluralOrphans('en', ['a.b_one', 'a.b_other'])).toEqual([])
    expect(
      findPluralOrphans('ru', ['a.b_few', 'a.b_many', 'a.b_one', 'a.b_other']),
    ).toEqual([])
  })

  test('only the `_one`/`_other` pair is required — a family carrying neither is not count-driven', () => {
    // `_zero`/`_two`/`_few`/`_many` are per-language: demanding them of every
    // locale would fault correct Japanese and correct English alike, which is
    // the false positive that would make this gate unrunnable.
    expect(findPluralOrphans('ru', ['a.b_few', 'a.b_many'])).toEqual([])
    expect(findPluralOrphans('en', ['a.b', 'a.other_thing', 'a.someone'])).toEqual([])
  })

  test('the gate runs green on the tree it ships with', () => {
    // The positive control for the four cases above: they state key sets by
    // hand, and this one proves the same code reaches the real locale files.
    expect(main()).toBe(0)
  })
})

describe('isExcusedExtraKey — P6.983 deleted the second escape', () => {
  test('POSITIVE — an extra plural form of a family English pluralizes is excused', () => {
    // ru needs `_few`/`_many`; English has the `_one`/`_other` pair, so the
    // family is real and the extra categories are the language, not a defect.
    const en = new Set(['a.b_one', 'a.b_other'])
    expect(isExcusedExtraKey('a.b_few', en)).toBe(true)
    expect(isExcusedExtraKey('a.b_many', en)).toBe(true)
  })

  test('NEGATIVE — a HALF-BUILT English family excuses nothing any more', () => {
    // This is the hole itself. The unsuffixed base being an English key used to
    // wave `a.b_few` through even when English carried `_other` and no `_one` —
    // exactly the state `settings.provenance.codexStateSupplies` sat in while
    // the gate exited 0. Both halves are asserted: with the base present and the
    // family half-built it is NOT excused, and with the pair present it is.
    expect(isExcusedExtraKey('a.b_few', new Set(['a.b', 'a.b_other']))).toBe(false)
    expect(isExcusedExtraKey('a.b_few', new Set(['a.b']))).toBe(false)
    expect(isExcusedExtraKey('a.b_few', new Set(['a.b', 'a.b_one', 'a.b_other']))).toBe(true)
  })

  test('BOUNDARY — a non-plural key is never excused, whatever English holds', () => {
    // The key-set comparison owns that case: an extra key with no plural suffix
    // is a translation English does not have, and this predicate must not
    // swallow it.
    expect(isExcusedExtraKey('a.b', new Set(['a.b_one', 'a.b_other']))).toBe(false)
    expect(isExcusedExtraKey('a.someone', new Set(['a.someone_one', 'a.someone_other']))).toBe(false)
  })
})
