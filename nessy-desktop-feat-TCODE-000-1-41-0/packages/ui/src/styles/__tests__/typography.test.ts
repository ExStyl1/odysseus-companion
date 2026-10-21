/**
 * UB13.6 — Typography: the text roles and the serif display face.
 *
 * The whole row's CODE landed with the token layer (UB13.2's tokens.css/base.css, switched on by
 * UB13.3): UB13.1's reading settled that v0.15.1's serif display face is a SYSTEM STACK — no font
 * file ships and no licence is owed — and this row owns the verification that our tree says so:
 * `--font-serif` is exactly upstream's system stack (ui-serif/"New York"/…), `text-display` is a
 * real utility role at its upstream scale, body copy stays SANS (`--font-default` resolves to
 * `--font-sans`; the pre-redesign mapping of `--font-serif` to the JetBrains MONO stack is gone
 * with the switch), and the posture arm: no font binary in `resources/` and no `@font-face`
 * anywhere in the app stylesheets (the Google Fonts <link> predates this plan and is upstream's
 * own head, untouched).
 *
 * The packaged-build arm (`h1.font-serif.text-display` computes a serif family, and body copy a
 * sans family, via CDP computed style) is UB13.16's sitting arm — recorded there, not here.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const UI_STYLES = join(import.meta.dir, '..')
const tokens = readFileSync(join(UI_STYLES, 'tokens.css'), 'utf8')
const base = readFileSync(join(UI_STYLES, 'base.css'), 'utf8')
const rendererCss = readFileSync(
  join(import.meta.dir, '../../../../../apps/electron/src/renderer/index.css'),
  'utf8',
)

describe('typography: the serif display face and the text roles (UB13.6)', () => {
  it('positive: --font-serif is exactly upstream v0.15.1\'s system stack', () => {
    expect(tokens).toContain(
      '--font-serif: ui-serif, "New York", "Source Serif 4", "Iowan Old Style", Charter, Georgia, serif;',
    )
  })

  it('positive: text-display is a real role at the upstream scale (30px/36px, serif moments only)', () => {
    expect(tokens).toContain('--fs-display: 30px;  --lh-display: 36px;   /* serif display moments only */')
    for (const line of [
      '--text-display: var(--fs-display);',
      '--text-display--line-height: var(--lh-display);',
      '--text-display--letter-spacing: var(--tracking-display);',
    ]) {
      expect(tokens).toContain(line)
    }
  })

  it('negative (control): body copy stays sans — --font-default resolves to --font-sans', () => {
    expect(base).toContain('font-family: var(--font-default);')
    expect(tokens).toContain('--font-default: var(--font-sans);')
  })

  it('negative: --font-serif is no longer the pre-redesign MONO stack (JetBrains Mono is mono-only)', () => {
    const serifLine = tokens.split('\n').find((l) => l.startsWith('  --font-serif:'))
    expect(serifLine).toBeDefined()
    expect(serifLine!).not.toContain('JetBrains Mono')
    // --font-mono keeps JetBrains Mono — the removal is the serif mapping only
    expect(tokens).toContain('--font-mono: "JetBrains Mono"')
  })

  it('posture: no font binary ships in resources and no @font-face in any app stylesheet', () => {
    const resources = join(import.meta.dir, '../../../../../apps/electron/resources')
    const fontish = /\.(woff2?|ttf|otf)$/i
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [e.name],
      )
    expect(walk(resources).filter((n) => fontish.test(n))).toEqual([])
    for (const [name, css] of [['tokens.css', tokens], ['base.css', base], ['index.css', rendererCss]] as const) {
      expect(css.includes('@font-face'), name).toBe(false)
    }
  })
})
