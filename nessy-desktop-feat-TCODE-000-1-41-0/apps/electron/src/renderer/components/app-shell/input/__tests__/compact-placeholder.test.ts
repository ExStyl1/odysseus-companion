/**
 * F1.93 (origin D1.400) — the compact composer's placeholder, and the DEAD
 * filter that was supposed to guard it.
 *
 * `FreeFormInput` carried a `placeholderOptions` `useMemo` that, in
 * `compactMode`, stripped the desktop-keyboard guidance from a placeholder
 * array. Nothing ever read it: the render path computes
 * `effectivePlaceholderProp` from the RAW prop, shuffles it into
 * `shuffledPlaceholder`, and renders `effectivePlaceholder`. D1.400 called it
 * "the guard that would have prevented D1.392's bug" — the `/btw` panel showing
 * *"Press B to toggle the sidebar"* — and this file is where that claim was
 * measured and REFUTED, which is why the memo was deleted rather than wired:
 *
 * 1. it read `placeholder`, not `effectivePlaceholderProp`, and returned the
 *    prop UNCHANGED when it was not an array — so a compact embedding that
 *    passes NO placeholder (exactly what the `/btw` panel did) falls through to
 *    the default rotation with the guidance still in it;
 * 2. its needles are ENGLISH substrings (`'shift + tab'`, `'toggle the
 *    sidebar'`, `'focus mode'`), so under any other locale it matches nothing.
 *
 * The live guard is the one D1.392 shipped instead: a compact composer NAMES
 * its own placeholder. The `/btw` panel passes
 * `SIDE_QUESTION_PLACEHOLDER_KEYS`, and that is what the third arm below pins.
 *
 * UB14.32 (v0.15.0, "phones no longer rotate keyboard-shortcut tips") takes the
 * OTHER half of upstream's change: the DEFAULT rotation leaves the four keyboard
 * tips out in compact, by KEY (`composer-placeholders.ts`), so it holds in every
 * locale. v0.15.0 also wires the English-needle filter back for caller lists;
 * that half is not taken, and the first arm below still guards it.
 *
 * Source-level, the instrument `ultracode-toggle.test.ts` and
 * `learn-image-refusal-wiring.test.ts` already use in this directory and for the
 * reason they record: `bun test` has no DOM and importing the component pulls a
 * UI barrel bun cannot resolve. The assertions are about symbols and arguments,
 * never about a line.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import { defaultComposerPlaceholderKeys } from '../composer-placeholders'

const composerSource = readFileSync(
  fileURLToPath(new URL('../FreeFormInput.tsx', import.meta.url)),
  'utf8',
)
const overlaySource = readFileSync(
  fileURLToPath(new URL('../../SideQuestionOverlay.tsx', import.meta.url)),
  'utf8',
)
const sideQuestionComposerSource = readFileSync(
  fileURLToPath(new URL('../../side-question-composer.ts', import.meta.url)),
  'utf8',
)

const occurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1

describe('the dead compact-placeholder filter is gone', () => {
  it('THE DEFECT — the memo is DECLARED nowhere, because nothing ever read it', () => {
    // GUARDED ON THE DECLARATION, NOT THE BARE NAME, and that is not a detail:
    // the comment standing where the memo stood spells `placeholderOptions` so
    // the next reader can find this row, and a bare-identifier guard would fail
    // on the very commit that deletes the thing it guards (AGENTS.md §Traps,
    // 2026-09-08). Its filter body is the second, independent needle.
    expect(occurrences(composerSource, 'const placeholderOptions')).toBe(0)
    expect(occurrences(composerSource, "includes('shift + tab')")).toBe(0)
  })

  it('THE POSITIVE CONTROL — the instrument reads the file and can see a declaration in it', () => {
    // If either of these answers 0 the assertion above is meaningless: it would
    // be measuring an unread file rather than a deleted symbol.
    expect(composerSource.length).toBeGreaterThan(10_000)
    expect(occurrences(composerSource, 'const effectivePlaceholderProp')).toBe(1)
  })

  it('CONTROL — the LIVE placeholder path is untouched by the deletion', () => {
    // The three steps the render path actually takes, in order. A deletion that
    // took one of them with it fails here rather than in a screenshot.
    expect(composerSource).toContain('const effectivePlaceholderProp = placeholder ?? defaultPlaceholders')
    expect(composerSource).toContain('Array.isArray(effectivePlaceholderProp) ? shuffleArray(effectivePlaceholderProp) : effectivePlaceholderProp')
    expect(composerSource).toContain('placeholder={effectivePlaceholder}')
  })

  it('CONTROL — the guard that REPLACED it: the compact `/btw` composer names its own placeholder', () => {
    // This is why the filter is not needed rather than merely unused. The panel
    // passes its own three keys, so the default rotation — the one carrying the
    // desktop-keyboard guidance — is never reached there.
    expect(sideQuestionComposerSource).toContain('export const SIDE_QUESTION_PLACEHOLDER_KEYS')
    expect(overlaySource).toContain('placeholder={SIDE_QUESTION_PLACEHOLDER_KEYS.map(key => t(key))}')
  })

  it('CONTROL — the desktop default rotation still carries the guidance it is meant to carry, in upstream\'s order', () => {
    // The deletion must not change the MAIN composer, which is where those hints
    // belong. All seven keys stay.
    expect(defaultComposerPlaceholderKeys(false)).toEqual([
      'chatInput.placeholder.workOn',
      'chatInput.placeholder.shiftTab',
      'chatInput.placeholder.mention',
      'chatInput.placeholder.labels',
      'chatInput.placeholder.newLine',
      'chatInput.placeholder.sidebar',
      'chatInput.placeholder.focusMode',
    ])
  })
})

describe('UB14.32 — the compact DEFAULT rotation leaves the keyboard tips out, by key (v0.15.0)', () => {
  it('POSITIVE — compact defaults contain no `chatInput.placeholder.shiftTab`, nor the other three key tips', () => {
    const compact = defaultComposerPlaceholderKeys(true)
    expect(compact).not.toContain('chatInput.placeholder.shiftTab')
    for (const tip of ['chatInput.placeholder.newLine', 'chatInput.placeholder.sidebar', 'chatInput.placeholder.focusMode']) {
      expect({ tip, inCompact: compact.includes(tip) }).toEqual({ tip, inCompact: false })
    }
    // The three tips that name no key stay, so a compact composer still rotates.
    expect(compact).toEqual(['chatInput.placeholder.workOn', 'chatInput.placeholder.mention', 'chatInput.placeholder.labels'])
  })

  it('the composer builds its defaults from the layout it renders, and re-reads them when the layout changes', () => {
    expect(composerSource).toContain('defaultComposerPlaceholderKeys(compactMode).map(key => t(key, { key: cmdKey }))')
    expect(composerSource).toContain('[t, compactMode],')
    // No second, hard-coded copy of the rotation survives in the component.
    expect(occurrences(composerSource, 't("chatInput.placeholder.shiftTab")')).toBe(0)
  })
})
