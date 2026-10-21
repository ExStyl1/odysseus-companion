/**
 * P2.399/P2.463 — the managed key that disables the app's own built-in browser.
 *
 * Mirrors `managed-in-app-updates.test.ts`, because the module mirrors its twin:
 * the two tiers are module-scope singletons with no env or CONFIG_DIR
 * dependency, so this runs in-process, and every test resets both tiers in
 * `afterEach` because the singletons are process-wide.
 *
 * The key NAME is pinned as a literal on purpose. `ManagedPiPolicyV1` writes it
 * and this module reads it; a rename that edits only one of the two is exactly
 * the failure the constant exists to prevent, and a test reading the constant
 * instead of the string would not notice.
 *
 * What this suite tests is the codex tier's BEHAVIOUR, not its writer. That was
 * true when P2.399 landed the tier with no caller at all, and it is still the
 * right boundary now that P2.463 has bound it: the caller is
 * `agent/codex-agent.ts`'s spawn path, which needs a real app-server and an
 * adapter port, so the CALL is pinned by source shape in
 * `agent/__tests__/codex-config-requirements.test.ts` and the CONTRACT is pinned
 * here.
 *
 * One case below is the reason that split matters. `a non-boolean clears the tier
 * rather than deciding something` is a statement about this registrar and stays
 * verbatim — but the caller must never USE it that way, because the reading is
 * `undefined` for a failed probe exactly as it is for "no requirement deployed".
 * That guard is the caller's, and it is pinned where the caller is. P2.137
 * measured the same split on the twin, and the registrar's contract was never
 * the defect there either.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import {
  describeManagedInAppBrowserRefusal,
  isInAppBrowserManagedDisabled,
  MANAGED_IN_APP_BROWSER_KEY,
  recordCodexInAppBrowserRequirement,
  registerManagedInAppBrowserDisabledProvider,
  resolveManagedInAppBrowserDisabled,
  resolveManagedInAppBrowserSource,
  subscribeManagedInAppBrowserChange,
} from '../managed-in-app-browser.ts'

afterEach(() => {
  registerManagedInAppBrowserDisabledProvider(undefined)
  recordCodexInAppBrowserRequirement(undefined)
})

describe('the key name', () => {
  it('spells the host-policy key the way `ManagedPiPolicyV1` writes it', () => {
    expect(MANAGED_IN_APP_BROWSER_KEY).toBe('disableInAppBrowser')
  })
})

describe('the provider bridge (the HOST tier)', () => {
  it('is undefined, and the browser is NOT disabled, when nothing is registered', () => {
    expect(resolveManagedInAppBrowserDisabled()).toBeUndefined()
    expect(isInAppBrowserManagedDisabled()).toBe(false)
  })

  it('passes a registered boolean through', () => {
    registerManagedInAppBrowserDisabledProvider(() => true)
    expect(resolveManagedInAppBrowserDisabled()).toBe(true)
    expect(isInAppBrowserManagedDisabled()).toBe(true)

    registerManagedInAppBrowserDisabledProvider(() => false)
    expect(resolveManagedInAppBrowserDisabled()).toBe(false)
    expect(isInAppBrowserManagedDisabled()).toBe(false)
  })

  it('tolerates a throwing provider — the browser keeps working rather than the app throwing', () => {
    registerManagedInAppBrowserDisabledProvider(() => { throw new Error('unreadable policy file') })
    expect(resolveManagedInAppBrowserDisabled()).toBeUndefined()
    expect(isInAppBrowserManagedDisabled()).toBe(false)
    expect(resolveManagedInAppBrowserSource()).toBeUndefined()
  })

  it('decides nothing on a non-boolean — a malformed policy neither disables nor enables', () => {
    registerManagedInAppBrowserDisabledProvider(() => 'true' as unknown as boolean)
    expect(resolveManagedInAppBrowserDisabled()).toBeUndefined()
    expect(isInAppBrowserManagedDisabled()).toBe(false)
  })
})

describe('the codex tier — armed by P2.399, fed by P2.463', () => {
  it('disables on its own, with no host provider registered', () => {
    recordCodexInAppBrowserRequirement(true)
    expect(isInAppBrowserManagedDisabled()).toBe(true)
    expect(resolveManagedInAppBrowserSource()).toBe('codex')
  })

  it('TIGHTEST WINS — a codex disable survives a host tier that permits', () => {
    registerManagedInAppBrowserDisabledProvider(() => false)
    recordCodexInAppBrowserRequirement(true)
    expect(resolveManagedInAppBrowserDisabled()).toBe(true)
    expect(resolveManagedInAppBrowserSource()).toBe('codex')
  })

  it('TIGHTEST WINS the other way — a host disable survives a codex tier that permits', () => {
    registerManagedInAppBrowserDisabledProvider(() => true)
    recordCodexInAppBrowserRequirement(false)
    expect(resolveManagedInAppBrowserDisabled()).toBe(true)
    expect(resolveManagedInAppBrowserSource()).toBe('host')
  })

  it('clearing the codex tier hands the answer back to the host tier', () => {
    registerManagedInAppBrowserDisabledProvider(() => false)
    recordCodexInAppBrowserRequirement(true)
    expect(resolveManagedInAppBrowserDisabled()).toBe(true)
    recordCodexInAppBrowserRequirement(undefined)
    expect(resolveManagedInAppBrowserDisabled()).toBe(false)
  })

  it('a non-boolean clears the tier rather than deciding something', () => {
    recordCodexInAppBrowserRequirement(true)
    recordCodexInAppBrowserRequirement('yes' as unknown as boolean)
    expect(resolveManagedInAppBrowserDisabled()).toBeUndefined()
  })
})

describe('the registrars notify subscribers', () => {
  it('fires on a host registration, on a de-registration, and on a codex report', () => {
    const seen: string[] = []
    const off = subscribeManagedInAppBrowserChange(() => { seen.push('fired') })
    registerManagedInAppBrowserDisabledProvider(() => true)
    registerManagedInAppBrowserDisabledProvider(undefined)
    recordCodexInAppBrowserRequirement(true)
    off()
    expect(seen).toHaveLength(3)
  })

  it('does not fire when the codex tier repeats an answer it already gave', () => {
    recordCodexInAppBrowserRequirement(true)
    let fired = 0
    const off = subscribeManagedInAppBrowserChange(() => { fired += 1 })
    recordCodexInAppBrowserRequirement(true)
    off()
    expect(fired).toBe(0)
  })

  it('a throwing listener does not take the policy write down', () => {
    const off1 = subscribeManagedInAppBrowserChange(() => { throw new Error('broken subscriber') })
    let reached = false
    const off2 = subscribeManagedInAppBrowserChange(() => { reached = true })
    expect(() => registerManagedInAppBrowserDisabledProvider(() => true)).not.toThrow()
    off1()
    off2()
    expect(reached).toBe(true)
    expect(isInAppBrowserManagedDisabled()).toBe(true)
  })

  it('an unsubscribed listener stops hearing', () => {
    let fired = 0
    const off = subscribeManagedInAppBrowserChange(() => { fired += 1 })
    off()
    registerManagedInAppBrowserDisabledProvider(() => true)
    expect(fired).toBe(0)
  })
})

describe('the managed source', () => {
  it('names nothing while nothing disables', () => {
    expect(resolveManagedInAppBrowserSource()).toBeUndefined()
    registerManagedInAppBrowserDisabledProvider(() => false)
    recordCodexInAppBrowserRequirement(false)
    expect(resolveManagedInAppBrowserSource()).toBeUndefined()
  })

  it('names both when both require it', () => {
    registerManagedInAppBrowserDisabledProvider(() => true)
    recordCodexInAppBrowserRequirement(true)
    expect(resolveManagedInAppBrowserSource()).toBe('both')
  })

  it('can never name a tier while the predicate says the browser is allowed', () => {
    for (const [host, codex] of [
      [undefined, undefined],
      [false, undefined],
      [undefined, false],
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ] as const) {
      registerManagedInAppBrowserDisabledProvider(host === undefined ? undefined : () => host)
      recordCodexInAppBrowserRequirement(codex)
      const named = resolveManagedInAppBrowserSource() !== undefined
      expect({ host, codex, named, disabled: isInAppBrowserManagedDisabled() })
        .toEqual({ host, codex, named, disabled: named })
    }
  })
})

describe('the refusal sentence', () => {
  it('names the codex document when a requirements.toml is the reason', () => {
    recordCodexInAppBrowserRequirement(true)
    const message = describeManagedInAppBrowserRefusal()
    expect(message).toContain('in_app_browser = false')
    expect(message).toContain('requirements.toml')
  })

  it('names the host document when the managed policy is the reason', () => {
    registerManagedInAppBrowserDisabledProvider(() => true)
    const message = describeManagedInAppBrowserRefusal()
    expect(message).toContain(MANAGED_IN_APP_BROWSER_KEY)
    expect(message).not.toContain('requirements.toml')
  })

  it('names both documents when both require it', () => {
    registerManagedInAppBrowserDisabledProvider(() => true)
    recordCodexInAppBrowserRequirement(true)
    expect(describeManagedInAppBrowserRefusal()).toContain('AND')
  })

  it('always says who can change it, so the sentence is actionable and not a dead end', () => {
    registerManagedInAppBrowserDisabledProvider(() => true)
    expect(describeManagedInAppBrowserRefusal()).toContain('manages this install')
  })
})
