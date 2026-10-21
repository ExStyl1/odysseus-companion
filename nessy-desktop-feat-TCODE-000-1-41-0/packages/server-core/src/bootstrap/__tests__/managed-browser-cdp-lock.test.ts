/**
 * P6.765 — the P6.536 CDP lock was ARMED AND UNFED.
 *
 * `config/managed-in-app-browser.ts` shipped `registerManagedBrowserCdpDisabledProvider`
 * and `isBrowserCdpManagedDisabled`, and its own docblock states the
 * requirement verbatim: *"an administrator can lock CDP off SEPARATELY from the
 * pane"*. Measured at HEAD before this row: the provider had **no production
 * caller** (four hits, the definition plus one main-process test) and
 * `MANAGED_PI_POLICY_KEYS` carried no CDP key at all. So the gate existed, the
 * predicate existed, and no administrator could turn either of them on — every
 * operator who wrote the obvious key got nothing, silently.
 *
 * This file is the wiring test, which is the only kind that can catch that
 * shape: a parse test proves the KEY reads, and a gate test proves the
 * PREDICATE refuses, and both were already green while the two halves were not
 * connected to each other.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import {
  isBrowserCdpManagedDisabled,
  registerManagedBrowserCdpDisabledProvider,
} from '@nessy-agent/shared/config/managed-in-app-browser'
import {
  DEFAULT_MANAGED_PI_POLICY,
  type ManagedPiPolicyV1,
} from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import { registerEnforcedManagedInAppBrowserProvider } from '../managed-policy-resolution'

const policy = (overrides: Partial<ManagedPiPolicyV1>): ManagedPiPolicyV1 =>
  Object.freeze({ ...DEFAULT_MANAGED_PI_POLICY, ...overrides })

function arm(file: ManagedPiPolicyV1): void {
  registerEnforcedManagedInAppBrowserProvider({
    file: () => ({ policy: file, drops: [] }),
    delivered: () => undefined,
  })
}

afterEach(() => {
  // The providers are module-scope singletons, so a leaked one would decide the
  // next file's verdict — the module-scope-mutation class this repo's register
  // already documents.
  registerManagedBrowserCdpDisabledProvider(undefined)
})

describe('P6.765 — the managed CDP lock reaches its gate', () => {
  it('POSITIVE: an administrator setting the key refuses the debugger', () => {
    arm(policy({ disableBrowserCdp: true }))
    expect(isBrowserCdpManagedDisabled()).toBe(true)
  })

  it('NEGATIVE: a policy that says nothing about CDP leaves it permitted', () => {
    // And this is the arm that would have caught the defect: before the
    // registration existed, BOTH cases returned false, so only the positive
    // separates a fed gate from an unfed one.
    arm(policy({}))
    expect(isBrowserCdpManagedDisabled()).toBe(false)

    // An explicit `false` is the same path as an unmanaged install, matching
    // every sibling in this family — only `true` disables.
    arm(policy({ disableBrowserCdp: false }))
    expect(isBrowserCdpManagedDisabled()).toBe(false)
  })

  it('the pane switch and the CDP lock are SEPARATE, which is the row P6.536 asked for', () => {
    // Turning the whole browser off must not be the only way to stop a debugger
    // attaching, and locking CDP must not take the browser away. The pane
    // switch still dominates in effect — the attach gate runs inside a pane, so
    // a forbidden pane never opens — but that is enforced by construction and
    // not by either predicate answering for the other.
    arm(policy({ disableInAppBrowser: true }))
    expect(isBrowserCdpManagedDisabled()).toBe(false)

    arm(policy({ disableBrowserCdp: true, disableInAppBrowser: false }))
    expect(isBrowserCdpManagedDisabled()).toBe(true)
  })
})
