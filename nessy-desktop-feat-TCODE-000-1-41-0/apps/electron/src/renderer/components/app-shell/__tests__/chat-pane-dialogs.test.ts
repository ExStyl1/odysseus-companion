/**
 * C3.247 — the agents, context and usage dialogs, which had no test of their own.
 *
 * C3.244 gave all four chat-pane dialogs one backdrop and pinned the ANCHOR
 * (`chat-pane-overlay.test.tsx`). The rewind dialog has `rewind-menu.test.tsx`
 * of its own. The other three had nothing: `agents.close`, `context.close` and
 * `usage.close` occur in exactly one file in this tree — `ChatDisplay.tsx` —
 * and in no test, so every affordance they carry was unasserted.
 *
 * ## The instrument, and why it is a source read
 *
 * These three dialogs are inline JSX inside `ChatDisplay.tsx`, which cannot be
 * rendered here: there is no React DOM harness in this tree, and importing that
 * component graph costs minutes and then throws (`pdfjs`/`DOMMatrix` — the W9-y
 * measurement, recorded in `local-mcp-disabled-surfaces.test.tsx`). A source
 * assertion is the honest instrument for "does the affordance reach the
 * component", which is what this file claims; the pixel claims belong to the
 * anchor suite and to a live CDP case.
 *
 * ## What is actually pinned, and why each one can fail
 *
 * 1. **The panel stops click propagation.** Its backdrop closes the dialog on
 *    click, so without `onClick={(event) => event.stopPropagation()}` on the
 *    panel every click INSIDE the dialog would close it — a defect that is
 *    invisible in a screenshot and fatal in use. Three copies, and nothing read
 *    them.
 * 2. **A labelled close control.** The backdrop is the "never mind" exit; the ×
 *    is the deliberate one, and its `aria-label` is the only name a screen
 *    reader gets for it (the glyph is an icon).
 * 3. **A heading and a description.** `aria-label` on the backdrop names the
 *    dialog to assistive technology; the `<h2>` names it on screen. A dialog
 *    that lost one of them would still look right in the other place.
 * 4. **Every key each dialog names resolves in BOTH locales.** `lint:i18n:parity`
 *    proves the two files agree with each other; it cannot prove that a key a
 *    component asks for exists at all. A `t('usage.close')` for a key nobody
 *    added renders the key, and no gate in this repo says so.
 *
 * The REWIND dialog is sliced by the same machinery and asserted alongside, as
 * the positive control: a slicer that had stopped finding blocks would satisfy
 * every assertion above by iterating an empty list.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import en from '@nessy-agent/shared/i18n/locales/en.json'
import ru from '@nessy-agent/shared/i18n/locales/ru.json'

const source = readFileSync(join(import.meta.dir, '..', 'ChatDisplay.tsx'), 'utf8')

/** One `<ChatPaneOverlay label={t('<titleKey>')} …>` block, opening tag to close. */
function dialogBlock(titleKey: string): string {
  const open = source.indexOf(`<ChatPaneOverlay label={t('${titleKey}')}`)
  expect(open, `no chat-pane dialog opens with ${titleKey}`).toBeGreaterThan(-1)
  const end = source.indexOf('</ChatPaneOverlay>', open)
  expect(end, `the ${titleKey} dialog never closes`).toBeGreaterThan(open)
  return source.slice(open, end)
}

interface Dialog {
  /** The id this file calls it by, and the locale prefix it uses. */
  prefix: string
  titleKey: string
}

/** The three the row is about. */
const UNTESTED: readonly Dialog[] = [
  { prefix: 'agents', titleKey: 'agents.title' },
  { prefix: 'context', titleKey: 'context.title' },
  { prefix: 'usage', titleKey: 'usage.title' },
]

const bundles: Record<string, Record<string, string>> = {
  en: en as Record<string, string>,
  ru: ru as Record<string, string>,
}

describe('the chat pane dialogs that had no test (C3.247)', () => {
  for (const { prefix, titleKey } of UNTESTED) {
    describe(`${prefix}`, () => {
      const block = dialogBlock(titleKey)

      it('does not close when the user clicks inside it', () => {
        // The backdrop's own `onClick` is `handleCloseOverlay`. Without this
        // line on the panel, selecting text or pressing a control inside the
        // dialog would dismiss it.
        expect(block).toContain('onClick={(event) => event.stopPropagation()}')
      })

      it('offers a deliberate close control, named for a screen reader', () => {
        expect(block).toContain(`aria-label={t('${prefix}.close')}`)
        expect(block).toContain('onClick={handleCloseOverlay}')
      })

      it('names itself on screen as well as to assistive technology', () => {
        // The backdrop carries `aria-label={t('<prefix>.title')}` (the anchor
        // suite pins that); this is the visible half.
        expect(block).toContain(`<h2 className="text-sm font-semibold text-foreground">{t('${titleKey}')}</h2>`)
        expect(block).toContain(`{t('${prefix}.description')}`)
      })

      it('asks for no key that either locale is missing', () => {
        const keys = [...block.matchAll(/t\('([a-zA-Z][\w.]*)'/g)].map(hit => hit[1]!)
        // The control on the extraction itself: a regex that had stopped
        // matching would make the loop below iterate nothing.
        expect(keys.length, `${prefix}: no t() calls extracted`).toBeGreaterThan(3)
        expect(keys).toContain(titleKey)
        for (const [name, bundle] of Object.entries(bundles)) {
          const missing = keys.filter(key => typeof bundle[key] !== 'string')
          expect(`${name}:${missing.join(',')}`).toBe(`${name}:`)
        }
      })
    })
  }

  it('slices the rewind dialog too — the positive control on the slicer', () => {
    // Rewind has `rewind-menu.test.tsx` of its own, so it is not in the list
    // above. It is sliced here so that "the three blocks were found" is a
    // measurement: a `dialogBlock` that returned an empty string for everything
    // would pass none of these, and one that could not find ANY block would
    // fail here first.
    const rewind = dialogBlock('chat.rewindMenu.title')
    expect(rewind).toContain('<RewindMenuPanel')
    // And the file still opens exactly four: a fifth dialog added without a
    // test is the state this row was opened for.
    expect((source.match(/<ChatPaneOverlay /g) ?? []).length).toBe(4)
  })
})
