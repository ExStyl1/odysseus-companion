/**
 * UB13.18 — the chat column grid (`lib/layout.ts`, R1-07): the 768px column, the `px-6 pt-6
 * pb-8` container, the new compact padding, the `gap-5` turn rhythm, no user-message padding,
 * and the modal backdrop on the `bg-scrim` role instead of `bg-black/50`.
 *
 * The Keep arms pin OUR control column (`controlGutter`/`controlGutterCompact` — upstream has no
 * control column; ChatInputZone lines the composer up with its plates through them). The token
 * arms read `tokens.css` directly so a token class the stylesheet does not declare reddens here
 * rather than silently rendering as no class at all.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CHAT_LAYOUT, OVERLAY_LAYOUT } from '../layout'

const tokensCss = readFileSync(join(import.meta.dir, '../../styles/tokens.css'), 'utf8')

describe('CHAT_LAYOUT (UB13.18)', () => {
  it('positive: the 768px column and the upstream container paddings', () => {
    expect(CHAT_LAYOUT.maxWidth).toBe('max-w-[768px]')
    expect(CHAT_LAYOUT.containerPaddingX).toBe('px-6')
    expect(CHAT_LAYOUT.containerPaddingY).toBe('pt-6 pb-8')
    expect(CHAT_LAYOUT.containerPadding).toBe('px-6 pt-6 pb-8')
    expect(CHAT_LAYOUT.compactContainerPadding).toBe('px-gutter pt-4 pb-6')
    expect(CHAT_LAYOUT.userMessagePadding).toBe('')
  })

  it('boundary: the turn rhythm is the flex column with gap-5 (not the old space-y-2.5)', () => {
    expect(CHAT_LAYOUT.messageSpacing).toContain('gap-5')
    expect(CHAT_LAYOUT.messageSpacing).toContain('flex flex-col')
    expect(CHAT_LAYOUT.messageSpacing).not.toContain('space-y')
  })

  it('positive: OUR control column is kept (upstream has none), on v0.15.1 ChatInputZone\'s composer padding (UB14.33)', () => {
    expect(CHAT_LAYOUT.controlGutter).toBe('px-3 @xs/panel:px-6')
    expect(CHAT_LAYOUT.controlGutterCompact).toBe('px-gutter')
  })

  it('boundary (UB14.33): the control column meets the transcript\'s text edge — 24px desktop, the 16px gutter compact', () => {
    // The desktop gutter's wide arm is the reading column's own padding; the compact gutter is the compact
    // container's horizontal class. The pre-UB14.33 values (`@xs/panel:px-4`, `px-2`) fail both.
    expect(CHAT_LAYOUT.controlGutter.split(' ').pop()).toBe(`@xs/panel:${CHAT_LAYOUT.containerPaddingX}`)
    expect(CHAT_LAYOUT.compactContainerPadding.split(' ')[0]).toBe(CHAT_LAYOUT.controlGutterCompact)
  })

  it('every token class the layout emits is declared in tokens.css', () => {
    expect(OVERLAY_LAYOUT.modalBackdropClass).toBe('bg-scrim')
    for (const cls of ['px-gutter', 'bg-scrim']) {
      // Tailwind v4: a utility exists when its --spacing/--color token does
      const token = cls === 'px-gutter' ? '--spacing-gutter:' : '--color-scrim:'
      expect(tokensCss.includes(token), `${cls} needs ${token}`).toBe(true)
    }
  })
})
