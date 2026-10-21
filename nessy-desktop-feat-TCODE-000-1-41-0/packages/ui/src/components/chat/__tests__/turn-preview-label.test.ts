/**
 * A11 — the collapsed header's label, checked by assertion instead of by eye.
 *
 * T6's gate said "looks right at three widths", which is a human judgement
 * standing where a check should be, so the cleanest task in the plan could not
 * self-certify. The three objective statements A11 asks for are made here, and
 * the *look* demotes to an optional owner glance in the dark theme.
 *
 * **UB14.11 retargeted this file** from `TurnCard.tsx` to `turn/WorkLog.tsx`:
 * v0.15.1's work log draws the header (`WorkLogHeader`), and its text is decided
 * in `turn/work-log-summary.ts` (asserted on values in
 * `turn/__tests__/work-log-summary.test.ts`). This stays a CONTAINMENT arm over
 * MARKUP ONLY — which classes an element wears, where a child sits — because
 * `WorkLog.tsx` is read as text here for the same claims it always made; a
 * rendered arm has no layout engine to measure wrapping either way:
 *
 * - **"does not wrap"** — the span carrying the lead and the preview wears
 *   Tailwind `truncate` (`white-space: nowrap; overflow: hidden; text-overflow:
 *   ellipsis`), so it cannot wrap at ANY width, which subsumes any three widths.
 * - **"present in the DOM at all three widths"** — no responsive or
 *   container-query variant on that span, and the lead is an unconditional child.
 *   (The preview text is conditional BY DESIGN: `{}` means the lead alone, "N
 *   steps completed".)
 * - **"the failure count is not truncated"** — it used to be a tail of the text
 *   (`turnCard.errorCount`), so this was a statement about label LENGTH. Since
 *   UB14.11 it is the "N failed" chip, a SIBLING after the truncate span, so the
 *   clip cannot reach it at any length. That placement is what is checked below.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const CHAT_DIR = join(import.meta.dir, '..')
const src = readFileSync(join(CHAT_DIR, 'turn', 'WorkLog.tsx'), 'utf-8')
const summarySrc = readFileSync(join(CHAT_DIR, 'turn', 'work-log-summary.ts'), 'utf-8')
const turnCardSrc = readFileSync(join(CHAT_DIR, 'TurnCard.tsx'), 'utf-8')

/** The `{lead}` child, inside its own span inside the summary span. */
const leadIndex = src.indexOf('{lead}')
const leadTagStart = src.lastIndexOf('<span', leadIndex)
/** The summary span: the `<span` that opens before the lead's own span. */
const summaryTagStart = src.lastIndexOf('<span', leadTagStart - 1)
const openingTag = src.slice(summaryTagStart, src.indexOf('>', summaryTagStart) + 1)

/** End of the summary span, found by counting nested `<span` / `</span>` from its opening tag. */
function summarySpanEnd(): number {
  let depth = 0
  const re = /<span\b|<\/span>/g
  re.lastIndex = summaryTagStart
  for (let m = re.exec(src); m; m = re.exec(src)) {
    depth += m[0] === '</span>' ? -1 : 1
    if (depth === 0) return m.index
  }
  return -1
}
const summaryEnd = summarySpanEnd()
const previewChild = src.indexOf('{preview.text}\n')
const chipIndex = src.indexOf('<span className={CHIP_DESTRUCTIVE}>')

describe('the detector itself works', () => {
  // AGENTS.md: an absence claim needs a positive control. Prove the reader finds
  // what is there before trusting it about what is not.
  it('read the real files', () => {
    expect(src).toContain('export function WorkLogHeader(')
    expect(src).toContain("import type { WorkLogPreview } from './work-log-summary'")
    expect(summarySrc).toContain('export function getWorkLogPreview(')
    expect(turnCardSrc).toContain("import { countFailedActivities, getWorkLogPreview } from './turn/work-log-summary'")
    expect(src).not.toContain('a-string-that-is-definitely-not-in-WorkLog')
  })

  it('found the summary span around the lead and the preview text', () => {
    expect(leadIndex).toBeGreaterThan(0)
    expect(openingTag).toContain('className=')
    expect(summaryEnd).toBeGreaterThan(leadIndex)
    expect(previewChild).toBeGreaterThan(leadIndex)
    expect(previewChild).toBeLessThan(summaryEnd)
  })
})

describe('the label cannot wrap', () => {
  it('renders inside a truncate span', () => {
    expect(openingTag).toContain('truncate')
  })

  it('carries nothing that would re-enable wrapping', () => {
    expect(openingTag).not.toMatch(/whitespace-(?:normal|pre-wrap)/)
    expect(openingTag).not.toMatch(/\bbreak-words\b/)
    expect(openingTag).not.toMatch(/line-clamp-[2-9]/)
  })
})

describe('the label is in the DOM at every width', () => {
  it('has no responsive or container-query variant on the summary span', () => {
    expect(openingTag).not.toMatch(/\b(?:sm|md|lg|xl|2xl):/)
    expect(openingTag).not.toMatch(/@[a-z0-9-]+(?:\/[a-z]+)?:/)
  })

  it('renders the lead unconditionally', () => {
    // No `&&` or ternary between the summary span's opening and the lead's span.
    const between = src.slice(summaryTagStart + openingTag.length, leadTagStart)
    expect(between).not.toMatch(/&&|\?/)
  })
})

describe('the failure count sits outside the clip (UB14.11: the "N failed" chip)', () => {
  it('is a sibling AFTER the truncate span, never inside it', () => {
    expect(chipIndex).toBeGreaterThan(summaryEnd)
    expect(src.slice(summaryTagStart, summaryEnd)).not.toContain('failedCount')
  })

  it('the header text no longer carries the old tail', () => {
    expect(summarySrc).not.toContain('turnCard.errorCount')
    expect(turnCardSrc).not.toContain('turnCard.errorCount')
  })
})

describe('turnCard.stepsCompleted (count-less) is gone from the renderer', () => {
  it('is referenced by none of the three files; the count-bearing key replaces it', () => {
    // The old key read "Steps Completed" beside a count badge. v0.15.1's lead is one
    // count-bearing phrase, `turnCard.stepsCompletedCount` ("4 steps completed").
    for (const text of [src, summarySrc, turnCardSrc]) {
      expect(text).not.toContain("'turnCard.stepsCompleted'")
    }
    expect(src).toContain("t('turnCard.stepsCompletedCount', { count: activityCount })")
  })
})
