/**
 * P2.10 — the managed key that disables the app's own in-app updater.
 *
 * The bridge mirrors `registerManagedSandboxEnabledProvider` /
 * `resolveManagedSandboxEnabledFloor` in `storage.ts`, so this suite mirrors
 * `managed-sandbox-enabled-provider.test.ts`: the provider is a module-scope
 * singleton with no env or CONFIG_DIR dependency, so it runs in-process, and
 * every test resets it in `afterEach` because the singleton is process-wide.
 *
 * The key NAME is pinned as a literal here on purpose. P2.7 writes it from the
 * codex side and this module reads it; a rename that only edits one of the two
 * is exactly the failure the constant exists to prevent, and a test that reads
 * the constant instead of the string would not notice.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import {
  areInAppUpdatesManagedDisabled,
  CODEX_IN_APP_UPDATES_FEATURE_KEY,
  MANAGED_IN_APP_UPDATES_KEY,
  readManagedInAppUpdatesDisabled,
  recordCodexInAppUpdatesRequirement,
  registerManagedInAppUpdatesDisabledProvider,
  resolveManagedInAppUpdatesDisabled,
  resolveManagedInAppUpdatesSource,
  subscribeManagedInAppUpdatesChange,
} from '../managed-in-app-updates.ts'
import type { ManagedInAppUpdatesSourceV1 } from '../managed-in-app-updates.ts'
import type { UpdateInfo } from '../../protocol/dto.ts'

afterEach(() => {
  registerManagedInAppUpdatesDisabledProvider(undefined)
  recordCodexInAppUpdatesRequirement(undefined)
})

describe('the key names', () => {
  it('spells our managed key and codex\'s feature key the way their writers do', () => {
    expect(MANAGED_IN_APP_UPDATES_KEY).toBe('disableInAppUpdates')
    expect(CODEX_IN_APP_UPDATES_FEATURE_KEY).toBe('in_app_updates')
  })
})

describe('readManagedInAppUpdatesDisabled', () => {
  it('reads a literal boolean under the managed key', () => {
    expect(readManagedInAppUpdatesDisabled({ disableInAppUpdates: true })).toBe(true)
    expect(readManagedInAppUpdatesDisabled({ disableInAppUpdates: false })).toBe(false)
  })

  it('is undefined when the key is absent, or the source is', () => {
    expect(readManagedInAppUpdatesDisabled({})).toBeUndefined()
    expect(readManagedInAppUpdatesDisabled({ somethingElse: true })).toBeUndefined()
    expect(readManagedInAppUpdatesDisabled(null)).toBeUndefined()
    expect(readManagedInAppUpdatesDisabled(undefined)).toBeUndefined()
  })

  it('decides nothing on a non-boolean value — a malformed policy neither disables nor enables', () => {
    expect(readManagedInAppUpdatesDisabled({ disableInAppUpdates: 'true' })).toBeUndefined()
    expect(readManagedInAppUpdatesDisabled({ disableInAppUpdates: 1 })).toBeUndefined()
    expect(readManagedInAppUpdatesDisabled({ disableInAppUpdates: null })).toBeUndefined()
  })
})

describe('the provider bridge', () => {
  it('is undefined, and updates are NOT disabled, when nothing is registered', () => {
    expect(resolveManagedInAppUpdatesDisabled()).toBeUndefined()
    expect(areInAppUpdatesManagedDisabled()).toBe(false)
  })

  it('passes a registered boolean through', () => {
    registerManagedInAppUpdatesDisabledProvider(() => true)
    expect(resolveManagedInAppUpdatesDisabled()).toBe(true)
    expect(areInAppUpdatesManagedDisabled()).toBe(true)

    registerManagedInAppUpdatesDisabledProvider(() => false)
    expect(resolveManagedInAppUpdatesDisabled()).toBe(false)
    expect(areInAppUpdatesManagedDisabled()).toBe(false)
  })

  it('is undefined when the registered provider itself returns undefined', () => {
    registerManagedInAppUpdatesDisabledProvider(() => undefined)
    expect(resolveManagedInAppUpdatesDisabled()).toBeUndefined()
    expect(areInAppUpdatesManagedDisabled()).toBe(false)
  })

  it('tolerates a throwing provider — updates keep working, no thrown error on the update path', () => {
    registerManagedInAppUpdatesDisabledProvider(() => {
      throw new Error('policy file unreadable')
    })
    expect(resolveManagedInAppUpdatesDisabled()).toBeUndefined()
    expect(areInAppUpdatesManagedDisabled()).toBe(false)
  })

  it('re-registering with undefined restores "no managed value"', () => {
    registerManagedInAppUpdatesDisabledProvider(() => true)
    expect(areInAppUpdatesManagedDisabled()).toBe(true)
    registerManagedInAppUpdatesDisabledProvider(undefined)
    expect(areInAppUpdatesManagedDisabled()).toBe(false)
  })

  it('composes with the record reader — the shape P2.7 will register', () => {
    const requirements: Record<string, unknown> = { disableInAppUpdates: true }
    registerManagedInAppUpdatesDisabledProvider(() => readManagedInAppUpdatesDisabled(requirements))
    expect(areInAppUpdatesManagedDisabled()).toBe(true)
  })
})

describe('the codex tier (P2.7)', () => {
  it('disables on its own, with no host provider registered', () => {
    // The codex app-server reported `[features] in_app_updates = false`. Nothing
    // on this machine carries a `managed-policy.json`, and the gate still holds.
    recordCodexInAppUpdatesRequirement(true)
    expect(resolveManagedInAppUpdatesDisabled()).toBe(true)
    expect(areInAppUpdatesManagedDisabled()).toBe(true)
  })

  it('TIGHTEST WINS — a codex disable survives a host tier that permits', () => {
    // The failure this composition exists to prevent: one slot, last writer
    // wins, and a codex session start quietly re-enables updates an MDM policy
    // turned off (or the reverse).
    registerManagedInAppUpdatesDisabledProvider(() => false)
    recordCodexInAppUpdatesRequirement(true)
    expect(areInAppUpdatesManagedDisabled()).toBe(true)

    registerManagedInAppUpdatesDisabledProvider(() => true)
    recordCodexInAppUpdatesRequirement(false)
    expect(areInAppUpdatesManagedDisabled()).toBe(true)
  })

  it('clearing the codex tier hands the answer back to the host tier', () => {
    registerManagedInAppUpdatesDisabledProvider(() => false)
    recordCodexInAppUpdatesRequirement(true)
    expect(areInAppUpdatesManagedDisabled()).toBe(true)
    recordCodexInAppUpdatesRequirement(undefined)
    expect(resolveManagedInAppUpdatesDisabled()).toBe(false)
  })

  it('a non-boolean clears the tier rather than deciding something', () => {
    recordCodexInAppUpdatesRequirement(true)
    recordCodexInAppUpdatesRequirement(undefined)
    expect(resolveManagedInAppUpdatesDisabled()).toBeUndefined()
  })
})

describe('the registrars notify subscribers (P2.7 clause (b))', () => {
  it('fires on a host registration, on a de-registration, and on a codex report', () => {
    const seen: boolean[] = []
    const unsubscribe = subscribeManagedInAppUpdatesChange(() => {
      seen.push(areInAppUpdatesManagedDisabled())
    })
    try {
      registerManagedInAppUpdatesDisabledProvider(() => true)
      recordCodexInAppUpdatesRequirement(true)
      registerManagedInAppUpdatesDisabledProvider(undefined)
      recordCodexInAppUpdatesRequirement(undefined)
    } finally {
      unsubscribe()
    }
    // Four writes, four notifications, each one carrying the state AFTER the
    // write — a listener that has to guess when to re-read guesses wrong.
    expect(seen).toEqual([true, true, true, false])
  })

  it('does not fire when the codex tier repeats an answer it already gave', () => {
    // Every codex runtime start reports the same requirement; a broadcast per
    // spawn would be noise on the renderer channel.
    let calls = 0
    const unsubscribe = subscribeManagedInAppUpdatesChange(() => { calls += 1 })
    try {
      recordCodexInAppUpdatesRequirement(true)
      recordCodexInAppUpdatesRequirement(true)
      recordCodexInAppUpdatesRequirement(true)
    } finally {
      unsubscribe()
    }
    expect(calls).toBe(1)
  })

  it('a throwing listener does not take the policy write down', () => {
    const unsubscribeBad = subscribeManagedInAppUpdatesChange(() => {
      throw new Error('renderer window destroyed')
    })
    let good = 0
    const unsubscribeGood = subscribeManagedInAppUpdatesChange(() => { good += 1 })
    try {
      expect(() => registerManagedInAppUpdatesDisabledProvider(() => true)).not.toThrow()
      expect(areInAppUpdatesManagedDisabled()).toBe(true)
      expect(good).toBe(1)
    } finally {
      unsubscribeBad()
      unsubscribeGood()
    }
  })

  it('an unsubscribed listener stops hearing', () => {
    let calls = 0
    subscribeManagedInAppUpdatesChange(() => { calls += 1 })()
    registerManagedInAppUpdatesDisabledProvider(() => true)
    expect(calls).toBe(0)
  })
})

/**
 * P3.240 — WHICH tier disabled updates, so the Settings indicator can say whose
 * decision it was.
 *
 * The invariant that makes the field safe to render: the source and the
 * predicate can never disagree. Every case below asserts both together, because
 * a source that named a document while updates were allowed would put a managed
 * sentence under an unmanaged card.
 */
describe('the managed source (P3.240)', () => {
  it('names nothing while nothing disables', () => {
    expect(resolveManagedInAppUpdatesSource()).toBeUndefined()
    registerManagedInAppUpdatesDisabledProvider(() => false)
    recordCodexInAppUpdatesRequirement(false)
    // BOTH tiers answered, and both said updates are allowed. An opinion is not
    // a reason, so there is still no document to name.
    expect(resolveManagedInAppUpdatesDisabled()).toBe(false)
    expect(resolveManagedInAppUpdatesSource()).toBeUndefined()
  })

  it('names the host tier when the host policy is the reason', () => {
    registerManagedInAppUpdatesDisabledProvider(() => true)
    expect(areInAppUpdatesManagedDisabled()).toBe(true)
    expect(resolveManagedInAppUpdatesSource()).toBe('host')
  })

  it('names the codex tier when a requirements.toml is the reason', () => {
    recordCodexInAppUpdatesRequirement(true)
    expect(areInAppUpdatesManagedDisabled()).toBe(true)
    expect(resolveManagedInAppUpdatesSource()).toBe('codex')
  })

  it('names both when both require it', () => {
    registerManagedInAppUpdatesDisabledProvider(() => true)
    recordCodexInAppUpdatesRequirement(true)
    expect(resolveManagedInAppUpdatesSource()).toBe('both')
  })

  it('names only the tier that DISABLED, not the one that merely answered', () => {
    // The composition is tightest-wins, so a tier saying `false` is outvoted —
    // and naming it as the source would send an operator to the wrong document.
    registerManagedInAppUpdatesDisabledProvider(() => false)
    recordCodexInAppUpdatesRequirement(true)
    expect(resolveManagedInAppUpdatesSource()).toBe('codex')

    registerManagedInAppUpdatesDisabledProvider(() => true)
    recordCodexInAppUpdatesRequirement(false)
    expect(resolveManagedInAppUpdatesSource()).toBe('host')
  })

  it('survives a throwing host provider the way the predicate does', () => {
    // `resolveManagedInAppUpdatesDisabled` tolerates one because an unreadable
    // policy file must not take the app down on the update path; a second reader
    // that threw would reintroduce exactly that.
    registerManagedInAppUpdatesDisabledProvider(() => { throw new Error('unreadable policy') })
    recordCodexInAppUpdatesRequirement(true)
    expect(resolveManagedInAppUpdatesSource()).toBe('codex')
  })

  it('follows the tiers as they change mid-session', () => {
    // The codex tier arms when the first codex runtime starts — long after the
    // settings page rendered — so the source has to move with it.
    registerManagedInAppUpdatesDisabledProvider(() => true)
    expect(resolveManagedInAppUpdatesSource()).toBe('host')
    recordCodexInAppUpdatesRequirement(true)
    expect(resolveManagedInAppUpdatesSource()).toBe('both')
    registerManagedInAppUpdatesDisabledProvider(undefined)
    expect(resolveManagedInAppUpdatesSource()).toBe('codex')
    recordCodexInAppUpdatesRequirement(undefined)
    expect(resolveManagedInAppUpdatesSource()).toBeUndefined()
    expect(areInAppUpdatesManagedDisabled()).toBe(false)
  })
})

/**
 * P3.240 — the wire spelling and the resolver's spelling are the same three
 * strings, and `dto.ts` cannot import this module to say so.
 *
 * `dto.ts` is the wire contract and deliberately carries no imports from the
 * modules it describes, so the union is written out there by hand. This is the
 * pin its docblock promises: a value added to
 * {@link ManagedInAppUpdatesSourceV1} without being added to
 * `UpdateInfo['managedSource']` — or the reverse — stops compiling here, which
 * is the whole failure mode of a type spelled in two places. Checked by
 * `packages/shared`'s own `tsc --noEmit`; the assignments are unreachable at
 * runtime and the assertion is the compile.
 */
describe('the wire type and the resolver agree on the source names', () => {
  it('assigns in both directions', () => {
    const toWire = (source: ManagedInAppUpdatesSourceV1): UpdateInfo['managedSource'] => source
    const fromWire = (source: NonNullable<UpdateInfo['managedSource']>): ManagedInAppUpdatesSourceV1 => source
    expect(toWire('codex')).toBe('codex')
    expect(fromWire('both')).toBe('both')
  })
})
