/**
 * P6.440 — the two numeric spellings the page grants, and the exception it
 * carves out in the same sentence.
 *
 * `env-vars.md#variables`, verbatim: "Numeric variables such as timeouts, token
 * budgets, and retry counts accept scientific notation and digit-separator
 * spellings in addition to plain digits, except where a variable's row notes it
 * takes plain digits only. For example, Claude Code reads `2e3` as 2000 and
 * `64_000` as 64000. Before v2.1.211, these spellings could silently set a much
 * smaller value, such as `1e6` setting a timeout to 1."
 *
 * Both halves are pinned here: the grant, and the exception. A parser that
 * implemented only the grant would break `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`,
 * whose row spells the exception out.
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import { join } from 'node:path'

import {
  describeNumericSettingRefusal,
  describeNumericSettingRejection,
  parseNumericSetting,
  reportNumericSettingRejection,
  resetNumericSettingReports,
  resolveNumericSetting,
  resolveOptionalNumericSetting,
} from '../numeric-setting.ts'

/**
 * The refusal ledger in `numeric-setting.ts` is per PROCESS and keyed by
 * (name, value), so whether a refusal is SAID depends on what an earlier test —
 * in this file or in any other file bun loaded into the same process — already
 * said (P6.735). Every case below that asserts a sentence used to clear the
 * ledger on its own first line; hoisting that into one `beforeEach` is what
 * makes the assertions independent of file order rather than each defending
 * itself by hand. The mid-test clears that remain are the ones that are the
 * point of their case.
 */
beforeEach(() => {
  resetNumericSettingReports()
})

describe('parseNumericSetting — the general rule', () => {
  it.each([
    ['2e3', 2000], // the page's first example, verbatim
    ['64_000', 64_000], // the page's second example, verbatim
    ['1e6', 1_000_000], // the pre-v2.1.211 bug: never 1
    ['200', 200],
    [' 200 ', 200], // trimmed first
    ['0', 0],
    ['2E3', 2000], // capital exponent
    ['2e+3', 2000],
    ['2.5e3', 2500], // a float spelling whose value is whole
    ['1_000_000', 1_000_000],
    ['1_0e1_0', 100_000_000_000], // separators in both parts
  ])('reads %j as %i', (raw, expected) => {
    expect(parseNumericSetting(raw)).toEqual({ ok: true, value: expected })
  })

  it.each([
    ['0x20', 'unparseable'], // hex
    ['+3', 'unparseable'], // signed
    ['-1', 'unparseable'],
    ['1__0', 'unparseable'], // doubled separator
    ['_1000', 'unparseable'], // leading separator
    ['1000_', 'unparseable'], // trailing separator
    ['1e', 'unparseable'], // exponent with no digits
    ['abc', 'unparseable'],
    ['1,000', 'unparseable'], // a thousands COMMA is not the separator granted
    ['', 'unparseable'],
    ['  ', 'unparseable'],
    ['1.5', 'not-an-integer'], // parses, but a float where an integer is required
    ['2e-3', 'not-an-integer'],
    ['9007199254740993', 'not-an-integer'], // plain digits past the safe range
    ['1e400', 'not-an-integer'], // Infinity
  ])('refuses %j as %s', (raw, reason) => {
    expect(parseNumericSetting(raw)).toEqual({ ok: false, reason: reason as never })
  })

  it('refuses an unset value rather than inventing one', () => {
    expect(parseNumericSetting(undefined)).toEqual({ ok: false, reason: 'unparseable' })
  })

  it('enforces the range the key documents, separately from the spelling', () => {
    expect(parseNumericSetting('0', { min: 1 })).toEqual({ ok: false, reason: 'out-of-range' })
    expect(parseNumericSetting('11', { max: 10 })).toEqual({ ok: false, reason: 'out-of-range' })
    expect(parseNumericSetting('2e3', { min: 1, max: 5000 })).toEqual({ ok: true, value: 2000 })
  })
})

describe('parseNumericSetting — the exception clause', () => {
  it('refuses the page\'s own two examples when the key\'s row says plain digits', () => {
    expect(parseNumericSetting('2e3', { plainDigitsOnly: true })).toEqual({ ok: false, reason: 'unparseable' })
    expect(parseNumericSetting('64_000', { plainDigitsOnly: true })).toEqual({ ok: false, reason: 'unparseable' })
  })

  it('still takes plain digits, which is the whole point of the mode', () => {
    expect(parseNumericSetting(' 64000 ', { plainDigitsOnly: true })).toEqual({ ok: true, value: 64_000 })
  })

  it('still refuses what the general mode refuses', () => {
    expect(parseNumericSetting('0x20', { plainDigitsOnly: true })).toEqual({ ok: false, reason: 'unparseable' })
    expect(parseNumericSetting('9007199254740993', { plainDigitsOnly: true }))
      .toEqual({ ok: false, reason: 'not-an-integer' })
  })
})

describe('resolveNumericSetting — falls back AND says so', () => {
  it('returns the parsed value and says nothing', () => {
    const said: string[] = []
    expect(resolveNumericSetting('X', '2e3', 7, {}, m => { said.push(m) })).toBe(2000)
    expect(said).toEqual([])
  })

  it('falls back to the default and states the rejection', () => {
    const said: string[] = []
    expect(resolveNumericSetting('X', '0x20', 7, {}, m => { said.push(m) })).toBe(7)
    expect(said).toEqual(['X="0x20" is not a number this setting accepts; using 7 instead.'])
  })

  it('treats unset and empty as silence, not as mistakes', () => {
    const said: string[] = []
    expect(resolveNumericSetting('X', undefined, 7, {}, m => { said.push(m) })).toBe(7)
    expect(resolveNumericSetting('X', '', 7, {}, m => { said.push(m) })).toBe(7)
    expect(resolveNumericSetting('X', '  ', 7, {}, m => { said.push(m) })).toBe(7)
    expect(said).toEqual([])
  })

  it('says it once per name and value, because these readers run per tool call', () => {
    const said: string[] = []
    for (let i = 0; i < 5; i++) resolveNumericSetting('X', 'abc', 7, {}, m => { said.push(m) })
    expect(said).toHaveLength(1)
    // A DIFFERENT bad value is a different problem and is said.
    resolveNumericSetting('X', 'def', 7, {}, m => { said.push(m) })
    expect(said).toHaveLength(2)
    // So is the same value under a different name.
    resolveNumericSetting('Y', 'abc', 7, {}, m => { said.push(m) })
    expect(said).toHaveLength(3)
  })
})

describe('describeNumericSettingRejection — one sentence per reason', () => {
  it('separates the three reasons, so a user can tell a typo from a range error', () => {
    expect(describeNumericSettingRejection('X', '0x20', 'unparseable', 7))
      .toBe('X="0x20" is not a number this setting accepts; using 7 instead.')
    expect(describeNumericSettingRejection('X', '1.5', 'not-an-integer', 7))
      .toBe('X="1.5" is not a whole number; using 7 instead.')
    expect(describeNumericSettingRejection('X', '0', 'out-of-range', 7))
      .toBe('X="0" is outside the range this setting allows; using 7 instead.')
  })
})

describe('reportNumericSettingRejection — the dedupe is per process, and clearable', () => {
  it('re-says a rejection after the register is cleared', () => {
    const said: string[] = []
    reportNumericSettingRejection('X', 'abc', 'unparseable', 7, m => { said.push(m) })
    reportNumericSettingRejection('X', 'abc', 'unparseable', 7, m => { said.push(m) })
    expect(said).toHaveLength(1)
    resetNumericSettingReports()
    reportNumericSettingRejection('X', 'abc', 'unparseable', 7, m => { said.push(m) })
    expect(said).toHaveLength(2)
  })
})

/**
 * P6.566 — the goal check-in interval's absence, BOUND rather than asserted.
 *
 * `numeric-setting.ts`'s docblock records a decision: this fork does not read
 * `env-vars.md`'s goal check-in variable. The vendored `claude` binary carries
 * zero occurrences of the name, so there is nothing native to enable, and the
 * host names its own timer instead.
 *
 * A decision written only in prose is the documented-claim-versus-assertion
 * split this repository has paid for repeatedly: nothing in the suite fails when
 * the world changes underneath the paragraph. This test makes it fail — the day
 * a reader lands, the sweep stops returning zero and the docblock has to be
 * rewritten rather than quietly rotting.
 *
 * **P6.1053 (2026-09-11) — the sweep now distinguishes a READER from a MENTION,
 * because the world moved and the file-level sweep could not tell them apart.**
 * P6.322 landed in `57b3f8847`: the check-in scheduler this variable would tune
 * EXISTS now, host-side for all three runtimes at once, and it is spelled
 * `NESSY_GOAL_CHECKIN_MINUTES` because the binary publishes no name to alias.
 * The module that owns it records that finding in a docblock — and that prose
 * sentence, the one whose whole job is to say the vendor name is unread, was the
 * single hit that turned this case red. Deleting a native-mechanism record to
 * satisfy a grep is the tail wagging the dog, so the sweep was taught the
 * distinction instead: a COMMENT line mentioning the name is prose, any other
 * line is a reader, and only readers are asserted absent. The docblock's REASON
 * was rewritten in the same commit, which is exactly what this case exists to
 * force.
 *
 * THE NAME IS ASSEMBLED, NOT SPELLED, and that is load-bearing. P6.555 was
 * exactly this variable's name pasted into `numeric-setting.ts` as an example:
 * the absence sweep then returned one hit and a reader concluded it was
 * implemented. A test file spelling it would recreate that false positive on the
 * very sweep this test performs.
 *
 * **C4.31 (2026-09-11) — THE READER LANDED, and this case is now pointed the
 * other way.** The owner accepted the vendor spelling as an alias of the host's
 * own `NESSY_GOAL_CHECKIN_MINUTES`, after the 2.1.247 bundle refuted the
 * surviving reason ("there is nothing to alias"): the name scores 4 in the
 * native binary and 1 in `sdk.mjs`, where it scored 0 at 2.1.233. So the case
 * asserts the reader is PRESENT, by file rather than by count, and keeps the
 * prose-versus-code distinction as its negative arm — without it the assertion
 * would be satisfied by the very docblock that records the finding, which is the
 * failure P6.1053 fixed in the other direction. The paragraph in
 * `numeric-setting.ts` was rewritten in the same commit, which is what this case
 * exists to force either way.
 */
describe('P6.566 → C4.31 — the goal check-in interval, bound in both directions', () => {
  const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..', '..')

  /**
   * A line that is prose about the name rather than code reading it. Deliberately
   * the smallest honest rule — a line whose first non-space characters open or
   * continue a comment — and it is pinned on literals below so a filter that
   * quietly stopped filtering cannot make the absence vacuous.
   */
  const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/

  interface Mention { file: string; line: string }

  /** Every line under `packages`/`apps` that mentions the name, by `git grep -a -F -n`. */
  function mentions(name: string): Mention[] {
    const run = Bun.spawnSync(
      ['git', 'grep', '-a', '-F', '-n', name, '--', 'packages', 'apps'],
      { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' },
    )
    // git grep exits 1 for "no match", which is the expected answer here, and
    // anything above 1 is a broken rig rather than an absence.
    if (run.exitCode > 1) throw new Error(`git grep failed: ${run.stderr.toString()}`)
    // Tracked files only, in their WORKING-TREE state: an edit to an existing
    // file is seen immediately, a brand-new untracked file is not. That is the
    // right boundary — `--untracked` would let any lane's scratch file in this
    // shared tree turn this red — and it still catches the reader the moment it
    // is committed. `-n` gives `path:line:content`; the content may itself carry
    // colons, so only the first two are separators.
    return run.stdout.toString().split('\n').filter(raw => raw.length > 0).map(raw => {
      const firstColon = raw.indexOf(':')
      const secondColon = raw.indexOf(':', firstColon + 1)
      return { file: raw.slice(0, firstColon), line: raw.slice(secondColon + 1) }
    })
  }

  /** The mentions that are not prose, as `<file>: <line>` so a red names them. */
  function readers(name: string): string[] {
    return mentions(name)
      .filter(mention => !COMMENT_LINE.test(mention.line))
      .map(mention => `${mention.file}: ${mention.line.trim()}`)
  }

  it('finds the reader the absence was bound against, and still tells prose from code', () => {
    // Assembled on purpose — see the block above.
    const goalCheckinKey = ['CLAUDE', 'CODE', 'GOAL', 'CHECKIN', 'MINUTES'].join('_')

    // C4.31 — the reader landed, which is what this case was built to force.
    // Named by FILE rather than by count: the alias has a constant, a resolver
    // and tests, and a number here would be a pin on how it happens to be
    // written rather than on whether it is read.
    const owner = 'packages/server-core/src/pi-harness/goal-service.ts: '
    expect(readers(goalCheckinKey).some(entry => entry.startsWith(owner))).toBe(true)

    // The negative arm, so the two arms cannot agree: the same file's docblock
    // states the finding in prose, and prose must NOT count as a reader — that
    // is the whole distinction P6.1053 taught this sweep, and it is what keeps
    // the assertion above meaningful rather than satisfied by any mention.
    const prose = mentions(goalCheckinKey).filter(mention => COMMENT_LINE.test(mention.line))
    expect(prose.length).toBeGreaterThan(0)
    expect(readers(goalCheckinKey)).not.toEqual(mentions(goalCheckinKey).map(
      mention => `${mention.file}: ${mention.line.trim()}`,
    ))

    // The classifier, pinned on literals in BOTH directions. Without this a
    // filter that had stopped filtering would let any mention satisfy the
    // reader assertion above.
    expect(COMMENT_LINE.test(` * the binary carries no \`${goalCheckinKey}\``)).toBe(true)
    expect(COMMENT_LINE.test(`  const raw = process.env.${goalCheckinKey}`)).toBe(false)

    // The row-mate this key was paired with in P6.566, kept as the rig control:
    // an empty result here means the sweep itself is broken. THIS file is
    // excluded from it, because the line below spells that name and would
    // otherwise satisfy the control by itself.
    const self = 'packages/shared/src/config/__tests__/numeric-setting.test.ts: '
    expect(readers('CLAUDE_CODE_WEBFETCH_CACHE_TTL_MS')
      .filter(entry => !entry.startsWith(self)).length).toBeGreaterThan(0)
  })
})

/**
 * P6.708 — the fallback-free twin.
 *
 * `describeNumericSettingRejection` ends *"using <fallback> instead"*, which a
 * layer that deliberately returns `undefined` cannot say truthfully. The twin
 * says the accepted form instead, so the operator is told what to write rather
 * than what they were given.
 */
describe('resolveOptionalNumericSetting — refuses out loud, invents no default', () => {
  it('names the variable, the value and the accepted form, and says the setting stays unset', () => {
    const said: string[] = []
    const plainDigits = { min: 1, max: Number.MAX_SAFE_INTEGER, plainDigitsOnly: true }
    expect(resolveOptionalNumericSetting('W', '500k', plainDigits, m => { said.push(m) }))
      .toBeUndefined()
    expect(said).toEqual([
      'W="500k" is not a number this setting accepts;'
      + ' it takes a whole number in plain digits, at least 1.'
      + ' The value is ignored and this setting stays unset.',
    ])
    // No invented fallback anywhere in the sentence — the whole point of the
    // twin, and the shape a mechanical reuse of the other describer would have.
    expect(said[0]).not.toMatch(/using \d+ instead/)
    // `Number.MAX_SAFE_INTEGER` is how this caller spells "the page states no
    // ceiling", so printing it would read as a limit nobody documented.
    expect(said[0]).not.toContain(String(Number.MAX_SAFE_INTEGER))
  })

  it('says nothing at all for an accepted value — the control', () => {
    const said: string[] = []
    expect(resolveOptionalNumericSetting('W', '500000', { plainDigitsOnly: true }, m => { said.push(m) }))
      .toBe(500000)
    // And unset/empty stay silent for the reason the sibling resolver records.
    expect(resolveOptionalNumericSetting('W', undefined, {}, m => { said.push(m) })).toBeUndefined()
    expect(resolveOptionalNumericSetting('W', '  ', {}, m => { said.push(m) })).toBeUndefined()
    expect(said).toEqual([])
  })

  it('states the general spelling and a two-sided range when the key has one', () => {
    // The general side of the page's "except" clause names the page's own two
    // examples, so this sentence and the page agree on what is accepted.
    expect(describeNumericSettingRefusal('P', '0', 'out-of-range', { min: 1, max: 100 }))
      .toBe('P="0" is outside the range this setting allows;'
        + ' it takes a whole number, which may be written in scientific notation (2e3)'
        + ' or with `_` separators (64_000), from 1 to 100.'
        + ' The value is ignored and this setting stays unset.')
  })

  it('shares the once-per-(name, value) ledger with the fallback describer', () => {
    const said: string[] = []
    for (let i = 0; i < 4; i++) {
      resolveOptionalNumericSetting('W', 'abc', {}, m => { said.push(m) })
    }
    expect(said).toHaveLength(1)
    // One refusal, one sentence: the other describer must not get a second turn
    // at the same (name, value).
    reportNumericSettingRejection('W', 'abc', 'unparseable', 7, m => { said.push(m) })
    expect(said).toHaveLength(1)
  })
})
