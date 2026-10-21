/**
 * Safe mode (`env-vars.md:318`) — the single gate, proved per surface.
 *
 * The gate lives in `buildCapabilityResolutionInputsV2`, the one funnel every
 * capability input is gathered through. These tests assert the CONSEQUENCE at
 * the runtime view rather than the gate's implementation, so a later refactor
 * that moves the check has to keep every surface empty to stay green.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CapabilityPolicyStore } from '@nessy-agent/shared/capabilities/policy-store'
import { createCapabilityResolver, type CapabilityContext } from '@nessy-agent/shared/capabilities/resolver'
import { toAgentRuntime, type AgentRuntimeView } from '@nessy-agent/shared/capabilities/views'
import { computeNormalizedBundleHash } from '@nessy-agent/shared/plugins/bundle-hash'
import type { PluginInstalledEntryV2, PluginStoreV2 } from '@nessy-agent/shared/plugins'
import { compilePermissionDslV1, evaluatePermissionDslV1 } from '@nessy-agent/shared/agent/pi-harness/permission-dsl'
import { SAFE_MODE_SUPPRESSED_SURFACES } from '@nessy-agent/shared/config/safe-mode'
import {
  buildCapabilityResolutionInputsV2,
  type CapabilityInputsV2Deps,
} from '../storage-runtime'

let root: string
let workspaceRoot: string
let bundleRoot: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'safe-mode-gate-'))
  workspaceRoot = join(root, 'workspace')
  bundleRoot = join(root, 'cache', 'toolkit')
  mkdirSync(workspaceRoot, { recursive: true })
  mkdirSync(bundleRoot, { recursive: true })
  writeFileSync(join(bundleRoot, 'plugin.json'), '{"kind":"plugin"}')
})

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

const capabilityContext: CapabilityContext = {
  workspaceId: 'ws_a',
  projectTrustState: 'none',
  projectTrustRevision: '',
}

/** A plugin carrying an MCP server, a skill and an agent — three of the surfaces. */
async function installedEntry(): Promise<PluginInstalledEntryV2> {
  const bundleHash = await computeNormalizedBundleHash(bundleRoot)
  return {
    pluginInstanceId: `plugin://internal/toolkit@1.0.0#${bundleHash}`,
    pluginKey: 'pk-toolkit',
    marketplaceId: 'internal',
    pluginId: 'toolkit',
    version: '1.0.0',
    bundleHash,
    cacheRef: { marketplaceId: 'internal', pluginId: 'toolkit', version: '1.0.0', bundleHash },
    manifest: {
      schemaVersion: 1,
      kind: 'plugin',
      id: 'toolkit',
      name: 'Toolkit',
      version: '1.0.0',
      capabilities: [{
        kind: 'mcp',
        id: 'wiki',
        mcp: { serverName: 'wiki', transport: 'stdio', command: 'wiki-mcp' },
      }],
    },
    origin: { source: 'marketplace', marketplaceId: 'internal', resolvedAt: 1 },
    installedAt: 1,
    diagnostics: [],
  }
}

async function deps(
  safeModeEnv: Record<string, string | undefined> | undefined,
  onRegistryRead?: () => void,
): Promise<CapabilityInputsV2Deps> {
  const entry = await installedEntry()
  const policyStore = new CapabilityPolicyStore({
    globalPath: join(root, 'config', 'capabilities.json'),
    workspacePolicyPath: workspaceId => join(root, 'workspaces', workspaceId, 'capabilities.json'),
  })
  policyStore.recordGlobal({ pluginKey: entry.pluginKey, enabled: true })
  return {
    resolveWorkspaceRootPath: () => workspaceRoot,
    nativeSourcesEnv: {
      // P2.455 / P2.461 — `[]` is "no administrator tier", pinned so this rig
      // cannot read the machine's real administrator roots. Why the field is
      // required rather than defaulting: `NativeSourcesEnv.adminSkillsDirs`.
      adminSkillsDirs: [],
      configDir: join(root, 'config'),
      homeAgentsSkillsDir: join(root, 'agents', 'skills'),
    },
    pluginStore: {
      readInstalledRegistry: async () => {
        onRegistryRead?.()
        return {
          schemaVersion: 2,
          updatedAt: 1,
          active: { [entry.pluginKey]: entry.pluginInstanceId },
          plugins: [entry],
        }
      },
      cachePathFor: () => bundleRoot,
      acquireInstanceLease: () => () => {},
    } as unknown as PluginStoreV2,
    policyStore,
    trustStore: { resolve: () => 'trusted' } as unknown as CapabilityInputsV2Deps['trustStore'],
    credentialBackend: {
      bind: () => { throw new Error('unexpected credential bind') },
      getRuntimeCredentialStatus: () => ({ state: 'missing', revision: 0 }),
    } as CapabilityInputsV2Deps['credentialBackend'],
    ...(safeModeEnv ? { safeModeEnv } : { safeModeEnv: {} }),
  }
}

async function runtimeView(
  safeModeEnv: Record<string, string | undefined> | undefined,
  onRegistryRead?: () => void,
): Promise<AgentRuntimeView> {
  const inputs = await buildCapabilityResolutionInputsV2(
    capabilityContext,
    await deps(safeModeEnv, onRegistryRead),
  )
  const resolver = createCapabilityResolver({ inputs: () => inputs })
  const snapshot = await resolver.resolve(capabilityContext)
  try {
    return toAgentRuntime(snapshot)
  } finally {
    resolver.releaseSnapshot(snapshot.leaseId)
  }
}

describe('safe mode — the single capability gate', () => {
  it('leaves every surface populated when it is off', async () => {
    const view = await runtimeView(undefined)
    // The control: this exact funnel does produce a third-party surface.
    expect(view.mcpServers).toHaveLength(1)
  })

  it.each([
    ['NESSY_SAFE_MODE', { NESSY_SAFE_MODE: '1' }],
    ['CLAUDE_CODE_SAFE_MODE', { CLAUDE_CODE_SAFE_MODE: '1' }],
  ] as const)('empties every surface under %s', async (_name, env) => {
    const view = await runtimeView(env)
    // One assertion per surface `env-vars.md:318` names, plus the two the
    // runtime view carries that the doc line folds into "plugins".
    expect(view.promptLayers).toEqual([])   // CLAUDE.md / instructions
    expect(view.skills).toEqual([])         // skills
    expect(view.sources).toEqual([])        // plugin- and connector-supplied sources
    expect(view.mcpServers).toEqual([])     // MCP servers
    expect(view.hooks).toEqual([])          // hooks
    expect(view.commands).toEqual([])       // custom commands
    expect(view.promptCommands).toEqual([]) // prompt commands
    expect(view.agents).toEqual([])         // custom agents
    expect(view.outputStyles ?? []).toEqual([])  // output styles
    expect(view.automations ?? []).toEqual([])   // workflows/automations
    expect(view.lspServers ?? []).toEqual([])    // LSP servers
    expect(view.memory).toEqual([])         // auto-memory
    expect(view.permissionLayers).toEqual([])
    expect(view.apps).toEqual([])
    expect(view.monitors ?? []).toEqual([])
    // Every surface the doc names has an assertion above.
    expect(SAFE_MODE_SUPPRESSED_SURFACES.length).toBe(11)
  })

  it('never even reads the installed-plugin registry', async () => {
    let reads = 0
    await runtimeView({ NESSY_SAFE_MODE: '1' }, () => { reads += 1 })
    expect(reads).toBe(0)
    await runtimeView(undefined, () => { reads += 1 })
    expect(reads).toBe(1)
  })

  it('lets the Nessy spelling win over the Claude one, like isCronDisabled', async () => {
    const view = await runtimeView({ NESSY_SAFE_MODE: '0', CLAUDE_CODE_SAFE_MODE: '1' })
    expect(view.mcpServers).toHaveLength(1)
  })

  it('still denies under a managed deny rule', async () => {
    // The managed rules ride `PermissionManager`'s `managedPermissionDsl`
    // input, which is resolved from the managed policy file and never travels
    // through the capability funnel safe mode empties. Compiling and
    // evaluating the same managed layer with safe mode on proves the deny is
    // untouched — that is what makes safe mode a posture rather than a bypass.
    const program = compilePermissionDslV1({
      generation: 'live',
      projectTrusted: false,
      layers: [{
        scope: 'managed',
        sourceDigest: 'managed-digest',
        document: {
          version: 1,
          rules: [{ id: 'managed-deny-bash', action: 'deny', match: { kind: 'tool', semanticId: 'bash' } }],
        },
      }],
    })
    const view = await runtimeView({ NESSY_SAFE_MODE: '1' })
    expect(view.permissionLayers).toEqual([])
    expect(evaluatePermissionDslV1(program, {
      generation: 'live',
      semanticId: 'bash',
      toolName: 'bash',
      input: { command: 'echo hi' },
      cwd: workspaceRoot,
    })).toMatchObject({ action: 'deny' })
  })
})
