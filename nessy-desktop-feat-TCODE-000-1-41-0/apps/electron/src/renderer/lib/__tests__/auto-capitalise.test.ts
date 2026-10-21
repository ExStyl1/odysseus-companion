import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { WORKFLOW_TRIGGER_KEYWORD } from '@nessy-agent/shared/workflows/workflow-keyword'

import {
  COMPOSER_CASE_SENSITIVE_KEYWORDS,
  COMPOSER_NO_CAPITALISE_PREFIXES,
  autoCapitaliseFirstCharacter,
  shouldAutoCapitaliseFirstCharacter,
} from '../auto-capitalise'

/**
 * C3.351 — the composer may capitalise prose and may not rewrite a token.
 *
 * The POSITIVE control is first and is the one that can fail vacuously: if the
 * predicate ever returned `false` for everything the keyword cases below would
 * all pass while the feature was dead, which is the shape a default flip takes
 * (AGENTS.md §Traps, 2026-09-11).
 */
describe('shouldAutoCapitaliseFirstCharacter', () => {
  it('positive control — ordinary prose is still capitalised', () => {
    expect(shouldAutoCapitaliseFirstCharacter('hello there')).toBe(true)
    expect(shouldAutoCapitaliseFirstCharacter('what does this do?')).toBe(true)
    expect(shouldAutoCapitaliseFirstCharacter('привет')).toBe(true)
  })

  it('a prompt opening with a case-sensitive keyword is left exactly as typed', () => {
    expect(shouldAutoCapitaliseFirstCharacter('ultrathink about this puzzle')).toBe(false)
    expect(shouldAutoCapitaliseFirstCharacter(`${WORKFLOW_TRIGGER_KEYWORD} refactor the parser`)).toBe(false)
    // The keyword ALONE, with no trailing text, is the same case.
    expect(shouldAutoCapitaliseFirstCharacter('ultrathink')).toBe(false)
  })

  it('the keyword is matched on a word boundary, not as a prefix', () => {
    // `ultracodex` is an ordinary word that happens to start with the keyword.
    expect(shouldAutoCapitaliseFirstCharacter(`${WORKFLOW_TRIGGER_KEYWORD}x is not the keyword`)).toBe(true)
    expect(shouldAutoCapitaliseFirstCharacter('ultrathinking about it')).toBe(true)
    // ...and punctuation after it IS a boundary.
    expect(shouldAutoCapitaliseFirstCharacter('ultrathink: why?')).toBe(false)
  })

  it('a keyword the user already capitalised is not re-capitalised either', () => {
    expect(shouldAutoCapitaliseFirstCharacter('Ultrathink about this')).toBe(false)
  })

  it('a keyword away from position 0 does not exempt the prompt', () => {
    // The transform only touches character 0, so nothing later was ever at risk
    // and claiming otherwise would disable the feature for ordinary prompts.
    expect(shouldAutoCapitaliseFirstCharacter('please ultrathink about this')).toBe(true)
  })

  it('the four sigils that were exempt before this row still are', () => {
    for (const prefix of COMPOSER_NO_CAPITALISE_PREFIXES) {
      expect(shouldAutoCapitaliseFirstCharacter(`${prefix}something`)).toBe(false)
    }
    expect([...COMPOSER_NO_CAPITALISE_PREFIXES]).toEqual(['/', '@', '#', '!'])
  })

  it('the empty string is total and never capitalised', () => {
    expect(shouldAutoCapitaliseFirstCharacter('')).toBe(false)
  })

  it('the workflow keyword comes from the shared constant, so a rename moves both halves', () => {
    expect(COMPOSER_CASE_SENSITIVE_KEYWORDS).toContain(WORKFLOW_TRIGGER_KEYWORD)
  })
})

/**
 * F1.460 (5) — the rewrite, driven through the function the composer calls. The
 * F1.249 arm used to assert only `toUpperCase()` on fixed strings, so a mutant of
 * the composer's own capitalising line left every needle intact.
 */
describe('autoCapitaliseFirstCharacter', () => {
  it('positive control — a Latin first letter is upper-cased and the rest kept', () => {
    expect(autoCapitaliseFirstCharacter('pinyin')).toBe('Pinyin')
    expect(autoCapitaliseFirstCharacter('привет, мир')).toBe('Привет, мир')
  })

  it('a committed CJK first character has no upper-case form and passes through unchanged', () => {
    for (const committed of ['你好', 'こんにちは', '안녕하세요']) {
      expect(autoCapitaliseFirstCharacter(committed)).toBe(committed)
    }
  })

  it('whatever the predicate exempts is returned exactly as typed', () => {
    expect(autoCapitaliseFirstCharacter('ultrathink about this')).toBe('ultrathink about this')
    expect(autoCapitaliseFirstCharacter(`${WORKFLOW_TRIGGER_KEYWORD} refactor`)).toBe(`${WORKFLOW_TRIGGER_KEYWORD} refactor`)
    for (const prefix of COMPOSER_NO_CAPITALISE_PREFIXES) {
      expect(autoCapitaliseFirstCharacter(`${prefix}something`)).toBe(`${prefix}something`)
    }
    expect(autoCapitaliseFirstCharacter('')).toBe('')
  })

  it('an already-capitalised prompt comes back identical, so the composer does not rewrite it', () => {
    expect(autoCapitaliseFirstCharacter('Hello')).toBe('Hello')
  })
})

describe('the composer reads the predicate rather than keeping a copy of the list', () => {
  const COMPOSER = readFileSync(
    join(import.meta.dir, '..', '..', 'components', 'app-shell', 'input', 'FreeFormInput.tsx'),
    'utf8',
  )

  it('the capitalisation branch calls the shared rewrite (which reads the predicate)', () => {
    expect(COMPOSER).toContain('const capitalized = autoCapitaliseFirstCharacter(nextValue)')
    expect(COMPOSER).toContain('if (capitalized !== nextValue) {')
  })

  it("negative — the component's own inline sigil chain is gone", () => {
    // The exact chain this row replaced. Asserted as an absence so a revert that
    // re-inlines the list cannot pass beside the call above.
    expect(COMPOSER).not.toContain("nextValue.charAt(0) !== '/'")
  })
})
