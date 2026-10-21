/**
 * P6.251 — the two managed-loader contracts the CLOSED_AT_HEAD promotions B37
 * and B38 rest on, pinned KEY BY KEY against the page rather than end-to-end.
 *
 * Both were already covered by behaviour tests that assert the whole outcome.
 * That is exactly what this file is not: an end-to-end assertion goes red for
 * any of a dozen reasons and names none of them, so a change to ONE combination
 * rule, or a drift in ONE fail-closed cell, was indistinguishable from a
 * refactor. Each rule and each key gets its own case here, so the red test says
 * which sentence of which page stopped being true.
 *
 * **This file is a check a Claude-docs corpus refresh re-runs.** Both tables
 * below are transcribed from a page that has already split once
 * (`settings.md` → `settings` + `settings-reference` + `managed-settings`) and
 * grown rules since this repo last read it — the per-kind list was three
 * bullets when `managed-policy-loader.ts` first quoted it and is six now. See
 * the pointer in `scripts/claude-doc-pages.tsv`'s header.
 *
 * Pages fetched 2026-09-06; anchors derived by `curl`-ing the page WITHOUT
 * `.md` and grepping `id="…"`, per AGENTS.md.
 */
import { describe, expect, test } from 'bun:test'
import { parseManagedPiPolicyTolerantV1 } from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import { mergeManagedPolicySources } from './managed-policy-loader.ts'

const BASE = '/etc/nessy/managed-policy.json'
const LATER = '/etc/nessy/managed-policy.d/20-security.json'

function merge(base: unknown, later: unknown): Record<string, unknown> {
  const { merged } = mergeManagedPolicySources([
    { path: BASE, value: base },
    { path: LATER, value: later },
  ])
  return merged as Record<string, unknown>
}

/**
 * `managed-settings.md#split-a-file-based-policy-across-teams`, rule by rule.
 * The quoted cell is the page's own bullet, verbatim.
 */
describe('per-kind combination rules across drop-in fragments', () => {
  test('single values — "the later file\'s value replaces the earlier one"', () => {
    expect(merge({ cleanupPeriodDays: 7 }, { cleanupPeriodDays: 30 }).cleanupPeriodDays).toBe(30)
    // The earlier file keeps every key the later one does not mention.
    expect(merge({ cleanupPeriodDays: 7, model: 'opus' }, { cleanupPeriodDays: 30 }).model).toBe('opus')
  })

  test('lists — "the two lists combine, with duplicates removed"', () => {
    const merged = merge(
      { permissions: { deny: ['Bash(rm:*)', 'Read(//etc/**)'] } },
      { permissions: { deny: ['Read(//etc/**)', 'Bash(curl:*)'] } },
    )
    expect((merged.permissions as { deny: readonly string[] }).deny)
      .toEqual(['Bash(rm:*)', 'Read(//etc/**)', 'Bash(curl:*)'])
  })

  test('nested blocks — "the two blocks merge key by key, and each key inside follows these same rules"', () => {
    const merged = merge(
      { sandbox: { enabled: true, network: { allowedDomains: ['a.example'] } } },
      { sandbox: { enabled: false, network: { allowedDomains: ['b.example'] } } },
    )
    const sandbox = merged.sandbox as { enabled: boolean, network: { allowedDomains: readonly string[] } }
    // "each key inside follows these same rules": the scalar replaces …
    expect(sandbox.enabled).toBe(false)
    // … and the list one level deeper still unions.
    expect(sandbox.network.allowedDomains).toEqual(['a.example', 'b.example'])
  })

  test('extraKnownMarketplaces — "a later entry with the same name replaces the earlier one whole", array spelling', () => {
    const merged = merge(
      { extraKnownMarketplaces: [{ name: 'team', source: 'acme/base' }, { name: 'other', source: 'acme/other' }] },
      { extraKnownMarketplaces: [{ name: 'team', source: 'acme/corrected' }] },
    )
    expect(merged.extraKnownMarketplaces)
      .toEqual([{ name: 'team', source: 'acme/corrected' }, { name: 'other', source: 'acme/other' }])
  })

  test('extraKnownMarketplaces — the same rule in the object spelling, and no deep merge inside an entry', () => {
    const merged = merge(
      { extraKnownMarketplaces: { team: { source: 'acme/base', autoUpdate: true } } },
      { extraKnownMarketplaces: { team: { source: 'acme/corrected' } } },
    )
    // "replaces the earlier one WHOLE" — the later entry does not inherit the
    // earlier entry's `autoUpdate`.
    expect(merged.extraKnownMarketplaces).toEqual({ team: { source: 'acme/corrected' } })
  })

  test('a replace-by-name key still unions entries the earlier fragment never named', () => {
    const merged = merge(
      { extraKnownMarketplaces: [{ name: 'team', source: 'acme/base' }] },
      { extraKnownMarketplaces: [{ name: 'new', source: 'acme/new' }] },
    )
    expect(merged.extraKnownMarketplaces)
      .toEqual([{ name: 'team', source: 'acme/base' }, { name: 'new', source: 'acme/new' }])
  })

  test('the merge attributes a replaced entry to the fragment that replaced it', () => {
    const { provenance } = mergeManagedPolicySources([
      { path: BASE, value: { extraKnownMarketplaces: [{ name: 'team', source: 'acme/base' }] } },
      { path: LATER, value: { extraKnownMarketplaces: [{ name: 'team', source: 'acme/corrected' }] } },
    ])
    expect(provenance.get('extraKnownMarketplaces[0]')).toBe(LATER)
  })

  test('fallbackModel and modelPicker — the page\'s whole-replacement rule is UNOBSERVABLE here, and this is the marker', () => {
    // Both carry "the later … replaces the earlier one whole" on the same page,
    // and neither is a key of `ManagedPiPolicyV1`: the parser strips them, so no
    // reader can see which rule the merge applied. Recorded as a null rather
    // than implemented. The day either key enters the schema, this test goes red
    // and the rule above it is the one to implement.
    const merged = merge({ fallbackModel: ['a'], modelPicker: ['a'] }, { fallbackModel: ['b'], modelPicker: ['b'] })
    expect(merged.fallbackModel).toBeDefined()
    const parsed = parseManagedPiPolicyTolerantV1(merged, { source: BASE })
    expect(Object.keys(parsed.policy)).not.toContain('fallbackModel')
    expect(Object.keys(parsed.policy)).not.toContain('modelPicker')
    expect(parsed.drops.map(drop => `${drop.field}:${drop.disposition}`))
      .toEqual(expect.arrayContaining(['fallbackModel:stripped', 'modelPicker:stripped']))
  })
})

/**
 * One row of `managed-settings.md#keys-that-fail-closed`, plus the two keys its
 * closing sentence exempts.
 *
 * `ours` is what `parseManagedPiPolicyTolerantV1` DOES at HEAD, measured — not
 * what the page asks for. Where the two differ the divergence is named in
 * `note` with the row that owns it, so this table is a register and not a wish.
 */
interface FailClosedCase {
  readonly key: string
  /** The page's cell, verbatim. */
  readonly cell: string
  /** A value of the wrong TYPE for this key — the "present but invalid" case. */
  readonly invalid: unknown
  /** The policy field to read back, and the value it must hold. */
  readonly field: string
  readonly ours: unknown
  readonly disposition: 'stripped' | 'emptied' | 'tightened'
  readonly note?: string
}

const FAIL_CLOSED: readonly FailClosedCase[] = [
  {
    key: 'allowedMcpServers',
    cell: 'Enforced as an empty allowlist, so no MCP servers are admitted until the value is fixed. '
      + 'An individual invalid entry is stripped and the valid subset is enforced.',
    invalid: 17,
    field: 'allowedMcpServers',
    ours: [],
    disposition: 'emptied',
  },
  {
    key: 'allowManagedHooksOnly',
    cell: 'Treated as `true` until fixed: the hook restrictions apply and, unless '
      + '`disableCommandPluginSources` is explicitly `false`, command-sourced plugins are disabled.',
    invalid: 'yes',
    field: 'allowManagedHooksOnly',
    ours: true,
    disposition: 'tightened',
  },
  {
    key: 'allowManagedMcpServersOnly',
    cell: 'Treated as `true`.',
    invalid: 'yes',
    field: 'allowManagedMcpServersOnly',
    ours: true,
    disposition: 'tightened',
    // P6.236 (2026-09-06) — this row's own note predicted exactly this edit:
    // "Open row P6.236 adds the key; when it lands, this row becomes
    // `true`/`tightened` like its two siblings." It did, and it does. The key
    // is now carried by `ManagedPiPolicyV1`, parsed through the same
    // `securitySwitch` as `allowManagedHooksOnly` and
    // `allowManagedPermissionRulesOnly`, and the divergence is closed.
  },
  {
    key: 'disableCommandPluginSources',
    cell: 'Treated as `true`, so command-sourced plugins stay disabled until the value is fixed.',
    invalid: 'yes',
    field: 'disableCommandPluginSources',
    ours: true,
    disposition: 'tightened',
  },
  {
    key: 'availableModels',
    cell: 'Enforced as an empty allowlist until fixed, so only the Default model is available; '
      + 'a non-string entry is stripped and the valid subset enforced.',
    invalid: 17,
    field: 'availableModels',
    ours: [],
    disposition: 'emptied',
  },
  {
    key: 'enforceAvailableModels',
    cell: 'Treated as `true`.',
    invalid: 'yes',
    field: 'enforceAvailableModels',
    ours: true,
    disposition: 'tightened',
  },
  {
    key: 'forceLoginOrgUUID',
    cell: 'No organization is permitted to log in until the value is fixed.',
    invalid: 17,
    field: 'forceLoginOrgUUID',
    ours: undefined,
    disposition: 'stripped',
    note: 'DIVERGES BY DECISION, and the decision is this line: Nessy authenticates through the `dp` '
      + 'gateway, not through an Anthropic organization, so there is no org login for the key to '
      + 'refuse. The key is refused as unknown — `managed-policy.test.ts` uses it as the literal '
      + 'unknown-key fixture — and the fleet loses nothing this key would have protected.',
  },
  {
    key: 'crossSessionInbound',
    cell: 'Treated as `refuse`, the most restrictive value, so inbound cross-session messages are '
      + 'refused until the value is fixed.',
    invalid: 'nope',
    field: 'crossSessionInbound',
    ours: undefined,
    disposition: 'stripped',
    note: 'NOT A MANAGED KEY HERE, measured and written down: `managed-composition.ts` records that '
      + 'none of the seven lower-scope exception keys is a key of `ManagedPiPolicyV1`, so no managed '
      + 'source we accept can set this one and there is no invalid value for it to fail closed on.',
  },
  {
    key: 'deniedMcpServers',
    cell: 'An individual invalid entry is stripped and the valid subset is enforced. A wholly invalid '
      + 'value is dropped with a warning, since denying every server would block servers the policy '
      + 'never named.',
    invalid: 17,
    field: 'deniedMcpServers',
    ours: undefined,
    disposition: 'stripped',
  },
  {
    key: 'sandbox.credentials',
    cell: 'A recoverable invalid entry is degraded to `mode: "deny"` with a warning; an unrecoverable '
      + 'one is stripped; valid entries stay enforced.',
    invalid: 17,
    field: 'sandbox',
    ours: {},
    disposition: 'stripped',
    note: 'PARTIAL: the unrecoverable arm matches, the degrade-to-`mode: "deny"` arm cannot be '
      + 'implemented because this fork has no `sandbox.credentials` block for a mode to be set on. '
      + 'Recorded on `sandbox-settings.ts`.',
  },
  {
    key: 'requiredMinimumVersion',
    cell: 'requiredMinimumVersion and requiredMaximumVersion fail open by design: an invalid value is '
      + 'dropped rather than enforced.',
    invalid: 17,
    field: 'requiredMinimumVersion',
    ours: undefined,
    disposition: 'stripped',
  },
  {
    key: 'requiredMaximumVersion',
    cell: 'requiredMinimumVersion and requiredMaximumVersion fail open by design: an invalid value is '
      + 'dropped rather than enforced.',
    invalid: 17,
    field: 'requiredMaximumVersion',
    ours: undefined,
    disposition: 'stripped',
  },
]

describe('managed-settings.md#keys-that-fail-closed, key by key', () => {
  test('the pin covers the page\'s table and nothing else', () => {
    // Ten rows in the table plus the two the closing sentence exempts. A page
    // that grows an eleventh row fails HERE, with a count, rather than silently
    // leaving the new key unpinned.
    expect(FAIL_CLOSED).toHaveLength(12)
    expect(new Set(FAIL_CLOSED.map(row => row.key)).size).toBe(12)
  })

  for (const row of FAIL_CLOSED) {
    test(`${row.key} — ${row.cell}`, () => {
      const document = row.key.includes('.')
        ? { sandbox: { credentials: row.invalid } }
        : { [row.key]: row.invalid }
      const parsed = parseManagedPiPolicyTolerantV1(document, { source: BASE })
      expect((parsed.policy as unknown as Record<string, unknown>)[row.field]).toEqual(row.ours)
      const drop = parsed.drops.find(entry => entry.field === row.key)
      expect(drop?.disposition).toBe(row.disposition)
    })
  }

  test('a VALID value of a fail-closed key is enforced as written — the control', () => {
    const parsed = parseManagedPiPolicyTolerantV1(
      { availableModels: ['opus'], enforceAvailableModels: true, allowManagedHooksOnly: false },
      { source: BASE },
    )
    expect(parsed.policy.availableModels).toEqual(['opus'])
    expect(parsed.policy.enforceAvailableModels).toBe(true)
    // `false` is the LAX pole and it survives: fail-closed applies to an invalid
    // value, never to a value the administrator meant.
    expect(parsed.policy.allowManagedHooksOnly).toBe(false)
    expect(parsed.drops.filter(drop => drop.field !== 'schemaVersion')).toEqual([])
  })
})
