/**
 * P2.7 — the managed floor reaches the Claude SDK's OWN policy tier.
 *
 * The claim under test is not "a mapper exists" but "a deny rule an
 * administrator composed arrives in the shape the SDK's restrictive-only filter
 * actually copies". Those are different claims, and the second one is why every
 * expectation here is written against the MEASURED filter (`Ebg` in the shipped
 * `claude-agent-sdk-darwin-arm64/claude`, quoted in the module under test)
 * rather than against `Settings` — a `Settings` key the filter does not copy
 * would typecheck, ship, and enforce nothing.
 *
 * The partition test is the load-bearing one: it keys off
 * `MANAGED_PI_POLICY_KEYS`, so a field added to the schema and to nothing else
 * fails here instead of silently becoming a policy that reaches the Pi runtime
 * and not the Claude one.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, setDefaultTimeout, test } from 'bun:test'

// P7.1, 2026-09-10 — the budget belongs to the FILE, sized against the largest
// observed run rather than against a per-test guess. Two tests here read the
// 233 MB native binary; the first read after a fresh install is I/O and cost
// 15.1 s at 0.2 % cpu, against bun's 5 s default. The memoised reader below
// removes the second read; nothing can remove the first.
setDefaultTimeout(60_000)
import {
  CLAUDE_MAPPED_POLICY_KEYS,
  buildClaudeManagedSettingsOptions,
  claudeAttributionFloor,
  claudeManagedPolicyUnenforcedKeys, claudeManagedPolicyUnhonouredAllowNotices, // F1.1001, in place: this file is cited by line
  claudeManagedSliceDiscardNotice,
  detectClaudeAdminSettingsTier,
  formatClaudeManagedSettingsDiagnostics,
  mapManagedPolicyToClaudeSettings,
} from '../claude-managed-settings.ts'
import {
  MANAGED_PI_POLICY_KEYS,
  parseManagedPiPolicyTolerantV1,
  type ManagedPiPolicyV1,
} from '../pi-harness/managed-policy.ts'
import { buildClaudeAutoModePolicySettings } from '../claude-auto-mode-policy.ts'
import { runtimeReceivesMcpChannelPush } from '../runtime-agent-support.ts'
import { i18n, setupI18n } from '../../i18n/index.ts'

/** Parse the way a host-owned `managed-policy.json` is parsed, drops and all. */
function policy(document: Record<string, unknown>): ManagedPiPolicyV1 {
  const parsed = parseManagedPiPolicyTolerantV1(
    { schemaVersion: 1, ...document },
    { source: '/etc/nessy/managed-policy.json' },
  )
  // A fixture that was quietly stripped proves nothing about the mapping.
  expect(parsed.drops).toEqual([])
  return parsed.policy
}

/**
 * P6.541 EMPTIED the `not-enforced` class, so the positive control is SYNTHETIC
 * from here on — and that is the finding, not a workaround.
 *
 * Every assertion below that says *"the nothing-applies-it sentence IS produced
 * on the same run, for the key it is true of"* used to point at a real table
 * entry: `disableAllHooks`, then `allowedHttpHookUrls`, then `autoMode`. Each
 * closure re-pointed it at whatever was left. `autoMode` was the last one, and
 * P6.541 moved it to `host-gate` by projecting the administrator's own
 * `environment` / `hard_deny` / `soft_deny` onto the classifier — so there is
 * nothing left to point at.
 *
 * Deleting the dimension instead would retire the check along with the defect,
 * which is exactly what these tests exist to prevent. So the control is a gap
 * built by hand: the FORMATTER and the WARNING LIST are pure functions of a
 * mapping, so a hand-built mapping exercises the same code paths a real
 * `not-enforced` key would, and the day one comes back the two halves still
 * meet. The key name is deliberately not a real policy key.
 */
const SYNTHETIC_UNENFORCED_KEY = 'nessySyntheticUnenforcedKey'

function withSyntheticUnenforcedGap(
  mapping: ReturnType<typeof mapManagedPolicyToClaudeSettings>,
): ReturnType<typeof mapManagedPolicyToClaudeSettings> {
  return {
    ...mapping,
    unsupported: [
      ...mapping.unsupported,
      {
        key: SYNTHETIC_UNENFORCED_KEY,
        kind: 'no-sdk-tier',
        enforcement: 'not-enforced',
        reason: 'a synthetic gap, so the not-enforced sentence keeps a positive control after P6.541',
      },
    ],
  }
}

/** The nothing-applies-it sentence, still produced for a key it is true of. */
function saysNothingAppliesIt(
  mapping: ReturnType<typeof mapManagedPolicyToClaudeSettings>,
): boolean {
  return formatClaudeManagedSettingsDiagnostics(withSyntheticUnenforcedGap(mapping))
    .some(line => line.includes(`does NOT enforce ${SYNTHETIC_UNENFORCED_KEY} — nothing applies it here`))
}

describe('a deny rule composed by our policy reaches the SDK layer', () => {
  test('claudeRules.deny lands on permissions.deny, through the real parser', () => {
    const mapping = mapManagedPolicyToClaudeSettings(policy({
      claudeRules: { deny: ['Bash(curl:*)'], ask: ['WebFetch'] },
    }))
    expect(mapping.settings?.permissions?.deny).toEqual(['Bash(curl:*)'])
    expect(mapping.settings?.permissions?.ask).toEqual(['WebFetch'])
    expect(mapping.mapped).toContain('claudeRules')
  })

  test('the spawn option carries it, and is ABSENT when nothing maps', () => {
    const withDeny = buildClaudeManagedSettingsOptions(policy({
      claudeRules: { deny: ['Bash(curl:*)'] },
    }))
    expect(withDeny.managedSettings?.permissions?.deny).toEqual(['Bash(curl:*)'])

    // An unmanaged install must spawn byte-identically to before this row: no
    // `managedSettings` key at all, not an empty object.
    expect(buildClaudeManagedSettingsOptions(policy({}))).toEqual({})
    expect(buildClaudeManagedSettingsOptions(undefined)).toEqual({})
  })

  test('a rule the admin wrote that does NOT compile never reaches the SDK', () => {
    // The parser drops an unparseable claude rule; the mapper must not resurrect
    // it, or the SDK would be handed a rule our own gate refused to install.
    const parsed = parseManagedPiPolicyTolerantV1(
      { schemaVersion: 1, claudeRules: { deny: ['Bash(curl:*)', '((not a rule'] } },
      { source: '/etc/nessy/managed-policy.json' },
    )
    expect(parsed.drops.length).toBe(1)
    const mapping = mapManagedPolicyToClaudeSettings(parsed.policy)
    expect(mapping.settings?.permissions?.deny).toEqual(['Bash(curl:*)'])
  })
})

describe('a floor never widens', () => {
  test('claudeRules.allow is withheld, and SAID to be withheld', () => {
    const mapping = mapManagedPolicyToClaudeSettings(policy({
      claudeRules: { allow: ['Read(~/corp/**)'] },
    }))
    // No permissions block at all: `allow` alone maps to nothing.
    expect(mapping.settings).toBeUndefined()
    // ONE gap, not two: the parser also compiled the allow rule into
    // `permissionDsl` under a generated `claude-allow-0` id, and reporting that
    // copy as a second gap would double-count one withheld rule.
    expect(mapping.unsupported.map(gap => gap.key)).toEqual(['claudeRules'])
    expect(mapping.unsupported[0]?.kind).toBe('enforced-elsewhere')
  })

  test('a policy carrying BOTH directions sends the deny and drops the allow', () => {
    // The realistic shape, and the one an allow-only fixture cannot catch: an
    // administrator writes a deny list and an exception list in one block, and
    // only the deny half is ours to forward. (The SDK filter would take an
    // `allow` from us whenever no admin tier sets `allowManagedPermissionRulesOnly`
    // — so this really would widen, it would not be quietly dropped.)
    const mapping = mapManagedPolicyToClaudeSettings(policy({
      claudeRules: { deny: ['Bash(curl:*)'], allow: ['Read(~/corp/**)'], ask: ['WebFetch'] },
    }))
    expect(mapping.settings?.permissions).toEqual({ deny: ['Bash(curl:*)'], ask: ['WebFetch'] })
    expect(Object.keys(mapping.settings?.permissions ?? {})).not.toContain('allow')
  })

  test('the non-enforcing pole of a lock is not sent', () => {
    // `allowManagedHooksOnly: false` asks for nothing, and the SDK filter only
    // copies the key at `=== true` anyway.
    const mapping = mapManagedPolicyToClaudeSettings(policy({ allowManagedHooksOnly: false }))
    expect(mapping.settings).toBeUndefined()
    expect(mapping.mapped).toEqual([])
  })

  test('sandbox sends the denials and withholds the grants', () => {
    const mapping = mapManagedPolicyToClaudeSettings(policy({
      sandbox: {
        enabled: true,
        excludedCommands: ['docker *'],
        deniedReadRoots: ['/etc/corp-secrets'],
        additionalWritableRoots: ['/opt/corp-build'],
        allowUnsandboxedCommands: false,
        network: {
          deniedDomains: ['blocked.example'],
          allowedDomains: ['corp.example'],
          allowManagedDomainsOnly: true,
        },
      },
    }))
    expect(mapping.settings?.sandbox).toEqual({
      enabled: true,
      allowUnsandboxedCommands: false,
      // P2.136 — `allowedDomains` IS here now, and this expectation asserted its
      // absence until then. It rides with `allowManagedDomainsOnly`, which makes
      // it the lock's operand rather than a widening: the lock alone is
      // deny-every-host, so the pair had inverted the administrator's allowlist.
      network: {
        deniedDomains: ['blocked.example'],
        allowManagedDomainsOnly: true,
        allowedDomains: ['corp.example'],
      },
      filesystem: { denyRead: ['/etc/corp-secrets'] },
    })
    // The two widening lists are absent by construction, not by omission:
    // `excludedCommands` re-opens the unsandboxed hatch and
    // `additionalWritableRoots` grants writes. Neither has a lock to be the
    // operand of, so P2.136 does not reach them.
    expect(JSON.stringify(mapping.settings?.sandbox)).not.toContain('docker')
    expect(JSON.stringify(mapping.settings?.sandbox)).not.toContain('/opt/corp-build')
  })

  test('both spellings of a read denial fold into the one key the filter copies', () => {
    const mapping = mapManagedPolicyToClaudeSettings(policy({
      sandbox: {
        deniedReadRoots: ['/etc/corp-secrets'],
        filesystem: { denyRead: ['/etc/corp-secrets', '/var/corp'], denyWrite: ['/srv/corp'] },
      },
    }))
    expect(mapping.settings?.sandbox?.filesystem).toEqual({
      denyRead: ['/etc/corp-secrets', '/var/corp'],
      denyWrite: ['/srv/corp'],
    })
  })
})

describe('deniedMcpServers pass through, because the entry shape is already theirs', () => {
  test('name, url and command entries all survive', () => {
    const mapping = mapManagedPolicyToClaudeSettings(policy({
      deniedMcpServers: [
        'forbidden-mcp',
        { serverUrl: 'https://*.vendor.example/*' },
        { serverCommand: ['npx', 'vendor-mcp'] },
      ],
    }))
    expect(mapping.settings?.deniedMcpServers).toEqual([
      { serverName: 'forbidden-mcp' },
      { serverUrl: 'https://*.vendor.example/*' },
      { serverCommand: ['npx', 'vendor-mcp'] },
    ])
  })
})

describe('unsupported keys are surfaced diagnostics, never silent drops', () => {
  test('a real Settings key the SDK filter does not copy is REPORTED, not sent', () => {
    // The measured trap: `disableAllHooks` is a genuine `Settings` key with
    // genuine managed meaning, and `Ebg` copies none of it. Sending it would
    // look like enforcement and be a no-op.
    const mapping = mapManagedPolicyToClaudeSettings(policy({
      disableAllHooks: true,
      allowedHttpHookUrls: ['https://hooks.corp.example/ingest'],
    }))
    expect(mapping.settings).toBeUndefined()
    expect(mapping.unsupported.map(gap => gap.key).sort())
      .toEqual(['allowedHttpHookUrls', 'disableAllHooks'])
    expect(mapping.unsupported.every(gap => gap.kind === 'no-sdk-tier')).toBe(true)
  })

  test('an absent key is not a gap', () => {
    const mapping = mapManagedPolicyToClaudeSettings(policy({ claudeRules: { deny: ['Bash(curl:*)'] } }))
    expect(mapping.unsupported).toEqual([])
  })

  test('each gap reaches the debug channel with its key and its reason', () => {
    const mapping = mapManagedPolicyToClaudeSettings(policy({
      claudeRules: { deny: ['Bash(curl:*)'] },
      allowedHttpHookUrls: ['https://hooks.corp.example/*'],
      autoMode: { environment: ['Production payment infrastructure.'] },
      disableAllHooks: true,
      autoCompactEnabled: false,
      cleanupPeriodDays: 30,
    }))
    const lines = formatClaudeManagedSettingsDiagnostics(mapping)
    expect(lines.some(line => line.includes('carries: claudeRules'))).toBe(true)
    // P2.133 — a MEASURED `not-enforced` key gets the stronger sentence. It used
    // to read "cannot carry <key> (no-sdk-tier)", which an administrator reads
    // as "so something else does it"; nothing does.
    //
    // The SUBJECT of this assertion was `disableAllHooks` until P2.206 wired
    // that key host-side, then `allowedHttpHookUrls` until P6.117 wired the
    // plugin http-hook runner onto claude and codex. Swapping in the remaining
    // measured-unenforced key keeps the dimension covered — deleting the
    // assertion instead would have retired the check along with the defect, and
    // `autoMode` is the one key in the table still measured `not-enforced`.
    // P6.541 moved `autoMode` to `host-gate` — the administrator's prose now
    // rides `Options.settings` — so it prints the ORDINARY sentence, and the
    // stronger one keeps its coverage through the synthetic control.
    expect(lines.some(line => line.includes('does NOT enforce autoMode'))).toBe(false)
    expect(lines.some(line => line.includes('cannot carry autoMode'))).toBe(true)
    expect(saysNothingAppliesIt(mapping)).toBe(true)
    // The key that just left this role, asserted from the other side on the same
    // run: a `host-gate` verdict prints the ordinary sentence and never the
    // nothing-applies-it one, so a reverted P6.117 trips here as well as in the
    // verdict block below.
    expect(lines.some(line => line.includes('cannot carry allowedHttpHookUrls (no-sdk-tier)'))).toBe(true)
    expect(lines.some(line => line.includes('does NOT enforce allowedHttpHookUrls'))).toBe(false)
    // Negative control on the same run: a key that is NOT measured
    // `not-enforced` keeps the ordinary sentence, so the new line is a verdict
    // and not a blanket rewrite of every gap. Two of them, and deliberately
    // different verdicts — `unmeasured` and (since P2.206) `host-gate`.
    //
    // `cleanupPeriodDays` carried the `unmeasured` half from P3.233 until P6.74
    // measured it `host-gate`; both verdicts print the same "cannot carry"
    // sentence, which is what this assertion is about, and the verdict itself is
    // asserted in the P2.133 block below. The key that carried it before,
    // `autoCompactEnabled`, is asserted separately below. Swapped rather than
    // dropped, for the reason the paragraph above gives about `disableAllHooks`.
    expect(lines.some(line => line.includes('cannot carry cleanupPeriodDays (no-sdk-tier)'))).toBe(true)
    expect(lines.some(line => line.includes('cannot carry disableAllHooks (no-sdk-tier)'))).toBe(true)
    expect(lines.some(line => line.includes('does NOT enforce disableAllHooks'))).toBe(false)
    // P3.233 — the diagnostic an operator reads must not say the opposite of
    // what the runtime does. The line still opens with "cannot carry", which is
    // true of the SDK's MANAGED tier, but the reason it carries now names the
    // host gate that does enforce the key instead of calling it a preference.
    const autoCompact = lines.find(line => line.includes('cannot carry autoCompactEnabled'))
    expect(autoCompact).toBeDefined()
    expect(autoCompact).toContain('DISABLE_AUTO_COMPACT')
    expect(autoCompact).not.toContain('a product preference, not a restriction')
    expect(lines.some(line => line.includes('does NOT enforce autoCompactEnabled'))).toBe(false)
  })
})

/**
 * A document that sets EVERY schema key at an enforcing value.
 *
 * Module-scope since P2.138 because two describes need it: the partition test
 * that no key falls through, and the one that ties `CLAUDE_MAPPED_POLICY_KEYS`
 * to what the mapper actually maps.
 */
const EVERY_KEY: Record<string, unknown> = {
  disabledPermissionModes: ['acceptEdits'],
  permissionDsl: {
    version: 1,
    rules: [{ id: 'org-deny-bash', action: 'deny', match: { kind: 'tool', semanticId: 'Bash' } }],
  },
  allowedPluginKeys: ['corp.toolkit'],
  deniedPluginKeys: ['vendor.unreviewed'],
  enabledPlugins: { 'corp.toolkit': true },
  allowedMcpServers: ['corp-mcp'],
  deniedMcpServers: ['forbidden-mcp'],
  allowPluginHooks: false,
  allowManagedHooksOnly: true,
  disableCommandPluginSources: true,
  disableAllHooks: true,
  disableSideloadFlags: true,
  allowManagedPermissionRulesOnly: true,
  allowManagedMcpServersOnly: true,
  model: 'claude-sonnet-4-5-20250929',
  strictPluginOnlyCustomization: ['skills', 'agents', 'hooks', 'mcp'],
  defaultMode: 'plan',
  channelsEnabled: false,
  disableAgentView: true,
  unattendedApprovalFallback: 'deny' as const,
  allowedChannelServers: ['corp-mcp'],
  sandbox: { allowUnsandboxedCommands: false },
  workflow: { disableWorkflows: true },
  allowedHttpHookUrls: ['https://hooks.corp.example/ingest'],
  httpHookAllowedEnvVars: ['CORP_HOOK_TOKEN'],
  claudeRules: { deny: ['Bash(curl:*)'] },
  claudeMdExcludes: ['**/vendor/**/CLAUDE.md'],
  // P6.245 — the two operator-authored strings.
  pluginTrustMessage: 'All plugins from our marketplace are approved by IT',
  companyAnnouncements: ['Welcome to Acme Corp! Review our code guidelines at docs.example.com'],
  autoMode: { environment: ['Production payment infrastructure.'] },
  cleanupPeriodDays: 30,
  autoCompactEnabled: false,
  connectSourcesOnStartup: false,
  disableInAppUpdates: true,
  disableInAppBrowser: true,
  // P6.338 — the three graded browser locks. `browserExternalPageTools`
  // carries the page's only effective value; the parser normalises the
  // second accepted spelling onto it.
  disableBrowserExternalNavigation: true,
  disableBrowserCdp: true,
  browserHostAllowlist: ['docs.example.com', '*.internal.example.com'],
  browserExternalPageTools: 'disabled',
  modelPricing: { multiplier: 0.85 },
  disableNonGatewayConnections: true, managedMcpServers: { 'corp-docs': { type: 'http', url: 'https://mcp.corp.example/docs' } }, // F1.593
  env: { CORP_TELEMETRY_ENDPOINT: 'https://otel.corp.example' },
  forceRemoteSettingsRefresh: true,
  requiredMinimumVersion: '1.0.0',
  requiredMaximumVersion: '9.9.9',
  availableModels: ['sonnet'],
  enforceAvailableModels: true,
  strictKnownMarketplaces: [{ source: 'hostPattern', hostPattern: '^gitlab\\.tcsbank\\.ru$' }],
  blockedMarketplaces: [{ source: 'github', repo: 'untrusted/plugins' }],
  extraKnownMarketplaces: {
    'corp-plugins': { source: { source: 'git', url: 'https://gitlab.tcsbank.ru/corp/plugins.git' } },
  },
  pluginSuggestionMarketplaces: ['corp-plugins'],
}

/**
 * P2.7 Low, measured and closed by P2.138 — the alarm had de-sensitised itself.
 *
 * `no mapping recorded for this key` exists to catch ONE thing: a field added to
 * `MANAGED_PI_POLICY_KEYS` and to no mapping. It was instead firing on ordinary
 * administrator policy — every key this mapper reads, set at the pole that asks
 * for nothing. The comment directly above the branch already said such a key was
 * "not a gap either"; the `continue` that would have made it true was never
 * written, so the code did the opposite of what it claimed.
 *
 * The six shapes below are the ones MEASURED to reach it (2026-08-27), each
 * driven through the real parser so it is a document an administrator could
 * actually deploy.
 */
describe('a key set at its NON-ENFORCING pole is not a gap', () => {
  const NON_ENFORCING: Record<string, Record<string, unknown>> = {
    'allowManagedHooksOnly:false': { allowManagedHooksOnly: false },
    'allowManagedPermissionRulesOnly:false': { allowManagedPermissionRulesOnly: false },
    'allowManagedMcpServersOnly:false': { allowManagedMcpServersOnly: false },
    'enforceAvailableModels:false': { enforceAvailableModels: false },
    'deniedMcpServers:[]': { deniedMcpServers: [] },
    'availableModels:[]': { availableModels: [] },
    'sandbox:{}': { sandbox: {} },
  }

  test('none of them raises the alarm, and none prints a line', () => {
    for (const [label, document] of Object.entries(NON_ENFORCING)) {
      const mapping = mapManagedPolicyToClaudeSettings(policy(document))
      expect({ label, unsupported: [...mapping.unsupported] }).toEqual({ label, unsupported: [] })
      expect({ label, mapped: [...mapping.mapped] }).toEqual({ label, mapped: [] })
      expect({ label, lines: [...formatClaudeManagedSettingsDiagnostics(mapping)] })
        .toEqual({ label, lines: [] })
    }
  })

  test('POSITIVE CONTROL: the same keys at the ENFORCING pole still map', () => {
    const mapping = mapManagedPolicyToClaudeSettings(policy({
      allowManagedHooksOnly: true,
      allowManagedPermissionRulesOnly: true,
      allowManagedMcpServersOnly: true,
      enforceAvailableModels: true,
      deniedMcpServers: ['forbidden-mcp'],
      availableModels: ['sonnet'],
      sandbox: { allowUnsandboxedCommands: false },
    }))
    expect([...mapping.mapped]).toEqual([
      'allowManagedHooksOnly',
      'allowManagedMcpServersOnly',
      'allowManagedPermissionRulesOnly',
      'availableModels',
      'deniedMcpServers',
      'enforceAvailableModels',
      'sandbox',
    ])
    expect(mapping.unsupported).toEqual([])
  })

  test('the skip does NOT swallow a real gap on a key it also owns', () => {
    // `claudeRules` is in the mapped list AND in the gaps table, and the gaps
    // table is read first. Its `allow` list is withheld on purpose, which is a
    // real thing to tell an administrator — so an empty `claudeRules` keeps its
    // explanation rather than being skipped as "asks for nothing".
    const mapping = mapManagedPolicyToClaudeSettings(policy({ claudeRules: { allow: ['Bash(ls:*)'] } }))
    expect(mapping.unsupported.map(gap => gap.key)).toEqual(['claudeRules'])
    expect(mapping.unsupported[0]?.reason).not.toStartWith('no mapping recorded')
  })

  test('the skip list is exactly what the mapper maps — it cannot over-suppress', () => {
    // The mutant this kills: a key parked in `CLAUDE_MAPPED_POLICY_KEYS` that the
    // mapper never actually maps would be skipped in SILENCE forever, which is
    // the same defect as the alarm, inverted. Tying the constant to the mapper's
    // own output over the every-key fixture means the two cannot drift.
    const mapping = mapManagedPolicyToClaudeSettings(policy(EVERY_KEY))
    expect(new Set(CLAUDE_MAPPED_POLICY_KEYS)).toEqual(new Set(mapping.mapped))
    // And no typo: every entry is a real policy key.
    for (const key of CLAUDE_MAPPED_POLICY_KEYS) {
      expect({ key, known: (MANAGED_PI_POLICY_KEYS as readonly string[]).includes(key) })
        .toEqual({ key, known: true })
    }
  })
})

describe('the partition covers the whole schema', () => {

  test('the fixture sets every key, so a new field cannot skip this test', () => {
    expect(new Set([...Object.keys(EVERY_KEY), 'schemaVersion'])).toEqual(new Set(MANAGED_PI_POLICY_KEYS))
  })

  test('every key an administrator SET is either mapped or explained', () => {
    const mapping = mapManagedPolicyToClaudeSettings(policy(EVERY_KEY))
    const accounted = new Set([...mapping.mapped, ...mapping.unsupported.map(gap => gap.key)])
    for (const key of MANAGED_PI_POLICY_KEYS) {
      if (key === 'schemaVersion') continue
      expect({ key, accounted: accounted.has(key) }).toEqual({ key, accounted: true })
    }
    // And nothing fell through to the placeholder reason, which is what a field
    // added to the schema and to no mapping would produce.
    expect(mapping.unsupported.filter(gap => gap.reason.startsWith('no mapping recorded'))).toEqual([])
  })

  test('the mapped set is exactly the keys the measured SDK filter copies', () => {
    const mapping = mapManagedPolicyToClaudeSettings(policy(EVERY_KEY))
    expect([...mapping.mapped]).toEqual([
      'allowManagedHooksOnly',
      'allowManagedMcpServersOnly',
      'allowManagedPermissionRulesOnly',
      'availableModels',
      'claudeRules',
      'deniedMcpServers',
      // P3.285 (2026-09-03). Arrived with the S0-3 bundle: `FILTER_COPIES`
      // above asserts the vendored binary copies it, and the mapper now emits
      // it, so the two halves of this test's own name stay true together.
      'disableCommandPluginSources',
      'enforceAvailableModels',
      'sandbox',
      'strictPluginOnlyCustomization',
    ])
  })

  /**
   * P3.285 — the TRI-STATE, driven rather than asserted from the type.
   *
   * `settings-reference.md#disablecommandpluginsources` and the SDK's own
   * `Settings` doc give three states, and only one of them is a floor. The
   * vendored filter (re-extracted 2026-09-03) copies the key at `true` only:
   * `if(e.disableCommandPluginSources===!0)r.disableCommandPluginSources=!0;`
   *
   * So the mapper must emit at `true`, emit NOTHING at `false` — and a `false`
   * must still be explained rather than silently dropped, because at that pole
   * the key means something host-side that the SDK will never see.
   */
  test('P3.285: the restrictive pole reaches the SDK and the widening pole is explained', () => {
    const floor = mapManagedPolicyToClaudeSettings(policy({ disableCommandPluginSources: true }))
    expect(floor.settings?.disableCommandPluginSources).toBe(true)
    expect(floor.mapped).toContain('disableCommandPluginSources')
    expect(floor.unsupported.map(gap => gap.key)).not.toContain('disableCommandPluginSources')

    const widening = mapManagedPolicyToClaudeSettings(policy({ disableCommandPluginSources: false }))
    // Never sent: a floor that hands capability out is not a floor, and the
    // filter would drop it anyway.
    expect(widening.settings?.disableCommandPluginSources).toBeUndefined()
    // But never silent either — this is the row's own standard.
    const gap = widening.unsupported.find(entry => entry.key === 'disableCommandPluginSources')
    expect(gap?.kind).toBe('enforced-elsewhere')
    expect(gap?.reason).not.toStartWith('no mapping recorded')

    // Unset delegates on both sides — the SDK's doc says it "follows
    // allowManagedHooksOnly", which is the key immediately above it here.
    const unset = mapManagedPolicyToClaudeSettings(policy({ allowManagedHooksOnly: true }))
    expect(unset.settings?.allowManagedHooksOnly).toBe(true)
    expect('disableCommandPluginSources' in (unset.settings ?? {})).toBe(false)
  })
})

/**
 * The spawn WIRING, pinned by source match.
 *
 * `ClaudeAgent.chatImpl` builds `Options` inside a method that needs a live SDK
 * subprocess, a plugin runtime and a session, so it is not drivable from a unit
 * test — and the fact that matters is small and exact: the mapping is resolved
 * BEFORE the options literal so its diagnostics run even when it maps nothing,
 * and the result is spread into the literal so the SDK actually receives it. A
 * mapper nothing spreads is the whole defect this row started from.
 */
describe('the claude spawn passes it as Options.managedSettings', () => {
  const source = readFileSync(fileURLToPath(new URL('../claude-agent.ts', import.meta.url)), 'utf8')
  const at = (needle: string): number => {
    const index = source.indexOf(needle)
    expect(index, `missing source anchor: ${needle}`).toBeGreaterThanOrEqual(0)
    return index
  }

  test('resolves the mapping from the registered policy floor', () => {
    // P6.511 · the call was split in two so the policy is named once and read
    // twice — the mapper takes it, and so does the product floor beside it. The
    // anchors are the two statements rather than the old single line, and the
    // ORDER is what matters: the floor must see the same policy object the
    // mapping did, not a second resolve.
    expect(source).toContain('const managedPiPolicyFloor = resolveManagedPiPolicyFloor()')
    expect(source)
      .toContain('const claudeManagedSettings = mapManagedPolicyToClaudeSettings(managedPiPolicyFloor)')
    expect(at('const managedPiPolicyFloor = resolveManagedPiPolicyFloor()'))
      .toBeLessThan(at('mapManagedPolicyToClaudeSettings(managedPiPolicyFloor)'))
  })

  test('P6.511: the product floor is the SECOND contributor, not a second spread', () => {
    // The seam `buildClaudeManagedSettingsOptions` exists for: one merge, one
    // collision report. A floor spread separately into the options literal would
    // silently overwrite the administrator's key instead of colliding with it.
    const contributor = at('productCommandSourceFloor: claudeCommandPluginSourceFloor(managedPiPolicyFloor)')
    expect(contributor).toBeGreaterThan(at('buildClaudeManagedSettingsOptions('))
    expect(contributor).toBeLessThan(at('const options: Options = {'))
  })

  test('P6.688: the PowerShell floor is the THIRD contributor, in the same map', () => {
    // The settings route to the second command executor. It has to be in the
    // contributor map rather than spread separately for the reason above — and
    // it has to be in THIS map rather than `composeClaudeSpawnSettings`'s,
    // because only the managed tier out-ranks the project `settings.json` the
    // row is about.
    const contributor = at('productPowerShellToolFloor: claudePowerShellToolDenyFloor()')
    expect(contributor).toBeGreaterThan(at('buildClaudeManagedSettingsOptions('))
    expect(contributor).toBeLessThan(at('const options: Options = {'))
  })

  test('P6.441: the host attribution floor is a contributor, and only the OFF direction', () => {
    // The row's claude half. The child honours all five keys from a project
    // `.claude/settings.json` while Pi and codex see none, so the host's answer
    // has to reach the tier that out-ranks a project file.
    const contributor = at('hostAttributionFloor: claudeAttributionFloor(resolveGitAttribution())')
    expect(contributor).toBeGreaterThan(at('buildClaudeManagedSettingsOptions('))
    expect(contributor).toBeLessThan(at('const options: Options = {'))

    // POSITIVE: the two facts the SDK's restrictive filter actually carries.
    expect(claudeAttributionFloor({
      commitTrailer: undefined,
      prText: undefined,
      sessionUrl: false,
      gitInstructions: true,
      prUrlTemplate: undefined,
    })).toEqual({ includeCoAuthoredBy: false, attribution: { sessionUrl: false } } as never)

    // NEGATIVE: attribution ON is `undefined`, so an unmanaged install spawns
    // byte-identically — a floor only ever removes. And CUSTOM TEXT never rides
    // this tier: the filter copies `commitTrailers:false`/`sessionUrl:false` and
    // no strings, so emitting the wording here would be a silent no-op. It
    // reaches every runtime through the system prompt instead.
    const on = claudeAttributionFloor({
      commitTrailer: 'Co-Authored-By: AI <ai@example.com>',
      prText: 'Raised by the corp agent',
      sessionUrl: true,
      gitInstructions: true,
      prUrlTemplate: 'https://reviews.example.com/{owner}/{repo}/pull/{number}',
    })
    expect(on).toBeUndefined()
    expect(JSON.stringify(claudeAttributionFloor({
      commitTrailer: 'Co-Authored-By: AI <ai@example.com>',
      prText: undefined,
      sessionUrl: false,
      gitInstructions: false,
      prUrlTemplate: 'https://reviews.example.com/x',
    }))).not.toContain('reviews.example.com')
  })

  test('P6.613: the unenforced-keys list reaches the DURABLE operator channel, guarded', () => {
    // The row's whole subject. `claudeManagedPolicyUnenforcedKeys` had no
    // production consumer, so the one fact that means "your policy is not in
    // effect" ended at `this.debug` — an optional callback `SessionManager`
    // points at a log FILE and that is simply absent on an agent built without
    // one. `queueDegradationNotice` latches per session and lands on the turn.
    const emit = at("this.queueDegradationNotice(i18n.t('chat.managedPolicy.unenforcedKeys'")
    expect(emit).toBeGreaterThan(at('claudeManagedPolicyUnenforcedKeys(claudeManagedSettings)'))
    expect(emit).toBeLessThan(at('const options: Options = {'))
    // GUARDED, which is the negative half: with nothing unenforced the operator
    // hears nothing, so the channel cannot become a line every session carries.
    expect(at('if (unenforcedManagedKeys.length > 0) {')).toBeLessThan(emit)
    // P6.541's withheld set rides the same channel, so the two managed facts an
    // administrator must act on are in one place.
    expect(at("this.queueDegradationNotice(i18n.t('chat.managedPolicy.autoModeAllowWithheld'"))
      .toBeLessThan(at('const options: Options = {'))
    // The full per-key explanation STAYS on debug — a session log is the right
    // place for thirty reasons, and this row only promoted the subset.
    expect(source).toContain('formatClaudeManagedSettingsDiagnostics(claudeManagedSettings)')
  })

  test('P6.613: both locales render the two notices, and neither leaks its key', () => {
    // An uninitialised i18next returns `undefined` from `t()`, which would make
    // the whole surface vanish on the headless entry — the measurement
    // `base-agent.ts` records and the reason the producer guards `setupI18n()`.
    if (!i18n.isInitialized) setupI18n()
    for (const locale of ['en', 'ru']) {
      const t = i18n.getFixedT(locale)
      const unenforced = t('chat.managedPolicy.unenforcedKeys', { keys: 'autoMode, workflow' })
      expect(unenforced, locale).toContain('autoMode, workflow')
      expect(unenforced, locale).not.toContain('chat.managedPolicy')
      const withheld = t('chat.managedPolicy.autoModeAllowWithheld')
      expect(withheld, locale).toContain('autoMode.allow')
      expect(withheld, locale).not.toContain('chat.managedPolicy')
    }
  })

  test('emits the diagnostics BEFORE the options literal, so an unmappable key is still said', () => {
    const diagnostics = at('formatClaudeManagedSettingsDiagnostics(claudeManagedSettings)')
    const literal = at('const options: Options = {')
    expect(diagnostics).toBeLessThan(literal)
  })

  test('spreads the option into the literal the SDK receives', () => {
    expect(at('...claudeManagedSettingsOptions,')).toBeGreaterThan(at('const options: Options = {'))
  })
})

// ============================================================
// P2.133 · the four keys the SDK silently drops.
//
// The row's sentence: a policy that reads as enforced and enforces nothing is
// worse than an absent key. Three parts, and each one kills a different
// mutation.
//
//  1. The EXTRACTION is pinned as a METHOD, not as symbol names. The minified
//     `Ebg`/`vbg` the module's docblock quotes will not survive a version bump,
//     so the anchor used here is a SETTINGS KEY that appears in the filter's own
//     first line. Bump the SDK and this fails, naming what to redo.
//  2. The four keys' verdicts are asserted as VERDICTS, not as prose. Flipping
//     one to `host-gate` without wiring anything fails.
//  3. The admin-surface helper reports exactly the measured `not-enforced`
//     ones — never the `unmeasured` ones, which are a lead, not a finding.
// ============================================================

/**
 * The version the filter extraction below was measured against.
 *
 * Moved 0.3.223 → 0.3.233 by S0-3 (2026-09-03) after re-running the method, not
 * on its own. The filter's copied allowlist is unchanged and none of the four
 * P2.133 keys is copied — but the SAME window gained a seventh copied key,
 * `disableCommandPluginSources`, which scored 0 occurrences in the whole 2.1.223
 * binary and 14 in 2.1.233. That is asserted below, so the next bump cannot let
 * it slip back out unnoticed, and the row it belongs to carries the consequence.
 *
 * Moved 0.3.233 → 0.3.247 by P7.1 (2026-09-10), again after re-running the
 * method. TWO things moved with it, and neither was a rename of the keys:
 *
 *  1. The filter's minified ACCUMULATOR went `r` → `n`, so the P3.285 shape
 *     assertion below — which had pinned that letter inside the string — broke
 *     on a bump that changed nothing semantically. It is a capture-bound regex
 *     now: the letter is read out of the first clause and required to be the
 *     same in the second, which is what "pin the method, not the symbols" means
 *     one level deeper than the docblock had taken it.
 *  2. The sandbox branch's FILESYSTEM half really did change, and P2.268's
 *     measurement with it — see that test.
 *
 * Moved 0.3.251 → 0.3.267 by F1.255 (2026-09-24), after re-running the method
 * on the lifted binary: all seven FILTER_COPIES are still copied, none of the
 * four P2.133 keys is, the restrictive pole and the single accumulator hold —
 * and the accumulator was renamed AGAIN (`n` → `o`), which broke the one
 * literal left, the `return r}` end control. It is capture-bound now, like the
 * shape assertion, so a rename can no longer fail it.
 *
 * Moved 0.3.267 → 0.3.274 by F1.1213 (2026-10-01), after re-running the method
 * on the lifted native binary: every extraction case in this file passed
 * unchanged (all seven FILTER_COPIES still copied, none of the four P2.133
 * keys, the capture-bound shape and end controls held) and only this constant
 * was red.
 *
 * Moved 0.3.274 → 0.3.280 by UA12.211 (2026-10-10), the same way: the three
 * extraction files ran together on the lifted bundle (112 pass / 3 fail /
 * "Ran 115 tests across 3 files") and every extraction case here passed
 * unchanged before this constant moved.
 */
const MEASURED_SDK_VERSION = '0.3.280'

/**
 * The keys the shipped CLI's restrictive-only filter copies, read out of the
 * binary at that version. Used as the POSITIVE CONTROL for the extraction: if
 * the window does not contain these, the anchor moved and an absence claim about
 * the four keys would be worthless.
 */
const FILTER_COPIES = [
  'allowManagedHooksOnly',
  'allowManagedMcpServersOnly',
  'allowManagedPermissionRulesOnly',
  'strictPluginOnlyCustomization',
  'deniedMcpServers',
  'enforceAvailableModels',
  // Arrived with 2.1.233 (S0-3): 0 occurrences anywhere in the 2.1.223 binary
  // and 14 in that one; re-measured 2026-09-12 on the vendored 2.1.247 at
  // 10 lines / 19 occurrences (C3.252 — "this one" used to mean 2.1.233 and the
  // sentence outlived the bundle it counted, which is the whole of that row).
  // Both instruments are named because they disagree on a minified artefact
  // (C3.294). Still inside the restrictive filter's copy list rather than
  // merely present. It is listed here as a control like the rest, so a later
  // bump that drops it fails loudly instead of leaving `claude-managed-settings.ts`
  // describing a native control that is gone again.
  'disableCommandPluginSources',
]

/** The four this row is about. */
const P2133_KEYS = [
  'disableAllHooks',
  'allowedHttpHookUrls',
  'httpHookAllowedEnvVars',
  'strictKnownMarketplaces',
] as const

/**
 * The bundled native CLI as text, memoised — and the memoisation is the fix for
 * a red, not a tidy-up (P7.1, 2026-09-10).
 *
 * Two tests here read the 233 MB binary, each with its own `readFileSync` +
 * `toString('latin1')`, i.e. about 466 MB allocated twice. Straight after the
 * `0.3.247` install the FIRST of them took 15.1 s against bun's 5 s per-test
 * default and failed as a timeout with zero assertion failures; the identical
 * bytes then cost 0.15 s (`user 0.06`, `sys 0.07`) on a warm page cache, and
 * every step inside the test measured ~110 ms in total. So the cost is the cold
 * read of a freshly-written artefact, not the work — exactly the shape AGENTS.md
 * warns reads as contention. It is latent rather than new: any fresh install of
 * any version pays it, and CI's cache is always cold.
 *
 * `claude-auto-compact-window-env.test.ts` already carries this same cache with
 * the same reasoning; this is the second copy, not a new idea. The cache holds
 * `undefined` too, so the off-platform arm still runs its declared assertion.
 */
let nativeBinaryCache: { text: string | undefined } | undefined

function nativeBinaryText(): string | undefined {
  if (nativeBinaryCache) return nativeBinaryCache.text
  const binary = fileURLToPath(new URL(
    '../../../../../node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude',
    import.meta.url,
  ))
  try {
    nativeBinaryCache = { text: readFileSync(binary).toString('latin1') }
  } catch {
    // A DECLARED skip, not a silence: the native CLI is per-platform, so this
    // dimension is unmeasurable on a non-darwin-arm64 host.
    expect(process.platform === 'darwin' && process.arch === 'arm64').toBe(false)
    nativeBinaryCache = { text: undefined }
  }
  return nativeBinaryCache.text
}

describe('P2.133 · the SDK restrictive filter, re-extracted by method', () => {
  const sdkPackage = (): { version: string } => JSON.parse(readFileSync(
    fileURLToPath(new URL('../../../../../node_modules/@anthropic-ai/claude-agent-sdk/package.json', import.meta.url)),
    'utf8',
  )) as { version: string }

  test('the vendored SDK is still the one the extraction was measured against', () => {
    // Not a version-pin for its own sake: every "the filter drops this key" row
    // in the module under test is a measurement of ONE build. When this fails,
    // re-run the method in the module docblock and re-record the verdicts —
    // do not edit this constant on its own.
    expect(sdkPackage().version).toBe(MEASURED_SDK_VERSION)
  })

  test('the filter body copies its allowlist and none of P2.133 four keys', () => {
    // The version assertion above still fails off-platform if the SDK version
    // moves, which is the part that must not depend on the platform.
    const text = nativeBinaryText()
    if (text === undefined) return
    // Anchor by a SETTINGS KEY, never by a minified symbol — that is the whole
    // "pin the method" instruction.
    const anchor = text.indexOf('allowManagedHooksOnly===!0')
    expect(anchor).toBeGreaterThan(-1)
    // D1.111 — an END ANCHOR read out of the bundle, which is the ONLY honest
    // bound on a minified artefact: `bracedRegion` is for code whose braces
    // balance textually, and the first `{` after this anchor is an object
    // literal mid-filter anyway. The filter ends at `return r}`, and the next
    // thing the binary spells is a settings-key SET whose first member is a real
    // env name — stable across builds, where the minified binding beside it
    // (`jo` today) rots with every one. Measured 2026-09-18 at the vendored
    // 2.1.247: the filter body is 2 747 characters from this anchor, so the old
    // 1 600-character window read 58 % of it — and every claim below except the
    // copy list is a NEGATIVE, which an under-read satisfies silently. The four
    // keys are still absent over the whole body; the finding is unchanged and
    // now measured over all of it.
    const filterEnd = text.indexOf('ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION', anchor)
    expect(filterEnd).toBeGreaterThan(anchor)
    const body = text.slice(anchor, filterEnd)
    // BOUNDARY CONTROL: the region is the filter and not the rest of a 233 MB
    // binary, in which every one of these keys occurs somewhere.
    expect(body.length).toBeLessThan(20_000)
    // The filter's own `return <accumulator>}`, the accumulator read out of the
    // first clause (F1.255: a literal `return r}` broke on the 0.3.267 rename).
    const accumulator = /allowManagedHooksOnly===!0\)([\w$]+)\./.exec(body)?.[1]
    expect(accumulator, 'the first clause of the filter moved').toBeDefined()
    expect(body).toContain(`return ${accumulator}}`)
    // Positive control: this really is the filter, not some other mention.
    for (const key of FILTER_COPIES) expect(body, `filter should copy ${key}`).toContain(key)
    // Negative control for the window itself: a key that cannot be in it is not.
    expect(body).not.toContain('nessyNotARealSdkKey')
    // The measurement: none of the four is copied.
    for (const key of P2133_KEYS) expect(body, `filter must not copy ${key}`).not.toContain(key)
    // P3.285 — the SHAPE, not just the presence. The mapper emits this key at
    // its restrictive pole only, and this expression is the whole reason: a
    // delivered `false` is dropped by the filter, so sending one could never do
    // anything but look like enforcement. If a later bundle widens the test to
    // `!==void 0`, the tri-state question re-opens and this fails first.
    //
    // CAPTURE-BOUND, and P7.1 is why (2026-09-10). This was a literal carrying
    // the filter's minified accumulator, `r`. The 0.3.233 → 0.3.247 bump renamed
    // it to `n` and nothing else — the two bodies are otherwise byte-identical:
    //
    //   0.3.233  …allowManagedHooksOnly===!0)r.allowManagedHooksOnly=!0;if(e.disableCommandPluginSources===!0)r.disableCommandPluginSources=!0;…
    //   0.3.247  …allowManagedHooksOnly===!0)n.allowManagedHooksOnly=!0;if(e.disableCommandPluginSources===!0)n.disableCommandPluginSources=!0;…
    //
    // so the test failed while the tri-state question it guards had NOT
    // re-opened. Re-pinning the new letter would only schedule the same failure
    // for the next bump; the backreference asserts what actually matters — one
    // accumulator, both clauses at the `===!0` pole.
    const shape = /allowManagedHooksOnly===!0\)(\w+)\.allowManagedHooksOnly=!0;if\(e\.disableCommandPluginSources===!0\)\1\.disableCommandPluginSources=!0/
    expect(shape.exec(body), 'the restrictive pole or the single accumulator moved').not.toBeNull()
  })
})

describe('P2.133 · every no-sdk-tier key states what enforces it', () => {
  /** Every key set at once, so the mapping reports the whole gap surface. */
  const everyGap = (): ReturnType<typeof mapManagedPolicyToClaudeSettings> =>
    mapManagedPolicyToClaudeSettings(policy({
      disableAllHooks: true,
      allowedHttpHookUrls: ['https://hooks.corp.example/*'],
      httpHookAllowedEnvVars: ['CORP_TOKEN'],
      strictKnownMarketplaces: [{ source: 'hostPattern', hostPattern: '^gitlab\\.corp\\.example$' }],
      autoCompactEnabled: false,
      cleanupPeriodDays: 30,
      // P6.74: the third-verdict control. `cleanupPeriodDays` used to play it
      // and is now `host-gate`.
      channelsEnabled: false,
      // P6.117: the `not-enforced` control. The http-hook pair played it until
      // that row gave claude and codex the runner that applies both keys, so the
      // fourth verdict needs the key that still carries it.
      autoMode: { environment: ['Production payment infrastructure.'] },
    }))

  test('the four carry the verdict that was measured, not a reassuring one', () => {
    const byKey = new Map(everyGap().unsupported.map(gap => [gap.key, gap]))
    // Every one of the four must actually be reported as a gap — a mapping that
    // stopped reporting them would satisfy an "is not host-gate" check vacuously.
    for (const key of P2133_KEYS) expect(byKey.has(key), `${key} is not reported at all`).toBe(true)
    const verdictOf = (key: string): string => {
      const gap = byKey.get(key)!
      return gap.kind === 'no-sdk-tier' ? gap.enforcement : gap.kind
    }
    // P2.206 moved this one, and only this one: the automation builder now reads
    // the managed policy floor itself and refuses to build a hook system at all,
    // so the key is enforced by a gate of ours on every runtime. Flipping it
    // back without unwiring `buildPinnedAgentAutomationSystem` fails the
    // behavioural half in `capabilities/__tests__/runtime-automations.test.ts`.
    expect(verdictOf('disableAllHooks')).toBe('host-gate')
    // P6.117 moved this pair, and only this pair: `pluginHttpHookRunner` — the
    // one production caller of `matchesHttpHookUrlPattern` and of
    // `interpolateHttpHookHeaders` — is supplied wherever
    // `PLUGIN_HOOK_ACTION_RUNNERS` lists `'http'`, which now includes
    // `anthropic`. Flipping them back without narrowing that record fails the
    // behavioural half in
    // `server-core/src/sessions/SessionManager.plugin-hook-runners.test.ts`.
    expect(verdictOf('allowedHttpHookUrls')).toBe('host-gate')
    expect(verdictOf('httpHookAllowedEnvVars')).toBe('host-gate')
    // P6.541 moved the last `not-enforced` entry, so the "not everything is
    // host-gate" dimension is carried by the SYNTHETIC control rather than by a
    // key that no longer qualifies — see `withSyntheticUnenforcedGap`.
    expect(verdictOf('autoMode')).toBe('host-gate')
    // The one that IS enforced, and the negative control for the three above:
    // "everything is unenforced" cannot satisfy both halves of this test.
    expect(verdictOf('strictKnownMarketplaces')).toBe('host-gate')
    // P3.233 — the verdict this row corrected. It read `unmeasured` while
    // P6.53's projection was already binding, so the module told an
    // administrator nobody had checked a key that works. `host-gate` is the
    // measurement; flipping it back without unwiring
    // `buildClaudeAutoCompactionEnv` fails the behavioural half in
    // `claude-auto-compact-window-env.test.ts`.
    expect(verdictOf('autoCompactEnabled')).toBe('host-gate')
    // P6.74 — the second key this describe block has had to re-verdict, and for
    // the same reason: the module said nobody had checked a key that binds.
    // `registerManagedRetentionDaysProvider` feeds `ensureConfigDir()`'s sweep
    // from the ENFORCED composition with no provider term anywhere on the path.
    expect(verdictOf('cleanupPeriodDays')).toBe('host-gate')
    // P6.341 — the third key this describe block has had to re-verdict, and the
    // one that emptied the `unmeasured` class entirely. `channelsEnabled` read
    // "measured, and neither pole true of it": nothing applied the key on claude
    // AND nothing could push there. Our own pool now arms the dispatcher on
    // claude and codex behind the server's `claude/channel` declaration, so
    // `resolveManagedChannelPolicy` reads the key here. Flipping it back without
    // narrowing `MCP_CHANNEL_PUSH_SUPPORT` fails the behavioural half in
    // `server-core/src/sessions/__tests__/mcp-channel-gate.test.ts`.
    expect(verdictOf('channelsEnabled')).toBe('host-gate')
    // EVERY no-sdk-tier verdict on this run is now `host-gate` (P6.541 moved the
    // last one), which would make the assertions above vacuous on their own —
    // so the counterexample is supplied deliberately instead of pretended.
    expect(saysNothingAppliesIt(everyGap())).toBe(true)
  })

  test('the admin surface lists the measured-unenforced keys and only those', () => {
    const mapping = everyGap()
    // `disableAllHooks` left this list in P2.206, the two http-hook keys in
    // P6.117, and `autoMode` in P6.541 — an administrator must not be warned
    // that a switch which now works does nothing. The list is therefore EMPTY
    // over the real table, which is the strongest state it has ever been in and
    // NOT a reason to stop asserting: the filter is proved to still filter by
    // the synthetic gap on the next line.
    expect([...claudeManagedPolicyUnenforcedKeys(mapping)]).toEqual([])
    expect([...claudeManagedPolicyUnenforcedKeys(withSyntheticUnenforcedGap(mapping))])
      .toEqual([SYNTHETIC_UNENFORCED_KEY])
    // The pair that just left, asserted by name: this is the whole
    // administrator-facing consequence of P6.117.
    expect(claudeManagedPolicyUnenforcedKeys(mapping)).not.toContain('allowedHttpHookUrls')
    expect(claudeManagedPolicyUnenforcedKeys(mapping)).not.toContain('httpHookAllowedEnvVars')
    // An `unmeasured` key is a lead, not a finding: it is a reported gap and it
    // must NOT reach the administrator's warning list. `channelsEnabled` since
    // P6.74 — `autoCompactEnabled` held this role while its verdict was the
    // wrong `unmeasured`, then `cleanupPeriodDays`, and both are `host-gate`
    // now. For this one the exclusion is load-bearing rather than cautious: the
    // restriction it asks for HOLDS on claude, so warning about it would be the
    // false alarm P3.60 measured, pointed the dangerous way.
    expect(mapping.unsupported.some(gap => gap.key === 'channelsEnabled')).toBe(true)
    expect(claudeManagedPolicyUnenforcedKeys(mapping)).not.toContain('channelsEnabled')
    expect(mapping.unsupported.some(gap => gap.key === 'cleanupPeriodDays')).toBe(true)
    expect(claudeManagedPolicyUnenforcedKeys(mapping)).not.toContain('cleanupPeriodDays')
    // Neither does a `host-gate` key: the gate applies it, so warning about it
    // would train an administrator to ignore this list.
    expect(mapping.unsupported.some(gap => gap.key === 'autoCompactEnabled')).toBe(true)
    expect(claudeManagedPolicyUnenforcedKeys(mapping)).not.toContain('autoCompactEnabled')
    // Positive control: a policy with none of the three reports an empty list,
    // so the helper is filtering rather than returning a constant.
    expect(claudeManagedPolicyUnenforcedKeys(
      mapManagedPolicyToClaudeSettings(policy({ autoCompactEnabled: false })),
    )).toEqual([])
  })
})

// ============================================================
// P2.481 · the blocklist's verdict, RECORDED rather than re-derived.
//
// P2.467 measured it: the shipped binary reads `blockedMarketplaces` natively
// and the mechanism is unreachable — it reads the OS policy tier this fork does
// not write, our one channel's copy set carries the key zero times against a
// sibling's three, and it would guard the binary's own registry on one runtime
// of three. So the enforcement that fires is ours, at boot, on every runtime,
// which is `host-gate`.
//
// The cautious value would be an ALARM, not a hedge, and that is the whole
// reason this block exists beside P3.60's: `not-enforced` feeds the list a UI
// shows as "your policy is not in effect" and prints "nothing applies it here"
// about a blocklist that blocks. P3.60 measured exactly that inversion once
// already.
// ============================================================

describe('P2.481 · the marketplace blocklist is applied on claude, and says so', () => {
  const blockPolicy = (): ManagedPiPolicyV1 => policy({
    blockedMarketplaces: [{ source: 'github', repo: 'untrusted/plugins' }],
    // Beside a MEASURED `not-enforced` key, so no assertion below can be
    // satisfied by a blanket verdict. The http-hook pair played this part until
    // P6.117 gave claude and codex the runner that applies both; `autoMode` is
    // the key still measured `not-enforced`.
    autoMode: { environment: ['Production payment infrastructure.'] },
  })

  test('the verdict is the measured host-gate, and it matches its allowlist twin', () => {
    const mapping = mapManagedPolicyToClaudeSettings(blockPolicy())
    const gap = mapping.unsupported.find(entry => entry.key === 'blockedMarketplaces')
    // Positive control: reported at all. A mapping that stopped reporting it
    // would satisfy every "is not X" check below vacuously.
    expect(gap, 'blockedMarketplaces is not reported as a gap at all').toBeDefined()
    expect(gap!.kind).toBe('no-sdk-tier')
    expect(gap!.kind === 'no-sdk-tier' ? gap!.enforcement : gap!.kind).toBe('host-gate')
    // The reason has to name the gates, because the row this closes is a gate
    // that existed with no feed — "our marketplace gate applies it" was true of
    // the code and false of production.
    expect(gap!.reason).toContain('add, upgrade, load and delivery')
  })

  test('an administrator is NOT told their blocklist is not in effect', () => {
    const mapping = mapManagedPolicyToClaudeSettings(blockPolicy())
    expect(claudeManagedPolicyUnenforcedKeys(mapping)).not.toContain('blockedMarketplaces')
    // Positive control: the helper is still filtering rather than returning a
    // constant. Synthetic since P6.541 emptied the real class.
    expect([...claudeManagedPolicyUnenforcedKeys(withSyntheticUnenforcedGap(mapping))])
      .toEqual([SYNTHETIC_UNENFORCED_KEY])
  })

  test('the diagnostic is the cannot-carry sentence, never the nothing-applies-it one', () => {
    const lines = formatClaudeManagedSettingsDiagnostics(
      mapManagedPolicyToClaudeSettings(blockPolicy()),
    )
    const blockLines = lines.filter(line => line.includes('blockedMarketplaces'))
    expect(blockLines).toHaveLength(1)
    expect(blockLines[0])
      .toStartWith('[managed] claude policy tier cannot carry blockedMarketplaces (no-sdk-tier):')
    // The exact string a `not-enforced` verdict would print instead — the
    // admin-facing half, and the assertion a wrong-pole mutant has to trip.
    expect(blockLines[0]).not.toContain('does NOT enforce blockedMarketplaces')
    expect(blockLines[0]).not.toContain('nothing applies it here')
    // Positive control: that sentence IS still produced for a key it is true of,
    // so "the formatter never says it" cannot pass this test. Synthetic since
    // P6.541 emptied the real `not-enforced` class.
    expect(saysNothingAppliesIt(mapManagedPolicyToClaudeSettings(blockPolicy()))).toBe(true)
  })
})

// ============================================================
// P3.60 · the workflow verdict, and the two siblings still carrying its shape.
//
// The row arrived asking for `not-enforced`, and `not-enforced` is a WARNING:
// `claudeManagedPolicyUnenforcedKeys` is the list a UI shows as "your policy is
// not in effect", and the diagnostic line for it says "nothing applies it here".
// Two gates apply it, neither provider-gated, so the row's own proposed fix
// would have swapped one wrong admin-facing message for another. The tests here
// pin the verdict AND the sentence, because the sentence is the product.
// ============================================================

describe('P3.60 · the workflow key is applied on claude, and says so', () => {
  const workflowPolicy = (): ManagedPiPolicyV1 => policy({
    workflow: { disableWorkflows: true },
    // Beside a MEASURED `not-enforced` key, so every assertion below has a live
    // counterexample on the same run: a blanket verdict cannot pass. The
    // http-hook pair played this part until P6.117.
    autoMode: { environment: ['Production payment infrastructure.'] },
  })

  test('the verdict is the measured host-gate, not the reassuring unmeasured', () => {
    const mapping = mapManagedPolicyToClaudeSettings(workflowPolicy())
    const gap = mapping.unsupported.find(entry => entry.key === 'workflow')
    // Positive control: the key must be REPORTED at all. A mapping that stopped
    // reporting it would satisfy every "is not X" check below vacuously.
    expect(gap, 'workflow is not reported as a gap at all').toBeDefined()
    expect(gap!.kind).toBe('no-sdk-tier')
    expect(gap!.kind === 'no-sdk-tier' ? gap!.enforcement : gap!.kind).toBe('host-gate')
    // The reason has to name the gates, because "our workflow gate enforces it"
    // beside `unmeasured` is what this row found.
    expect(gap!.reason).toContain('slash-command and plugin-command gates')
  })

  test('an administrator is NOT warned that their workflow ban does nothing', () => {
    const mapping = mapManagedPolicyToClaudeSettings(workflowPolicy())
    // The whole point of the row: `workflow` must not reach the warning list.
    expect(claudeManagedPolicyUnenforcedKeys(mapping)).not.toContain('workflow')
    // Positive control: the helper is still filtering rather than returning a
    // constant. Synthetic since P6.541 emptied the real class.
    expect([...claudeManagedPolicyUnenforcedKeys(withSyntheticUnenforcedGap(mapping))])
      .toEqual([SYNTHETIC_UNENFORCED_KEY])
  })

  test('the diagnostic line is the cannot-carry sentence, never the nothing-applies-it one', () => {
    const lines = formatClaudeManagedSettingsDiagnostics(
      mapManagedPolicyToClaudeSettings(workflowPolicy()),
    )
    const workflowLines = lines.filter(line => line.includes('workflow'))
    expect(workflowLines).toHaveLength(1)
    expect(workflowLines[0]).toStartWith('[managed] claude policy tier cannot carry workflow (no-sdk-tier):')
    // The exact string a `not-enforced` verdict would print instead. This is the
    // admin-facing half, and it is the assertion the mutant has to trip.
    expect(workflowLines[0]).not.toContain('does NOT enforce workflow')
    expect(workflowLines[0]).not.toContain('nothing applies it here')
    // Positive control: that sentence IS still produced for a key it is true of
    // — so "the formatter never says it" cannot pass this test. Synthetic since
    // P6.541 emptied the real `not-enforced` class.
    expect(saysNothingAppliesIt(mapManagedPolicyToClaudeSettings(workflowPolicy()))).toBe(true)
  })
})

describe('P3.60 · the unmeasured set is pinned, so the asserting pattern cannot grow', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../claude-managed-settings.ts', import.meta.url)),
    'utf8',
  )
  const gapsTable = (): string => {
    const start = source.indexOf('const CLAUDE_MANAGED_GAPS')
    expect(start).toBeGreaterThan(-1)
    const end = source.indexOf('\n})\n', start)
    expect(end).toBeGreaterThan(start)
    return source.slice(start, end)
  }
  const unmeasuredKeys = (): string[] => {
    const keys: string[] = []
    for (const match of gapsTable().matchAll(/^ {2}(\w+): \{(.*?)^ {2}\},/gms)) {
      if (match[2]!.includes("enforcement: 'unmeasured'")) keys.push(match[1]!)
    }
    return keys.sort()
  }

  const reasonOf = (key: string): string => {
    const match = gapsTable().match(new RegExp(`^ {2}${key}: \\{(.*?)^ {2}\\},`, 'ms'))
    expect(match, `${key} is not in the gaps table`).not.toBeNull()
    return match![1]!.match(/reason: '(.*)',/s)![1]!
  }

  test('exactly these keys carry no claim — thirteen, then twelve, then eight, five, two, now none', () => {
    // Pinned as a SET rather than a count: a count tells the next reader that
    // something moved, the set tells them WHICH key they now owe a verdict for.
    // `workflow` left in P3.60; `claudeMdExcludes`, `env` and the version pair
    // left in P3.254; the three DOMAIN-assigning ones left in P3.257 (b), which
    // measured all three to `host-gate` — a reason that states a domain with no
    // agent-session term does not mean unenforced, it means enforced host-wide.
    //
    // P6.74 measured the last five. `cleanupPeriodDays` and
    // `connectSourcesOnStartup` are `host-gate` and `autoMode` is
    // `not-enforced`, so three more left. The channel pair stayed, and it was
    // the first pair here that stayed for a reason other than "nobody looked":
    // it was measured and neither pole was true of it — nothing read the key on
    // claude AND nothing could push there.
    //
    // P6.341 removed the second half of that, so the first half went with it.
    // Our own pool now arms the dispatcher on claude and codex behind the
    // server's `claude/channel` declaration, `resolveManagedChannelPolicy` is
    // read there, and both keys are `host-gate`. The set is EMPTY, which is not
    // the end of this pin: it is the strongest form of it. A key that arrives
    // here from now on is a key somebody left without a verdict, and this
    // assertion names it on the next run.
    expect(unmeasuredKeys()).toEqual([])
    // The three P3.257 (b) measured must not come back as leads.
    expect(unmeasuredKeys()).not.toContain('disableInAppBrowser')
    expect(unmeasuredKeys()).not.toContain('disableInAppUpdates')
    expect(unmeasuredKeys()).not.toContain('forceRemoteSettingsRefresh')
    // Nor the three P6.74 measured.
    expect(unmeasuredKeys()).not.toContain('autoMode')
    expect(unmeasuredKeys()).not.toContain('cleanupPeriodDays')
    expect(unmeasuredKeys()).not.toContain('connectSourcesOnStartup')
    // Nor the pair P6.341 measured.
    expect(unmeasuredKeys()).not.toContain('channelsEnabled')
    expect(unmeasuredKeys()).not.toContain('allowedChannelServers')
    // The extraction is still WORKING on an empty result, not silently matching
    // nothing: the same regex must find a key that IS in the table.
    expect(reasonOf('channelsEnabled')).toContain('channel')
    // Negative control for the extraction itself: a key that IS measured must
    // not appear, or the regex is matching the whole file rather than the table.
    expect(unmeasuredKeys()).not.toContain('workflow')
    expect(unmeasuredKeys()).not.toContain('autoCompactEnabled')
  })

  test('every remaining unmeasured reason is pinned, so a new asserting one is visible here', () => {
    // P3.254 replaces the three-reason pin this block used to carry. That pin
    // could only catch a change to the reasons it named; the class it guards is
    // "an `unmeasured` entry whose reason claims a mechanism of ours applies the
    // key", and a fourth one could appear on ANY of the survivors. Pinning all
    // eight is the only mechanical way to make that visible, and it is what the
    // `ClaudeManagedPolicyEnforcementV1` docblock now promises.
    const reasons = Object.fromEntries(unmeasuredKeys().map(key => [key, reasonOf(key)]))
    // P3.257 (b) removed the three domain-assigning reasons from this map by
    // MEASURING them, not by rewording them, and P6.74 removed three more the
    // same way. What is left is a FOURTH shape, and the reasons have to carry it
    // because the STATE cannot: each of these two says the key was measured and
    // that neither enforcement pole states the result truthfully. A reason here
    // that goes back to a bare "our own concept" is the regression this pin
    // exists to show.
    // P6.341 emptied the class: the channel pair was its last carrier and both
    // keys are `host-gate` now. An empty pin is still the pin — the next key
    // that arrives without a verdict is printed here by name, with its reason
    // beside it, which is exactly the reading this block was written to give.
    expect(reasons).toEqual({})
    // The FOURTH-class marker itself, asserted rather than left to the prose: a
    // reason that no longer says the key was measured would put a key back into
    // the "nobody looked" class the state alone reports. Vacuous while the set
    // is empty, and deliberately kept for the run where it is not.
    for (const key of unmeasuredKeys()) expect(reasonOf(key)).toContain('measured')
  })
})

// ============================================================
// P6.74 · the last five keys nobody had scored, one key at a time.
//
// Method verbatim from P3.254 and P3.257 (b): measure the CALL GRAPH, never
// reword the reason. Three of the five moved and two did not, and the two that
// did not are a class this vocabulary cannot state — see the
// `ClaudeManagedPolicyEnforcementV1` docblock. A new state was refused: it
// changes what an administrator is shown and is the owner's call.
// ============================================================

describe('P6.74 · the last five managed keys carry a measured verdict', () => {
  /** All five set at once, plus the control key, so one mapping answers all six. */
  const fivePolicy = (): ManagedPiPolicyV1 => policy({
    channelsEnabled: false,
    allowedChannelServers: ['corp-mcp'],
    autoMode: { environment: ['Production payment infrastructure.'] },
    cleanupPeriodDays: 30,
    connectSourcesOnStartup: false,
    // Control: a key already scored `host-gate` by P3.257 (b) must reproduce
    // that verdict on this rig, or the rig is not measuring anything.
    disableInAppUpdates: true,
  })

  const verdicts = (): Record<string, string> => {
    const mapping = mapManagedPolicyToClaudeSettings(fivePolicy())
    const byKey = new Map(mapping.unsupported.map(gap => [gap.key, gap]))
    const out: Record<string, string> = {}
    for (const key of [
      'channelsEnabled',
      'allowedChannelServers',
      'autoMode',
      'cleanupPeriodDays',
      'connectSourcesOnStartup',
      'disableInAppUpdates',
    ]) {
      // Positive control per key: a key that is not REPORTED at all would make
      // every verdict assertion pass vacuously.
      const gap = byKey.get(key)
      expect(gap, `${key} is not reported as a gap at all`).toBeDefined()
      out[key] = gap!.kind === 'no-sdk-tier' ? gap!.enforcement : gap!.kind
    }
    return out
  }

  test('three moved, two stayed, and the control reproduces', () => {
    expect(verdicts()).toEqual({
      // Our own retention sweep reads the ENFORCED managed value through
      // `registerManagedRetentionDaysProvider`, with no provider term anywhere
      // on the path — the host-wide shape `disableInAppUpdates` already holds.
      cleanupPeriodDays: 'host-gate',
      // `maybeConnectSourcesAtSessionStart` resolves the managed value with no
      // provider term and returns before the registry is touched.
      connectSourcesOnStartup: 'host-gate',
      // P6.541 — the last `not-enforced` entry, and it moved: the builder now
      // appends the administrator's `environment`/`hard_deny`/`soft_deny` onto
      // the same `Options.settings` block, so their prose reaches the
      // classifier's prompt. Only `allow` is withheld, and it is refused by
      // name rather than dropped.
      autoMode: 'host-gate',
      // P6.341 — was `unmeasured` ("nothing reads them here AND nothing can push
      // here either"). Both halves of that measurement moved in one commit: our
      // own pool now arms the dispatcher on claude, behind the server's
      // `claude/channel` declaration, so `resolveManagedChannelPolicy` is read
      // here and the keys bind.
      channelsEnabled: 'host-gate',
      allowedChannelServers: 'host-gate',
      // The control.
      disableInAppUpdates: 'host-gate',
    })
  })

  test('only the real alarm reaches the administrator, and it reaches it', () => {
    const mapping = mapManagedPolicyToClaudeSettings(fivePolicy())
    // POSITIVE: the list still SAYS the thing it exists to say. Its subject is
    // synthetic since P6.541 moved `autoMode` — which is now on the negative
    // side, and asserted there rather than deleted.
    expect(claudeManagedPolicyUnenforcedKeys(mapping)).not.toContain('autoMode')
    expect([...claudeManagedPolicyUnenforcedKeys(withSyntheticUnenforcedGap(mapping))])
      .toEqual([SYNTHETIC_UNENFORCED_KEY])
    const lines = formatClaudeManagedSettingsDiagnostics(mapping)
    expect(saysNothingAppliesIt(mapping)).toBe(true)
    // NEGATIVE: the channel pair must NOT — and since P6.341 for a stronger
    // reason than before. It used to be "no source can push here at all"; it is
    // now "our own gate applies the key here", which is what `host-gate` means.
    // Either way, printing "not in effect" would be the P3.60 inversion pointed
    // the dangerous way.
    for (const key of ['channelsEnabled', 'allowedChannelServers']) {
      expect(claudeManagedPolicyUnenforcedKeys(mapping), `${key} reached the warning list`)
        .not.toContain(key)
      expect(lines.some(line => line.includes(`does NOT enforce ${key}`))).toBe(false)
      // …and they are still REPORTED, so the exclusion is a verdict rather than
      // the mapping having lost the keys.
      expect(lines.some(line => line.includes(`cannot carry ${key} (no-sdk-tier)`))).toBe(true)
    }
    // Nor do the two that were measured to bind.
    for (const key of ['cleanupPeriodDays', 'connectSourcesOnStartup']) {
      expect(claudeManagedPolicyUnenforcedKeys(mapping), `${key} reached the warning list`)
        .not.toContain(key)
    }
  })

  test('the fact the channel verdict rests on is pinned where it lives', () => {
    // The whole measurement in one line: channel push is armed only under
    // `runtimeReceivesMcpChannelPush(provider)`. It answered false for the
    // claude backend until P6.341, and the alarm this assertion exists to be
    // did fire when that record flipped — the two entries above were
    // re-measured in the same commit rather than left saying `unmeasured`
    // beside a runtime that now reads the key.
    expect(runtimeReceivesMcpChannelPush('anthropic')).toBe(true)
    expect(runtimeReceivesMcpChannelPush('codex-runtime')).toBe(true)
    expect(runtimeReceivesMcpChannelPush('pi')).toBe(true)
    // Negative control on the same call: the record is not answering true to
    // everything. The remote agent runs no local pool, so it arms nothing.
    expect(runtimeReceivesMcpChannelPush('nestor-cloud-agent')).toBe(false)
  })

  test('the claude classifier block carries the org prose — the update P6.74 predicted', () => {
    // P6.74 wrote: "when a later row widens it to take the managed block, this
    // assertion is the one that must be updated, which is the point of writing
    // it." P6.541 is that row, so this is that update.
    const ours = buildClaudeAutoModePolicySettings({ gatewayUpstream: false }).autoMode
    expect(Object.keys(ours).sort()).toEqual(['environment', 'hard_deny', 'soft_deny'])
    // Positive control: the block is non-empty, so nothing below is satisfied by
    // an empty object.
    expect(ours.hard_deny?.length ?? 0).toBeGreaterThan(0)
    const withOrg = buildClaudeAutoModePolicySettings({
      gatewayUpstream: false,
      managedAutoMode: { hard_deny: ['Never touch the payments ledger.'], allow: ['anything'] },
    }).autoMode
    expect(withOrg.hard_deny).toEqual([...ours.hard_deny!, 'Never touch the payments ledger.'])
    // `allow` is the one set a floor never grants, on any runtime.
    expect(withOrg.allow).toBeUndefined()
  })
})

// ============================================================
// P3.254 · the last two asserting reasons, and the pair excluded as the
// "nearest miss".
//
// P3.60 left three findings for this row: two `unmeasured` entries whose reason
// named a mechanism of OURS as the present-tense agent of applying the key, and
// one deliberate exclusion made under time pressure. All four keys measured to
// `host-gate` — neither the value they carried nor the cautious `not-enforced`
// the class invites — and the four answers are not one answer:
//
//  - `claudeMdExcludes`: the assertion was TRUE and INCOMPLETE. Our inventory
//    drops the file on every runtime; the SDK child re-discovers
//    User/Project/Local CLAUDE.md through its own cascade, which our managed
//    value cannot reach. A restricting pole, so the residue is in the REASON,
//    where an administrator reads it — not only in a comment.
//  - `env`: the assertion was simply TRUE, measured through one host writer and
//    the child env spread.
//  - `requiredMinimumVersion`/`requiredMaximumVersion`: excluded as a near miss,
//    and they carry the strongest enforcement in the table — a startup refusal
//    in both hosts, before any session of any provider exists.
//
// Each verdict is asserted three ways, because P3.60 measured that the verdict,
// the warning list and the admin-facing sentence can disagree: the sentence is
// the product.
// ============================================================

describe('P3.254 · the four keys are applied on claude, and say so', () => {
  const P3254_KEYS = ['claudeMdExcludes', 'env', 'requiredMinimumVersion', 'requiredMaximumVersion'] as const

  /** All four set, beside the two MEASURED `not-enforced` keys and one that is
   * still `unmeasured`, so no blanket verdict can satisfy this suite. */
  const measuredPolicy = (): ManagedPiPolicyV1 => policy({
    claudeMdExcludes: ['**/vendor/**/CLAUDE.md'],
    env: { CORP_TELEMETRY_ENDPOINT: 'https://otel.corp.example' },
    requiredMinimumVersion: '1.0.0',
    requiredMaximumVersion: '9.0.0',
    // The MEASURED `not-enforced` control. The http-hook pair held this role
    // until P6.117 wired their enforcer onto claude and codex.
    autoMode: { environment: ['Production payment infrastructure.'] },
    cleanupPeriodDays: 30,
    // P6.74 measured `cleanupPeriodDays` to `host-gate`, so the third-verdict
    // control below needs a key that still carries no claim. `channelsEnabled`
    // is the one, and it carries it for a NEW reason — measured, and neither
    // pole true of it.
    channelsEnabled: false,
  })

  test('all four carry the measured host-gate, not the reassuring unmeasured', () => {
    const mapping = mapManagedPolicyToClaudeSettings(measuredPolicy())
    const byKey = new Map(mapping.unsupported.map(gap => [gap.key, gap]))
    for (const key of P3254_KEYS) {
      // Positive control: the key must be REPORTED at all, or every "is not X"
      // assertion below passes vacuously.
      const gap = byKey.get(key)
      expect(gap, `${key} is not reported as a gap at all`).toBeDefined()
      expect(gap!.kind).toBe('no-sdk-tier')
      expect(gap!.kind === 'no-sdk-tier' ? gap!.enforcement : gap!.kind, `${key} verdict`).toBe('host-gate')
    }
    // A second verdict still exists on the same run, so `host-gate` is not a
    // blanket answer: the http-hook pair is measured unenforced. The
    // `unmeasured` carrier this line used to hold was `cleanupPeriodDays`, then
    // `channelsEnabled` — P6.341 measured the second one into `host-gate` too,
    // and there is no third, so the dimension is now carried by `not-enforced`
    // alone rather than swapped again.
    const verdictOf = (key: string): string => {
      const gap = byKey.get(key)!
      return gap.kind === 'no-sdk-tier' ? gap.enforcement : gap.kind
    }
    expect(verdictOf('channelsEnabled')).toBe('host-gate')
    expect(verdictOf('cleanupPeriodDays')).toBe('host-gate')
    // P6.541 moved the last `not-enforced` entry, so the counterexample this
    // block needs is supplied rather than borrowed from a key that no longer
    // qualifies.
    expect(verdictOf('autoMode')).toBe('host-gate')
    expect(saysNothingAppliesIt(mapping)).toBe(true)
  })

  test('no administrator is warned that these four do nothing', () => {
    const mapping = mapManagedPolicyToClaudeSettings(measuredPolicy())
    for (const key of P3254_KEYS) {
      expect(claudeManagedPolicyUnenforcedKeys(mapping), `${key} reached the warning list`).not.toContain(key)
    }
    // Positive control: the helper is still filtering rather than returning a
    // constant. Synthetic since P6.541 emptied the real class.
    expect([...claudeManagedPolicyUnenforcedKeys(withSyntheticUnenforcedGap(mapping))])
      .toEqual([SYNTHETIC_UNENFORCED_KEY])
  })

  test('each diagnostic is the cannot-carry sentence, never the nothing-applies-it one', () => {
    const lines = formatClaudeManagedSettingsDiagnostics(
      mapManagedPolicyToClaudeSettings(measuredPolicy()),
    )
    for (const key of P3254_KEYS) {
      const own = lines.filter(line => line.includes(`carry ${key} `) || line.includes(`enforce ${key} `))
      expect(own, `${key} has no diagnostic line`).toHaveLength(1)
      expect(own[0]).toStartWith(`[managed] claude policy tier cannot carry ${key} (no-sdk-tier):`)
      // The exact strings a `not-enforced` verdict would print instead. This is
      // the admin-facing half, and the one a reverted verdict has to trip.
      expect(own[0]).not.toContain(`does NOT enforce ${key}`)
      expect(own[0]).not.toContain('nothing applies it here')
    }
    // Positive control: that sentence IS still produced for a key it is true of,
    // so "the formatter never says it" cannot pass this test. Synthetic since
    // P6.541 emptied the real `not-enforced` class.
    expect(saysNothingAppliesIt(mapManagedPolicyToClaudeSettings(measuredPolicy()))).toBe(true)
  })

  test('claudeMdExcludes states the residue in the reason, because it is a restricting pole', () => {
    const mapping = mapManagedPolicyToClaudeSettings(measuredPolicy())
    const gap = mapping.unsupported.find(entry => entry.key === 'claudeMdExcludes')
    expect(gap, 'claudeMdExcludes is not reported as a gap at all').toBeDefined()
    // The gate half — without it the verdict is unexplained.
    expect(gap!.reason).toContain('our capability inventory drops every matching instruction and memory file on every runtime')
    // The residue half, which is the honest part and the reason `host-gate` is
    // not the whole story: a `host-gate` reason that omits it would read as
    // "fully applied", which is the failure this row exists to remove.
    expect(gap!.reason).toContain('the SDK child re-discovers User/Project/Local CLAUDE.md through its own settings cascade')
    // Negative control on the same string: the residue must not be written as a
    // total failure either.
    expect(gap!.reason).not.toContain('nothing applies')
  })

  test('env and the version pair name the gate that applies them', () => {
    const mapping = mapManagedPolicyToClaudeSettings(measuredPolicy())
    const reasonFor = (key: string): string =>
      mapping.unsupported.find(entry => entry.key === key)!.reason
    expect(reasonFor('env')).toContain('writes the composed block into the host process environment at boot')
    expect(reasonFor('env')).toContain('buildClaudeSubprocessEnv')
    for (const key of ['requiredMinimumVersion', 'requiredMaximumVersion']) {
      expect(reasonFor(key)).toContain('refuses to launch either host')
      expect(reasonFor(key)).toContain('before a session of any runtime exists')
    }
  })
})

// ============================================================
// P2.136 · a managed lock was sent without its operand.
//
// MEASURED on HEAD before the fix, through the real parser: a policy carrying
// `sandbox{network{allowManagedDomainsOnly:true, allowedDomains:['corp.example']},
// filesystem{allowManagedReadPathsOnly:true, allowRead:['/opt/corp']}}` reached
// the SDK as `{sandbox:{network:{allowManagedDomainsOnly:true},
// filesystem:{allowManagedReadPathsOnly:true}}}` — the locks with neither list —
// while the surfacing said `mapped:['sandbox']`, `unsupported:[]` and printed
// one line, "carries: sandbox".
//
// `settings-reference.md#sandbox-network-allowmanageddomainsonly`: "Lock the
// network allowlist to what managed settings define. Claude Code then honors
// only `allowedDomains` and `WebFetch(domain:...)` allow rules from managed
// settings, ignores domains from user, project, local, and `--settings`
// settings, and blocks a non-allowed domain automatically instead of prompting."
// So the lock with an empty managed list blocks every host, without prompting.
//
// `settings-reference.md#sandbox-filesystem-allowmanagedreadpathsonly`: "Honor
// only the `allowRead` entries that come from managed settings, so developers
// can't re-open read access to paths your organization blocked. `denyRead`
// entries still merge from every settings file." So the lock with an empty
// managed list re-opens nothing inside any `denyRead` region, from any source.
//
// `managed-settings.md#managed-only-settings` states the category directly:
// "Most of them are locks: the value a lock governs, such as permission rules or
// `sandbox.network.allowedDomains`, is an ordinary key that any level can set,
// and the lock tells Claude Code to honor only the managed value."
// ============================================================

/** The row's policy, verbatim. */
const P2136_POLICY: Record<string, unknown> = {
  sandbox: {
    network: { allowManagedDomainsOnly: true, allowedDomains: ['corp.example'] },
    filesystem: { allowManagedReadPathsOnly: true, allowRead: ['/opt/corp'] },
  },
}

describe('P2.136 · a lock carries its operand', () => {
  test('POSITIVE: the row\'s policy reaches the SDK as lock AND list, both halves', () => {
    // Asserted on the SPAWN OPTION, not on the mapping: `managedSettings` is the
    // value `ClaudeAgent` hands the SDK, so this is what actually arrives. A
    // mapping-only assertion could be satisfied by an intermediate the spawn
    // never reads.
    const sandbox = buildClaudeManagedSettingsOptions(policy(P2136_POLICY)).managedSettings?.sandbox
    expect(sandbox).toEqual({
      network: { allowManagedDomainsOnly: true, allowedDomains: ['corp.example'] },
      filesystem: { allowManagedReadPathsOnly: true, allowRead: ['/opt/corp'] },
    })
  })

  test('NEGATIVE: the same lists WITHOUT their locks are still withheld', () => {
    // The direction that is easy to lose. Unlocked, each list merges on top of
    // whatever a user or project settings file already allows, so it is a plain
    // widening and a floor never widens.
    const options = buildClaudeManagedSettingsOptions(policy({
      sandbox: {
        network: { allowedDomains: ['corp.example'] },
        filesystem: { allowRead: ['/opt/corp'] },
      },
    }))
    // Nothing in that policy narrows anything, so there is no option at all.
    expect(options).toEqual({})
  })

  test('NEGATIVE: one lock set does not smuggle the OTHER list through', () => {
    // The mutant this kills: carrying both operands from either lock, or from
    // any lock at all. Each list rides only inside its own lock's branch.
    const sandbox = buildClaudeManagedSettingsOptions(policy({
      sandbox: {
        network: { allowManagedDomainsOnly: true, allowedDomains: ['corp.example'] },
        filesystem: { allowRead: ['/opt/corp'] },
      },
    })).managedSettings?.sandbox
    expect(sandbox).toEqual({
      network: { allowManagedDomainsOnly: true, allowedDomains: ['corp.example'] },
    })
    expect(JSON.stringify(sandbox)).not.toContain('/opt/corp')
  })

  test('BOUNDARY: a lock with no list stays a lock, because that is what was written', () => {
    // Deny-every-host is a policy an administrator may deploy deliberately, and
    // the fix must not invent a list to soften it.
    const sandbox = buildClaudeManagedSettingsOptions(policy({
      sandbox: {
        network: { allowManagedDomainsOnly: true },
        filesystem: { allowManagedReadPathsOnly: true },
      },
    })).managedSettings?.sandbox
    expect(sandbox).toEqual({
      network: { allowManagedDomainsOnly: true },
      filesystem: { allowManagedReadPathsOnly: true },
    })
  })

  test('the write lists have no lock to be an operand of, and stay withheld', () => {
    // `settings-reference.md` publishes `allowManagedReadPathsOnly` and no write
    // equivalent, so the read pair is not a template for the write pair. The
    // measured SDK filter agrees: its filesystem branch picks only `denyRead`
    // and `denyWrite`, and copies `allowRead` alone.
    const sandbox = buildClaudeManagedSettingsOptions(policy({
      sandbox: {
        filesystem: {
          allowManagedReadPathsOnly: true,
          allowRead: ['/opt/corp'],
          allowWrite: ['/opt/corp-build'],
        },
        additionalWritableRoots: ['/srv/corp-build'],
      },
    })).managedSettings?.sandbox
    expect(sandbox?.filesystem).toEqual({
      allowManagedReadPathsOnly: true,
      allowRead: ['/opt/corp'],
    })
    expect(JSON.stringify(sandbox)).not.toContain('corp-build')
  })
})

describe('P2.136 · the surfacing reports at SUB-KEY granularity', () => {
  test('the row\'s own fixture now reports a whole key, because nothing is withheld', () => {
    const mapping = mapManagedPolicyToClaudeSettings(policy(P2136_POLICY))
    expect([...mapping.mapped]).toEqual(['sandbox'])
    expect([...mapping.withheld]).toEqual([])
    expect([...formatClaudeManagedSettingsDiagnostics(mapping)])
      .toEqual(['[managed] claude policy tier carries: sandbox'])
  })

  test('a withheld sub-key of a CARRIED key is visible, and the key reads as partial', () => {
    // The defect the row names: `mapped: ['sandbox']` with "carries: sandbox"
    // told an administrator their whole sandbox block arrived while a list
    // inside it had been dropped. `sandbox` is still mapped — its `enabled` and
    // `denyRead` really did arrive — and the report now says which part did not.
    const mapping = mapManagedPolicyToClaudeSettings(policy({
      sandbox: {
        enabled: true,
        deniedReadRoots: ['/etc/corp-secrets'],
        excludedCommands: ['docker *'],
        network: { allowedDomains: ['corp.example'] },
      },
    }))
    expect([...mapping.mapped]).toEqual(['sandbox'])
    expect(mapping.withheld.map(entry => entry.path))
      .toEqual(['sandbox.excludedCommands', 'sandbox.network.allowedDomains'])
    expect(mapping.withheld.every(entry => entry.key === 'sandbox')).toBe(true)
    const lines = formatClaudeManagedSettingsDiagnostics(mapping)
    expect(lines[0]).toBe('[managed] claude policy tier carries: sandbox (partial)')
    expect(lines.some(line => line.startsWith('[managed] claude policy tier withholds sandbox.network.allowedDomains (widening):')))
      .toBe(true)
    expect(lines.some(line => line.includes('withholds sandbox.excludedCommands'))).toBe(true)
  })

  test('the report is read off the SETTINGS, so the carry silences it and nothing else does', () => {
    // The pairing that proves `withheld` is a measurement rather than a second
    // reading of the policy: the same `allowedDomains`, once without its lock
    // and once with it. Only the value that actually reached the SDK differs.
    const unlocked = mapManagedPolicyToClaudeSettings(policy({
      sandbox: { network: { allowedDomains: ['corp.example'] } },
    }))
    expect(unlocked.withheld.map(entry => entry.path)).toEqual(['sandbox.network.allowedDomains'])
    const locked = mapManagedPolicyToClaudeSettings(policy({
      sandbox: { network: { allowManagedDomainsOnly: true, allowedDomains: ['corp.example'] } },
    }))
    expect(locked.withheld).toEqual([])
    expect(locked.settings?.sandbox?.network?.allowedDomains).toEqual(['corp.example'])
  })

  test('claudeRules.allow is reported even though claudeRules is MAPPED', () => {
    // The same hole in its other instance: a policy with both directions maps
    // `claudeRules` on the strength of its deny list, so the whole-key gap in
    // the gaps table never fires and the withheld `allow` was invisible.
    const mapping = mapManagedPolicyToClaudeSettings(policy({
      claudeRules: { deny: ['Bash(curl:*)'], allow: ['Read(~/corp/**)'] },
    }))
    expect([...mapping.mapped]).toEqual(['claudeRules'])
    expect(mapping.unsupported).toEqual([])
    expect(mapping.withheld.map(entry => entry.path)).toEqual(['claudeRules.allow'])
    expect(formatClaudeManagedSettingsDiagnostics(mapping)[0])
      .toBe('[managed] claude policy tier carries: claudeRules (partial)')
  })

  test('a policy that withholds nothing prints no withheld line and no partial marker', () => {
    // Negative control for the whole surfacing: an alarm that fires on ordinary
    // policy is an alarm that stops being read, and this module has already been
    // bitten by exactly that (P2.138).
    const mapping = mapManagedPolicyToClaudeSettings(policy({
      claudeRules: { deny: ['Bash(curl:*)'] },
      sandbox: { enabled: true, deniedReadRoots: ['/etc/corp-secrets'] },
    }))
    expect([...mapping.withheld]).toEqual([])
    const lines = formatClaudeManagedSettingsDiagnostics(mapping)
    expect(lines).toEqual(['[managed] claude policy tier carries: claudeRules, sandbox'])
  })

  /**
   * P2.244 — the pin the row asked for, at SUB-KEY granularity and DERIVED.
   *
   * The row's premise is refuted (see the module docblock): all five sub-fields
   * it named do emit a diagnostic today, through `withheld` rather than through
   * `unsupported`. What was still true is the shape of the next failure: the
   * partition test above is machine-derived from `MANAGED_PI_POLICY_KEYS` and
   * therefore cannot be skipped by a new top-level key, while every sandbox
   * SUB-key assertion was a hand-written list of paths that already exist. A
   * sixth sandbox sub-field added to the parser and read by neither
   * `mapSandbox` nor a `CLAUDE_WITHHELD_SUB_KEYS` probe would appear in no list
   * and go unnoticed — which is exactly how the five got here.
   *
   * This closes that at the same granularity. Each entry pins the sub-field at
   * the pole an administrator would be ASKING with; the first assertion makes
   * the fixture itself exhaustive against the parser, so a new sub-field cannot
   * skip the second.
   */
  const SANDBOX_SUB_KEY_POLES: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['enabled', { enabled: true }],
    ['excludedCommands', { excludedCommands: ['docker *'] }],
    ['deniedReadRoots', { deniedReadRoots: ['/etc/corp'] }],
    ['deniedWriteRoots', { deniedWriteRoots: ['/etc/corp'] }],
    ['additionalWritableRoots', { additionalWritableRoots: ['/opt/b'] }],
    ['allowUnsandboxedCommands', { allowUnsandboxedCommands: false }],
    ['network.deniedDomains', { network: { deniedDomains: ['bad.example'] } }],
    ['network.allowedDomains', { network: { allowedDomains: ['corp.example'] } }],
    ['network.allowManagedDomainsOnly', { network: { allowManagedDomainsOnly: true } }],
    ['filesystem.disabled', { filesystem: { disabled: true } }],
    ['filesystem.allowRead', { filesystem: { allowRead: ['/opt/r'] } }],
    ['filesystem.allowWrite', { filesystem: { allowWrite: ['/opt/w'] } }],
    ['filesystem.denyRead', { filesystem: { denyRead: ['/etc/corp'] } }],
    ['filesystem.denyWrite', { filesystem: { denyWrite: ['/etc/corp'] } }],
    ['filesystem.allowManagedReadPathsOnly', { filesystem: { allowManagedReadPathsOnly: true } }],
  ]

  /** Dotted leaf paths of a parsed sandbox block, `network`/`filesystem` nested. */
  function sandboxLeafPaths(sandbox: Record<string, unknown> | undefined): string[] {
    if (!sandbox) return []
    const paths: string[] = []
    for (const [key, value] of Object.entries(sandbox)) {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        for (const sub of Object.keys(value as Record<string, unknown>)) paths.push(`${key}.${sub}`)
      } else {
        paths.push(key)
      }
    }
    return paths.sort()
  }

  test('the sub-key fixture is exhaustive against the parser, so a new sub-field cannot skip the next test', () => {
    // Everything the fixtures set, in one document, parsed the real way. If the
    // parser starts accepting a sixth sandbox sub-field, this set no longer
    // matches and whoever added it is sent to the table above.
    const everySubKey = SANDBOX_SUB_KEY_POLES.reduce<Record<string, unknown>>((acc, [, document]) => {
      for (const [key, value] of Object.entries(document)) {
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          acc[key] = { ...(acc[key] as Record<string, unknown> | undefined), ...(value as Record<string, unknown>) }
        } else {
          acc[key] = value
        }
      }
      return acc
    }, {})
    const parsed = policy({ sandbox: everySubKey })
    expect(sandboxLeafPaths(parsed.sandbox as Record<string, unknown> | undefined))
      .toEqual([...SANDBOX_SUB_KEY_POLES.map(([path]) => path)].sort())
  })

  test('every sandbox sub-field an administrator sets is CARRIED or SAID, never silently dropped', () => {
    // One policy per sub-field, so the verdict is about that field alone and
    // not about a neighbour that happened to carry the whole `sandbox` key.
    for (const [path, document] of SANDBOX_SUB_KEY_POLES) {
      const mapping = mapManagedPolicyToClaudeSettings(policy({ sandbox: document }))
      const carried = mapping.settings?.sandbox !== undefined
      const said = mapping.withheld.some(entry => entry.path === `sandbox.${path}`)
      expect({ path, accountedFor: carried || said }).toEqual({ path, accountedFor: true })
    }
  })

  test('every withheld path names a real place in the policy document', () => {
    // A typo in the table would print a path an administrator cannot find in
    // their own file. Each path is rooted at a key the schema declares, and the
    // sub-key really is readable there.
    const mapping = mapManagedPolicyToClaudeSettings(policy({
      claudeRules: { allow: ['Read(~/corp/**)'] },
      sandbox: {
        excludedCommands: ['docker *'],
        additionalWritableRoots: ['/opt/b'],
        network: { allowedDomains: ['corp.example'] },
        filesystem: { allowRead: ['/opt/r'], allowWrite: ['/opt/w'] },
      },
    }))
    expect(mapping.withheld.map(entry => entry.path)).toEqual([
      'claudeRules.allow',
      'sandbox.additionalWritableRoots',
      'sandbox.excludedCommands',
      'sandbox.filesystem.allowRead',
      'sandbox.filesystem.allowWrite',
      'sandbox.network.allowedDomains',
    ])
    for (const entry of mapping.withheld) {
      expect({ path: entry.path, root: entry.path.split('.')[0] })
        .toEqual({ path: entry.path, root: entry.key })
      expect({ path: entry.path, known: (MANAGED_PI_POLICY_KEYS as readonly string[]).includes(entry.key) })
        .toEqual({ path: entry.path, known: true })
    }
  })
})

// ============================================================
// P2.268 · `sandbox.filesystem.disabled` — a RESTRICTIVE key that fell through
// both the carry and the surfacing.
//
// Different category from P2.136's rows: nothing was being withheld as a
// suspected widening, the key simply had no branch. Its restricting pole is
// `false` (isolation may NOT be skipped), which is why it reads backwards at a
// glance and is the reason it was missed.
// ============================================================
describe('P2.268 · the locking pole of sandbox.filesystem.disabled', () => {
  test('reaches the SDK, and reports nothing withheld', () => {
    const mapping = mapManagedPolicyToClaudeSettings(policy({
      sandbox: { filesystem: { disabled: false } },
    }))
    expect(mapping.settings?.sandbox?.filesystem).toEqual({ disabled: false })
    expect([...mapping.mapped]).toEqual(['sandbox'])
    expect([...mapping.withheld]).toEqual([])
    expect([...formatClaudeManagedSettingsDiagnostics(mapping)])
      .toEqual(['[managed] claude policy tier carries: sandbox'])
  })

  test('the widening pole is withheld AND said, rather than falling through silently', () => {
    const mapping = mapManagedPolicyToClaudeSettings(policy({
      sandbox: { enabled: true, filesystem: { disabled: true } },
    }))
    expect(mapping.settings?.sandbox?.filesystem?.disabled).toBeUndefined()
    expect(mapping.withheld.map(entry => entry.path)).toEqual(['sandbox.filesystem.disabled'])
    const lines = formatClaudeManagedSettingsDiagnostics(mapping)
    expect(lines[0]).toBe('[managed] claude policy tier carries: sandbox (partial)')
    expect(lines.some(line => line.includes('withholds sandbox.filesystem.disabled (widening)'))).toBe(true)
  })

  test('NEGATIVE: a policy that never sets the key is neither carried nor reported', () => {
    // The false-alarm guard this module has already been bitten by (P2.138): an
    // ordinary sandbox policy must stay silent about a key it does not mention.
    const mapping = mapManagedPolicyToClaudeSettings(policy({
      sandbox: { enabled: true, deniedReadRoots: ['/etc/corp-secrets'] },
    }))
    expect(JSON.stringify(mapping.settings)).not.toContain('disabled')
    expect([...mapping.withheld]).toEqual([])
  })

  test('the SDK filter no longer copies it at EITHER pole — re-measured at 0.3.247', () => {
    // P7.1, 2026-09-10. This test used to assert the opposite, and it was right
    // when written: at 0.3.233 the filter's filesystem branch carried
    // `if(i.disabled===!1)l.disabled=!1;`, and that expression occurred exactly
    // ONCE in the whole binary. At 0.3.247 the string `disabled===!1` occurs
    // ZERO times in the 233 MB binary, and the branch has been rewritten as a
    // restrictive-key PICK with one conditional widening:
    //
    //   if(e.sandbox){let{network:o,filesystem:i,credentials:s}=e.sandbox,a={},
    //     l=o?Z(o,["deniedDomains"]):{},c=i?Z(i,["denyRead","denyWrite"]):{};
    //     …
    //     if(i){if(t.sandbox?.filesystem?.allowManagedReadPathsOnly!==!0&&i.allowRead)c.allowRead=i.allowRead}
    //
    // `Z` is the same picker the permissions branch above uses for
    // `["deny","ask"]`, so the copied filesystem set is exactly `denyRead`,
    // `denyWrite` and a conditional `allowRead`. `disabled` is in NEITHER pole
    // and the word does not occur in the branch at all — while `sdk.d.ts` still
    // declares the field. The vendor did not rename the key; it stopped copying
    // it through this filter.
    //
    // Consequence, recorded rather than acted on here: `mapSandbox` still emits
    // `filesystem.disabled = false` as P2.268's lock, and that value is now
    // dropped by the filter it was measured against. Whether the host should
    // keep sending it, report it as vendor-dropped, or find the path that still
    // honours it is P2.268's own question and a proposed row, not a test edit.
    //
    // ANCHORED ON THE FILTER, not on `allowManagedReadPathsOnly===!0` — that
    // string now has two occurrences and `indexOf` takes the first, which at
    // 0.3.247 is the TIER COMPOSER, a different function. The citation still
    // resolved and named the wrong code, which is the exact failure mode
    // `check-minified-citations.ts`'s own verdict warns about.
    const text = nativeBinaryText()
    if (text === undefined) return
    const filter = text.indexOf('allowManagedHooksOnly===!0')
    expect(filter).toBeGreaterThan(-1)
    const sandboxAt = text.indexOf('if(e.sandbox){', filter)
    expect(sandboxAt).toBeGreaterThan(filter)
    // D1.111 — the same END ANCHOR as the sibling case above, for the same
    // reason: this is a minified artefact, so the bound is a stable STRING the
    // binary spells after the filter returns, never a brace scan and never a
    // character count. The region is therefore the sandbox branch plus whatever
    // remains of the filter — 1 217 characters at the vendored 2.1.247, where
    // the old window read 900 of them (74 %) and every claim here but two is a
    // NEGATIVE. Re-measured with the wider bound: the verdicts are unchanged.
    const filterEnd = text.indexOf('ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION', filter)
    expect(filterEnd).toBeGreaterThan(sandboxAt)
    const branch = text.slice(sandboxAt, filterEnd)
    // BOUNDARY CONTROL: the region is the filter's tail and not the rest of the
    // binary.
    expect(branch.length).toBeLessThan(20_000)
    // Positive controls: this window really is the filesystem half of the filter.
    expect(branch).toContain('["denyRead","denyWrite"]')
    expect(branch).toContain('allowRead')
    // Negative control for the window itself.
    expect(branch).not.toContain('nessyNotARealSdkKey')
    // The measurement, both poles and the bare key.
    expect(branch).not.toContain('disabled')
    expect(text).not.toContain('disabled===!1')
  })
})

/**
 * P6.236 — `allowManagedMcpServersOnly`, the exclusive-control switch its two
 * siblings already had.
 *
 * `settings-reference.md#allowmanagedmcpserversonly`: *"Make the managed
 * allowlist the only one that applies. Claude Code then reads
 * `allowedMcpServers` from managed settings alone and ignores allowlists in
 * user, project, and local settings."*
 *
 * Why the projection is the whole deliverable, and why the other two runtimes
 * get nothing: we pass `settingSources` with `user` to the SDK (`project` + `local` for a trusted project, F1.768),
 * so the claude child really does read a user's own `.claude/settings.json` and
 * really can have its allowlist widened by it. Pi and codex read no MCP
 * allowlist outside the managed schema, so the switch has nothing to turn off
 * there — satisfied by construction rather than unenforced.
 */
describe('allowManagedMcpServersOnly reaches the SDK tier (P6.236)', () => {
  test('the enforcing pole is emitted, and it is one of the keys the measured filter copies', () => {
    const mapping = mapManagedPolicyToClaudeSettings(policy({ allowManagedMcpServersOnly: true }))
    expect(mapping.settings?.allowManagedMcpServersOnly).toBe(true)
    expect([...mapping.mapped]).toEqual(['allowManagedMcpServersOnly'])
    // FILTER_COPIES is asserted against the shipped binary elsewhere in this
    // file; naming the key here ties the emission to that measurement.
    expect(FILTER_COPIES).toContain('allowManagedMcpServersOnly')
  })

  test('the non-enforcing pole emits nothing, because the SDK filter tests `===!0`', () => {
    const mapping = mapManagedPolicyToClaudeSettings(policy({ allowManagedMcpServersOnly: false }))
    expect(mapping.settings?.allowManagedMcpServersOnly).toBeUndefined()
    expect([...mapping.mapped]).toEqual([])
    expect([...mapping.unsupported]).toEqual([])
  })
})

/**
 * P6.234 — a Claude Code admin source on this machine discards our whole slice.
 *
 * `managed-settings.md#let-an-embedding-host-add-policy`: "By default, Claude
 * Code ignores parent settings whenever an admin source is present". Our slice
 * IS a parent setting, so on such a machine every key this module maps enforces
 * nothing on the claude runtime — and nothing said so.
 *
 * The switch belongs to that machine's administrator ("set
 * parentSettingsBehavior to 'merge' in the highest-priority managed source;
 * Claude Code reads the key from that source only"), so detection and a
 * sentence are the whole of what a host can do.
 */
describe('a Claude Code admin source is detected and named (P6.234)', () => {
  const FILE = '/etc/claude-code/managed-settings.json'
  const PLIST = '/Library/Managed Preferences/com.anthropic.claudecode.plist'
  const probe = (present: Record<string, string>, platform: NodeJS.Platform = 'linux') =>
    detectClaudeAdminSettingsTier({
      platform,
      existsSync: (path: string) => path in present,
      readFileSync: (path: string) => present[path] ?? '',
    })
  const mapping = () => mapManagedPolicyToClaudeSettings(policy({ allowManagedHooksOnly: true }))

  test('no admin source on the machine — nothing detected and nothing said', () => {
    const tier = probe({})
    expect(tier).toBeUndefined()
    expect(claudeManagedSliceDiscardNotice(mapping(), tier)).toBeUndefined()
  })

  test('a managed policy file with no merge key — the notice names the tier and the keys at stake', () => {
    const tier = probe({ [FILE]: JSON.stringify({ permissions: { deny: ['Bash'] } }) })
    expect(tier).toMatchObject({ mechanism: 'file', location: FILE, readable: true })
    expect(tier?.parentSettingsBehavior).toBeUndefined()

    const notice = claudeManagedSliceDiscardNotice(mapping(), tier)
    expect(notice).toContain('DISCARDED, not filtered')
    expect(notice).toContain(FILE)
    // The size of the loss, by name rather than "everything".
    expect(notice).toContain('allowManagedHooksOnly')
    // The remedy, and whose it is.
    expect(notice).toContain('parentSettingsBehavior')
  })

  test("CONTROL — the row's own: the same rig with merge present says nothing", () => {
    const tier = probe({ [FILE]: JSON.stringify({ parentSettingsBehavior: 'merge' }) })
    expect(tier?.parentSettingsBehavior).toBe('merge')
    expect(claudeManagedSliceDiscardNotice(mapping(), tier)).toBeUndefined()
  })

  test('an unreadable admin source is PRESENT, and the notice says the discard cannot be ruled out', () => {
    // The macOS managed-preferences domain is a binary plist; guessing "merge"
    // from a source we cannot read would turn a warning into a false all-clear.
    const tier = probe({ [PLIST]: 'bplist00' }, 'darwin')
    expect(tier).toMatchObject({ mechanism: 'mdm-managed-preferences', readable: false })
    const notice = claudeManagedSliceDiscardNotice(mapping(), tier)
    expect(notice).toContain('cannot read')
    expect(notice).toContain('cannot be ruled out')
  })

  test('a corrupt policy file is an admin source too — presence outranks validity', () => {
    const tier = probe({ [FILE]: '{ not json' })
    expect(tier).toMatchObject({ mechanism: 'file', readable: false })
    expect(claudeManagedSliceDiscardNotice(mapping(), tier)).toContain('cannot be ruled out')
  })

  test('a policy that maps to nothing has no slice to lose, so there is no notice', () => {
    const empty = mapManagedPolicyToClaudeSettings(policy({}))
    expect(empty.settings).toBeUndefined()
    expect(claudeManagedSliceDiscardNotice(empty, probe({ [FILE]: '{}' }))).toBeUndefined()
  })

  test('the diagnostics line comes FIRST, and the existing lines are untouched without a tier', () => {
    const withoutTier = formatClaudeManagedSettingsDiagnostics(mapping())
    const withTier = formatClaudeManagedSettingsDiagnostics(mapping(), probe({ [FILE]: '{}' }))
    // Deterministic by construction: no probe happens unless a caller passes
    // one, so every existing line-for-line comparison in this file is unmoved.
    expect(withTier.slice(1)).toEqual([...withoutTier]);
    expect(withTier[0]).toContain('DISCARDED, not filtered')
  })
})

/**
 * F1.832 — `permissionDsl` on claude is enforced IN PART, and the report says so.
 *
 * Since F1.813 (deny) and F1.830 (ask) the host PreToolUse gate binds both of the
 * DSL's restricting halves on this runtime, while an ALLOW rule is not honoured
 * (the call falls to the permission mode's own answer). Before this row the key
 * was reported as `enforced-elsewhere` whatever the policy held, so a policy
 * whose allow rule did nothing here read as wholly in force. The CONTROL the row
 * named: a managed policy carrying one native allow rule.
 */
describe('F1.832: a native permissionDsl allow rule makes the key partially enforced', () => {
  const permissionDslGap = (document: Record<string, unknown>) =>
    mapManagedPolicyToClaudeSettings(policy(document)).unsupported.find(gap => gap.key === 'permissionDsl')

  test('one native allow rule beside a deny → partially-enforced, naming the allow half, never "unenforced"', () => {
    const document = {
      permissionDsl: {
        version: 1,
        rules: [
          { id: 'org-deny-bash', action: 'deny', match: { kind: 'tool', semanticId: 'Bash' } },
          { id: 'org-allow-read', action: 'allow', match: { kind: 'tool', semanticId: 'Read' } },
        ],
      },
    }
    const gap = permissionDslGap(document)
    expect(gap?.kind).toBe('partially-enforced')
    // The unenforced half is a REQUIRED field on this kind, and it names the rule.
    const unenforced = gap?.kind === 'partially-enforced' ? gap.unenforced : undefined
    expect(unenforced).toContain('org-allow-read')
    expect(unenforced).toContain('allow')
    expect(unenforced).not.toContain('org-deny-bash')
    const mapping = mapManagedPolicyToClaudeSettings(policy(document))
    const line = formatClaudeManagedSettingsDiagnostics(mapping).find(entry => entry.includes('permissionDsl'))
    expect(line).toContain('(partially-enforced)')
    expect(line).toContain('org-allow-read')
    // The deny and ask halves DO bind here, so the durable "nothing applies it"
    // warning would be false about this key.
    expect(claudeManagedPolicyUnenforcedKeys(mapping)).not.toContain('permissionDsl')
  })

  test('deny and ask only → still enforced-elsewhere; a claudeRules allow is not counted twice', () => {
    const restricting = permissionDslGap({
      permissionDsl: {
        version: 1,
        rules: [
          { id: 'org-deny-bash', action: 'deny', match: { kind: 'tool', semanticId: 'Bash' } },
          { id: 'org-ask-fetch', action: 'ask', match: { kind: 'tool', semanticId: 'WebFetch' } },
        ],
      },
    })
    expect(restricting?.kind).toBe('enforced-elsewhere')
    // The parser compiles `claudeRules.allow` into a generated `claude-allow-0`
    // DSL rule; that allow is already reported as `claudeRules.allow`, withheld.
    const mixed = mapManagedPolicyToClaudeSettings(policy({
      claudeRules: { allow: ['Read(~/corp/**)'] },
      permissionDsl: {
        version: 1,
        rules: [{ id: 'org-deny-bash', action: 'deny', match: { kind: 'tool', semanticId: 'Bash' } }],
      },
    }))
    expect(mixed.unsupported.find(gap => gap.key === 'permissionDsl')?.kind).toBe('enforced-elsewhere')
    expect(mixed.withheld.map(entry => entry.path)).toContain('claudeRules.allow')
  })
})

/**
 * F1.1001 — the unhonoured half F1.832 names reaches the DURABLE chat channel.
 *
 * F1.832 stated a managed native `permissionDsl` allow rule that claude does not
 * honour on the session debug channel only, while the withheld `autoMode.allow`
 * already had a lasting chat notice. Owner decision 2026-09-26: the allow rule
 * gets the same channel, once per session. The sentence is derived from the
 * mapping's own `partially-enforced` gap, never from a second read of the policy.
 */
describe('F1.1001: an unhonoured managed allow rule gets one durable chat notice', () => {
  const notices = (document: Record<string, unknown>, locale = 'en'): readonly string[] => {
    if (!i18n.isInitialized) setupI18n()
    return claudeManagedPolicyUnhonouredAllowNotices(
      mapManagedPolicyToClaudeSettings(policy(document)),
      i18n.getFixedT(locale),
    )
  }
  const withAllow = {
    permissionDsl: {
      version: 1,
      rules: [
        { id: 'org-deny-bash', action: 'deny', match: { kind: 'tool', semanticId: 'Bash' } },
        { id: 'org-allow-read', action: 'allow', match: { kind: 'tool', semanticId: 'Read' } },
        { id: 'org-allow-grep', action: 'allow', match: { kind: 'tool', semanticId: 'Grep' } },
      ],
    },
  }

  test('a native allow rule gives exactly ONE sentence naming its ids, in both locales, with no key leak', () => {
    for (const locale of ['en', 'ru']) {
      const said = notices(withAllow, locale)
      expect(said, locale).toHaveLength(1)
      expect(said[0], locale).toContain('org-allow-read, org-allow-grep')
      expect(said[0], locale).toContain('permissionDsl')
      expect(said[0], locale).not.toContain('org-deny-bash')
      expect(said[0], locale).not.toContain('chat.managedPolicy')
      expect(said[0], locale).not.toContain('{{')
    }
    // Derived from the mapping: the gap itself carries the ids the sentence names.
    const gap = mapManagedPolicyToClaudeSettings(policy(withAllow)).unsupported
      .find(entry => entry.key === 'permissionDsl')
    expect(gap?.kind === 'partially-enforced' ? gap.unenforcedRuleIds : undefined)
      .toEqual(['org-allow-read', 'org-allow-grep'])
  })

  test('deny and ask only, or a claudeRules allow only, gives NO notice', () => {
    expect(notices({
      permissionDsl: {
        version: 1,
        rules: [
          { id: 'org-deny-bash', action: 'deny', match: { kind: 'tool', semanticId: 'Bash' } },
          { id: 'org-ask-fetch', action: 'ask', match: { kind: 'tool', semanticId: 'WebFetch' } },
        ],
      },
    })).toEqual([])
    // The generated `claude-allow-0` copy is already reported as the withheld
    // `claudeRules.allow` entry, so it must not raise this notice as well.
    expect(notices({ claudeRules: { allow: ['Read(~/corp/**)'] } })).toEqual([])
    expect(notices({})).toEqual([])
  })

  test('the claude spawn queues it on the durable channel, after the mapping and before the options literal', () => {
    const source = readFileSync(fileURLToPath(new URL('../claude-agent.ts', import.meta.url)), 'utf8')
    const at = (needle: string): number => {
      const index = source.indexOf(needle)
      expect(index, `missing source anchor: ${needle}`).toBeGreaterThanOrEqual(0)
      return index
    }
    const emit = at('of claudeManagedPolicyUnhonouredAllowNotices(claudeManagedSettings, i18n.t)) this.queueDegradationNotice(notice);')
    expect(emit).toBeGreaterThan(at('const claudeManagedSettings = mapManagedPolicyToClaudeSettings(managedPiPolicyFloor)'))
    // After the guarded `setupI18n()`, so `t()` never renders `undefined`.
    expect(emit).toBeGreaterThan(at('if (!i18n.isInitialized) setupI18n();'))
    expect(emit).toBeLessThan(at('const options: Options = {'))
  })
})
