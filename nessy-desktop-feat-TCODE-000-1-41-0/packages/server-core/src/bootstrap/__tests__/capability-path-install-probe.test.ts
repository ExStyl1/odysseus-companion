/**
 * C5 install probe (capability-path plan § 9 gate): a 14-server install shaped
 * like `nessy-default-extension` — 9 dp-backed stdio servers + 5 remote OAuth
 * servers — through the REAL install/resolve/materialize chain in TEMP
 * directories only.
 *
 * Proven, with real counts:
 *  - sources created on disk: 0 (the Source projection is gone);
 *  - the resolved runtime view carries 0 sources and all 14 mcp servers;
 *  - materialization serves all 14 through the capability path: 9 dp servers
 *    materialize ready, 5 oauth servers surface as ONE needs-login
 *    `externalAuthRequirements` entry naming every server's plugin slot;
 *  - no `connector-stdio-deferred`-class parking state exists anywhere in the
 *    output (the T9-killed class stays dead).
 */

import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CapabilityPolicyStore } from '@nessy-agent/shared/capabilities/policy-store'
import { CapabilityTrustStore } from '@nessy-agent/shared/capabilities/trust-store'
import { createCapabilityResolver, type CapabilityContext } from '@nessy-agent/shared/capabilities/resolver'
import { toAgentRuntime } from '@nessy-agent/shared/capabilities/views'
import { materializeRuntimePoolServers } from '@nessy-agent/shared/mcp/runtime-pool-servers'
import {
  CapabilityMaterializationError,
  type CapabilitySnapshotMaterializer,
} from '@nessy-agent/shared/capabilities/materializer'
import { PluginManagementServiceV2, PluginStoreV2 } from '@nessy-agent/shared/plugins'
import { pluginMcpWireName } from '@nessy-agent/shared/capabilities/mcp-wire-name'
import {
  buildCapabilityResolutionInputsV2,
  type CapabilityInputsV2Deps,
} from '../storage-runtime'

let root: string
let workspaceRoot: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'capability-path-install-probe-'))
  workspaceRoot = join(root, 'workspaces', 'ws_a')
  mkdirSync(join(workspaceRoot, 'sources'), { recursive: true })
})

afterEach(async () => { await installs.settle() // F1.424 — never remove a root under an install still copying into it
  rmSync(root, { recursive: true, force: true })
})

const DP_SERVERS = ['jira', 'gitlab', 'confluence', 'search', 'people', 'calendar', 'wiki', 'tasks', 'metrics']
const OAUTH_SERVERS = ['tracker', 'mail', 'docs', 'drive', 'boards']
const PLUGIN_ID = 'default-extension-shaped'

function createDefaultExtensionShapedBundle(): string {
  const bundle = join(root, 'bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(bundle, 'plugin.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'plugin',
    id: PLUGIN_ID,
    name: 'Default Extension Shaped',
    version: '1.0.0',
    capabilities: DP_SERVERS.map(name => ({
      kind: 'mcp',
      id: name,
      mcp: { serverName: name, transport: 'stdio', command: 'dp', args: ['ai', 'mcp', name] },
    })),
    connectors: OAUTH_SERVERS.map(name => ({
      id: name,
      mcpServers: [{ serverName: `${name}-mcp`, transport: 'http', url: `https://${name}.example.test/mcp` }],
      auth: { type: 'oauth', timing: 'ON_FIRST_USE' },
    })),
  }))
  return bundle
}

/**
 * Faithful to production in the ONE respect this probe turns on: the real
 * `createCapabilitySnapshotMaterializer.resolveCredential` reports "not ready"
 * by THROWING `capability-snapshot-credential-not-ready`, it does not return
 * `{ ready: false }`. Modelling it as a quiet false is what let this probe pass
 * while the shipped app failed every materialization in a workspace holding one
 * installed-but-not-logged-in OAuth plugin.
 */
function fakeMaterializer(): CapabilitySnapshotMaterializer {
  return {
    assertActive: () => {},
    verifyPlugin: async () => {},
    resolvePath: async () => '/unused',
    readText: async () => '{}',
    resolveCredential: () => { throw new CapabilityMaterializationError('credential-not-ready') },
  }
}

describe('C5 install probe: 14 servers, zero sources, all on the capability path', () => {
  it('installs, resolves and materializes with the gate counts', async () => {
    const store = new PluginStoreV2({ rootDirectory: join(root, 'plugins') })
    const policyStore = new CapabilityPolicyStore({
      globalPath: join(root, 'config', 'capabilities.json'),
      workspacePolicyPath: workspaceId => join(root, 'workspaces', workspaceId, 'capabilities.json'),
    })
    const service = installs.track(new PluginManagementServiceV2({
      store,
      policyStore,
      trustStore: new CapabilityTrustStore({ path: join(root, 'config', 'trust.json') }),
      fetchImpl: (async () => { throw new Error('network forbidden') }) as unknown as typeof fetch,
      baseTempDir: join(root, 'staging'),
      pluginDataDir: join(root, 'plugins', 'data'),
    }))

    const result = await service.install(
      { kind: 'local-path', path: createDefaultExtensionShapedBundle() },
      { activateIn: { kind: 'workspace', workspaceId: 'ws_a' } },
    )
    expect(result.ok).toBe(true)

    // GATE: zero sources created by a 14-server install.
    const sourcesDir = join(workspaceRoot, 'sources')
    expect(existsSync(sourcesDir) ? readdirSync(sourcesDir) : []).toEqual([])

    const deps: CapabilityInputsV2Deps = {
      resolveWorkspaceRootPath: () => workspaceRoot,
      nativeSourcesEnv: {
        // P2.455 / P2.461 — `[]` is "no administrator tier", pinned so this rig
        // cannot read the machine's real administrator roots. Why the field is
        // required rather than defaulting: `NativeSourcesEnv.adminSkillsDirs`.
        adminSkillsDirs: [],
        configDir: join(root, 'config'),
        homeAgentsSkillsDir: join(root, 'agents', 'skills'),
      },
      pluginStore: store,
      policyStore,
      trustStore: { resolve: () => 'trusted' } as unknown as CapabilityInputsV2Deps['trustStore'],
      credentialBackend: {
        bind: (id: unknown) => ({ id, expectedRevision: 0 }),
        getRuntimeCredentialStatus: () => ({ state: 'missing', revision: 0 }),
      } as unknown as CapabilityInputsV2Deps['credentialBackend'],
    }
    const capabilityContext: CapabilityContext = {
      workspaceId: 'ws_a',
      projectTrustState: 'none',
      projectTrustRevision: '',
    }
    const resolver = createCapabilityResolver({
      inputs: () => buildCapabilityResolutionInputsV2(capabilityContext, deps),
    })
    const snapshot = await resolver.resolve(capabilityContext)
    try {
      const view = toAgentRuntime(snapshot)

      // GATE: the runtime view carries NO sources and every server as a
      // capability-path mcp server. Every server here is plugin-origin, so
      // NONE owns its bare declared name (`mcp.md:365`) — each wire name is
      // the stable plugin-qualified form, computed with the same mint the
      // resolver uses so this assertion tracks the production algorithm
      // (including its 40-char hash-tail cap) instead of hand-duplicating it.
      expect(view.sources).toEqual([])
      expect(view.mcpServers.map(server => server.wireName).sort()).toEqual(
        [...DP_SERVERS, ...OAUTH_SERVERS.map(name => `${name}-mcp`)]
          .map(name => pluginMcpWireName(PLUGIN_ID, name))
          .sort(),
      )
      expect(view.mcpServers).toHaveLength(14)

      const materialized = await materializeRuntimePoolServers(
        { view, materializer: fakeMaterializer() } as never,
        {
          workspaceRootPath: workspaceRoot,
          workspaceId: 'ws_a',
          dpSessionState: 'ready',
          pluginNodeRuntime: {
            command: process.execPath,
            executables: {
              dp: { command: process.execPath, environment: {}, externalAuthProvider: 'dp' },
            },
          },
        },
      )

      // GATE: 9 dp servers materialize ready; 5 oauth servers surface as ONE
      // needs-login entry naming every plugin slot. 9 + 5 = all 14 served
      // through the capability path. Keyed by wire name, so — same as above —
      // by the plugin-qualified form, never the bare declared name.
      expect(Object.keys(materialized.mergedMcpServers).sort()).toEqual(
        DP_SERVERS.map(name => pluginMcpWireName(PLUGIN_ID, name)).sort(),
      )
      const dpEntry = materialized.externalAuthRequirements.find(entry => entry.provider === 'dp')
      expect(dpEntry).toMatchObject({ state: 'ready' })
      expect(dpEntry?.wireNames).toHaveLength(9)
      const oauthEntry = materialized.externalAuthRequirements.find(entry => entry.provider === 'oauth')
      expect(oauthEntry?.state).toBe('needs-login')
      expect(oauthEntry?.servers?.map(server => server.serverName).sort()).toEqual(
        OAUTH_SERVERS.map(name => `${name}-mcp`).sort(),
      )

      // GATE: the T9-killed parking class stays dead — nothing in the whole
      // output can even spell it.
      expect(JSON.stringify({ snapshotEntries: snapshot.entries, materialized }))
        .not.toContain('connector-stdio-deferred')
    } finally {
      resolver.releaseSnapshot(snapshot.leaseId)
    }
  })
})

// F1.424 — every case here runs a REAL plugin-store install: a per-CASE budget, and a teardown that waits for every
// install still copying before it removes a root (`packages/shared/src/testing/install-tracker.ts` says why and what
// the tracker does not change). Placed last so no cited line moves: imports hoist, and bun applies a default set
// at module load to the cases registered above it (measured 2026-09-24).
import { MODULE_GRAPH_CASE_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import { createInstallTracker } from '@nessy-agent/shared/testing/install-tracker'
setDefaultTimeout(MODULE_GRAPH_CASE_BUDGET_MS)
const installs = createInstallTracker()
