/**
 * P6.821 — THE CEILINGS ARE DISCLOSED, AND THE NOTICES POINT AT THE DISCLOSURE
 * INSTEAD OF ASKING FOR SOMETHING IMPOSSIBLE.
 *
 * Neither budget ceiling can be set from this app: `maxBudgetTokens` and
 * `maxBudgetUsd` are `workspaceDefaults` fields of `config-defaults.json`, which
 * `syncConfigDefaults` rewrites from the bundle on every launch. Two chat
 * notices ended with *set a token limit (`maxBudgetTokens`)* anyway, and
 * `SessionManager`'s `maxBudgetUsdReached` latch rested on *ask the user to
 * raise the limit* being followable. The owner's ruling (2026-09-10, balance
 * rule) was (a) disclose both effective ceilings and (c) reword the notices to
 * name the tier as operator-owned; (b), a user-settable ceiling, was refused.
 *
 * Both halves are pinned here because they are one promise: the notices now
 * send the reader to a row, and a row that stopped existing would leave them
 * pointing at nothing.
 *
 * SOURCE MATCH, for the reason the sibling `advisor-settings-surface.test.ts`
 * gives and `workspace-default-mode.test.ts` repeats: `bun test` has no DOM
 * here, `WorkspaceSettingsPage` needs the app-shell context, `window.electronAPI`
 * and the router to mount, and no unit test in this tree mounts it. What must be
 * true is that the payload field is READ and the row is WIRED — which is exactly
 * what a source assertion can see.
 *
 * MUTATION PROBES (2026-09-10):
 *  - drop `setBudgetCeilings(settings.budgetCeilings)` from the load → the
 *    consumption case goes red;
 *  - render the row unguarded → the absence case goes red on `budgetCeilings &&`;
 *  - show the raw `0` instead of the "no limit" wording → the zero case goes red;
 *  - revert either notice to "set a token limit" → the notice case goes red.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import en from '@nessy-agent/shared/i18n/locales/en.json'
import ru from '@nessy-agent/shared/i18n/locales/ru.json'

const source = readFileSync(
  fileURLToPath(new URL('../WorkspaceSettingsPage.tsx', import.meta.url)),
  'utf8',
)

const DISCLOSURE_KEYS = [
  'settings.workspace.budgetCeilings',
  'settings.workspace.budgetCeilingsDesc',
  'settings.workspace.budgetCeilingsNone',
] as const

const NOTICE_KEYS = ['chat.budget.notMetered', 'chat.budget.unenforceable'] as const

describe('P6.821 · the workspace page discloses both budget ceilings', () => {
  it('reads the payload field and renders a row for it', () => {
    // The wire half is pinned in server-core; this is the consumer half, and
    // before this row the field had no reader at all.
    expect(source).toContain('setBudgetCeilings(settings.budgetCeilings)')
    for (const key of DISCLOSURE_KEYS) {
      expect(source, key).toContain(key)
    }
  })

  /**
   * ABSENCE IS NOT "OFF", and the direction is the whole point. An older host
   * sends no `budgetCeilings` at all; rendering that as two zeroes would tell
   * the user there is no limit on a build that simply cannot say. The row is
   * therefore guarded and disappears instead.
   */
  it('hides the row when the host cannot answer, rather than claiming no limit', () => {
    expect(source).toContain('{budgetCeilings && (')
  })

  /**
   * `0` is the documented "no ceiling" on both fields (`config-defaults-schema.ts`
   * — "0 disables the guard"), so it must reach the user as words. A bare `0`
   * beside "Tokens" reads as a limit of zero, which is the opposite claim.
   */
  it('shows 0 as the no-limit wording on BOTH ceilings, never as a digit', () => {
    for (const field of ['maxBudgetTokens', 'maxBudgetUsd'] as const) {
      expect(source, field).toContain(`budgetCeilings.${field} > 0`)
    }
    // TWICE — once per ceiling. A single occurrence means one of them still
    // renders its zero, which is the half-fix a rewrite of this block produces.
    expect(source.split('settings.workspace.budgetCeilingsNone').length - 1).toBe(2)
  })

  it('names the tier as operator-owned in both locales', () => {
    for (const key of DISCLOSURE_KEYS) {
      expect((en as Record<string, string>)[key], key).toBeDefined()
      expect((ru as Record<string, string>)[key], key).toBeDefined()
    }
    // Asserted on the CLAIM rather than on a phrase a translator may rewrite:
    // the description must still carry both interpolations, because a wording
    // that dropped one would disclose half the answer.
    for (const locale of [en, ru] as Array<Record<string, string>>) {
      expect(locale['settings.workspace.budgetCeilingsDesc']).toContain('{{tokens}}')
      expect(locale['settings.workspace.budgetCeilingsDesc']).toContain('{{usd}}')
    }
    expect((en as Record<string, string>)['settings.workspace.budgetCeilingsDesc'])
      .toContain('operator-owned')
  })
})

describe('P6.821 clause (c) · the two notices stopped asking for a limit the user cannot set', () => {
  /**
   * The instructive half stays instructive — that was P2.130's point and
   * `base-agent.ts` still quotes it — but it now instructs something a user can
   * actually do. What it must NOT do is issue the imperative: the token ceiling
   * is an operator's field, and telling a user to set it is the defect this
   * clause closes.
   */
  it('neither notice tells the user to set the token limit any more', () => {
    for (const key of NOTICE_KEYS) {
      expect((en as Record<string, string>)[key], key).not.toContain('set a token limit')
      expect((ru as Record<string, string>)[key], key).not.toContain('задайте лимит токенов')
    }
  })

  it('both name the setting as operator-owned and point at the disclosure', () => {
    for (const key of NOTICE_KEYS) {
      const english = (en as Record<string, string>)[key]
      // The identifier survives — it is what makes the sentence actionable for
      // the operator who reads it over the user's shoulder, and
      // `base-agent-budget-i18n.test.ts` pins it in both locales.
      expect(english, key).toContain('maxBudgetTokens')
      expect(english, key).toContain('operator-owned')
      expect(english, key).toContain('Workspace Settings')
      expect((ru as Record<string, string>)[key], key).toContain('maxBudgetTokens')
    }
  })

  /**
   * THE TWO CONTROLS THAT MUST SURVIVE THE REWORD, both of them pinned
   * elsewhere and both easy to lose in a rewrite of these very sentences:
   * `base-agent-budget-price-basis.test.ts` matches "cannot be enforced"
   * lower-cased, and `base-agent-budget-i18n.test.ts` matches the dollar route
   * verbatim — the ONLY way to a limit in dollars, which adding the disclosure
   * must not have replaced.
   */
  it('keeps the two clauses its sibling suites match on', () => {
    for (const key of NOTICE_KEYS) {
      const english = (en as Record<string, string>)[key]
      expect(english.toLowerCase(), key).toContain('cannot be enforced')
      expect(english, key).toContain('switch to a connection that reports cost')
      expect((en as Record<string, string>)[key], key).toContain('{{limit}}')
      expect((ru as Record<string, string>)[key], key).toContain('{{limit}}')
    }
  })
})
