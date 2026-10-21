/**
 * F1.635 (origin WJ-bt P-WJbt-2) — the organisation's `managedMcpServers`
 * (F1.593) are projected into the capability catalog the same way
 * `builtinDpMcpCapabilityRecords` projects the built-in dp set, so a policy with
 * `managedMcpServers` gives one READ-ONLY row per server in the Sources list,
 * and a policy without the key gives none.
 *
 * What is proven here, through the real layers and never a re-derivation:
 *
 * - The set arrives as ordinary `kind: 'mcp'` records with `origin: 'managed'`,
 *   the transport the policy entry declares, `readOnly: true` (the documented
 *   "users ... can't edit or remove the ones you provide"), and no credential
 *   slot (static `headers` are the only authentication the key can express).
 * - The deny is judged on the DENY LIST ALONE — `managed-mcp.md`, verbatim in
 *   the SDK's `sdk.d.ts`: "deniedMcpServers still applies, and they need no
 *   allowedMcpServers entry" — the SAME `denyOnly` policy the runtime fold
 *   (`mcp/runtime-pool-servers.ts:foldManagedOrgMcpServers`) judges on, so the
 *   row and the pool can never disagree about whether an org server is on.
 * - A denied org server is KEPT on the provider-neutral browse read with
 *   `managed-denied` (P2.368/P3.218 semantics — visible, and saying WHOSE the
 *   decision is), and DROPPED on a runtime turn, exactly like its built-in
 *   sibling.
 * - The runtime binding pins NO document (`resource` absent, empty command), so
 *   `materializeSnapshotMcpServers` cannot take the pinned-document branch and
 *   the fold stays the single materialization path — the same hazard the
 *   built-in projection's suite exists to catch.
 *
 * Driven through the REAL production input provider
 * (`createCapabilityResolutionInputProviderV2`), not a re-derivation of the
 * record builder: the projection is a post-pass on the resolver inputs, and
 * calling `buildCapabilityResolutionInputsV2` directly would bypass it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CapabilityPolicyStore } from '@nessy-agent/shared/capabilities/policy-store'
import { PluginStoreV2 } from '@nessy-agent/shared/plugins'
import { createCapabilityResolver, type CapabilityContext } from '@nessy-agent/shared/capabilities/resolver'
import { toUserCatalog } from '@nessy-agent/shared/capabilities/views'
import { parseManagedPiPolicyV1 } from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import {
  createCapabilityResolutionInputProviderV2,
  type CapabilityInputsV2Deps,
} from '../storage-runtime'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'managed-org-capability-'))
  mkdirSync(join(root, 'workspaces', 'ws_a', 'sources'), { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const BROWSE_CONTEXT: CapabilityContext = {
  workspaceId: 'ws_a',
  projectTrustState: 'none',
  projectTrustRevision: '',
}
const RUNTIME_CONTEXT: CapabilityContext = { ...BROWSE_CONTEXT, provider: 'pi' }

const ORG_DOCS = { type: 'http' as const, url: 'https://mcp.example.test/docs', headers: { 'X-Org': 'nessy' } }
const ORG_EVENTS = { type: 'sse' as const, url: 'https://mcp.example.test/events' }

function depsWith(managedPiPolicy?: ReturnType<typeof parseManagedPiPolicyV1>): CapabilityInputsV2Deps {
  return {
    ...(managedPiPolicy ? { managedPiPolicy } : {}),
    resolveWorkspaceRootPath: () => join(root, 'workspaces', 'ws_a'),
    nativeSourcesEnv: {
      adminSkillsDirs: [],
      configDir: join(root, 'config'),
      homeAgentsSkillsDir: join(root, 'agents', 'skills'),
    },
    pluginStore: new PluginStoreV2({ rootDirectory: join(root, 'plugins') }),
    policyStore: new CapabilityPolicyStore({
      globalPath: join(root, 'config', 'capabilities.json'),
      workspacePolicyPath: workspaceId => join(root, 'workspaces', workspaceId, 'capabilities.json'),
    }),
    trustStore: { resolve: () => 'trusted' } as unknown as CapabilityInputsV2Deps['trustStore'],
    credentialBackend: {
      bind: (id: unknown) => ({ id, expectedRevision: 0 }),
      getRuntimeCredentialStatus: () => ({ state: 'missing', revision: 0 }),
    } as unknown as CapabilityInputsV2Deps['credentialBackend'],
    storedConfig: null,
    bundledSkillRoots: { bundledRoot: join(root, 'no-bundled'), skillsRoot: join(root, 'no-skills') },
  }
}

async function resolveOnce<T>(read: (
  catalog: ReturnType<typeof toUserCatalog>,
) => T, options: { policy?: ReturnType<typeof parseManagedPiPolicyV1>, context?: CapabilityContext } = {}): Promise<T> {
  const deps = depsWith(options.policy)
  const resolver = createCapabilityResolver({
    inputs: createCapabilityResolutionInputProviderV2(deps),
  })
  const snapshot = await resolver.resolve(options.context ?? BROWSE_CONTEXT)
  try {
    return read(toUserCatalog(snapshot))
  } finally {
    resolver.releaseSnapshot(snapshot.leaseId)
  }
}

const orgRow = (name: string) => (catalog: ReturnType<typeof toUserCatalog>) => (
  catalog.capabilities.find(capability => capability.key === `managed:mcp:${name}`)
)

describe('F1.635 — the org servers are ordinary read-only rows of the Sources list', () => {
  it('CONTROL — a policy without the key projects no row', async () => {
    const none = await resolveOnce(catalog => (
      catalog.capabilities.filter(capability => capability.key.startsWith('managed:mcp:'))
    ), { policy: parseManagedPiPolicyV1({ schemaVersion: 1, disabledPermissionModes: [] }) })
    expect(none).toEqual([])
  })

  it('a policy with managedMcpServers gives one read-only row per server', async () => {
    const docs = await resolveOnce(orgRow('org-docs'), { policy: parseManagedPiPolicyV1({
      schemaVersion: 1,
      disabledPermissionModes: [],
      managedMcpServers: { 'org-docs': ORG_DOCS, 'org-events': ORG_EVENTS },
    }) })
    expect(docs).toBeDefined()
    expect(docs).toMatchObject({
      kind: 'mcp',
      logicalName: 'org-docs',
      origin: 'managed',
      mcpTransport: 'http',
      scope: { kind: 'builtin' },
      state: 'active',
      // Nothing about an org server is editable in place — the documented
      // "users keep the servers they add themselves and can't edit or remove
      // the ones you provide".
      readOnly: true,
      // Static `headers` are the only authentication the key can express, and
      // they are never a credential slot — the row must not claim a sign-in
      // is outstanding.
      credentialState: 'not-required',
      trustState: 'not-required',
    })
    const events = await resolveOnce(orgRow('org-events'), { policy: parseManagedPiPolicyV1({
      schemaVersion: 1,
      disabledPermissionModes: [],
      managedMcpServers: { 'org-docs': ORG_DOCS, 'org-events': ORG_EVENTS },
    }) })
    expect(events).toMatchObject({ logicalName: 'org-events', mcpTransport: 'sse', state: 'active' })
  })

  it('the runtime binding pins no document — the fold stays the single materialization path', async () => {
    const deps = depsWith(parseManagedPiPolicyV1({
      schemaVersion: 1,
      disabledPermissionModes: [],
      managedMcpServers: { 'org-docs': ORG_DOCS },
    }))
    const resolver = createCapabilityResolver({ inputs: createCapabilityResolutionInputProviderV2(deps) })
    const snapshot = await resolver.resolve(BROWSE_CONTEXT)
    try {
      const entry = snapshot.entries.find(item => item.summary.key === 'managed:mcp:org-docs')!
      expect(entry.summary.enabled).toBe(true)
      expect(entry.runtimeBinding.kind).toBe('mcp')
      const server = entry.runtimeBinding.kind === 'mcp' ? entry.runtimeBinding.server : undefined
      // With a resource, `materializeSnapshotMcpServers` would take the
      // pinned-document branch for this wire name — the same hazard the
      // built-in projection's suite names — and produce a second, competing
      // materialization beside the fold's.
      expect(server?.resource).toBeUndefined()
      expect(server?.definition).toMatchObject({ type: 'stdio', command: '' })
      expect(server?.wireName).toBe('org-docs')
    } finally {
      resolver.releaseSnapshot(snapshot.leaseId)
    }
  })

  it('a denial reaches the browse row with WHOSE it is, and drops on a runtime turn', async () => {
    const deniedPolicy = parseManagedPiPolicyV1({
      schemaVersion: 1,
      disabledPermissionModes: [],
      managedMcpServers: { 'org-docs': ORG_DOCS },
      deniedMcpServers: [{ serverName: 'org-docs' }],
    })
    const browse = await resolveOnce(orgRow('org-docs'), { policy: deniedPolicy })
    expect(browse).toBeDefined()
    expect(browse!.state).toBe('disabled')
    expect(browse!.unavailableReason).toBe('managed-denied')

    const runtime = await resolveOnce(orgRow('org-docs'), { policy: deniedPolicy, context: RUNTIME_CONTEXT })
    expect(runtime).toBeUndefined()
  })

  it('an allowlist that does not name them does not deny them — deny list alone, like the fold', async () => {
    const row = await resolveOnce(orgRow('org-docs'), { policy: parseManagedPiPolicyV1({
      schemaVersion: 1,
      disabledPermissionModes: [],
      managedMcpServers: { 'org-docs': ORG_DOCS },
      allowedMcpServers: [{ serverName: 'something-else' }],
    }) })
    expect(row).toMatchObject({ state: 'active' })
  })
})
