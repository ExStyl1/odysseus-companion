/**
 * C6 toggle round trip (capability-path plan § 9 gate): the unified panel's
 * per-server enable rides the EXISTING capabilityId-scoped policy records.
 *
 * Through every real layer except the click: install a plugin with an
 * auth-carrying MCP server → `setCapabilityEnabled(false)` (the exact service
 * call the `set-capability-enabled` RPC action makes) → resolve → the safe
 * catalog's plugin component reports `enabled: false` with the
 * per-capability reason and the runtime view DROPS the server → toggle back
 * ON → the server returns. TEMP directories only.
 */

import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CapabilityPolicyStore } from '@nessy-agent/shared/capabilities/policy-store'
import { CapabilityTrustStore } from '@nessy-agent/shared/capabilities/trust-store'
import { createCapabilityResolver, type CapabilityContext } from '@nessy-agent/shared/capabilities/resolver'
import { toAgentRuntime, toUserCatalog } from '@nessy-agent/shared/capabilities/views'
import { PluginManagementServiceV2, PluginStoreV2 } from '@nessy-agent/shared/plugins'
import { pluginMcpWireName } from '@nessy-agent/shared/capabilities/mcp-wire-name'
import {
  buildCapabilityResolutionInputsV2,
  type CapabilityInputsV2Deps,
} from '../storage-runtime'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mcp-server-toggle-roundtrip-'))
  mkdirSync(join(root, 'workspaces', 'ws_a', 'sources'), { recursive: true })
})

afterEach(async () => { await installs.settle() // F1.424 — never remove a root under an install still copying into it
  rmSync(root, { recursive: true, force: true })
})

describe('per-server enable toggle round trip (C6)', () => {
  it('policy record OFF drops the server from catalog and runtime; ON restores it', async () => {
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

    const bundle = join(root, 'bundle')
    mkdirSync(bundle, { recursive: true })
    const pluginId = 'toggle-kit'
    const serverName = 'tracker-mcp'
    writeFileSync(join(bundle, 'plugin.json'), JSON.stringify({
      schemaVersion: 1,
      kind: 'plugin',
      id: pluginId,
      name: 'Toggle Kit',
      version: '1.0.0',
      capabilities: [{
        kind: 'mcp',
        id: 'mcp.tracker',
        mcp: {
          serverName,
          transport: 'http',
          url: 'https://tracker.example.test/mcp',
          authType: 'oauth',
        },
      }],
    }))
    // A plugin MCP server NEVER owns its bare declared name (`mcp.md:365`) —
    // the wire name is the stable plugin-qualified form, computed with the
    // same mint the resolver uses.
    const wireName = pluginMcpWireName(pluginId, serverName)
    const installed = await service.install(
      { kind: 'local-path', path: bundle },
      { activateIn: { kind: 'workspace', workspaceId: 'ws_a' } },
    )
    expect(installed.ok).toBe(true)
    const pluginKey = installed.installed!.pluginKey

    const deps: CapabilityInputsV2Deps = {
      resolveWorkspaceRootPath: () => join(root, 'workspaces', 'ws_a'),
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
    const context: CapabilityContext = {
      workspaceId: 'ws_a',
      projectTrustState: 'none',
      projectTrustRevision: '',
    }
    const resolver = createCapabilityResolver({
      inputs: () => buildCapabilityResolutionInputsV2(context, deps),
    })
    const resolveState = async () => {
      const snapshot = await resolver.resolve(context)
      try {
        const catalog = toUserCatalog(snapshot)
        const component = catalog.installedPlugins
          .find(plugin => plugin.pluginKey === pluginKey)!
          .components!.find(entry => entry.kind === 'mcp')!
        const served = toAgentRuntime(snapshot).mcpServers.map(server => server.wireName)
        return { component, served }
      } finally {
        resolver.releaseSnapshot(snapshot.leaseId)
      }
    }

    const initial = await resolveState()
    expect(initial.component.enabled).toBe(true)
    expect(initial.served).toContain(wireName)

    // OFF — the exact call the `set-capability-enabled` RPC action makes.
    await service.setCapabilityEnabled(pluginKey, { kind: 'workspace', workspaceId: 'ws_a' }, 'mcp.tracker', false)
    const off = await resolveState()
    expect(off.component.enabled).toBe(false)
    expect(off.component.unavailableReason).toBe('capability-disabled')
    expect(off.served).not.toContain(wireName)

    // ON — round trip complete.
    await service.setCapabilityEnabled(pluginKey, { kind: 'workspace', workspaceId: 'ws_a' }, 'mcp.tracker', true)
    const on = await resolveState()
    expect(on.component.enabled).toBe(true)
    expect(on.served).toContain(wireName)
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
