/**
 * F1.593 (C4.4, owner answer QB2 = C; B12's trigger fired at 2.1.267) — an
 * organisation's `managedMcpServers` reaches every session, on all three
 * runtimes, through the HOST pool.
 *
 * ## Why the host pool, and not claude's own managed settings (measured)
 *
 * C4.4 decided "project the key into claude's own managed settings and merge the
 * pool for Pi and codex only". The first half was driven on the vendored binary
 * (SDK 0.3.267, init `2.1.267`, env scrubbed, binary pinned) with a loopback
 * Streamable-HTTP MCP stub recording every JSON-RPC method it received:
 *
 * | channel the host used | MCP requests | `mcp__wjbtorg__probe_tool` offered |
 * | --- | --- | --- |
 * | `Options.mcpServers` (positive control) | initialize, initialized, GET, tools/list | yes |
 * | `Options.managedSettings.managedMcpServers` | **none** | no |
 * | `Options.settings.managedMcpServers` (flag tier) | none | no |
 * | nothing (control) | none | no |
 *
 * `Options.managedSettings` is the only managed channel an EMBEDDING host has —
 * the SDK parent tier — and its restrictive-only filter (re-extracted at 2.1.267
 * by `claude-managed-settings.ts`'s anchor, `parentSettingsBehavior==="merge"`)
 * copies no `managedMcpServers`: the key is additive, so the filter drops it
 * whole. The vendor's own reader takes it from `policySettings` (a real admin
 * tier: server-managed, MDM plist, or `managed-settings.json`), which this host
 * cannot write. So native step 1 does not exist for claude, and AGENTS.md's
 * native-first step 2 applies — the host supplies it uniformly, once, for all
 * three: the same fold `materializeRuntimePoolServers` already runs for the
 * built-in dp set, which reaches claude through `createSourceProxyServers`, Pi
 * through the pool's proxy tools and codex through `[mcp_servers.sources]`.
 * No switch divergence to price, and no double on claude (nothing is projected).
 *
 * The documented contract, `settings-reference.md#managedmcpservers` (verbatim
 * in the SDK's `sdk.d.ts` at 0.3.267): "MCP servers the organization provides to
 * every user, keyed by server name, each with the .mcp.json entry shape; only
 * "http" and "sse" servers are accepted (nothing that names a program to run, no
 * ${VAR} references). … users cannot remove them, deniedMcpServers still
 * applies, and they need no allowedMcpServers entry."
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { materializeRuntimePoolServers } from '../runtime-pool-servers.ts'
import type { CapabilityTurnRuntime } from '../../agent/backend/types.ts'
import {
  MANAGED_PI_POLICY_KEYS,
  isManagedPolicyTightening,
  parseManagedPiPolicyTolerantV1,
  parseManagedPiPolicyV1,
  registerManagedPiPolicyProvider,
  type ManagedPiPolicyV1,
} from '../../agent/pi-harness/managed-policy.ts'

afterEach(() => { registerManagedPiPolicyProvider(undefined) })

const NO_BUILTIN_DP = { builtinDpMcpServers: false } as const
const OPTIONS = { ...NO_BUILTIN_DP, workspaceRootPath: '/ws', workspaceId: 'ws-1' }

const ORG_DOCS = { type: 'http', url: 'https://mcp.example.test/docs', headers: { 'X-Org': 'nessy' } } as const
const ORG_EVENTS = { type: 'sse', url: 'https://mcp.example.test/events' } as const

function runtimeWith(mcpServers: unknown[] = []): CapabilityTurnRuntime {
  return {
    view: {
      generation: 'g', sources: [], skills: [], mcpServers, hooks: [], automations: [], agents: [],
      promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [], lspServers: [],
    },
    materializer: {
      assertActive: () => {}, verifyPlugin: async () => {}, resolvePath: async () => '/abs', readText: async () => '{}',
      resolveCredential: () => { throw new Error('credential-not-ready') },
    },
  } as unknown as CapabilityTurnRuntime
}

function policy(extra: Record<string, unknown>): ManagedPiPolicyV1 {
  return parseManagedPiPolicyV1({ schemaVersion: 1, ...extra })
}

describe('F1.593 managedMcpServers — the policy key', () => {
  it('is a key of the schema, and adding it WIDENS rather than tightens', () => {
    expect(MANAGED_PI_POLICY_KEYS).toContain('managedMcpServers')
    const before = policy({})
    const after = policy({ managedMcpServers: { 'org-docs': ORG_DOCS } })
    expect(after.managedMcpServers).toEqual({ 'org-docs': ORG_DOCS })
    expect(isManagedPolicyTightening(before, after)).toBe(false)
  })

  it('keeps http and sse entries and strips, each with a reason, what the contract refuses', () => {
    const { policy: parsed, drops } = parseManagedPiPolicyTolerantV1({
      schemaVersion: 1,
      managedMcpServers: {
        'org-docs': ORG_DOCS,
        'org-events': ORG_EVENTS,
        local: { type: 'stdio', command: 'org-server' },
        templated: { type: 'http', url: 'https://${ORG_HOST}/mcp' },
        'bad name!': { type: 'http', url: 'https://mcp.example.test/x' },
        plain: { type: 'http', url: 'ftp://mcp.example.test/x' },
      },
    }, { source: 'managed-policy.json' })
    expect(parsed.managedMcpServers).toEqual({ 'org-docs': ORG_DOCS, 'org-events': ORG_EVENTS })
    const fields = drops.map(drop => drop.field).sort()
    expect(fields).toEqual([
      'managedMcpServers.bad name!',
      'managedMcpServers.local',
      'managedMcpServers.plain',
      'managedMcpServers.templated',
    ])
  })

  it('CONTROL — a document without the key parses exactly as before', () => {
    expect('managedMcpServers' in policy({ deniedMcpServers: [{ serverName: 'x' }] })).toBe(false)
  })
})

describe('F1.593 the host pool delivers the org servers — the one set all three runtimes read', () => {
  it('folds them into the set pool.sync receives, beside what the user configured', async () => {
    registerManagedPiPolicyProvider(() => policy({ managedMcpServers: { 'org-docs': ORG_DOCS, 'org-events': ORG_EVENTS } }))
    const out = await materializeRuntimePoolServers(runtimeWith([
      { key: 'k', wireName: 'gh', definition: { type: 'http', url: 'https://mcp.test/gh' } },
    ]), OPTIONS)
    expect(out.mergedMcpServers).toEqual({
      gh: { type: 'http', url: 'https://mcp.test/gh' },
      'org-docs': ORG_DOCS,
      'org-events': ORG_EVENTS,
    })
  })

  it('CONTROL — no managed policy, or one without the key, folds nothing', async () => {
    const view = [{ key: 'k', wireName: 'gh', definition: { type: 'http', url: 'https://mcp.test/gh' } }]
    expect((await materializeRuntimePoolServers(runtimeWith(view), OPTIONS)).mergedMcpServers)
      .toEqual({ gh: { type: 'http', url: 'https://mcp.test/gh' } })
    registerManagedPiPolicyProvider(() => policy({}))
    expect((await materializeRuntimePoolServers(runtimeWith(view), OPTIONS)).mergedMcpServers)
      .toEqual({ gh: { type: 'http', url: 'https://mcp.test/gh' } })
  })

  it('users cannot shadow one: the org entry wins a wire name a user server also takes', async () => {
    registerManagedPiPolicyProvider(() => policy({ managedMcpServers: { 'org-docs': ORG_DOCS } }))
    const out = await materializeRuntimePoolServers(runtimeWith([
      { key: 'k', wireName: 'org-docs', definition: { type: 'http', url: 'https://user.example.test/mine' } },
    ]), OPTIONS)
    expect(out.mergedMcpServers).toEqual({ 'org-docs': ORG_DOCS })
  })

  it('deniedMcpServers still applies, and an allowlist that does not name them does not', async () => {
    registerManagedPiPolicyProvider(() => policy({
      managedMcpServers: { 'org-docs': ORG_DOCS, 'org-events': ORG_EVENTS },
      deniedMcpServers: [{ serverName: 'org-events' }],
      allowedMcpServers: [{ serverName: 'something-else' }],
    }))
    const out = await materializeRuntimePoolServers(runtimeWith(), OPTIONS)
    expect(out.mergedMcpServers).toEqual({ 'org-docs': ORG_DOCS })
  })
})

describe('F1.635 — an org server named like a built-in dp server is not withheld by dp needs-login', () => {
  const DP_BUILTIN = {
    resolveDpPath: () => '/usr/local/bin/dp',
    enabled: { dpGitlab: true },
    runtimeEnv: {},
  } as const

  it('CONTROL — without the org server, needs-login withholds the enabled built-in', async () => {
    const seen: string[] = []
    const out = await materializeRuntimePoolServers(runtimeWith(), {
      ...OPTIONS,
      builtinDpMcpServers: DP_BUILTIN,
      dpSessionState: 'needs-login',
      debug: message => seen.push(message),
    })
    expect(out.mergedMcpServers.dpGitlab).toBeUndefined()
    expect(seen).toContain('runtime-external-auth-required:dp-builtin:1')
    expect(out.externalAuthRequirements.find(requirement => requirement.provider === 'dp')?.wireNames)
      .toEqual(['dpGitlab'])
  })

  it('the org server that displaced the built-in stays present, and no dp requirement rides its name', async () => {
    // P-WJbt-3: the built-in fold computed `builtinWireNames` before the org
    // fold, so a name the organisation took over was still gated and reported
    // as needing dp auth — a needs-login state withheld the ORG's server, which
    // needs no dp login at all. The org entry wins the wire name in the fold
    // (F1.593), so the needs-login gate must see the SURVIVING builtin names.
    registerManagedPiPolicyProvider(() => policy({ managedMcpServers: { dpGitlab: ORG_DOCS } }))
    const seen: string[] = []
    const out = await materializeRuntimePoolServers(runtimeWith(), {
      ...OPTIONS,
      builtinDpMcpServers: DP_BUILTIN,
      dpSessionState: 'needs-login',
      debug: message => seen.push(message),
    })
    expect(out.mergedMcpServers.dpGitlab).toEqual(ORG_DOCS)
    expect(seen).not.toContain('runtime-external-auth-required:dp-builtin:1')
    expect(out.externalAuthRequirements.find(requirement => requirement.provider === 'dp')).toBeUndefined()
  })

  it('a sibling builtin the org did not name is still withheld, and still reported', async () => {
    registerManagedPiPolicyProvider(() => policy({ managedMcpServers: { dpGitlab: ORG_DOCS } }))
    const out = await materializeRuntimePoolServers(runtimeWith(), {
      ...OPTIONS,
      builtinDpMcpServers: { ...DP_BUILTIN, enabled: { dpGitlab: true, dpJira: true } },
      dpSessionState: 'needs-login',
    })
    expect(out.mergedMcpServers.dpGitlab).toEqual(ORG_DOCS)
    expect(out.mergedMcpServers.dpJira).toBeUndefined()
    expect(out.externalAuthRequirements.find(requirement => requirement.provider === 'dp')?.wireNames)
      .toEqual(['dpJira'])
  })
})
