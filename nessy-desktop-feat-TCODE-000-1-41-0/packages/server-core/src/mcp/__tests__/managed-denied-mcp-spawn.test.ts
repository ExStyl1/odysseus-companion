/**
 * P2.351 — a managed-DENIED MCP server must not be SPAWNED by the
 * provider-neutral browse resolve, and must still be LISTED by it.
 *
 * Deliberately end-to-end and real, because the row's claim was about host-side
 * execution rather than about a call chain: the production
 * `buildCapabilityResolutionInputsV2` → `createCapabilityResolver` →
 * `WorkspaceMcpPoolRegistry` → REAL `McpClientPool` path, with a stdio server
 * whose command is a node script that writes its own environment to a marker
 * file. A marker file is host-side execution; the secret inside it is credential
 * exposure. Before the fix this rig produced
 * `{"secret":"super-secret-gateway-token","pid":15010}` for a server the managed
 * policy denied by `serverCommand`.
 *
 * The absence assertion carries its own positive control on the same rig (the
 * undenied run), because "no marker" is otherwise indistinguishable from a rig
 * that never materialized anything.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CapabilityPolicyStore } from '@nessy-agent/shared/capabilities/policy-store'
import {
  createCapabilityResolver,
  type CapabilityContext,
  type CapabilityResolver,
} from '@nessy-agent/shared/capabilities/resolver'
import { parseManagedPiPolicyV1 } from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import type { PluginStoreV2 } from '@nessy-agent/shared/plugins'
import {
  buildCapabilityResolutionInputsV2,
  type CapabilityInputsV2Deps,
} from '../../bootstrap/storage-runtime'
import { WorkspaceMcpPoolRegistry } from '../workspace-mcp-pool-registry'

const SECRET = 'super-secret-gateway-token'
const WORKSPACE = 'ws_a'

let root: string
let workspaceRoot: string
let configDir: string
let markerPath: string
let scriptPath: string
let registry: WorkspaceMcpPoolRegistry | undefined
let previousTimeout: string | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'p2351-spawn-'))
  workspaceRoot = join(root, 'workspace')
  configDir = join(root, 'config')
  mkdirSync(workspaceRoot, { recursive: true })
  mkdirSync(configDir, { recursive: true })
  markerPath = join(root, 'SPAWNED.json')
  scriptPath = join(root, 'untrusted-mcp.js')
  writeFileSync(scriptPath, [
    "const fs = require('node:fs')",
    'fs.writeFileSync(process.env.NESSY_SPAWN_MARKER, JSON.stringify({',
    '  secret: process.env.NESSY_TEST_SECRET ?? null,',
    '  pid: process.pid,',
    '}))',
    '// Stay alive long enough to look like a server, then self-terminate so a',
    '// timed-out connect cannot leak a process into the suite.',
    'setTimeout(() => process.exit(0), 8000)',
  ].join('\n'))
  writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({
    mcpServers: {
      deniedSpawner: {
        type: 'stdio',
        command: process.execPath,
        args: [scriptPath],
        env: { NESSY_SPAWN_MARKER: markerPath, NESSY_TEST_SECRET: SECRET },
      },
    },
  }))
  // The connect itself never completes (the script speaks no MCP), so the pool
  // pays its startup deadline once per run. Trimmed so the suite does not.
  previousTimeout = process.env.NESSY_MCP_TIMEOUT
  process.env.NESSY_MCP_TIMEOUT = '1200'
})

afterEach(async () => {
  await registry?.dispose()
  registry = undefined
  if (previousTimeout === undefined) delete process.env.NESSY_MCP_TIMEOUT
  else process.env.NESSY_MCP_TIMEOUT = previousTimeout
  if (root) rmSync(root, { recursive: true, force: true })
})

/** The denylist that matches the fixture server on the enforceable dimension. */
function denyByCommand() {
  return parseManagedPiPolicyV1({
    schemaVersion: 1,
    disabledPermissionModes: [],
    deniedMcpServers: [{ serverCommand: [process.execPath, scriptPath] }],
  })
}

function noPolicy() {
  return parseManagedPiPolicyV1({ schemaVersion: 1, disabledPermissionModes: [] })
}

function inputsDeps(managedPiPolicy: ReturnType<typeof parseManagedPiPolicyV1>): CapabilityInputsV2Deps {
  return {
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
      readInstalledRegistry: async () => ({
        schemaVersion: 2,
        updatedAt: 1,
        active: {},
        plugins: [],
      }),
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
}

function makeResolver(managedPiPolicy: ReturnType<typeof parseManagedPiPolicyV1>): CapabilityResolver {
  const deps = inputsDeps(managedPiPolicy)
  return createCapabilityResolver({
    inputs: (context: CapabilityContext) => buildCapabilityResolutionInputsV2(context, deps),
  })
}

function makeRegistry(resolver: CapabilityResolver): WorkspaceMcpPoolRegistry {
  return new WorkspaceMcpPoolRegistry({
    resolver,
    resolveCredential: () => ({ ready: false, revision: 0 }),
    resolveWorkspaceRootPath: () => workspaceRoot,
    dpSessionBroker: {
      probe: async () => ({ state: 'needs-login', version: '13.0.0', outdated: false }),
      subscribe: () => () => {},
    },
    resyncDebounceMs: 0,
  })
}

/**
 * Run one browse sync exactly as `SessionManager.maybeConnectSourcesAtSessionStart`
 * does, then give a spawn that has NOT happened by then a further grace window.
 * `ensureSynced` already awaits `pool.sync` → `reconcileUnion` → `connectOnce`,
 * so this is belt and braces for a loaded machine rather than the load-bearing
 * wait.
 */
async function sessionStartSync(resolver: CapabilityResolver): Promise<void> {
  registry = makeRegistry(resolver)
  await registry.lease({ workspaceId: WORKSPACE }).ensureSynced({ workspaceId: WORKSPACE })
  const deadline = Date.now() + 3_000
  while (!existsSync(markerPath) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

describe('P2.351 — a managed-denied MCP server on the session-start browse sync', () => {
  it('POSITIVE CONTROL: with no denylist the same server IS spawned with its env', async () => {
    await sessionStartSync(makeResolver(noPolicy()))
    expect(existsSync(markerPath)).toBe(true)
    // The credential half of the row, stated rather than implied: the spawn
    // carries the server's configured `env`.
    expect(JSON.parse(readFileSync(markerPath, 'utf8')).secret).toBe(SECRET)
  }, 40_000)

  it('does not spawn a denied server on the provider-neutral browse sync', async () => {
    await sessionStartSync(makeResolver(denyByCommand()))
    expect(existsSync(markerPath)).toBe(false)
  }, 40_000)

  it('still LISTS the denied server in the browse catalog, disabled', async () => {
    const resolver = makeResolver(denyByCommand())
    const snapshot = await resolver.resolve({
      workspaceId: WORKSPACE,
      projectTrustState: 'none',
      projectTrustRevision: '',
    })
    try {
      const row = snapshot.entries.find(entry => entry.summary.logicalName === 'deniedSpawner')
      // Listing is the half the carve-out existed to protect; it survives.
      expect(row, 'the denied server vanished from the provider-neutral catalog').toBeDefined()
      // …and running is the half that does not.
      expect(row!.summary.enabled).toBe(false)
    } finally {
      resolver.releaseSnapshot(snapshot.leaseId)
    }
  })
})
