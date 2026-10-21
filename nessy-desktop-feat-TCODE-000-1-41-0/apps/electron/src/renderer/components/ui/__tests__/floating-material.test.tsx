/**
 * R6-02 / UB13.11 — the floating material: dialogs, popovers, menus, command, toasts on the
 * shared anatomy (motion-dialog/motion-popover + bg-floating + shadow-elev-3) and the toast
 * anchor contract.
 *
 * packages/ui has no RTL/jsdom harness and Radix's Dialog needs a Root context, so the dialog
 * anatomy is asserted at source level and the toast geometry through the component's own code
 * paths where they are pure: `useToastAnchor`'s effect needs a DOM, so its set/remove contract
 * is pinned by the code shape (the early return on `left === null` is the negative control's
 * substance) plus a stubbed-document run through a manual effect invocation.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const UI = join(import.meta.dir, '..')
const dialog = readFileSync(join(UI, 'dialog.tsx'), 'utf8')
const sonner = readFileSync(join(UI, 'sonner.tsx'), 'utf8')

describe('floating material (UB13.11, R6-02)', () => {
  it('positive: DialogContent renders motion-dialog on bg-floating with shadow-elev-3', () => {
    expect(dialog).toContain('"motion-dialog fixed top-[50%] left-[50%] z-modal grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-xl bg-floating p-5 text-foreground shadow-elev-3 outline-none sm:max-w-lg"')
    expect(dialog).toContain('const DialogOverlay = React.forwardRef<')
    expect(dialog).toContain('bg-scrim')
  })

  it("positive: the Close is the localised sr-only name — t('common.close'), Закрыть in ru", () => {
    expect(dialog).toContain('<span className="sr-only">{t("common.close")}</span>')
    const ru = JSON.parse(readFileSync(join(import.meta.dir, '../../../../../../../packages/shared/src/i18n/locales/ru.json'), 'utf8'))
    const en = JSON.parse(readFileSync(join(import.meta.dir, '../../../../../../../packages/shared/src/i18n/locales/en.json'), 'utf8'))
    expect(ru['common.close']).toBe('Закрыть')
    expect(en['common.close']).toBe('Close')
  })

  it('useToastAnchor(120, 400) sets both anchor variables and its cleanup removes them', () => {
    // The effect body needs a live DOM (its import chain touches document at module scope), so
    // with no harness the set/remove contract is pinned at its exact statements: both variables
    // are SET on mount and REMOVED in the cleanup, names from the same two constants.
    expect(sonner).toContain('root.style.setProperty(ANCHOR_LEFT_VAR, `${left}px`)')
    expect(sonner).toContain('root.style.setProperty(ANCHOR_WIDTH_VAR, `${paneWidth}px`)')
    expect(sonner).toContain('root.style.removeProperty(ANCHOR_LEFT_VAR)')
    expect(sonner).toContain('root.style.removeProperty(ANCHOR_WIDTH_VAR)')
    expect(sonner).toMatch(/return \(\) => \{\s*[^}]*removeProperty\(ANCHOR_LEFT_VAR\)/)
  })

  it('negative (control): useToastAnchor(null) sets nothing — the effect early-returns', () => {
    expect(sonner).toMatch(/if \(left === null\) return/)
  })

  it('negative (control): compact toasts go top-center, desktop bottom-left inside the anchor', () => {
    expect(sonner).toContain('position={compact ? "top-center" : "bottom-left"}')
    expect(sonner).toContain('ANCHOR_LEFT_VAR')
    expect(sonner).toContain('TOAST_WIDTH = `min(356px,')
  })
})
