/**
 * D1.377 — a Stop the app could not deliver is REPORTED, never ignored.
 *
 * Both renderer Stop call sites ended in
 * `window.electronAPI.cancelProcessing(...).catch(error => console.error(…))`:
 * `ChatDisplay.handleStop` (the composer's button) and `AppShell`'s
 * `chat.stopProcessing` action (Esc-Esc). A rejected cancel left the button
 * looking like it had worked, the turn running, and nothing anywhere the user
 * could see — which is the exact shape RS-81 arm A measured and the reason
 * D1.376's one-line renderer defect survived two waves.
 *
 * ## Why this is a SOURCE arm and not a render
 *
 * Importing `ChatDisplay` under bun costs ~136 s and then throws
 * `ReferenceError: DOMMatrix is not defined` from `react-pdf`'s own nested
 * `pdfjs-dist` (AGENTS.md, measured 2026-09-08). The question here is "does the
 * failure reach a surface the user sees", and the honest cheap instrument for
 * that is the call itself. The BEHAVIOUR of the toast is sonner's, not ours.
 *
 * The locale pair is asserted beside it because a `t()` of a key that exists in
 * one locale only renders the key to half the users, and this row's whole point
 * is that the failure is legible.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const APP_SHELL = join(import.meta.dir, '..')
const LOCALES = join(import.meta.dir, '..', '..', '..', '..', '..', '..', '..', 'packages', 'shared', 'src', 'i18n', 'locales')
const KEY = 'chat.submit.stopFailed'

function read(file: string): string {
  return readFileSync(join(APP_SHELL, file), 'utf8')
}

/** The body of a named function or action, from its declaration to `length` chars on. */
function region(source: string, anchor: string, length: number): string {
  const start = source.indexOf(anchor)
  expect(start).toBeGreaterThan(-1)
  return source.slice(start, start + length)
}

describe('a Stop that fails reaches the user', () => {
  it('the composer Stop surfaces the rejection instead of only logging it', () => {
    const handleStop = region(read('ChatDisplay.tsx'), 'const handleStop = (silent = false)', 1400)

    expect(handleStop).toContain('cancelProcessing(session.id, silent).catch(')
    expect(handleStop).toContain(`toast.error(t('${KEY}')`)
    // The console line stays: a support read of the renderer console loses
    // nothing, and the toast is the half the user sees.
    expect(handleStop).toContain('[ChatDisplay] Failed to cancel processing:')
  })

  it('Esc-Esc surfaces it too, because it is a second Stop route and not a second product', () => {
    const escAction = region(read('AppShell.tsx'), "useAction('chat.stopProcessing'", 1200)

    expect(escAction).toContain('cancelProcessing(effectiveSessionId, false).catch(')
    expect(escAction).toContain(`toast.error(t('${KEY}')`)
    expect(escAction).toContain('[AppShell] Failed to cancel processing:')
  })

  it('THE CONTROL — the key exists in BOTH locales, with different text', () => {
    // Without this, both assertions above pass against a key that renders as
    // `chat.submit.stopFailed` to every Russian user. Different text is the
    // cheap proof that the ru value was translated rather than copied.
    const en = JSON.parse(readFileSync(join(LOCALES, 'en.json'), 'utf8')) as Record<string, string>
    const ru = JSON.parse(readFileSync(join(LOCALES, 'ru.json'), 'utf8')) as Record<string, string>

    expect(typeof en[KEY]).toBe('string')
    expect(typeof ru[KEY]).toBe('string')
    expect(en[KEY]).not.toBe(ru[KEY])
  })
})
