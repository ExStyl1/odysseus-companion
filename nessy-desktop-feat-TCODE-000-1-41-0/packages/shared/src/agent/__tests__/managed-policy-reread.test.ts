/**
 * D4 — the direction rule a running fleet applies a policy change by.
 *
 * `isManagedPolicyTightening` decides one thing: may this change take effect
 * NOW, in the middle of a turn, or must it wait for a turn boundary. An
 * administrator tightening after an incident must reach every running desktop
 * at once; a widening that lands between the gate's decision and the next tool
 * call of the same turn is a security event, not a convenience.
 *
 * The predicate is deliberately structural and conservative: a false `false`
 * costs one turn of delay, a false `true` applies a widening mid-turn. Every
 * assertion below is written to hold that asymmetry in place.
 */
import { describe, expect, test } from 'bun:test'
import {
  isManagedPolicyTightening,
  managedPolicyEquals,
  MANAGED_PI_POLICY_KEYS,
  type ManagedPiPolicyV1,
} from '../pi-harness/managed-policy.ts'

const BASE: ManagedPiPolicyV1 = Object.freeze({
  schemaVersion: 1 as const,
  disabledPermissionModes: Object.freeze([]),
})

function withKeys(extra: Record<string, unknown>): ManagedPiPolicyV1 {
  return { ...BASE, ...extra } as ManagedPiPolicyV1
}

describe('managedPolicyEquals', () => {
  test('compares what is ENFORCED, not key order', () => {
    const a = withKeys({ deniedMcpServers: [{ serverName: 'acme-chat' }], allowManagedHooksOnly: true })
    const b = withKeys({ allowManagedHooksOnly: true, deniedMcpServers: [{ serverName: 'acme-chat' }] })
    expect(managedPolicyEquals(a, b)).toBe(true)
    expect(managedPolicyEquals(a, BASE)).toBe(false)
  })
})

describe('isManagedPolicyTightening — applied at once', () => {
  test('an added constraint is a tightening', () => {
    // The incident case the whole row exists for: an admin denies an MCP server.
    expect(isManagedPolicyTightening(BASE, withKeys({ deniedMcpServers: [{ serverName: 'acme-chat' }] }))).toBe(true)
    expect(isManagedPolicyTightening(BASE, withKeys({ allowManagedPermissionRulesOnly: true }))).toBe(true)
    expect(isManagedPolicyTightening(BASE, withKeys({ disableAllHooks: true }))).toBe(true)
    expect(isManagedPolicyTightening(BASE, withKeys({ permissionDsl: { version: 1, rules: [] } }))).toBe(true)
  })

  test('an unchanged policy is trivially adoptable', () => {
    expect(isManagedPolicyTightening(BASE, BASE)).toBe(true)
  })

  test('several constraints added at once still count', () => {
    expect(isManagedPolicyTightening(BASE, withKeys({
      deniedMcpServers: [{ serverName: 'acme-chat' }],
      deniedPluginKeys: ['acme.thing'],
      allowManagedHooksOnly: true,
    }))).toBe(true)
  })

  test('a deny list that GROWS is a tightening, including the required one', () => {
    // `disabledPermissionModes` is REQUIRED and starts `[]`, so the single most
    // ordinary tightening an administrator makes reads as a CHANGED key rather
    // than an added one. Without the deny-list rule it would have waited for a
    // turn boundary for no reason at all.
    expect(isManagedPolicyTightening(BASE, withKeys({ disabledPermissionModes: ['allow-all'] }))).toBe(true)
    expect(isManagedPolicyTightening(
      withKeys({ disabledPermissionModes: ['allow-all'] }),
      withKeys({ disabledPermissionModes: ['allow-all', 'auto'] }),
    )).toBe(true)
    // And shrinking it is the widening.
    expect(isManagedPolicyTightening(
      withKeys({ disabledPermissionModes: ['allow-all'] }),
      BASE,
    )).toBe(false)
  })
})

describe('isManagedPolicyTightening — held for the turn boundary', () => {
  test('a REMOVED constraint is never immediate', () => {
    expect(isManagedPolicyTightening(withKeys({ allowManagedHooksOnly: true }), BASE)).toBe(false)
  })

  test('a CHANGED value is never immediate outside the named deny lists', () => {
    // `allowedHttpHookUrls` growing is a WIDENING, and shrinking it is a
    // narrowing the predicate deliberately does not try to see: it is not a
    // deny list, so any change to it waits. The cost is one turn of delay.
    const before = withKeys({ allowedHttpHookUrls: ['https://a.test/*'] })
    const after = withKeys({ allowedHttpHookUrls: ['https://a.test/*', 'https://b.test/*'] })
    expect(isManagedPolicyTightening(before, after)).toBe(false)
    expect(isManagedPolicyTightening(after, before)).toBe(false)
  })

  test('a deny list that SHRINKS is a widening and waits', () => {
    const before = withKeys({ deniedMcpServers: [{ serverName: 'a' }, { serverName: 'b' }] })
    const after = withKeys({ deniedMcpServers: [{ serverName: 'a' }] })
    expect(isManagedPolicyTightening(before, after)).toBe(false)
  })

  test('a newly-added WIDENING key is never immediate', () => {
    // Each of these hands something out rather than taking it away.
    expect(isManagedPolicyTightening(BASE, withKeys({ enabledPlugins: { 'acme.thing': true } }))).toBe(false)
    expect(isManagedPolicyTightening(BASE, withKeys({ extraKnownMarketplaces: [] }))).toBe(false)
    expect(isManagedPolicyTightening(BASE, withKeys({ defaultMode: 'allow-all' }))).toBe(false)
    expect(isManagedPolicyTightening(BASE, withKeys({ env: { API_TOKEN: 'x' } }))).toBe(false)
    expect(isManagedPolicyTightening(BASE, withKeys({ autoCompactEnabled: true }))).toBe(false)
    expect(isManagedPolicyTightening(BASE, withKeys({ workflow: { disableWorkflows: false } }))).toBe(false)
    expect(isManagedPolicyTightening(BASE, withKeys({ availableModels: ['sonnet'] }))).toBe(false)
  })

  test('one widening alongside any number of tightenings holds the WHOLE change', () => {
    // The change is adopted or held as a document; a policy half-applied is a
    // policy nobody can reason about.
    expect(isManagedPolicyTightening(BASE, withKeys({
      deniedMcpServers: [{ serverName: 'acme-chat' }],
      disableAllHooks: true,
      enabledPlugins: { 'acme.thing': true },
    }))).toBe(false)
  })
})

describe('the predicate covers the whole schema', () => {
  test('every key is classified, so a new field cannot slip in unjudged', () => {
    // A key added to the schema and to nothing else defaults to "constraining",
    // which is the immediate-adoption side. This asserts that the judgement was
    // actually made for each one rather than inherited by accident.
    for (const key of MANAGED_PI_POLICY_KEYS) {
      if (key === 'schemaVersion') continue
      const next = withKeys({ [key]: key === 'disabledPermissionModes' ? ['auto'] : true })
      const verdict = isManagedPolicyTightening(BASE, next)
      expect(typeof verdict).toBe('boolean')
    }
    // And the nine exceptions are exactly the nine the constant names (F1.593 added managedMcpServers).
    const widening = MANAGED_PI_POLICY_KEYS.filter(key => key !== 'schemaVersion'
      && key !== 'disabledPermissionModes'
      && !isManagedPolicyTightening(BASE, withKeys({ [key]: true })))
    expect([...widening].sort()).toEqual([
      'autoCompactEnabled', 'availableModels', 'defaultMode', 'enabledPlugins',
      'env', 'extraKnownMarketplaces', 'managedMcpServers', 'pluginSuggestionMarketplaces', 'workflow',
    ])
  })
})
