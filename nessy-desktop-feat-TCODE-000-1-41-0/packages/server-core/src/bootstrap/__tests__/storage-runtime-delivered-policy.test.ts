/**
 * R25c — a delivered managed payload must reach ENFORCEMENT, not just the cache.
 *
 * The defect this file exists to stop from recurring: R25b shipped the whole
 * server-managed lifecycle — fetch at sign-in, salvage, 0600 atomic cache,
 * approval digest, withheld-env hardening — and `createStorageRuntime` built
 * the enforced policy from the host-owned FILE alone. `env` and
 * `forceRemoteSettingsRefresh` were the only two keys with a consumer. An admin
 * who deployed a deny rule through the server saw it accepted, cached and
 * reported as applied; it denied nothing.
 *
 * Nothing asserted that a delivered key reaches enforcement, which is why it
 * survived. So the load-bearing test here is the GENERAL one — every field of
 * `ManagedPiPolicyV1` that the file path enforces is reachable from the
 * delivered path — rather than one test per enforcement family. It is keyed off
 * `MANAGED_PI_POLICY_KEYS`, so a field added to the schema and not to the
 * delivered path fails it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_MANAGED_PI_POLICY,
  isManagedMcpServerAllowed,
  isManagedPluginAllowed,
  MANAGED_PI_POLICY_KEYS,
  parseManagedPiPolicyTolerantV1,
  type ManagedPiPolicyV1,
} from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import {
  applyDeliveredDocument,
  getDeliveredManagedPolicy,
  getManagedDeliveryCachePath,
  resetManagedDeliverySession,
  type ManagedDeliverySalvageV1,
} from '@nessy-agent/shared/config/managed-delivery'
import { classifyManagedApproval } from '@nessy-agent/shared/config/managed-approval'
import {
  getRetentionDays,
  registerManagedRetentionDaysProvider,
  registerManagedSandboxEnabledProvider,
  resolveManagedSandboxEnabledFloor,
} from '@nessy-agent/shared/config'
import {
  registerEnforcedManagedRetentionProvider,
  registerEnforcedManagedSandboxEnabledProvider,
} from '../managed-policy-resolution'
import { CapabilityPolicyStore } from '@nessy-agent/shared/capabilities/policy-store'
import { createCapabilityResolver, type CapabilityContext } from '@nessy-agent/shared/capabilities/resolver'
import type { PluginStoreV2 } from '@nessy-agent/shared/plugins'
import {
  buildCapabilityResolutionInputsV2,
  resolveEnforcedManagedPolicy,
  type CapabilityInputsV2Deps,
} from '../storage-runtime'

let root: string
let cachePath: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'storage-runtime-delivered-'))
  cachePath = getManagedDeliveryCachePath(root)
  resetManagedDeliverySession()
})

afterEach(() => {
  resetManagedDeliverySession()
  if (root) rmSync(root, { recursive: true, force: true })
})

/**
 * Deliver a document the way a successful fetch does, and read it back.
 *
 * `approve` stands in for a user answering the `:207` security dialog: it
 * stamps the payload digest so the startup read accepts it. Without it a
 * payload that needs approval is applied for the run and never cached
 * (`:221`), which is the state the last test in this file pins.
 */
function deliver(
  document: Record<string, unknown>,
  approve = false,
): ManagedPiPolicyV1 | undefined {
  applyDeliveredDocument({
    document,
    now: 1_700_000_000_000,
    cachePath,
    ...(approve
      ? {
          gate: (salvage: ManagedDeliverySalvageV1) => {
            const request = classifyManagedApproval(salvage.policy, salvage.payload)
            return {
              apply: true,
              persist: true,
              ...(request === null ? {} : { approvedDigest: request.digest }),
            }
          },
        }
      : {}),
  })
  return getDeliveredManagedPolicy(cachePath)
}

/**
 * Every key the schema accepts, as a TYPE, derived from the schema's own list.
 *
 * P6.867 — `MANAGED_PI_POLICY_KEYS` is the source of truth here rather than
 * `keyof ManagedPiPolicyV1`: the two are not tied together anywhere, and it is
 * the ARRAY the parser is checked against (`parsePolicy`'s allow-set is built
 * from it, and the reachability property below asserts the enforced policy's own
 * keys equal it). Deriving from the interface instead would pin the fixture to a
 * list nothing else in this file reads.
 */
type EveryManagedPolicyKey = (typeof MANAGED_PI_POLICY_KEYS)[number]

/**
 * A document that sets EVERY key the schema accepts, with values that all
 * survive validation.
 *
 * P6.867 — the key list is DERIVED, not repeated. `satisfies
 * Record<EveryManagedPolicyKey, unknown>` makes a schema key with no entry here
 * a COMPILE error naming that key, and (object-literal excess-property checking)
 * makes a fixture key the schema does not accept one too. The runtime
 * completeness assertion below is kept as the belt, but it is no longer the only
 * guard: this fixture had drifted three keys behind by `e30125a02` and seven more
 * by `cf87593a0`, and both repairs were made from a RED test — the property
 * caught the drift twice and prevented it neither time, because a test only
 * speaks when someone runs it. `tsc` speaks on every `typecheck:server-core`,
 * and this file is inside that project — server-core's tsconfig includes all of
 * `src` recursively and excludes no test directory — so the lane that adds the
 * key is told by the same gate it already runs.
 *
 * The values stay hand-written and cannot be derived: each must be VALID for its
 * own key, which is what `viaFile.drops` being empty proves below. Type-level
 * derivation buys the key list, never the values.
 */
const EVERY_KEY = {
  schemaVersion: 1,
  disabledPermissionModes: ['acceptEdits'],
  permissionDsl: {
    version: 1,
    rules: [{ id: 'org-deny-bash', action: 'deny', match: { kind: 'tool', semanticId: 'Bash' } }],
  },
  allowedPluginKeys: ['corp.toolkit'],
  deniedPluginKeys: ['vendor.unreviewed'],
  enabledPlugins: { 'corp.toolkit': true, 'corp.optional': false },
  allowedMcpServers: ['corp-mcp'],
  deniedMcpServers: ['forbidden-mcp'],
  allowPluginHooks: false,
  allowManagedHooksOnly: true,
  disableCommandPluginSources: true,
  disableAllHooks: false,
  disableSideloadFlags: true,
  allowManagedPermissionRulesOnly: true,
  allowManagedMcpServersOnly: true,
  model: 'sonnet',
  strictPluginOnlyCustomization: ['skills', 'agents', 'hooks', 'mcp'],
  defaultMode: 'plan',
  channelsEnabled: false,
  disableAgentView: true,
  allowedChannelServers: ['corp-mcp'],
  sandbox: {
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
  workflow: { disableWorkflows: true, sizeGuideline: 'small', keywordTriggerEnabled: false },
  allowedHttpHookUrls: ['https://hooks.corp.example/ingest'],
  httpHookAllowedEnvVars: ['CORP_HOOK_TOKEN'],
  claudeRules: { allow: ['Read(~/corp/**)'], ask: ['WebFetch'], deny: ['Bash(curl:*)'] },
  claudeMdExcludes: ['**/vendor/**/CLAUDE.md'],
  // P6.245 — the two operator-authored strings.
  pluginTrustMessage: 'All plugins from our marketplace are approved by IT',
  companyAnnouncements: ['Welcome to Acme Corp! Review our code guidelines at docs.example.com'],
  autoMode: {
    environment: ['This fleet runs production payment infrastructure.'],
    hard_deny: ['Never rotate a production credential.'],
    soft_deny: ['Avoid destructive migrations.'],
    allow: ['Reading production logs is fine.'],
    classifyAllShell: true,
  },
  cleanupPeriodDays: 30,
  autoCompactEnabled: false,
  connectSourcesOnStartup: false,
  disableInAppUpdates: true,
  disableInAppBrowser: true,
  env: { CORP_TELEMETRY_ENDPOINT: 'https://otel.corp.example' },
  forceRemoteSettingsRefresh: true,
  requiredMinimumVersion: '1.0.0',
  requiredMaximumVersion: '9.9.9',
  availableModels: ['sonnet'],
  enforceAvailableModels: true,
  strictKnownMarketplaces: [{ source: 'hostPattern', hostPattern: '^gitlab\\.tcsbank\\.ru$' }],
  blockedMarketplaces: [{ source: 'github', repo: 'untrusted/plugins' }],
  extraKnownMarketplaces: { 'corp-plugins': { source: { source: 'git', url: 'https://gitlab.tcsbank.ru/corp/plugins.git' } } },
  pluginSuggestionMarketplaces: ['corp-plugins'],
  // W9-ar 2026-09-08 — seven keys that reached `MANAGED_PI_POLICY_KEYS` after
  // `e30125a02` last repaired this fixture and never reached the fixture, so the
  // reachability property was failing for all of them at once. Restored the same
  // way that commit did: a VALID value each, which `viaFile.drops` above proves
  // rather than assumes — a wrong type here is dropped and fails the test.
  unattendedApprovalFallback: 'deny',
  disableBrowserExternalNavigation: true,
  disableBrowserCdp: true,
  browserHostAllowlist: ['docs.corp.example'],
  browserExternalPageTools: 'disabled',
  modelPricing: { 'corp/model': { input: 1, output: 2 } },
  disableNonGatewayConnections: true,
  // F1.593 — the organisation's additive MCP servers (http/sse only).
  managedMcpServers: { 'corp-docs': { type: 'http', url: 'https://mcp.corp.example/docs' } },
} as const satisfies Record<EveryManagedPolicyKey, unknown>

describe('delivered managed policy reachability (the general property)', () => {
  it('sets every key the schema accepts, so a new field cannot skip this test', () => {
    // Named, not set-differenced: a Set-vs-Set mismatch reports both sides in
    // full and leaves the reader to spot the one that moved. These say WHICH.
    const fixtureKeys = new Set<string>(Object.keys(EVERY_KEY))
    const schemaKeys = new Set<string>(MANAGED_PI_POLICY_KEYS)
    expect(
      MANAGED_PI_POLICY_KEYS.filter(key => !fixtureKeys.has(key)),
      'schema keys missing from EVERY_KEY',
    ).toEqual([])
    expect(
      Object.keys(EVERY_KEY).filter(key => !schemaKeys.has(key)),
      'EVERY_KEY keys the schema does not accept',
    ).toEqual([])
  })

  it('lands every field the FILE path enforces on the enforced policy when delivered instead', () => {
    // The file path: what `loadManagedPiPolicyWithDiagnostics` would produce for
    // this document. Zero drops is part of the assertion — it proves the fixture
    // is genuinely valid rather than quietly stripped down to the keys that work.
    const viaFile = parseManagedPiPolicyTolerantV1(EVERY_KEY, { source: 'managed-policy.json' })
    expect(viaFile.drops).toEqual([])

    // The delivered path: fetch -> salvage -> 0600 cache -> startup read.
    const delivered = deliver({ ...EVERY_KEY }, true)
    expect(delivered).toBeDefined()

    // A round trip through the cache FILE loses nothing the file path enforces.
    expect(delivered).toEqual(viaFile.policy)

    // And the seam `createStorageRuntime` reads carries all of it.
    const enforced = resolveEnforcedManagedPolicy({
      file: () => ({ policy: DEFAULT_MANAGED_PI_POLICY, drops: [] }),
      delivered: () => delivered,
    })
    expect(enforced.policy).toEqual(viaFile.policy)
    expect(new Set(Object.keys(enforced.policy))).toEqual(new Set(MANAGED_PI_POLICY_KEYS))
  })
})

/**
 * The marketplace FEED, pinned by source match — P2.481.
 *
 * `createStorageRuntime` needs a dp session broker, a plugin runtime host and a
 * writable plugin root, so the one line that matters here is not drivable from a
 * unit test. The fact it carries is small and exact, and P2.481 is the row
 * because it was MISSING: P2.467 built the `blockedMarketplaces` gate, proved it
 * with six mutants, and its only production feed was a
 * `createPluginRegistrySource` parameter nothing set. A gate reachable only from
 * its own tests is an unenforced blocklist, and an unenforced blocklist fails
 * OPEN.
 *
 * Keyed off the policy schema rather than a literal list, so a marketplace key
 * added to `ManagedPiPolicyV1` and not forwarded here fails instead of quietly
 * repeating the defect.
 */
describe('the managed marketplace keys reach the registry source at boot', () => {
  const source = readFileSync(fileURLToPath(new URL('../storage-runtime.ts', import.meta.url)), 'utf8')
  /** The `createPluginRegistrySource({ … })` call, and nothing else in the file. */
  const call = (() => {
    const start = source.indexOf('createPluginRegistrySource({')
    expect(start, 'missing source anchor: createPluginRegistrySource({').toBeGreaterThanOrEqual(0)
    const end = source.indexOf('\n  })', start)
    expect(end, 'unterminated createPluginRegistrySource call').toBeGreaterThan(start)
    return source.slice(start, end)
  })()

  /**
   * Every schema key whose name ends in `Marketplaces` — the four the registry
   * source can be fed. Derived, so this cannot go stale against the schema.
   */
  const MARKETPLACE_KEYS = MANAGED_PI_POLICY_KEYS.filter(key => key.endsWith('Marketplaces'))

  it('EXTRACTION CONTROL: the window is the call, not the whole file', () => {
    // Without this, every assertion below would pass on a file that mentions the
    // keys anywhere at all — including in the comments that explain them.
    expect(MARKETPLACE_KEYS.length).toBe(4)
    expect(call).not.toContain('deniedMcpServers')
    expect(call).not.toContain('const marketplaceService')
  })

  it('forwards every marketplace key the policy carries, blocklist included', () => {
    for (const key of MARKETPLACE_KEYS) {
      expect({ key, fed: call.includes(`{ ${key}: managedPiPolicy.${key} }`) })
        .toEqual({ key, fed: true })
    }
  })

  it('feeds each one only when the administrator set it, so an unmanaged install is unchanged', () => {
    // `undefined` is "no managed constraint" for all four; spreading the key
    // regardless would hand the registry source an explicit `undefined` and turn
    // an absent policy into a present one.
    for (const key of MARKETPLACE_KEYS) {
      expect({ key, guarded: call.includes(`managedPiPolicy.${key} === undefined`) })
        .toEqual({ key, guarded: true })
    }
  })
})

describe('a delivered payload reaching a real enforcement decision', () => {
  it('walks a delivered deny through the cache to the capability snapshot', async () => {
    const workspaceRoot = join(root, 'workspace')
    const configDir = join(root, 'config')
    mkdirSync(workspaceRoot, { recursive: true })
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({
      mcpServers: { 'forbidden-mcp': { command: 'forbidden' }, 'allowed-mcp': { command: 'allowed' } },
    }))

    // Delivered by the server; never written to the host-owned policy file.
    const delivered = deliver({
      schemaVersion: 1,
      deniedMcpServers: ['forbidden-mcp'],
      deniedPluginKeys: ['vendor.unreviewed'],
      permissionDsl: {
        version: 1,
        rules: [{ id: 'org-deny-bash', action: 'deny', match: { kind: 'tool', semanticId: 'Bash' } }],
      },
    })
    const { policy: managedPiPolicy } = resolveEnforcedManagedPolicy({
      file: () => ({ policy: DEFAULT_MANAGED_PI_POLICY, drops: [] }),
      delivered: () => delivered,
    })

    // The three enforcement helpers every consumer of the policy calls.
    expect(isManagedMcpServerAllowed(managedPiPolicy, { name: 'forbidden-mcp' })).toBe(false)
    expect(isManagedMcpServerAllowed(managedPiPolicy, { name: 'allowed-mcp' })).toBe(true)
    expect(isManagedPluginAllowed(managedPiPolicy, 'vendor.unreviewed')).toBe(false)
    expect(managedPiPolicy.permissionDsl?.rules.map(rule => rule.id)).toEqual(['org-deny-bash'])

    // And the decision the resolver actually makes for a Pi turn: the delivered
    // deny excludes the server from the snapshot the agent runs against.
    const context: CapabilityContext = {
      workspaceId: 'ws_a',
      provider: 'pi',
      projectTrustState: 'none',
      projectTrustRevision: '',
    }
    const deps: CapabilityInputsV2Deps = {
      resolveWorkspaceRootPath: () => workspaceRoot,
      nativeSourcesEnv: {
        // P2.455 / P2.461 — `[]` is "no administrator tier", pinned so this rig
        // cannot read the machine's real administrator roots. Why the field is
        // required rather than defaulting: `NativeSourcesEnv.adminSkillsDirs`.
        adminSkillsDirs: [],
        configDir,
        homeAgentsSkillsDir: join(root, 'agents', 'skills'),
      },
      pluginStore: {
        readInstalledRegistry: async () => ({ schemaVersion: 2, updatedAt: 1, active: {}, plugins: [] }),
        cachePathFor: () => join(root, 'cache'),
        acquireInstanceLease: () => () => {},
      } as unknown as PluginStoreV2,
      policyStore: new CapabilityPolicyStore({
        globalPath: join(configDir, 'capabilities.json'),
        workspacePolicyPath: workspaceId => join(root, 'workspaces', workspaceId, 'capabilities.json'),
      }),
      trustStore: { resolve: () => 'trusted' } as unknown as CapabilityInputsV2Deps['trustStore'],
      credentialBackend: {
        bind: () => { throw new Error('unexpected credential bind') },
        getRuntimeCredentialStatus: () => ({ state: 'missing', revision: 0 }),
      } as CapabilityInputsV2Deps['credentialBackend'],
      managedPiPolicy,
    }

    const inputs = await buildCapabilityResolutionInputsV2(context, deps)
    const names = inputs.nativeInventory.records.map(record => record.logicalName)
    expect(names).toContain('allowed-mcp')
    expect(names).not.toContain('forbidden-mcp')

    const resolver = createCapabilityResolver({ inputs: () => inputs })
    const snapshot = await resolver.resolve(context)
    try {
      const resolved = snapshot.entries.map(entry => entry.summary.logicalName)
      expect(resolved).toContain('allowed-mcp')
      expect(resolved).not.toContain('forbidden-mcp')
    } finally {
      resolver.releaseSnapshot(snapshot.leaseId)
    }
  })

  it('does not let an unapproved delivered payload reach enforcement', () => {
    // `server-managed-settings.md#security-approval-dialogs` — this payload's
    // `env` block is one of the settings that require approval: "**Custom
    // environment variables**: delivered `env` variables that require the user's
    // approval, such as proxy and base-URL variables". With no gate wired the
    // payload applies for the run but is never stamped, so the STARTUP read
    // refuses it — "Users must approve to proceed. If a user rejects the
    // settings, Claude Code exits", and `#approval-memory`'s non-interactive
    // bullet, "it applies them for that run only. It doesn't record them as
    // approved or write them to the local cache". The enforced policy must
    // therefore fall back to the file, not to the unapproved payload.
    //
    // The citation this replaced called that the `claudeMd`-class, and the class
    // has INVERTED since it was written (read 2026-09-10): "A managed CLAUDE.md
    // delivered through the `claudeMd` key doesn't require approval, because it's
    // instruction text for Claude rather than a command Claude Code runs. …
    // Before v2.1.260, a `claudeMd` value required approval too." What this test
    // pins is unaffected — the payload carries an `env` block — but the old class
    // name is not a reason to classify `claudeMd` that way anywhere else.
    applyDeliveredDocument({
      document: { schemaVersion: 1, deniedMcpServers: ['forbidden-mcp'], env: { CORP_SECRET_HOOK: 'x' } },
      now: 1_700_000_000_000,
      cachePath,
    })
    const filePolicy = parseManagedPiPolicyTolerantV1(
      { schemaVersion: 1, deniedMcpServers: ['from-file'] },
      { source: 'managed-policy.json' },
    )

    const enforced = resolveEnforcedManagedPolicy({
      file: () => ({ policy: filePolicy.policy, drops: [] }),
      delivered: () => getDeliveredManagedPolicy(cachePath),
    })

    expect(enforced.policy.deniedMcpServers).toEqual([{ serverName: 'from-file' }])
    expect(isManagedMcpServerAllowed(enforced.policy, { name: 'forbidden-mcp' })).toBe(true)
  })
})

describe('managed retention reaching its consumer (R25)', () => {
  // The zero-drop suite above proves `cleanupPeriodDays` survives composition;
  // what it never proved is that the one CONSUMER the key has reads the composed
  // object. Both hosts fed `readManagedRetentionDays()` from the raw file, so a
  // delivered-only value was composed, approved, digest-pinned — and ignored.
  afterEach(() => {
    registerManagedRetentionDaysProvider(undefined)
  })

  it("a delivered-only policy's cleanupPeriodDays reaches readManagedRetentionDays()", () => {
    const delivered = deliver({ schemaVersion: 1, cleanupPeriodDays: 5 }, true)
    expect(delivered?.cleanupPeriodDays).toBe(5)

    // The registration both hosts call. The file seam carries NO settings, so
    // the only place 5 can come from is the delivered path — read back through
    // the approval-digest-checking cache read, exactly like the tests above.
    registerEnforcedManagedRetentionProvider({
      file: () => ({ policy: DEFAULT_MANAGED_PI_POLICY, drops: [] }),
      delivered: () => getDeliveredManagedPolicy(cachePath),
    })

    expect(getRetentionDays()).toBe(5)
  })

  it('yields no managed value when the policy file cannot be loaded, instead of throwing into the sweep', () => {
    deliver({ schemaVersion: 1, cleanupPeriodDays: 5 }, true)
    registerEnforcedManagedRetentionProvider({
      file: () => { throw new Error('managed-pi-policy-invalid') },
    })

    // The conservative path: no managed value, the stored/default decision
    // stands, and nothing propagates out of a destructive sweep's policy read.
    expect(getRetentionDays()).not.toBe(5)
  })
})

describe('managed sandbox.enabled reaching its consumer (review fix, T1 follow-up)', () => {
  // Mirrors the retention block above exactly. The general reachability suite
  // proves `sandbox.enabled` survives composition into `policy.sandbox`; it
  // never proved the CONSUMER — `resolveManagedSandboxEnabledFloor()`, contour
  // (b)'s and (e)'s shared bridge — reads the composed object. Both contours
  // fed the master switch from the user layer alone, so a delivered-only
  // `sandbox.enabled: true` was composed, approved, digest-pinned, cached —
  // and unreachable outside contour (a) (`ProcessSupervisor`, which reads the
  // `ManagedPiPolicyV1` object directly and never needed this bridge).
  afterEach(() => {
    registerManagedSandboxEnabledProvider(undefined)
  })

  it("a delivered-only policy's sandbox.enabled reaches resolveManagedSandboxEnabledFloor()", () => {
    const delivered = deliver({ schemaVersion: 1, sandbox: { enabled: true } }, true)
    expect(delivered?.sandbox?.enabled).toBe(true)

    // The registration both hosts call (headless-start.ts's
    // bootstrapConfigArtifacts, apps/electron's index.ts). The file seam
    // carries NO settings, so the only place `true` can come from is the
    // delivered path.
    registerEnforcedManagedSandboxEnabledProvider({
      file: () => ({ policy: DEFAULT_MANAGED_PI_POLICY, drops: [] }),
      delivered: () => getDeliveredManagedPolicy(cachePath),
    })

    expect(resolveManagedSandboxEnabledFloor()).toEqual({ enabled: true })
  })

  it('yields no managed floor when the policy file cannot be loaded, instead of throwing into contour (b)/(e)', () => {
    deliver({ schemaVersion: 1, sandbox: { enabled: true } }, true)
    registerEnforcedManagedSandboxEnabledProvider({
      file: () => { throw new Error('managed-pi-policy-invalid') },
    })

    // The conservative path: no managed floor, so contour (b)/(e) fall through
    // to their own user layer — exactly what an unregistered provider does.
    expect(resolveManagedSandboxEnabledFloor()).toBeUndefined()
  })
})
