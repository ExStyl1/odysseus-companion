/**
 * C3.248 — the sticky band's background really is opaque, in both themes.
 *
 * C3.245 gave `SystemCard` an opt-in sticky header and said in its own docblock
 * why the background matters: "a translucent sticky header lets the rows
 * scrolling under it show through and become unreadable". It then reached for
 * `bg-muted`, and nothing in this tree ever read the token that name resolves
 * to. MEASURED, `--muted` was `oklch(from var(--foreground) l c h / 0.05)` in
 * the renderer stylesheet's `:root` block AND its `.dark` block — five per cent
 * ALPHA, not a five per cent tint — so the band was ninety-five per cent
 * transparent and the docblock described a property the stylesheet never
 * provided. The fix then was `bg-foreground-5`, the same tint as a colour-mix
 * against the background.
 *
 * UB13.3 (retarget): the theme blocks moved to `packages/ui/src/styles/tokens.css`
 * (the redesign's token layer).
 *
 * UB14.40 (R6-11): the card itself moved onto v0.15.1's sunken well
 * (`bg-sunken`), and `--surface-sunken` is a plain hex — opaque by construction —
 * in both theme blocks, and in every solved theme (`toHex` in
 * `packages/shared/src/config/theme-roles.ts` writes six digits). So the band
 * takes the card's own surface and this file pins THAT reading: the band and the
 * body name `bg-sunken`, the token is an opaque hex in `:root` and in `.dark`,
 * and it is exposed as a utility. If a future theme edit gives `--surface-sunken`
 * an alpha, or the band goes back to an alpha token, this file reddens.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const RENDERER = join(import.meta.dir, '..', '..', '..')
const source = readFileSync(join(RENDERER, 'components/ui/system-card.tsx'), 'utf8')
const css = readFileSync(
  join(RENDERER, '..', '..', '..', '..', 'packages', 'ui', 'src', 'styles', 'tokens.css'),
  'utf8',
)

/**
 * A block of the token stylesheet by the selector that opens it, at the start
 * of a line. Sliced rather than parsed: a declaration's own block is all that is
 * needed, and a CSS parser here would be a second thing to keep true.
 */
function themeBlock(selector: string): string {
  const open = css.indexOf(`\n${selector} {`)
  expect(open, selector).toBeGreaterThan(-1)
  const close = css.indexOf('\n}', open + 1)
  expect(close, selector).toBeGreaterThan(open)
  return css.slice(open, close)
}

/** The value of one custom property's declaration inside a block. */
function declaration(block: string, name: string): string | undefined {
  return block.split('\n').find(line => line.trimStart().startsWith(`${name}:`))
}

/** Opaque: a 3- or 6-digit hex, nothing that carries an alpha channel or mixes to `transparent`. */
const OPAQUE_HEX_VALUE = /:\s*#(?:[0-9a-f]{3}|[0-9a-f]{6});/i

const MODE_BLOCKS = [':root', '.dark'] as const

describe('SystemCard sticky header band', () => {
  it('paints with the card\'s own opaque well, not with an alpha token', () => {
    const sticky = source
      .split('\n')
      .find(line => line.includes('stickyHeader &&') && line.includes('sticky top-0'))
    expect(sticky).toBeDefined()
    expect(sticky!).toContain('bg-sunken')
    // The band must not take any alpha background — `bg-muted` is the one it
    // had, and a `/NN` modifier on anything would reintroduce the defect.
    expect(sticky!).not.toContain('bg-muted')
    expect(sticky!).not.toMatch(/bg-[a-z-]+\/\d/)
  })

  it('draws the card BODY on the same well — the positive control on this read', () => {
    // Without this, a source read that had silently stopped finding the file's
    // class strings would satisfy the assertions above by finding nothing.
    const body = source.split('\n').find(line => line.includes("cn('rounded-lg"))
    expect(body).toBeDefined()
    expect(body!).toContain('bg-sunken')
    expect(body!).not.toContain('bg-muted')
  })

  it('declares --surface-sunken as an opaque hex in BOTH theme blocks', () => {
    for (const mode of MODE_BLOCKS) {
      const sunken = declaration(themeBlock(mode), '--surface-sunken')
      expect(sunken, mode).toBeDefined()
      expect(sunken!, mode).toMatch(OPAQUE_HEX_VALUE)
    }
  })

  it('NEGATIVE (control) — the same opacity read rejects what made the C3.245 band translucent', () => {
    // The instrument must be able to fail: the alpha forms a theme edit could
    // give the token are each refused by the predicate the arm above applies.
    for (const translucent of [
      '  --surface-sunken: #f4f5f680;',
      '  --surface-sunken: color-mix(in srgb, var(--fg-base) 4.5%, transparent);',
      '  --surface-sunken: oklch(from var(--foreground) l c h / 0.05);',
    ]) {
      expect(translucent).not.toMatch(OPAQUE_HEX_VALUE)
    }
    expect('  --surface-sunken: #111214;').toMatch(OPAQUE_HEX_VALUE)
  })

  it('exposes that token as a utility, so `bg-sunken` is a real class', () => {
    expect(css).toContain('--color-sunken: var(--surface-sunken);')
  })
})
