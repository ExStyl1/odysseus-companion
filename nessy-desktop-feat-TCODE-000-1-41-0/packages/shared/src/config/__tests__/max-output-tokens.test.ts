/**
 * P6.702 — the reader for `CLAUDE_CODE_MAX_OUTPUT_TOKENS` / `NESSY_MAX_OUTPUT_TOKENS`.
 *
 * The consumer's cases live beside the consumer (`pi-agent-server`'s
 * `model-resolution.test.ts`); what is pinned here is the READING: which name
 * wins, which spellings the page's numeric paragraph admits, and the two
 * documented clauses this module deliberately does not implement — because an
 * absence with a reason is exactly the thing a later reader will otherwise
 * "fix".
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  MAX_OUTPUT_TOKENS_COMPAT_ENV,
  MAX_OUTPUT_TOKENS_ENV,
  MAX_OUTPUT_TOKENS_UNRECOGNISED_MODEL_DEFAULT,
  maxOutputTokens,
} from '../max-output-tokens'
import { resetNumericSettingReports } from '../numeric-setting.ts'

// `delete` before assign, never a bare assign — the Bun spread trap.
function env(record: Record<string, string | undefined>): Record<string, string | undefined> {
  return record
}

afterEach(() => {
  delete process.env[MAX_OUTPUT_TOKENS_ENV]
  delete process.env[MAX_OUTPUT_TOKENS_COMPAT_ENV]
})

/**
 * `resolveOptionalNumericSetting`'s refusal ledger is per PROCESS and keyed by
 * (name, value), so whether a refusal is SAID here depended on what every other
 * file bun loaded into the same process had already said (P6.735). The case
 * below used to defend itself with a value chosen to be globally unique, which
 * works only for as long as nobody else picks it and says nothing about the two
 * cases sitting next to each other. Clearing the ledger before each test is the
 * fix; the pair of cases below is what proves the clearing happens.
 */
beforeEach(() => {
  resetNumericSettingReports()
})

describe('maxOutputTokens', () => {
  it('reads the Nessy spelling', () => {
    expect(maxOutputTokens(env({ [MAX_OUTPUT_TOKENS_ENV]: '4096' }))).toBe(4096)
  })

  it('accepts the documented Claude spelling as a compat alias', () => {
    expect(maxOutputTokens(env({ [MAX_OUTPUT_TOKENS_COMPAT_ENV]: '4096' }))).toBe(4096)
  })

  it('lets the Nessy name win when both are set', () => {
    expect(maxOutputTokens(env({
      [MAX_OUTPUT_TOKENS_ENV]: '4096',
      [MAX_OUTPUT_TOKENS_COMPAT_ENV]: '8192',
    }))).toBe(4096)
  })

  /**
   * `env-vars.md#variables`: *"Numeric variables such as timeouts, token
   * budgets, and retry counts accept scientific notation and digit-separator
   * spellings in addition to plain digits"*. A token budget is named there and
   * this row notes no restriction.
   */
  it.each([['3.2e4', 32000], ['32_000', 32000], ['32000', 32000]])(
    'accepts %s as %i',
    (raw, expected) => {
      expect(maxOutputTokens(env({ [MAX_OUTPUT_TOKENS_ENV]: raw as string }))).toBe(expected)
    },
  )

  /** THE CONTROL: unset says nothing, so the caller leaves the request alone. */
  it('is undefined when neither name is set', () => {
    expect(maxOutputTokens(env({}))).toBeUndefined()
  })

  it('is undefined for an empty value, which is not a configuration', () => {
    expect(maxOutputTokens(env({ [MAX_OUTPUT_TOKENS_ENV]: '   ' }))).toBeUndefined()
  })

  /**
   * A zero-token output budget is a request that cannot answer, and the page
   * describes a maximum rather than a disable — so it is refused, and refusing
   * leaves the ceiling ABSENT rather than substituting a number.
   */
  it.each(['0', '-1', 'not-a-number', '0x20'])('refuses %s and stays absent', raw => {
    expect(maxOutputTokens(env({ [MAX_OUTPUT_TOKENS_ENV]: raw }))).toBeUndefined()
  })

  /**
   * And the refusal is SAID — a ceiling the operator wrote and nobody honours,
   * with nothing telling them, is the silent divergence this row removes.
   *
   * The value used to be unique to this case ON PURPOSE, because
   * `resolveOptionalNumericSetting` shares a once-per-(name, value) ledger
   * across the whole process and a spelling any other test in any other file
   * already refused would be silent here — the assertion then failed for a
   * reason that has nothing to do with this module. Measured, not guessed: it
   * failed exactly that way first. The `beforeEach` above is the real fix
   * (P6.735); the value stays ordinary now, and the case below is the proof.
   */
  it('says the refusal out loud, naming the variable and the accepted form', () => {
    const said: string[] = []
    expect(maxOutputTokens(env({ [MAX_OUTPUT_TOKENS_ENV]: 'not-a-number' }), m => { said.push(m) }))
      .toBeUndefined()

    expect(said).toHaveLength(1)
    expect(said[0]).toContain(MAX_OUTPUT_TOKENS_ENV)
    expect(said[0]).toContain('not-a-number')
  })

  /**
   * The negative arm, and the only one that can see the ledger: the SAME
   * (name, value) the case above just refused. Without the `beforeEach` clear
   * this is silent — `said` comes back empty and the refusal the operator needs
   * is swallowed by a dedupe from a previous test. It is a two-case assertion on
   * purpose: one test can never observe a per-process ledger leaking into the
   * next one.
   */
  it('says it again in the next test, because the ledger is cleared between them', () => {
    const said: string[] = []
    expect(maxOutputTokens(env({ [MAX_OUTPUT_TOKENS_ENV]: 'not-a-number' }), m => { said.push(m) }))
      .toBeUndefined()
    expect(said).toHaveLength(1)
  })

  /**
   * The unimplemented clause, pinned as a NUMBER that nothing reads. If a later
   * lane decides the default is wanted, this constant is where the value comes
   * from — and this case is what makes the decision deliberate rather than a
   * side effect.
   */
  it('sources the 32000 default for unrecognised ids without applying it', () => {
    expect(MAX_OUTPUT_TOKENS_UNRECOGNISED_MODEL_DEFAULT).toBe(32000)
    expect(maxOutputTokens(env({}))).toBeUndefined()
  })
})
