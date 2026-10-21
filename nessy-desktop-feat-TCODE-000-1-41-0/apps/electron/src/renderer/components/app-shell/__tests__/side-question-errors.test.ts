/**
 * D1.398, half two — the `/btw` panel says a SENTENCE where it used to print a
 * code (owner, 2026-09-19: a red bubble reading `agent-not-started`).
 *
 * The census below is the part worth keeping: a map of codes in the renderer
 * and a set of `return { success: false, error: '…' }` literals in a 38 000-line
 * server file drift silently, and the drift is invisible until a user meets the
 * token. So the census READS `SessionManager.ts`'s own source, slices the two
 * side-channel methods out of it, and asserts every literal it finds has a
 * sentence — with a positive control on the extraction itself, because a regex
 * that matched nothing would pass this vacuously.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import en from '@nessy-agent/shared/i18n/locales/en.json'
import ru from '@nessy-agent/shared/i18n/locales/ru.json'
import {
  SIDE_QUESTION_ERROR_CODES,
  SIDE_QUESTION_GENERIC_ERROR_KEY,
  sideQuestionErrorDisplay,
} from '../side-question-errors'

/** Comment-stripped source, so a sentence in a docblock cannot satisfy a pin. */
function stripped(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const locales: Record<string, Record<string, string>> = {
  en: en as Record<string, string>,
  ru: ru as Record<string, string>,
}

describe('D1.398 — a side-question failure is a sentence, not a code', () => {
  it('maps every named code to its own key, with no raw text carried through', () => {
    for (const code of SIDE_QUESTION_ERROR_CODES) {
      const display = sideQuestionErrorDisplay(code)
      expect(display.key.startsWith('chat.sideQuestion.error.')).toBe(true)
      // A mapped code is REPLACED, never shown beside its sentence.
      expect(display.detail).toBeUndefined()
    }
    // The one code that deliberately shares the generic sentence.
    expect(sideQuestionErrorDisplay('unknown-error').key).toBe(SIDE_QUESTION_GENERIC_ERROR_KEY)
    // ...and the start failure that D1.398 half one introduced has its own.
    expect(sideQuestionErrorDisplay('agent-start-failed').key)
      .toBe('chat.sideQuestion.error.agentStartFailed')
  })

  it('keeps a PROVIDER message as a detail under the generic sentence', () => {
    // The catch arms of both server methods return `error.message` verbatim —
    // a sentence already, and often the only thing that says what went wrong.
    const display = sideQuestionErrorDisplay('429 Too Many Requests: retry after 30s')
    expect(display.key).toBe(SIDE_QUESTION_GENERIC_ERROR_KEY)
    expect(display.detail).toBe('429 Too Many Requests: retry after 30s')
  })

  it('answers the generic sentence with no detail for an absent or blank error', () => {
    expect(sideQuestionErrorDisplay(undefined)).toEqual({ key: SIDE_QUESTION_GENERIC_ERROR_KEY })
    expect(sideQuestionErrorDisplay('   ')).toEqual({ key: SIDE_QUESTION_GENERIC_ERROR_KEY })
  })

  it('carries a real sentence in BOTH locales for every key it can return', () => {
    const keys = new Set<string>([SIDE_QUESTION_GENERIC_ERROR_KEY])
    for (const code of SIDE_QUESTION_ERROR_CODES) keys.add(sideQuestionErrorDisplay(code).key)
    expect(keys.size).toBeGreaterThanOrEqual(6)

    for (const [name, bundle] of Object.entries(locales)) {
      for (const key of keys) {
        const sentence = bundle[key]
        // Names the missing key in the failure message rather than "undefined".
        expect(`${name} ${key} -> ${typeof sentence}`).toBe(`${name} ${key} -> string`)
        expect((sentence ?? '').trim().length).toBeGreaterThan(10)
      }
    }
    // A "sentence" that is really the token would satisfy every check above.
    for (const code of SIDE_QUESTION_ERROR_CODES) {
      const key = sideQuestionErrorDisplay(code).key
      for (const bundle of Object.values(locales)) {
        expect(bundle[key]).not.toContain(code)
      }
    }
  })

  /**
   * The census. Codes are minted in `SessionManager`'s two side-channel methods
   * and read here; nothing else connects the two files.
   */
  it('has a sentence for every error literal the two server methods return', () => {
    const source = stripped('../../../../../../../packages/server-core/src/sessions/SessionManager.ts')
    const start = source.indexOf('async askSideQuestion(sessionId')
    const end = source.indexOf('private heapdumpWriter')
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)

    const slice = source.slice(start, end)
    const found = new Set<string>()
    for (const match of slice.matchAll(/error:\s*'([a-z][a-z-]+)'/g)) found.add(match[1] as string)

    // POSITIVE CONTROL on the extraction: an absence census that found nothing
    // would pass the assertion below without reading a byte of behaviour.
    expect(found.size).toBeGreaterThanOrEqual(5)
    expect(found.has('agent-start-failed')).toBe(true)

    // WIDENED ON PURPOSE (F1.95): the codes are a union now, and this census
    // asks about STRINGS scraped out of a source file — the question is whether
    // an arbitrary literal is one of them, which is not a question the union's
    // own type can be asked.
    const known: readonly string[] = SIDE_QUESTION_ERROR_CODES
    const unmapped = [...found].filter(code => !known.includes(code))
    expect(unmapped).toEqual([])
    // The negative: a code nobody minted is NOT quietly mapped.
    expect(known.includes('no-such-code')).toBe(false)
  })

  /**
   * F1.95 / D1.408 — the census above is now the WEAKER of two guards, and this
   * is the stronger one wired end to end: the codes are a union in the DTO, the
   * sentence map is TOTAL over it, and both server methods stamp their coded
   * literals against it. The type gate is what fails first; these arms prove the
   * wiring the types rest on is still in place.
   */
  it('the union in the DTO and the sentence map are ONE list', () => {
    const dto = stripped('../../../../../../../packages/shared/src/protocol/dto.ts')
    const start = dto.indexOf('export type SideQuestionErrorCode =')
    const end = dto.indexOf('export type SideQuestionCodedFailure')
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)

    const declared = [...dto.slice(start, end).matchAll(/'([a-z][a-z-]+)'/g)].map(match => match[1] as string)
    // POSITIVE CONTROL on the extraction: a regex that matched nothing would
    // make the comparison below vacuous in both directions.
    expect(declared.length).toBeGreaterThanOrEqual(5)
    expect([...declared].sort()).toEqual([...SIDE_QUESTION_ERROR_CODES].sort())
  })

  it('every coded literal the two server methods return is stamped against that union', () => {
    // `satisfies SideQuestionCodedFailure` is what turns a typo, or a code that
    // was never added to the union, into a `typecheck:server-core` failure. A
    // literal that lost the stamp is reported BY NAME here.
    const source = stripped('../../../../../../../packages/server-core/src/sessions/SessionManager.ts')
    const start = source.indexOf('async askSideQuestion(sessionId')
    const end = source.indexOf('private heapdumpWriter')
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)

    const coded = [...source.slice(start, end).matchAll(
      /\{ success: false, error: '([a-z][a-z-]+)' \}( satisfies SideQuestionCodedFailure)?/g,
    )]
    expect(coded.length).toBeGreaterThanOrEqual(5)
    expect(coded.filter(match => !match[2]).map(match => match[1])).toEqual([])
  })

  it('the panel renders the sentence — it no longer puts the code in the bubble', () => {
    const panel = stripped('../SideQuestionOverlay.tsx')
    expect(panel).toContain('sideQuestionErrorDisplay(')
    // The defect, spelled the way HEAD spelled it before this row.
    expect(panel).not.toContain('content: current.error')
    expect(panel).not.toContain('content: exchange.error')
  })
})
