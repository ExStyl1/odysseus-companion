/**
 * P3.278 — the tool-surface counts written in `runtime-switch-costs.ts` PROSE,
 * re-derived from `getSessionToolNames` and matched against the file's own text.
 *
 * ## Why this test exists at all, when the counts are already pinned
 *
 * They used to be pinned in another package.
 * `session-tools-core/src/scheduling-projection.test.ts` asserted five absolute
 * counts, and what it could not see was a SENTENCE in this module transcribing
 * one of them: when P3.222 took the bare codex surface 18 → 16 the pin moved
 * and four prose copies of it in `runtime-switch-costs.ts` did not. P6.907
 * (`39556c852`) then removed that sibling's literals — they had drifted from
 * their own case titles — which leaves THIS file the only pin of the sizes, and
 * the only one that derives them rather than transcribing them. The absolute
 * NAMES stay pinned by the regenerated `tool-surface.json` fixture behind
 * `check:surface --pin`. The suite stayed green for a day and the
 * module's own header — which already documents this exact failure mode, twice,
 * about itself — gained a fifth instance of it.
 *
 * The header's closing paragraph names the pattern precisely: *"a NUMBER or a
 * QUOTE written beside the value it describes. The counts were pinned and stayed
 * true; the sentences around them were not and did not."* Its answer for quotes
 * was `runtime-switch-costs-gaps-parity.test.ts`, which re-reads the quoted
 * comment blocks. This file is the same answer for numbers.
 *
 * ## Why it matches text rather than exporting the counts
 *
 * A constant the docblock interpolated would not be prose any more, and prose is
 * what a reader of that header actually reads. So the numbers stay written out,
 * and this test asserts the two propositions that can drift apart:
 *
 * 1. every count claimed in the file is the count `getSessionToolNames` answers
 *    today — a live derivation, never a literal in this file either;
 * 2. no OTHER spelling of a surface count survives beside them, which is what
 *    catches a sentence that was missed rather than one that was changed.
 *
 * Proposition 2 is the one that would have caught P3.278 a day earlier: the four
 * stale sites all read `18-tool surface` / `18 under` while a sibling pin said
 * 16, and nothing in the repository compared the two.
 *
 * ## The historical numbers are deliberately NOT swept
 *
 * The file records transitions — `(18 → 23)`, `(23 → 24)`, `44 → 46`, `taking
 * the bare surface from 18 to 16` — and every one of them is a true statement
 * about a past reading. A test that demanded the current value everywhere would
 * force those to be falsified, which is worse than the rot it prevents. They are
 * excluded by SHAPE (an arrow, or the word `until`/`before`), never by a list of
 * line numbers, so a new historical note needs no change here.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  getSessionToolNames,
  SESSION_TOOLS_WITHHELD_FOR_NATIVE_EQUIVALENT,
} from '@nessy-agent/session-tools-core'

const source = readFileSync(
  fileURLToPath(new URL('../runtime-switch-costs.ts', import.meta.url)),
  'utf8',
)

/**
 * The four surfaces, derived with the exact options each enforcement site
 * passes — the same four `runtime-capability-drift.test.ts` derives, and for the
 * same reason: a transcribed set carries its own drift.
 */
const surfaceSizes = () => ({
  pi: getSessionToolNames({ projection: 'pi' }).size,
  claude: getSessionToolNames().size,
  bareCodex: getSessionToolNames({ externalStandaloneOnly: true }).size,
  bridgedCodex: getSessionToolNames({ externalStandaloneOnly: true, hostCallbackBridge: true }).size,
  // UA12.26 — the advisor flag is a surface only ON the bridge:
  // `getSessionToolDefs` ANDs it (`(options?.advisorConsultBridge ?? false) &&
  // hostCallbackBridge`), so it is derived with both, never alone.
  bridgedCodexWithAdvisor: getSessionToolNames({
    externalStandaloneOnly: true, hostCallbackBridge: true, advisorConsultBridge: true,
  }).size,
})

/**
 * Comment lines only, with the historical transitions removed.
 *
 * A count is HISTORICAL when the line that carries it also carries an arrow
 * (`→`), the phrase `from N to M`, or one of the words that dates a reading
 * (`until`, `before`, `moved`). Those sentences are true about a past state and
 * must stay exactly as written; sweeping them would trade one kind of false
 * statement for another.
 */
const currentClaimLines = (): string[] =>
  source
    .split('\n')
    .filter(line => /^\s*\*/.test(line))
    .filter(line => !/→|\bfrom \d+ to \d+\b|\buntil\b|\bbefore\b|\bmoved\b|\bgrew\b|\bshrank\b/.test(line))

/**
 * The spelled-out English count the appActions sentence opens with. A word and
 * not a digit, because the pin must match the prose's own shape ("Seventeen
 * tools…"); two digits cover the difference's plausible range, and beyond them
 * the sentence needs a re-read by a person, not a number this test mints.
 */
const appActionsCountWord = (n: number): string => {
  const ones = [
    'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
    'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
    'seventeen', 'eighteen', 'nineteen',
  ]
  const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']
  if (!Number.isInteger(n) || n < 0 || n > 99) {
    throw new Error(`the appActions count word is spelled out only for 0–99; the derivation gave ${n}`)
  }
  if (n < 20) return ones[n]!
  const t = Math.floor(n / 10)
  const o = n % 10
  return o === 0 ? tens[t]! : `${tens[t]}-${ones[o]}`
}

describe('the surface counts in runtime-switch-costs.ts prose', () => {
  /**
   * KILLS: the P3.278 defect itself — a bare-surface count left at its previous
   * value while `getSessionToolNames` answers something else.
   */
  it('claims the bare codex surface the projection actually answers', () => {
    const { bareCodex } = surfaceSizes()
    // The two live spellings, both in the header's own voice.
    expect(source).toContain(`${bareCodex} under \`externalStandaloneOnly\``)
    expect(source).toContain(`whole life on the ${bareCodex}-tool surface`)
    expect(source).toContain(`lives its whole life on the BARE ${bareCodex}-tool surface`)
  })

  /**
   * KILLS: any of the five pinned counts drifting in the tuple this file
   * transcribes from `scheduling-projection.test.ts`.
   */
  it('transcribes the sibling pin tuple with the derived values', () => {
    const { pi, claude, bareCodex, bridgedCodex } = surfaceSizes()
    expect(source).toContain(`(${pi} / ${claude} / ${bareCodex} / ${bridgedCodex} /`)
    expect(source).toContain(`returns ${pi} names under \`projection: 'pi'\``)
    expect(source).toContain(`${claude} with no\n * projection (Claude)`)
    expect(source).toContain(`and ${bridgedCodex} with\n * \`hostCallbackBridge\``)
  })

  /**
   * UA12.26 (origin UA-n P-UA-n-3, 2026-10-02) — the advisor near-miss sentence
   * said "takes the surface to 28" while this derivation answered 41: the same
   * rot P3.278's five copies died of, in a sentence none of the arms above read.
   * Both live spellings of the claim are asserted — the bridgeTools row's
   * "takes the surface to" and P3.13's correction "advertises N — the M plus
   * exactly", whose M must stay the bridged figure the advisor adds one to.
   * The dated reading in the header ("Re-measured 2026-09-03 — … 28 with
   * `advisorConsultBridge`") is a true statement about a past reading and is
   * deliberately not swept, per this file's historical-numbers rule.
   */
  it('claims the advisor surface the projection actually answers', () => {
    const { bridgedCodex, bridgedCodexWithAdvisor } = surfaceSizes()
    // The prose's own claim about the shape: the flag adds exactly the advisor.
    expect(bridgedCodexWithAdvisor).toBe(bridgedCodex + 1)
    expect(source).toContain(`takes the surface to ${bridgedCodexWithAdvisor}`)
    expect(source).toContain(`advertises ${bridgedCodexWithAdvisor} — the ${bridgedCodex} plus exactly`)
  })

  /**
   * KILLS: the `bridgeTools` row's dated reading falling out of step with the
   * set difference the row is DERIVED from — the defect that left nine names
   * listed where the difference held eleven.
   */
  it('lists the bridge-only difference at the size the projections give it', () => {
    const bare = getSessionToolNames({ externalStandaloneOnly: true })
    const bridged = getSessionToolNames({ externalStandaloneOnly: true, hostCallbackBridge: true })
    const difference = [...bridged].filter(name => !bare.has(name))
    expect(difference.length).toBe(bridged.size - bare.size)
    expect(source).toContain(`bare ${bare.size}, bridged\n   * ${bridged.size}, difference`)
    // SCOPED to the reading itself, not to the file. Every one of these names
    // also appears in the paragraph above the reading, which is what made the
    // whole-file form of this check useless: it passed with a name deleted from
    // the list it was meant to guard.
    const reading = source.slice(
      // UA1.3 — anchored on the YEAR, not the month: the reading is re-dated whenever the bridge moves.
      source.indexOf('The reading on 2026-'),
      source.indexOf('Claude carry every one of them unconditionally'),
    )
    expect(reading.length).toBeGreaterThan(0)
    for (const name of difference) {
      expect(reading, `the bridgeTools reading does not name \`${name}\``).toContain(`\`${name}\``)
    }
  })

  /**
   * UA12.6 — the `appActions` row's COUNT WORD pinned against the drift
   * derivation, the one count in this file's prose no test below or above
   * re-derived: its opening sentence spells the size of
   * `anthropic \ codex-bridged` out ("Seventeen tools are on Claude and absent
   * on Codex") and has gone stale under this very suite's green before (the
   * wave-1 reading that named Eighteen against a derived 19, fixed by UA1.3
   * carrying two tools across). The difference is derived here exactly as
   * `runtime-capability-drift.test.ts` derives the row's grounds — that file
   * owns the membership; this is the prose reader of its size — so the word and
   * the number cannot move apart silently in either direction.
   */
  it('spells the appActions difference at the size the projections give it', () => {
    const claude = getSessionToolNames()
    const bridgedCodex = getSessionToolNames({ externalStandaloneOnly: true, hostCallbackBridge: true })
    const difference = [...claude].filter(
      tool =>
        !bridgedCodex.has(tool)
        && tool !== 'SubmitPlan'
        && !SESSION_TOOLS_WITHHELD_FOR_NATIVE_EQUIVALENT.has(tool),
    )
    // Vacuity control, the drift test's own for this row's grounds: an empty
    // difference would match any word and make this pin silently meaningless.
    expect(difference.length).toBeGreaterThan(0)
    const word = appActionsCountWord(difference.length)
    expect(source).toContain(`${word[0]!.toUpperCase()}${word.slice(1)} tools are on Claude and absent on Codex`)
  })

  /**
   * KILLS: a stale surface count anywhere else in the file — the sentence that
   * was MISSED rather than the one that was edited.
   *
   * Any `N-tool surface` or `N under \`externalStandaloneOnly\`` on a
   * non-historical line must be the live bare figure, and (UA12.26) any
   * "takes the surface to N" / "advertises N" must be the live advisor figure,
   * with "the M plus exactly" the bridged figure it adds one to.
   */
  it('carries no other spelling of a surface count', () => {
    const { bareCodex, bridgedCodex, bridgedCodexWithAdvisor } = surfaceSizes()
    const offenders = currentClaimLines().flatMap(line => {
      const stale: string[] = []
      const bare = line.match(/(\d+)(?:-tool surface|\s+under `externalStandaloneOnly`)/)
      if (bare != null && Number(bare[1]) !== bareCodex) stale.push(line.trim())
      for (const advisor of line.matchAll(/(?:takes the surface to|advertises)\s+(\d+)/g)) {
        if (Number(advisor[1]) !== bridgedCodexWithAdvisor) stale.push(line.trim())
      }
      const plusExactly = line.match(/—\s+the\s+(\d+)\s+plus exactly/)
      if (plusExactly != null && Number(plusExactly[1]) !== bridgedCodex) stale.push(line.trim())
      return stale
    })
    expect(offenders, `stale surface counts: ${offenders.join(' | ')}`).toEqual([])
  })
})
