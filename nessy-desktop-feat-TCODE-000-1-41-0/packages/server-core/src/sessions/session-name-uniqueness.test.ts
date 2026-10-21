import { describe, expect, it } from 'bun:test'
import {
  isSessionNameTaken,
  isSessionNameVariantOf,
  resolveUniqueSessionName,
  type SessionNameHolderV1,
} from './session-name-uniqueness.ts'

/**
 * C3.224 (= row D1.80 of the integrations plan, carried from P6.464), the
 * naming half. `sessions.md#name-your-sessions`, verbatim: *"Claude Code leaves
 * the name with the session that already has it, renames yours to a variant
 * with a two-word suffix, such as `auth-refactor-graceful-unicorn`, and tells
 * you."*
 *
 * The suffix words are ours (see the module header), so every assertion here is
 * about the SHAPE the page publishes and never about a word — a vocabulary
 * pinned by a test could not grow without breaking one.
 */

const holder = (id: string, name: string, extra: Partial<SessionNameHolderV1> = {}): SessionNameHolderV1 =>
  ({ id, name, ...extra })

/** Deterministic picks, so an assertion reads one suffix rather than 256. */
const cyclingPick = (...indices: number[]) => {
  let call = 0
  return (bound: number) => (indices[call++ % indices.length] ?? 0) % bound
}

describe('isSessionNameTaken', () => {
  it('sees another live session holding the name, and not the session being named', () => {
    const rows = [holder('a', 'auth-refactor'), holder('b', 'payments')]
    expect(isSessionNameTaken('auth-refactor', rows, 'b')).toBe(true)
    // The one case that must answer "free": a session renaming to the name it
    // already has would otherwise displace itself.
    expect(isSessionNameTaken('auth-refactor', rows, 'a')).toBe(false)
    expect(isSessionNameTaken('unheld', rows, 'b')).toBe(false)
  })

  it('ignores archived and hidden rows, which nobody can address', () => {
    const rows = [
      holder('a', 'auth-refactor', { isArchived: true }),
      holder('b', 'auth-refactor', { hidden: true }),
    ]
    expect(isSessionNameTaken('auth-refactor', rows, 'c')).toBe(false)
    // Positive control on the same name: one LIVE row and the answer flips, so
    // the two arms above are the exclusion and not an unreachable list.
    expect(isSessionNameTaken('auth-refactor', [...rows, holder('d', 'auth-refactor')], 'c')).toBe(true)
  })
})

describe('resolveUniqueSessionName', () => {
  it('leaves a free name alone, and reports no displacement', () => {
    expect(resolveUniqueSessionName('auth-refactor', () => false))
      .toEqual({ name: 'auth-refactor' })
  })

  it('assigns the documented two-word-suffix variant and names what it displaced', () => {
    const resolution = resolveUniqueSessionName(
      'auth-refactor',
      (candidate) => candidate === 'auth-refactor',
      cyclingPick(0, 0),
    )

    expect(resolution.name).toBe('auth-refactor-graceful-unicorn')
    // The page's "and tells you" is only reachable through this field: a caller
    // comparing two strings itself could not tell a variant from a rename the
    // user typed.
    expect(resolution.displacedFrom).toBe('auth-refactor')
    expect(isSessionNameVariantOf(resolution.name, 'auth-refactor')).toBe(true)
  })

  it('keeps trying when the first variant is taken too', () => {
    const taken = new Set(['auth-refactor', 'auth-refactor-graceful-unicorn'])
    const resolution = resolveUniqueSessionName(
      'auth-refactor',
      (candidate) => taken.has(candidate),
      cyclingPick(0, 0, 1, 1),
    )

    expect(resolution.name).toBe('auth-refactor-brave-otter')
    expect(resolution.displacedFrom).toBe('auth-refactor')
  })

  /**
   * Unreachable with 256 suffixes and any realistic number of live sessions, and
   * asserted anyway: a loop that could end without an answer would return the
   * TAKEN name, which is the silent duplicate the module exists to prevent.
   */
  it('still answers with a free name when every variant is taken', () => {
    const resolution = resolveUniqueSessionName(
      'auth-refactor',
      (candidate) => candidate !== 'auth-refactor-3',
    )

    expect(resolution.name).toBe('auth-refactor-3')
    expect(resolution.displacedFrom).toBe('auth-refactor')
  })

  it('passes a blank name through, leaving that refusal to its one owner', () => {
    for (const blank of ['', '   ']) {
      expect(resolveUniqueSessionName(blank, () => true)).toEqual({ name: blank })
    }
  })
})

describe('isSessionNameVariantOf', () => {
  it('matches by structure, not by vocabulary', () => {
    expect(isSessionNameVariantOf('auth-refactor-graceful-unicorn', 'auth-refactor')).toBe(true)
    // A name the USER typed that merely starts with the same prefix is not a
    // variant, and neither is a one-word or three-word suffix.
    expect(isSessionNameVariantOf('auth-refactor-v2', 'auth-refactor')).toBe(false)
    expect(isSessionNameVariantOf('auth-refactor-graceful', 'auth-refactor')).toBe(false)
    expect(isSessionNameVariantOf('auth-refactor-graceful-unicorn-2', 'auth-refactor')).toBe(false)
    expect(isSessionNameVariantOf('payments-graceful-unicorn', 'auth-refactor')).toBe(false)
  })
})
