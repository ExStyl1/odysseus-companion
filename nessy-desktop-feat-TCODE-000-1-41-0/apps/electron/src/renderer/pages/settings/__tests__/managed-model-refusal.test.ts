/**
 * P2.502 — A MODEL PICKER THAT OFFERS WHAT THE MANAGED ALLOWLIST FORBIDS.
 *
 * THE POSTURE, decided in `AiSettingsPage.tsx` and reasoned there: the pickers
 * on this page OFFER the connection's catalog and the HOST refuses the write.
 * The alternative — narrowing the list here — was rejected for four reasons,
 * the load-bearing one being that the renderer CANNOT compute the answer:
 * `isManagedModelSelectable` is importable here (its module carries zero imports
 * so that it can be), but it reads a registry set once at HOST bootstrap, so in
 * the renderer process it answers TRUE FOR EVERYTHING. A filter built on it
 * would look like a filter and be a no-op — the worst of the available failures.
 *
 * WHAT THIS FILE PINS. Two things, and neither of them is the posture itself:
 *
 *  1. The refusal rule — that a write refused by managed policy is recognised
 *     by its wire CODE and turned into a warning, while anything else falls to
 *     the generic save-failed path. Driven against the REAL exported function,
 *     the convention `ai-settings-reconnect.test.ts` established for this page:
 *     the rule lives in its own module so it can be asserted on values, because
 *     `bun test` has no DOM in this repo and the JSX around it cannot be
 *     rendered. Two earlier drafts are worth knowing about: the first MIRRORED
 *     the six-line body here, and a mutation run showed what that costs —
 *     inverting the predicate in the source left every behavioural assertion
 *     green, because they were testing the copy. The second imported the PAGE,
 *     which works but drags in two `mock.module` stubs and a `DOMMatrix` shim
 *     to get past the UI barrel. (It was also blamed for a 38-second
 *     `beforeAll`; a control run refuted that — see the rule module's header.)
 *  2. That the code is still a code. The branch is dead the moment the protocol
 *     renames or drops `MODEL_RESTRICTED_BY_POLICY`, and dead silently — the
 *     `satisfies ErrorCode` in the source catches a rename at compile time, and
 *     `isErrorCode` catches it here at runtime, from the protocol's OWN
 *     registry rather than from a second copy of the literal.
 *
 * WHAT THIS FILE DOES NOT CLAIM. The guardian channel does not throw that code
 * today: `SET_MODEL_FOR_CONNECTION` writes without consulting the allowlist and
 * `resolveGuardianModelId` silently drops a forbidden id later. The refusal arm
 * is therefore correct and not yet reachable through that one channel — the
 * gate belongs beside the write, in the host, and that is reported as its own
 * unit rather than smuggled in here. The ROLLBACK half of the same handler is
 * live today for every transport failure, which is what it was missing.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isErrorCode } from '@nessy-agent/shared/protocol'
import en from '@nessy-agent/shared/i18n/locales/en.json'
import ru from '@nessy-agent/shared/i18n/locales/ru.json'
// The rule itself, imported directly. Its module carries one TYPE import and
// nothing else, precisely so this suite needs no pdfjs stubs and no `DOMMatrix`
// shim — see that module's header for what importing the PAGE instead cost.
import { describeManagedModelRefusal } from '../managed-model-refusal'

const AI_SETTINGS = join(import.meta.dir, '..', 'AiSettingsPage.tsx')
const RULE_MODULE = join(import.meta.dir, '..', 'managed-model-refusal.ts')

/** A refusal as the transport rebuilds it: a plain Error carrying the wire code. */
function refused(model: string): Error {
  const error = new Error(`Model is restricted by managed policy: ${model}`)
  ;(error as Error & { code?: string }).code = 'MODEL_RESTRICTED_BY_POLICY'
  return error
}

describe('P2.502 · a managed-policy refusal is recognised by its code', () => {
  it('turns the coded refusal into a warning naming the model', () => {
    expect(describeManagedModelRefusal(refused('gpt-5'), 'gpt-5')).toEqual({
      titleKey: 'chat.modelPicker.restrictedByPolicy',
      description: 'gpt-5',
    })
  })

  it('branches on the CODE, not on the class or the message', () => {
    // The transport rebuilds a plain Error, so an `instanceof CodedError` test
    // would never match and the refusal would fall to the generic path.
    const plain = new Error('Model is restricted by managed policy: gpt-5')
    expect(describeManagedModelRefusal(plain, 'gpt-5')).toBeNull()

    // And any object carrying the code qualifies, however it was rebuilt.
    expect(describeManagedModelRefusal({ code: 'MODEL_RESTRICTED_BY_POLICY' }, 'x'))
      .toEqual({ titleKey: 'chat.modelPicker.restrictedByPolicy', description: 'x' })
  })

  it('leaves every other failure to the generic save-failed path', () => {
    const other = new Error('socket hung up')
    ;(other as Error & { code?: string }).code = 'HANDLER_ERROR'
    for (const error of [other, new Error('boom'), null, undefined, 'a string', { code: 42 }]) {
      expect(describeManagedModelRefusal(error, 'gpt-5')).toBeNull()
    }
  })
})

describe('P2.502 · the code and the copy still exist', () => {
  it('is a code the protocol still publishes', () => {
    // From the protocol's OWN registry. A rename or removal reddens here
    // instead of leaving a branch that can never match.
    expect(isErrorCode('MODEL_RESTRICTED_BY_POLICY')).toBe(true)
    // Positive control for the instrument: it really does reject a non-code.
    expect(isErrorCode('MODEL_RESTRICTED_BY_POLICY_TYPO')).toBe(false)
  })

  it('reuses a title that is translated and does NOT reuse the session-only description', () => {
    const key = 'chat.modelPicker.restrictedByPolicy'
    for (const locale of [en, ru] as Record<string, string>[]) {
      expect(typeof locale[key]).toBe('string')
      expect(locale[key]!.length).toBeGreaterThan(0)
      // The title carries no interpolation, which is why it survives being
      // moved off the session picker onto a settings row.
      expect(locale[key]).not.toContain('{{')
    }
    // Its companion description ends on a session-specific promise, so this
    // page passes the model id instead. If that ever stops being true the
    // description key becomes reusable and this assertion should be revisited.
    expect(en[`${key}Desc` as keyof typeof en]).toContain('{{model}}')
  })
})

describe('P2.502 · the page still carries the rule and the posture', () => {
  const source = readFileSync(AI_SETTINGS, 'utf8')
  const rule = readFileSync(RULE_MODULE, 'utf8')

  // The rule's BEHAVIOUR is driven above, against the real export — these
  // assertions cover only what a value test cannot see: the compile-time drift
  // guard, and the two properties of the CALLER, whose JSX cannot be rendered
  // here. Pinning the function body as text was tried and removed: with the
  // real function imported it asserts nothing new and reddens on a rename.
  it('keeps the compile-time half of the drift guard', () => {
    expect(rule).toContain('satisfies ErrorCode')
  })

  it('keeps the posture written down where the rule lives', () => {
    // The row this closes calls the choice a product posture and asks for it to
    // be stated at the site. An undocumented choice nobody can see is
    // indistinguishable from a defect, and "why is this list not filtered?" is
    // exactly the question the next reader arrives with.
    expect(rule).toContain('FOUR REASONS')
    // And the picker points at it, so the reader finds it from the JSX.
    expect(source).toContain('P2.502 — the list is NOT narrowed by the managed allowlist')
  })

  it('no longer writes the judge model without a catch or a rollback', () => {
    // The shipped shape, verbatim: an awaited write with nothing around it.
    expect(source).not.toContain(
      '    await window.electronAPI?.setGuardianModelForConnection(slug, modelId)\n  }, [guardianActiveConnection])'
    )
    expect(source).toContain('setGuardianModels(previous)')
    expect(source).toContain('describeManagedModelRefusal(error, modelId)')
  })

  it('does not narrow either picker with a predicate that cannot work here', () => {
    // The renderer-side filter this posture rejects: `isManagedModelSelectable`
    // imports cleanly and answers `true` for everything in this process, so
    // calling it here would look like a filter and be a no-op.
    //
    // Asserted against the CALL and the IMPORT, not the bare name — the page
    // names the rejected option in prose on purpose, and the first draft of
    // this test failed against its own explanatory comment. A substring check
    // cannot tell a use from a mention.
    expect(source).not.toContain('isManagedModelSelectable(')
    expect(source).not.toMatch(/^import\b.*\bisManagedModelSelectable\b/m)
    // Positive control on the same instrument: a name this page really does
    // call is found by the same shape of check.
    expect(source).toContain('describeManagedModelRefusal(')
  })
})
