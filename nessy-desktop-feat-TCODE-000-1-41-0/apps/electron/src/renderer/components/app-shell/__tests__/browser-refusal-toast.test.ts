/**
 * P2.464 — A MANAGED REFUSAL TOLD IN THE WORDS OF A FAILURE.
 *
 * `BrowserPaneManager.create` refuses when an administrator has turned the
 * in-app browser off. Until this row it threw a PLAIN error and `AppShell`
 * caught it into `toast.error(t('toast.failedToCreateBrowser'))` — the reason
 * discarded entirely, so a policy reached the user as a malfunction and the two
 * opposite remedies (the administrator changes the policy / the user tries
 * again) shared one sentence.
 *
 * WHAT THIS PINS, and neither is the copy:
 *
 *  1. The rule, driven against the REAL export — a refusal is recognised by its
 *     wire CODE and carries the server's own sentence, while every other
 *     failure falls to the generic path. The rule lives in its own module for
 *     the reason `managed-model-refusal.ts` records: `AppShell.tsx` reaches the
 *     `@nessy-agent/ui` barrel, whose chain ends at a `?url` import of the pdf
 *     worker bun's runner cannot load, so a suite importing it must install
 *     `mock.module` stubs on a shared graph first — the trap AGENTS.md names,
 *     entered for no reason other than reaching four lines of pure logic.
 *  2. That the code is still a code. The branch is dead the moment the protocol
 *     renames or drops `BROWSER_MANAGED_DISABLED`, and dead SILENTLY — the
 *     refusal would fall back to the generic sentence, which is the defect this
 *     row closed. `satisfies ErrorCode` catches a rename at compile time;
 *     `isErrorCode` catches a removal here, read from the protocol's OWN
 *     registry rather than from a second copy of the literal.
 *
 * The sibling halves of this row are pinned elsewhere and are NOT restated
 * here: the thrower is `browser-pane-manager.ts` and the model-facing mapping
 * is `pi-agent.ts`'s `mapBrowserToolErrorCode`.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isErrorCode } from '@nessy-agent/shared/protocol'
import en from '@nessy-agent/shared/i18n/locales/en.json'
import ru from '@nessy-agent/shared/i18n/locales/ru.json'
import { describeBrowserRefusal } from '../browser-refusal-toast'

const RULE_MODULE = join(import.meta.dir, '..', 'browser-refusal-toast.ts')
const APP_SHELL = join(import.meta.dir, '..', 'AppShell.tsx')

/** A refusal as the transport rebuilds it: a plain Error carrying the wire code. */
function refused(message: string): Error {
  const error = new Error(message)
  ;(error as Error & { code?: string }).code = 'BROWSER_MANAGED_DISABLED'
  return error
}

describe('P2.464 · a managed browser refusal is recognised by its code', () => {
  it('keeps the server sentence, because it names WHICH document decided', () => {
    // The one fact no translated string can carry, and the only actionable half
    // of the refusal — so it is shown rather than replaced, which is the
    // opposite of what every other coded refusal in this tree does.
    const sentence = 'The in-app browser is disabled by managed policy (acme-corp.json).'
    expect(describeBrowserRefusal(refused(sentence))).toEqual({
      titleKey: 'toast.browserManagedDisabled',
      description: sentence,
    })
  })

  it('branches on the CODE, not on the class or the message', () => {
    // The transport rebuilds a plain Error, so an `instanceof CodedError` test
    // would never match and every real refusal would fall to the generic path.
    // This is the mistake the shape invites, and the reason both sibling halves
    // of this row write the rule down at their own sites.
    expect(describeBrowserRefusal(new Error('disabled by managed policy'))).toBeNull()
    expect(describeBrowserRefusal({ code: 'BROWSER_MANAGED_DISABLED', message: 'x' }))
      .toEqual({ titleKey: 'toast.browserManagedDisabled', description: '[object Object]' })
  })

  it('leaves every other failure to the generic could-not-create path', () => {
    const other = new Error('renderer crashed')
    ;(other as Error & { code?: string }).code = 'HANDLER_ERROR'
    for (const error of [other, new Error('boom'), null, undefined, 'a string', { code: 42 }]) {
      expect(describeBrowserRefusal(error)).toBeNull()
    }
  })
})

describe('P2.464 · the code and the copy still exist', () => {
  it('is a code the protocol still publishes', () => {
    // From the protocol's OWN registry, so a removal reddens here instead of
    // leaving a branch that can never match.
    expect(isErrorCode('BROWSER_MANAGED_DISABLED')).toBe(true)
    // Positive control for the instrument: it really does reject a non-code.
    expect(isErrorCode('BROWSER_MANAGED_DISABLED_TYPO')).toBe(false)
  })

  it('keeps the compile-time half of the drift guard', () => {
    expect(readFileSync(RULE_MODULE, 'utf8')).toContain('satisfies ErrorCode')
  })

  it('has the title in both locales, with no interpolation to lose', () => {
    // The description is the server's sentence, so the TITLE is the whole of
    // what is translated — it must stand alone in either language.
    for (const locale of [en, ru] as Record<string, string>[]) {
      expect(typeof locale['toast.browserManagedDisabled']).toBe('string')
      expect(locale['toast.browserManagedDisabled']!.length).toBeGreaterThan(0)
      expect(locale['toast.browserManagedDisabled']).not.toContain('{{')
    }
    expect(en['toast.browserManagedDisabled']).not.toBe(ru['toast.browserManagedDisabled'])
  })

  it('the caller routes through the rule instead of re-deriving it', () => {
    // A value test cannot see the caller, whose JSX cannot be rendered here.
    // Asserted on the CALL, and with a positive control on the same instrument.
    const source = readFileSync(APP_SHELL, 'utf8')
    expect(source).toContain('describeBrowserRefusal(error)')
    expect(source).toContain("toast.error(t('toast.failedToCreateBrowser'))")
    // The literal must NOT come back inline: a second copy of the code in the
    // component is exactly what the `satisfies ErrorCode` guard cannot see.
    expect(source).not.toContain("=== 'BROWSER_MANAGED_DISABLED'")
  })
})
